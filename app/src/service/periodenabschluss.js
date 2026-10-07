/**
 * service/periodenabschluss.js — Bewertung der Abrechnungsperioden gegen einen
 * Erstattungsbescheid.
 *
 * Fachliches Modell (bewusst schmal gehalten):
 *   - Eine Abrechnungsperiode hat höchstens EINEN Abschlussbescheid
 *     (`abrechnungsperiode_buch.eb_postid`). Derselbe Bescheid darf mehrere
 *     Perioden abschließen — es gibt deshalb keine M:N-Tabelle.
 *   - Sind alle Rechnungen einer eingereichten Periode auf dem Bescheid
 *     enthalten, wird sie COMPLETED.
 *   - Bei einem Teiltreffer bleiben die zugeordneten Rechnungen in der nun
 *     abgeschlossenen Periode; die übrigen wandern automatisch in eine neue
 *     SUBMITTED-Restperiode, die ihre direkte Elternperiode in
 *     `ursprungsperiode` festhält.
 *   - Kein Treffer → die Periode bleibt unverändert. Trifft der Bescheid eine
 *     bereits abgeschlossene Periode (Nachzahlung), entsteht keine zweite
 *     Beziehung zwischen Periode und Bescheid.
 *
 * Die Bewertung liest ihre Trefferliste immer frisch aus
 * `erstattungsbescheid_einzelposition.arz_postid`. Dadurch ist sie für alle
 * Auslöser identisch: Erstverarbeitung, Wiederverarbeitung mit
 * Korrekturanweisung und manuelle Zuordnungsänderung am Bescheid.
 *
 * Wiederholbarkeit entsteht über zwei Phasen:
 *   A. Rücknahme — alles, was dieser Bescheid zuletzt bewirkt hat, wird
 *      zurückgedreht (Restperioden auflösen, Elternperioden wieder SUBMITTED).
 *      Eine Restperiode, an der inzwischen weitergearbeitet wurde, bleibt
 *      unangetastet und wird protokolliert.
 *   B. Bewertung — der aktuelle Trefferstand wird neu angewendet.
 *
 * Gleichzeitigkeit: Beide Phasen sperren zuerst die Bescheidzuordnung des
 * Kostenträgers und danach die Perioden aller berührten Personen (Reihenfolge
 * siehe service/perioden-sperre.js). Erst danach wird gelesen — Treffer,
 * Periodenstatus und Rechnungsbestand stammen damit immer aus dem Stand nach
 * jedem konkurrierenden Bescheid, jeder Einreichung und jeder neuen Rechnung.
 */

import pool from '../db.js';
import { appLog } from '../app-log.js';
import { sperreBescheidzuordnung, sperrePerioden } from './perioden-sperre.js';

/** Periodenspalte der Arztrechnung je Kostenträger. Nie aus Nutzereingaben. */
const PERIODE_SPALTE = {
  PKV: 'abrechnungsperiode_pkv',
  Beihilfe: 'abrechnungsperiode_beihilfe',
};

function periodenSchluessel(person, kostentraeger, periode) {
  return `${person}/${kostentraeger}/${periode}`;
}

/**
 * Führt `arbeit` in einer Transaktion aus — entweder auf einem übergebenen
 * Client (dann gehört die Transaktion dem Aufrufer) oder auf einem eigenen.
 */
