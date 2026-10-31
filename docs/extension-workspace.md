# Persistent extension workspace (D5C-C / D5D)

The popup's **Open Application Tracker** button opens or focuses the packaged
`workspace.html` page. Legacy candidate-name configuration and the standalone
filesystem-access page remain under **Legacy capture setup**. Neither the legacy
name nor the extension ID authenticates an owner or selects the bound candidate.

No browser permissions, backend authorization policy, hotkey or native-host code
changed. Scripts and styles are packaged locally; no inline executable script,
remote dependency or CSP relaxation is used.

## Implemented screens

1. Backend discovery and unpaired identity confirmation.
2. Explicit pairing request with browser label and server approval code.
3. Pending approval with local expiry countdown and explicit claim.
4. Paired confirmation followed by owner sign-in.
5. Backend-verified owner login and session restoration.
6. Exactly two main tabs, Workspace and Settings, after authentication.
7. Locked expiration, reassignment, revocation, offline and recovery states.

Workspace contains functioning Job Description, CV (JSON) and optional Cover
Letter editors. [Workspace editor behavior](workspace-editors.md) documents
explicit import review, exact copying, shared validation and memory-only drafts.
Settings still contains Personal Details and Custom Prompts, labeled **Candidate
settings integration is coming in D5E.** No profile or prompt data is loaded by
the extension. There are no Generate, Save, Download or application controls.

The candidate header is projected only from the verified extension session.
Backend availability is based on actual bootstrap/request outcomes; stored pairing
alone does not show an authenticated owner. Unsupported Incognito use is rejected
before storage/network operations, without changing legacy Incognito behavior.

## Transport and storage

`studio/enrollment.mjs` remains the enrollment implementation.
`studio/auth.mjs` implements only the transport for the existing backend
AuthService, following [the D5C-B contracts](extension-authentication.md).

All requests target exactly `http://127.0.0.1:8765`, omit cookies, reject redirects
and check pinned backend/workspace identity before transmitting owner/installation
proof. The browser supplies Origin; JavaScript never fabricates it. The auth
client bounds request waiting, distinguishes synchronous browser execution errors
from network failures, and does not retry passwords or uncertain mutations.

`chrome.storage.local` retains the existing installation credential and identity
pin. Only an explicit acknowledgement after fresh server verification updates
the local binding revision; the credential and pin are unchanged.

`chrome.storage.session` contains:

- Existing pending enrollment secret/metadata.
- `tracker.auth.session.v1`: bearer token and minimal verified owner/context data.
- `tracker.auth.control.v1`: non-secret revision/state for cross-page operation
  invalidation and logout coordination.
- `tracker.workspace.tab.v1`: non-secret launcher tab ID, validated before reuse.

Local and session access are restricted to `TRUSTED_CONTEXTS` before sensitive
reads. No credential uses sync, page localStorage or IndexedDB. Password input is
cleared immediately on submission and never stored. The control revision is not
an identity or authentication credential: stored sessions always need a real
authenticated backend check before the UI is restored.

Web Locks protect shared storage transitions. Network waits do not hold the auth
storage lock: logout can clear state while another page's login is in flight.
Revision checks prevent late login/status responses from restoring cleared state
or erasing a newer session. Storage-change notifications lock other trusted pages;
they never authenticate them. Ordinary Chrome profiles remain separate storage
boundaries. Incognito is not presented as an independent installation.

## Lifecycle and recovery

- Refresh/focus/pageshow/visibility restoration verifies the session with GET;
  these checks do not renew idle expiration. No background network poll exists.
- A local deadline hides the shell. Native fetch/timer/storage methods retain
  their proper receivers. Initialization/cleanup errors remain local errors and
  cannot activate protected content.
- **Keep signed in** is an explicit user-triggered activity request. The backend
  retains its 30-minute idle and eight-hour absolute limits.
- Logout hides candidate content first, clears shared session state and attempts
  exact-token server revocation. It preserves the installation credential.
  Failure says **Server sign-out could not be confirmed.** Storage cleanup failure
  is reported separately. No backend revocation is claimed without confirmation.
- Backend restart requires login again while preserving the installation.
- Reassignment locks the old context. Fresh owner login reveals the current
  candidate in a separate acknowledgement screen; a further GET verifies it
  before updating local revision metadata and opening the shell.
- Revoked/reset installations remain stored and locked with Web Studio guidance.
  Credential removal/replacement is deliberately not automated in this checkpoint.
