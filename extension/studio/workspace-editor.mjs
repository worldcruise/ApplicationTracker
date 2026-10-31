import { loadDataContracts } from "../shared/data-contracts.mjs";

const fields = ["company", "jobUrl", "jd", "cvJson", "coverLetter"];
const emptyDraft = () => Object.fromEntries(fields.map(field => [field, ""]));
const emptyValidation = () => ({ state: "empty", issues: [] });
const clone = value => structuredClone(value);

export function parseJobImport(source) {
  if (typeof source !== "string") throw new TypeError("Paste job text to review.");
  const match = /^(?:Company: ([^\r\n]*)\r?\n\r?\n)?Job URL: ([^\r\n]*)\r?\n\r?\nJob Description:\r?\n([\s\S]*)$/.exec(source);
  const multiple = match && /(?:^|\r?\n\r?\n)(?:Company: [^\r\n]*\r?\n\r?\n)?Job URL: [^\r\n]*\r?\n\r?\nJob Description:\r?\n/.test(match[3]);
  if (!match || multiple) return { kind: /(?:Company:|Job URL:|Job Description:)/.test(source) ? "ambiguous" : "plain",
    company: "", jobUrl: "", jd: source,
    message: /(?:Company:|Job URL:|Job Description:)/.test(source)
      ? "No single supported hotkey record was detected. All pasted text is retained as JD. Review it before applying."
      : "Plain JD text. No metadata was inferred. Review the blank company and URL fields before applying." };
  let message = "Hotkey format detected. Review all three fields before applying.";
  if (!match[3].trim()) message += " The extracted JD is empty; no content was fabricated.";
  if (match[2]) {
    try {
      const url = new URL(match[2]);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error();
    } catch { message += " The URL needs review; its original value is retained and will not be opened."; }
  }
  return { kind: match[1] === undefined ? "hotkey-jd-url" : "hotkey-company-jd-url", company: match[1] ?? "", jobUrl: match[2], jd: match[3], message };
}

function contextKey(metadata) {
  const context = metadata?.context;
  const values = [metadata?.user?.id, context?.backendId, context?.workspaceId, context?.installationId,
    context?.bindingId, context?.candidate?.id, context?.extensionOrigin];
  if (metadata?.authenticated !== true || metadata?.user?.role !== "owner" || values.some(value => typeof value !== "string" || !value)
    || !Number.isSafeInteger(context?.bindingRevision) || context.bindingRevision < 1)
    throw new Error("Verified workspace context is required.");
  return JSON.stringify([...values, context.bindingRevision]);
}

