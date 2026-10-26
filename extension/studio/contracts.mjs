// Browser-side readers for the version-1 contracts in tracker_config/models.py.
// These functions validate data; they never open paths or change records.
import { validateDocumentSettings, getBuiltInDocumentTemplates } from "../shared/document-settings.mjs";
export class AccessError extends Error {
  constructor(code, message) { super(message); this.name = "AccessError"; this.code = code; }
}

export function requireValue(condition, message, code = "configuration-invalid") {
  if (!condition) throw new AccessError(code, message);
}
const object = (value, label) => {
  requireValue(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object.`);
  return value;
};
const text = (value, label, nonempty = false) => {
  requireValue(typeof value === "string" && (!nonempty || value.trim().length > 0), `${label} must be ${nonempty ? "nonempty " : ""}text.`);
  return value;
};
export function identifier(value, label = "ID") {
  text(value, label);
  requireValue(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value), `${label} must be a safe stable identifier.`);
  return value;
}
const version = (value, label) => requireValue(value.schemaVersion === 1, `${label} has an unsupported schema version; expected 1.`);
const fields = (record, names, label) => {
  for (const name of names) if (Object.hasOwn(record, name)) text(record[name], `${label}.${name}`);
};
const allowed = (record, names, label) => requireValue(Object.keys(record).every(key => names.includes(key)), `${label} contains unsupported fields.`);
const strings = (value, label) => {
  requireValue(Array.isArray(value), `${label} must be an array.`);
  value.forEach(item => text(item, label));
};
const records = (value, label) => {
  requireValue(Array.isArray(value), `${label} must be an array.`);
  const seen = new Set();
  for (const record of value) {
    object(record, label); identifier(record.id, `${label}.id`);
    requireValue(!seen.has(record.id), `${label} contains a duplicate ID.`); seen.add(record.id);
  }
  return value;
};

// Unicode caseless comparison without locale-dependent collation or accent folding.
// Keep dotless i distinct; uppercase sharp S needs an extra expansion.
export function nameKey(value) {
  return value.trim().split("\u0131").map(part => part.toUpperCase().toLowerCase().replaceAll("ß", "ss")).join("\u0131");
}

export function normalizeReference(reference) {
  text(reference, "Configured file reference", true);
  // Verbatim Windows namespaces have different normalization rules. Keep exact
  // strings rather than merging them with ordinary drive/UNC references.
  if (/^\\\\[?.]\\/.test(reference)) return ["verbatim", reference];
  const path = reference.replaceAll("\\", "/");
  let root, rest;
  if (/^[A-Za-z]:\//.test(path)) { root = path.slice(0, 2).toUpperCase(); rest = path.slice(3); }
  else if (path.startsWith("//")) {
    const parts = path.slice(2).split("/");
    requireValue(parts[0] && parts[1], "A UNC reference must include a server and share.");
    root = `//${parts.shift()}/${parts.shift()}`; rest = parts.join("/");
  } else if (path.startsWith("/")) { root = "/"; rest = path.slice(1); }
  else throw new AccessError("configuration-invalid", "An absolute configured file reference is required.");
  const parts = [];
  for (const part of rest.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") { requireValue(parts.length > 0, "File reference escapes its root."); parts.pop(); }
    else parts.push(part);
  }
  // Preserve component case, Unicode, and trailing characters: Windows can have
  // case-sensitive directories. Distinct references must not share a handle.
  return [root, ...parts];
}
export function promptMappingKey(scope, reference) {
  identifier(scope, "Configuration scope");
  return JSON.stringify(["prompt", scope, normalizeReference(reference)]);
}
export const referenceFilename = reference => reference.replaceAll("\\", "/").split("/").at(-1);
export function templateParts(reference) {
  text(reference, "promptTemplate", true);
  const parts = reference.replaceAll("\\", "/").split("/").filter(part => part && part !== ".");
  requireValue(!/^(?:[A-Za-z]:|[\\/])/.test(reference) && parts.length >= 2 && parts[0] === "templates" && !parts.includes(".."), "promptTemplate must reference a file under templates/.");
  return parts;
}

