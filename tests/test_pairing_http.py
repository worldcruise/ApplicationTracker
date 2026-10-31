"""Actual owner-protected loopback HTTP pairing, isolated from production stores."""
from concurrent.futures import ThreadPoolExecutor
import io
import json
import secrets
from contextlib import redirect_stderr
from unittest.mock import patch

from test_auth_http import AuthHttpFixture
from tracker_config.auth import AuthError
from tracker_config.models import RevisionConflict
from tracker_config.browser_bindings import BrowserBindingRepository, BrowserPairingService
from tracker_config.repositories import ConfigurationRepositories
from tracker_config.security_files import private_atomic_write
from manager import app, pairing_http


BASE = "/api/studio/extension/"
ORIGIN = "chrome-extension://" + "a" * 32


class PairingHttpFixture(AuthHttpFixture):
    def setUp(self):
        super().setUp()
        self.registry.write_text(json.dumps({"schemaVersion": 1, "activeCandidateId": "candidate-one", "candidates": [
            {"id": candidate, "name": candidate, "extensionId": "a" * 32,
             "historyFolder": str(self.root / candidate), "promptTemplate": "templates/synthetic.txt"}
            for candidate in ("candidate-one", "candidate-two")]}), encoding="utf-8")
        self.registry_before = self.registry.read_bytes()
        self.repos = ConfigurationRepositories(self.config_directory)
        device = self.repos.save_extension_settings("device", {"extensionId": "a" * 32}, expected_revision=None).data
        self.pairings = BrowserPairingService(BrowserBindingRepository(self.repository), self.repos.candidates, device["id"], ORIGIN, clock=self.clock)
        self.server.pairing_service = self.pairings
        self.server.pairing_service_key = (device["id"], "a" * 32)
        self.token, _, _ = self.login_http()
        status, _, context = self.request("GET", "/api/extension/bootstrap", headers={"Origin": ORIGIN, "X-Tracker-Token": None})
        self.assertEqual(status, 200, context)
        self.enrollment_token = context["requestToken"]

    def enrollment(self, method, path, **options):
        headers = {"Origin": ORIGIN, "X-Tracker-Token": self.enrollment_token, **options.pop("headers", {})}
        return self.request(method, "/api/extension/" + path, headers=headers, **options)

    def create(self):
        secret = secrets.token_urlsafe(32)
        status, _, result = self.enrollment("POST", "pairings", headers={"X-Pairing-Exchange": secret},
                                           payload={"label": "Synthetic Chrome", "protocolVersion": 1})
        row = {"id": result.get("pairingId"), "revision": 1}
        self.assertEqual(status, 201, result)
        return row, secret

    def approve(self, row, candidate="candidate-one"):
        return self.request("POST", BASE + f"pairings/{row['id']}/approve", token=self.token,
                            payload={"candidateId": candidate, "revision": row["revision"]})

    def claim(self, row, secret):
        return self.enrollment("POST", f"pairings/{row['id']}/claim", payload={}, headers={"X-Pairing-Exchange": secret})

    def enroll(self, candidate="candidate-one"):
        row, secret = self.create(); self.assertEqual(self.approve(row, candidate)[0], 200)
        status, _, enrolled = self.claim(row, secret); self.assertEqual(status, 200)
        return enrolled


