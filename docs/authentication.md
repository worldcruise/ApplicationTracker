# UI-C2B: Backend owner authentication and sessions

The authentication service and five HTTP endpoints are implemented. **The overall
manager is not yet login-protected.** Existing Studio APIs retain their existing
Host/Origin/process-token protection until the coordinated UI-C3 authorization
rollout. No frontend login, browser pairing, extension binding or activity polling
is added here. No real owner account is initialized automatically.

## Components and storage

- `tracker_config/auth.py`: transport-independent `AuthService(repository, clock=...)`.
- `manager/auth_http.py`: strict HTTP parsing, safe response projection and cookies.
- `manager/app.py`: auth dispatch and one service instance attached to each server.
- `tracker_config/security.py`: the unchanged UI-C1 owner source, verifier helpers,
  `authEpoch` and `authGeneration`.

There is one owner repository, at the existing security location. Authentication
never loads candidate records, creates folders, rewrites profiles or initializes
an account. Administrative setup/reset/recovery remain local CLI operations; see
[owner-security.md](owner-security.md).

`AuthService.login(username, password, previous_token=None)` verifies through the
existing PBKDF2 helper. Because this version has exactly one owner, every valid
credential-shaped attempt uses that same real verifier, including unknown
usernames. Username and disabled-state results are evaluated after hashing. No
second password algorithm, dummy account or verifier store is needed.

Login returns a transient `IssuedSession` containing the raw token and safe
metadata to the transport adapter. Each token uses 32 cryptographically random
bytes. Only SHA-256 token digests are keys in the server-side session dictionary.
Records contain the verified user/backend IDs, epoch/generation and monotonic
creation/activity times; they contain no raw tokens, passwords or verifiers.
Sensitive transient/session objects do not include their fields in default repr.

The HTTP adapter delivers the token only through `Set-Cookie`, not JSON. No
authentication credential is placed in localStorage, frontend JavaScript or URL
parameters. This checkpoint exposes no extension bearer-token endpoint; a future
transport must supply its own approved pairing and authorization boundary.

## Session lifecycle and limits

The public service methods are `login`, `session(token, touch=False)`,
`logout(token)`, `revoke_all()` and `status()`.

- Idle expiration is 1,800 seconds after the last explicit activity.
- Absolute expiration is 28,800 seconds after creation, regardless of activity.
- Equality with either deadline means expired. Validation/pruning happens before
  activity changes, so an expired session cannot be revived.
- `session()` defaults to no renewal. Only explicit `touch=True` renews idle time.
- Logout removes the presented token digest; it does not change other sessions.
- Successful relogin issues a fresh token and replaces the presented old session
  after verification. Other browser sessions remain valid.
- `revoke_all()` also invalidates logins already undergoing password verification.
- Backend restart constructs a fresh service and invalidates old tokens.

Every session verification rereads the validated, permission-checked security
record. Disabled accounts, changed user/backend IDs, epoch or generation reject
the session. Missing, malformed or unreadable storage fails closed and clears the
session cache; restoring a file does not resurrect those cleared sessions.
Administrative reset/recovery therefore invalidates sessions without restarting
the backend. The CLI rotates epoch/generation rather than writing session files.

Login captures the verified security revision, then rechecks it after hashing
before issuing a token. A reset during hashing rejects login. The session retains
the identity/generation of the verified snapshot, so a reset immediately after
that final check still makes the token fail its next validation. Old-password
verification never adopts a newer authentication generation.

Session and rate-limit state use a lock; hashing runs outside that lock under a
two-slot semaphore. No login waits in an unbounded hash-work queue.

Resource limits:

| Limit | Behavior |
| --- | --- |
| 10 login attempts in a rolling 300-second window | Global to this local backend; usernames cannot create independent buckets. Excess returns 429 and `Retry-After`. Rejected attempts do not grow the timestamp queue. |
| Two simultaneous password verifications | Excess returns 429 with `Retry-After: 1`; the attempt still consumes the global budget. |
| 128 live sessions | Expired/revoked-generation records are pruned. New login at capacity returns 503 without evicting unrelated valid sessions. A verified replacement of the presented session can proceed. |

