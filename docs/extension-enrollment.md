# D5B2: secure pre-login extension enrollment transport

## Scope and trust boundary

Three explicit exceptions let the configured extension enroll before owner login.
They do not authorize access to business APIs or create an owner session. Existing
Web Studio cookie authentication, Host/Origin/CSRF policy and the original
20-operation authorization matrix remain unchanged. No login/workspace UI, Native
Messaging bridge, capture, candidate picker or filesystem saving is added.

Production client requests always target `http://127.0.0.1:8765`. No alternate
host/port, scan, redirect or network fallback is supported. The approved boundary
is trusted-laptop HTTP. UUID pinning prevents accidental identity replacement;
it does not cryptographically authenticate a server or defeat hostile local
processes capable of impersonating the backend/Origin.

## Backend identity and Origin policy

The saved extension ID in `config/local/extension-studio.json` is authoritative
for the exact allowed `chrome-extension://<id>` Origin. The request's actual
Origin header must match. Missing, `null`, unrelated or malformed origins are
rejected; a body extension ID/origin cannot establish authority. The Host must
be the actual loopback listener's `127.0.0.1:<port>` (8765 in production; isolated
HTTP fixtures deliberately use ephemeral ports).

Backend ID comes from the existing validated private owner repository. Workspace
ID is the existing explicitly saved device ID. No identities, owner credentials,
configuration defaults or directories are generated during discovery. Missing
workspace/owner storage returns `setup-required` when safe; unsafe/corrupt owner
or binding storage returns `unavailable`. If no valid extension ID is configured,
the server cannot establish a trusted Origin and rejects enrollment without CORS
access. Configure it in the authenticated Web Extension Studio first.

An enrollment request token is generated only in process memory, separately from
the manager's web CSRF token and owner sessions. It is scoped to the current
workspace/origin service instance and changes on restart/configuration change.
It is a request guard, not owner identity or an installation credential.

## Exact HTTP contracts

All responses are JSON with `Cache-Control: no-store` and `nosniff`. Enrollment
rejects Cookie/Authorization headers, query parameters, duplicate critical
headers, unsupported framing and unexpected request bodies. POST bodies are
UTF-8 JSON, maximum 8 KiB, with exact properties and no duplicate/non-finite
values. Existing private ACL checks are revalidated; no automatic recovery runs.

### GET /api/extension/bootstrap

No owner session. Actual configured extension Origin is mandatory.

```json
{
  "protocolVersion": 1,
  "state": "ready",
  "backendId": "existing-backend-id",
  "workspaceId": "existing-workspace-id",
  "requestToken": "process-local-enrollment-token"
}
```

Only those fields are returned: no username, owner ID, candidates, profiles or
prompts. Safe missing setup returns HTTP 200 with `state: "setup-required"`;
unavailable storage returns 503 with `state: "unavailable"`. Both use null IDs
and request token. Origin/Host failures return structured errors instead.

### POST /api/extension/pairings

Headers: exact Origin, `Content-Type: application/json`, `X-Tracker-Token` from
bootstrap and `X-Pairing-Exchange` containing a fresh canonical 32-byte base64url
secret. Body: `{"protocolVersion":1,"label":"Chrome Profile 1"}` only.

HTTP 201 returns `{pairingId, approvalCode, status:"pending", expiresAt}`. The
server keeps only the exchange-secret digest in process memory. Existing five-
minute monotonic expiry, creation rate limit and bounded pending storage apply.
No candidate is selected by this request. Backend owner scope is derived from
private installation state; it is not treated as an authenticated owner action.

### POST /api/extension/pairings/<pairingId>/claim

Same headers, with the ORIGINAL exchange secret; body `{}` only. Actual Origin
must match both current configuration and the original request. Owner approval
through Web Studio must already exist. A pending request returns HTTP 202
`{"status":"pending"}` without issuing anything.

Approved success returns HTTP 200:

```json
{
  "installationCredential": "one-time-32-byte-secret",
  "installationId": "installation-uuid",
  "bindingId": "same-installation-uuid",
  "bindingRevision": 1,
  "backendId": "existing-backend-id",
  "workspaceId": "existing-workspace-id"
}
```

There is one binding per installation, so `bindingId` reuses its existing ID.
No new competing identity or candidate information is returned. The private
credential digest and durable pairing ID commit together BEFORE response
delivery. Replays, denied requests, wrong secrets, wrong origins and expired
requests cannot issue credentials. A post-commit failure cannot issue again.

Errors use `{code,error}`: 400 invalid input/framing/credentials, 403 Origin/Host/
token/secret failure, 404 unknown pairing, 405 method, 409 consumed/denied,
410 expired, 429 rate/capacity and 503 unavailable setup/storage. A lost or
uncertain claim result must never be retried automatically.

