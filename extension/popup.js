const form = document.getElementById("candidate-form");
const nameInput = document.getElementById("candidate-name");
const status = document.getElementById("status");

function showStatus(message, isError = false) {
  status.textContent = message;
  status.className = isError ? "error" : "";
}

async function loadCandidateName() {
  try {
    const saved = await chrome.storage.local.get("candidateName");
    nameInput.value = saved.candidateName || "";
  } catch (error) {
    showStatus(`Could not load the name: ${error.message}`, true);
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const candidateName = nameInput.value.trim();
  if (!candidateName) {
    showStatus("Enter a candidate name.", true);
    return;
  }

  try {
    await chrome.storage.local.set({ candidateName });
    nameInput.value = candidateName;
    showStatus("Candidate name saved.");
  } catch (error) {
    showStatus(`Could not save the name: ${error.message}`, true);
  }
});

loadCandidateName();
