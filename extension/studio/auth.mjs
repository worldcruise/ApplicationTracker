// Browser transport for the existing backend AuthService. No owner verifier here.
import { BACKEND, ENROLLMENT_KEYS, EnrollmentClient } from "./enrollment.mjs";
import { identifier } from "./contracts.mjs";

export const AUTH_KEYS = Object.freeze({ session: "tracker.auth.session.v1", control: "tracker.auth.control.v1" });
const UUID = /^[0-9a-f]{32}$/;
const TOKEN = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const LOCK = "application-tracker-extension-auth-v1";
const exact = (value, fields) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));
export class ExtensionAuthError extends Error {
  constructor(code, message, status = null, retryAfter = null) {
    super(message); this.name = "ExtensionAuthError"; Object.assign(this, { code, status, retryAfter });
  }
}
function check(value, code, message) { if (!value) throw new ExtensionAuthError(code, message); }
function metadata(value, installation, origin) {
  check(exact(value, ["authenticated", "user", "context", "session"]) && value.authenticated === true,
    "invalid-response", "The authenticated response is invalid. The workspace remains locked.");
  const { user, context, session } = value;
  check(exact(user, ["id", "username", "role"]) && UUID.test(user.id) && typeof user.username === "string"
    && user.username.length > 0 && user.username.length <= 64 && user.role === "owner"
    && exact(session, ["audience", "idleRemainingSeconds", "absoluteRemainingSeconds"]) && session.audience === "extension"
    && Number.isInteger(session.idleRemainingSeconds) && session.idleRemainingSeconds > 0 && session.idleRemainingSeconds <= 1800
    && Number.isInteger(session.absoluteRemainingSeconds) && session.absoluteRemainingSeconds > 0 && session.absoluteRemainingSeconds <= 28800,
  "invalid-response", "The owner/session response is invalid. Sign in again explicitly.");
  check(exact(context, ["backendId", "workspaceId", "installationId", "bindingId", "bindingRevision", "extensionOrigin", "candidate"])
    && context.backendId === installation.backendId && context.workspaceId === installation.workspaceId
    && context.installationId === installation.installationId && context.bindingId === installation.bindingId
    && context.extensionOrigin === origin && Number.isSafeInteger(context.bindingRevision)
    && context.bindingRevision >= installation.bindingRevision
    && exact(context.candidate, ["id", "name"]) && typeof context.candidate.name === "string" && context.candidate.name.trim(),
  "context-mismatch", "The session does not match this installation and confirmed binding.");
  try { identifier(context.candidate.id, "Candidate ID"); } catch {
    throw new ExtensionAuthError("invalid-response", "The authenticated candidate identity is invalid.");
  }
  return structuredClone(value);
}
function sameScope(first, second) {
  return ["backendId", "workspaceId", "installationId", "bindingId", "bindingRevision", "extensionOrigin"]
    .every(key => first[key] === second[key]) && first.candidate.id === second.candidate.id;
}

