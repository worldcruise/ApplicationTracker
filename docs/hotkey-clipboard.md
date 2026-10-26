# Clipboard hotkey — Checkpoint B

The existing `check-selected-company` command and suggested `Ctrl+Shift+F`
binding are retained. Reloading the extension loads the new implementation;
Chrome's shortcut settings may override the suggested binding.

## Output and behavior

Selected company:

```text
Company: Example Company

Job URL: https://example.com/jobs/123

Job Description:
Original extracted JD text
```

Without a selection, omit the Company section. The URL is the current tab URL
returned when the shortcut starts, including its query and fragment. Clipboard
content is plain text, with no generated prompt or Markdown link substitution.

The same JD extractor is used by the hotkey and the separate legacy context-menu
operation. It reads overview/company/article sections, limits individual sections
to 20,000 characters and the combined output to 40,000, and falls back to the main
frame if all-frame extraction fails. This is not a complete general-purpose job
parser. Every nonempty result reports that it may be incomplete. Empty extraction
or extraction failure leaves the JD field empty and warns that only available
information was copied. An unavailable tab URL is left empty with a warning.

Clipboard copying first uses the existing page-injected `navigator.clipboard`
helper, then its temporary-textarea fallback. If both fail, the notification says
copy failed. Temporary DOM elements are removed; no filesystem save is performed.

## Optional saved-company lookup

Only a nonempty selected company initiates lookup. The existing popup candidate
name and native `check_company` action are reused. The host still validates the
configured caller extension, candidate name and legacy active-candidate reference;
the hotkey does not activate or modify a candidate.

Copying proceeds without awaiting lookup. A successful copy is reported while
status is pending, and status recovery is limited to two seconds. Missing setup,
permission/candidate errors, host failures, malformed responses and timeout show
saved status as unavailable while retaining the successful copy. An existing
folder produces the existing **Already saved** feedback plus copy confirmation.
Folder existence does not establish that an application was submitted.

No-selection mode reads no candidate settings and sends no native message.

`candidate_root(..., create=False)` validates and resolves the same history path
without creating it. `check_company` uses this option; missing directories mean
not saved, while access errors and non-directory paths remain errors. Explicit
legacy saves retain the default directory-creation behavior. Both Python launcher
branches now use `-B` to prevent bytecode-cache writes during native lookup.

## Isolation from legacy saving

The keyboard listener calls `handleJobCopy`. The context-menu listener still calls
`handleCompanySave`, retaining its MHTML, native `save_application`, duplicate-stop
and returned-prompt clipboard behavior. The hotkey never falls back to this route.
No application record, archive, history directory or candidate state is written
by either hotkey mode. Native registration is not invoked.

The popup and file-access UI are unchanged. The desired login screen and two-tab
extension workspace are absent from this checkout and remain a separate unresolved
UI requirement: Tab 1 JD/Copy, CV JSON and optional cover letter; Tab 2 personal
details and custom prompts. This checkpoint does not reconstruct that interface.

## Automated verification

`tests/hotkey.test.mjs` executes the actual background listeners and injected
selection, extraction and clipboard functions inside Node VM contexts. Synthetic
Chrome APIs, page DOM, native responses and a controlled lookup clock cover both
modes, saved/unavailable status, timeout, missing/partial JD, URL integrity,
clipboard fallback/failure, and independent legacy context-menu behavior. Assertions
reject hotkey MHTML generation, storage writes and native save actions.

`tests/test_hotkey.py` exercises the actual native lookup and explicit legacy save
functions with temporary registries, history roots, prompts and archive bytes.
Write guards and before/after comparisons check directory and registry isolation.
An explicit legacy-save test is allowed to write only within its temporary root.
Python discovery also runs the new Node suite. These are not installed-extension,
Windows Native Messaging, browser clipboard-permission or visual Chrome tests.

```powershell
& 'C:\Users\Honey\AppData\Local\Programs\Python\Python313\python.exe' -B -m unittest discover -s tests -v
& 'C:\Program Files\nodejs\node.exe' --test tests/extension-access.test.mjs tests/resume-contract.test.mjs tests/pdf-renderer.test.mjs tests/web-studio.test.mjs tests/hotkey.test.mjs
git diff --check
```

## Real Chrome functional review — pending Checkpoint C

Checkpoint B results: **136 Python tests and 153 JavaScript tests passed**, with
no failures or skips. `node --check extension/background.js` and
`git diff --check` also passed. The eight new Python cases include a runner for
the 18 new JavaScript hotkey cases; these counts are not independent browser tests.

No manager startup, Chrome launch, native registration or real candidate/history
operation was performed for this checkpoint. Browser clipboard policy and native
launch behavior still require functional review.

1. Reload the updated unpacked extension in Chrome; keep its existing installed ID.
   Confirm `check-selected-company` is assigned in `chrome://extensions/shortcuts`.
2. Optionally serve only the synthetic fixtures, from the repository root:
   `py -3 -B -m http.server 8766 --bind 127.0.0.1 --directory tests/fixtures`.
   Open `http://127.0.0.1:8766/hotkey-job.html`. This is an optional manual fixture
   server, separate from the application manager; it was not started here.
3. Select **Example Company**, press the shortcut, and paste into a scratch editor.
   Verify Company, actual local URL, and the synthetic article text, without prompt
   instructions. Native lookup may report unavailable; copying must still succeed.
4. Clear selection and repeat. Verify JD/URL without a Company section. This mode
   must work with the native host unavailable and the manager closed.
5. In an isolated synthetic native-host setup, repeat selected-company lookup with
   a pre-existing company folder, missing history root, incorrect candidate and
   unavailable host. Never run the explicit save action against real candidate data.
6. Use a page without matching sections (the fixture server's directory index is
   sufficient) and verify an empty JD plus a visible extraction warning.
7. Verify clipboard fallback/denial feedback in a controlled browser setup. A copied
   notification must never appear when both clipboard methods fail.
8. Compare isolated registry bytes and history contents before/after hotkeys. Check
   missing history roots remain absent. Inspect the native service-worker traffic
   for `check_company` only; no `save_application` or `pageCapture` should occur.
9. Test the separate legacy context-menu archive action only in isolated synthetic
   storage, verifying its existing save and prompt-copy behavior remains independent.

Checkpoint C's [verification review](hotkey-verification.md) records the current
automation blockers, repeated regression results, exact automated clipboard strings
and detailed isolated manual steps. Live Chrome checks remain pending; no browser
success is inferred from automated tests.