export function validateRegistry(value) {
  object(value, "Candidate registry"); version(value, "Candidate registry");
  const candidates = records(value.candidates, "candidates");
  requireValue(Object.hasOwn(value, "activeCandidateId"), "Candidate registry requires activeCandidateId.");
  const identities = new Set(), histories = new Set();
  for (const candidate of candidates) {
    text(candidate.name, "Candidate name", true);
    requireValue([...candidate.name.trim()].length <= 100, "Candidate name must be 1–100 characters.");
    requireValue(typeof candidate.extensionId === "string" && /^[a-p]{32}$/.test(candidate.extensionId), "Invalid candidate extensionId.");
    const history = JSON.stringify(normalizeReference(candidate.historyFolder)).toLowerCase();
    requireValue(!histories.has(history), "Duplicate candidate historyFolder."); histories.add(history);
    const identity = JSON.stringify([candidate.extensionId, nameKey(candidate.name)]);
    requireValue(!identities.has(identity), "Duplicate candidate name and extensionId."); identities.add(identity);
    if (candidate.promptFilePath) {
      normalizeReference(candidate.promptFilePath);
      requireValue(/\.(txt|md)$/i.test(candidate.promptFilePath), "promptFilePath must reference a .txt or .md file.");
    } else templateParts(candidate.promptTemplate);
    for (const field of ["assignedPromptTemplateId", "preferredDocumentTemplateId"])
      if (candidate[field] !== undefined && candidate[field] !== null) identifier(candidate[field], field);
  }
  requireValue(value.activeCandidateId === null || (typeof value.activeCandidateId === "string" && candidates.some(candidate => candidate.id === value.activeCandidateId)), "activeCandidateId does not reference an existing candidate.");
  return value;
}

