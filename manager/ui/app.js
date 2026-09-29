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
  extensionId: document.getElementById("extension-id"),
  historyFolder: document.getElementById("history-folder"),
  promptTemplate: document.getElementById("prompt-template"),
  testFolder: document.getElementById("test-folder"),
  folderResult: document.getElementById("folder-result"),
  saveCandidate: document.getElementById("save-candidate"),
  registrationNote: document.getElementById("registration-note"),
  templateFile: document.getElementById("template-file"),
  templateFilePanel: document.getElementById("template-file-panel"),
  templatePastePanel: document.getElementById("template-paste-panel"),
  templateResult: document.getElementById("template-result"),
  templateChoiceFile: document.getElementById("template-choice-file"),
  formError: document.getElementById("form-error")
};

let state = {
  schemaVersion: 1,
  activeCandidateId: null,
  candidates: []
};

let sessionToken = "";
let editingCandidateId = null;

let savedTemplateText = "";

function templateMethod() {
  return document.querySelector(
    'input[name="template-method"]:checked'
  ).value;
}

function setTemplateResult(message, kind = "") {
  elements.templateResult.textContent = message;
  elements.templateResult.className = `field-result ${kind}`;
}

function updateSelectedFile() {
  const file = elements.templateFile.files[0];

  if (file) {
    setTemplateResult(
      `${file.name} (${Math.ceil(file.size / 1024)} KB) selected`,
      "good"
    );
  } else if (editingCandidateId) {
    setTemplateResult(
      "No replacement selected. The saved template will be kept.",
      "good"
    );
  } else {
    setTemplateResult("Choose a .txt or .md file.");
  }
}

