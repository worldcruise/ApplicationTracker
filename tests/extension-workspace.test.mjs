import test from "node:test";
import assert from "node:assert/strict";
import { fixture, domFixture, html } from "./extension-ui-fakes.mjs";
import { WorkspaceController } from "../extension/workspace.mjs";
import { bindWorkspace } from "../extension/studio/workspace-view.mjs";
import { AUTH_KEYS } from "../extension/studio/auth.mjs";
import { ENROLLMENT_KEYS } from "../extension/studio/enrollment.mjs";

function screen(t, options = {}) {
  const f = fixture(options), dom = domFixture();
  class Controller extends WorkspaceController {
    constructor(options) { super({ ...options, setTimer: f.setTimer, clearTimer: f.clearTimer }); }
  }
  const controller = bindWorkspace(Controller, { ...dom, auth: f.auth, editor: f.editor, now: () => f.now });
  t.after(() => controller.dispose());
  return Object.assign(f, dom, { controller });
}
async function pair(f) {
  await f.flush(); await f.controller.confirmBackend(); await f.controller.requestPairing("Synthetic profile");
}
async function login(f) { await f.flush(); await f.controller.login(f.username, f.password); }

test("unpaired screen checks real bootstrap without auto-pinning or pairing", async t => {
  const f = screen(t); await f.flush();
  assert.equal(f.controller.view.status, "unpaired"); assert.equal(f.$("pairing").hidden, false);
  assert.equal(f.$("request-pairing").disabled, true); assert.equal(f.$("authenticated-shell").hidden, true);
  assert.equal(f.$("backend-status").textContent, "Local backend: Available");
  assert.equal(f.created, 0); assert.equal(f.storage.local.data[ENROLLMENT_KEYS.identity], undefined);
});
test("identity confirmation enables explicit labeled pairing and shows the real code", async t => {
  const f = screen(t); await pair(f);
  assert.equal(f.created, 1); assert.equal(f.$("pending").hidden, false);
  assert.equal(f.$("approval-code").textContent, "ABCD-2345");
  assert.equal(f.$("pending-label").textContent, "Browser: Synthetic profile");
  assert.match(f.$("pending-expiry").textContent, /5:00/);
  assert.equal(f.claims, 0);
});
test("pending and approved claims require clicks and lead to paired confirmation then login", async t => {
  const f = screen(t); await pair(f); await f.controller.claimPairing();
  assert.equal(f.controller.view.status, "pairing-pending"); assert.match(f.controller.view.notice, /approval is still pending/);
  f.approved = true;
  // screen spreads fixture values; mutate the transport through its captured f.
  f.enrollment.fetcher = function (url, options) {
    if (url.includes("/claim")) return Promise.resolve(f.reply(200, Object.fromEntries(Object.entries(f.installation).filter(([key]) => key !== "schemaVersion"))));
    return f.fetcher.call(this, url, options);
  };
  await f.controller.claimPairing(); assert.equal(f.controller.view.status, "paired");
  assert.equal(f.storage.session.data[ENROLLMENT_KEYS.pending], undefined);
  f.controller.continueToLogin(); assert.equal(f.$("login").hidden, false);
});
test("cancel clears only local pending exchange and never claims server cancellation", async t => {
  const f = screen(t); await pair(f); await f.controller.clearPending();
  assert.equal(f.controller.view.status, "unpaired"); assert.match(f.controller.view.notice, /did not cancel or revoke/);
  assert.equal(f.storage.session.data[ENROLLMENT_KEYS.pending], undefined);
  assert.equal(f.calls.some(call => /cancel|revoke/.test(call.url)), false);
});
test("pending expiry disables claiming and countdown performs no network polling", async t => {
  const f = screen(t); await pair(f); const before = f.calls.length;
  const tick = [...f.timers.values()].find(timer => timer.delay === 1000);
  const expires = Date.parse(f.controller.view.pending.expiresAt);
  f.controller.now = () => expires + 1;
  tick.callback();
  assert.equal(f.controller.view.status, "pairing-expired"); assert.equal(f.$("claim-pairing").disabled, true);
  assert.equal(f.calls.length, before);
});
test("denied or consumed claim shows recovery and never automatically replays", async t => {
  const f = screen(t); await pair(f);
  f.enrollment.fetcher = function (url, options) { return url.includes("/claim") ? Promise.resolve(f.reply(409, { code: "pairing-consumed" })) : f.fetcher.call(this, url, options); };
  await f.controller.claimPairing(); assert.equal(f.controller.view.status, "recovery-required");
  assert.match(f.controller.view.error, /denied or already consumed/);
  assert.equal(f.$("clear-pending").disabled, true);
  assert.equal(f.$("authenticated-shell").hidden, true);
  assert.equal(f.storage.session.data[ENROLLMENT_KEYS.pending].exchangeSecret, null);
});
test("one-time credential storage failure keeps recovery locked without replay", async t => {
  const f = screen(t); await pair(f); f.storage.local.failSet = ENROLLMENT_KEYS.installation;
  let claims = 0;
  f.enrollment.fetcher = function (url, options) {
    if (!url.includes("/claim")) return f.fetcher.call(this, url, options);
    claims++; const { schemaVersion, ...value } = f.installation; return Promise.resolve(f.reply(200, value));
  };
  await f.controller.claimPairing(); await f.controller.claimPairing();
  assert.equal(claims, 1); assert.equal(f.controller.view.status, "recovery-required");
  assert.equal(f.storage.local.data[ENROLLMENT_KEYS.installation], undefined);
});
test("paired but signed-out screen is not an authenticated indicator", async t => {
  const f = screen(t, { paired: true }); await f.flush();
  assert.equal(f.controller.view.status, "signed-out"); assert.equal(f.$("login").hidden, false);
  assert.equal(f.$("owner-header").hidden, true); assert.equal(f.$("candidate-name").textContent, "");
});
test("login form clears its password and opens verified two-tab shell", async t => {
  const f = screen(t, { paired: true }); await f.flush();
  f.$("username").value = f.username; f.$("password").value = f.password;
  await f.$("login-form").fire("submit"); assert.equal(f.$("password").value, ""); await f.flush();
  assert.equal(f.controller.view.status, "authenticated");
  assert.equal(f.$("candidate-name").textContent, "Candidate: Alex Synthetic");
  assert.equal(f.$("authenticated-shell").hidden, false); assert.equal(f.$("owner-header").hidden, false);
  const serialized = JSON.stringify(f.controller.view);
  assert.equal(serialized.includes(f.installation.installationCredential), false);
  assert.equal(serialized.includes(f.storage.session.data[AUTH_KEYS.session].token), false);
});
test("incorrect credentials remain a login error with no workspace flash", async t => {
  const f = screen(t, { paired: true }); await f.flush(); await f.controller.login(f.username, "wrong");
  assert.equal(f.controller.view.status, "signed-out"); assert.match(f.$("error").textContent, /Invalid username or password/);
  assert.equal(f.$("authenticated-shell").hidden, true);
});
test("refresh restores only after authenticated backend verification", async t => {
  const f = screen(t, { paired: true }); await login(f);
  f.controller.suspend(); assert.equal(f.$("candidate-name").textContent, "");
  await f.controller.boot(); assert.equal(f.controller.view.status, "authenticated");
  assert.equal(f.calls.at(-1).url.endsWith("/session"), true);
});
test("keyboard tab navigation has exactly two tabs and correctly linked panels", async t => {
  const f = screen(t, { paired: true }); await login(f);
  assert.equal((html.match(/role="tab"/g) || []).length, 2);
  await f.$("tab-workspace").fire("keydown", { key: "ArrowRight" });
  assert.equal(f.controller.view.tab, "settings"); assert.equal(f.document.activeElement.id, "tab-settings");
  assert.equal(f.$("panel-settings").hidden, false); assert.equal(f.$("panel-workspace").hidden, true);
  assert.equal(f.$("tab-settings").attributes["aria-selected"], "true");
  await f.$("tab-settings").fire("keydown", { key: "Home" }); assert.equal(f.controller.view.tab, "workspace");
  assert.match(html, /for="username"/); assert.match(html, /for="password"/);
});
test("workspace has real editors while Settings stays deferred without unsupported actions", () => {
  for (const title of ["Job Description", "CV (JSON)", "Cover Letter", "Personal Details", "Custom Prompts"]) assert.ok(html.includes(title));
  for (const id of ["job-description", "cv-json", "cover-letter", "copy-jd", "open-import", "copy-cover-letter"]) assert.ok(html.includes(`id="${id}"`));
  assert.equal(/<button[^>]*>\s*(?:Save|Generate|Download|Capture)/.test(html), false);
  assert.match(html, /Candidate settings integration is coming in D5E/);
  assert.equal(/<script(?![^>]*src=)[^>]*>\s*\S/.test(html), false);
});
test("sign out clears protected DOM and preserves installation", async t => {
  const f = screen(t, { paired: true }); await login(f); await f.controller.signOut();
  assert.equal(f.$("authenticated-shell").hidden, true); assert.equal(f.$("candidate-name").textContent, "");
  assert.equal(f.controller.view.status, "signed-out"); assert.ok(f.storage.local.data[ENROLLMENT_KEYS.installation]);
});
test("offline sign out still locks and reports unconfirmed server revocation", async t => {
  const f = screen(t, { paired: true }); await login(f);
  f.enrollment.fetcher = () => Promise.reject(Error("Offline")); await f.controller.signOut();
  assert.match(f.controller.view.error, /Server sign-out could not be confirmed/);
  assert.equal(f.storage.session.data[AUTH_KEYS.session], undefined); assert.equal(f.$("authenticated-shell").hidden, true);
});
test("local expiration hides candidate content and clears shared session", async t => {
  const f = screen(t, { paired: true }); await login(f);
  const deadline = [...f.timers.values()].find(timer => timer.delay === 1800000);
  assert.ok(deadline); deadline.callback(); await f.flush();
  assert.equal(f.$("authenticated-shell").hidden, true); assert.equal(f.$("candidate-name").textContent, "");
  assert.equal(f.storage.session.data[AUTH_KEYS.session], undefined);
});
test("timer setup failure after backend login is local and cannot activate shell", async t => {
  const f = screen(t, { paired: true }); await f.flush();
  f.controller.setTimer = function () { assert.equal(this, globalThis); throw TypeError("Illegal invocation"); };
  await f.controller.login(f.username, f.password);
  assert.equal(f.controller.view.status, "client-error"); assert.equal(f.$("authenticated-shell").hidden, true);
  assert.equal(f.storage.session.data[AUTH_KEYS.session], undefined);
  assert.equal(f.controller.view.error.includes("backend outage"), true);
});
test("backend disconnection locks content and reconnect verifies the stored session", async t => {
  const f = screen(t, { paired: true }); await login(f);
  const fetcher = f.enrollment.fetcher;
  f.enrollment.fetcher = () => Promise.reject(Error("Offline"));
  await f.controller.boot(); assert.equal(f.controller.view.status, "disconnected"); assert.equal(f.$("candidate-name").textContent, "");
  f.enrollment.fetcher = fetcher; await f.controller.boot(); assert.equal(f.controller.view.status, "authenticated");
});
test("focus and visibility restoration verify but never renew sessions automatically", async t => {
  const f = screen(t, { paired: true }); await login(f);
  f.document.visibilityState = "hidden"; for (const callback of f.document.listeners.visibilitychange) callback();
  assert.equal(f.$("authenticated-shell").hidden, true);
  f.document.visibilityState = "visible"; for (const callback of f.document.listeners.visibilitychange) callback();
  await f.flush(); assert.equal(f.controller.view.status, "authenticated");
  assert.equal(f.calls.some(call => call.url.endsWith("/activity")), false);
});
test("Incognito page performs no storage or network operation", async t => {
  const g = fixture({ paired: true }); g.auth.incognito = true;
  const controller = new WorkspaceController({ auth: g.auth, setTimer: g.setTimer, clearTimer: g.clearTimer });
  t.after(() => controller.dispose());
  await controller.boot(); assert.equal(controller.view.status, "incognito"); assert.equal(g.calls.length, 0); assert.equal(g.levels.length, 0);
});

