import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, webcrypto } from "node:crypto";
import { BACKEND, ENROLLMENT_KEYS as K, EnrollmentClient } from "../extension/studio/enrollment.mjs";

const token = () => randomBytes(32).toString("base64url");
function fixture() {
  const calls = [], storageCalls = [];
  function area(name) {
    const value = { data: {}, level: null, failRead: false, failSet: null, failRemove: null, failAccess: false, rejectAfterSet: null,
      async setAccessLevel(options) { assert.equal(this, value); if (this.failAccess) throw Error("Synthetic permission failure"); this.level = options.accessLevel; storageCalls.push([name, "restrict"]); },
      async get(key) { assert.equal(this, value); assert.equal(this.level, "TRUSTED_CONTEXTS"); if (this.failRead) throw Error("Synthetic read failure"); return Object.hasOwn(this.data, key) ? { [key]: structuredClone(this.data[key]) } : {}; },
      async set(items) { assert.equal(this, value); assert.equal(this.level, "TRUSTED_CONTEXTS"); const key = Object.keys(items)[0]; if (this.failSet === key) throw Error("Synthetic write failure"); Object.assign(this.data, structuredClone(items)); if (this.rejectAfterSet === key) throw Error("Synthetic ambiguous write"); },
      async remove(key) { assert.equal(this, value); assert.equal(this.level, "TRUSTED_CONTEXTS"); if (this.failRemove === key) throw Error("Synthetic cleanup failure"); delete this.data[key]; } };
    return value;
  }
  const storage = { local: area("local"), session: area("session") };
  let tail = Promise.resolve();
  const locks = { request(name, options, action) { assert.equal(this, locks); assert.equal(name, "application-tracker-enrollment-v1"); assert.equal(options.mode, "exclusive"); const result = tail.then(action); tail = result.catch(() => {}); return result; } };
  const crypto = { getRandomValues(bytes) { assert.equal(this, crypto); assert.equal(bytes.length, 32); return webcrypto.getRandomValues(bytes); } };
  const context = { protocolVersion: 1, state: "ready", backendId: "b".repeat(32), workspaceId: "workspace-one", requestToken: token() };
  const f = { calls, storageCalls, storage, context, approved: false, dropClaim: false, badClaim: false, denied: false, now: Date.now(), created: 0, claimCalls: 0, throwSync: false, failBootstrap: false, unavailable: false };
  const reply = (status, data) => ({ ok: status >= 200 && status < 300, status, async json() { return structuredClone(data); } });
  function fetcher(url, options) {
    assert.equal(this, globalThis, "Native fetch receiver");
    assert.equal(options.credentials, "omit"); assert.equal(options.mode, "cors"); assert.equal(options.redirect, "error"); assert.equal(options.cache, "no-store");
    assert.equal(url.startsWith(BACKEND + "/api/extension/"), true);
    assert.equal("Origin" in options.headers, false, "The browser supplies actual Origin");
    calls.push({ url, options: structuredClone(options) });
    if (f.throwSync) throw TypeError("Illegal invocation");
    if (url.endsWith("/bootstrap")) {
      if (f.failBootstrap) return Promise.reject(Error("Synthetic network failure"));
      return Promise.resolve(reply(f.unavailable ? 503 : 200, context));
    }
    assert.equal(options.method, "POST"); assert.equal(options.headers["X-Tracker-Token"], context.requestToken);
    assert.equal(Buffer.from(options.headers["X-Pairing-Exchange"], "base64url").length, 32);
    if (url.endsWith("/pairings")) {
      const body = JSON.parse(options.body); assert.deepEqual(Object.keys(body).sort(), ["label", "protocolVersion"]);
      f.created++;
      return Promise.resolve(reply(201, { pairingId: String(f.created).padStart(32, "0"), approvalCode: "ABCD-2345", status: "pending", expiresAt: new Date(f.now + 300000).toISOString() }));
    }
    f.claimCalls++;
    if (f.dropClaim) return Promise.reject(Error("Synthetic lost response"));
    if (f.denied) return Promise.resolve(reply(409, { code: "pairing-consumed", error: "Synthetic denial" }));
    if (!f.approved) return Promise.resolve(reply(202, { status: "pending" }));
    return Promise.resolve(reply(200, { installationCredential: f.badClaim ? "invalid" : token(), installationId: "c".repeat(32), bindingId: "c".repeat(32), bindingRevision: 1, backendId: context.backendId, workspaceId: context.workspaceId }));
  }
  f.dependencies = { fetcher, storage, runtime: { id: "a".repeat(32) }, location: { protocol: "chrome-extension:", hostname: "a".repeat(32) },
    crypto, locks, now: () => f.now, encode(value) { assert.equal(this, globalThis); return btoa(value); } };
  f.client = new EnrollmentClient(f.dependencies);
  f.confirm = () => f.client.confirmBackendIdentity({ backendId: context.backendId, workspaceId: context.workspaceId });
  f.request = async () => { await f.confirm(); return f.client.requestPairing("Synthetic Chrome profile"); };
  return f;
}

