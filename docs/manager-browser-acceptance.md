# UI-C3C-A: Authenticated manager browser acceptance

Status on October 28, 2026: **Manual verification pending.** No Chrome scenario
below is marked passed. Supported browser inventory returned no browsers; the
Windows computer-use provider failed once with native-pipe OS error 2. It was not
retried without remediation. No screenshots were captured in this checkpoint.

Current implementation is commit `1f59779` on `feat/manager-authorization`, already
pushed at the owner's earlier request. `9e8b031` is its parent, not current HEAD.
The authorization feature is committed; the fetch regression fix and these
acceptance notes remain uncommitted. Preserve `config/candidates.json` unstaged
and untouched. This procedure does not require production setup/startup,
native-host registration or a loaded extension.

## Reported running-manager result

The owner reported that Chrome at `http://127.0.0.1:53264/` now displays
Authentication unavailable and the server logs authentication requests. A direct
read-only GET of `/api/auth/status` confirmed `state: unavailable` and
`managerAuthorizationEnforced: true`; no session or candidate data was requested.
This confirms bootstrap transport reaches the server, not full browser acceptance.

Read-only local diagnostics found no `config/security.json` or security backup.
The parent `config/` directory fails the existing security-permissions validation:
its inherited ACL grants Modify access to additional principals, including
`CodexSandboxUsers`. `SecurityRepository` validates that parent before checking for
the missing owner file, so the status is unavailable rather than setup-required.
This was the fail-closed storage/setup blocker before UI-C3D/D2, not a fetch or
network failure. D2 replaces the default with validated private Known Folder
LocalAppData storage; see [private-owner-storage.md](private-owner-storage.md).
No production setup or Chrome login is implied by that implementation. Production
ACL review/provisioning still requires D4 approval.

No permissions, credentials, candidate records or application code were changed
during diagnosis. Do not whitelist sandbox principals, suppress validation, or
initialize a real owner as a workaround. Continue acceptance in the private
synthetic fixture below. Production credential storage/permissions and initial
owner creation require a separately reviewed, explicitly authorized action.

## Latest final regression review

The complete suites were rerun after reviewing the fetch correction: **223 Python
tests and 188 JavaScript tests pass**, including 30 real loopback HTTP tests.
Chrome inventory is still empty. No real Chrome scenario is accepted from those
test results, and no production owner was initialized.

The original `ManagerAuth.raw()` call used the controller as the receiver of
stored native fetch. The corrected call uses `fetcher.call(globalThis, ...)` for
default and injected transports. Synchronous execution/illegal-invocation errors
now show Browser request error; genuine rejected network requests retain the
disconnected state. Cookie credentials, CSRF headers, Origin/Host validation,
session checks and business authorization are preserved. The regression tests
enforce the receiver contract, and the Node-to-Python test confirms the actual
handler receives auth bootstrap before login and authorized Studio loading.

The 20-operation HTTP matrix rejects anonymous reads/writes before filesystem or
picker work. Public assets remain the original 17 exact GET resources plus
`/auth.mjs`; candidate/profile/security data is not static content. Expiration,
logout, reset/restart revocation and draft conflicts remain covered. No extension,
Native Messaging, shared renderer or configuration-model source differs from the
UI-C2B baseline. No new implementation change was required in this final review.

Run the same complete suites with:

```powershell
& 'C:\Users\Honey\AppData\Local\Programs\Python\Python313\python.exe' -B -m unittest discover -s tests -v
& 'C:\Program Files\nodejs\node.exe' --test --test-reporter=spec tests/extension-access.test.mjs tests/resume-contract.test.mjs tests/pdf-renderer.test.mjs tests/web-studio.test.mjs tests/hotkey.test.mjs tests/manager-auth.test.mjs
git diff --check
```

Git recommendation: retain the already-pushed authorization commit `1f59779`.
Use a separate `fix(auth): correct browser fetch invocation during bootstrap`
commit for `manager/ui/auth.mjs`, `manager/ui/app.js`,
`tests/manager-auth.test.mjs`, `tests/test_auth_http.py` and
`tests/web-studio.test.mjs`. The two acceptance documents can form a separate
`docs(auth): document manual browser acceptance` commit. Do not recreate a
baseline commit or rewrite the pushed feature commit. Nothing is staged or
committed by this procedure; exclude all candidate configuration/user data.

## Existing infrastructure and boundaries

- `tests/serve_web_studio_fixture.py` starts the real `TrackerHandler` plus real
  `AuthService` against a private `TemporaryDirectory`. Registry/profile/prompt
  fixtures come from `tests/fixtures/resume-data.json`; no real configuration is
  loaded. Native registration is replaced with a fixture-only no-op.
