import { contracts, composePrompt, promptStatus, profileCompleteness, setProfileField, formatAddress, safePdfFilename, resumeInput, PdfPreview, preserveTextEdits, replaceTextRange, normalizedText, birthdateToDisplay, birthdateFromDisplay } from "./studio-core.mjs";
import { validateProfile } from "../../extension/studio/contracts.mjs";
import { renderResumePdfBlob } from "../../extension/shared/resume-renderer.mjs";
import { getBuiltInDocumentTemplates, validateDocumentSettings } from "../../extension/shared/document-settings.mjs";
import { initializeExtensionStudio } from "./extension-studio.mjs";
import { captureFields, restoreFields, mergeDraft } from "./auth.mjs";

export function initializeStudio({ api, editCandidate, renderPdf = renderResumePdfBlob, authorize = action => action() }) {
  const $ = id => document.getElementById(id);
  const node = (tag, text = "", cls = "") => { const element = document.createElement(tag); element.textContent = text; element.className = cls; return element; };
  const button = (label, action, cls = "button secondary") => { const element = node("button", label, cls); element.type = "button"; element.addEventListener("click", () => run(action)); return element; };
  let page = "home", state, knownCandidates = "", profile, profileBaseline, profileDirty = false, promptDirty = false, documentDirty = false;
  let selectedCandidate = null, editingPrompt = null, editingDocument = null, documentDefaults = {}, profileEpoch = 0, refreshEpoch = 0, renderTimer, copyEpoch = 0, promptEpoch = 0;
  let bindings = { experience: [], education: [] }, overrides = {}, parsedText = null, lastResume = null;
  let saving = false, promptBodyDraft = "", homeEpoch = 0;
  let profileFormBaseline = null, promptFormBaseline = null, documentFormBaseline = null, promptDraft = false, documentDraft = false;
  const registrySignature = registry => JSON.stringify({ schemaVersion: registry.schemaVersion, activeCandidateId: registry.activeCandidateId, candidates: registry.candidates });
  const status = (message, error = false) => { $("studio-status").hidden = !message; $("studio-status").textContent = message; $("studio-status").className = `notice ${error ? "error" : "success"}`; };
  let suspended = false, restoringDraft = false;
  const run = async action => { if (suspended) return; try { await action(); } catch (error) { if (!error.authHandled && !suspended) status(error.message, true); } };
  const current = () => state?.registry.data.candidates.find(item => item.id === selectedCandidate);
  const supportedDocument = item => ["classic", "modern"].includes(item.layoutId) && (getBuiltInDocumentTemplates().some(builtin => builtin.id === item.id) ? item.version === 1 : item.rendererVersion === 1);
  const documents = () => (state?.documents.templates || []).filter(item => supportedDocument(item) && !item.archived);
  const preview = new PdfPreview({ render: renderPdf, onChange({ url, message }) {
    // Avoid navigating to a PDF when browser policy would download it externally.
    const inline = navigator.pdfViewerEnabled !== false;
    const frame = $("pdf-preview"); frame.hidden = !url || !inline;
    $("preview-empty").hidden = Boolean(url && inline);
    if (url && inline) frame.src = `${url}#navpanes=0&view=Fit`; else frame.removeAttribute("src");
    $("resume-download").disabled = !url; $("preview-status").textContent = url && !inline ? "Inline PDF viewing is disabled in this browser. Enable it or explicitly click Download PDF." : message;
  }});
  const extensionWorkspace = initializeExtensionStudio({ api, authorize });
  const dirty = () => profileDirty || promptDirty || documentDirty || extensionWorkspace.dirty;
  function allowContextChange() {
    if (restoringDraft) return true;
    if (saving || extensionWorkspace.saving) { status("Wait for the current save to finish.", true); return false; }
    if (dirty() && !window.confirm("Discard unsaved profile, library or extension settings changes?")) return false;
    if (extensionWorkspace.dirty) extensionWorkspace.discard();
    if (profileDirty && profileBaseline) { profile.data = structuredClone(profileBaseline); renderProfile(); $("profile-dirty").textContent = "Unsaved edits discarded"; }
    if (promptDirty) $("prompt-editor").hidden = true;
    if (documentDirty) $("document-editor").hidden = true;
    profileDirty = promptDirty = documentDirty = false; saveButtons(); return true;
  }
  function saveButtons() {
    $("profile-save").disabled = saving || !profile || !profileDirty;
    $("prompt-save").disabled = saving || !promptDirty;
    $("document-save").disabled = saving || !documentDirty;
  }
  function profileFormSignature() {
    return JSON.stringify([...$("profile-editor").querySelectorAll("input, textarea")].map(input =>
      [input.id, input.type === "checkbox" ? input.checked : input.value]));
  }
  function markProfile() {
    profileDirty = profileFormBaseline !== null && profileFormSignature() !== profileFormBaseline;
    $("profile-dirty").textContent = profileDirty ? "Unsaved changes" : profile?.exists ? "Saved profile" : "Not created — edit the profile to save";
    saveButtons();
  }
  function promptFields() {
    const data = {}; for (const key of ["name", "description", "body", "category"]) data[key] = $("prompt-" + key).value;
    data.body = preserveTextEdits(promptBodyDraft, data.body);
    data.isDefault = $("prompt-default").checked; data.archived = $("prompt-archived").checked;
    return data;
  }
  function promptFormSignature() {
    const data = promptFields(); data.body = normalizedText(data.body); return JSON.stringify(data);
  }
  function markPrompt() {
    promptDirty = promptDraft || promptFormSignature() !== promptFormBaseline;
    $("prompt-dirty").textContent = promptDirty ? "Unsaved changes" : ""; saveButtons();
  }
  function documentFields() {
    return { name: $("document-name").value, description: $("document-description").value, layoutId: $("document-layout").value,
      defaultSettings: documentDefaults, archived: $("document-archived").checked };
  }
  function markDocument() {
    documentDirty = documentDraft || JSON.stringify(documentFields()) !== documentFormBaseline;
    $("document-dirty").textContent = documentDirty ? "Unsaved changes" : ""; saveButtons();
  }
  function clearResume() {
    clearTimeout(renderTimer); copyEpoch++; promptEpoch++; preview.clear(); parsedText = null; lastResume = null; bindings = { experience: [], education: [] }; overrides = {};
    $("resume-json").value = ""; $("resume-jd").value = ""; $("resume-bindings").replaceChildren(); $("resume-errors").textContent = "";
    $("assistant-prompt").value = ""; $("resume-prompt-source").textContent = "No prompt loaded"; $("resume-copy-prompt").disabled = true;
    $("json-status").textContent = "Awaiting JSON"; $("json-status").dataset.state = "empty";
  }
  function confirmResumeDiscard() {
    return !($("resume-json").value || $("resume-jd").value) || window.confirm("Discard the current unsaved job description and resume input?");
  }
  function fillSelect(select, items, selected, placeholder = "Select candidate") {
    select.replaceChildren(); const empty = node("option", placeholder); empty.value = ""; select.append(empty);
    for (const item of items) { const option = node("option", item.name); option.value = item.id; select.append(option); }
    select.value = selected || "";
  }
  async function navigate(next) {
    if (next === page) return;
    if (!allowContextChange() || (page === "resume" && !confirmResumeDiscard())) return;
    if (page === "resume") clearResume();
    if (page === "extensions") extensionWorkspace.leave();
    page = next; document.body.dataset.page = next; status("");
    const route = next === "extensions" ? "/extension-studio" : "/";
    if (window.history?.replaceState && window.location.pathname !== route) window.history.replaceState(null, "", route + (window.location.search || "") + (window.location.hash || ""));
    for (const element of document.querySelectorAll(".studio-page")) element.hidden = element.id !== `page-${next}`;
    for (const element of document.querySelectorAll("[data-page]")) {
      if (element.dataset.page === next) element.setAttribute("aria-current", "page"); else element.removeAttribute("aria-current");
    }
    if (next === "extensions") { await extensionWorkspace.load(); window.scrollTo?.({ top: 0, behavior: "instant" }); return; }
    if (!state) { await refresh(); return; }
    if (next === "candidates") await loadProfile();
    if (next === "prompts") { $("prompt-editor").hidden = true; renderPrompts(); }
    if (next === "home") await renderHome();
    if (next === "documents") renderDocuments();
    if (next === "resume") { await loadProfile(); await prepareResume(); }
    window.scrollTo?.({ top: 0, behavior: "instant" });
  }
  async function refresh() {
    if (page === "extensions") { await extensionWorkspace.load(); return; }
    const epoch = ++refreshEpoch;
    status("Loading Studio configuration…");
    const next = await api("/api/studio/state"); if (epoch !== refreshEpoch) return;
    state = next;
    selectedCandidate = state.registry.data.activeCandidateId;
    syncCandidateSelects(); renderPrompts(); renderDocuments();
    if (page === "home") await renderHome();
    if (page === "candidates" || page === "resume") await loadProfile();
    if (page === "resume") await prepareResume();
    status("");
  }
  async function renderHome() {
    const epoch = ++homeEpoch;
    const target = $("home-content"); target.replaceChildren();
    const tools = $("home-tools"); tools.replaceChildren();
    // Add future tools here once they have a working destination. All launch
    // points use the same navigation and unsaved-change protections.
    for (const [route, symbol, title, description, action] of [
      ["candidates", "01", "Candidates & profiles", "Keep experience, contact details and candidate defaults together.", "Manage candidates"],
      ["prompts", "02", "Prompt library", "Maintain reusable instructions for your own AI workflow.", "Explore prompts"],
      ["documents", "03", "Document designs", "Build reusable configurations with supported layout settings.", "Browse designs"],
      ["resume", "04", "Resume Studio", "Turn validated JSON into a tailored, downloadable PDF.", "Open Studio"],
      ["extensions", "05", "Extension Studio", "Manage browser setup, local settings and integration diagnostics.", "Manage integration"],
    ]) {
      const card = node("article", "", "landing-tool");
      card.append(node("span", symbol, "tool-number"), node("h3", title), node("p", description), button(action + " ↗", () => navigate(route), "button subtle")); tools.append(card);
    }
    const candidate = state.registry.data.candidates.find(item => item.id === state.registry.data.activeCandidateId);
    $("home-start").textContent = candidate ? "Open Resume Studio ↗" : "Set up your first workspace ↗";
    target.append(node("p", "YOUR ACTIVE WORKSPACE", "eyebrow"));
    if (!candidate) { target.append(node("h2", "Make room for your next opportunity."), node("p", "Add a candidate or activate an existing one. Their profile and preferences will be ready across your workspace."), button("Open Candidates", () => navigate("candidates"), "button primary")); return; }
    target.append(node("h2", candidate.name), node("p", "Ready to continue. Your candidate context follows you across Studio.", "field-help"));
    const facts = node("dl", "", "home-facts");
    const fact = (label, value) => { const group = node("div"); group.append(node("dt", label), node("dd", value)); facts.append(group); };
    fact("Assigned prompt", promptStatus(candidate, state.prompts.data).label);
    const preferred = documents().find(item => item.id === candidate.preferredDocumentTemplateId);
    fact("Document template", preferred?.name || (candidate.preferredDocumentTemplateId ? "Unavailable preference — select a supported template" : "Classic (default)"));
    target.append(facts);
    try {
      const response = await api(`/api/studio/candidates/${candidate.id}/profile`);
      if (epoch !== homeEpoch || page !== "home" || candidate.id !== state.registry.data.activeCandidateId) return;
      const completeness = profileCompleteness(response.exists ? response.data : null);
      fact("Profile readiness", response.exists ? `${completeness.completed}/${completeness.total} groups present` : "Not created");
      if (completeness.missing.length) target.append(node("p", `To review: ${completeness.missing.join(", ")}. Presence does not verify accuracy.`, "field-help"));
    } catch (error) { if (epoch !== homeEpoch || page !== "home") return; fact("Profile", error.message); }
    target.append(button("Open candidate & profile ↗", () => navigate("candidates"), "button secondary"));
  }
  function syncCandidateSelects() {
    const candidate = current();
    for (const id of ["profile-candidate", "resume-candidate"]) $(id).value = candidate?.name || "No active candidate";
    $("edit-active-candidate").disabled = !candidate;
    const defaults = $("candidate-defaults"); defaults.replaceChildren();
    if (!candidate) return;
    const preferred = documents().find(item => item.id === candidate.preferredDocumentTemplateId);
    for (const [label, value] of [["AI prompt", promptStatus(candidate, state.prompts.data).label], ["Document design", preferred?.name || (candidate.preferredDocumentTemplateId ? "Unavailable — edit configuration" : "Classic (default)")]]) {
      const group = node("div"); group.append(node("dt", label), node("dd", value)); defaults.append(group);
    }
  }
  async function loadProfile() {
    const epoch = ++profileEpoch; profile = null; profileFormBaseline = null; profileDirty = false; saveButtons();
    $("profile-dirty").textContent = "";
    $("profile-reload").disabled = !selectedCandidate;
    $("profile-editor").replaceChildren(node("p", selectedCandidate ? "Loading profile…" : "Activate a candidate from the directory to edit their profile. New profiles are created only when you click Save profile.", "profile-empty"));
    if (!selectedCandidate) return;
    const response = await api(`/api/studio/candidates/${selectedCandidate}/profile`);
    if (epoch !== profileEpoch) return;
    profile = response; profileBaseline = structuredClone(response.data); renderProfile();
    profileFormBaseline = profileFormSignature(); markProfile();
  }
  function renderProfile() {
    const form = $("profile-editor"); form.replaceChildren(); if (!profile) return;
    function section(title, description, id, add) {
      const block = node("section", "", "profile-section"); block.setAttribute("aria-labelledby", `profile-section-${id}`);
      const header = node("div", "", "profile-section-heading"), text = node("div"), heading = node("h3", title); heading.id = `profile-section-${id}`;
      text.append(heading, node("p", description)); header.append(text);
      if (add) { const action = button(`+ ${add.label}`, add.action, "button secondary profile-add"); action.id = `profile-add-${id}`; header.append(action); }
      block.append(header); form.append(block); return block;
    }
    function entryCard(parent, title, id, remove) {
      const card = node("div", "", "profile-entry"); card.id = `profile-entry-${id}`;
      const header = node("div", "", "profile-entry-heading"), cross = button("×", remove, "profile-remove"); cross.id = `profile-remove-${id}`; cross.title = `Remove ${title.toLowerCase()}`; cross.setAttribute("aria-label", cross.title);
      header.append(node("h4", title), cross); card.append(header); parent.append(card); return card;
    }
    function field(parent, label, path, type = "text", placeholder = "") {
      const wrapper = node("div", "", `profile-field${type === "checkbox" ? " profile-check" : ""}`); const id = `profile-${path.join("-")}`; const caption = node("label", label); caption.htmlFor = id;
      const input = node(type === "textarea" ? "textarea" : "input"); input.id = id;
      if (type !== "textarea") input.type = type === "birthdate" ? "text" : type; else input.rows = 3;
      input.placeholder = placeholder;
      const value = path.reduce((item, key) => item?.[key], profile.data);
      if (type === "checkbox") input.checked = Boolean(value); else input.value = value ?? "";
      let calendar;
      if (type === "birthdate") {
        input.value = birthdateToDisplay(value || ""); input.inputMode = "numeric"; input.maxLength = 10; input.autocomplete = "bday";
        input.pattern = "[0-9]{2}/[0-9]{2}/[0-9]{4}"; input.setAttribute("aria-describedby", `${id}-hint`);
        calendar = node("input", "", "profile-calendar"); calendar.id = `${id}-calendar`; calendar.type = "date"; calendar.lang = "en-US";
        calendar.setAttribute("aria-label", "Choose birthdate from calendar"); calendar.title = "Choose birthdate from calendar";
        calendar.addEventListener("click", () => {
          // The compact control's whole area opens the native calendar, not just
          // the browser-specific indicator hit target. Keep the user gesture.
          try { calendar.showPicker?.(); }
          catch { status("The calendar could not open. Enter the birthdate as MM/DD/YYYY.", true); }
        });
        try { calendar.value = input.value ? birthdateFromDisplay(input.value) : ""; }
        catch (error) { calendar.value = ""; input.setCustomValidity(error.message); }
        calendar.addEventListener("change", () => { input.value = birthdateToDisplay(calendar.value); input.setCustomValidity(""); profile.data = setProfileField(profile.data, path, calendar.value); markProfile(); });
      }
      input.addEventListener("input", () => {
        const previous = path.reduce((item, key) => item?.[key], profile.data) ?? "";
        let edited = type === "checkbox" ? input.checked : type === "textarea" ? preserveTextEdits(previous, input.value) : input.value;
        if (type === "birthdate") {
          try { edited = birthdateFromDisplay(input.value); input.setCustomValidity(""); calendar.value = edited; }
          catch (error) { input.setCustomValidity(error.message); calendar.value = ""; }
        }
        profile.data = setProfileField(profile.data, path, edited); markProfile();
      });
      if (type === "textarea") input.addEventListener("paste", event => {
        if (!event.clipboardData) return;
        event.preventDefault(); const previous = path.reduce((item, key) => item?.[key], profile.data) ?? "";
        const text = event.clipboardData.getData("text/plain"), position = input.selectionStart + normalizedText(text).length;
        const edited = replaceTextRange(previous, input.selectionStart, input.selectionEnd, text);
        profile.data = setProfileField(profile.data, path, edited); input.value = edited; input.setSelectionRange(position, position); markProfile();
      });
      if (calendar) {
        const control = node("div", "", "profile-date-control"), hint = node("p", "MM/DD/YYYY", "field-help"); hint.id = `${id}-hint`;
        control.append(input, calendar); wrapper.append(caption, control, hint);
      } else if (type === "checkbox") wrapper.append(input, caption);
      else wrapper.append(caption, input);
      parent.append(wrapper); return input;
    }
    function grid(parent) { const result = node("div", "", "field-grid"); parent.append(result); return result; }
    function addressFields(parent, prefix) {
      const fields = grid(parent); fields.className += " profile-address-grid";
      for (const [key, label, placeholder] of [["line1", "Address line 1", "Street address"], ["line2", "Address line 2", "Apartment, suite, etc. (optional)"], ["city", "City", "City"], ["state", "State / region", "State or province"], ["postalCode", "ZIP / postal code", "ZIP or postal code"], ["country", "Country", "Country"]]) field(fields, label, [...prefix, key], "text", placeholder);
    }
    const personal = section("Personal information", "Personal details and availability.", "personal"), personalGrid = grid(personal);
    field(personalGrid, "Birthdate", ["personal", "birthday"], "birthdate", "MM/DD/YYYY");
    field(personalGrid, "Preferred start date", ["preferences", "startDate"], "text", "e.g. Immediately or 2 weeks after offer");
    const contact = section("Contact & address", "How employers can reach you.", "contact"), contactGrid = grid(contact);
    field(contactGrid, "Email", ["contact", "email"], "email", "name@example.com"); field(contactGrid, "Phone", ["contact", "phone"], "tel", "e.g. (555) 123-4567"); addressFields(contact, ["address"]);
    const links = section("Online links", "Professional sites and portfolios.", "links", { label: "Add link", action: () => { (profile.data.contact.links ??= []).push({ label: "", url: "" }); markProfile(); renderProfile(); } });
    if (!profile.data.contact.links?.length) links.append(node("p", "No links yet. Add a professional profile or portfolio.", "profile-empty-note"));
    (profile.data.contact.links || []).forEach((link, index) => {
      const row = entryCard(links, `Link ${index + 1}`, `links-${index}`, () => { profile.data.contact.links.splice(index, 1); markProfile(); renderProfile(); }), fields = grid(row);
      field(fields, "Label", ["contact", "links", index, "label"], "text", "e.g. LinkedIn or Portfolio"); field(fields, "URL", ["contact", "links", index, "url"], "text", "https://example.com/your-profile");
    });
    for (const [key, title] of [["workExperience", "Career"], ["education", "Education"]]) {
      const work = key === "workExperience";
      const parent = section(title, work ? "Employment history used for explicit resume associations." : "Academic background and qualifications.", key, { label: `Add ${work ? "employment" : "education"}`, action: () => { profile.data[key].push(work ? { id: crypto.randomUUID(), company: "", title: "", period: {}, address: {}, highlights: [] } : { id: crypto.randomUUID(), university: "", degree: "", major: "", period: {}, address: {} }); markProfile(); renderProfile(); } });
      if (!profile.data[key].length) parent.append(node("p", `No ${work ? "employment" : "education"} entries yet. Add one when ready.`, "profile-empty-note"));
      profile.data[key].forEach((entry, index) => {
        const row = entryCard(parent, `${work ? "Employment" : "Education"} ${index + 1}`, `${key}-${index}`, () => { if (!window.confirm("Remove this profile entry? Existing resume bindings will need review.")) return; profile.data[key].splice(index, 1); markProfile(); renderProfile(); });
        const fields = grid(row);
        for (const [name, label, placeholder] of (work ? [["company", "Employer", "Company name"], ["title", "Job title", "e.g. Systems Engineer"]] : [["university", "University", "University or institution"], ["degree", "Degree", "e.g. Bachelor of Science"], ["major", "Major", "e.g. Computer Science"]])) {
          const input = field(fields, label, [key, index, name], "text", placeholder);
          if (name === "university") input.parentElement?.classList.add("profile-field-wide");
        }
        const dates = grid(row); dates.className += " profile-period";
        field(dates, "Start date", [key, index, "period", "start"], "text", "e.g. Jan 2020 or 2020");
        const end = field(dates, "End date", [key, index, "period", "end"], "text", "e.g. Dec 2023 or 2023"); end.disabled = Boolean(entry.period.current);
        const current = field(dates, work ? "I currently work here" : "I currently study here", [key, index, "period", "current"], "checkbox");
        current.addEventListener("input", () => { end.disabled = current.checked; });
        const addressHeading = node("div", "", "profile-address-heading"); addressHeading.append(node("h5", work ? "Company address" : "University address"), button("Copy address", async () => { const text = formatAddress(profile.data[key][index].address); if (!text) throw new Error("No address is configured for this entry."); await copy(text); status("Address copied."); }, "button subtle")); row.append(addressHeading); addressFields(row, [key, index, "address"]);
      });
    }
    const answers = section("Custom answers", "Reusable application answers, kept exactly as entered.", "answers", { label: "Add answer", action: () => { (profile.data.customAnswers.answers ??= []).push({ id: crypto.randomUUID(), question: "", answer: "" }); markProfile(); renderProfile(); } });
    field(answers, "Notice period", ["customAnswers", "noticePeriod"], "text", "e.g. Two weeks");
    field(answers, "Reason for leaving", ["customAnswers", "reasonForLeaving"], "textarea", "Describe your reason in your own words…");
    (profile.data.customAnswers.answers || []).forEach((answer, index) => {
      const row = entryCard(answers, `Answer ${index + 1}`, `answers-${index}`, () => { profile.data.customAnswers.answers.splice(index, 1); markProfile(); renderProfile(); });
      field(row, "Question", ["customAnswers", "answers", index, "question"], "text", "e.g. Why are you interested in this role?"); field(row, "Complete answer", ["customAnswers", "answers", index, "answer"], "textarea", "Write your complete answer…");
    });
    form.append(node("p", "Additional profile fields are preserved. Changes take effect only after Save profile.", "field-help"));
    markProfile();
  }
  async function saveProfile() {
    if (!profile || saving) return;
    markProfile(); if (!profileDirty) return;
    if (!$("profile-editor").reportValidity()) throw new Error("Review the highlighted profile fields. Birthdate must use MM/DD/YYYY.");
    validateProfile(profile.data, selectedCandidate);
    saving = true; saveButtons(); $("profile-editor").inert = true;
    try { profile = await api(`/api/studio/candidates/${selectedCandidate}/profile`, { method: "PUT", body: { data: profile.data, revision: profile.revision } }); profileBaseline = structuredClone(profile.data); profileFormBaseline = profileFormSignature(); markProfile(); status("Profile saved."); }
    finally { saving = false; saveButtons(); $("profile-editor").inert = false; }
  }
  function renderPrompts() {
    if (!state) return; const list = $("prompt-list"); list.replaceChildren();
    if (!state.prompts.data.templates.length) list.append(node("p", "No managed templates. Create one explicitly; legacy prompts have not been imported."));
    for (const template of state.prompts.data.templates) { const item = button(`${template.name} · v${template.version}${template.archived ? " · Archived" : ""}`, () => openPrompt(template), "list-item"); item.setAttribute("aria-pressed", String(editingPrompt?.id === template.id)); list.append(item); }
  }
  function openPrompt(template = null, duplicate = false) {
    if (!state) { status("Load valid Studio configuration before editing the library.", true); return; }
    if (!allowContextChange()) return;
    editingPrompt = template ? structuredClone(template) : null;
    if (duplicate && editingPrompt) { editingPrompt.id = null; editingPrompt.name += " (copy)"; editingPrompt.archived = false; editingPrompt.isDefault = false; }
    $("prompt-editor").hidden = false; $("prompt-editor-title").textContent = editingPrompt?.id ? "Edit managed template" : "New template draft";
    for (const key of ["name", "description", "body", "category"]) $("prompt-" + key).value = editingPrompt?.[key] || "";
    promptBodyDraft = editingPrompt?.body || "";
    $("prompt-default").checked = editingPrompt?.isDefault || false; $("prompt-archived").checked = editingPrompt?.archived || false;
    promptFormBaseline = promptFormSignature(); promptDraft = duplicate; markPrompt(); renderPrompts();
  }
  async function savePrompt(event) {
    event.preventDefault(); if (saving || promptFormBaseline === null || $("prompt-editor").hidden) return;
    markPrompt(); if (!promptDirty) return;
    const data = promptFields();
    const references = editingPrompt?.id ? state.registry.data.candidates.filter(candidate => candidate.assignedPromptTemplateId === editingPrompt.id).length : 0;
    if (data.archived && references && !window.confirm(`Archive this prompt? ${references} candidate reference(s) will remain and require a replacement in Candidates.`)) return;
    const id = editingPrompt?.id; saving = true; saveButtons(); $("prompt-editor").inert = true;
    try {
      state.prompts = await api(`/api/studio/prompts${id ? "/" + id : ""}`, { method: id ? "PUT" : "POST", body: { data, revision: state.prompts.revision } });
      promptFormBaseline = promptFormSignature(); promptDraft = promptDirty = false; $("prompt-editor").hidden = true; renderPrompts(); status("Managed template saved. Existing legacy prompt files were not changed.");
    } finally { saving = false; saveButtons(); $("prompt-editor").inert = false; }
  }
  function renderDocuments() {
    if (!state) return; const gallery = $("document-gallery"); gallery.replaceChildren();
    for (const template of state.documents.templates.filter(supportedDocument)) {
      const builtin = getBuiltInDocumentTemplates().some(item => item.id === template.id);
      const references = state.registry.data.candidates.filter(candidate => candidate.preferredDocumentTemplateId === template.id).length;
      const card = node("article", "", "template-card"); const image = node("img"); image.src = `/${template.layoutId}.svg`; image.alt = `${template.name}: synthetic ${template.layoutId} layout illustration; saved settings apply to the PDF`; image.width = 306; image.height = 396;
      const actions = node("div", "", "toolbar");
      actions.append(button(builtin ? "View / customize" : "View / edit", () => openDocument(template)), button("Duplicate", () => openDocument(template, true)));
      card.append(image, node("h2", template.name), node("p", template.description), node("p", `${builtin ? "Built-in" : "Configuration"} · ${template.archived ? "Archived" : "Available"} · ${references} candidate reference(s)`, "field-help"), actions); gallery.append(card);
    }
  }
  const settingGroups = [
    ["Primary typography", [["bodyFontSize", "Font size (pt)"], ["textColor", "Text color"], ["accentColor", "Accent color"]]],
    ["Page layout", [["pageMargin", "Page margin (pt)"], ["lineHeight", "Line spacing"], ["sectionSpacing", "Section gap (pt)"], ["pageNumbers", "Page numbers"]]],
    ["Header", [["nameFontSize", "Full name size"], ["nameColor", "Full name color"], ["titleFontSize", "Job title size"], ["contactFontSize", "Contact size"], ["headerAlignment", "Alignment"]]],
    ["Resume sections", [["headingFontSize", "Heading size"], ["showSummary", "Professional Summary"], ["showSkills", "Technical Skills"], ["showExperience", "Work Experience"], ["showEducation", "Education"]]],
  ];
  function settingsControls(container, template, values, prefix, onChange) {
    container.replaceChildren();
    const effective = { ...validateDocumentSettings(template), ...values };
    for (const [title, fields] of settingGroups) {
      const group = node("details", "", "settings-group"); group.open = true; group.append(node("summary", title));
      if (title === "Primary typography") group.append(node("p", "Roboto · bundled font", "font-label"));
      for (const [key, caption] of fields) {
        const rule = template.supportedSettings[key]; if (!rule) continue;
        const row = node("div", "", "setting-row"), label = node("label", caption); label.htmlFor = `${prefix}-${key}`;
        const input = node(key === "headerAlignment" ? "select" : "input"); input.id = label.htmlFor;
        if (key === "headerAlignment") { for (const value of ["left", "center", "right"]) { const option = node("option", value[0].toUpperCase() + value.slice(1)); option.value = value; input.append(option); } }
        else input.type = rule.type === "boolean" ? "checkbox" : rule.type === "number" ? "number" : "color";
        if (rule.type === "number") { input.min = rule.minimum; input.max = rule.maximum; input.step = key === "lineHeight" ? "0.02" : "0.5"; }
        if (rule.type === "boolean") input.checked = effective[key]; else input.value = effective[key];
        input.addEventListener("input", () => onChange(key, rule.type === "boolean" ? input.checked : rule.type === "number" ? (input.value === "" ? NaN : Number(input.value)) : input.value)); row.append(label, input); group.append(row);
      }
      container.append(group);
    }
  }
  function openDocument(template = null, duplicate = false) {
    if (!state) { status("Load valid Studio configuration before editing the library.", true); return; }
    if (!allowContextChange()) return;
    const builtin = !template || getBuiltInDocumentTemplates().some(item => item.id === template.id);
    editingDocument = template && !builtin && !duplicate ? structuredClone(template) : null;
    const layout = getBuiltInDocumentTemplates().find(item => item.layoutId === template?.layoutId) || getBuiltInDocumentTemplates()[0];
    documentDefaults = structuredClone(template ? validateDocumentSettings(template) : layout.defaultSettings);
    $("document-name").value = template ? `${template.name}${duplicate || builtin ? " (copy)" : ""}` : "";
    $("document-description").value = template?.description || ""; $("document-layout").value = layout.layoutId;
    $("document-archived").checked = editingDocument?.archived || false;
    $("document-editor-title").textContent = editingDocument ? "Edit document configuration" : "New document configuration";
    $("document-references").textContent = `${editingDocument?.id ? state.registry.data.candidates.filter(candidate => candidate.preferredDocumentTemplateId === editingDocument.id).length : 0} candidate reference(s). Archiving retains references and shows an unavailable-preference warning.`;
    $("document-editor").hidden = false; documentFormBaseline = JSON.stringify(documentFields()); documentDraft = Boolean(duplicate || template && builtin); markDocument(); renderDocumentSettings();
  }
  function renderDocumentSettings() {
    const template = getBuiltInDocumentTemplates().find(item => item.layoutId === $("document-layout").value);
    settingsControls($("document-settings"), template, documentDefaults, "document-setting", (key, value) => { documentDefaults[key] = value; markDocument(); });
  }
  async function saveDocument(event) {
    event.preventDefault(); if (saving || documentFormBaseline === null || $("document-editor").hidden) return;
    markDocument(); if (!documentDirty) return;
    const template = getBuiltInDocumentTemplates().find(item => item.layoutId === $("document-layout").value);
    validateDocumentSettings(template, documentDefaults);
    const data = documentFields();
    const references = editingDocument?.id ? state.registry.data.candidates.filter(candidate => candidate.preferredDocumentTemplateId === editingDocument.id).length : 0;
    if (data.archived && references && !window.confirm(`Archive this configuration? ${references} candidate reference(s) will remain and require an explicit replacement in Candidates.`)) return;
    saving = true; saveButtons(); $("document-editor").inert = true;
    try {
      state.documentCatalog = await api(`/api/studio/documents${editingDocument ? "/" + editingDocument.id : ""}`, { method: editingDocument ? "PUT" : "POST", body: { data, revision: state.documentCatalog?.revision ?? null } });
      documentFormBaseline = JSON.stringify(documentFields()); documentDraft = documentDirty = false; $("document-editor").hidden = true; await refresh(); status("Document configuration saved. Candidate assignments were not changed.");
    } finally { saving = false; saveButtons(); $("document-editor").inert = false; }
  }
  async function loadAssignedPrompt() {
    const epoch = ++promptEpoch, id = selectedCandidate;
    $("assistant-prompt").value = ""; $("resume-copy-prompt").disabled = true;
    $("resume-prompt-source").textContent = id ? "Resolving assigned prompt…" : "Activate a candidate in Candidates first.";
    if (!id) return;
    try {
      const prompt = await api(`/api/studio/candidates/${id}/prompt`);
      if (epoch !== promptEpoch || selectedCandidate !== id || page !== "resume") return;
      $("assistant-prompt").value = prompt.body; $("resume-prompt-source").textContent = `${prompt.name}${prompt.version ? " · v" + prompt.version : ""}`; $("resume-copy-prompt").disabled = false;
    } catch (error) { if (epoch === promptEpoch) { $("resume-prompt-source").textContent = error.message; $("assistant-prompt").placeholder = "Assigned prompt unavailable. Check the candidate configuration or file, then reload."; } }
  }
  async function prepareResume() {
    const candidate = current(); const available = documents();
    fillSelect($("resume-template"), available, candidate?.preferredDocumentTemplateId || "classic", "Choose template");
    $("resume-preference").textContent = candidate?.preferredDocumentTemplateId
      ? (available.some(item => item.id === candidate.preferredDocumentTemplateId) ? "Starts with the saved preference. Alternatives apply to this resume only." : "The saved preference is unavailable. Choose a supported template explicitly.")
      : "Classic default · session changes only";
    $("resume-prompt-source").textContent = promptStatus(candidate, state.prompts.data).label;
    renderSettings(); renderThumbnails(); invalidatePreview(); await loadAssignedPrompt();
  }
  function renderThumbnails() {
    const container = $("resume-thumbnails"); container.replaceChildren();
    for (const template of documents()) {
      const select = button(template.name, () => { $("resume-template").value = template.id; overrides = {}; renderSettings(); renderThumbnails(); invalidatePreview(); }, "compact-template");
      const image = node("img"); image.src = `/${template.layoutId}.svg`; image.alt = `Synthetic ${template.layoutId} layout`; image.width = 70; image.height = 92;
      select.replaceChildren(image, node("span", template.name)); select.setAttribute("aria-pressed", String($("resume-template").value === template.id)); container.append(select);
    }
  }
  function renderSettings() {
    const container = $("resume-settings"); container.replaceChildren(); const template = documents().find(item => item.id === $("resume-template").value); if (!template) return;
    settingsControls(container, template, overrides, "setting", (key, value) => { overrides[key] = value; invalidatePreview(); });
  }
  function renderBindings(resume) {
    const container = $("resume-bindings"); container.replaceChildren(node("h3", "Explicit profile associations"), node("p", "Associate each generated entry with its actual profile record. Dates and universities are never matched by position or guessed from company text."));
    for (const [section, profileSection] of [["experience", "workExperience"], ["education", "education"]]) {
      resume[section].forEach((entry, index) => {
        const id = `binding-${section}-${index}`; const label = node("label", `${section} ${index + 1}: ${entry.company || entry.degree}`); label.htmlFor = id; const select = node("select"); select.id = id;
        const items = (profile?.data[profileSection] || []).map(item => ({ id: item.id, name: section === "experience" ? `${item.company} · ${item.title} (${item.id})` : `${item.university} · ${item.degree} (${item.id})` }));
        fillSelect(select, items, bindings[section][index], "Choose the actual profile entry"); select.addEventListener("change", () => { bindings[section][index] = select.value; invalidatePreview(); }); container.append(label, select);
      });
    }
  }
  function invalidatePreview() {
    clearTimeout(renderTimer); preview.clear(); $("resume-errors").textContent = "";
    $("json-status").textContent = $("resume-json").value.trim() ? "Validating…" : "Awaiting JSON"; $("json-status").dataset.state = "empty";
    if (page !== "resume" || !$("resume-json").value.trim()) return;
    renderTimer = setTimeout(() => run(updatePreview), 350);
  }
  async function updatePreview() {
    if (page !== "resume") return;
    try {
      const text = $("resume-json").value; const resume = contracts.parseResumeResponse(text);
      if (text !== parsedText) {
        // Retain an earlier explicit association only while that generated entry
        // still has the same identity in that position. Never match profile text.
        const retain = (section, same) => resume[section].map((entry, index) => lastResume?.[section][index] && same(entry, lastResume[section][index]) ? bindings[section][index] || "" : "");
        bindings = { experience: retain("experience", (a, b) => a.title === b.title && a.company === b.company), education: retain("education", (a, b) => a.degree === b.degree) };
        parsedText = text; lastResume = resume; renderBindings(resume);
      }
      $("json-status").textContent = "Valid JSON"; $("json-status").dataset.state = "valid";
      if (!profile?.exists) throw new Error("Save a structured profile before rendering. Missing details are never inferred from prompts.");
      const input = resumeInput({ registry: state.registry.data, candidateId: selectedCandidate, profile: profile.data, resumeText: text, documents: state.documents, templateId: $("resume-template").value, bindings, overrides });
      await preview.update(input);
    } catch (error) {
      try { contracts.parseResumeResponse($("resume-json").value); }
      catch { $("json-status").textContent = "Invalid JSON"; $("json-status").dataset.state = "invalid"; }
      $("resume-errors").textContent = error.issues ? error.issues.map(item => `${item.path || "/"}: ${item.message}`).join("\n") : error.message;
      preview.clear("Resolve the validation errors to preview the current input.");
    }
  }
  async function copy(text) {
    await authorize(() => {});
    if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable. Use a supported browser on the local manager origin.");
    try { await navigator.clipboard.writeText(text); } catch { throw new Error("Clipboard write failed. Check browser permissions and try the button again."); }
  }
  for (const element of document.querySelectorAll("[data-page]")) element.addEventListener("click", () => run(() => navigate(element.dataset.page)));
  $("home-start").addEventListener("click", () => run(() => navigate(current() ? "resume" : "candidates")));
  $("home-candidates").addEventListener("click", () => run(() => navigate("candidates")));
  $("edit-active-candidate").addEventListener("click", () => run(async () => { if (current()) await editCandidate?.(current()); }));
  $("studio-refresh").addEventListener("click", () => run(async () => { if (!allowContextChange() || !confirmResumeDiscard()) return; clearResume(); await refresh(); status("Studio configuration refreshed from disk."); }));
  $("profile-editor").addEventListener("submit", event => event.preventDefault());
  $("profile-save").addEventListener("click", () => run(saveProfile));
  $("profile-reload").addEventListener("click", () => run(async () => { if (allowContextChange()) await loadProfile(); }));
  $("prompt-new").addEventListener("click", () => openPrompt());
  $("prompt-editor").addEventListener("input", markPrompt);
  $("prompt-editor").addEventListener("change", markPrompt);
  $("prompt-body").addEventListener("input", () => { promptBodyDraft = preserveTextEdits(promptBodyDraft, $("prompt-body").value); });
  $("prompt-body").addEventListener("paste", event => {
    if (!event.clipboardData) return;
    const input = $("prompt-body"), text = event.clipboardData.getData("text/plain");
    event.preventDefault(); promptBodyDraft = preserveTextEdits(promptBodyDraft, input.value);
    const position = input.selectionStart + normalizedText(text).length;
    promptBodyDraft = replaceTextRange(promptBodyDraft, input.selectionStart, input.selectionEnd, text);
    input.value = promptBodyDraft; input.setSelectionRange(position, position);
    markPrompt();
  });
  $("prompt-editor").addEventListener("submit", event => run(() => savePrompt(event)));
  $("prompt-duplicate").addEventListener("click", () => { const draft = {}; for (const key of ["name", "description", "body", "category"]) draft[key] = $("prompt-" + key).value; draft.body = preserveTextEdits(promptBodyDraft, draft.body); openPrompt(draft, true); });
  $("prompt-discard").addEventListener("click", () => run(async () => { if (!allowContextChange()) return; $("prompt-editor").hidden = true; await refresh(); }));
  $("document-new").addEventListener("click", () => openDocument());
  $("document-editor").addEventListener("submit", event => run(() => saveDocument(event)));
  $("document-editor").addEventListener("input", markDocument);
  $("document-editor").addEventListener("change", markDocument);
  $("document-layout").addEventListener("change", () => { documentDefaults = structuredClone(getBuiltInDocumentTemplates().find(item => item.layoutId === $("document-layout").value).defaultSettings); markDocument(); renderDocumentSettings(); });
  $("document-discard").addEventListener("click", () => run(async () => { if (!allowContextChange()) return; $("document-editor").hidden = true; await refresh(); }));
  $("resume-template").addEventListener("change", () => { overrides = {}; renderSettings(); renderThumbnails(); invalidatePreview(); });
  $("customize-toggle").addEventListener("click", () => { const collapsed = $("customize-toggle").attributes?.["aria-expanded"] === "false" || $("customize-toggle").getAttribute?.("aria-expanded") === "false"; $("customize-toggle").setAttribute("aria-expanded", String(collapsed)); $("resume-workspace").classList.toggle("customize-collapsed", !collapsed); });
  $("prompt-retry").addEventListener("click", () => run(loadAssignedPrompt));
  $("resume-copy-json").addEventListener("click", () => run(async () => { contracts.parseResumeResponse($("resume-json").value); await copy($("resume-json").value); status("Original JSON response copied."); }));
  $("resume-json").addEventListener("input", invalidatePreview);
  $("resume-jd").addEventListener("input", () => { copyEpoch++; invalidatePreview(); });
  $("resume-copy-prompt").addEventListener("click", () => run(async () => {
    const epoch = ++copyEpoch, id = selectedCandidate, jd = $("resume-jd").value;
    let assigned;
    try { assigned = await api(`/api/studio/candidates/${id}/prompt`); }
    catch (error) { if (id === selectedCandidate && epoch === copyEpoch) { $("assistant-prompt").value = ""; $("resume-prompt-source").textContent = error.message; $("resume-copy-prompt").disabled = true; } throw error; }
    if (epoch !== copyEpoch || id !== selectedCandidate || jd !== $("resume-jd").value || page !== "resume") throw new Error("Candidate or JD changed. Copy again with the current input.");
    $("assistant-prompt").value = assigned.body; $("resume-prompt-source").textContent = assigned.name;
    await copy(composePrompt(assigned.body, jd)); status(`Copied ${assigned.name} with the original JD. The JD input is unchanged.`);
  }));
  $("resume-download").addEventListener("click", () => run(() => authorize(() => {
    const resume = contracts.parseResumeResponse($("resume-json").value);
    preview.download(safePdfFilename(current()?.name, resume.company), document);
    status("Download requested. Check your browser downloads for completion or a blocked download.");
  })));
  window.addEventListener("beforeunload", event => { if (dirty() || saving || extensionWorkspace.saving || $("resume-json").value || $("resume-jd").value) { event.preventDefault(); event.returnValue = ""; } });
  window.addEventListener("pagehide", () => { clearTimeout(renderTimer); preview.clear(); extensionWorkspace.leave(); });
  if (window.location?.pathname === "/extension-studio") void run(() => navigate("extensions"));
  function suspend() {
    const draft = { page, selectedCandidate,
      profile: profileDirty && profile ? { snapshot: structuredClone(profile), base: structuredClone(profileBaseline), fields: captureFields($("profile-editor")) } : null,
      prompt: promptDirty ? { record: structuredClone(editingPrompt), fields: promptFields(), revision: state?.prompts.revision, isNew: promptDraft, form: captureFields($("prompt-editor")) } : null,
      document: documentDirty ? { record: structuredClone(editingDocument), fields: structuredClone(documentFields()), revision: state?.documentCatalog.revision, isNew: documentDraft } : null,
      resume: page === "resume" ? { json: $("resume-json").value, jd: $("resume-jd").value, templateId: $("resume-template").value, overrides: structuredClone(overrides), bindings: structuredClone(bindings) } : null,
      extension: extensionWorkspace.suspend() };
    suspended = true; profileEpoch++; refreshEpoch++; homeEpoch++; copyEpoch++; promptEpoch++;
    clearTimeout(renderTimer); preview.clear("Sign in again before viewing or downloading.");
    $("resume-copy-prompt").disabled = $("resume-copy-json").disabled = true;
    return draft;
  }
  function clear() {
    if (!suspended) suspend();
    state = profile = profileBaseline = editingPrompt = editingDocument = null;
    page = "home"; document.body.dataset.page = page;
    profileDirty = promptDirty = documentDirty = saving = false; knownCandidates = ""; selectedCandidate = null;
    profileFormBaseline = promptFormBaseline = documentFormBaseline = null; promptBodyDraft = ""; documentDefaults = {};
    clearResume(); extensionWorkspace.clear();
    for (const id of ["profile-editor", "prompt-list", "document-gallery", "home-content", "home-tools", "candidate-defaults", "resume-thumbnails", "resume-template", "resume-settings"]) $(id).replaceChildren();
    for (const id of ["profile-candidate", "resume-candidate"]) $(id).value = "";
    $("resume-preference").textContent = "";
    for (const id of ["prompt-editor", "document-editor"]) { for (const field of $(id).querySelectorAll("input, textarea, select")) { field.value = ""; field.checked = false; } $(id).hidden = true; }
    status(""); saveButtons();
  }
  async function resume(draft, approval = null) {
    suspended = false;
    state = await api("/api/studio/state");
    page = draft?.page || (window.location?.pathname === "/extension-studio" ? "extensions" : "home"); document.body.dataset.page = page;
    for (const element of document.querySelectorAll(".studio-page")) element.hidden = element.id !== `page-${page}`;
    for (const element of document.querySelectorAll("[data-page]")) { if (element.dataset.page === page) element.setAttribute("aria-current", "page"); else element.removeAttribute("aria-current"); }
    $("resume-copy-json").disabled = false;
    selectedCandidate = draft?.selectedCandidate && state.registry.data.candidates.some(item => item.id === draft.selectedCandidate) ? draft.selectedCandidate : state.registry.data.activeCandidateId;
    syncCandidateSelects(); renderPrompts(); renderDocuments();
    const candidateExists = !draft?.selectedCandidate || selectedCandidate === draft.selectedCandidate;
    if (page === "home") await renderHome();
    if (selectedCandidate) await loadProfile();
    else { profile = profileBaseline = null; profileDirty = false; profileFormBaseline = null; $("profile-editor").replaceChildren(node("p", "No authorized candidate is selected.")); }
    const extension = await extensionWorkspace.resume(draft?.extension, approval?.extension);
    const key = JSON.stringify([state.registry.revision, state.prompts.revision, state.documentCatalog.revision, profile?.revision, extension.key]);
    const reviewed = approval?.key === key;
    const conflicts = [...extension.conflicts];
    if (!candidateExists && (draft?.profile || draft?.resume)) conflicts.push({ label: "Candidate is no longer available; its draft cannot be restored", unavailable: true });
    if (draft?.profile && candidateExists && draft.profile.snapshot.revision !== profile?.revision) conflicts.push({ label: "Profile", saved: profile?.data, draft: draft.profile.snapshot.data });
    if (draft?.prompt && draft.prompt.revision !== state.prompts.revision) conflicts.push({ label: "Prompt library", saved: state.prompts.data, draft: draft.prompt.fields });
    if (draft?.document && draft.document.revision !== state.documentCatalog.revision) conflicts.push({ label: "Document library", saved: state.documentCatalog.data, draft: draft.document.fields });
    if (draft?.prompt?.record?.id && !state.prompts.data.templates.some(item => item.id === draft.prompt.record.id)) conflicts.push({ label: "Edited prompt was removed", unavailable: true });
    if (draft?.document?.record?.id && !state.documentCatalog.data.templates.some(item => item.id === draft.document.record.id)) conflicts.push({ label: "Edited document configuration was removed", unavailable: true });
    if (draft?.resume && !documents().some(item => item.id === draft.resume.templateId)) conflicts.push({ label: "Selected document configuration is no longer available", unavailable: true });
    if (conflicts.length && !reviewed) {
      profileDirty = promptDirty = documentDirty = false; $("prompt-editor").hidden = $("document-editor").hidden = true; saveButtons();
      return { conflicts, approval: { key, extension: extension.approval }, unavailable: conflicts.some(item => item.unavailable) };
    }
    if (conflicts.some(item => item.unavailable)) return { conflicts, unavailable: true };
    restoringDraft = true;
    try {
    if (draft?.profile) {
      profile.data = mergeDraft(draft.profile.base, draft.profile.snapshot.data, profile.data);
      renderProfile(); restoreFields($("profile-editor"), draft.profile.fields.filter(field => draft.profile.snapshot.revision === profile.revision || field.customMessage)); markProfile();
    }
    if (draft?.prompt) {
      const currentRecord = state.prompts.data.templates.find(item => item.id === draft.prompt.record?.id);
      openPrompt(currentRecord || null);
      const fields = mergeDraft(draft.prompt.record || {}, draft.prompt.fields, currentRecord || {});
      for (const name of ["name", "description", "body", "category"]) $("prompt-" + name).value = fields[name] || "";
      $("prompt-default").checked = fields.isDefault; $("prompt-archived").checked = fields.archived;
      promptBodyDraft = fields.body || ""; promptDraft = draft.prompt.isNew; markPrompt();
    }
    if (draft?.document) {
      const currentRecord = state.documentCatalog.data.templates.find(item => item.id === draft.document.record?.id);
      openDocument(currentRecord || null);
      const fields = mergeDraft(draft.document.record || {}, draft.document.fields, currentRecord || {});
      for (const name of ["name", "description", "layout"]) $("document-" + name).value = fields[name === "layout" ? "layoutId" : name] || "";
      $("document-archived").checked = fields.archived; documentDefaults = fields.defaultSettings || {}; documentDraft = draft.document.isNew; renderDocumentSettings(); markDocument();
    }
    if (draft?.resume && candidateExists) { await prepareResume(); $("resume-json").value = draft.resume.json; $("resume-jd").value = draft.resume.jd; $("resume-template").value = draft.resume.templateId; overrides = draft.resume.overrides; bindings = draft.resume.bindings; renderSettings(); invalidatePreview(); }
    } finally { restoringDraft = false; }
    return { conflicts: [] };
  }
  return { allowContextChange, suspend, resume, clear, get dirty() { return dirty() || Boolean($("resume-json").value || $("resume-jd").value); }, candidateOptions: () => api("/api/studio/state"), async candidatesChanged(registry) {
    if (suspended) return;
    const signature = registrySignature(registry); if (signature === knownCandidates) return;
    knownCandidates = signature;
    // Changes originate in guarded legacy actions. Refresh all repository revisions.
    selectedCandidate = registry.activeCandidateId;
    clearResume(); await run(refresh);
  }};
}
