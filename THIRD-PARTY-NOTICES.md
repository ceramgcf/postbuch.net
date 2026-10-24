# Third-Party Notices

postbuch.net's own source code is licensed under the GNU Affero General
Public License v3.0 (see [LICENSE](LICENSE)). The project logo is **not**
covered by that license – see [LOGO-LICENSE.md](LOGO-LICENSE.md). The Docker
images built from this repository
download and bundle third-party software at build time. Those components keep
their own licenses, listed below.

All third-party components are used **unmodified**, either as standalone
programs invoked as separate processes (e.g. Ghostscript, Tesseract, qpdf) or
as libraries via their public APIs. Copyleft-licensed components (AGPL / GPL /
LGPL / MPL) are aggregated alongside postbuch.net, not modified and not linked
into postbuch.net's code; their license terms apply to those components only,
not to postbuch.net itself.

## Container base images and system packages

| Component | License | Used in | Source |
|---|---|---|---|
| OCRmyPDF (base image `jbarlow83/ocrmypdf`) | MPL-2.0 | cleaner | https://github.com/ocrmypdf/OCRmyPDF |
| Ghostscript | AGPL-3.0 | app, cleaner (via OCRmyPDF image) | https://ghostscript.com |
| Tesseract OCR | Apache-2.0 | cleaner (via OCRmyPDF image) | https://github.com/tesseract-ocr/tesseract |
| qpdf | Apache-2.0 | app | https://github.com/qpdf/qpdf |
| pikepdf | MPL-2.0 | cleaner (via OCRmyPDF image) | https://github.com/pikepdf/pikepdf |
| img2pdf | LGPL-3.0 | scanner | https://gitlab.mister-muffin.de/josch/img2pdf |
| SANE (sane-utils, sane-airscan) | GPL-2.0-or-later | scanner | http://www.sane-project.org |
| inotify-tools | GPL-2.0 | cleaner | https://github.com/inotify-tools/inotify-tools |
| PostgreSQL | PostgreSQL License | postgres | https://www.postgresql.org |
| pgvector | PostgreSQL License | postgres | https://github.com/pgvector/pgvector |
| nginx | BSD-2-Clause | web | https://nginx.org |
| Caddy (incl. DNS plugins for DuckDNS and Cloudflare) | Apache-2.0 | caddy | https://caddyserver.com |
| Node.js | MIT (with bundled components) | app | https://nodejs.org |
| Flask | BSD-3-Clause | scanner | https://github.com/pallets/flask |
| Pillow | MIT-CMU (HPND) | cleaner (via OCRmyPDF image) | https://github.com/python-pillow/Pillow |
| PostgreSQL client (`postgresql16-client`) | PostgreSQL License | app | https://www.postgresql.org |
| Python | PSF-2.0 | scanner, embedding | https://www.python.org |
| ONNX Runtime | MIT | embedding | https://github.com/microsoft/onnxruntime |
| NumPy | BSD-3-Clause | embedding | https://numpy.org |
| SentencePiece | Apache-2.0 | embedding | https://github.com/google/sentencepiece |

## AGPL notice: Ghostscript

Ghostscript is licensed under the GNU Affero General Public License v3.0 –
the same license postbuch.net itself uses, but as a separate grant from a separate
copyright holder. postbuch.net invokes it as an unmodified, standalone
command-line program (mere aggregation in the sense of the GPL family of
licenses), so Ghostscript's terms apply to Ghostscript, and postbuch.net's own
LICENSE applies to postbuch.net.

The complete corresponding source code of Ghostscript is available from
Artifex Software at https://ghostscript.com and
https://github.com/ArtifexSoftware/ghostpdl. If you redistribute Docker
images containing Ghostscript, the AGPL's source-offer obligations pass on
to you for that component.

## npm dependencies (app and web images)

The `app` and `web` images bundle npm packages installed at build time. All
direct dependencies are under permissive licenses (MIT, ISC, BSD, Apache-2.0),
including Express, pg, @azure/msal-node, @anthropic-ai/sdk,
@modelcontextprotocol/sdk, pdf-lib, pdfkit, ExcelJS, React, react-router,
TanStack Query, Tailwind CSS, lucide-react and @mmote/niimbluelib. In the
`app` image the full license texts ship under `node_modules/<package>/LICENSE*`.
The `web` image contains only the built frontend; its build collects the
license texts of all non-development npm packages into one file, served at
`/lizenzen/npm-pakete.txt`.

## OpenCV.js (camera scan)

The camera scan in the web app uses OpenCV, compiled to WebAssembly and
packaged as the npm module `@techstark/opencv-js`
(https://github.com/TechStark/opencv-js, upstream https://opencv.org),
licensed under the Apache License 2.0. The `web` image serves the unmodified
`opencv.js` from that package to the browser, which runs it locally on the
device. Its license text is part of `/lizenzen/npm-pakete.txt`.

## Embedding model (embedding image)

The `embedding` image downloads two files at build time, each pinned to a
fixed revision and checked against a SHA-256 checksum. Neither file is part
of this repository or of the release archive.

- **Snowflake Arctic Embed M v2.0** (`onnx/model_int8.onnx`) by Snowflake Inc.,
  https://huggingface.co/Snowflake/snowflake-arctic-embed-m-v2.0, licensed
  under the Apache License 2.0
  (https://www.apache.org/licenses/LICENSE-2.0). The build rearranges the
  stored weights into a separate file so they can be memory-mapped; the
  model's values and graph are not changed.
- **SentencePiece tokenizer model** (`sentencepiece.bpe.model`) of
  XLM-RoBERTa base by Facebook AI,
  https://huggingface.co/FacebookAI/xlm-roberta-base, licensed under the MIT
  License.

The precomputed help vectors in `app/hilfe-vektoren.json` are output of that
model for postbuch.net's own documentation.

## Lucide icons in the documentation

The icons under `docs/icons/` are copies from Lucide (https://lucide.dev),
changed only in their display size (16 px). They are licensed under the ISC
License; icons derived from the Feather project are additionally under the
MIT License. The license text lies next to them in [docs/icons/LICENSE.txt](docs/icons/LICENSE.txt).

## Trademarks

Microsoft, Azure, OneDrive, Discord, DuckDNS, Cloudflare, Niimbot and
Snowflake are
trademarks of their respective owners. They are referenced in this project
solely to describe interoperability; no affiliation or endorsement is implied.
