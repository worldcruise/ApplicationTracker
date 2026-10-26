import {
  AccessError, parseConfigurationJson, requireValue, templateParts,
  validateRegistry, validateProfile, validateCatalog, validateReferences, promptMappingKey,
} from "./contracts.mjs";
import { validateHandle } from "./handles.mjs";

export const MAX_PROMPT_BYTES = 512_000;
export const MAX_CONFIGURATION_BYTES = 5 * 1024 * 1024;
const decoder = () => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const cancelled = error => error?.name === "AbortError";

export async function checkPermission(handle, mode) {
  let permission;
  try { permission = await handle.queryPermission({ mode }); }
  catch { throw new AccessError("handle-unavailable", "Saved access is unusable. Select the resource again."); }
  if (permission !== "granted") throw new AccessError(permission === "denied" ? "permission-denied" : "permission-renewal", permission === "denied"
    ? "Access is denied. Use Reconnect to request access, or select the resource again."
    : "Permission renewal is required. Use Reconnect to grant access.");
}

// Call directly from a click handler with an already retrieved handle. Do not
// await IndexedDB or other work before invoking the permission request.
export async function requestAccess(handle, mode) {
  let permission;
  try { permission = await handle.requestPermission({ mode }); }
  catch { throw new AccessError("permission-denied", "Access could not be renewed. Select the resource again."); }
  if (permission !== "granted") throw new AccessError("permission-denied", "Access was not granted. You can reconnect or select the resource again.");
}

async function digest(bytes) {
  const result = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(result), byte => byte.toString(16).padStart(2, "0")).join("");
}
async function bytesFromFile(file, limit, label, code) {
  requireValue(Number.isFinite(file.size) && file.size <= limit, `${label} exceeds the ${limit}-byte limit.`, code);
  let bytes;
  try { bytes = new Uint8Array(await file.arrayBuffer()); }
  catch { throw new AccessError(code, `${label} cannot be read. Refresh or select the resource again.`); }
  requireValue(bytes.byteLength <= limit, `${label} exceeds the ${limit}-byte limit.`, code);
  return bytes;
}
function decode(bytes, label, code) {
  try { return decoder().decode(bytes); }
  catch { throw new AccessError(code, `${label} must contain valid UTF-8 text.`); }
}

export async function readPromptFile(handle, { external = true } = {}) {
  validateHandle(handle, "file"); await checkPermission(handle, "read");
  let file;
  try { file = await handle.getFile(); }
  catch { throw new AccessError("prompt-unavailable", "The prompt file cannot be opened. Relink it or restore its permission."); }
  if (external) requireValue(/\.(txt|md)$/i.test(file.name), "Link an existing .txt or .md prompt file.", "prompt-invalid");
  const bytes = await bytesFromFile(file, MAX_PROMPT_BYTES, "Prompt file", "prompt-invalid");
  const body = decode(bytes, "Prompt file", "prompt-invalid");
  requireValue(body.trim().length > 0, "The prompt file is empty.", "prompt-invalid");
  return { body, filename: file.name, size: bytes.byteLength };
}

async function readConfigurationFile(directory, parts, optional = false) {
  let file;
  const label = parts.join("/");
  try {
    let parent = directory;
    for (const component of parts.slice(0, -1)) parent = await parent.getDirectoryHandle(component, { create: false });
    const handle = await parent.getFileHandle(parts.at(-1), { create: false });
    file = await handle.getFile();
  } catch (error) {
    if (error?.name === "NotFoundError") {
      if (optional) return null;
      throw new AccessError("configuration-missing", `${label} is missing. Select the existing configuration folder; Studio will not create a replacement.`);
    }
    throw new AccessError("configuration-unreadable", `${label} cannot be read. Reconnect or select the configuration folder again.`);
  }
  const bytes = await bytesFromFile(file, MAX_CONFIGURATION_BYTES, label, "configuration-invalid");
  return { text: decode(bytes, label, "configuration-invalid"), revision: await digest(bytes) };
}

