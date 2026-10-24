// Hauptthread-Seite des Scanner-Workers: ein Worker je Sitzung, Anfragen als
// Promises. Der Worker wird erst beim Öffnen des Kamerascans gestartet; die
// OpenCV-Datei (rund 3,7 MB über die Leitung) cacht der Browser dauerhaft.

/* global __OPENCV_VERSION__ */
const OPENCV_URL = `/opencv/opencv-${__OPENCV_VERSION__}.js`;

export function erstelleScanner({ beiFortschritt } = {}) {
  const worker = new Worker(new URL('./scanner.worker.js', import.meta.url));
  let naechsteId = 1;
  const offen = new Map();

  worker.onmessage = (ereignis) => {
    const nachricht = ereignis.data;
    if (nachricht.typ === 'laden') {
      beiFortschritt?.(nachricht.anteil);
      return;
    }
    const eintrag = offen.get(nachricht.id);
    if (!eintrag) return;
    offen.delete(nachricht.id);
    if (nachricht.ok) eintrag.resolve(nachricht.ergebnis);
    else eintrag.reject(new Error(nachricht.fehler));
  };
  worker.onerror = (ereignis) => {
    const fehler = new Error(ereignis.message || 'Scanner-Worker abgestürzt');
    for (const eintrag of offen.values()) eintrag.reject(fehler);
    offen.clear();
  };

  function frage(typ, daten, transfer = []) {
    const id = naechsteId++;
    return new Promise((resolve, reject) => {
      offen.set(id, { resolve, reject });
      worker.postMessage({ id, typ, daten }, transfer);
    });
  }

  const bereit = frage('init', { url: OPENCV_URL });

  return {
    bereit,
    /** Vorschaubild (ImageBitmap, wird übertragen) auf Blatt und Schärfe prüfen. */
    analyse: (bild, { schaerfe = false } = {}) => frage('analyse', { bild, schaerfe }, [bild]),
    /** QR-Codes im Vorschaubild (ImageBitmap, wird übertragen) lesen. */
    qr: (bild) => frage('qr', { bild }, [bild]),
    /** Ecken auf dem fertigen Foto (Blob) suchen und verfeinern. */
    erkenne: (foto, { hinweis = null } = {}) => frage('erkenne', { foto, hinweis }),
    /** Seite fertig rechnen: entzerren, verbessern, für das PDF kodieren. */
    seite: (foto, { ecken = null, hinweis = null, modus, drehung = 0 }) => frage('seite', { foto, ecken, hinweis, modus, drehung }),
    beenden() {
      worker.terminate();
      for (const eintrag of offen.values()) eintrag.reject(new Error('Scanner beendet'));
      offen.clear();
    },
  };
}
