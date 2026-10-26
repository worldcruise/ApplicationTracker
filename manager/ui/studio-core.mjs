// Pure Studio workflows and explicit browser effects. No persistence or startup IO.
import schema from "../../extension/shared/data-contracts-v1.json" with { type: "json" };
import { createDataContracts, buildRenderInput } from "../../extension/shared/data-contracts.mjs";
import { validateProfile, isoDate } from "../../extension/studio/contracts.mjs";
import { validateDocumentSettings } from "../../extension/shared/document-settings.mjs";

export const contracts = createDataContracts(schema);
export const normalizedText = value => value.replace(/\r\n|\r/g, "\n");
function rawOffset(text, normalizedOffset) {
  let at = 0, count = 0;
  while (at < text.length && count < normalizedOffset) { if (text[at] === "\r" && text[at + 1] === "\n") at++; at++; count++; }
  return at;
}
export function replaceTextRange(raw, start, end, inserted) {
  return raw.slice(0, rawOffset(raw, start)) + inserted + raw.slice(rawOffset(raw, end));
}
export function preserveTextEdits(raw, controlValue) {
  if (!raw) return controlValue;
  const before = normalizedText(raw), after = normalizedText(controlValue);
  if (before === after) return raw;
  let start = 0; while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0; while (end < before.length - start && end < after.length - start && before.at(-end - 1) === after.at(-end - 1)) end++;
  const newline = /\r\n|\r|\n/.exec(raw)?.[0] || "\n";
  return replaceTextRange(raw, start, before.length - end, after.slice(start, after.length - end).replaceAll("\n", newline));
}
export function composePrompt(body, jobDescription) {
  if (typeof body !== "string" || !body.trim()) throw new Error("The assigned prompt is empty.");
  if (typeof jobDescription !== "string" || !jobDescription.trim()) throw new Error("Enter the original job description first.");
  // This explicit, documented token is the only substitution syntax.
  return body.includes("{{JOB_DESCRIPTION}}") ? body.replaceAll("{{JOB_DESCRIPTION}}", () => jobDescription)
    : `${body}\n\nJob Description:\n${jobDescription}`;
}
export function promptStatus(candidate, catalog) {
  if (!candidate) return { label: "No candidate selected", usable: false };
  const id = candidate.assignedPromptTemplateId;
  if (!id) return { label: candidate.promptFilePath ? "Legacy linked prompt" : "Legacy stored prompt", usable: true };
  const template = catalog.templates.find(item => item.id === id);
  if (!template || template.archived) return { label: `Assigned prompt ${id} is ${template ? "archived" : "missing"}. Choose an active template or the legacy source.`, usable: false };
  return { label: `${template.name} · v${template.version}`, usable: true };
}
export function profileCompleteness(profile) {
  const fields = ["email", "phone"].map(key => [key, Boolean(profile?.contact?.[key]?.trim())]);
  fields.push(["address", Boolean(profile?.address?.line1?.trim())], ["career", Boolean(profile?.workExperience?.length)], ["education", Boolean(profile?.education?.length)]);
  return { completed: fields.filter(([, present]) => present).length, total: fields.length, missing: fields.filter(([, present]) => !present).map(([key]) => key) };
}
export function setProfileField(profile, path, value) {
  // All paths are application-defined; retain the rest of the original record.
  const copy = structuredClone(profile); let target = copy;
  for (const key of path.slice(0, -1)) target = target[key] ??= {};
  target[path.at(-1)] = value; return copy;
}
// Presentation only. The stored profile retains its established ISO contract.
export function birthdateToDisplay(value = "") {
  const date = isoDate(value);
  if (!date) return value;
  const [year, month, day] = date.toISOString().slice(0, 10).split("-");
  return `${month}/${day}/${year}`;
}
export function birthdateFromDisplay(value) {
  if (!value) return "";
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  const result = match && `${match[3]}-${match[1]}-${match[2]}`;
  if (!result || !isoDate(result)) throw new Error("Birthdate: enter a valid date as MM/DD/YYYY or choose it from the calendar.");
  return result;
}
export function formatAddress(address) {
  return [address.line1, address.line2, [address.city, address.state].filter(Boolean).join(", "), address.postalCode, address.country].filter(value => value?.trim()).join("\n");
}
export function safePdfFilename(candidate, company) {
  const component = value => {
    if (typeof value !== "string") return "";
    let safe = value.toWellFormed().replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().replace(/^[. ]+|[. ]+$/g, "");
    if (/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(safe)) safe = `_${safe}`;
    return safe;
  };
  const value = [component(candidate), component(company)].filter(Boolean).join(" - ") || "Resume";
  // Limit the whole filename, not each independent component. Avoid split surrogates.
  let limited = ""; for (const letter of value) { if (limited.length + letter.length > 180) break; limited += letter; }
  return `${limited.replace(/[. ]+$/, "")}.pdf`;
}
export function resumeInput({ registry, candidateId, profile, resumeText, documents, templateId, bindings, overrides = {} }) {
  const resume = contracts.parseResumeResponse(resumeText);
  validateProfile(profile, candidateId);
  const template = documents.templates.find(item => item.id === templateId && !item.archived);
  if (!template) throw new Error("Select an available document template.");
  validateDocumentSettings(template, overrides);
  return buildRenderInput(contracts, { registry, candidateId, profile, resume, documents,
    documentTemplate: { id: template.id, version: template.version }, bindings, formattingOverrides: overrides });
}

export class PdfPreview {
  constructor({ render, urls = URL, onChange = () => {} }) {
    this.render = render; this.urls = urls; this.onChange = onChange; this.generation = 0;
    this.url = null; this.blob = null;
  }
  clear(message = "Preview needs valid, current input.") {
    this.generation++;
    if (this.url) this.urls.revokeObjectURL(this.url);
    this.url = null; this.blob = null; this.onChange({ url: null, message });
  }
  async update(input) {
    this.clear("Rendering PDF…"); const generation = this.generation;
    try {
      const blob = await this.render(input);
      if (generation !== this.generation) return false;
      if (!(blob instanceof Blob) || blob.type !== "application/pdf" || !blob.size) throw new Error("Renderer did not return a nonempty PDF Blob.");
      this.blob = blob; this.url = this.urls.createObjectURL(blob);
      this.onChange({ url: this.url, message: "PDF ready. Download starts only when you click Download PDF." }); return true;
    } catch (error) {
      if (generation !== this.generation) return false;
      if (generation === this.generation) this.clear(`PDF rendering failed: ${error.message}`);
      throw error;
    }
  }
  download(filename, document) {
    if (!this.url || !this.blob) throw new Error("Generate a current valid preview before downloading.");
    const anchor = document.createElement("a"); anchor.href = this.url; anchor.download = filename;
    document.body.append(anchor);
    try { anchor.click(); } finally { anchor.remove(); }
  }
}
