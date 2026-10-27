"""Web integration hub: synthetic files, mocked HTTP handler, no registration."""
import io
import json
from types import SimpleNamespace
from unittest.mock import Mock, patch

import test_regression as regression
from tracker_config.web_studio import WebStudio


class ExtensionStudioTests(regression.IsolatedApplicationTestCase):
    def setUp(self):
        super().setUp()
        self.extension = self.root / "extension"
        self.extension.mkdir()
        self.manifest = self.extension / "manifest.json"
        self.manifest.write_text(json.dumps({"manifest_version": 3, "name": "Synthetic extension", "version": "0.5.0",
                                             "externally_connectable": {"matches": ["http://127.0.0.1/*"]}}))
        self.enterContext(patch.object(self.manager, "EXTENSION_DIR", self.extension))
        self.service = WebStudio(self.config)

    def handler(self, path="/api/studio/extension", method="GET", payload=None, headers=None):
        handler = self.manager.TrackerHandler.__new__(self.manager.TrackerHandler)
        handler.path = path
        handler.server = SimpleNamespace(server_port=8765)
        handler.headers = {"Host": "127.0.0.1:8765", "Origin": "http://127.0.0.1:8765",
                           "X-Tracker-Token": self.manager.SESSION_TOKEN, **(headers or {})}
        handler.wfile = io.BytesIO()
        for name in ("send_response", "send_header", "end_headers", "send_error", "send_json", "log_error"):
            setattr(handler, name, Mock())
        handler.read_json = Mock(return_value=payload)
        self.authorize_handler(handler)
        getattr(handler, "do_" + method)()
        return handler

    def put(self, scope, data, revision=None):
        return self.handler("/api/studio/extension/" + scope, "PUT", {"data": data, "revision": revision})

    def snapshot(self):
        return self.service.extension_settings(self.extension)

    def test_loading_defaults_is_read_only_and_does_not_require_candidates_or_catalogs(self):
        before = set(self.config.rglob("*"))
        response = self.handler().send_json.call_args.args
        self.assertEqual(response[0], 200)
        data = response[1]
        self.assertIsNone(data["preferences"]["revision"])
        self.assertIsNone(data["device"]["revision"])
        self.assertNotIn("id", data["device"]["data"])
        self.assertEqual(data["diagnostics"]["browserConnection"], "not-checked")
        self.assertEqual(data["diagnostics"]["nativeHost"], "not-checked")
        self.assertTrue(data["diagnostics"]["package"]["diagnosticBridge"])
        self.assertEqual(before, set(self.config.rglob("*")))
        self.registration.assert_not_called()

    def test_preferences_and_local_device_save_separately_with_stable_device_id(self):
        prefs = self.put("preferences", {"setupPage": "legacy-popup", "confirmSetupCopy": False})
        self.assertEqual(prefs.send_json.call_args.args[0], 200)
        self.assertFalse((self.config / "local").exists())
        device = self.put("device", {"label": "Synthetic laptop", "extensionId": regression.EXTENSION_ID, "probeTimeoutMs": 6000})
        saved = device.send_json.call_args.args[1]
        self.assertIn("id", saved["data"])
        updated = self.put("device", {"label": "Renamed laptop"}, saved["revision"]).send_json.call_args.args[1]
        self.assertEqual(updated["data"]["id"], saved["data"]["id"])
        self.assertEqual(self.snapshot()["preferences"]["data"]["setupPage"], "legacy-popup")
        self.assertTrue((self.config / "extension-studio.json").is_file())
        self.assertTrue((self.config / "local/extension-studio.json").is_file())
        self.registration.assert_not_called()

    def test_invalid_fields_and_unsupported_behavior_are_rejected_without_writes(self):
        invalid = [("preferences", {"setupPage": "arbitrary"}), ("preferences", {"confirmSetupCopy": 1}),
                   ("preferences", {"captureCandidateId": "candidate-one"}), ("preferences", {"schemaVersion": 2}),
                   ("device", {"extensionId": "bad"}), ("device", {"extensionId": "A" * 32}),
                   ("device", {"probeTimeoutMs": True}), ("device", {"probeTimeoutMs": 999}),
                   ("device", {"probeTimeoutMs": 15001}), ("device", {"label": "x" * 81}),
                   ("device", {"id": "forged"}), ("device", {"bidRoot": str(self.root)}),
                   ("preferences", {"path": str(self.root / "outside.json")})]
        for scope, data in invalid:
            with self.subTest(data=data):
                self.assertEqual(self.put(scope, data).send_json.call_args.args[0], 400)
        self.assertFalse((self.config / "extension-studio.json").exists())
        self.assertFalse((self.config / "local").exists())

    def test_revision_conflicts_preserve_newer_settings_in_both_scopes(self):
        for scope, first, second in [("preferences", {"setupPage": "legacy-popup"}, {"setupPage": "file-access"}),
                                      ("device", {"label": "First"}, {"label": "Newer"})]:
            initial = self.put(scope, first).send_json.call_args.args[1]
            self.put(scope, second, initial["revision"])
            stale = self.put(scope, first, initial["revision"])
            self.assertEqual(stale.send_json.call_args.args[0], 409)
            for key, value in second.items():
                self.assertEqual(self.snapshot()[scope]["data"][key], value)

    def test_unknown_record_fields_survive_targeted_edits(self):
        for scope in ("preferences", "device"):
            repository = getattr(self.service.repositories, "extension_" + scope)
            snapshot = repository.read()
            snapshot.data["future"] = {"nested": ["retain"]}
            saved = repository.save(snapshot.data, expected_revision=None)
            fields = {"confirmSetupCopy": False} if scope == "preferences" else {"label": "Changed"}
            self.put(scope, fields, saved.revision)
            self.assertEqual(repository.read().data["future"], {"nested": ["retain"]})

    def test_malformed_or_incompatible_settings_are_not_replaced_by_defaults(self):
        for raw in (b'{"schemaVersion":', b'{"schemaVersion":2}', b'{"schemaVersion":1,"schemaVersion":1}'):
            self.config.mkdir(exist_ok=True)
            path = self.config / "extension-studio.json"
            path.write_bytes(raw)
            self.assertEqual(self.handler().send_json.call_args.args[0], 400)
            self.assertEqual(self.put("preferences", {"confirmSetupCopy": False}).send_json.call_args.args[0], 400)
            self.assertEqual(path.read_bytes(), raw)

    def test_failed_atomic_write_keeps_previous_valid_settings(self):
        saved = self.put("device", {"label": "Original"}).send_json.call_args.args[1]
        path = self.config / "local/extension-studio.json"
        original = path.read_bytes()
        with patch("tracker_config.repositories.os.replace", side_effect=OSError("synthetic disk failure")):
            failed = self.put("device", {"label": "Replacement"}, saved["revision"])
        self.assertEqual(failed.send_json.call_args.args[0], 500)
        self.assertEqual(path.read_bytes(), original)
        self.assertFalse(list(path.parent.glob("*.tmp")))

    def test_no_candidate_selection_history_or_registration_changes(self):
        candidate = self.create_candidate()
        self.activate(candidate["id"])
        self.registration.reset_mock()
        original = self.registry.read_bytes()
        self.put("device", {"extensionId": regression.OTHER_EXTENSION_ID})
        self.put("preferences", {"setupPage": "legacy-popup"})
        self.handler()
        self.assertEqual(self.registry.read_bytes(), original)
        self.assertEqual(self.manager.load_state()["activeCandidateId"], candidate["id"])
        self.registration.assert_not_called()

    def test_authorization_and_request_envelope_are_not_weakened(self):
        for headers in ({"Host": "evil.test"}, {"Origin": "http://evil.test"}, {"X-Tracker-Token": "wrong"},
                        {"Origin": "chrome-extension://" + regression.EXTENSION_ID}):
            response = self.handler("/api/studio/extension/device", "PUT", {"data": {}, "revision": None}, headers)
            response.send_response.assert_called_once_with(403)
            self.assertEqual(json.loads(response.wfile.getvalue())["code"], "invalid-host" if "Host" in headers else "invalid-origin" if "Origin" in headers else "invalid-csrf")
            response.read_json.assert_not_called()
        for payload in ({"data": {}}, {"data": {}, "revision": 3}, {"data": {}, "revision": None, "path": "outside"}):
            response = self.handler("/api/studio/extension/device", "PUT", payload)
            self.assertEqual(response.send_json.call_args.args[0], 400)

    def test_package_diagnostics_fail_honestly_without_blocking_settings(self):
        for contents in ("not-json", "[]", '{"manifest_version":2}', '{"manifest_version":3,"name":"Test","version":"1","externally_connectable":{"matches":null}}'):
            self.manifest.write_text(contents)
            response = self.handler().send_json.call_args.args
            self.assertEqual(response[0], 200)
            self.assertEqual(response[1]["diagnostics"]["browserConnection"], "not-checked")
            self.assertFalse(response[1]["diagnostics"]["package"].get("diagnosticBridge", False))
        self.manifest.unlink()
        self.assertEqual(self.snapshot()["diagnostics"]["package"]["status"], "unavailable")

    def test_web_route_and_module_are_exact_read_only_resources(self):
        self.manager.UI_DIR.mkdir()
        for name in ("index.html", "extension-studio.mjs"):
            (self.manager.UI_DIR / name).write_bytes(b"synthetic local resource")
        for path, mime in (("/extension-studio", "text/html; charset=utf-8"), ("/extension-studio.mjs", "text/javascript; charset=utf-8")):
            response = self.handler(path)
            response.send_response.assert_called_once_with(200)
            response.send_header.assert_any_call("Content-Type", mime)
            self.assertEqual(response.wfile.getvalue(), b"synthetic local resource")
        for path in ("/local/extension-studio.json", "/config/extension-studio.json", "/../extension-studio.mjs", "/extension-studio/anything"):
            self.handler(path).send_error.assert_called_once_with(404)
        self.handler("/api/studio/extension/device", "DELETE", {"data": {}, "revision": None}).send_error.assert_called_once_with(404)
