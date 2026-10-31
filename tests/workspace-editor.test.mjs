import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { WorkspaceEditor, parseJobImport } from "../extension/studio/workspace-editor.mjs";
import { WorkspaceController } from "../extension/workspace.mjs";
import { bindWorkspace } from "../extension/studio/workspace-view.mjs";
import { contracts, fixture, domFixture } from "./extension-ui-fakes.mjs";

const resume = () => ({ company: "Unknown", title: "Engineer", summary: "Synthetic professional summary.",
  skills: [{ Engineering: ["Testing", "Design"] }], experience: [{ title: "Engineer", company: "Previous Employer", sentences: ["Delivered synthetic work."] }],
  education: [{ degree: "Bachelor of Example Studies" }] });
const jd = "  Build reliable systems.\nReview designs.\n\nKeep this ending.  \n";
const selected = "Company: Example Company\n\nJob URL: https://example.test/jobs/123\n\nJob Description:\n" + jd;
const noSelection = "Job URL: https://example.test/jobs/123\n\nJob Description:\n" + jd;
function model() {
  const f = fixture({ paired: true }); f.editor.activate(f.metadata()); return f;
}
async function screen(t) {
  const f = fixture({ paired: true }), dom = domFixture();
  class Controller extends WorkspaceController {
    constructor(options) { super({ ...options, setTimer: f.setTimer, clearTimer: f.clearTimer }); }
  }
  f.controller = bindWorkspace(Controller, { ...dom, auth: f.auth, editor: f.editor, now: () => f.now });
  Object.assign(f, dom); t.after(() => f.controller.dispose());
  await f.flush(); await f.controller.login(f.username, f.password); return f;
}
async function enter(f, id, value) { f.$(id).value = value; await f.$(id).fire("input"); }

