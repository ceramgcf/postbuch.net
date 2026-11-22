/**
 * lib/suchspalten.js – gespeicherte Suchspalten aus Antworten entfernen
 *
 * postbuch.postbuch und postbuch.akte tragen die generierten Spalten
 * suchtext und suchvektor (base_schema.sql, Abschnitt „Wortsuche“). Sie dienen
 * nur dem Index der Wortsuche und landen über SELECT * bzw. RETURNING * sonst
 * in API-Antworten und Rückgängig-Schnappschüssen.
 */
export function ohneSuchspalten(zeile) {
  if (zeile && typeof zeile === 'object') {
    delete zeile.suchtext;
    delete zeile.suchvektor;
  }
  return zeile;
}
