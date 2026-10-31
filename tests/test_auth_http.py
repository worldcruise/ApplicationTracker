"""Actual loopback HTTP requests; no production server, account, browser or host."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import redirect_stderr
import http.client
from http.cookies import SimpleCookie
from io import StringIO
import json
from pathlib import Path
import shutil
import socket
import subprocess
from http.server import ThreadingHTTPServer
import threading
from urllib.parse import quote
from unittest.mock import patch

from auth_fixtures import AuthFixture, PASSWORD, NEW_PASSWORD, USERNAME
from manager import app
from manager.auth_http import COOKIE_NAME
from tracker_config import auth
from tracker_config.auth import AuthService
from tracker_config.security import owner_repository


UNSET = object()


class AuthHttpFixture(AuthFixture):
    def setUp(self):
        super().setUp()
        self.config_directory = self.root / "config"
        self.config_directory.mkdir()
        self.registry = self.config_directory / "candidates.json"
        self.registry.write_text(json.dumps({"schemaVersion": 1, "activeCandidateId": None, "candidates": []}), encoding="utf-8")
        self.registry_before = self.registry.read_bytes()
        self.enterContext(patch.object(app, "CONFIG_FILE", self.registry))
        self.enterContext(patch.object(app, "sync_host_registration", side_effect=AssertionError("Registration forbidden")))
        self.enterContext(patch("webbrowser.open", side_effect=AssertionError("Browser startup forbidden")))
        self.logs = StringIO()
        self.enterContext(redirect_stderr(self.logs))
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), app.TrackerHandler)
        self.server.auth_service = self.service
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        self.thread.start()
        self.addCleanup(self.close_server)

    def close_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        self.assertFalse(self.thread.is_alive())
        if self.registry.exists():
            self.assertEqual(self.registry_before, self.registry.read_bytes())

    def request(self, method, path, *, payload=UNSET, raw=None, headers=None, token=None):
        request_headers = {"Host": f"127.0.0.1:{self.server.server_port}",
                           "Origin": f"http://127.0.0.1:{self.server.server_port}", "X-Tracker-Token": app.SESSION_TOKEN}
        if token is not None:
            request_headers["Cookie"] = f"{COOKIE_NAME}={token}"
        if method == "POST" and payload is UNSET and raw is None:
            payload = {}
        if payload is not UNSET:
            raw = json.dumps(payload).encode("utf-8")
            request_headers["Content-Type"] = "application/json"
        for name, value in (headers or {}).items():
            if value is None:
                request_headers.pop(name, None)
            else:
                request_headers[name] = value
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        try:
            connection.request(method, path, body=raw, headers=request_headers)
            response = connection.getresponse()
            content = response.read()
            response_headers = dict(response.getheaders())
            return response.status, response_headers, json.loads(content) if content else None
        finally:
            connection.close()

    def login_http(self, **options):
        status, headers, data = self.request("POST", "/api/auth/login", payload={"username": USERNAME, "password": PASSWORD}, **options)
        self.assertEqual(status, 200, data)
        cookie = SimpleCookie()
        cookie.load(headers["Set-Cookie"])
        return cookie[COOKIE_NAME].value, headers, data

    def wire(self, request):
        connection = socket.create_connection(("127.0.0.1", self.server.server_port), timeout=5)
        try:
            connection.sendall(request)
            connection.shutdown(socket.SHUT_WR)
            response = http.client.HTTPResponse(connection)
            response.begin()
            content = response.read()
            return response.status, dict(response.getheaders()), json.loads(content) if content else None
        finally:
            connection.close()


class AuthHttpTests(AuthHttpFixture):
    def test_private_default_discovery_setup_and_login_use_real_http(self):
        repository = owner_repository()
        self.server.auth_service = AuthService(repository, clock=self.clock)
        before = {path: path.read_bytes() for path in self.root.rglob("*") if path.is_file()}
        for _ in range(2):
            self.assertEqual(self.request("GET", "/api/auth/status")[2]["state"], "setup-required")
        self.assertEqual(self.request("GET", "/api/state")[2]["code"], "owner-setup-required")
        self.assertFalse(repository.directory.exists())
        self.assertEqual(before, {path: path.read_bytes() for path in self.root.rglob("*") if path.is_file()})
        repository.initialize(USERNAME, PASSWORD)
        self.assertEqual(self.request("GET", "/api/auth/status")[2]["state"], "ready")
        token, _, data = self.login_http()
        self.assertEqual(data["user"]["id"], repository.read().data["users"][0]["id"])
        self.assertEqual(self.request("GET", "/api/state", token=token)[0], 200)
        repository.reset_password(USERNAME, NEW_PASSWORD, expected_revision=repository.read().revision)
        self.assertEqual(self.request("GET", "/api/auth/session", token=token)[0], 401)
        self.assertFalse((self.config_directory / "security.json").exists())

    def test_private_storage_legacy_conflict_and_corruption_are_unavailable_over_http(self):
        repository = owner_repository()
        self.server.auth_service = AuthService(repository)
        repository.initialize(USERNAME, PASSWORD)
        token, _, _ = self.login_http()
        legacy = self.root / "legacy"; legacy.mkdir()
        sentinel = legacy / "security.json.bak"; sentinel.write_bytes(b"legacy synthetic sentinel")
        self.assertEqual(self.request("GET", "/api/auth/status")[2]["state"], "unavailable")
        self.assertEqual(self.request("GET", "/api/state", token=token)[0], 503)
        self.assertEqual(sentinel.read_bytes(), b"legacy synthetic sentinel")
        sentinel.unlink()
        from tracker_config.security_files import private_atomic_write
        private_atomic_write(repository.path, b"corrupt synthetic owner", permissions=repository.permissions)
        self.assertEqual(self.request("GET", "/api/auth/status")[2]["state"], "unavailable")
        self.assertEqual(self.request("POST", "/api/auth/login", payload={"username": USERNAME, "password": PASSWORD})[0], 503)

    def test_browser_receiver_bootstrap_login_and_studio_use_real_http(self):
        node = shutil.which("node") or r"C:\Program Files\nodejs\node.exe"
        if not Path(node).is_file():
            self.skipTest("Node.js unavailable; no dependencies installed")
        script = r"""
