# UI-C1: Local owner storage and administration

UI-C1 supplies local owner storage, password verification and administrative
commands only. **It does not enable login or protect the manager's HTTP APIs.**
UI-C2 now implements backend login and in-memory sessions; see
[authentication.md](authentication.md). Authorization of all existing sensitive
manager routes, the frontend login gate and fixed loopback port belong to UI-C3.
No public account-registration or password-reset endpoint exists.

No real owner account was initialized during development. Candidate configuration,
profiles, prompts, history and extension state were not imported or migrated.

## Storage contract

The CLI defaults to `config/security.json`. `--config-dir` can select another
existing directory for isolated tests or local administration. It is a local CLI
option, not a web-supplied filesystem path. The directory is never created by the
repository. No HTTP route serves these files.

Version 1 has this shape (placeholders are illustrative, not usable credentials):

```json
{
  "schemaVersion": 1,
  "backendId": "<random UUID hex>",
  "authEpoch": "<random UUID hex>",
  "users": [
    {
      "id": "<random immutable UUID hex>",
      "username": "local-owner",
      "role": "owner",
      "passwordVerifier": {
        "algorithm": "pbkdf2-hmac-sha256",
        "iterations": 600000,
        "salt": "<base64, 32 random bytes>",
        "digest": "<base64, 32 derived bytes>"
      },
      "authGeneration": 1,
      "disabled": false,
      "createdAt": "<ISO timestamp with timezone>",
      "passwordChangedAt": "<ISO timestamp with timezone>"
    }
  ]
}
```

Exactly one owner is supported in this version. Owner identity is independent of
candidate identities, extension IDs and the existing manager process token. No
ownership grants or browser bindings are created in UI-C1. The users collection
provides an explicit boundary for a later coordinated multi-user extension; it
does not imply multi-user authentication exists today.

Usernames are stripped, case-folded ASCII names of 3–64 letters, digits, dots,
underscores or hyphens, starting with a letter/digit. Stored usernames must already
be canonical. Passphrases are at least 15 characters and at most 1024 UTF-8 bytes;
their exact whitespace and Unicode bytes are preserved. Hash comparison uses
`hmac.compare_digest`. Verifiers validate their algorithm, cost (600,000–2,000,000),
canonical base64 and byte lengths before hashing. The upper cost bound prevents
corrupt records requesting an unbounded amount of CPU work.

Unknown security fields, missing fields, unsupported versions, invalid timestamps,
duplicate JSON keys, non-finite numbers, invalid UTF-8 and malformed verifiers are
rejected. There is no empty default account and no automatic repair or migration.

## Administrative commands

Run from the repository root in an interactive terminal using Python 3.13:

```powershell
py -3.13 -B manager/owner.py init --username local-owner
py -3.13 -B manager/owner.py verify-password --username local-owner
py -3.13 -B manager/owner.py reset-password --username local-owner
py -3.13 -B manager/owner.py recover-backup --username local-owner
```

These commands affect only owner-security files in the selected directory. They
do not start the manager, open a browser, register Native Messaging or modify
candidate records. Use `--config-dir` for a synthetic directory instead of the
default application configuration.

`init` uses hidden password and confirmation prompts. It refuses an existing
primary, backup or interrupted/recovery artifact, including malformed records.
Passwords cannot be passed as CLI arguments or environment options. A terminal
that cannot hide password input is rejected rather than falling back to echoing.
The CLI never prints the verifier, passphrase or full security record.

`verify-password` checks the actual stored verifier and disabled state. It creates
no login session and changes no file. A wrong password returns exit status 1;
success returns 0. Invalid command options return 2; cancellation returns 130.

`reset-password` requires a valid primary, the matching username, the exact typed
confirmation `RESET local-owner`, and a new hidden passphrase twice. It preserves
the immutable user ID, backend ID, account creation timestamp and disabled state.
This is an **OS-authorized administrative reset**, so it intentionally does not
require the old password. Anyone able to run code as this OS user can administer
the local store. It is not a remote password-recovery protocol.

`recover-backup` is for a missing or malformed primary and a valid, private
`security.json.bak`. It requires `RECOVER local-owner` and a new hidden passphrase
twice. A valid primary must use `reset-password`; an explicitly unsupported primary
schema cannot be downgraded. Recovery preserves the backup's owner/backend identity
and retains replaced primary bytes in a private, uniquely named
`.security.json.before-restore.<uuid>` file. The backup is left unchanged. If both
primary and backup are invalid or missing, the command refuses; it does not create
a replacement account. Recovery artifacts require deliberate operator review and
are never consumed as an alternative source of credentials.

Both reset and recovery rotate `authEpoch` and increment `authGeneration`. UI-C2
compares these against the current store on every session verification so reset
invalidates old sessions. UI-C1 itself creates no sessions.
No command silently re-enables a disabled owner or restores an old password.

