// Trusted popup launcher only. No capture, native messages or candidate state.
export async function openWorkspace({ chrome = globalThis.chrome, locks = globalThis.navigator?.locks,
  location = globalThis.location } = {}) {
  if (location?.protocol !== "chrome-extension:" || location.hostname !== chrome?.runtime?.id)
    throw new Error("Open Application Tracker from its extension popup.");
  if (chrome.extension?.inIncognitoContext)
    throw new Error("Use an ordinary Chrome profile for the authenticated workspace. Incognito is not a separate installation.");
  if (typeof locks?.request !== "function" || typeof chrome.runtime.getContexts !== "function")
    throw new Error("This Chrome version cannot safely locate the persistent workspace.");
  const url = chrome.runtime.getURL.call(chrome.runtime, "workspace.html");
  return locks.request.call(locks, "application-tracker-workspace-launcher", { mode: "exclusive" }, async () => {
    const area = chrome.storage.session;
    await area.setAccessLevel.call(area, { accessLevel: "TRUSTED_CONTEXTS" });
    const contexts = await chrome.runtime.getContexts.call(chrome.runtime, { contextTypes: ["TAB"], documentUrls: [url] });
    let tab = contexts.find(context => Number.isInteger(context.tabId) && context.tabId >= 0);
    if (!tab) {
      const cached = (await area.get.call(area, "tracker.workspace.tab.v1"))["tracker.workspace.tab.v1"];
      if (Number.isInteger(cached)) {
        let existing;
        try { existing = await chrome.tabs.get.call(chrome.tabs, cached); } catch { /* Closed tab. */ }
        if (existing?.url === url || existing?.pendingUrl === url) tab = { tabId: existing.id, windowId: existing.windowId };
        else if (existing && !existing.url && !existing.pendingUrl)
          throw new Error("The workspace is still opening. Try again when its tab has loaded.");
      }
    }
    if (!tab) {
      const created = await chrome.tabs.create.call(chrome.tabs, { url, active: true });
      await area.set.call(area, { "tracker.workspace.tab.v1": created.id });
      return created.id;
    }
    await chrome.tabs.update.call(chrome.tabs, tab.tabId, { active: true });
    await chrome.windows.update.call(chrome.windows, tab.windowId, { focused: true });
    return tab.tabId;
  });
}
