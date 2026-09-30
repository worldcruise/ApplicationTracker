const HOST_NAME = "com.kevin.candidate_host";
const MENU_ID = "check-save-candidate-company";


chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: "Check + Save Company",
      contexts: ["selection"]
    });
  });
});


chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab?.id) return;

  const companyName = normalizeSelectedText(info.selectionText) ||
    await getSelectedText(tab.id, info.frameId);

  await handleCompanySave(companyName, tab);
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "check-selected-company") return;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) return;
  await handleCompanySave(await getSelectedText(tab.id), tab);
});


function normalizeSelectedText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function getSelectedText(tabId, frameId = null) {
  try {
    const target = Number.isInteger(frameId) && frameId >= 0
      ? { tabId, frameIds: [frameId] }
      : { tabId, allFrames: true };
    const frames = await chrome.scripting.executeScript({
      target,
      func: () => {
        let active = document.activeElement;
        while (active?.shadowRoot?.activeElement) {
          active = active.shadowRoot.activeElement;
        }
        let text = "";
        if (active instanceof HTMLInputElement ||
            active instanceof HTMLTextAreaElement) {
          const start = active.selectionStart;
          const end = active.selectionEnd;
          if (typeof start === "number" && typeof end === "number" && end > start) {
            text = active.value.slice(start, end);
          }
        }
        if (!text) text = window.getSelection()?.toString() || "";
        return {
          text,
          focused: document.hasFocus() &&
            !(active instanceof HTMLIFrameElement) &&
            !(active instanceof HTMLFrameElement)
        };
      }
    });
    const selected = frames.find(({ result }) => result?.focused && result.text?.trim()) ||
      frames.find(({ result }) => result?.text?.trim());
    return normalizeSelectedText(selected?.result?.text);
  } catch (error) {
    console.error("Could not read selected company name:", error);
    return "";
  }
}


async function captureMhtmlBase64(tabId) {
  const blob = await chrome.pageCapture.saveAsMHTML({ tabId });

  if (!blob) {
    throw new Error("Could not capture MHTML.");
  }

  if (blob.size > 45 * 1024 * 1024) {
    throw new Error("MHTML file too large.");
  }

  const bytes = new Uint8Array(await blob.arrayBuffer());

  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }

  return btoa(binary);
}


async function extractCompanyText(tabId) {
  const extract = () => {
    const sections = [];
    for (const element of document.querySelectorAll("div[id^='overview' i], div#company, article")) {
      const clone = element.cloneNode(true);
      clone.querySelectorAll(
        "script, style, noscript, template, svg, nav, footer, form, button, " +
        "[hidden], [aria-hidden='true'], div[id^='overview' i], div#company, article"
      ).forEach((node) => node.remove());
      clone.querySelectorAll("br").forEach((node) => node.replaceWith("\n"));
      clone.querySelectorAll("li").forEach((node) => node.prepend("\n- "));
      clone.querySelectorAll("p, div, section, h1, h2, h3, h4, h5, h6")
        .forEach((node) => node.prepend("\n"));

      const text = String(clone.textContent || "")
        .replace(/\u00a0/g, " ")
        .replace(/[ \t]+/g, " ")
        .replace(/ *\n */g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      if (!text) continue;
      const label = element.id?.toLowerCase().startsWith("overview") ? "Overview" :
        element.id === "company" ? "Company details" : "Article";
      sections.push(`${label}:\n${text.slice(0, 20000)}`);
    }
    return sections;
  };

  let frames;
  try {
    frames = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true }, func: extract
    });
  } catch (error) {
    console.warn("Could not read all frames; trying the main page:", error);
    frames = await chrome.scripting.executeScript({ target: { tabId }, func: extract });
  }

  const sections = [...new Set(frames.flatMap(({ result }) => result || []))];
  return sections.join("\n\n").slice(0, 40000);
}


