# Web Studio integration and verification

The subsequent [Phase 5 UI correction](web-studio-ui-correction.md) supersedes the
initial page organization described here: candidate assignments now live only in
Candidates, which also contains the profile editor; Home is an in-app landing page,
both libraries manage reusable records, and Resume Studio is a dark three-column
editor. The correction report includes actual synthetic Chrome captures.

UI-C3B adds the [manager authorization and login gate](manager-authorization.md)
without redesigning these pages. All APIs below now require a verified owner
cookie session; unsafe requests also retain the process-token CSRF and Origin
checks. Login, expiration, draft recovery and cross-tab behavior have automated
coverage. Real Chrome verification of this authentication integration is still
**NOT TESTED**; earlier captures do not verify the new gate.

Phase 5 adds Home, Candidates, Profile, Prompt Templates, Document Templates and
Resume Studio to the existing plain-JavaScript manager. The legacy candidate
dialog/actions remain in `manager/ui/app.js`. `studio-app.mjs` handles the new
pages; `studio-core.mjs` contains testable composition, profile-editing, rendering
input, filename and preview/download workflows. There is no framework or build.

## Persistence and APIs

`tracker_config/web_studio.py` coordinates the existing repositories; mutable
operations live behind repository validation, revisions and atomic replacement.
`tracker_config/prompts.py` shares the established legacy path resolver with the
native host. Capture retains its existing whitespace trimming and composition;
Studio reads complete file text without newline conversion, only when Copy is
requested. Both legacy storage modes remain file references. No import occurs.

| Method and path | Behavior |
| --- | --- |
| GET `/api/studio/state` | Registry/revision, prompt catalog/revision, available document metadata |
| GET `/api/studio/candidates/<id>/profile` | Existing profile/revision, or an empty unsaved draft with `exists:false` |
| PUT `/api/studio/candidates/<id>/profile` | Explicit validated profile save |
| GET `/api/studio/candidates/<id>/prompt` | Current assigned managed body/version, or live legacy file contents |
| POST `/api/studio/prompts` | Explicit creation with server-issued stable ID, version and timestamps |
| PUT `/api/studio/prompts/<id>` | Edit/archive; preserve unknown metadata, ID and creation time; increment version |
| POST/PUT `/api/studio/documents[/<id>]` | Explicit supported-layout configuration create/edit/archive with catalog revision |
| PUT `/api/studio/candidates/<id>/settings` | Only `assignedPromptTemplateId` / `preferredDocumentTemplateId` changes |

Writes require `{data, revision}` (null for an absent file), an authenticated owner
cookie, the process CSRF token, exact local Host and matching Origin. Revision
conflicts return HTTP 409;
the form retains edits and offers reload/discard. GET retains the existing local
Host check and now owner-session/Origin validation. No CORS changes, arbitrary
destination paths, registration calls or
new write routes for generated documents are introduced. The existing candidate
CRUD routes retain their existing registration behavior.

Profiles keep schema version 1, accept noncredential JSON extension fields, and
validate known fields. Editors clone the entire record and change only edited
properties; stable entry IDs and unexposed skills/certifications/highlights/custom
prompts survive. Custom Q&A uses optional `customAnswers.answers` records with
stable `id`, nonblank `question`, and complete text `answer`. Full name comes from
the candidate registry; edit it in Candidates. Missing profiles are created only
with Save. No verified data is inferred from prompts. Credential fields are
rejected; this is not a credential-management facility.

The managed catalog keeps its version-1 format. Duplicate creates an unsaved
draft and a new ID only on Save. Archive preserves all candidate references and
clears default status; an unavailable assignment is an error/warning, never an
implicit fallback. Catalog defaults do not assign candidates. Explicitly selecting
the legacy source clears the managed assignment. Switching the catalog default
increments versions for both changed records. Reads create no files.

Classic/Modern metadata comes from the shipped renderer defaults in memory.
Existing compatible catalog records may also describe those layouts. Unsupported
layouts/versions are not presented as usable. Candidate preference saves modify
only the authoritative registry; they do not manufacture document catalog records.
Per-resume selection/settings are temporary. The standalone access page recognizes
built-in preferences and displays unavailable-assignment warnings without blocking
valid legacy file access. It gains no manager dependency or filesystem writes.

Revisions protect individual files, not a group transaction. Server writes are
serialized within the manager process; another process can still change a catalog
after reference validation. Prompt composition rereads the current assignment and
catalog/file, and Refresh Studio rereads configuration/revisions. Existing atomic
write/backups/recovery behavior remains in the repositories. External catalog
changes do not automatically overwrite unsaved forms. Resolve conflicts explicitly.

