/**
 * lib/db-enums.js — Enum-Werte zur Laufzeit aus der Datenbank
 *
 * Die erlaubten Dokumenttypen standen bislang mehrfach im Code (Prompt-Template,
 * Routen-Guards, Frontend-Konstanten) UND als Enum in base_schema.sql. Nur das
 * Enum kann den INSERT sprengen — also ist es die Quelle der Wahrheit, und alles
 * andere leitet sich daraus ab. Sonst bestraft der Validator die KI für einen
 * Wert, den der Prompt ihr selbst vorgegeben hat, und löst dauerhaft Repair-Calls
 * aus.
 *
 * Cache: Enum-Werte ändern sich ausschließlich über base_schema.sql, das beim
 * Container-Start läuft. Ein Prozess-Cache ohne Invalidierung ist deshalb korrekt
 * — anders als bei _settings, die zur Laufzeit über das UI änderbar sind.
 */

import pool from '../db.js';
import { getAktiveCodes } from './taxonomie.js';

const cache = new Map();

/**
 * Werte eines Postgres-Enums, in Deklarationsreihenfolge.
 * @param {string} enumTyp  Voll qualifiziert, z. B. 'postbuch.post_status'
 * @returns {Promise<string[]>}
 */
export async function getEnumValues(enumTyp) {
  const vorhanden = cache.get(enumTyp);
  if (vorhanden) return vorhanden;

  // enum_range() akzeptiert keinen Parameter für den Typnamen — der Wert kommt
  // ausschließlich aus Code-Konstanten dieser Datei, nie aus einer Eingabe.
  const r = await pool.query(`SELECT unnest(enum_range(NULL::${enumTyp}))::text AS v`);
  const werte = r.rows.map((x) => x.v);
  cache.set(enumTyp, werte);
  return werte;
}

/**
 * Die erlaubten Dokumentarten für den verbleibenden Legacy-Adapter.
 * `postbuch.art` ist seit LxD Text; die Taxonomie ist damit die einzige
 * Wahrheit und darf nicht mehr aus dem alten PostgreSQL-Enum gelesen werden.
 */
export async function getPostArten() {
  return (await getAktiveCodes()).dokumentarten;
}

/**
 * Case-insensitiver Abgleich gegen eine Werteliste.
 * Liefert den KANONISCHEN Wert oder null. Bewusst nur Groß-/Kleinschreibung und
 * Randleerzeichen — kein Fuzzy-Matching, weil ein „fast passender" Dokumenttyp
 * eine inhaltliche Fehlklassifikation wäre, keine Schreibvariante.
 */
export function kanonisiere(wert, erlaubt) {
  if (typeof wert !== 'string') return null;
  const gesucht = wert.trim().toLowerCase();
  if (!gesucht) return null;
  return erlaubt.find((e) => e.toLowerCase() === gesucht) || null;
}
