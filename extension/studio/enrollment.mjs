// Pre-login transport only. No UI, polling, native messages or content-script bridge.
import { identifier } from "./contracts.mjs";

export const BACKEND = "http://127.0.0.1:8765";
export const ENROLLMENT_KEYS = Object.freeze({
  identity: "tracker.enrollment.identity.v1", pending: "tracker.enrollment.pending.v1",
  installation: "tracker.enrollment.installation.v1", recovery: "tracker.enrollment.recovery.v1"
});
const UUID = /^[0-9a-f]{32}$/;
const SECRET = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const CODE = /^[A-Z2-9]{4}-[A-Z2-9]{4}$/;
const LOCK = "application-tracker-enrollment-v1";

export class EnrollmentError extends Error {
  constructor(code, message, status = null) { super(message); this.name = "EnrollmentError"; this.code = code; this.status = status; }
}
function requireValue(condition, code, message) { if (!condition) throw new EnrollmentError(code, message); }
function keys(value, allowed) { return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === allowed.length && Object.keys(value).every(key => allowed.includes(key)); }
function identity(value) {
  requireValue(value && UUID.test(value.backendId), "invalid-identity", "Invalid backend identity.");
  identifier(value.workspaceId, "Workspace ID");
  return { backendId: value.backendId, workspaceId: value.workspaceId };
}
function sameIdentity(first, second) { return first.backendId === second.backendId && first.workspaceId === second.workspaceId; }
function installation(value) {
  requireValue(keys(value, ["schemaVersion", "installationCredential", "installationId", "bindingId", "bindingRevision", "backendId", "workspaceId"])
    && value.schemaVersion === 1 && SECRET.test(value.installationCredential)
    && UUID.test(value.installationId) && value.bindingId === value.installationId
    && Number.isSafeInteger(value.bindingRevision) && value.bindingRevision > 0,
  "storage-corrupt", "Stored installation credential is invalid; do not overwrite it.");
  identity(value); return value;
}

