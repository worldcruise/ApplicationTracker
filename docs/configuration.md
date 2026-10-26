# Configuration and persistence foundation

This documents the Phase 2 foundation and Phase 5 web integration. The design reference is
`docs/Updating Plan.md` (that is the actual filename). No live configuration is
created, migrated, imported, or repaired by importing the application or repository
modules. New files are created only by explicit repository saves.

## Sources of truth

| Data | Authority |
| --- | --- |
| Candidate identity, name, active selection, history path, extension ID | `config/candidates.json` |
| Existing linked prompt | Original `promptFilePath`, reread by the native host |
| Existing pasted prompt | File referenced by `promptTemplate`, normally `templates/<candidate-id>.txt` relative to `config/` |
| Structured profile | `config/profiles/<candidate-id>.json`, explicitly created |
| Managed prompt | `config/prompt-templates.json`, explicitly created |
| Visual template metadata | Optional `config/document-templates.json`; supported built-ins also exist in memory |
| Captured pages and metadata | Existing external candidate history folders |
| Extension setup preferences for the current workspace owner | `config/extension-studio.json` |
| Machine-local extension setup record | `config/local/extension-studio.json` |

The legacy field named `promptTemplate` is a relative file reference, not an
inline JSON prompt body and not a managed-template ID. The manager's paste-text
workflow stores its text in that file. When both legacy fields are present, the
native host retains its existing preference for a nonempty `promptFilePath`.

There is no second candidate registry. Profiles do not copy candidate names,
history paths, extension IDs, or prompt assignments. Consumers join profile data
to identity by `candidateId` and obtain the full name from the registry.

## Candidate registry: existing schema version 1

The root retains `schemaVersion: 1`, `activeCandidateId` (an existing ID or null),
and `candidates`. Candidate records retain `id`, `name`, `historyFolder`,
`extensionId`, and the legacy prompt fields. Loading does not normalize, rewrite,
add timestamps, assign templates, or move files. Explicit saves may reformat JSON
as indented UTF-8 with a final LF; they preserve the decoded records.

Validation checks root/record types, unique IDs, name/extension pairs, lexical
history-path uniqueness, absolute history/linked-prompt paths, safe relative
template paths, extension-ID syntax, and active-reference integrity. It never
tests external folders or reads prompt files. The existing manager's explicit
folder/prompt checks remain responsible for accessibility when saving a candidate.

Unknown registry and candidate properties are retained as JSON values. Editing
starts with the existing candidate and changes only the legacy form's fields.
Switching prompt modes still removes the opposing legacy prompt field, as before.

Two optional candidate properties are recognized:

- `assignedPromptTemplateId`: stable managed-prompt ID or null.
- `preferredDocumentTemplateId`: stable document-template ID or null.

Phase 5 adds targeted `update_candidate_settings` repository writes with explicit
registry revisions. They validate only changed assignments, retaining existing
archived references during unrelated edits. Supported Classic/Modern IDs resolve
against in-memory shipped defaults when absent from the optional document catalog.
Unsupported document layouts/versions cannot be newly assigned for rendering.
Reads do not create catalogs. See [web-studio-verification.md](web-studio-verification.md)
for APIs, edit/archival policy, UI behavior and unchecked browser verification.

Neither is populated automatically or used to change legacy prompt generation.
Legacy CRUD and the native host validate their identifier syntax but do not load
managed catalogs. Thus optional, missing, or malformed catalog files cannot break
legacy capture. Studio callers explicitly use `validate_references(candidate)` or
`save_registry(data, expected_revision=...)` to reject missing/archived template
references before consuming them or writing new assignments.

Stable identifiers use 1–100 ASCII letters, digits, underscores, or hyphens,
starting with a letter or digit. Windows device names such as `CON` and `LPT1`
are rejected. Existing generated 32-character UUID IDs already fit this contract.

`migrate_candidate_registry` validates version 1 and returns an independent,
unchanged copy. It is intentionally an identity migration. Other root versions
are rejected; there is no automatic conversion from an unknown format and no
approved schema-version upgrade.

