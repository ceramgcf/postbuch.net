// Erzeugt den Anzeige-/Download-Dateinamen für ein Postbuch-PDF:
//   "JJJJ-MM-TT PostID Betreff.pdf"   (Betreff auf 120 Zeichen begrenzt).
// Mirror der serverseitigen Funktion in app/src/routes/files.js, damit
// die `download`-Attribut-Vorgabe im <a>-Tag mit der Server-
// Content-Disposition übereinstimmt.
export function buildPdfFilename(postid, briefdatum, betreff) {
  let datePart = '';
  if (typeof briefdatum === 'string' && briefdatum) {
    datePart = briefdatum.split('T')[0];
  } else if (briefdatum instanceof Date && !isNaN(briefdatum)) {
    const y = briefdatum.getFullYear();
    const m = String(briefdatum.getMonth() + 1).padStart(2, '0');
    const d = String(briefdatum.getDate()).padStart(2, '0');
    datePart = `${y}-${m}-${d}`;
  }
  // eslint-disable-next-line no-control-regex
  const subject = (betreff || '')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  const parts = [datePart, postid, subject].filter(Boolean);
  return `${parts.join(' ')}.pdf`;
}
