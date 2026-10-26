import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import vm from "node:vm";
import { createDataContracts, buildRenderInput, validateRenderInput, DataContractError } from "../extension/shared/data-contracts.mjs";
import { getBuiltInDocumentTemplates, buildResumeDocumentDefinition, buildCoverLetterDocumentDefinition,
  renderResumePdfBlob, renderResumePdfBytes, renderCoverLetterPdfBlob, pdfBlobToBytes, PdfRenderError } from "../extension/shared/resume-renderer.mjs";

const schema = JSON.parse(await readFile(new URL("../extension/shared/data-contracts-v1.json", import.meta.url), "utf8"));
const fixture = JSON.parse(await readFile(new URL("./fixtures/resume-data.json", import.meta.url), "utf8"));
const contracts = createDataContracts(schema);
const vendor = new URL("../extension/shared/vendor/pdfmake-0.3.11/", import.meta.url);
function input(layout = "classic", overrides = {}, mutate = () => {}) {
  const f = structuredClone(fixture);
  const documents = { schemaVersion: 1, templates: getBuiltInDocumentTemplates() };
  mutate(f, documents);
  return buildRenderInput(contracts, { registry: f.registry, candidateId: "candidate-one", profile: f.profile,
    resume: f.resume, documents, documentTemplate: { id: layout, version: 1 }, bindings: f.bindings, formattingOverrides: overrides });
}
function texts(value) {
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, entry]) => typeof entry === "function" ? []
    : key === "text" && typeof entry === "string" ? [entry] : texts(entry));
}
function pdfStructure(bytes) {
  const binary = Buffer.from(bytes).toString("latin1");
  assert.equal(binary.startsWith("%PDF-"), true);
  assert.match(binary.slice(-32), /%%EOF/);
  assert.match(binary, /\/MediaBox\s*\[0 0 612 792\]/);
  const pages = binary.split(/\d+ 0 obj/).find(object => /\/Type\s*\/Pages\b/.test(object));
  assert.ok(pages, "PDF must contain a page-tree dictionary");
  const count = Number(/\/Count\s+(\d+)/.exec(pages)?.[1]);
  assert.ok(count >= 1);
  assert.match(binary, /Roboto/);
  assert.match(binary, /\/FontFile2/);
  return { binary, count };
}

test("vendor hashes pin the exact official package assets and retain licenses", async () => {
  const manifest = JSON.parse(await readFile(new URL("vendor-manifest.json", vendor), "utf8"));
  assert.equal(manifest.version, "0.3.11");
  assert.equal(manifest.tarball, "https://registry.npmjs.org/pdfmake/-/pdfmake-0.3.11.tgz");
  assert.equal(manifest.shasum, "b4504d19b8f31fa5063dc1b847b060faa4f7c5bb");
  const pinned = { "pdfmake.min.js": "faaee53f8dcf48b0934553665809d8180e20e435b654f633df2f18f9dbdeaa88",
    "vfs_fonts.js": "1483ed267fe00ad90a3834441b019d856dd41ed079b2614404b2fcef425db6fc" };
  for (const file of manifest.files) {
    const bytes = await readFile(new URL(file.path, vendor));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256);
    if (file.bytes !== undefined) assert.equal(bytes.length, file.bytes);
    if (pinned[file.path]) assert.equal(file.sha256, pinned[file.path]);
  }
  assert.match(await readFile(new URL("LICENSE.pdfmake.txt", vendor), "utf8"), /The MIT License/);
  assert.match(await readFile(new URL("LICENSE.Roboto.txt", vendor), "utf8"), /SIL OPEN FONT LICENSE Version 1.1/);
});

