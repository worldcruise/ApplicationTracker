"""Renderer resources and settings, with no server or real configuration access."""

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
from tracker_config.document_settings import builtin_document_templates, validate_document_settings
from tracker_config.models import validate_document_catalog
from tracker_config.resume import build_render_input, validate_render_input


ROOT = Path(__file__).resolve().parents[1]


class SharedResourceTests(regression.IsolatedApplicationTestCase):
    def setUp(self):
        super().setUp()
        self.extension = self.root / "extension"
        self.enterContext(patch.object(self.manager, "EXTENSION_DIR", self.extension))
        for relative, content_type in self.manager.SHARED_STATIC_FILES.values():
            target = self.extension / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(b'{"synthetic":true}' if content_type.startswith("application/json") else b"// synthetic approved resource\n")

    def handler(self, path, method="GET", headers=None):
        handler = self.manager.TrackerHandler.__new__(self.manager.TrackerHandler)
        handler.path = path
        handler.server = SimpleNamespace(server_port=8765)
        handler.headers = {"Host": "127.0.0.1:8765", "Origin": "http://127.0.0.1:8765",
                           "X-Tracker-Token": self.manager.SESSION_TOKEN, **(headers or {})}
        handler.wfile = io.BytesIO()
        for name in ("send_response", "send_header", "end_headers", "send_error", "send_json", "log_error"):
            setattr(handler, name, Mock())
        handler.read_json = Mock(side_effect=AssertionError("Static resources must not parse request bodies"))
        getattr(handler, f"do_{method}")()
        return handler

    def test_exact_approved_modules_json_and_vendor_files_have_correct_mime_and_contents(self):
        for url, (relative, mime) in self.manager.SHARED_STATIC_FILES.items():
            with self.subTest(url=url):
                handler = self.handler(url + "?cache=test")
                handler.send_response.assert_called_once_with(200)
                self.assertEqual(handler.wfile.getvalue(), (self.extension / relative).read_bytes())
                handler.send_header.assert_any_call("Content-Type", mime)
                handler.send_header.assert_any_call("X-Content-Type-Options", "nosniff")
                self.assertFalse(any(call.args[0].lower().startswith("access-control-") for call in handler.send_header.call_args_list))
                handler.send_error.assert_not_called()
        self.registration.assert_not_called()
        self.assertFalse(self.registry.exists())

    def test_invalid_and_traversal_paths_never_open_arbitrary_files(self):
        paths = ("/shared/", "/shared/unknown.js", "/shared/vendor/pdfmake-0.3.11/LICENSE.pdfmake.txt",
                 "/shared/../config/candidates.json", "/shared/../shared/resume-renderer.mjs",
                 "/shared/%2e%2e/config/candidates.json", "/shared/%252e%252e/config/candidates.json",
                 "/shared/..%5cconfig%5ccandidates.json", "/shared\\..\\config\\candidates.json",
                 "/shared/resume-renderer.mjs/extra", "/shared/resume-renderer.mjs%00", "/config/candidates.json",
                 "/studio/access.mjs", "C:/Windows/system.ini")
        with patch.object(Path, "read_bytes", side_effect=AssertionError("Unapproved file access")):
            for path in paths:
                with self.subTest(path=path):
                    handler = self.handler(path)
                    handler.send_error.assert_called_once_with(404)
                    self.assertEqual(handler.wfile.getvalue(), b"")

    def test_missing_approved_file_is_a_404_without_creating_a_replacement(self):
        target = self.extension / "shared/resume-renderer.mjs"
        target.unlink()
        handler = self.handler("/shared/resume-renderer.mjs")
        handler.send_error.assert_called_once_with(404)
        self.assertFalse(target.exists())

    def test_resolved_file_or_directory_escape_is_rejected_before_reading(self):
        original = Path.resolve
        for escape in ("file", "directory"):
            def resolve(path, *args, **kwargs):
                if (escape == "file" and path.name == "resume-renderer.mjs") or (escape == "directory" and path.name == "shared"):
                    return self.root / "outside-shared" / path.name
                return original(path, *args, **kwargs)
            with self.subTest(escape=escape), patch.object(Path, "resolve", resolve), patch.object(Path, "read_bytes", side_effect=AssertionError("No escaped reads")):
                handler = self.handler("/shared/resume-renderer.mjs")
                self.assertEqual(handler.send_json.call_args.args[0], 403)
                self.assertEqual(handler.wfile.getvalue(), b"")

    def test_unsupported_methods_are_405_and_never_parse_bodies_or_write(self):
        for method in ("POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"):
            for path in ("/shared/resume-renderer.mjs", "/shared/unknown.js", "/studio/contracts.mjs"):
                with self.subTest(method=method, path=path):
                    handler = self.handler(path, method)
                    handler.send_response.assert_called_once_with(405)
                    handler.send_header.assert_any_call("Allow", "GET")
                    handler.read_json.assert_not_called()
                    self.assertEqual(handler.wfile.getvalue(), b"")
        self.registration.assert_not_called()
        self.assertFalse(self.registry.exists())

    def test_host_and_existing_write_origin_and_token_checks_are_preserved(self):
        for method, headers in (("GET", {"Host": "evil.test"}), ("POST", {"Origin": "https://evil.test"}),
                                ("PUT", {"X-Tracker-Token": "wrong"}), ("HEAD", {"Host": "evil.test"})):
            handler = self.handler("/shared/resume-renderer.mjs", method, headers)
            self.assertEqual(handler.send_json.call_args.args[0], 403)
            handler.send_response.assert_not_called()
            handler.read_json.assert_not_called()

    def test_existing_static_ui_route_is_unchanged(self):
        self.manager.UI_DIR.mkdir()
        (self.manager.UI_DIR / "index.html").write_bytes(b"<p>Synthetic UI</p>")
        handler = self.handler("/")
        handler.send_response.assert_called_once_with(200)
        self.assertEqual(handler.wfile.getvalue(), b"<p>Synthetic UI</p>")