export class EnrollmentClient {
  constructor({ fetcher = globalThis.fetch, storage = globalThis.chrome?.storage, runtime = globalThis.chrome?.runtime,
    crypto = globalThis.crypto, location = globalThis.location, locks = globalThis.navigator?.locks,
    encode = globalThis.btoa, now = Date.now, setTimer = globalThis.setTimeout, clearTimer = globalThis.clearTimeout,
    Abort = globalThis.AbortController } = {}) {
    Object.assign(this, { fetcher, storage, runtime, crypto, location, locks, encode, now, setTimer, clearTimer, Abort });
  }
  async prepare() {
    requireValue(/^[a-p]{32}$/.test(this.runtime?.id || "") && this.location?.protocol === "chrome-extension:"
      && this.location?.hostname === this.runtime.id, "untrusted-context", "Enrollment is restricted to trusted extension pages.");
    try {
      for (const area of [this.storage?.local, this.storage?.session]) {
        requireValue(typeof area?.setAccessLevel === "function", "storage-unavailable", "Trusted extension storage is unavailable.");
        await area.setAccessLevel.call(area, { accessLevel: "TRUSTED_CONTEXTS" });
      }
    } catch { throw new EnrollmentError("storage-unavailable", "Trusted storage restrictions could not be established. No enrollment request was sent."); }
  }
  async read(area, key) {
    try {
      const value = await area.get.call(area, key);
      requireValue(value && typeof value === "object" && !Array.isArray(value), "storage-unavailable", "Stored enrollment data could not be read.");
      return Object.hasOwn(value, key) ? value[key] : undefined;
    } catch { throw new EnrollmentError("storage-unavailable", "Stored enrollment data could not be read; no defaults were substituted."); }
  }
  async store(area, key, value) {
    try { await area.set.call(area, { [key]: value }); }
    catch { throw new EnrollmentError("storage-unavailable", "Enrollment storage could not be confirmed."); }
  }
  async remove(area, key) {
    try { await area.remove.call(area, key); }
    catch { throw new EnrollmentError("storage-unavailable", "Enrollment cleanup could not be confirmed."); }
  }
  async exclusive(action) {
    await this.prepare();
    requireValue(typeof this.locks?.request === "function", "locks-unavailable", "Exclusive browser storage access is unavailable; enrollment is disabled.");
    return this.locks.request.call(this.locks, LOCK, { mode: "exclusive" }, action);
  }
  async savedInstallation() {
    const value = await this.read(this.storage.local, ENROLLMENT_KEYS.installation);
    return value === undefined ? null : installation(value);
  }
  async pin() {
    const value = await this.read(this.storage.local, ENROLLMENT_KEYS.identity);
    const saved = await this.savedInstallation();
    if (value === undefined) {
      requireValue(!saved, "storage-corrupt", "An installation exists without its confirmed identity; do not replace it.");
      return null;
    }
    requireValue(keys(value, ["schemaVersion", "backendId", "workspaceId"]) && value.schemaVersion === 1, "storage-corrupt", "Stored backend identity is invalid.");
    identity(value);
    requireValue(!saved || sameIdentity(value, saved), "identity-mismatch", "Stored installation and backend identities disagree.");
    return value;
  }
  async pending() {
    const value = await this.read(this.storage.session, ENROLLMENT_KEYS.pending);
    if (value === undefined) return null;
    requireValue(keys(value, ["schemaVersion", "status", "label", "backendId", "workspaceId", "exchangeSecret", "pairingId", "approvalCode", "expiresAt"])
      && value.schemaVersion === 1 && ["creating", "pending", "claiming", "claim-uncertain"].includes(value.status)
      && typeof value.label === "string" && (value.exchangeSecret === null || SECRET.test(value.exchangeSecret))
      && (value.pairingId === null || UUID.test(value.pairingId)) && (value.approvalCode === null || CODE.test(value.approvalCode))
      && (value.expiresAt === null || Number.isFinite(Date.parse(value.expiresAt))), "storage-corrupt", "Pending enrollment is invalid; recovery requires an explicit action.");
    identity(value);
    requireValue(!["creating", "pending"].includes(value.status) || SECRET.test(value.exchangeSecret), "storage-corrupt", "Pending exchange secret is missing.");
    return value;
  }
  async recovery() {
    const value = await this.read(this.storage.local, ENROLLMENT_KEYS.recovery);
    if (value === undefined) return null;
    requireValue(keys(value, ["schemaVersion", "backendId", "workspaceId", "pairingId"]) && value.schemaVersion === 1 && UUID.test(value.pairingId), "storage-corrupt", "Claim recovery record is invalid.");
    identity(value); return value;
  }
  async http(path, options = {}) {
    let request, timeout, controller;
    try {
      controller = new this.Abort();
      timeout = this.setTimer.call(globalThis, () => controller.abort(), 12000);
      request = this.fetcher.call(globalThis, BACKEND + path, { method: options.method || "GET", mode: "cors", credentials: "omit",
        redirect: "error", cache: "no-store", headers: options.headers || {}, signal: controller.signal,
        ...(options.method === "POST" ? { body: JSON.stringify(options.body || {}) } : {}) });
    } catch {
      if (timeout !== undefined) { try { this.clearTimer.call(globalThis, timeout); } catch { /* Local failure stays locked. */ } }
      throw new EnrollmentError("client-execution-error", "The browser request could not execute. Enrollment remains locked.");
    }
    let response, data;
    try { response = await request; data = await response.json(); }
    catch { throw new EnrollmentError("connection-unavailable", "Enrollment response could not be confirmed. Check the backend, extension ID and Chrome network permissions; do not replay an uncertain claim."); }
    finally {
      try { this.clearTimer.call(globalThis, timeout); } catch {
        throw new EnrollmentError("client-execution-error", "Browser request cleanup failed. Enrollment remains locked.");
      }
    }
    if (!response.ok && !(path === "/api/extension/bootstrap" && response.status === 503 && data?.state === "unavailable")) {
      throw new EnrollmentError("request-rejected", `Enrollment request rejected (HTTP ${response.status}). Review Web Extension Studio before retrying explicitly.`, response.status);
    }
    return { status: response.status, data };
  }
  async bootstrap() {
    const pinned = await this.pin();
    const { data } = await this.http("/api/extension/bootstrap");
    requireValue(keys(data, ["protocolVersion", "state", "backendId", "workspaceId", "requestToken"]) && data.protocolVersion === 1
      && ["ready", "setup-required", "unavailable"].includes(data.state), "invalid-response", "Invalid enrollment bootstrap response.");
    if (data.state === "ready") {
      identity(data); requireValue(SECRET.test(data.requestToken), "invalid-response", "Invalid enrollment request token.");
      requireValue(!pinned || sameIdentity(pinned, data), "identity-mismatch", "The backend/workspace does not match the confirmed identity. Nothing was replaced.");
    } else requireValue(data.backendId === null && data.workspaceId === null && data.requestToken === null, "invalid-response", "Invalid unavailable bootstrap response.");
    return data;
  }
  async ready() {
    const value = await this.bootstrap();
    requireValue(value.state === "ready", value.state, "Complete or repair owner/device setup in Web Studio before enrollment.");
    return value;
  }
  async getBootstrap() { await this.prepare(); return this.bootstrap(); }
  async confirmBackendIdentity(expected) {
    return this.exclusive(async () => {
      identity(expected); const context = await this.ready();
      requireValue(sameIdentity(expected, context), "identity-mismatch", "Confirm the currently displayed backend/workspace identity.");
      const pinned = await this.pin();
      requireValue(!pinned || sameIdentity(pinned, expected), "identity-mismatch", "Replacing a confirmed identity requires a separate recovery workflow.");
      await this.store(this.storage.local, ENROLLMENT_KEYS.identity, { schemaVersion: 1, ...identity(context) });
      return identity(context);
    });
  }
  async requestPairing(label) {
    return this.exclusive(async () => {
      requireValue(typeof label === "string" && label.trim().length > 0 && label.trim().length <= 80 && !/[\u0000-\u001f]/.test(label), "invalid-label", "Provide a browser profile label of 1–80 printable characters.");
      requireValue(!await this.savedInstallation(), "already-paired", "An installation credential already exists; it will not be overwritten.");
      requireValue(!await this.recovery(), "recovery-required", "A prior claim is uncertain. Revoke it in Web Studio before explicitly clearing enrollment.");
      requireValue(!await this.pending(), "pending-exists", "An exchange already exists. Review or clear it explicitly before starting another.");
      const context = await this.ready(), pinned = await this.pin();
      requireValue(pinned && sameIdentity(pinned, context), "identity-confirmation-required", "The future enrollment UI must explicitly confirm backend/workspace identity first.");
      requireValue(typeof this.crypto?.getRandomValues === "function" && typeof this.encode === "function", "crypto-unavailable", "Secure browser randomness is unavailable.");
      const bytes = this.crypto.getRandomValues.call(this.crypto, new Uint8Array(32));
      const exchangeSecret = this.encode.call(globalThis, String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
      const pending = { schemaVersion: 1, status: "creating", label: label.trim(), ...identity(context), exchangeSecret, pairingId: null, approvalCode: null, expiresAt: null };
      await this.store(this.storage.session, ENROLLMENT_KEYS.pending, pending);
      const { data } = await this.http("/api/extension/pairings", { method: "POST", body: { protocolVersion: 1, label: pending.label },
        headers: { "Content-Type": "application/json", "X-Tracker-Token": context.requestToken, "X-Pairing-Exchange": exchangeSecret } });
      requireValue(keys(data, ["pairingId", "approvalCode", "status", "expiresAt"]) && UUID.test(data.pairingId) && CODE.test(data.approvalCode)
        && data.status === "pending" && Number.isFinite(Date.parse(data.expiresAt)), "invalid-response", "Pairing creation could not be confirmed; clear the pending exchange explicitly.");
      Object.assign(pending, data); await this.store(this.storage.session, ENROLLMENT_KEYS.pending, pending);
      return this.getPendingPairing();
    });
  }
  async getPendingPairing() {
    await this.prepare(); const pending = await this.pending(), recovery = await this.recovery();
    if (!pending) return recovery ? { ...recovery, status: "claim-uncertain" } : null;
    const { exchangeSecret, ...safe } = pending;
    safe.status = recovery ? "claim-uncertain" : pending.expiresAt && this.now() >= Date.parse(pending.expiresAt) ? "expired" : pending.status;
    return safe;
  }
  async claimPairing() {
    return this.exclusive(async () => {
      requireValue(!await this.savedInstallation(), "already-paired", "An existing credential cannot be replaced by a claim.");
      requireValue(!await this.recovery(), "recovery-required", "An earlier claim is uncertain; revoke and re-pair instead of replaying it.");
      const pending = await this.pending();
      requireValue(pending?.status === "pending" && UUID.test(pending.pairingId) && this.now() < Date.parse(pending.expiresAt), "pending-unavailable", "No unexpired, claimable exchange exists. Do not replay an uncertain claim.");
      const context = await this.ready();
      requireValue(sameIdentity(pending, context), "identity-mismatch", "Pending enrollment belongs to another backend/workspace.");
      await this.store(this.storage.local, ENROLLMENT_KEYS.recovery, { schemaVersion: 1, ...identity(context), pairingId: pending.pairingId });
      await this.store(this.storage.session, ENROLLMENT_KEYS.pending, { ...pending, status: "claiming" });
      let persisted = false;
      try {
        const { status, data } = await this.http(`/api/extension/pairings/${pending.pairingId}/claim`, { method: "POST", body: {},
          headers: { "Content-Type": "application/json", "X-Tracker-Token": context.requestToken, "X-Pairing-Exchange": pending.exchangeSecret } });
        if (status === 202 && keys(data, ["status"]) && data.status === "pending") {
          await this.store(this.storage.session, ENROLLMENT_KEYS.pending, pending);
          await this.remove(this.storage.local, ENROLLMENT_KEYS.recovery);
          return { status: "pending" };
        }
        requireValue(status === 200, "invalid-response", "Claim result is uncertain.");
        const saved = installation({ schemaVersion: 1, ...data });
        requireValue(sameIdentity(saved, context), "identity-mismatch", "Claim returned a different backend/workspace.");
        requireValue(!await this.savedInstallation(), "already-paired", "An installation appeared during claim; it was not overwritten.");
        await this.store(this.storage.local, ENROLLMENT_KEYS.installation, saved);
        const checked = await this.savedInstallation();
        requireValue(checked?.installationCredential === saved.installationCredential && checked?.installationId === saved.installationId,
          "credential-loss", "Installation credential persistence could not be confirmed.");
        persisted = true;
        await this.remove(this.storage.session, ENROLLMENT_KEYS.pending);
        await this.remove(this.storage.local, ENROLLMENT_KEYS.recovery);
        const { installationCredential, ...safe } = checked;
        return { status: "claimed", ...safe };
      } catch (error) {
        try { await this.store(this.storage.session, ENROLLMENT_KEYS.pending, { ...pending, status: "claim-uncertain", exchangeSecret: null }); } catch { /* The pre-request durable recovery marker remains. */ }
        throw new EnrollmentError(persisted ? "credential-stored-cleanup-required" : "claim-uncertain",
          persisted ? "The credential was stored, but cleanup failed. Read the stored installation; never replay the claim."
            : error.status === 409 ? "The claim was denied or already consumed. Do not retry. Review Web Studio and revoke any installation from this exchange before clearing it."
              : error.status === 410 ? "The pairing expired. Do not retry the claim. Review Web Studio before clearing this exchange."
                : "The claim or its credential storage could not be confirmed. Do not retry the claim. Check Web Studio, revoke the installation if present, and re-pair explicitly.", error.status ?? null);
      }
    });
  }
  async getInstallationCredential() { await this.prepare(); await this.pin(); return this.savedInstallation(); }
  async acceptVerifiedBinding(context) {
    // Only the authenticated client calls this after a fresh server verification
    // and explicit candidate acknowledgement. Never replace a credential or pin.
    return this.exclusive(async () => {
      const saved = await this.savedInstallation();
      requireValue(saved && sameIdentity(saved, context) && saved.installationId === context.installationId
        && saved.bindingId === context.bindingId && Number.isSafeInteger(context.bindingRevision)
        && context.bindingRevision >= saved.bindingRevision, "binding-mismatch", "The verified binding does not match this installation.");
      await this.store(this.storage.local, ENROLLMENT_KEYS.installation, { ...saved, bindingRevision: context.bindingRevision });
    });
  }
  async clearPendingEnrollment({ acknowledgeRevocation = false } = {}) {
    return this.exclusive(async () => {
      const saved = await this.savedInstallation();
      const pending = await this.pending();
      const uncertain = await this.recovery() || ["claiming", "claim-uncertain"].includes(pending?.status);
      requireValue(saved || !uncertain || acknowledgeRevocation === true, "recovery-required", "Explicitly confirm Web Studio revocation before abandoning an uncertain claim.");
      await this.remove(this.storage.session, ENROLLMENT_KEYS.pending);
      await this.remove(this.storage.local, ENROLLMENT_KEYS.recovery);
    });
  }
}

let defaultClient;
const client = () => defaultClient ??= new EnrollmentClient();
export const getBootstrap = () => client().getBootstrap();
export const confirmBackendIdentity = expected => client().confirmBackendIdentity(expected);
export const requestPairing = label => client().requestPairing(label);
export const getPendingPairing = () => client().getPendingPairing();
export const claimPairing = () => client().claimPairing();
export const getInstallationCredential = () => client().getInstallationCredential();
export const clearPendingEnrollment = options => client().clearPendingEnrollment(options);
