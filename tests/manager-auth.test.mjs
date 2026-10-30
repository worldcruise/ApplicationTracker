import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { ManagerAuth, mergeDraft } from "../manager/ui/auth.mjs";

const metadata = id => ({ authenticated: true, user: { id: id || "a".repeat(32), username: "synthetic-owner", role: "owner" }, session: { idleRemainingSeconds: 1800, absoluteRemainingSeconds: 28800 } });
function fixture(t, extra = {}) {
  const calls = [], phases = [], events = [], timers = new Map(); let handler, timerId = 0;
  const auth = new ManagerAuth({
    fetch: async (path, options) => { calls.push({ path, ...options }); return handler(path, options); },
    onChange: state => phases.push(state.phase), onSuspend: owner => events.push(["suspend", owner.id]),
    onClear: () => events.push(["clear"]), onAuthenticated: owner => events.push(["load", owner.id]),
    setTimer: (action, delay) => { const id = ++timerId; timers.set(id, { action, delay }); return id; }, clearTimer: id => timers.delete(id), ...extra
  });
  const response = (data, status = 200, retry = "") => ({ ok: status < 400, status, headers: { get: () => retry }, json: async () => data });
  handler = path => response(path.endsWith("status") ? { state: "ready", csrfToken: "csrf-only", managerAuthorizationEnforced: true } : metadata());
  t.after(() => auth.dispose());
  return { auth, calls, phases, events, timers, response, set handler(value) { handler = value; } };
}