test("selected-company hotkey import splits only its exact labels and preserves JD", () => {
  assert.deepEqual(parseJobImport(selected), { kind: "hotkey-company-jd-url", company: "Example Company",
    jobUrl: "https://example.test/jobs/123", jd, message: "Hotkey format detected. Review all three fields before applying." });
});
test("no-selection hotkey import has URL and JD without inventing company", () => {
  const parsed = parseJobImport(noSelection);
  assert.equal(parsed.kind, "hotkey-jd-url"); assert.equal(parsed.company, "");
  assert.equal(parsed.jobUrl, "https://example.test/jobs/123"); assert.equal(parsed.jd, jd);
});
test("plain JD remains exact, including leading/trailing whitespace", () => {
  const parsed = parseJobImport(jd); assert.equal(parsed.kind, "plain"); assert.equal(parsed.jd, jd);
  assert.equal(parsed.company, ""); assert.equal(parsed.jobUrl, "");
});
test("CRLF hotkey headers are recognized without rewriting the body", () => {
  const raw = selected.replaceAll("\n", "\r\n"); assert.equal(parseJobImport(raw).jd, jd.replaceAll("\n", "\r\n"));
});
test("malformed and unsupported metadata stays visible as complete ambiguous JD", () => {
  for (const raw of ["Company: Example\nJob URL: https://example.test\nJob Description:\nBody", "Preface\n\n" + selected,
    "Job URL: https://example.test\n\nUnknown label:\nBody", selected + "\n\n" + noSelection]) {
    const parsed = parseJobImport(raw); assert.equal(parsed.kind, "ambiguous"); assert.equal(parsed.jd, raw);
    assert.equal(parsed.company, ""); assert.equal(parsed.jobUrl, "");
  }
});
test("empty extracted JD and unusable URL are reported without fabrication or navigation", () => {
  const parsed = parseJobImport("Job URL: javascript:alert(1)\n\nJob Description:\n");
  assert.equal(parsed.jd, ""); assert.equal(parsed.jobUrl, "javascript:alert(1)");
  assert.match(parsed.message, /empty/); assert.match(parsed.message, /will not be opened/);
});
test("import review and cancel never mutate current draft fields", () => {
  const f = model(); f.editor.update("jd", "Existing original"); f.editor.openImport();
  f.editor.editImportSource(selected); f.editor.reviewImport();
  assert.equal(f.editor.snapshot().draft.jd, "Existing original");
  assert.equal(f.editor.snapshot().import.source, selected); f.editor.cancelImport();
  assert.equal(f.editor.snapshot().draft.jd, "Existing original"); assert.equal(f.editor.snapshot().import, null);
});
test("Apply updates reviewed JD metadata only and leaves CV/cover letter independent", () => {
  const f = model(); f.editor.update("cvJson", "not JSON"); f.editor.update("coverLetter", "Separate cover letter.");
  f.editor.openImport(); f.editor.editImportSource(selected); f.editor.reviewImport(); assert.equal(f.editor.applyImport(), true);
  const draft = f.editor.snapshot().draft;
  assert.equal(draft.jd, jd); assert.equal(draft.company, "Example Company");
  assert.equal(draft.cvJson, "not JSON"); assert.equal(draft.coverLetter, "Separate cover letter.");
});
test("existing nonempty JD or metadata cannot be overwritten without explicit confirmation", () => {
  const f = model(); f.editor.update("company", "Existing company"); f.editor.update("jd", "Original");
  f.editor.openImport(); f.editor.editImportSource(jd); f.editor.reviewImport();
  assert.equal(f.editor.snapshot().import.overwriteNeeded, true); assert.equal(f.editor.applyImport(), false);
  assert.equal(f.editor.snapshot().draft.company, "Existing company");
  f.editor.confirmOverwrite(true); assert.equal(f.editor.applyImport(), true);
  assert.equal(f.editor.snapshot().draft.company, ""); assert.equal(f.editor.snapshot().draft.jd, jd);
});
test("changing source, reviewed values or current fields invalidates overwrite acknowledgement", () => {
  const f = model(); f.editor.update("jd", "Old JD"); f.editor.openImport();
  f.editor.editImportSource(selected); f.editor.reviewImport(); f.editor.confirmOverwrite(true);
  f.editor.editReview("jd", "Edited review"); assert.equal(f.editor.applyImport(), false);
  f.editor.confirmOverwrite(true); f.editor.update("company", "Changed current metadata"); assert.equal(f.editor.applyImport(), false);
  f.editor.editImportSource("New source"); assert.equal(f.editor.snapshot().import.review, null);
});
test("review can be corrected explicitly without altering the pasted source", () => {
  const f = model(); f.editor.openImport(); f.editor.editImportSource(selected); f.editor.reviewImport();
  f.editor.editReview("company", "Reviewed Company"); f.editor.editReview("jd", "Reviewed JD");
  assert.equal(f.editor.snapshot().import.source, selected); f.editor.applyImport();
  assert.equal(f.editor.snapshot().draft.company, "Reviewed Company"); assert.equal(f.editor.snapshot().draft.jd, "Reviewed JD");
});
test("Copy JD copies the exact value without company, URL, labels or prompts", async () => {
  const f = model(); f.editor.update("company", "Metadata Company"); f.editor.update("jobUrl", "https://example.test"); f.editor.update("jd", jd);
  assert.equal(await f.editor.copy("jd"), true); assert.deepEqual(f.copies, [jd]);
});
test("clipboard rejection reports failure and never claims copy success", async () => {
  const f = model(); f.copyDenied = true; f.editor.update("jd", jd);
  assert.equal(await f.editor.copy("jd"), false); assert.equal(f.editor.snapshot().feedback.jd.kind, "error");
  assert.match(f.editor.snapshot().feedback.jd.message, /denied/); assert.deepEqual(f.copies, []);
});
test("opening, pasting, reviewing and applying never read or write clipboard automatically", () => {
  const f = model(); f.editor.openImport(); f.editor.editImportSource(selected); f.editor.reviewImport(); f.editor.applyImport();
  assert.deepEqual(f.copies, []);
});
test("valid six-field CV with Unknown is accepted without changing its raw text", () => {
  const f = model(), raw = " \n" + JSON.stringify(resume(), null, 4) + "\n\t";
  f.editor.update("cvJson", raw); assert.equal(f.editor.snapshot().validation.state, "valid");
  assert.equal(f.editor.snapshot().draft.cvJson, raw);
  assert.equal(f.editor.snapshot().draft.company, "");
});
test("syntax errors and duplicate JSON properties use the strict shared parser", () => {
  const f = model();
  for (const raw of ["{", '{"company":"one","company":"two"}', "[Summary]\nTagged content", "```json\n" + JSON.stringify(resume()) + "\n```"] ) {
    f.editor.update("cvJson", raw); assert.equal(f.editor.snapshot().validation.state, "invalid");
    assert.equal(f.editor.snapshot().draft.cvJson, raw); assert.equal(f.editor.snapshot().validation.issues[0].path, "/");
  }
});
test("semantic CV validation reports nested field paths and rejects extra metadata", () => {
  const f = model(), value = resume(); value.skills[0].Engineering = "Wrong type";
  value.experience[0].sentences = [12]; value.education[0] = {}; value.candidateId = "not-resume-content";
  f.editor.update("cvJson", JSON.stringify(value));
  const paths = f.editor.snapshot().validation.issues.map(issue => issue.path);
  for (const path of ["/skills/0/Engineering", "/experience/0/sentences/0", "/education/0/degree", "/candidateId"]) assert.ok(paths.includes(path));
});
test("CV empty and invalid states preserve exact input and remain independent of other sections", () => {
  const f = model(); f.editor.update("cvJson", "\n\t "); assert.equal(f.editor.snapshot().validation.state, "empty");
  assert.equal(f.editor.snapshot().draft.cvJson, "\n\t ");
  f.editor.update("cvJson", "{}"); assert.equal(f.editor.snapshot().validation.state, "invalid");
  f.editor.update("jd", jd); f.editor.update("coverLetter", "Independent"); assert.equal(f.editor.snapshot().validation.state, "invalid");
});
test("Copy JSON preserves invalid raw content without saving or repairing it", async () => {
  const f = model(), raw = "  {\"company\": 123}\n";
  f.editor.update("cvJson", raw); assert.equal(await f.editor.copy("cvJson"), true); assert.deepEqual(f.copies, [raw]);
});
test("cover-letter text copies exactly with invalid CV, empty JD and no jobId", async () => {
  const f = model(), text = "  Dear team,\n\nAccented résumé text.\n  ";
  f.editor.update("cvJson", "invalid"); f.editor.update("coverLetter", text);
  assert.equal(await f.editor.copy("coverLetter"), true); assert.deepEqual(f.copies, [text]);
  assert.equal(Object.hasOwn(f.editor.snapshot().draft, "jobId"), false);
});
test("empty optional cover letter causes no clipboard write and failure is independent", async () => {
  const f = model(); assert.equal(await f.editor.copy("coverLetter"), false); assert.deepEqual(f.copies, []);
  f.editor.update("coverLetter", "A letter"); f.copyDenied = true;
  assert.equal(await f.editor.copy("coverLetter"), false); assert.equal(f.editor.snapshot().draft.coverLetter, "A letter");
});
test("suspension hides DOM-facing values and exact verified context restores memory-only drafts", () => {
  const f = model(); f.editor.update("jd", jd); f.editor.update("coverLetter", "Private letter"); f.editor.suspend();
  assert.equal(f.editor.snapshot().active, false); assert.equal(f.editor.snapshot().draft.jd, "");
  assert.equal(JSON.stringify(f.editor).includes("Private letter"), false);
  f.editor.activate(f.metadata()); assert.equal(f.editor.snapshot().draft.jd, jd);
});
test("every owner, installation, candidate and revision boundary discards incompatible drafts", () => {
  for (const mutate of [m => m.user.id = "f".repeat(32), m => m.context.backendId = "f".repeat(32),
    m => m.context.workspaceId = "other-workspace", m => m.context.installationId = "f".repeat(32),
    m => m.context.bindingId = "f".repeat(32), m => m.context.candidate.id = "candidate-two",
    m => m.context.bindingRevision++, m => m.context.extensionOrigin = "chrome-extension://" + "b".repeat(32)]) {
    const f = model(); f.editor.update("jd", "Private draft"); f.editor.suspend();
    const metadata = f.metadata(); mutate(metadata); f.editor.activate(metadata);
    assert.equal(f.editor.snapshot().draft.jd, "");
  }
});
test("clear is irreversible even after another verified login with the same context", () => {
  const f = model(); f.editor.update("jd", jd); f.editor.clear(); f.editor.activate(f.metadata());
  assert.equal(f.editor.snapshot().draft.jd, "");
});
test("locked models reject editing, import and copy operations", async () => {
  const f = model(); f.editor.update("jd", jd); f.editor.suspend();
  assert.equal(f.editor.update("jd", "Unauthorized"), false); f.editor.openImport(); f.editor.reviewImport();
  assert.equal(f.editor.applyImport(), false); assert.equal(await f.editor.copy("jd"), false); assert.deepEqual(f.copies, []);
});
test("late clipboard completion cannot display success after logout or a newer edit", async () => {
  const f = model(); let release; f.copyGate = new Promise(resolve => release = resolve);
  f.editor.update("jd", jd); const pending = f.editor.copy("jd"); f.editor.clear(); release(); await pending;
  f.editor.activate(f.metadata()); assert.deepEqual(f.editor.snapshot().feedback, {});
  let second; f.copyGate = new Promise(resolve => second = resolve);
  f.editor.update("jd", "Old text"); const another = f.editor.copy("jd"); f.editor.update("jd", "New text"); second(); await another;
  assert.equal(f.editor.snapshot().feedback.jd, undefined);
});
test("packaged schema failure affects only validation and explicit retry can recover", async () => {
  const f = fixture({ paired: true }); let available = false;
  const editor = new WorkspaceEditor({ contractsLoader: async () => { if (!available) throw Error("Synthetic failure"); return contracts; }, clipboard: f.clipboard });
  editor.activate(f.metadata()); editor.update("cvJson", JSON.stringify(resume())); await editor.loadContracts();
  assert.equal(editor.snapshot().validation.state, "unavailable");
  editor.update("coverLetter", "Independent letter"); assert.equal(await editor.copy("coverLetter"), true);
  available = true; await editor.retryValidation(); assert.equal(editor.snapshot().validation.state, "valid");
});
test("late packaged schema loading cannot restore a cleared draft", async () => {
  const f = fixture({ paired: true }); let release;
  const editor = new WorkspaceEditor({ contractsLoader: () => new Promise(resolve => release = resolve) });
  editor.activate(f.metadata()); editor.update("cvJson", JSON.stringify(resume())); await f.flush();
  editor.clear(); release(contracts); await f.flush(); assert.equal(editor.snapshot().active, false);
  editor.activate(f.metadata()); assert.equal(editor.snapshot().draft.cvJson, "");
});
test("DOM import preview is explicit, editable and protected against overwrite", async t => {
  const f = await screen(t); await enter(f, "job-description", "Existing JD");
  await f.$("open-import").fire("click"); assert.equal(f.document.activeElement.id, "import-source");
  await enter(f, "import-source", selected); await f.$("review-import").fire("click");
  assert.equal(f.$("review-company").value, "Example Company"); assert.equal(f.$("review-url").value, "https://example.test/jobs/123");
  assert.equal(f.$("job-description").value, "Existing JD"); assert.equal(f.$("apply-import").disabled, true);
  f.$("import-overwrite").checked = true; await f.$("import-overwrite").fire("change");
  await f.$("apply-import").fire("click"); assert.equal(f.$("job-description").value, jd);
  assert.equal(f.$("import-panel").hidden, true); assert.equal(f.document.activeElement.id, "job-description");
});
test("DOM cancellation leaves the current JD untouched", async t => {
  const f = await screen(t); await enter(f, "job-description", jd); await f.$("open-import").fire("click");
  await enter(f, "import-source", "Different draft"); await f.$("review-import").fire("click"); await f.$("cancel-import").fire("click");
  assert.equal(f.$("job-description").value, jd); assert.equal(f.$("import-panel").hidden, true);
});
test("DOM copy actions read live textarea values and show success or clipboard denial", async t => {
  const f = await screen(t); f.$("job-description").value = jd; await f.$("copy-jd").fire("click"); await f.flush();
  assert.deepEqual(f.copies, [jd]); assert.match(f.$("copy-jd-status").textContent, /exact editor text/);
  await enter(f, "cv-json", "not JSON"); await enter(f, "cover-letter", "A separate letter"); f.copyDenied = true;
  await f.$("copy-cover-letter").fire("click"); await f.flush(); assert.match(f.$("copy-cover-letter-status").textContent, /denied/);
  assert.equal(f.controller.view.status, "authenticated");
});
test("DOM validation updates field errors without rewriting JSON or copying it", async t => {
  const f = await screen(t); const raw = "\n" + JSON.stringify(resume(), null, 2) + "\n";
  await enter(f, "cv-json", raw); assert.equal(f.$("cv-json").value, raw); assert.equal(f.$("cv-validation").dataset.state, "valid");
  await enter(f, "cv-json", '{"company":123}'); assert.equal(f.$("cv-validation").dataset.state, "invalid");
  assert.match(f.$("cv-errors").textContent, /\/title/); assert.match(f.$("cv-errors").textContent, /\/company/);
  await enter(f, "cv-json", ""); assert.equal(f.$("cv-validation").dataset.state, "empty"); assert.deepEqual(f.copies, []);
});
test("tab switching preserves all edits without draft writes or new backend requests", async t => {
  const f = await screen(t), before = JSON.stringify([f.storage.local.data, f.storage.session.data]), calls = f.calls.length;
  for (const [id, value] of [["job-company", "Company"], ["job-url", "https://example.test"], ["job-description", jd],
    ["cv-json", "Malformed raw JSON"], ["cover-letter", "Letter"]]) await enter(f, id, value);
  f.controller.selectTab("settings"); f.controller.selectTab("workspace");
  assert.equal(f.$("job-description").value, jd); assert.equal(f.$("cv-json").value, "Malformed raw JSON");
  assert.equal(f.$("cover-letter").value, "Letter"); assert.equal(f.calls.length, calls);
  assert.equal(JSON.stringify([f.storage.local.data, f.storage.session.data]), before);
});
test("backend unavailability clears protected DOM and same verified context restores eligible drafts", async t => {
  const f = await screen(t); await enter(f, "job-description", jd); await enter(f, "cover-letter", "Private draft");
  f.offline = true; await f.controller.boot();
  assert.equal(f.$("job-description").value, ""); assert.equal(f.$("cover-letter").value, "");
  assert.equal(f.$("copy-jd").disabled, true); assert.equal(f.controller.view.status, "disconnected");
  f.offline = false; await f.controller.boot(); assert.equal(f.$("job-description").value, jd);
});
test("expiration hides drafts until genuine owner reauthentication verifies the same scope", async t => {
  const f = await screen(t); await enter(f, "job-description", jd);
  f.now += 1800000; [...f.timers.values()].find(timer => timer.delay === 1800000).callback(); await f.flush();
  assert.equal(f.$("job-description").value, "");
  await f.controller.login(f.username, "wrong"); assert.equal(f.$("job-description").value, "");
  await f.controller.login(f.username, f.password); assert.equal(f.$("job-description").value, jd);
});
test("logout clears drafts immediately even if backend revocation cannot be confirmed", async t => {
  const f = await screen(t); await enter(f, "job-description", jd); await enter(f, "cover-letter", "Private letter");
  f.offline = true; const logout = f.controller.signOut();
  assert.equal(f.$("job-description").value, ""); await logout; f.offline = false;
  await f.controller.login(f.username, f.password); assert.equal(f.$("job-description").value, ""); assert.equal(f.$("cover-letter").value, "");
});
test("verified revocation discards old drafts without modifying candidate state", async t => {
  const f = await screen(t); await enter(f, "job-description", jd); f.revoked = true; await f.controller.boot();
  assert.equal(f.controller.view.status, "installation-revoked"); assert.equal(f.$("job-description").value, "");
  f.revoked = false; await f.controller.login(f.username, f.password); assert.equal(f.$("job-description").value, "");
});
test("candidate reassignment and acknowledgement never reveal another candidate's drafts", async t => {
  const f = await screen(t); await enter(f, "job-description", "Candidate A draft");
  f.bindingRevision = 2; f.candidateId = "candidate-two"; await f.controller.boot();
  assert.equal(f.$("job-description").value, ""); await f.controller.login(f.username, f.password);
  await f.controller.acknowledge(f.controller.view.metadata.context);
  assert.equal(f.$("job-description").value, ""); assert.equal(f.$("candidate-name").textContent, "Candidate: Blake Synthetic");
});
test("another page's session change conservatively discards drafts", async t => {
  const f = await screen(t); await enter(f, "job-description", jd); await f.makeAuth().logout(); await f.flush();
  assert.equal(f.$("job-description").value, ""); await f.controller.login(f.username, f.password);
  assert.equal(f.$("job-description").value, "");
});
test("refresh creates a new empty memory draft even with a restored authorized session", async t => {
  const f = await screen(t); await enter(f, "job-description", jd); f.controller.dispose();
  const dom = domFixture();
  class Controller extends WorkspaceController { constructor(options) { super({ ...options, setTimer: f.setTimer, clearTimer: f.clearTimer }); } }
  const editor = new WorkspaceEditor({ contracts, clipboard: f.clipboard });
  const next = bindWorkspace(Controller, { ...dom, auth: f.makeAuth(), editor }); t.after(() => next.dispose());
  await f.flush(); assert.equal(next.view.status, "authenticated"); assert.equal(dom.$("job-description").value, "");
});
test("the editor has no persistence, filesystem, native messaging or automatic clipboard-read interfaces", async () => {
  for (const path of ["../extension/studio/workspace-editor.mjs", "../extension/studio/workspace-editor-view.mjs"]) {
    const source = await readFile(new URL(path, import.meta.url), "utf8");
    assert.equal(/chrome\.storage|localStorage|indexedDB|sendNativeMessage|connectNative|showDirectoryPicker|showSaveFilePicker|clipboard\.read/.test(source), false);
  }
});
