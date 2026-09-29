const elements = {
  activeSummary: document.getElementById("active-summary"),
  addCandidate: document.getElementById("add-candidate"),
  emptyAdd: document.getElementById("empty-add"),
  refresh: document.getElementById("refresh"),
  notice: document.getElementById("notice"),
  candidateCount: document.getElementById("candidate-count"),
  candidateList: document.getElementById("candidate-list"),
  emptyState: document.getElementById("empty-state"),
  dialog: document.getElementById("candidate-dialog"),
  dialogTitle: document.getElementById("dialog-title"),
  closeDialog: document.getElementById("close-dialog"),
  cancelDialog: document.getElementById("cancel-dialog"),
  form: document.getElementById("candidate-form"),
  name: document.getElementById("candidate-name"),
  historyFolder: document.getElementById("history-folder"),
  browseFolder: document.getElementById("browse-folder"),
  promptChoicePaste: document.getElementById("prompt-choice-paste"),
  promptChoiceFile: document.getElementById("prompt-choice-file"),
  promptPastePanel: document.getElementById("prompt-paste-panel"),
  promptFilePanel: document.getElementById("prompt-file-panel"),
  promptTemplate: document.getElementById("prompt-template"),
  promptFilePath: document.getElementById("prompt-file-path"),
  browsePrompt: document.getElementById("browse-prompt"),
  extensionId: document.getElementById("extension-id"),
  makeActive: document.getElementById("set-active-after-save"),
  testFolder: document.getElementById("test-folder"),
  folderResult: document.getElementById("folder-result"),
  saveCandidate: document.getElementById("save-candidate"),
  formError: document.getElementById("form-error"),
  registrationNote: document.getElementById("registration-note")
};

let state = { schemaVersion: 1, activeCandidateId: null, candidates: [] };
let sessionToken = "";
let editingCandidateId = null;
let selectingCandidate = false;
let deletingCandidateId = null;

function updatePromptMethod() {
  const useFile = elements.promptChoiceFile.checked;
  elements.promptPastePanel.hidden = useFile;
  elements.promptFilePanel.hidden = !useFile;
  elements.promptTemplate.disabled = useFile;
  elements.promptFilePath.disabled = !useFile;
}

async function api(path, options = {}) {
  const method = options.method || "GET";
  const headers = {};

  if (method !== "GET") {
    headers["Content-Type"] = "application/json";
    headers["X-Tracker-Token"] = sessionToken;
  }

  const response = await fetch(path, {
    method,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
    cache: "no-store"
  });

  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.error || `Request failed: ${response.status}`);
  }
  return result;
}

function showNotice(message, kind = "success") {
  elements.notice.textContent = message;
  elements.notice.className = `notice ${kind}`;
  elements.notice.hidden = !message;
}

function setFolderResult(message, kind = "") {
  elements.folderResult.textContent = message;
  elements.folderResult.className = `field-result ${kind}`;
}

function makeElement(tag, className, text = "") {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
}

function detail(label, value) {
  const line = makeElement("div", "candidate-detail");
  line.append(makeElement("span", "detail-label", `${label}: `));
  line.append(document.createTextNode(value || "Not configured"));
  return line;
}

function render() {
  const candidates = state.candidates || [];
  const active = candidates.find(candidate => candidate.id === state.activeCandidateId);

  elements.candidateCount.textContent = String(candidates.length);
  elements.activeSummary.textContent = active ? `Active: ${active.name}` : "No active candidate";
  elements.activeSummary.classList.toggle("has-active", Boolean(active));
  elements.candidateList.replaceChildren();
  elements.emptyState.hidden = candidates.length > 0;

  for (const candidate of candidates) {
    const isActive = candidate.id === state.activeCandidateId;
    const row = makeElement("article", `candidate-row${isActive ? " is-active" : ""}`);
    const info = makeElement("div", "candidate-info");
    const name = makeElement("div", "candidate-name", candidate.name);
    if (isActive) name.append(makeElement("span", "active-badge", "ACTIVE"));

    info.append(
      name,
      detail("History folder", candidate.historyFolder),
      detail("Prompt", candidate.promptFilePath || "Pasted text"),
      detail("Extension ID", candidate.extensionId)
    );

    const actions = makeElement("div", "candidate-actions");
    const edit = makeElement("button", "icon-button", "✎");
    edit.type = "button";
    edit.title = `Edit ${candidate.name}`;
    edit.setAttribute("aria-label", `Edit ${candidate.name}`);
    edit.disabled = selectingCandidate || Boolean(deletingCandidateId);
    edit.addEventListener("click", () => openEditCandidate(candidate));

    const remove = makeElement("button", "button danger", "Delete");
    remove.type = "button";
    remove.title = `Delete ${candidate.name}`;
    remove.setAttribute("aria-label", `Delete ${candidate.name}`);
    remove.disabled = selectingCandidate || Boolean(deletingCandidateId);
    remove.addEventListener("click", () => deleteCandidate(candidate));

    const activeLabel = makeElement("label", "active-choice");
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "active-candidate";
    radio.value = candidate.id;
    radio.checked = isActive;
    radio.disabled = selectingCandidate || Boolean(deletingCandidateId);
    radio.setAttribute("aria-label", `Set ${candidate.name} active`);
    radio.addEventListener("change", () => {
      if (radio.checked) setActiveCandidate(candidate);
    });
    activeLabel.append(radio, makeElement("span", "", "Active"));

    actions.append(edit, remove, activeLabel);
    row.append(info, actions);
    elements.candidateList.append(row);
  }
}

