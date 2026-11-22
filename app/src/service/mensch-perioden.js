/**
 * Abrechnungsperioden rund um die Kostenträger-Flags eines Menschen.
 *
 * - `ensureMenschCollectingPeriods`: Wer PKV bzw. Beihilfe hat, braucht eine
 *   COLLECTING-Periode, in die neue Rechnungen fallen. Fehlt sie, entsteht die
 *   nächste (MAX+1) – dasselbe Muster wie beim Einreichen.
 * - `findeBelegteSammelperioden`: Vor dem Abwählen eines Flags meldet sie die
 *   COLLECTING-Perioden, die schon Inhalt haben. Die Route verlangt dann eine
 *   ausdrückliche Bestätigung; belegte Perioden bleiben bestehen.
 * - `entferneLeereSammelperioden`: Nach dem Abwählen verschwinden die leeren
 *   COLLECTING-Perioden dieses Kostenträgers.
 * - `ladeAbrechnungsPatienten`: Personenliste für das Lesen von
 *   Erstattungsbescheiden. Nach einer Kündigung kommt der letzte Bescheid erst,
 *   wenn das Flag schon aus ist; deshalb zählt dort auch eine eingereichte
 *   (SUBMITTED) Periode.
 */
import { sperrePerioden } from './perioden-sperre.js';
import { entferneInaktiveSessionZiele, loeseHerkunftAuf } from './abrechnungsperiode.js';

const PERIODEN_SPALTE = { PKV: 'abrechnungsperiode_pkv', Beihilfe: 'abrechnungsperiode_beihilfe' };

/**
 * Legt je aktivem Kostenträger eine COLLECTING-Periode an, falls keine
 * existiert. Für die in `satzUebernehmen` genannten Kostenträger (beim
 * Wiedereinschalten) übernehmen alle COLLECTING-Perioden den neuen Satz –
 * immer, auch wenn er leer ist oder vorher ein anderer Wert galt.
 * Eingereichte und abgeschlossene Perioden bleiben unverändert.
 *
 * @param {import('pg').PoolClient} client  Client mit offener Transaktion
 */
export async function ensureMenschCollectingPeriods(client, {
  kurzname,
  pkv,
  beihilfe,
  pkvSatz = null,
  beihilfeSatz = null,
  satzUebernehmen = [],
}) {
  const kandidaten = [
    ['PKV', pkv, pkvSatz],
    ['Beihilfe', beihilfe, beihilfeSatz],
  ].filter(([, aktiv]) => aktiv);
  if (!kandidaten.length) return;
  // MAX+1 nur unter der Periodensperre (siehe perioden-sperre.js).
  await sperrePerioden(client, kandidaten.map(([kostentraeger]) => ({ person: kurzname, kostentraeger })));
  for (const [kostentraeger, , satz] of kandidaten) {
    // HAVING ohne GROUP BY liefert auch ohne vorhandene Perioden eine Zeile
    // (MAX = NULL → Periode 1).
    await client.query(
      `INSERT INTO postbuch.abrechnungsperiode_buch
         (person, kostentraeger, periode, status, satz)
       SELECT $1, $2, COALESCE(MAX(periode), 0) + 1, 'COLLECTING', $3
         FROM postbuch.abrechnungsperiode_buch
        WHERE person = $1 AND kostentraeger = $2
       HAVING NOT EXISTS (
         SELECT 1 FROM postbuch.abrechnungsperiode_buch
          WHERE person = $1 AND kostentraeger = $2 AND status = 'COLLECTING'
       )
       ON CONFLICT (person, kostentraeger, periode) DO NOTHING`,
      [kurzname, kostentraeger, satz],
    );
    if (satzUebernehmen.includes(kostentraeger)) {
      await client.query(
        `UPDATE postbuch.abrechnungsperiode_buch SET satz = $3
          WHERE person = $1 AND kostentraeger = $2 AND status = 'COLLECTING'`,
        [kurzname, kostentraeger, satz],
      );
    }
  }
}

