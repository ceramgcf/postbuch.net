/**
 * lib/personen-auswahl.js — Mehrfachauswahl von Personen als Filter
 *
 * Format im Query-String: kommagetrennte Kurznamen, optional ergänzt um
 * `_ohne` für „ohne Personenzuordnung“, z. B. `?personen=anna,ben,_ohne`.
 * Kurznamen bestehen nur aus [a-zA-Z0-9_.-] und beginnen nie mit _ – Komma
 * und `_ohne` können also nicht mit einem echten Kurznamen kollidieren.
 */

export const PERSON_OHNE = '_ohne';
const NAME_RE = /^[a-zA-Z0-9_.-]{1,64}$/;

/**
 * @param {unknown} raw  Query-Wert
 * @returns {{namen:string[], ohne:boolean}|null}  null = kein Filter.
 *   Kurznamen werden kleingeschrieben geliefert (Vergleich über LOWER()).
 */
export function parsePersonenAuswahl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const namen = new Set();
  let ohne = false;
  for (const teil of raw.split(',')) {
    const t = teil.trim();
    if (t === PERSON_OHNE) ohne = true;
    else if (NAME_RE.test(t) && !t.startsWith('_')) namen.add(t.toLowerCase());
  }
  return { namen: [...namen], ohne };
}

/**
 * SQL-Bedingung „Spalte gehört zur Auswahl“. Hängt höchstens einen Parameter
 * an `params` an. Eine Auswahl ohne gültigen Eintrag trifft nichts.
 *
 * @param {string} spalte  z. B. 'p.familienmitglied'
 * @param {{namen:string[], ohne:boolean}|null} auswahl
 * @param {Array} params
 * @returns {string|null}  null = nicht filtern
 */
export function personenBedingung(spalte, auswahl, params) {
  if (!auswahl) return null;
  const teile = [];
  if (auswahl.ohne) teile.push(`NULLIF(${spalte}, '') IS NULL`);
  if (auswahl.namen.length) {
    params.push(auswahl.namen);
    teile.push(`LOWER(${spalte}) = ANY($${params.length}::text[])`);
  }
  return teile.length ? `(${teile.join(' OR ')})` : 'FALSE';
}

/**
 * Akten haben keine eigene Person: Eine Akte gehört zu einer Person, sobald sie
 * ein Dokument dieser Person enthält, und gilt als „ohne Zuordnung“, wenn keins
 * ihrer Dokumente einer Person zugeordnet ist.
 *
 * @param {string} akteidSpalte  z. B. 'a.akteid'
 */
export function aktenPersonenBedingung(akteidSpalte, auswahl, params) {
  if (!auswahl) return null;
  const dokumente = (bedingung) => `SELECT 1 FROM postbuch.akte_dokument pa_ad
      JOIN postbuch.postbuch pa_p ON pa_p.postid = pa_ad.postid
     WHERE pa_ad.akteid = ${akteidSpalte} AND ${bedingung}`;
  const teile = [];
  if (auswahl.ohne) teile.push(`NOT EXISTS (${dokumente(`NULLIF(pa_p.familienmitglied, '') IS NOT NULL`)})`);
  if (auswahl.namen.length) {
    params.push(auswahl.namen);
    teile.push(`EXISTS (${dokumente(`LOWER(pa_p.familienmitglied) = ANY($${params.length}::text[])`)})`);
  }
  return teile.length ? `(${teile.join(' OR ')})` : 'FALSE';
}
