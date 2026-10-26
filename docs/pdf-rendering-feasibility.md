# PDF rendering feasibility — Phase 4A

**Historical analysis:** Phase 4B explicitly approved the official npm package
**pdfmake 0.3.11**, superseding the earlier 0.3.12 recommendation below. The
implemented engine uses only the approved 0.3.11 artifacts. See
[pdf-renderer.md](pdf-renderer.md) and [third-party-notices.md](third-party-notices.md)
for verified package provenance, implementation and remaining browser checks.

Status: recommendation only, inspected 2026-10-22. **No PDF renderer, dependency,
font bundle, preview, download or save implementation has been added.** No actual
PDF bytes or Chrome behavior were exercised. Contract implementation is documented
in [resume-contract.md](resume-contract.md).

## Existing environment and constraints

The manager is a Python standard-library HTTP server plus a plain JavaScript UI.
`TrackerHandler.do_GET` in `manager/app.py` serves an explicit allowlist of just
`/`, `/app.js`, and `/styles.css` from `manager/ui/`; there is no generic shared
asset route. `extension/studio.html` is a separate extension-origin module page.
The extension package root is `extension/`; files beside it cannot automatically
be imported by its pages. `background.js` remains legacy Native Messaging capture.

Repository file/search inspection found no PDF renderer, generation code, package
manifest, vendored PDF library, font bundle or build pipeline. Read-only runtime
resolution probes found no `pdfmake`, `jspdf`, `pdf-lib`, `pdfkit`, `puppeteer` or
`playwright` in the installed Node v24.22.0 runtime's repository resolution path.
Python 3.13.13 metadata/module discovery found no `reportlab`, `weasyprint`,
`pypdf`, `fpdf`, `playwright` or `pymupdf`, and no PDF-related installed distribution.
These probes did not import those libraries, install anything, or inspect real
configuration. They are not a search of every unrelated directory on the machine.

The design document's “existing renderer,” generation, preview and export cannot
be reused because they do not exist. Real rendering therefore needs an approved
dependency. A print dialog is not a programmatic source of PDF bytes for future
filesystem saving. An HTML-only preview with a separately implemented PDF layout
would introduce two layouts that could disagree.

## Options

| Approach | Actual PDF bytes and manager closed | Pagination, fonts and layout | Distribution and test implications |
| --- | --- | --- | --- |
| **pdfmake browser bundle (recommended)** | `createPdf(definition).getBuffer()` or `getBlob()` returns actual output in the visible page, independent of Python. Both UIs can use the same bundle and document-definition builder. | Declarative text stacks, lists, columns/tables, automatic flow, explicit page breaks and page-break callbacks. Embedded fonts, styles, margins and spacing. | Vendor a pinned browser bundle plus licensed VFS font data and notices inside the extension. Test the pure builder and library bytes in Node; verify the approved browser bundle under extension CSP separately. |
| jsPDF | `output('arraybuffer')` produces bytes locally; same browser module can serve both UIs. | Text splitting, font embedding and explicit pages are available, but flowing a resume across pages requires more application layout/pagination work. Its HTML route adds html2canvas and DOMPurify dependencies. | Bundle jsPDF/fonts; avoid the HTML route to keep untrusted content plain text. Node can test direct text/PDF APIs, while HTML rendering needs a browser and more dependencies. |
| pdf-lib | `PDFDocument.save()` returns bytes in browser or Node, independently of Python. | Strong PDF creation/editing and drawing primitives. The application would need substantially more flowing layout/page management; custom fonts additionally need `@pdf-lib/fontkit`. | Package pdf-lib/fontkit/fonts. Headless Node tests are feasible, but this is a poor starting point for a flowing resume without building layout infrastructure. |
| Python renderer or headless Chromium service | A Python PDF library or Chromium DevTools `Page.printToPDF` can return bytes; a running local process/service is needed. | Python layout engines or browser print CSS can paginate with embedded fonts. Reproducing the same behavior inside an offline extension needs another runtime or renderer. | New Python/Chromium dependencies, service lifecycle and distribution. Would undermine the approved standalone Studio requirement if required for rendering. |
| Browser print alone | User-driven print output; no `window.print()` result containing PDF bytes. | Uses print CSS/browser configuration. | Does not satisfy the extension's future direct file-save requirement. Not recommended as the renderer. |