## Structured profiles: schema version 1

`empty_profile(candidate_id)` creates a draft in memory with the following required
sections. It never extracts content from prompts or saves a file.

| Field | Shape |
| --- | --- |
| `schemaVersion` | Integer `1` |
| `candidateId` | Existing stable registry ID; must match the filename |
| `personal` | Optional text `birthday`, `headline`, `summary`; nonempty birthday must be an ISO date |
| `contact` | Optional text `email`, `phone`; optional `links` array of `{label, url}` text records |
| `address` | Address object |
| `workExperience` | Array of `{id, company, title, period, address, highlights}` |
| `education` | Array of `{id, university, degree, major, period, address}` |
| `skills` | Array of `{category, items}`; items are strings |
| `certifications` | Array with unique `id` and text `name`; optional `issuer`, `issuedOn`, `expiresOn`, `credentialUrl` |
| `customAnswers` | Optional text `reasonForLeaving`, `noticePeriod`; optional `prompts` array of `{id, text}`; optional `answers` array of `{id, question, answer}` |
| `preferences` | Optional text `startDate`, separate from read-only answers |

An address accepts text `line1`, `line2`, `city`, `state`, `postalCode`, and
`country`. A period accepts text `start` and `end`, plus boolean `current`.
Work-experience highlights are strings. Entries in work, education,
certifications, and custom prompts have unique IDs within their section.

Draft sections may be empty. Validation is structural, not a claim of profile
completeness, verified employment, deliverable email, or chronological accuracy.
Periods and preferred start dates preserve entered text, allowing partial dates.
Phase 5 preserves additional noncredential JSON properties at profile/entry/nested
boundaries, while still validating all known fields. The editor changes only the
edited properties and keeps unexposed collections. Q&A records have unique stable
IDs, nonblank questions and complete text answers. Credential property names
(`password`, `passwords`, `credential`, `credentials`, `accessToken`, `refreshToken`,
`secret`, case-insensitive) are rejected recursively. Credential management remains
separate. This additive extension retains profile schema version 1.

`ProfileRepository` verifies the candidate exists and confines destinations to
`profiles/`. Reads, writes, and recovery reject a record whose candidate ID does
not match its filename. Candidate deletion does not silently delete new profile
files or catalog records; orphan cleanup is deferred.

## Managed prompts: catalog schema version 1

The catalog root is `{"schemaVersion": 1, "templates": []}`. Each record has:

- Stable `id`, nonempty `name`, text `description`, and complete nonempty `body`.
- Positive integer `version`, optional text `category`.
- Boolean `isDefault` and `archived`. At most one template is default; an archived
  template cannot be default.
- `createdAt` and `updatedAt`: ISO timestamps with timezones, with update time not
  preceding creation time.

Prompt-body whitespace, CRLF/LF characters, Unicode, and code fences round-trip
exactly as text. Validation checks for an empty body but does not trim or rewrite
it. Additional JSON metadata is preserved. The repository still accepts explicit
catalog versions; the Phase 5 editor issues IDs/timestamps and increments edited
record versions through `ConfigurationRepositories.save_prompt`. Switching the
default versions both affected records. No version-history store is introduced.

Saving a managed catalog never reads, imports, merges, overwrites, or deletes a
legacy prompt. In Phase 5, managed assignment resolves for new web resume prompt
composition only. Legacy captures still resolve the original file. Archived or
missing assignments remain referenced and require an explicit choice; there is
no implicit fallback. Explicit prompt import remains deferred.

## Document templates: catalog schema version 1

The root is also `{"schemaVersion": 1, "templates": []}`. Each record has stable
`id`, nonempty `name`, text `description`, positive integer `version`, a symbolic
`layoutId`, and object fields `supportedSettings` and `defaultSettings`.

