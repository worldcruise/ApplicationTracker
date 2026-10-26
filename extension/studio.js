import { HandleStore } from "./studio/handles.mjs";
import { StudioAccess } from "./studio/access.mjs";
import { promptMappingKey, referenceFilename } from "./studio/contracts.mjs";

const byId = id => document.getElementById(id);
const access = new StudioAccess(new HandleStore());
const select = byId("select-folder"), reconnect = byId("reconnect-folder"), refresh = byId("refresh");
const folderStatus = byId("folder-status"), registryStatus = byId("registry-status");
const candidates = byId("candidates"), optionalStatus = byId("optional-status");
let busy = false;

function notice(message = "", error = false) {
  const element = byId("notice");
  element.hidden = !message; element.textContent = message;
  element.dataset.kind = error ? "error" : "info";
  element.setAttribute("role", error ? "alert" : "status");
}
function element(tag, content, className = "") {
  const result = document.createElement(tag); result.textContent = content; result.className = className; return result;
}
function setBusy(value) {
  busy = value; document.querySelectorAll("button").forEach(button => { button.disabled = value; });
  if (!value) {
    select.disabled = typeof window.showDirectoryPicker !== "function";
    refresh.disabled = !access.directory; reconnect.disabled = !access.directory;
  }
  document.querySelector("main").setAttribute("aria-busy", String(value));
}
function renderConfiguration(error = null) {
  reconnect.hidden = !access.directory;
  refresh.disabled = !access.directory || busy;
  select.textContent = access.directory ? "Reselect Configuration Folder" : "Select Configuration Folder";
  optionalStatus.textContent = "";
  const snapshot = access.snapshot;
  if (snapshot) {
    folderStatus.textContent = `Folder access granted: ${access.directory.handle.name}`;
    folderStatus.dataset.state = "ready";
    registryStatus.textContent = `Registry validated. ${snapshot.registry.candidates.length} candidate(s) loaded. Last read: ${new Date(snapshot.loadedAt).toLocaleString()}.`;
    const profiles = [...snapshot.profiles.values()].filter(Boolean).length;
    optionalStatus.textContent = `${profiles} structured profile(s), ${snapshot.prompts.templates.length} managed prompt(s), ${snapshot.documents.templates.length} document template(s). Missing optional records remain unconfigured.`;
  } else {
    folderStatus.textContent = error ? `${error.message} [${error.code || "access-unavailable"}]` : "No configuration folder selected.";
    folderStatus.dataset.state = error ? "error" : "none";
    registryStatus.textContent = "Registry has not been validated. No cached candidate data is being used.";
  }
}

async function promptStatus(candidate, status, actions) {
  actions.replaceChildren();
  let failure = null;
  try {
    const result = await access.readPrompt(candidate.id);
    status.textContent = candidate.promptFilePath ? `Connected: ${result.filename}. File contents validated on this read.` : "Saved pasted prompt is configured and readable.";
    status.dataset.state = "ready";
  } catch (error) {
    failure = error;
    status.textContent = `${error.message} [${error.code || "prompt-unavailable"}]`;
    status.dataset.state = "error";
  }
  if (!access.snapshot) return failure;
  const button = (label, operation) => {
    const control = element("button", label, "secondary"); control.type = "button";
    control.addEventListener("click", () => run(operation)); actions.append(control);
  };
  if (candidate.promptFilePath) {
    const linked = access.promptHandles.has(promptMappingKey(access.directory.scope, candidate.promptFilePath));
    button(linked ? "Relink Prompt File" : "Link Prompt File", async () => {
      const result = await access.linkPrompt(candidate.id);
      notice(result.cancelled ? "File selection canceled. The previous link is unchanged." : `Linked ${result.filename} to this candidate's configured reference. Its absolute path has not been independently verified.`);
    });
    if (linked) {
      button("Reconnect Prompt Access", async () => { await access.reconnectPrompt(candidate.id); notice("Prompt access restored and current file contents validated."); });
      button("Forget Prompt Link", async () => { await access.forgetPrompt(candidate.id); notice("Prompt handle mapping removed. The file itself was not changed."); });
    }
  }
  button("Check Prompt File", async () => { await access.readPrompt(candidate.id); notice("Current prompt file contents validated."); });
}
async function renderCandidates() {
  candidates.replaceChildren();
  const snapshot = access.snapshot;
  byId("candidate-empty").hidden = Boolean(snapshot?.registry.candidates.length);
  byId("candidate-empty").textContent = snapshot ? "No candidates are configured in this registry." : "Select or reconnect a configuration folder to load candidates.";
  if (!snapshot) return;
  for (const candidate of snapshot.registry.candidates) {
    const card = element("article", "", "candidate"), heading = element("h3", candidate.name);
    if (candidate.id === snapshot.registry.activeCandidateId) heading.append(element("span", "ACTIVE", "badge"));
    card.append(heading, element("p", candidate.promptFilePath ? "Storage mode: external linked prompt" : "Storage mode: saved pasted prompt (configuration-relative file)", "muted"));
    if (snapshot.referenceWarnings?.has(candidate.id)) card.append(element("p", `${snapshot.referenceWarnings.get(candidate.id)} Review the assignment in the manager. Legacy prompt-file access remains separate.`, "status error"));
    card.append(element("p", candidate.promptFilePath ? `Configured reference: ${candidate.promptFilePath}` : `Configuration file: ${candidate.promptTemplate}`, "muted"));
    if (candidate.promptFilePath) card.append(element("p", `Configured filename: ${referenceFilename(candidate.promptFilePath)}`, "muted"));
    const status = element("p", "Checking current prompt access…", "status"), actions = element("div", "", "actions");
    status.setAttribute("role", "status"); card.append(status, actions); candidates.append(card);
    const failure = await promptStatus(candidate, status, actions);
    if (access.snapshot !== snapshot) {
      candidates.replaceChildren();
      byId("candidate-empty").hidden = false;
      byId("candidate-empty").textContent = "Reconnect or refresh configuration before loading candidates again.";
      renderConfiguration(failure || { message: "Configuration changed. Refresh it again.", code: "configuration-changed" }); break;
    }
  }
}
async function run(operation) {
  if (busy) return;
  setBusy(true); notice();
  let failure = null;
  try { await operation(); }
  catch (error) { failure = error; notice(error.message || "Filesystem access failed. Select the resource again.", true); }
  try { renderConfiguration(failure); await renderCandidates(); }
  catch { notice("Access status could not be loaded. Reselect the configuration folder and retry.", true); }
  finally { setBusy(false); }
}

select.addEventListener("click", () => run(async () => {
  const result = await access.selectConfiguration();
  notice(result.cancelled ? "Folder selection canceled. The previous selection is unchanged." : "Configuration folder validated and its access handle remembered.");
}));
reconnect.addEventListener("click", () => run(async () => { await access.reconnectConfiguration(); notice("Folder access restored and configuration reread successfully."); }));
refresh.addEventListener("click", () => run(async () => { await access.refresh(); notice("Configuration refreshed from disk."); }));

if (typeof window.showDirectoryPicker !== "function") {
  select.disabled = true; folderStatus.textContent = "Directory access is unsupported in this browser context. Use a supported desktop Chrome extension page.";
} else {
  await run(() => access.restore()); // Only query existing permission; never request it on load.
}