- `--owner-state ready` creates a synthetic owner using `SecurityRepository` and
  the actual password verifier. `missing` creates no owner; `corrupt` creates only
  malformed synthetic security data. These modes do not alter production files.
  Owner files live in a separate temporary `security/` directory, alongside
  temporary candidate `config/`, with injected Known Folder paths. Missing-state
  discovery creates no security directory and never uses production Local AppData.
- `tests/web-studio-browser-fixture.mjs` normally submits the public synthetic
  credentials through real login endpoints and prepares demonstration content.
  **Always use `?auth=manual` for this acceptance run.** It disables those scripted
  scenarios and automated login. Its hidden `ready` report means only the helper
  loaded; it is not proof of authentication or acceptance.
- `/__fixture/data` requires genuine owner authorization. There is no special
  fixture session or anonymous business-API bypass.
- `tests/capture-web-studio.mjs` is an older opt-in headless Chrome/CDP screenshot
  runner. It was inspected, not run here. Its existing captures do not establish
  acceptance of this authentication rollout.
- Unit/HTTP regression infrastructure remains in `test_auth.py`,
  `test_auth_http.py`, `test_manager_authorization.py`, `manager-auth.test.mjs` and
  `web-studio.test.mjs`. Their current 223-Python/188-JavaScript result is
  automated evidence, not a real-browser result from UI-C3C.

Do not run `manager/app.py`, the owner CLI without an isolated `--security-dir`, or
any registration command for these checks. In particular, do not execute the
production setup command displayed by the setup-required screen. Transition from
the missing-owner fixture to a separate ready fixture as described below.

## Exact startup and credentials

Use a dedicated Chrome test profile or Guest window; close unrelated manager tabs
in that profile. Cookies on `127.0.0.1` are not isolated by port. Run one fixture
at a time. Production uses fixed `127.0.0.1:8765`; this isolated fixture keeps its
ephemeral port. See [manager startup](manager-startup.md).

In PowerShell terminal A, from the repository root:

```powershell
Set-Location -LiteralPath 'C:\Users\Honey\Documents\dev\ApplicationTracker_v1.1'
$reviewPortFile = Join-Path ([IO.Path]::GetTempPath()) ('tracker-c3c-' + [guid]::NewGuid().ToString('N') + '.port')
Write-Output ('Port file: ' + $reviewPortFile)
& 'C:\Users\Honey\AppData\Local\Programs\Python\Python313\python.exe' -B tests/serve_web_studio_fixture.py --port-file $reviewPortFile --owner-state ready
```

Leave that terminal running. The script prints the actual local URL, for example
`Synthetic Studio fixture: http://127.0.0.1:<allocated-port>/`. The port is allocated
by the OS; do not substitute 8765. In terminal B, use the exact printed port-file
path:

```powershell
$reviewPort = [int](Get-Content -LiteralPath 'PASTE_THE_PRINTED_PORT_FILE_PATH')
$reviewOrigin = 'http://127.0.0.1:' + $reviewPort
Write-Output ($reviewOrigin + '/?auth=manual')
Write-Output ($reviewOrigin + '/extension-studio?auth=manual')
```

Open the first printed URL manually in Chrome. Synthetic login:

- Username: `synthetic-owner`
- Password: `Synthetic browser passphrase 123!`

These are public fixture credentials, not defaults for the real manager. The
fixture sets them up only inside its private temporary config. Login must still
perform backend password verification and issue a real cookie session.

Stop terminal A with Ctrl+C when finished. Its temporary candidate/security data
is discarded. Every restart creates a new owner identity and fresh records; do
not expect drafts from a previous fixture run to restore to that new owner.

For setup-required, run the same command with `--owner-state missing`, open the
new printed URL with `?auth=manual`, inspect, then stop it. Use `ready` in a new
run for login checks. `--owner-state corrupt` similarly exercises authentication
unavailable without damaging real records. No fixtures should run concurrently
in the same Chrome profile.

## Record each result

Record Chrome version, commit, viewport (desktop about 1650 × 900 plus one narrow
window), fixture mode and scenario outcome: PASS / FAIL / NOT TESTED. Record the
HTTP status and safe error code where relevant. Capture screenshots of login,
authenticated Home, PDF, suspended editor and reconciliation if possible. Do not
save cookies, passwords, CSRF headers, or an unredacted HAR as evidence.

All 18 scenarios below are currently **NOT TESTED in Chrome**.