async function inTransaktion(db, arbeit) {
  if (db) return arbeit(db);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ergebnis = await arbeit(client);
    await client.query('COMMIT');
    return ergebnis;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Bucht PKV-Prüfvormerkungen und angepinnte Dokumente einer Periode mit um.
 * Ohne Rechnungsfilter (`postids === null`) wandert alles mit — das ist der
 * Fall beim Auflösen einer Restperiode.
 */
async function bucheAnhaengeUm(client, person, kostentraeger, vonPeriode, nachPeriode, postids) {
  if (kostentraeger === 'PKV') {
    await client.query(
      `UPDATE postbuch.beihilfe_kuerzung_pkv_pruefung b
          SET periode = $3, vorherige_periode = $2
        WHERE b.person = $1 AND b.kostentraeger = 'PKV' AND b.periode = $2
          AND ($4::text[] IS NULL OR EXISTS (
                SELECT 1 FROM postbuch.erstattungsbescheid_kuerzung k
                 WHERE k.postid = b.eb_postid AND k.eb_subid = b.eb_subid
                   AND k.kuerzung_id = b.kuerzung_id
                   AND k.arz_postid = ANY($4::text[])))`,
      [person, vonPeriode, nachPeriode, postids],
    );
  }
  await client.query(
    `UPDATE postbuch.dokument_pin SET periode = $4
      WHERE person = $1 AND kostentraeger = $2 AND periode = $3
        AND ($5::text[] IS NULL OR postid = ANY($5::text[]))`,
    [person, kostentraeger, vonPeriode, nachPeriode, postids],
  );
}

/**
 * Prüft, ob eine Restperiode gefahrlos wieder aufgelöst werden darf.
 * @returns {Promise<string|null>} Grund, der dagegen spricht — oder null.
 */
async function ermittleRuecknahmeHindernis(client, person, kostentraeger, rest) {
  if (rest.status !== 'SUBMITTED') return `Status ist ${rest.status}`;
  if (rest.eb_postid) return `hat einen eigenen Bescheid (${rest.eb_postid})`;

  const enkel = await client.query(
    `SELECT 1 FROM postbuch.abrechnungsperiode_buch
      WHERE person = $1 AND kostentraeger = $2 AND ursprungsperiode = $3 LIMIT 1`,
    [person, kostentraeger, rest.periode],
  );
  if (enkel.rows.length > 0) return 'hat selbst eine Restperiode abgegeben';

  // Bewusst OHNE `aktiv`-Filter: Die Zeilen werden beim Bestätigen nur
  // deaktiviert, nie gelöscht, und der Fremdschlüssel steht auf RESTRICT. Eine
  // Periode mit eigener Abrechnungssession ist außerdem fachlich weiterbearbeitet
  // worden und darf nicht stillschweigend verschwinden.
  const session = await client.query(
    `SELECT 1 FROM postbuch._abrechnung_session_ziel
      WHERE person = $1 AND kostentraeger = $2 AND periode = $3 LIMIT 1`,
    [person, kostentraeger, rest.periode],
  );
  if (session.rows.length > 0) return 'war Ziel einer Abrechnungssession';

  return null;
}

/**
 * Phase A — nimmt die Periodenwirkung eines Bescheids zurück.
 *
 * Jede Periode, die diesen Bescheid als Abschluss trägt, verliert ihn wieder
 * (der Trigger `tg_revert_ap_status_on_eb_nulled` stuft sie dabei von COMPLETED
 * auf SUBMITTED zurück). Ihre unveränderten Restperioden werden aufgelöst und
 * deren Rechnungen zurückgebucht.
 *
 * @returns {Promise<{aufgeloest: Array, behalten: Array}>}
 */
async function nimmBescheidwirkungZurueck(client, ebPostid, grund) {
  // Vor der ersten Zeilensperre alle betroffenen Personen sperren. Unter der
  // Bescheidzuordnungs-Sperre ändert niemand sonst, welche Perioden diesen
  // Bescheid tragen; die Menge ist also stabil.
  const betroffen = await client.query(
    `SELECT DISTINCT person, kostentraeger FROM postbuch.abrechnungsperiode_buch WHERE eb_postid = $1`,
    [ebPostid],
  );
  await sperrePerioden(client, betroffen.rows);

  const eltern = await client.query(
    `SELECT person, kostentraeger, periode
       FROM postbuch.abrechnungsperiode_buch
      WHERE eb_postid = $1
      ORDER BY person, kostentraeger, periode
        FOR UPDATE`,
    [ebPostid],
  );

  const aufgeloest = [];
  const behalten = [];

  for (const elternPeriode of eltern.rows) {
    const { person, kostentraeger, periode } = elternPeriode;
    const spalte = PERIODE_SPALTE[kostentraeger];
    if (!spalte) continue;

    const kinder = await client.query(
      `SELECT periode, status, eb_postid
         FROM postbuch.abrechnungsperiode_buch
        WHERE person = $1 AND kostentraeger = $2 AND ursprungsperiode = $3
        ORDER BY periode
          FOR UPDATE`,
      [person, kostentraeger, periode],
    );

    for (const rest of kinder.rows) {
      const hindernis = await ermittleRuecknahmeHindernis(client, person, kostentraeger, rest);
      if (hindernis) {
        behalten.push({ person, kostentraeger, periode: rest.periode, hindernis });
        appLog('WARN', 'periodenabschluss',
          `Restperiode ${periodenSchluessel(person, kostentraeger, rest.periode)} bleibt bestehen: ${hindernis}`,
          { entity: 'postbuch', entityId: ebPostid });
        continue;
      }

      const zurueck = await client.query(
        `UPDATE postbuch.arztrechnung SET ${spalte} = $1
          WHERE behandelte_person = $2 AND ${spalte} = $3
          RETURNING postid`,
        [periode, person, rest.periode],
      );
      await bucheAnhaengeUm(client, person, kostentraeger, rest.periode, periode, null);
      await client.query(
        `DELETE FROM postbuch.abrechnungsperiode_buch
          WHERE person = $1 AND kostentraeger = $2 AND periode = $3`,
        [person, kostentraeger, rest.periode],
      );
      aufgeloest.push({ person, kostentraeger, periode: rest.periode, ursprungsperiode: periode });
      appLog('INFO', 'periodenabschluss',
        `Restperiode ${periodenSchluessel(person, kostentraeger, rest.periode)} aufgelöst `
        + `→ zurück in #${periode} (${zurueck.rows.length} Rg., Grund: ${grund})`,
        { entity: 'postbuch', entityId: ebPostid });
    }

    // Bescheid lösen — der Trigger setzt COMPLETED dabei auf SUBMITTED zurück.
    await client.query(
      `UPDATE postbuch.abrechnungsperiode_buch SET eb_postid = NULL
        WHERE person = $1 AND kostentraeger = $2 AND periode = $3`,
      [person, kostentraeger, periode],
    );
  }

  return { aufgeloest, behalten };
}

/**
 * Ermittelt die Rechnungen, die dieser Bescheid aktuell abrechnet — gruppiert
 * nach der Periode, in der sie gerade liegen.
 */
async function ermittleTreffer(client, ebPostid, spalte) {
  const treffer = await client.query(
    `SELECT DISTINCT a.postid, a.behandelte_person AS person, a.${spalte} AS periode
       FROM postbuch.erstattungsbescheid_einzelposition ep
       JOIN postbuch.arztrechnung a ON a.postid = ep.arz_postid
      WHERE ep.postid = $1 AND ep.arz_postid IS NOT NULL
        AND a.behandelte_person IS NOT NULL AND a.${spalte} IS NOT NULL`,
    [ebPostid],
  );

  const gruppen = new Map();
  for (const zeile of treffer.rows) {
    const schluessel = `${zeile.person} ${zeile.periode}`;
    if (!gruppen.has(schluessel)) {
      gruppen.set(schluessel, { person: zeile.person, periode: zeile.periode, postids: new Set() });
    }
    gruppen.get(schluessel).postids.add(zeile.postid);
  }
  return [...gruppen.values()].sort((a, b) => (
    a.person.localeCompare(b.person) || a.periode - b.periode
  ));
}

/**
 * Phase B — wendet den aktuellen Trefferstand auf die betroffenen Perioden an.
 */
async function bewerteTreffer(client, ebPostid, kostentraeger, grund) {
  const spalte = PERIODE_SPALTE[kostentraeger];
  const abgeschlossen = [];
  const restperioden = [];

  // Erst alle Personen sperren, dann die Treffer lesen. Umgekehrt könnte ein
  // parallel abschließender Vorgang eine Rechnung zwischen Lesen und Sperren
  // in eine Restperiode verschieben — die Gruppe zeigte dann auf die bereits
  // abgeschlossene Elternperiode, und die Restperiode bliebe trotz Treffer offen.
  const personen = await client.query(
    `SELECT DISTINCT a.behandelte_person AS person
       FROM postbuch.erstattungsbescheid_einzelposition ep
       JOIN postbuch.arztrechnung a ON a.postid = ep.arz_postid
      WHERE ep.postid = $1 AND a.behandelte_person IS NOT NULL`,
    [ebPostid],
  );
  await sperrePerioden(client, personen.rows.map(({ person }) => ({ person, kostentraeger })));

  for (const gruppe of await ermittleTreffer(client, ebPostid, spalte)) {
    const { person, periode, postids } = gruppe;

    // Nachsperre für den Fall, dass sich die behandelte Person einer Rechnung
    // seit der Vorab-Abfrage geändert hat. Bereits gehaltene Sperren sind
    // wiedereintrittsfähig und kosten hier nichts.
    await sperrePerioden(client, [{ person, kostentraeger }]);

    const periodenZeile = await client.query(
      `SELECT status, satz FROM postbuch.abrechnungsperiode_buch
        WHERE person = $1 AND kostentraeger = $2 AND periode = $3 FOR UPDATE`,
      [person, kostentraeger, periode],
    );
    if (periodenZeile.rows.length === 0) continue;

    // Nur eingereichte Perioden werden abgeschlossen. Eine bereits
    // abgeschlossene Periode bleibt unangetastet — genau so wird eine
    // Nachzahlung abgebildet, ohne eine zweite Periodenbeziehung zu erzeugen.
    if (periodenZeile.rows[0].status !== 'SUBMITTED') continue;

    const gesperrt = await client.query(
      `SELECT 1 FROM postbuch._abrechnung_session_ziel
        WHERE person = $1 AND kostentraeger = $2 AND periode = $3 AND aktiv LIMIT 1`,
      [person, kostentraeger, periode],
    );
    if (gesperrt.rows.length > 0) {
      appLog('WARN', 'periodenabschluss',
        `Periode ${periodenSchluessel(person, kostentraeger, periode)} nicht abgeschlossen: `
        + 'laufende Abrechnungssession',
        { entity: 'postbuch', entityId: ebPostid });
      continue;
    }

    const alle = await client.query(
      `SELECT postid FROM postbuch.arztrechnung
        WHERE behandelte_person = $1 AND ${spalte} = $2`,
      [person, periode],
    );
    const offen = alle.rows.map((r) => r.postid).filter((id) => !postids.has(id));

    let restPeriode = null;
    if (offen.length > 0) {
      const neue = await client.query(
        `INSERT INTO postbuch.abrechnungsperiode_buch
           (person, kostentraeger, periode, status, satz, ursprungsperiode)
         SELECT $1, $2, COALESCE(MAX(ab.periode), 0) + 1, 'SUBMITTED',
                -- Der Satz der Restperiode ist eine historische Eigenschaft
                -- der Elternperiode. Auch NULL muss unverändert vererbt
                -- werden; ein Personen-Fallback würde die Elternperiode
                -- rückwirkend fachlich falsch darstellen.
                $3::numeric,
                $4
           FROM postbuch.abrechnungsperiode_buch ab
          WHERE ab.person = $1 AND ab.kostentraeger = $2
         RETURNING periode`,
        [person, kostentraeger, periodenZeile.rows[0].satz, periode],
      );
      restPeriode = neue.rows[0].periode;

      await client.query(
        `UPDATE postbuch.arztrechnung SET ${spalte} = $1
          WHERE behandelte_person = $2 AND postid = ANY($3::text[])`,
        [restPeriode, person, offen],
      );
      await bucheAnhaengeUm(client, person, kostentraeger, periode, restPeriode, offen);
      restperioden.push({
        person, kostentraeger, periode: restPeriode, ursprungsperiode: periode, anzahl: offen.length,
      });
    }

    await client.query(
      `UPDATE postbuch.abrechnungsperiode_buch
          SET status = 'COMPLETED', eb_postid = $4
        WHERE person = $1 AND kostentraeger = $2 AND periode = $3 AND status = 'SUBMITTED'`,
      [person, kostentraeger, periode, ebPostid],
    );
    abgeschlossen.push({
      person, kostentraeger, periode, anzahl: postids.size, gesamt: alle.rows.length, restPeriode,
    });

    appLog('INFO', 'periodenabschluss',
      `Periode ${periodenSchluessel(person, kostentraeger, periode)} abgeschlossen `
      + `(${postids.size} von ${alle.rows.length} Rg., Grund: ${grund})`
      + (restPeriode ? ` — ${offen.length} Rg. → neue Restperiode #${restPeriode}` : ''),
      { entity: 'postbuch', entityId: ebPostid });
  }

  return { abgeschlossen, restperioden };
}

/**
 * Nimmt die Periodenwirkung eines Bescheids zurück, ohne sie neu zu bewerten.
 * Wird vor einer Wiederverarbeitung gebraucht: erst danach steht wieder der
 * ungeteilte Rechnungsbestand für das Matching bereit.
 */
/**
 * Sperrt die Bescheidzuordnung für alle Kostenträger, die dieser Bescheid
 * berührt: den gespeicherten und den jeder Periode, die er noch als Abschluss
 * trägt (nach einer Wiederverarbeitung mit geändertem Kostenträger können die
 * beiden auseinanderfallen).
 *
 * @returns {Promise<string|null>} gespeicherter Kostenträger des Bescheids
 */
export async function sperreZuordnungFuerBescheid(client, ebPostid) {
  const r = await client.query(
    `SELECT (SELECT kostentraeger FROM postbuch.erstattungsbescheid WHERE postid = $1) AS kostentraeger,
            ARRAY(SELECT DISTINCT kostentraeger FROM postbuch.abrechnungsperiode_buch
                   WHERE eb_postid = $1) AS perioden_kt`,
    [ebPostid],
  );
  const { kostentraeger, perioden_kt: periodenKt } = r.rows[0];
  // Ohne gespeicherten Kostenträger gibt es nur noch die Perioden, die der
  // Bescheid trägt — ist auch davon keine da, ist nichts zu sperren.
  const zuSperren = [kostentraeger, ...periodenKt].filter((kt) => kt != null);
  if (zuSperren.length > 0) await sperreBescheidzuordnung(client, zuSperren);
  return kostentraeger;
}

export async function setzeBescheidwirkungZurueck(ebPostid, { grund = 'wiederverarbeitung', db = null } = {}) {
  return inTransaktion(db, async (client) => {
    await sperreZuordnungFuerBescheid(client, ebPostid);
    return nimmBescheidwirkungZurueck(client, ebPostid, grund);
  });
}

/**
 * Bewertet alle von einem Erstattungsbescheid berührten Abrechnungsperioden neu.
 *
 * @param {string} ebPostid PostID des Erstattungsbescheids
 * @param {object} [opts]
 * @param {string} [opts.grund] Auslöser, nur fürs Protokoll
 * @param {object} [opts.db] Transaktions-Client des Aufrufers; ohne ihn wird
 *                           eine eigene Transaktion geöffnet
 * @returns {Promise<{abgeschlossen: Array, restperioden: Array, aufgeloest: Array, behalten: Array}>}
 */
export async function bewertePeriodenNachBescheid(ebPostid, { grund = 'bewertung', db = null } = {}) {
  return inTransaktion(db, async (client) => {
    const kostentraeger = await sperreZuordnungFuerBescheid(client, ebPostid);
    if (!PERIODE_SPALTE[kostentraeger]) {
      return { abgeschlossen: [], restperioden: [], aufgeloest: [], behalten: [] };
    }

    const ruecknahme = await nimmBescheidwirkungZurueck(client, ebPostid, grund);
    const bewertung = await bewerteTreffer(client, ebPostid, kostentraeger, grund);
    return { ...bewertung, ...ruecknahme };
  });
}