test("bootstrap is explicit, fixed-address, credential-free and never pins identity automatically", async () => {
  const f = fixture(); assert.equal(f.calls.length, 0); const context = await f.client.getBootstrap();
  assert.equal(context.state, "ready"); assert.equal(f.storage.local.data[K.identity], undefined);
  assert.equal(f.storage.local.level, "TRUSTED_CONTEXTS"); assert.equal(f.storage.session.level, "TRUSTED_CONTEXTS");
  assert.equal(f.calls[0].url, "http://127.0.0.1:8765/api/extension/bootstrap");
});

test("pairing requires explicit first-time identity confirmation", async () => {
  const f = fixture(); await assert.rejects(f.client.requestPairing("Browser"), error => error.code === "identity-confirmation-required");
  assert.equal(f.created, 0); await f.confirm(); await f.client.requestPairing("Browser"); assert.equal(f.created, 1);
});

test("identity mismatches reject bootstrap/create without replacing pins or sending secrets", async () => {
  const f = fixture(); await f.confirm(); const pinned = structuredClone(f.storage.local.data[K.identity]); f.context.backendId = "d".repeat(32);
  await assert.rejects(f.client.getBootstrap(), error => error.code === "identity-mismatch");
  await assert.rejects(f.client.requestPairing("Browser"), error => error.code === "identity-mismatch");
  assert.deepEqual(f.storage.local.data[K.identity], pinned); assert.equal(f.created, 0);
});

test("unavailable/setup bootstrap states never create identities or pending records", async () => {
  const f = fixture(); Object.assign(f.context, { state: "setup-required", backendId: null, workspaceId: null, requestToken: null });
  assert.equal((await f.client.getBootstrap()).state, "setup-required");
  f.context.state = "unavailable"; f.unavailable = true;
  assert.equal((await f.client.getBootstrap()).state, "unavailable");
  assert.deepEqual(f.storage.local.data, {}); assert.deepEqual(f.storage.session.data, {});
});

test("exchange uses 32 Web Crypto bytes with correct receivers and lives only in trusted session storage", async () => {
  const f = fixture(); const original = Math.random; Math.random = () => { throw Error("Math.random is prohibited"); };
  try { await f.request(); } finally { Math.random = original; }
  const pending = f.storage.session.data[K.pending], safe = await f.client.getPendingPairing();
  assert.equal(Buffer.from(pending.exchangeSecret, "base64url").length, 32);
  assert.equal(JSON.stringify(f.storage.local.data).includes(pending.exchangeSecret), false);
  assert.equal(JSON.stringify(safe).includes(pending.exchangeSecret), false);
  const sent = f.calls.find(call => call.url.endsWith("/pairings"));
  assert.equal(sent.options.headers["X-Pairing-Exchange"], pending.exchangeSecret);
  assert.equal(sent.options.body.includes(pending.exchangeSecret), false); assert.equal(sent.url.includes(pending.exchangeSecret), false);
});