## Scoped CORS and OPTIONS

Only these enrollment routes receive CORS responses. Allowed Origin is the
single configured extension origin, never `*`. No
`Access-Control-Allow-Credentials` is sent. The client always uses
`credentials: "omit"`, `mode: "cors"` and `redirect: "error"`.

OPTIONS is supported only for the two POST route shapes. It requires the exact
Origin, requested method POST and requested headers within this whitelist:
`Content-Type`, `X-Tracker-Token`, `X-Pairing-Exchange`. Other methods/headers and
deprecated Private Network Access preflight requests are rejected. No global
OPTIONS exception or CORS access to existing manager APIs is added. Unknown
API routes and malformed/trailing-slash aliases retain owner authorization.

## Single credential-delivery path

Only the new extension-origin claim endpoint delivers installation credentials
over HTTP. The old owner-authenticated POST `/api/studio/extension/pairings` and
POST `/api/studio/extension/pairings/<id>/claim` now return 410 after existing owner
and CSRF checks. Source inspection found no production UI consumer; tests now
enroll through the new transport. Owner listing, approval, denial, reassignment
and revocation remain unchanged and authenticated. The same D5B service/private
repository handles issuance; no duplicate state machine or credential store exists.

## Packaged client API

`extension/studio/enrollment.mjs` exports `EnrollmentClient` and reusable default
functions. Importing it does not contact the backend or modify storage.

| API | Behavior |
| --- | --- |
| `getBootstrap()` | Explicit read; validates protocol and compares confirmed identity |
| `confirmBackendIdentity({backendId,workspaceId})` | Explicit future-UI confirmation; refuses replacement of an existing different pin |
| `requestPairing(label)` | Requires confirmed identity; generates/stores a fresh exchange, then sends one request |
| `getPendingPairing()` | Returns sanitized code/state/expiry metadata; never the exchange secret |
| `claimPairing()` | Explicit one-shot attempt; pending 202 can be checked again only by another explicit call |
| `getInstallationCredential()` | Trusted-context read for the next authentication checkpoint; never a UI display API |
| `clearPendingEnrollment(options)` | Explicit cleanup; uncertain claims require acknowledgment of prior Web Studio revocation |

First-time identity is NEVER pinned by bootstrap automatically. The future UI
must display it, obtain confirmation and call `confirmBackendIdentity()` before
requesting pairing. Mismatches never overwrite prior identity/credentials.

Every operation first restricts local/session storage to `TRUSTED_CONTEXTS` and
checks the packaged extension context. Web Locks serialize mutations across
pages in the same profile; unavailable locks/storage fail closed. Native fetch,
Crypto, encoding, storage and lock methods retain their proper receivers.

`crypto.getRandomValues()` supplies exactly 32 exchange-secret bytes. Pending
secrets live only in trusted `chrome.storage.session`. Installation credential,
ID, binding revision and backend/workspace IDs persist in trusted
`chrome.storage.local`; confirmed identity and a NONSECRET recovery marker also
live there. No storage.sync, page localStorage, content-script messaging proxy,
secret URLs, logs or DOM attributes are used. Existing unrelated storage keys
are untouched. Local storage is not an encrypted credential vault; trusted OS
and extension code remain part of the boundary.

No timers, approval polling, automatic claim retries or automatic replacement
workflow are implemented. Existing credentials cannot be overwritten. Browser
restart/reload clears pending session data; it does not remove stored credentials
or a durable uncertain-claim marker. Ordinary Chrome profiles have independent
storage; incognito/cloned-profile independence is not promised.

## Uncertain claim and storage recovery

Before transmitting a claim, the client writes a nonsecret recovery marker to
local storage and marks the session exchange as claiming. Any lost, malformed,
failed or uncertain result blocks replay. After successful persistence and
readback, the pending exchange is removed. Failed credential persistence never
requests another credential or deletes a possibly successful local write.

1. Do not retry the original claim or overwrite local credential data.
2. If `getInstallationCredential()` confirms an already persisted installation,
   keep it; cleanup can be completed explicitly without another claim.
3. Otherwise, the owner opens Web Extension Studio and matches the **pairing
   request ID**, label and creation details. Installation cards expose that
   nonsecret pairing ID so recovery does not guess based only on the label.
4. Explicitly revoke the installation if present; deny/abandon a pending request.
5. Only after that manual review may future UI call
   `clearPendingEnrollment({acknowledgeRevocation:true})` and start a new exchange.

The acknowledgment is a user workflow confirmation, not proof of server-side
revocation. No reset/delete/migration of private security records is automated.

## Chrome 156 networking review

