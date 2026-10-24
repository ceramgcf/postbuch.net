// Etiketten-QR-Codes im Livebild des Kamerascans. Ein postbuch.net-Etikett
// trägt „<host>/postbuch/P000123“ (Dokument) bzw. „<host>/mappe/S000123“
// (Sammelmappe), siehe etikettQrText() in labelRenderer.js; host = Adresse
// der Instanz beim Drucken, je nach Leser mit oder ohne Schema. Erkannt werden
// nur Etiketten mit der aktuellen Adresse oder einem vom Admin eingetragenen
// Alias (Einstellung etikett_qr_erkennung); mit `alleAdressen` zählt nur der
// hintere Teil. Jeder andere QR-Code (GiroCode, Portal-Links, fremde
// Instanzen) gehört zum Papier und wird mitgescannt.
const ETIKETT = /^(?:https?:\/\/)?([^\s/]+)\/(?:postbuch\/(P\d{6})|mappe\/(S\d{6}))\/?$/i;

/**
 * Kennung (PostID oder Mappennummer) aus dem Inhalt eines Etiketten-QR-Codes, sonst null.
 * @param {string} text Inhalt des QR-Codes
 * @param {{ host?: string, aliase?: string[], alleAdressen?: boolean }} [regel]
 */
export function etikettAusQr(text, { host = globalThis.location?.host, aliase = [], alleAdressen = false } = {}) {
  const treffer = String(text ?? '').trim().match(ETIKETT);
  if (!treffer) return null;
  if (!alleAdressen) {
    const erlaubt = [host, ...aliase].filter(Boolean).map((h) => h.toLowerCase());
    if (!erlaubt.includes(treffer[1].toLowerCase())) return null;
  }
  return (treffer[2] ?? treffer[3]).toUpperCase();
}

/** Mappennummer einer Sammelmappe (S000123)? Sonst ist es eine PostID. */
export const istSammelmappe = (kennung) => kennung.startsWith('S');

/** Seite, die ein erkanntes Etikett öffnet. */
export function etikettPfad(kennung) {
  return istSammelmappe(kennung) ? `/mappe/${kennung}` : `/postbuch/${kennung}`;
}

/**
 * Nativer QR-Leser des Browsers (BarcodeDetector, z. B. Chrome unter Android),
 * liest direkt aus dem Videoelement in voller Auflösung. null, wenn es ihn
 * nicht gibt – dann sucht der Scanner-Worker mit OpenCV.
 */
export async function erstelleNativenQrLeser() {
  if (typeof globalThis.BarcodeDetector !== 'function') return null;
  try {
    const formate = await globalThis.BarcodeDetector.getSupportedFormats();
    if (!formate.includes('qr_code')) return null;
    const leser = new globalThis.BarcodeDetector({ formats: ['qr_code'] });
    return async (quelle) => (await leser.detect(quelle)).map((c) => c.rawValue);
  } catch {
    return null;
  }
}