test("content-script contexts and failed storage restrictions cannot read secrets or send requests", async () => {
  const f = fixture(); const client = new EnrollmentClient({ ...f.dependencies, location: { protocol: "https:", hostname: "example.test" } });
  await assert.rejects(client.getInstallationCredential(), error => error.code === "untrusted-context");
  f.storage.local.failAccess = true; await assert.rejects(f.client.getBootstrap(), error => error.code === "storage-unavailable");
  assert.equal(f.calls.length, 0);
});

test("failed pending-secret persistence prevents creation", async () => {
  const f = fixture(); await f.confirm(); f.storage.session.failSet = K.pending;
  await assert.rejects(f.client.requestPairing("Browser"), error => error.code === "storage-unavailable");
  assert.equal(f.created, 0);
});

test("native execution errors remain distinct from genuine network failures", async () => {
  const f = fixture(); f.throwSync = true;
  await assert.rejects(f.client.getBootstrap(), error => error.code === "client-execution-error");
  f.throwSync = false; f.failBootstrap = true;
  await assert.rejects(f.client.getBootstrap(), error => error.code === "connection-unavailable");
});

test("pending claims are explicit and produce no polling or retries", async () => {
  const f = fixture(); await f.request(); assert.equal(f.claimCalls, 0);
  assert.deepEqual(await f.client.claimPairing(), { status: "pending" });
  assert.equal(f.claimCalls, 1); assert.equal(f.storage.local.data[K.recovery], undefined);
  await Promise.resolve(); assert.equal(f.claimCalls, 1);
  assert.equal((await f.client.getPendingPairing()).status, "pending");
});

test("successful claim persists credential, clears the pending secret and returns only safe metadata", async () => {
  const f = fixture(); await f.request(); f.approved = true;
  const result = await f.client.claimPairing(), saved = await f.client.getInstallationCredential();
  assert.equal(result.status, "claimed"); assert.equal(result.installationCredential, undefined);
  assert.equal(saved.installationCredential.length, 43); assert.equal(saved.bindingRevision, 1);
  assert.equal(f.storage.session.data[K.pending], undefined); assert.equal(f.storage.local.data[K.recovery], undefined);
  await assert.rejects(f.client.claimPairing(), error => error.code === "already-paired"); assert.equal(f.claimCalls, 1);
});

test("an existing installation is never overwritten or silently replaced", async () => {
  const f = fixture(); await f.request(); f.approved = true; await f.client.claimPairing();
  const before = structuredClone(f.storage.local.data[K.installation]);
  await assert.rejects(f.client.requestPairing("Replacement"), error => error.code === "already-paired");
  await f.client.clearPendingEnrollment(); assert.deepEqual(f.storage.local.data[K.installation], before);
});

test("lost claim response blocks replay and keeps a nonsecret recovery marker across session loss", async () => {
  const f = fixture(); await f.request(); const secret = f.storage.session.data[K.pending].exchangeSecret; f.dropClaim = true;
  await assert.rejects(f.client.claimPairing(), error => error.code === "claim-uncertain");
  assert.equal(f.storage.session.data[K.pending].exchangeSecret, null);
  assert.equal(JSON.stringify(f.storage.local.data).includes(secret), false);
  await assert.rejects(f.client.claimPairing(), error => error.code === "recovery-required");
  f.storage.session.data = {};
  const restarted = new EnrollmentClient(f.dependencies);
  assert.equal((await restarted.getPendingPairing()).status, "claim-uncertain");
  await assert.rejects(restarted.requestPairing("Browser"), error => error.code === "recovery-required");
  await assert.rejects(restarted.clearPendingEnrollment(), error => error.code === "recovery-required");
  assert.equal(f.claimCalls, 1);
  await restarted.clearPendingEnrollment({ acknowledgeRevocation: true }); assert.equal(await restarted.getPendingPairing(), null);
});

test("installation persistence failure after claim never retries issuance", async () => {
  const f = fixture(); await f.request(); f.approved = true; f.storage.local.failSet = K.installation;
  await assert.rejects(f.client.claimPairing(), error => error.code === "claim-uncertain");
  assert.equal(f.storage.local.data[K.installation], undefined);
  await assert.rejects(f.client.claimPairing(), error => error.code === "recovery-required"); assert.equal(f.claimCalls, 1);
});