Origin/CSRF/body-shape failures are rejected before credential processing. Requests
that reach `AuthService.login`, including invalid credential types, consume the
attempt budget. Limits and sessions reset with the process. The service accepts
an injectable monotonic clock for deterministic boundary tests. This is a local
MVP limit, not a distributed limiter or general HTTP denial-of-service defense.

## HTTP contract

All five endpoints require the exact current `127.0.0.1:<port>` Host. POST requires
the exact `http://127.0.0.1:<port>` Origin and the existing `X-Tracker-Token` value.
GET rejects a supplied inappropriate Origin. Supplied Fetch Metadata must indicate
same-origin or direct navigation. There are no CORS allow headers or extension
origin exemptions. The process token is **CSRF/request protection, not identity**.

Auth URLs cannot have query parameters or fragments. POST accepts an object in
`application/json`, optionally with UTF-8 charset, capped at 8,192 bytes. The
adapter rejects duplicate JSON properties, non-finite constants, invalid UTF-8,
unknown properties, duplicate critical headers, transfer encoding, unsupported
Expect handling, invalid/duplicate lengths and unexpected GET bodies. Incomplete
bodies fail; auth body reads have a five-second timeout. Connections close after
the response rather than interpreting leftover bytes as another request.

### Availability/bootstrap

`GET /api/auth/status` returns HTTP 200:

```json
{
  "state": "ready",
  "csrfToken": "<existing process request token>",
  "idleTimeoutSeconds": 1800,
  "absoluteTimeoutSeconds": 28800,
  "managerAuthorizationEnforced": false
}
```

`state` is `ready`, `setup-required` or `unavailable`. No account name, candidate
record, session credential or security document is returned. Status does not
renew a session. Its bootstrap avoids depending on the candidate-bearing
`/api/state` endpoint before login during the future UI-C3 rollout.

### Login and authenticated metadata

`POST /api/auth/login` accepts exactly:

```json
{"username":"local-owner","password":"<entered passphrase>"}
```

The username must be nonempty text, with at most 64 stripped characters and 256
input characters; canonical normalization uses UI-C1's helper. The password must
be nonempty UTF-8 text of at most 1024 bytes, preserved exactly. UI-C1 enforces its
stronger minimum length when a password is created/reset. Wrong usernames,
passwords and disabled accounts receive the same generic 401 failure.

HTTP 200 login success sets a cookie and returns this safe projection:

```json
{
  "authenticated": true,
  "user": {"id":"<verified owner ID>","username":"local-owner","role":"owner"},
  "session": {"idleRemainingSeconds":1800,"absoluteRemainingSeconds":28800}
}
```

`GET /api/auth/session` reads the owner cookie and returns the same shape with
remaining times. It **does not** renew idle time. `POST /api/auth/activity` accepts
exactly `{}`, validates the cookie, renews idle time and returns this shape without
extending the absolute lifetime. There is no frontend polling integration yet.

The backend derives the owner ID from verified credentials/session state. Client
`user_id`, `candidate_id`, generation, credential-path or arbitrary input fields
are not accepted. Response fields and types are validated/projected explicitly;
internal security records cannot be serialized as session responses.

### Logout

`POST /api/auth/logout` accepts exactly `{}`. It revokes the presented session,
clears its cookie and returns HTTP 200 with `{"authenticated":false}`. It is
idempotent with missing/invalid/expired tokens and remains usable when the owner
store is unavailable. Host/Origin/CSRF checks still apply. Duplicate owner cookies
are rejected as ambiguous input, rather than choosing one silently.

### Errors

Auth errors have `{"error":"<safe message>","code":"<stable code>"}`.

