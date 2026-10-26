# Checkpoint C — hotkey verification review

Review date: **2026-10-26**, America/New_York.

**Acceptance is pending real Chrome verification.** No Chrome session was
controlled, no installed extension was reloaded, and no live clipboard contents
or extension screenshot were obtained. Application code and UI are unchanged.

## VERIFIED — environment and regression execution

- Computer-use JavaScript initialization now succeeds. The earlier kernel-assets
  `os error 3` did not recur; no configuration repair was made or claimed.
- Browser inventory returned `apps: [], browsers: []`.
- Opening the Chrome provider returned `Browser is not available: chrome`.
- The Windows computer-use helper returned `failed to connect native pipe: The
  system cannot find the file specified (os error 2)`.
- Installed Chrome executable metadata reports **156.0.8078.47**. This verifies an
  executable is present, not that a browser session or extension is healthy.
- Node **24.22.0** ran all **153 JavaScript tests**, with zero failures/skips.
- Python **3.13** ran all **136 Python tests**, with zero failures/skips, using
  approved interpreter access. Test fixtures use temporary synthetic storage.
- JavaScript syntax checking and `git diff --check` passed.

No browser provider or native helper is connected to this session. Changing the
application manifest, CSP, candidate settings or native registration would not
repair that automation connection. No such changes were made. The helper itself
was not searched for, replaced, installed or launched through an undocumented API.

Commands executed:

```powershell
& 'C:\Users\Honey\AppData\Local\Programs\Python\Python313\python.exe' -B -m unittest discover -s tests -v
& 'C:\Program Files\nodejs\node.exe' --test tests/extension-access.test.mjs tests/resume-contract.test.mjs tests/pdf-renderer.test.mjs tests/web-studio.test.mjs tests/hotkey.test.mjs
& 'C:\Program Files\nodejs\node.exe' --check extension/background.js
git diff --check
```

## AUTOMATED-ONLY — behavior evidence

| Requirement | Evidence | Live Chrome result |
| --- | --- | --- |
| Extension loads | Manifest parsing and background execution in a Node VM pass | NOT TESTED |
| Ctrl+Shift+F registered | Manifest command ID and suggested binding asserted unchanged | NOT TESTED |
| Company-selected output | Exact Company/URL/JD string asserted | NOT TESTED |
| No-selection output | Exact URL/JD string; zero native calls/settings reads | NOT TESTED |
| Lookup never blocks copying | Saved/error/malformed/pending/timeout cases pass | NOT TESTED |
| No lookup directory creation | Actual Python lookup, missing nested roots and write guards pass | NOT TESTED |
| Missing/partial JD | Empty output, failure, section cap and main-frame fallback cases pass | NOT TESTED |
| Unavailable native host | Simulated transport rejection still copies | NOT TESTED |
| Clipboard fallback/failure | Actual injected helper with synthetic clipboard/DOM passes | NOT TESTED |
| No hotkey saves/state changes | Guards reject MHTML/save actions/storage writes; actual Python state/registry comparisons pass | NOT TESTED |

Legacy context-menu saves, standalone extension file access, and web Studio
remain covered by their existing automated suites. Their live browser behavior
was not reverified. The explicit legacy-save regression writes archive bytes only
inside its test-owned temporary directory.

Exact strings asserted by the Node hotkey tests (LF line endings, no final newline):

Mode A:

```text
Company: Example Company

Job URL: https://example.test/jobs/123?source=test#details

Job Description:
Overview:
Original synthetic JD.
No generated prompt instructions.
```

Mode B:

```text
Job URL: https://example.test/jobs/123?source=test#details

Job Description:
Overview:
Original synthetic JD.
No generated prompt instructions.
```

These are automated assertions, not observed Chrome clipboard contents.

## NOT TESTED — manual Chrome procedure

Use a disposable Chrome profile. Do not alter the normal profile's extension
settings, candidate registry, history roots or native-host registration. Initially
leave the test extension's legacy candidate name empty: both clipboard modes can
then be reviewed without opening candidate configuration through Native Messaging.

1. Open `chrome://extensions`, load/reload this checkout's unpacked `extension/`
   directory in the test profile, and confirm **Application Tracker 0.5.0** is
   enabled with no load errors. Record its extension ID and any worker errors.
2. Open `chrome://extensions/shortcuts`. Confirm the copy command is assigned
   **Ctrl+Shift+F**. Record an existing conflict rather than silently changing the
   normal profile's shortcut. The manifest's suggested binding is not proof of
   the installed binding.
3. From the repository root, serve only the existing synthetic fixtures:

   ```powershell
   & 'C:\Users\Honey\AppData\Local\Programs\Python\Python313\python.exe' -B -m http.server 8766 --bind 127.0.0.1 --directory tests/fixtures
   ```

   Open `http://127.0.0.1:8766/hotkey-job.html`. This fixture server does not start
   the application manager or expose `config/`.
4. Highlight exactly **Example Company**. Press Ctrl+Shift+F, then paste into a
   scratch editor. Confirm the Company line, exact current URL and original
   synthetic article text. With no popup candidate name, expect copying plus a
   saved-status-unavailable notice, and no native request.