async function loadState() {
  const result = await api("/api/state");
  sessionToken = result.sessionToken;
  state = {
    schemaVersion: result.schemaVersion,
    activeCandidateId: result.activeCandidateId,
    candidates: result.candidates
  };
  render();
}

function openAddCandidate() {
  editingCandidateId = null;
  elements.form.reset();
  elements.dialogTitle.textContent = "Add candidate";
  elements.saveCandidate.textContent = "Save candidate";
  elements.extensionId.value = state.candidates[0]?.extensionId || "";
  elements.makeActive.checked = !state.activeCandidateId;
  elements.formError.textContent = "";
  setFolderResult("");
  elements.promptChoicePaste.checked = true;
  updatePromptMethod();
  elements.dialog.showModal();
  elements.name.focus();
}

async function openEditCandidate(candidate) {
  try {
    const prompt = candidate.promptFilePath
      ? ""
      : (await api(`/api/candidates/${encodeURIComponent(candidate.id)}/template`)).promptTemplateText;
    editingCandidateId = candidate.id;
    elements.form.reset();
    elements.name.value = candidate.name;
    elements.historyFolder.value = candidate.historyFolder || "";
    elements.promptFilePath.value = candidate.promptFilePath || "";
    elements.promptTemplate.value = prompt;
    elements.promptChoiceFile.checked = Boolean(candidate.promptFilePath);
    elements.promptChoicePaste.checked = !candidate.promptFilePath;
    updatePromptMethod();
    elements.extensionId.value = candidate.extensionId || "";
    elements.makeActive.checked = false;
    elements.dialogTitle.textContent = `Edit ${candidate.name}`;
    elements.saveCandidate.textContent = "Save changes";
    elements.formError.textContent = "";
    setFolderResult("");
    elements.dialog.showModal();
    elements.name.focus();
  } catch (error) {
    showNotice(`Could not open ${candidate.name}: ${error.message}`, "error");
  }
}

function closeCandidateDialog() {
  elements.dialog.close();
  editingCandidateId = null;
}

async function testHistoryFolder() {
  const historyFolder = elements.historyFolder.value.trim();
  if (!historyFolder) {
    setFolderResult("Enter a history-folder path first.", "error");
    return;
  }

  elements.testFolder.disabled = true;
  setFolderResult("Checking folder...");
  try {
    const result = await api("/api/folders/check", {
      method: "POST",
      body: { historyFolder }
    });
    setFolderResult(
      result.exists
        ? `Folder is accessible: ${result.historyFolder}`
        : `Folder can be created when saved: ${result.historyFolder}`,
      "good"
    );
  } catch (error) {
    setFolderResult(error.message, "error");
  } finally {
    elements.testFolder.disabled = false;
  }
}