| # | Action | Required result |
| --- | --- | --- |
| 1 | Start `missing`; open manual URL; inspect Network. | Setup-required screen, no candidate/profile content or business requests. Direct `/api/state` returns 503 `owner-setup-required`. No account created by the page. |
| 2 | Start fresh `ready`; sign in with fixture credentials. | Login POST succeeds, session GET verifies, then business requests load Home. No protected content flashes before verification. |
| 3 | Use the separate rate-limit procedure below. | Wrong password and unknown username give identical generic 401 messages. Attempt limit yields 429 with retry timing. |
| 4 | Navigate Home shortcuts after login; check keyboard and narrow layout. | Existing landing page and owner context are visible; shortcuts work; no activation/write occurs merely from login/navigation. |
| 5 | Open Candidates. | Synthetic Alex Example and its combined profile/defaults load. No real candidate information appears. Save is inactive when unchanged. |
| 6 | Change synthetic profile phone, Save, reload; repeat revision test below. | Explicit save persists; fresh revision loaded; stale save returns 409 without silently replacing another edit. |
| 7 | Create/edit/duplicate/archive a synthetic prompt; create a Classic/Modern document configuration with supported settings. | Explicit saves only; full multiline prompt text survives; IDs remain stable; library assignments are not changed implicitly. |
| 8 | Use the resume sample/bindings below, then malformed JSON. | Actual PDF previews after valid input; invalid latest input clears/disables stale output. No automatic download. Templates/settings change output. |
| 9 | Open Extension Studio; change a device label, Save, reload. | Real backend settings persist with revision; browser connection remains Not checked/unavailable unless a real extension responds. No fabricated Connected status. |
| 10 | Refresh authenticated page, with no dirty edits. | Status/session bootstrap recognizes the existing cookie and reloads authorized data; no password entry needed while session remains valid. Unsaved drafts are not reload-persistent. |
| 11 | Open the printed direct `/extension-studio?auth=manual` URL in a new tab, before and after login. | Same auth gate before login; Extension Studio loads after verification. No protected requests before verification. |
| 12 | Sign out; run the direct API check below. | Session revoked, sensitive DOM/form/list state cleared, PDF hidden/revoked; subsequent business GET is 401. |
| 13 | Leave a dirty profile/resume idle for at least 31 minutes, with no trusted input in any tab sharing that session. | Backend idle deadline expires; content is hidden, copy/download locked, PDF URL revoked. Next session/business check is 401. Do not substitute a client-only lock for this test. |
| 14 | Sign in again in the same running fixture after #13; exercise reconciliation below. | Same-owner authorized drafts restore in memory; changed revisions require review; no save is replayed. Removed/incompatible records do not receive another candidate's draft. |
| 15 | Two tabs in the same Chrome profile; dirty editor in B; sign out in A. | B suspends promptly via cross-tab hint or upon focus/session check; protected operations fail on the backend; stale PDF not downloadable. B's suspended draft stays hidden until genuine reauthentication. |
| 16 | Use disconnect procedures below. | Accurate disconnected/locked state, no anonymous fallback or false save claim. Same-process reconnect revalidates; new-owner restart does not restore old drafts. |
| 17 | From a logged-out tab/credential-free terminal, call `/api/state`, `/api/studio/state`, and `/__fixture/data`. | 401 with no candidate/profile data. Public source files must not be confused with public data access. |
| 18 | Exercise CSRF and Origin checks below, including controller error handling. | 403 protection error; UI locks when its controller receives it. Retry reboots CSRF/session validation, never silently replays the failed write. |

### Invalid credentials and rate limiting

Use a fresh ready fixture for this check so the five-minute global budget is known.
Submit ten total wrong attempts through the login form (include one unknown
username and one wrong password for the known owner). The first ten attempts
should receive the same generic 401 response. The eleventh receives 429 and
`Retry-After`; the UI disables Sign in during the reported wait. Wait that interval
before a valid login, or stop this disposable run and start a fresh ready fixture
for the rest of acceptance. Successful logins also consume the shared budget.

### Profile revision and draft reconciliation

For an ordinary stale-save check, open Candidates in tabs A and B; load the same
profile revision in both. Make different unsaved phone edits. Save A, then Save B.
B must receive 409 and retain its draft; the saved A value must remain authoritative.
Explicitly reload/discard or reconcile before saving again.

For expiration plus a changed saved revision, keep A's dirty editor open until
its real session expires. After expiration, use a separate Guest/Incognito context
to sign in to the same still-running fixture and change the same profile. Separate
cookie contexts prevent activity there from renewing A's session. Reauthenticate
A: inspect saved/draft values, choose Restore reviewed drafts or discard, and
verify no write happens until Save. Another change after review must require a
new review or fail the subsequent revision check. Do not use a new fixture process
for same-owner draft restoration; it has a new owner ID.

### Resume JSON and PDF

In Resume Studio, use a synthetic JD such as `Example Hiring Company seeks a
Systems Engineer to develop reliable test systems.` Paste:

```json
{
  "company": "Example Hiring Company",
  "title": "Systems Engineer",
  "summary": "Develops reliable systems with a multidisciplinary team.",
  "skills": [{"Engineering": ["Testing", "Design"]}],
  "experience": [{
    "title": "Engineer",
    "company": "Example Employer",
    "sentences": ["Improved a synthetic test system."]
  }],
  "education": [{"degree": "Bachelor of Example Studies"}]
}
```