export async function loadConfiguration(directory) {
  validateHandle(directory, "directory"); await checkPermission(directory, "readwrite");
  try { await directory.entries().next(); }
  catch { throw new AccessError("folder-invalid", "The selected folder is no longer accessible. Reconnect or select it again."); }
  const observations = [];
  const read = async (parts, optional = false) => {
    const file = await readConfigurationFile(directory, parts, optional);
    observations.push({ parts, optional, revision: file?.revision ?? null });
    return file;
  };
  const registryFile = await read(["candidates.json"]);
  const registry = validateRegistry(parseConfigurationJson(registryFile.text, "candidates.json"));
  const catalog = async (filename, kind) => {
    const file = await read([filename], true);
    return validateCatalog(file ? parseConfigurationJson(file.text, filename) : { schemaVersion: 1, templates: [] }, kind);
  };
  const prompts = await catalog("prompt-templates.json", "prompt");
  const documents = await catalog("document-templates.json", "document");
  const profiles = new Map();
  const referenceWarnings = new Map();
  for (const candidate of registry.candidates) {
    const file = await read(["profiles", `${candidate.id}.json`], true);
    profiles.set(candidate.id, file ? validateProfile(parseConfigurationJson(file.text, "Candidate profile"), candidate.id) : null);
    try { validateReferences(candidate, prompts, documents); }
    catch (error) {
      if (!(error instanceof AccessError) || error.code !== "configuration-invalid") throw error;
      // Assignment availability does not invalidate identity or legacy file access.
      // Never substitute a different managed prompt; show the unresolved reference.
      referenceWarnings.set(candidate.id, error.message);
    }
  }
  // Reacquire each file from the directory after loading. This observes Python's
  // replacements and detects changed/deleted/new optional files without writing.
  for (const observation of observations) {
    const current = await readConfigurationFile(directory, observation.parts, observation.optional);
    if ((current?.revision ?? null) !== observation.revision) throw new AccessError("configuration-changed", "Configuration changed while it was loading. Refresh to read it again.");
  }
  return { registry, profiles, prompts, documents, referenceWarnings, registryRevision: registryFile.revision, loadedAt: new Date().toISOString() };
}