test("bootstrap precedes session verification and workspace loading; cookie credentials never enter JS", async t => {
  const f = fixture(t); await f.auth.start();
  assert.deepEqual(f.calls.map(call => call.path), ["/api/auth/status", "/api/auth/session"]);
  assert.equal(f.auth.phase, "authenticated"); assert.deepEqual(f.events, [["load", "a".repeat(32)]]);
  assert.ok(f.calls.every(call => call.credentials === "same-origin" && call.cache === "no-store"));
  assert.equal("token" in f.auth, false); assert.equal(f.auth.csrf, "csrf-only");
});
test("missing owner and corrupt storage show distinct closed states with no protected requests", async t => {
  for (const [state, expected] of [["setup-required", "setup-required"], ["unavailable", "unavailable"]]) {
    const f = fixture(t); f.handler = () => f.response({ state, csrfToken: "csrf-only", managerAuthorizationEnforced: true });
    await f.auth.start(); assert.equal(f.auth.phase, expected); assert.equal(f.calls.length, 1); assert.equal(f.events.length, 0);
    await assert.rejects(f.auth.api("/api/state"), error => error.authHandled);
  }
});
test("an old backend that does not enforce authorization is never accepted", async t => {
  const f = fixture(t); f.handler = () => f.response({ state: "ready", csrfToken: "csrf-only", managerAuthorizationEnforced: false });
  await f.auth.start(); assert.notEqual(f.auth.phase, "authenticated"); assert.equal(f.events.length, 0);
});
test("unauthenticated bootstrap shows login without loading candidate data", async t => {
  const f = fixture(t); f.handler = path => path.endsWith("status") ? f.response({ state: "ready", csrfToken: "csrf-only", managerAuthorizationEnforced: true }) : f.response({ error: "Sign in", code: "authentication-required" }, 401);
  await f.auth.start(); assert.equal(f.auth.phase, "login"); assert.equal(f.events.length, 0);
});
test("login forwards credentials only in JSON and verifies the cookie session before loading", async t => {
  const f = fixture(t); f.auth.csrf = "csrf-only"; await f.auth.login("synthetic-owner", "synthetic passphrase");
  assert.deepEqual(f.calls.map(call => call.path), ["/api/auth/login", "/api/auth/session"]);
  assert.equal(f.calls[0].headers["X-Tracker-Token"], "csrf-only"); assert.equal(JSON.parse(f.calls[0].body).password, "synthetic passphrase");
  assert.equal(JSON.stringify(f.auth).includes("synthetic passphrase"), false); assert.equal(f.auth.phase, "authenticated");
});
test("credential, rate, protection, configuration and network failures stay distinct", async t => {
  for (const [status, code, phase] of [[401, "invalid-credentials", "login"], [429, "rate-limited", "login"], [403, "invalid-origin", "blocked"], [503, "authentication-unavailable", "unavailable"], [503, "owner-setup-required", "setup-required"]]) {
    const f = fixture(t); f.handler = () => f.response({ error: "Safe failure", code }, status, "5");
    await f.auth.login("synthetic", "synthetic password"); assert.equal(f.auth.phase, phase); assert.equal(f.events.length, 0);
    if (status === 429) assert.match(f.auth.message, /5 seconds/);
  }
  const f = fixture(t); f.handler = () => { throw new TypeError("Failed to fetch"); }; await f.auth.start(); assert.equal(f.auth.phase, "disconnected");
});
test("business 401 suspends drafts; local deadline also locks and never grants access", async t => {
  const f = fixture(t); await f.auth.start();
  f.handler = () => f.response({ error: "Sign in", code: "authentication-required" }, 401);
  await assert.rejects(f.auth.api("/api/state"), error => error.authHandled);
  assert.equal(f.auth.phase, "expired"); assert.deepEqual(f.events.at(-1), ["suspend", "a".repeat(32)]);
  const g = fixture(t); await g.auth.start(); const deadline = [...g.timers.values()][0];
  assert.equal(deadline.delay, 1800000); deadline.action(); assert.equal(g.auth.phase, "expired");
});
test("late successful responses cannot restore data after suspension", async t => {
  const f = fixture(t); await f.auth.start(); let finish;
  f.handler = () => new Promise(resolve => { finish = resolve; });
  const pending = f.auth.api("/api/state"); f.auth.lock("expired", "Session expired"); finish(f.response({ candidates: ["sensitive"] }));
  await assert.rejects(pending, error => error.authHandled); assert.equal(f.auth.phase, "expired");
});
test("403 protection errors lock without replaying writes; ordinary business errors retain auth", async t => {
  const f = fixture(t); await f.auth.start();
  f.handler = () => f.response({ error: "Bad folder", code: "validation" }, 400);
  await assert.rejects(f.auth.api("/api/candidates", { method: "POST", body: {} }), /Bad folder/); assert.equal(f.auth.phase, "authenticated");
  f.handler = () => f.response({ error: "Bad token", code: "invalid-csrf" }, 403);
  const before = f.calls.length; await assert.rejects(f.auth.api("/api/candidates", { method: "POST", body: {} }), error => error.authHandled);
  assert.equal(f.calls.length - before, 1); assert.equal(f.auth.phase, "blocked");
});
test("logout confirms dirty edits, clears state, revokes server session and broadcasts only a hint", async t => {
  const f = fixture(t); await f.auth.start(); f.auth.dirty = () => true; f.auth.confirmDiscard = () => false;
  assert.equal(await f.auth.logout(), false); assert.equal(f.auth.phase, "authenticated");
  f.auth.confirmDiscard = () => true; const hints = []; f.auth.channel = { postMessage: value => hints.push(value), close() {} };
  f.handler = path => f.response(path.endsWith("status") ? { csrfToken: "renewed" } : { authenticated: false });
  assert.equal(await f.auth.logout(), true); assert.equal(f.auth.phase, "login"); assert.deepEqual(hints, [{ type: "signed-out" }]);
  assert.equal(f.calls.at(-1).path, "/api/auth/logout"); assert.equal(f.auth.owner, null); assert.ok(f.events.some(event => event[0] === "clear"));
});
test("offline logout stays locked and retry signs out instead of restoring workspace", async t => {
  const f = fixture(t); await f.auth.start(); f.handler = () => { throw new TypeError("offline"); };
  assert.equal(await f.auth.logout(), false); assert.equal(f.auth.phase, "logout-unconfirmed"); assert.equal(f.auth.pendingLogout, true);
  f.handler = path => f.response(path.endsWith("status") ? { csrfToken: "csrf-only" } : { authenticated: false });
  await f.auth.start(); assert.equal(f.auth.phase, "login"); assert.equal(f.calls.at(-1).path, "/api/auth/logout");
});
test("a different verified owner clears previous drafts before any workspace is loaded", async t => {
  const f = fixture(t); await f.auth.start(); f.auth.lock("expired", "Sign in"); f.handler = () => f.response(metadata("b".repeat(32)));
  await f.auth.login("different-owner", "synthetic password");
  assert.deepEqual(f.events.slice(-2), [["clear"], ["load", "b".repeat(32)]]);
});
test("activity requires an explicit call, is throttled and session checks never become activity", async t => {
  const f = fixture(t); await f.auth.start(); let now = 0; f.auth.now = () => now;
  await f.auth.check(); assert.equal(f.calls.some(call => call.path.endsWith("activity")), false);
  await f.auth.activity(); await f.auth.activity(); assert.equal(f.calls.filter(call => call.path.endsWith("activity")).length, 1);
  now = 60000; await f.auth.activity(); assert.equal(f.calls.filter(call => call.path.endsWith("activity")).length, 2);
  // A trusted pointer event may renew activity just before the Sign out click.
  // That request must not disable Sign out as though a business save were pending.
  let release; const gate = new Promise(resolve => { release = resolve; }); now = 120000;
  f.handler = async path => { if (path.endsWith("activity")) await gate; return f.response(path.endsWith("status") ? { csrfToken: "csrf-only" } : metadata()); };
  const pending = f.auth.activity(); assert.equal(f.auth.writes, 0);
  assert.equal(await f.auth.logout(), true); release(); await pending; assert.equal(f.auth.phase, "login");
});
test("focus and cross-tab hints revalidate; hints never create an authenticated session", async t => {
  const f = fixture(t); const listeners = {};
  f.auth.bind({ addEventListener: (name, action) => { listeners[name] = action; } }, { addEventListener() {}, visibilityState: "visible" });
  await f.auth.start(); const before = f.calls.length; await listeners.focus(); await f.auth.checking;
  assert.equal(f.calls.at(-1).path, "/api/auth/session"); assert.ok(f.calls.length > before);
  const channel = { postMessage() {}, close() {} }; const g = new ManagerAuth({ channel }); t.after(() => g.dispose());
  channel.onmessage({ data: { type: "signed-out" } }); assert.equal(g.phase, "expired"); assert.equal(g.owner, null);
});
test("three-way draft merge retains newer unknown fields and stable entry IDs", () => {
  const base = { contact: { phone: "old", unknown: 1 }, entries: [{ id: "one", title: "old", unknown: 1 }] };
  const draft = structuredClone(base); draft.contact.phone = "edited"; draft.entries[0].title = "edited";
  const latest = structuredClone(base); latest.contact.unknown = 2; latest.entries[0].unknown = 3; latest.entries.push({ id: "two", title: "new" });
  const merged = mergeDraft(base, draft, latest);
  assert.equal(merged.contact.phone, "edited"); assert.equal(merged.contact.unknown, 2); assert.equal(merged.entries[0].unknown, 3); assert.equal(merged.entries[1].id, "two");
});
test("HTML starts closed and app initialization is behind backend verification", async () => {
  const html = await readFile(new URL("../manager/ui/index.html", import.meta.url), "utf8");
  const app = await readFile(new URL("../manager/ui/app.js", import.meta.url), "utf8");
  assert.match(html, /<body data-auth="checking">/); assert.match(html, /id="auth-form" method="post" hidden/);
  assert.match(app, /onAuthenticated: async owner/); assert.doesNotMatch(app, /localStorage|indexedDB/);
});

