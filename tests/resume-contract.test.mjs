import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createDataContracts, loadDataContracts, DataContractError, RESUME_CONTRACT_VERSION,
  companyNamingStatus, resumeWarnings, buildRenderInput } from "../extension/shared/data-contracts.mjs";

const schema = JSON.parse(await readFile(new URL("../extension/shared/data-contracts-v1.json", import.meta.url), "utf8"));
const fixture = JSON.parse(await readFile(new URL("./fixtures/resume-data.json", import.meta.url), "utf8"));
const contracts = createDataContracts(schema);
const data = () => structuredClone(fixture);
function invalid(kind, value, path) {
  assert.throws(() => contracts.validate(kind, value), error => error instanceof DataContractError && error.issues.some(issue => issue.path === path));
}
const renderOptions = () => {
  const f = data();
  return { ...f, candidateId: "candidate-one", documentTemplate: { id: "document-one", version: 1 } };
};

test("reference resume retains exactly its content fields and verbatim Unicode text", () => {
  const value = data().resume;
  value.summary = "  Exact résumé\r\n<script>text only</script>  ";
  const before = structuredClone(value);
  assert.equal(contracts.validateResume(value), value);
  assert.deepEqual(contracts.parse("resume", JSON.stringify(value)), before);
  assert.deepEqual(value, before);
  assert.equal(RESUME_CONTRACT_VERSION, 1);
  assert.equal(Object.hasOwn(value, "schemaVersion"), false);
});
test("one fenced response and raw JSON work; prose, multiple blocks and legacy tags fail", () => {
  const source = JSON.stringify(data().resume);
  for (const response of [source, "\n```json\n" + source + "\n```\n", "```\r\n" + source + "\r\n```"])
    assert.deepEqual(contracts.parseResumeResponse(response), data().resume);
  for (const response of ["prose\n```json\n" + source + "\n```", "```json\n" + source + "\n```\nextra",
    "```json\n" + source + "\n```\n```json\n" + source + "\n```", "<resume>legacy</resume>"])
    assert.throws(() => contracts.parseResumeResponse(response), DataContractError);
});
test("malformed JSON, duplicate properties and nonfinite numbers are never repaired", () => {
  for (const source of ["{", '{"company":"A","company":"B"}', '{"company":NaN}', '{"company":1e400}', "null", "[]"])
    assert.throws(() => contracts.parse("resume", source), DataContractError);
});
test("every required resume field reports its own path when absent", () => {
  for (const field of Object.keys(data().resume)) {
    const value = data().resume; delete value[field]; invalid("resume", value, `/${field}`);
  }
});
test("wrong types and blank text are rejected, including non-ASCII whitespace", () => {
  for (const [field, value] of [["company", null], ["title", 42], ["summary", "\u0085\ufeff"], ["skills", {}], ["experience", "text"], ["education", false]])
    invalid("resume", { ...data().resume, [field]: value }, `/${field}`);
  invalid("resume", { ...data().resume, company: "\ud800" }, "/company");
});
test("skill-category structures validate names, arrays and every skill with escaped pointers", () => {
  for (const [skills, path] of [[[{}], "/skills/0"], [[{ " ": ["Skill"] }], "/skills/0/ "],
    [[{ Category: "Skill" }], "/skills/0/Category"], [[{ Category: [] }], "/skills/0/Category"],
    [[{ "A/B~C": [false] }], "/skills/0/A~1B~0C/0"]]) invalid("resume", { ...data().resume, skills }, path);
  contracts.validateResume({ ...data().resume, skills: [{ One: ["Skill"], Two: ["Another"] }] });
});
test("experience and education objects require complete nonblank entries", () => {
  invalid("resume", { ...data().resume, experience: [{}] }, "/experience/0/title");
  invalid("resume", { ...data().resume, experience: [{ title: "Role", company: "Employer", sentences: [""] }] }, "/experience/0/sentences/0");
  invalid("resume", { ...data().resume, education: [{}] }, "/education/0/degree");
  invalid("resume", { ...data().resume, education: [{ degree: "Degree", university: "Profile data" }] }, "/education/0/university");
});
test("empty sections warn without enforcing prompt-specific counts, employers or sentence lengths", () => {
  const value = { ...data().resume, skills: [], experience: [], education: [] };
  contracts.validateResume(value);
  assert.equal(resumeWarnings(contracts, value).length, 3);
  value.experience = [{ title: "Any level", company: "Any employer", sentences: ["Short.", "Long ".repeat(300)] }];
  contracts.validateResume(value);
});
test("Unknown is structurally valid and filesystem usability is a separate decision", () => {
  contracts.validateResume({ ...data().resume, company: "Unknown" });
  assert.equal(companyNamingStatus("Unknown").usable, true);
  assert.equal(resumeWarnings(contracts, { ...data().resume, company: "Unknown" })[0].code, "company-unknown");
  for (const company of ["A/B", "CON", "nul.txt", "COM¹", "Trailing.", "Trailing ", "😀".repeat(128)]) {
    const value = { ...data().resume, company };
    contracts.validateResume(value);
    assert.equal(companyNamingStatus(company).requiresManualEntry, true);
    assert.equal(resumeWarnings(contracts, value)[0].code, "company-folder");
    assert.equal(value.company, company);
  }
  for (const company of [null, "", "  "]) assert.equal(companyNamingStatus(company).requiresManualEntry, true);
});
test("profile, metadata, formatting and cover-letter additions cannot enter generated resume JSON", () => {
  for (const field of ["schemaVersion", "candidateId", "contact", "job", "documentTemplate", "formattingOverrides", "coverLetter"])
    invalid("resume", { ...data().resume, [field]: "unsupported" }, `/${field}`);
});
test("job metadata has its own version, original JD and optional template provenance", () => {
  const value = data().job, before = structuredClone(value);
  contracts.validateJobRecord(value);
  assert.deepEqual(value, before);
  for (const field of ["sourceUrl", "promptTemplate", "documentTemplate"]) delete value[field];
  contracts.validateJobRecord(value);
  for (const [field, entry, path] of [["schemaVersion", 2, "/schemaVersion"], ["schemaVersion", true, "/schemaVersion"],
    ["createdAt", "2026-02-30T00:00:00Z", "/createdAt"], ["createdAt", "2026-01-01T00:00:00+01:60", "/createdAt"],
    ["id", "../escape", "/id"], ["candidateId", "CON", "/candidateId"], ["sourceUrl", "javascript:alert(1)", "/sourceUrl"],
    ["promptTemplate", { id: "prompt", version: 0 }, "/promptTemplate/version"], ["clipboardText", "combined text", "/clipboardText"],
    ["resume", data().resume, "/resume"]]) invalid("job", { ...value, [field]: entry }, path);
});
test("cover-letter paragraphs are separate text with explicit candidate/job association", () => {
  const value = data().coverLetter;
  value.paragraphs[0] = "<script>literal text</script>";
  contracts.validateCoverLetter(value);
  invalid("coverLetter", { ...value, paragraphs: [] }, "/paragraphs");
  invalid("coverLetter", { ...value, paragraphs: [""] }, "/paragraphs/0");
  invalid("coverLetter", { ...value, schemaVersion: 2 }, "/schemaVersion");
  invalid("coverLetter", { ...value, resume: data().resume }, "/resume");
});
test("render input uses registry identity and explicit profile bindings with independent snapshots", () => {
  const options = renderOptions(), before = structuredClone(options);
  const result = buildRenderInput(contracts, options);
  assert.deepEqual(result.candidate, { id: "candidate-one", name: "Alex Example" });
  assert.equal(result.profile.workExperience[0].period.start, "2020-01");
  assert.deepEqual(result.resume, options.resume);
  result.profile.contact.email = "independent@example.test";
  assert.deepEqual(options, before);
});
test("render input rejects cross-candidate profiles, unresolved bindings, stale templates and unsupported overrides", () => {
  for (const changes of [{ candidateId: "missing" }, { profile: { ...data().profile, candidateId: "other" } },
    { bindings: { experience: [], education: ["education-one"] } },
    { bindings: { experience: ["missing"], education: ["education-one"] } },
    { documentTemplate: { id: "document-one", version: 2 } }, { documentTemplate: { id: "document-one", version: true } },
    { formattingOverrides: { fontSize: 12 } }, { formattingOverrides: null }])
    assert.throws(() => buildRenderInput(contracts, { ...renderOptions(), ...changes }), DataContractError);
});
test("shared definitions load only on request, using a packaged relative resource", async () => {
  const loaded = await loadDataContracts(async url => {
    assert.equal(url.pathname.endsWith("/extension/shared/data-contracts-v1.json"), true);
    return { ok: true, json: async () => schema };
  });
  loaded.validateResume(data().resume);
  await assert.rejects(loadDataContracts(async () => ({ ok: false })), /could not be loaded/);
  assert.throws(() => createDataContracts({ $id: "unsupported" }), /Unsupported/);
  const broken = structuredClone(schema); broken.$defs.resume.unknownKeyword = true;
  assert.throws(() => createDataContracts(broken).validateResume(data().resume), /Unsupported contract keyword/);
});
