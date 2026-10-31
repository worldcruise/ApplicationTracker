// Web integration management only. No capture, native calls or filesystem grants.
export function extensionSetupAddress(extensionId, setupPage) {
  if (!/^[a-p]{32}$/.test(extensionId)) throw new Error("Save a valid installed extension ID first.");
  if (!["file-access", "legacy-popup"].includes(setupPage)) throw new Error("Unknown setup page.");
  return `chrome-extension://${extensionId}/${setupPage === "file-access" ? "studio.html" : "popup.html"}`;
}

export function probeExtension(extensionId, timeoutMs, runtime = globalThis.chrome?.runtime) {
  if (!/^[a-p]{32}$/.test(extensionId)) return Promise.reject(new Error("Save a valid installed extension ID first."));
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 15000) return Promise.reject(new Error("Diagnostic timeout must be 1000–15000 milliseconds."));
  if (typeof runtime?.sendMessage !== "function") return Promise.reject(new Error("Extension messaging is unavailable in this browser/page. Use Chrome, load the updated extension and reload this page. Installation cannot be determined here."));
  const nonce = globalThis.crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The extension did not respond before the timeout. Check its ID, enable/reload the updated extension and retry.")), timeoutMs);
    try {
      runtime.sendMessage(extensionId, { type: "tracker:diagnostics", protocolVersion: 1, nonce }, response => {
        clearTimeout(timer);
        if (runtime.lastError) { reject(new Error(`Extension check failed: ${runtime.lastError.message}. Check the installed ID and reload the updated extension.`)); return; }
        if (!response || response.protocolVersion !== 1 || response.nonce !== nonce || response.extensionId !== extensionId || typeof response.version !== "string" || !response.version.trim() || response.version.length > 80) {
          reject(new Error("The extension returned an incompatible diagnostic response. Reload the matching extension package.")); return;
        }
        resolve({ extensionId, version: response.version });
      });
    } catch (error) { clearTimeout(timer); reject(new Error(`Extension messaging failed: ${error.message}`)); }
  });
}

