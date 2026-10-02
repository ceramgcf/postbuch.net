/**
 * lib/taxonomie.js — zentrale LxD-Taxonomiequelle
 *
 * Anders als DB-Enums ist Taxonomie zur Laufzeit durch Admins pflegbar. Daher
 * bewusst kein Prozess-Cache: Prompt, Validator, API und Pipeline sehen stets
 * dieselben DB-Zeilen.
 */

import pool from '../db.js';

async function ladeTaxonomie({ nurAktiv = true } = {}) {
  const aktivFilter = nurAktiv ? 'WHERE aktiv = true' : '';
  const [lebensbereiche, dokumentarten, aktivierungen] = await Promise.all([
    pool.query(`SELECT code, label, erlaeuterung, builtin, aktiv, sortierung
                  FROM postbuch.lebensbereich ${aktivFilter} ORDER BY sortierung, code`),
    pool.query(`SELECT code, label, erlaeuterung, spezial_pipeline, kompatibilitaetsgruppe,
                       builtin, aktiv, sortierung
                  FROM postbuch.dokumentart ${aktivFilter} ORDER BY sortierung, code`),
    pool.query('SELECT lebensbereich_code, dokumentart_code, builtin FROM postbuch.sd_aktivierung'),
  ]);

  return {
    lebensbereiche: lebensbereiche.rows,
    dokumentarten: dokumentarten.rows,
    aktivierungen: aktivierungen.rows,
  };
}

/** Aktive, für neue Klassifikationen zulässige Taxonomie. */
export function getAktiveTaxonomie() {
  return ladeTaxonomie({ nurAktiv: true });
}

/** Vollständige Taxonomie inklusive ausgemusterter, aber referenzierter Werte. */
export function getGesamteTaxonomie() {
  return ladeTaxonomie({ nurAktiv: false });
}

/** Aktive Codes für Prompt und Validator. */
export async function getAktiveCodes() {
  const { lebensbereiche, dokumentarten } = await getAktiveTaxonomie();
  return {
    lebensbereiche: lebensbereiche.map(({ code }) => code),
    dokumentarten: dokumentarten.map(({ code }) => code),
  };
}

/**
 * Bestimmt ausschließlich aus DB-Taxonomie den spezialisierten Folgepfad.
 * Die LLM-Antwort selbst kann keine Spezialpipeline nominieren.
 */
export async function resolveSpezialpipeline(lebensbereich, dokumentart) {
  const { rows } = await pool.query(
    `SELECT d.spezial_pipeline
       FROM postbuch.dokumentart d
       JOIN postbuch.sd_aktivierung a ON a.dokumentart_code = d.code
      WHERE d.code = $1 AND a.lebensbereich_code = $2`,
    [dokumentart, lebensbereich],
  );
  return rows[0]?.spezial_pipeline || null;
}

/**
 * Effektive Verarbeitungsgruppe eines L×D-Paars. Eine Spezialpipeline zählt
 * nur, wenn sie für genau diese Kombination aktiviert ist; sonst ist das
 * Dokument generisch. Diese Funktion ist die einzige Grundlage für Inserter
 * und spätere manuelle Typwechsel.
 */
export async function effektiveGruppe(lebensbereich, dokumentart) {
  return (await resolveSpezialpipeline(lebensbereich, dokumentart)) || 'generisch';
}
