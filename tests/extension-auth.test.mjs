import test from "node:test";
import assert from "node:assert/strict";
import { fixture, secret } from "./extension-ui-fakes.mjs";
import { AUTH_KEYS } from "../extension/studio/auth.mjs";
import { ENROLLMENT_KEYS } from "../extension/studio/enrollment.mjs";

test("paired browser still needs owner login and returns no token to the UI", async () => {
  const f = fixture({ paired: true }); assert.equal((await f.auth.restore()).state, "signed-out");
  const result = await f.auth.login(f.username, f.password);
  assert.equal(result.state, "authenticated"); assert.equal(result.metadata.context.candidate.name, "Alex Synthetic");
  assert.equal(JSON.stringify(result).includes(f.token), false);
  const saved = f.storage.session.data[AUTH_KEYS.session];
  assert.equal(saved.token, f.token); assert.equal(JSON.stringify(f.storage).includes(f.password), false);
  assert.equal(f.storage.local.data[AUTH_KEYS.session], undefined);
  assert.ok(f.storage.local.restricted && f.storage.session.restricted);
});

test("login uses exact D5C-B headers with omitted cookies and the native fetch receiver", async () => {
  const f = fixture({ paired: true }); await f.auth.login(f.username, f.password);
  const call = f.calls.find(call => call.url.endsWith("/login"));
  assert.deepEqual(JSON.parse(call.options.body), { username: f.username, password: f.password });
  assert.deepEqual(Object.keys(call.options.headers).sort(), ["Content-Type", "X-Tracker-Installation-Credential", "X-Tracker-Installation-Id", "X-Tracker-Token"]);
  assert.equal(call.url.includes(f.password), false); assert.equal(call.options.credentials, "omit");
});

test("incorrect credentials never persist a session or retry automatically", async () => {
  const f = fixture({ paired: true }); await assert.rejects(f.auth.login(f.username, "wrong"), error => error.code === "invalid-credentials");
  assert.equal(f.storage.session.data[AUTH_KEYS.session], undefined);
  assert.equal(f.calls.filter(call => call.url.endsWith("/login")).length, 1);
});

test("refresh verifies stored session remotely without renewing idle time", async () => {
  const f = fixture({ paired: true }); await f.auth.login(f.username, f.password); f.now += 100000;
  const refreshed = f.makeAuth(); const result = await refreshed.restore();
  assert.equal(result.state, "authenticated"); assert.equal(result.metadata.session.idleRemainingSeconds, 1700);
  assert.equal(f.calls.at(-1).options.method, "GET");
  assert.equal("X-Tracker-Token" in f.calls.at(-1).options.headers, false);
  assert.equal(f.calls.some(call => call.url.endsWith("/activity")), false);
});

test("only explicit activity renews the valid idle deadline", async () => {
  const f = fixture({ paired: true }); await f.auth.login(f.username, f.password); f.now += 100000;
  assert.equal((await f.auth.restore({ activity: true })).metadata.session.idleRemainingSeconds, 1800);
  assert.equal(f.calls.at(-1).url.endsWith("/activity"), true);
});

test("backend restart expires login without removing installation credentials", async () => {
  const f = fixture({ paired: true }); await f.auth.login(f.username, f.password); f.sessions.clear();
  await assert.rejects(f.auth.restore(), error => error.status === 401);
  assert.equal(f.storage.session.data[AUTH_KEYS.session], undefined);
  assert.equal(f.storage.local.data[ENROLLMENT_KEYS.installation].installationCredential, f.installation.installationCredential);
});

test("revoked installations lock session restoration and are not silently re-paired", async () => {
  const f = fixture({ paired: true }); await f.auth.login(f.username, f.password); f.revoked = true;
  await assert.rejects(f.auth.restore(), error => error.code === "installation-unavailable");
  assert.equal(f.created, 0); assert.ok(f.storage.local.data[ENROLLMENT_KEYS.installation]);
});