import { mergeDraft, captureFields, restoreFields } from "./auth.mjs";
export function initializeExtensionStudio({ api, probe = probeExtension, authorize = action => action() }) {
  const $ = id => document.getElementById(id);
  const pairings = initializeBrowserPairings({ api, authorize });
  let snapshot, preferencesDirty = false, deviceDirty = false, saving = false, loadEpoch = 0, probeEpoch = 0, browserReport = null;
  const notice = (text, error = false) => { const target = $("extension-notice"); target.hidden = !text; target.textContent = text; target.className = `notice ${error ? "error" : "success"}`; };
  let suspended = false;
  const run = async action => { if (suspended) return; try { await action(); } catch (error) { if (!error.authHandled && !suspended) notice(error.message, true); } };
  function buttons() {
    $("extension-device-fields").disabled = suspended || !snapshot || saving;
    $("extension-preferences-fields").disabled = suspended || !snapshot || saving;
    $("extension-device-save").disabled = !snapshot || saving || !deviceDirty;
    $("extension-preferences-save").disabled = !snapshot || saving || !preferencesDirty;
    $("extension-probe").disabled = !snapshot?.device.data.extensionId || deviceDirty || saving;
    $("extension-copy-setup").disabled = !snapshot?.device.data.extensionId || deviceDirty || preferencesDirty || saving;
    $("extension-copy-diagnostics").disabled = !snapshot || saving;
    $("extension-refresh").disabled = saving;
  }
  function connection(text = "Not checked", detail = "Check this browser after saving an installed extension ID.") {
    $("extension-connection-status").textContent = text; $("extension-connection-detail").textContent = detail;
  }
  function render(scope) {
    if (!snapshot) return;
    if (!scope || scope === "preferences") {
      $("extension-setup-page").value = snapshot.preferences.data.setupPage;
      $("extension-confirm-copy").checked = snapshot.preferences.data.confirmSetupCopy;
      $("extension-preferences-state").textContent = snapshot.preferences.revision ? "Saved" : "Defaults · not saved";
    }
    if (!scope || scope === "device") {
      const data = snapshot.device.data;
      $("extension-device-label").value = data.label; $("extension-id-setting").value = data.extensionId; $("extension-timeout").value = data.probeTimeoutMs;
      $("extension-device-state").textContent = snapshot.device.revision ? "Saved on this computer" : "Not configured";
    }
    $("extension-setup-address").textContent = snapshot.device.data.extensionId ? extensionSetupAddress(snapshot.device.data.extensionId, snapshot.preferences.data.setupPage) : "Save an extension ID to prepare its setup-page address.";
    const target = $("extension-diagnostics"); target.replaceChildren();
    const pkg = snapshot.diagnostics.package;
    for (const [label, value] of [["Manager API", "Reached on last settings load"], ["Packaged extension", pkg.status === "available" ? `${pkg.name} · ${pkg.version}` : pkg.detail], ["Runtime diagnostic bridge", pkg.diagnosticBridge ? "Declared by the local package; check this browser separately" : "Not declared by the local package"], ["Native host", "Not tested; legacy capture verification required"], ["Browser bindings", "Owner-managed below; extension login/transport pending"], ["Bid-folder saving", "Pending writer and duplicate/failure protections"]]) {
      const group = document.createElement("div"), term = document.createElement("dt"), valueNode = document.createElement("dd"); term.textContent = label; valueNode.textContent = value; group.append(term, valueNode); target.append(group);
    }
    buttons();
  }
  async function load() {
    pairings.suspend();
    const epoch = ++loadEpoch; probeEpoch++; browserReport = null; snapshot = null; buttons();
    notice("Loading Extension Studio settings…"); $("extension-backend-status").textContent = "Checking…"; connection();
    $("extension-device-state").textContent = $("extension-preferences-state").textContent = "Loading";
    try {
      const result = await api("/api/studio/extension"); if (epoch !== loadEpoch) return;
      snapshot = result; preferencesDirty = deviceDirty = false; render();
      $("extension-backend-status").textContent = "Backend reached";
      notice(!result.device.data.extensionId ? "No extension ID is configured on this computer. Save its ID, then run a browser check." : "Settings loaded. Browser connection has not been checked.");
      await pairings.load();
    } catch (error) {
      if (epoch !== loadEpoch) return;
      $("extension-backend-status").textContent = "Settings unavailable";
      $("extension-device-state").textContent = $("extension-preferences-state").textContent = "Load failed";
      $("extension-diagnostics").replaceChildren(); notice(`Settings could not load: ${error.message} Retry Reload settings; existing files were not replaced.`, true);
    }
  }
  function discard() { preferencesDirty = deviceDirty = false; if (snapshot) render(); }
  function fields(scope) {
    return scope === "preferences" ? { setupPage: $("extension-setup-page").value, confirmSetupCopy: $("extension-confirm-copy").checked }
      : { label: $("extension-device-label").value, extensionId: $("extension-id-setting").value, probeTimeoutMs: Number($("extension-timeout").value) };
  }
  function changed(scope) {
    return Boolean(snapshot && Object.entries(fields(scope)).some(([key, value]) => value !== snapshot[scope].data[key]));
  }
  async function save(scope, event) {
    event.preventDefault(); if (!snapshot || saving || !changed(scope)) return;
    const data = fields(scope), epoch = loadEpoch;
    if (scope === "device") {
      if (data.extensionId && !/^[a-p]{32}$/.test(data.extensionId)) throw new Error("Extension ID must contain 32 lowercase letters a–p, or be empty.");
      if (data.label.length > 80) throw new Error("Computer label must be at most 80 characters.");
      if (!Number.isInteger(data.probeTimeoutMs) || data.probeTimeoutMs < 1000 || data.probeTimeoutMs > 15000) throw new Error("Diagnostic timeout must be an integer from 1000 to 15000 milliseconds.");
    }
    saving = true; buttons();
    try {
      const response = await api(`/api/studio/extension/${scope}`, { method: "PUT", body: { data, revision: snapshot[scope].revision } });
      if (epoch !== loadEpoch) return;
      snapshot[scope] = response;
      if (scope === "device") { deviceDirty = false; probeEpoch++; browserReport = null; connection(); } else preferencesDirty = false;
      render(scope); notice(scope === "device" ? (data.extensionId ? "Device settings saved. Run a browser check to verify a response." : "Device settings saved. Add an extension ID before checking this browser.") : "Workspace setup preferences saved.");
      if (scope === "device") await pairings.load();
    } catch (error) { if (!error.authHandled && epoch === loadEpoch) notice(`Save failed: ${error.message} Your edits are retained; reload and reconcile if the revision changed.`, true); }
    finally { saving = false; buttons(); }
  }
  async function copy(text, confirmSetup = false) {
    await authorize(() => {});
    if (confirmSetup && snapshot.preferences.data.confirmSetupCopy && !window.confirm("Copy this extension setup address to the clipboard?")) return;
    if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable in this browser.");
    try { await navigator.clipboard.writeText(text); } catch { throw new Error("Clipboard copy failed. Check browser permissions and try again."); }
    notice("Copied to clipboard.");
  }
  function deviceEdited() {
    deviceDirty = changed("device"); probeEpoch++; browserReport = null;
    connection("Not checked", deviceDirty ? "Device settings changed. Save before checking this browser." : "Check this browser using the loaded settings.");
    $("extension-device-state").textContent = deviceDirty ? "Unsaved changes" : snapshot?.device.revision ? "Saved on this computer" : "Not configured";
    buttons();
  }
  function preferencesEdited() {
    preferencesDirty = changed("preferences");
    $("extension-preferences-state").textContent = preferencesDirty ? "Unsaved changes" : snapshot?.preferences.revision ? "Saved" : "Defaults · not saved";
    buttons();
  }
  for (const event of ["input", "change"]) {
    $("extension-device-form").addEventListener(event, deviceEdited);
    $("extension-preferences-form").addEventListener(event, preferencesEdited);
  }
  $("extension-device-form").addEventListener("submit", event => run(() => save("device", event)));
  $("extension-preferences-form").addEventListener("submit", event => run(() => save("preferences", event)));
  $("extension-refresh").addEventListener("click", () => run(async () => { if (saving || (preferencesDirty || deviceDirty) && !window.confirm("Discard unsaved extension settings and reload?")) return; await load(); }));
  $("extension-probe").addEventListener("click", () => run(async () => {
    if (!snapshot || deviceDirty || saving) return;
    const epoch = ++probeEpoch, data = snapshot.device.data; connection("Checking…", "Waiting for a diagnostic response from this browser's extension.");
    try {
      const result = await probe(data.extensionId, data.probeTimeoutMs); if (epoch !== probeEpoch) return;
      browserReport = { ...result, checkedAt: new Date().toISOString() };
      connection("Extension responded", `Version ${result.version} · checked ${browserReport.checkedAt}. This does not verify pairing, Native Messaging, capture or file access.`);
    } catch (error) { if (epoch === probeEpoch) { browserReport = null; connection("Response unavailable", error.message); notice(error.message, true); } }
  }));
  $("extension-copy-setup").addEventListener("click", () => run(async () => { if (snapshot && !deviceDirty && !preferencesDirty) await copy(extensionSetupAddress(snapshot.device.data.extensionId, snapshot.preferences.data.setupPage), true); }));
  $("extension-copy-diagnostics").addEventListener("click", () => run(async () => { if (snapshot) await copy(JSON.stringify({ schemaVersion: 1, diagnostics: snapshot.diagnostics, browserReport }, null, 2)); }));
  buttons();
  function suspend() {
    pairings.suspend();
    const draft = snapshot ? { snapshot: structuredClone(snapshot),
      preferences: preferencesDirty ? fields("preferences") : null, device: deviceDirty ? fields("device") : null,
      forms: { preferences: captureFields($("extension-preferences-form")), device: captureFields($("extension-device-form")) } } : null;
    suspended = true; probeEpoch++; loadEpoch++; buttons(); return draft;
  }
  function clear() {
    pairings.suspend();
    suspended = true; snapshot = browserReport = null; preferencesDirty = deviceDirty = saving = false; probeEpoch++; loadEpoch++;
    for (const id of ["extension-device-label", "extension-id-setting", "extension-timeout"]) $(id).value = "";
    $("extension-diagnostics").replaceChildren(); $("extension-setup-address").textContent = ""; connection("Not checked", "Sign in before loading settings."); notice(""); buttons();
  }
  async function resume(draft, approval) {
    suspended = false; await load();
    if (!snapshot) throw new Error("Extension settings could not be reloaded.");
    const key = JSON.stringify([snapshot.preferences.revision, snapshot.device.revision]), conflicts = [];
    for (const scope of ["preferences", "device"]) if (draft?.[scope] && draft.snapshot[scope].revision !== snapshot[scope].revision)
      conflicts.push({ label: `Extension ${scope}`, saved: snapshot[scope].data, draft: draft[scope] });
    if (!conflicts.length || approval === key) {
      for (const scope of ["preferences", "device"]) if (draft?.[scope]) {
        const merged = mergeDraft(draft.snapshot[scope].data, draft[scope], snapshot[scope].data);
        if (scope === "preferences") { $("extension-setup-page").value = merged.setupPage; $("extension-confirm-copy").checked = merged.confirmSetupCopy; }
        else { $("extension-device-label").value = merged.label; $("extension-id-setting").value = merged.extensionId; $("extension-timeout").value = merged.probeTimeoutMs; }
        if (draft.snapshot[scope].revision === snapshot[scope].revision) restoreFields($("extension-" + scope + "-form"), draft.forms[scope]);
      }
      preferencesDirty = changed("preferences"); deviceDirty = changed("device"); buttons();
    }
    return { key, conflicts, approval: key };
  }
  return { load, discard, suspend, resume, clear, leave() { probeEpoch++; loadEpoch++; pairings.suspend(); }, get dirty() { return preferencesDirty || deviceDirty; }, get saving() { return saving || pairings.saving; } };
}

