// One cookie-based authentication/request controller. No credential or draft storage.
export class AuthSuspended extends Error {
  constructor(message = "Authentication must be revalidated.") { super(message); this.authHandled = true; }
}
function requestExecutionError(cause) {
  return Object.assign(new Error("The browser could not execute the Studio request. Reload the page and retry.", { cause }), { code: "client-request-error" });
}
function sessionTimerError(cause) {
  return Object.assign(new Error("The browser could not maintain session monitoring. Reload the page and sign in again.", { cause }), { code: "client-request-error" });
}

export function captureFields(root) {
  return [...root.querySelectorAll("input, textarea, select")].map((field, index) => ({
    id: field.id, index, type: field.type, value: field.value, checked: field.checked,
    customMessage: field.validity?.customError ? field.validationMessage : ""
  }));
}
export function restoreFields(root, values) {
  const fields = [...root.querySelectorAll("input, textarea, select")];
  for (const value of values || []) {
    const field = fields.find(item => value.id && item.id === value.id) || fields[value.index];
    if (!field || field.id !== value.id || field.type !== value.type) continue;
    field.value = value.value; field.checked = value.checked; field.setCustomValidity?.(value.customMessage || "");
  }
}
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function mergeDraft(base, draft, latest) {
  if (equal(base, draft)) return structuredClone(latest);
  if (Array.isArray(base) && Array.isArray(draft) && Array.isArray(latest)
      && [...base, ...draft, ...latest].every(item => item && typeof item.id === "string")) {
    const result = draft.filter(item => latest.some(next => next.id === item.id) || !equal(item, base.find(old => old.id === item.id)))
      .map(item => mergeDraft(base.find(old => old.id === item.id), item, latest.find(next => next.id === item.id) || item));
    result.push(...latest.filter(item => !base.some(old => old.id === item.id) && !draft.some(own => own.id === item.id)).map(item => structuredClone(item)));
    return result;
  }
  if ([base, draft, latest].every(item => item && typeof item === "object" && !Array.isArray(item))) {
    const result = structuredClone(latest);
    for (const key of new Set([...Object.keys(base), ...Object.keys(draft)])) {
      if (equal(base[key], draft[key])) continue;
      if (!(key in draft)) delete result[key]; else result[key] = mergeDraft(base[key], draft[key], latest[key]);
    }
    return result;
  }
  return structuredClone(draft);
}

