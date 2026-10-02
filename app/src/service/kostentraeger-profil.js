/**
 * service/kostentraeger-profil.js — Verwaltung der Kostenträger-Profile
 *
 * Ein Profil beschreibt rein deskriptiv das Layout eines bekannten
 * Kostenträger-Absenders (z. B. Debeka, eine Beihilfestelle) und wird dem
 * generischen EB-Parse-Prompt optional beigelegt (siehe
 * prompts/erstattungsbescheid.js, buildProfilBlock). Plan:
 * internaldocs/FEATURE_KOSTENTRAEGER_PROFILE.md.
 *
 * Höchstens 5 Profile dürfen gleichzeitig aktiv sein (Prompt-Länge). Es gibt
 * bewusst keine Bearbeiten-Funktion: Der Korrekturpfad für ein schlechtes
 * Profil ist Löschen + Neu-Profilieren, nicht Editieren (kein Versions-/
 * Änderungsverlauf im Schema).
 */

import pool from '../db.js';
import { KOSTENTRAEGER_PROFIL_KATALOG, findKatalogEintrag } from '../lib/kostentraeger-profil-katalog.js';

export const MAX_AKTIVE_PROFILE = 5;

export class ProfilAktivierungsFehler extends Error {
  constructor(message, aktiveNamen) {
    super(message);
    this.status = 409;
    this.aktiveNamen = aktiveNamen;
  }
}

export class ProfilValidierungsFehler extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

const PROFIL_SPALTEN = 'id, name, kostentraeger, profiltext, aktiv, quelle, erzeugt_von_modell, erzeugt_am, aktualisiert_am, katalog_schluessel, katalog_version';

export async function listProfile() {
  const { rows } = await pool.query(
    `SELECT ${PROFIL_SPALTEN}
     FROM postbuch.kostentraeger_profil
     ORDER BY kostentraeger, name`
  );
  return rows.map((row) => {
    if (!row.katalog_schluessel) return row;
    const eintrag = findKatalogEintrag(row.katalog_schluessel);
    return { ...row, updateVerfuegbar: !!eintrag && eintrag.version > row.katalog_version };
  });
}

/**
 * Katalog der mitgelieferten Profile, angereichert mit dem Materialisierungs-
 * status auf dieser Instanz (noch nie aktiviert / materialisiert+aktiv/inaktiv /
 * Update verfügbar). Dient dem UI, um den "nicht aktivierte Vorlagen"-Bereich
 * getrennt von den bereits materialisierten Zeilen darzustellen.
 */
export async function listKatalog() {
  const { rows } = await pool.query(
    `SELECT id, name, aktiv, katalog_schluessel, katalog_version
     FROM postbuch.kostentraeger_profil
     WHERE katalog_schluessel IS NOT NULL`
  );
  const byKey = new Map(rows.map((r) => [r.katalog_schluessel, r]));
  return KOSTENTRAEGER_PROFIL_KATALOG.map((eintrag) => {
    const zeile = byKey.get(eintrag.schluessel);
    return {
      schluessel: eintrag.schluessel,
      name: eintrag.name,
      kostentraeger: eintrag.kostentraeger,
      version: eintrag.version,
      materialisiert: !!zeile,
      profilId: zeile?.id ?? null,
      aktiv: zeile?.aktiv ?? false,
      updateVerfuegbar: !!zeile && eintrag.version > zeile.katalog_version,
    };
  });
}

/**
 * Materialisiert einen Katalogeintrag beim ersten Aktivieren als Zeile
 * (quelle='mitgeliefert') und aktiviert sie sofort — respektiert dabei das
 * 5er-Limit über aktiviereProfil(). Ist der Eintrag bereits materialisiert,
 * wird nur die vorhandene Zeile aktiviert (kein Duplikat, siehe UNIQUE-Index
 * auf katalog_schluessel).
 */
