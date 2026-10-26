# Regression and configuration tests

Run from the repository root with the available Python 3.13 interpreter:

```powershell
py -3 -B -m unittest discover -s tests -v
```

If Python is not on PATH, use the full path to an existing interpreter. For the
interpreter discovered in this environment:

```powershell
& 'C:\Users\Honey\AppData\Local\Programs\Python\Python313\python.exe' -B -m unittest discover -s tests -v
```

There are no dependencies to install. `-B` suppresses bytecode-cache files.

## Isolation and import safety

Source inspection confirmed `manager/app.py` and `native-host/candidate_host.py`
load definitions and initialize in-memory state at import time. They also add the
project root to the import search path if needed for the shared local package.
Importing these modules never loads candidate configuration. Their operational
entry points are guarded by `if __name__ == "__main__"`.

The reusable `IsolatedApplicationTestCase` imports fresh application modules,
immediately redirects every application data path to its own `TemporaryDirectory`,
and uses invented candidates and extension
IDs. History folders and linked prompts outside the synthetic `config/` still
remain inside that temporary root. No fixture reads the real `config/` or any
configured external candidate path.

Native-host registration is mocked. Additional guards reject subprocess creation,
browser opening, HTTP server startup, and import-time `Path.open` file I/O. The
registration module is never imported or executed. Cleanup restores mocks and
removes only test-owned temporary directories. Module imports also suppress caches
beside production source files.

Active selection is tested by invoking the existing request-handler method with
mocked request parsing, authorization, and response methods. No handler constructor,
network socket, application server, or Chrome workflow is used.

## Coverage

- Registry schema and active-reference round trips, Unicode serialization,
  missing-file behavior, malformed JSON, and unsupported schema versions.
- Creation normalization, stable IDs on edit, name/extension validation,
  casefold-based duplicate checks, shared extension IDs, and unique history paths.
- Pasted-prompt storage, configured linked-file resolution and rereading, prompt
  path/type/content validation, and template-directory traversal rejection.
- Active selection, invalid selection, deletion clearing, inactive deletion, and
  preservation of history contents and linked prompt files.
- Host caller origins, case-insensitive candidate routing, active-candidate gates,
  mismatched callers, and ambiguous candidate matches.
- Company-name normalization and directory matching, prompt composition, HTTP
  error mapping, and original-registry preservation on failed atomic replacement.

## Phase 2 coverage

`test_configuration.py` adds version-1 legacy round trips, preservation of nested
unknown candidate fields, explicit managed-reference checks, structured profile
and catalog validation, exact prompt-body preservation, identity migration,
revision conflicts, failed writes, validated backups, explicit recovery, and
native-host function compatibility with synthetic archive bytes. The original
29 characterization tests remain in `test_regression.py`.

See [configuration.md](../docs/configuration.md) for the record contracts,
persistence/recovery behavior, and unresolved synchronization choices.

## Phase 3 extension access coverage

The original 61 cases remain intact. `test_extension_access.py` runs the Node.js
access-service tests and compares synthetic browser/Python contract fixtures,
including Unicode candidate-name equivalence classes. Node is discovered from
PATH or its existing Windows installation; it is never installed by the suite.
If unavailable, those two cases explicitly skip.

The Node cases use in-memory file/directory handles and an IndexedDB transaction
fake. They cover grants, renewal, cancellation, safe replacement, live prompt
reads, bad/missing records, observed configuration changes, and storage failures.
They do not exercise Chrome or actual browser handle persistence.

Run those JavaScript tests separately with:

```powershell
& 'C:\Program Files\nodejs\node.exe' --test tests/extension-access.test.mjs
```

See [extension-access.md](../docs/extension-access.md) for syntax-check commands,
the confirmed legacy prompt-file contract, and the unverified Chrome checklist.

## Limits and existing gaps

The Phase 2 shared repository validates records on reads and writes and preserves
unknown registry/candidate fields during legacy edits. Remaining limits include:

- Atomic replacement protects one registry file. Pasted prompts are updated before
  the registry, so a later registry failure can leave prompt and registry revisions
  inconsistent. Flush/replacement failures and observed stale revisions are
  tested; power loss, actual disk exhaustion, and cross-process races are not.
- Linked-prompt validation differs: the manager enforces a size limit and wraps
  UTF-8 errors; the host has no equivalent size check and propagates decode errors.
- The active-route test bypasses HTTP parsing and request authorization; it is not
  coverage of the Host/Origin/session-token checks or a real HTTP integration test.
- Native-message framing, host dispatch, Windows registry integration, native-host
  installation, Tk file dialogs, JavaScript UI, Chrome capture, clipboard behavior,
  and the extension service-worker lifecycle remain untested.
- The native-host save function is tested with synthetic MHTML bytes in a temporary
  history directory. Real capture and the existing duplicate-check/overwrite race
  remain outside this suite.
- Phase 4A adds data contracts and Phase 4B adds the shared PDF engine described
  below. Resume generation, preview UI and export/save workflows remain deferred.

