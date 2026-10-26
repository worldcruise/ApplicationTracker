# Shared PDF renderer

The first renderer is implemented in `extension/shared/resume-renderer.mjs`.
It generates actual PDF Blobs/bytes locally with the official **pdfmake 0.3.11
browser bundle** and its bundled Roboto VFS. Both browser contexts load the same
source and assets. No renderer source is copied to `manager/ui/`.

The renderer itself does not download, save files or invoke AI generation. Phase 5
and its UI correction integrate preview/download through the manager; see
[web-studio-ui-correction.md](web-studio-ui-correction.md). Legacy capture and the
Native Messaging protocol remain separate. No real candidate records were changed.

## Input and validation boundaries

The existing version-1 rendering envelope and generated resume contract remain
authoritative. See [resume-contract.md](resume-contract.md). Versioning is still
outside generated resume JSON. `buildRenderInput` joins identity from the supplied
validated registry, profile, resume, explicitly selected document-template version
and explicit profile-entry IDs. It returns a separate snapshot without persisting
anything or selecting a legacy active candidate.

`validateRenderInput(contracts, input)` is the common envelope validator used by
both the builder and renderer. Python has `validate_render_input` and its existing
builder uses that boundary too. The renderer does not independently resolve a
candidate or infer profile associations. Revalidating a snapshot does not prove
that the registry/catalogs are still current: later UI/session orchestration must
check freshness before rebuilding input. Unknown, missing or mismatched fields,
versions, bindings and settings fail before PDF generation.

The renderer uses these sources:

| Rendered information | Source |
| --- | --- |
| Full name | `renderInput.candidate.name`, obtained by the builder from the registry |
| Email, phone, address, labelled online details | Explicit existing profile fields only |
| Headline and summary | Generated `title` and `summary` |
| Skill categories and every skill | Generated `skills` |
| Job title, employer, distinct list items | Generated experience entries; stored sentences remain unchanged |
| Employment periods and optional company addresses | Only the explicitly bound profile work entry |
| Degree | Generated education entry |
| University, dates, optional address | Only the explicitly bound profile education entry |

The target employer in `resume.company` is never used as the header, work employer
or PDF metadata. Profile birthday, custom answers, prompts and credentials are not
included. Missing optional contact/address/period/university data is omitted, not
invented. `current: true` explicitly renders “Present”; no current date is injected.

All candidate/generated values enter plain PDF text nodes, never HTML, SVG,
images, active link definitions, resource URLs or executable callbacks. Online
details are printed as text, not fetched or activated. The renderer supplies its
own trusted layout callbacks. Even strings resembling markup remain literal text.
Every section is shown by default, including explicitly empty outer arrays. The UI
correction adds explicit section-visibility settings; hiding a section changes
presentation only and never changes or relaxes validation of generated JSON.

## Built-in templates and settings

`getBuiltInDocumentTemplates()` returns fresh in-memory catalog-compatible
records. Template ID and layout ID are both `classic` or `modern`, version 1.
Built-in IDs remain version 1. The UI correction also supports catalog configurations
with stable custom IDs, supported `layoutId`, positive record `version`, and explicit
`rendererVersion: 1`. Editing a configuration advances its record version without
claiming a new renderer layout. Unsupported layouts/renderer versions still fail.
The renderer never seeds catalogs or changes candidate preferences.

- **Classic:** centered name/contact/headline, conservative black default accent,
  uppercase underlined section headings, 54-point margins.
- **Modern:** left-aligned larger name, blue default accent, title-case shaded
  headings, 44-point margins.

Both use Roboto, US Letter portrait, automatic text wrapping and flowing content.
There is no unbreakable whole experience block. Sentences are separate list nodes;
bullet markers are visual layout, not changes to stored sentence strings. The
pdfmake 0.3 `pageBreakBefore(currentNode, nodeContainer)` callback moves stranded
headings when content follows on another page and avoids forcing an extra page
for a final empty section. Actual page-break aesthetics still require visual QA.

`document-layouts-v1.json` is the shared, shipped capabilities/defaults definition.
`document-settings.mjs` and `tracker_config/document_settings.py` consume it.
The version-1 document-template model now permits these real settings for supported
layouts. Unknown legacy layout metadata remains valid only with empty settings.
Existing registry/profile/catalog schema versions are not incremented.

