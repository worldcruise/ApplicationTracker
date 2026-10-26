# Resume and job data contracts — Phase 4A

Phase 4A implemented data boundaries. Phase 4B adds the shared renderer described
in [pdf-renderer.md](pdf-renderer.md), using these same contracts. Neither phase
reads real candidate/prompt files or changes the registry schema.
The actual design filename is `docs/Updating Plan.md`. Its references to existing
generation, profile UI, preview and PDF export are aspirational: those workflows
do not exist in this checkout. This document follows the Phase 4A contract where
that earlier design describes different or nonexistent behavior.

## Shared definitions and entry points

The canonical JSON Schema definitions are
`extension/shared/data-contracts-v1.json`, with ID
`urn:resume-tailoring-studio:data-contracts:1`. Select `#/$defs/resume`,
`#/$defs/job`, or `#/$defs/coverLetter`; the containing definition library is not
itself a schema for a resume instance. Version 1 belongs to this library and its
consumers, **never to the generated resume object**.

- `extension/shared/data-contracts.mjs`: one reusable browser implementation for
  both future UIs. `loadDataContracts()` explicitly loads only its packaged schema;
  `createDataContracts(schema)` permits dependency-free tests without network I/O.
- `tracker_config/resume.py`: Python validators read those same checked-in schema
  definitions lazily. Importing the module does not open files or start services.
- Both implementations expose validation, strict parsing, company naming checks,
  optional warnings, and an in-memory render-input builder. The shared renderer
  now consumes them; the legacy UI, native host and Studio access page do not
  yet expose resume-rendering controls.

The small evaluators implement only the schema vocabulary checked in here:
local `$ref`, `type`, `required`, `properties`, `additionalProperties`,
`propertyNames`, `minProperties`, `items`, `minItems`, `pattern`, `const`,
`minimum`, `maximum`, and the documented format checks. They are not general
JSON Schema engines; unknown rule keywords fail rather than being ignored.
`stable-id` and `http-url` are application formats, and `date-time` uses the
explicit subset below. An external schema tool must enable matching format
assertions to reproduce the entire application boundary.

## Generated resume content, contract version 1

```json
{
  "company": "Company name from the job description",
  "title": "Resume headline",
  "summary": "Professional summary",
  "skills": [{ "Skill category": ["Skill 1", "Skill 2"] }],
  "experience": [{
    "title": "Job title",
    "company": "Employer name",
    "sentences": ["Experience sentence 1.", "Experience sentence 2."]
  }],
  "education": [{ "degree": "Degree and major" }]
}
```

All six top-level properties are required, case sensitive, and exclusive. No
`schemaVersion`, candidate ID, contact details, metadata, cover letter, template
settings, dates or university fields may be added to this object. The experience
and education objects likewise accept exactly their documented properties.

| Field | Structural rule |
| --- | --- |
| `company`, `title`, `summary` | Nonblank Unicode string |
| `skills` | Array of category objects; each object has one or more nonblank category names; each category maps to a nonempty array of nonblank strings |
| `experience` | Array of objects requiring nonblank `title`, nonblank `company`, and a nonempty `sentences` array of nonblank strings |
| `education` | Array of objects requiring nonblank `degree` |

Empty outer `skills`, `experience`, and `education` arrays are accepted with
optional `empty-section` warnings. Required text, category objects and provided
entry contents cannot be empty. This permits an explicitly empty section without
inventing history or imposing a universal skill/experience count. A later layout
may require a completeness decision before export; structural success alone is
not a claim that a resume is ready to submit.

Nonblank means a string containing something other than Unicode White_Space
characters or a BOM. Unpaired Unicode surrogates are invalid. Text is returned
unchanged: no trimming, normalization, HTML interpretation, inferred facts or
silent repairs. Strings containing markup are still text and must remain text
at the future renderer boundary. Category names can contain punctuation; errors
escape their names as JSON Pointers, for example `/skills/0/A~1B~0C/0`.