No dependency installation, startup, registration, commit, or push is required to
run these tests. Python 3.13 is the verified test interpreter for this phase.

## Phase 4A data-contract coverage

`test_resume_contract.py` adds 19 tests (including a Node-suite runner and
cross-runtime parity check), keeping the previous 63 Python tests unchanged.
`resume-contract.test.mjs` adds 15 JavaScript tests alongside the existing 31.
Only checked-in definitions and synthetic `fixtures/resume-data.json` are read;
Node subprocesses run in test-owned temporary directories. No live config or
prompt paths are opened. The Python module's import-time file access is blocked
in an explicit import-safety test.

Coverage includes required fields/types, nonblank strings, nested error paths,
strict JSON/code-block parsing, duplicate/nonfinite rejection, company folder
readiness, `Unknown`, empty-section warnings, separate job/cover-letter contracts,
and explicit profile joins and template-version checks for render input. The
parity test compares validity, issue paths/codes, warnings, company decisions and
render snapshots. It does not establish general JSON Schema conformance.

```powershell
& 'C:\Program Files\nodejs\node.exe' --test tests/extension-access.test.mjs tests/resume-contract.test.mjs
& 'C:\Program Files\nodejs\node.exe' --check extension/shared/data-contracts.mjs
& 'C:\Users\Honey\AppData\Local\Programs\Python\Python313\python.exe' -B -m unittest discover -s tests -v
git diff --check
```

The complete suite runs both JavaScript suites when Node is available. Contract
tests produce no PDF and do not test Chrome, HTTP serving, native registration or
the installed extension. See [resume-contract.md](../docs/resume-contract.md) and
[pdf-rendering-feasibility.md](../docs/pdf-rendering-feasibility.md) for boundaries,
the rendering recommendation and deferred dependency approval.

## Phase 4B PDF renderer coverage

`test_pdf_renderer.py` adds 11 Python cases for exact read-only resource routing,
containment/traversal, unsupported methods, existing authorization, shared settings,
and Node integration/parity. `pdf-renderer.test.mjs` adds 19 JavaScript cases.
The complete baseline is now **93 Python tests and 65 JavaScript tests**, retaining
all earlier tests unchanged. The Python suite invokes all three Node suites.

Only the approved official pdfmake 0.3.11 browser bundle and Roboto VFS are used.
No package manager or additional test/PDF dependency is installed. The tests check
real PDF Blobs, bytes, conversion, repeatability, page trees, Letter size, embedded
font markers, separate letters, settings and literal text. The unmodified vendor
scripts also run in a browser-global Node VM with string/Wasm code generation
disabled and network APIs blocked. These checks are not real Chrome CSP or visual
PDF QA. PDF documents remain in memory and no application save is invoked.

Static-route tests use temporary synthetic files and direct handler calls with
fake streams, keeping real Host/Origin/token checks without opening a socket.
Resolved path escapes are simulated; no privileged symlink setup is needed.

```powershell
& 'C:\Program Files\nodejs\node.exe' --test tests/extension-access.test.mjs tests/resume-contract.test.mjs tests/pdf-renderer.test.mjs
& 'C:\Users\Honey\AppData\Local\Programs\Python\Python313\python.exe' -B -m unittest discover -s tests -v
git diff --check
```

See [pdf-renderer.md](../docs/pdf-renderer.md) for APIs, settings, syntax commands,
limits and the unchecked manual checklist, and
[third-party-notices.md](../docs/third-party-notices.md) for provenance/hashes and
license handling. No Chrome/server/registration or live candidate access is run.

## Phase 5 Web Studio coverage

The combined result is **112 Python tests and 93 JavaScript tests passing**.

`test_web_studio.py` uses the existing guarded temporary fixture to test profile
creation/saves, unknown fields, Q&A, invalid records, revisions/write failures,
managed prompt edits/duplication/archival/defaults, exact body preservation,
assignments, live legacy fallback, builtin preferences, authorization and exact
UI resource routes. It also runs `web-studio.test.mjs` with Node's built-in runner.
The earlier suites/tests remain unchanged.

The new Node suite exercises composition and raw newline handling, profile edits,
reference availability, temporary overrides, shared validation/building/rendering,
real PDF bytes, safe filenames and preview/URL/download lifecycles. A small DOM
adapter exercises actual page event handlers and API requests without Chrome. It
does not verify browser layout, native PDF viewing, real clipboard/download policy,
import-map support or CSP. Extension API compatibility is tested with in-memory
files only. No new dependency, application startup or real candidate access occurs.

```powershell
& 'C:\Program Files\nodejs\node.exe' --test tests/extension-access.test.mjs tests/resume-contract.test.mjs tests/pdf-renderer.test.mjs tests/web-studio.test.mjs
& 'C:\Users\Honey\AppData\Local\Programs\Python\Python313\python.exe' -B -m unittest discover -s tests -v
git diff --check
```

See [web-studio-verification.md](../docs/web-studio-verification.md) for the API,
consistency limitations, scope and unchecked manual checklist.

