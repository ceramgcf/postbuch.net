/**
 * Keyset-Paginierung für die Dokumentliste (Endlos-Scrollen).
 *
 * Der Cursor ist opak (base64url-JSON) und hält Sortierung, Richtung, den
 * Sortwert der letzten Zeile als Text und deren postid. Gegenüber OFFSET
 * verschiebt sich nichts, wenn zwischendurch Dokumente hinzukommen.
 *
 * Reihenfolge der Liste: ORDER BY <ausdruck> <ASC|DESC> NULLS LAST, p.postid DESC.
 * Der Tiebreak läuft unabhängig von der Richtung immer absteigend über postid.
 */

// Sortierspalte → SQL-Typ, in den der Text-Sortwert zurückgecastet wird.
export const KEYSET_TYPEN = {
  briefdatum: 'date',
  erfassungsdatum: 'date',
  kontakt: 'text',
  art: 'text',
  postid: 'text',
  betrag: 'numeric',
};

export function kodiereCursor({ sort, order, wert, postid }) {
  const json = JSON.stringify({ s: sort, o: order, v: wert ?? null, id: postid });
  return Buffer.from(json, 'utf8').toString('base64url');
}

/** @returns {{sort, order, wert, postid} | null} – null bei jeder Unstimmigkeit */
export function dekodiereCursor(cursor) {
  if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > 1024) return null;
  let roh;
  try {
    roh = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!roh || typeof roh !== 'object') return null;
  const { s, o, v, id } = roh;
  if (!Object.hasOwn(KEYSET_TYPEN, s)) return null;
  if (o !== 'asc' && o !== 'desc') return null;
  if (v !== null && (typeof v !== 'string' || v.length > 500)) return null;
  if (typeof id !== 'string' || !/^[A-Z]\d{1,12}$/.test(id)) return null;
  return { sort: s, order: o, wert: v, postid: id };
}

/**
 * WHERE-Bedingung „Zeilen nach dem Cursor“.
 * @param {string} ausdruck  Sortierausdruck (aus der Whitelist der Route)
 * @param {number} idx       nächste freie Parameternummer
 * @returns {{ sql: string, params: unknown[] }}
 */
export function keysetBedingung({ ausdruck, sort, order, wert, postid, idx }) {
  const typ = KEYSET_TYPEN[sort];
  if (!typ) throw new Error(`Keine Keyset-Sortierung für ${sort}`);
  if (wert === null) {
    // Cursor steht schon im NULL-Block am Ende: nur noch dort weiter
    return { sql: `(${ausdruck} IS NULL AND p.postid < $${idx})`, params: [postid] };
  }
  const vgl = order === 'asc' ? '>' : '<';
  const v = `$${idx}::${typ}`;
  const id = `$${idx + 1}`;
  return {
    sql: `(${ausdruck} ${vgl} ${v} OR (${ausdruck} = ${v} AND p.postid < ${id}) OR ${ausdruck} IS NULL)`,
    params: [wert, postid],
  };
}
