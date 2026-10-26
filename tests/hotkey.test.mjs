// Execute the actual background listeners and injected extraction/clipboard code.
// Chrome/native calls and the page DOM are synthetic; no browser or disk writes.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../extension/background.js", import.meta.url), "utf8");
const manifest = JSON.parse(await readFile(new URL("../extension/manifest.json", import.meta.url), "utf8"));
const tab = { id: 42, url: "https://example.test/jobs/123?source=test#details", title: "Synthetic job page" };

function fixture(options = {}) {
  const listeners = {}, clipboard = [], notices = [], nativeCalls = [], storageReads = [], timers = new Set();
  const effects = { mhtml: 0, storageWrites: 0, fallback: 0, removed: 0, extractionTargets: [] };
  const candidateName = options.candidateName ?? "Alex Example";
  const selected = options.selected ?? "Example Company";
  const jd = options.jd ?? "Original synthetic JD.\nNo generated prompt instructions.";
  let selectedTextarea;
  class Input {}
  class Textarea extends Input {}
  class Iframe {}
  class Frame {}
  const page = vm.createContext({
    HTMLInputElement: Input, HTMLTextAreaElement: Textarea, HTMLIFrameElement: Iframe, HTMLFrameElement: Frame,
    window: { getSelection: () => ({ toString: () => selected }) },
    navigator: { clipboard: { async writeText(text) {
      if (options.clipboardDenied) throw new Error("Clipboard permission denied");
      clipboard.push(text);
    } } },
    document: {
      activeElement: options.inputSelection ? Object.assign(new Textarea(), {
        value: "before Selected Company after", selectionStart: 7, selectionEnd: 23
      }) : {},
      hasFocus: () => true,
      querySelectorAll(selector) {
        assert.equal(selector, "div[id^='overview' i], div#company, article");
        return jd ? [{ id: "overview-test", cloneNode: () => ({ textContent: jd, querySelectorAll: () => [] }) }] : [];
      },
      body: { appendChild() {} },
      createElement(tag) {
        assert.equal(tag, "textarea");
        return { style: {}, select() { selectedTextarea = this; }, remove() { effects.removed++; } };
      },
      execCommand(command) {
        assert.equal(command, "copy"); effects.fallback++;
        if (!options.fallbackAllowed) return false;
        clipboard.push(selectedTextarea.value); return true;
      }
    }
  });
  const chrome = {
    contextMenus: { onClicked: { addListener(fn) { listeners.menu = fn; } }, removeAll() {}, create() {} },
    commands: { onCommand: { addListener(fn) { listeners.command = fn; } } },
    tabs: { async query(query) { assert.deepEqual({ ...query }, { active: true, lastFocusedWindow: true }); return [options.tab ?? tab]; } },
    storage: { local: {
      async get(key) { storageReads.push(key); if (options.storageDenied) throw new Error("Settings unavailable"); return { candidateName }; },
      async set() { effects.storageWrites++; throw new Error("Storage writes forbidden"); }
    } },
    pageCapture: { async saveAsMHTML(request) {
      effects.mhtml++; assert.equal(options.legacy, true, "Hotkey must never generate MHTML");
      assert.equal(request.tabId, tab.id); return new Blob(["Synthetic MHTML"]);
    } },
    runtime: {
      onInstalled: { addListener(fn) { listeners.installed = fn; } },
      async sendNativeMessage(host, message) {
        nativeCalls.push(JSON.parse(JSON.stringify(message)));
        assert.equal(host, "com.kevin.candidate_host");
        if (message.action === "save_application") {
          assert.equal(options.legacy, true, "Hotkey must never invoke save_application");
          return { ok: true, finalPrompt: "Legacy generated prompt", folderPath: "Synthetic history" };
        }
        assert.equal(message.action, "check_company", "Only read-only lookup is permitted");
        if (options.lookup) return options.lookup(message);
        if (options.nativeDenied) throw new Error("Native host unavailable");
        return options.lookupResponse ?? { ok: true, exists: Boolean(options.saved), folderPath: options.saved ? "Synthetic history/Example Company" : null };
      }
    },
    scripting: { async executeScript(request) {
      if (request.args?.length === 2) {
        notices.push({ text: request.args[0], type: request.args[1] }); return [{ result: undefined }];
      }
      if (request.func.name === "extract") {
        effects.extractionTargets.push({ ...request.target });
        if (options.extractionDenied || options.mainFrameOnly && request.target.allFrames) throw new Error("Frame access denied");
      }
      page.args = request.args ?? [];
      return [{ result: await vm.runInContext(`(${request.func.toString()})(...args)`, page) }];
    } }
  };
  vm.runInNewContext(source, {
    chrome, Blob, Uint8Array, console: { error() {}, warn() {} },
    importScripts(name) { assert.equal(name, "integration-diagnostics.js"); },
    btoa: text => Buffer.from(text, "binary").toString("base64"),
    setTimeout(callback, delay) { const timer = { callback, delay }; timers.add(timer); return timer; },
    clearTimeout(timer) { timers.delete(timer); }
  });
  return {
    clipboard, notices, nativeCalls, storageReads, effects,
    run: () => listeners.command("check-selected-company"),
    command: name => listeners.command(name),
    menu: () => listeners.menu({ menuItemId: "check-save-candidate-company", selectionText: selected }, tab),
    expireLookup() { for (const timer of [...timers]) { assert.equal(timer.delay, 2000); timer.callback(); } },
    assertReadOnly() {
      assert.equal(effects.mhtml, 0); assert.equal(effects.storageWrites, 0);
      assert.ok(nativeCalls.every(message => message.action === "check_company"));
      for (const message of nativeCalls) assert.deepEqual(Object.keys(message).sort(), ["action", "candidateName", "companyName"]);
    }
  };
}