## Phase 5 UI correction

The corrected combined suite passes **128 Python tests and 128 JavaScript tests**.

Additional cases exercise the actual Candidate Add/Edit handlers and moved
assignments, optional-catalog failures without breaking legacy editing, independent
document library CRUD/archival/revisions, active context changes, prompt resolution,
temporary overrides, sustained explicit bindings, new renderer settings and section
visibility, and preventing automatic PDF navigation when inline viewing is disabled.
The obsolete Resume Studio preference-save interaction was replaced with a stricter
assertion that it is absent and makes no write; relocated persistence is verified
through the actual Candidate form and Python routes. No prior capture, validator,
persistence or rendering assertions were removed.

Opt-in `serve_web_studio_fixture.py`, `web-studio-browser-fixture.mjs` and
`capture-web-studio.mjs` support Chrome verification with temporary synthetic records
and a separate browser profile. They are not part of ordinary unit-test discovery
and do not start the real manager or register the host. The capture helper uses
only Node/Chrome built-ins. Actual desktop, four-page PDF, responsive and library
captures are documented in [web-studio-ui-correction.md](../docs/web-studio-ui-correction.md).

The landing-page follow-up adds four interaction tests: all working tool launchers,
empty workspace routing without writes, the combined candidate/profile editor and
its existing configuration dialog, and candidate activation with unsaved-change
protection and the correct profile-save target. Existing profile tests now use
Candidates. Browser captures also cover desktop and narrow Home/Candidates layouts.

Six profile-form tests cover MM/DD/YYYY presentation and ISO round trips (including
existing basic/week-date values), impossible/leap dates, native picker synchronization,
invalid drafts across entry creation, Current/end-date behavior in both repeatable
sections, header add/remove actions and confirmation, placeholders and address copy.
No profile is saved automatically. Chrome captures include the actual calendar popup
and Career section, using synthetic data only. The opt-in capture runner accepts
unsaved-change dialogs only in its disposable test browser; app warnings remain intact.

## Web Extension Studio

`test_extension_studio.py` adds 11 isolated API/repository cases. The web JavaScript
suite adds 15 cases for setup URLs, the minimal diagnostic protocol, sender rejection,
timeouts, navigation, empty/loading/error states, scoped saves, revision failures,
stale responses, clipboard behavior and separate dirty drafts. No installed extension
or native registration is exercised. The existing four JavaScript-suite command
includes all new browser tests; Python discovery includes the new API test file.
See [extension-studio.md](../docs/extension-studio.md) for contracts and manual checks.

## Clipboard hotkey correction — Checkpoint B

`hotkey.test.mjs` adds 18 dependency-free cases executing actual background
listeners and injected selection/extraction/clipboard code with synthetic Chrome
and page objects. `test_hotkey.py` adds eight cases, including the Node runner,
read-only missing/existing history checks, unchanged registry/state checks,
permission/path errors, the native launcher's bytecode flag, and an independent
explicit legacy save into temporary storage. Registration is never executed.

Both hotkey modes are forbidden from generating MHTML or sending a native save.
The explicit legacy save test is intentionally separate and may create only its
own temporary archive/metadata. Existing tests are retained.

Run the full JavaScript suite with:

```powershell
& 'C:\Program Files\nodejs\node.exe' --test tests/extension-access.test.mjs tests/resume-contract.test.mjs tests/pdf-renderer.test.mjs tests/web-studio.test.mjs tests/hotkey.test.mjs
```

The standard Python discovery command includes all new Python cases and invokes
the hotkey Node suite. Real Chrome verification remains pending; the synthetic
manual page is `fixtures/hotkey-job.html`. See
[hotkey-clipboard.md](../docs/hotkey-clipboard.md) for behavior and review steps.

## UI-C1 owner storage and setup

`test_owner_security.py` adds 32 isolated cases using synthetic credentials and
private temporary directories. Coverage includes real 600,000-iteration PBKDF2,
strict schema/verifier parsing, duplicate/corrupt setup refusal, stable owner IDs,
explicit reset/recovery with new credentials, primary/backup revision conflicts,
failed writes, Windows DACL enforcement, hard-link/reparse rejection and concurrent
initialization in two actual Python processes. CLI tests inject getpass values;
they do not create a real owner or verify a live interactive terminal.

The complete verified UI-C1 baseline is **168 Python tests and 153 JavaScript
tests**, all passing on Python 3.13 and Node.js 24.22.0 on Windows.

Candidate/profile sentinel files cannot be opened during administration tests.
No manager server, registration, real candidate folder or browser is used.
The full Python discovery and JavaScript commands above retain all prior cases.
To run only security checks:

```powershell
& 'C:\Users\Honey\AppData\Local\Programs\Python\Python313\python.exe' -B -m unittest discover -s tests -p test_owner_security.py -v
```

See [owner-security.md](../docs/owner-security.md) for schema, safe synthetic
interactive commands, permissions and the UI-C2/UI-C3 authorization boundary.
