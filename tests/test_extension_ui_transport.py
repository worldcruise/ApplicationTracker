"""Packaged JS auth client against actual synthetic loopback HTTP, not Chrome."""
import json
import importlib.util
from pathlib import Path
import shutil
import subprocess
from unittest.mock import patch

from auth_fixtures import USERNAME, PASSWORD
from test_pairing_http import PairingHttpFixture
from manager import app


class ExtensionUiTransportTests(PairingHttpFixture):
    def test_manual_visual_fixture_import_never_starts_or_initializes_anything(self):
        path = Path(app.ROOT) / "tests/serve_extension_workspace_fixture.py"
        spec = importlib.util.spec_from_file_location("extension_visual_import_test", path)
        module = importlib.util.module_from_spec(spec)
        with patch("http.server.ThreadingHTTPServer", side_effect=AssertionError("No listener on import")), \
             patch("tracker_config.security.SecurityRepository.initialize", side_effect=AssertionError("No owner on import")):
            spec.loader.exec_module(module)
        self.assertTrue(callable(module.main))

    def test_packaged_auth_client_login_restore_binding_review_and_logout_over_http(self):
        node = shutil.which("node") or r"C:\Program Files\nodejs\node.exe"
        if not Path(node).is_file():
            self.skipTest("Existing Node.js executable unavailable")
        first, second = self.enroll(), self.enroll("candidate-two")
        script = r'''
import assert from 'node:assert/strict';
const { EnrollmentClient, BACKEND, ENROLLMENT_KEYS: K } = await import(process.argv[1]);
const { ExtensionAuthClient, AUTH_KEYS } = await import(process.argv[2]);
let input = ''; for await (const chunk of process.stdin) input += chunk;
const fixture = JSON.parse(input), base = process.argv[3];
const origin = 'chrome-extension://' + 'a'.repeat(32);
function client(installation) {
  const area = () => ({ data: {}, restricted: false,
    async setAccessLevel(value) { assert.equal(this.restricted === undefined, false); assert.equal(value.accessLevel, 'TRUSTED_CONTEXTS'); this.restricted = true; },
    async get(key) { assert.ok(this.restricted); return Object.hasOwn(this.data, key) ? { [key]: structuredClone(this.data[key]) } : {}; },
    async set(items) { assert.ok(this.restricted); Object.assign(this.data, structuredClone(items)); },
    async remove(key) { assert.ok(this.restricted); delete this.data[key]; } });
  const storage = { local: area(), session: area() };
  storage.local.data[K.identity] = { schemaVersion: 1, backendId: installation.backendId, workspaceId: installation.workspaceId };
  storage.local.data[K.installation] = { schemaVersion: 1, ...installation };
  const fetcher = function (url, options) {
    assert.equal(this, globalThis); assert.ok(url.startsWith(BACKEND + '/api/extension/'));
    assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
    assert.equal('Cookie' in options.headers, false);
    // Test-only URL and Origin adapter. This is not installed Chrome evidence.
    return fetch(base + url.slice(BACKEND.length), { ...options, headers: { ...options.headers, Origin: origin } });
  };
  const enrollment = new EnrollmentClient({ storage, fetcher, runtime: { id: 'a'.repeat(32) },
    location: { protocol: 'chrome-extension:', hostname: 'a'.repeat(32) },
    locks: { async request(name, options, action) { return action(); } } });
  return { auth: new ExtensionAuthClient({ enrollment, fetcher }), storage };
}
const a = client(fixture.first), b = client(fixture.second);
assert.equal((await a.auth.restore()).state, 'signed-out');
const signedA = await a.auth.login(fixture.username, fixture.password);
const signedB = await b.auth.login(fixture.username, fixture.password);
assert.equal(signedA.metadata.context.candidate.id, 'candidate-one');
assert.equal(signedB.metadata.context.candidate.id, 'candidate-two');
assert.equal((await a.auth.restore()).state, 'authenticated');
assert.equal((await a.auth.restore({ activity: true })).state, 'authenticated');
assert.equal((await a.auth.logout()).serverConfirmed, true);
assert.equal(a.storage.session.data[AUTH_KEYS.session], undefined);
assert.equal((await b.auth.restore()).state, 'authenticated');
async function manage(id, action, method, body) {
  const response = await fetch(base + '/api/studio/extension/installations/' + id + '/' + action, {
    method, headers: { Origin: base, Cookie: fixture.ownerCookie, 'X-Tracker-Token': fixture.webToken, 'Content-Type': 'application/json' },
    body: JSON.stringify(body) });
  assert.equal(response.status, 200);
}
await manage(fixture.second.installationId, 'binding', 'PUT', { candidateId: 'candidate-one', revision: 1 });
await assert.rejects(b.auth.restore(), error => error.status === 401 || error.status === 409);
const changed = await b.auth.login(fixture.username, fixture.password);
assert.equal(changed.state, 'binding-reassigned');
assert.equal(b.storage.local.data[K.installation].bindingRevision, 1);
const accepted = await b.auth.acknowledgeBinding(changed.metadata.context);
assert.equal(accepted.state, 'authenticated');
assert.equal(accepted.metadata.context.candidate.id, 'candidate-one');
assert.equal(b.storage.local.data[K.installation].bindingRevision, 2);
await manage(fixture.first.installationId, 'revoke', 'POST', { revision: 1 });
await assert.rejects(a.auth.login(fixture.username, fixture.password), error => error.status === 403);
assert.equal((await b.auth.restore()).state, 'authenticated');
assert.equal((await b.auth.logout()).serverConfirmed, true);
console.log(JSON.stringify({ authenticated: true, isolated: true, bindingRevision: 2, logoutConfirmed: true }));
'''
        root = Path(app.ROOT)
        values = {"first": first, "second": second, "username": USERNAME, "password": PASSWORD,
                  "ownerCookie": "tracker_owner_session=" + self.token, "webToken": app.SESSION_TOKEN}
        result = subprocess.run([node, "--input-type=module", "-e", script,
            (root / "extension/studio/enrollment.mjs").as_uri(), (root / "extension/studio/auth.mjs").as_uri(),
            f"http://127.0.0.1:{self.server.server_port}"], input=json.dumps(values), text=True,
            capture_output=True, timeout=30)
        self.assertEqual(result.returncode, 0, "Synthetic packaged-client HTTP integration failed; output withheld.")
        self.assertEqual(json.loads(result.stdout), {"authenticated": True, "isolated": True, "bindingRevision": 2, "logoutConfirmed": True})
        for value in (PASSWORD, first["installationCredential"], second["installationCredential"]):
            self.assertNotIn(value, self.logs.getvalue())