test("reassignment requires reauthentication and explicit fresh candidate acknowledgement", async () => {
  const f = fixture({ paired: true }); await f.auth.login(f.username, f.password);
  f.bindingRevision = 2; f.candidateId = "candidate-two";
  await assert.rejects(f.auth.restore(), error => error.code === "binding-changed");
  const changed = await f.auth.login(f.username, f.password);
  assert.equal(changed.state, "binding-reassigned"); assert.equal(changed.metadata.context.candidate.name, "Blake Synthetic");
  assert.equal(f.storage.local.data[ENROLLMENT_KEYS.installation].bindingRevision, 1);
  const credential = f.storage.local.data[ENROLLMENT_KEYS.installation].installationCredential;
  const accepted = await f.auth.acknowledgeBinding(changed.metadata.context);
  assert.equal(accepted.state, "authenticated");
  assert.equal(f.storage.local.data[ENROLLMENT_KEYS.installation].bindingRevision, 2);
  assert.equal(f.storage.local.data[ENROLLMENT_KEYS.installation].installationCredential, credential);
  assert.equal(f.calls.at(-1).url.endsWith("/session"), true);
});

test("another reassignment during acknowledgement is rejected", async () => {
  const f = fixture({ paired: true }); f.bindingRevision = 2; f.candidateId = "candidate-two";
  const changed = await f.auth.login(f.username, f.password); f.bindingRevision = 3;
  await assert.rejects(f.auth.acknowledgeBinding(changed.metadata.context), error => error.code === "binding-changed");
  assert.equal(f.storage.local.data[ENROLLMENT_KEYS.installation].bindingRevision, 1);
});

test("cross-installation and wrong-audience responses are rejected before UI activation", async () => {
  for (const mutate of [value => value.context.installationId = "f".repeat(32), value => value.session.audience = "web",
    value => value.context.candidate.id = "../candidate", value => value.context.bindingRevision = 0,
    value => value.user.passwordVerifier = "must not leak"]) {
    const f = fixture({ paired: true });
    f.intercept = url => { if (!url.endsWith("/login")) return; const value = { sessionToken: secret(), ...f.metadata() }; mutate(value); return Promise.resolve(f.reply(200, value)); };
    await assert.rejects(f.auth.login(f.username, f.password));
    assert.equal(f.storage.session.data[AUTH_KEYS.session], undefined);
  }
});

test("identity mismatch prevents installation or owner secrets from being transmitted", async () => {
  const f = fixture({ paired: true }); f.bootstrap.backendId = "f".repeat(32);
  await assert.rejects(f.auth.login(f.username, f.password), error => error.code === "identity-mismatch");
  assert.equal(f.calls.some(call => call.url.endsWith("/login")), false);
});

test("untrusted contexts and failed storage restrictions cannot authenticate", async () => {
  const f = fixture({ paired: true }); f.enrollment.location.protocol = "https:";
  await assert.rejects(f.auth.login(f.username, f.password), error => error.code === "untrusted-context");
  assert.equal(f.calls.length, 0);
  f.enrollment.location.protocol = "chrome-extension:"; f.storage.session.failAccess = true;
  await assert.rejects(f.auth.login(f.username, f.password), error => error.code === "storage-unavailable");
  assert.equal(f.calls.length, 0);
});

test("Incognito is rejected before any storage or network operation", async () => {
  const f = fixture({ paired: true }); const auth = f.makeAuth({ incognito: true });
  await assert.rejects(auth.restore(), error => error.code === "incognito-unsupported");
  assert.deepEqual(f.calls, []); assert.deepEqual(f.levels, []);
});

test("sign out clears local session first and preserves pairing", async () => {
  const f = fixture({ paired: true }); await f.auth.login(f.username, f.password);
  f.intercept = url => { if (url.endsWith("/logout")) assert.equal(f.storage.session.data[AUTH_KEYS.session], undefined); };
  const result = await f.auth.logout(); assert.equal(result.serverConfirmed, true);
  assert.equal(f.storage.session.data[AUTH_KEYS.session], undefined); assert.ok(f.storage.local.data[ENROLLMENT_KEYS.installation]);
});

