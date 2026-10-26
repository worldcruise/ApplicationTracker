# Application Tracker

Application Tracker manages several candidate profiles for a Chrome extension. A local management page lets you edit each candidate's settings and choose the active candidate. The extension hotkey copies extracted JD text, the current tab URL, and an optional selected company. The separate legacy context-menu action captures MHTML and uses a Python native host to save the archive and return a generated prompt.

**Current scope:** The web platform includes Home, combined candidate/profile management, template libraries, Resume Studio PDF preview/download, and [Extension Studio integration management](docs/extension-studio.md). Legacy extension capture remains separate. New candidate-scoped extension operations, bid-folder saving, a bidding queue and application statuses are pending. Installed-extension/native capture has not been verified end to end by the synthetic web tests.

**Owner security checkpoints UI-C1/UI-C2:** [Local owner setup and recovery](docs/owner-security.md) provide the private credential store and administrative CLI. [Backend login and sessions](docs/authentication.md) now supply cookie authentication endpoints. Authorization of existing manager routes and the web login gate remain pending UI-C3; creating an owner or logging in does not yet secure the overall manager. No existing candidate data is migrated.

## What's new

- A candidate list with **Edit**, **Delete**, and **Active** actions.
- Separate history folder and prompt for each candidate. Candidates may share an installed Chrome extension ID. A prompt can be pasted or linked to a UTF-8 `.txt` or `.md` file.
- A guided configuration window with a history-folder test.
- One shared native host that registers the configured extension IDs and reads the active candidate from a central configuration file.
- `Ctrl+Shift+F` copies matching JD sections and the actual tab URL. Selecting a company adds its name and a best-effort, read-only saved-company lookup. Copying works regardless of the lookup result; no selection means no native lookup. See [hotkey behavior and review steps](docs/hotkey-clipboard.md).
- The separate **Check + Save Company** context-menu action captures an MHTML archive and takes text from `<div>` elements whose ID starts with `overview`, `div#company`, and `<article>` elements. The host saves the archive and builds a prompt from that text and the active candidate's template; the extension copies the returned prompt.
- The host matches the calling extension ID and popup candidate name, then checks whether that candidate is active.

One extension can be used for several candidates. The popup name, configured extension ID and active candidate govern legacy saving and the optional hotkey duplicate lookup. A lookup authorization failure is reported without blocking clipboard copying. Change the popup name when switching legacy candidates. The hotkey never changes the active candidate.

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
6. For legacy saving or optional duplicate lookup, click the extension icon, enter the same candidate name used in the manager, and select **Save name**. The **Check + Save Company** right-click action still requires this candidate to be active and can save MHTML. `Ctrl+Shift+F` only copies Company/JD/URL, or JD/URL when nothing is selected. It never saves MHTML or invokes a native save, and lookup failure never prevents copying.

You may close the manager after setting the active candidate. Chrome starts the native host when the extension sends a message; the management page does not need to remain open for a capture. Reopen it with `py -3 manager\app.py` to change settings.

## Legacy context-menu saved job files

The host creates a company folder in the active candidate's history folder. It writes:

| File | Purpose |
| --- | --- |
| `job_description.mhtml` | Captured page archive |
| `meta.json` | Company, page URL, candidate ID, and save timestamps |

The host uses the matching page text to build the prompt and returns it for clipboard copying. It does not write `job_description.txt` or `resume_prompt.txt`.

If a matching company folder already exists, the legacy context-menu action displays **Already saved** and stops. The hotkey still copies and displays the duplicate status. Folder existence does not prove that an application was submitted. Duplicate lookup does not create missing history directories.

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