export function initializeBrowserPairings({ api, authorize = action => action() }) {
  const $ = id => document.getElementById(id);
  let snapshot = null, epoch = 0, locked = true, busy = false;
  const notice = (text, error = false) => { $("pairing-notice").textContent = text; $("pairing-notice").className = error ? "field-result error" : "field-help"; };
  const element = (tag, text) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; return node; };
  function controls() {
    $("pairing-refresh").disabled = busy || locked;
    for (const container of [$("pairing-requests"), $("pairing-installations")]) {
      for (const control of container.querySelectorAll("button,select,input")) control.disabled = locked || busy || control.dataset.unavailable === "true";
    }
  }
  function selector(row, pending) {
    const select = element("select"); select.id = `pairing-candidate-${row.id}`;
    select.setAttribute("aria-label", `Candidate assigned to ${row.label}`);
    const empty = element("option", "Choose a candidate"); empty.value = ""; select.append(empty);
    for (const candidate of snapshot.candidates) { const option = element("option", `${candidate.name} · ${candidate.id}`); option.value = candidate.id; select.append(option); }
    select.value = pending ? "" : row.candidateId;
    return select;
  }
  function button(label, id, action) {
    const node = element("button", label); node.id = id; node.type = "button"; node.className = "button secondary";
    node.addEventListener("click", action); return node;
  }
  async function write(path, method, body, message) {
    if (locked || busy) return;
    const current = epoch;
    busy = true; controls();
    try {
      await authorize(() => {});
      if (current !== epoch || locked || !window.confirm(message)) return;
      await api(path, { method, body });
      if (current !== epoch || locked) return;
      await load();
      if (!locked && snapshot) notice("Saved. Current browser bindings were reloaded.");
    } catch (error) {
      if (current === epoch && !locked && !error.authHandled) notice(`${error.message} Refresh and review before retrying; the operation was not replayed.`, true);
    } finally { if (current === epoch) { busy = false; controls(); } }
  }
  function render() {
    $("pairing-requests").replaceChildren(); $("pairing-installations").replaceChildren();
    for (const request of snapshot.requests) {
      const card = element("article"); card.className = "pairing-record";
      card.append(element("strong", request.label), element("code", request.approvalCode), element("p", `${request.extensionOrigin} · ${request.state} · expires ${request.expiresAt}`));
      const candidate = selector(request, true), verifyLabel = element("label"); verifyLabel.className = "checkbox-row";
      const verified = element("input"); verified.type = "checkbox"; verified.id = `pairing-verified-${request.id}`;
      verifyLabel.append(verified, element("span", "I verified this browser label and approval code."));
      const approve = button("Approve pairing", `pairing-approve-${request.id}`, () => {
        if (!verified.checked || !candidate.value || locked || busy) return;
        return write(`/api/studio/extension/pairings/${request.id}/approve`, "POST", { candidateId: candidate.value, revision: request.revision }, `Approve ${request.label} (${request.approvalCode}) for the selected candidate?`);
      });
      const update = () => { approve.dataset.unavailable = String(!verified.checked || !candidate.value); controls(); };
      verified.addEventListener("change", update); candidate.addEventListener("change", update);
      const deny = button("Deny request", `pairing-deny-${request.id}`, () => write(`/api/studio/extension/pairings/${request.id}/deny`, "POST", { revision: request.revision }, `Deny the pairing request from ${request.label}?`));
      const actions = element("div"); actions.className = "toolbar"; actions.append(approve, deny);
      card.append(candidate, verifyLabel, actions); $("pairing-requests").append(card); update();
    }
    for (const row of snapshot.installations) {
      const card = element("article"); card.className = "pairing-record";
      card.append(element("strong", row.label), element("p", `${row.id} · ${row.extensionOrigin}`), element("p", `Pairing request: ${row.pairingId || "Not recorded"}`), element("p", `Candidate: ${row.candidateName || "Unavailable"} · ${row.revoked ? "Revoked" : row.usable ? "Approved; online status not checked" : "Unavailable; pair again"} · revision ${row.bindingRevision}`));
      const candidate = selector(row, false);
      candidate.dataset.unavailable = String(!row.usable);
      const save = button("Save candidate binding", `pairing-save-${row.id}`, () => {
        if (!candidate.value || candidate.value === row.candidateId || !row.usable || locked || busy) return;
        return write(`/api/studio/extension/installations/${row.id}/binding`, "PUT", { candidateId: candidate.value, revision: row.bindingRevision }, `Reassign ${row.label}? Its previous binding context will become invalid.`);
      });
      const update = () => { save.dataset.unavailable = String(!row.usable || !candidate.value || candidate.value === row.candidateId); controls(); };
      candidate.addEventListener("change", update);
      const revoke = button("Revoke installation", `pairing-revoke-${row.id}`, () => write(`/api/studio/extension/installations/${row.id}/revoke`, "POST", { revision: row.bindingRevision }, `Revoke ${row.label}? It will need a new pairing.`));
      revoke.dataset.unavailable = String(row.revoked);
      const actions = element("div"); actions.className = "toolbar"; actions.append(save, revoke);
      card.append(candidate, actions); $("pairing-installations").append(card); update();
    }
    if (!snapshot.requests.length) $("pairing-requests").append(element("p", "No pending browser requests."));
    if (!snapshot.installations.length) $("pairing-installations").append(element("p", "No approved browser installations."));
    controls();
  }
  async function load() {
    const current = ++epoch; locked = false; busy = true; snapshot = null;
    $("pairing-requests").replaceChildren(); $("pairing-installations").replaceChildren(); controls(); notice("Loading browser pairings…");
    try {
      const result = await api("/api/studio/extension/pairings");
      if (current !== epoch || locked) return;
      if (!result || !Array.isArray(result.requests) || !Array.isArray(result.installations) || !Array.isArray(result.candidates)) throw new Error("Invalid pairing response.");
      snapshot = result; busy = false; render(); notice("Bindings loaded. Enrollment/login UI remains pending; no online status is inferred.");
    } catch (error) { if (current === epoch && !locked && !error.authHandled) notice(`Pairings unavailable: ${error.message}`, true); }
    finally { if (current === epoch) { busy = false; controls(); } }
  }
  function suspend() { epoch++; locked = true; busy = false; snapshot = null; $("pairing-requests").replaceChildren(); $("pairing-installations").replaceChildren(); notice("Sign in and reload to manage browser pairings."); controls(); }
  $("pairing-refresh").addEventListener("click", () => { if (!busy) return load(); });
  suspend();
  return { load, suspend, get saving() { return busy; } };
}
