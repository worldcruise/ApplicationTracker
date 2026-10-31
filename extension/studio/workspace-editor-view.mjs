// Workspace-only DOM bindings. No storage, backend writes or clipboard reads.
export function bindWorkspaceEditor(editor, { document = globalThis.document } = {}) {
  const $ = id => document.getElementById(id);
  const inputs = { company: "job-company", jobUrl: "job-url", jd: "job-description", cvJson: "cv-json", coverLetter: "cover-letter" };
  const copyButtons = { jd: "copy-jd", cvJson: "copy-json", coverLetter: "copy-cover-letter" };
  const setValue = (id, value) => { if ($(id).value !== value) $(id).value = value; };
  function render() {
    const state = editor.snapshot();
    for (const [field, id] of Object.entries(inputs)) { setValue(id, state.draft[field]); $(id).disabled = !state.active; }
    for (const [field, id] of Object.entries(copyButtons)) {
      $(id).disabled = !state.active || state.draft[field].length === 0;
      const notice = $(id + "-status");
      notice.textContent = state.feedback[field]?.message || ""; notice.dataset.kind = state.feedback[field]?.kind || "";
    }
    const validation = state.validation;
    $("cv-validation").textContent = { empty: "Empty — paste resume JSON to validate.", valid: "Valid resume JSON.", invalid: "Invalid resume JSON.", unavailable: "CV validation unavailable." }[validation.state];
    $("cv-validation").dataset.state = validation.state;
    $("cv-errors").textContent = validation.issues.map(issue => `${issue.path}: ${issue.message}`).join("\n");
    $("cv-errors").hidden = !state.active || validation.issues.length === 0;
    $("validate-cv").disabled = !state.active;
    $("open-import").disabled = !state.active;
    $("import-panel").hidden = !state.active || !state.import;
    setValue("import-source", state.import?.source || "");
    $("import-source").disabled = !state.active;
    $("review-import").disabled = !state.active || !state.import?.source.length;
    $("import-review").hidden = !state.active || !state.import?.review;
    for (const field of ["company", "jobUrl", "jd"]) {
      const id = { company: "review-company", jobUrl: "review-url", jd: "review-jd" }[field];
      setValue(id, state.import?.review?.[field] || ""); $(id).disabled = !state.active;
    }
    $("import-detection").textContent = state.import?.review?.message || "";
    $("import-overwrite-row").hidden = !state.import?.overwriteNeeded;
    $("import-overwrite").checked = state.import?.confirmOverwrite === true;
    $("import-overwrite").disabled = !state.active;
    $("apply-import").disabled = !state.active || !state.import?.review
      || state.import.overwriteNeeded && !state.import.confirmOverwrite;
    $("cancel-import").disabled = !state.active;
    $("import-error").textContent = state.import?.error || "";
    $("import-error").hidden = !state.import?.error;
  }
  for (const [field, id] of Object.entries(inputs)) $(id).addEventListener("input", () => editor.update(field, $(id).value));
  for (const [field, id] of Object.entries(copyButtons)) $(id).addEventListener("click", () => {
    // The live textarea value is authoritative, including native newline handling.
    editor.update(field, $(inputs[field]).value);
    void editor.copy(field);
  });
  $("open-import").addEventListener("click", () => { editor.openImport(); $("import-source").focus(); });
  $("import-source").addEventListener("input", () => editor.editImportSource($("import-source").value));
  $("review-import").addEventListener("click", () => editor.reviewImport());
  for (const [field, id] of Object.entries({ company: "review-company", jobUrl: "review-url", jd: "review-jd" }))
    $(id).addEventListener("input", () => editor.editReview(field, $(id).value));
  $("import-overwrite").addEventListener("change", () => editor.confirmOverwrite($("import-overwrite").checked));
  $("apply-import").addEventListener("click", () => { if (editor.applyImport()) $("job-description").focus(); });
  $("cancel-import").addEventListener("click", () => { editor.cancelImport(); $("open-import").focus(); });
  $("validate-cv").addEventListener("click", () => { void editor.retryValidation(); });
  const unsubscribe = editor.subscribe(render);
  render();
  return { render, dispose: unsubscribe };
}