Validators raise `DataContractError` with an `issues` array. Each issue contains
`path` (JSON Pointer; empty string denotes the root), `code`, and an actionable
`message`. Examples include `/summary` with `required`,
`/experience/0/sentences/1` with `type`, and `/education/0/degree` with `pattern`
for blank/invalid text. Independent structural errors are accumulated.

`parseResumeResponse` / `parse_resume_response` accept raw JSON, or exactly one
whole fenced block with an optional lowercase `json` label and no prose outside
it. Raw JSON supports application imports; it does not change the AI prompt's
one-code-block output requirement. Multiple blocks, explanatory prose, legacy
tagged text, duplicate properties, nonfinite numbers, malformed JSON, wrong root
types and unsupported properties are rejected. `parse` / `parse_data` are strict
raw-JSON readers for the selected contract. No legacy prompt is rewritten or
automatically imported, and there is no tagged-text adapter here.

Sentence counts for particular employers, specific employers or majors,
seniority, target skill counts, and 150–250-character sentence rules are not
structural requirements. A future template-specific quality checker may report
them separately; none is inferred from existing prompt text.

## Company validity versus later filesystem readiness

`Unknown` is a valid company value. It produces an optional `company-unknown`
warning, not a structural error. It is also a legal folder component; this phase
does not force a replacement solely because it is a placeholder.

Absent or blank company text fails structural validation. The independent
`companyNamingStatus` / `company_naming_status` returns `usable`,
`requiresManualEntry`, and `reason`, including for missing input. It rejects
Windows-invalid characters and controls, separators, dot-only components,
trailing ASCII spaces/dots, reserved device names (including superscript-number
variants), malformed Unicode, and components longer than 255 UTF-16 code units.
It does not trim, sanitize, guess a replacement, inspect the filesystem, or apply
the legacy capture workflow's company-suffix normalization.
The character/device rules follow [Windows filename conventions](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file).

For example `A/B` is structurally valid resume text but requires manual company
entry before a future save. `Example, Inc.` also requires entry because of its
trailing dot. `Example & Partners` is usable. The later save workflow must ask
for a usable explicit company name rather than guessing; actual target filesystem
errors and duplicate-folder checks still need handling at save time. This helper
does not establish that a folder exists or is writable.

## Candidate profiles and rendering input

Identity still comes exclusively from `config/candidates.json`, schema version 1.
Structured profiles retain their existing schema version 1 and stable candidate
IDs. No prompt text is used to populate or verify profile data.

The pure `buildRenderInput` / `build_render_input` creates an independent snapshot:

```text
{
  schemaVersion: 1,
  resumeContractVersion: 1,
  candidate: {id, name},             // selected from a validated registry
  profile: <validated version-1 profile for that candidate>,
  resume: <validated generated content, unchanged>,
  documentTemplate: <selected catalog record at an explicit id + version>,
  formattingOverrides: {},
  bindings: {
    experience: [<profile workExperience ID for each generated entry>],
    education: [<profile education ID for each generated entry>]
  }
}
```

This is transient rendering input, not a second registry or persisted candidate
record. The caller must select an existing candidate explicitly; construction
does not change global active selection. A missing/mismatched profile, unavailable
or stale document-template version, unresolved binding, or unsupported override
fails with a field path. A missing profile is not synthesized.

The binding arrays are explicitly supplied associations indexed to the current
generated arrays; their values are stable profile-entry IDs. No association is
guessed from employer spelling or position. Reordering/editing generated entries
requires rechecking these associations; the builder cannot verify that a human's
chosen association is factually correct. Date/address data comes only from those
associated profile entries. The registry supplies the full name; the profile
supplies contact information and addresses. Generated summary/headline, skills,
experience sentences and degree text remain generated content.

Profiles may be incomplete drafts. Construction is not PDF/export readiness or
factual verification. Future layouts must explicitly report required missing
profile information or omit optional fields, never fabricate it. Phase 4B permits
the implemented settings for `classic`/`modern` layouts and validates them through
shared shipped capabilities. Other layouts still require empty settings and
overrides. The envelope keeps schema version 1. `validateRenderInput` /
`validate_render_input` is reused by the builder and rendering boundary; it does
not reauthorize or refresh a snapshot's identity from disk.