## Resume workflow

Activate a candidate in Candidates, choose a session layout, enter the original JD, copy the assigned prompt, then
paste generated JSON. The original JD is never replaced with composed text.
The one supported explicit placeholder is `{{JOB_DESCRIPTION}}` (case-sensitive,
all occurrences); otherwise composition appends `Job Description:` and the
original JD. Stored prompt text is unchanged. Textarea edit handling retains raw
newlines in unchanged regions, including mixed CRLF/LF, and captures pasted plain
text before browser normalization. Existing newline style is used for typed
line breaks. Answers use the same handling. No legacy prompts are rewritten.

The existing shared validator accepts only the six-field content contract, with
its documented raw JSON/single code-block parsing. All experience/education
associations must be selected explicitly by stable profile-entry ID. No matching
by employer text or array position occurs. A saved structured profile is required
before preview; missing profile fields are not fabricated. `Unknown` is valid.

Supported settings now include tested header styling, text color, line height,
section visibility and the original body/margin/spacing/accent/page-number controls.
See [pdf-renderer.md](pdf-renderer.md). The shared builder/renderer
validate them again. The same `extension/shared/resume-renderer.mjs` and local
pdfmake 0.3.11/Roboto assets produce the PDF Blob; there is no copied renderer.
An import map maps the modules' repository-relative extension imports to the
existing exact `/shared/…` and `/studio/contracts.mjs` allowlist. The manager adds
only exact read-only paths for its two Studio modules and two synthetic SVG
thumbnails. No shared allowlist, extension manifest or CSP relaxation is needed.
The current manager has no restrictive CSP requiring a new Blob allowance.

Preview uses an iframe with a Blob URL. Edits immediately disable download and
remove the old preview; valid input regenerates after a short debounce. Superseded
asynchronous results are ignored. URLs are revoked on replacement, navigation,
candidate switch and pagehide. Only the explicit Download PDF listener creates
and clicks a download anchor, using the current preview Blob URL. The filename
sanitizer removes path/control characters, handles Windows device names and bounds
length without splitting Unicode pairs. The JSON remains unchanged. Browser
download completion cannot be observed reliably from an anchor; the UI reports
that a download was requested and asks the user to check browser downloads.

No JD/resume/history/application files are persisted automatically. Navigating
away from Resume Studio warns before discarding its unsaved inputs. Profile and
template drafts warn before navigation/switching, and beforeunload warns on drafts.
The page intentionally does not implement cover-letter controls, AI generation,
bid-root saving, extension resume workspace or authentication. Document configuration
CRUD uses the two supported layouts; arbitrary layout creation remains unsupported.
The separate cover-letter contract/renderer remain for
a later integration.

## Automated checks

Python tests use the existing guarded synthetic-data fixture and temporary
configuration folders. Direct handler calls exercise authorization/routes without
starting a socket/server. Node tests exercise pure workflows and the actual page
orchestration through a small DOM/event adapter, plus real shared pdfmake bytes.
The adapter does not establish real browser behavior or visual quality.

Final automated result: **112 Python tests and 93 JavaScript tests pass**, retaining
the earlier 93/65 baseline. This adds 19 Python cases (including the new Node-suite
runner) and 28 JavaScript cases. Syntax checks pass for the three manager scripts,
`extension/studio.js`, `extension/studio/access.mjs` and
`extension/studio/contracts.mjs`. `git diff --check` passes; Git reports existing
LF-to-CRLF advisory warnings for previously modified tracked files.

```powershell
& 'C:\Users\Honey\AppData\Local\Programs\Python\Python313\python.exe' -B -m unittest discover -s tests -v
& 'C:\Program Files\nodejs\node.exe' --test tests/extension-access.test.mjs tests/resume-contract.test.mjs tests/pdf-renderer.test.mjs tests/web-studio.test.mjs
& 'C:\Program Files\nodejs\node.exe' --check manager/ui/app.js
& 'C:\Program Files\nodejs\node.exe' --check manager/ui/studio-app.mjs
& 'C:\Program Files\nodejs\node.exe' --check manager/ui/studio-core.mjs
git diff --check
```

## Phase 5 file inventory

Created:

- `manager/ui/studio-app.mjs`, `manager/ui/studio-core.mjs`.
- `manager/ui/classic.svg`, `manager/ui/modern.svg` (synthetic local thumbnails).
- `tracker_config/web_studio.py`, `tracker_config/prompts.py`.
- `tests/test_web_studio.py`, `tests/web-studio.test.mjs`.
- `docs/web-studio-verification.md`.