test("reassigned candidate stays outside the shell until explicit acknowledgement", async t => {
  const f = screen(t, { paired: true }); await login(f); f.bindingRevision = 2; f.candidateId = "candidate-two";
  await f.controller.boot(); assert.equal(f.controller.view.status, "binding-reassigned");
  assert.equal(f.$("candidate-name").textContent, ""); assert.equal(f.$("authenticated-shell").hidden, true);
  await f.controller.login(f.username, f.password);
  assert.equal(f.$("binding-review").hidden, false); assert.equal(f.$("accept-binding").disabled, true);
  assert.match(f.$("binding-candidate").textContent, /Blake Synthetic/);
  f.$("binding-acknowledgement").checked = true; await f.$("binding-acknowledgement").fire("change");
  await f.$("accept-binding").fire("click"); await f.flush();
  assert.equal(f.controller.view.status, "authenticated"); assert.equal(f.$("candidate-name").textContent, "Candidate: Blake Synthetic");
  assert.equal(f.storage.local.data[ENROLLMENT_KEYS.installation].bindingRevision, 2);
});

test("revoked installation keeps its credential and displays actionable locked recovery", async t => {
  const f = screen(t, { paired: true }); await login(f); f.revoked = true; await f.controller.boot();
  assert.equal(f.controller.view.status, "installation-revoked"); assert.equal(f.$("authenticated-shell").hidden, true);
  assert.ok(f.storage.local.data[ENROLLMENT_KEYS.installation]); assert.equal(f.created, 0);
});

