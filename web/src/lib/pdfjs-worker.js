/**
 * Zentrales pdf.js-Worker-Setup für react-pdf.
 *
 * Worker aus dem gleichen Build statt externem CDN laden. Das vermeidet einen
 * weiteren Laufzeit-Download und passt zu React-PDF 10 / PDF.js 5. nginx liefert
 * die .mjs-Datei bewusst mit JavaScript-MIME-Type aus, sonst lehnt der Browser
 * sie wegen nosniff ab (siehe web/nginx.conf).
 *
 * Ein Import genügt – die Zuweisung ist ein idempotenter Modul-Seiteneffekt.
 * PdfPanel.jsx und DokumentViewer.jsx tragen dieselbe Zuweisung noch inline;
 * sie sollen bei Gelegenheit auf dieses Modul umgestellt werden.
 */
import { pdfjs } from 'react-pdf';

if (!pdfjs.GlobalWorkerOptions.workerSrc) {
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url,
  ).toString();
}

/**
 * Gemeinsame `options` für <Document> aller PDF-Viewer. PDF.js dekodiert
 * Schwarz-Weiß-Scans (CCITT/JBIG2) und JPEG 2000 über WebAssembly-Module und
 * lädt Standardschriften nach; ohne diese Pfade bleiben solche Bilder leer.
 * Die Dateien kopiert web/Dockerfile beim Build aus pdfjs-dist nach
 * public/pdfjs/ (Auslieferung: web/nginx.conf, Block /pdfjs/).
 */
export const PDFJS_DOCUMENT_OPTIONS = Object.freeze({
  withCredentials: true,
  wasmUrl: '/pdfjs/wasm/',
  standardFontDataUrl: '/pdfjs/standard_fonts/',
});

export { pdfjs };
