# Application Tracker

Application Tracker manages several candidate profiles for a Chrome extension. A local management page lets you edit each candidate's settings and choose the active candidate. The extension reads a highlighted company name, captures the page as MHTML, and reads selected page sections. A Python native host saves the archive and returns a generated prompt for copying.

**Current scope:** Candidate setup and active-candidate routing. The Tracking dashboard, Bidding queue, application statuses, and folder deletion are future stages. The component code has been provided file by file, but the assembled Windows workflow has not yet been tested end to end.

## What's new

- A candidate list with **Edit**, **Delete**, and **Active** actions.
- Separate history folder and prompt for each candidate. Candidates may share an installed Chrome extension ID. A prompt can be pasted or linked to a UTF-8 `.txt` or `.md` file.
- A guided configuration window with a history-folder test.
- One shared native host that registers the configured extension IDs and reads the active candidate from a central configuration file.
- The extension reads the company name you highlight, captures an MHTML archive, and takes text only from `<div>` elements whose ID starts with `overview`, `div#company`, and `<article>` elements. The host saves the archive and builds a prompt from that text and the active candidate's template; the extension copies the returned prompt.
- The host matches the calling extension ID and popup candidate name, then checks whether that candidate is active.

One extension can be used for several candidates. The extension popup stores the candidate name; the host checks that name and the caller's extension ID, then permits folder access only while that candidate is active. Change the popup name when switching candidates.

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
    ├── background.js
    ├── popup.html
    ├── popup.css
    └── popup.js
```

Each candidate's history folder can be anywhere on your computer. It does not need to be inside `ApplicationTracker/`.

## Requirements

- Windows and Google Chrome
- Python 3.10 or newer, available through `py -3` or `python`
- A writable, permanent location for the `ApplicationTracker/` folder

## Configuration

The repository contains the extension background script, popup, manager, and native host. The native host matches the calling extension ID and popup name to a candidate and checks that candidate is active before checking or saving a company. The popup name must match the candidate name in the manager.

The native-host manifest is generated when you save the first candidate. Keep the project folder in its final location before registering it, because the Windows registration contains an absolute path.

## Install and run

1. In Chrome, open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the `ApplicationTracker/extension` folder. Copy the installed extension's ID.
2. Open a Windows terminal in `ApplicationTracker/` and start the manager:

   ```bat
   py -3 manager\app.py
   ```

   The manager prints its local address and opens it in your browser. Leave this terminal open while using the management page.
3. Select **Add candidate**. Enter a name and the actual extension ID. Paste the candidate's prompt text, or select **Use a .txt or .md file** and choose its path with **Browse**. Enter or browse to a history folder, select **Test folder**, then **Save candidate**.
4. Saving runs `native-host/register_host.py`. It writes the native-host manifest and registers it for your Windows user. The page reports any registration error.
5. Select the candidate's **Active** radio button, or check **Set this candidate active after saving**. The active candidate appears at the top of the page.
6. Click the extension icon, enter the same candidate name used in the manager, and select **Save name**. On a job page, highlight the company name and use the extension's right-click action or `Ctrl+Shift+F`. The host stops with “This candidate is not active.” if another candidate is active; otherwise it checks the folder, saves the MHTML archive, and uses the matching page sections to build the prompt for copying.

You may close the manager after setting the active candidate. Chrome starts the native host when the extension sends a message; the management page does not need to remain open for a capture. Reopen it with `py -3 manager\app.py` to change settings.

## Saved job files

The host creates a company folder in the active candidate's history folder. It writes:

| File | Purpose |
| --- | --- |
| `job_description.mhtml` | Captured page archive |
| `meta.json` | Company, page URL, candidate ID, and save timestamps |

The host uses the matching page text to build the prompt and returns it for clipboard copying. It does not write `job_description.txt` or `resume_prompt.txt`.

If a matching company folder already exists, the extension displays **Already saved** and stops. At this stage, folder existence means the company was saved; it does not prove that an application was submitted.

## Existing history and multiple candidates

The old `candidate-host/config.json` is **not automatically imported** by the files supplied so far. To reuse an existing candidate, enter the existing `candidate_root` path as that candidate's history folder, paste the desired prompt template into the manager, and enter the installed extension's ID. This does not move or delete the existing company folders.

Each candidate must have a distinct history-folder path. Candidates can share an extension ID if their names differ. Pasted prompts are stored separately under `config/templates/`. A linked prompt file is read from its original path for each capture, so keep the file there. Editing a candidate's history path changes where future captures are saved; it does not move old folders.

**Delete** removes a candidate profile and its stored pasted prompt after confirmation. Saved application folders and linked prompt files stay on disk. If the deleted candidate was active, select another candidate before capturing jobs. Deleting the last profile removes this app's native-host registration.

## Troubleshooting

- **“Native host not found” or “access forbidden”:** Confirm the extension ID in the manager matches Chrome's ID. Run `py -3 native-host\register_host.py` after saving candidates, then reload the extension and retry. The project folder must remain at the path used during registration.
- **“No active candidate”:** Open the manager and select **Set active**.
- **Folder test fails:** Use a full Windows path and ensure your account can create files there.
- **The shortcut does not run:** Check `chrome://extensions/shortcuts`. If several copies are installed, assign `Ctrl+Shift+F` to only one.
- **The copied prompt is outdated:** Reload the extension and confirm the active candidate's prompt template in the manager.

Chrome's [unpacked-extension guide](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world) explains **Load unpacked**. Its [native-messaging guide](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging) documents the Windows registration and allowed extension origins.
