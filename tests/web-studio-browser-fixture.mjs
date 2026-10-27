// Served exclusively by the opt-in synthetic visual-test server, never the manager.
const $ = id => document.getElementById(id);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label) {
  for (let attempt = 0; attempt < 200; attempt++) { if (predicate()) return; await pause(50); }
  throw new Error(`Timed out: ${label}`);
}
const result = document.createElement("output"); result.id = "fixture-report"; result.hidden = true; document.body.append(result);
try {
  const manual = new URL(location.href).searchParams.get("auth") === "manual";
  if (manual) {
    result.textContent = JSON.stringify({ ready: true, manualAuthentication: true });
  } else {
  await until(() => document.body.dataset.auth === "login" || document.body.dataset.auth === "authenticated", "authentication bootstrap");
  if (document.body.dataset.auth === "login") {
    $("auth-username").value = "synthetic-owner"; $("auth-password").value = "Synthetic browser passphrase 123!";
    $("auth-form").requestSubmit();
    await until(() => document.body.dataset.auth === "authenticated", "backend-verified synthetic login");
  }
  const fixture = await (await fetch("/__fixture/data")).json();
  await until(() => $("active-summary").textContent.includes("Alex Example"), "candidate initialization");
  const view = new URL(location.href).searchParams.get("view") || "resume";
  document.querySelector(`[data-page="${view}"]`).click();
  if (view === "home") await until(() => $("home-content").textContent.includes("Alex Example") && $("home-tools").children.length === 5, "landing page context and tools");
  if (view === "extensions") await until(() => $("extension-backend-status").textContent === "Backend reached" && $("extension-device-state").textContent === "Not configured", "Extension Studio empty settings and backend diagnostics");
  if (view === "candidates") {
    await until(() => $("profile-contact-email") && $("candidate-defaults").textContent.includes("Modern"), "combined candidate profile");
    const current = $("profile-workExperience-0-period-current"), end = $("profile-workExperience-0-period-end"), previousEnd = end.value;
    current.checked = true; current.dispatchEvent(new Event("input", { bubbles: true }));
    if (!end.disabled || end.value !== previousEnd) throw new Error("Current must disable the end date without losing its value.");
    if (new URL(location.href).searchParams.get("scenario") === "career") $("profile-section-workExperience").closest("section").scrollIntoView({ block: "start" });
  }
  if (view === "resume") {
    await until(() => $("assistant-prompt").value.includes("Tailor the resume"), "automatic assigned prompt");
    $("resume-jd").value = "Example Hiring Company seeks a Systems Engineer to develop reliable test systems. This is synthetic demonstration content.";
    $("resume-jd").dispatchEvent(new Event("input", { bubbles: true }));
    const resume = structuredClone(fixture.resume);
    if (new URL(location.href).searchParams.get("scenario") === "long") resume.experience[0].sentences = Array.from({ length: 45 }, (_, index) => `Synthetic achievement ${index + 1}: developed reliable test systems with cross-functional teams, documented design decisions, verified interface behavior and improved repeatable engineering checks across several releases.`);
    $("resume-json").value = JSON.stringify(resume, null, 2); $("resume-json").dispatchEvent(new Event("input", { bubbles: true }));
    await until(() => $("binding-experience-0"), "explicit association controls");
    for (const [section, id] of [["experience", "work-one"], ["education", "education-one"]]) { const input = $(`binding-${section}-0`); input.value = id; input.dispatchEvent(new Event("change", { bubbles: true })); }
    await until(() => !$("resume-download").disabled && $("pdf-preview").src.startsWith("blob:"), "actual PDF Blob generation");
    await pause(600);
  }
  const rect = selector => { const target = document.querySelector(selector); if (!target) return null; const r = target.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
  result.textContent = JSON.stringify({ ready: true, view, viewport: [innerWidth, innerHeight], columns: getComputedStyle($("resume-workspace")).gridTemplateColumns,
    left: rect(".customize-panel"), center: rect(".viewer-panel"), right: rect(".assistant-panel"), pdf: rect("#pdf-preview"),
    jsonVisible: rect("#resume-json"), valid: $("json-status").textContent, pdfBlob: $("pdf-preview").src.startsWith("blob:"),
    landing: rect(".landing-hero"), toolkit: rect("#home-tools"), candidateDirectory: rect(".candidate-directory"), candidateProfile: rect(".candidate-profile"),
    birthdate: view === "candidates" ? { display: $("profile-personal-birthday").value, pickerType: $("profile-personal-birthday-calendar").type, pickerValue: $("profile-personal-birthday-calendar").value, currentDisablesEnd: $("profile-workExperience-0-period-end").disabled } : null,
    integration: view === "extensions" ? { backend: $("extension-backend-status").textContent, browser: $("extension-connection-status").textContent, device: $("extension-device-state").textContent, main: rect(".extension-main"), preferences: rect(".extension-aside") } : null,
    overflowX: document.documentElement.scrollWidth > innerWidth });
  }
} catch (error) { result.textContent = JSON.stringify({ ready: false, error: error.message, uiError: $("studio-status").textContent, validation: $("resume-errors").textContent }); }
