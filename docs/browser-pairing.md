# D5B: private browser pairing and candidate bindings

## Implemented boundary

The manager administers persistent candidate bindings from its existing Extension
Studio. Management routes require the verified owner cookie and existing
Host/Origin/request-integrity guards; mutations also require the existing CSRF
token. D5B2 adds the separately guarded [pre-login enrollment transport](extension-enrollment.md)
and packaged client. Only its three explicit route shapes have extension-origin
exceptions. Extension owner login, bearer sessions and extension UI are not implemented
by that transport. No candidate picker is added to the extension.

## Storage and identity

`tracker_config/browser_bindings.py` reuses the owner repository's validated
private directory, Windows ACL policy, native/process locking and private atomic
writer. It never provisions directories. Storage is `browser-bindings.json`
beside `security.json`, with a validated private `.bak` on subsequent writes.
Primary/backup corruption and unsafe permissions fail closed, without automatic
repair or backup restoration. Reads and pending exchanges create no files.

The schema is version 1:

```json
{
  "schemaVersion": 1,
  "installations": [
    {
      "id": "32-character installation UUID",
      "pairingId": "32-character one-use pairing UUID",
      "ownerId": "verified owner UUID",
      "backendId": "owner-store backend UUID",
      "workspaceId": "existing local device ID",
      "candidateId": "existing candidate ID",
      "extensionOrigin": "chrome-extension://<configured-extension-id>",
      "label": "Browser profile label",
      "bindingRevision": 1,
      "revoked": false,
      "credentialDigest": "SHA-256 digest; never the credential",
      "authEpoch": "owner authentication epoch",
      "authGeneration": 1,
      "createdAt": "UTC timestamp",
      "updatedAt": "UTC timestamp"
    }
  ]
}
```

The illustrated strings describe fields, not valid fixture credentials. Runtime
validation requires concrete identifiers, types, supported schema and timestamps.
Unknown security fields, plaintext credentials and duplicate installation/claim IDs
are rejected. No identity or credential data is added to `candidates.json`.

The saved `config/local/extension-studio.json` ID namespaces this checkout's
workspace under the shared owner/backend identity. Its extension ID constrains
the allowed extension origin. Save device settings explicitly before enrollment;
bootstrap/listing never creates a device ID. An extension ID or device label is
not authentication or proof that a browser is installed. Different Chrome
profiles receive independent installation IDs and credentials even with the same
extension origin. Ordinary Chrome profiles, rather than incognito separation,
are the intended future acceptance target.

## Exchange lifecycle

1. An authorized caller supplies a browser label, the configured extension origin
   and a fresh cryptographically generated 32-byte base64url exchange secret.
2. The process stores only its SHA-256 digest in memory, a random request ID, a
   short matching code and a monotonic five-minute deadline. Ten creation attempts
   per five minutes, bounded requests and a 256-installation private-store limit
   prevent unbounded growth. The matching code is never an authorization input.
3. The owner compares browser label/code, explicitly chooses a candidate, then
   approves or denies using the observed request revision. No active candidate is
   preselected, activated or modified.
4. Claim requires the original exchange secret. Pending returns 202. Denied,
   consumed, wrong-secret and expired requests cannot issue a credential.
5. An approved claim creates one 32-byte random installation credential. Its
   digest and durable pairing ID are atomically written in the same private file.
   The raw credential is returned only in that claim response, never in lists or
   approval responses. The digest is also excluded from ordinary responses.
6. The durable pairing ID rejects retries even if the write committed but its
   result/response failed. A lost claim response requires explicit revocation and
   a new exchange; the credential cannot be recovered or delivered again.

Pending exchanges expire after five minutes regardless of polling and are lost
on backend restart or a device identity/origin change. Installations persist.
Terminal request tombstones are memory-bounded. Backend restart does not revoke
pairing credentials; owner sessions still expire on restart as before.

## HTTP contracts

All paths below start with `/api/studio/extension/`. All require a verified owner.
POST/PUT use strict UTF-8 JSON (8 KiB maximum), reject duplicate/unknown fields and
require existing same-origin CSRF protection. Query parameters and credential
URLs are rejected; pairing request targets are redacted in manager logs.

| Method/path | Input | Success |
| --- | --- | --- |
| GET `pairings` or `installations` | No body | 200: `{workspaceId, backendId, requests, installations, candidates}`; safe metadata only |
| POST `pairings` | Retired; owner/session/CSRF checks still apply | 410: use `/api/extension/pairings` |
| POST `pairings/<id>/approve` | `{candidateId, revision}` | 200: approved request metadata |
| POST `pairings/<id>/deny` | `{revision}` | 200: denied request metadata |
| POST `pairings/<id>/claim` | Retired; owner/session/CSRF checks still apply | 410: only `/api/extension/pairings/<id>/claim` delivers credentials |
| PUT `installations/<id>/binding` | `{candidateId, revision}` | 200: safe updated installation metadata |
| POST `installations/<id>/revoke` | `{revision}` | 200: safe revoked installation metadata |