## Permissions, writes and concurrency

`SecurityRepository` reuses the existing `JsonRepository` validation, serialization,
revision checks and backup behavior with an optional private atomic writer. The
default writer for all existing configuration repositories is unchanged.

Windows uses native DACL inspection/set operations through standard-library
`ctypes`; `chmod` alone is not a Windows privacy boundary. New security files have
protected DACLs granting access only to the current OS user, Local System and local
Administrators. Existing security files and backups must grant no rights to other
principals. The immediate parent must have trusted ownership and no effective
write/delete/permission-change grants to other principals. Unsupported ACL entries
fail closed. Read-only parent access is allowed. POSIX requires trusted ownership,
mode `0600` files and a parent not writable by group/others. That fallback is
implemented but has not been exercised on this Windows environment.

Symlinks, reparse points, hard-linked security records and unsafe existing
permissions are rejected. The repository does not change existing directory/file
ACLs to make a command succeed. If setup reports unsafe permissions, review the
selected directory's OS permissions explicitly before trying again; do not weaken
the checks or relocate candidate data as a workaround. This boundary assumes a
trusted local OS account and trusted path ancestors, not hostile code running as
the same user or an administrator.

Writes use an empty temporary file in the same existing directory, apply and
validate private permissions **before writing credentials**, flush and `fsync`,
recheck the expected revision and atomically replace the destination. A failed
write leaves the original primary intact and cleans its temporary file. Ordinary
reset retains the previous valid primary as `security.json.bak`; those old verifier
bytes remain sensitive and receive the same private permissions.

An in-process lock and a Windows named mutex serialize owner operations across
processes within the Windows logon session. POSIX uses an advisory directory lock.
Initialization rechecks an unclaimed store under that lock. Reset/recovery also
check revisions after interactive input; recovery checks both primary and backup.
This does not promise coordination with arbitrary external file editors or atomic
transactions across several files. A failed primary replacement may leave an
updated valid backup or a private retained recovery copy. Neither is restored
automatically. Interrupted setup artifacts block accidental new-owner creation.

## Safe verification without real application data

The automated suite creates and explicitly privatizes only its own temporary
directories. Synthetic accounts exercise the real PBKDF2 implementation, native
Windows ACL checks, two simultaneous Python setup processes, revision conflicts,
failed flush/replacement, recovery, CLI confirmation and hidden-input failures.
Candidate/profile sentinel files are guarded against even being opened.

```powershell
& 'C:\Users\Honey\AppData\Local\Programs\Python\Python313\python.exe' -B -m unittest discover -s tests -p test_owner_security.py -v
& 'C:\Users\Honey\AppData\Local\Programs\Python\Python313\python.exe' -B -m unittest discover -s tests -v
& 'C:\Program Files\nodejs\node.exe' --test tests/extension-access.test.mjs tests/resume-contract.test.mjs tests/pdf-renderer.test.mjs tests/web-studio.test.mjs tests/hotkey.test.mjs
git diff --check
```

For an optional interactive smoke test, create and privatize a **new disposable**
directory, then pass it explicitly to every command. These commands do not target
`config/`:

```powershell
$ownerTestDir = Join-Path ([IO.Path]::GetTempPath()) ('tracker-owner-review-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $ownerTestDir | Out-Null
$ownerPython = 'C:\Users\Honey\AppData\Local\Programs\Python\Python313\python.exe'
& $ownerPython -B -c "import sys; from pathlib import Path; from tracker_config.security_files import SecurityPermissions; SecurityPermissions().make_private(Path(sys.argv[1]))" $ownerTestDir
& $ownerPython -B manager/owner.py init --config-dir $ownerTestDir --username review-owner
& $ownerPython -B manager/owner.py verify-password --config-dir $ownerTestDir --username review-owner
& $ownerPython -B manager/owner.py init --config-dir $ownerTestDir --username review-owner
```

Enter a synthetic passphrase, verify it successfully, run verification again with
a wrong passphrase (exit 1), and confirm duplicate initialization refuses before a
password prompt. The unit tests cover malformed-record/recovery cases without
asking an operator to damage any real configuration. Interactive terminal hiding
has not been manually checked in this checkpoint; the getpass path is tested with
injected hidden inputs and its echo-warning refusal.

## Legacy boundary and remaining work

Owner storage does not secure the Native Messaging path. Its candidate-name,
extension-ID and active-candidate checks are legacy compatibility checks, not owner
authentication. Clipboard-only hotkey and separate context-menu behavior remain
unchanged. UI-C2 adds login throttling, process-local sessions and logout. Browser
pairing, candidate binding, extension login, the manager authorization transition
and remote-computer transport remain deferred. Real Chrome verification remains
pending independently of these storage and HTTP tests.