/**
 * Welche Kostenträger werden durch das Speichern (wieder) eingeschaltet?
 */
export function eingeschalteteKostentraeger(alt, neu) {
  const liste = [];
  if (!alt?.pkv && neu.pkv) liste.push('PKV');
  if (!alt?.beihilfe && neu.beihilfe) liste.push('Beihilfe');
  return liste;
}

/**
 * Welche Kostenträger werden durch das Speichern abgewählt?
 */
export function abgewaehlteKostentraeger(alt, neu) {
  const liste = [];
  if (alt?.pkv && !neu.pkv) liste.push('PKV');
  if (alt?.beihilfe && !neu.beihilfe) liste.push('Beihilfe');
  return liste;
}

/**
 * COLLECTING-Perioden der Person, die Rechnungen oder offene Vormerkungen
 * enthalten. Leere Sammelperioden zählen nicht. Liefert nur Zähler.
 *
 * @param {import('pg').PoolClient} client  Client mit offener Transaktion
 * @returns {Promise<Array<{kostentraeger: string, periode: number, rechnungen: number, vormerkungen: number}>>}
 */
export async function findeBelegteSammelperioden(client, kurzname, kostentraegerListe) {
  const liste = kostentraegerListe.filter((kt) => PERIODEN_SPALTE[kt]);
  if (!liste.length) return [];
  await sperrePerioden(client, liste.map((kostentraeger) => ({ person: kurzname, kostentraeger })));
  const belegt = [];
  for (const kostentraeger of liste) {
    const spalte = PERIODEN_SPALTE[kostentraeger]; // Whitelist, keine Eingabe
    const r = await client.query(
      `SELECT ab.periode,
              (SELECT count(*)::int FROM postbuch.arztrechnung a
                WHERE a.behandelte_person = ab.person AND a.${spalte} = ab.periode) AS rechnungen,
              (SELECT count(*)::int FROM postbuch.dokument_pin d
                WHERE d.person = ab.person AND d.kostentraeger = ab.kostentraeger
                  AND d.periode = ab.periode AND d.status = 'VORGEMERKT')
              + (SELECT count(*)::int FROM postbuch.beihilfe_kuerzung_pkv_pruefung b
                  WHERE b.person = ab.person AND b.kostentraeger = ab.kostentraeger
                    AND b.periode = ab.periode AND b.status = 'VORGEMERKT') AS vormerkungen
         FROM postbuch.abrechnungsperiode_buch ab
        WHERE ab.person = $1 AND ab.kostentraeger = $2 AND ab.status = 'COLLECTING'
        ORDER BY ab.periode`,
      [kurzname, kostentraeger],
    );
    for (const z of r.rows) {
      if (z.rechnungen > 0 || z.vormerkungen > 0) belegt.push({ kostentraeger, ...z });
    }
  }
  return belegt;
}

/**
 * Löscht nach dem Abwählen eines Kostenträgers dessen leere COLLECTING-Perioden:
 * Wer nicht mehr versichert ist, sammelt nichts mehr. Leer heißt: keine
 * Rechnung, kein Anpinnen und keine Prüfvormerkung (jeden Status, beide
 * blockieren per Fremdschlüssel) und kein aktives Ziel einer laufenden
 * Abrechnung. Belegte Perioden bleiben stehen und können eingereicht werden.
 *
 * @param {import('pg').PoolClient} client  Client mit offener Transaktion
 * @returns {Promise<Array<{kostentraeger: string, periode: number}>>}  gelöschte Perioden
 */