The Phase 5 UI correction adds explicit document-configuration CRUD through
`ConfigurationRepositories.save_document`. New records use a custom stable ID,
supported Classic/Modern `layoutId`, `rendererVersion: 1`, a positive editing
`version`, optional boolean `archived`, timestamps and validated settings. Built-in
IDs are read-only; copying creates a record only on explicit Save. Editing preserves
unknown metadata. Archiving retains candidate references and requires a subsequent
explicit assignment change. Schema version 1 and older metadata-only records remain
compatible. The new header/color/line-height/visibility capabilities are additive;
see [pdf-renderer.md](pdf-renderer.md) for all 17 actual settings.

Template assignments now live exclusively in the Candidate Add/Edit UI. Its
optional `registryRevision` and reference fields use the same repository validation
as the existing targeted settings method. Unknown fields and unchanged unavailable
references are retained. Invalid new references fail before legacy filesystem
checks/writes. Libraries and per-resume choices do not assign candidate defaults.

Phase 4B supports validated settings for the shipped `classic` and `modern`
layouts: body font size, uniform margin, section spacing, accent color and page
numbers. Their capability descriptors and default values live in the shared
`extension/shared/document-layouts-v1.json`. Defaults/overrides must use declared
supported keys and satisfy the shipped ranges/types. Other layout IDs remain
metadata only and require empty settings. See [pdf-renderer.md](pdf-renderer.md).
No layouts or sample catalog records are seeded or persisted automatically.

Optional `thumbnail` metadata accepts a text `reference`, timezone-qualified
`generatedAt`, and positive integer `templateVersion`. No thumbnails are generated
or loaded by this phase.

No `app-settings.json` is introduced. The existing application has no persisted
global theme preference to justify it yet. Candidate preferences remain separate.

The web Extension Studio now has two narrowly scoped version-1 setting records,
separating workspace setup preferences from a local installation record. They use
the same JSON repository/revision/backup boundary and are created only on explicit
Save. They contain no candidate registry copy, filesystem handles or credentials.
See [extension-studio.md](extension-studio.md) for the actual settings, endpoints,
runtime diagnostic limits and pending capture/pairing/save capabilities.

## Repository and persistence boundaries

`tracker_config/models.py` contains pure validation and draft factories.
`tracker_config/repositories.py` centralizes reads, per-file serialization,
revision checks, backups, and explicit recovery. `ConfigurationRepositories`
groups candidate, profile, prompt, and document repositories under an explicitly
supplied configuration directory. Construction and reads never create files.
Missing candidate registries preserve the manager's existing empty-state behavior;
the native host still requires a registry. Missing catalogs have in-memory empty
defaults; malformed existing files always raise an error.

Reads return `Snapshot(data, revision)`. The revision is a SHA-256 digest of the
exact file bytes, or null for an absent file. It is not written into the registry
or returned through a new extension protocol. Saves require `expected_revision`:
use the revision from the read, or null for create-only behavior. An outdated
revision raises `RevisionConflict` with an instruction to reload.

The manager retains its public `load_state`/`save_state` wrappers. Its candidate
edit/delete and active-selection read/modify/write operations pass the revision
they actually read. The legacy `save_state(state)` convenience form obtains a
revision immediately before saving; callers needing an earlier stale-write check
must pass `expected_revision` explicitly. Existing browser forms do not carry a
revision, so this is not protection against an old form submission relative to a
prior GET. Adding client preconditions is deferred; no current protocol changes.

Writes proceed as follows:

1. Copy the proposed record and validate its JSON values and model.
2. Read and validate the existing primary file; never overwrite malformed data.
3. Verify the caller's expected revision.
4. If a valid primary exists, atomically retain its exact bytes as `<file>.bak`.
5. Write a sibling temporary file, flush and `fsync` it, recheck the primary's
   revision, and use `os.replace` to replace the primary.
6. Remove the temporary file on ordinary failure, preserving the prior primary.

Duplicate JSON properties, nonfinite numbers, malformed UTF-8/JSON, and unsupported
schema versions are rejected. Python values that would be coerced during JSON
serialization, such as tuples or nontext object keys, are rejected too.

