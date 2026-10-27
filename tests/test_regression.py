"""Characterize existing behavior using synthetic data and no running services."""

import copy
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
EXTENSION_ID = "a" * 32
OTHER_EXTENSION_ID = "b" * 32


def load_source_module(name, relative_path):
    spec = importlib.util.spec_from_file_location(
        name, REPOSITORY_ROOT / relative_path
    )
    module = importlib.util.module_from_spec(spec)
    # Even a runner without -B must not create caches beside production files.
    with patch.object(sys, "dont_write_bytecode", True):
        spec.loader.exec_module(module)
    return module


class IsolatedApplicationTestCase(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="tracker-regression-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.config = self.root / "config"
        self.templates = self.config / "templates"
        self.templates.mkdir(parents=True)
        self.registry = self.config / "candidates.json"
        self.history = self.root / "history"
        self.history.mkdir()

        # Fail closed if a tested path unexpectedly tries an external effect.
        self.process_guard = self.enterContext(patch(
            "subprocess.run", side_effect=AssertionError("Subprocesses are forbidden")
        ))
        self.browser_guard = self.enterContext(patch(
            "webbrowser.open", side_effect=AssertionError("Browser startup is forbidden")
        ))
        self.server_guard = self.enterContext(patch(
            "http.server.ThreadingHTTPServer",
            side_effect=AssertionError("Server startup is forbidden"),
        ))

        # Source inspection confirmed both entry points are __main__-guarded.
        # Import definitions only; never import or execute register_host.py.
        with patch.object(Path, "open", side_effect=AssertionError(
            "Import-time application file I/O is forbidden"
        )):
            self.manager = load_source_module("regression_manager", "manager/app.py")
            self.host = load_source_module("regression_host", "native-host/candidate_host.py")
        self.enterContext(patch.multiple(
            self.manager,
            ROOT=self.root,
            CONFIG_FILE=self.registry,
            TEMPLATE_DIR=self.templates,
            HOST_DIR=self.root / "native-host",
            UI_DIR=self.root / "ui",
        ))
        self.enterContext(patch.multiple(
            self.host,
            ROOT=self.root,
            CONFIG_DIR=self.config,
            STATE_FILE=self.registry,
            TEMPLATE_DIR=self.templates,
        ))
        self.registration = self.enterContext(patch.object(
            self.manager, "sync_host_registration", return_value={"ok": True}
        ))

    def payload(self, name="Alex Example", folder="alex"):
        return {
            "name": name,
            "historyFolder": str(self.history / folder),
            "extensionId": EXTENSION_ID,
            "promptTemplateText": "  Tailor this synthetic resume.\n",
        }

    def create_candidate(self, name="Alex Example", folder="alex"):
        return self.manager.save_candidate(self.payload(name, folder))["candidate"]

    def activate(self, candidate_id):
        # Exercise the actual route without constructing a socket or HTTP server.
        handler = self.manager.TrackerHandler.__new__(self.manager.TrackerHandler)
        handler.path = "/api/active"
        self.authorize_handler(handler)
        handler.check_local_request = Mock(return_value=True)
        handler.read_json = Mock(return_value={"candidateId": candidate_id})
        handler.send_json = Mock()
        handler.send_error = Mock()
        handler.log_error = Mock()
        handler.handle_write("POST")
        return handler

    def authorize_handler(self, handler):
        """Real synthetic owner/session for handler-level business regression tests."""
        from types import SimpleNamespace
        from auth_fixtures import AuthFixture, USERNAME, PASSWORD
        if not hasattr(self, "handler_auth"):
            fixture = AuthFixture()
            fixture.setUp()
            self.addCleanup(fixture.doCleanups)
            self.handler_auth = fixture.service
            self.handler_token = fixture.service.login(USERNAME, PASSWORD).token
        handler.server = SimpleNamespace(server_port=8765, auth_service=self.handler_auth)
        if not hasattr(handler, "headers"):
            handler.headers = {"Host": "127.0.0.1:8765", "Origin": "http://127.0.0.1:8765", "X-Tracker-Token": self.manager.SESSION_TOKEN}
        handler.headers["Cookie"] = "tracker_owner_session=" + self.handler_token


class ExistingBehaviorTests(IsolatedApplicationTestCase):
    def test_imports_do_not_start_services_or_read_registry(self):
        self.process_guard.assert_not_called()
        self.browser_guard.assert_not_called()
        self.server_guard.assert_not_called()
        self.registration.assert_not_called()
        self.assertFalse(self.registry.exists())

    def test_missing_registry_is_empty_for_manager_but_an_error_for_host(self):
        self.assertEqual(self.manager.load_state(), {
            "schemaVersion": 1, "activeCandidateId": None, "candidates": []
        })
        with self.assertRaisesRegex(FileNotFoundError, "Candidate settings are missing"):
            self.host.load_state()
        self.assertFalse(self.registry.exists())

    def test_registry_round_trip_preserves_schema_active_id_and_unicode(self):
        candidate = self.create_candidate("Zoë Example")
        state = self.manager.load_state()
        state["activeCandidateId"] = candidate["id"]
        self.manager.save_state(state)
        self.assertEqual(self.manager.load_state(), state)
        self.assertEqual(self.host.load_state(), state)
        self.assertEqual(state["schemaVersion"], 1)
        self.assertEqual(state["candidates"], [candidate])
        serialized = self.registry.read_text(encoding="utf-8")
        self.assertIn("Zoë Example", serialized)
        self.assertTrue(serialized.endswith("\n"))

    def test_malformed_or_unsupported_registry_is_rejected_without_rewriting(self):
        for content in ("{broken", "{}", '{"schemaVersion": 2}'):
            with self.subTest(content=content):
                self.registry.write_text(content, encoding="utf-8")
                before = self.registry.read_bytes()
                for loader in (self.manager.load_state, self.host.load_state):
                    with self.assertRaises(ValueError):
                        loader()
                    self.assertEqual(self.registry.read_bytes(), before)

    def test_failed_atomic_replacement_preserves_valid_registry_and_cleans_temp(self):
        candidate = self.create_candidate()
        original = self.registry.read_bytes()
        changed = self.manager.load_state()
        changed["activeCandidateId"] = candidate["id"]
        with patch.object(self.manager.os, "replace", side_effect=PermissionError("busy")):
            with self.assertRaisesRegex(PermissionError, "busy"):
                self.manager.save_state(changed)
        self.assertEqual(self.registry.read_bytes(), original)
        self.assertIsNone(self.manager.load_state()["activeCandidateId"])
        self.assertEqual(list(self.config.glob(".candidates.json.*.tmp")), [])

    def test_creation_normalizes_input_and_does_not_automatically_activate(self):
        payload = self.payload("  Alex Example  ")
        payload["extensionId"] = EXTENSION_ID.upper()
        result = self.manager.save_candidate(payload)
        self.assertEqual(result["candidate"]["name"], "Alex Example")
        self.assertEqual(result["candidate"]["extensionId"], EXTENSION_ID)
        self.assertRegex(result["candidate"]["id"], r"^[0-9a-f]{32}$")
        self.assertIsNone(result["state"]["activeCandidateId"])
        self.registration.assert_called_once_with()

    def test_edit_retains_id_active_reference_and_other_candidate(self):
        first = self.create_candidate()
        second = self.create_candidate("Jordan Example", "jordan")
        self.activate(first["id"])
        result = self.manager.save_candidate(
            self.payload("Alex Renamed"), candidate_id=first["id"]
        )
        self.assertEqual(result["candidate"]["id"], first["id"])
        self.assertEqual(result["state"]["activeCandidateId"], first["id"])
        self.assertEqual(result["state"]["candidates"], [result["candidate"], second])

    def test_invalid_candidate_fields_do_not_create_registry_or_history(self):
        cases = (
            ("name", "", "Candidate name"),
            ("name", "  ", "Candidate name"),
            ("name", "x" * 101, "Candidate name"),
            ("extensionId", "a" * 31, "32-character ID"),
            ("extensionId", "a" * 33, "32-character ID"),
            ("extensionId", "q" * 32, "32-character ID"),
            ("promptTemplateText", " \n", "Paste the candidate"),
            ("promptTemplateText", None, "Paste the candidate"),
            ("historyFolder", "relative-history", "absolute history-folder"),
            ("historyFolder", "", "history-folder path"),
        )
        for field, value, message in cases:
            with self.subTest(field=field, value=value):
                payload = self.payload()
                payload[field] = value
                with self.assertRaisesRegex(ValueError, message):
                    self.manager.save_candidate(payload)
                self.assertFalse(self.registry.exists())
                self.assertEqual(list(self.history.iterdir()), [])
                self.registration.assert_not_called()

    def test_duplicate_names_use_casefold_within_the_same_extension(self):
        self.create_candidate("Straße Example")
        original = self.registry.read_bytes()
        with self.assertRaisesRegex(ValueError, "name is already used"):
            self.manager.save_candidate(self.payload(" STRASSE EXAMPLE ", "other"))
        self.assertEqual(self.registry.read_bytes(), original)
        self.assertFalse((self.history / "other").exists())

    def test_extension_can_be_shared_and_names_can_repeat_across_extensions(self):
        first = self.create_candidate()
        second = self.create_candidate("Jordan Example", "jordan")
        payload = self.payload("Alex Example", "another-alex")
        payload["extensionId"] = OTHER_EXTENSION_ID
        third = self.manager.save_candidate(payload)["candidate"]
        self.assertEqual(first["extensionId"], second["extensionId"])
        self.assertNotEqual(first["extensionId"], third["extensionId"])
        self.assertEqual(len(self.manager.load_state()["candidates"]), 3)

    def test_duplicate_resolved_history_path_is_rejected(self):
        self.create_candidate()
        original = self.registry.read_bytes()
        payload = self.payload("Jordan Example")
        payload["historyFolder"] = str(self.history / "alex" / ".." / "alex")
        with self.assertRaisesRegex(ValueError, "history folder belongs"):
            self.manager.save_candidate(payload)
        self.assertEqual(self.registry.read_bytes(), original)

    def test_history_check_does_not_create_requested_folder_and_rejects_files(self):
        pending = self.history / "pending" / "nested"
        self.assertEqual(self.manager.check_history_folder(str(pending)), (pending, False))
        self.assertFalse((self.history / "pending").exists())
        self.assertEqual(
            self.manager.check_history_folder(str(self.history)), (self.history, True)
        )
        file_path = self.history / "not-a-directory"
        file_path.write_text("keep", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "points to a file"):
            self.manager.check_history_folder(str(file_path))

    def test_pasted_prompt_is_stored_per_candidate_and_resolves(self):
        candidate = self.create_candidate()
        self.assertEqual(candidate["promptTemplate"], f"templates/{candidate['id']}.txt")
        stored = self.templates / f"{candidate['id']}.txt"
        self.assertEqual(stored.read_text(encoding="utf-8"), self.payload()["promptTemplateText"])
        self.assertEqual(self.host.candidate_template(candidate), "Tailor this synthetic resume.")

    def test_linked_prompt_uses_configured_location_and_is_reread(self):
        linked = self.root / "linked-prompts" / "instructions.md"
        linked.parent.mkdir()
        linked.write_text("  Original instructions.\n", encoding="utf-8")
        # A same-named file under config is deliberately not the source.
        (self.templates / linked.name).write_text("Decoy", encoding="utf-8")
        payload = self.payload()
        payload.pop("promptTemplateText")
        payload["promptFilePath"] = str(linked)
        candidate = self.manager.save_candidate(payload)["candidate"]
        self.assertEqual(candidate["promptFilePath"], str(linked))
        self.assertNotIn("promptTemplate", candidate)
        self.assertFalse((self.templates / f"{candidate['id']}.txt").exists())
        self.assertEqual(self.host.candidate_template(candidate), "Original instructions.")
        linked.write_text("Updated instructions.", encoding="utf-8")
        self.assertEqual(self.host.candidate_template(candidate), "Updated instructions.")

    def test_invalid_linked_prompt_paths_and_contents_are_rejected(self):
        empty = self.root / "empty.txt"
        empty.write_text(" \n", encoding="utf-8")
        wrong_type = self.root / "prompt.json"
        wrong_type.write_text("instructions", encoding="utf-8")
        for path in ("relative.txt", str(self.root / "missing.md"), str(empty), str(wrong_type)):
            with self.subTest(path=path):
                with self.assertRaises(ValueError):
                    self.manager.check_prompt_file(path)
                with self.assertRaises(ValueError):
                    self.host.candidate_template({"promptFilePath": path})

        invalid_utf8 = self.root / "invalid.txt"
        invalid_utf8.write_bytes(b"\xff")
        with self.assertRaisesRegex(ValueError, "UTF-8"):
            self.manager.check_prompt_file(str(invalid_utf8))
        with self.assertRaises(UnicodeDecodeError):
            self.host.candidate_template({"promptFilePath": str(invalid_utf8)})

        oversized = self.root / "large.txt"
        oversized.write_bytes(b"x" * (self.manager.MAX_REQUEST_BYTES + 1))
        with self.assertRaisesRegex(ValueError, "smaller than 500 KB"):
            self.manager.check_prompt_file(str(oversized))

    def test_relative_prompt_cannot_escape_template_directory(self):
        outside = self.root / "outside.txt"
        outside.write_text("must not be loaded", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "outside templates"):
            self.host.candidate_template({"promptTemplate": "../outside.txt"})

    def test_delete_active_candidate_preserves_linked_prompt_and_history(self):
        linked = self.root / "linked.txt"
        linked.write_text("Keep these instructions.", encoding="utf-8")
        payload = self.payload()
        payload["promptFilePath"] = str(linked)
        candidate = self.manager.save_candidate(payload)["candidate"]
        marker = Path(candidate["historyFolder"]) / "existing-application.txt"
        marker.write_text("Keep this application.", encoding="utf-8")
        self.activate(candidate["id"])
        result = self.manager.delete_candidate(candidate["id"])
        self.assertEqual(result["state"]["candidates"], [])
        self.assertIsNone(result["state"]["activeCandidateId"])
        self.assertEqual(linked.read_text(encoding="utf-8"), "Keep these instructions.")
        self.assertEqual(marker.read_text(encoding="utf-8"), "Keep this application.")
        self.assertIsNone(result["cleanupWarning"])

    def test_delete_inactive_candidate_removes_only_its_pasted_prompt(self):
        first = self.create_candidate()
        second = self.create_candidate("Jordan Example", "jordan")
        self.activate(second["id"])
        result = self.manager.delete_candidate(first["id"])
        self.assertEqual(result["state"]["candidates"], [second])
        self.assertEqual(result["state"]["activeCandidateId"], second["id"])
        self.assertFalse((self.templates / f"{first['id']}.txt").exists())
        self.assertTrue((self.templates / f"{second['id']}.txt").is_file())
        self.assertTrue(Path(first["historyFolder"]).is_dir())

    def test_unknown_edit_or_delete_does_not_change_registry(self):
        self.create_candidate()
        original = self.registry.read_bytes()
        self.registration.reset_mock()
        with self.assertRaisesRegex(ValueError, "Candidate not found"):
            self.manager.save_candidate(self.payload(), candidate_id="missing")
        with self.assertRaisesRegex(ValueError, "Candidate not found"):
            self.manager.delete_candidate("missing")
        self.assertEqual(self.registry.read_bytes(), original)
        self.registration.assert_not_called()

    def test_active_route_persists_selection_without_registration(self):
        first = self.create_candidate()
        second = self.create_candidate("Jordan Example", "jordan")
        self.registration.reset_mock()
        handler = self.activate(second["id"])
        handler.send_json.assert_called_once_with(200, {"state": self.manager.load_state()})
        self.assertEqual(self.host.active_candidate(self.host.load_state()), second)
        self.assertEqual(self.manager.load_state()["candidates"], [first, second])
        self.registration.assert_not_called()

    def test_unknown_active_selection_returns_400_without_changing_registry(self):
        self.create_candidate()
        original = self.registry.read_bytes()
        handler = self.activate("missing")
        self.assertEqual(handler.send_json.call_args.args[0], 400)
        self.assertIn("Candidate not found", handler.send_json.call_args.args[1]["error"])
        self.assertEqual(self.registry.read_bytes(), original)

    def test_host_rejects_absent_or_stale_active_reference(self):
        candidate = self.create_candidate()
        for active_id in (None, "missing"):
            with self.subTest(active_id=active_id):
                state = {"activeCandidateId": active_id, "candidates": [candidate]}
                with self.assertRaisesRegex(ValueError, "No active candidate"):
                    self.host.active_candidate(state)

    def test_host_candidate_name_matching_is_trimmed_and_case_insensitive(self):
        candidate = self.create_candidate("Straße Example")
        self.activate(candidate["id"])
        for action in ("check_company", "save_application"):
            with self.subTest(action=action):
                self.host.verify_caller(self.manager.load_state(), EXTENSION_ID, {
                    "action": action, "candidateName": "  STRASSE EXAMPLE  "
                })

    def test_host_rejects_wrong_extension_name_inactive_and_ambiguous_candidates(self):
        first = self.create_candidate()
        second = self.create_candidate("Jordan Example", "jordan")
        self.activate(first["id"])
        state = self.manager.load_state()
        for action in ("check_company", "save_application"):
            cases = (
                (OTHER_EXTENSION_ID, first["name"], PermissionError),
                (EXTENSION_ID, "Someone Else", PermissionError),
                (EXTENSION_ID, second["name"], PermissionError),
                (EXTENSION_ID, "  ", ValueError),
            )
            for extension_id, name, error in cases:
                with self.subTest(action=action, extension_id=extension_id, name=name):
                    with self.assertRaises(error):
                        self.host.verify_caller(state, extension_id, {
                            "action": action, "candidateName": name
                        })
        ambiguous = copy.deepcopy(state)
        ambiguous["candidates"][1]["name"] = first["name"].upper()
        with self.assertRaisesRegex(ValueError, "More than one candidate"):
            self.host.verify_caller(ambiguous, EXTENSION_ID, {
                "action": "check_company", "candidateName": first["name"]
            })

    def test_caller_origin_must_be_a_valid_exact_chrome_extension_origin(self):
        self.assertEqual(self.host.caller_extension_id([
            "host", f"chrome-extension://{EXTENSION_ID}/"
        ]), EXTENSION_ID)
        for origin in ("", "https://example.test/", f"chrome-extension://{'q' * 32}/",
                       f"chrome-extension://{EXTENSION_ID}"):
            with self.subTest(origin=origin):
                with self.assertRaises(PermissionError):
                    self.host.caller_extension_id(["host", origin])

    def test_company_normalization_preserves_current_punctuation_and_suffix_rules(self):
        cases = (
            ("  ACME!, Inc.  ", "acme"),
            ("Acme & Sons Corporation", "acme and sons"),
            ("Acme Technologies LLC", "acme"),
            ("Acme L.L.C.", "acme"),
            ("Acme-Works Ltd.", "acme-works"),
            ("Acme.Works", "acme.works"),
            ("Acme Works", "acme works"),
        )
        for original, expected in cases:
            with self.subTest(original=original):
                self.assertEqual(self.host.normalize_company_name(original), expected)

    def test_company_folder_matching_uses_normalized_names_and_ignores_files(self):
        # Windows removes trailing dots from directory names, so avoid that
        # unrelated platform behavior in this company-matching fixture.
        existing = self.history / "Acme, Incorporated"
        existing.mkdir()
        marker = existing / "keep.txt"
        marker.write_text("untouched", encoding="utf-8")
        (self.history / "Other LLC").write_text("a file, not a folder", encoding="utf-8")
        self.assertEqual(self.host.find_company_folder(self.history, "ACME Corporation"), existing)
        self.assertIsNone(self.host.find_company_folder(self.history, "Other"))
        self.assertIsNone(self.host.find_company_folder(self.history, "Unrelated"))
        self.assertEqual(marker.read_text(encoding="utf-8"), "untouched")

    def test_prompt_composition_preserves_existing_sections_and_optional_jd(self):
        self.assertEqual(self.host.build_final_prompt(" Instructions \n", "Acme", " JD \n"),
                         "Instructions\n\nCompany:\nAcme\n\nJob Description:\nJD")
        self.assertEqual(self.host.build_final_prompt("Instructions", "Acme", " \n"),
                         "Instructions\n\nCompany:\nAcme")

    def test_http_error_mapping_preserves_400_403_and_generic_500(self):
        handler = self.manager.TrackerHandler.__new__(self.manager.TrackerHandler)
        handler.send_json = Mock()
        handler.log_error = Mock()
        for error, status, message in (
            (ValueError("invalid input"), 400, "invalid input"),
            (PermissionError("denied"), 403, "denied"),
            (OSError("private detail"), 500, "The request could not be completed."),
        ):
            with self.subTest(status=status):
                handler.send_json.reset_mock()
                handler.handle_error(error)
                handler.send_json.assert_called_once_with(status, {"error": message})


if __name__ == "__main__":
    unittest.main()
