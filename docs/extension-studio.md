# Web Extension Studio

Extension Studio is the web platform's integration-management page. Open it from
the top navigation, Home's toolkit, or `/extension-studio`. It uses the existing
dark shell, responsive panels, accessible forms and guarded navigation. The
existing extension-origin `studio.html` remains the standalone file-access page.
These pages have different responsibilities.

## Backend address prerequisite

Production manager startup now uses `http://127.0.0.1:8765/` exclusively. An
occupied or unavailable port stops startup; no port scanning, fallback or process
termination occurs. See [manager startup and manual acceptance](manager-startup.md).
The existing runtime diagnostic still returns public package metadata only. The
stable address does not implement pairing, extension login, candidate bindings or
authenticated extension HTTP access, and is not proof of backend identity.

## Implemented capabilities

D5B adds [private browser pairing and candidate bindings](browser-pairing.md) to
this existing page. Owner-authenticated routes manage pending requests,
approval/denial, explicit candidate assignment and revocation.
The [D5B2 pre-login enrollment transport and packaged client](extension-enrollment.md)
are implemented separately. Enrollment/login UI and the two-tab extension UI
remain pending.

| Area | Current behavior |
| --- | --- |
| Connection | Save this installation's extension ID and explicitly request a runtime diagnostic response |
| Workspace preferences | Select the actual setup-page address copied by this UI and whether copying asks for confirmation |
| Device settings | Save a computer label, installed extension ID and diagnostic timeout |
| Capture/bidding | Explain current legacy behavior and the missing operation/save services; no inert preference controls |
| Candidate binding | Owner approves an individual browser request and assigns/reassigns its candidate here; no extension picker or active-candidate mutation |
| Files | Prepare/copy the existing extension page's address; grants remain inside the extension |
| Diagnostics | Display packaged version/bridge declaration, actual API-load outcome and optional browser response; copy a non-sensitive report |

The extension login transport/UI, enrollment UI and extension resume workspace,
bid-root selection, artifact saving, heartbeats and registered computers
are **not implemented** by this page. Private pairing administration is implemented;
it does not prove an installation is online. No Connected badge is inferred from local
package files or saved settings. The existing global-active/native capture path
remains labeled legacy compatibility behavior; it was not adopted by new settings.

## Persistence and ownership

Both new record types use schema version 1 and the existing `JsonRepository`:

- `config/extension-studio.json`: workspace-owner setup preferences with
  `setupPage: "file-access" | "legacy-popup"` and boolean `confirmSetupCopy`.
- `config/local/extension-studio.json`: this local backend installation's device
  settings: optional draft `id`, `label`, `extensionId` and `probeTimeoutMs`.
  The backend generates a stable ID on the first explicit device Save. It is a
  setup identifier, not hardware verification, pairing or registered-computer auth.

Defaults are in memory only. Loading/constructing repositories creates no files.
The device label is at most 80 characters. Extension ID is empty during setup or
exactly 32 lowercase letters a–p. Timeout is an integer from 1000 through 15000 ms.
Paths, candidate selections, capture actions, credentials and client-selected
device IDs are not accepted in these write payloads.

The workspace uses the existing authenticated single local owner. The two files
separate preference scope from machine-local setup, while browser credential
digests remain in private security storage. Multi-user synchronization is not
implemented. Future registered computers
need an authenticated mapping, not merely a copied device file. Browser handles
remain in extension-origin IndexedDB and are not placed in either JSON record.

Saves validate, preserve unknown stored metadata, require the observed revision,
retain the previous valid backup and atomically replace one file. A stale write
returns 409; invalid fields return 400. Malformed existing files are never reset
to defaults. Saving one form retains unsaved changes in the other form. There is
no transaction across both files. The candidate registry, IDs, assignments,
history roots, prompts and root schema version are untouched.

## API and routing

- GET `/api/studio/extension`: preference/device snapshots and package diagnostics.
- PUT `/api/studio/extension/preferences`: `{data, revision}` with targeted setup fields.
- PUT `/api/studio/extension/device`: `{data, revision}` with targeted device fields.
- GET `/extension-studio`: the existing HTML shell; initialization selects the page.
- GET `/extension-studio.mjs`: exact read-only UI resource.

The existing Host, Origin and session-token checks protect writes. No CORS rules
or shared-resource wildcard route were added. No request can supply a destination
path. The extension does not gain direct access to these write endpoints.

## Runtime diagnostics and security boundary