const addressFields = ["line1", "line2", "city", "state", "postalCode", "country"];
function address(value, label) { object(value, label); fields(value, addressFields, label); }
function period(value, label) {
  object(value, label); fields(value, ["start", "end"], label);
  if (Object.hasOwn(value, "current")) requireValue(typeof value.current === "boolean", `${label}.current must be boolean.`);
}
export function isoDate(value) {
  // Calendar/basic/week dates are accepted by Python's date.fromisoformat.
  const match = /^(?:(\d{4})-(\d{2})-(\d{2})|(\d{4})(\d{2})(\d{2}))$/.exec(value);
  const week = /^(?:(\d{4})-W(\d{2})(?:-([1-7]))?|(\d{4})W(\d{2})([1-7])?)$/.exec(value);
  if (!match && !week) return null;
  const year = Number((match || week)[1] || (match || week)[4]);
  if (year < 1) return null;
  const date = new Date(0); date.setUTCFullYear(year, 0, week ? 4 : 1); date.setUTCHours(0, 0, 0, 0);
  if (week) {
    const number = Number(week[2] || week[5]), day = Number(week[3] || week[6] || 1);
    const januaryFirst = new Date(date); januaryFirst.setUTCDate(1);
    const weekday = januaryFirst.getUTCDay() || 7;
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    if (number < 1 || number > (weekday === 4 || (weekday === 3 && leap) ? 53 : 52)) return null;
    date.setUTCDate(4 - (date.getUTCDay() || 7) + 1 + (number - 1) * 7 + day - 1);
    return date.getUTCFullYear() >= 1 && date.getUTCFullYear() <= 9999 ? date : null;
  }
  const month = Number(match[2] || match[5]), day = Number(match[3] || match[6]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  if (!(month >= 1 && month <= 12 && day >= 1 && day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1])) return null;
  date.setUTCFullYear(year, month - 1, day); return date;
}
export function validateProfile(value, candidateId) {
  object(value, "Profile"); version(value, "Profile"); identifier(value.candidateId, "profile.candidateId");
  requireValue(value.candidateId === candidateId, "Profile candidateId does not match its filename.");
  const extension = item => {
    if (item && typeof item === "object") for (const [key, child] of Object.entries(item)) {
      requireValue(!["password", "passwords", "credential", "credentials", "accesstoken", "refreshtoken", "secret"].includes(key.toLowerCase()), `Profile credential field '${key}' is unsupported.`);
      extension(child);
    } else requireValue(item === null || ["string", "boolean", "number"].includes(typeof item) && (typeof item !== "number" || Number.isFinite(item)), "Profile extensions must be finite JSON values.");
  };
  extension(value);
  for (const key of ["personal", "contact", "address", "customAnswers", "preferences"]) object(value[key], `profile.${key}`);
  fields(value.personal, ["birthday", "headline", "summary"], "profile.personal");
  if (value.personal.birthday) requireValue(Boolean(isoDate(value.personal.birthday)), "profile.personal.birthday must be an ISO date.");
  fields(value.contact, ["email", "phone"], "profile.contact");
  if (Object.hasOwn(value.contact, "links")) {
    requireValue(Array.isArray(value.contact.links), "Contact links must be an array.");
    for (const link of value.contact.links) { object(link, "Contact link"); text(link.label, "Link label"); text(link.url, "Link URL"); }
  }
  address(value.address, "profile.address");
  for (const work of records(value.workExperience, "workExperience")) {
    text(work.company, "work.company"); text(work.title, "work.title"); period(work.period, "work.period"); address(work.address, "work.address"); strings(work.highlights, "work.highlights");
  }
  for (const school of records(value.education, "education")) {
    for (const key of ["university", "degree", "major"]) text(school[key], `education.${key}`);
    period(school.period, "education.period"); address(school.address, "education.address");
  }
  requireValue(Array.isArray(value.skills), "Skills must be an array.");
  for (const skill of value.skills) { object(skill, "Skill group"); text(skill.category, "Skill category"); strings(skill.items, "Skill items"); }
  for (const certification of records(value.certifications, "certifications")) {
    text(certification.name, "Certification name"); fields(certification, ["issuer", "issuedOn", "expiresOn", "credentialUrl"], "Certification");
  }
  fields(value.customAnswers, ["reasonForLeaving", "noticePeriod"], "Custom answers");
  if (Object.hasOwn(value.customAnswers, "prompts")) for (const prompt of records(value.customAnswers.prompts, "Custom prompts")) text(prompt.text, "Custom prompt text");
  if (Object.hasOwn(value.customAnswers, "answers")) for (const answer of records(value.customAnswers.answers, "Custom answers")) { text(answer.question, "Custom answer question", true); text(answer.answer, "Custom answer text"); }
  fields(value.preferences, ["startDate"], "Preferences");
  return value;
}
function timestamp(value, label) {
  text(value, label, true);
  const match = /^(\d{4}(?:-\d{2}-\d{2}|\d{4}|-W\d{2}(?:-[1-7])?|W\d{2}[1-7]?))[\s\S](.+?)(Z|[+-]\d{2}(?:(?::?\d{2})(?::?\d{2})?)?(?:[.,]\d+)?)$/u.exec(value);
  const invalid = () => { throw new AccessError("configuration-invalid", `${label} must be an ISO timestamp with a timezone.`); };
  if (!match) return invalid();
  const date = isoDate(match[1]); if (!date) return invalid();
  const time = source => {
    const part = /^(\d{2}(?::\d{2}(?::\d{2})?|\d{2}(?:\d{2})?)?)(?:[.,](\d+))?$/.exec(source);
    if (!part) return invalid();
    const digits = part[1].replaceAll(":", ""), hour = Number(digits.slice(0, 2)), minute = Number(digits.slice(2, 4) || 0), second = Number(digits.slice(4, 6) || 0);
    if (hour > 23 || minute > 59 || second > 59) return invalid();
    return BigInt(hour * 3600 + minute * 60 + second) * 1_000_000n + BigInt((part[2] || "").padEnd(6, "0").slice(0, 6));
  };
  const local = time(match[2]);
  const offset = match[3] === "Z" ? 0n : time(match[3].slice(1)) * (match[3][0] === "-" ? -1n : 1n);
  return BigInt(date.getTime()) * 1000n + local - offset;
}
export function validateCatalog(value, kind) {
  object(value, `${kind} catalog`); version(value, `${kind} catalog`);
  let defaults = 0;
  for (const template of records(value.templates, `${kind} templates`)) {
    text(template.name, "Template name", true); text(template.description, "Template description");
    requireValue(Number.isInteger(template.version) && template.version >= 1, "Template version must be a positive integer.");
    if (kind === "prompt") {
      text(template.body, "Prompt body", true); fields(template, ["category"], "Prompt");
      for (const key of ["isDefault", "archived"]) requireValue(typeof template[key] === "boolean", `Prompt ${key} must be boolean.`);
      requireValue(!(template.isDefault && template.archived), "An archived prompt cannot be the default."); defaults += Number(template.isDefault);
      const created = timestamp(template.createdAt, "createdAt"), updated = timestamp(template.updatedAt, "updatedAt");
      requireValue(updated >= created, "updatedAt must not precede createdAt.");
    } else {
      identifier(template.layoutId, "layoutId");
      if (Object.hasOwn(template, "rendererVersion")) requireValue(template.rendererVersion === 1, "Unsupported document rendererVersion; expected 1.");
      if (Object.hasOwn(template, "archived")) requireValue(typeof template.archived === "boolean", "document.archived must be boolean.");
      for (const key of ["supportedSettings", "defaultSettings"]) object(template[key], key);
      try { validateDocumentSettings(template); }
      catch (error) { throw new AccessError("configuration-invalid", error.message); }
      if (Object.hasOwn(template, "thumbnail")) {
        object(template.thumbnail, "Thumbnail"); allowed(template.thumbnail, ["reference", "generatedAt", "templateVersion"], "Thumbnail"); fields(template.thumbnail, ["reference"], "Thumbnail");
        if (Object.hasOwn(template.thumbnail, "generatedAt")) timestamp(template.thumbnail.generatedAt, "thumbnail.generatedAt");
        if (Object.hasOwn(template.thumbnail, "templateVersion")) requireValue(Number.isInteger(template.thumbnail.templateVersion) && template.thumbnail.templateVersion >= 1, "Thumbnail version must be a positive integer.");
      }
    }
  }
  requireValue(defaults <= 1, "Prompt catalog may have only one default template.");
  return value;
}
export function validateReferences(candidate, prompts, documents) {
  for (const [field, catalog] of [["assignedPromptTemplateId", prompts], ["preferredDocumentTemplateId", documents]]) {
    if (candidate[field] === null || candidate[field] === undefined) continue;
    const template = catalog.templates.find(item => item.id === candidate[field])
      || (field === "preferredDocumentTemplateId" ? getBuiltInDocumentTemplates().find(item => item.id === candidate[field]) : null);
    requireValue(template && !template.archived, `${field} references a missing or archived template.`);
  }
}