| Setting | Accepted value | Actual effect |
| --- | --- | --- |
| `bodyFontSize` | Finite number 9–13, points | Body text size |
| `pageMargin` | Finite number 36–72, points | All four page margins and footer alignment |
| `sectionSpacing` | Finite number 6–24, points | Space above section headings and between letter paragraphs |
| `accentColor` | Exactly `#` plus six hexadecimal digits | Section heading color |
| `pageNumbers` | Boolean | Footer containing current page / total pages |
| `textColor` | Six-digit hexadecimal color | Default document text color |
| `lineHeight` | Finite number 1–1.8 | Text line-height multiplier |
| `nameFontSize` | Finite number 16–34, points | Candidate name size |
| `nameColor` | Six-digit hexadecimal color | Candidate name color |
| `titleFontSize` | Finite number 10–20, points | Resume headline size |
| `contactFontSize` | Finite number 8–13, points | Contact/address/link text size |
| `headerAlignment` | `left`, `center`, `right` | Header alignment |
| `headingFontSize` | Finite number 10–18, points | Section heading size |
| `showSummary` | Boolean | Explicitly show/hide summary |
| `showSkills` | Boolean | Explicitly show/hide skills |
| `showExperience` | Boolean | Explicitly show/hide experience |
| `showEducation` | Boolean | Explicitly show/hide education |

Each catalog record's `supportedSettings` can declare a subset of the shipped
capabilities, using the exact shipped descriptors. Defaults/overrides may contain
only declared settings and must satisfy their types/ranges. Unsupported keys,
custom rule ranges, nulls, nonfinite numbers and invalid values fail. Built-in
records declare all 17 capabilities. Existing catalogs declaring the previous
subset remain valid; new capabilities are not automatically written to them.

Effective values are shipped layout defaults, then selected-template defaults,
then `renderInput.formattingOverrides`. Those layers remain separate; rendering
never mutates template defaults or candidate preferences. Fonts, arbitrary page
sizes, HTML, custom CSS and user-supplied layout functions are not settings.

## Public APIs