The existing manifest already grants `<all_urls>` for legacy capture, which
covers the fixed HTTP loopback URL. No broader host permission or new speculative
`localNetworkAccess` extension permission is added. Chrome documents host
permissions for cross-origin requests from extension pages/service workers;
content scripts retain web-origin restrictions. See [Chrome network requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests).

Modern Chrome gates applicable address-space crossings with Local Network Access
permissions (including loopback-network), rather than deprecated PNA response
headers. Do not disable security flags, depend on temporary opt-out policies in
Chrome 156, or add `Access-Control-Allow-Private-Network` as a workaround. See
[Chrome LNA guidance](https://developer.chrome.com/docs/modern-web-guidance/guides/security/local-network-access).
Use the future visible extension document and an explicit user action for first
contact; honor any browser/OS permission denial. No UI permission prompt is
implemented here. Actual Chrome 156 Origin, preflight and LNA behavior remains
NOT TESTED and must be checked before browser acceptance.

Storage restrictions use the documented [StorageArea API](https://developer.chrome.com/docs/extensions/reference/api/storage/StorageArea).
Current [Chromium storage utilities](https://raw.githubusercontent.com/chromium/chromium/main/extensions/browser/api/storage/storage_utils.cc)
store access levels in extension preferences. Restrictions are established
before the first credential write and reasserted on every client operation;
restart/reload enforcement still requires real Chrome verification.

## Automated verification

The pre-change baseline was rerun: 305 Python and 210 JavaScript tests passed.
Final D5B2 results: **324 Python and 232 JavaScript tests passed**, with zero
failures or skips. New coverage includes 19 actual loopback HTTP tests (one runs
the packaged client against a real isolated server and owner approval) and 22
client tests. All 11 existing D5B management tests remain and now use the new
enrollment helpers. The original owner-authentication, 20-operation authorization,
private ACL, hotkey, Native Messaging and Studio regressions pass unchanged.

The actual-client HTTP test uses a test-only URL adapter from the fixed production
URL to its ephemeral fixture port. It verifies protocol integration without
changing the packaged client's address or touching production port 8765.

```powershell
& 'C:\Users\Honey\AppData\Local\Programs\Python\Python313\python.exe' -B -m unittest discover -s tests -v
& 'C:\Program Files\nodejs\node.exe' --test --test-reporter=spec tests/extension-access.test.mjs tests/resume-contract.test.mjs tests/pdf-renderer.test.mjs tests/web-studio.test.mjs tests/hotkey.test.mjs tests/manager-auth.test.mjs tests/browser-pairings.test.mjs tests/enrollment.test.mjs
& 'C:\Program Files\nodejs\node.exe' --check extension/studio/enrollment.mjs
& 'C:\Program Files\nodejs\node.exe' --check tests/enrollment.test.mjs
& 'C:\Program Files\nodejs\node.exe' --check manager/ui/extension-studio.mjs
git diff --check
```

## Future manual Chrome acceptance — NOT TESTED

Use isolated synthetic owner/configuration storage and a separate test Chrome
profile/unpacked copy, with explicit approval. Do not test against production
pairing records or change legacy extension IDs to make a fixture connect.
The existing synthetic browser launcher uses an ephemeral port. A separately
approved isolated fixed-port harness and the future enrollment UI are prerequisites
for this Chrome checklist; neither was launched or added in D5B2. The Node adapter
is a test seam, not a configurable production fallback.

1. Record Chrome version, extension ID and host-access settings. Run only the
   isolated test backend at the approved fixed address after ensuring no real
   manager is using it. Configure its matching extension ID/device identity via
   authenticated Web Studio.
2. From a packaged visible extension document, import the module. On an explicit
   user action call `getBootstrap()`. Inspect Network for actual extension Origin,
   exact Host, omitted credentials and any Chrome/OS LNA prompt. Do not print
   cookies, request tokens, exchange headers or installation credentials.
3. Confirm displayed backend/workspace identity, explicitly pin it, then request
   pairing. Compare the returned code with Web Extension Studio.
4. Approve for a synthetic candidate. Explicitly claim once. Verify trusted local
   credential persistence and pending-secret removal without displaying secrets.
5. Repeat in another ordinary Chrome profile; verify different installation IDs
   and candidate bindings. No global active candidate changes are permitted.
6. Test denial, expiry, wrong ID/origin, restart, storage denial and a lost claim
   response. Use the explicit revocation/re-pair procedure; never replay an
   uncertain claim. Confirm identity mismatches and existing credentials block
   replacement.
7. Reload/restart Chrome and verify content scripts cannot access restricted keys.
   Confirm web business APIs, CSRF policy, clipboard hotkey and legacy context
   menu remain unchanged. No application/folder/file-save operations are involved.

Node/HTTP tests do not prove Chrome's CORS, LNA prompts, storage isolation or UI.
