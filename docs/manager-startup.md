# Manager startup: stable loopback address

From the repository root, run the existing launcher `run_app.bat`, or:

```powershell
py -3.13 -B manager/app.py
```

Production always binds to IPv4 `127.0.0.1:8765` and prints:

```text
Application Tracker: http://127.0.0.1:8765/
```

The manager opens that URL in the default browser as before. Keep its terminal
open and use Ctrl+C there for normal shutdown. Owner setup is never automatic;
existing credentials remain in their validated private security directory. The
optional absolute `--security-dir` override is unchanged and does not alter the
network address. No `--host` or `--port` override is offered.

## Port conflicts

If binding or listening fails, startup exits unsuccessfully with a message beginning
`Cannot start Application Tracker at http://127.0.0.1:8765/` and explaining that no
alternative port will be used. It does not open the browser, load owner storage,
kill a process or scan other ports after a bind failure.

On Windows, address/port reuse is disabled and `SO_EXCLUSIVEADDRUSE` is set before
binding. This prevents a second manager from sharing the listening address. A
startup failure after socket creation closes that socket, including authentication
initialization and browser-launch failures. Other platforms also disable reuse.

Use these read-only PowerShell commands to identify listeners:

```powershell
$trackerListeners = @(Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue)
$trackerListeners | Select-Object LocalAddress, LocalPort, OwningProcess
$trackerListeners | ForEach-Object {
    Get-Process -Id $_.OwningProcess | Select-Object Id, ProcessName, Path
}
```

If it is an existing manager, use that instance or stop it with Ctrl+C in its own
terminal before restarting. If another application owns the port, identify it and
resolve the conflict manually through its normal controls. Do not terminate an
unknown process. If no listener appears, review the reported OS error; the port
may be reserved or access denied. No automatic repair is performed.

Automatic port fallback is prohibited because extension discovery must have one
predictable address. The address itself is not authentication or cryptographic
proof of backend identity. Pairing and extension HTTP authentication remain
unimplemented. The backend is not exposed on the LAN.

## Authentication compatibility

Host, Origin, request-token, owner-cookie and business authorization checks are
unchanged. Production requests use Host `127.0.0.1:8765` and, where required,
Origin `http://127.0.0.1:8765`. Use this exact address rather than `localhost`.
The 30-minute idle and eight-hour absolute session deadlines are unchanged.
Backend restart invalidates sessions; sign in again after restarting.

The stable URL has a different browser origin from previous random-port URLs.
Do not expect old tabs or origin-scoped preferences to move automatically.
Cookies remain scoped to the host rather than isolated by port; the trusted-local
HTTP limitations in [authentication.md](authentication.md) still apply.

## Automated verification

`tests/test_manager_startup.py` checks the exact production address, printed URL,
exclusive socket options, clear failure without fallback/process termination,
cleanup on startup/serving failures, rejected network overrides and unchanged
Host/Origin/CSRF checks. Real socket checks substitute an ephemeral test address
at the server factory boundary; they never bind production port 8765 or read
production owner/candidate data. Existing HTTP authorization tests also retain
ephemeral ports and synthetic private security/configuration roots.

```powershell
py -3.13 -B -m unittest discover -s tests -p test_manager_startup.py -v
py -3.13 -B -m unittest discover -s tests -v
```

Checkpoint D4C3 automated results: 13 focused startup tests, 275 total Python
tests and all 200 JavaScript tests passed, with no failures or skips. The full
Python run includes real synthetic loopback authentication and the 20-operation
manager authorization matrix. The new fixed-address assertion was also run
before the implementation and correctly failed on the old port-0 startup.

## Manual Chrome acceptance — not performed by this checkpoint

1. Save any edits and stop the existing manager with Ctrl+C in its terminal.
2. Start the manager with the command above. Confirm the exact printed URL.
3. Open `http://127.0.0.1:8765/` in Chrome. For an already initialized, safe owner
   store, expect Sign In. A missing owner still produces Setup Required; do not
   initialize or reset an owner as part of this port check.
4. Inspect safe authentication status fields in PowerShell:

   ```powershell
   Invoke-RestMethod 'http://127.0.0.1:8765/api/auth/status' |
       Select-Object state, managerAuthorizationEnforced
   ```

   An existing valid owner should return `ready` and `True`.
5. Before login, use DevTools on this origin to request `/api/state` with no
   authenticated cookie. Expect 401 and no candidate data. If a cookie already
   exists, sign out first; do not clear or reset owner credentials.
6. Sign in using the existing owner account, then verify Home and the existing
   workspaces. Confirm `/api/state` succeeds only with the verified session. Do
   not edit real candidate records during acceptance.
7. Leave the first manager running. In a second terminal, run the same command.
   Expect a clear port-conflict error and nonzero exit, no alternate URL/browser
   launch, and the first manager remaining usable. In PowerShell, inspect
   `$LASTEXITCODE` immediately after the failed command; it should be nonzero.
8. Close the second terminal, then stop/restart the first manager normally. Open
   the same fixed URL and confirm reauthentication is required.

Record Chrome and production-port results separately from automated ephemeral-port
tests. No installed extension reload, registration or pairing is needed here.