export class StudioAccess {
  constructor(store, pickers = globalThis, newScope = () => globalThis.crypto.randomUUID()) {
    this.store = store; this.pickers = pickers; this.newScope = newScope;
    this.directory = null; this.snapshot = null; this.promptHandles = new Map();
  }
  async restore() {
    this.snapshot = null; this.promptHandles.clear();
    this.directory = await this.store.getDirectory();
    if (!this.directory) return null;
    return this.refresh();
  }
  async selectConfiguration() {
    requireValue(typeof this.pickers.showDirectoryPicker === "function", "This browser does not support directory access. Use a supported desktop Chrome extension page.", "unsupported");
    let handle;
    try { handle = await this.pickers.showDirectoryPicker({ id: "studio-configuration", mode: "readwrite" }); }
    catch (error) { if (cancelled(error)) return { cancelled: true }; throw new AccessError("folder-unavailable", "The folder picker could not grant access. Try selecting the folder again."); }
    const snapshot = await loadConfiguration(handle);
    let scope = this.newScope();
    if (this.directory && typeof handle.isSameEntry === "function") {
      try { if (await handle.isSameEntry(this.directory.handle)) scope = this.directory.scope; } catch { /* A stale previous handle must not block a new grant. */ }
    }
    // Do not replace the in-memory or durable previous selection until every
    // required validation and the IndexedDB transaction have succeeded.
    const saved = await this.store.saveDirectory(handle, scope);
    this.directory = saved; this.snapshot = snapshot; this.promptHandles.clear();
    return { cancelled: false, snapshot };
  }
  async refresh() {
    this.snapshot = null; this.promptHandles.clear();
    requireValue(this.directory, "No configuration folder is selected.", "folder-not-selected");
    this.snapshot = await loadConfiguration(this.directory.handle);
    return this.snapshot;
  }
  async reconnectConfiguration() {
    requireValue(this.directory, "Select a configuration folder first.", "folder-not-selected");
    this.snapshot = null; this.promptHandles.clear();
    await requestAccess(this.directory.handle, "readwrite");
    return this.refresh(); // A grant alone is not evidence that files are readable.
  }
  candidate(candidateId) {
    requireValue(this.snapshot, "Refresh and validate configuration first.", "configuration-unavailable");
    const candidate = this.snapshot.registry.candidates.find(item => item.id === candidateId);
    requireValue(candidate, "This candidate is no longer loaded. Refresh configuration.", "configuration-changed");
    return candidate;
  }
  async assertRegistryCurrent(snapshot = this.snapshot) {
    requireValue(snapshot && this.directory, "Refresh configuration first.", "configuration-unavailable");
    let current;
    try {
      await checkPermission(this.directory.handle, "readwrite");
      current = await readConfigurationFile(this.directory.handle, ["candidates.json"]);
    } catch (error) {
      this.snapshot = null; this.promptHandles.clear(); throw error;
    }
    if (this.snapshot !== snapshot || current.revision !== snapshot.registryRevision) {
      this.snapshot = null; this.promptHandles.clear();
      throw new AccessError("configuration-changed", "The candidate registry changed. Refresh configuration before using a prompt.");
    }
  }
  async readPrompt(candidateId) {
    const candidate = this.candidate(candidateId), snapshot = this.snapshot;
    const directory = this.directory;
    await this.assertRegistryCurrent(snapshot);
    let handle;
    if (candidate.promptFilePath) {
      const key = promptMappingKey(directory.scope, candidate.promptFilePath);
      this.promptHandles.delete(key);
      const record = await this.store.getPrompt(directory.scope, candidate.promptFilePath);
      requireValue(record, "Prompt file is not linked. Use Link Prompt File to authorize the existing file.", "prompt-unlinked");
      this.promptHandles.set(key, record);
      handle = record.handle;
    } else {
      const parts = templateParts(candidate.promptTemplate);
      try {
        let parent = directory.handle;
        for (const component of parts.slice(0, -1)) parent = await parent.getDirectoryHandle(component, { create: false });
        handle = await parent.getFileHandle(parts.at(-1), { create: false });
      } catch { throw new AccessError("prompt-unavailable", "The saved pasted-prompt file is missing or unreadable inside the configuration folder."); }
    }
    const prompt = await readPromptFile(handle, { external: Boolean(candidate.promptFilePath) });
    await this.assertRegistryCurrent(snapshot);
    return prompt;
  }
  async linkPrompt(candidateId) {
    const candidate = this.candidate(candidateId), snapshot = this.snapshot, directory = this.directory;
    requireValue(candidate.promptFilePath, "This candidate uses a configuration-relative prompt file.", "prompt-invalid");
    requireValue(typeof this.pickers.showOpenFilePicker === "function", "This browser does not support linking prompt files.", "unsupported");
    let handles;
    try { handles = await this.pickers.showOpenFilePicker({ id: "studio-linked-prompt", multiple: false, excludeAcceptAllOption: true,
      types: [{ description: "Existing UTF-8 prompt", accept: { "text/plain": [".txt", ".md"] } }] }); }
    catch (error) { if (cancelled(error)) return { cancelled: true }; throw new AccessError("prompt-unavailable", "The prompt file picker could not grant access. Try again."); }
    const handle = handles?.[0];
    const prompt = await readPromptFile(handle);
    await this.assertRegistryCurrent(snapshot);
    const record = await this.store.savePrompt(directory.scope, candidate.promptFilePath, handle);
    this.promptHandles.set(promptMappingKey(directory.scope, candidate.promptFilePath), record);
    return { cancelled: false, filename: prompt.filename, size: prompt.size };
  }
  async reconnectPrompt(candidateId) {
    const candidate = this.candidate(candidateId);
    const record = this.promptHandles.get(promptMappingKey(this.directory.scope, candidate.promptFilePath));
    requireValue(record, "Link the prompt file again to restore access.", "prompt-unlinked");
    await requestAccess(record.handle, "read");
    return this.readPrompt(candidateId);
  }
  async forgetPrompt(candidateId) {
    const candidate = this.candidate(candidateId);
    await this.store.removePrompt(this.directory.scope, candidate.promptFilePath);
    this.promptHandles.delete(promptMappingKey(this.directory.scope, candidate.promptFilePath));
  }
}
