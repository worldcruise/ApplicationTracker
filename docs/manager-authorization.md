# UI-C3B: Manager owner authorization and web login

All 20 manager business operations require the existing UI-C2 owner session.
The setup/login screen and protected Studio ship together. No owner is created
on startup or by a web request. No candidate schema, registry record, native-host
protocol, extension UI or hotkey is changed by this checkpoint.

## Backend boundary

`TrackerHandler.check_business_request()` applies to every `/api/` request and
`/api` itself, including unknown routes and unsupported methods. The order is:

1. Validate critical headers, framing, exact loopback Host and request target.
2. Validate supplied Origin/Fetch Metadata; require exact Origin and the process
   `X-Tracker-Token` on unsafe methods.
3. Dispatch only the five exact authentication endpoints under their own guards.
4. Validate the HttpOnly owner cookie through `AuthService.session()` without
   renewing activity. Missing or expired sessions return 401; missing owner setup
   or unavailable/malformed security storage returns 503.
5. Resolve existing candidate-specific route targets through the registry.
6. Parse business data, validate records/revisions and execute existing logic.

The auth dispatcher performs steps 1–2 itself before its allowlisted handlers;
the business guard performs them before steps 4–6. The process token is CSRF
protection only. Bootstrap may disclose it; it never authenticates an owner.
No client-provided user ID, candidate name, extension ID or unknown registry field
confers access. The explicit single-owner policy grants the verified installation
owner access to candidates in this installation's registry. This is the boundary
to replace when multi-user ownership grants are implemented later.

### Protected business operations

All entries below require owner authentication. All POST/PUT/DELETE entries also
require Origin and CSRF validation. Reads reject an inappropriate supplied Origin.

| Method | Exact route pattern | Existing responsibility |
| --- | --- | --- |
| GET | `/api/state` | Legacy registry state and process CSRF token |
| GET | `/api/candidates/<id>/template` | Current legacy prompt body |
| POST | `/api/candidates` | Create candidate |
| PUT | `/api/candidates/<id>` | Edit candidate |
| DELETE | `/api/candidates/<id>` | Delete candidate configuration |
| POST | `/api/active` | Explicit legacy activation compatibility control |
| POST | `/api/folders/check` | Existing history-folder probe |
| POST | `/api/browse` | Existing local file/folder picker |
| GET | `/api/studio/state` | Registry, catalogs and Studio configuration |
| GET | `/api/studio/candidates/<id>/profile` | Structured profile or unsaved empty model |
| PUT | `/api/studio/candidates/<id>/profile` | Explicit revision-checked profile save |
| GET | `/api/studio/candidates/<id>/prompt` | Managed assignment or live legacy prompt |
| PUT | `/api/studio/candidates/<id>/settings` | Candidate template references |
| POST | `/api/studio/prompts` | Create managed prompt |
| PUT | `/api/studio/prompts/<id>` | Edit/archive managed prompt |
| POST | `/api/studio/documents` | Create supported document configuration |
| PUT | `/api/studio/documents/<id>` | Edit/archive document configuration |
| GET | `/api/studio/extension` | Workspace/device integration settings |
| PUT | `/api/studio/extension/preferences` | Workspace preferences |
| PUT | `/api/studio/extension/device` | Local device settings |

Candidate creation resolves no preexisting candidate. `/api/active` validates the
explicit payload ID inside the existing operation. ID-based reads/updates require
an existing registry record; repository checks still validate profile associations
and template references. Login never invokes activation. Folder probes and browse
dialogs retain existing authorized behavior, but cannot execute before login.

Trailing slashes do not alias supported routes. Business query strings use the
same guarded path; they do not bypass authentication. HEAD/OPTIONS/PATCH and other
unsupported API methods cannot fall through to static serving. Auth endpoints
continue rejecting URL parameters and unsupported methods. Duplicate critical
headers, transfer encoding, unsupported Expect handling, invalid lengths and
unexpected read bodies are rejected. Business JSON now also rejects duplicate
properties and nonfinite constants.

No server-side resume download or arbitrary file-serving endpoint exists.
Authorized data feeds the shared local renderer; explicit downloads remain
client-side. Existing approved path controls and filesystem operations are retained.
Business/auth JSON responses use `Cache-Control: no-store` and `nosniff`.

### Public exceptions

The five auth endpoints remain:

- GET `/api/auth/status`: availability and process CSRF bootstrap, no owner or
  candidate data. `managerAuthorizationEnforced` is true on the enforcing handler.
- POST `/api/auth/login`: credential verification; Origin/CSRF required.
- GET `/api/auth/session`: requires a valid owner session; no idle renewal.
- POST `/api/auth/activity`: requires owner session and Origin/CSRF; explicit renewal.
- POST `/api/auth/logout`: idempotent revocation/cookie clearing; Origin/CSRF required.

The original 17 exact static GET resources are preserved: `/`, `/extension-studio`,
`/styles.css`, `/app.js`, `/studio-app.mjs`, `/studio-core.mjs`,
`/extension-studio.mjs`, `/classic.svg`, `/modern.svg`, and the eight entries of
`SHARED_STATIC_FILES` (renderer/contracts/settings, their two JSON definitions,
the two approved pdfmake assets, and `/studio/contracts.mjs`). One exact public
module `/auth.mjs` is added for login bootstrap: 18 static resources total.
There is no directory serving, listing or wildcard exception. Path containment,
traversal rejection and shared-resource method checks remain. Static source and
initial HTML contain no owner/candidate records. `/config/` is never served.

## Frontend controller and session lifecycle

`manager/ui/auth.mjs` is the only authentication/request controller. `app.js`
delegates business requests to it. The initial HTML is closed (`data-auth` plus
hidden protected shell and inert controls) before module execution.

Startup requests `/api/auth/status`, then `/api/auth/session` when setup is ready.
Only a verified owner session allows `initializeStudio()` and `loadState()`.
Direct `/extension-studio` entry follows the same gate. Setup-required shows the
local administrative command; invalid security configuration shows unavailable.
Login uses the existing backend endpoints and verifies session status before
loading business data. Password input is cleared after submission.

Requests use same-origin credentials, no-store, and the CSRF token for writes.
The controller never reads, stores or broadcasts the HttpOnly session cookie.
401 locks the workspace; request-protection 403 locks with a reconnect message;
429 reports login retry timing; auth availability 503 and network failure show
distinct states. Ordinary business validation/permission errors remain visible
without inventing a new owner identity. Writes are never automatically replayed.

Local deadline timers lock conservatively; backend validation is authoritative.
Visible-page status checks every minute and focus checks never renew idle time.
Only trusted input/key/pointer activity in a visible, focused document may issue
throttled POST activity. There is no automatic activity heartbeat. Page restoration
revalidates before exposing protected content.

Cross-tab `BroadcastChannel` messages contain only `signed-in`/`signed-out` hints.
They are not authorization proof. Sign-out hints immediately suspend; backend
session checks determine subsequent access. All tabs are rechecked on focus, so
unsupported cross-tab transport does not grant access. Password reset/revocation
is detected by backend calls, deadline/status checks or focus revalidation.

## In-memory drafts and uncertain writes

Candidate configuration, profiles, prompt/document editors, Resume Studio and
Extension Studio expose suspend/resume/clear hooks. Suspension hides sensitive
content, aborts/invalidate request generations, closes candidate dialogs, disables
copy/download actions and revokes PDF Blob URLs. Drafts remain only in this page's
memory, bound to the verified owner ID and original candidate/record IDs.

Reauthentication reloads authoritative registry/profile/catalog/device revisions
and validates candidate access. Same-owner compatible drafts can be restored.
Changed revisions show saved values alongside the retained draft and require an
explicit reviewed restore or discard. Reviewed restore applies changed draft fields
to that fresh revision, preserving newer unedited/unknown fields and stable IDs;
it does not save anything. A revision changed after review requires a new review.
Removed candidate/template records cannot receive another record's draft. A new
verified owner clears all previous retained state. Revalidation failure stays locked.

Resume recovery restores JSON, JD, template, formatting overrides and explicit
profile bindings; it regenerates a new PDF after validation. There is no automatic
download or history write. Copy and download verify the session before proceeding.

Explicit logout confirms dirty drafts, clears protected client state, revokes the
backend session and returns to login. It waits for known pending writes. If server
logout cannot be confirmed, the workspace remains locked and Retry retries logout,
not workspace restoration. A write already accepted by the backend may complete
after a client abort/disconnect; neither an abort nor a lost response proves
rollback. Fresh revisions and explicit reconciliation handle that uncertainty.