- Editor drafts remain in page memory only. Expiration or disconnection redacts
  the form; a fresh backend verification of the exact same owner, installation,
  candidate and binding revision can restore compatible drafts. Logout,
  reassignment, revocation and cross-page session changes discard them. See the
  [draft lifecycle](workspace-editors.md#draft-lifecycle) for the full scope.

Pending cancellation only clears local enrollment. It does not cancel a server
request. Pending claim responses can be retried only by another explicit click
after approval. A lost/uncertain claim is never replayed. HTTP 409 cannot reliably
distinguish a denied exchange from an already consumed exchange; the UI says
**denied or already consumed**, rather than inventing certainty. HTTP 410 reports
expiry. Reviewed uncertain exchanges require explicit acknowledgement before
local clearing. A stored credential with failed cleanup offers **Finish Local
Pairing Cleanup**, without re-claiming it.

## Wireframes for review

The pairing/login wireframes below remain unchanged. For the implemented D5D
desktop and narrow editor layouts, see [the editor wireframe](workspace-editors.md#layout).

Unpaired:

```text
Application Tracker                         Local backend: Available
                 Connect this browser
                 Backend / Workspace Identity
                 [Confirm Backend]
                 Browser label [________________]
                 [Request Pairing]
                 Already paired? (recovery guidance)
```

Pending:

```text
                 Pairing Requested
                 Browser: [actual label]
                 ABCD-2345       Expires in 4:59
                 [Open Web Studio]
                 [Claim Approved Pairing] [Cancel Pending Request]
```

Login:

```text
                 Sign In
                 Stored pairing · Owner verification required
                 Username [________________]
                 Password [________________]
                 [Sign In]
```

Authenticated desktop:

```text
Application Tracker     Local backend: Available    Candidate: [verified]
                                                   Owner: [...] [Sign Out]
Ready when you are                                  [Keep signed in]
[ Workspace ] [ Settings ]
┌ Job Description ─────────────────┬ CV (JSON) ──────────────────┐
│ Company [________________]       │ [Editable raw JSON]        │
│ Job URL [________________]       │ [Validate] [Copy JSON]     │
│                                 ├ Optional Cover Letter ─────┤
│ [Original JD textarea]           │ [Editable plain text]      │
│ [Import / Review] [Copy JD]       │ [Copy Cover Letter]        │
└─────────────────────────────────┴────────────────────────────┘
```

Settings:

```text
[ Workspace ] [ Settings ]
┌ Personal Details ────────────────┬ Custom Prompts ─────────────┐
│ Candidate settings integration   │ Candidate settings         │
│ is coming in D5E.                │ integration is coming      │
│                                 │ in D5E.                    │
└─────────────────────────────────┴────────────────────────────┘
```

Below 700px, header content wraps and both section grids stack into one column.
The same two tabs remain; arrows/Home/End support roving keyboard focus. Controls
have labels and focus indicators; errors use an alert and notices a live status.

## Automated evidence and browser boundary

D5D adds `workspace-editor.test.mjs`, exercising the actual editor model, DOM
bindings and authenticated controller with synthetic data. No browser or
production pairing is exercised by these tests. The user reports D5C-D1 basic
Chrome networking/UI smoke tests passed; remaining real Chrome acceptance is
**DEFERRED BY USER** until the full extension is built. No additional manual
pairing, login, multi-profile or session checks are requested in D5D.

The three JavaScript suites exercise the real client/controller/DOM adapter with
synthetic browser APIs and receiver-sensitive functions. A Python integration
test runs the actual packaged auth client against real ephemeral loopback HTTP,
including two installations, candidate isolation, activity/logout and reassignment
acknowledgement. Its test-only URL/Origin adapter does not prove Chrome CORS or LNA.

No new Chrome session, screenshot or installed-extension test was performed in
D5D. Basic smoke success is user-reported, not an automated assertion about the
remaining CORS/LNA, rendering or multi-profile scenarios. No production extension
was loaded, reloaded or paired by this checkpoint. Do not disable security flags,
accept missing/null Origin, add speculative permissions or broaden CORS.

## Later user-authorized visual acceptance

The following procedure is retained for future acceptance, **not executed** in
D5D and **deferred by the user**. It is not a prerequisite to this implementation
review:

1. Obtain approval to stop the production manager and use an isolated ordinary
   Chrome test profile. Do not use a profile pinned to the production backend.
2. With approval, load this repository's unpacked extension in that test profile.
   Note its actual extension ID. Do not run native-host registration.
3. Start the opt-in synthetic fixture from the repository root:

   ```powershell
   & 'C:\Users\Honey\AppData\Local\Programs\Python\Python313\python.exe' -B tests/serve_extension_workspace_fixture.py --extension-id <actual-extension-id>
   ```

   It binds only 127.0.0.1:8765, fails on conflict, opens no browser and creates
   only temporary synthetic config/security records. It prints clearly synthetic
   login credentials. Production LocalAppData, candidates and bindings are unused.
   Native registration and filesystem browsing are disabled in the fixture.
4. Open the popup, verify the primary launcher and separate legacy section.
   Reopen it and confirm the same persistent page is focused.
5. Check bootstrap in DevTools. Record actual Origin, HTTP status, preflight and
   any network-permission prompt; never export credentials or a HAR. If unexpected,
   stop and report a focused transport issue. Keep backend guards unchanged.
6. Confirm displayed identity, request pairing, and inspect the actual code.
   Open `http://127.0.0.1:8765/extension-studio`, sign in with fixture credentials,
   approve the matching request and assign Alex Synthetic or Blake Synthetic.
7. Explicitly claim, continue to Sign In, and verify the candidate header and
   exactly two tabs. Review at roughly 1200×900 and 390×844; use only synthetic
   screenshots. Exercise the D5D editors with synthetic pasted text and JSON;
   verify no Save, Generate or Download controls appear.
8. Verify incorrect login, refresh/focus restoration, logout, backend disconnect,
   explicit reconnect, reassignment acknowledgement and revocation. Use another
   isolated ordinary profile for independent installation checks.
9. Keep the same fixture process running for a review session. Restart creates a
   new synthetic backend identity, which must correctly cause a pin mismatch in
   old test profiles. Do not erase a production pin to work around it.
10. Stop the fixture with Ctrl+C. Its temporary records are removed. Test extension
    storage remains in the disposable Chrome test profile, not production storage.

The real legacy Native Messaging path still targets its separately registered
host. Do not invoke context-menu saving or selected-company native lookup as part
of this fixture review. Their production compatibility remains a separate boundary.
