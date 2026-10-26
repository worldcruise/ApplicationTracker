// One browser implementation for both UIs. No application data is loaded here.
import { parseConfigurationJson, validateRegistry, validateProfile, validateCatalog, identifier } from "../studio/contracts.mjs";
import { validateDocumentSettings } from "./document-settings.mjs";

export const RESUME_CONTRACT_VERSION = 1;
export class DataContractError extends Error {
  constructor(issues) {
    super(issues.map(issue => `${issue.path || "/"}: ${issue.message}`).join("\n"));
    this.name = "DataContractError";
    this.issues = issues;
  }
}
const issue = (path, code, message) => ({ path, code, message });
const fail = (path, code, message) => { throw new DataContractError([issue(path, code, message)]); };
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const pointer = (path, key) => `${path}/${String(key).replaceAll("~", "~0").replaceAll("/", "~1")}`;
const device = value => /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/i.test(value);
const trim = value => value.replace(/^[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+|[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+$/gu, "");

function validTimestamp(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return false;
  const [, y, m, d, h, minute, s, zone] = match;
  const year = Number(y), month = Number(m), day = Number(d);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return year >= 1 && month >= 1 && month <= 12 && day >= 1
    && day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
    && Number(h) <= 23 && Number(minute) <= 59 && Number(s) <= 59
    && (zone === "Z" || (Number(zone.slice(1, 3)) <= 23 && Number(zone.slice(4)) <= 59));
}
function validUrl(value) {
  // Deliberately restrict the shared contract to printable ASCII HTTP(S) URLs.
  // Encode international hostnames/paths before recording them; never repair here.
  if (!/^https?:\/\/[\x21-\x7e]+$/.test(value) || /[\\<>"`{}|^]/.test(value)) return false;
  const match = /^https?:\/\/(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(?::([0-9]{1,5}))?([/?#][\x21-\x7e]*)?$/u.exec(value);
  if (!match || (match[2] && Number(match[2]) > 65535) || /%(?![0-9A-Fa-f]{2})/u.test(value)) return false;
  const host = match[1];
  if (host.startsWith("[")) {
    try { new URL(`http://${host}/`); return true; } catch { return false; }
  }
  return host.length <= 253 && host.replace(/\.$/u, "").split(".").every(part => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u.test(part));
}

// A deliberately bounded evaluator for the checked-in schema vocabulary, not a
// general JSON Schema implementation. Unknown authoring keywords fail closed.
export function createDataContracts(schema) {
  if (schema?.$id !== "urn:resume-tailoring-studio:data-contracts:1") throw new Error("Unsupported data-contract definitions.");
  const keywords = new Set(["$ref", "type", "required", "properties", "additionalProperties", "minItems", "items", "minProperties", "propertyNames", "pattern", "minimum", "maximum", "const", "format"]);
  function check(value, rule, path, issues) {
    for (const key of Object.keys(rule)) if (!keywords.has(key)) throw new Error(`Unsupported contract keyword: ${key}`);
    if (rule.$ref) {
      if (!rule.$ref.startsWith("#/$defs/") || !Object.hasOwn(schema.$defs, rule.$ref.slice(8))) throw new Error("Invalid local contract reference.");
      return check(value, schema.$defs[rule.$ref.slice(8)], path, issues);
    }
    const validType = rule.type === "object" ? object(value) : rule.type === "array" ? Array.isArray(value)
      : rule.type === "integer" ? Number.isSafeInteger(value) : rule.type === "string" && typeof value === "string";
    if (!validType) { issues.push(issue(path, "type", `Expected ${rule.type}.`)); return; }
    const add = (code, message) => issues.push(issue(path, code, message));
    if (Object.hasOwn(rule, "const") && value !== rule.const) add("const", `Expected ${rule.const}.`);
    if (rule.type === "string") {
      if (!value.isWellFormed()) add("unicode", "Text must contain valid Unicode characters.");
      if (rule.pattern && !new RegExp(rule.pattern, "u").test(value)) add("pattern", "Text must be nonblank and match the documented field format.");
      if (rule.format === "stable-id" && (device(value) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/u.test(value) || /[^A-Za-z0-9_-]/u.test(value))) add("format", "Use a safe stable identifier, not a Windows device name.");
      if (rule.format === "date-time" && !validTimestamp(value)) add("format", "Use YYYY-MM-DDTHH:MM:SS[.ffffff]Z or a numeric timezone offset.");
      if (rule.format === "http-url" && !validUrl(value)) add("format", "Use an absolute ASCII HTTP(S) URL without credentials.");
    } else if (rule.type === "integer") {
      if (value < (rule.minimum ?? -Infinity) || value > (rule.maximum ?? Infinity)) add("range", "Integer is outside the supported range.");
    } else if (rule.type === "array") {
      if (value.length < (rule.minItems ?? 0)) add("empty", "Array must contain at least one entry.");
      value.forEach((entry, index) => check(entry, rule.items, pointer(path, index), issues));
    } else {
      if (Object.keys(value).length < (rule.minProperties ?? 0)) add("empty", "Object must contain at least one category.");
      for (const key of rule.required || []) if (!Object.hasOwn(value, key)) issues.push(issue(pointer(path, key), "required", "Required field is missing."));
      for (const [key, entry] of Object.entries(value)) {
        const entryPath = pointer(path, key);
        if (rule.propertyNames) check(key, rule.propertyNames, entryPath, issues);
        if (Object.hasOwn(rule.properties || {}, key)) check(entry, rule.properties[key], entryPath, issues);
        else if (rule.additionalProperties === false) issues.push(issue(entryPath, "unsupported", "Field is not part of this contract."));
        else if (object(rule.additionalProperties)) check(entry, rule.additionalProperties, entryPath, issues);
      }
    }
  }
  function validate(kind, value) {
    if (!["resume", "job", "coverLetter"].includes(kind)) throw new Error("Unknown data contract.");
    const issues = []; check(value, schema.$defs[kind], "", issues);
    if (issues.length) throw new DataContractError(issues);
    return value;
  }
  function parse(kind, source) {
    if (typeof source !== "string") fail("", "json", "Provide JSON text.");
    let value;
    try { value = parseConfigurationJson(source, "Input"); }
    catch { fail("", "json", "Invalid JSON: check syntax, duplicate properties, and finite numbers."); }
    return validate(kind, value);
  }
  return {
    validate, parse,
    validateResume: value => validate("resume", value),
    validateJobRecord: value => validate("job", value),
    validateCoverLetter: value => validate("coverLetter", value),
    validateTemplateReference(value) {
      const issues = []; check(value, schema.$defs.templateReference, "/documentTemplate", issues);
      if (issues.length) throw new DataContractError(issues);
      return value;
    },
    parseResumeResponse(source) {
      if (typeof source !== "string") fail("", "json", "Provide the JSON response as text.");
      const match = /^[ \t\r\n]*```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t\r\n]*$/.exec(source);
      // Raw JSON is also accepted for application imports. No prose extraction,
      // tagged-text adapter, quote repair, or alteration of content strings.
      return parse("resume", match ? match[1] : source);
    },
  };
}

export async function loadDataContracts(fetchResource = globalThis.fetch) {
  const response = await fetchResource(new URL("./data-contracts-v1.json", import.meta.url));
  if (!response.ok) throw new Error("Packaged data-contract definitions could not be loaded.");
  return createDataContracts(await response.json());
}

export function companyNamingStatus(value) {
  let reason = null;
  if (typeof value !== "string" || !trim(value)) reason = "Enter a company name.";
  else if (/[<>:"/\\|?*\u0000-\u001f]/.test(value) || /[. ]$/.test(value) || !value.isWellFormed()
    || value.length > 255 || device(value.split(".")[0].replace(/ +$/, ""))) reason = "Enter a company name usable as one Windows folder component.";
  return { usable: reason === null, requiresManualEntry: reason !== null, reason };
}

export function resumeWarnings(contracts, resume) {
  contracts.validateResume(resume);
  const warnings = [];
  const naming = companyNamingStatus(resume.company);
  if (!naming.usable) warnings.push(issue("/company", "company-folder", naming.reason));
  if (trim(resume.company).toLowerCase() === "unknown") warnings.push(issue("/company", "company-unknown", "Company is Unknown; confirm it before saving."));
  for (const key of ["skills", "experience", "education"]) if (!resume[key].length) warnings.push(issue(`/${key}`, "empty-section", "Section is empty; review document readiness."));
  return warnings;
}

export function validateRenderInput(contracts, input) {
  const keys = ["schemaVersion", "resumeContractVersion", "candidate", "profile", "resume", "documentTemplate", "formattingOverrides", "bindings"];
  if (!object(input) || keys.some(key => !Object.hasOwn(input, key)) || Object.keys(input).some(key => !keys.includes(key)))
    fail("", "type", "Provide the complete versioned rendering input from buildRenderInput.");
  if (input.schemaVersion !== 1 || input.resumeContractVersion !== RESUME_CONTRACT_VERSION)
    fail("/schemaVersion", "version", "Unsupported rendering input or resume contract version; expected 1.");
  const { candidate, profile, resume, documentTemplate, formattingOverrides, bindings } = input;
  const guard = (path, operation) => { try { operation(); } catch { fail(path, "configuration", "Provide a valid, associated configuration record."); } };
  guard("/candidate", () => {
    if (!object(candidate) || Object.keys(candidate).length !== 2 || typeof candidate.name !== "string" || !candidate.name.trim() || !candidate.name.isWellFormed()) throw new Error();
    identifier(candidate.id);
  });
  guard("/profile", () => validateProfile(profile, candidate.id));
  contracts.validateResume(resume);
  guard("/documentTemplate", () => validateCatalog({ schemaVersion: 1, templates: [documentTemplate] }, "document"));
  if (documentTemplate.archived) fail("/documentTemplate", "reference", "Select an available document template.");
  try { validateDocumentSettings(documentTemplate, formattingOverrides); }
  catch (error) { fail("/formattingOverrides", "unsupported", error.message); }
  if (!object(bindings) || Object.keys(bindings).some(key => !["experience", "education"].includes(key))) fail("/bindings", "reference", "Provide explicit experience and education profile-ID bindings.");
  for (const [section, profileSection] of [["experience", "workExperience"], ["education", "education"]]) {
    const ids = bindings[section];
    if (!Array.isArray(ids) || ids.length !== resume[section].length) fail(`/bindings/${section}`, "reference", "Bind every generated entry explicitly to a profile entry ID.");
    ids.forEach((id, index) => {
      if (typeof id !== "string" || !profile[profileSection].some(entry => entry.id === id)) fail(`/bindings/${section}/${index}`, "reference", "Profile entry ID is missing; resolve the association explicitly.");
    });
  }
  return input;
}

export function buildRenderInput(contracts, { registry, candidateId, profile, resume, documents, documentTemplate, bindings, formattingOverrides = {} }) {
  try { validateRegistry(registry); validateCatalog(documents, "document"); }
  catch { fail("/candidate", "configuration", "Provide a valid registry and document catalog."); }
  const candidate = registry.candidates.find(item => item.id === candidateId);
  if (!candidate) fail("/candidate/id", "reference", "Candidate is absent from the authoritative registry.");
  contracts.validateTemplateReference(documentTemplate);
  const selected = documents.templates.find(item => item.id === documentTemplate.id && item.version === documentTemplate.version && !item.archived);
  if (!selected) fail("/documentTemplate", "reference", "Select an available document template with its current version.");
  const input = { schemaVersion: 1, resumeContractVersion: RESUME_CONTRACT_VERSION,
    candidate: { id: candidate.id, name: candidate.name }, profile, resume,
    documentTemplate: selected, formattingOverrides, bindings };
  validateRenderInput(contracts, input);
  return structuredClone(input);
}
