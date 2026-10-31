// Synthetic Chrome storage and HTTP contracts. Not real Chrome networking.
import assert from "node:assert/strict";
import { randomBytes, webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { EnrollmentClient, BACKEND, ENROLLMENT_KEYS } from "../extension/studio/enrollment.mjs";
import { ExtensionAuthClient } from "../extension/studio/auth.mjs";
import { WorkspaceEditor } from "../extension/studio/workspace-editor.mjs";
import { createDataContracts } from "../extension/shared/data-contracts.mjs";

export const secret = () => randomBytes(32).toString("base64url");
export const html = await readFile(new URL("../extension/workspace.html", import.meta.url), "utf8");
export const contracts = createDataContracts(JSON.parse(await readFile(new URL("../extension/shared/data-contracts-v1.json", import.meta.url), "utf8")));
export function fixture({ paired = false } = {}) {
  const f = { calls: [], levels: [], now: Date.parse("2026-10-31T12:00:00Z"), offline: false, approved: false,
    denied: false, revoked: false, expiredClaim: false, bindingRevision: 1, candidateId: "candidate-one",
    created: 0, claims: 0, username: "synthetic-owner", password: "Synthetic password only 123!",
    token: null, sessions: new Map(), timers: new Map(), timerId: 0, synchronousFailure: false };
  const callbacks = new Set();
  const onChanged = {
    addListener(callback) { assert.equal(this, onChanged); callbacks.add(callback); },
    removeListener(callback) { assert.equal(this, onChanged); callbacks.delete(callback); }
  };
  const notify = (changes, area) => queueMicrotask(() => { for (const callback of callbacks) callback(changes, area); });
  function area(name) {
    const value = { data: {}, restricted: false, failSet: null, failRead: false, failRemove: null,
      async setAccessLevel(options) { assert.equal(this, value); assert.equal(options.accessLevel, "TRUSTED_CONTEXTS"); if (this.failAccess) throw Error("Synthetic storage restriction failure"); this.restricted = true; f.levels.push(name); },
      async get(key) { assert.equal(this, value); assert.ok(this.restricted); if (this.failRead) throw Error("Synthetic read failure"); return Object.hasOwn(this.data, key) ? { [key]: structuredClone(this.data[key]) } : {}; },
      async set(items) {
        assert.equal(this, value); assert.ok(this.restricted);
        if (Object.keys(items).includes(this.failSet)) throw Error("Synthetic storage write failure");
        const changes = {};
        for (const [key, item] of Object.entries(items)) { changes[key] = { oldValue: this.data[key], newValue: structuredClone(item) }; this.data[key] = structuredClone(item); }
        notify(changes, name);
      },
      async remove(key) { assert.equal(this, value); assert.ok(this.restricted); if (key === this.failRemove) throw Error("Synthetic remove failure"); const oldValue = this.data[key]; delete this.data[key]; notify({ [key]: { oldValue } }, name); }
    };
    return value;
  }
  f.storage = { local: area("local"), session: area("session"), onChanged };
  const tails = new Map();
  f.locks = { request(name, options, callback) {
    assert.equal(this, f.locks); assert.equal(options.mode, "exclusive");
    const result = (tails.get(name) || Promise.resolve()).then(callback);
    tails.set(name, result.catch(() => {})); return result;
  } };
  f.setTimer = function (callback, delay) { assert.equal(this, globalThis); if (f.timerFailure) throw TypeError("Illegal invocation"); const id = ++f.timerId; f.timers.set(id, { callback, delay }); return id; };
  f.clearTimer = function (id) { assert.equal(this, globalThis); if (f.clearFailure) throw TypeError("Illegal invocation"); f.timers.delete(id); };
  f.bootstrap = { protocolVersion: 1, state: "ready", backendId: "b".repeat(32), workspaceId: "workspace-one", requestToken: secret() };
  f.installation = { schemaVersion: 1, installationId: "c".repeat(32), bindingId: "c".repeat(32), installationCredential: secret(),
    bindingRevision: 1, backendId: f.bootstrap.backendId, workspaceId: f.bootstrap.workspaceId };
  if (paired) {
    f.storage.local.data[ENROLLMENT_KEYS.identity] = { schemaVersion: 1, backendId: f.bootstrap.backendId, workspaceId: f.bootstrap.workspaceId };
    f.storage.local.data[ENROLLMENT_KEYS.installation] = structuredClone(f.installation);
  }
  f.reply = (status, data) => {
    const headers = { get(name) { assert.equal(this, headers); return name === "Retry-After" ? "7" : null; } };
    return { status, ok: status >= 200 && status < 300, headers, async json() { return structuredClone(data); } };
  };
  f.metadata = () => ({ authenticated: true,
    user: { id: "d".repeat(32), username: f.username, role: "owner" },
    context: { backendId: f.bootstrap.backendId, workspaceId: f.bootstrap.workspaceId,
      installationId: f.installation.installationId, bindingId: f.installation.bindingId, bindingRevision: f.bindingRevision,
      extensionOrigin: "chrome-extension://" + "a".repeat(32), candidate: { id: f.candidateId, name: f.candidateId === "candidate-one" ? "Alex Synthetic" : "Blake Synthetic" } },
    session: { audience: "extension", idleRemainingSeconds: 1800, absoluteRemainingSeconds: 28800 } });
  f.fetcher = function (url, options) {
    assert.equal(this, globalThis); assert.equal(url.startsWith(BACKEND + "/api/extension/"), true);
    assert.equal(options.credentials, "omit"); assert.equal(options.redirect, "error"); assert.equal(options.mode, "cors"); assert.equal(options.cache, "no-store");
    assert.equal("Origin" in options.headers, false); assert.equal("Cookie" in options.headers, false);
    f.calls.push({ url, options });
    if (f.synchronousFailure) throw TypeError("Illegal invocation");
    if (f.offline) return Promise.reject(Error("Synthetic network failure"));
    if (f.intercept) { const result = f.intercept(url, options); if (result) return result; }
    if (url.endsWith("/bootstrap")) return Promise.resolve(f.reply(200, f.bootstrap));
    if (url.includes("/auth/")) {
      const headers = options.headers;
      assert.equal(headers["X-Tracker-Installation-Id"], f.installation.installationId);
      assert.equal(headers["X-Tracker-Installation-Credential"], f.installation.installationCredential);
      if (options.method === "POST") assert.equal(headers["X-Tracker-Token"], f.bootstrap.requestToken);
      else assert.equal("X-Tracker-Token" in headers, false);
      if (f.revoked) return Promise.resolve(f.reply(403, { code: "installation-unavailable" }));
      if (url.endsWith("/login")) {
        assert.equal("Authorization" in headers, false);
        const data = JSON.parse(options.body);
        if (data.username !== f.username || data.password !== f.password) return Promise.resolve(f.reply(401, { code: "invalid-credentials" }));
        f.sessions.clear(); f.token = secret();
        f.sessions.set(f.token, { revision: f.bindingRevision, created: f.now, last: f.now });
        return Promise.resolve(f.reply(200, { sessionToken: f.token, ...f.metadata() }));
      }
      const token = headers.Authorization?.slice(7), record = f.sessions.get(token);
      if (!record || f.now >= record.last + 1800000 || f.now >= record.created + 28800000) return Promise.resolve(f.reply(401, { code: "authentication-required" }));
      if (url.endsWith("/logout")) { f.sessions.delete(token); return Promise.resolve(f.reply(200, { authenticated: false })); }
      if (record.revision !== f.bindingRevision) return Promise.resolve(f.reply(409, { code: "binding-changed" }));
      if (url.endsWith("/activity")) record.last = f.now;
      const metadata = f.metadata();
      metadata.session.idleRemainingSeconds = Math.ceil((record.last + 1800000 - f.now) / 1000);
      metadata.session.absoluteRemainingSeconds = Math.ceil((record.created + 28800000 - f.now) / 1000);
      return Promise.resolve(f.reply(200, metadata));
    }
    assert.equal(options.headers["X-Tracker-Token"], f.bootstrap.requestToken);
    if (url.endsWith("/pairings")) { f.created++; return Promise.resolve(f.reply(201, { pairingId: "e".repeat(32), approvalCode: "ABCD-2345", status: "pending", expiresAt: new Date(f.now + 300000).toISOString() })); }
    f.claims++;
    if (f.dropClaim) return Promise.reject(Error("Synthetic claim lost"));
    if (f.denied) return Promise.resolve(f.reply(409, { code: "pairing-consumed" }));
    if (f.expiredClaim) return Promise.resolve(f.reply(410, { code: "pairing-expired" }));
    if (!f.approved) return Promise.resolve(f.reply(202, { status: "pending" }));
    const { schemaVersion, ...installation } = f.installation;
    return Promise.resolve(f.reply(200, installation));
  };
  f.enrollment = new EnrollmentClient({ storage: f.storage, locks: f.locks, fetcher: f.fetcher,
    runtime: { id: "a".repeat(32) }, location: { protocol: "chrome-extension:", hostname: "a".repeat(32) },
    crypto: webcrypto, encode: btoa, now: () => f.now, setTimer: f.setTimer, clearTimer: f.clearTimer });
  f.makeAuth = options => new ExtensionAuthClient({ enrollment: f.enrollment, fetcher: f.fetcher,
    now: () => f.now, setTimer: f.setTimer, clearTimer: f.clearTimer, ...options });
  f.auth = f.makeAuth();
  f.copies = [];
  f.clipboard = { async writeText(text) { assert.equal(this, f.clipboard); if (f.copyDenied) throw Error("Synthetic clipboard denial");
    f.copies.push(text); if (f.copyGate) await f.copyGate; }, readText() { throw Error("Clipboard reading is prohibited"); } };
  f.editor = new WorkspaceEditor({ contracts, clipboard: f.clipboard });
  f.flush = () => new Promise(resolve => setImmediate(resolve));
  return f;
}

export function domFixture() {
  const ids = new Map();
  const document = { visibilityState: "visible", listeners: {}, getElementById(id) { assert.ok(ids.has(id), `Missing ${id}`); return ids.get(id); },
    querySelectorAll(selector) { assert.equal(selector, "button"); return [...ids.values()].filter(node => node.tagName === "button"); },
    addEventListener(type, callback) { (this.listeners[type] ??= []).push(callback); } };
  for (const match of html.matchAll(/<([a-z]+)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const [source, tag, id] = match;
    const node = { id, tagName: tag, hidden: /\bhidden\b/.test(source), disabled: /\bdisabled\b/.test(source), value: "", checked: false, dataset: {}, attributes: {}, listeners: {}, textContent: "",
      setAttribute(key, value) { this.attributes[key] = value; },
      addEventListener(type, callback) { (this.listeners[type] ??= []).push(callback); },
      focus() { document.activeElement = this; },
      async fire(type, extra = {}) { const event = { currentTarget: this, target: this, preventDefault() { this.defaultPrevented = true; }, ...extra }; for (const callback of this.listeners[type] || []) await callback(event); return event; } };
    ids.set(id, node);
  }
  const window = { listeners: {}, addEventListener(type, callback) { (this.listeners[type] ??= []).push(callback); } };
  return { document, window, ids, $: id => document.getElementById(id) };
}