export class WorkspaceEditor {
  #active = false;
  #scope = null;
  #draft = emptyDraft();
  #validation = emptyValidation();
  #import = null;
  #feedback = {};
  #version = 0;
  #listeners = new Set();
  #contracts;
  #loading = null;
  #attempted = false;
  constructor({ contracts = null, contractsLoader = () => loadDataContracts((url) => globalThis.fetch.call(globalThis, url,
    { credentials: "omit", redirect: "error", cache: "no-store" })), clipboard = globalThis.navigator?.clipboard } = {}) {
    this.#contracts = contracts; this.contractsLoader = contractsLoader; this.clipboard = clipboard;
  }
  subscribe(callback) { this.#listeners.add(callback); return () => this.#listeners.delete(callback); }
  notify() { for (const callback of this.#listeners) callback(this.snapshot()); }
  snapshot() {
    if (!this.#active) return { active: false, draft: emptyDraft(), validation: emptyValidation(), import: null, feedback: {} };
    return { active: true, draft: clone(this.#draft), validation: clone(this.#validation),
      import: this.#import ? { ...clone(this.#import), overwriteNeeded: this.wouldOverwrite() } : null, feedback: clone(this.#feedback) };
  }
  activate(metadata) {
    const key = contextKey(metadata);
    if (key !== this.#scope) this.clear();
    const wasActive = this.#active;
    this.#scope = key; this.#active = true;
    if (!wasActive) this.#version++;
    this.validate(); this.notify();
    if (!this.#contracts && !this.#loading && !this.#attempted) void this.loadContracts();
  }
  suspend({ discard = false } = {}) {
    if (discard) { this.clear(); return; }
    if (!this.#active) return;
    this.#active = false; this.#version++; this.#import = null; this.#feedback = {}; this.notify();
  }
  clear() {
    this.#active = false; this.#scope = null; this.#draft = emptyDraft(); this.#validation = emptyValidation();
    this.#import = null; this.#feedback = {}; this.#version++; this.notify();
  }
  loadContracts() {
    if (this.#loading) return this.#loading;
    this.#attempted = true;
    this.#loading = Promise.resolve().then(() => this.contractsLoader()).then(
      value => { this.#contracts = value; }, () => { this.#contracts = null; }
    ).finally(() => {
      this.#loading = null;
      if (this.#active) { this.validate(); this.notify(); }
    });
    return this.#loading;
  }
  validate() {
    if (!this.#draft.cvJson.trim()) { this.#validation = emptyValidation(); return; }
    if (!this.#contracts) {
      this.#validation = { state: "unavailable", issues: [{ path: "/", message: "Packaged CV validation is unavailable. Retry validation; the raw text is unchanged." }] };
      return;
    }
    try {
      // Strict raw JSON, deliberately not the code-fence response adapter.
      this.#contracts.parse("resume", this.#draft.cvJson);
      this.#validation = { state: "valid", issues: [] };
    } catch (error) {
      this.#validation = { state: "invalid", issues: Array.isArray(error.issues)
        ? error.issues.map(({ path, message }) => ({ path: path || "/", message }))
        : [{ path: "/", message: "CV validation could not complete. Raw text was not repaired." }] };
    }
  }
  async retryValidation() {
    if (!this.#active) return;
    if (!this.#contracts) await this.loadContracts();
    if (this.#active) { this.validate(); this.notify(); }
  }
  update(field, value) {
    if (!this.#active || !fields.includes(field) || typeof value !== "string") return false;
    if (this.#draft[field] === value) return true;
    this.#draft[field] = value; this.#version++; delete this.#feedback[field];
    if (field === "cvJson") this.validate();
    if (["company", "jobUrl", "jd"].includes(field) && this.#import) this.#import.confirmOverwrite = false;
    this.notify(); return true;
  }
  openImport() {
    if (!this.#active) return;
    this.#import = { source: "", review: null, confirmOverwrite: false, error: "" }; this.notify();
  }
  editImportSource(source) {
    if (!this.#active || !this.#import || typeof source !== "string") return;
    Object.assign(this.#import, { source, review: null, confirmOverwrite: false, error: "" }); this.notify();
  }
  reviewImport() {
    if (!this.#active || !this.#import) return;
    this.#import.review = parseJobImport(this.#import.source); this.#import.confirmOverwrite = false; this.#import.error = ""; this.notify();
  }
  editReview(field, value) {
    if (!this.#active || !this.#import?.review || !["company", "jobUrl", "jd"].includes(field) || typeof value !== "string") return;
    this.#import.review[field] = value; this.#import.confirmOverwrite = false; this.notify();
  }
  confirmOverwrite(value) { if (this.#active && this.#import) { this.#import.confirmOverwrite = value === true; this.notify(); } }
  wouldOverwrite() {
    return Boolean(this.#import?.review && ["company", "jobUrl", "jd"].some(field => this.#draft[field].length > 0
      && this.#draft[field] !== this.#import.review[field]));
  }
  applyImport() {
    if (!this.#active || !this.#import?.review) return false;
    if (this.wouldOverwrite() && !this.#import.confirmOverwrite) {
      this.#import.error = "Confirm replacement of the existing JD or metadata before applying."; this.notify(); return false;
    }
    for (const field of ["company", "jobUrl", "jd"]) this.#draft[field] = this.#import.review[field];
    this.#import = null; this.#version++; this.#feedback.jd = { kind: "success", message: "Import applied to this page only. Nothing was saved." };
    this.notify(); return true;
  }
  cancelImport() { if (this.#active) { this.#import = null; this.notify(); } }
  async copy(field) {
    if (!this.#active || !["jd", "cvJson", "coverLetter"].includes(field)) return false;
    const text = this.#draft[field], version = this.#version, scope = this.#scope;
    if (!text.length) { this.#feedback[field] = { kind: "error", message: "Nothing to copy." }; this.notify(); return false; }
    let success = false;
    try {
      // Called synchronously from the click handler, without a preceding network await.
      if (typeof this.clipboard?.writeText !== "function") throw new Error();
      await this.clipboard.writeText.call(this.clipboard, text); success = true;
    } catch { /* Never claim success after a rejected clipboard operation. */ }
    if (this.#active && scope === this.#scope && version === this.#version) {
      this.#feedback[field] = { kind: success ? "success" : "error", message: success ? "Copied the exact editor text."
        : "Copy failed or clipboard permission was denied. Select and copy the text manually." };
      this.notify();
    }
    return success;
  }
}