export async function aktiviereAusKatalog(schluessel) {
  const eintrag = findKatalogEintrag(schluessel);
  if (!eintrag) throw new ProfilValidierungsFehler('Unbekannter Katalog-Schlüssel.');

  // ON CONFLICT statt SELECT-then-INSERT: der UNIQUE-Index auf katalog_schluessel
  // verhindert eine Duplikatzeile bei zwei parallelen Requests ohnehin, so bekommt
  // der "Verlierer" aber sein Ergebnis über die Nachfrage statt eine rohe 23505-Exception.
  const { rows: eingefuegt } = await pool.query(
    `INSERT INTO postbuch.kostentraeger_profil (name, kostentraeger, profiltext, quelle, katalog_schluessel, katalog_version)
     VALUES ($1, $2, $3, 'mitgeliefert', $4, $5)
     ON CONFLICT (katalog_schluessel) WHERE katalog_schluessel IS NOT NULL DO NOTHING
     RETURNING id`,
    [eintrag.name, eintrag.kostentraeger, eintrag.profiltext, eintrag.schluessel, eintrag.version],
  );
  let id = eingefuegt[0]?.id;
  if (!id) {
    const { rows } = await pool.query(
      `SELECT id FROM postbuch.kostentraeger_profil WHERE katalog_schluessel = $1`,
      [schluessel],
    );
    id = rows[0]?.id;
  }
  return aktiviereProfil(id);
}

/**
 * Übernimmt eine im Code geänderte Katalog-Fassung in eine bereits
 * materialisierte Zeile. Das UI erzwingt vorher den JSON-Export der alten
 * Fassung (Sicherheitsnetz); diese Funktion vertraut darauf und schreibt
 * profiltext/name/kostentraeger sowie katalog_version fort. aktiv/id bleiben
 * unverändert, damit ein bereits gepinnter Verweis von Bescheiden gültig bleibt.
 */
export async function uebernimmKatalogUpdate(id) {
  const { rows: zeilen } = await pool.query(
    `SELECT katalog_schluessel FROM postbuch.kostentraeger_profil WHERE id = $1`,
    [id],
  );
  if (!zeilen.length) throw new Error('Profil nicht gefunden.');
  const schluessel = zeilen[0].katalog_schluessel;
  if (!schluessel) throw new ProfilValidierungsFehler('Kein mitgeliefertes Profil mit Katalog-Bezug.');
  const eintrag = findKatalogEintrag(schluessel);
  if (!eintrag) throw new ProfilValidierungsFehler('Katalogeintrag existiert nicht mehr.');

  const { rows } = await pool.query(
    `UPDATE postbuch.kostentraeger_profil
     SET name = $1, kostentraeger = $2, profiltext = $3, katalog_version = $4, aktualisiert_am = now()
     WHERE id = $5
     RETURNING ${PROFIL_SPALTEN}`,
    [eintrag.name, eintrag.kostentraeger, eintrag.profiltext, eintrag.version, id],
  );
  return rows[0];
}

/**
 * Aktiviert ein Profil. Serialisiert über einen transaktionalen Advisory-Lock,
 * damit zwei gleichzeitige Aktivierungen nicht beide am selben (noch
 * ungezählten) 5er-Limit vorbeikommen. Bei Erreichen des Limits: 409 mit den
 * Namen der 5 bereits aktiven Profile, kein automatisches Deaktivieren.
 */
