// DOM adapter: authenticated data is plain text and never used as HTML.
import { bindWorkspaceEditor } from "./workspace-editor-view.mjs";
export function bindWorkspace(Controller, { document = globalThis.document, window = globalThis.window,
  auth, editor, now = Date.now } = {}) {
  const $ = id => document.getElementById(id);
  let current = null;
  let editorView = null;
  const panels = ["loading", "pairing", "pending", "paired", "login", "binding-review", "recovery", "authenticated-shell"];
  const clearPassword = () => { $("password").value = ""; };
  const render = view => {
    current = view;
    $("extension-workspace").setAttribute("aria-busy", String(view.busy));
    for (const panel of panels) $(panel).hidden = true;
    $("owner-header").hidden = true;
    $("candidate-name").textContent = ""; $("owner-name").textContent = "";
    $("binding-candidate").textContent = "";
    if (view.status === "signing-out") $("username").value = "";
    $("notice").textContent = view.notice; $("notice").hidden = !view.notice;
    $("error").textContent = view.error; $("error").hidden = !view.error;
    $("backend-status").textContent = "Local backend: " + ({ available: "Available", checking: "Checking", offline: "Unavailable", unknown: "Not verified",
      "setup-required": "Setup required", unavailable: "Authentication unavailable" }[view.backend] || "Not verified");
    $("backend-status").dataset.state = view.backend;
    const show = id => { $(id).hidden = false; };
    if (["checking", "signing-in", "signing-out", "reviewing-binding"].includes(view.status)) show("loading");
    else if (view.status === "unpaired") {
      show("pairing"); $("backend-id").textContent = view.identity?.backendId || "";
      $("workspace-id").textContent = view.identity?.workspaceId || "";
      $("confirm-backend").disabled = view.confirmed || view.busy;
      $("confirm-backend").textContent = view.confirmed ? "Backend confirmed" : "Confirm Backend";
    } else if (["pairing-pending", "pairing-expired"].includes(view.status)) {
      show("pending"); $("pending-label").textContent = "Browser: " + (view.pending?.label || "");
      $("approval-code").textContent = view.pending?.approvalCode || "No confirmed code";
      const seconds = Math.max(0, Math.ceil((Date.parse(view.pending?.expiresAt) - now()) / 1000));
      $("pending-expiry").textContent = view.status === "pairing-expired" ? "Expired. Clear the local exchange before requesting another."
        : `Expires in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
    } else if (view.status === "paired") show("paired");
    else if (["signed-out", "session-expired"].includes(view.status) || view.status === "binding-reassigned" && !view.metadata) show("login");
    else if (view.status === "binding-reassigned" && view.metadata) {
      show("binding-review"); $("binding-candidate").textContent = `Assigned candidate: ${view.metadata.context.candidate.name} · revision ${view.metadata.context.bindingRevision}`;
    } else if (view.status === "authenticated" && view.metadata) {
      show("authenticated-shell"); show("owner-header");
      $("candidate-name").textContent = "Candidate: " + view.metadata.context.candidate.name;
      $("owner-name").textContent = "Owner: " + view.metadata.user.username;
    } else {
      show("recovery"); $("recovery-detail").textContent = view.error || "Review this browser's connection and pairing in Web Extension Studio, then reconnect explicitly.";
    }
    $("pending-recovery").hidden = !(view.status === "recovery-required" && view.pending && !view.pending.credentialStored && view.pending.status !== "creating");
    $("clear-local-request").hidden = !(view.status === "recovery-required" && view.pending?.status === "creating");
    $("finish-cleanup").hidden = !(view.pending && (view.notice.includes("credential is stored") || view.error.includes("credential was stored")));
    if (!$("finish-cleanup").hidden) show("recovery");
    for (const button of document.querySelectorAll("button")) button.disabled = view.busy;
    $("confirm-backend").disabled = view.busy || view.confirmed;
    $("request-pairing").disabled = view.busy || !view.confirmed || view.retryAt > now();
    $("claim-pairing").disabled = view.busy || view.status !== "pairing-pending";
    $("accept-binding").disabled = view.busy || !$("binding-acknowledgement").checked;
    $("clear-pending").disabled = view.busy || !$("recovery-reviewed").checked;
    const wait = Math.max(0, Math.ceil((view.retryAt - now()) / 1000));
    $("sign-in").disabled = view.busy || wait > 0;
    $("login-retry").textContent = wait ? `Try again in ${wait} seconds.` : "";
    for (const tab of ["workspace", "settings"]) {
      const selected = view.tab === tab;
      $("tab-" + tab).setAttribute("aria-selected", String(selected));
      $("tab-" + tab).tabIndex = selected ? 0 : -1;
      $("panel-" + tab).hidden = !selected || view.status !== "authenticated";
    }
    if (view.status !== "binding-reassigned") $("binding-acknowledgement").checked = false;
    if (view.status !== "recovery-required") $("recovery-reviewed").checked = false;
    editorView?.render();
  };
  const controller = new Controller({ ...(auth ? { auth } : {}), ...(editor ? { editor } : {}), render, clearPassword, now });
  editorView = bindWorkspaceEditor(controller.editor, { document });
  $("pairing-form").addEventListener("submit", event => { event.preventDefault(); void controller.requestPairing($("browser-label").value); });
  $("login-form").addEventListener("submit", event => {
    event.preventDefault(); const username = $("username").value, password = $("password").value;
    clearPassword(); void controller.login(username, password);
  });
  const actions = {
    "confirm-backend": () => controller.confirmBackend(), "claim-pairing": () => controller.claimPairing(),
    "cancel-pending": () => controller.clearPending(), "clear-pending": () => controller.clearPending($("recovery-reviewed").checked),
    "clear-local-request": () => controller.clearPending(),
    "finish-cleanup": () => controller.clearPending(), "continue-login": () => controller.continueToLogin(),
    "reconnect": () => controller.boot(), "sign-out": () => controller.signOut(), "binding-sign-out": () => controller.signOut(),
    "accept-binding": () => $("binding-acknowledgement").checked && controller.acknowledge(current.metadata.context),
    "keep-signed-in": () => controller.keepSignedIn()
  };
  for (const [id, action] of Object.entries(actions)) $(id).addEventListener("click", () => { void action(); });
  for (const id of ["binding-acknowledgement", "recovery-reviewed"]) $(id).addEventListener("change", () => render(current));
  for (const tab of ["workspace", "settings"]) {
    $("tab-" + tab).addEventListener("click", () => controller.selectTab(tab));
    $("tab-" + tab).addEventListener("keydown", event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault(); const next = event.key === "Home" ? "workspace" : event.key === "End" ? "settings" : tab === "workspace" ? "settings" : "workspace";
      controller.selectTab(next); $("tab-" + next).focus();
    });
  }
  const unwatch = controller.auth.watch();
  const focus = () => { if (!controller.view.busy) void controller.boot(); };
  window.addEventListener("focus", focus);
  window.addEventListener("pageshow", focus);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      if (controller.view.metadata || controller.view.status === "signing-in") controller.suspend();
    } else focus();
  });
  window.addEventListener("pagehide", () => { controller.suspend(); clearPassword(); });
  window.addEventListener("unload", () => { unwatch(); controller.dispose(); editorView.dispose(); });
  void controller.boot();
  return controller;
}
