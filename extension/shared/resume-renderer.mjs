import schema from "./data-contracts-v1.json" with { type: "json" };
import { createDataContracts, validateRenderInput, DataContractError } from "./data-contracts.mjs";
import { getBuiltInDocumentTemplates, validateDocumentSettings } from "./document-settings.mjs";

export { getBuiltInDocumentTemplates };
const contracts = createDataContracts(schema);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const present = value => typeof value === "string" && value.trim().length > 0;
let enginePromise;

export class PdfRenderError extends Error {
  constructor(message, options) { super(message, options); this.name = "PdfRenderError"; }
}
const requireValue = (condition, message) => { if (!condition) throw new PdfRenderError(message); };

function renderingContext(input, options) {
  requireValue(object(options) && Object.keys(options).length === 0, "Renderer options are reserved. Put supported formatting overrides in the rendering input.");
  validateRenderInput(contracts, input);
  const template = getBuiltInDocumentTemplates().find(item => item.layoutId === input.documentTemplate.layoutId);
  const shipped = getBuiltInDocumentTemplates().some(item => item.id === input.documentTemplate.id);
  requireValue(template && (shipped ? template.id === input.documentTemplate.id && input.documentTemplate.version === 1 : input.documentTemplate.rendererVersion === 1),
    "Unsupported document template or renderer version. Select a supported Classic or Modern configuration.");
  return { input, classic: template.id === "classic", settings: validateDocumentSettings(input.documentTemplate, input.formattingOverrides) };
}

function addressText(address) {
  return [address.line1, address.line2, address.city, address.state, address.postalCode, address.country].filter(present).join(", ");
}
function periodText(period) {
  return [period.start, period.current === true ? "Present" : period.end].filter(present).join(" - ");
}
function identityHeader(context, headline) {
  const { input, classic, settings } = context;
  const alignment = settings.headerAlignment;
  const nodes = [{ text: input.candidate.name, fontSize: settings.nameFontSize, bold: true,
    color: settings.nameColor, alignment, margin: [0, 0, 0, 4] }];
  const profile = input.profile;
  const contacts = [profile.contact.email, profile.contact.phone, addressText(profile.address)].filter(present);
  if (contacts.length) nodes.push({ text: contacts.join(" | "), alignment, fontSize: settings.contactFontSize, margin: [0, 0, 0, 3] });
  for (const link of profile.contact.links || []) {
    const text = [link.label, link.url].filter(present).join(": ");
    if (text) nodes.push({ text, alignment, fontSize: settings.contactFontSize, margin: [0, 0, 0, 2] });
  }
  if (headline !== undefined) nodes.push({ text: headline, alignment, fontSize: settings.titleFontSize, margin: [0, 5, 0, 2] });
  return nodes;
}
function sectionHeading(context, label) {
  const { settings, classic } = context;
  return {
    text: classic ? label.toUpperCase() : label, bold: true, headlineLevel: 1,
    color: settings.accentColor, fontSize: settings.headingFontSize,
    decoration: classic ? "underline" : undefined,
    background: classic ? undefined : "#F1F5F8",
    margin: [0, settings.sectionSpacing, 0, 6],
  };
}
function baseDefinition(context, title, content) {
  const { settings } = context;
  return {
    pageSize: "LETTER", pageOrientation: "portrait", pageMargins: [settings.pageMargin, settings.pageMargin, settings.pageMargin, settings.pageMargin],
    defaultStyle: { font: "Roboto", fontSize: settings.bodyFontSize, lineHeight: settings.lineHeight, color: settings.textColor },
    info: { title, subject: title, creator: "Resume Tailoring Studio", producer: "Resume Tailoring Studio / pdfmake 0.3.11",
      creationDate: new Date(0), modDate: new Date(0) },
    content,
    footer: settings.pageNumbers ? (page, total) => ({ text: `${page} / ${total}`, alignment: "right",
      font: "Roboto", fontSize: 8, color: "#555555", margin: [settings.pageMargin, 12, settings.pageMargin, 0] }) : undefined,
    pageBreakBefore(currentNode, nodeContainer) {
      // pdfmake 0.3 API: move a stranded heading only when content really follows
      // on another page. Never add a final page for an explicitly empty section.
      return Boolean(currentNode.headlineLevel && nodeContainer.getFollowingNodesOnPage().length === 0
        && nodeContainer.getNodesOnNextPage().length > 0);
    },
  };
}