export async function aktiviereProfil(id) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('kostentraeger_profil_aktivierung'))`);

    const aktiveResult = await client.query(
      `SELECT id, name FROM postbuch.kostentraeger_profil WHERE aktiv = true ORDER BY name`
    );
    const bereitsAktiv = aktiveResult.rows.some((r) => r.id === id);

    if (!bereitsAktiv && aktiveResult.rowCount >= MAX_AKTIVE_PROFILE) {
      await client.query('ROLLBACK');
      throw new ProfilAktivierungsFehler(
        `Es sind bereits ${MAX_AKTIVE_PROFILE} Profile aktiv. Zuerst eines davon deaktivieren.`,
        aktiveResult.rows.map((r) => r.name),
      );
    }

    const updateResult = await client.query(
      `UPDATE postbuch.kostentraeger_profil SET aktiv = true, aktualisiert_am = now()
       WHERE id = $1
       RETURNING id, name, kostentraeger, profiltext, aktiv, quelle, erzeugt_von_modell, erzeugt_am, aktualisiert_am`,
      [id],
    );
    if (!updateResult.rowCount) {
      await client.query('ROLLBACK');
      throw new Error('Profil nicht gefunden.');
    }

    await client.query('COMMIT');
    return updateResult.rows[0];
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function deaktiviereProfil(id) {
  const { rows, rowCount } = await pool.query(
    `UPDATE postbuch.kostentraeger_profil SET aktiv = false, aktualisiert_am = now()
     WHERE id = $1
     RETURNING id, name, kostentraeger, profiltext, aktiv, quelle, erzeugt_von_modell, erzeugt_am, aktualisiert_am`,
    [id],
  );
  if (!rowCount) throw new Error('Profil nicht gefunden.');
  return rows[0];
}

/**
 * Aktiviert ein frisch angelegtes Profil, sofern noch ein Slot frei ist. Ist
 * das Limit erreicht, bleibt das Profil gespeichert und inaktiv — das ist kein
 * Fehlerfall, sondern der Normalzustand bei 5 aktiven Profilen.
 *
 * Nur für selbst extrahierte Profile (profiliereAkte() in
 * service/kostentraeger-profilierung.js): deren Text hat die Instanz aus den
 * eigenen Bescheiden erzeugt. Importierte Profile laufen bewusst nicht hier
 * durch, siehe importiereProfil().
 *
 * @param {object} profil - die eben eingefügte Zeile
 * @returns {Promise<{ profil: object, aktiviert: boolean, hinweis?: string }>}
 */
export async function versucheAktivierung(profil) {
  try {
    return { profil: await aktiviereProfil(profil.id), aktiviert: true };
  } catch (err) {
    if (err instanceof ProfilAktivierungsFehler) {
      return {
        profil,
        aktiviert: false,
        hinweis: `Profil wurde gespeichert, aber nicht automatisch aktiviert: ${err.message}`,
      };
    }
    throw err;
  }
}

/**
 * Importiert ein Profil aus einer vom Admin hochgeladenen .json-Datei (z. B.
 * ein per "JSON exportieren" erzeugtes File eines anderen Kostenträger-
 * Profils, oder eines, das die Community per GitHub-Issue beigesteuert hat).
 * Validiert dieselben Grenzen wie das DB-Schema, damit ein Fehler als 400 mit
 * verständlichem Text zurückkommt statt als rohem Constraint-Fehler.
 *
 * Ein importiertes Profil wird bewusst NICHT automatisch aktiviert — anders als
 * ein selbst extrahiertes (profiliereAkte). Der Profiltext stammt hier aus
 * fremder Hand und geht bei Aktivierung wörtlich in den Auswertungs-Prompt für
 * Erstattungsbescheide ein. Zwischen "Datei geöffnet" und "fremder Text
 * beeinflusst die Auswertung" gehört deshalb ein bewusster zweiter Klick des
 * Admins über "Aktivieren" — die Karte im Frontend zeigt den vollen Text davor
 * an. Das ist dieselbe Sorgfalt, die der Export-Dialog beim Weitergeben
 * verlangt, nur in umgekehrter Richtung.
 */
export async function importiereProfil({ name, kostentraeger, profiltext } = {}) {
  const trimmedName = typeof name === 'string' ? name.trim() : '';
  const trimmedText = typeof profiltext === 'string' ? profiltext.trim() : '';

  if (!trimmedName) throw new ProfilValidierungsFehler('Name fehlt.');
  if (trimmedName.length > 200) throw new ProfilValidierungsFehler('Name zu lang (max. 200 Zeichen).');
  if (!['PKV', 'Beihilfe'].includes(kostentraeger)) {
    throw new ProfilValidierungsFehler('Kostenträger muss "PKV" oder "Beihilfe" sein.');
  }
  if (!trimmedText) throw new ProfilValidierungsFehler('Profiltext fehlt.');
  if (trimmedText.length > 4000) throw new ProfilValidierungsFehler('Profiltext zu lang (max. 4000 Zeichen).');

  const { rows } = await pool.query(
    `INSERT INTO postbuch.kostentraeger_profil (name, kostentraeger, profiltext, quelle)
     VALUES ($1, $2, $3, 'importiert')
     RETURNING id, name, kostentraeger, profiltext, aktiv, quelle, erzeugt_von_modell, erzeugt_am, aktualisiert_am`,
    [trimmedName, kostentraeger, trimmedText],
  );
  return {
    profil: rows[0],
    aktiviert: false,
    hinweis: 'Das Profil ist gespeichert, aber noch inaktiv. Lies den Text durch und aktiviere es erst dann.',
  };
}

export async function loescheProfil(id) {
  const { rowCount } = await pool.query(
    `DELETE FROM postbuch.kostentraeger_profil WHERE id = $1`,
    [id],
  );
  if (!rowCount) throw new Error('Profil nicht gefunden.');
}
