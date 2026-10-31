"""Pre-login exceptions exercised through actual isolated loopback HTTP."""
from contextlib import redirect_stderr
import http.client
import copy
import io
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
from unittest.mock import patch

from test_pairing_http import PairingHttpFixture, BASE, ORIGIN
from manager import app, enrollment_http
from tracker_config.browser_bindings import BrowserPairingService
from tracker_config.security_files import private_atomic_write


class EnrollmentHttpTests(PairingHttpFixture):
    def test_bootstrap_has_only_public_identity_and_no_cookie_or_filesystem_writes(self):
        before = {p: p.read_bytes() for p in self.root.rglob("*") if p.is_file()}
        with patch.object(self.pairings.candidates, "read", side_effect=AssertionError("No candidate data at bootstrap")), \
             patch.object(self.pairings.candidates, "get", side_effect=AssertionError("No candidate lookup")):
            status, headers, value = self.enrollment("GET", "bootstrap")
        self.assertEqual(status, 200)
        self.assertEqual(set(value), {"protocolVersion", "state", "backendId", "workspaceId", "requestToken"})
        self.assertEqual(value["state"], "ready")
        self.assertEqual(value["backendId"], self.record["backendId"])
        self.assertNotEqual(value["requestToken"], app.SESSION_TOKEN)
        self.assertEqual(headers["Access-Control-Allow-Origin"], ORIGIN)
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertNotIn("Set-Cookie", headers)
        self.assertNotIn("Access-Control-Allow-Credentials", headers)
        self.assertEqual(before, {p: p.read_bytes() for p in self.root.rglob("*") if p.is_file()})

    def test_exact_origin_and_host_required_for_bootstrap(self):
        for changes in ({"Origin": None}, {"Origin": "null"}, {"Origin": "chrome-extension://" + "b" * 32},
                        {"Origin": ORIGIN + "/"}, {"Origin": "https://example.test"}, {"Host": "localhost:8765"},
                        {"Host": "127.0.0.1:8765"}, {"Host": "192.0.2.1:8765"}):
            with self.subTest(changes=changes):
                status, headers, body = self.enrollment("GET", "bootstrap", headers=changes)
                self.assertEqual(status, 403)
                self.assertNotIn("requestToken", body)
                self.assertNotIn("Access-Control-Allow-Origin", headers)

    def test_missing_workspace_and_missing_owner_are_setup_required_without_provisioning(self):
        path = self.repos.extension_device.path
        original = path.read_bytes(); value = json.loads(original); value.pop("id")
        path.write_text(json.dumps(value), encoding="utf-8")
        before = {p: p.read_bytes() for p in self.root.rglob("*") if p.is_file()}
        self.assertEqual(self.enrollment("GET", "bootstrap")[2]["state"], "setup-required")
        self.assertEqual(before, {p: p.read_bytes() for p in self.root.rglob("*") if p.is_file()})
        path.write_bytes(original)
        self.repository.path.unlink()
        self.assertEqual(self.enrollment("GET", "bootstrap")[2]["state"], "setup-required")
        self.assertFalse(self.repository.path.exists())

    def test_corrupt_owner_or_binding_store_is_unavailable_not_setup(self):
        original = self.repository.path.read_bytes()
        self.write(self.repository.path, b"{synthetic-corrupt")
        self.assertEqual(self.enrollment("GET", "bootstrap")[0:1], (503,))
        self.assertEqual(self.enrollment("GET", "bootstrap")[2]["state"], "unavailable")
        self.write(self.repository.path, original)
        private_atomic_write(self.pairings.repository.path, b"{corrupt", permissions=self.repository.permissions)
        status, _, body = self.enrollment("GET", "bootstrap")
        self.assertEqual((status, body["state"]), (503, "unavailable"))

    def test_unconfigured_extension_id_never_allows_an_arbitrary_origin(self):
        value = self.repos.extension_device.read().data; value["extensionId"] = ""
        self.repos.extension_device.path.write_text(json.dumps(value), encoding="utf-8")
        status, headers, _ = self.enrollment("GET", "bootstrap")
        self.assertEqual(status, 503); self.assertNotIn("Access-Control-Allow-Origin", headers)

    def test_enrollment_never_accepts_owner_cookies_or_authorization(self):
        for changes in ({"Cookie": f"tracker_owner_session={self.token}"}, {"Authorization": "Bearer synthetic"}):
            status, headers, _ = self.enrollment("GET", "bootstrap", headers=changes)
            self.assertEqual(status, 400); self.assertNotIn("Set-Cookie", headers)

    def test_creation_secret_token_and_strict_protocol_contract(self):
        valid = {"protocolVersion": 1, "label": "Synthetic profile"}
        for changes in ({"X-Pairing-Exchange": None}, {"X-Pairing-Exchange": "A" * 42},
                        {"X-Pairing-Exchange": "A" * 42 + "B"}):
            self.assertEqual(self.enrollment("POST", "pairings", payload=valid, headers=changes)[0], 400)
        for token in (None, "invalid", app.SESSION_TOKEN):
            self.assertEqual(self.enrollment("POST", "pairings", payload=valid, headers={"X-Pairing-Exchange": secrets.token_urlsafe(32), "X-Tracker-Token": token})[0], 403)
        for value in ({**valid, "extensionOrigin": ORIGIN}, {**valid, "user_id": "forged"},
                      {**valid, "protocolVersion": True}, {"label": "Missing protocol"}):
            self.assertEqual(self.enrollment("POST", "pairings", payload=value, headers={"X-Pairing-Exchange": secrets.token_urlsafe(32)})[0], 400)
        self.assertEqual(self.enrollment("POST", "pairings", payload=valid, headers={"X-Pairing-Exchange": secrets.token_urlsafe(32), "Origin": "null"})[0], 403)
        self.assertFalse(self.pairings.repository.path.exists())

    def test_creation_rate_and_pending_capacity_are_bounded(self):
        with patch("tracker_config.browser_bindings.MAX_PENDING", 2):
            self.create(); self.create()
            status, _, _ = self.enrollment("POST", "pairings", payload={"protocolVersion": 1, "label": "Third"}, headers={"X-Pairing-Exchange": secrets.token_urlsafe(32)})
            self.assertEqual(status, 429)
        self.pairings._requests.clear(); self.pairings._attempts.clear()
        for _ in range(10): self.create()
        status, headers, _ = self.enrollment("POST", "pairings", payload={"protocolVersion": 1, "label": "Eleventh"}, headers={"X-Pairing-Exchange": secrets.token_urlsafe(32)})
        self.assertEqual(status, 429); self.assertIn("Retry-After", headers)
        self.clock.now += 300
        self.create(); self.assertFalse(self.pairings.repository.path.exists())

    def test_claim_pending_wrong_secret_denial_expiration_and_one_time_delivery(self):
        row, secret = self.create(); self.assertEqual(self.claim(row, secret)[0], 202)
        self.assertEqual(self.approve(row)[0], 200)
        self.assertEqual(self.claim(row, secrets.token_urlsafe(32))[0], 403)
        status, _, result = self.claim(row, secret)
        self.assertEqual(status, 200)
        self.assertEqual(set(result), {"installationCredential", "installationId", "bindingId", "bindingRevision", "backendId", "workspaceId"})
        self.assertEqual(result["bindingId"], result["installationId"])
        self.assertEqual(self.claim(row, secret)[0], 409)
        denied, denied_secret = self.create()
        self.request("POST", BASE + f"pairings/{denied['id']}/deny", token=self.token, payload={"revision": 1})
        self.assertEqual(self.claim(denied, denied_secret)[0], 409)
        expired, expired_secret = self.create(); self.approve(expired); self.clock.now = 300
        self.assertEqual(self.claim(expired, expired_secret)[0], 410)

    def test_claim_wrong_origin_unknown_id_and_approval_code_are_rejected(self):
        row, secret = self.create(); self.approve(row)
        path = f"pairings/{row['id']}/claim"
        self.assertEqual(self.enrollment("POST", path, payload={}, headers={"Origin": "chrome-extension://" + "b" * 32, "X-Pairing-Exchange": secret})[0], 403)
        self.assertEqual(self.claim({"id": "f" * 32}, secret)[0], 404)
        code = self.pairings.listing(self.record["users"][0]["id"])["requests"][0]["approvalCode"]
        self.assertEqual(self.claim(row, code)[0], 400)
        self.assertFalse(self.pairings.repository.path.exists())

    def test_durable_post_commit_marker_blocks_replay_after_failure(self):
        row, secret = self.create(); self.approve(row)
        replace = os.replace
        def lose_result(source, destination):
            replace(source, destination)
            if Path(destination) == self.pairings.repository.path:
                raise OSError("Synthetic committed-write response failure")
        with patch("tracker_config.security_files.os.replace", side_effect=lose_result):
            self.assertEqual(self.claim(row, secret)[0], 503)
        self.assertEqual(self.claim(row, secret)[0], 409)
        installed = self.pairings.listing(self.record["users"][0]["id"])["installations"]
        self.assertEqual(len(installed), 1)
        self.assertEqual(installed[0]["pairingId"], row["id"])

    def test_lost_http_response_after_commit_closes_without_reissuing(self):
        row, secret = self.create(); self.approve(row)
        with patch.object(enrollment_http, "_send", side_effect=BrokenPipeError("Synthetic response lost")):
            with self.assertRaises(http.client.RemoteDisconnected):
                self.claim(row, secret)
        self.assertEqual(self.claim(row, secret)[0], 409)
        self.assertEqual(len(self.pairings.listing(self.record["users"][0]["id"])["installations"]), 1)

    def test_exact_scoped_preflight_has_no_wildcards_or_credentials(self):
        status, headers, body = self.enrollment("OPTIONS", "pairings", headers={"X-Tracker-Token": None,
            "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type,x-tracker-token,x-pairing-exchange"})
        self.assertEqual(status, 204); self.assertIsNone(body)
        self.assertEqual(headers["Access-Control-Allow-Origin"], ORIGIN)
        self.assertEqual(headers["Access-Control-Allow-Methods"], "POST")
        self.assertEqual({name.strip().lower() for name in headers["Access-Control-Allow-Headers"].split(",")}, {"content-type", "x-tracker-token", "x-pairing-exchange"})
        self.assertNotIn("Access-Control-Allow-Credentials", headers)
        self.assertNotIn("Access-Control-Allow-Private-Network", headers)

    def test_preflight_wrong_origin_method_headers_and_unrelated_paths_fail_closed(self):
        valid = {"Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type,x-pairing-exchange,x-tracker-token"}
        for changes in ({"Origin": "null"}, {"Access-Control-Request-Method": "GET"}, {"Access-Control-Request-Method": "PUT"},
                        {"Access-Control-Request-Headers": "authorization"}, {"Access-Control-Request-Headers": "*"},
                        {"Access-Control-Request-Private-Network": "true"}):
            self.assertEqual(self.enrollment("OPTIONS", "pairings", headers={**valid, **changes})[0], 403)
        self.assertEqual(self.enrollment("OPTIONS", "bootstrap", headers=valid)[0], 405)
        status, headers, _ = self.request("OPTIONS", "/api/state")
        self.assertEqual(status, 401); self.assertNotIn("Access-Control-Allow-Origin", headers)

    def test_unknown_routes_aliases_and_business_data_do_not_gain_anonymous_access(self):
        for path in ("/api/extension/unknown", "/api/extension/bootstrap/", "/api/extension/pairings/bad/claim",
                     "/api/extension/../state", "/api/state", "/api/studio/state"):
            status, headers, _ = self.request("GET", path)
            self.assertEqual(status, 401, path); self.assertNotIn("Access-Control-Allow-Origin", headers)
        self.assertEqual(self.enrollment("GET", "bootstrap?secret=synthetic")[0], 400)
        self.assertEqual(self.enrollment("GET", "pairings")[0], 405)

    def test_old_web_creation_and_claim_are_retired_and_cannot_issue_credentials(self):
        row, secret = self.create(); self.approve(row)
        for path in ("pairings", f"pairings/{row['id']}/claim"):
            status, _, result = self.request("POST", BASE + path, token=self.token, payload={})
            self.assertEqual((status, result["code"]), (410, "enrollment-route-retired"))
            self.assertNotIn("installationCredential", result)
        self.assertEqual(self.claim(row, secret)[0], 200)

    def test_restart_invalidates_enrollment_request_token_and_pending_exchanges(self):
        row, secret = self.create()
        old = self.enrollment_token
        replacement = BrowserPairingService(self.pairings.repository, self.repos.candidates, self.pairings.workspace_id, ORIGIN, clock=self.clock)
        self.server.pairing_service = replacement
        status, _, context = self.enrollment("GET", "bootstrap")
        self.assertEqual(status, 200); self.assertNotEqual(context["requestToken"], old)
        self.assertEqual(self.claim(row, secret)[0], 403)
        self.enrollment_token = context["requestToken"]
        self.assertEqual(self.claim(row, secret)[0], 404)

    def test_enrollment_logs_never_contain_exchange_or_installation_credentials(self):
        logs = io.StringIO()
        with redirect_stderr(logs):
            row, secret = self.create(); self.approve(row)
            status, _, result = self.claim(row, secret); self.assertEqual(status, 200)
            self.enrollment("GET", "bootstrap?secret=" + secret)
        self.assertNotIn(secret, logs.getvalue()); self.assertNotIn(result["installationCredential"], logs.getvalue())

    def test_packaged_enrollment_client_uses_actual_isolated_http_and_owner_approval(self):
        node = shutil.which("node") or r"C:\Program Files\nodejs\node.exe"
        if not Path(node).is_file():
            self.skipTest("Existing Node.js executable unavailable")
        # The test-only fetch adapter asserts the production URL and redirects
        # traffic to this fixture's ephemeral port. The packaged client itself
        # has no host/port override. Node supplies the synthetic Origin header;
        # this proves real HTTP integration, not Chrome Origin/CORS behavior.
        script = r'''
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
const { EnrollmentClient, BACKEND } = await import(process.argv[1]);
const origin = 'chrome-extension://' + 'a'.repeat(32), base = process.argv[2];
const ownerCookie = process.argv[3], webToken = process.argv[4];
const area = () => ({ data: {}, async setAccessLevel(value) { assert.equal(value.accessLevel, 'TRUSTED_CONTEXTS'); },
  async get(key) { return Object.hasOwn(this.data, key) ? { [key]: this.data[key] } : {}; },
  async set(value) { Object.assign(this.data, structuredClone(value)); }, async remove(key) { delete this.data[key]; } });
const client = new EnrollmentClient({ runtime: { id: 'a'.repeat(32) }, location: { protocol: 'chrome-extension:', hostname: 'a'.repeat(32) },
  storage: { local: area(), session: area() }, crypto: webcrypto,
  locks: { async request(name, options, action) { return action(); } },
  fetcher(url, options) { assert.equal(this, globalThis); assert.equal(options.credentials, 'omit'); assert.ok(url.startsWith(BACKEND));
    return fetch(base + url.slice(BACKEND.length), { ...options, headers: { ...options.headers, Origin: origin } }); } });
const bootstrap = await client.getBootstrap(); assert.equal(bootstrap.state, 'ready');
await client.confirmBackendIdentity(bootstrap);
const pending = await client.requestPairing('Synthetic Node browser');
assert.deepEqual(await client.claimPairing(), { status: 'pending' });
const approved = await fetch(base + '/api/studio/extension/pairings/' + pending.pairingId + '/approve', {
  method: 'POST', headers: { Origin: base, Cookie: ownerCookie, 'X-Tracker-Token': webToken, 'Content-Type': 'application/json' },
  body: JSON.stringify({ candidateId: 'candidate-two', revision: 1 }) });
assert.equal(approved.status, 200);
const claimed = await client.claimPairing(); assert.equal(claimed.status, 'claimed');
const installed = await client.getInstallationCredential(); assert.equal(installed.installationCredential.length, 43);
assert.equal(await client.getPendingPairing(), null);
await assert.rejects(client.claimPairing(), error => error.code === 'already-paired');
console.log(JSON.stringify({ installed: true, bindingRevision: installed.bindingRevision }));
'''
        result = subprocess.run([node, "--input-type=module", "-e", script,
                                 (Path(app.ROOT) / "extension/studio/enrollment.mjs").as_uri(),
                                 f"http://127.0.0.1:{self.server.server_port}",
                                 "tracker_owner_session=" + self.token, app.SESSION_TOKEN],
                                text=True, capture_output=True, timeout=30)
        # Never include subprocess output in assertion failures: even a runtime
        # diagnostic must not accidentally disclose synthetic credentials.
        self.assertEqual(result.returncode, 0, "Isolated client/HTTP integration failed; output withheld.")
        self.assertEqual(json.loads(result.stdout), {"installed": True, "bindingRevision": 1})
        rows = self.pairings.listing(self.record["users"][0]["id"])["installations"]
        self.assertEqual([row["candidateId"] for row in rows], ["candidate-two"])
