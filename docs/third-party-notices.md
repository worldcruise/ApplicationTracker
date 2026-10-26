# Third-party assets

## pdfmake 0.3.11

Source: the official [npm version record](https://registry.npmjs.org/pdfmake/0.3.11)
and its [package tarball](https://registry.npmjs.org/pdfmake/-/pdfmake-0.3.11.tgz).
Upstream repository: [bpampuch/pdfmake](https://github.com/bpampuch/pdfmake).
The user-approved pin is **0.3.11**, regardless of other release tags or the
earlier feasibility recommendation. No fork, rebuild, package-manager install,
remote runtime resource, or version 0.3.12 is used.

The tarball was obtained directly from registry.npmjs.org. Both published SHA-1
and SHA-512 were verified before selected members were copied, byte for byte.
No package scripts were executed. The archive was inspected in a temporary
directory, not unpacked over the application. No Node dependencies were installed.

Published tarball SHA-1:
`b4504d19b8f31fa5063dc1b847b060faa4f7c5bb`

Published tarball Subresource Integrity value:
`sha512-Uc49J9hUMyuqJk+U+PxlpBpPr96A4HOOfesGx609EPr2ue82+5/Smq/KTAkEqh0/jUGSi1fumvqZ5yAWijJTJg==`

Installed under `extension/shared/vendor/pdfmake-0.3.11/`:

| Local file | Exact package member | SHA-256 |
| --- | --- | --- |
| `pdfmake.min.js` | `build/pdfmake.min.js` | `faaee53f8dcf48b0934553665809d8180e20e435b654f633df2f18f9dbdeaa88` |
| `vfs_fonts.js` | `build/vfs_fonts.js` | `1483ed267fe00ad90a3834441b019d856dd41ed079b2614404b2fcef425db6fc` |
| `LICENSE.pdfmake.txt` | `LICENSE` | `ab919430421c2e244dbb8694d70916eae16235b75c0ea07e9a6c67cd4265c954` |
| `LICENSE.svg-to-pdfkit.txt` | `src/3rd-party/svg-to-pdfkit/LICENSE` | `97a9a454169e8bb54afa875ba1741ac77f2a3b8cfac57e06c7e54f4467776ed8` |

The pdfmake MIT notice credits bpampuch (2014–2015) and liborm85 (2016–2026).
The package's SVG-to-PDFKit MIT notice is retained even though our renderer does
not expose SVG input. The upstream browser distribution bundles its own runtime
components; they are not separately installed or modified here. Preserve all
upstream code and notices when distributing or upgrading these assets.

## Bundled Roboto fonts

`vfs_fonts.js` contains `Roboto-Regular.ttf`, `Roboto-Medium.ttf`,
`Roboto-Italic.ttf`, and `Roboto-MediumItalic.ttf`. The package's font metadata
identifies Copyright 2011 The Roboto Project Authors
(`https://github.com/googlefonts/roboto-classic`), SIL Open Font License 1.1, and
the notice “Roboto is a trademark of Google.” These are the exact supplied VFS
fonts, not replacements or re-encoded fonts.

The complete matching official
[Roboto OFL notice](https://raw.githubusercontent.com/googlefonts/roboto-classic/main/OFL.txt)
is preserved as `LICENSE.Roboto.txt`, SHA-256:
`061402327a96aadb0bfb694a960ed289ecd38d383e396243831ab81feb109c41`.
The npm tarball does not include a separate Roboto license text; this notice was
obtained from the font upstream identified in the embedded metadata. The library's
MIT license is not substituted for the font license.

`vendor-manifest.json` records the source, package member names, sizes and hashes.
Automated tests verify the local files against that manifest and the approved
runtime asset hashes. Registry signatures/provenance were not independently
cryptographically verified; tarball hash verification is the check performed.

Vendor files must remain unchanged, including line endings. Obtain future updates
only through an explicitly approved version change, verify registry integrity,
and rerun the PDF and browser verification checks. No runtime CDN is used.