Choose the explicit work binding for Example Employer (`work-one`) and education
binding for Example University (`education-one`). Inspect actual PDF text and
both supported layouts. For multi-page output, add many synthetic experience
sentences. Change font size/spacing and confirm visual changes. Delete a required
JSON property; the previous PDF must no longer be represented as current or
downloadable. Only click Download when intentionally testing an explicit download.

For cleanup, note the iframe's Blob URL in DevTools, then expire/logout. The frame
must lose its URL and Download must be disabled. Within that document, fetching
the remembered URL after revocation should fail. An already-open independent PDF
tab or a file already downloaded cannot be recalled by logout.

### Disconnect and late responses

First use Chrome DevTools Network **Offline** on the test tab while the same
fixture process stays running. Request a refresh/save: the UI must lock and retain
eligible drafts without claiming persistence. Return Online and click Retry;
authorization and current revisions must be reloaded, without replaying writes.
This verifies a real browser network failure, not an actual server crash.

Separately, stop terminal A and attempt a protected request in the open test tab.
Expect connection failure. Restarting this fixture uses a new random port and new
owner; open its new URL, login, and confirm it does not restore another owner's
drafts. **Same-owner reconnect after an actual server-process outage is not
reproducible with this throwaway fixture**, because shutdown discards its storage;
mark that subcase NOT TESTED pending an approved persistent synthetic fixture.

Use DevTools throttling to overlap an in-flight profile/state read with logout or
expiration, then let it complete. No late result may redisplay protected content.
Repeat while a long PDF is rendering: old completion must not reinstall its Blob
URL or enable Download. If no overlap can be demonstrated, mark this browser
subcase NOT TESTED; the existing deferred-promise unit tests are separate evidence.
Client abort/disconnect does not prove a write was rolled back: reload revisions.

### Direct API and request protection checks

With `$reviewOrigin` from terminal B, these requests contain no owner cookie:

```powershell
curl.exe --silent --show-error --include "$reviewOrigin/api/state"
curl.exe --silent --show-error --include "$reviewOrigin/api/studio/state"
curl.exe --silent --show-error --include "$reviewOrigin/__fixture/data"
curl.exe --silent --show-error --include -H 'Host: example.invalid' "$reviewOrigin/api/auth/status"
curl.exe --silent --show-error --include -H 'Origin: http://example.invalid' "$reviewOrigin/api/auth/status"
curl.exe --silent --show-error --include -H "Origin: $reviewOrigin" -H 'Content-Type: application/json' --data '{}' "$reviewOrigin/api/auth/logout"
```

Ready-fixture expectations: first three 401, last three 403. The last intentionally
omits CSRF; it must not log out the browser or execute business work. Missing-owner
business access instead returns setup-required 503. Do not copy a browser session
cookie into a terminal to make these requests pass.

For actual controller feedback, while authenticated in this synthetic page, use
DevTools Console (the process CSRF token is not an owner credential):

```javascript
const acceptanceAuth = (await import('/app.js')).authentication;
acceptanceAuth.csrf = 'deliberately-invalid-test-csrf';
await acceptanceAuth.api('/api/folders/check', {
  method: 'POST', body: {}
}).catch(error => console.log({authHandled: error.authHandled}));
```

Expect Request protection/locked UI and a 403 `invalid-csrf` response, before any
folder operation. Click Retry connection: bootstrap restores the real CSRF value
and verifies the cookie session, but does not retry that request. No cookie or
identity is fabricated by this test.

## Fixture limitations and acceptance gate

The fixture supplies one candidate/profile and managed prompt; it does not create
the legacy `templates/candidate-one.txt` reference. Candidate directory/profile
checks work with its managed prompt, but the legacy candidate configuration Edit
action can report that missing fixture file. Do not mark legacy configuration
editing as passed from this fixture or infer a production authentication defect.
Its existing synthetic CRUD tests remain automated-only evidence until a complete
legacy-prompt fixture is approved/provisioned for browser testing.

Extension runtime/native-host health, real clipboard/download permissions,
same-owner process-outage recovery, password-manager behavior, visual layout and
all 18 browser scenarios remain unaccepted without actual observations. Native
Messaging is not secured by the owner cookie. HTTP loopback cookies omit Secure
and are not port-isolated; remote-computer use is out of scope.

The latest final-review request authorizes the regression/security rerun even
while manual Chrome acceptance is pending. Return the manual results before final
UI-C3 sign-off or fixed-port/pairing work. No product code, test bypass, fixed
port, pairing or extension UI is introduced here. No Git staging/commit/push is
authorized by this procedure.