test("built-in templates are independent in-memory defaults, not persisted records", () => {
  const templates = getBuiltInDocumentTemplates();
  assert.deepEqual(templates.map(item => item.id), ["classic", "modern"]);
  templates[0].defaultSettings.bodyFontSize = 99;
  assert.equal(getBuiltInDocumentTemplates()[0].defaultSettings.bodyFontSize, 10.5);
});
test("resume definition includes registry identity, explicit contact, headline and every content section", () => {
  const value = input("classic", {}, f => {
    f.registry.candidates[0].name = "Zoë Álvarez";
    f.profile.contact.phone = "555-0100";
    f.profile.contact.links = [{ label: "Portfolio", url: "https://example.test/zoe" }];
    f.profile.address = { line1: "1 Example Street", city: "Example City" };
    f.resume.skills.push({ Analysis: ["Modeling"], Planning: ["Review"] });
  });
  const before = structuredClone(value), definition = buildResumeDocumentDefinition(value), printed = texts(definition).join("\n");
  for (const expected of ["Zoë Álvarez", "alex@example.test", "555-0100", "1 Example Street", "Portfolio: https://example.test/zoe",
    value.resume.title, value.resume.summary, "Engineering: ", "Testing, Design", "Analysis: ", "Planning: ", "Example Employer", value.resume.education[0].degree])
    assert.ok(printed.includes(expected), expected);
  assert.deepEqual(value, before);
  assert.equal(definition.pageSize, "LETTER");
});
test("only explicit profile bindings supply employment and education details", () => {
  const value = input("classic", {}, f => {
    f.profile.workExperience.unshift({ ...structuredClone(f.profile.workExperience[0]), id: "unrelated-work", period: { start: "1900" } });
    f.profile.education.unshift({ ...structuredClone(f.profile.education[0]), id: "unrelated-school", university: "Unrelated University", period: { start: "1800" } });
  });
  const printed = texts(buildResumeDocumentDefinition(value)).join("\n");
  assert.match(printed, /2020-01 - Present/);
  assert.match(printed, /Example University/);
  assert.match(printed, /2015 - 2019/);
  for (const excluded of ["1900", "1800", "Unrelated University"]) assert.equal(printed.includes(excluded), false);
});
test("missing optional profile fields do not fabricate dates, address or contacts", () => {
  const value = input("classic", {}, f => {
    f.profile.contact = {}; f.profile.address = {};
    f.profile.workExperience[0].period = {}; f.profile.workExperience[0].address = {};
    f.profile.education[0].period = {}; f.profile.education[0].address = {}; f.profile.education[0].university = "";
  });
  const printed = texts(buildResumeDocumentDefinition(value)).join("\n");
  for (const excluded of ["Present", "2020", "2015", "University", "undefined", "@", "555"]) assert.equal(printed.includes(excluded), false);
});
test("target company stays out of resume content and generated strings remain literal text", () => {
  const value = input("modern", {}, f => {
    f.resume.company = "TARGET COMPANY NOT AN EMPLOYER";
    f.resume.summary = "<script>alert('literal')</script> & <img src='https://example.test/pixel'>";
    f.resume.experience[0].sentences = ["<b>Literal experience.</b>", "Second sentence."];
  });
  const before = structuredClone(value), definition = buildResumeDocumentDefinition(value), printed = texts(definition).join("\n");
  assert.equal(printed.includes(value.resume.company), false);
  assert.ok(printed.includes(value.resume.summary));
  assert.deepEqual(definition.content.find(node => node.ul).ul.map(item => item.text), value.resume.experience[0].sentences);
  assert.deepEqual(value, before);
  assert.equal(JSON.stringify(definition).includes('"svg"'), false);
  assert.equal(JSON.stringify(definition).includes('"image"'), false);
  assert.equal(JSON.stringify(definition).includes('"link"'), false);
});
test("empty validated arrays still have visible section headings", () => {
  const value = input("classic", {}, f => {
    for (const field of ["skills", "experience", "education"]) f.resume[field] = [];
    f.bindings = { experience: [], education: [] };
  });
  const printed = texts(buildResumeDocumentDefinition(value)).join("\n");
  for (const section of ["SKILLS", "PROFESSIONAL EXPERIENCE", "EDUCATION"]) assert.match(printed, new RegExp(section));
});
test("renderer reuses shared envelope and resume validation before rendering", async () => {
  for (const mutate of [value => delete value.profile, value => value.schemaVersion = 2,
    value => value.resumeContractVersion = 2, value => value.candidate.name = "", value => value.resume.summary = "",
    value => value.profile.candidateId = "other", value => value.bindings.experience = ["missing"]]) {
    const value = input(); mutate(value);
    assert.throws(() => buildResumeDocumentDefinition(value), DataContractError);
    await assert.rejects(renderResumePdfBlob(value), DataContractError);
  }
});
test("Classic and Modern have visibly distinct header, margins and section styling", () => {
  const classic = buildResumeDocumentDefinition(input("classic")), modern = buildResumeDocumentDefinition(input("modern"));
  assert.equal(classic.content[0].alignment, "center"); assert.equal(modern.content[0].alignment, "left");
  assert.notEqual(classic.content[0].fontSize, modern.content[0].fontSize);
  assert.notDeepEqual(classic.pageMargins, modern.pageMargins);
  assert.notEqual(classic.content.find(node => node.headlineLevel === 1).decoration,
    modern.content.find(node => node.headlineLevel === 1).decoration);
});
test("every supported override affects actual document settings without changing defaults", () => {
  const value = input("modern", { bodyFontSize: 12, pageMargin: 60, sectionSpacing: 20, accentColor: "#123456", pageNumbers: false });
  const definition = buildResumeDocumentDefinition(value);
  assert.equal(definition.defaultStyle.fontSize, 12);
  assert.deepEqual(definition.pageMargins, [60, 60, 60, 60]);
  const heading = definition.content.find(node => node.headlineLevel === 1);
  assert.equal(heading.margin[1], 20); assert.equal(heading.color, "#123456");
  assert.equal(definition.footer, undefined);
  assert.equal(value.documentTemplate.defaultSettings.bodyFontSize, 10.5);
  const numbered = buildResumeDocumentDefinition(input());
  assert.equal(numbered.footer(2, 5).text, "2 / 5");
});
test("unsupported and invalid settings, capability changes, template IDs and versions fail", () => {
  for (const overrides of [{ bodyFontSize: 8 }, { bodyFontSize: Infinity }, { bodyFontSize: true }, { pageMargin: 73 },
    { sectionSpacing: 0 }, { accentColor: "red" }, { accentColor: "#ffffff\n" }, { pageNumbers: 1 }, { fontSize: 12 }])
    assert.throws(() => input("classic", overrides), DataContractError);
  assert.throws(() => input("classic", {}, (f, documents) => documents.templates[0].supportedSettings.bodyFontSize.maximum = 99), DataContractError);
  for (const change of [{ id: "unknown" }, { layoutId: "unknown" }, { version: 2 }]) {
    const value = input(); Object.assign(value.documentTemplate, change);
    assert.throws(() => buildResumeDocumentDefinition(value), /Unsupported|unsupported|configuration/);
  }
  assert.throws(() => buildResumeDocumentDefinition(input(), { unusedOption: true }), PdfRenderError);
});
test("metadata is deterministic and excludes candidate identity, target company and prompt data", () => {
  const definition = buildResumeDocumentDefinition(input());
  assert.equal(definition.info.title, "Resume");
  assert.equal(definition.info.creationDate.getTime(), 0);
  assert.equal(definition.info.modDate.getTime(), 0);
  assert.equal(Object.hasOwn(definition.info, "author"), false);
  assert.equal(JSON.stringify(definition.info).includes("Alex Example"), false);
});
test("orphan-heading guard uses the 0.3 API and never moves a final empty heading", () => {
  const callback = buildResumeDocumentDefinition(input()).pageBreakBefore;
  assert.equal(callback({ headlineLevel: 1 }, { getFollowingNodesOnPage: () => [], getNodesOnNextPage: () => [{}] }), true);
  assert.equal(callback({ headlineLevel: 1 }, { getFollowingNodesOnPage: () => [], getNodesOnNextPage: () => [] }), false);
});
test("cover letter uses the separate contract and supplied paragraphs without invented content", () => {
  const renderInput = input(), coverLetter = structuredClone(fixture.coverLetter);
  coverLetter.paragraphs = ["Literal <b>letter</b>.", "A second supplied paragraph."];
  const printed = texts(buildCoverLetterDocumentDefinition({ renderInput, coverLetter })).join("\n");
  for (const paragraph of coverLetter.paragraphs) assert.ok(printed.includes(paragraph));
  for (const excluded of ["Dear", "Sincerely", "1970", "job-one", "Company", "Systems Engineer"]) assert.equal(printed.includes(excluded), false);
  assert.throws(() => buildCoverLetterDocumentDefinition({ renderInput, coverLetter: { ...coverLetter, candidateId: "other" } }), /another candidate/);
  assert.throws(() => buildCoverLetterDocumentDefinition({ renderInput, coverLetter: { ...coverLetter, paragraphs: [] } }), DataContractError);
});

