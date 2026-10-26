import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as pause } from "node:timers/promises";
import { contracts, composePrompt, promptStatus, profileCompleteness, setProfileField, formatAddress, safePdfFilename, resumeInput, PdfPreview, preserveTextEdits, replaceTextRange, birthdateToDisplay, birthdateFromDisplay } from "../manager/ui/studio-core.mjs";
import { initializeStudio } from "../manager/ui/studio-app.mjs";
import { getBuiltInDocumentTemplates, renderResumePdfBlob, buildResumeDocumentDefinition } from "../extension/shared/resume-renderer.mjs";
import { validateProfile, validateReferences } from "../extension/studio/contracts.mjs";
import { loadConfiguration } from "../extension/studio/access.mjs";
import { extensionSetupAddress, probeExtension } from "../manager/ui/extension-studio.mjs";
import vm from "node:vm";
import { configuration, candidate, fileHandle } from "./extension-fakes.mjs";

const fixture = JSON.parse(await readFile(new URL("./fixtures/resume-data.json", import.meta.url), "utf8"));
const clone = value => structuredClone(value);
function args() { return { registry: clone(fixture.registry), candidateId: "candidate-one", profile: clone(fixture.profile), resumeText: JSON.stringify(fixture.resume), documents: { schemaVersion: 1, templates: getBuiltInDocumentTemplates() }, templateId: "classic", bindings: { experience: ["work-one"], education: ["education-one"] } }; }
const pdf = () => new Blob(["%PDF-synthetic"], { type: "application/pdf" });