test("backend restart shows sign in and preserves pairing without retrying login", async t => {
  const f = screen(t, { paired: true }); await login(f); f.sessions.clear();
  const count = f.calls.filter(call => call.url.endsWith("/login")).length;
  await f.controller.boot(); assert.equal(f.controller.view.status, "session-expired");
  assert.equal(f.$("login").hidden, false); assert.ok(f.storage.local.data[ENROLLMENT_KEYS.installation]);
  assert.equal(f.calls.filter(call => call.url.endsWith("/login")).length, count);
});

test("another page signing out clears candidate DOM immediately", async t => {
  const f = screen(t, { paired: true }); await login(f);
  await f.makeAuth().logout(); await f.flush();
  assert.equal(f.$("candidate-name").textContent, ""); assert.equal(f.$("authenticated-shell").hidden, true);
});

test("only the Keep signed in click calls activity", async t => {
  const f = screen(t, { paired: true }); await login(f); f.now += 100000;
  await f.$("keep-signed-in").fire("click"); await f.flush();
  assert.equal(f.controller.view.status, "authenticated");
  assert.equal(f.calls.filter(call => call.url.endsWith("/activity")).length, 1);
});

test("rate-limited sign in is disabled until the displayed retry interval passes", async t => {
  const f = screen(t, { paired: true }); await f.flush();
  f.intercept = url => url.endsWith("/login") ? Promise.resolve(f.reply(429, { code: "rate-limited" })) : null;
  await f.controller.login(f.username, f.password);
  assert.equal(f.$("sign-in").disabled, true); assert.match(f.$("login-retry").textContent, /7 seconds/);
  const tick = [...f.timers.values()].find(timer => timer.delay === 1000); f.now += 7000; tick.callback();
  assert.equal(f.$("sign-in").disabled, false);
});