test("failed workspace revalidation cannot reveal retained drafts", async t => {
  const f = fixture(t); await f.auth.start(); f.auth.lock("expired", "Sign in");
  f.auth.onAuthenticated = async () => { throw new Error("Profile reload failed"); };
  await f.auth.login("synthetic", "synthetic password"); assert.equal(f.auth.phase, "unavailable"); assert.equal(f.auth.ready, false);
});
test("a local copy or download waits for an in-flight verification and cannot run after rejection", async t => {
  const f = fixture(t); await f.auth.start(); let finish, actions = 0;
  f.handler = () => new Promise(resolve => { finish = resolve; }); const check = f.auth.check();
  const action = f.auth.verifyAction(() => { actions++; }); assert.equal(actions, 0);
  finish(f.response({ error: "Sign in", code: "authentication-required" }, 401)); await check;
  await assert.rejects(action, error => error.authHandled); assert.equal(actions, 0);
});
test("signed-in cross-tab notifications obtain a verified session instead of trusting the hint", async t => {
  const channel = { postMessage() {}, close() {} }, f = fixture(t, { channel });
  f.handler = path => path.endsWith("status") ? f.response({ state: "ready", csrfToken: "csrf-only", managerAuthorizationEnforced: true }) : f.response({ error: "Sign in" }, 401);
  await f.auth.start(); assert.equal(f.auth.phase, "login");
  f.handler = path => f.response(path.endsWith("status") ? { state: "ready", csrfToken: "csrf-only", managerAuthorizationEnforced: true } : metadata());
  channel.onmessage({ data: { type: "signed-in" } }); await f.auth.starting;
  assert.equal(f.auth.phase, "authenticated"); assert.deepEqual(f.calls.slice(-2).map(call => call.path), ["/api/auth/status", "/api/auth/session"]);
});
test("simultaneous bootstrap requests share one initialization", async t => {
  const f = fixture(t); let finish;
  f.handler = path => path.endsWith("status") ? new Promise(resolve => { finish = resolve; }) : f.response(metadata());
  const first = f.auth.start(), second = f.auth.start(); assert.equal(first, second); assert.equal(f.calls.length, 1);
  finish(f.response({ state: "ready", csrfToken: "csrf-only", managerAuthorizationEnforced: true })); await first;
  assert.equal(f.events.filter(event => event[0] === "load").length, 1);
});