test("ambiguous local write does not erase a credential that actually persisted", async () => {
  const f = fixture(); await f.request(); f.approved = true; f.storage.local.rejectAfterSet = K.installation;
  await assert.rejects(f.client.claimPairing(), error => error.code === "claim-uncertain");
  const saved = await f.client.getInstallationCredential(); assert.equal(saved.installationId, "c".repeat(32));
  await assert.rejects(f.client.claimPairing(), error => error.code === "already-paired"); assert.equal(f.claimCalls, 1);
});

test("failed cleanup reports a stored credential without replaying claim", async () => {
  const f = fixture(); await f.request(); f.approved = true; f.storage.session.failRemove = K.pending;
  await assert.rejects(f.client.claimPairing(), error => error.code === "credential-stored-cleanup-required");
  assert.ok(await f.client.getInstallationCredential()); assert.equal(f.claimCalls, 1);
});

test("recovery marker is stored before sending a claim and storage failure prevents transmission", async () => {
  const f = fixture(); await f.request(); f.storage.local.failSet = K.recovery;
  await assert.rejects(f.client.claimPairing(), error => error.code === "storage-unavailable"); assert.equal(f.claimCalls, 0);
});

test("denied and malformed claim responses are not retried", async () => {
  for (const option of ["denied", "badClaim"]) {
    const f = fixture(); await f.request(); f.approved = true; f[option] = true;
    await assert.rejects(f.client.claimPairing(), error => error.code === "claim-uncertain");
    await assert.rejects(f.client.claimPairing(), error => error.code === "recovery-required");
    assert.equal(f.claimCalls, 1);
  }
});

test("expired pending exchange is reported and is not claimed or replaced automatically", async () => {
  const f = fixture(); await f.request(); f.now += 300000;
  assert.equal((await f.client.getPendingPairing()).status, "expired");
  await assert.rejects(f.client.claimPairing(), error => error.code === "pending-unavailable"); assert.equal(f.claimCalls, 0);
  await assert.rejects(f.client.requestPairing("New"), error => error.code === "pending-exists");
  await f.client.clearPendingEnrollment(); assert.equal(await f.client.getPendingPairing(), null);
});

test("corrupted/unreadable storage fails closed instead of substituting empty values", async () => {
  const f = fixture(); f.storage.local.data[K.installation] = null;
  await assert.rejects(f.client.requestPairing("Browser"), error => error.code === "storage-corrupt");
  assert.equal(f.created, 0); f.storage.local.failRead = true;
  await assert.rejects(f.client.getInstallationCredential(), error => error.code === "storage-unavailable");
});

test("Web Locks serialize concurrent pages so they cannot replace pending secrets or issue twice", async () => {
  const f = fixture(); await f.confirm(); const other = new EnrollmentClient(f.dependencies);
  const results = await Promise.allSettled([f.client.requestPairing("First"), other.requestPairing("Second")]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1); assert.equal(f.created, 1);
  f.approved = true;
  const claims = await Promise.allSettled([f.client.claimPairing(), other.claimPairing()]);
  assert.equal(claims.filter(result => result.status === "fulfilled").length, 1); assert.equal(f.claimCalls, 1);
});

test("missing locks disable mutations instead of using a racy storage fallback", async () => {
  const f = fixture(); const client = new EnrollmentClient({ ...f.dependencies, locks: null });
  await assert.rejects(client.requestPairing("Browser"), error => error.code === "locks-unavailable"); assert.equal(f.created, 0);
});

test("pending claim uncertainty cannot be cleared without acknowledgment even if its recovery marker is lost", async () => {
  const f = fixture(); await f.request(); f.dropClaim = true;
  await assert.rejects(f.client.claimPairing()); delete f.storage.local.data[K.recovery];
  await assert.rejects(f.client.clearPendingEnrollment(), error => error.code === "recovery-required");
  assert.equal(f.claimCalls, 1);
});