export class ManagerAuth {
  constructor({ fetch: fetcher = globalThis.fetch, onChange = () => {}, onSuspend = () => {}, onClear = () => {},
    onAuthenticated = async () => {}, dirty = () => false, confirmDiscard = () => true, now = () => Date.now(), channel = null,
    setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    Object.assign(this, { fetcher, onChange, onSuspend, onClear, onAuthenticated, dirty, confirmDiscard, now, channel, setTimer, clearTimer });
    this.phase = "checking"; this.owner = null; this.csrf = ""; this.epoch = 0; this.pending = new Set(); this.writes = 0;
    this.lastActivity = -Infinity; this.message = "Checking authentication…"; this.pendingLogout = false;
    if (channel) channel.onmessage = event => {
      if (event.data?.type === "signed-out") { this.lock("expired", "This browser was signed out in another tab. Sign in again."); if (this.owner && !this.pendingLogout) void this.start(); }
      else if (event.data?.type === "signed-in" && !this.pendingLogout) { if (this.ready) void this.check(); else void this.start(); }
    };
  }
  get ready() { return this.phase === "authenticated" || this.phase === "restoring"; }
  emit(phase = this.phase, message = this.message) {
    this.phase = phase; this.message = message;
    this.onChange({ phase, message, owner: this.owner, busy: this.busy, writes: this.writes, retryAfter: this.retryAfter || 0 });
  }
  invalidate() {
    this.epoch++;
    let timerError;
    try { this.clearTimer.call(globalThis, this.expiryTimer); this.expiryTimer = undefined; }
    catch (error) { timerError = sessionTimerError(error); }
    // A timer cleanup failure must not prevent request invalidation or locking.
    for (const controller of this.pending) controller.abort();
    this.pending.clear();
    return timerError;
  }
  lock(phase, message) {
    const preserve = this.ready || this.phase === "checking-session";
    const timerError = this.invalidate();
    if (timerError) { phase = "client-error"; message = timerError.message; }
    this.emit(phase, message);
    if (preserve && this.owner) {
      try { this.onSuspend(this.owner); }
      catch { this.onClear(); message = "Workspace locked. Drafts could not be retained."; }
    }
    this.emit(phase, message);
  }
  async raw(path, options = {}, managed = false) {
    const epoch = this.epoch, controller = new AbortController(), method = options.method || "GET";
    const write = managed && method !== "GET" && !path.startsWith("/api/auth/");
    this.pending.add(controller); if (write) { this.writes++; this.emit(); }
    try {
      let request;
      try {
        // Native Window.fetch requires its global receiver, including when injected.
        request = this.fetcher.call(globalThis, path, { method, credentials: "same-origin", cache: "no-store", redirect: "error", signal: controller.signal,
          headers: method === "GET" ? {} : { "Content-Type": "application/json", "X-Tracker-Token": this.csrf },
          body: method === "GET" ? undefined : JSON.stringify(options.body ?? {}) });
      } catch (error) { throw requestExecutionError(error); }
      const response = await request;
      const data = await response.json();
      if (epoch !== this.epoch) throw new AuthSuspended();
      if (!response.ok) {
        const error = new Error(typeof data.error === "string" ? data.error : "Request failed.");
        Object.assign(error, { status: response.status, code: data.code, retryAfter: Number(response.headers?.get?.("Retry-After")) || 0 });
        throw error;
      }
      return data;
    } catch (error) {
      if (epoch !== this.epoch || error.name === "AbortError") throw new AuthSuspended();
      if (!error.status && /illegal invocation/i.test(error.message || "")) error = requestExecutionError(error);
      if (managed) {
        if (error.code === "client-request-error") this.lock("client-error", error.message);
        else if (error.status === 401) this.lock("expired", "Your session expired or was revoked. Unsaved edits remain in this tab.");
        else if (error.code === "owner-setup-required") this.lock("setup-required", error.message);
        else if (error.code === "authentication-unavailable") this.lock("unavailable", error.message);
        else if (["invalid-csrf", "invalid-host", "invalid-origin", "access-denied"].includes(error.code)) this.lock("blocked", "Request protection rejected this operation. Reconnect, then explicitly retry your action.");
        else if (!error.status) this.lock("disconnected", "Cannot reach the local backend. Unsaved edits remain in this tab.");
        else throw error;
        throw new AuthSuspended(error.message);
      }
      throw error;
    } finally {
      this.pending.delete(controller); if (write) { this.writes--; this.emit(); }
    }
  }
  api(path, options = {}) {
    if (!this.ready) return Promise.reject(new AuthSuspended());
    if (!path.startsWith("/api/") || path.startsWith("/api/auth/")) return Promise.reject(new Error("Unsupported business API address."));
    return this.raw(path, options, true);
  }
  deadlines(metadata) {
    if (metadata?.authenticated !== true || !/^[a-f0-9]{32}$/.test(metadata.user?.id || "") || metadata.user?.role !== "owner"
        || !["idleRemainingSeconds", "absoluteRemainingSeconds"].every(key => Number.isInteger(metadata.session?.[key]) && metadata.session[key] > 0 && metadata.session[key] <= (key === "idleRemainingSeconds" ? 1800 : 28800))) throw new Error("Invalid authentication response.");
    try {
      this.clearTimer.call(globalThis, this.expiryTimer);
      const epoch = this.epoch;
      this.expiryTimer = this.setTimer.call(globalThis, () => {
        if (epoch === this.epoch) this.lock("expired", "Your session expired. Sign in again to recover eligible drafts.");
      }, Math.min(metadata.session.idleRemainingSeconds, metadata.session.absoluteRemainingSeconds) * 1000);
      this.expiryTimer.unref?.();
    } catch (error) { throw sessionTimerError(error); }
  }
  async accept(metadata, reload = true) {
    if (this.owner && this.owner.id !== metadata.user.id) { this.invalidate(); this.onClear(); }
    try { this.deadlines(metadata); }
    catch (error) { this.lock("client-error", error.message); throw new AuthSuspended(error.message); }
    const epoch = this.epoch;
    this.owner = metadata.user; this.emit("restoring", "Loading authorized workspace…");
    try { if (reload) await this.onAuthenticated(this.owner); }
    catch (error) {
      if (!error.authHandled) this.lock("unavailable", "Workspace records could not be revalidated. Reconnect to retry; no draft was saved.");
      throw new AuthSuspended();
    }
    if (epoch !== this.epoch) throw new AuthSuspended();
    this.emit("authenticated", "");
  }
  async bootstrap() {
    const data = await this.raw("/api/auth/status");
    if (typeof data.csrfToken !== "string" || !data.csrfToken || data.managerAuthorizationEnforced !== true) throw new Error("Backend owner authorization is not enabled.");
    this.csrf = data.csrfToken;
    if (data.state === "setup-required") { this.emit("setup-required", "Initialize the local owner from an interactive terminal."); return false; }
    if (data.state !== "ready") { this.emit("unavailable", "Authentication is unavailable. Review the local owner configuration."); return false; }
    return true;
  }
  start() {
    if (this.starting) return this.starting;
    this.starting = this.begin().finally(() => { this.starting = null; });
    return this.starting;
  }
  async begin() {
    if (this.pendingLogout) return this.logout(true);
    this.emit("checking", "Checking authentication…");
    try {
      if (await this.bootstrap()) await this.accept(await this.raw("/api/auth/session"));
    } catch (error) {
      if (error.authHandled) return;
      this.emit(error.code === "client-request-error" ? "client-error" : error.status === 401 ? "login" : error.status ? "unavailable" : "disconnected", error.status === 401 ? "Sign in to your local workspace." : error.message || "Cannot reach the local backend.");
    }
  }
  async login(username, password) {
    if (this.busy) return;
    this.busy = true; this.retryAfter = 0; this.emit(this.phase, "Signing in…");
    try {
      const result = await this.raw("/api/auth/login", { method: "POST", body: { username, password } });
      const verified = await this.raw("/api/auth/session");
      if (verified.user?.id !== result.user?.id) throw new Error("Owner session could not be verified.");
      await this.accept(verified); this.channel?.postMessage({ type: "signed-in" });
    } catch (error) {
      if (error.authHandled) return;
      this.retryAfter = error.retryAfter;
      const phase = error.code === "client-request-error" ? "client-error" : error.code === "owner-setup-required" ? "setup-required" : error.code === "authentication-unavailable" ? "unavailable" : error.status === 403 ? "blocked" : !error.status ? "disconnected" : "login";
      this.emit(phase, error.status === 401 ? "Invalid username or password." : error.status === 429 ? `Too many sign-in attempts. Retry in ${error.retryAfter} seconds.` : error.message);
    } finally { this.busy = false; this.emit(); }
  }
  check() {
    if (this.checking) return this.checking;
    if (!this.ready || this.busy) return Promise.resolve();
    this.checking = (async () => { try {
      const data = await this.raw("/api/auth/session", {}, true);
      if (this.owner?.id !== data.user?.id) { this.lock("expired", "Owner identity changed. Sign in again."); return; }
      this.deadlines(data);
    } catch (error) { if (!error.authHandled) this.lock(error.code === "client-request-error" ? "client-error" : "disconnected", error.code === "client-request-error" ? error.message : "Session verification failed. Reconnect."); }
    finally { this.checking = null; } })();
    return this.checking;
  }
  async verifyAction(action) {
    if (!this.ready || this.busy) throw new AuthSuspended();
    await this.check(); if (!this.ready) throw new AuthSuspended();
    return action();
  }
  async activity() {
    if (this.phase !== "authenticated" || this.now() - this.lastActivity < 60000) return;
    this.lastActivity = this.now();
    try { const data = await this.raw("/api/auth/activity", { method: "POST" }, true); if (data.user?.id !== this.owner?.id) { this.lock("expired", "Owner identity changed. Sign in again."); return; } this.deadlines(data); }
    catch (error) { if (!error.authHandled) this.lock(error.code === "client-request-error" ? "client-error" : "unavailable", error.code === "client-request-error" ? error.message : "Session activity could not be verified."); }
  }
  async logout(confirmed = false) {
    if (this.writes) { this.emit(this.phase, "Wait for the current save before signing out."); return false; }
    if (!confirmed && this.dirty() && !this.confirmDiscard()) return false;
    this.pendingLogout = true; const timerError = this.invalidate(); this.emit("signing-out", "Signing out…"); this.onClear();
    try {
      const status = await this.raw("/api/auth/status"); this.csrf = status.csrfToken;
      await this.raw("/api/auth/logout", { method: "POST" });
      this.pendingLogout = false; this.owner = null; this.channel?.postMessage({ type: "signed-out" });
      this.emit(timerError ? "client-error" : "login", timerError ? `Signed out on the server. ${timerError.message}` : "Signed out."); return true;
    } catch { this.emit("logout-unconfirmed", "Workspace locked. Server logout could not be confirmed. Retry sign out when the backend returns."); return false; }
  }
  bind(window, document) {
    const listen = (target, name, action) => { target.addEventListener?.(name, action); (this.listeners ??= []).push(() => target.removeEventListener?.(name, action)); };
    listen(window, "focus", () => void this.check());
    listen(window, "pageshow", event => { if (event.persisted) { this.lock("expired", "Rechecking restored workspace…"); void this.start(); } });
    listen(window, "pagehide", () => { if (this.ready) this.lock("expired", "Rechecking workspace…"); });
    for (const event of ["keydown", "pointerdown", "input"]) listen(document, event, input => { if (input.isTrusted && document.visibilityState !== "hidden" && document.hasFocus?.() !== false) void this.activity(); });
    this.poll = setInterval(() => { if (document.visibilityState !== "hidden") void this.check(); }, 60000); this.poll.unref?.();
  }
  dispose() { this.invalidate(); clearInterval(this.poll); this.channel?.close(); for (const stop of this.listeners || []) stop(); }
}
