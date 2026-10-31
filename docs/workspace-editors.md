# Extension Workspace editors (D5D)

The authenticated packaged extension page now provides Job Description, CV
(JSON), and optional Cover Letter editors. These extend the existing Workspace
tab; Settings retains its Personal Details and Custom Prompts placeholders for
D5E. The verified backend session still supplies the candidate header.

## Layout

```text
Application Tracker                 Candidate: [backend verified]
                                    Owner: [...] [Sign Out]
[ Workspace ] [ Settings ]
Drafts are kept on this page only; refresh or close may discard them.
+ Job Description ----------------+ CV (JSON) -------------------+
| Company [____________________]   | [Editable raw JSON]          |
| Job URL [____________________]   | Empty / Valid / Invalid      |
|                                 | Field-level validation errors|
| Original JD                     | [Validate] [Copy JSON]       |
| [                           ]   + Optional Cover Letter -------+
| [                           ]   | [Editable plain text]        |
| [Import / Review] [Copy JD]      | [Copy Cover Letter]          |
+---------------------------------+------------------------------+
```

Below 700px, sections stack as JD, CV, Cover Letter. The two tabs, visible labels,
keyboard focus styles and live copy/validation feedback remain. No profile,
candidate picker, generation, PDF, application or filesystem action is added.

## Explicit JD import

Import / Review opens an inline paste panel. The user pastes text; the extension
never reads the clipboard automatically. **Review Pasted Text** recognizes only
the actual hotkey format:

```text
Company: Example Company

Job URL: https://example.com/jobs/123

Job Description:
Original extracted JD
```

The other supported hotkey format omits Company and its following blank line.
Plain text becomes JD with blank metadata. Unsupported labels, malformed records
or multiple concatenated hotkey records are classified as ambiguous: the entire
source stays visible as JD for review. Nothing is silently dropped or inferred.
An empty extracted JD or unusable URL is reported without fabricating text or
opening the URL. URL fields are text, not navigation controls.

The source stays visible while editable Company, URL and JD review fields show
the proposed result. **Apply Import** changes only the current page's three JD
fields. If any existing nonempty value would be replaced or cleared, the user
must explicitly acknowledge replacement; changing the source, review or current
values resets that consent. **Cancel** leaves current edits unchanged. CV and
Cover Letter are independent of import.

**Copy JD** invokes Clipboard.writeText only from a user click, with the live JD
textarea value. It appends no labels, metadata or prompts. Permission denial and
unavailable clipboard access show an error with manual copy guidance. Empty
editors disable copy. Copy completion after a lock or newer edit cannot report
stale success.

## CV validation and Cover Letter

The CV editor preserves raw text, including invalid JSON. It uses the existing
`extension/shared/data-contracts.mjs` strict resume parser and packaged schema:
`company`, `title`, `summary`, `skills`, `experience`, `education`. There is no
new schema, code-fence stripping, tagged-content conversion or silent repair.
`Unknown` remains valid for company. Syntax/duplicate-property and semantic
errors use the shared validator's field paths. Validation updates while editing;
the explicit Validate action can retry a failed packaged schema load.

States are Empty, Valid, Invalid and Validation unavailable. A schema load
failure preserves raw text and does not disable JD or Cover Letter. **Copy JSON**
copies the exact raw editor text, even if invalid; it creates no file.

Cover Letter is optional plain text. Its editor and exact copy action require
neither valid CV JSON nor JD, job metadata, jobId or recipient details. The
existing structured cover-letter contract is unchanged. No PDF or generation
workflow is added.

## Draft lifecycle

Company, URL, JD, raw CV JSON and Cover Letter exist only in the authenticated
page's private model memory. Tab changes preserve them. Refresh/close creates a
fresh empty editor. No draft is written to chrome.storage, page localStorage,
IndexedDB, the backend or candidate documents.

The existing authenticated controller alone activates the model after backend
verification. The retained scope includes owner, backend, workspace,
installation, binding ID, candidate ID, binding revision and extension origin.

- Expiration, reconnect verification and backend unavailability immediately hide
  protected panels, disable editing/copying and clear DOM-facing field values.
  Compatible core drafts can remain in private page memory.
- Only fresh backend verification of the exact same scope restores those drafts.
  Stored claimed identity alone never restores a draft.
- Logout clears drafts before awaiting server revocation, including offline
  logout. Confirmed revocation or reassignment discards old drafts. A different
  verified scope always starts empty.
- Cross-page session/installation-change notifications conservatively discard
  drafts, since the event may represent logout or a changed context.
- An un-applied import review and copy notices are discarded on suspension.
- Late schema loads cannot restore cleared drafts; late clipboard completions
  cannot reveal another scope's state. Existing auth generation checks continue
  to reject stale session responses.

No auth endpoint, cookie, bearer handling, session deadline, installation binding,
activeCandidateId, hotkey or Native Messaging behavior changes in D5D. The two
editor modules have no backend mutation, filesystem or storage interface.

## Automated verification and deferred acceptance

`tests/workspace-editor.test.mjs` exercises the real model and DOM/controller
integration using synthetic validated contexts, text and browser APIs. Coverage
includes import/overwrite confirmation, exact clipboard calls and rejection,
shared strict CV validation, schema failures, tab retention, expired/offline
locking, same-scope restoration, logout and reassignment isolation. Receiver-
sensitive clipboard mocks catch detached native-method invocation. Existing
authentication, pairing, launcher, hotkey and Native Messaging tests remain.

Verified D5D result: **389 Python tests and 343 JavaScript tests pass**, including
all 41 new editor tests, with zero failures or skips. JavaScript syntax checks
and `git diff --check` also pass. Python includes the existing real isolated
loopback HTTP integration tests; editor browser APIs use synthetic fixtures.

```powershell
& 'C:\Program Files\nodejs\node.exe' --test tests/workspace-editor.test.mjs
& 'C:\Program Files\nodejs\node.exe' --test tests/*.test.mjs
& 'C:\Users\Honey\AppData\Local\Programs\Python\Python313\python.exe' -B -m unittest discover -s tests -v
git diff --check
```

Real Chrome acceptance is **DEFERRED BY USER** until the full extension is built.
No browser, installed extension, production pairing, credentials or candidate
data is exercised in D5D. Wireframes describe implemented markup/CSS, not a
screenshot or proof of browser layout. Future acceptance can use the existing
opt-in synthetic fixture documented in [extension-workspace.md](extension-workspace.md).
No manual browser step is required for this checkpoint review.