test("offline logout clears local access and does not claim server revocation", async () => {
  const f = fixture({ paired: true }); await f.auth.login(f.username, f.password); f.offline = true;
  assert.deepEqual(await f.auth.logout(), { serverConfirmed: false, localCleared: true });
  assert.equal(f.storage.session.data[AUTH_KEYS.session], undefined);
  assert.equal(f.sessions.size, 1); assert.ok(f.storage.local.data[ENROLLMENT_KEYS.installation]);
});

test("storage failure after login locks locally without replaying the login", async () => {
  const f = fixture({ paired: true }); f.storage.session.failSet = AUTH_KEYS.session;
  await assert.rejects(f.auth.login(f.username, f.password), error => error.code === "storage-unavailable");
  assert.equal(f.auth.active, false); assert.equal(f.calls.filter(call => call.url.endsWith("/login")).length, 1);
  assert.equal(f.storage.session.data[AUTH_KEYS.session], undefined);
});

test("local browser invocation failures differ from genuine network failures", async () => {
  const f = fixture({ paired: true }); f.intercept = url => { if (url.endsWith("/login")) throw TypeError("Illegal invocation"); };
  await assert.rejects(f.auth.login(f.username, f.password), error => error.code === "client-execution-error");
  const g = fixture({ paired: true }); g.intercept = url => url.endsWith("/login") ? Promise.reject(Error("Offline")) : null;
  await assert.rejects(g.auth.login(g.username, g.password), error => error.code === "connection-unavailable");
});

test("rate limiting preserves Retry-After without automatic retries", async () => {
  const f = fixture({ paired: true }); f.intercept = url => url.endsWith("/login") ? Promise.resolve(f.reply(429, { code: "rate-limited" })) : null;
  await assert.rejects(f.auth.login(f.username, f.password), error => error.retryAfter === 7 && error.status === 429);
  assert.equal(f.calls.filter(call => call.url.endsWith("/login")).length, 1);
});

test("cross-page logout notifications lock trusted pages immediately", async () => {
  const f = fixture({ paired: true }), other = f.makeAuth(), signals = [];
  await f.auth.login(f.username, f.password); await other.restore();
  other.subscribe(reason => signals.push(reason)); const stop = other.watch();
  await f.auth.logout(); await f.flush(); stop();
  assert.ok(signals.includes("session-changed")); assert.equal(other.active, false);
});

test("logout invalidates an in-flight login response from another page", async () => {
  const f = fixture({ paired: true }); let release;
  f.intercept = url => url.endsWith("/login") ? new Promise(resolve => { release = () => resolve(f.reply(200, { sessionToken: secret(), ...f.metadata() })); }) : null;
  const pending = f.auth.login(f.username, f.password); await f.flush();
  await f.makeAuth().logout(); release();
  await assert.rejects(pending, error => error.code === "operation-interrupted");
  assert.equal(f.storage.session.data[AUTH_KEYS.session], undefined);
});

test("a stale 401 cannot erase a newer page's login", async () => {
  const f = fixture({ paired: true }); await f.auth.login(f.username, f.password); let release;
  f.intercept = url => url.endsWith("/session") ? new Promise(resolve => { release = () => resolve(f.reply(401, { code: "authentication-required" })); }) : null;
  const old = f.auth.restore(); await f.flush(); const newer = f.makeAuth(); await newer.login(f.username, f.password);
  const token = f.storage.session.data[AUTH_KEYS.session].token; release(); await assert.rejects(old);
  assert.equal(f.storage.session.data[AUTH_KEYS.session].token, token);
});

test("receiver-sensitive fetch, timer, storage and listener APIs work throughout restoration", async () => {
  const f = fixture({ paired: true }); const stop = f.auth.watch();
  await f.auth.login(f.username, f.password); await f.auth.restore(); await f.auth.logout(); stop();
  assert.equal(f.timers.size, 0);
});

