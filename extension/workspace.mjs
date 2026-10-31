import { ExtensionAuthClient } from "./studio/auth.mjs";
import { bindWorkspace } from "./studio/workspace-view.mjs";
import { WorkspaceEditor } from "./studio/workspace-editor.mjs";

export class WorkspaceController {
  constructor({ auth = new ExtensionAuthClient(), editor = new WorkspaceEditor(), render = () => {}, clearPassword = () => {}, now = Date.now,
    setTimer = globalThis.setTimeout, clearTimer = globalThis.clearTimeout } = {}) {
    Object.assign(this, { auth, editor, enrollment: auth.enrollment, render, clearPassword, now, setTimer, clearTimer });
    this.generation = 0; this.timer = null; this.tickTimer = null;
    this.view = { status: "checking", backend: "checking", identity: null, confirmed: false,
      pending: null, metadata: null, busy: false, notice: "", error: "", retryAt: 0, tab: "workspace" };
    this.unsubscribe = auth.subscribe(reason => {
      if (this.view.metadata || this.view.status === "signing-in" && ["session-changed", "installation-changed"].includes(reason)) this.suspend(reason);
    });
  }
  paint(patch = {}) {
    Object.assign(this.view, patch);
    if (this.view.status === "authenticated" && this.view.metadata) this.editor.activate(this.view.metadata);
    else this.editor.suspend({ discard: ["binding-reassigned", "installation-revoked", "signing-out"].includes(this.view.status) });
    this.render(structuredClone(this.view));
  }
  timersOff() {
    for (const name of ["timer", "tickTimer"]) {
      if (this[name] !== null) this.clearTimer.call(globalThis, this[name]);
      this[name] = null;
    }
  }
  suspend(reason = "session-check-required") {
    this.generation++; this.clearPassword();
    this.editor.suspend({ discard: ["session-changed", "installation-changed", "signed-out"].includes(reason) });
    this.paint({ status: reason === "installation-changed" ? "binding-reassigned" : "session-expired",
      metadata: null, busy: false, notice: "Workspace locked. Reconnect and verify your session before continuing." });
    try { this.timersOff(); } catch {
      this.paint({ status: "client-error", error: "Browser session cleanup failed. The workspace remains locked." });
    }
  }
  fail(error) {
    const code = error?.code;
    const pairingLimited = error?.status === 429 && code !== "rate-limited";
    const state = pairingLimited ? "unpaired" : code === "incognito-unsupported" ? "incognito" : code === "identity-mismatch" ? "identity-mismatch"
      : code === "binding-changed" ? "binding-reassigned"
      : ["installation-unavailable", "candidate-unavailable"].includes(code) ? "installation-revoked"
      : code === "authentication-required" ? "session-expired"
      : code === "invalid-credentials" || code === "rate-limited" ? "signed-out"
      : code === "connection-unavailable" ? "disconnected"
      : code === "client-execution-error" ? "client-error"
      : code === "setup-required" || code === "owner-setup-required" ? "setup-required"
      : error?.status === 503 ? "authentication-unavailable" : "recovery-required";
    const messages = {
      "unpaired": "Too many pairing requests. Wait before explicitly requesting another exchange.",
      "signed-out": code === "rate-limited" ? "Too many sign-in attempts. Wait before trying again." : "Invalid username or password.",
      "session-expired": "Your session expired or was invalidated. Sign in again explicitly.",
      "binding-reassigned": "The browser assignment changed. Sign in again and review the current candidate.",
      "installation-revoked": "Browser authorization is unavailable. It may be revoked, reset or have an unavailable candidate. Review Web Extension Studio. Stored credentials were preserved.",
      "disconnected": "No backend response was confirmed. Start the manager at 127.0.0.1:8765 and check extension/network permissions.",
      "client-error": "A local browser operation failed. The workspace remains locked; this is not proof of a backend outage.",
      "identity-mismatch": "Backend/workspace identity does not match the confirmed identity. Nothing was replaced. Review the manager before continuing.",
      "incognito": "The authenticated workspace supports ordinary Chrome profiles only. Incognito is not an independent installation. Legacy extension features remain separate.",
      "setup-required": "Complete owner and device setup in Web Studio. This extension will not create an account or backend identity.",
      "authentication-unavailable": "Authentication is unavailable. Review local owner/private storage or session capacity in Web Studio.",
      "recovery-required": "The session or storage operation could not be confirmed. Review Web Studio and reconnect explicitly. Nothing was replaced."
    };
    this.paint({ status: state, metadata: null, busy: false, error: messages[state],
      backend: state === "disconnected" ? "offline" : ["identity-mismatch", "incognito", "client-error"].includes(state) ? "unknown"
        : state === "authentication-unavailable" ? "unavailable" : this.view.backend,
      ...(state === "binding-reassigned" ? { tab: "workspace" } : {}),
      retryAt: code === "rate-limited" || pairingLimited ? this.now() + (error.retryAfter || 300) * 1000 : 0 });
    if (code === "rate-limited" || pairingLimited) this.ticking();
  }
  async inspect() {
    await this.auth.prepare();
    const bootstrap = await this.enrollment.getBootstrap();
    if (bootstrap.state !== "ready") return { status: bootstrap.state === "setup-required" ? "setup-required" : "authentication-unavailable",
      backend: bootstrap.state, metadata: null, error: "Review owner and device setup in Web Studio. No protected data has been loaded." };
    const identity = { backendId: bootstrap.backendId, workspaceId: bootstrap.workspaceId };
    const pin = await this.enrollment.pin();
    const installation = await this.enrollment.getInstallationCredential();
    const pending = await this.enrollment.getPendingPairing();
    const common = { backend: "available", identity, confirmed: Boolean(pin), pending, error: "", notice: "" };
    if (installation) {
      if (pending) return { ...common, status: "recovery-required", metadata: null,
        pending: { ...pending, credentialStored: true }, notice: "An installation credential is stored. Finish local pairing cleanup; never replay the claim." };
      const result = await this.auth.restore();
      return { ...common, ...result, pending: pending ? { ...pending, credentialStored: true } : null,
        notice: pending ? "An installation credential is stored. Finish local pairing cleanup; never replay the claim." : "" };
    }
    return { ...common, metadata: null, status: !pending ? "unpaired" : pending.status === "expired" ? "pairing-expired"
      : ["claiming", "claim-uncertain"].includes(pending.status) ? "recovery-required"
        : pending.status === "creating" ? "recovery-required" : "pairing-pending" };
  }
  async run(action, status = null) {
    if (this.view.busy) return;
    const generation = ++this.generation;
    this.paint({ busy: true, error: "", ...(status ? { status, metadata: null } : {}) });
    if (status) {
      try { this.timersOff(); } catch {
        await this.auth.lock("client-execution-error").catch(() => {});
        if (generation === this.generation) this.fail({ code: "client-execution-error" });
        return;
      }
    }
    try {
      const result = await action();
      if (generation !== this.generation) return;
      await this.adopt(result, generation);
    } catch (error) { if (generation === this.generation) this.fail(error); }
  }
  async adopt(result, generation) {
    try { this.timersOff(); } catch {
      await this.auth.lock("client-execution-error").catch(() => {});
      if (generation === this.generation) this.fail({ code: "client-execution-error" });
      return;
    }
    if (result.status === "authenticated" || result.state === "authenticated") {
      try {
        const seconds = Math.min(result.metadata.session.idleRemainingSeconds, result.metadata.session.absoluteRemainingSeconds);
        this.timer = this.setTimer.call(globalThis, () => {
          this.suspend("session-expired");
          void this.auth.lock("session-expired").catch(() => {});
        }, seconds * 1000);
      } catch {
        await this.auth.lock("client-execution-error").catch(() => {});
        this.fail({ code: "client-execution-error" }); return;
      }
    }
    this.paint({ ...result, status: result.state || result.status || this.view.status, busy: false,
      ...(result.state === "binding-reassigned" ? { tab: "workspace" } : {}) });
    if (this.view.pending && !this.view.metadata || this.view.retryAt > this.now()) this.ticking();
  }
  ticking() {
    if (this.tickTimer !== null) return;
    try {
      this.tickTimer = this.setTimer.call(globalThis, () => {
        this.tickTimer = null;
        if (this.view.pending?.expiresAt && this.now() >= Date.parse(this.view.pending.expiresAt) && this.view.status === "pairing-pending")
          this.view.status = "pairing-expired";
        this.paint();
        if (this.view.status === "pairing-pending" || this.view.retryAt > this.now()) this.ticking();
      }, 1000);
    } catch { this.paint({ status: "client-error", metadata: null, busy: false, error: "The browser timer could not start. Reconnect explicitly." }); }
  }
  boot() {
    this.clearPassword();
    return this.run(() => this.inspect(), "checking");
  }
  confirmBackend() {
    return this.run(async () => {
      await this.enrollment.confirmBackendIdentity(this.view.identity);
      return { confirmed: true, notice: "Backend/workspace identity confirmed." };
    });
  }
  requestPairing(label) {
    return this.run(async () => {
      try {
        return { status: "pairing-pending", pending: await this.enrollment.requestPairing(label),
          notice: "Review this approval code in Web Extension Studio. No candidate has been selected here." };
      } catch (error) {
        const pending = await this.enrollment.getPendingPairing();
        if (pending) return { status: "recovery-required", pending, retryAt: error.status === 429 ? this.now() + 300000 : 0,
          error: error.status === 429 ? "Too many pairing requests. Clear the local request, then wait before explicitly requesting another exchange."
            : "Pairing creation was not confirmed. Review Web Studio and clear the local request explicitly before trying again." };
        if (error.code === "invalid-label") return { status: "unpaired", error: "Enter a browser label of 1–80 printable characters." };
        throw error;
      }
    });
  }
  claimPairing() {
    return this.run(async () => {
      try {
        const result = await this.enrollment.claimPairing();
        return result.status === "pending" ? { notice: "Owner approval is still pending. Claim again only after approval." }
          : { status: "paired", pending: null, notice: "Browser paired. Sign in with the owner account to continue." };
      } catch (error) {
        const pending = await this.enrollment.getPendingPairing();
        return { status: "recovery-required", pending: pending && error.code === "credential-stored-cleanup-required" ? { ...pending, credentialStored: true } : pending,
          error: error.code === "credential-stored-cleanup-required" ? "The credential was stored, but cleanup failed. Finish local cleanup; never replay the claim."
            : error.status === 409 ? "The pairing was denied or already consumed. Do not replay the claim. Review Web Studio."
              : error.status === 410 ? "This pairing expired. Review and clear the local exchange; do not replay the claim."
                : "Claim delivery or credential storage is uncertain. Do not retry. Review Web Studio and revoke any installation from this exchange before clearing it." };
      }
    });
  }
  clearPending(reviewed = false) {
    return this.run(async () => {
      await this.enrollment.clearPendingEnrollment({ acknowledgeRevocation: reviewed });
      return { ...await this.inspect(), notice: "Local pending enrollment cleared. This did not cancel or revoke anything on the server." };
    });
  }
  continueToLogin() { this.paint({ status: "signed-out", notice: "", error: "" }); }
  login(username, password) {
    this.clearPassword();
    return this.run(() => this.auth.login(username, password), "signing-in");
  }
  acknowledge(context) { return this.run(() => this.auth.acknowledgeBinding(context), "reviewing-binding"); }
  keepSignedIn() { return this.run(() => this.auth.restore({ activity: true }), "checking"); }
  async signOut() {
    const generation = ++this.generation;
    this.editor.clear();
    this.clearPassword(); this.paint({ status: "signing-out", metadata: null, busy: true, tab: "workspace", error: "", notice: "" });
    try { this.timersOff(); } catch { /* Local content is already locked. */ }
    const result = await this.auth.logout();
    if (generation !== this.generation) return;
    this.paint({ status: "signed-out", busy: false, backend: result.serverConfirmed ? "available" : "unknown",
      notice: result.serverConfirmed ? "Signed out. The installation credential was preserved." : "",
      error: result.serverConfirmed ? "" : "Server sign-out could not be confirmed." + (result.localCleared ? " Local session state was cleared." : " Local storage cleanup also requires review.") });
  }
  selectTab(tab) { if (this.view.status === "authenticated" && ["workspace", "settings"].includes(tab)) this.paint({ tab }); }
  dispose() { this.generation++; this.unsubscribe(); this.editor.clear(); this.view.metadata = null; this.clearPassword(); this.timersOff(); }
}

if (globalThis.document?.getElementById("extension-workspace")) bindWorkspace(WorkspaceController);
