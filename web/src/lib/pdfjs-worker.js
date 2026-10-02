/**
 * Zentrales pdf.js-Worker-Setup für react-pdf.
 *
 * Worker aus dem gleichen Build statt externem CDN laden. Das vermeidet einen
 * weiteren Laufzeit-Download und passt zu React-PDF 10 / PDF.js 5. nginx liefert
 * die .mjs-Datei bewusst mit JavaScript-MIME-Type aus, sonst lehnt der Browser
 * sie wegen nosniff ab (siehe web/nginx.conf).
 *
 * Ein Import genügt – die Zuweisung ist ein idempotenter Modul-Seiteneffekt.
 * PdfPanel.jsx und MobilePdfOverlay.jsx tragen dieselbe Zuweisung noch inline;
 * sie sollen bei Gelegenheit auf dieses Modul umgestellt werden.
 */
import { pdfjs } from 'react-pdf';

if (!pdfjs.GlobalWorkerOptions.workerSrc) {
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url,
  ).toString();
}

export { pdfjs };