export class ExtensionAuthClient {
  constructor({ enrollment = new EnrollmentClient(), fetcher = enrollment.fetcher, now = Date.now,
    setTimer = globalThis.setTimeout, clearTimer = globalThis.clearTimeout, Abort = globalThis.AbortController,
    incognito = globalThis.chrome?.extension?.inIncognitoContext ?? false } = {}) {
    Object.assign(this, { enrollment, fetcher, now, setTimer, clearTimer, Abort, incognito });
    this.revision = null; this.epoch = 0; this.listeners = new Set(); this.expectedBinding = null; this.active = false;
    this.changed = (changes, area) => {
      const control = changes[AUTH_KEYS.control]?.newValue;
      if (area === "session" && Object.hasOwn(changes, AUTH_KEYS.control) && (!control || control.revision !== this.revision)) {
        this.active = false; this.epoch++; this.emit("session-changed");
      }
      if (area === "session" && this.active && changes[AUTH_KEYS.session] && !changes[AUTH_KEYS.session].newValue && !control) {
        this.active = false; this.epoch++; this.emit("session-changed");
      }
      if (area === "local" && (changes[ENROLLMENT_KEYS.identity] || changes[ENROLLMENT_KEYS.installation])) {
        const change = changes[ENROLLMENT_KEYS.installation], saved = change?.newValue;
        if (changes[ENROLLMENT_KEYS.identity] || !saved || saved.installationId !== this.expectedBinding?.installationId
          || saved.bindingRevision !== this.expectedBinding?.bindingRevision
          || saved.installationCredential !== change.oldValue?.installationCredential
          || saved.backendId !== change.oldValue?.backendId || saved.workspaceId !== change.oldValue?.workspaceId) {
          this.active = false; this.epoch++; this.emit("installation-changed");
        }
      }
    };
  }
  subscribe(callback) { this.listeners.add(callback); return () => this.listeners.delete(callback); }
  emit(reason) { for (const listener of this.listeners) listener(reason); }
  async prepare() {
    check(!this.incognito, "incognito-unsupported", "Use an ordinary Chrome profile. Incognito is not a separate browser installation.");
    await this.enrollment.prepare();
  }
  async exclusive(action) {
    await this.prepare();
    const locks = this.enrollment.locks;
    check(typeof locks?.request === "function", "locks-unavailable", "Exclusive session storage is unavailable. The workspace remains locked.");
    return locks.request.call(locks, LOCK, { mode: "exclusive" }, action);
  }
  async control() {
    const value = await this.enrollment.read(this.enrollment.storage.session, AUTH_KEYS.control);
    if (value === undefined) return { schemaVersion: 1, revision: 0, state: "locked" };
    check(exact(value, ["schemaVersion", "revision", "state"]) && value.schemaVersion === 1
      && Number.isSafeInteger(value.revision) && value.revision >= 0
      && ["locked", "pending", "authenticated", "acknowledgement"].includes(value.state),
    "storage-corrupt", "Stored session state is invalid. Nothing was trusted or replaced.");
    return value;
  }
  async saved(installation) {
    const value = await this.enrollment.read(this.enrollment.storage.session, AUTH_KEYS.session);
    if (value === undefined) return null;
    check(exact(value, ["schemaVersion", "token", "metadata"]) && value.schemaVersion === 1 && TOKEN.test(value.token),
      "storage-corrupt", "Stored session data is invalid. Sign-in recovery is required.");
    metadata(value.metadata, { ...installation, bindingRevision: 1 }, this.origin());
    return value;
  }
  origin() { return "chrome-extension://" + this.enrollment.runtime.id; }
  async installation() {
    const value = await this.enrollment.getInstallationCredential();
    check(value, "unpaired", "Pair this browser explicitly before signing in.");
    return value;
  }
  async http(action, installation, { token = null, body = null, requestToken = null } = {}) {
    const method = action === "session" ? "GET" : "POST";
    const headers = { "X-Tracker-Installation-Id": installation.installationId,
      "X-Tracker-Installation-Credential": installation.installationCredential };
    if (token) headers.Authorization = "Bearer " + token;
    if (method === "POST") Object.assign(headers, { "Content-Type": "application/json", "X-Tracker-Token": requestToken });
    let response, timeout, controller, request;
    try {
      controller = new this.Abort();
      timeout = this.setTimer.call(globalThis, () => controller.abort(), 12000);
      request = this.fetcher.call(globalThis, `${BACKEND}/api/extension/auth/${action}`, {
        method, mode: "cors", credentials: "omit", redirect: "error", cache: "no-store", headers,
        signal: controller.signal, ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {})
      });
    } catch {
      if (timeout !== undefined) { try { this.clearTimer.call(globalThis, timeout); } catch { /* Locked local failure. */ } }
      throw new ExtensionAuthError("client-execution-error", "The browser request could not execute. The workspace remains locked.");
    }
    try {
      try { response = await request; } catch {
        throw new ExtensionAuthError("connection-unavailable", "No backend response was confirmed. Check the manager and Chrome networking permissions.");
      }
      let data;
      try { data = await response.json(); } catch {
        throw new ExtensionAuthError("invalid-response", "The backend returned an unreadable authentication response.");
      }
      if (!response.ok) {
        const allowed = ["invalid-credentials", "authentication-required", "installation-unavailable", "candidate-unavailable", "binding-changed",
          "rate-limited", "invalid-host", "invalid-origin", "invalid-request-token", "authentication-unavailable", "owner-setup-required", "session-capacity"];
        const code = allowed.includes(data?.code) ? data.code : "request-rejected";
        const retry = Number(response.headers?.get.call(response.headers, "Retry-After"));
        throw new ExtensionAuthError(code, `Authentication request rejected (HTTP ${response.status}).`, response.status,
          Number.isInteger(retry) && retry > 0 && retry <= 300 ? retry : null);
      }
      return data;
    } finally {
      try { this.clearTimer.call(globalThis, timeout); } catch {
        throw new ExtensionAuthError("client-execution-error", "Browser request cleanup failed. The workspace remains locked.");
      }
    }
  }
  async begin() {
    this.active = false;
    return this.exclusive(async () => {
      const control = await this.control();
      check(control.revision < Number.MAX_SAFE_INTEGER, "storage-corrupt", "Session recovery is required.");
      this.revision = control.revision + 1;
      const epoch = ++this.epoch;
      await this.enrollment.store(this.enrollment.storage.session, AUTH_KEYS.control,
        { schemaVersion: 1, revision: this.revision, state: "pending" });
      await this.enrollment.remove(this.enrollment.storage.session, AUTH_KEYS.session);
      return { revision: this.revision, epoch };
    });
  }
  async commit(operation, token, value, installation, previous = null) {
    const safe = metadata(value, installation, this.origin());
    if (previous) {
      check(previous.user.id === safe.user.id && (sameScope(previous.context, safe.context)
        || safe.context.bindingRevision > previous.context.bindingRevision), "context-mismatch", "Owner or candidate context changed unexpectedly.");
    }
    return this.exclusive(async () => {
      const control = await this.control(), current = await this.installation();
      check(this.epoch === operation.epoch && control.revision === operation.revision
        && current.installationCredential === installation.installationCredential && current.installationId === installation.installationId,
      "operation-interrupted", "Session initialization was interrupted. Reconnect explicitly.");
      const acknowledge = safe.context.bindingRevision !== current.bindingRevision || control.state === "acknowledgement";
      this.revision = control.revision;
      await this.enrollment.store(this.enrollment.storage.session, AUTH_KEYS.session, { schemaVersion: 1, token, metadata: safe });
      await this.enrollment.store(this.enrollment.storage.session, AUTH_KEYS.control,
        { ...control, state: acknowledge ? "acknowledgement" : "authenticated" });
      this.active = !acknowledge;
      return { state: acknowledge ? "binding-reassigned" : "authenticated", metadata: safe };
    });
  }
  async login(username, password) {
    const operation = await this.begin();
    try {
      const installation = await this.installation(), bootstrap = await this.enrollment.ready();
      const data = await this.http("login", installation, { body: { username, password }, requestToken: bootstrap.requestToken });
      check(exact(data, ["sessionToken", "authenticated", "user", "context", "session"]) && TOKEN.test(data.sessionToken),
        "invalid-response", "The login response is invalid. Do not retry automatically.");
      const { sessionToken, ...safe } = data;
      return await this.commit(operation, sessionToken, safe, installation);
    } catch (error) {
      await this.lock("sign-in-failed", { revision: operation.revision }).catch(() => {});
      throw error;
    }
  }
  async snapshot() {
    return this.exclusive(async () => {
      const installation = await this.installation(), control = await this.control();
      const saved = await this.saved(installation);
      if (!saved || !["authenticated", "acknowledgement"].includes(control.state)) return null;
      this.revision = control.revision;
      return { installation, saved, operation: { revision: control.revision, epoch: this.epoch } };
    });
  }
  async restore({ activity = false } = {}) {
    this.active = false;
    const snapshot = await this.snapshot();
    if (!snapshot) return { state: "signed-out" };
    try {
      const bootstrap = await this.enrollment.ready();
      const value = await this.http(activity ? "activity" : "session", snapshot.installation,
        { token: snapshot.saved.token, requestToken: activity ? bootstrap.requestToken : null });
      return await this.commit(snapshot.operation, snapshot.saved.token, value, snapshot.installation, snapshot.saved.metadata);
    } catch (error) {
      if (error.status === 401 || error.status === 403 || error.status === 409 || ["context-mismatch", "invalid-response"].includes(error.code))
        await this.lock(error.code, { revision: snapshot.operation.revision }).catch(() => {});
      throw error;
    }
  }
  async acknowledgeBinding(expected) {
    const snapshot = await this.snapshot();
    check(snapshot, "authentication-required", "Sign in again before reviewing the assigned candidate.");
    await this.enrollment.ready();
    const value = metadata(await this.http("session", snapshot.installation, { token: snapshot.saved.token }), snapshot.installation, this.origin());
    check(expected && sameScope(expected, value.context) && sameScope(snapshot.saved.metadata.context, value.context),
      "context-mismatch", "The assignment changed again. Sign in and review it again.");
    return this.exclusive(async () => {
      const control = await this.control();
      check(control.state === "acknowledgement" && control.revision === snapshot.operation.revision && this.epoch === snapshot.operation.epoch,
        "operation-interrupted", "Candidate acknowledgement was interrupted.");
      this.expectedBinding = value.context;
      await this.enrollment.acceptVerifiedBinding(value.context);
      await this.enrollment.store(this.enrollment.storage.session, AUTH_KEYS.session, { ...snapshot.saved, metadata: value });
      await this.enrollment.store(this.enrollment.storage.session, AUTH_KEYS.control, { ...control, state: "authenticated" });
      this.active = true;
      return { state: "authenticated", metadata: value };
    });
  }
  async lock(reason, { revision = null } = {}) {
    const invalidate = () => { this.active = false; this.expectedBinding = null; this.epoch++; this.emit(reason); };
    // Explicit logout locks immediately. A failed older request may only lock
    // the revision it actually verified, never a newer login on this same page.
    if (revision === null) invalidate();
    return this.exclusive(async () => {
      const control = await this.control();
      if (revision !== null && control.revision !== revision) return null;
      if (revision !== null) invalidate();
      check(control.revision < Number.MAX_SAFE_INTEGER, "storage-corrupt", "Session recovery is required.");
      const previous = await this.enrollment.read(this.enrollment.storage.session, AUTH_KEYS.session);
      this.revision = control.revision + 1;
      await this.enrollment.store(this.enrollment.storage.session, AUTH_KEYS.control,
        { schemaVersion: 1, revision: this.revision, state: "locked" });
      await this.enrollment.remove(this.enrollment.storage.session, AUTH_KEYS.session);
      return previous;
    });
  }
  async logout() {
    let saved;
    try { saved = await this.lock("signed-out"); } catch {
      return { serverConfirmed: false, localCleared: false };
    }
    if (!saved?.token) return { serverConfirmed: false, localCleared: true };
    try {
      const installation = await this.installation(), bootstrap = await this.enrollment.ready();
      const value = await this.http("logout", installation, { token: saved.token, requestToken: bootstrap.requestToken });
      check(exact(value, ["authenticated"]) && value.authenticated === false, "invalid-response", "Sign-out was not confirmed.");
      return { serverConfirmed: true, localCleared: true };
    } catch { return { serverConfirmed: false, localCleared: true }; }
  }
  watch() {
    const event = this.enrollment.storage?.onChanged;
    if (event?.addListener) event.addListener.call(event, this.changed);
    return () => { if (event?.removeListener) event.removeListener.call(event, this.changed); };
  }
}
