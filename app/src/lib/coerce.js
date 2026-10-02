/**
 * lib/coerce.js — Konvertierung von KI-/Fremddaten in DB-taugliche Werte
 *
 * Zuvor lagen toDate/toNumeric/toStr byte-identisch in service/document-inserter.js
 * und service/erstattungsbescheid.js, und der Haupt-Insert in
 * service/document-processor.js hatte gar keine. Diese Datei ist jetzt die einzige
 * Quelle.
 *
 * Wichtig zur Semantik: Diese Funktionen sind WHITELIST-Konvertierer. Was nicht
 * sicher erkannt wird, kommt als null zurück — niemals als unveränderter Rohwert.
 * Die alten Fassungen gaben bei unbekanntem Format den Eingabestring zurück und
 * ließen ihn in eine date-/numeric-Spalte laufen; der Insert starb dann an einer
 * Postgres-Fehlermeldung statt an einer fachlichen Prüfung.
 */

// numeric(12,2) → 10 Vorkommastellen. Beträge darüber sind keine Rechnungen mehr,
// sondern Extraktionsfehler.
export const MAX_BETRAG = 9_999_999_999.99;
// numeric(5,2) → 3 Vorkommastellen (GOÄ-Faktor).
export const MAX_FAKTOR = 999.99;

const DATUM_MIN = '1900-01-01';

/**
 * Zahl aus KI-Ausgabe. Versteht deutsche Notation.
 *
 * Number() allein reichte nicht: Number('1.234,56') und Number('2,3') sind NaN,
 * was in der alten Fassung still zu null (bzw. über `?? 1` zu einem falschen
 * GOÄ-Faktor 1.0) wurde — ein unbemerkter Betragsverlust.
 * Infinity wurde von der alten isNaN-Prüfung ebenfalls durchgelassen; PostgreSQL
 * nimmt 'Infinity' in numeric-Spalten an und vergiftet danach jede SUM().
 *
 * @returns {number|null}
 */
export function toNumeric(val) {
  if (val == null || val === '') return null;

  if (typeof val === 'number') return Number.isFinite(val) ? val : null;

  if (typeof val !== 'string') return null;

  let s = val.trim()
    .replace(/\s/g, '')
    .replace(/(?:€|EUR|eur)$/i, '')
    .replace(/^(?:€|EUR|eur)/i, '');
  if (!s) return null;

  // Deutsche Notation: Punkt als Tausender-, Komma als Dezimaltrenner.
  if (/^-?\d{1,3}(?:\.\d{3})+,\d{1,2}$/.test(s)) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (/^-?\d+,\d{1,2}$/.test(s)) {
    s = s.replace(',', '.');
  } else if (/^-?\d{1,3}(?:\.\d{3})+$/.test(s)) {
    // Reine Tausendergliederung ohne Nachkommastellen: 1.234
    s = s.replace(/\./g, '');
  } else if (!/^-?\d+(?:\.\d+)?$/.test(s)) {
    return null;
  }

  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Betrag mit Bereichsprüfung gegen numeric(12,2).
 * @returns {number|null}
 */
export function toBetrag(val, max = MAX_BETRAG) {
  const n = toNumeric(val);
  if (n == null) return null;
  return Math.abs(n) <= max ? n : null;
}

/**
 * Datum aus KI-Ausgabe als 'YYYY-MM-DD'.
 *
 * Prüft echte Kalendergültigkeit, nicht nur die Form: '2026-13-45' passierte die
 * alte Regex und starb erst im INSERT. Außerdem blockt die Plausibilitätsspanne
 * die Postgres-Sonderwerte ('today', 'now', 'infinity', 'epoch'), die eine
 * date-Spalte sonst klaglos annimmt.
 *
 * @returns {string|null}
 */
export function toDate(val) {
  if (val == null || val === '') return null;
  if (val instanceof Date) {
    return Number.isNaN(val.getTime()) ? null : val.toISOString().slice(0, 10);
  }
  if (typeof val !== 'string') return null;

  const s = val.trim();
  let iso = null;

  const de = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (de) {
    const [, d, m, y] = de;
    iso = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  } else {
    const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (isoMatch) iso = isoMatch[0];
  }
  if (!iso) return null;

  // Kalendergültigkeit: Date normalisiert stillschweigend (2026-02-31 → 2026-03-03),
  // deshalb die Bestandteile gegenprüfen.
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;

  if (iso < DATUM_MIN) return null;
  const obergrenze = new Date(Date.now() + 2 * 365 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  if (iso > obergrenze) return null;

  return iso;
}

/**
 * Zahl mit Vorgabewert für den FEHLENDEN Fall — aber null für den UNLESBAREN.
 *
 * Der Unterschied ist wichtig: `toNumeric(x) ?? 1` würde einen unlesbaren
 * GOÄ-Faktor zu 1.0 machen und damit einen konkreten Wert vortäuschen, wo keiner
 * bekannt ist. Ein fehlendes Feld dagegen darf legitim auf den Fachdefault
 * fallen. Solange toNumeric den Rohwert durchreichte, fiel das nicht auf — der
 * INSERT scheiterte dann laut; seit der Härtung wäre es ein stiller Fehlwert.
 *
 * @returns {number|null}
 */
export function zahlOderVorgabe(val, vorgabe) {
  if (val == null || val === '') return vorgabe;
  return toNumeric(val);
}

/** Trimmter String oder null. */
export function toStr(val) {
  if (val == null) return null;
  if (typeof val === 'object') return null;
  const s = String(val).trim();
  return s || null;
}
