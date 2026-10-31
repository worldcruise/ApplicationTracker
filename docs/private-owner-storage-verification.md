# UI-C3D / D3 verification

Date: October 29, 2026. Result: **Passed within the automated and read-only
production inspection boundary.** No application-code repair was required.
Production provisioning and owner initialization remain separately gated by D4.

## Production inspection: read-only

The real Windows Known Folder API returned current-user LocalAppData as
`C:\Users\Honey\AppData\Local`. Two fresh production repository/service instances
resolved `C:\Users\Honey\AppData\Local\ApplicationTracker\security` and returned
`setup-required`. Provisioning and ACL-mutating helpers were patched to reject any
call during this inspection. The directory/file existence checks before and after
were identical:

| Resource | Exists |
| --- | --- |
| `LocalAppData/ApplicationTracker` | No |
| `LocalAppData/ApplicationTracker/security` | No |
| Primary owner file | No |
| Legacy owner/backup/recovery artifacts in this checkout's `config/` | No |

The existing current-user profile, AppData and LocalAppData directories passed
the production ancestor validation, including nearest-parent create-access
validation. No parent ACL was changed. Additional read-only ACL inspection of
`C:\` and `C:\Users` found no effective outsider deletion/DACL/ownership grants
over the existing protected user path. The volume root's ordinary append/create
grant is not a production private-directory grant; the account profile remains
the resolver's documented ACL trust boundary. Production private-directory ACLs
cannot be accepted before those directories exist and are validated during D4.

No owner file was opened, created, reset or recovered in production. No manager
service was started against production configuration. The state check used the
same `owner_repository()` and `AuthService` used by manager startup. Actual HTTP
behavior was exercised separately against temporary synthetic installations.

## Targeted verification

| Suite | Passed |
| --- | ---: |
| Existing owner and location tests | 62 |
| Additional D3 native verification tests | 7 |
| Authentication service and auth HTTP tests | 52 |
| Manager authorization HTTP matrix methods | 5 |
| Complete Python regression discovery | 262 |
| Complete JavaScript regression suites | 188 |

All runs passed with zero failures/skips on this Windows environment. The 52
auth cases comprise 25 service tests and 27 actual HTTP test methods. Together
with the five authorization matrix methods there are 32 real loopback HTTP test
methods; the matrix includes all 20 business operations with/without a session.

`tests/test_private_storage_verification.py` adds seven checks without changing
the application:

1. Ten independent ancestor grants to a synthetic SID are rejected: write data,
   add subdirectory, write extended attributes, delete child, write attributes,
   delete, write DACL, write owner, generic write and generic all. Setup creates
   nothing and does not repair the unsafe directory. Only the disposable test
   root is explicitly restored for fixture cleanup.
2. Direct native DACL inspection verifies protected directories and primary,
   backup and retained recovery files. The only grants are full control for the
   current Windows user, SYSTEM and Administrators. No inherited/inherit-only
   credential-file ACE or unexpected SID grant is accepted.
3. A dangerous ancestor ACL is introduced after file flush. Revalidation prevents
   atomic replacement, preserves the original primary and removes the temp file.
4. Different explicit roots retain different backend/owner identities, credentials,
   revisions and session state. Reset in one does not revoke another root's user.
5. Two synthetic checkout contexts share the default owner identity while their
   independent authentication-service instances reject one another's sessions.
6. Changing actual working directories cannot select another default repository.
7. An actual temporary Windows junction is rejected before owner reads/setup;
   its target stays empty. No real directory is used as the junction target.

Existing tests also verify API-based directory creation with a protected descriptor
before the directory exists, no inheritance window, partial creation failure,
concurrent setup processes, private atomic backup/primary replacement, corruption,
legacy conflicts, aliases/overrides, PBKDF2, reset and explicit backup recovery.
Reparse/symlink flags are covered by unit tests; the new junction test exercises
a real filesystem reparse point. No distinct OS account was created or switched
to for cross-account read attempts: unauthorized access evidence is native ACL
inspection and rejection, not an impersonated-user integration test.

## Authentication and compatibility

Real HTTP tests exercised status, login, session verification, protected reads
and writes, unauthorized rejection, logout, exact idle/absolute expiration,
password-reset revocation and process-local session restart invalidation. Client
`user_id` properties cannot authenticate and are rejected by auth request parsing.
Credentials, tokens and verifier material remain absent from safe responses/logs.
Malformed storage and legacy conflicts fail closed; no migration takes place.

Automated frontend/HTTP checks cover authenticated Home, candidate/profile edits,
prompt/document templates, Resume Studio validation/PDF preview cleanup and
Extension Studio settings. Host, Origin, CSRF, framing, static allowlists and
candidate authorization remain enforced. Clipboard-only hotkey and native-host
compatibility tests pass. The owner session does not secure Native Messaging.

No real Chrome acceptance or screenshots are claimed. Actual cookie enforcement,
clipboard/download permissions, visible UI/PDF behavior and manual session/draft
flows remain on the existing browser acceptance checklist. Interactive hidden
password input and new production directory ACLs also remain D4/manual checks.

## Commands executed

Python interpreter: `C:\Users\Honey\AppData\Local\Programs\Python\Python313\python.exe`.
Node interpreter: `C:\Program Files\nodejs\node.exe`. Run from the repository root:

```powershell
& 'C:\Users\Honey\AppData\Local\Programs\Python\Python313\python.exe' -B -m unittest discover -s tests -p 'test_*security*.py' -v
& 'C:\Users\Honey\AppData\Local\Programs\Python\Python313\python.exe' -B -m unittest discover -s tests -p test_private_storage_verification.py -v
& 'C:\Users\Honey\AppData\Local\Programs\Python\Python313\python.exe' -B -m unittest discover -s tests -p 'test_auth*.py' -v
& 'C:\Users\Honey\AppData\Local\Programs\Python\Python313\python.exe' -B -m unittest discover -s tests -p test_manager_authorization.py -v
& 'C:\Users\Honey\AppData\Local\Programs\Python\Python313\python.exe' -B -m unittest discover -s tests -v
& 'C:\Program Files\nodejs\node.exe' --test --test-reporter=spec tests/extension-access.test.mjs tests/resume-contract.test.mjs tests/pdf-renderer.test.mjs tests/web-studio.test.mjs tests/hotkey.test.mjs tests/manager-auth.test.mjs
git diff --check
```

The production check invoked `windows_known_folder`, `SecurityLocation.inspect`,
`ensure_uninitialized` and `AuthService.status` only, with mutating provisioning
helpers blocked and before/after existence checks. It was not owner initialization.

## Git review boundary

Branch `feat/manager-authorization`, HEAD `1f59779`. D3 adds this report and the
seven-test module, and appends its test summary to `tests/README.md`. All existing
application source and user candidate configuration remain untouched by D3.
Nothing is staged, committed, tagged or pushed.

Recommended storage commit:
`fix(auth): isolate owner credentials in private Windows storage`.

Review these paths for that commit:

- `tracker_config/security_location.py`, `tracker_config/security.py`,
  `tracker_config/security_files.py`.
- `manager/app.py`, `manager/owner.py`.
- `tests/auth_fixtures.py`, `tests/test_owner_security.py`,
  `tests/test_security_location.py`, `tests/test_private_storage_verification.py`,
  `tests/test_manager_authorization.py`, `tests/serve_web_studio_fixture.py`, and
  the private-storage fixture/new-test hunks of `tests/test_auth_http.py`.
- `.gitignore`, `README.md`, `tests/README.md`, `docs/owner-security.md`,
  `docs/authentication.md`, `docs/private-owner-storage.md`, this report, and the
  storage-specific notes in `docs/manager-authorization.md` and
  `docs/manager-browser-acceptance.md`.

The earlier fetch correction remains separate: `manager/ui/auth.mjs`,
`manager/ui/app.js`, `tests/manager-auth.test.mjs`, `tests/web-studio.test.mjs`, and
the fetch-receiver HTTP test/import hunks of `tests/test_auth_http.py`. Review
mixed files by hunk rather than staging them indiscriminately. Do not rewrite the
already-pushed authorization commit. Exclude `config/candidates.json`, credentials
and all generated sensitive artifacts. D4 can be considered for explicit approval;
no provisioning is authorized by this verification result itself.