class PairingHttpTests(PairingHttpFixture):
    def test_all_management_creation_and_claim_routes_require_owner_before_effects(self):
        record = "a" * 32
        routes = [("GET", "pairings", None), ("GET", "installations", None),
                  ("POST", "pairings", {"label": "Test", "extensionOrigin": ORIGIN, "exchangeSecret": secrets.token_urlsafe(32)}),
                  ("POST", f"pairings/{record}/approve", {"candidateId": "candidate-one", "revision": 1}),
                  ("POST", f"pairings/{record}/deny", {"revision": 1}), ("POST", f"pairings/{record}/claim", {}),
                  ("PUT", f"installations/{record}/binding", {"candidateId": "candidate-one", "revision": 1}),
                  ("POST", f"installations/{record}/revoke", {"revision": 1})]
        before = {p: p.read_bytes() for p in self.root.rglob("*") if p.is_file()}
        with patch.object(pairing_http, "service_for", side_effect=AssertionError("Pairing access before owner auth")):
            for method, path, payload in routes:
                options = {} if method == "GET" else {"payload": payload}
                with self.subTest(method=method, path=path):
                    status, _, body = self.request(method, BASE + path, **options)
                    self.assertEqual((status, body["code"]), (401, "authentication-required"))
        self.assertEqual(before, {p: p.read_bytes() for p in self.root.rglob("*") if p.is_file()})

    def test_real_http_approval_pending_claim_wrong_secret_and_single_delivery(self):
        row, secret = self.create()
        self.assertEqual(self.claim(row, secret)[0], 202)
        status, headers, approval = self.approve(row)
        self.assertEqual(status, 200); self.assertNotIn("installationCredential", approval)
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(self.claim(row, secrets.token_urlsafe(32))[0], 403)
        status, _, enrolled = self.claim(row, secret)
        self.assertEqual(status, 200)
        self.assertEqual(self.claim(row, secret)[0], 409)
        for path in ("pairings", "installations"):
            status, headers, listing = self.request("GET", BASE + path, token=self.token)
            self.assertEqual(status, 200)
            self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
            text = json.dumps(listing)
            self.assertNotIn(secret, text); self.assertNotIn(enrolled["installationCredential"], text)
            self.assertNotIn("credentialDigest", text)

    def test_denial_and_expiration_through_http_are_terminal(self):
        row, secret = self.create()
        self.assertEqual(self.request("POST", BASE + f"pairings/{row['id']}/deny", token=self.token, payload={"revision": 1})[0], 200)
        self.assertEqual(self.claim(row, secret)[0], 409)
        row, secret = self.create(); self.assertEqual(self.approve(row)[0], 200)
        self.clock.now = 300
        self.assertEqual(self.claim(row, secret)[0], 410)
        self.assertFalse(self.pairings.repository.path.exists())

    def test_independent_installations_reassign_revoke_and_conflict_through_http(self):
        first, second = self.enroll(), self.enroll("candidate-two")
        path = BASE + f"installations/{first['installationId']}/binding"
        status, _, updated = self.request("PUT", path, token=self.token, payload={"candidateId": "candidate-two", "revision": 1})
        self.assertEqual((status, updated["bindingRevision"]), (200, 2))
        self.assertEqual(self.request("PUT", path, token=self.token, payload={"candidateId": "candidate-one", "revision": 1})[0], 409)
        owner = self.record["users"][0]["id"]
        with self.assertRaises(RevisionConflict) as conflict:
            self.pairings.authorize_installation(owner, first["installationId"], first["installationCredential"], 1)
        self.assertIn("changed", str(conflict.exception))
        self.assertTrue(self.pairings.authorize_installation(owner, second["installationId"], second["installationCredential"], 1)["usable"])
        self.assertEqual(self.request("POST", BASE + f"installations/{first['installationId']}/revoke", token=self.token, payload={"revision": 2})[0], 200)
        with self.assertRaises(AuthError): self.pairings.authorize_installation(owner, first["installationId"], first["installationCredential"], 3)

    def test_host_origin_csrf_and_extension_origin_cannot_bypass_web_owner_routes(self):
        for headers in ({"Host": "localhost:8765"}, {"Origin": "https://untrusted.example"},
                        {"Origin": ORIGIN}, {"X-Tracker-Token": "invalid"}, {"Sec-Fetch-Site": "cross-site"}):
            with self.subTest(headers=headers):
                status, _, _ = self.request("POST", BASE + "pairings", token=self.token, payload={}, headers=headers)
                self.assertEqual(status, 403)
        self.assertFalse(self.pairings.repository.path.exists())

    def test_strict_request_shape_methods_query_and_duplicate_headers(self):
        for raw in (b'{"label":"A","label":"B"}', b'[]', b'{"user_id":"forged"}', b'{"revision":NaN}'):
            self.assertEqual(self.enrollment("POST", "pairings", raw=raw, headers={"Content-Type": "application/json", "X-Pairing-Exchange": secrets.token_urlsafe(32)})[0], 400)
        self.assertEqual(self.enrollment("POST", "pairings", payload={}, headers={"Content-Type": "text/plain", "X-Pairing-Exchange": secrets.token_urlsafe(32)})[0], 400)
        self.assertEqual(self.enrollment("POST", "pairings", raw=b"x" * 8193, headers={"Content-Type": "application/json", "X-Pairing-Exchange": secrets.token_urlsafe(32)})[0], 400)
        self.assertEqual(self.request("GET", BASE + "pairings?exchangeSecret=synthetic", token=self.token)[0], 400)
        self.assertEqual(self.request("GET", BASE + "pairings/", token=self.token)[0], 404)
        for method in ("HEAD", "OPTIONS", "DELETE"):
            self.assertIn(self.request(method, BASE + "pairings", token=self.token)[0], (405,))
        row, secret = self.create()
        host = f"127.0.0.1:{self.server.server_port}"
        request = (f"POST /api/extension/pairings/{row['id']}/claim HTTP/1.1\r\nHost: {host}\r\nOrigin: {ORIGIN}\r\n"
                   f"X-Tracker-Token: {self.enrollment_token}\r\n"
                   "Content-Type: application/json\r\nContent-Length: 2\r\n"
                   f"X-Pairing-Exchange: {secret}\r\nX-Pairing-Exchange: {secret}\r\nConnection: close\r\n\r\n{{}}")
        self.assertEqual(self.wire(request.encode())[0], 400)

    def test_invalid_candidates_and_forged_identity_are_rejected(self):
        row, _ = self.create()
        self.assertEqual(self.approve(row, "missing")[0], 400)
        self.assertEqual(self.request("POST", BASE + f"pairings/{row['id']}/approve", token=self.token,
                                      payload={"candidateId": "candidate-one", "revision": 1, "ownerId": "f" * 32})[0], 400)
        self.assertFalse(self.pairings.repository.path.exists())

    def test_corrupted_private_storage_returns_generic_unavailable_without_repair(self):
        self.enroll()
        private_atomic_write(self.pairings.repository.path, b"{synthetic-corrupt", permissions=self.repository.permissions)
        status, _, result = self.request("GET", BASE + "pairings", token=self.token)
        self.assertEqual((status, result["code"]), (503, "pairing-unavailable"))
        self.assertEqual(self.pairings.repository.path.read_bytes(), b"{synthetic-corrupt")

    def test_missing_device_setup_does_not_write_defaults_or_private_bindings(self):
        self.repos.extension_device.path.unlink()
        before = {p: p.read_bytes() for p in self.root.rglob("*") if p.is_file()}
        status, _, body = self.request("GET", BASE + "pairings", token=self.token)
        self.assertEqual((status, body["code"]), (409, "pairing-setup-required"))
        self.assertEqual(before, {p: p.read_bytes() for p in self.root.rglob("*") if p.is_file()})

    def test_concurrent_real_http_claims_deliver_once(self):
        row, secret = self.create(); self.approve(row)
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda _: self.claim(row, secret)[0], range(4)))
        self.assertCountEqual(results, (200, 409, 409, 409))

    def test_logout_blocks_management_and_secret_urls_are_redacted(self):
        marker = secrets.token_urlsafe(32)
        logs = io.StringIO()
        with redirect_stderr(logs):
            self.request("GET", BASE + "pairings?exchangeSecret=" + marker, token=self.token)
        self.assertNotIn(marker, logs.getvalue())
        self.assertEqual(self.request("POST", "/api/auth/logout", token=self.token)[0], 200)
        self.assertEqual(self.request("GET", BASE + "pairings", token=self.token)[0], 401)