Import from `extension/shared/resume-renderer.mjs`, or `/shared/resume-renderer.mjs`
when the manager serves it. The module uses packaged JSON imports with
`with { type: "json" }`, requiring Chrome 123+ and a compatible modern JavaScript
runtime. See [V8 import-attribute support](https://v8.dev/features/import-attributes).
Node v24.22.0 is the verified test runtime. No extension manifest minimum-version
or CSP change has been made; older Studio runtimes are not verified.

| Function | Result |
| --- | --- |
| `getBuiltInDocumentTemplates()` | Independent array of built-in catalog records |
| `buildResumeDocumentDefinition(renderInput, options = {})` | Synchronous pdfmake definition; validates first |
| `renderResumePdfBlob(renderInput, options = {})` | Promise of a real `Blob`, MIME `application/pdf` |
| `renderResumePdfBytes(renderInput, options = {})` | Promise of `Uint8Array` PDF bytes |
| `pdfBlobToBytes(blob)` | Promise of bytes from the same Blob; verifies MIME, nonempty size and signature |
| `buildCoverLetterDocumentDefinition({renderInput, coverLetter}, options = {})` | Synchronous separate letter definition |
| `renderCoverLetterPdfBlob({renderInput, coverLetter}, options = {})` | Promise of a separate PDF Blob |

`options` is reserved and must be empty; unknown options are rejected. Formatting
belongs in the existing input envelope, not a second options/settings pathway.

Example for a future caller with already loaded synthetic/authorized records:

```javascript
import { buildRenderInput, createDataContracts } from "./data-contracts.mjs";
import schema from "./data-contracts-v1.json" with { type: "json" };
import {
  getBuiltInDocumentTemplates, renderResumePdfBlob, pdfBlobToBytes
} from "./resume-renderer.mjs";

const contracts = createDataContracts(schema);
const input = buildRenderInput(contracts, {
  registry, candidateId, profile, resume,
  documents: { schemaVersion: 1, templates: getBuiltInDocumentTemplates() },
  documentTemplate: { id: "classic", version: 1 },
  bindings, // Explicit profile IDs associated with each generated entry.
  formattingOverrides: { bodyFontSize: 11, pageNumbers: true }
});
const blob = await renderResumePdfBlob(input);
const bytes = await pdfBlobToBytes(blob); // Same generated artifact; no save.
```

The renderer lazily imports the local vendor scripts only when generating bytes.
In a browser, the official UMD distribution exposes `pdfMake` on `self/window`,
and the subsequently loaded VFS script registers itself through
`pdfMake.addVirtualFileSystem`. In Node's CommonJS interop the bundle and VFS have
default exports, and the loader explicitly calls `addVirtualFileSystem(fonts)`.
This behavior was checked in the **0.3.11 package source** and tested in both Node
module and browser-global VM modes. No old 0.2 `.vfs` assignment is assumed.
The official [client initialization](https://pdfmake.github.io/docs/0.3/getting-started/client-side/)
and [0.3.11 browser implementation](https://github.com/bpampuch/pdfmake/blob/0.3.11/src/browser-extensions/index.js)
describe the relevant API.

Blob output uses the official asynchronous `createPdf(definition).getBlob()`;
byte output converts that Blob. No print, `open`, `download`, file picker or
filesystem writer is invoked. Each separate render call generates a fresh
document; use `pdfBlobToBytes` when preview/save must share exactly one artifact.

Definition errors retain shared `DataContractError` field paths where applicable.
Unsupported rendering choices and engine/output failures reject with an actionable
`PdfRenderError`. Errors are not converted to empty PDFs or logged with profile/
prompt bodies. The output signature check is a failure guard, not a complete PDF
validator. Callers must display failures and decide whether to retry.

## Cover letters and metadata

Cover-letter input wraps the existing render envelope plus the separate version-1
cover-letter record. The candidate IDs must match. It renders exactly the supplied
paragraphs after the available candidate header; it does not use the resume's
headline/experience, infer a recipient/address, add a date or generate a salutation
or signature. The future session must also verify the letter's `jobId` association.
No cover-letter fields enter resume JSON.

Metadata titles are only “Resume” or “Cover Letter,” with product/engine names.
There is no candidate author, target company, prompt or job body in PDF metadata.
Creation/modification dates are fixed to the Unix epoch as neutral deterministic
metadata, overriding the engine's current-time default; no date is printed in
the document. Fixed synthetic inputs produced identical bytes in the current
runtime tests. This is not a guarantee across future engine/font/runtime upgrades.

## Vendor assets and browser policy

The official npm tarball supplied unmodified `pdfmake.min.js` and `vfs_fonts.js`
under `extension/shared/vendor/pdfmake-0.3.11/`. SHA-512 and SHA-1 tarball integrity
were checked before copying. Per-file SHA-256 hashes, licenses, source URLs and
font notices are in [third-party-notices.md](third-party-notices.md) and the vendor
manifest. A vendor `.gitattributes` preserves original bytes across Git line-ending
conversion. No package manager, build step, CDN or runtime installation is needed.

The renderer uses only the bundled Roboto faces and sets the engine URL policy
to deny external resources. Generated/profile strings never become resource
definitions. No host permission, Native Messaging operation, CORS allowance or
`unsafe-eval` policy is added. The manifest and existing extension entry pages
are unchanged. Rendering can operate in a packaged extension page while Python
is closed; no Python renderer or HTTP API is called by it.

The exact scripts generated a PDF in a Node VM with string/Wasm code generation
disabled, network APIs blocked, and browser-style global/VFS registration. This
is useful evidence but **not Chrome extension CSP or lifecycle verification**.
Actual dynamic module loading under the installed extension policy remains a
manual check. No fallback library or vendor patch has been introduced.

Roboto embedding and accented Latin input were exercised, but output was not
visually inspected. There is no promised complete Unicode, emoji, CJK, RTL or
complex-script coverage, no font fallback and no missing-glyph detector. Required
language/font expansion belongs to a later approved asset and verification step.

## Manager static-resource routing

`manager/app.py` adds an exact read-only allowlist:

- `/shared/resume-renderer.mjs`
- `/shared/data-contracts.mjs`, `/shared/data-contracts-v1.json`
- `/shared/document-settings.mjs`, `/shared/document-layouts-v1.json`
- `/shared/vendor/pdfmake-0.3.11/pdfmake.min.js`, `/shared/vendor/pdfmake-0.3.11/vfs_fonts.js`
- `/studio/contracts.mjs` — the existing configuration-validator dependency,
  explicitly allowed as one file, not a directory-wide Studio route.

No requested path is appended to a filesystem root. Exact entries map to approved
physical files; resolved targets must remain inside their approved shared/Studio
directory and the resolved extension root. Traversal/encoded traversal, unknown
paths, extra path components and unapproved files return 404. Resolved symlink/
junction escapes return 403. This is containment checking, not a guarantee against
a malicious local process replacing filesystem entries between check and read.

JavaScript bundles/modules use `text/javascript`, JSON uses `application/json`,
all with UTF-8, `no-store` and `nosniff`. Missing resources return 404 without
creating replacements. POST/PUT/DELETE/PATCH/HEAD/OPTIONS on the shared namespace
are rejected with 405 and `Allow: GET`; the existing Host check and existing
write-route Origin/token checks remain. No CORS headers are added. Existing UI
static routes and API behavior remain intact. No server was started for testing.

Distributions must include the shared JSON definitions, modules, existing Studio
contract helper, and vendor/license files alongside the manager. These routes
make the renderer importable; this phase does not add UI buttons or wire a preview.

## Automated verification performed

```powershell
& 'C:\Users\Honey\AppData\Local\Programs\Python\Python313\python.exe' -B -m unittest discover -s tests -v
& 'C:\Program Files\nodejs\node.exe' --test tests/extension-access.test.mjs tests/resume-contract.test.mjs tests/pdf-renderer.test.mjs
& 'C:\Program Files\nodejs\node.exe' --check extension/shared/resume-renderer.mjs
& 'C:\Program Files\nodejs\node.exe' --check extension/shared/document-settings.mjs
& 'C:\Program Files\nodejs\node.exe' --check extension/shared/data-contracts.mjs
& 'C:\Program Files\nodejs\node.exe' --check extension/studio/contracts.mjs
git diff --check
```

Results: 93 Python tests and 65 JavaScript tests pass, retaining all 82/46 earlier
cases. New tests cover definitions/content integrity, bindings, missing optional
data, template/settings rejection and application, metadata, literal text, separate
letters, exact vendor hashes, real Blob/byte conversion, deterministic output,
long-resume multi-page page trees, embedded Roboto font data, blocked-network/
code-generation VM operation, settings parity and static-route security.

PDF checks also inspect EOF, Letter MediaBox, page-tree count and font embedding
markers. They are structural smoke checks, not a full independent PDF parser or
visual correctness test. PDFs stay in memory. No Chrome/server/registration/live
data workflow runs in this suite. Poppler/pdfinfo were not available on PATH;
no additional parser or visual-rendering package was installed. There are no
PNG/layout, Chrome CSP or Blob-preview verification claims.

## Later manual browser verification — not performed

Use disposable synthetic records and an authorized packaged external test module
or later UI integration. Do not use inline scripts, `eval`, a remote script or a
DevTools-only workaround as proof that normal extension-page loading works.

- [ ] Record Chrome version (123+), OS and extension policy. Import the shared
  renderer through the normal packaged page/module path with no CSP relaxation.
- [ ] Generate Classic and Modern resumes; inspect actual differences in headers,
  margins, headings, wrapping and spacing.
- [ ] Generate a long multi-page resume. Inspect every page for clipping,
  overlapping items, stranded headings, blank trailing pages and page numbering.
- [ ] Inspect accented Latin names/content and document any missing glyphs.
- [ ] Change each supported setting and inspect the resulting PDF, including
  page-number off/on. Confirm unsupported settings fail visibly.
- [ ] Generate a separate cover letter. Confirm only supplied paragraphs and
  explicit candidate information appear, with no invented recipient/date/signature.
- [ ] Keep Python/manager/native host closed. Confirm extension PDF generation
  works and Network shows only packaged resources, with no remote font/API/CDN
  requests. Missing/corrupt assets must fail rather than load a substitute.
- [ ] In a separately authorized manager run, import `/shared/resume-renderer.mjs`
  and confirm it uses the same source/vendor hashes and equivalent PDF output.
  Check MIME types, absence of CORS exposure and missing-resource errors.
- [ ] Confirm the normal extension module loader and bundled library need no
  `unsafe-eval`, remote script allowance or new manifest permissions.
- [ ] During the later preview phase, display the generated Blob through a Blob
  URL, verify viewer/CSP behavior, and revoke URLs when replaced/closed. Preview
  must use the same artifact as any later download/save.

UI integration, company folders, saving/export orchestration and persistent
history remain deferred. Stop at this renderer foundation before the next phase.