test("composition replaces only the explicit JD token and preserves body, JD, punctuation and CRLF", () => {
  const body = "  Exact body\r\n{{JOB_DESCRIPTION}}\n$&\n{{JOB_DESCRIPTION}} "; const jd = "Original\r\n$& $` </script>";
  assert.equal(composePrompt(body, jd), `  Exact body\r\n${jd}\n$&\n${jd} `);
  assert.equal(body, "  Exact body\r\n{{JOB_DESCRIPTION}}\n$&\n{{JOB_DESCRIPTION}} "); assert.equal(jd, "Original\r\n$& $` </script>");
});
test("composition without a token appends a labeled JD without altering the stored body", () => {
  assert.equal(composePrompt("  legacy tags <resume>\r\n", "  original JD\n"), "  legacy tags <resume>\r\n\n\nJob Description:\n  original JD\n");
  assert.throws(() => composePrompt(" ", "JD"), /empty/); assert.throws(() => composePrompt("Body", " "), /job description/);
});
test("textarea normalization does not rewrite unchanged CRLF or mixed newlines", () => {
  const original = " First\r\nSecond\nThird\rFourth ";
  assert.equal(preserveTextEdits(original, " First\nSecond\nThird\nFourth "), original);
  assert.equal(preserveTextEdits(original, " First\nChanged\nThird\nFourth "), " First\r\nChanged\nThird\rFourth ");
  assert.equal(replaceTextRange("One\r\nTwo", 4, 7, "Paste\r\nExact"), "One\r\nPaste\r\nExact");
});
test("managed source status preserves missing and archived references without selecting a fallback", () => {
  const candidate = { assignedPromptTemplateId: "prompt-one" };
  assert.equal(promptStatus(candidate, { templates: [] }).usable, false);
  assert.match(promptStatus(candidate, { templates: [{ id: "prompt-one", archived: true }] }).label, /archived/);
  assert.equal(promptStatus(candidate, { templates: [{ id: "prompt-one", name: "Example", version: 3 }] }).label, "Example · v3");
  assert.match(promptStatus({ promptTemplate: "templates/existing.txt" }, { templates: [] }).label, /Legacy stored/);
});
test("completeness uses only structured profile fields and never prompt text", () => {
  assert.equal(profileCompleteness({ promptTemplate: "name phone all details" }).completed, 0);
  assert.equal(profileCompleteness(fixture.profile).completed, 3);
});
test("profile edits retain future nested data, unedited collections and exact custom answers", () => {
  const profile = clone(fixture.profile); profile.future = { enabled: true }; profile.workExperience[0].future = [1, 2];
  profile.customAnswers.answers = [{ id: "qa", question: "Question", answer: "  Exact\r\nanswer.\n" }];
  const changed = setProfileField(profile, ["workExperience", 0, "address", "city"], "Changed City");
  validateProfile(changed, "candidate-one"); assert.deepEqual(changed.future, profile.future); assert.deepEqual(changed.workExperience[0].future, [1, 2]);
  assert.deepEqual(changed.customAnswers, profile.customAnswers); assert.deepEqual(changed.skills, profile.skills); assert.notEqual(profile.workExperience[0].address.city, "Changed City");
});
test("new profile extensions do not permit credential fields or malformed custom answers", () => {
  const profile = clone(fixture.profile); profile.contact.password = "forbidden";
  assert.throws(() => validateProfile(profile, "candidate-one"), /credential/);
  delete profile.contact.password; profile.customAnswers.answers = [{ id: "qa", question: "", answer: "value" }];
  assert.throws(() => validateProfile(profile, "candidate-one"), /question/);
});
test("employer address copy formats only present supported address fields", () => {
  assert.equal(formatAddress({ line1: "1 Example St", city: "City", state: "EX", postalCode: "00000" }), "1 Example St\nCity, EX\n00000");
  assert.equal(formatAddress({}), "");
});
test("built-in document references validate without creating a persistent catalog", () => {
  const documents = { schemaVersion: 1, templates: [] };
  validateReferences({ preferredDocumentTemplateId: "modern" }, { schemaVersion: 1, templates: [] }, documents);
  assert.deepEqual(documents.templates, []);
});
test("standalone access tolerates built-in preferences and warns about unavailable managed assignments", async () => {
  const folder = configuration([candidate({ preferredDocumentTemplateId: "classic", assignedPromptTemplateId: "archived-prompt" })]);
  const prompt = { id: "archived-prompt", name: "Archived", description: "Synthetic", body: "Instructions", version: 1, isDefault: false, archived: true, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
  folder.contents.set("prompt-templates.json", fileHandle("prompt-templates.json", JSON.stringify({ schemaVersion: 1, templates: [prompt] })));
  const snapshot = await loadConfiguration(folder); assert.equal(snapshot.registry.candidates.length, 1); assert.match(snapshot.referenceWarnings.get("candidate-one"), /archived/); assert.equal(snapshot.documents.templates.length, 0);
});
test("per-resume layout and settings overrides do not change registry preferences or defaults", () => {
  const input = args(); input.registry.candidates[0].preferredDocumentTemplateId = "classic"; input.templateId = "modern"; input.overrides = { bodyFontSize: 12 };
  const before = clone(input); const result = resumeInput(input);
  assert.equal(result.documentTemplate.layoutId, "modern"); assert.equal(result.formattingOverrides.bodyFontSize, 12); assert.deepEqual(input, before);
});
test("resume parsing and complete validation happen before any rendering can occur", () => {
  for (const text of ["{", "{}", JSON.stringify({ ...fixture.resume, skills: "invalid" })]) assert.throws(() => resumeInput({ ...args(), resumeText: text }));
  const unknown = { ...fixture.resume, company: "Unknown" }; assert.equal(resumeInput({ ...args(), resumeText: JSON.stringify(unknown) }).resume.company, "Unknown");
});
test("explicit associations are required and target company never becomes employment data", () => {
  const input = args(); input.bindings.experience = [""]; assert.throws(() => resumeInput(input), /bindings/);
  input.bindings.experience = ["work-one"]; const result = resumeInput(input);
  assert.equal(result.resume.experience[0].company, fixture.resume.experience[0].company);
  assert.notEqual(result.resume.company, result.resume.experience[0].company); assert.equal(result.candidate.name, fixture.registry.candidates[0].name);
});
test("safe PDF names remove paths, device names, controls and trailing dots while retaining accents", () => {
  assert.equal(safePdfFilename("Zoë Example", "../ACME: West\\Dept?"), "Zoë Example - ACME West Dept.pdf");
  assert.equal(safePdfFilename("CON", "LPT¹.txt"), "_CON - _LPT¹.txt.pdf");
  assert.equal(safePdfFilename("", "..."), "Resume.pdf"); assert.equal(safePdfFilename(null, null), "Resume.pdf");
  const name = safePdfFilename("😀".repeat(200), "x"); assert.ok(name.length <= 184); assert.ok(name.isWellFormed()); assert.doesNotMatch(name, /[<>:"/\\|?*\u0000-\u001f]/);
});
test("preview creates real Blob URLs, revokes replaced URLs, and clears stale output immediately", async () => {
  const events = [], revoked = []; let number = 0;
  const preview = new PdfPreview({ render: async () => pdf(), urls: { createObjectURL: () => `blob:${++number}`, revokeObjectURL: value => revoked.push(value) }, onChange: value => events.push(value) });
  await preview.update({}); assert.equal(preview.blob.type, "application/pdf"); await preview.update({}); assert.deepEqual(revoked, ["blob:1"]);
  preview.clear(); assert.deepEqual(revoked, ["blob:1", "blob:2"]); assert.equal(preview.blob, null); assert.equal(events.at(-1).url, null);
});
test("late PDF success and late PDF failure cannot replace or clear a newer preview", async () => {
  const pending = []; let number = 0;
  const preview = new PdfPreview({ render: () => new Promise((resolve, reject) => pending.push({ resolve, reject })), urls: { createObjectURL: () => `blob:${++number}`, revokeObjectURL() {} } });
  const old = preview.update({}); const current = preview.update({}); pending[1].resolve(pdf()); await current;
  pending[0].resolve(pdf()); assert.equal(await old, false); assert.equal(preview.url, "blob:1");
  const failing = preview.update({}); const newest = preview.update({}); pending[3].resolve(pdf()); await newest;
  pending[2].reject(new Error("obsolete failure")); assert.equal(await failing, false); assert.equal(preview.url, "blob:2");
});
test("render failures leave no old downloadable PDF and report actionable errors", async () => {
  let fail = false; const preview = new PdfPreview({ render: async () => { if (fail) throw new Error("Font unavailable"); return pdf(); } });
  await preview.update({}); fail = true; await assert.rejects(preview.update({}), /Font unavailable/); assert.equal(preview.url, null); assert.equal(preview.blob, null);
});
test("download creates no anchor until explicitly invoked, and uses the preview Blob URL", async () => {
  let clicks = 0, removes = 0; const anchors = [];
  const document = { body: { append(element) { anchors.push(element); } }, createElement(tag) { assert.equal(tag, "a"); return { click() { clicks++; }, remove() { removes++; } }; } };
  const preview = new PdfPreview({ render: async () => pdf() }); assert.throws(() => preview.download("Resume.pdf", document), /preview/);
  await preview.update({}); assert.equal(clicks, 0); preview.download("Resume.pdf", document);
  assert.equal(clicks, 1); assert.equal(removes, 1); assert.equal(anchors[0].href, preview.url); assert.equal(anchors[0].download, "Resume.pdf"); preview.clear();
});
test("browser download exceptions propagate and remove their temporary anchor", async () => {
  let removed = false; const preview = new PdfPreview({ render: async () => pdf() }); await preview.update({});
  assert.throws(() => preview.download("Resume.pdf", { body: { append() {} }, createElement() { return { click() { throw new Error("blocked"); }, remove() { removed = true; } }; } }), /blocked/);
  assert.equal(removed, true); preview.clear();
});
test("the web workflow generates actual pdfmake PDF bytes through the one shared renderer", async () => {
  const preview = new PdfPreview({ render: renderResumePdfBlob }); const input = resumeInput(args()); await preview.update(input);
  assert.equal(preview.blob.type, "application/pdf"); assert.equal(new TextDecoder().decode((new Uint8Array(await preview.blob.arrayBuffer())).slice(0, 5)), "%PDF-");
  assert.ok(preview.blob.size > 1000); preview.clear();
});

// Small DOM/event adapter for real Studio orchestration. This does not emulate a
// browser PDF viewer, clipboard permission model, downloads, or visual layout.
class Element {
  constructor(tag, document) { this.tagName = tag; this.document = document; this.children = []; this.listeners = {}; this.attributes = {}; this.dataset = {}; this.value = ""; this.selectionStart = this.selectionEnd = 0; this.hidden = false; this.textContent = ""; const classes = new Set(); this.classList = { toggle(key, on) { if (on ?? !classes.has(key)) classes.add(key); else classes.delete(key); }, contains(key) { return classes.has(key); } }; }
  set value(text) { this._value = this.tagName === "textarea" ? String(text).replace(/\r\n|\r/g, "\n") : text; }
  get value() { return this._value; }
  setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
  set id(value) { this._id = value; this.document.ids.set(value, this); }
  get id() { return this._id; }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; }
  addEventListener(event, callback) { (this.listeners[event] ??= []).push(callback); }
  async fire(event, detail = {}) { for (const callback of this.listeners[event] || []) await callback({ target: this, preventDefault() {}, ...detail }); }
  setAttribute(key, value) { this.attributes[key] = value; }
  getAttribute(key) { return this.attributes[key] ?? null; }
  setCustomValidity(message) { this.validationMessage = message; }
  reportValidity() { return !this.validationMessage && this.children.every(child => child.reportValidity?.() ?? true); }
  reset() {}
  showModal() { this.open = true; }
  close() { this.open = false; }
  focus() {}
  removeAttribute(key) { delete this.attributes[key]; if (key === "src") delete this.src; }
  querySelector() { return null; }
  querySelectorAll(selector) {
    const tags = selector.split(",").map(tag => tag.trim());
    return this.children.flatMap(child => [...(tags.includes(child.tagName) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  remove() {}
  click() { this.document.downloads++; }
}
async function uiFixture(t, exists = true, legacy = false, profileData = fixture.profile) {
  const html = await readFile(new URL("../manager/ui/index.html", import.meta.url), "utf8");
  const document = { ids: new Map(), downloads: 0, createElement(tag) { return new Element(tag, this); }, getElementById(id) { const element = this.ids.get(id); assert.ok(element, `Missing DOM ID ${id}`); return element; } };
  document.body = document.createElement("body");
  document.createTextNode = text => { const element = document.createElement("text"); element.textContent = text; return element; };
  for (const match of html.matchAll(/<([a-z]+)[^>]*\bid="([^"]+)"[^>]*>/g)) { const element = document.createElement(match[1]); element.id = match[2]; }
  const nav = [...html.matchAll(/<button[^>]*data-page="([^"]+)"/g)].map(match => { const button = document.createElement("button"); button.dataset.page = match[1]; return button; });
  document.querySelectorAll = selector => selector === "[data-page]" ? nav : [...document.ids.values()].filter(element => element.id.startsWith("page-"));
  const listeners = {}, clipboard = []; let confirm = true;
  const window = { confirm: () => confirm, addEventListener(name, action) { (listeners[name] ??= []).push(action); } };
  const previous = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch, chrome: globalThis.chrome, navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator") };
  globalThis.document = document; globalThis.window = window; Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { async writeText(text) { clipboard.push(text); } } } });
  t.after(() => { for (const callback of listeners.pagehide || []) callback(); globalThis.document = previous.document; globalThis.window = previous.window; globalThis.fetch = previous.fetch; if (previous.chrome === undefined) delete globalThis.chrome; else globalThis.chrome = previous.chrome; if (previous.navigator) Object.defineProperty(globalThis, "navigator", previous.navigator); else delete globalThis.navigator; });
  const state = { registry: { data: clone(fixture.registry), revision: "registry-1" }, prompts: { data: { schemaVersion: 1, templates: [] }, revision: null }, documents: { schemaVersion: 1, templates: getBuiltInDocumentTemplates() } };
  state.registry.data.futureRoot = { preserve: true };
  state.documentCatalog = { data: { schemaVersion: 1, templates: [] }, revision: null };
  let savedProfile = { data: clone(profileData), revision: exists ? "profile-1" : null, exists };
  const calls = []; let conflict = false, catalogFailure = false, integrationFailure = false, integrationGate, writeGate;
  const extensionState = { preferences: { data: { schemaVersion: 1, setupPage: "file-access", confirmSetupCopy: true }, revision: null }, device: { data: { schemaVersion: 1, label: "", extensionId: "", probeTimeoutMs: 4000 }, revision: null }, diagnostics: { backend: "reachable", package: { status: "available", name: "Synthetic extension", version: "0.5.0", diagnosticBridge: true }, browserConnection: "not-checked", nativeHost: "not-checked", perOperationCapture: "pending", bidFolderSaving: "pending" } };
  const api = async (path, options = {}) => {
    calls.push({ path, ...clone(options) });
    if (catalogFailure && path === "/api/studio/state") throw new Error("Malformed managed catalog");
    if (integrationFailure && path === "/api/studio/extension") throw new Error("Synthetic settings failure");
    if (options.method) {
      if (writeGate) await writeGate;
      if (conflict) { const error = new Error("Revision conflict. Reload and reconcile."); error.status = 409; throw error; }
      if (path.startsWith("/api/studio/extension/")) { const scope = path.split("/").at(-1); extensionState[scope] = { data: { ...extensionState[scope].data, ...options.body.data }, revision: "extension-2" }; return clone(extensionState[scope]); }
      if (path.endsWith("/profile")) { savedProfile = { data: clone(options.body.data), revision: "profile-2", exists: true }; return clone(savedProfile); }
      if (path.endsWith("/settings")) { Object.assign(state.registry.data.candidates[0], options.body.data); state.registry.revision = "registry-2"; return clone(state.registry); }
      if (path.includes("/prompts")) { const record = { id: "prompt-new", version: 1, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", ...options.body.data }; state.prompts.data.templates.push(record); state.prompts.revision = "catalog-1"; return clone(state.prompts); }
      if (path.includes("/documents")) { const record = { id: "document-new", version: 1, rendererVersion: 1, supportedSettings: getBuiltInDocumentTemplates()[0].supportedSettings, ...options.body.data }; state.documentCatalog.data.templates.push(record); state.documentCatalog.revision = "documents-1"; state.documents.templates.push(record); return clone(state.documentCatalog); }
      if (path.startsWith("/api/candidates/")) { Object.assign(state.registry.data.candidates[0], options.body); return { candidate: clone(state.registry.data.candidates[0]), state: clone(state.registry.data), registration: { ok: true } }; }
      if (path === "/api/active") { state.registry.data.activeCandidateId = options.body.candidateId; return { state: clone(state.registry.data) }; }
    }
    if (path === "/api/state") return { ...clone(state.registry.data), sessionToken: "synthetic-token" };
    if (path === "/api/studio/extension") { if (integrationGate) await integrationGate; return clone(extensionState); }
    if (path.endsWith("/state")) return clone(state);
    if (path.endsWith("/profile")) { const id = path.split("/").at(-2); return { ...clone(savedProfile), data: { ...clone(savedProfile.data), candidateId: id } }; }
    if (path.endsWith("/template")) return { promptTemplateText: "Legacy instructions" };
    if (path.endsWith("/prompt")) return { name: "Legacy stored prompt", body: path.includes("candidate-two") ? "Different candidate prompt" : "Exact legacy prompt\r\n" };
    throw new Error(`Unexpected API call: ${path}`);
  };
  const renders = []; let studio;
  if (legacy) {
    globalThis.fetch = async (path, options) => ({ ok: true, json: async () => api(path, { ...options, method: options.method === "GET" ? undefined : options.method, body: options.body ? JSON.parse(options.body) : undefined }) });
    await import(`../manager/ui/app.js?candidate-ui-test=${Date.now()}`); await pause(10);
  } else { studio = initializeStudio({ api, refreshCandidates: async () => {}, renderPdf: async input => { renders.push(input); return pdf(); } }); await studio.candidatesChanged(state.registry.data); }
  return { document, state, extensionState, calls, clipboard, renders, listeners, studio, setConfirm(value) { confirm = value; }, setConflict(value) { conflict = value; }, setCatalogFailure(value) { catalogFailure = value; }, setIntegrationFailure(value) { integrationFailure = value; }, setIntegrationGate(value) { integrationGate = value; }, setWriteGate(value) { writeGate = value; }, $: id => document.getElementById(id), async navigate(page) { await nav.find(element => element.dataset.page === page).fire("click"); } };
}
test("Home loads active-candidate information without any configuration writes", async t => {
  const ui = await uiFixture(t); assert.equal(ui.calls.some(call => call.method), false); assert.ok(ui.$("home-content").children.some(element => element.textContent === "Alex Example"));
});
test("landing page launches the existing tools and exposes no separate Profile destination", async t => {
  const ui = await uiFixture(t);
  assert.equal(ui.document.ids.has("page-profile"), false);
  const tools = ui.$("home-tools").children; assert.equal(tools.length, 5);
  for (const [index, route] of ["candidates", "prompts", "documents", "resume", "extensions"].entries()) {
    await tools[index].children.at(-1).fire("click");
    assert.equal(ui.$(`page-${route}`).hidden, false); assert.equal(ui.document.body.dataset.page, route);
    await ui.navigate("home");
  }
  await ui.$("home-candidates").fire("click"); assert.equal(ui.$("page-candidates").hidden, false);
  await ui.navigate("home"); await ui.$("home-start").fire("click"); assert.equal(ui.$("page-resume").hidden, false);
  assert.equal(ui.calls.some(call => call.method), false);
});
test("landing page without an active candidate directs setup to Candidates without creating records", async t => {
  const ui = await uiFixture(t); ui.state.registry.data.activeCandidateId = null; await ui.studio.candidatesChanged(ui.state.registry.data);
  assert.match(ui.$("home-start").textContent, /Set up/);
  assert.equal(ui.$("home-tools").children.length, 5);
  await ui.$("home-start").fire("click"); assert.equal(ui.$("page-candidates").hidden, false);
  assert.equal(ui.$("profile-save").disabled, true); assert.equal(ui.$("edit-active-candidate").disabled, true);
  assert.match(ui.$("profile-editor").children[0].textContent, /Activate a candidate/);
  assert.equal(ui.calls.some(call => call.method), false);
});
test("combined workspace shows active profile and assignments; configuration opens the existing dialog", async t => {
  const ui = await uiFixture(t, true, true); await ui.navigate("candidates");
  assert.equal(ui.$("profile-candidate").value, "Alex Example"); assert.equal(ui.$("profile-contact-email").value, fixture.profile.contact.email);
  assert.equal(ui.$("candidate-defaults").children[0].children[0].textContent, "AI prompt");
  assert.equal(ui.$("candidate-defaults").children[1].children[1].textContent, "Classic (default)");
  await ui.$("edit-active-candidate").fire("click");
  assert.equal(ui.$("candidate-dialog").open, true); assert.equal(ui.$("candidate-name").value, "Alex Example");
  assert.equal(ui.$("page-candidates").hidden, false); assert.equal(ui.calls.some(call => call.method), false);
});
test("candidate activation in the combined workspace guards dirty edits and loads the newly active profile", async t => {
  const ui = await uiFixture(t, true, true);
  ui.state.registry.data.candidates.push({ ...clone(fixture.registry.candidates[0]), id: "candidate-two", name: "Other Synthetic Candidate", preferredDocumentTemplateId: "modern" });
  await ui.$("refresh").fire("click"); await pause(10); await ui.navigate("candidates");
  const email = ui.$("profile-contact-email"); email.value = "unsaved@example.test"; await email.fire("input");
  ui.setConfirm(false);
  let radio = ui.$("candidate-list").children[1].children[1].children[2].children[0]; radio.checked = true; await radio.fire("change");
  assert.equal(ui.calls.some(call => call.path === "/api/active"), false); assert.equal(ui.$("profile-candidate").value, "Alex Example"); assert.equal(email.value, "unsaved@example.test");
  assert.equal(ui.$("candidate-list").children[1].children[1].children[2].children[0].checked, false);
  ui.setConfirm(true); radio = ui.$("candidate-list").children[1].children[1].children[2].children[0]; radio.checked = true; await radio.fire("change"); await pause(10);
  assert.equal(ui.$("profile-candidate").value, "Other Synthetic Candidate");
  assert.equal(ui.$("candidate-defaults").children[1].children[1].textContent, "Modern");
  assert.ok(ui.calls.some(call => call.path === "/api/studio/candidates/candidate-two/profile"));
  ui.$("profile-contact-phone").value = "555-0102"; await ui.$("profile-contact-phone").fire("input");
  await ui.$("profile-save").fire("click");
  const save = ui.calls.filter(call => call.method === "PUT").at(-1); assert.equal(save.path, "/api/studio/candidates/candidate-two/profile"); assert.equal(save.body.data.candidateId, "candidate-two");
});
test("missing profile stays a draft until explicit Save and retains unknown data", async t => {
  const ui = await uiFixture(t, false); await ui.navigate("candidates"); assert.equal(ui.calls.some(call => call.method), false);
  const email = ui.$("profile-contact-email"); email.value = "new@example.test"; await email.fire("input"); await ui.$("profile-save").fire("click");
  const save = ui.calls.find(call => call.method === "PUT"); assert.equal(save.body.revision, null); assert.equal(save.body.data.contact.email, "new@example.test"); assert.deepEqual(save.body.data.workExperience, fixture.profile.workExperience);
});
test("birthdate presentation uses MM/DD/YYYY while validating and preserving the ISO profile contract", () => {
  assert.equal(birthdateToDisplay("1992-07-09"), "07/09/1992");
  assert.equal(birthdateToDisplay("19920709"), "07/09/1992");
  assert.equal(birthdateToDisplay("2020-W01-1"), "12/30/2019");
  assert.equal(birthdateFromDisplay("02/29/2000"), "2000-02-29");
  assert.equal(birthdateFromDisplay("01/01/0001"), "0001-01-01");
  assert.equal(birthdateFromDisplay(""), ""); assert.equal(birthdateToDisplay(""), "");
  for (const invalid of ["02/29/1900", "02/30/2000", "13/01/2000", "00/10/2000", "01/00/2000", "01/01/0000", "7/9/1992", "1992-07-09"]) assert.throws(() => birthdateFromDisplay(invalid), /MM\/DD\/YYYY/);
});
test("birthdate has a native calendar, preserves existing dates until edited, and saves selected dates as ISO", async t => {
  const data = clone(fixture.profile); data.personal.birthday = "19920709";
  const ui = await uiFixture(t, true, false, data); await ui.navigate("candidates");
  const date = ui.$("profile-personal-birthday"), calendar = ui.$("profile-personal-birthday-calendar");
  assert.equal(date.value, "07/09/1992"); assert.equal(date.placeholder, "MM/DD/YYYY"); assert.equal(calendar.type, "date"); assert.equal(calendar.value, "1992-07-09");
  let opened = 0; calendar.showPicker = () => { opened++; }; await calendar.fire("click"); assert.equal(opened, 1);
  assert.equal(ui.calls.some(call => call.method), false); assert.equal(ui.$("profile-save").disabled, true);
  ui.$("profile-contact-phone").value = "555-0102"; await ui.$("profile-contact-phone").fire("input"); await ui.$("profile-save").fire("click");
  assert.equal(ui.calls.filter(call => call.method === "PUT").at(-1).body.data.personal.birthday, "19920709");
  date.value = "08/10/1993"; await date.fire("input"); assert.equal(calendar.value, "1993-08-10");
  calendar.value = "1994-09-11"; await calendar.fire("change"); assert.equal(date.value, "09/11/1994");
  await ui.$("profile-save").fire("click"); assert.equal(ui.calls.filter(call => call.method === "PUT").at(-1).body.data.personal.birthday, "1994-09-11");
});
test("invalid birthdate input cannot save and survives adding another profile entry", async t => {
  const ui = await uiFixture(t); await ui.navigate("candidates");
  ui.$("profile-personal-birthday").value = "02/30/2000"; await ui.$("profile-personal-birthday").fire("input");
  await ui.$("profile-add-links").fire("click"); assert.equal(ui.$("profile-personal-birthday").value, "02/30/2000");
  await ui.$("profile-save").fire("click"); assert.match(ui.$("studio-status").textContent, /MM\/DD\/YYYY/); assert.equal(ui.calls.some(call => call.method), false);
  ui.$("profile-personal-birthday").value = "02/29/2000"; await ui.$("profile-personal-birthday").fire("input");
  ui.$("profile-contact-links-0-label").value = "Portfolio"; await ui.$("profile-contact-links-0-label").fire("input");
  ui.$("profile-contact-links-0-url").value = "https://example.test"; await ui.$("profile-contact-links-0-url").fire("input");
  await ui.$("profile-save").fire("click"); assert.equal(ui.calls.filter(call => call.method === "PUT").at(-1).body.data.personal.birthday, "2000-02-29");
});
test("Current disables each employment and education end date without discarding the stored value", async t => {
  const data = clone(fixture.profile);
  for (const key of ["workExperience", "education"]) { data[key][0].period.current = true; data[key][0].period.end = "Dec 2023"; }
  const ui = await uiFixture(t, true, false, data); await ui.navigate("candidates");
  for (const key of ["workExperience", "education"]) {
    const current = ui.$(`profile-${key}-0-period-current`), end = ui.$(`profile-${key}-0-period-end`);
    assert.equal(end.disabled, true); assert.equal(end.value, "Dec 2023");
    current.checked = false; await current.fire("input"); assert.equal(end.disabled, false); assert.equal(end.value, "Dec 2023");
    current.checked = true; await current.fire("input"); assert.equal(end.disabled, true);
  }
  assert.equal(ui.$("profile-save").disabled, true); await ui.$("profile-save").fire("click"); assert.equal(ui.calls.some(call => call.method), false);
  ui.$("profile-contact-phone").value = "555-0102"; await ui.$("profile-contact-phone").fire("input");
  await ui.$("profile-save").fire("click"); const saved = ui.calls.find(call => call.method === "PUT").body.data;
  for (const key of ["workExperience", "education"]) { assert.equal(saved[key][0].period.current, true); assert.equal(saved[key][0].period.end, "Dec 2023"); }
});
test("profile sections place add controls in their headers and accessible red crosses in entry headers", async t => {
  const ui = await uiFixture(t); await ui.navigate("candidates");
  for (const key of ["links", "workExperience", "education", "answers"]) {
    const section = ui.$("profile-editor").children.find(item => item.attributes["aria-labelledby"] === `profile-section-${key}`);
    assert.equal(section.children[0].children.at(-1).id, `profile-add-${key}`);
  }
  for (const key of ["links", "answers"]) await ui.$(`profile-add-${key}`).fire("click");
  for (const key of ["links", "workExperience", "education", "answers"]) {
    const cross = ui.$(`profile-remove-${key}-0`), card = ui.$(`profile-entry-${key}-0`);
    assert.equal(cross.textContent, "×"); assert.equal(cross.className, "profile-remove"); assert.match(cross.attributes["aria-label"], /Remove/);
    assert.equal(card.children[0].children.at(-1), cross);
  }
  ui.setConfirm(false); await ui.$("profile-remove-workExperience-0").fire("click"); assert.equal(ui.$("profile-workExperience-0-company").value, fixture.profile.workExperience[0].company);
  ui.setConfirm(true); await ui.$("profile-remove-workExperience-0").fire("click"); await ui.$("profile-remove-links-0").fire("click"); await ui.$("profile-remove-answers-0").fire("click");
  assert.equal(ui.calls.some(call => call.method), false);
  await ui.$("profile-save").fire("click"); const saved = ui.calls.find(call => call.method === "PUT").body.data;
  assert.deepEqual(saved.workExperience, []); assert.deepEqual(saved.contact.links, []); assert.deepEqual(saved.customAnswers.answers, []);
  assert.deepEqual(saved.education, fixture.profile.education);
});
test("profile fields have descriptive placeholders and address copy remains an explicit action", async t => {
  const ui = await uiFixture(t); await ui.navigate("candidates");
  for (const id of ["profile-contact-email", "profile-contact-phone", "profile-address-line1", "profile-address-city", "profile-workExperience-0-company", "profile-workExperience-0-title", "profile-education-0-degree", "profile-education-0-major", "profile-customAnswers-reasonForLeaving"]) assert.ok(ui.$(id).placeholder);
  const card = ui.$("profile-entry-workExperience-0"), addressHeader = card.children.find(item => item.className === "profile-address-heading");
  assert.deepEqual(ui.clipboard, []); await addressHeader.children[1].fire("click"); assert.deepEqual(ui.clipboard, [formatAddress(fixture.profile.workExperience[0].address)]);
});
test("unsaved profile edits block navigation and failed stale saves retain the edited form", async t => {
  const ui = await uiFixture(t); await ui.navigate("candidates"); const email = ui.$("profile-contact-email"); email.value = "unsaved@example.test"; await email.fire("input");
  ui.setConfirm(false); await ui.navigate("home"); assert.equal(ui.$("page-candidates").hidden, false);
  ui.setConflict(true); await ui.$("profile-save").fire("click"); assert.match(ui.$("studio-status").textContent, /Revision conflict/); assert.equal(email.value, "unsaved@example.test");
  let warned = false; ui.listeners.beforeunload[0]({ preventDefault() { warned = true; } }); assert.equal(warned, true);
});
test("prompt editor saves full body only on submit and duplicate starts an unsaved draft", async t => {
  const ui = await uiFixture(t); await ui.navigate("prompts"); await ui.$("prompt-new").fire("click");
  ui.$("prompt-name").value = "Example template"; const body = "  Complete body\r\n{{JOB_DESCRIPTION}}\n"; await ui.$("prompt-body").fire("paste", { clipboardData: { getData: () => body } }); await ui.$("prompt-editor").fire("input");
  assert.equal(ui.calls.some(call => call.method), false); await ui.$("prompt-editor").fire("submit");
  assert.equal(ui.calls.find(call => call.method === "POST").body.data.body, body);
  await ui.$("prompt-list").children[0].fire("click"); await ui.$("prompt-duplicate").fire("click"); assert.equal(ui.$("prompt-body").value, body.replaceAll("\r\n", "\n")); assert.match(ui.$("prompt-name").value, /copy/); assert.equal(ui.calls.filter(call => call.method).length, 1);
  await ui.$("prompt-editor").fire("submit"); assert.equal(ui.calls.filter(call => call.method).at(-1).body.data.body, body);
});
test("Studio preselects preference, temporary alternatives do not save it, and prompt copy keeps original JD", async t => {
  const ui = await uiFixture(t); await ui.navigate("resume"); assert.equal(ui.$("resume-template").value, "classic");
  ui.$("resume-template").value = "modern"; await ui.$("resume-template").fire("change"); assert.equal(ui.calls.some(call => call.method), false);
  ui.$("resume-jd").value = "  Original JD\n"; await ui.$("resume-copy-prompt").fire("click"); assert.equal(ui.clipboard[0], "Exact legacy prompt\r\n\n\nJob Description:\n  Original JD\n"); assert.equal(ui.$("resume-jd").value, "  Original JD\n");
  assert.equal(ui.document.ids.has("resume-save-preference"), false); assert.equal(ui.calls.some(call => call.method), false);
  assert.equal(ui.$("resume-jd").value, "  Original JD\n"); assert.equal(ui.$("resume-template").value, "modern");
});
test("clipboard failure is visible and does not change the original JD or persist anything", async t => {
  const ui = await uiFixture(t); await ui.navigate("resume"); ui.$("resume-jd").value = "Original JD";
  navigator.clipboard.writeText = async () => { throw new Error("denied"); };
  await ui.$("resume-copy-prompt").fire("click"); assert.match(ui.$("studio-status").textContent, /Clipboard write failed/); assert.equal(ui.$("resume-jd").value, "Original JD"); assert.equal(ui.calls.some(call => call.method), false);
});
test("invalid JSON never renders; valid explicitly bound input previews and downloads only on click", async t => {
  const ui = await uiFixture(t); await ui.navigate("resume"); ui.$("resume-json").value = "{}"; await ui.$("resume-json").fire("input"); await pause(400);
  assert.equal(ui.renders.length, 0); assert.match(ui.$("resume-errors").textContent, /company/);
  ui.$("resume-json").value = JSON.stringify(fixture.resume); await ui.$("resume-json").fire("input"); await pause(400); assert.equal(ui.renders.length, 0);
  ui.$("binding-experience-0").value = "work-one"; await ui.$("binding-experience-0").fire("change"); ui.$("binding-education-0").value = "education-one"; await ui.$("binding-education-0").fire("change"); await pause(400);
  assert.equal(ui.renders.length, 1); assert.equal(ui.$("pdf-preview").hidden, false); assert.equal(ui.document.downloads, 0);
  await ui.$("resume-download").fire("click"); assert.equal(ui.document.downloads, 1);
  ui.$("resume-json").value = "{"; await ui.$("resume-json").fire("input"); assert.equal(ui.$("pdf-preview").hidden, true); assert.equal(ui.$("resume-download").disabled, true);
});
test("web resource import map routes the same shared modules through the restricted allowlist", async () => {
  const html = await readFile(new URL("../manager/ui/index.html", import.meta.url), "utf8"); const map = JSON.parse(/<script type="importmap">(.*?)<\/script>/.exec(html)[1]);
  assert.equal(map.imports["/extension/shared/"], "/shared/"); assert.equal(map.imports["/extension/studio/contracts.mjs"], "/studio/contracts.mjs");
  assert.match(html, /<script src="\/app.js" type="module">/); assert.doesNotMatch(html, /https?:\/\/[^<]*\.js/);
});

test("Candidates Add/Edit selectors persist both assignments through the existing candidate handler", async t => {
  const ui = await uiFixture(t, true, true);
  ui.state.prompts.data.templates.push({ id: "managed-one", name: "Managed instructions", archived: false });
  const row = ui.$("candidate-list").children[0], edit = row.children[1].children[0];
  await edit.fire("click"); assert.equal(ui.$("candidate-dialog").open, true);
  assert.ok(ui.$("candidate-prompt-assignment").children.some(option => option.value === "managed-one"));
  assert.ok(ui.$("candidate-document-assignment").children.some(option => option.value === "modern"));
  ui.$("candidate-prompt-assignment").value = "managed-one"; ui.$("candidate-document-assignment").value = "modern";
  await ui.$("candidate-form").fire("submit");
  const save = ui.calls.find(call => call.method === "PUT" && call.path === "/api/candidates/candidate-one");
  assert.equal(save.body.assignedPromptTemplateId, "managed-one"); assert.equal(save.body.preferredDocumentTemplateId, "modern"); assert.equal(save.body.registryRevision, "registry-1");
  assert.equal(ui.$("candidate-dialog").open, false);
  await pause(10); // The legacy render hook refreshes Studio asynchronously.
});
test("malformed optional catalogs leave legacy candidate editing available and retain assignments", async t => {
  const ui = await uiFixture(t, true, true); ui.setCatalogFailure(true);
  ui.state.registry.data.candidates[0].assignedPromptTemplateId = "existing-assignment";
  await ui.$("candidate-list").children[0].children[1].children[0].fire("click");
  assert.equal(ui.$("candidate-dialog").open, true); assert.equal(ui.$("candidate-prompt-assignment").disabled, true); assert.match(ui.$("candidate-assignment-status").textContent, /preserved/);
  ui.$("candidate-name").value = "Renamed synthetic candidate"; await ui.$("candidate-name").fire("input");
  await ui.$("candidate-form").fire("submit");
  const save = ui.calls.find(call => call.method === "PUT"); assert.equal(Object.hasOwn(save.body, "assignedPromptTemplateId"), false); assert.equal(Object.hasOwn(save.body, "preferredDocumentTemplateId"), false);
  assert.equal(ui.state.registry.data.candidates[0].assignedPromptTemplateId, "existing-assignment"); await pause(10);
});
test("template libraries expose CRUD without candidate-assignment forms or writes", async t => {
  const ui = await uiFixture(t); await ui.navigate("documents");
  assert.equal(ui.document.ids.has("assignment-candidate"), false); assert.equal(ui.document.ids.has("document-candidate"), false); assert.equal(ui.document.ids.has("assignment-save"), false);
  await ui.$("document-new").fire("click"); ui.$("document-name").value = "Synthetic configuration"; ui.$("document-layout").value = "modern"; await ui.$("document-layout").fire("change");
  ui.$("document-setting-bodyFontSize").value = "12"; await ui.$("document-setting-bodyFontSize").fire("input");
  assert.equal(ui.calls.some(call => call.method), false); await ui.$("document-editor").fire("submit");
  const save = ui.calls.find(call => call.method === "POST"); assert.equal(save.path, "/api/studio/documents"); assert.equal(save.body.data.defaultSettings.bodyFontSize, 12);
  assert.equal(ui.calls.some(call => call.path.endsWith("/settings")), false); assert.equal(ui.state.registry.data.candidates[0].preferredDocumentTemplateId, undefined);
});
test("active candidate changes clear prompt, JD, JSON, preview and formatting together", async t => {
  const ui = await uiFixture(t); await ui.navigate("resume"); assert.equal(ui.$("assistant-prompt").value, "Exact legacy prompt\n");
  ui.$("resume-json").value = JSON.stringify(fixture.resume); ui.$("resume-jd").value = "First candidate JD"; ui.$("setting-bodyFontSize").value = "13"; await ui.$("setting-bodyFontSize").fire("input");
  ui.state.registry.data.candidates.push({ ...clone(fixture.registry.candidates[0]), id: "candidate-two", name: "Other Synthetic Candidate", historyFolder: "C:\\synthetic-unopened-history\\two", preferredDocumentTemplateId: "modern" });
  ui.state.registry.data.activeCandidateId = "candidate-two"; await ui.studio.candidatesChanged(ui.state.registry.data);
  assert.equal(ui.$("resume-candidate").value, "Other Synthetic Candidate"); assert.equal(ui.$("resume-json").value, ""); assert.equal(ui.$("resume-jd").value, "");
  assert.equal(ui.$("resume-template").value, "modern"); assert.equal(Number(ui.$("setting-bodyFontSize").value), 10.5); assert.equal(ui.$("assistant-prompt").value, "Different candidate prompt"); assert.equal(ui.$("resume-download").disabled, true);
});
test("valid JSON edits and styling changes refresh the actual render input while preserving explicit bindings", async t => {
  const ui = await uiFixture(t); await ui.navigate("resume"); ui.$("resume-json").value = JSON.stringify(fixture.resume); await ui.$("resume-json").fire("input"); await pause(400);
  ui.$("binding-experience-0").value = "work-one"; await ui.$("binding-experience-0").fire("change"); ui.$("binding-education-0").value = "education-one"; await ui.$("binding-education-0").fire("change"); await pause(400);
  const updated = { ...fixture.resume, summary: "Updated synthetic summary." }; ui.$("resume-json").value = JSON.stringify(updated); await ui.$("resume-json").fire("input"); assert.equal(ui.$("resume-download").disabled, true); await pause(400);
  assert.equal(ui.renders.at(-1).resume.summary, updated.summary); assert.deepEqual(ui.renders.at(-1).bindings, { experience: ["work-one"], education: ["education-one"] });
  ui.$("setting-nameFontSize").value = "30"; await ui.$("setting-nameFontSize").fire("input"); await pause(400); assert.equal(ui.renders.at(-1).formattingOverrides.nameFontSize, 30);
  await ui.$("resume-thumbnails").children[1].fire("click"); await pause(400); assert.equal(ui.renders.at(-1).documentTemplate.layoutId, "modern"); assert.equal(ui.calls.some(call => call.method), false);
  await ui.$("resume-copy-json").fire("click"); assert.equal(ui.clipboard.at(-1), JSON.stringify(updated));
});
test("customization sidebar collapse changes only layout, without changing content or downloading", async t => {
  const ui = await uiFixture(t); await ui.navigate("resume"); await ui.$("customize-toggle").fire("click"); assert.equal(ui.$("resume-workspace").classList.contains("customize-collapsed"), true);
  await ui.$("customize-toggle").fire("click"); assert.equal(ui.$("resume-workspace").classList.contains("customize-collapsed"), false); assert.equal(ui.document.downloads, 0);
});
test("disabled inline PDF viewing does not trigger a browser navigation or automatic download", async t => {
  const ui = await uiFixture(t); navigator.pdfViewerEnabled = false; await ui.navigate("resume");
  ui.$("resume-json").value = JSON.stringify({ ...fixture.resume, experience: [], education: [] }); await ui.$("resume-json").fire("input"); await pause(400);
  assert.equal(ui.$("pdf-preview").hidden, true); assert.equal(ui.$("pdf-preview").src, undefined); assert.equal(ui.document.downloads, 0);
  assert.equal(ui.$("resume-download").disabled, false); assert.match(ui.$("preview-status").textContent, /Inline PDF viewing is disabled/);
});
test("all new typography and header controls affect PDF document definitions", () => {
  const value = args(); value.overrides = { textColor: "#112233", lineHeight: 1.5, nameFontSize: 30, nameColor: "#445566", titleFontSize: 18, contactFontSize: 12, headerAlignment: "right", headingFontSize: 17 };
  const definition = buildResumeDocumentDefinition(resumeInput(value));
  assert.equal(definition.defaultStyle.color, "#112233"); assert.equal(definition.defaultStyle.lineHeight, 1.5);
  assert.equal(definition.content[0].fontSize, 30); assert.equal(definition.content[0].color, "#445566"); assert.equal(definition.content[0].alignment, "right");
  assert.equal(definition.content.find(item => item.text === fixture.resume.title).fontSize, 18); assert.equal(definition.content.find(item => typeof item.text === "string" && item.text.includes("alex@example.test")).fontSize, 12);
  assert.equal(definition.content.find(item => item.headlineLevel === 1).fontSize, 17);
});
test("each section visibility setting affects PDF output without editing generated JSON", () => {
  for (const [setting, text] of [["showSummary", fixture.resume.summary], ["showSkills", "Engineering: "], ["showExperience", fixture.resume.experience[0].company], ["showEducation", fixture.resume.education[0].degree]]) {
    const value = args(), original = value.resumeText; value.overrides = { [setting]: false };
    const definition = JSON.stringify(buildResumeDocumentDefinition(resumeInput(value)));
    assert.equal(definition.includes(text), false); assert.equal(value.resumeText, original);
  }
});
test("validated custom configurations can use supported layouts and later record versions", async () => {
  const value = args(), template = { ...getBuiltInDocumentTemplates()[1], id: "my-modern", name: "My Modern", version: 3, rendererVersion: 1, defaultSettings: { ...getBuiltInDocumentTemplates()[1].defaultSettings, nameColor: "#125678" } };
  value.documents.templates.push(template); value.templateId = "my-modern";
  const input = resumeInput(value); assert.equal(buildResumeDocumentDefinition(input).content[0].color, "#125678");
  const blob = await renderResumePdfBlob(input); assert.equal(blob.type, "application/pdf"); assert.ok(blob.size > 1000);
  for (const [key, invalid] of [["lineHeight", 0.9], ["nameFontSize", 35], ["nameColor", "red"], ["titleFontSize", 9], ["contactFontSize", 7], ["headerAlignment", "center\n"], ["headingFontSize", 19], ["showSummary", 1]]) assert.throws(() => resumeInput({ ...value, overrides: { [key]: invalid } }));
});

test("extension setup addresses are restricted to supported local extension pages", () => {
  assert.equal(extensionSetupAddress("a".repeat(32), "file-access"), `chrome-extension://${"a".repeat(32)}/studio.html`);
  assert.match(extensionSetupAddress("b".repeat(32), "legacy-popup"), /\/popup\.html$/);
  for (const id of ["", "../bad", "A".repeat(32), "q".repeat(32)]) assert.throws(() => extensionSetupAddress(id, "file-access"), /valid installed/);
  assert.throws(() => extensionSetupAddress("a".repeat(32), "../other"), /Unknown setup/);
});
test("runtime probes validate nonce, version and ID without reading candidate data", async () => {
  let request;
  const runtime = { sendMessage(id, message, respond) { request = message; respond({ protocolVersion: 1, nonce: message.nonce, extensionId: id, version: "0.5.0" }); } };
  assert.deepEqual(await probeExtension("a".repeat(32), 1000, runtime), { extensionId: "a".repeat(32), version: "0.5.0" });
  assert.deepEqual(Object.keys(request).sort(), ["nonce", "protocolVersion", "type"]);
  for (const wrong of [{ protocolVersion: 2 }, { nonce: "wrong" }, { extensionId: "b".repeat(32) }, { version: 4 }]) {
    await assert.rejects(probeExtension("a".repeat(32), 1000, { sendMessage(id, message, respond) { respond({ protocolVersion: 1, nonce: message.nonce, extensionId: id, version: "0.5.0", ...wrong }); } }), /incompatible/);
  }
});
test("missing runtime, lastError, malformed input and timeout never become a connected state", async () => {
  await assert.rejects(probeExtension("a".repeat(32), 1000, {}), /unavailable/);
  await assert.rejects(probeExtension("bad", 1000, {}), /valid installed/);
  await assert.rejects(probeExtension("a".repeat(32), 999, {}), /1000/);
  const runtime = { lastError: { message: "No receiving end" }, sendMessage(id, message, respond) { respond(); } };
  await assert.rejects(probeExtension("a".repeat(32), 1000, runtime), /No receiving end/);
  await assert.rejects(probeExtension("a".repeat(32), 1000, { sendMessage() {} }), /timeout/);
});
test("external diagnostics accept only the minimal loopback protocol and have no privileged effects", async () => {
  const source = await readFile(new URL("../extension/integration-diagnostics.js", import.meta.url), "utf8");
  let listener; const answers = [];
  vm.runInNewContext(source, { URL, chrome: { runtime: { id: "a".repeat(32), getManifest: () => ({ version: "0.5.0" }), onMessageExternal: { addListener(value) { listener = value; } } } } });
  const message = { type: "tracker:diagnostics", protocolVersion: 1, nonce: "synthetic-nonce" };
  for (const path of ["/", "/extension-studio"]) listener(message, { url: `http://127.0.0.1:8765${path}`, origin: "http://127.0.0.1:8765" }, value => answers.push(value));
  assert.equal(answers.length, 2); assert.deepEqual(Object.keys(answers[0]).sort(), ["extensionId", "nonce", "protocolVersion", "version"]);
  for (const sender of [{ url: "https://evil.test/" }, { url: "http://localhost:8765/" }, { url: "http://127.0.0.1:8765/unrelated" }, { url: "http://127.0.0.1:8765/", id: "b".repeat(32) }, { url: "http://127.0.0.1:8765/", origin: "https://evil.test" }, {}]) listener(message, sender, value => answers.push(value));
  for (const change of [{ type: "save_application" }, { nonce: "x".repeat(101) }, { protocolVersion: 2 }, { candidateId: "candidate-one" }]) listener({ ...message, ...change }, { url: "http://127.0.0.1:8765/" }, value => answers.push(value));
  assert.equal(answers.length, 2); assert.doesNotMatch(source, /sendNativeMessage|connectNative|\.storage\.|\.tabs\.|fetch\(/);
  const manifest = JSON.parse(await readFile(new URL("../extension/manifest.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.externally_connectable.matches, ["http://127.0.0.1/*"]); assert.ok(manifest.permissions.includes("nativeMessaging")); assert.equal(manifest.content_security_policy, undefined);
});
test("Extension Studio navigation loads empty settings without writes or candidate activation", async t => {
  const ui = await uiFixture(t); await ui.navigate("extensions");
  assert.equal(ui.$("page-extensions").hidden, false); assert.equal(ui.$("extension-backend-status").textContent, "Backend reached");
  assert.equal(ui.$("extension-connection-status").textContent, "Not checked"); assert.equal(ui.$("extension-device-state").textContent, "Not configured");
  assert.equal(ui.$("extension-probe").disabled, true); assert.equal(ui.$("extension-copy-setup").disabled, true);
  assert.equal(ui.calls.some(call => call.method), false); assert.equal(ui.calls.some(call => call.path === "/api/active"), false);
});
test("extension settings save with revisions in separate scopes and drive the real setup-copy action", async t => {
  const ui = await uiFixture(t); await ui.navigate("extensions");
  ui.$("extension-id-setting").value = "a".repeat(32); ui.$("extension-device-label").value = "Synthetic laptop"; await ui.$("extension-device-form").fire("input");
  assert.equal(ui.calls.some(call => call.method), false); assert.equal(ui.$("extension-probe").disabled, true);
  await ui.$("extension-device-form").fire("submit");
  const device = ui.calls.find(call => call.method === "PUT"); assert.equal(device.path, "/api/studio/extension/device"); assert.equal(device.body.revision, null); assert.equal(device.body.data.extensionId, "a".repeat(32));
  ui.$("extension-setup-page").value = "legacy-popup"; ui.$("extension-confirm-copy").checked = false; await ui.$("extension-preferences-form").fire("input");
  assert.equal(ui.$("extension-copy-setup").disabled, true); await ui.$("extension-preferences-form").fire("submit");
  const preference = ui.calls.filter(call => call.method === "PUT").at(-1); assert.equal(preference.path, "/api/studio/extension/preferences");
  ui.setConfirm(false); await ui.$("extension-copy-setup").fire("click"); assert.deepEqual(ui.clipboard, [`chrome-extension://${"a".repeat(32)}/popup.html`]);
  assert.equal(ui.state.registry.data.activeCandidateId, fixture.registry.activeCandidateId);
});
test("dirty extension settings guard navigation and conflict responses retain edits", async t => {
  const ui = await uiFixture(t); await ui.navigate("extensions"); ui.$("extension-device-label").value = "Unsaved laptop"; await ui.$("extension-device-form").fire("input");
  ui.setConfirm(false); await ui.navigate("home"); assert.equal(ui.$("page-extensions").hidden, false);
  ui.setConflict(true); await ui.$("extension-device-form").fire("submit"); assert.match(ui.$("extension-notice").textContent, /Revision conflict/); assert.equal(ui.$("extension-device-label").value, "Unsaved laptop");
  assert.equal(ui.$("extension-device-state").textContent, "Unsaved changes");
});
test("extension settings load failures disable edits and retry recovers without creating defaults", async t => {
  const ui = await uiFixture(t); ui.setIntegrationFailure(true); await ui.navigate("extensions");
  assert.equal(ui.$("extension-backend-status").textContent, "Settings unavailable"); assert.equal(ui.$("extension-device-fields").disabled, true); assert.equal(ui.$("extension-preferences-fields").disabled, true);
  assert.match(ui.$("extension-notice").textContent, /existing files were not replaced/);
  ui.setIntegrationFailure(false); await ui.$("extension-refresh").fire("click"); assert.equal(ui.$("extension-device-fields").disabled, false); assert.equal(ui.calls.some(call => call.method), false);
});
test("extension UI rejects invalid settings before a write and reports missing browser transport honestly", async t => {
  const ui = await uiFixture(t); await ui.navigate("extensions"); ui.$("extension-id-setting").value = "bad"; await ui.$("extension-device-form").fire("input"); await ui.$("extension-device-form").fire("submit");
  assert.match(ui.$("extension-notice").textContent, /32 lowercase/); assert.equal(ui.calls.some(call => call.method), false);
  ui.$("extension-id-setting").value = "a".repeat(32); await ui.$("extension-device-form").fire("submit"); await ui.$("extension-probe").fire("click");
  assert.equal(ui.$("extension-connection-status").textContent, "Response unavailable"); assert.match(ui.$("extension-connection-detail").textContent, /Installation cannot be determined/);
});
test("a real matching runtime response is distinguished from pairing, native health and file permissions", async t => {
  const ui = await uiFixture(t); ui.extensionState.device.data.extensionId = "a".repeat(32);
  globalThis.chrome = { runtime: { sendMessage(id, message, respond) { respond({ protocolVersion: 1, nonce: message.nonce, extensionId: id, version: "0.5.0" }); } } };
  await ui.navigate("extensions"); assert.equal(ui.$("extension-connection-status").textContent, "Not checked"); await ui.$("extension-probe").fire("click");
  assert.equal(ui.$("extension-connection-status").textContent, "Extension responded"); assert.match(ui.$("extension-connection-detail").textContent, /does not verify pairing/);
  await ui.$("extension-copy-diagnostics").fire("click"); const report = JSON.parse(ui.clipboard.at(-1)); assert.equal(report.diagnostics.nativeHost, "not-checked"); assert.equal(report.browserReport.extensionId, "a".repeat(32));
  assert.equal("registry" in report, false); assert.equal("sessionToken" in report, false); assert.equal(ui.calls.some(call => call.method), false);
});
test("late extension probe responses cannot restore stale status after device changes", async t => {
  const ui = await uiFixture(t); ui.extensionState.device.data.extensionId = "a".repeat(32); let respond, request;
  globalThis.chrome = { runtime: { sendMessage(id, message, callback) { respond = callback; request = message; } } };
  await ui.navigate("extensions"); const pending = ui.$("extension-probe").fire("click");
  ui.$("extension-id-setting").value = "b".repeat(32); await ui.$("extension-device-form").fire("input");
  respond({ protocolVersion: 1, nonce: request.nonce, extensionId: "a".repeat(32), version: "0.5.0" }); await pending;
  assert.equal(ui.$("extension-connection-status").textContent, "Not checked"); assert.equal(ui.$("extension-probe").disabled, true);
});
test("extension loading has disabled controls and late loads cannot update a departed page", async t => {
  const ui = await uiFixture(t); let resolve;
  ui.setIntegrationGate(new Promise(done => { resolve = done; }));
  const loading = ui.navigate("extensions");
  assert.equal(ui.$("extension-backend-status").textContent, "Checking…"); assert.equal(ui.$("extension-device-fields").disabled, true);
  await ui.navigate("home"); resolve(); await loading;
  assert.equal(ui.$("page-home").hidden, false); assert.equal(ui.$("extension-device-fields").disabled, true);
  ui.setIntegrationGate(null); await ui.navigate("extensions"); assert.equal(ui.$("extension-device-fields").disabled, false);
});
test("saving workspace preferences retains a separate unsaved device draft", async t => {
  const ui = await uiFixture(t); await ui.navigate("extensions");
  ui.$("extension-device-label").value = "Unsaved device"; await ui.$("extension-device-form").fire("input");
  ui.$("extension-confirm-copy").checked = false; await ui.$("extension-preferences-form").fire("input"); await ui.$("extension-preferences-form").fire("submit");
  assert.equal(ui.$("extension-device-label").value, "Unsaved device"); assert.equal(ui.$("extension-device-state").textContent, "Unsaved changes");
  ui.setConfirm(false); await ui.navigate("home"); assert.equal(ui.$("page-extensions").hidden, false);
  assert.equal(ui.calls.filter(call => call.method).length, 1);
});
test("setup copy respects confirmation and reports clipboard failure without writes", async t => {
  const ui = await uiFixture(t); ui.extensionState.device.data.extensionId = "a".repeat(32); await ui.navigate("extensions");
  ui.setConfirm(false); await ui.$("extension-copy-setup").fire("click"); assert.deepEqual(ui.clipboard, []);
  ui.setConfirm(true); navigator.clipboard.writeText = async () => { throw new Error("Permission denied"); };
  await ui.$("extension-copy-setup").fire("click"); assert.match(ui.$("extension-notice").textContent, /Clipboard copy failed/); assert.equal(ui.calls.some(call => call.method), false);
});
test("Extension Studio navigation keeps its direct URL consistent when entering and leaving", async t => {
  const ui = await uiFixture(t); window.location = { pathname: "/", search: "", hash: "" };
  window.history = { replaceState(state, title, url) { window.location.pathname = url; } };
  await ui.navigate("extensions"); assert.equal(window.location.pathname, "/extension-studio");
  await ui.navigate("home"); assert.equal(window.location.pathname, "/");
});

test("extension Save buttons track each loaded scope, reverted edits and successful saves", async t => {
  const ui = await uiFixture(t); await ui.navigate("extensions");
  for (const scope of ["device", "preferences"]) {
    assert.equal(ui.$(`extension-${scope}-save`).disabled, true);
    await ui.$(`extension-${scope}-form`).fire("submit");
  }
  assert.equal(ui.calls.some(call => call.method), false);
  ui.$("extension-device-label").value = "New label"; await ui.$("extension-device-form").fire("input");
  assert.equal(ui.$("extension-device-save").disabled, false); assert.equal(ui.$("extension-preferences-save").disabled, true);
  ui.$("extension-device-label").value = ""; await ui.$("extension-device-form").fire("input");
  assert.equal(ui.$("extension-device-save").disabled, true); assert.equal(ui.$("extension-device-state").textContent, "Not configured");
  ui.$("extension-confirm-copy").checked = false; await ui.$("extension-preferences-form").fire("change");
  assert.equal(ui.$("extension-preferences-save").disabled, false);
  ui.$("extension-confirm-copy").checked = true; await ui.$("extension-preferences-form").fire("change");
  assert.equal(ui.$("extension-preferences-save").disabled, true);
  ui.setConfirm(false); await ui.navigate("home"); assert.equal(ui.$("page-home").hidden, false);
  await ui.navigate("extensions"); ui.$("extension-device-label").value = "Saved label"; await ui.$("extension-device-form").fire("input");
  await ui.$("extension-device-form").fire("submit"); assert.equal(ui.$("extension-device-save").disabled, true);
  await ui.$("extension-device-form").fire("submit"); assert.equal(ui.calls.filter(call => call.method).length, 1);
  ui.$("extension-device-label").value = "Another label"; await ui.$("extension-device-form").fire("input");
  ui.setConflict(true); await ui.$("extension-device-form").fire("submit"); assert.equal(ui.$("extension-device-save").disabled, false);
  ui.$("extension-device-label").value = "Saved label"; await ui.$("extension-device-form").fire("input");
  assert.equal(ui.$("extension-device-save").disabled, true);
});

test("candidate Save stays disabled without a change, including reverted assignments, and remains retryable after failure", async t => {
  const ui = await uiFixture(t, true, true); await ui.$("edit-active-candidate").fire("click");
  assert.equal(ui.$("save-candidate").disabled, true); await ui.$("candidate-form").fire("submit");
  assert.equal(ui.calls.some(call => call.method), false);
  const name = ui.$("candidate-name"), original = name.value;
  name.value = "Changed synthetic name"; await name.fire("input"); assert.equal(ui.$("save-candidate").disabled, false);
  name.value = ` ${original} `; await name.fire("input"); assert.equal(ui.$("save-candidate").disabled, true);
  const design = ui.$("candidate-document-assignment"), before = design.value;
  design.value = "modern"; await design.fire("change"); assert.equal(ui.$("save-candidate").disabled, false);
  design.value = before; await design.fire("change"); assert.equal(ui.$("save-candidate").disabled, true);
  name.value = "Changed synthetic name"; await name.fire("input"); ui.setConflict(true); await ui.$("candidate-form").fire("submit");
  assert.match(ui.$("form-error").textContent, /Revision conflict/); assert.equal(ui.$("save-candidate").disabled, false);
  ui.setConflict(false); await ui.$("candidate-form").fire("submit"); assert.equal(ui.$("save-candidate").disabled, true);
  await pause(10); await ui.$("edit-active-candidate").fire("click"); assert.equal(ui.$("save-candidate").disabled, true);
  await ui.$("cancel-dialog").fire("click"); await ui.$("add-candidate").fire("click"); assert.equal(ui.$("save-candidate").disabled, true);
  ui.$("candidate-name").value = "New candidate draft"; await ui.$("candidate-name").fire("input"); assert.equal(ui.$("save-candidate").disabled, false);
});

test("profile Save compares visible values, handles empty optional fields and add/remove reversals, and resets after saving", async t => {
  const ui = await uiFixture(t); await ui.navigate("candidates"); assert.equal(ui.$("profile-save").disabled, true);
  await ui.$("profile-save").fire("click"); assert.equal(ui.calls.some(call => call.method), false);
  const notice = ui.$("profile-customAnswers-noticePeriod"), original = notice.value;
  notice.value = "Two weeks"; await notice.fire("input"); assert.equal(ui.$("profile-save").disabled, false);
  notice.value = original; await notice.fire("input"); assert.equal(ui.$("profile-save").disabled, true);
  const email = ui.$("profile-contact-email"), originalEmail = email.value;
  email.value = "changed@example.test"; await email.fire("input"); email.value = originalEmail; await email.fire("input");
  assert.equal(ui.$("profile-save").disabled, true);
  await ui.$("profile-add-links").fire("click"); assert.equal(ui.$("profile-save").disabled, false);
  await ui.$("profile-remove-links-0").fire("click"); assert.equal(ui.$("profile-save").disabled, true);
  ui.$("profile-contact-email").value = "changed@example.test"; await ui.$("profile-contact-email").fire("input");
  ui.setConflict(true); await ui.$("profile-save").fire("click"); assert.equal(ui.$("profile-save").disabled, false);
  ui.setConflict(false); await ui.$("profile-save").fire("click"); assert.equal(ui.$("profile-save").disabled, true);
  const count = ui.calls.filter(call => call.method).length; await ui.$("profile-save").fire("click"); assert.equal(ui.calls.filter(call => call.method).length, count);
});

test("an untouched missing profile cannot create an empty file via Save", async t => {
  const ui = await uiFixture(t, false); await ui.navigate("candidates");
  assert.equal(ui.$("profile-save").disabled, true); await ui.$("profile-save").fire("click"); assert.equal(ui.calls.some(call => call.method), false);
});

test("prompt Save detects reverted multiline edits and unchanged templates while allowing explicit duplication", async t => {
  const ui = await uiFixture(t);
  const template = { id: "prompt-one", name: "Synthetic prompt", description: "Example", category: "Resume", body: "First line\r\nSecond line\n", isDefault: false, archived: false, version: 1 };
  ui.state.prompts.data.templates.push(template); await ui.$("studio-refresh").fire("click"); await ui.navigate("prompts"); await ui.$("prompt-list").children[0].fire("click");
  assert.equal(ui.$("prompt-save").disabled, true); await ui.$("prompt-editor").fire("submit"); assert.equal(ui.calls.some(call => call.method), false);
  ui.$("prompt-body").value += "Edited"; await ui.$("prompt-body").fire("input"); await ui.$("prompt-editor").fire("input"); assert.equal(ui.$("prompt-save").disabled, false);
  ui.$("prompt-body").value = template.body; await ui.$("prompt-body").fire("input"); await ui.$("prompt-editor").fire("input"); assert.equal(ui.$("prompt-save").disabled, true);
  ui.$("prompt-archived").checked = true; await ui.$("prompt-editor").fire("change"); assert.equal(ui.$("prompt-save").disabled, false);
  ui.$("prompt-archived").checked = false; await ui.$("prompt-editor").fire("change"); assert.equal(ui.$("prompt-save").disabled, true);
  await ui.$("prompt-duplicate").fire("click"); assert.equal(ui.$("prompt-save").disabled, false);
  await ui.$("prompt-editor").fire("submit"); assert.equal(ui.$("prompt-save").disabled, true);
  assert.equal(ui.calls.find(call => call.method).body.data.body, template.body);
  await ui.$("prompt-editor").fire("submit"); assert.equal(ui.calls.filter(call => call.method).length, 1);
});

test("document Save tracks actual formatting defaults and reverted edits without modifying a template on view", async t => {
  const ui = await uiFixture(t);
  const record = { ...getBuiltInDocumentTemplates()[0], id: "custom-one", name: "Synthetic design", rendererVersion: 1, archived: false };
  ui.state.documents.templates.push(record); ui.state.documentCatalog.data.templates.push(record);
  await ui.$("studio-refresh").fire("click");
  await ui.navigate("documents"); await ui.$("document-gallery").children[2].children.at(-1).children[0].fire("click");
  assert.equal(ui.$("document-save").disabled, true); await ui.$("document-editor").fire("submit"); assert.equal(ui.calls.some(call => call.method), false);
  const size = ui.$("document-setting-bodyFontSize"), original = size.value;
  size.value = Number(original) + 1; await size.fire("input"); assert.equal(ui.$("document-save").disabled, false);
  size.value = original; await size.fire("input"); assert.equal(ui.$("document-save").disabled, true);
  ui.$("document-name").value += " edited"; await ui.$("document-editor").fire("input"); assert.equal(ui.$("document-save").disabled, false);
  ui.setConflict(true); await ui.$("document-editor").fire("submit"); assert.equal(ui.$("document-save").disabled, false);
  ui.setConflict(false); await ui.$("document-editor").fire("submit"); assert.equal(ui.$("document-save").disabled, true);
  const count = ui.calls.filter(call => call.method).length; await ui.$("document-editor").fire("submit"); assert.equal(ui.calls.filter(call => call.method).length, count);
});

test("Save is disabled during pending requests and duplicate submissions do not write twice", async t => {
  const ui = await uiFixture(t); await ui.navigate("extensions"); let release;
  ui.$("extension-device-label").value = "Pending save"; await ui.$("extension-device-form").fire("input");
  ui.$("extension-confirm-copy").checked = false; await ui.$("extension-preferences-form").fire("change");
  ui.setWriteGate(new Promise(resolve => { release = resolve; }));
  const savingDevice = ui.$("extension-device-form").fire("submit");
  assert.equal(ui.$("extension-device-save").disabled, true); assert.equal(ui.$("extension-preferences-save").disabled, true);
  await ui.$("extension-device-form").fire("submit"); assert.equal(ui.calls.filter(call => call.method).length, 1);
  release(); await savingDevice; ui.setWriteGate(null);
  assert.equal(ui.$("extension-device-save").disabled, true); assert.equal(ui.$("extension-preferences-save").disabled, false);
  await ui.navigate("candidates"); ui.$("profile-contact-email").value = "pending@example.test"; await ui.$("profile-contact-email").fire("input");
  ui.setWriteGate(new Promise(resolve => { release = resolve; }));
  const savingProfile = ui.$("profile-save").fire("click"); assert.equal(ui.$("profile-save").disabled, true);
  await ui.$("profile-save").fire("click"); assert.equal(ui.calls.filter(call => call.method).length, 2);
  release(); await savingProfile; ui.setWriteGate(null); assert.equal(ui.$("profile-save").disabled, true);
});