test("browser-native fetch receives the global receiver for default and injected transports", async t => {
  const paths = [];
  let signedIn = false;
  const browserFetch = function (path, options) {
    assert.equal(this, globalThis, "A browser-native fetch must not receive ManagerAuth as its receiver");
    paths.push(path);
    assert.equal(options.credentials, "same-origin");
    if (path.endsWith("login")) {
      assert.equal(options.headers["X-Tracker-Token"], "csrf-only"); signedIn = true;
    }
    const data = path.endsWith("status") ? { state: "ready", csrfToken: "csrf-only", managerAuthorizationEnforced: true }
      : path === "/api/state" ? { candidates: [] } : signedIn ? metadata() : { error: "Sign in", code: "authentication-required" };
    return Promise.resolve({ ok: path.endsWith("session") ? signedIn : true, status: path.endsWith("session") && !signedIn ? 401 : 200, json: async () => data });
  };
  t.mock.method(globalThis, "fetch", browserFetch);
  for (const injected of [false, true]) {
    paths.length = 0; signedIn = false;
    const auth = new ManagerAuth({ ...(injected ? { fetch: globalThis.fetch } : {}),
      onAuthenticated: async () => { await auth.api("/api/state"); } });
    t.after(() => auth.dispose());
    await auth.start(); assert.equal(auth.phase, "login");
    assert.deepEqual(paths, ["/api/auth/status", "/api/auth/session"]);
    await auth.login("synthetic-owner", "synthetic password");
    assert.equal(auth.phase, "authenticated");
    assert.deepEqual(paths.slice(2), ["/api/auth/login", "/api/auth/session", "/api/state"]);
  }
});

test("synchronous browser request execution errors are not reported as backend outages", async t => {
  const auth = new ManagerAuth({ fetch() { throw new ReferenceError("Synthetic request implementation bug"); } });
  t.after(() => auth.dispose());
  await auth.start(); assert.equal(auth.phase, "client-error"); assert.equal(auth.ready, false);
  assert.match(auth.message, /browser.*request/i); assert.doesNotMatch(auth.message, /backend unavailable|cannot reach/i);
  const f = fixture(t); await f.auth.start(); f.auth.fetcher = () => { throw new TypeError("Illegal invocation"); };
  await assert.rejects(f.auth.api("/api/state"), error => error.authHandled);
  assert.equal(f.auth.phase, "client-error"); assert.ok(f.events.some(event => event[0] === "suspend"));
});

test("a rejected illegal-invocation error is distinct from a rejected network fetch", async t => {
  for (const [message, expected] of [["Failed to execute 'fetch' on 'Window': Illegal invocation", "client-error"], ["Failed to fetch", "disconnected"]]) {
    const auth = new ManagerAuth({ fetch: () => Promise.reject(new TypeError(message)) });
    t.after(() => auth.dispose()); await auth.start(); assert.equal(auth.phase, expected); assert.equal(auth.ready, false);
  }
});

