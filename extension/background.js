async function handleCompanySave(companyName, tab) {
  const cleanName = normalizeSelectedText(companyName);

  if (!tab?.id) return;

  if (!cleanName) {
    await showPageMessage(
      tab.id,
      "SELECT COMPANY NAME",
      "Highlight the company name, then run the extension again.",
      "info"
    );
    return;
  }

  try {
    const checkResponse = await chrome.runtime.sendNativeMessage(
      HOST_NAME,
      {
        action: "check_company",
        companyName: cleanName
      }
    );

    if (!checkResponse?.ok) {
      await showPageMessage(
        tab.id,
        "CHECK FAILED",
        checkResponse?.error || "Could not check this company.",
        "error"
      );
      return;
    }

    if (checkResponse.exists) {
      await showPageMessage(
        tab.id,
        "ALREADY SAVED",
        `Candidate: ${checkResponse.candidateName}\n` +
          `Company: ${cleanName}\n\n` +
          `Folder: ${checkResponse.folderPath}`,
        "error"
      );
      return;
    }

    await showPageMessage(
      tab.id,
      "SAVING JOB",
      `Candidate: ${checkResponse.candidateName}\n` +
        `Company: ${cleanName}\n\nPlease wait…`,
      "info"
    );

    const [domPageData, captureResult] = await Promise.all([
      extractPageData(tab.id),
      captureMhtmlBase64(tab.id)
    ]);

    const mhtmlPageData = extractPageDataFromMhtml(
      captureResult.mhtmlText || ""
    );

    const pageData = choosePreferredPageData(
      domPageData,
      mhtmlPageData
    );

    // The MHTML text was needed only for the fallback extractor.
    // Send the archive as Base64 to the native host.
    captureResult.mhtmlText = "";

    const saveResponse = await chrome.runtime.sendNativeMessage(
      HOST_NAME,
      {
        action: "save_application",
        expectedCandidateId: checkResponse.candidateId,
        companyName: cleanName,
        jobTitle: pageData.jobTitle || tab.title || "",
        jobUrl: tab.url || "",
        pageTitle: pageData.pageTitle || tab.title || "",
        selectedText: cleanName,
        jobDescription: pageData.jobDescription || "",
        mhtmlBase64: captureResult.mhtmlBase64 || ""
      }
    );

    if (!saveResponse?.ok) {
      await showPageMessage(
        tab.id,
        "SAVE FAILED",
        saveResponse?.error || "Could not save this job.",
        "error"
      );
      return;
    }

    if (typeof saveResponse.finalPrompt !== "string" ||
        !saveResponse.finalPrompt.trim()) {
      await showPageMessage(
        tab.id,
        "SAVED, PROMPT UNAVAILABLE",
        `The job was saved in ${saveResponse.folderPath}, ` +
          "but the host did not return a prompt to copy.",
        "error"
      );
      return;
    }

    const copyResult = await copyTextToClipboard(
      tab.id,
      saveResponse.finalPrompt
    );

    if (!copyResult?.ok) {
      await showPageMessage(
        tab.id,
        "SAVED, BUT COPY FAILED",
        `Candidate: ${saveResponse.candidateName}\n` +
          `Company: ${cleanName}\n\n` +
          `Folder: ${saveResponse.folderPath}\n\n` +
          `Clipboard error: ${copyResult?.error || "Unknown error"}`,
        "error"
      );
      return;
    }

    let message =
      `Candidate: ${saveResponse.candidateName}\n` +
      `Company: ${cleanName}\n\n` +
      `Folder: ${saveResponse.folderPath}\n\n` +
      "Saved prompt copied to clipboard.";

    if (captureResult.captureError) {
      message +=
        "\n\nThe MHTML archive could not be captured; " +
        "the available job text was saved.";
    }

    await showPageMessage(
      tab.id,
      "SAVED + COPIED",
      message,
      "success"
    );
  } catch (error) {
    console.error("Application Tracker failed:", error);

    await showPageMessage(
      tab.id,
      "APPLICATION TRACKER ERROR",
      "Check that the native host is registered for this " +
        "extension ID and an active candidate is selected.\n\n" +
        `Details: ${error?.message || String(error)}`,
      "error"
    );
  }
}