test("two ordinary-profile fixtures keep credentials and owner sessions independent", async () => {
  const a = fixture({ paired: true }), b = fixture({ paired: true });
  b.installation.installationId = b.installation.bindingId = "f".repeat(32);
  b.storage.local.data[ENROLLMENT_KEYS.installation] = structuredClone(b.installation);
  b.candidateId = "candidate-two";
  await a.auth.login(a.username, a.password); await b.auth.login(b.username, b.password);
  assert.notEqual(a.storage.local.data[ENROLLMENT_KEYS.installation].installationCredential,
    b.storage.local.data[ENROLLMENT_KEYS.installation].installationCredential);
  await a.auth.logout(); assert.equal((await b.auth.restore()).metadata.context.candidate.id, "candidate-two");
});

test("corrupted stored sessions and absent trusted storage never become authentication", async () => {
  const f = fixture({ paired: true }); await f.auth.login(f.username, f.password);
  f.storage.session.data[AUTH_KEYS.session].metadata.user.role = "admin";
  await assert.rejects(f.auth.restore(), error => error.code === "invalid-response");
  assert.equal(f.auth.active, false);
});

test("clearing the session control record locks other pages", async () => {
  const f = fixture({ paired: true }); await f.auth.login(f.username, f.password);
  const signals = []; f.auth.subscribe(reason => signals.push(reason)); const stop = f.auth.watch();
  await f.storage.session.remove(AUTH_KEYS.control); await f.flush(); stop();
  assert.equal(f.auth.active, false); assert.ok(signals.includes("session-changed"));
});

test("native timer initialization and cleanup errors remain local failures", async () => {
  const f = fixture({ paired: true }); f.timerFailure = true;
  await assert.rejects(f.auth.login(f.username, f.password), error => error.code === "client-execution-error");
  assert.equal(f.calls.some(call => call.url.endsWith("/login")), false);
  const g = fixture({ paired: true }); g.clearFailure = true;
  await assert.rejects(g.auth.login(g.username, g.password), error => error.code === "client-execution-error");
  assert.equal(g.auth.active, false);
});

test("backend identity is rechecked before accepting a changed binding", async () => {
  const f = fixture({ paired: true }); f.bindingRevision = 2;
  const pending = await f.auth.login(f.username, f.password); f.bootstrap.backendId = "f".repeat(32);
  const before = f.calls.filter(call => call.url.endsWith("/session")).length;
  await assert.rejects(f.auth.acknowledgeBinding(pending.metadata.context), error => error.code === "identity-mismatch");
  assert.equal(f.calls.filter(call => call.url.endsWith("/session")).length, before);
});

test("hung authentication requests abort without retry or persisting a session", async () => {
  const f = fixture({ paired: true });
  f.intercept = (url, options) => url.endsWith("/login") ? new Promise((resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(Error("Synthetic timeout")));
  }) : null;
  const pending = f.auth.login(f.username, f.password); await f.flush();
  const timeout = [...f.timers.values()].find(timer => timer.delay === 12000); assert.ok(timeout); timeout.callback();
  await assert.rejects(pending, error => error.code === "connection-unavailable");
  assert.equal(f.storage.session.data[AUTH_KEYS.session], undefined);
  assert.equal(f.calls.filter(call => call.url.endsWith("/login")).length, 1);
});

test("a stale same-page status failure cannot lock a newer login", async () => {
  const f = fixture({ paired: true }); await f.auth.login(f.username, f.password); let release;
  f.intercept = url => url.endsWith("/session") ? new Promise(resolve => { release = () => resolve(f.reply(401, { code: "authentication-required" })); }) : null;
  const pending = f.auth.restore(); await f.flush(); await f.auth.login(f.username, f.password);
  const token = f.storage.session.data[AUTH_KEYS.session].token;
  release(); await assert.rejects(pending, error => error.status === 401);
  assert.equal(f.auth.active, true); assert.equal(f.storage.session.data[AUTH_KEYS.session].token, token);
});