5. Click a blank part of the fixture to clear selection. Repeat the shortcut and
   paste. Confirm the Company section is absent. Do not select text in the
   scratch editor and accidentally send the next shortcut to that window.
6. Expected JD text for this HTML fixture is:

   ```text
   Article:
   Synthetic Systems Engineer

   This is invented job-description text for an isolated clipboard review.

   Responsibilities include testing sample systems and documenting results.

   No real employer, candidate, application or prompt data is present.
   ```

   The URL line must be `Job URL: http://127.0.0.1:8766/hotkey-job.html`.
   The fixture uses an article, while the automated example above uses overview.
   Record actual pasted contents and notification text for both modes.
7. Open `http://127.0.0.1:8766/`, clear selection and repeat. The directory index
   has no matching JD sections. Verify the JD section is empty, the URL remains
   correct and a missing-JD warning appears. Nonempty extraction must disclose
   that matching sections may be incomplete; it must not claim a full-page parse.

### Native-host scenarios — additional isolation required

The registration script writes a fixed HKCU native-host key. A different Chrome
profile alone does not isolate that key. Use an existing isolated Windows test
account or VM for the following steps. If neither is available, leave them NOT
TESTED; never redirect the normal account's host registration or swap real config.

1. In that isolated environment, copy the current `extension/`, `native-host/`,
   and `tracker_config/` source directories to a temporary test tree, excluding
   real configuration, history and bytecode caches. Load its unpacked extension.
2. Prepare only synthetic configuration under the copied tree. Replace the two
   placeholders below with the test tree's absolute history path and this test
   extension's actual ID. Keep the history directory absent initially:

   ```json
   {
     "schemaVersion": 1,
     "activeCandidateId": "review-candidate",
     "candidates": [{
       "id": "review-candidate",
       "name": "Review Candidate",
       "historyFolder": "<absolute test history path>",
       "extensionId": "<test extension ID>",
       "promptTemplate": "templates/review.txt"
     }]
   }
   ```

   Create `config/templates/review.txt` with synthetic instructions. In the test
   popup save the name **Review Candidate**. These are setup writes, not hotkey
   operations; take filesystem/registry baselines after setup.
3. Before registering a host, run Mode A. Confirm the unavailable-host error never
   prevents clipboard copying. This requires an environment without a pre-existing
   native-host registration.
4. Only in the isolated account/VM and copied tree, run the existing registration
   command: `py -3 -B native-host/register_host.py`. Do not run it in the normal
   Windows account. Record the synthetic registry hash with
   `Get-FileHash -LiteralPath .\config\candidates.json -Algorithm SHA256`.
5. Run Mode A against the synthetic page. Verify the configured missing history
   path remains absent with `Test-Path -LiteralPath '<test history path>'` and
   that the registry hash is unchanged. Copying should succeed without a duplicate.
6. As explicit test preparation, create `<test history path>/Example Company`
   with a sentinel file. Record its contents/hash and the full history tree.
   Run Mode A again. Verify **Already saved** appears, clipboard copying still
   succeeds, and the directory tree, sentinel and registry remain unchanged.
7. Inspect the extension service worker using `chrome://extensions` → service
   worker Inspect. In its console, `chrome.commands.getAll().then(console.table)`
   reports the installed binding. Set breakpoints/logpoints at the actual
   `check_company`, `save_application` and `saveAsMHTML` calls in `background.js`.
   Mode A may reach `check_company` only; Mode B must reach none of them. Neither
   may reach `handleCompanySave`. Do not invoke the context-menu save action.

### Controlled clipboard fallback/failure

Run only on the synthetic page in the disposable profile. After one hotkey run,
open page DevTools and select the Application Tracker extension's isolated-world
execution context. Verify `chrome.runtime.id` matches the test extension. If that
context is unavailable, leave these checks NOT TESTED. Overriding the page's main
world is not proof that the extension's clipboard helper saw the failure.

In that isolated context, temporarily inject a denied primary clipboard method:

```javascript
globalThis.hotkeyReview = {
  writeText: navigator.clipboard.writeText,
  execCommand: document.execCommand,
  fallbackCalls: 0
};
navigator.clipboard.writeText = async () => { throw new Error("Synthetic clipboard denial"); };
document.execCommand = function (command, ...args) {
  if (command === "copy") hotkeyReview.fallbackCalls++;
  return hotkeyReview.execCommand.call(this, command, ...args);
};
```

Focus the fixture, press the hotkey, paste into the scratch editor, then inspect
`hotkeyReview.fallbackCalls`. A successful paste plus a positive count verifies
fallback in that browser context. If Chrome blocks it too, record failure.

Next set `document.execCommand = () => false` in the same isolated context and
repeat. Expect a copy-failed notification, no success claim and no save. Reload
the synthetic page to discard the temporary overrides. These are controlled
fault-injection checks, not proof of every natural browser permission condition.

## Acceptance and changes

No application failure or new application fix was established in this review.
Only this report and its link in `hotkey-clipboard.md` were added. No application
code, popup, candidate records, native registration or installed Chrome settings
were changed. No server or browser was launched and no commit/push occurred.

Checkpoint C is **not ready for full acceptance** until the real Chrome results
above are recorded. Stop here for user review; do not reconstruct the extension UI.
