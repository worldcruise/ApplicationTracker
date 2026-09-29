# Application Tracker

Application Tracker manages several candidate profiles for the existing Chrome job-capture extension. A local management page lets you edit each candidate's settings and choose the active candidate. The Chrome extension captures a posting; a Python native host checks the active candidate's history folder, saves the job files, and returns the exact saved prompt for copying.

**Current scope:** Candidate setup and active-candidate routing. The Tracking dashboard, Bidding queue, application statuses, and folder deletion are future stages. The component code has been provided file by file, but the assembled Windows workflow has not yet been tested end to end.

## What's new

- A candidate list with **Edit** and **Set active** actions.
- Separate history folder, prompt template, and installed Chrome extension ID for each candidate.
- A guided configuration window with a history-folder test.
- One shared native host that registers the configured extension IDs and reads the active candidate from a central configuration file.
- The host builds and saves the prompt from the active candidate's template; the extension copies that same returned prompt.
- A safeguard that stops a save if the active candidate changes between the duplicate check and the save.

All permitted extension copies use the **active** candidate's folder and template. An extension ID identifies an allowed caller; it does not itself choose the candidate. Assign `Ctrl+Shift+F` to one extension copy if you install several.

## Folder layout

```text
ApplicationTracker/
├── ApplicationTracker-README.md
├── config/
│   ├── candidates.json
│   └── templates/                 # Created when candidates are saved
├── manager/
│   ├── app.py
│   └── ui/
│       ├── index.html
│       ├── styles.css
│       └── app.js
├── native-host/
│   ├── candidate_host.py
│   ├── register_host.py
│   ├── _run_host.bat
│   └── com.kevin.candidate_host.json  # Generated on registration
└── extension/
    ├── manifest.json
    └── background.js
```

Each candidate's history folder can be anywhere on your computer. It does not need to be inside `ApplicationTracker/`.

## Requirements

- Windows and Google Chrome
- Python 3.10 or newer, available through `py -3` or `python`
- A writable, permanent location for the `ApplicationTracker/` folder

## Assemble the files

1. Create the folder layout above and place the provided files at those paths.
2. Copy the **original extension's complete** `background.js` into `extension/`, then replace only its `handleCompanySave` function with the supplied File 6 version. Keep its extraction, MHTML, clipboard, and page-message helpers.
3. Use the supplied File 7 `manifest.json`.
4. Include the **File 4 correction** in `native-host/candidate_host.py`: `handle_save_application` must compare `expectedCandidateId` with the active candidate ID.
5. Use the corrected `manager/app.py` registration call that runs `register_host.py` with `subprocess`; remove the unresolved `from register_host import ...` import.
6. Start `config/candidates.json` with:

   ```json
   {
     "schemaVersion": 1,
     "activeCandidateId": null,
     "candidates": []
   }
   ```

The native-host manifest is generated when you save the first candidate. Keep the project folder in its final location before registering it, because the Windows registration contains an absolute path.

## Install and run

1. In Chrome, open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the `ApplicationTracker/extension` folder. Copy the installed extension's ID.
2. Open a Windows terminal in `ApplicationTracker/` and start the manager:

   ```bat
   py -3 manager\app.py
   ```

   The manager prints its local address and opens it in your browser. Leave this terminal open while using the management page.
3. Select **Add candidate**. Enter a name, the actual extension ID, a full history-folder path, and the candidate's complete prompt template. Select **Test folder**, then **Save candidate**.
4. Saving runs `native-host/register_host.py`. It writes the native-host manifest and registers it for your Windows user. The page reports any registration error.
5. Select **Set active** next to the candidate. The active candidate appears at the top of the page.
6. On a job page, highlight the company name and use the extension's right-click action or `Ctrl+Shift+F`. The extension checks the active history folder, saves the job, and copies the saved prompt.

You may close the manager after setting the active candidate. Chrome starts the native host when the extension sends a message; the management page does not need to remain open for a capture. Reopen it with `py -3 manager\app.py` to change settings.

## Saved job files

The host creates a company folder in the active candidate's history folder. It writes:

| File | Purpose |
| --- | --- |
| `job_description.txt` | Extracted job text, when available |
| `job_description.mhtml` | Page archive, when capture succeeds |
| `resume_prompt.txt` | Prompt built from the active candidate's template |
| `meta.json` | Company, role, URL, candidate ID, and save timestamps |

If a matching company folder already exists, the extension displays **Already saved** and stops. At this stage, folder existence means the company was saved; it does not prove that an application was submitted.

## Existing history and multiple candidates

The old `candidate-host/config.json` is **not automatically imported** by the files supplied so far. To reuse an existing candidate, enter the existing `candidate_root` path as that candidate's history folder, paste the desired prompt template into the manager, and enter the installed extension's ID. This does not move or delete the existing company folders.

Each candidate must have a distinct extension ID and history-folder path. The prompt templates are stored separately under `config/templates/`. Editing a candidate's history path changes where future captures are saved; it does not move old folders.

## Troubleshooting

- **“Native host not found” or “access forbidden”:** Confirm the extension ID in the manager matches Chrome's ID. Run `py -3 native-host\register_host.py` after saving candidates, then reload the extension and retry. The project folder must remain at the path used during registration.
- **“No active candidate”:** Open the manager and select **Set active**.
- **Folder test fails:** Use a full Windows path and ensure your account can create files there.
- **The shortcut does not run:** Check `chrome://extensions/shortcuts`. If several copies are installed, assign `Ctrl+Shift+F` to only one.
- **The prompt differs from the saved file:** Ensure the updated `handleCompanySave` function is installed and reload the extension.

Chrome's [unpacked-extension guide](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world) explains **Load unpacked**. Its [native-messaging guide](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging) documents the Windows registration and allowed extension origins.