export function parseConfigurationJson(source, label) {
  let value;
  try { value = JSON.parse(source); } catch { throw new AccessError("configuration-invalid", `${label} is not valid JSON.`); }
  // JSON.parse validates syntax first. Walk its original text to reject duplicate
  // object properties, which JSON.parse alone would silently discard.
  let at = 0;
  const space = () => { while (/\s/.test(source[at] || "") && at < source.length) at++; };
  const string = () => {
    const start = at++;
    while (source[at] !== '"') { if (source[at] === "\\") at++; at++; }
    at++; return JSON.parse(source.slice(start, at));
  };
  const scan = () => {
    space();
    if (source[at] === "{") {
      at++; space(); const keys = new Set();
      if (source[at] !== "}") while (true) {
        space(); const key = string();
        requireValue(!keys.has(key), `${label} contains duplicate JSON properties.`); keys.add(key);
        space(); at++; scan(); space(); if (source[at] !== ",") break; at++;
      }
      at++;
    } else if (source[at] === "[") {
      at++; space(); if (source[at] !== "]") while (true) { scan(); space(); if (source[at] !== ",") break; at++; } at++;
    } else if (source[at] === '"') string();
    else while (at < source.length && !/[\s,\]}]/.test(source[at])) at++;
  };
  scan();
  const finite = item => {
    if (typeof item === "number") requireValue(Number.isFinite(item), `${label} contains a nonfinite number.`);
    else if (item && typeof item === "object") Object.values(item).forEach(finite);
  };
  finite(value); return value;
}