function receiverTimers() {
  const active = new Map(), calls = [], fail = { set: false, clear: false }; let serial = 0;
  return {
    active, calls, fail,
    setTimer: function (action, delay) {
      assert.ok(this === globalThis, "setTimeout requires the browser global receiver");
      calls.push(["set", delay]);
      if (fail.set) throw new Error("Synthetic timer creation failure");
      const id = ++serial; active.set(id, { action, delay }); return id;
    },
    clearTimer: function (id) {
      assert.ok(this === globalThis, "clearTimeout requires the browser global receiver");
      calls.push(["clear", id]);
      if (fail.clear) throw new Error("Synthetic timer cleanup failure");
      active.delete(id);
    }
  };
}

test("receiver-sensitive timers allow verified login before initializing Studio", async t => {
  const timers = receiverTimers(), f = fixture(t, timers); let initialized = 0;
  f.auth.csrf = "csrf-only";
  f.auth.onAuthenticated = async () => {
    assert.equal(timers.active.size, 1);
    assert.equal([...timers.active.values()][0].delay, 1800000);
    await f.auth.api("/api/state"); initialized++;
  };
  await f.auth.login("synthetic-owner", "synthetic passphrase");
  assert.equal(f.auth.phase, "authenticated"); assert.equal(initialized, 1);
  assert.deepEqual(f.calls.map(call => call.path), ["/api/auth/login", "/api/auth/session", "/api/state"]);
  assert.deepEqual(timers.calls.slice(0, 2), [["clear", undefined], ["set", 1800000]]);
  assert.equal(f.calls[0].headers["X-Tracker-Token"], "csrf-only");
});

test("default native timer references receive the global receiver after dependency capture", async t => {
  const timers = receiverTimers(), originals = { set: globalThis.setTimeout, clear: globalThis.clearTimeout }; let f;
  // Capture browser-like native defaults synchronously; do not replace Node's
  // globals while the asynchronous test/framework is running.
  try {
    globalThis.setTimeout = timers.setTimer; globalThis.clearTimeout = timers.clearTimer;
    f = fixture(t, { setTimer: undefined, clearTimer: undefined });
  } finally {
    globalThis.setTimeout = originals.set; globalThis.clearTimeout = originals.clear;
  }
  await f.auth.login("synthetic-owner", "synthetic passphrase");
  assert.equal(f.auth.phase, "authenticated"); assert.equal(timers.active.size, 1);
  assert.deepEqual(timers.calls.slice(0, 2), [["clear", undefined], ["set", 1800000]]);
});

test("restored sessions initialize receiver-sensitive expiration monitoring before loading", async t => {
  const timers = receiverTimers(), f = fixture(t, timers);
  await f.auth.start();
  assert.equal(f.auth.phase, "authenticated"); assert.equal(timers.active.size, 1);
  assert.deepEqual(f.calls.map(call => call.path), ["/api/auth/status", "/api/auth/session"]);
  assert.deepEqual(f.events, [["load", "a".repeat(32)]]);
});

test("repeated initialization replaces timers using verified remaining deadlines", async t => {
  const timers = receiverTimers(), f = fixture(t, timers);
  await f.auth.start(); const original = f.auth.expiryTimer;
  await f.auth.start(); assert.notEqual(f.auth.expiryTimer, original);
  assert.equal(timers.active.has(original), false); assert.equal(timers.active.size, 1);
  f.handler = () => f.response({ ...metadata(), session: { idleRemainingSeconds: 90, absoluteRemainingSeconds: 40 } });
  await f.auth.check();
  assert.equal(f.auth.phase, "authenticated"); assert.equal(timers.active.size, 1);
  assert.equal([...timers.active.values()][0].delay, 40000);
  assert.equal(f.calls.some(call => call.path.endsWith("activity")), false);
});

test("logout clears receiver-sensitive timers and confirms backend revocation", async t => {
  const timers = receiverTimers(), f = fixture(t, timers);
  await f.auth.start();
  f.handler = path => f.response(path.endsWith("status") ? { csrfToken: "csrf-only" } : { authenticated: false });
  assert.equal(await f.auth.logout(), true);
  assert.equal(timers.active.size, 0); assert.equal(f.auth.phase, "login"); assert.equal(f.auth.owner, null);
  assert.equal(f.calls.at(-1).path, "/api/auth/logout");
});

test("receiver-sensitive expiration cleanup locks protected actions", async t => {
  const timers = receiverTimers(), f = fixture(t, timers);
  await f.auth.start(); const deadline = [...timers.active.values()][0];
  deadline.action();
  assert.equal(f.auth.phase, "expired"); assert.equal(f.auth.ready, false);
  assert.equal(timers.active.size, 0); assert.ok(f.events.some(event => event[0] === "suspend"));
  await assert.rejects(f.auth.api("/api/state"), error => error.authHandled);
});