Errors are structured `{code,error}`: 400 invalid input/candidate, 401 missing or
expired owner login, 403 invalid Origin/CSRF/exchange or denied installation,
404 unknown route/record, 405 method, 409 stale revision/consumed exchange or
missing setup, 410 expired exchange, 429 rate/capacity, 503 unsafe/corrupt storage.
No client-supplied owner/user ID is accepted as authorization. Candidate access
uses the explicit single-owner policy and validates the current registry record.

## Binding invalidation

Reassignment and revocation increment that installation's binding revision.
Another installation is unaffected. Revocation is terminal; a fresh exchange is
required. Password reset/recovery or a changed authentication epoch/generation
invalidates existing installations and pending requests without rewriting them.
Missing candidates and incompatible extension origins make a binding unusable.

`authorize_installation()` is the reusable future enforcement boundary. It
requires a verified owner identity, the installation credential and the expected
binding revision, then rereads private state and validates candidate access.
Future extension sessions MUST pin the installation/revision server-side and
call this check for every relevant request; never accept a caller's revision or
owner ID as proof of a newly authorized session. D5B issues no extension sessions,
so it does not claim to revoke a token type that has not been implemented.

## Web UI

Extension Studio shows pending labels, origins, matching codes, expiry and state.
Approval requires a checked verification box, explicit candidate choice and
confirmation. Owners can deny, reassign or revoke with revision checks. Unchanged
binding Save buttons are disabled. Revoked/unusable bindings cannot be reassigned.
Controls provide loading, empty, setup/error and success feedback. Listing a
binding never displays a fabricated Connected status.

Sensitive rows are cleared on session suspension/logout/navigation, asynchronous
responses are generation-checked, duplicate submissions are blocked, and failed
writes are never replayed automatically. Refresh discards unsubmitted management
selections. Existing Extension Studio settings drafts retain their own lifecycle.

## Consistency and recovery

One binding-file write is atomic; owner, device and candidate JSON are not a
multi-file transaction. Operations serialize with owner reset and binding writes,
validate candidate existence and retain revision checks. Subsequent operations
reject removed candidates. No candidate files or active selection are written.
If corruption, unsafe ACLs, a missing primary with backup, or an ambiguous claim
result occurs, stop and inspect offline. Do not automatically restore/delete
security records or rerun owner initialization. Administrative binding recovery
needs a separately reviewed procedure because restoring an older backup could
resurrect revoked credentials. No automatic migration/recovery is provided here.

## Verification and remaining acceptance

D5B verification: **305 Python tests and 210 JavaScript tests passed**, with no
failures or skips. New coverage comprises 19 private binding/lifecycle tests,
11 real loopback HTTP tests and 10 JavaScript management tests. JavaScript syntax
checks and `git diff --check` also pass. All existing tests are retained.

Commands used from the repository root:

```powershell
& 'C:\Users\Honey\AppData\Local\Programs\Python\Python313\python.exe' -B -m unittest discover -s tests -v
& 'C:\Program Files\nodejs\node.exe' --test --test-reporter=spec tests/extension-access.test.mjs tests/resume-contract.test.mjs tests/pdf-renderer.test.mjs tests/web-studio.test.mjs tests/hotkey.test.mjs tests/manager-auth.test.mjs tests/browser-pairings.test.mjs
& 'C:\Program Files\nodejs\node.exe' --check manager/ui/extension-studio.mjs
& 'C:\Program Files\nodejs\node.exe' --check tests/browser-pairings.test.mjs
git diff --check
```

Synthetic tests cover expiry, denial, secret checks, one-time/post-commit replay,
independent profiles/workspaces, reassignment/revocation, reset invalidation,
concurrency, schema corruption, private primary/backup ACLs and failed atomic
writes. Real loopback HTTP tests cover owner authorization, strict requests,
Origin/CSRF checks, nondisclosure and concurrent claims. JavaScript DOM tests
exercise actual pairing management, empty/error/loading states, confirmations,
revision handling, suspension and duplicate-submission prevention.

Manual Chrome acceptance is NOT performed. In an isolated synthetic fixture,
review the pairing panel at desktop/narrow widths, keyboard labels/focus, code
comparison, explicit confirmations, stale revisions and cross-tab logout. Future
extension enrollment tests must prove Origin/transport behavior and two ordinary
Chrome profiles. Do not create production pairings merely to validate this phase.

The stable loopback URL is not backend authentication. Trusted-local HTTP,
legacy Native Messaging, filesystem grants and local credential-storage
limitations remain separate boundaries. No extension package, hotkey or legacy
context-menu behavior changes in D5B.