async function browsePath(kind, input, button) {
  button.disabled = true;
  elements.formError.textContent = "";
  try {
    const result = await api("/api/browse", {
      method: "POST",
      body: { kind, currentPath: input.value.trim() }
    });
    if (result.path) {
      input.value = result.path;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  } catch (error) {
    elements.formError.textContent = `Could not browse: ${error.message}`;
  } finally {
    button.disabled = false;
  }
}

async function saveCandidate(event) {
  event.preventDefault();
  if (!elements.form.reportValidity()) return;

  const payload = {
    name: elements.name.value.trim(),
    historyFolder: elements.historyFolder.value.trim(),
    extensionId: elements.extensionId.value.trim().toLowerCase()
  };
  if (elements.promptChoiceFile.checked) {
    payload.promptFilePath = elements.promptFilePath.value.trim();
  } else {
    payload.promptTemplateText = elements.promptTemplate.value;
  }
  const path = editingCandidateId
    ? `/api/candidates/${encodeURIComponent(editingCandidateId)}`
    : "/api/candidates";
  const method = editingCandidateId ? "PUT" : "POST";
  const activateAfterSave = elements.makeActive.checked;

  elements.saveCandidate.disabled = true;
  elements.formError.textContent = "";
  try {
    const result = await api(path, { method, body: payload });
    state = result.state;
    let message = `${result.candidate.name} saved.`;
    let kind = "success";

    if (result.registration && !result.registration.ok) {
      message += ` Host registration needs attention: ${result.registration.error}`;
      kind = "warning";
    }

    if (activateAfterSave && state.activeCandidateId !== result.candidate.id) {
      try {
        const activeResult = await api("/api/active", {
          method: "POST",
          body: { candidateId: result.candidate.id }
        });
        state = activeResult.state;
        message += " This candidate is now active.";
      } catch (error) {
        message += ` Saved, but could not set active: ${error.message}`;
        kind = "warning";
      }
    }

    render();
    closeCandidateDialog();
    showNotice(message, kind);
    elements.registrationNote.textContent =
      "Run a capture from the extension to verify the Chrome connection.";
  } catch (error) {
    elements.formError.textContent = error.message;
  } finally {
    elements.saveCandidate.disabled = false;
  }
}

async function setActiveCandidate(candidate) {
  if (selectingCandidate || deletingCandidateId) return;
  selectingCandidate = true;
  render();
  try {
    const result = await api("/api/active", {
      method: "POST",
      body: { candidateId: candidate.id }
    });
    state = result.state;
    showNotice(`${candidate.name} is active. New captures use this candidate's history folder and prompt.`);
  } catch (error) {
    showNotice(error.message, "error");
  } finally {
    selectingCandidate = false;
    render();
  }
}

async function deleteCandidate(candidate) {
  if (selectingCandidate || deletingCandidateId) return;
  const wasActive = state.activeCandidateId === candidate.id;
  const activeMessage = wasActive ? " You will need to select another active candidate." : "";
  if (!window.confirm(
    `Delete ${candidate.name}'s profile and stored pasted prompt? Its saved application folders and any linked prompt file will stay on disk.${activeMessage}`
  )) return;

  deletingCandidateId = candidate.id;
  render();
  try {
    const result = await api(`/api/candidates/${encodeURIComponent(candidate.id)}`, {
      method: "DELETE",
      body: {}
    });
    state = result.state;
    let message = `${candidate.name} deleted.${wasActive ? " No candidate is active; select another to capture jobs." : ""}`;
    let kind = "success";
    if (result.registration && !result.registration.ok) {
      message += ` Host registration needs attention: ${result.registration.error}`;
      kind = "warning";
    }
    if (result.cleanupWarning) {
      message += ` ${result.cleanupWarning}`;
      kind = "warning";
    }
    showNotice(message, kind);
  } catch (error) {
    showNotice(`Could not delete ${candidate.name}: ${error.message}`, "error");
  } finally {
    deletingCandidateId = null;
    render();
  }
}

elements.addCandidate.addEventListener("click", openAddCandidate);
elements.emptyAdd.addEventListener("click", openAddCandidate);
elements.refresh.addEventListener("click", () => {
  loadState().then(
    () => showNotice("Candidate list refreshed."),
    error => showNotice(error.message, "error")
  );
});
elements.closeDialog.addEventListener("click", closeCandidateDialog);
elements.cancelDialog.addEventListener("click", closeCandidateDialog);
elements.dialog.addEventListener("close", () => { editingCandidateId = null; });
elements.testFolder.addEventListener("click", testHistoryFolder);
elements.historyFolder.addEventListener("input", () => setFolderResult(""));
elements.browseFolder.addEventListener("click", () => browsePath("folder", elements.historyFolder, elements.browseFolder));
elements.browsePrompt.addEventListener("click", () => browsePath("prompt", elements.promptFilePath, elements.browsePrompt));
elements.promptChoicePaste.addEventListener("change", updatePromptMethod);
elements.promptChoiceFile.addEventListener("change", updatePromptMethod);
elements.form.addEventListener("submit", saveCandidate);

loadState().catch(error => showNotice(`Could not load candidates: ${error.message}`, "error"));