async function copyTextToClipboard(tabId, text) {
  try {
    const [frame] = await chrome.scripting.executeScript({
      target: { tabId },
      args: [text],
      func: async (value) => {
        try {
          await navigator.clipboard.writeText(value);
          return { ok: true };
        } catch {
          const input = document.createElement("textarea");
          input.value = value;
          input.readOnly = true;
          input.style.cssText = "position:fixed;left:-9999px;top:-9999px";
          (document.body || document.documentElement).appendChild(input);
          try {
            input.select();
            return document.execCommand("copy")
              ? { ok: true }
              : { ok: false, error: "Clipboard copy was blocked by the page." };
          } finally {
            input.remove();
          }
        }
      }
    });
    return frame?.result || { ok: false, error: "Clipboard returned no result." };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}


async function handleCompanySave(companyName, tab) {
  if (!tab?.id) return;
  const company = normalizeSelectedText(companyName);
  if (!company) {
    await showPageMessage(tab.id, "Select the company name first.");
    return;
  }

  try {
    const settings = await chrome.storage.local.get("candidateName");
    const candidateName = String(settings.candidateName || "").trim();
    if (!candidateName) {
      await showPageMessage(tab.id, "Save the candidate name in the extension popup first.");
      return;
    }

    // The host verifies the caller and active candidate before page capture.
    const check = await chrome.runtime.sendNativeMessage(HOST_NAME, {
      action: "check_company", candidateName, companyName: company
    });
    if (!check?.ok) {
      await showPageMessage(tab.id, check?.error || "Could not check this company.");
      return;
    }
    if (check.exists) {
      await showPageMessage(tab.id, `Already saved:\n${check.folderPath}`);
      return;
    }

    const mhtmlBase64 = await captureMhtmlBase64(tab.id);
    let jobDescription = "";
    try {
      jobDescription = await extractCompanyText(tab.id);
    } catch (error) {
      console.warn("Could not read the requested page tags:", error);
    }

    const saved = await chrome.runtime.sendNativeMessage(HOST_NAME, {
      action: "save_application",
      candidateName,
      companyName: company,
      selectedText: company,
      jobUrl: tab.url || "",
      pageTitle: tab.title || "",
      jobDescription,
      mhtmlBase64
    });
    if (!saved?.ok) {
      await showPageMessage(tab.id, saved?.error || "Could not save this company.");
      return;
    }
    if (typeof saved.finalPrompt !== "string" || !saved.finalPrompt.trim()) {
      await showPageMessage(tab.id, `MHTML saved in ${saved.folderPath}, but no prompt was returned.`);
      return;
    }

    const copied = await copyTextToClipboard(tab.id, saved.finalPrompt);
    if (!copied.ok) {
      await showPageMessage(tab.id,
        `MHTML saved in ${saved.folderPath}, but prompt copy failed: ${copied.error}`);
      return;
    }
    await showPageMessage(tab.id,
      `Saved MHTML and copied prompt.\n${saved.folderPath}` +
      (jobDescription ? "" : "\nNo matching overview, company, or article tags were found."),
      "success");
  } catch (error) {
    console.error("Application Tracker failed:", error);
    await showPageMessage(tab.id, error?.message || String(error));
  }
}


async function showPageMessage(tabId, message, type = "error") {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      args: [message, type],
      func: (text, kind) => {
        document.getElementById("__application_tracker_toast__")?.remove();

        const toast = document.createElement("div");
        toast.id = "__application_tracker_toast__";
        toast.setAttribute("role", kind === "error" ? "alert" : "status");
        const accent = kind === "success" ? "#4adea8" :
          kind === "error" ? "#ff9b94" : "#d2e3fc";
        const background = kind === "success" ? "#0f9d58" :
          kind === "error" ? "#d93025" : "#1a73e8";
        Object.assign(toast.style, {
          position: "fixed",
          top: "24px",
          right: "24px",
          zIndex: "2147483647",
          boxSizing: "border-box",
          width: "400px",
          maxWidth: "calc(100vw - 48px)",
          maxHeight: "40vh",
          overflowY: "auto",
          padding: "16px 42px 16px 18px",
          display: "flex",
          alignItems: "flex-start",
          gap: "11px",
          borderRadius: "12px",
          border: "1px solid rgba(255, 255, 255, 0.16)",
          borderLeft: `4px solid ${accent}`,
          background,
          color: "#f8fbff",
          boxShadow: "0 16px 44px rgba(8, 19, 41, 0.34), 0 3px 10px rgba(8, 19, 41, 0.15)",
          font: "14px/1.45 Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere"
        });

        const badge = document.createElement("span");
        badge.textContent = kind === "success" ? "✓" : "!";
        badge.setAttribute("aria-hidden", "true");
        Object.assign(badge.style, {
          flex: "0 0 24px",
          width: "24px",
          height: "24px",
          display: "grid",
          placeItems: "center",
          borderRadius: "50%",
          background: "#ffffff",
          color: background,
          fontSize: "16px",
          fontWeight: "800"
        });

        const close = document.createElement("button");
        close.textContent = "\u00d7";
        close.setAttribute("aria-label", "Close message");
        Object.assign(close.style, {
          position: "absolute",
          top: "8px",
          right: "10px",
          width: "26px",
          height: "26px",
          border: "0",
          borderRadius: "7px",
          background: "rgba(255, 255, 255, 0.08)",
          color: "#d6e0ef",
          fontSize: "20px",
          lineHeight: "1",
          cursor: "pointer"
        });
        close.addEventListener("click", () => toast.remove());

        const body = document.createElement("div");
        body.style.paddingTop = "2px";
        body.style.minWidth = "0";
        const firstLineBreak = text.indexOf("\n");
        const title = document.createElement("strong");
        title.textContent = firstLineBreak === -1 ? text : text.slice(0, firstLineBreak);
        Object.assign(title.style, {
          display: "block",
          fontSize: "16px",
          lineHeight: "1.3",
          fontWeight: "700"
        });
        body.appendChild(title);
        if (firstLineBreak !== -1) {
          const details = document.createElement("div");
          details.textContent = text.slice(firstLineBreak + 1);
          details.style.marginTop = "4px";
          body.appendChild(details);
        }

        const timerTrack = document.createElement("div");
        timerTrack.setAttribute("aria-hidden", "true");
        Object.assign(timerTrack.style, {
          position: "absolute",
          left: "4px",
          right: "0",
          bottom: "0",
          height: "3px",
          overflow: "hidden",
          borderRadius: "0 0 12px 0",
          background: "rgba(255, 255, 255, 0.12)",
          pointerEvents: "none"
        });
        const timerFill = document.createElement("div");
        Object.assign(timerFill.style, {
          width: "100%",
          height: "100%",
          background: accent,
          boxShadow: `0 0 8px ${accent}`,
          transformOrigin: "left center"
        });
        timerTrack.appendChild(timerFill);

        toast.append(badge, body, close, timerTrack);
        (document.body || document.documentElement).appendChild(toast);
        toast.animate(
          [
            { opacity: 0, transform: "translateY(-8px) scale(0.98)" },
            { opacity: 1, transform: "translateY(0) scale(1)" }
          ],
          { duration: 180, easing: "ease-out" }
        );
        timerFill.animate(
          [{ transform: "scaleX(1)" }, { transform: "scaleX(0)" }],
          { duration: 3000, easing: "linear", fill: "forwards" }
        );
        setTimeout(() => {
          toast.animate(
            [
              { opacity: 1, transform: "translateY(0)" },
              { opacity: 0, transform: "translateY(-6px)" }
            ],
            { duration: 300, easing: "ease-in", fill: "forwards" }
          );
        }, 2700);
        setTimeout(() => toast.remove(), 3000);
      }
    });
  } catch (error) {
    console.error("Could not show page message:", error);
  }
}
