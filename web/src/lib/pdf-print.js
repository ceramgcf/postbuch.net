/**
 * Drucken eines serverseitig gelieferten PDFs aus der SPA.
 *
 * Warum nicht einfach ein verstecktes `<iframe src="…/pdf">` + `contentWindow.print()`:
 *   1. nginx liefert auf allen Antworten `X-Frame-Options: DENY` (web/nginx.conf) –
 *      ein Iframe mit der PDF-URL wird schlicht geblockt.
 *   2. PDF-Viewer-Erweiterungen (z. B. Adobe Acrobat für Chrome) klinken sich in
 *      HTTP-Antworten mit `Content-Type: application/pdf` ein und rendern das
 *      Dokument in einem eigenen, gekapselten Kontext. Ein `print()` auf dem
 *      äußeren Frame erreicht deren Druckfunktion nicht und verpufft wortlos –
 *      ohne Fehler, den man abfangen könnte.
 *
 * Beides umgeht eine `blob:`-URL: sie entsteht rein im Client, es gibt keine
 * HTTP-Antwort zum Abfangen und keinen Frame-Header. Chrome fällt damit auf
 * seinen eingebauten Viewer zurück, der `contentWindow.print()` unterstützt.
 *
 * Fallstricke, die die Implementierung bewusst berücksichtigt:
 *   - Kein `display:none` und keine 0×0-Größe – Firefox erreicht damit nie den
 *     druckbereiten Zustand.
 *   - `load` heißt nicht „Viewer bereit"; ein Standard-Ready-Event dafür gibt es
 *     nicht, daher die kurze Wartezeit davor.
 *   - `focus()` vor `print()`, sonst wirft Firefox gelegentlich einen SecurityError.
 *   - Aufräumen erst nach `afterprint` bzw. spät per Timeout, sonst hängt der
 *     Druckdialog.
 *
 * Das Ganze ist bewusst hier gekapselt: Rückbau heißt, diese Datei zu ersetzen,
 * ohne die aufrufenden Komponenten anzufassen.
 */

// Wartezeit zwischen load und print – der native Viewer meldet nicht, wann er bereit ist.
const VIEWER_BEREIT_MS = 500;
// Notbremse fürs Aufräumen, falls afterprint nie feuert (passiert je nach Browser).
const AUFRAEUM_TIMEOUT_MS = 120000;

/**
 * Druckt bereits im Browser vorliegende PDF-Bytes (Uint8Array/ArrayBuffer).
 * Bevorzugter Weg, wenn die Anzeige das Dokument ohnehin schon geladen hat:
 * spart den kompletten zweiten Download (der Endpunkt liefert no-store, der
 * Browser könnte den ersten also gar nicht wiederverwenden).
 */
export function printPdfBytes(bytes) {
  return druckeBlob(new Blob([bytes], { type: 'application/pdf' }));
}

/** Lädt das PDF selbst und druckt es – für Aufrufer ohne bereits geladene Bytes. */
export async function printPdf(url) {
  const antwort = await fetch(url, { credentials: 'include' });
  if (!antwort.ok) throw new Error(`PDF konnte nicht geladen werden (HTTP ${antwort.status})`);
  return druckeBlob(await antwort.blob());
}

async function druckeBlob(blob) {
  const blobUrl = URL.createObjectURL(blob);

  await new Promise((resolve, reject) => {
    const rahmen = document.createElement('iframe');
    rahmen.style.cssText = 'position:fixed;left:-10000px;top:0;width:1024px;height:768px;border:0;';
    rahmen.setAttribute('aria-hidden', 'true');
    rahmen.src = blobUrl;

    let aufgeraeumt = false;
    const aufraeumen = () => {
      if (aufgeraeumt) return;
      aufgeraeumt = true;
      clearTimeout(spaetTimer);
      rahmen.remove();
      URL.revokeObjectURL(blobUrl);
    };
    const spaetTimer = setTimeout(aufraeumen, AUFRAEUM_TIMEOUT_MS);

    rahmen.addEventListener('load', () => {
      setTimeout(() => {
        try {
          rahmen.contentWindow.addEventListener('afterprint', aufraeumen);
          rahmen.contentWindow.focus();
          rahmen.contentWindow.print();
          resolve();
        } catch (fehler) {
          aufraeumen();
          reject(fehler);
        }
      }, VIEWER_BEREIT_MS);
    });

    rahmen.addEventListener('error', () => {
      aufraeumen();
      reject(new Error('PDF konnte nicht zum Drucken geladen werden.'));
    });

    document.body.appendChild(rahmen);
  });
}