| HTTP | Code |
| --- | --- |
| 400 | `invalid-request` |
| 401 | `invalid-credentials` for failed login; `authentication-required` for invalid, expired or revoked sessions |
| 403 | `invalid-host`, `invalid-origin`, `invalid-csrf` |
| 404 | `not-found` for unknown auth endpoints |
| 405 | `method-not-allowed`, with `Allow` |
| 429 | `rate-limited`, with `Retry-After` |
| 503 | `owner-setup-required`, `authentication-unavailable`, `session-capacity` |

401 responses clear the cookie; explicit logout additionally revokes its server
record. Availability errors do not expose OS errors, file contents, verifiers or
exception messages. Auth request logging omits the request target, body, cookie
and query values, including deliberately rejected credential-bearing URLs.

## Cookie transport and limitations

```http
Set-Cookie: tracker_owner_session=<opaque-token>; HttpOnly; SameSite=Strict; Path=/api/; Max-Age=28800
```

No Domain attribute is set. Logout/401 clears the same name/path with Max-Age=0
and matching HttpOnly/SameSite attributes. Every auth response has no-store,
nosniff and JSON headers. Server-side deadlines remain authoritative even if a
browser retains the cookie longer.

For the approved HTTP loopback-only MVP, **Secure is intentionally omitted**.
No unverified browser-specific localhost exception is assumed. HTTP provides no
TLS protection. Cookies are not isolated by port, so other services on the same
loopback host are part of the local OS trust boundary. HttpOnly prevents ordinary
JavaScript reads; it does not protect against same-user local malware, a hostile
loopback service or compromised same-origin application code. This transport must
not be exposed to the LAN or reused for remote computers. See the primary
[cookie reference](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie)
and [RFC 6265 section 8.5](https://www.rfc-editor.org/rfc/rfc6265#section-8.5).

The current production launcher still selects a random loopback port. The fixed
127.0.0.1:8765 transition, with no fallback, belongs to UI-C3. A fixed port will not
by itself create cookie isolation from other loopback services.

## Verification and rollout

`test_auth.py` exercises the service with real private owner fixtures and injected
time. `test_auth_http.py` starts disposable loopback servers using the actual
TrackerHandler, isolated storage and real HTTP clients; it never calls manager
`main()`, opens Chrome or executes native registration. Helpers live in
`auth_fixtures.py`. Tests verify original candidate fixture bytes remain unchanged.

Password verification uses the actual UI-C1 PBKDF2 helper. Capacity-only tests mock
hash/rate work while filling 128 real session records; hashing and both resource
limits are tested independently and through HTTP. Coordinated HTTP threads test
reset during verification, concurrent verification limits and separate sessions.
Browser cookie acceptance, JavaScript HttpOnly isolation and cookie restoration
have not been manually verified in Chrome.

Verified on Windows with Python 3.13 and Node.js 24.22.0: 25 authentication-service
tests and 24 actual loopback HTTP tests pass; the complete suites pass 217 Python
tests and 153 JavaScript tests. Existing owner-storage tests remain included.

Safe commands from the repository root:

```powershell
& 'C:\Users\Honey\AppData\Local\Programs\Python\Python313\python.exe' -B -m unittest discover -s tests -p 'test_auth*.py' -v
& 'C:\Users\Honey\AppData\Local\Programs\Python\Python313\python.exe' -B -m unittest discover -s tests -v
& 'C:\Program Files\nodejs\node.exe' --test --test-reporter=spec tests/extension-access.test.mjs tests/resume-contract.test.mjs tests/pdf-renderer.test.mjs tests/web-studio.test.mjs tests/hotkey.test.mjs
git diff --check
```

UI-C3 must add the web login gate and enforce verified owner sessions on all
sensitive existing APIs together, preserving CSRF, revision checks and unsaved
drafts. There must be no missing-owner anonymous fallback. Public bootstrap/static
assets must remain narrowly scoped. This checkpoint does not claim authorization
of candidate data or ownership mapping for future users. Legacy Native Messaging
is separate and is not secured by owner login. Pairing, extension UI and the
clipboard-only hotkey are unchanged and outside UI-C2.