import assert from 'node:assert/strict';
const { ManagerAuth } = await import(process.argv[1]);
const [origin, username, password, ownerId] = process.argv.slice(2);
const nativeFetch = globalThis.fetch;
let cookie = '', loaded = 0;
// Node has no browser cookie jar/automatic Origin header. This test-only adapter
// supplies them and enforces the Window.fetch receiver contract; it is not Chrome.
const browserFetch = function(path, options) {
  assert.equal(this, globalThis, 'Detached browser-native fetch invocation');
  const url = new URL(path, origin); assert.equal(url.origin, origin);
  const headers = { ...options.headers, Origin: origin };
  if (cookie) headers.Cookie = cookie;
  return nativeFetch(url, { ...options, headers }).then(response => {
    const issued = response.headers.get('set-cookie');
    if (issued) cookie = issued.split(';')[0];
    return response;
  });
};
const auth = new ManagerAuth({ fetch: browserFetch, onAuthenticated: async owner => {
  assert.equal(owner.id, ownerId);
  const state = await auth.api('/api/state'); assert.deepEqual(state.candidates, []);
  await auth.api('/api/studio/state'); await auth.api('/api/studio/extension'); loaded++;
} });
try {
  await auth.start(); assert.equal(auth.phase, 'login'); assert.equal(loaded, 0);
  await auth.login(username, password);
  assert.equal(auth.phase, 'authenticated'); assert.equal(loaded, 1);
  assert.equal(await auth.logout(), true);
  const denied = await browserFetch.call(globalThis, '/api/state', {});
  assert.equal(denied.status, 401);
} finally { auth.dispose(); }
"""
        received = []
        original_get = app.TrackerHandler.do_GET

        def record_get(handler):
            received.append(handler.path)
            return original_get(handler)

        with patch.object(app.TrackerHandler, "do_GET", record_get):
            result = subprocess.run([node, "--input-type=module", "-e", script,
                                     (Path(app.__file__).parent / "ui/auth.mjs").as_uri(),
                                     f"http://127.0.0.1:{self.server.server_port}", USERNAME, PASSWORD,
                                     self.record["users"][0]["id"]], cwd=self.directory,
                                    text=True, capture_output=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(received[:2], ["/api/auth/status", "/api/auth/session"])
        self.assertIn("/api/studio/state", received)
        self.assertIn("/api/studio/extension", received)
        self.assertFalse(self.service._sessions)

    def test_status_bootstraps_csrf_without_candidate_or_owner_details(self):
        original = Path.open

        def guarded(path, *args, **kwargs):
            if Path(path) == self.registry:
                raise AssertionError("Auth status must not read candidate data")
            return original(path, *args, **kwargs)

        with patch.object(Path, "open", guarded):
            status, headers, data = self.request("GET", "/api/auth/status", headers={"Origin": None})
        self.assertEqual(status, 200)
        self.assertEqual(data, {"state": "ready", "csrfToken": app.SESSION_TOKEN,
                               "idleTimeoutSeconds": 1800, "absoluteTimeoutSeconds": 28800,
                               "managerAuthorizationEnforced": True})
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
        self.assertNotIn("Set-Cookie", headers)

    def test_successful_login_cookie_and_authenticated_session(self):
        token, headers, data = self.login_http()
        self.assertEqual(data["user"]["id"], self.record["users"][0]["id"])
        self.assertNotIn(token, json.dumps(data))
        cookie = SimpleCookie()
        cookie.load(headers["Set-Cookie"])
        value = cookie[COOKIE_NAME]
        self.assertTrue(value["httponly"])
        self.assertEqual(value["samesite"], "Strict")
        self.assertEqual(value["path"], "/api/")
        self.assertEqual(value["max-age"], "28800")
        self.assertEqual(value["domain"], "")
        self.assertEqual(value["secure"], "")
        self.assertEqual(self.request("GET", "/api/auth/session", token=token)[0], 200)
        self.assertFalse(any(name.lower().startswith("access-control-") for name in headers))

    def test_bad_password_unknown_username_and_disabled_owner_are_generic(self):
        errors = []
        for username, password in ((USERNAME, "incorrect"), ("unknown-owner", PASSWORD)):
            status, _, data = self.request("POST", "/api/auth/login", payload={"username": username, "password": password})
            self.assertEqual(status, 401)
            errors.append(data)
        self.record["users"][0]["disabled"] = True
        self.write(self.repository.path, json.dumps(self.record).encode())
        errors.append(self.request("POST", "/api/auth/login", payload={"username": USERNAME, "password": PASSWORD})[2])
        self.assertEqual(errors, [{"error": "Invalid username or password.", "code": "invalid-credentials"}] * 3)

    def test_missing_unknown_and_wrong_type_input_fields_are_rejected(self):
        for payload in ({}, {"username": USERNAME}, {"username": USERNAME, "password": None},
                        {"username": USERNAME, "password": PASSWORD, "user_id": "client-owner"},
                        {"username": [], "password": PASSWORD}, {"username": USERNAME, "password": ""}):
            status, _, data = self.request("POST", "/api/auth/login", payload=payload)
            self.assertEqual((status, data["code"]), (400, "invalid-request"))
        for path in ("activity", "logout"):
            self.assertEqual(self.request("POST", "/api/auth/" + path, payload={"user_id": "fake"})[0], 400)

    def test_malformed_duplicate_nonfinite_and_non_utf8_json_are_rejected(self):
        cases = [b"{", b"[]", b'{"username":"first","username":"second","password":"x"}',
                 b'{"username":NaN,"password":"x"}', b"\xff", b'{"username":"x","password":Infinity}']
        for raw in cases:
            status, _, data = self.request("POST", "/api/auth/login", raw=raw, headers={"Content-Type": "application/json"})
            self.assertEqual((status, data["code"]), (400, "invalid-request"))

    def test_content_type_body_size_and_get_body_limits(self):
        for content_type in ("text/plain", "application/x-www-form-urlencoded", "application/json; charset=latin1"):
            self.assertEqual(self.request("POST", "/api/auth/login", raw=b"{}", headers={"Content-Type": content_type})[0], 400)
        self.assertEqual(self.request("POST", "/api/auth/login", raw=b"x" * 8193, headers={"Content-Type": "application/json"})[0], 400)
        self.assertEqual(self.request("GET", "/api/auth/status", raw=b"{}", headers={"Content-Length": "2"})[0], 400)

    def test_ambiguous_framing_and_duplicate_critical_headers_are_rejected_on_wire(self):
        host = f"127.0.0.1:{self.server.server_port}"
        common = f"POST /api/auth/login HTTP/1.1\r\nHost: {host}\r\nOrigin: http://{host}\r\nX-Tracker-Token: {app.SESSION_TOKEN}\r\nContent-Type: application/json\r\n"
        for extra in ("Content-Length: 2\r\nContent-Length: 2", "Content-Length: 2\r\nTransfer-Encoding: chunked",
                      "Content-Length: -2", "Content-Length: +2", "Content-Length: 2,2",
                      f"Host: {host}\r\nContent-Length: 2", "Content-Length: 2\r\nExpect: 100-continue",
                      f"Origin: http://{host}\r\nContent-Length: 2", "Content-Length: 2\r\nCookie: a=b\r\nCookie: c=d"):
            status, headers, data = self.wire((common + extra + "\r\n\r\n{}").encode())
            self.assertEqual((status, data["code"]), (400, "invalid-request"))
            self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
        self.assertFalse(self.service._sessions)

    def test_truncated_body_is_rejected_without_waiting_for_missing_bytes(self):
        host = f"127.0.0.1:{self.server.server_port}"
        wire = f"POST /api/auth/login HTTP/1.1\r\nHost: {host}\r\nOrigin: http://{host}\r\nX-Tracker-Token: {app.SESSION_TOKEN}\r\nContent-Type: application/json\r\nContent-Length: 10\r\n\r\n{{}}"
        self.assertEqual(self.wire(wire.encode())[0], 400)

    def test_host_origin_csrf_and_fetch_site_checks_apply_before_login(self):
        for headers in ({"Host": "localhost:8765"}, {"Host": "attacker.test"}, {"Origin": "null"},
                        {"Origin": "https://attacker.test"}, {"Origin": None}, {"X-Tracker-Token": None},
                        {"X-Tracker-Token": "wrong"}, {"Sec-Fetch-Site": "cross-site"}, {"Sec-Fetch-Site": "same-site"}):
            status, _, data = self.request("POST", "/api/auth/login", payload={"username": USERNAME, "password": PASSWORD}, headers=headers)
            self.assertEqual(status, 403, data)
        self.assertFalse(self.service._attempts)
        for path in ("status", "session"):
            self.assertEqual(self.request("GET", "/api/auth/" + path, headers={"Origin": "http://other.test"})[0], 403)

    def test_status_polling_does_not_renew_and_activity_renewal_preserves_absolute_deadline(self):
        token, _, _ = self.login_http()
        self.clock.now = 1700
        status, _, data = self.request("GET", "/api/auth/session", token=token)
        self.assertEqual((status, data["session"]["idleRemainingSeconds"]), (200, 100))
        status, _, data = self.request("POST", "/api/auth/activity", token=token)
        self.assertEqual((status, data["session"]), (200, {"idleRemainingSeconds": 1800, "absoluteRemainingSeconds": 27100}))
        self.clock.now = 3500
        self.assertEqual(self.request("POST", "/api/auth/activity", token=token)[0], 401)
        self.assertFalse(self.service._sessions)

    def test_absolute_expiration_is_enforced_by_http_activity(self):
        token, _, _ = self.login_http()
        for now in range(1700, 28800, 1700):
            self.clock.now = now
            self.assertEqual(self.request("POST", "/api/auth/activity", token=token)[0], 200)
        self.clock.now = 28800
        self.assertEqual(self.request("POST", "/api/auth/activity", token=token)[0], 401)

    def test_logout_revokes_server_session_and_clears_matching_cookie_scope(self):
        token, _, _ = self.login_http()
        status, headers, data = self.request("POST", "/api/auth/logout", token=token)
        self.assertEqual((status, data), (200, {"authenticated": False}))
        cookie = SimpleCookie()
        cookie.load(headers["Set-Cookie"])
        self.assertEqual(cookie[COOKIE_NAME]["max-age"], "0")
        self.assertEqual(cookie[COOKIE_NAME]["path"], "/api/")
        self.assertTrue(cookie[COOKIE_NAME]["httponly"])
        self.assertEqual(cookie[COOKIE_NAME]["samesite"], "Strict")
        self.assertEqual(self.request("GET", "/api/auth/session", token=token)[0], 401)
        self.assertEqual(self.request("POST", "/api/auth/logout", token=token)[0], 200)

    def test_missing_invalid_duplicate_and_csrf_tokens_cannot_authenticate(self):
        for token in (None, "invalid", app.SESSION_TOKEN):
            status, headers, data = self.request("GET", "/api/auth/session", token=token)
            self.assertEqual((status, data["code"]), (401, "authentication-required"))
            self.assertIn("Max-Age=0", headers["Set-Cookie"])
        token, _, _ = self.login_http()
        self.assertEqual(self.request("GET", "/api/auth/session", headers={"Cookie": f"{COOKIE_NAME}={token}; {COOKIE_NAME}={token}"})[0], 400)

    def test_reset_and_backend_restart_revoke_existing_cookie(self):
        token, _, _ = self.login_http()
        self.repository.reset_password(USERNAME, NEW_PASSWORD, expected_revision=self.repository.read().revision)
        self.assertEqual(self.request("GET", "/api/auth/session", token=token)[0], 401)
        status, headers, _ = self.request("POST", "/api/auth/login", payload={"username": USERNAME, "password": NEW_PASSWORD})
        self.assertEqual(status, 200)
        cookie = SimpleCookie()
        cookie.load(headers["Set-Cookie"])
        self.server.auth_service = AuthService(self.repository, clock=self.clock)
        self.assertEqual(self.request("GET", "/api/auth/session", token=cookie[COOKIE_NAME].value)[0], 401)

    def test_real_http_rate_limit_returns_retry_after_and_recovers(self):
        for _ in range(10):
            self.assertEqual(self.request("POST", "/api/auth/login", payload={"username": USERNAME, "password": "wrong"})[0], 401)
        status, headers, data = self.request("POST", "/api/auth/login", payload={"username": USERNAME, "password": PASSWORD})
        self.assertEqual((status, data["code"], headers["Retry-After"]), (429, "rate-limited", "300"))
        self.clock.now = 300
        self.login_http()

    def test_corrupt_or_missing_owner_fails_closed_without_creating_an_account(self):
        token, _, _ = self.login_http()
        self.write(self.repository.path, b"broken private security file")
        self.assertEqual(self.request("GET", "/api/auth/status")[2]["state"], "unavailable")
        self.assertEqual(self.request("GET", "/api/auth/session", token=token)[0], 503)
        self.assertEqual(self.request("POST", "/api/auth/login", payload={"username": USERNAME, "password": PASSWORD})[0], 503)
        self.repository.path.unlink()
        self.assertEqual(self.request("GET", "/api/auth/status")[2]["state"], "setup-required")
        self.assertEqual(self.request("POST", "/api/auth/login", payload={"username": USERNAME, "password": PASSWORD})[2]["code"], "owner-setup-required")
        self.assertFalse(self.repository.path.exists())
        self.assertFalse(self.repository.backup_path.exists())
        self.assertEqual(self.request("POST", "/api/auth/logout", token=token)[0], 200)

    def test_credential_url_errors_and_unexpected_exceptions_do_not_leak_secrets(self):
        token, _, data = self.login_http()
        status, _, query_data = self.request("GET", "/api/auth/status?password=" + quote(PASSWORD) + "&token=" + token)
        self.assertEqual(status, 400)
        with patch.object(self.service, "login", side_effect=RuntimeError(PASSWORD + token)):
            status, _, error_data = self.request("POST", "/api/auth/login", payload={"username": USERNAME, "password": PASSWORD})
        self.assertEqual(status, 503)
        combined = self.logs.getvalue() + json.dumps([data, query_data, error_data])
        for forbidden in (PASSWORD, quote(PASSWORD), token, "passwordVerifier", "digest", self.record["users"][0]["passwordVerifier"]["digest"]):
            self.assertNotIn(forbidden, combined)

    def test_wrong_methods_unknown_routes_and_url_input_have_safe_structured_errors(self):
        for method in ("PUT", "DELETE", "PATCH", "HEAD", "OPTIONS", "TRACE", "FOO"):
            status, headers, data = self.request(method, "/api/auth/session")
            self.assertEqual(status, 405)
            self.assertEqual(headers["Allow"], "GET")
            self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
        self.assertEqual(self.request("GET", "/api/auth/registration")[0], 404)
        self.assertEqual(self.request("GET", "/api/auth/status?user_id=fake")[0], 400)

    def test_invalid_service_responses_cannot_disclose_internal_fields(self):
        for value in ({"passwordVerifier": self.record["users"][0]["passwordVerifier"]}, {"authenticated": True, "user": {}, "session": {}}):
            with patch.object(self.service, "session", return_value=value):
                status, _, data = self.request("GET", "/api/auth/session", token="a" * 43)
            self.assertEqual(status, 503)
            self.assertNotIn("passwordVerifier", json.dumps(data))
        with patch.object(self.service, "status", return_value=self.record):
            self.assertEqual(self.request("GET", "/api/auth/status")[0], 503)

    def test_existing_manager_routes_keep_old_protections_and_studio_remains_accessible(self):
        self.assertEqual(self.request("GET", "/api/state")[0], 401)
        token, _, _ = self.login_http()
        status, _, data = self.request("GET", "/api/state", token=token)
        self.assertEqual((status, data["sessionToken"], data["candidates"]), (200, app.SESSION_TOKEN, []))
        self.assertEqual(self.request("GET", "/api/state", headers={"Host": "attacker.test"})[0], 403)
        for headers in ({"Origin": "http://attacker.test"}, {"X-Tracker-Token": "wrong"}):
            self.assertEqual(self.request("POST", "/api/active", payload={"candidateId": "unknown"}, headers=headers)[0], 403)
        self.assertEqual(self.request("GET", "/api/studio/state", token=token)[0], 200)
        self.assertEqual(self.request("POST", "/api/active", payload={"candidateId": "unknown"}, token=token)[0], 400)

    def test_concurrent_real_http_logins_and_logouts_keep_sessions_separate(self):
        with ThreadPoolExecutor(max_workers=2) as pool:
            tokens = list(pool.map(lambda _: self.login_http()[0], range(2)))
        self.assertEqual(len(set(tokens)), 2)
        with ThreadPoolExecutor(max_workers=2) as pool:
            statuses = list(pool.map(lambda token: self.request("POST", "/api/auth/logout", token=token)[0], tokens))
        self.assertEqual(statuses, [200, 200])
        self.assertFalse(self.service._sessions)

    def test_real_http_password_verification_concurrency_limit(self):
        entered, release = threading.Barrier(3), threading.Event()
        original = auth.verify_password

        def blocked(*args):
            entered.wait(timeout=5)
            if not release.wait(5):
                raise AssertionError("Synthetic verification barrier timed out")
            return original(*args)

        with ThreadPoolExecutor(max_workers=2) as pool, patch.object(auth, "verify_password", side_effect=blocked):
            futures = [pool.submit(self.login_http) for _ in range(2)]
            try:
                entered.wait(timeout=5)
                status, headers, data = self.request("POST", "/api/auth/login", payload={"username": USERNAME, "password": PASSWORD})
                self.assertEqual((status, data["code"], headers["Retry-After"]), (429, "rate-limited", "1"))
            finally:
                release.set()
            self.assertEqual(len({future.result(timeout=5)[0] for future in futures}), 2)

    def test_real_http_login_rejects_a_password_reset_during_verification(self):
        entered, release = threading.Event(), threading.Event()
        original = auth.verify_password

        def blocked(*args):
            result = original(*args)
            entered.set()
            if not release.wait(5):
                raise AssertionError("Synthetic reset barrier timed out")
            return result

        with ThreadPoolExecutor(max_workers=1) as pool, patch.object(auth, "verify_password", side_effect=blocked):
            future = pool.submit(self.request, "POST", "/api/auth/login", payload={"username": USERNAME, "password": PASSWORD})
            try:
                self.assertTrue(entered.wait(5))
                self.repository.reset_password(USERNAME, NEW_PASSWORD, expected_revision=self.repository.read().revision)
            finally:
                release.set()
            self.assertEqual(future.result(timeout=5)[0], 401)
        self.assertFalse(self.service._sessions)

    def test_real_http_session_capacity_error_keeps_unrelated_sessions_valid(self):
        # Fill capacity through the actual service, isolating only the other
        # resource limits. The final HTTP login uses the real password verifier.
        with patch.object(auth, "verify_password", return_value=True), patch.object(self.service, "_attempt"):
            tokens = [self.service.login(USERNAME, PASSWORD).token for _ in range(128)]
        before = set(self.service._sessions)
        status, _, data = self.request("POST", "/api/auth/login", payload={"username": USERNAME, "password": PASSWORD})
        self.assertEqual((status, data["code"]), (503, "session-capacity"))
        self.assertEqual(before, set(self.service._sessions))
        self.assertEqual(self.request("GET", "/api/auth/session", token=tokens[0])[0], 200)
