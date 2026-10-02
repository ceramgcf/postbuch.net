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
TanStack Query, Tailwind CSS, lucide-react and @mmote/niimbluelib. The full
license texts ship inside the images under `node_modules/<package>/LICENSE*`.

## Trademarks

Microsoft, Azure, OneDrive, Discord, DuckDNS, Cloudflare and Niimbot are
trademarks of their respective owners. They are referenced in this project
solely to describe interoperability; no affiliation or endorsement is implied.
