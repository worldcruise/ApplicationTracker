"""Phase 5 APIs/repositories using synthetic data; no sockets or registration."""
import copy
import io
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import test_regression as regression
from tracker_config.models import ConfigurationError, RevisionConflict, validate_profile
from tracker_config.web_studio import WebStudio

ROOT = Path(__file__).resolve().parents[1]


class WebStudioTests(regression.IsolatedApplicationTestCase):
    def setUp(self):
        super().setUp()
        self.candidate = self.create_candidate()
        self.registration.reset_mock()
        self.service = WebStudio(self.config)
        self.repos = self.service.repositories
        self.profile = json.loads((ROOT / "tests/fixtures/resume-data.json").read_text(encoding="utf-8"))["profile"]
        self.profile["candidateId"] = self.candidate["id"]

    def tearDown(self):
        self.registration.assert_not_called()
        super().tearDown()

    def handler(self, path, method="GET", payload=None, headers=None):
        handler = self.manager.TrackerHandler.__new__(self.manager.TrackerHandler)
        handler.path = path
        handler.server = SimpleNamespace(server_port=8765)
        handler.headers = {"Host": "127.0.0.1:8765", "Origin": "http://127.0.0.1:8765",
                           "X-Tracker-Token": self.manager.SESSION_TOKEN, **(headers or {})}
        handler.wfile = io.BytesIO()
        for name in ("send_response", "send_header", "end_headers", "send_error", "send_json", "log_error"):
            setattr(handler, name, Mock())
        handler.read_json = Mock(return_value=payload)
        getattr(handler, "do_" + method)()
        return handler

    def profile_url(self):
        return f"/api/studio/candidates/{self.candidate['id']}/profile"

    def settings_url(self):
        return f"/api/studio/candidates/{self.candidate['id']}/settings"

    def prompt(self, **changes):
        fields = {"name": "Example prompt", "description": "Synthetic", "body": "  Complete text.\r\n{{JOB_DESCRIPTION}}\n$& punctuation.\n", "category": "General", "archived": False, "isDefault": False}
        fields.update(changes)
        return self.repos.save_prompt(fields, template_id=None, expected_revision=self.repos.prompts.read().revision)

    def assign(self, **changes):
        return self.repos.update_candidate_settings(self.candidate["id"], changes,
                                                   expected_revision=self.repos.candidates.read().revision)

    def test_loading_missing_profile_and_catalogs_never_creates_files(self):
        before = {path: path.read_bytes() for path in self.config.rglob("*") if path.is_file()}
        result = self.handler(self.profile_url())
        status, response = result.send_json.call_args.args
        self.assertEqual(status, 200)
        self.assertFalse(response["exists"])
        self.assertIsNone(response["revision"])
        state = self.service.state()
        self.assertEqual({record["id"] for record in state["documents"]["templates"]}, {"classic", "modern"})
        self.assertEqual(before, {path: path.read_bytes() for path in self.config.rglob("*") if path.is_file()})

    def test_explicit_profile_save_preserves_nested_future_fields_and_custom_answers(self):
        self.profile["future"] = {"enabled": True}
        self.profile["workExperience"][0]["future"] = {"text": ["exact"]}
        self.profile["personal"]["future"] = {"nested": 1}
        self.profile["customAnswers"]["answers"] = [{"id": "qa-one", "question": "Why?", "answer": "  Full answer\r\nnext line.\n", "future": [1]}]
        response = self.handler(self.profile_url(), "PUT", {"data": self.profile, "revision": None})
        self.assertEqual(response.send_json.call_args.args[0], 200)
        saved = self.service.profile(self.candidate["id"])
        self.assertEqual(saved["data"], self.profile)
        edited = copy.deepcopy(saved["data"]); edited["contact"]["email"] = "changed@example.test"
        self.service.save_profile(self.candidate["id"], {"data": edited, "revision": saved["revision"]})
        self.assertEqual(self.service.profile(self.candidate["id"])["data"], edited)

    def test_profile_stale_revision_returns_409_without_overwriting_either_edit(self):
        saved = self.service.save_profile(self.candidate["id"], {"data": self.profile, "revision": None})
        other = copy.deepcopy(self.profile); other["contact"]["phone"] = "555-0100"
        self.service.save_profile(self.candidate["id"], {"data": other, "revision": saved["revision"]})
        result = self.handler(self.profile_url(), "PUT", {"data": self.profile, "revision": saved["revision"]})
        self.assertEqual(result.send_json.call_args.args[0], 409)
        self.assertEqual(self.service.profile(self.candidate["id"])["data"], other)

    def test_profiles_reject_invalid_known_fields_credentials_and_bad_custom_answers(self):
        for path, value in [("personal", {"birthday": "invalid"}), ("contact", {"password": "forbidden"}),
                            ("customAnswers", {"answers": [{"id": "qa-one", "question": "", "answer": "text"}]})]:
            record = copy.deepcopy(self.profile); record[path] = value
            with self.subTest(path=path), self.assertRaises(ConfigurationError):
                validate_profile(record)
        self.assertFalse((self.config / "profiles").exists())

    def test_profile_candidate_mismatch_missing_revision_and_bad_payloads_fail(self):
        for payload in ({"data": self.profile}, {"data": {**self.profile, "candidateId": "other"}, "revision": None},
                        {"data": self.profile, "revision": None, "path": str(self.root / "outside.json")}):
            result = self.handler(self.profile_url(), "PUT", payload)
            self.assertEqual(result.send_json.call_args.args[0], 400)
        self.assertFalse((self.config / "profiles").exists())

    def test_invalid_existing_profile_is_not_replaced_with_empty_data(self):
        path = self.config / "profiles" / f"{self.candidate['id']}.json"
        path.parent.mkdir(); path.write_bytes(b'{"broken":')
        result = self.handler(self.profile_url())
        self.assertEqual(result.send_json.call_args.args[0], 400)
        self.assertEqual(path.read_bytes(), b'{"broken":')

    def test_prompt_creation_edit_duplicate_and_archive_preserve_full_body(self):
        first = self.prompt(); record = first.data["templates"][0]; body = record["body"]
        # Existing future metadata survives API-style field updates.
        first.data["templates"][0]["future"] = {"key": "value"}
        first = self.repos.prompts.save(first.data, expected_revision=first.revision)
        edited = self.repos.save_prompt({"name": "Updated"}, template_id=record["id"], expected_revision=first.revision)
        updated = edited.data["templates"][0]
        self.assertEqual(updated["body"], body); self.assertEqual(updated["version"], 2)
        self.assertEqual(updated["createdAt"], record["createdAt"]); self.assertEqual(updated["future"], {"key": "value"})
        duplicate = self.prompt(name="Updated (copy)", body=body)
        self.assertNotEqual(duplicate.data["templates"][1]["id"], record["id"])
        archived = self.repos.save_prompt({"archived": True}, template_id=record["id"], expected_revision=duplicate.revision)
        self.assertEqual(archived.data["templates"][0]["body"], body)
        self.assertTrue(archived.data["templates"][0]["archived"])

    def test_assigned_managed_prompt_is_resolved_and_archival_does_not_substitute_legacy(self):
        saved = self.prompt(); record = saved.data["templates"][0]
        self.assign(assignedPromptTemplateId=record["id"])
        self.assertEqual(self.service.prompt(self.candidate["id"])["body"], record["body"])
        self.repos.save_prompt({"archived": True}, template_id=record["id"], expected_revision=saved.revision)
        with self.assertRaisesRegex(ConfigurationError, "archived"):
            self.service.prompt(self.candidate["id"])
        self.assign(preferredDocumentTemplateId="modern")  # unrelated preference keeps reference
        self.assertEqual(self.repos.candidates.get(self.candidate["id"])["assignedPromptTemplateId"], record["id"])
        self.assertIn("Tailor", self.host.candidate_template(self.repos.candidates.get(self.candidate["id"])))

    def test_invalid_or_archived_assignments_fail_and_explicit_null_restores_legacy(self):
        with self.assertRaisesRegex(ConfigurationError, "missing"):
            self.assign(assignedPromptTemplateId="missing")
        saved = self.prompt(archived=True); record = saved.data["templates"][0]
        with self.assertRaisesRegex(ConfigurationError, "archived"):
            self.assign(assignedPromptTemplateId=record["id"])
        self.assign(assignedPromptTemplateId=None)
        self.assertEqual(self.service.prompt(self.candidate["id"])["source"], "legacy")

    def test_legacy_file_reference_and_linked_prompt_are_live_and_never_imported(self):
        body = "  Exact prompt\r\nSecond line.\n"
        custom = self.templates / "configured-name.md"; custom.write_bytes(body.encode())
        snapshot = self.repos.candidates.read(); snapshot.data["candidates"][0]["promptTemplate"] = "templates/configured-name.md"
        self.repos.candidates.save(snapshot.data, expected_revision=snapshot.revision)
        self.assertEqual(self.service.prompt(self.candidate["id"])["body"], body)
        self.assertEqual(self.handler(f"/api/candidates/{self.candidate['id']}/template").send_json.call_args.args[1]["promptTemplateText"], body)
        linked = self.root / "outside-config.txt"; linked.write_bytes(body.encode())
        snapshot = self.repos.candidates.read(); snapshot.data["candidates"][0]["promptFilePath"] = str(linked)
        self.repos.candidates.save(snapshot.data, expected_revision=snapshot.revision)
        self.assertEqual(self.service.prompt(self.candidate["id"])["body"], body)
        linked.write_text("Changed original file", encoding="utf-8")
        self.assertEqual(self.service.prompt(self.candidate["id"])["body"], "Changed original file")
        self.assertFalse(self.repos.prompts.path.exists())

    def test_builtin_document_preference_preserves_registry_and_requires_no_catalog(self):
        snapshot = self.repos.candidates.read(); snapshot.data["future"] = ["root"]
        snapshot.data["candidates"][0]["future"] = {"keep": True}
        snapshot = self.repos.candidates.save(snapshot.data, expected_revision=snapshot.revision)
        before = copy.deepcopy(snapshot.data)
        result = self.handler(self.settings_url(), "PUT", {"data": {"preferredDocumentTemplateId": "modern"}, "revision": snapshot.revision})
        self.assertEqual(result.send_json.call_args.args[0], 200)
        before["candidates"][0]["preferredDocumentTemplateId"] = "modern"
        self.assertEqual(self.repos.candidates.read().data, before)
        self.assertFalse(self.repos.documents.path.exists())
        self.assertEqual(self.host.load_state(), before)

    def test_unsupported_document_or_arbitrary_settings_paths_are_rejected(self):
        for data in ({"preferredDocumentTemplateId": "missing"}, {"historyFolder": str(self.root)}, {"path": "../outside"}, [], {}):
            with self.subTest(data=data):
                response = self.handler(self.settings_url(), "PUT", {"data": data, "revision": self.repos.candidates.read().revision})
                self.assertEqual(response.send_json.call_args.args[0], 400)
        for suffix in ("../other/profile", "%2e%2e/profile", "C:/Windows/profile"):
            response = self.handler("/api/studio/candidates/" + suffix)
            response.send_error.assert_called_once_with(404)

    def test_new_routes_preserve_host_origin_and_session_authorization(self):
        for headers in ({"Host": "attacker.test"}, {"Origin": "http://attacker.test"}, {"X-Tracker-Token": "wrong"}):
            handler = self.handler(self.profile_url(), "PUT", {"data": self.profile, "revision": None}, headers)
            self.assertEqual(handler.send_json.call_args.args[0], 403)
            handler.read_json.assert_not_called()
        result = self.handler("/api/studio/state", headers={"Host": "attacker.test"})
        self.assertEqual(result.send_json.call_args.args[0], 403)

    def test_catalog_stale_write_and_malformed_json_never_erase_catalog(self):
        first = self.prompt(); before = self.repos.prompts.path.read_bytes()
        with self.assertRaises(RevisionConflict):
            self.repos.save_prompt({"body": "stale"}, template_id=first.data["templates"][0]["id"], expected_revision=None)
        self.assertEqual(self.repos.prompts.path.read_bytes(), before)
        self.repos.prompts.path.write_bytes(b'{"broken":')
        result = self.handler("/api/studio/state")
        self.assertEqual(result.send_json.call_args.args[0], 400)
        self.assertEqual(self.repos.prompts.path.read_bytes(), b'{"broken":')

    def test_failed_profile_write_preserves_previous_valid_file(self):
        saved = self.service.save_profile(self.candidate["id"], {"data": self.profile, "revision": None})
        path = self.config / "profiles" / f"{self.candidate['id']}.json"; before = path.read_bytes()
        changed = copy.deepcopy(self.profile); changed["contact"]["email"] = "other@example.test"
        with patch("tracker_config.repositories.os.replace", side_effect=OSError("synthetic failure")):
            with self.assertRaises(OSError):
                self.service.save_profile(self.candidate["id"], {"data": changed, "revision": saved["revision"]})
        self.assertEqual(path.read_bytes(), before)

    def test_prompt_api_validates_fields_and_does_not_accept_paths(self):
        for data in ({"name": "", "body": "x"}, {"name": "Name", "body": " "}, {"name": "Name", "body": "x", "path": "../outside"}):
            handler = self.handler("/api/studio/prompts", "POST", {"data": data, "revision": None})
            self.assertEqual(handler.send_json.call_args.args[0], 400)
        valid = self.handler("/api/studio/prompts", "POST", {"data": {"name": "Name", "body": "  Entire body\r\n"}, "revision": None})
        self.assertEqual(valid.send_json.call_args.args[0], 200)
        saved = valid.send_json.call_args.args[1]
        identifier = saved["data"]["templates"][0]["id"]
        update = self.handler("/api/studio/prompts/" + identifier, "PUT", {"data": {"archived": True}, "revision": saved["revision"]})
        self.assertEqual(update.send_json.call_args.args[1]["data"]["templates"][0]["body"], "  Entire body\r\n")

    def test_switching_catalog_default_versions_both_changed_records(self):
        first = self.prompt(isDefault=True)
        second = self.prompt(name="Other", isDefault=True)
        self.assertEqual([item["isDefault"] for item in second.data["templates"]], [False, True])
        self.assertEqual(second.data["templates"][0]["version"], 2)
        self.assertEqual(second.data["templates"][0]["body"], first.data["templates"][0]["body"])

    def test_new_ui_resources_are_exact_read_only_paths_with_correct_mime(self):
        ui = self.manager.UI_DIR; ui.mkdir()
        for filename, mime in (("studio-app.mjs", "text/javascript; charset=utf-8"), ("studio-core.mjs", "text/javascript; charset=utf-8"), ("classic.svg", "image/svg+xml"), ("modern.svg", "image/svg+xml")):
            (ui / filename).write_bytes(b"synthetic local resource")
            response = self.handler("/" + filename)
            response.send_response.assert_called_once_with(200)
            response.send_header.assert_any_call("Content-Type", mime)
            self.assertEqual(response.wfile.getvalue(), b"synthetic local resource")
            forbidden = self.handler("/" + filename, "POST", {})
            forbidden.send_error.assert_called_once_with(404)
        for path in ("/../studio-app.mjs", "/%2e%2e/studio-core.mjs", "/config/profiles/test.json", "/ui/classic.svg"):
            response = self.handler(path)
            response.send_error.assert_called_once_with(404)

    def test_candidate_add_edit_routes_persist_independent_template_assignments(self):
        prompt = self.prompt().data["templates"][0]
        second_prompt = self.prompt(name="Other instructions").data["templates"][1]
        payload = self.payload("Other Candidate", "other")
        payload.update(assignedPromptTemplateId=second_prompt["id"], preferredDocumentTemplateId="modern", registryRevision=self.repos.candidates.read().revision)
        created = self.handler("/api/candidates", "POST", payload)
        self.assertEqual(created.send_json.call_args.args[0], 200)
        second = created.send_json.call_args.args[1]["candidate"]
        edit = self.payload(); edit.update(assignedPromptTemplateId=prompt["id"], preferredDocumentTemplateId="classic", registryRevision=self.repos.candidates.read().revision)
        updated = self.handler(f"/api/candidates/{self.candidate['id']}", "PUT", edit)
        self.assertEqual(updated.send_json.call_args.args[0], 200)
        self.assertEqual(self.repos.candidates.get(self.candidate["id"])["assignedPromptTemplateId"], prompt["id"])
        self.assertEqual(self.repos.candidates.get(second["id"])["assignedPromptTemplateId"], second_prompt["id"])
        self.assertEqual(self.repos.candidates.get(second["id"])["preferredDocumentTemplateId"], "modern")
        self.registration.assert_called(); self.registration.reset_mock()

    def test_candidate_assignment_errors_and_stale_form_fail_before_side_effects(self):
        original = self.registry.read_bytes()
        for changes in ({"assignedPromptTemplateId": "missing"}, {"preferredDocumentTemplateId": "missing"}, {"registryRevision": "stale"}):
            payload = self.payload("Invalid", "never-created"); payload.update(changes)
            result = self.handler("/api/candidates", "POST", payload)
            self.assertIn(result.send_json.call_args.args[0], (400, 409))
            self.assertFalse((self.history / "never-created").exists())
            self.assertEqual(self.registry.read_bytes(), original)

    def test_document_configuration_crud_is_revision_checked_and_preserves_metadata(self):
        fields = {"name": "Compact Modern", "description": "Synthetic", "layoutId": "modern", "defaultSettings": {"bodyFontSize": 10, "showEducation": False}}
        created = self.handler("/api/studio/documents", "POST", {"data": fields, "revision": None})
        self.assertEqual(created.send_json.call_args.args[0], 200)
        saved = created.send_json.call_args.args[1]; record = saved["data"]["templates"][0]
        self.assertEqual(record["rendererVersion"], 1); self.assertEqual(record["defaultSettings"], fields["defaultSettings"])
        saved["data"]["templates"][0]["future"] = {"keep": True}
        revised = self.repos.documents.save(saved["data"], expected_revision=saved["revision"])
        update = self.handler("/api/studio/documents/" + record["id"], "PUT", {"data": {"name": "Updated"}, "revision": revised.revision})
        current = update.send_json.call_args.args[1]
        self.assertEqual(current["data"]["templates"][0]["id"], record["id"])
        self.assertEqual(current["data"]["templates"][0]["version"], 2)
        self.assertEqual(current["data"]["templates"][0]["future"], {"keep": True})
        stale = self.handler("/api/studio/documents/" + record["id"], "PUT", {"data": {"name": "Stale"}, "revision": revised.revision})
        self.assertEqual(stale.send_json.call_args.args[0], 409)

    def test_document_duplication_and_archive_preserve_candidate_references(self):
        fields = {"name": "My Classic", "description": "Synthetic", "layoutId": "classic", "defaultSettings": {"lineHeight": 1.3}}
        first = self.repos.save_document(fields, template_id=None, expected_revision=None)
        record = first.data["templates"][0]
        self.assign(preferredDocumentTemplateId=record["id"])
        second = self.repos.save_document({**fields, "name": "Copy"}, template_id=None, expected_revision=first.revision)
        self.assertNotEqual(second.data["templates"][1]["id"], record["id"])
        archived = self.repos.save_document({"archived": True}, template_id=record["id"], expected_revision=second.revision)
        self.assertTrue(archived.data["templates"][0]["archived"])
        self.assertEqual(self.repos.candidates.get(self.candidate["id"])["preferredDocumentTemplateId"], record["id"])
        self.assertEqual(self.service.state()["documentCatalog"]["revision"], archived.revision)

    def test_document_library_rejects_fake_layouts_settings_and_builtin_edits(self):
        for fields, template_id in (({"name": "Fake", "layoutId": "unsupported"}, None), ({"name": "Bad", "layoutId": "classic", "defaultSettings": {"fontFamily": "Remote"}}, None), ({"name": "Bad", "layoutId": "classic", "defaultSettings": {"headerAlignment": "center\n"}}, None), ({"name": "Changed"}, "classic")):
            with self.subTest(fields=fields), self.assertRaises(ConfigurationError):
                self.repos.save_document(fields, template_id=template_id, expected_revision=None)
        self.assertFalse(self.repos.documents.path.exists())


class WebStudioJavaScriptTests(unittest.TestCase):
    def test_web_studio_javascript_suite(self):
        node = shutil.which("node") or r"C:\Program Files\nodejs\node.exe"
        if not Path(node).is_file():
            self.skipTest("Node.js unavailable; no dependencies installed")
        with tempfile.TemporaryDirectory(prefix="studio-node-") as directory:
            result = subprocess.run([node, "--test", str(ROOT / "tests/web-studio.test.mjs")], cwd=directory, text=True, capture_output=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
