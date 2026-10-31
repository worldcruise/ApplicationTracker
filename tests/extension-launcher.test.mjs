import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { openWorkspace } from "../extension/studio/launcher.mjs";
import { fixture } from "./extension-ui-fakes.mjs";

function launcher() {
  const f = fixture(), calls = [], tabs = new Map(); let next = 1;
  const url = "chrome-extension://" + "a".repeat(32) + "/workspace.html";
  const chrome = { storage: f.storage, extension: { inIncognitoContext: false } };
  chrome.runtime = {
    id: "a".repeat(32), getURL(path) { assert.equal(this, chrome.runtime); assert.equal(path, "workspace.html"); return url; },
    async getContexts(filter) { assert.equal(this, chrome.runtime); assert.deepEqual(filter, { contextTypes: ["TAB"], documentUrls: [url] });
      return [...tabs.values()].filter(tab => tab.loaded && tab.url === url).map(tab => ({ tabId: tab.id, windowId: tab.windowId })); }
  };
  chrome.tabs = {
    async create(options) { assert.equal(this, chrome.tabs); calls.push(["create", options]); const tab = { id: next++, windowId: 4, url: options.url, loaded: false }; tabs.set(tab.id, tab); return tab; },
    async get(id) { assert.equal(this, chrome.tabs); if (!tabs.has(id)) throw Error("Closed tab"); return tabs.get(id); },
    async update(id, options) { assert.equal(this, chrome.tabs); assert.ok(tabs.has(id)); calls.push(["focus-tab", id, options]); }
  };
  chrome.windows = { async update(id, options) { assert.equal(this, chrome.windows); calls.push(["focus-window", id, options]); } };
  const open = () => openWorkspace({ chrome, locks: f.locks, location: f.enrollment.location });
  return { ...f, chrome, calls, tabs, open, url };
}

test("launcher opens the packaged page without candidate/native/hotkey operations", async () => {
  const f = launcher(); const before = structuredClone(f.storage.local.data);
  assert.equal(await f.open(), 1);
  assert.deepEqual(f.calls, [["create", { url: f.url, active: true }]]);
  assert.deepEqual(f.storage.local.data, before);
});
test("launcher focuses an existing workspace and its window", async () => {
  const f = launcher(); await f.open(); f.tabs.get(1).loaded = true; await f.open();
  assert.equal(f.calls.filter(call => call[0] === "create").length, 1);
  assert.deepEqual(f.calls.at(-2), ["focus-tab", 1, { active: true }]);
  assert.deepEqual(f.calls.at(-1), ["focus-window", 4, { focused: true }]);
});
test("concurrent popup launchers reuse an opening tab before its context registers", async () => {
  const f = launcher(); assert.deepEqual(await Promise.all([f.open(), f.open()]), [1, 1]);
  assert.equal(f.calls.filter(call => call[0] === "create").length, 1);
});
test("closed or unrelated cached tabs are never focused as the workspace", async () => {
  const f = launcher(); await f.open(); f.tabs.get(1).url = "https://example.test";
  assert.equal(await f.open(), 2);
  f.tabs.delete(2); assert.equal(await f.open(), 3);
  assert.equal(f.calls.some(call => call[0] === "focus-tab" && call[1] === 1), false);
});
test("unverifiable opening tabs fail without creating duplicates", async () => {
  const f = launcher(); await f.open(); f.tabs.get(1).url = undefined;
  await assert.rejects(f.open(), /still opening/);
  assert.equal(f.calls.filter(call => call[0] === "create").length, 1);
});
test("Incognito and untrusted launcher contexts perform no storage or tab operation", async () => {
  const f = launcher(); f.chrome.extension.inIncognitoContext = true;
  await assert.rejects(f.open(), /ordinary Chrome/);
  assert.equal(f.calls.length, 0); assert.equal(f.levels.length, 0);
  f.chrome.extension.inIncognitoContext = false; f.enrollment.location.protocol = "https:";
  await assert.rejects(f.open(), /extension popup/);
});
test("missing APIs or storage restrictions fail safely without adding permissions", async () => {
  const f = launcher(); f.storage.session.failAccess = true;
  await assert.rejects(f.open()); assert.equal(f.calls.length, 0);
  const g = launcher(); g.chrome.runtime.getContexts = undefined;
  await assert.rejects(g.open(), /Chrome version/);
  const manifest = JSON.parse(await readFile(new URL("../extension/manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.permissions.includes("tabs"), false); assert.equal(manifest.action.default_popup, "popup.html");
});
test("legacy popup name remains independent and its original Save handler works", async () => {
  const source = await readFile(new URL("../extension/popup.js", import.meta.url), "utf8");
  const nodes = new Map(), writes = [];
  for (const id of ["candidate-form", "candidate-name", "status", "open-workspace", "launcher-status"])
    nodes.set(id, { value: "", listeners: {}, addEventListener(type, callback) { this.listeners[type] = callback; } });
  const chrome = { storage: { local: { async get(key) { assert.equal(key, "candidateName"); return { candidateName: "Legacy Synthetic" }; }, async set(value) { writes.push(value); } } } };
  new vm.Script(source).runInNewContext({ document: { getElementById: id => nodes.get(id) }, chrome });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(nodes.get("candidate-name").value, "Legacy Synthetic");
  nodes.get("candidate-name").value = " Other Synthetic ";
  await nodes.get("candidate-form").listeners.submit({ preventDefault() {} });
  assert.deepEqual(JSON.parse(JSON.stringify(writes)), [{ candidateName: "Other Synthetic" }]);
  const markup = await readFile(new URL("../extension/popup.html", import.meta.url), "utf8");
  assert.match(markup, /Legacy capture setup/); assert.match(markup, /Open Application Tracker/);
});