test("pinned browser bundle generates PDF Blob, bytes, Letter pages and embedded Roboto without network", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("Unexpected network request"); };
  try {
    const value = input("classic", {}, f => f.registry.candidates[0].name = "Zoë Álvarez"), before = structuredClone(value);
    const blob = await renderResumePdfBlob(value);
    assert.equal(blob.type, "application/pdf"); assert.ok(blob.size > 1000);
    const bytes = await pdfBlobToBytes(blob);
    assert.ok(bytes instanceof Uint8Array);
    assert.deepEqual(bytes, new Uint8Array(await blob.arrayBuffer()));
    assert.ok(pdfStructure(bytes).count >= 1);
    assert.deepEqual(value, before);
    const separatelyGenerated = await renderResumePdfBytes(value);
    assert.deepEqual(separatelyGenerated, bytes, "Fixed input and metadata should produce the same document bytes");
  } finally { globalThis.fetch = previousFetch; }
});
test("Modern and a long synthetic resume generate distinct, multi-page PDF output", async () => {
  const classic = await renderResumePdfBytes(input("classic")), modern = await renderResumePdfBytes(input("modern"));
  assert.notDeepEqual(classic, modern);
  const value = input("modern", {}, f => {
    f.resume.summary = "Long synthetic summary with accented résumé text. ".repeat(60);
    f.resume.skills = [{ Engineering: Array.from({ length: 120 }, (_, index) => `Synthetic skill ${index}`) }];
    f.resume.experience[0].sentences = Array.from({ length: 90 }, (_, index) => `Synthetic item ${index}: ` + "Long experience description and tested wrapping. ".repeat(5));
  });
  const bytes = await renderResumePdfBytes(value);
  assert.ok(pdfStructure(bytes).count > 1, "Page-tree count proves multiple pages, not visual correctness");
});
test("separate cover-letter PDF returns a real Blob distinct from the resume", async () => {
  const renderInput = input("modern"), coverLetter = structuredClone(fixture.coverLetter);
  const blob = await renderCoverLetterPdfBlob({ renderInput, coverLetter });
  assert.equal(blob.type, "application/pdf");
  const bytes = await pdfBlobToBytes(blob), structure = pdfStructure(bytes);
  const titleReference = /\/Title (\d+) 0 R/.exec(structure.binary);
  assert.ok(titleReference && new RegExp(`(?:^|\\n)${titleReference[1]} 0 obj\\s*\\(Cover Letter\\)`).test(structure.binary),
    "The PDF title reference must point to the separate cover-letter title");
  assert.notDeepEqual(bytes, await renderResumePdfBytes(renderInput));
});
test("Blob conversion and vendor generation failures reject instead of reporting success", async () => {
  for (const blob of [null, new Blob([], { type: "application/pdf" }), new Blob(["invalid"], { type: "application/pdf" }), new Blob(["%PDF-test"], { type: "text/plain" })])
    await assert.rejects(pdfBlobToBytes(blob), PdfRenderError);
  await assert.rejects(pdfBlobToBytes({ type: "application/pdf", size: 10, arrayBuffer: async () => new ArrayBuffer(10) }), PdfRenderError);
  await assert.rejects(pdfBlobToBytes({ type: "application/pdf", size: 10,
    slice: () => ({ arrayBuffer: async () => { throw new Error("Synthetic read failure"); } }), arrayBuffer: async () => new ArrayBuffer(10) }), /could not be read/);
  const OriginalBlob = globalThis.Blob;
  try {
    globalThis.Blob = class { constructor() { throw new Error("Synthetic Blob failure"); } };
    await assert.rejects(renderResumePdfBlob(input()), /PDF generation failed/);
  } finally { globalThis.Blob = OriginalBlob; }
});
test("unmodified browser globals initialize and generate bytes with string/Wasm code generation disabled", async () => {
  const context = vm.createContext({ Blob, TextEncoder, TextDecoder, URL, setTimeout, clearTimeout,
    setInterval, clearInterval, queueMicrotask,
    navigator: { userAgent: "Synthetic test sandbox" },
    fetch: () => { throw new Error("Network is forbidden"); },
    XMLHttpRequest: function () { throw new Error("Network is forbidden"); },
  }, { codeGeneration: { strings: false, wasm: false } });
  vm.runInContext("globalThis.self = globalThis; globalThis.window = globalThis;", context);
  vm.runInContext(await readFile(new URL("pdfmake.min.js", vendor), "utf8"), context);
  vm.runInContext(await readFile(new URL("vfs_fonts.js", vendor), "utf8"), context);
  const blob = await vm.runInContext("pdfMake.setUrlAccessPolicy(() => false); pdfMake.createPdf({pageSize:'LETTER', content:['Synthetic accented résumé.']}).getBlob()", context);
  assert.equal(blob.type, "application/pdf");
  pdfStructure(await pdfBlobToBytes(blob));
});