test("late login response cannot reopen the shell after local Sign Out", async t => {
  const f = screen(t, { paired: true }); await f.flush(); let release;
  f.intercept = url => url.endsWith("/login") ? new Promise(resolve => { release = () => resolve(f.reply(200, { sessionToken: "A".repeat(43), ...f.metadata() })); }) : null;
  const pending = f.controller.login(f.username, f.password); await f.flush();
  await f.controller.signOut(); release(); await pending;
  assert.equal(f.controller.view.status, "signed-out"); assert.equal(f.$("authenticated-shell").hidden, true);
});

test("timer cleanup failure cannot restore protected candidate content", async t => {
  const f = screen(t, { paired: true }); await login(f);
  f.controller.clearTimer = function () { assert.equal(this, globalThis); throw TypeError("Illegal invocation"); };
  await f.controller.boot();
  assert.equal(f.controller.view.status, "client-error"); assert.equal(f.$("candidate-name").textContent, "");
  assert.equal(f.storage.session.data[AUTH_KEYS.session], undefined);
  f.controller.clearTimer = f.clearTimer;
});

test("setup, corrupt service and identity mismatch are distinct from disconnection", async t => {
  const f = screen(t); await f.flush();
  Object.assign(f.bootstrap, { state: "setup-required", backendId: null, workspaceId: null, requestToken: null });
  await f.controller.boot(); assert.equal(f.controller.view.status, "setup-required");
  f.bootstrap.state = "unavailable"; await f.controller.boot(); assert.equal(f.controller.view.status, "authentication-unavailable");
  const g = fixture({ paired: true }); g.bootstrap.backendId = "f".repeat(32);
  const controller = new WorkspaceController({ auth: g.auth, setTimer: g.setTimer, clearTimer: g.clearTimer });
  t.after(() => controller.dispose()); await controller.boot();
  assert.equal(controller.view.status, "identity-mismatch"); assert.equal(controller.view.backend, "unknown");
});