The manifest permits external messages only from `http://127.0.0.1/*`.
`background.js` loads `integration-diagnostics.js`; its synchronous listener checks
the page URL/origin, rejects extension senders and accepts only
`{type:"tracker:diagnostics", protocolVersion:1, nonce}`. Only the manager page
paths `/` and `/extension-studio` are accepted. Other loopback services at those
paths can request the same **public package metadata**; this is not authentication.

The reply contains only protocol version, the nonce, runtime extension ID and
manifest version. It reads no registry, profile, storage, handle, native-host
status or captured page. It cannot start capture, open tabs or write files.
The web client checks the matching nonce/ID/protocol and applies the saved timeout.
No broad host permission, CSP relaxation, remote script or dependency was added.

See Chrome's official [external-message manifest reference](https://developer.chrome.com/docs/extensions/reference/manifest/externally-connectable)
and [match-pattern reference](https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns).

Status wording deliberately distinguishes:

- Backend reached on a successful settings load.
- Package available, which is only a local source-file observation.
- Browser not checked until an explicit user action.
- Extension responded, with a check timestamp, which is not a heartbeat or pairing.
- Response unavailable, including unsupported runtime, timeout and protocol errors.
- Native host/capture and folder permissions not tested by this probe.

Reloading, editing device settings or leaving the page invalidates earlier probe
results. Late responses cannot restore stale status. Diagnostics omit prompts,
profiles, candidate lists, local paths and session tokens.

## Verification

Automated baseline: **128 Python tests and 128 JavaScript tests pass**. New tests
exercise navigation, defaults without writes, both setting scopes, stable IDs,
validation, unknown-field preservation, stale/failed writes, malformed JSON,
authorization, route containment, loading/error recovery, concurrent form drafts,
clipboard confirmation/failure, probe timeout/protocol checks and sender rejection.
Existing Home, Candidates, profile, renderer, capture and filesystem-access tests
remain. VM/mocked runtime tests do not prove an installed Chrome extension exchange.

```powershell
& 'C:\Users\Honey\AppData\Local\Programs\Python\Python313\python.exe' -B -m unittest discover -s tests -v
& 'C:\Program Files\nodejs\node.exe' --test tests/extension-access.test.mjs tests/resume-contract.test.mjs tests/pdf-renderer.test.mjs tests/web-studio.test.mjs
git diff --check
```

Synthetic headless Chrome captures at 1650 × 900 and 390 × 900 show the
[desktop workspace](screenshots/extensions-desktop.png) and
[narrow workspace](screenshots/extensions-mobile.png). Home/Candidates, actual
resume PDF, multi-page preview and template-library captures were also repeated.
No real configuration, prompt/history folders or installed extension was used.
Only the isolated fixture server and disposable browser profile were launched.

Manual checks still required, using disposable data first:

- [ ] Restart the manager to load the new Python routes; verify `/extension-studio`
  survives reload and navigation updates the URL correctly.
- [ ] Reload the updated unpacked extension while preserving its installed ID.
  Save that ID here and check for a genuine response in the same Chrome profile.
- [ ] Disable/reload the extension, use an incorrect ID and verify useful failures.
- [ ] Confirm the probe never starts a capture or contacts the native host.
- [ ] Verify persistence, 409 conflict recovery and dirty-form warnings in two tabs.
- [ ] Copy both setup addresses; verify browser clipboard permissions and cancellation.
- [ ] Open the extension's access page; separately verify grants/reconnection there.
- [ ] Check keyboard focus, screen-reader announcements and native mobile layouts.
- [ ] Verify legacy context-menu/shortcut capture and native registration separately
  under an authorized disposable integration setup.

Candidate selection for new job operations must be implemented in the extension
when the operation starts, with explicit stable candidate IDs. There is no claim
that the current legacy global-active gate meets that future requirement.

## Files changed for this workspace

- Manager: `manager/app.py`, `manager/ui/index.html`, `studio-app.mjs`, `styles.css`,
  and new `manager/ui/extension-studio.mjs`.
- Persistence: `tracker_config/models.py`, `repositories.py`, `web_studio.py`.
- Extension: `extension/manifest.json`, `background.js`, and new
  `extension/integration-diagnostics.js`.
- Tests: new `tests/test_extension_studio.py`, `web-studio.test.mjs`,
  `web-studio-browser-fixture.mjs`, `capture-web-studio.mjs`.
- Documentation: `README.md`, `docs/configuration.md`, this document,
  `tests/README.md`, and synthetic captures/measurements under `docs/screenshots/`.

Existing user modifications and real candidate data were preserved. No dependency
installation, commit, push or real native-host registration was performed.