class RendererSettingsTests(unittest.TestCase):
    def test_builtin_template_catalog_validates_without_creating_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            before = list(Path(directory).iterdir())
            templates = builtin_document_templates()
            validate_document_catalog({"schemaVersion": 1, "templates": templates})
            self.assertEqual([item["id"] for item in templates], ["classic", "modern"])
            self.assertEqual(list(Path(directory).iterdir()), before)

    def test_supported_defaults_and_overrides_are_validated_without_mutation(self):
        template = builtin_document_templates()[0]
        before = copy.deepcopy(template)
        settings = validate_document_settings(template, {"bodyFontSize": 12, "pageMargin": 60, "pageNumbers": False})
        self.assertEqual(settings["bodyFontSize"], 12)
        self.assertEqual(settings["pageMargin"], 60)
        self.assertFalse(settings["pageNumbers"])
        self.assertEqual(template, before)
        for values in ({"fontSize": 12}, {"bodyFontSize": True}, {"bodyFontSize": 10**1000},
                       {"accentColor": "#ffffff\n"}, {"pageMargin": 100}, {"sectionSpacing": 0}, None):
            with self.subTest(values=values), self.assertRaises(ValueError):
                validate_document_settings(template, values)


class PdfRendererJavaScriptTests(unittest.TestCase):
    def setUp(self):
        self.node = shutil.which("node")
        if not self.node:
            installed = Path("C:/Program Files/nodejs/node.exe")
            self.node = str(installed) if installed.is_file() else None
        if not self.node:
            self.skipTest("Node.js unavailable; no installation will be attempted.")
        temporary = tempfile.TemporaryDirectory(prefix="studio-pdf-tests-")
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)

    def run_node(self, arguments, source=None):
        result = subprocess.run([self.node, *arguments], cwd=self.directory, input=source,
                                capture_output=True, text=True, encoding="utf-8", timeout=45, check=False)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result.stdout

    def test_actual_pinned_browser_bundle_and_shared_renderer_in_node(self):
        self.run_node(["--test", str(ROOT / "tests/pdf-renderer.test.mjs")])

    def test_python_and_javascript_agree_on_settings_and_render_envelopes(self):
        template = builtin_document_templates()[0]
        records = [{"template": template, "overrides": {}}]
        for key, values in (("bodyFontSize", [9, 13, 8, 14, True, "12"]), ("pageMargin", [36, 72, 73]),
                            ("sectionSpacing", [6, 24, 25]), ("accentColor", ["#123abc", "red", "#ffffff\n"]),
                            ("pageNumbers", [True, False, 1]), ("unknown", [12])):
            records.extend({"template": template, "overrides": {key: value}} for value in values)
        records.append({"template": template, "overrides": None})
        malformed = copy.deepcopy(template)
        malformed["supportedSettings"]["bodyFontSize"]["maximum"] = 99
        records.append({"template": malformed, "overrides": {}})
        f = json.loads((ROOT / "tests/fixtures/resume-data.json").read_text(encoding="utf-8"))
        f["registry"]["candidates"][0]["historyFolder"] = str(self.directory / "unopened-history")
        value = build_render_input(registry=f["registry"], candidate_id="candidate-one", profile=f["profile"], resume=f["resume"],
                                   documents={"schemaVersion": 1, "templates": builtin_document_templates()},
                                   document_template={"id": "classic", "version": 1}, bindings=f["bindings"],
                                   formatting_overrides={"bodyFontSize": 12})
        records.append({"input": value})
        for key, entry in (("schemaVersion", 2), ("formattingOverrides", {"fontSize": 12}),
                           ("profile", {**f["profile"], "candidateId": "other"}), ("bindings", {"experience": [], "education": []})):
            records.append({"input": {**value, key: entry}})
        expected = []
        for record in records:
            try:
                if "input" in record:
                    validate_render_input(record["input"])
                else:
                    validate_document_catalog({"schemaVersion": 1, "templates": [record["template"]]})
                    validate_document_settings(record["template"], record["overrides"])
                expected.append(True)
            except ValueError:
                expected.append(False)
        actual = json.loads(self.run_node([str(ROOT / "tests/renderer-contract-parity.mjs")], json.dumps(records)))
        self.assertEqual(actual, expected)