No sensitive drafts are persisted to localStorage or IndexedDB. Closing/crashing
the page can lose unsaved drafts. Existing same-origin code and local OS access
remain trusted; this is not encryption against a compromised browser or OS.

## Automated verification

Verified on Python 3.13 and Node.js 24.22.0: **222 Python tests and 184 JavaScript
tests pass**. This retains all 217/153 baseline cases. New coverage is five real
HTTP test methods with a 20-operation allow/deny matrix, 20 controller tests and
11 page/component lifecycle tests. The existing 25 auth-service and 24 auth-HTTP
tests remain. Tests use synthetic owners/candidates, temporary private storage,
mocked registration and pickers; they never start the production manager.

```powershell
& 'C:\Users\Honey\AppData\Local\Programs\Python\Python313\python.exe' -B -m unittest discover -s tests -p test_manager_authorization.py -v
& 'C:\Users\Honey\AppData\Local\Programs\Python\Python313\python.exe' -B -m unittest discover -s tests -v
& 'C:\Program Files\nodejs\node.exe' --test --test-reporter=spec tests/extension-access.test.mjs tests/resume-contract.test.mjs tests/pdf-renderer.test.mjs tests/web-studio.test.mjs tests/hotkey.test.mjs tests/manager-auth.test.mjs
git diff --check
```

The matrix verifies no candidate lookup, folder probing, picker, registration or
business write runs anonymously. Test-owned file bytes remain unchanged for denied
operations. Authorized matrix writes affect temporary fixtures only. Existing
handler tests now use genuine isolated owner sessions rather than a security bypass.

## Manual browser verification — NOT TESTED

This checkpoint could not exercise Chrome: the computer-use native pipe was
unavailable (OS error 2), and the browser inventory was empty. DOM tests do not
prove cookie enforcement, actual cross-tab delivery, visual layout or PDF viewing.
Earlier screenshots predate this login change.

For a later manual check, run this opt-in disposable fixture in a terminal:

```powershell
$authReviewPortFile = Join-Path ([IO.Path]::GetTempPath()) ('tracker-auth-review-' + [guid]::NewGuid().ToString('N') + '.txt')
& 'C:\Users\Honey\AppData\Local\Programs\Python\Python313\python.exe' -B tests/serve_web_studio_fixture.py --port-file $authReviewPortFile --owner-state ready
```

Open the printed URL with `?auth=manual`. It creates a synthetic owner only in a
temporary directory: username `synthetic-owner`, password
`Synthetic browser passphrase 123!`. These are public test credentials, never
production defaults. Stop with Ctrl+C. `--owner-state missing` and `corrupt` can
exercise setup-required and authentication-unavailable without damaging real files.
Do not use the production manager or real profiles for these failure checks.

- [ ] Initial page shows only auth; no protected request/data before session proof.
- [ ] Setup/malformed states, generic invalid login, retry-limit and offline feedback.
- [ ] Cookie has HttpOnly, SameSite=Strict, Path=/api/; no token in JS/storage/URLs.
- [ ] Login preserves Home, Candidates/Profile, libraries, Resume and Extension Studio.
- [ ] Direct `/extension-studio` is gated and loads normally after login.
- [ ] Expiration/revocation hides dirty editors and PDFs; reauth restores only
  authorized same-owner drafts; conflicting revisions require reviewed action.
- [ ] Explicit dirty logout confirms, clears state and revokes access in other tabs.
- [ ] Offline logout stays locked; Retry does not restore the workspace.
- [ ] Focus, back/forward restoration and two-tab sign-in/out behave correctly.
- [ ] PDF URLs are revoked, stale downloads/copies disabled, no write replay occurs.
- [ ] Keyboard focus, password-manager behavior and narrow-window login layout.
- [ ] Standalone extension and legacy clipboard/context-menu behavior remain intact
  using isolated storage in a separately authorized Chrome verification run.

## Deferred boundaries

The launcher remains random-port loopback-only. Fixed `127.0.0.1:8765`, extension
pairing/binding and the two-tab extension workspace are separate checkpoints.
HTTP cookies intentionally omit Secure on this approved loopback MVP; cookies are
not isolated by port and local services/OS remain a trust boundary. See
[authentication.md](authentication.md). Multi-user candidate grants and remote
computer transport are not implemented. Owner login does not secure legacy Native
Messaging; its active-candidate checks remain compatibility behavior.
