# Phase 5 UI correction

The correction reuses the existing manager, repositories, validators and shared
pdfmake renderer. No frontend framework, package installation, AI provider or
second PDF-generation engine was added. The original reference screenshot was
not available in the accessible conversation/attachment files, so the detailed
written requirements guided the layout. Exact pixel comparison remains pending.

## Responsibilities and state

- **Home** is now an in-app landing page: product introduction, primary Studio and
  candidate actions, a live active-workspace summary, four working tool launchers
  and a short workflow guide. Tool cards are defined together and use a responsive
  grid so future working tools can be added without replacing the page structure.
  No future feature is presented as connected, and no defaults are written on load.
- **Candidates** owns default AI prompt and preferred document assignments through
  the existing Add/Edit dialog. The existing candidate POST/PUT routes accept the
  two optional reference fields plus `registryRevision`. Validation occurs before
  history/probe/prompt writes. Revisions detect stale forms. Another candidate's
  assignments are retained. Existing archived assignments can remain unchanged;
  new invalid/archived references are rejected. A broken optional catalog disables
  assignment editing with a warning while preserving legacy candidate editing.
- **Prompt Templates** is a library: browse/view/edit/create/duplicate/archive.
  Archiving a referenced record prompts for confirmation and retains references.
  Bodies, raw newlines and stable IDs are preserved. No assignment form remains.
- **Document Templates** manages supported layout configurations: create, view,
  edit settings, duplicate and archive. Built-ins are read-only and can be copied.
  A new configuration receives a stable ID, `rendererVersion:1`, record `version`,
  timestamps and validated supported settings. Edits advance the record version,
  preserve unknown metadata, and use catalog revision checks. Archive retains
  candidate references and warns before changing referenced records. There is no
  hard deletion or invented layout engine. No assignment controls remain here.
- **Candidates also contains the structured profile editor**, beside the candidate
  directory on desktop and below it on small screens. The separate Profile
  navigation/page has been removed. Activate a candidate in the directory to load
  their profile; Edit configuration opens the existing dialog for identity, legacy
  capture and template assignments. Profile saves remain explicit and separate
  from configuration saves, with the existing revision checks and unknown-field
  preservation. Missing profiles remain drafts until Save profile is clicked.
- **Home/Candidates/Resume Studio** all use the registry's one active candidate.
  There are no independent profile selectors. Activation clears
  JD/JSON, prompt, overrides, bindings and old PDF before loading the new context.
  Existing profile and template draft warnings remain; no profile extraction occurs.

The existing `/api/studio/candidates/<id>/settings` endpoint remains compatible,
but the corrected UI assigns defaults only via candidate Add/Edit. Document CRUD
adds POST `/api/studio/documents` and PUT `/api/studio/documents/<id>` with the same
`{data, revision}`, Host, Origin, session-token and repository protections. Studio
state also returns the document catalog revision. No arbitrary client paths, broad
CORS or expanded shared-resource allowlist were introduced. Writes remain atomic
per file, not a transaction across registry/catalogs.

## Resume workspace and data flow

At 1650 × 900 the desktop grid is **254 / 1046 / 350 pixels**. The customization
and assistant sidebars scroll independently, and the main viewer stays 793 pixels
high with a 708-pixel PDF area. The left sidebar can collapse. At narrower widths
the layout uses a two-column viewer/customization area and then stacks the assistant;
phone widths stack the panels. No outer horizontal overflow was measured at
1650, 800 or 390 pixels. Mobile captures use desktop Chrome at narrow viewports,
not an Android/iOS device.

The left panel contains compact template illustrations, session-only selection,
and grouped typography, page, header and section controls. The right panel resolves
and displays the complete assigned prompt automatically, keeps JD separately,
copies the prompt plus JD, and offers an always-present JSON editor with validation
status, field errors and Copy JSON. No integrated AI generation is claimed.

Valid JSON is passed through the existing validator and `buildRenderInput` with
the active profile and explicit entry-ID associations. Previously chosen bindings
survive summary/sentence edits while the entry identity remains unchanged in its
position; different/reordered entries require review. No profile matching by name
or position is inferred. Debounced changes generate a new real PDF Blob. Invalid
or changed input immediately removes the stale viewer and disables download;
superseded asynchronous results cannot reappear. Blob URLs are revoked on
replacement, navigation, activation and pagehide. Original JSON is unchanged.