The pdfmake byte APIs above are documented in its
[browser methods](https://pdfmake.github.io/docs/0.3/getting-started/client-side/methods/).
Its [page dimensions and page-break controls](https://pdfmake.github.io/docs/0.3/document-definition-object/page/),
[styling](https://pdfmake.github.io/docs/0.3/document-definition-object/styling/),
and [embedded VFS fonts](https://pdfmake.github.io/docs/0.3/fonts/custom-fonts-client-side/vfs/)
provide the required layout building blocks. This is documentation-based
feasibility, not an executed prototype.

The alternatives are supported by the primary
[jsPDF output/page APIs](https://parallax.github.io/jsPDF/docs/jsPDF.html),
[jsPDF dependency/font documentation](https://github.com/parallax/jsPDF),
and [pdf-lib save/drawing/font documentation](https://pdf-lib.js.org/).
The extra application pagination work described above is an architectural
assessment of those APIs, not a claim that those libraries cannot produce resumes.
For the service alternative, see the browser-only
[Chrome DevTools PDF API](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-printToPDF).

## Recommendation requiring approval

Approve a **locally vendored, pinned pdfmake 0.3.12 browser distribution**, its
reviewed dependency/license notices, and a licensed embedded Roboto font set for
the initial feasibility implementation. The project's
[official release list](https://github.com/bpampuch/pdfmake/releases/tag/0.3.12)
identifies 0.3.12 as the current release when inspected. Recheck the exact artifact,
security fixes and integrity before obtaining it in the approved implementation
phase. The proposed pin is not an installed or tested dependency.

The library has an [MIT license](https://github.com/bpampuch/pdfmake/blob/master/LICENSE).
Font redistribution terms and included transitive notices must accompany the
specific approved bundle; do not assume the library license covers fonts.
Confirm the font's coverage for intended candidate languages before promising
support. A font name alone does not guarantee every glyph, script, RTL layout or
line-breaking behavior. Additional font assets need explicit selection and
verification. No fonts were downloaded here.

This choice avoids writing a PDF engine or manual paragraph pagination in this
repository. An initial implementation can use prebuilt local assets, without a
frontend framework or mandatory runtime npm installation. Vendored size, upgrade
tracking, checksums and license inventory become distribution responsibilities.

Approval is required by the Phase 4A instruction before introducing any library
or implementing the renderer. The next phase must first prove that this exact
bundle can produce bytes under the extension's existing security policy. If it
requires forbidden dynamic code execution, choose a compatible build/alternative;
do not relax security silently.

## One source for rendering in both UIs

Proposed future files, **not created in this phase**:

```text
extension/shared/render-input.mjs       # layout readiness/capability checks if needed
extension/shared/render-document.mjs    # pure input -> library definition -> bytes
extension/shared/layouts/...            # named, versioned layout builders
extension/vendor/pdfmake/...            # pinned library, VFS fonts, licenses, checksums
```

The existing `extension/shared/data-contracts.mjs` and JSON definitions are the
implemented validation boundary. Both UIs should import that same module and
future renderer. Browser orchestration differs only after bytes exist:

1. Resolve an explicit registry candidate, profile, generated content, template
   version and profile-entry bindings. Check freshness at the consuming workflow.
2. Build the validated render input described in `resume-contract.md`. Check
   selected layout capabilities and required profile completeness explicitly.
3. The single renderer constructs library nodes from plain text and approved
   settings and returns a `Uint8Array` of PDF bytes.
4. Preview those bytes through a Blob URL. Download those same bytes in the web
   workflow; later pass them to an explicitly authorized filesystem writer in
   Studio. Rendering never itself writes application files or triggers a download.
5. An optional separate cover-letter builder uses the same engine/font/style
   infrastructure and the separate letter/profile input, not a resume JSON field.

The Python manager must later add a **small explicit static allowlist** mapping
the shared contract module/JSON, its current `../studio/contracts.mjs` import,
renderer, chosen layout files, and vendor/font assets to these same physical
files with correct MIME types. Preserve relative URLs: for example
`/shared/data-contracts.mjs`, `/shared/data-contracts-v1.json`, and
`/studio/contracts.mjs`. Do not expose arbitrary repository paths or `config/`.
No static route changes are needed or made before a consuming UI exists. Test
that future allowlist by calling handlers with fake streams, without starting a
server. Distribution of the manager must include those extension/shared/vendor
resources, just as distribution already needs `tracker_config/`.

Studio imports within its own package; it does not fetch code from the manager
or depend on that server. No new Native Messaging operation or host permission
is needed for local rendering. No duplicated generated renderer bundle is needed
for the web UI. Use identical library, layout versions and font bytes in both
contexts to reproduce typography and pagination.

Chrome's [Manifest V3 code policy](https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code)
requires packaged executable code, and its
[extension CSP](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy)
restricts dynamic evaluation. Therefore use local reviewed assets, no CDN scripts,
remote fonts, `eval` or user-supplied layout functions. Do not spread arbitrary
generated JSON/configuration into a library document definition. Candidate strings
must enter text nodes only, never `innerHTML`, SVG, code, attachment paths, or
automatic resource URLs. Link targets, if supported later, need their own allowlist.
Layout IDs map only to shipped builders and supported settings map to actual
library properties; arbitrary config must not become renderer instructions.

## Preview and reproducibility limits

A shared PDF artifact makes preview/download/save agree at the document level.
Browser-native PDF viewing of a Blob URL inside the extension still needs real
Chrome/CSP testing. The current default object policy may require a narrow,
reviewed viewer/resource adjustment. No viewer permission or CSP change is made
here. If native viewing cannot support the required embedded preview, PDF.js is
a separate potential dependency decision, not implicitly included with pdfmake.

Generated PDFs can contain volatile timestamps/IDs. Do not promise identical raw
bytes without controlling those fields and verifying the library. Reproducibility
means equivalent layout, fonts, text and page breaks for fixed inputs and versions;
normalize metadata for deterministic fixtures where the approved API permits it.
Asynchronous renders also need stale-result handling when content/settings change.

## Verification after approval, without Chrome or manager startup

- Keep the current Python/Node regression suites. Add pure definition-builder
  tests using synthetic profile/resume/letter fixtures and explicit bindings.
- Exercise the approved engine's byte-returning API in Node using the same fonts
  and document definitions. Try the actual vendored browser bundle first; if its
  environment needs browser-only APIs, record that limit instead of equating a
  Node-specific distribution test with browser-bundle verification.
- Use short and long multi-page fixtures, very long words, nested lists, page
  boundary headings, accented text, unsupported glyphs and malicious-looking
  markup. Confirm content stays literal, no remote resources are fetched, and
  font/size/margin/spacing overrides actually affect output.
- Check a real `%PDF-` artifact, page counts, extracted text, fonts and page
  dimensions with an approved parser or existing available tool. A header check
  alone is not a valid-PDF or layout test. No suitable parser is installed here;
  approval for test tooling may be needed separately.
- Render synthetic PDFs to images and inspect wrapping, clipping, spacing and
  page breaks using approved available tooling. No visual-PDF QA is claimed by
  data-contract tests. Do not install a parser/renderer silently.
- Subsequently perform explicitly authorized manual extension/web checks for
  CSP, Blob viewing, worker/main-thread responsiveness, page lifecycle and output
  equivalence, including operation with the manager closed. Those checks cannot
  be replaced by ordinary unit tests and were not run in Phase 4A.

Remaining decisions: approve the dependency/assets, confirm language/font coverage,
prove exact-bundle CSP compatibility, choose initial real layouts/settings and
required profile fields, select preview behavior and any additional test/viewer
tooling. The full editor, gallery, bid folders and application-file saving remain
out of scope.
