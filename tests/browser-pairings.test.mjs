import test from "node:test";
import assert from "node:assert/strict";
import { initializeBrowserPairings } from "../manager/ui/extension-studio.mjs";

class Node {
  constructor(tag, document) { this.tagName = tag; this.document = document; this.children = []; this.listeners = {}; this.dataset = {}; this.value = ""; this.checked = false; this.textContent = ""; }
  set id(value) { this._id = value; this.document.ids.set(value, this); }
  get id() { return this._id; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(key, value) { this[key] = value; }
  addEventListener(type, callback) { (this.listeners[type] ??= []).push(callback); }
  async fire(type) { for (const callback of this.listeners[type] || []) await callback({ target: this }); }
  querySelectorAll(selector) {
    const tags = selector.split(",");
    return this.children.flatMap(child => [...(tags.includes(child.tagName) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
}

function fixture(t) {
  const original = { document: globalThis.document, window: globalThis.window };
  t.after(() => Object.assign(globalThis, original));
  const document = { ids: new Map(), createElement(tag) { return new Node(tag, this); }, getElementById(id) { assert.ok(this.ids.has(id), `Missing ${id}`); return this.ids.get(id); } };
  for (const id of ["pairing-refresh", "pairing-notice", "pairing-requests", "pairing-installations"]) { const node = document.createElement("div"); node.id = id; }
  let confirm = true, failure = null, gate = null, authorizations = 0;
  globalThis.document = document; globalThis.window = { confirm: () => confirm };
  const state = { workspaceId: "workspace", backendId: "backend", candidates: [{ id: "one", name: "Alex Synthetic" }, { id: "two", name: "Blake Synthetic" }],
    requests: [{ id: "request-one", label: "Browser A", extensionOrigin: "chrome-extension://" + "a".repeat(32), approvalCode: "ABCD-2345", state: "pending", revision: 1, expiresAt: "2026-01-01T00:05:00Z", candidateId: null }],
    installations: [{ id: "install-one", pairingId: "request-recorded", label: "Browser B", extensionOrigin: "chrome-extension://" + "a".repeat(32), candidateId: "one", candidateName: "Alex Synthetic", usable: true, revoked: false, bindingRevision: 1 }] };
  const calls = [];
  const api = async (path, options = {}) => {
    calls.push({ path, ...structuredClone(options) });
    if (gate) await gate;
    if (failure) throw failure;
    if (!options.method) return structuredClone(state);
    if (path.endsWith("/approve")) { state.requests[0].state = "approved"; state.requests[0].candidateId = options.body.candidateId; state.requests[0].revision++; }
    else if (path.endsWith("/deny")) state.requests = [];
    else if (path.endsWith("/binding")) { state.installations[0].candidateId = options.body.candidateId; state.installations[0].bindingRevision++; }
    else if (path.endsWith("/revoke")) { state.installations[0].revoked = true; state.installations[0].usable = false; state.installations[0].bindingRevision++; }
    return {};
  };
  const ui = initializeBrowserPairings({ api, authorize: async action => { authorizations++; return action(); } });
  return { ui, state, calls, $: id => document.getElementById(id), writes: () => calls.filter(call => call.method),
    setConfirm(value) { confirm = value; }, setFailure(value) { failure = value; }, setGate(value) { gate = value; }, authorizations: () => authorizations };
}

test("pairing management starts locked and only explicit load reads owner data", async t => {
  const f = fixture(t); assert.equal(f.calls.length, 0); assert.equal(f.$("pairing-refresh").disabled, true);
  await f.ui.load(); assert.equal(f.calls.length, 1); assert.equal(f.writes().length, 0);
  assert.equal(f.$("pairing-candidate-request-one").value, "");
  assert.equal(f.$("pairing-approve-request-one").disabled, true);
  assert.equal(f.$("pairing-requests").children[0].children[1].textContent, "ABCD-2345");
  assert.match(f.$("pairing-installations").children[0].children[2].textContent, /request-recorded/);
});

test("approval requires code verification and an explicit authorized candidate choice", async t => {
  const f = fixture(t); await f.ui.load();
  await f.$("pairing-approve-request-one").fire("click"); assert.equal(f.writes().length, 0);
  f.$("pairing-candidate-request-one").value = "two"; await f.$("pairing-candidate-request-one").fire("change");
  assert.equal(f.$("pairing-approve-request-one").disabled, true);
  f.$("pairing-verified-request-one").checked = true; await f.$("pairing-verified-request-one").fire("change");
  assert.equal(f.$("pairing-approve-request-one").disabled, false);
  await f.$("pairing-approve-request-one").fire("click");
  assert.deepEqual(f.writes()[0], { path: "/api/studio/extension/pairings/request-one/approve", method: "POST", body: { candidateId: "two", revision: 1 } });
  assert.equal(f.authorizations(), 1); assert.match(f.$("pairing-notice").textContent, /Saved/);
  assert.equal(f.calls.some(call => call.path === "/api/active"), false);
});

test("denial and candidate reassignment require confirmation and never change active candidate", async t => {
  const f = fixture(t); await f.ui.load(); f.setConfirm(false);
  await f.$("pairing-deny-request-one").fire("click"); assert.equal(f.writes().length, 0);
  f.setConfirm(true); await f.$("pairing-deny-request-one").fire("click");
  assert.equal(f.writes()[0].path.endsWith("/deny"), true);
  assert.equal(f.$("pairing-save-install-one").disabled, true);
  f.$("pairing-candidate-install-one").value = "two"; await f.$("pairing-candidate-install-one").fire("change");
  assert.equal(f.$("pairing-save-install-one").disabled, false);
  await f.$("pairing-save-install-one").fire("click");
  assert.deepEqual(f.writes()[1].body, { candidateId: "two", revision: 1 });
  assert.equal(f.$("pairing-save-install-one").disabled, true);
  assert.equal(f.calls.some(call => /active|candidates\//.test(call.path)), false);
});

test("revoked installations disable reassignment and revocation while preserving other records", async t => {
  const f = fixture(t); await f.ui.load(); await f.$("pairing-revoke-install-one").fire("click");
  assert.deepEqual(f.writes()[0].body, { revision: 1 });
  assert.equal(f.$("pairing-candidate-install-one").disabled, true);
  assert.equal(f.$("pairing-revoke-install-one").disabled, true);
  assert.equal(f.$("pairing-approve-request-one").disabled, true);
});

test("loading and empty states never invent connected browsers or perform writes", async t => {
  const f = fixture(t); let release; f.setGate(new Promise(resolve => { release = resolve; }));
  const loading = f.ui.load(); assert.match(f.$("pairing-notice").textContent, /Loading/);
  assert.equal(f.$("pairing-refresh").disabled, true); f.state.requests = []; f.state.installations = [];
  release(); await loading; assert.match(f.$("pairing-requests").children[0].textContent, /No pending/);
  assert.match(f.$("pairing-installations").children[0].textContent, /No approved/);
  assert.equal(f.writes().length, 0);
});

test("storage/setup errors remain visible and explicit refresh can recover", async t => {
  const f = fixture(t); f.setFailure(new Error("Save local device settings first")); await f.ui.load();
  assert.match(f.$("pairing-notice").textContent, /Pairings unavailable.*device settings/);
  assert.equal(f.$("pairing-requests").children.length, 0);
  f.setFailure(null); await f.$("pairing-refresh").fire("click");
  assert.equal(f.$("pairing-installations").children.length, 1); assert.equal(f.writes().length, 0);
});

test("revision errors retain safe current rows and do not automatically replay writes", async t => {
  const f = fixture(t); await f.ui.load(); f.setFailure(new Error("Revision conflict"));
  await f.$("pairing-revoke-install-one").fire("click");
  assert.equal(f.writes().length, 1); assert.match(f.$("pairing-notice").textContent, /Revision conflict.*not replayed/);
  assert.equal(f.$("pairing-installations").children.length, 1);
});

test("suspension clears rows and late asynchronous responses cannot restore protected content", async t => {
  const f = fixture(t); let release; f.setGate(new Promise(resolve => { release = resolve; }));
  const loading = f.ui.load(); f.ui.suspend(); release(); await loading;
  assert.equal(f.$("pairing-requests").children.length, 0); assert.equal(f.$("pairing-installations").children.length, 0);
  assert.equal(f.$("pairing-refresh").disabled, true); assert.match(f.$("pairing-notice").textContent, /Sign in/);
});

test("double submissions are blocked while authorization or a write is pending", async t => {
  const f = fixture(t); await f.ui.load(); let release; f.setGate(new Promise(resolve => { release = resolve; }));
  const first = f.$("pairing-revoke-install-one").fire("click");
  await f.$("pairing-revoke-install-one").fire("click");
  release(); await first; assert.equal(f.writes().length, 1);
});

test("browser labels are passed as plain text without HTML execution", async t => {
  const f = fixture(t); f.state.requests[0].label = '<img src=x onerror="throw 1">'; await f.ui.load();
  assert.equal(f.$("pairing-requests").children[0].children[0].textContent, f.state.requests[0].label);
});
