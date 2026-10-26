# Standalone Studio filesystem access

Phase 3 adds a read-only access-management page to the existing extension.
**Chrome verification has not been performed.** The checklist below is deliberately
unchecked. No browser, application server, registration script, or real candidate
file was used during implementation or automated testing.

## Entry point and compatibility

The existing popup has an **Open Studio file access** link that opens
`studio.html` in its own extension tab. The popup's candidate-name form and its
JavaScript are unchanged. The manifest, background service worker, context menu,
shortcut, Native Messaging calls, archive writes, and clipboard behavior are
unchanged. The Studio page does not select or activate a legacy candidate.

The dedicated page is needed because pickers and permission requests require a
visible document and user activation. No picker runs in the background worker.
No new manifest permission or web-accessible resource declaration is required
for this internal extension page. See the [File System Access specification](https://wicg.github.io/file-system-access/).

New files:

- `extension/studio.html`, `studio.css`, `studio.js`: access UI and orchestration.
- `extension/studio/contracts.mjs`: version-1 registry/profile/catalog readers,
  strict JSON parsing, and configured-reference keys.
- `extension/studio/handles.mjs`: direct IndexedDB handle persistence.
- `extension/studio/access.mjs`: explicit selection, restoration, permissions,
  coherent-read checks, and live prompt reads.

Phase 4B catalog validation also uses `extension/shared/document-settings.mjs`
and its shipped JSON capabilities. These JSON-module imports require Chrome
123+. The separately implemented [PDF renderer](pdf-renderer.md) has no access-page
UI or save integration yet. The existing legacy popup/background are unaffected.

Studio never calls the manager, a network service, or Native Messaging. It has
no filesystem write, registry-save, profile-edit, directory-creation, or export
interface. It requests a read/write directory grant for the future editing
workflow but only reads files in this phase.

## Configuration access

**Select Configuration Folder** calls `showDirectoryPicker` directly from the
button action. A selected folder must be readable and contain an existing valid
`candidates.json` with schema version 1. The selected configuration is the
authority; there is no imported or independently editable candidate registry.

The reader also loads optional `prompt-templates.json`, `document-templates.json`,
and `profiles/<candidate-id>.json`. Missing catalogs have the documented empty
in-memory defaults. Missing profiles are unconfigured (`null`), not fabricated
profile data. Existing optional records must satisfy their version-1 contracts;
profile IDs must match their filenames. Managed references, when present, must
resolve to available, unarchived records. Malformed optional data blocks accepting
the attempted configuration and identifies the problem.

No absolute path is used to open configuration. All child reads use the selected
directory handle with `create: false`. History paths are validated as metadata;
history directories are never accessed. A wrong folder, bad registry, failed
storage transaction, or canceled picker does not replace a previous valid
selection. Reselecting the same directory preserves its scope when
`isSameEntry()` confirms it is the same entry.

Refresh reacquires files from the directory, including files replaced by Python.
The reader hashes each observed file and rechecks it after loading, including
the absence of optional files. Observed changes reject the attempted snapshot
and ask for another refresh. Prompt reads also check the registry before and
after reading so a changed candidate prompt reference cannot silently use an old
association. Failed configuration access invalidates displayed candidate data.

These checks do not establish an atomic multi-file snapshot. A writer can change
a file after the final check. There are no browser writes in this phase, so no
stale registry/profile data is written back. Future editing needs explicit
revision checks and coordination with Python's separate write operations.

Configuration JSON must be valid UTF-8, have unique object properties, contain
finite numbers, and remain within a 5 MiB per-file read limit. This limit is an
access-reader resource bound, not a migration or alteration of existing records.
The browser validators are exercised against synthetic Python contract fixtures
and Unicode case-equivalence classes; this is not exhaustive schema equivalence
for every possible representation of JSON numbers or ISO timestamps.

## Prompt authorization and live content

The confirmed legacy contract is preserved: **`promptTemplate` is a relative
file reference, not literal inline text**. The manager's pasted prompt is read
from that file under `templates/` in the authorized configuration directory.
It needs no separate external picker. When both legacy fields exist, the
existing nonempty `promptFilePath` preference remains in effect.

An external `promptFilePath` is only a configured reference. **Link Prompt File**
opens `showOpenFilePicker` from the user's click and associates the selected
existing file with that reference. The UI shows both the configured reference
and the selected filename. It explicitly does not claim to independently verify
the selected file's physical absolute path, and permits a relinked/moved file to
have a different name. Nothing is copied, imported, or rewritten.

External files must be `.txt` or `.md`, no larger than 512,000 bytes, valid UTF-8,
and nonempty. The size bound matches the manager's linked-file validation limit.
The body is returned intact, including whitespace and line endings; it is not
shown in the access UI, transformed into JSON, logged, or stored in browser
persistence. Each check/read calls `getFile()` again. Missing, changed-invalid,
or revoked files cannot fall back to an old cached body.

Configured-reference keys normalize ordinary Windows drive-letter case,
separators, and dot components. They preserve path-component case, Unicode, and
trailing characters to avoid merging distinct references in case-sensitive
directories. UNC and verbatim namespaces remain distinct. Some equivalent
spellings therefore deliberately need separate associations rather than risking
a collision. Keys include a configuration scope, so identical reference strings
in different configuration selections cannot share handles accidentally.

## IndexedDB and permissions

The extension-origin database is `application-tracker-studio-access`, version 1,
with the `handles` object store (`keyPath: "key"`). Records have `schemaVersion: 1`,
a structured key, `kind`, configuration `scope`, and the direct handle object.
The directory slot API can later support another directory kind, but there is
no bid-root UI or save operation here.

Handles are stored through IndexedDB's structured clone, never JSON,
`chrome.storage.local`, or extension messaging. No registry/profile/prompt body
is persisted. Transaction completion, rather than request success, determines
whether a new mapping was committed. Corrupt records, unavailable storage,
blocked upgrades, failed transactions, or unusable handles report recovery
actions. The service supports removing prompt mappings without deleting files.

File/directory handles can be persisted in IndexedDB, but their permission may
need renewal. See the [Chrome file-access guide](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access).
Extension pages and the worker share the extension origin's IndexedDB; this does
not share grants with a separate web origin. See [Chrome extension storage](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies).

On load, Studio retrieves stored handles and queries permission. It never asks
for permission automatically. Reconnect buttons use handles already retrieved
in this page, invoking `requestPermission` before unrelated asynchronous work
can consume user activation. Reconnection is reported as successful only after
configuration or prompt contents have actually been read and validated.

Status codes distinguish `folder-not-selected`, `permission-renewal`,
`permission-denied`, `folder-invalid`, `configuration-missing`,
`configuration-invalid`, `configuration-changed`, `prompt-unlinked`,
`prompt-invalid`, `prompt-unavailable`, and stored-handle/storage failures.
Picker cancellation is a neutral outcome and preserves the prior selection/link.

## Automated verification

Use the installed Node.js and Python interpreters; there are no dependencies to
install. `tests/extension-access.test.mjs` uses in-memory handles and a deliberately
small IndexedDB transaction fake. It does not prove browser structured-clone,
permission, picker, persistence, or lifecycle behavior.

```powershell
& 'C:\Program Files\nodejs\node.exe' --test tests/extension-access.test.mjs
& 'C:\Program Files\nodejs\node.exe' --check extension/studio.js
& 'C:\Program Files\nodejs\node.exe' --check extension/studio/access.mjs
& 'C:\Program Files\nodejs\node.exe' --check extension/studio/contracts.mjs
& 'C:\Program Files\nodejs\node.exe' --check extension/studio/handles.mjs
& 'C:\Users\Honey\AppData\Local\Programs\Python\Python313\python.exe' -B -m unittest discover -s tests -v
git diff --check
```

The full unittest command retains all 61 earlier cases and adds Node-suite and
cross-runtime contract checks. If Node is unavailable, only those two new cases
are skipped with an explicit explanation; no installation is attempted. Node
subprocesses run from test-owned temporary working directories and only read
extension/test source plus supplied synthetic fixtures.

## Manual Chrome verification checklist — not run

Use a disposable configuration directory and disposable external prompt file
first. Do not point these checks at real candidate data. A registry fixture can
use a stable synthetic ID, an invented name, a syntactically valid 32-letter
extension ID, an unused absolute history path, and
`promptTemplate: "templates/<synthetic-id>.txt"`. Create that fixture prompt file
and a separate linked `.md` file manually. Nothing needs to exist at the history
path, because Studio must never open it.

- [ ] Record Chrome version and OS. Reload the intended unpacked extension
  without changing its installation path or ID. Confirm the old popup still has
  its name form, and the new link opens a stable extension tab.
- [ ] Keep the Python manager/server closed. Open Studio and select the disposable
  configuration folder. Confirm the read/write grant, successful registry status,
  correct candidate count, and no filesystem changes.
- [ ] Cancel a first selection, then cancel reselection after a valid selection.
  Confirm no error toast and no change to the valid stored folder.
- [ ] Select a wrong folder, a missing registry, malformed JSON, and an unsupported
  schema version. Confirm clear errors and preservation of the old valid selection.
- [ ] Reload the Studio page. Confirm the stored directory is retrieved. It may
  load immediately only with a valid grant; otherwise it must show Reconnect.
- [ ] Restart Chrome and reload the extension separately. Check restoration and
  any required user-activated permission renewal. No automatic permission prompt
  should appear. Do not assume persistence from one successful reload.
- [ ] Revoke the configuration grant through browser controls. Refresh and confirm
  stale candidates disappear. Use Reconnect or Reselect; success must require a
  real configuration read. Remove/rename the disposable folder and verify recovery.
- [ ] Confirm the saved pasted prompt reads through the config-relative path and
  never opens an external picker. Delete only the disposable prompt and check
  that a clear missing-file status appears.
- [ ] Configure a disposable external `.txt`/`.md` reference. Confirm selecting
  `config/` alone does not authorize it. Use Link Prompt File, confirm the explicit
  reference/filename association, then reload the page and check restoration.
- [ ] Cancel Relink and select an empty, invalid UTF-8, wrong-extension, and oversized
  disposable file. The prior valid mapping must remain. Check filename differences
  are described as associations, not verified physical paths.
- [ ] Change the linked file's text, click Check Prompt File, and confirm the new
  read succeeds. Make it empty/invalid or delete it and confirm failure, with no
  stale-body fallback. Revoke its permission and test explicit recovery/relinking.
- [ ] Replace the disposable registry/profile/catalog from an external editor
  between reads, then Refresh. Confirm updated contents are loaded or an observed
  concurrent change asks for another refresh. No replacement registry is created.
- [ ] With the manager closed and the native host unavailable to Studio, verify
  selection, refresh, prompt linking, and prompt checks still work. Inspect network
  activity only for the packaged page resources, with no local-server requests.
- [ ] In a separately authorized legacy test using disposable candidate/history
  data and an already working native-host setup, verify popup name-saving,
  context-menu and shortcut capture, duplicate-company behavior, MHTML/metadata,
  and returned-prompt clipboard copying remain unchanged. Legacy native-host
  unavailability must retain its existing legacy error behavior.
- [ ] Confirm prompt bodies/profiles are absent from console output and persistent
  browser records. Inspect IndexedDB to verify direct handle objects and no JSON
  copies of the registry or prompts. Check narrow/wide layouts, keyboard focus,
  accessible labels, and status/error announcements.

No checklist item is claimed as verified by automated Node/Python tests.