test("expired server claim and persisted credential cleanup have explicit recovery", async t => {
  const f = screen(t); await pair(f); f.expiredClaim = true;
  await f.controller.claimPairing(); assert.match(f.controller.view.error, /expired/);
  await f.controller.clearPending(true); await f.controller.requestPairing("Second synthetic request");
  f.expiredClaim = false; f.approved = true; f.storage.session.failRemove = ENROLLMENT_KEYS.pending;
  await f.controller.claimPairing();
  assert.match(f.controller.view.error, /credential was stored/); assert.equal(f.$("finish-cleanup").hidden, false);
  f.storage.session.failRemove = null; await f.controller.clearPending();
  assert.equal(f.controller.view.status, "signed-out"); assert.ok(f.storage.local.data[ENROLLMENT_KEYS.installation]);
});

test("pairing rate limit stays in pairing UI and disables repeated requests", async t => {
  const f = screen(t); await f.flush(); await f.controller.confirmBackend();
  f.intercept = url => url.endsWith("/pairings") ? Promise.resolve(f.reply(429, { code: "rate-limited" })) : null;
  await f.controller.requestPairing("Synthetic label");
  assert.equal(f.controller.view.status, "recovery-required"); assert.match(f.controller.view.error, /pairing requests/);
  assert.equal(f.$("clear-local-request").hidden, false);
  await f.controller.clearPending();
  assert.equal(f.controller.view.status, "unpaired");
  assert.equal(f.$("request-pairing").disabled, true); assert.equal(f.created, 0);
});

test("hung bootstrap gets bounded disconnected feedback with no pairing side effects", async t => {
  const f = fixture();
  f.intercept = (url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(Error("Synthetic timeout")));
  });
  const controller = new WorkspaceController({ auth: f.auth, setTimer: f.setTimer, clearTimer: f.clearTimer });
  t.after(() => controller.dispose());
  const pending = controller.boot(); await f.flush();
  [...f.timers.values()].find(timer => timer.delay === 12000).callback(); await pending;
  assert.equal(controller.view.status, "disconnected"); assert.equal(controller.view.busy, false); assert.equal(f.created, 0);
});

test("refresh after a stored claim with failed cleanup offers cleanup only", async t => {
  const f = screen(t, { paired: true }); await f.flush();
  f.storage.local.data[ENROLLMENT_KEYS.recovery] = { schemaVersion: 1, backendId: f.bootstrap.backendId,
    workspaceId: f.bootstrap.workspaceId, pairingId: "e".repeat(32) };
  await f.controller.boot();
  assert.equal(f.controller.view.status, "recovery-required");
  assert.equal(f.$("login").hidden, true); assert.equal(f.$("authenticated-shell").hidden, true);
  assert.equal(f.$("finish-cleanup").hidden, false); assert.equal(f.$("pending-recovery").hidden, true);
});