const expected = (company, jd = "Overview:\nOriginal synthetic JD.\nNo generated prompt instructions.", url = tab.url) =>
  `${company ? `Company: ${company}\n\n` : ""}Job URL: ${url}\n\nJob Description:\n${jd}`;

test("command ID and binding are preserved, with a clipboard-only description", () => {
  assert.equal(manifest.commands["check-selected-company"].suggested_key.default, "Ctrl+Shift+F");
  assert.match(manifest.commands["check-selected-company"].description, /Copy/);
  assert.doesNotMatch(manifest.commands["check-selected-company"].description, /save/i);
});

test("selected unsaved company copies Company, current URL and extracted JD without saving", async () => {
  const f = fixture({ selected: "  Example\u00a0 Company  " }); await f.run();
  assert.deepEqual(f.clipboard, [expected("Example Company")]);
  assert.deepEqual(f.nativeCalls, [{ action: "check_company", candidateName: "Alex Example", companyName: "Example Company" }]);
  assert.equal(f.notices.at(-1).type, "success"); assert.match(f.notices.at(-1).text, /Copied Company, JD and URL/);
  f.assertReadOnly();
});

test("already-saved status retains duplicate feedback and never prevents copying", async () => {
  const f = fixture({ saved: true }); await f.run(); assert.deepEqual(f.clipboard, [expected("Example Company")]);
  assert.match(f.notices.at(-1).text, /Already saved:\nSynthetic history\/Example Company\nCopied/); f.assertReadOnly();
});

test("native lookup rejection still copies and reports unknown saved status", async () => {
  const f = fixture({ nativeDenied: true }); await f.run(); assert.deepEqual(f.clipboard, [expected("Example Company")]);
  assert.match(f.notices.at(-1).text, /Saved status unavailable: Native host unavailable/); f.assertReadOnly();
});

test("native lookup errors and malformed responses never become an unsaved or saved claim", async () => {
  for (const lookupResponse of [{ ok: false, error: "This candidate is not active." }, { ok: true }, { ok: true, exists: "false" }, null]) {
    const f = fixture({ lookup: async () => lookupResponse }); await f.run();
    assert.equal(f.clipboard.length, 1); assert.match(f.notices.at(-1).text, /Saved status unavailable/);
    assert.doesNotMatch(f.notices.at(-1).text, /Already saved/); f.assertReadOnly();
  }
});

test("copy finishes while duplicate lookup is pending, with bounded status recovery", async () => {
  const f = fixture({ lookup: () => new Promise(() => {}) }); const pending = f.run();
  await new Promise(setImmediate);
  assert.deepEqual(f.clipboard, [expected("Example Company")]); assert.match(f.notices.at(-1).text, /Checking saved-company status/);
  f.expireLookup(); await pending; assert.match(f.notices.at(-1).text, /Saved-company lookup timed out/); f.assertReadOnly();
});

test("missing legacy candidate name or inaccessible settings cannot block copying", async () => {
  for (const options of [{ candidateName: "" }, { storageDenied: true }]) {
    const f = fixture(options); await f.run(); assert.equal(f.clipboard.length, 1);
    assert.equal(f.nativeCalls.length, 0); assert.match(f.notices.at(-1).text, /Saved status unavailable/); f.assertReadOnly();
  }
});

test("no selection copies only JD and URL without reading candidate settings or calling native messaging", async () => {
  const f = fixture({ selected: " \n " }); await f.run(); assert.deepEqual(f.clipboard, [expected("")]);
  assert.deepEqual(f.nativeCalls, []); assert.deepEqual(f.storageReads, []);
  assert.equal(f.notices.at(-1).type, "success"); f.assertReadOnly();
});