export function buildResumeDocumentDefinition(renderInput, options = {}) {
  const context = renderingContext(renderInput, options);
  const { resume, profile, bindings } = renderInput;
  const content = [...identityHeader(context, resume.title)];
  if (context.settings.showSummary) content.push(sectionHeading(context, "Professional Summary"), { text: resume.summary, margin: [0, 0, 0, 2] });
  if (context.settings.showSkills) content.push(sectionHeading(context, "Skills"));
  for (const categories of context.settings.showSkills ? resume.skills : []) {
    for (const [category, skills] of Object.entries(categories)) {
      content.push({ text: [{ text: `${category}: `, bold: true }, { text: skills.join(", ") }], margin: [0, 0, 0, 5] });
    }
  }
  if (context.settings.showExperience) content.push(sectionHeading(context, "Professional Experience"));
  for (const [index, entry] of (context.settings.showExperience ? resume.experience : []).entries()) {
    // The shared validator checked every explicit ID. No name/position inference.
    const bound = profile.workExperience.find(item => item.id === bindings.experience[index]);
    content.push({ text: entry.title, bold: true, fontSize: context.settings.bodyFontSize + 0.5,
      headlineLevel: 2, margin: [0, index ? 9 : 0, 0, 2] });
    content.push({ text: entry.company, bold: !context.classic, margin: [0, 0, 0, 2] });
    const dates = periodText(bound.period), address = addressText(bound.address);
    if (dates) content.push({ text: dates, fontSize: context.settings.bodyFontSize - 0.5, margin: [0, 0, 0, 2] });
    if (address) content.push({ text: address, fontSize: context.settings.bodyFontSize - 0.5, margin: [0, 0, 0, 3] });
    content.push({ ul: entry.sentences.map(sentence => ({ text: sentence, margin: [0, 0, 0, 4] })), margin: [12, 2, 0, 2] });
  }
  if (context.settings.showEducation) content.push(sectionHeading(context, "Education"));
  for (const [index, entry] of (context.settings.showEducation ? resume.education : []).entries()) {
    const bound = profile.education.find(item => item.id === bindings.education[index]);
    content.push({ text: entry.degree, bold: true, headlineLevel: 2, margin: [0, index ? 7 : 0, 0, 2] });
    if (present(bound.university)) content.push({ text: bound.university, margin: [0, 0, 0, 2] });
    const dates = periodText(bound.period), address = addressText(bound.address);
    if (dates) content.push({ text: dates, fontSize: context.settings.bodyFontSize - 0.5, margin: [0, 0, 0, 2] });
    if (address) content.push({ text: address, fontSize: context.settings.bodyFontSize - 0.5, margin: [0, 0, 0, 2] });
  }
  // resume.company is deliberately absent: it identifies the target employer.
  return baseDefinition(context, "Resume", content);
}

export function buildCoverLetterDocumentDefinition(coverLetterInput, options = {}) {
  requireValue(object(coverLetterInput) && Object.keys(coverLetterInput).length === 2
    && Object.hasOwn(coverLetterInput, "renderInput") && Object.hasOwn(coverLetterInput, "coverLetter"),
    "Provide {renderInput, coverLetter} using the existing, separate contracts.");
  const { renderInput, coverLetter } = coverLetterInput;
  const context = renderingContext(renderInput, options);
  contracts.validateCoverLetter(coverLetter);
  requireValue(coverLetter.candidateId === renderInput.candidate.id, "Cover letter belongs to another candidate. Select the matching rendering input.");
  const content = identityHeader(context);
  coverLetter.paragraphs.forEach((paragraph, index) => content.push({ text: paragraph,
    margin: [0, index === 0 ? context.settings.sectionSpacing : 0, 0, context.settings.sectionSpacing] }));
  return baseDefinition(context, "Cover Letter", content);
}

async function loadEngine() {
  if (!enginePromise) {
    enginePromise = (async () => {
      // Official unmodified UMD assets: namespace.default is CommonJS in Node;
      // browser modules expose pdfMake on self/window. VFS auto-registers there.
      const bundle = await import("./vendor/pdfmake-0.3.11/pdfmake.min.js");
      const engine = bundle.default || globalThis.pdfMake;
      requireValue(engine && typeof engine.createPdf === "function" && typeof engine.addVirtualFileSystem === "function",
        "The official pdfmake 0.3.11 browser bundle did not initialize. Check the packaged assets and browser support.");
      const fonts = await import("./vendor/pdfmake-0.3.11/vfs_fonts.js");
      if (fonts.default) engine.addVirtualFileSystem(fonts.default);
      engine.setUrlAccessPolicy(() => false);
      return engine;
    })().catch(error => { enginePromise = undefined; throw new PdfRenderError("PDF engine could not load. Verify the local pdfmake 0.3.11 bundle, Roboto VFS, and browser policy.", { cause: error }); });
  }
  return enginePromise;
}

async function assertPdfBlob(blob) {
  requireValue(blob && blob.type === "application/pdf" && blob.size > 5 && typeof blob.arrayBuffer === "function"
    && typeof blob.slice === "function", "PDF generation returned an empty or invalid PDF Blob.");
  const signature = new Uint8Array(await blob.slice(0, 5).arrayBuffer());
  requireValue(String.fromCharCode(...signature) === "%PDF-", "PDF generation returned data without a PDF signature.");
}

export async function pdfBlobToBytes(blob) {
  try {
    await assertPdfBlob(blob);
    return new Uint8Array(await blob.arrayBuffer());
  } catch (error) {
    if (error instanceof PdfRenderError) throw error;
    throw new PdfRenderError("The PDF Blob could not be read. Regenerate the document before retrying.", { cause: error });
  }
}

async function renderDefinition(definition) {
  try {
    const engine = await loadEngine();
    const blob = await engine.createPdf(definition).getBlob();
    await assertPdfBlob(blob);
    return blob;
  } catch (error) {
    if (error instanceof PdfRenderError || error instanceof DataContractError) throw error;
    throw new PdfRenderError("PDF generation failed. Check the validated content, supported settings, and bundled Roboto files before retrying.", { cause: error });
  }
}

export async function renderResumePdfBlob(renderInput, options = {}) {
  return renderDefinition(buildResumeDocumentDefinition(renderInput, options));
}
export async function renderResumePdfBytes(renderInput, options = {}) {
  return pdfBlobToBytes(await renderResumePdfBlob(renderInput, options));
}
export async function renderCoverLetterPdfBlob(coverLetterInput, options = {}) {
  return renderDefinition(buildCoverLetterDocumentDefinition(coverLetterInput, options));
}