## Job record, internal schema version 1

This separate model is the proposed future `JobDescription.json` content:

```json
{
  "schemaVersion": 1,
  "id": "job-one",
  "candidateId": "candidate-one",
  "jobDescription": "Original job description text only.",
  "company": "Resolved company name",
  "sourceUrl": "https://example.test/jobs/one",
  "createdAt": "2026-10-22T14:30:00Z",
  "promptTemplate": { "id": "prompt-one", "version": 2 },
  "documentTemplate": { "id": "document-one", "version": 1 }
}
```

Required: `schemaVersion`, `id`, `candidateId`, nonblank `jobDescription`, nonblank
`company`, and `createdAt`. `sourceUrl`, `promptTemplate`, and `documentTemplate`
are optional and omitted when unavailable; null/empty invented provenance is not
accepted. Additional properties, including `resume` and `clipboardText`, fail.

- IDs use the existing safe stable-ID shape, not names or filesystem paths.
  Generate a job ID once at creation in the later workflow and retain it on edits.
- `createdAt`: calendar-valid `YYYY-MM-DDTHH:MM:SS[.ffffff]Z` or the same with an
  explicit `+HH:MM` / `-HH:MM` offset; 1–6 fractional digits, no leap seconds.
- `sourceUrl`: lexical absolute ASCII HTTP(S) URL with a domain/IPv6 host, optional
  port 0–65535, no user-info, whitespace or unsafe delimiters; percent escapes
  must be complete. International URLs must be explicitly encoded by the future
  caller. No navigation, DNS resolution or source-page access occurs here.
- Template references require an ID and positive safe-integer version. Legacy
  linked/config-relative prompts have no managed version; omit that reference
  unless a later workflow has real managed provenance. Never invent a catalog
  import or infer provenance by reading the prompt body.

The job stores the resolved company separately so a later user correction does
not mutate generated resume text. Structural validation permits a draft company
such as `Unknown` or `A/B`; saving additionally requires the company naming check.
The eventual `JobDescription.txt` must contain exactly `jobDescription`, not the
JD-plus-prompt clipboard composition. A schema cannot distinguish an accidentally
pasted combined prompt from ordinary prose: the future capture/composition flow
must retain the original JD in a separate variable and test that data flow.

Job/candidate/template IDs are validated syntactically here. The consuming session
must also check membership, candidate agreement, and the referenced versions
against the current registry/catalogs; this model is not a synchronization service
or a cross-file transaction. No job files are written in this phase.

## Cover letter, separate internal schema version 1

```json
{
  "schemaVersion": 1,
  "candidateId": "candidate-one",
  "jobId": "job-one",
  "paragraphs": ["Dear hiring team,", "User-provided letter text."]
}
```

All properties are required and exclusive. Paragraphs are a nonempty array of
nonblank plain-text strings, preserved verbatim. This is the smallest draft model
for future explicit user input; it assumes neither AI generation nor a rich-text
editor. Absence of a cover-letter draft means no letter, rather than an invalid
empty letter. Candidate and job association must be checked when combined with a
session. No cover letter is embedded in resume JSON or generated/exported here.

## Verification and deferred integration

`tests/fixtures/resume-data.json` contains invented records only.
`tests/test_resume_contract.py` and `tests/resume-contract.test.mjs` cover valid,
missing, malformed, mistyped, empty and nested data; error paths; strict response
parsing; company readiness; separation; and rendering-input joins/rejections.
`tests/resume-contract-parity.mjs` checks Python/browser agreement on synthetic
records, issue paths/codes, naming decisions, warnings and render snapshots.
This is shared-definition/parity testing, not exhaustive JSON Schema conformance.

No production configuration, prompt, history, UI flow, native protocol or manifest
was changed. Existing tests remain intact. Phase 4B exercises real PDF generation
in memory using only the approved browser assets, with no server, Chrome,
registration, preview, file save or migration. See [pdf-renderer.md](pdf-renderer.md)
for the implemented API and the unverified browser checklist. The earlier
[feasibility analysis](pdf-rendering-feasibility.md) is historical.