test("timer creation or cleanup failure after verified login is a locked local error", async t => {
  for (const operation of ["set", "clear"]) {
    const timers = receiverTimers(), f = fixture(t, timers); timers.fail[operation] = true;
    await f.auth.login("synthetic-owner", "synthetic passphrase");
    assert.equal(f.auth.phase, "client-error", operation); assert.equal(f.auth.ready, false);
    assert.equal(f.auth.owner, null); assert.equal(f.events.some(event => event[0] === "load"), false);
    assert.match(f.auth.message, /browser.*session/i); assert.doesNotMatch(f.auth.message, /backend unavailable|cannot reach/i);
    assert.deepEqual(f.calls.map(call => call.path), ["/api/auth/login", "/api/auth/session"]);
    await assert.rejects(f.auth.api("/api/state"), error => error.authHandled);
    timers.fail[operation] = false;
  }
});

test("restored session timer failure cannot initialize protected Studio", async t => {
  const timers = receiverTimers(), f = fixture(t, timers); timers.fail.set = true;
  await f.auth.start();
  assert.equal(f.auth.phase, "client-error"); assert.equal(f.auth.ready, false);
  assert.equal(f.events.some(event => event[0] === "load"), false);
  assert.deepEqual(f.calls.map(call => call.path), ["/api/auth/status", "/api/auth/session"]);
});

test("session checks and explicit activity classify timer failures locally and suspend drafts", async t => {
  for (const action of ["check", "activity"]) {
    const timers = receiverTimers(), f = fixture(t, timers);
    await f.auth.start(); timers.fail.set = true;
    await f.auth[action]();
    assert.equal(f.auth.phase, "client-error", action); assert.equal(f.auth.ready, false);
    assert.ok(f.events.some(event => event[0] === "suspend"));
    await assert.rejects(f.auth.verifyAction(() => assert.fail("Protected action executed")), error => error.authHandled);
  }
});

test("genuine login network rejection remains disconnected without initializing timers", async t => {
  const timers = receiverTimers(), f = fixture(t, timers);
  f.handler = () => Promise.reject(new TypeError("Failed to fetch"));
  await f.auth.login("synthetic-owner", "synthetic passphrase");
  assert.equal(f.auth.phase, "disconnected"); assert.equal(f.auth.ready, false);
  assert.equal(f.events.some(event => event[0] === "load"), false); assert.equal(timers.active.size, 0);
  assert.deepEqual(f.calls.map(call => call.path), ["/api/auth/login"]);
});

test("timer cleanup failure does not prevent logout revocation or unlock stale expiry callbacks", async t => {
  const timers = receiverTimers(), f = fixture(t, timers);
  await f.auth.start(); const staleDeadline = [...timers.active.values()][0]; timers.fail.clear = true;
  f.handler = path => f.response(path.endsWith("status") ? { csrfToken: "csrf-only" } : { authenticated: false });
  assert.equal(await f.auth.logout(), true);
  assert.equal(f.auth.phase, "client-error"); assert.equal(f.auth.ready, false); assert.equal(f.auth.owner, null);
  assert.equal(f.calls.at(-1).path, "/api/auth/logout"); assert.match(f.auth.message, /signed out/i);
  staleDeadline.action(); assert.equal(f.auth.phase, "client-error");
  timers.fail.clear = false;
});

test("timer cleanup failure still aborts pending work and suspends protected content", async t => {
  const timers = receiverTimers(), f = fixture(t, timers);
  await f.auth.start(); let finish;
  f.handler = () => new Promise(resolve => { finish = resolve; });
  const pending = f.auth.api("/api/state"); const signal = f.calls.at(-1).signal;
  const rejected = assert.rejects(pending, error => error.authHandled);
  timers.fail.clear = true;
  f.auth.lock("expired", "Sign in again");
  assert.equal(f.auth.phase, "client-error"); assert.equal(f.auth.ready, false); assert.equal(signal.aborted, true);
  assert.ok(f.events.some(event => event[0] === "suspend"));
  finish(f.response({ candidates: ["synthetic stale response"] }));
  await rejected;
  timers.fail.clear = false;
});