function updateTemplateMethod() {
  const useFile = templateMethod() === "file";

  elements.templateFilePanel.hidden = !useFile;
  elements.templatePastePanel.hidden = useFile;
  elements.templateFile.disabled = !useFile;
  elements.promptTemplate.disabled = useFile;

  if (useFile) {
    updateSelectedFile();
  } else {
    setTemplateResult("");
  }
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


function makeElement(tag, className, text) {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
}


function render() {
  const candidates = state.candidates || [];
  const active = candidates.find(
    candidate => candidate.id === state.activeCandidateId
  );

  elements.candidateCount.textContent = String(candidates.length);
  elements.activeSummary.textContent = active
    ? `Active: ${active.name}`
    : "No active candidate";
  elements.activeSummary.classList.toggle("has-active", Boolean(active));

  elements.candidateList.replaceChildren();
  elements.emptyState.hidden = candidates.length > 0;

  for (const candidate of candidates) {
    const isActive = candidate.id === state.activeCandidateId;

    const row = makeElement(
      "article",
      `candidate-row${isActive ? " is-active" : ""}`,
      ""
    );

    const info = makeElement("div", "candidate-info", "");
    const nameLine = makeElement("div", "candidate-name", candidate.name);

    if (isActive) {
      nameLine.append(
        makeElement("span", "active-badge", "ACTIVE")
      );
    }

    info.append(
      nameLine,
      makeElement(
        "div",
        "candidate-detail",
        `History: ${candidate.historyFolder}`
      ),
      makeElement(
        "div",
        "candidate-detail",
        `Extension ID: ${candidate.extensionId}`
      )
    );

    const actions = makeElement("div", "candidate-actions", "");

    const editButton = makeElement("button", "icon-button", "✎");
    editButton.type = "button";
    editButton.title = `Edit ${candidate.name}`;
    editButton.setAttribute(
      "aria-label",
      `Edit ${candidate.name}`
    );
    editButton.addEventListener(
      "click",
      () => openEditCandidate(candidate)
    );

    const activeButton = makeElement(
      "button",
      isActive ? "button secondary" : "button primary",
      isActive ? "Active" : "Set active"
    );
    activeButton.type = "button";
    activeButton.disabled = isActive;
    activeButton.addEventListener(
      "click",
      () => setActiveCandidate(candidate)
    );

    actions.append(editButton, activeButton);
    row.append(info, actions);
    elements.candidateList.append(row);
  }
}


async function loadState() {
  const response = await api("/api/state");

  sessionToken = response.sessionToken;
  state = {
    schemaVersion: response.schemaVersion,
    activeCandidateId: response.activeCandidateId,
    candidates: response.candidates
  };

  render();
}


function openAddCandidate() {
  editingCandidateId = null;
  elements.form.reset();
  elements.dialogTitle.textContent = "Add candidate";
  elements.saveCandidate.textContent = "Save candidate";
  setFolderResult("");
  savedTemplateText = "";
  elements.formError.textContent = "";
  elements.templateChoiceFile.checked = true;
  updateTemplateMethod();
  elements.dialog.showModal();
  elements.name.focus();
}


async function openEditCandidate(candidate) {
  try {
    const response = await api(
      `/api/candidates/${encodeURIComponent(candidate.id)}/template`
    );

    editingCandidateId = candidate.id;
    elements.name.value = candidate.name;
    elements.extensionId.value = candidate.extensionId;
    elements.historyFolder.value = candidate.historyFolder;
    elements.promptTemplate.value = response.promptTemplateText;
    elements.dialogTitle.textContent = `Edit ${candidate.name}`;
    elements.saveCandidate.textContent = "Save changes";
    setFolderResult("");
    elements.dialog.showModal();
    elements.name.focus();
  } catch (error) {
    showNotice(error.message, "error");
  }
}


function closeCandidateDialog() {
  elements.dialog.close();
  editingCandidateId = null;
  setFolderResult("");
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


async function saveCandidate(event) {
  event.preventDefault();

  if (!elements.form.reportValidity()) {
    return;
  }

  const payload = {
    name: elements.name.value.trim(),
    extensionId: elements.extensionId.value.trim().toLowerCase(),
    historyFolder: elements.historyFolder.value.trim(),
    promptTemplateText: elements.promptTemplate.value
  };

  const isEditing = Boolean(editingCandidateId);
  const path = isEditing
    ? `/api/candidates/${encodeURIComponent(editingCandidateId)}`
    : "/api/candidates";

  elements.saveCandidate.disabled = true;

  try {
    const result = await api(path, {
      method: isEditing ? "PUT" : "POST",
      body: payload
    });

    state = result.state;
    render();
    closeCandidateDialog();

    if (result.registration.ok) {
      showNotice(
        `${result.candidate.name} saved. Its extension ID is registered.`
      );
      elements.registrationNote.textContent =
        "The native host registration was updated. Run a capture " +
        "from the extension to verify the connection.";
    } else {
      showNotice(
        `${result.candidate.name} was saved, but host registration ` +
          `needs attention: ${result.registration.error}`,
        "warning"
      );
      elements.registrationNote.textContent =
        "Candidate settings are saved. Repair native-host registration " +
        "before using the extension.";
    }
  } catch (error) {
    showNotice(error.message, "error");
  } finally {
    elements.saveCandidate.disabled = false;
  }
}


async function setActiveCandidate(candidate) {
  try {
    const result = await api("/api/active", {
      method: "POST",
      body: { candidateId: candidate.id }
    });

    state = result.state;
    render();
    showNotice(
      `${candidate.name} is active. New captures use this candidate’s ` +
        "history folder and prompt template."
    );
  } catch (error) {
    showNotice(error.message, "error");
  }
}


elements.addCandidate.addEventListener("click", openAddCandidate);
elements.emptyAdd.addEventListener("click", openAddCandidate);
elements.refresh.addEventListener("click", async () => {
  try {
    await loadState();
    showNotice("Candidate list refreshed.");
  } catch (error) {
    showNotice(error.message, "error");
  }
});

elements.closeDialog.addEventListener("click", closeCandidateDialog);
elements.cancelDialog.addEventListener("click", closeCandidateDialog);
elements.testFolder.addEventListener("click", testHistoryFolder);
elements.form.addEventListener("submit", saveCandidate);

loadState().catch(error => {
  showNotice(`Could not load candidates: ${error.message}`, "error");
});