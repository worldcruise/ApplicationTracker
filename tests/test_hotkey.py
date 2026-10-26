"""Read-only native lookup and hotkey regression tests using synthetic data only."""
import base64
from contextlib import ExitStack
import copy
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import test_regression as regression


class ReadOnlyLookupTests(regression.IsolatedApplicationTestCase):
    def state_for(self, history):
        candidate = {
            "id": "synthetic-candidate", "name": "Alex Example",
            "extensionId": regression.EXTENSION_ID, "historyFolder": str(history),
            "promptTemplate": "templates/synthetic-candidate.txt",
        }
        state = {"schemaVersion": 1, "activeCandidateId": candidate["id"], "candidates": [candidate]}
        self.manager.save_state(state)
        return state

    def check_without_writes(self, state, company="Example Company"):
        before = copy.deepcopy(state)
        registry_before = self.registry.read_bytes()
        paths_before = set(self.root.rglob("*"))
        message = {"action": "check_company", "candidateName": "Alex Example", "companyName": company}
        with ExitStack() as guards:
            for method in ("mkdir", "write_text", "write_bytes"):
                guards.enter_context(patch.object(Path, method, side_effect=AssertionError("Lookup attempted a write")))
            guards.enter_context(patch.object(self.host, "handle_save_application", side_effect=AssertionError("Save forbidden")))
            guards.enter_context(patch.object(self.host, "candidate_template", side_effect=AssertionError("Prompt read forbidden")))
            guards.enter_context(patch("tracker_config.repositories.atomic_write_bytes", side_effect=AssertionError("Registry write forbidden")))
            self.host.verify_caller(state, regression.EXTENSION_ID, message)
            response = self.host.handle_check_company(message, state)
        self.assertEqual(state, before)
        self.assertEqual(self.registry.read_bytes(), registry_before)
        self.assertEqual(set(self.root.rglob("*")), paths_before)
        self.registration.assert_not_called()
        return response

    def test_missing_nested_history_directory_is_not_created(self):
        history = self.root / "uncreated-parent" / "nested-history"
        state = self.state_for(history)
        response = self.check_without_writes(state)
        self.assertFalse(response["exists"])
        self.assertIsNone(response["folderPath"])
        self.assertFalse(history.parent.exists())

    def test_existing_saved_company_retains_normalization_and_all_file_contents(self):
        history = self.history / "existing"
        saved = history / "Example, Incorporated"
        saved.mkdir(parents=True)
        marker = saved / "keep.txt"
        marker.write_bytes(b"Synthetic existing job - do not overwrite")
        state = self.state_for(history)
        response = self.check_without_writes(state, "EXAMPLE Corporation")
        self.assertTrue(response["exists"])
        self.assertEqual(response["folderPath"], str(saved))
        self.assertEqual(marker.read_bytes(), b"Synthetic existing job - do not overwrite")

    def test_unsaved_company_in_existing_history_creates_nothing(self):
        state = self.state_for(self.history)
        response = self.check_without_writes(state)
        self.assertFalse(response["exists"])
        self.assertEqual(list(self.history.iterdir()), [])

    def test_lookup_resolves_paths_without_creating_them(self):
        history = self.root / "unused" / ".." / "missing-history"
        state = self.state_for(history)
        self.assertFalse(self.check_without_writes(state)["exists"])
        self.assertFalse((self.root / "unused").exists())
        self.assertFalse((self.root / "missing-history").exists())
        with self.assertRaisesRegex(ValueError, "must be absolute"):
            self.host.candidate_root({"historyFolder": "relative-history"}, create=False)

    def test_permission_errors_and_non_directory_paths_are_not_reported_as_unsaved(self):
        state = self.state_for(self.history)
        with patch.object(self.host, "find_company_folder", side_effect=PermissionError("Synthetic access denial")):
            with self.assertRaises(PermissionError):
                self.check_without_writes(state)
        file_path = self.root / "not-a-directory"
        file_path.write_text("Keep this synthetic file", encoding="utf-8")
        state = self.state_for(file_path)
        with self.assertRaises(NotADirectoryError):
            self.check_without_writes(state)
        self.assertEqual(file_path.read_text(encoding="utf-8"), "Keep this synthetic file")

    def test_explicit_legacy_save_still_creates_missing_root_and_archive(self):
        history = self.root / "missing-parent" / "legacy-history"
        state = self.state_for(history)
        (self.templates / "synthetic-candidate.txt").write_text("Synthetic legacy instructions", encoding="utf-8")
        self.assertFalse(self.check_without_writes(state)["exists"])
        self.assertFalse(history.exists())
        registry_before = self.registry.read_bytes()
        message = {
            "action": "save_application", "candidateName": "Alex Example", "companyName": "Example Company",
            "jobUrl": "https://example.test/jobs/123", "jobDescription": "Synthetic original JD",
            "mhtmlBase64": base64.b64encode(b"Synthetic MHTML").decode("ascii"),
        }
        self.host.verify_caller(state, regression.EXTENSION_ID, message)
        response = self.host.handle_save_application(message, state)
        folder = Path(response["folderPath"])
        self.assertTrue(folder.is_relative_to(self.root))
        self.assertEqual((folder / "job_description.mhtml").read_bytes(), b"Synthetic MHTML")
        self.assertTrue((folder / "meta.json").is_file())
        self.assertIn("Synthetic legacy instructions", response["finalPrompt"])
        self.assertEqual(self.registry.read_bytes(), registry_before)
        self.registration.assert_not_called()


class HotkeyJavaScriptTests(unittest.TestCase):
    def test_background_hotkey_and_clipboard_suite(self):
        node = shutil.which("node")
        if node is None:
            installed = Path("C:/Program Files/nodejs/node.exe")
            node = str(installed) if installed.is_file() else None
        if node is None:
            self.skipTest("Node.js is unavailable; no software will be installed.")
        with tempfile.TemporaryDirectory(prefix="tracker-hotkey-tests-") as temporary:
            result = subprocess.run(
                [node, "--test", str(regression.REPOSITORY_ROOT / "tests/hotkey.test.mjs")],
                cwd=temporary, capture_output=True, text=True, encoding="utf-8", timeout=30, check=False,
            )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_native_launcher_disables_bytecode_writes_for_both_python_options(self):
        source = (regression.REPOSITORY_ROOT / "native-host/_run_host.bat").read_text(encoding="utf-8")
        self.assertIn('py -3 -B -u "%~dp0candidate_host.py" %*', source)
        self.assertIn('python -B -u "%~dp0candidate_host.py" %*', source)