Each repository retains one previous valid file, not an unlimited backup history.
`restore_backup(expected_revision=...)` is an explicit operation that validates
the backup, checks the primary's current digest, retains the replaced primary as
`<file>.before-restore`, and atomically restores the backup. The latter sidecar
retains the latest replaced bytes, including malformed bytes, not a recovery
history. Profile recovery additionally takes a candidate ID and validates file
association. No read or application startup automatically restores a backup.

Locks coordinate repository instances within the same Python process. Hash
preconditions detect observed stale writes and changes before replacement; they
are not a cross-process compare-and-swap primitive. An uncoordinated external
writer can still race between the final check and replacement. Cross-process
locking is a prerequisite for any future direct shared-file writer architecture.
Crash-created orphan temporary files are not automatically swept or deleted.

There are no group transactions. Existing pasted-prompt edits precede registry
saves, so a later registry failure may leave that prompt updated while the
registry remains unchanged; the caller must inspect and retry deliberately.
Registration follows a successful registry save and can still report a warning
without undoing the save. Profile saves do not update the registry. Catalog
reference checks describe the catalog state at validation time; callers must
revalidate when consuming references after independent edits.

## Native-host compatibility and output contracts

The host uses the shared version-1 registry reader but retains its caller checks,
global active-candidate gate, linked/pasted prompt loading, prompt composition,
MHTML writes, metadata structure, and current company matching. It never needs
the running manager or the new catalogs. Registration code, host name, allowlists,
extension IDs, manifest, and legacy background workflow are unchanged. Phase 3
adds a separate access page and a popup link without changing the popup's
candidate-name handlers.

The existing direct script entry points add the project root to their import
search path so the local package works without installation. Distribution must
include `tracker_config/` beside `manager/` and `native-host/`.

The existing prompts' tagged-text output remains unchanged. Phase 4A now defines
the separate generated JSON reference (`company`, `title`, `summary`, categorized
`skills`, `experience` with `sentences`, and `education` with `degree`) and strict
response parsing in [resume-contract.md](resume-contract.md). Its version belongs
to the application contract, not the generated object. No candidate-specific
examples are imported into defaults and no tagged output is silently converted.
Phase 4B adds a shared PDF Blob/byte renderer, without a generation engine,
preview UI, export/save workflow or changes to legacy prompt generation.
The new data validators remain separate from registry persistence.

## Configuration sharing decision after Phase 2

Phase 3 approved explicit configuration-directory access for the new extension
page, independent of the manager and Native Messaging. The page reads the same
authoritative files and stores only directory/file handles in extension-origin
IndexedDB. It performs no configuration writes. Details and the outstanding
browser-verification checklist are in [extension-access.md](extension-access.md).

The earlier alternatives remain relevant to later editing/synchronization work:

| Option | Manager closed | Outstanding work |
| --- | --- | --- |
| Paired local HTTP API through the existing manager | The API is unavailable while closed; existing Native Messaging must remain or an approved offline policy is needed | Pairing, port discovery, authentication, API preconditions, offline behavior |
| Separate configuration-directory grant to the extension | Potentially independent of the manager once a supported grant is valid | Real extension-context verification, permission recovery, cross-process write coordination, external linked-prompt access |
| Explicit import/export or synchronization | An imported snapshot can work offline but can become stale; it is not a second authority | Explicit synchronization, freshness/conflict handling, candidate routing |

The paired HTTP API and import/export options are not implemented. Current Native
Messaging continues to provide legacy live registry/prompt reads and capture while
the manager is closed, alongside the independent Studio access page.
The web UI still uses its Python backend. A bid-root grant would not grant access
to `config/` or arbitrary linked prompt paths, and browser directory handles must
not be placed in JSON configuration.

## Verification scope

The standard-library suite uses the reusable Phase 1 temporary-data fixture and
blocks registration, subprocesses, browser opening, and server startup. It checks
legacy round trips, field preservation, models/references, exact prompt bodies,
stale/failed writes, backups/recovery, profile isolation, and native-host functions
with synthetic archive bytes. This is not an installed Chrome/native-messaging
integration test. No live candidate registry, prompt file, or history directory is
opened by the suite.