Modified, preserving previous-phase/user changes:

- `manager/app.py`, `manager/ui/app.js`, `manager/ui/index.html`, `manager/ui/styles.css`.
- `tracker_config/models.py`, `tracker_config/repositories.py`.
- `native-host/candidate_host.py` (shared path resolution; capture text/composition unchanged).
- `extension/studio.js`, `extension/studio/access.mjs`, `extension/studio/contracts.mjs`
  (profile contract and builtin/unavailable-reference compatibility only).
- `docs/configuration.md`, `tests/README.md`.

Vendor files, manifest, legacy extension background/popup/capture code, real
configuration and existing tests were not changed by Phase 5.

## Manual browser checklist — not performed

Use a separately authorized later browser-validation phase with a disposable
configuration and synthetic records. Do not mark these checks complete based on
unit tests or a PDF signature.

- [ ] Home shows the active candidate, real profile-presence indicators, prompt
  source, preferred layout and working shortcuts. No active candidate gives a
  useful create/select route. Check narrow screens, keyboard navigation and focus.
- [ ] Existing candidate create/edit/delete/activation works; IDs/unknown fields,
  history paths and extension IDs survive. Deleted profiles/history/linked prompts
  remain on disk according to existing cleanup rules.
- [ ] Profile empty draft creates no file until Save. Exercise repeatable career,
  education, online links and Q&A, birthday validation, Copy Address, multiline
  answers, unknown-field preservation and reload. Full name edits use Candidates.
- [ ] Unsaved forms warn on navigation, candidate switches and reload/close.
  A stale save returns 409 and retains edits; reconcile after explicit reload.
- [ ] Create/edit/duplicate/archive a managed prompt. Inspect full body, whitespace,
  mixed CRLF/LF, punctuation and paste behavior on disk. Duplicate is only a draft
  until Save; stable ID/version/timestamps behave as documented.
- [ ] Assign a managed template, archive it, and confirm an actionable warning
  without substitution. Explicitly restore legacy source. Capture still resolves
  the original legacy file even when a managed template is assigned.
- [ ] Linked and stored legacy prompt modes resolve live changes without importing
  or changing their files. Test missing/invalid files and clipboard denial.
- [ ] Classic/Modern synthetic thumbnails are readable and representative. Save a
  candidate preference, reload, and confirm persistence. Unsupported layouts are
  not offered. Temporary Resume Studio alternatives do not change preference.
- [ ] Follow the template-first workflow. Copy Prompt + JD with/without the exact
  placeholder; verify original JD and stored body remain separate and unchanged.
- [ ] Invalid JSON/type/missing-field/nested-entry errors identify fields; no old
  preview or active Download remains. `Unknown` company stays structurally valid.
- [ ] Valid JSON plus explicit profile bindings creates an actual PDF preview using
  the shared local assets. Missing/incorrect bindings block generation. Target
  company never appears as employment history. Test absent optional profile data.
- [ ] Inspect Classic/Modern, all settings, long multi-page output, page breaks,
  accented characters and typography against `pdf-renderer.md`.
- [ ] Loading, validation and preview never automatically download or save history.
  Only an explicit download action requests an actual PDF matching the preview.
- [ ] Inspect filenames for slashes, colons, control characters, reserved device
  names, long Unicode names, absent values and a malicious target-company string.
- [ ] Confirm browser download success, blocked/canceled downloads and readable
  failure messaging; the application must not claim completion from anchor click.
- [ ] Track Blob URLs during edits, rendering races, navigation, candidate switches
  and page close. Old URLs are revoked and stale output never returns.
- [ ] Check Host, Origin and session-token rejection, 409 conflicts, malformed
  catalog errors, unsupported routes and refusal of arbitrary filesystem paths.
- [ ] With manager closed, verify the existing standalone extension access page,
  stored handle/permission recovery, live prompt reads, builtin preferences and
  unavailable-assignment warnings. Follow `extension-access.md` as well.
- [ ] Verify legacy capture, context menu, shortcut, clipboard, archive/history and
  metadata flows with the registered host in the later authorized validation run.
- [ ] Cover-letter web controls are deferred; do not claim a web cover-letter PDF
  test passed. Its shared renderer has separate existing automated coverage.

No Chrome, manager, registration script, real candidate files or external history
folders were used during Phase 5 implementation/testing.
