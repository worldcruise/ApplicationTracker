import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { AccessError, normalizeReference, promptMappingKey, parseConfigurationJson, validateRegistry, nameKey } from "../extension/studio/contracts.mjs";
import { HandleStore, DATABASE_NAME, DATABASE_VERSION } from "../extension/studio/handles.mjs";
import { StudioAccess, loadConfiguration, readPromptFile, MAX_PROMPT_BYTES } from "../extension/studio/access.mjs";
import { FakeIndexedDB, candidate, configuration, directoryHandle, fileHandle, domError } from "./extension-fakes.mjs";

const code = expected => error => error instanceof AccessError && error.code === expected;
function setup(pickers = {}) {
  const database = new FakeIndexedDB(), store = new HandleStore(database);
  let scope = 0;
  return { database, store, access: new StudioAccess(store, pickers, () => `scope-${++scope}`) };
}
async function connected(directory = configuration()) {
  const state = setup({ showDirectoryPicker: async () => directory });
  await state.access.selectConfiguration(); return { ...state, directory };
}

test("normalizes drive/separator/dot aliases without merging distinct components or scopes", () => {
  assert.deepEqual(normalizeReference("c:\\Prompts\\.\\One\\..\\A.txt"), normalizeReference("C:/Prompts/A.txt"));
  assert.notEqual(promptMappingKey("one", "C:/Prompts/A.txt"), promptMappingKey("one", "C:/Prompts/a.txt"));
  assert.notEqual(promptMappingKey("one", "C:/Prompts/A.txt"), promptMappingKey("two", "C:/Prompts/A.txt"));
  assert.notEqual(promptMappingKey("one", "C:/a/b.txt"), promptMappingKey("one", "C:/a_b.txt"));
  assert.throws(() => normalizeReference("relative.txt"), code("configuration-invalid"));
  assert.throws(() => normalizeReference("C:/../a.txt"), code("configuration-invalid"));
  assert.deepEqual(normalizeReference("\\\\server\\share\\A.txt"), ["//server/share", "A.txt"]);
});
test("strict JSON parsing rejects duplicate escaped properties, malformed JSON, and overflow", () => {
  for (const source of ['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"a":1e400}', '{broken'])
    assert.throws(() => parseConfigurationJson(source, "fixture"), code("configuration-invalid"));
  assert.deepEqual(parseConfigurationJson('{"body":"{\\\"key\\\": 1}","nested":[{},true,null]}', "fixture"), { body: '{"key": 1}', nested: [{}, true, null] });
});
test("registry rejects malformed fields, unsupported versions and stale active references", () => {
  const good = { schemaVersion: 1, activeCandidateId: "candidate-one", candidates: [candidate()] };
  assert.equal(validateRegistry(good), good);
  for (const invalid of [null, {}, { ...good, schemaVersion: 2 }, { ...good, activeCandidateId: "missing" },
    { ...good, candidates: [candidate({ promptTemplate: "../outside.txt" })] },
    { ...good, candidates: [candidate({ extensionId: "q".repeat(32) })] }]) assert.throws(() => validateRegistry(invalid), code("configuration-invalid"));
  assert.equal(nameKey(" Straße Example "), nameKey("STRASSE EXAMPLE"));
  assert.notEqual(nameKey("ı"), nameKey("i"));
});
test("handle store upgrades once and saves direct handle objects across service instances", async () => {
  const { database, store } = setup(), directory = configuration();
  assert.equal(await store.getDirectory(), null);
  await store.saveDirectory(directory, "scope-one");
  const loaded = await new HandleStore(database).getDirectory();
  assert.equal(loaded.handle, directory); assert.equal(loaded.scope, "scope-one");
  assert.equal(database.openedName, DATABASE_NAME); assert.equal(database.openedVersion, DATABASE_VERSION);
  assert.equal(database.upgrades, 1);
});
test("prompt handle lookup, replacement, removal and configuration scopes stay separate", async () => {
  const { store } = setup(), first = fileHandle("one.md"), second = fileHandle("two.md");
  await store.savePrompt("one", "C:/Prompts/A.md", first);
  assert.equal((await store.getPrompt("one", "c:\\Prompts\\A.md")).handle, first);
  assert.equal(await store.getPrompt("two", "C:/Prompts/A.md"), null);
  await store.savePrompt("one", "C:/Prompts/A.md", second);
  assert.equal((await store.getPrompt("one", "C:/Prompts/A.md")).handle, second);
  await store.removePrompt("one", "C:/Prompts/A.md");
  assert.equal(await store.getPrompt("one", "C:/Prompts/A.md"), null);
});
test("transaction abort after request success preserves the previous durable handle", async () => {
  const { database, store } = setup(), original = configuration();
  await store.saveDirectory(original, "one");
  database.failNextTransaction = true;
  await assert.rejects(store.saveDirectory(configuration(), "two"), code("storage-failed"));
  assert.equal((await store.getDirectory()).handle, original);
});
test("storage open, blocked and transaction failures are reported", async () => {
  await assert.rejects(new HandleStore(null).getDirectory(), code("storage-unavailable"));
  for (const flag of ["openError", "throwOnOpen", "blocked"]) {
    const { database, store } = setup(); database[flag] = true;
    await assert.rejects(store.getDirectory(), code("storage-unavailable"));
  }
  const { database, store } = setup(); database.throwTransaction = true;
  await assert.rejects(store.getDirectory(), code("storage-failed"));
});
test("corrupted and incompatible stored-handle records require reselection", async () => {
  for (const record of [{}, { schemaVersion: 2 }, { schemaVersion: 1, kind: "directory", handle: {} }]) {
    const { database, store } = setup();
    database.records.set(JSON.stringify(["directory", "configuration"]), record);
    await assert.rejects(store.getDirectory(), code("stored-handle-invalid"));
  }
});
test("damaged scopes cannot substitute a handle from another configuration", async () => {
  const { database, store } = setup(), key = promptMappingKey("one", "C:/Prompts/A.md");
  database.records.set(key, { key, schemaVersion: 1, kind: "file", scope: "two", handle: fileHandle("A.md") });
  await assert.rejects(store.getPrompt("one", "C:/Prompts/A.md"), code("stored-handle-invalid"));
  database.records.set(key, { key, schemaVersion: 1, kind: "file", scope: "../escape", handle: fileHandle("A.md") });
  await assert.rejects(store.getPrompt("one", "C:/Prompts/A.md"), code("stored-handle-invalid"));
});
test("configuration selection requests readwrite and accepts a valid existing registry", async () => {
  const directory = configuration(); let options;
  const { access, store } = setup({ showDirectoryPicker: async value => { options = value; return directory; } });
  assert.equal((await access.selectConfiguration()).cancelled, false);
  assert.equal(options.mode, "readwrite");
  assert.equal(access.snapshot.registry.candidates.length, 1);
  assert.equal((await store.getDirectory()).handle, directory);
  assert.equal(access.snapshot.profiles.get("candidate-one"), null);
  assert.deepEqual(access.snapshot.prompts, { schemaVersion: 1, templates: [] });
});
test("unsupported picker is detected without filesystem operations", async () => {
  await assert.rejects(setup().access.selectConfiguration(), code("unsupported"));
});
test("missing, malformed and unsupported registry selections leave the old handle intact", async () => {
  const { access, store, directory } = await connected();
  for (const content of [null, "{broken", JSON.stringify({ schemaVersion: 2, candidates: [] })]) {
    const invalid = configuration();
    if (content === null) invalid.contents.delete("candidates.json"); else invalid.contents.get("candidates.json").body = content;
    access.pickers.showDirectoryPicker = async () => invalid;
    await assert.rejects(access.selectConfiguration(), code(content === null ? "configuration-missing" : "configuration-invalid"));
    assert.equal(access.directory.handle, directory);
    assert.equal((await store.getDirectory()).handle, directory);
  }
});
test("picker cancellation keeps configuration and prompt associations without false errors", async () => {
  const { access, directory } = await connected();
  access.pickers.showDirectoryPicker = async () => { throw domError("AbortError"); };
  assert.deepEqual(await access.selectConfiguration(), { cancelled: true });
  assert.equal(access.directory.handle, directory);
  const external = candidate({ promptFilePath: "C:/Prompts/one.md" });
  const linked = await connected(configuration([external]));
  linked.access.pickers.showOpenFilePicker = async () => { throw domError("AbortError"); };
  assert.deepEqual(await linked.access.linkPrompt(external.id), { cancelled: true });
  assert.equal(await linked.store.getPrompt(linked.access.directory.scope, external.promptFilePath), null);
});
test("failed handle persistence does not replace a previously validated selection", async () => {
  const { access, database, directory } = await connected();
  access.pickers.showDirectoryPicker = async () => configuration(); database.failNextTransaction = true;
  await assert.rejects(access.selectConfiguration(), code("storage-failed"));
  assert.equal(access.directory.handle, directory);
});
test("reselecting the same folder retains its prompt-link scope", async () => {
  const { access } = await connected(), scope = access.directory.scope;
  await access.selectConfiguration(); assert.equal(access.directory.scope, scope);
});
test("restore queries permission without silently requesting it", async () => {
  const { access, store, directory } = await connected(); directory.permission = "prompt";
  const reloaded = new StudioAccess(store, {});
  await assert.rejects(reloaded.restore(), code("permission-renewal"));
  assert.equal(directory.requests, 0); assert.equal(reloaded.snapshot, null);
  await reloaded.reconnectConfiguration();
  assert.equal(directory.requests, 1); assert.equal(reloaded.snapshot.registry.candidates.length, 1);
});
test("picker and reconnect calls start before unrelated asynchronous work", async () => {
  const directory = configuration(); let pickerCalled = false;
  const { access } = setup({ showDirectoryPicker: () => { pickerCalled = true; return Promise.resolve(directory); } });
  const selecting = access.selectConfiguration();
  assert.equal(pickerCalled, true); await selecting;
  directory.permission = "prompt";
  const reconnecting = access.reconnectConfiguration();
  assert.equal(directory.requests, 1); assert.equal(access.snapshot, null);
  await reconnecting;
});
test("denied access and failed file operations never report successful recovery", async () => {
  const { access, directory } = await connected(); directory.permission = "denied";
  await assert.rejects(access.refresh(), code("permission-denied"));
  directory.nextPermission = "denied";
  await assert.rejects(access.reconnectConfiguration(), code("permission-denied"));
  directory.nextPermission = "granted"; directory.exists = false;
  await assert.rejects(access.reconnectConfiguration(), code("folder-invalid"));
  assert.equal(access.snapshot, null);
});
test("optional catalogs and profiles are loaded, validated and never fabricated", async () => {
  const directory = configuration(), profile = {
    schemaVersion: 1, candidateId: "candidate-one", personal: {}, contact: {}, address: {}, workExperience: [], education: [], skills: [], certifications: [], customAnswers: {}, preferences: { startDate: "2026-11-09" },
  };
  directory.contents.set("profiles", directoryHandle("profiles", new Map([["candidate-one.json", fileHandle("candidate-one.json", JSON.stringify(profile))]])));
  assert.deepEqual((await loadConfiguration(directory)).profiles.get("candidate-one"), profile);
  profile.candidateId = "other";
  directory.contents.get("profiles").contents.get("candidate-one.json").body = JSON.stringify(profile);
  await assert.rejects(loadConfiguration(directory), code("configuration-invalid"));
  directory.contents.delete("profiles"); directory.contents.set("prompt-templates.json", fileHandle("prompt-templates.json", "{broken"));
  await assert.rejects(loadConfiguration(directory), code("configuration-invalid"));
});
test("configuration changes during a multi-file read invalidate the attempted snapshot", async () => {
  const directory = configuration(), registryFile = directory.contents.get("candidates.json");
  registryFile.onRead = count => { if (count === 2) registryFile.body = JSON.stringify({ schemaVersion: 1, activeCandidateId: null, candidates: [] }); };
  await assert.rejects(loadConfiguration(directory), code("configuration-changed"));
});
test("an optional file created during loading invalidates the attempted snapshot", async () => {
  const directory = configuration(), registryFile = directory.contents.get("candidates.json");
  registryFile.onRead = count => {
    if (count === 2) directory.contents.set("prompt-templates.json", fileHandle("prompt-templates.json", '{"schemaVersion":1,"templates":[]}'));
  };
  await assert.rejects(loadConfiguration(directory), code("configuration-changed"));
});
test("refresh reacquires replaced registry files instead of keeping a cached file handle", async () => {
  const { access, directory } = await connected();
  directory.contents.set("candidates.json", fileHandle("candidates.json", JSON.stringify({ schemaVersion: 1, activeCandidateId: null, candidates: [] })));
  await access.refresh(); assert.equal(access.snapshot.registry.candidates.length, 0);
});
test("saved pasted prompts resolve within config and preserve their full text without a picker", async () => {
  const { access } = await connected();
  assert.equal((await access.readPrompt("candidate-one")).body, "  Legacy tagged instructions\r\n");
});
test("revoked configuration permission invalidates cached candidates before a prompt read", async () => {
  const { access, directory } = await connected(); directory.permission = "denied";
  await assert.rejects(access.readPrompt("candidate-one"), code("permission-denied"));
  assert.equal(access.snapshot, null); assert.equal(directory.requests, 0);
});
test("external prompt access requires a separate handle and explicit picker association", async () => {
  const external = candidate({ promptFilePath: "C:/Prompts/configured.md" });
  const { access, store } = await connected(configuration([external]));
  await assert.rejects(access.readPrompt(external.id), code("prompt-unlinked"));
  // Filename differences are displayed associations, not absolute-path verification.
  const selected = fileHandle("selected.md", "  Whole prompt\r\n");
  access.pickers.showOpenFilePicker = async () => [selected];
  assert.equal((await access.linkPrompt(external.id)).filename, "selected.md");
  assert.equal((await access.readPrompt(external.id)).body, "  Whole prompt\r\n");
  assert.equal((await store.getPrompt(access.directory.scope, external.promptFilePath)).handle, selected);
});
test("linked prompts are reread, and changed or removed files never fall back to cached bodies", async () => {
  const external = candidate({ promptFilePath: "C:/Prompts/live.txt" });
  const { access, store } = await connected(configuration([external])), file = fileHandle("live.txt", "Original");
  await store.savePrompt(access.directory.scope, external.promptFilePath, file);
  assert.equal((await access.readPrompt(external.id)).body, "Original");
  file.body = "Updated"; assert.equal((await access.readPrompt(external.id)).body, "Updated");
  file.exists = false; await assert.rejects(access.readPrompt(external.id), code("prompt-unavailable"));
});
test("invalid UTF-8, empty, oversized and unsupported external prompts are rejected", async () => {
  for (const file of [fileHandle("bad.txt", new Uint8Array([255])), fileHandle("empty.md", " \n"), fileHandle("large.txt", "x".repeat(MAX_PROMPT_BYTES + 1)), fileHandle("bad.json", "text")])
    await assert.rejects(readPromptFile(file), code("prompt-invalid"));
});
test("failed relinking retains the previous authorized prompt file", async () => {
  const external = candidate({ promptFilePath: "C:/Prompts/live.md" });
  const { access, store } = await connected(configuration([external])), previous = fileHandle("old.md");
  await store.savePrompt(access.directory.scope, external.promptFilePath, previous);
  access.pickers.showOpenFilePicker = async () => [fileHandle("empty.md", "")];
  await assert.rejects(access.linkPrompt(external.id), code("prompt-invalid"));
  assert.equal((await store.getPrompt(access.directory.scope, external.promptFilePath)).handle, previous);
});
test("linked prompt renewal requires a user call and a real subsequent read", async () => {
  const external = candidate({ promptFilePath: "C:/Prompts/live.md" });
  const { access, store } = await connected(configuration([external])), file = fileHandle("live.md", "Current", "prompt");
  await store.savePrompt(access.directory.scope, external.promptFilePath, file);
  await assert.rejects(access.readPrompt(external.id), code("permission-renewal")); assert.equal(file.requests, 0);
  assert.equal((await access.reconnectPrompt(external.id)).body, "Current"); assert.equal(file.requests, 1);
  file.exists = false; await assert.rejects(access.reconnectPrompt(external.id), code("prompt-unavailable"));
});
test("registry changes invalidate prompt reads and do not save a stale link", async () => {
  const external = candidate({ promptFilePath: "C:/Prompts/live.md" });
  const { access, directory, store } = await connected(configuration([external]));
  access.pickers.showOpenFilePicker = async () => {
    directory.contents.get("candidates.json").body = JSON.stringify({ schemaVersion: 1, activeCandidateId: null, candidates: [] });
    return [fileHandle("live.md")];
  };
  const scope = access.directory.scope;
  await assert.rejects(access.linkPrompt(external.id), code("configuration-changed"));
  assert.equal(await store.getPrompt(scope, external.promptFilePath), null); assert.equal(access.snapshot, null);
});
test("Studio source has no manager/network/native bridge or filesystem write calls", async () => {
  for (const path of ["studio.js", "studio/access.mjs", "studio/handles.mjs", "studio/contracts.mjs"]) {
    const source = await readFile(new URL(`../extension/${path}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /sendNativeMessage|connectNative|chrome\.storage|chrome\.fileSystem|\bfetch\s*\(|createWritable|showSaveFilePicker/);
  }
  const manifest = JSON.parse(await readFile(new URL("../extension/manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.background.service_worker, "background.js"); assert.equal(manifest.action.default_popup, "popup.html");
  assert.deepEqual(manifest.permissions, ["contextMenus", "scripting", "nativeMessaging", "pageCapture", "clipboardWrite", "storage"]);
});
