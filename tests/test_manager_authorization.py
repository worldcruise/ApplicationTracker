"""Real HTTP authorization matrix: synthetic installation only."""
import http.client
import json
from unittest.mock import patch

from test_auth_http import AuthHttpFixture
from auth_fixtures import USERNAME, NEW_PASSWORD
from manager import app
from tracker_config.repositories import ConfigurationRepositories


class ManagerAuthorizationTests(AuthHttpFixture):
    def setUp(self):
        super().setUp()
        app.sync_host_registration.side_effect = None
        app.sync_host_registration.return_value = {"ok": True}
        self.prompt_file = self.directory / "linked.txt"
        self.prompt_file.write_text("Complete synthetic legacy prompt.\n", encoding="utf-8")
        self.candidate = {"id": "candidate-one", "name": "Alex Synthetic", "extensionId": "a" * 32,
                          "historyFolder": str(self.directory / "history"), "promptFilePath": str(self.prompt_file)}
        self.registry.write_text(json.dumps({"schemaVersion": 1, "activeCandidateId": None, "candidates": [self.candidate]}), encoding="utf-8")
        self.repos = ConfigurationRepositories(self.directory)
        self.prompt_id = self.repos.save_prompt({"name": "Synthetic prompt", "body": "Exact prompt body"}, template_id=None, expected_revision=None).data["templates"][0]["id"]
        self.document_id = self.repos.save_document({"name": "Synthetic document", "layoutId": "classic"}, template_id=None, expected_revision=None).data["templates"][0]["id"]
        self.routes = [
            ("GET", "/api/state"), ("GET", "/api/studio/state"), ("GET", "/api/studio/extension"),
            ("GET", "/api/candidates/candidate-one/template"), ("GET", "/api/studio/candidates/candidate-one/profile"),
            ("GET", "/api/studio/candidates/candidate-one/prompt"), ("POST", "/api/candidates"),
            ("PUT", "/api/candidates/candidate-one"), ("POST", "/api/active"),
            ("POST", "/api/folders/check"), ("POST", "/api/browse"),
            ("PUT", "/api/studio/candidates/candidate-one/profile"), ("PUT", "/api/studio/candidates/candidate-one/settings"),
            ("POST", "/api/studio/prompts"), ("PUT", "/api/studio/prompts/" + self.prompt_id),
            ("POST", "/api/studio/documents"), ("PUT", "/api/studio/documents/" + self.document_id),
            ("PUT", "/api/studio/extension/preferences"), ("PUT", "/api/studio/extension/device"),
            ("DELETE", "/api/candidates/candidate-one"),
        ]

    def close_server(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join(timeout=5)
        self.assertFalse(self.thread.is_alive())

    def payload(self, method, path):
        if path == "/api/candidates":
            return {**self.candidate, "name": "New Synthetic", "historyFolder": str(self.directory / "new-history")}
        if path == "/api/candidates/candidate-one":
            return self.candidate if method == "PUT" else {}
        if path == "/api/active":
            return {"candidateId": "candidate-one"}
        if path == "/api/browse":
            return {"kind": "folder", "currentPath": str(self.directory)}
        if path == "/api/folders/check":
            return {"historyFolder": str(self.directory / "probe-only")}
        if path.endswith("/profile"):
            return {"data": self.repos.profiles.new("candidate-one"), "revision": None}
        if path.endswith("/settings"):
            return {"data": {"preferredDocumentTemplateId": "modern"}, "revision": self.repos.candidates.read().revision}
        if "/prompts" in path:
            return {"data": {"name": "Updated synthetic prompt", "body": "Preserved\ncomplete text"}, "revision": self.repos.prompts.read().revision}
        if "/documents" in path:
            return {"data": {"name": "Updated synthetic document", "layoutId": "modern"}, "revision": self.repos.documents.read().revision}
        scope = path.rsplit("/", 1)[-1]
        return {"data": {"confirmSetupCopy": False} if scope == "preferences" else {"label": "Synthetic device"},
                "revision": getattr(self.repos, "extension_" + scope).read().revision}

    def test_all_20_operations_reject_anonymous_access_before_business_effects(self):
        before = {p: p.read_bytes() for p in self.directory.rglob("*") if p.is_file()}
        with patch.object(app, "candidate_repository", side_effect=AssertionError("Candidate lookup before authorization")), \
             patch.object(app, "WebStudio", side_effect=AssertionError("Studio before authorization")), \
             patch.object(app, "browse_path", side_effect=AssertionError("Picker before authorization")), \
             patch.object(app, "check_history_folder", side_effect=AssertionError("Probe before authorization")), \
             patch.object(app, "save_candidate", side_effect=AssertionError("Save before authorization")), \
             patch.object(app, "delete_candidate", side_effect=AssertionError("Delete before authorization")):
            for method, path in self.routes:
                with self.subTest(method=method, path=path):
                    status, headers, data = self.request(method, path)
                    self.assertEqual((status, data["code"]), (401, "authentication-required"))
                    self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(before, {p: p.read_bytes() for p in self.directory.rglob("*") if p.is_file()})
        app.sync_host_registration.assert_not_called()

    def test_all_20_operations_work_for_verified_owner(self):
        token, _, _ = self.login_http()
        with patch.object(app, "browse_path", return_value=str(self.directory)) as picker:
            for method, path in self.routes:
                with self.subTest(method=method, path=path):
                    payload = self.payload(method, path) if method != "GET" else UNSET
                    options = {} if method == "GET" else {"payload": payload}
                    status, _, data = self.request(method, path, token=token, **options)
                    self.assertEqual(status, 200, data)
            picker.assert_called_once()
        self.assertFalse((self.directory / "probe-only").exists())
        self.assertEqual(self.prompt_file.read_text(), "Complete synthetic legacy prompt.\n")

    def test_expiration_logout_reset_and_missing_owner_protect_business_reads(self):
        token, _, _ = self.login_http()
        self.clock.now = 1800
        self.assertEqual(self.request("GET", "/api/state", token=token)[0], 401)
        token, _, _ = self.login_http()
        self.request("POST", "/api/auth/logout", token=token)
        self.assertEqual(self.request("GET", "/api/studio/state", token=token)[0], 401)
        token, _, _ = self.login_http()
        self.repository.reset_password(USERNAME, NEW_PASSWORD, expected_revision=self.repository.read().revision)
        self.assertEqual(self.request("GET", "/api/state", token=token)[0], 401)
        self.repository.path.unlink()
        self.assertEqual(self.request("GET", "/api/state", token=token)[2]["code"], "owner-setup-required")

    def test_bad_security_origin_csrf_ids_and_aliases_never_bypass_guard(self):
        token, _, _ = self.login_http()
        for path in ("/api/state/", "/api/state?user_id=fake", "/api/unknown", "/api/studio/candidates/unknown/profile"):
            self.assertEqual(self.request("GET", path)[0], 401)
        for method in ("HEAD", "OPTIONS", "PATCH", "FOO"):
            self.assertEqual(self.request(method, "/api/state")[0], 401)
            self.assertEqual(self.request(method, "/api/state", token=token)[0], 405)
        for path in ("/api/state", "/api/auth/session"):
            for method in ("GET", "FOO"):
                self.assertEqual(self.request(method, path, token=token, headers={"Host": "evil.test"})[0], 403)
                self.assertEqual(self.request(method, path, token=token, headers={"Origin": "http://evil.test"})[0], 403)
        for suffix in ("/", "?ignored=true"):
            self.assertIn(self.request("GET", "/api/state" + suffix, token=token)[0], (200, 404))
        # Framing checks precede both owner lookup and body consumption.
        address = f"127.0.0.1:{self.server.server_port}"
        for invalid_headers in ("Content-Length: 0\r\nContent-Length: 0", "Transfer-Encoding: chunked", "Expect: 100-continue"):
            request = f"GET /api/state HTTP/1.1\r\nHost: {address}\r\n{invalid_headers}\r\n\r\n".encode()
            self.assertEqual(self.wire(request)[0], 400)
        self.assertEqual(self.request("GET", f"http://{address}/api/state", token=token)[0], 400)
        for method in ("POST", "PUT", "DELETE"):
            self.assertEqual(self.request(method, "/api/candidates/candidate-one", token=token, headers={"Origin": "http://evil.test"})[0], 403)
            self.assertEqual(self.request(method, "/api/candidates/candidate-one", token=token, headers={"X-Tracker-Token": "wrong"})[0], 403)
        self.assertEqual(self.request("GET", "/api/studio/candidates/unknown/profile", token=token)[0], 400)
        self.assertEqual(self.request("GET", "/api/unknown", token=token)[0], 404)
        self.write(self.repository.path, b"corrupt")
        self.assertEqual(self.request("GET", "/api/state", token=token)[2]["code"], "authentication-unavailable")

    def test_all_17_static_resources_stay_public_without_configuration_access(self):
        paths = ["/", "/extension-studio", "/styles.css", "/app.js", "/studio-app.mjs", "/studio-core.mjs", "/extension-studio.mjs", "/classic.svg", "/modern.svg", *app.SHARED_STATIC_FILES]
        self.assertEqual(len(paths), 17)
        with patch.object(app, "candidate_repository", side_effect=AssertionError("Static candidate access")):
            for path in [*paths, "/auth.mjs"]:
                connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port)
                try:
                    connection.request("GET", path)
                    response = connection.getresponse(); response.read()
                    self.assertEqual(response.status, 200, path)
                finally:
                    connection.close()
        for path in ("/config/security.json", "/config/candidates.json", "/shared/../config/security.json", "/shared/%2e%2e/config/candidates.json"):
            # These are never served; use the raw client because 404 is HTML.
            connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port)
            try:
                connection.request("GET", path)
                response = connection.getresponse(); response.read(); self.assertEqual(response.status, 404)
            finally:
                connection.close()


UNSET = object()
