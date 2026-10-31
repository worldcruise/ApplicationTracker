# Installation-scoped owner authentication (D5C-B)

This backend implementation adds extension-audience owner sessions to the existing
`AuthService`. It does not implement an extension login page, launcher, persistent
workspace, profile/prompt endpoints or candidate picker. Installed Chrome acceptance
is still pending; synthetic HTTP tests do not prove Chrome Origin, CORS or Local
Network Access behavior.

## Identity and authorization

Production connects only to `http://127.0.0.1:8765`. The fixed port and identity
pinning do not provide cryptographic server authentication against hostile local
processes. The MVP boundary remains a trusted laptop.

The private owner repository is the only account/password-verifier store. Private
browser bindings remain the only installation-credential store. A pairing
credential proves an approved installation, not owner login. Each authenticated
extension operation proves both an installation and an owner session.

Owner and candidate identity are resolved server-side. No endpoint accepts
`user_id`, `candidate_id`, `candidateId`, binding revision or audience in its body
as an authorization claim. The candidate comes from the current binding, never
`activeCandidateId`, the legacy popup name or a web session's selected candidate.
The single-owner policy grants the verified local owner access to this registry;
future multi-user ownership policies must replace that explicit policy.

## HTTP contract

All four routes require the exact configured
`Origin: chrome-extension://<extension-id>` and exact loopback Host. Isolated
HTTP tests use an ephemeral loopback listener; production remains port 8765.

Required installation headers on all requests:

```text
X-Tracker-Installation-Id: <installation-id>
X-Tracker-Installation-Credential: <installation-credential>
```

Protected session requests additionally require:

```text
Authorization: Bearer <extension-session-token>
```

POST requests require:

```text
X-Tracker-Token: <requestToken from /api/extension/bootstrap>
Content-Type: application/json
```

This request token is the current enrollment-process token, not the web CSRF
token and not an owner credential. Refresh bootstrap after restart; identity
mismatches still require explicit recovery. GET session does not require a
mutation token. Login rejects an existing Authorization header.

| Method and route | JSON body | Result |
| --- | --- | --- |
| POST `/api/extension/auth/login` | `{"username":"...","password":"..."}` | 200, newly issued bearer token and verified context |
| GET `/api/extension/auth/session` | None | 200, verified context without renewing idle time |
| POST `/api/extension/auth/activity` | `{}` | 200, verified context and renewed valid idle time |
| POST `/api/extension/auth/logout` | `{}` | 200, `{"authenticated":false}` after exact-token revocation |

Login response (all identifiers below are illustrative):

```json
{
  "authenticated": true,
  "sessionToken": "<fresh opaque token, returned only at issuance>",
  "user": {"id": "<owner-id>", "username": "<username>", "role": "owner"},
  "context": {
    "backendId": "<backend-id>",
    "workspaceId": "<workspace-id>",
    "installationId": "<installation-id>",
    "bindingId": "<installation-id>",
    "candidate": {"id": "<bound-id>", "name": "<registry display name>"},
    "bindingRevision": 1,
    "extensionOrigin": "chrome-extension://<configured-id>"
  },
  "session": {
    "audience": "extension",
    "idleRemainingSeconds": 1800,
    "absoluteRemainingSeconds": 28800
  }
}
```

Session/activity responses have the same shape without `sessionToken`. Neither
installation credentials nor password/verifier data appear in responses. No route
sets a cookie. Candidate context is returned only after owner authentication.

## Request security and CORS

- Cookies and proxy authorization are rejected; the web owner cookie never
  authenticates these routes. Future extension fetches must use
  `credentials: "omit"`, `redirect: "error"` and the fixed address.
- Reuse the strict bounded authentication parser: 8 KiB maximum, UTF-8 JSON
  object, no duplicate/unknown properties, no ambiguous framing or query strings.
- OPTIONS is limited to the four exact authentication paths. The allowed method
  is GET for session, POST for login/activity/logout. Allowed headers are only the
  installation proof headers, plus Authorization for protected routes, plus
  Content-Type and X-Tracker-Token for POST. Login preflight does not allow
  Authorization. No wildcard or CORS credential allowance exists.
- Enrollment's separate three-header, POST-only preflight policy is unchanged.
  Existing web Origin/Host/CSRF checks and business authorization are unchanged.
- Responses use no-store and nosniff. Sensitive paths use existing redacted
  logging; exception details and supplied credentials are never echoed.

Errors contain only `{"code":"...","error":"..."}`:

| HTTP | Codes and recovery |
| --- | --- |
| 400 | `invalid-request`, `credentials-not-allowed`; correct the request, do not replay automatically |
| 401 | `invalid-credentials`, `authentication-required`; generic owner login failure or invalid/expired/wrong-audience session |
| 403 | `invalid-host`, `invalid-origin`, `invalid-request-token`, `preflight-denied`, `installation-unavailable`, `candidate-unavailable`; review proof/configuration or bootstrap |
| 409 | `binding-changed`; authenticated scope is stale; discard incompatible drafts and explicitly sign in again |
| 429 | `rate-limited`; respect Retry-After; no automatic password retries |
| 503 | `owner-setup-required`, `authentication-unavailable`, `session-capacity`; explicit setup/recovery or wait/sign out; no fallback |

Unknown authentication paths return 404 and unsupported methods 405, after
request guards. These are not anonymous business API fallbacks. An eager owner
management revocation may make a stale session return 401 instead of 409. Neither
response returns the newly assigned candidate's information.

## Session lifecycle and concurrency

Session tokens contain 32 random bytes. Only their SHA-256 digests are retained
server-side in the same process-local, thread-safe store used by web sessions.
An immutable extension scope records backend/workspace, installation/binding,
candidate, revision and origin; owner identity/epoch/generation and timestamps
remain in the session record. Absolute expiration is creation plus eight hours.

Web and extension audiences are separate during validation, activity, replacement
and logout. A successful new extension login replaces only the previous extension
session for that installation. Other browser installations and all web sessions
remain valid. Concurrent logins serialize issuance; only the last-issued token
remains active. Old-token logout cannot delete a replacement token.

Both audiences share the existing global limits: 10 login attempts per five
minutes, two concurrent password verifications and 128 live sessions. Rotation
can replace its own slot at capacity; it cannot evict another valid session.
Expired and owner-generation-invalid sessions are pruned.

Login validates the installation before hashing and revalidates owner generation
and binding after hashing. Issuance holds the private binding transaction, so a
concurrent reset/reassignment/revocation cannot issue under changed credentials
or adopt another candidate silently. No private lock is held during password work.

Every session request revalidates the installation digest, owner generation,
candidate existence, scope and binding revision. Validation and activity renewal
hold that transaction and check expiration again before renewing. A previously
valid request cannot revive an expired session. GET polling never touches idle
time; no frontend activity heartbeat is introduced.

Lock order is AuthService lock, pairing-service lock, owner/private binding locks,
then candidate lookup. Management commits and releases private locks before
targeted session revocation. A delayed reassignment callback preserves sessions
issued at a newer revision. Direct/offline binding changes are still rejected by
per-request validation. Returned metadata represents a validation point, not a
cross-file transaction for future writes; later data adapters must validate their
own operation at commit.

## Revocation and recovery

- Idle expiration: 30 minutes; absolute lifetime: eight hours.
- Backend restart: all owner sessions lost; installation credential persists.
- Password reset/recovery: existing epoch/generation policy invalidates sessions
  and existing pairing credentials. Re-pairing is required; no silent replacement.
- Reassignment: old scoped session invalid; fresh owner login resolves the current
  binding. Future UI must require explicit changed-context acknowledgement and
  must not restore an old candidate's drafts.
- Installation revocation: affected sessions invalid, other installations remain
  usable. Web Studio remains the management/recovery surface.
- Logout after a direct binding change can revoke the exact previously scoped
  token using the original installation proof, without candidate access. Eagerly
  revoked/unknown tokens return 401. Successful logout never targets another
  installation or a replacement session.
- Offline logout: future UI must clear local session state and lock regardless,
  while reporting server revocation unconfirmed. It must not claim a successful
  server logout or automatically retry an uncertain login/write.
- Lost login response: no automatic retry. The next explicit successful login
  rotates that installation's orphaned session. This differs from a one-time
  enrollment claim, which must never be replayed after uncertain delivery.

## Verification boundary

`test_extension_auth.py` exercises synthetic service state, shared limits, clocks,
generation/reassignment races, audience and installation isolation.
`test_extension_auth_http.py` uses actual ephemeral loopback HTTP with temporary
owners/candidates/private bindings, including web/enrollment compatibility.

No production owner, pairing, candidate configuration or ACL is changed. The
extension UI, actual Chrome Origin/preflight/LNA transport, multi-profile browser
acceptance and trusted browser-session storage are future D5C-C/D5C-D checks.
