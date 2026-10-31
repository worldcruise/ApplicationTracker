# UI-C3D: Private Windows owner storage

The default is the current user's Windows Known Folder `LocalAppData`, followed
by `ApplicationTracker/security/security.json`. The resolver calls
`SHGetKnownFolderPath` with the current-user token and flags `0`; it neither trusts
`LOCALAPPDATA` nor derives a Windows username. There is no repository or
working-directory fallback. The owner schema remains version 1.

`tracker_config/security_location.py` is shared by `SecurityRepository`, the
manager's `AuthService`, and every owner administrative command. Path resolution
is lazy: imports and repository construction do not create storage. Manager
startup and authentication/status requests only discover and validate it.

## Storage states

| Validated condition | Authentication status |
| --- | --- |
| No primary/artifacts, safe existing ancestors, private directories can be provisioned | `setup-required` |
| Valid private primary and no legacy conflict | `ready` |
| Unsafe permissions, redirected path, corruption, unreadable discovery, or orphaned recovery evidence | `unavailable` |
| Any old repository credential/recovery artifact, including both old and new stores | `unavailable` |
| HTTP backend cannot be reached | Frontend connection/backend unavailable |

No missing or malformed record is replaced with an empty owner. The original
fetch receiver correction and the distinction between browser execution errors
and network failures remain intact. Business APIs still require an owner session.

## Directory and file protection

Only the explicit local `owner.py init` operation provisions missing directories,
after validating setup inputs and before writing the first account. It calls
`CreateDirectoryW` with a protected security descriptor in `SECURITY_ATTRIBUTES`.
Both new directories initially grant full access only to the current Windows
user, Local System and local Administrators. There is no intermediate inherited
public DACL and no ACL repair of existing directories.
The OS Local AppData folder itself must already exist; setup never creates or
repairs a missing Known Folder.

Validation checks every path component for symlinks/reparse points. ACL validation
starts at the OS-resolved current-user profile (the trusted account boundary) and
continues through every existing ancestor to the security directory. Explicit
locations outside that profile are checked from their volume root and can be
rejected conservatively. Existing ancestors may be readable by others, but cannot
grant them dangerous write/delete/ownership/DACL rights. The nearest existing
parent must explicitly permit the user to create a subdirectory before missing
storage is reported as provisionable. No parent permissions are changed.

The security directory, and the default `ApplicationTracker` directory, require
protected DACLs, direct current-user full control, and no effective grants to
unexpected principals, including read access. Deny entries in private/create
access checks and unsupported ACE formats require explicit review and fail
closed. Files/backups/recovery artifacts require trusted ownership, no unexpected
principal access, no hard links, and no reparse points. Checks repeat during reads
and writes, including immediately before atomic replacement. Unix mode bits are
not used as a Windows ACL substitute.

The private-file writer, validation, revision checks, backup rules, filesystem
locking, PBKDF2 verifier and auth epoch/generation remain in use. A failed
provisioning operation may leave a validated private empty directory; no cleanup
changes parent ACLs or removes unrelated files. Retry is allowed only after
validation. A surviving credential/temp/recovery artifact blocks new setup.
Writes to multiple files are not a group transaction.

This boundary trusts the local Windows account and administrators. It does not
protect credentials against malicious code running as that same account. No
global account permissions or system-wide settings are changed.

## Overrides and commands

Both manager and administration accept an **absolute local directory** through
`--security-dir`. Owner commands also accept `--config-dir` as a compatibility
alias for the security directory; it no longer means the candidate directory.
Relative, traversal, UNC/device and ambiguous Windows name/stream paths are
rejected. Overrides undergo the same ACL and legacy checks. Use the identical
override on manager startup and on every administrative command. There is no HTTP
endpoint for changing this location. Non-Windows defaults are unsupported; an
explicit location has POSIX permission checks, not verified on this Windows host.

These production commands are for **D4 after separate approval**, not D2:

```powershell
py -3.13 -B manager/owner.py init --username local-owner
py -3.13 -B manager/owner.py verify-password --username local-owner
py -3.13 -B manager/app.py
```

`init` uses hidden input and confirmation, refuses replacement, and prints the
selected directory after success. Do not run it to repair a corrupt account.
`reset-password` and `recover-backup` use the same default/override and existing
explicit confirmations. They preserve identity and revoke sessions by changing
the authentication generation/epoch. They do not provision a replacement store.
The manager still uses a random loopback port; no port migration is included.

For D4 review, inspect the reported directory/file with `Get-Acl` or `icacls` and
the repository's own validation; a directory name alone is not evidence of
privacy. Then inspect `GET /api/auth/status` at the manager's printed URL:
`setup-required` before authorized initialization, `ready` afterward. Test login
with correct and incorrect credentials, then logout. Chrome acceptance and
interactive password entry remain separate manual checks.

## Legacy installations: explicit offline migration only

Discovery inspects names/metadata in this checkout's old `config/` location. It
does not read legacy verifier contents to make a status decision. The following
case-insensitive names block startup/setup: `security.json`, `security.json.*`,
and `.security.json.*` (backups, retained recovery and interrupted writes).
Unreadable legacy metadata also fails closed. An explicit override does not
bypass this conflict. Unknown historical custom directories cannot be discovered
automatically; an administrator must inventory them before relocating an owner.

No migration command or automatic migration is implemented. Do not initialize a
second owner, reset credentials, edit generation numbers, or delete old evidence
to make the new location start. For a separately approved migration:

1. Stop the manager and all administrative processes. Inventory the old primary,
   backup and recovery artifacts, including any custom historical location.
2. Validate source ownership/ACLs and the complete record using the existing
   validator. Resolve corrupt/ambiguous records with separately approved recovery
   first. Retain a private offline copy; never publish verifier bytes in logs.
3. Provision and validate the destination using the native private-directory
   helper in a reviewed offline migration operation. Do not use owner `init`.
4. Use the private atomic writer to copy the validated record bytes, preserving
   `backendId`, user ID, verifier, timestamps, `authEpoch` and `authGeneration`.
   Recheck the original revisions before replacement and verify destination
   bytes, schema and ACLs. Handle backups/artifacts explicitly; no multi-file
   atomic guarantee applies. If interrupted, keep both copies and fail closed.
5. After successful verification and separate approval, retire the old active
   credential/artifact paths into validated private offline archival storage.
   Do not erase them automatically or move candidate files. Until the old names
   are retired, the manager intentionally refuses either-store ambiguity.
6. Restart the manager, verify `ready`, authenticate and confirm the same owner
   and backend identities. Restart invalidates old in-memory sessions.

No legacy owner was found on the inspected laptop, and no migration was performed.

## D2 verification boundary

Tests inject Known Folder providers rooted in temporary directories. The binding
test verifies current-user flags and memory cleanup using synthetic API results;
it does not select production Local AppData as a fixture. Native Windows ACL
creation/inspection runs on real temporary directories, including rejection of
broad grants, inheritance, unsafe ancestors and redirected paths. Two subprocesses
exercise concurrent first setup. Real loopback HTTP tests exercise default-path
factory integration, login and reset revocation with synthetic owners, plus
legacy conflicts and corrupt storage. Candidate fixtures are separate.

An additional read-only call to the real Windows Known Folder API resolved
`C:\Users\Honey\AppData\Local\ApplicationTracker\security`; both the
`ApplicationTracker` parent and `security` child were absent. This was only a path
and existence check, not production provisioning or ACL acceptance.

No production directory, owner, credential migration or candidate modification
is part of D2. Real Chrome login, production ACL review/provisioning and interactive
terminal checks remain unverified. See [tests/README.md](../tests/README.md) for
commands and [manager-browser-acceptance.md](manager-browser-acceptance.md) for
the pending browser checklist. Native Messaging and the clipboard-only hotkey
remain separate, unchanged security boundaries.