test("text selected within an input uses the existing selection reader", async () => {
  const f = fixture({ selected: "", inputSelection: true }); await f.run();
  assert.deepEqual(f.clipboard, [expected("Selected Company")]); f.assertReadOnly();
});

test("missing JD leaves an empty JD field, copies available information and warns", async () => {
  for (const selected of ["Example Company", ""]) {
    const f = fixture({ selected, jd: "" }); await f.run(); assert.deepEqual(f.clipboard, [expected(selected, "")]);
    assert.match(f.notices.at(-1).text, /No matching.*JD text.*empty/);
    assert.match(f.notices.at(-1).text, /Copied available job information/); assert.equal(f.notices.at(-1).type, "info"); f.assertReadOnly();
  }
});

test("extraction failure copies the actual URL without fabricating JD", async () => {
  const f = fixture({ selected: "", extractionDenied: true }); await f.run(); assert.deepEqual(f.clipboard, [expected("", "")]);
  assert.match(f.notices.at(-1).text, /JD extraction failed/); assert.equal(f.nativeCalls.length, 0); f.assertReadOnly();
});

test("partial extraction and main-frame fallback retain the existing cap and report incompleteness", async () => {
  const f = fixture({ jd: "x".repeat(25000), mainFrameOnly: true }); await f.run();
  assert.deepEqual(f.clipboard, [expected("Example Company", "Overview:\n" + "x".repeat(20000))]);
  assert.deepEqual(f.effects.extractionTargets, [{ tabId: 42, allFrames: true }, { tabId: 42 }]);
  assert.match(f.notices.at(-1).text, /may be incomplete/); f.assertReadOnly();
});

test("clipboard fallback copies the same data and removes its temporary textarea", async () => {
  const f = fixture({ clipboardDenied: true, fallbackAllowed: true }); await f.run();
  assert.deepEqual(f.clipboard, [expected("Example Company")]); assert.equal(f.effects.fallback, 1); assert.equal(f.effects.removed, 1); f.assertReadOnly();
});

test("clipboard failure never claims success or falls back to saving in either mode", async () => {
  for (const selected of ["Example Company", ""]) {
    const f = fixture({ selected, saved: true, clipboardDenied: true }); await f.run();
    assert.deepEqual(f.clipboard, []); assert.equal(f.effects.removed, 1); assert.equal(f.notices.at(-1).type, "error");
    assert.match(f.notices.at(-1).text, /Clipboard copy failed/); assert.doesNotMatch(f.notices.at(-1).text, /Copied|Already saved/); f.assertReadOnly();
    await new Promise(setImmediate);
  }
});

test("the URL comes from the actual tab snapshot, not selected text or generated content", async () => {
  const url = "https://other.example.test/opening?job=456&source=chrome#apply";
  const f = fixture({ selected: "", tab: { ...tab, url } }); await f.run(); assert.deepEqual(f.clipboard, [expected("", undefined, url)]); f.assertReadOnly();
  const missing = fixture({ selected: "", tab: { id: 42 } }); await missing.run();
  assert.match(missing.notices.at(-1).text, /URL was unavailable/); assert.match(missing.clipboard[0], /^Job URL: \n/); missing.assertReadOnly();
});

test("unrelated commands do not extract, copy or look up a company", async () => {
  const f = fixture(); await f.command("unrelated"); assert.deepEqual(f.clipboard, []); assert.deepEqual(f.nativeCalls, []); f.assertReadOnly();
});

test("separate legacy context-menu save still generates MHTML, saves and copies its original prompt", async () => {
  const f = fixture({ legacy: true }); await f.menu();
  assert.equal(f.effects.mhtml, 1); assert.deepEqual(f.nativeCalls.map(call => call.action), ["check_company", "save_application"]);
  const message = f.nativeCalls[1]; assert.equal(message.jobUrl, tab.url); assert.match(message.jobDescription, /^Overview:/);
  assert.equal(Buffer.from(message.mhtmlBase64, "base64").toString(), "Synthetic MHTML");
  assert.deepEqual(f.clipboard, ["Legacy generated prompt"]); assert.match(f.notices.at(-1).text, /Saved MHTML and copied prompt/);
});

test("legacy context-menu duplicate handling remains separate and still stops its save", async () => {
  const f = fixture({ legacy: true, saved: true }); await f.menu();
  assert.deepEqual(f.nativeCalls.map(call => call.action), ["check_company"]); assert.deepEqual(f.clipboard, []);
  assert.equal(f.effects.mhtml, 0); assert.match(f.notices.at(-1).text, /Already saved/);
});