The center uses Chrome's native PDF viewer for centered white pages, scrolling,
page count/navigation and zoom, with the application's explicit Download PDF action
above it. It initially fits the page and closes the thumbnail side pane using
Chrome's [supported PDF open parameters](https://chromium.googlesource.com/chromium/src/+/HEAD/chrome/browser/resources/pdf/open_pdf_params_parser.ts).
There are no decorative duplicate page/zoom controls. Browser-provided PDF controls
may vary. If [`navigator.pdfViewerEnabled`](https://html.spec.whatwg.org/multipage/system-state.html#pdf-viewing-support)
is false, no PDF navigation occurs: the app explains that inline viewing is disabled
and retains only the explicit download action, preventing an external-viewer
preference from turning preview into an automatic download.

Only user download actions request files; no JD/resume/history/bid files are
persisted automatically. The application uses the same Blob for preview and its
download action, with the existing safe filename sanitizer. Browser download
completion/denial is not inferred from anchor click.

## Actual rendering settings

Roboto is the sole packaged font and is identified as such, without an inert font
selector. All 17 exposed settings are validated and affect the document definition:

- Body size, text color and accent color.
- Page margin, line-height multiplier, section spacing and page-number footer.
- Name size/color, headline size, contact size and header alignment.
- Section heading size and explicit visibility for summary, skills, experience
  and education.

See [pdf-renderer.md](pdf-renderer.md) for exact ranges. Configuration defaults and
session overrides stay separate; hiding a section never edits its stored JSON.
Candidate identity, profile joins and resume-content contracts remain unchanged.
No vendor assets, native protocol, extension workspace or real data were modified.

## Verification and captures

Automated coverage includes actual Candidate Add/Edit event handlers, independent
library CRUD, revision/invalid-reference rejection, archival/reference preservation,
active-candidate changes, prompt resolution, temporary layout changes, JSON editing,
real PDF bytes, every new setting, stale-download prevention and Blob cleanup.
The former Resume Studio "save preference" interaction test now asserts that
control is absent and selection performs no write; stronger Candidate-dialog and
repository tests cover the relocated persistence. Earlier validators, persistence
and capture assertions remain intact.

Commands:

Final results: **117 Python tests and 103 JavaScript tests pass**, with no remaining
failures. Syntax checks and `git diff --check` pass. Git emits LF/CRLF advisories
for previously modified files; no whitespace errors were reported.

```powershell
& 'C:\Users\Honey\AppData\Local\Programs\Python\Python313\python.exe' -B -m unittest discover -s tests -v
& 'C:\Program Files\nodejs\node.exe' --test tests/extension-access.test.mjs tests/resume-contract.test.mjs tests/pdf-renderer.test.mjs tests/web-studio.test.mjs
& 'C:\Program Files\nodejs\node.exe' --check manager/ui/app.js
& 'C:\Program Files\nodejs\node.exe' --check manager/ui/studio-app.mjs
& 'C:\Program Files\nodejs\node.exe' --check extension/shared/resume-renderer.mjs
git diff --check
```

For browser verification, `tests/serve_web_studio_fixture.py --port-file <temporary-path>`
starts an opt-in loopback fixture with temporary synthetic JSON records. It never
starts `manager.main`, opens real candidate files or registers a native host.
`tests/capture-web-studio.mjs <fixture-url> docs/screenshots` uses installed Chrome,
Node built-ins and a disposable browser profile; no package or installed extension
is added. Browser-generated PDFs are not downloaded during capture. The fixture
server is stopped after verification. Only synthetic screenshots/measurements remain.

The browser run used **Chrome 156.0.8078.47**. The initial CLI capture was blank in
the PDF area; a real-time DevTools capture waited for the native viewer and verified
the actual PDF. Captures show:

- [Desktop editor, 1650 × 900](screenshots/studio-desktop.png): dark shell, columns,
  centered actual PDF, toolbar, assigned prompt and JSON editor.
- [Four-page PDF](screenshots/studio-multipage.png): native 1/4 count and scrollable
  real document, without an HTML substitute.
- [800-pixel layout](screenshots/studio-responsive.png) and
  [390-pixel layout](screenshots/studio-mobile.png): responsive arrangements.
- [Document library](screenshots/template-library.png): independent library cards.
- [Measured results](screenshots/studio-browser-results.json): dimensions, valid
  JSON/Blob state and no remote HTTP requests during the captured application flow.

Still unverified: exact original-reference/pixel comparison, interactive zoom/page
navigation clicks in the native PDF toolbar, exhaustive page-break typography,
real clipboard permissions, browser download success/denial, other browsers and
mobile devices, and installed-extension/native capture. No cover-letter UI, AI
provider, arbitrary new layout engine or extension bid-folder workflow is connected
by this task. Those items were not represented as completed.

## Files

Application changes: `manager/ui/index.html`, `styles.css`, `app.js`,
`studio-app.mjs`, `classic.svg`, `modern.svg`; `manager/app.py`;
`tracker_config/models.py`, `repositories.py`, `web_studio.py`;
`extension/shared/document-layouts-v1.json`, `document-settings.mjs`,
`resume-renderer.mjs`; `extension/studio/contracts.mjs` (additive shared validation).

Tests/tools: `tests/test_web_studio.py`, `web-studio.test.mjs`,
`serve_web_studio_fixture.py`, `web-studio-browser-fixture.mjs`,
`capture-web-studio.mjs`. Documentation: this report, `pdf-renderer.md`,
`configuration.md`, `web-studio-verification.md`, `tests/README.md`, and synthetic
captures under `docs/screenshots/`. Existing user changes, including the modified
real candidate registry, were preserved.

## Combined Candidates workspace and landing-page follow-up

The user's later navigation decision supersedes the separate Home dashboard and
Profile page in the original design. This follow-up changes only manager UI,
synthetic UI tests/captures and documentation; no repository, API, schema, renderer,
extension or real candidate record changes were needed.

Current results: **117 Python tests and 107 JavaScript tests pass**, using the full
commands listed above. Four additional tests cover every landing-page tool link,
empty setup routing without writes, the combined profile/configuration interaction,
and candidate activation with dirty-edit rejection and correct profile save target.
Existing profile persistence and stale-save tests now exercise Candidates instead
of the removed page. Canceling activation also restores the visible radio state.
JavaScript syntax checks and `git diff --check` pass.

Synthetic Chrome captures were refreshed at 1650 × 900 and 390 × 900, with the
existing 800-pixel Studio, actual PDF, four-page PDF and template-library checks
also repeated. No outer horizontal overflow or remote application requests were
measured. The native PDF preview still produced a real Blob. Screenshots reviewed:

- [Home landing page](screenshots/home-desktop.png) and [narrow Home](screenshots/home-mobile.png).
- [Combined Candidates/profile workspace](screenshots/candidates-desktop.png) and
  [narrow Candidates](screenshots/candidates-mobile.png).

This is desktop Chrome at narrow widths, not mobile-device verification. Browser
clipboard/download permissions, installed extension/native capture and exact
comparison with the inaccessible original reference remain unverified. The
temporary synthetic fixture server was stopped after verification.

## Profile form organization follow-up

The profile form now uses named section cards, aligned field grids and nested
employment/education/link/answer cards. Contact and address fields have their own
group; university spans a row above degree/major. Most editable fields include
descriptive placeholders; placeholders never become stored values. Repeatable
sections put Add in the top-right header. Entry cards use accessible red × controls
at the top right. The candidate card uses the same red control while retaining its
existing deletion confirmation and cleanup behavior.

Birthdate shows **MM/DD/YYYY** in an editable text field beside a native calendar
control. The click handler calls the supported native `showPicker()` synchronously
from the user gesture; no date-picker dependency was added. Manual entry is checked
for real calendar dates before saving. Calendar choices and manual edits synchronize
with each other and save canonical ISO dates through the existing profile repository.
Existing accepted ISO calendar/basic/week values display correctly and are preserved
verbatim until that field is edited. Blank birthdates remain optional. The existing
shared ISO-date parser is exported for presentation reuse; validation rules and the
profile schema version have not changed.

For employment and education, Current immediately disables the corresponding End
date input and restores it when unchecked. Existing end-date text is retained;
disabling a field does not delete profile data. Employment/education dates keep
their existing free-text contract, which supports year/month-only values.

Current automated results: **117 Python tests and 113 JavaScript tests pass** using
the complete commands above. Six added cases exercise formatting/validation,
calendar synchronization, incomplete-date draft recovery, Current behavior, header
actions, placeholders and explicit address copying. All existing persistence,
native-host, extension-access and PDF tests remain. Syntax and whitespace checks pass.

Chrome 156 synthetic verification covers desktop/narrow Candidates, the Career
section with disabled end date, and an actual opened birthdate calendar. The runner
checks the date input's `:open` state after a trusted click and captures the popup:
[Calendar](screenshots/profile-calendar.png), [Career](screenshots/profile-career.png).
Existing Home, Resume Studio/PDF and library captures were also refreshed. Browser
checks do not write candidate/profile files; the Current toggle is an unsaved draft.
Native mobile date-picker behavior and exhaustive keyboard/screen-reader testing
remain manual checks. No real candidate data, prompt files, extension installation,
backend protocol or vendor assets were changed by this follow-up.

Changed source: `manager/ui/studio-app.mjs`, `studio-core.mjs`, `app.js`, `styles.css`,
and the additive export in `extension/studio/contracts.mjs`. Tests, fixture/capture
helpers, this report, `tests/README.md` and synthetic screenshots were updated too.