export async function entferneLeereSammelperioden(client, kurzname, kostentraegerListe) {
  const liste = kostentraegerListe.filter((kt) => PERIODEN_SPALTE[kt]);
  if (!liste.length) return [];
  await sperrePerioden(client, liste.map((kostentraeger) => ({ person: kurzname, kostentraeger })));
  const geloescht = [];
  for (const kostentraeger of liste) {
    const spalte = PERIODEN_SPALTE[kostentraeger]; // Whitelist, keine Eingabe
    const kandidaten = await client.query(
      `SELECT ab.periode
         FROM postbuch.abrechnungsperiode_buch ab
        WHERE ab.person = $1 AND ab.kostentraeger = $2 AND ab.status = 'COLLECTING'
          AND NOT EXISTS (SELECT 1 FROM postbuch.arztrechnung a
                           WHERE a.behandelte_person = ab.person AND a.${spalte} = ab.periode)
          AND NOT EXISTS (SELECT 1 FROM postbuch.dokument_pin d
                           WHERE d.person = ab.person AND d.kostentraeger = ab.kostentraeger
                             AND d.periode = ab.periode)
          AND NOT EXISTS (SELECT 1 FROM postbuch.beihilfe_kuerzung_pkv_pruefung b
                           WHERE b.person = ab.person AND b.kostentraeger = ab.kostentraeger
                             AND b.periode = ab.periode)
          AND NOT EXISTS (SELECT 1 FROM postbuch._abrechnung_session_ziel z
                           WHERE z.person = ab.person AND z.kostentraeger = ab.kostentraeger
                             AND z.periode = ab.periode AND z.aktiv)
        ORDER BY ab.periode
        FOR UPDATE`,
      [kurzname, kostentraeger],
    );
    for (const { periode } of kandidaten.rows) {
      await loeseHerkunftAuf(client, kurzname, kostentraeger, periode, null);
      await entferneInaktiveSessionZiele(client, kurzname, kostentraeger, periode);
      await client.query(
        `DELETE FROM postbuch.abrechnungsperiode_buch
          WHERE person = $1 AND kostentraeger = $2 AND periode = $3 AND status = 'COLLECTING'`,
        [kurzname, kostentraeger, periode],
      );
      geloescht.push({ kostentraeger, periode });
    }
  }
  return geloescht;
}

/**
 * Personen, die ein Erstattungsbescheid betreffen kann: Flag gesetzt oder
 * eine eingereichte Periode dieses Kostenträgers offen. Für abgewählte Flags
 * gilt der Satz der jüngsten eingereichten Periode.
 *
 * @param {(sql: string, params?: any[]) => Promise<{rows: any[]}>} executor
 * @param {{istTier?: boolean|null}} [opts]  null = Menschen und Tiere
 */
export async function ladeAbrechnungsPatienten(executor, { istTier = null } = {}) {
  const r = await executor(
    `WITH eingereicht AS (
       SELECT DISTINCT ON (person, kostentraeger) person, kostentraeger, satz
         FROM postbuch.abrechnungsperiode_buch
        WHERE status = 'SUBMITTED'
        ORDER BY person, kostentraeger, periode DESC
     )
     SELECT m.kurzname, m.anzeigename AS vollname, m.ist_tier,
            (m.pkv OR ep.person IS NOT NULL) AS pkv,
            (m.beihilfe OR eb.person IS NOT NULL) AS beihilfe,
            CASE WHEN m.pkv THEN m.pkv_satz ELSE ep.satz END AS pkv_satz,
            CASE WHEN m.beihilfe THEN m.beihilfe_satz ELSE eb.satz END AS beihilfe_satz
       FROM postbuch.mensch m
       LEFT JOIN eingereicht ep ON ep.person = m.kurzname AND ep.kostentraeger = 'PKV'
       LEFT JOIN eingereicht eb ON eb.person = m.kurzname AND eb.kostentraeger = 'Beihilfe'
      WHERE ($1::boolean IS NULL OR m.ist_tier = $1)
        AND (m.pkv OR m.beihilfe OR ep.person IS NOT NULL OR eb.person IS NOT NULL)
      ORDER BY m.kurzname`,
    [istTier],
  );
  return r.rows;
}
