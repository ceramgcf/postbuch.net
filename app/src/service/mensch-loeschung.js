/**
 * Endgültiges Löschen eines Menschen — Vorschau und Ausführung.
 *
 * Ein Mensch ist mit Dokumenten nur über den Text `kurzname` verbunden (bewusst
 * ohne Fremdschlüssel, siehe base_schema.sql). Es gibt deshalb keine Kaskade,
 * die das Aufräumen für uns erledigt — jede Referenzstelle wird hier explizit
 * behandelt. Wer eine neue kurzname-Referenz einführt, muss sie hier ergänzen.
 *
 * Drei Modi:
 *   'nur-frei'   — löscht nur, wenn gar keine Referenz existiert (Standardweg).
 *   'bezuege'    — Dokumente bleiben unverändert bestehen und verlieren nur die
 *                  Personenzuordnung.
 *   'dokumente'  — Dokumente dieser Person werden gelöscht (DB + Papierkorb der
 *                  Ablage). Dokumente, an denen weitere Menschen hängen, bleiben
 *                  erhalten; dort wird nur der Bezug dieser Person entfernt.
 *
 * Vorschau und Ausführung teilen sich `ermittleBetroffene()`. Das ist Absicht:
 * zwei Formulierungen derselben Klassifikation würden früher oder später
 * auseinanderlaufen, und die Vorschau ist hier die Entscheidungsgrundlage für
 * eine unumkehrbare Aktion.
 */
import { getClient, query } from '../db.js';
import { revokeUserAccess } from './session-revocation.js';
import { verschiebeInPapierkorb } from './document-delete.js';
import { appLog } from '../app-log.js';
import { uiLog } from '../log.js';
import * as tracker from '../jobs/tracker.js';
import {
  pruefeMehrereArzLoeschschutzUnterLock,
  ermittleArzLoeschschutzMehrere,
  pruefeMehrereBescheidLoeschschutzUnterLock,
  pruefeMehrereDokumentPinLoeschschutzUnterLock,
  pruefeErsetzungLoeschschutz,
  ERSETZUNG_DELETE_PROTECTED_CODE,
  DELETE_PROTECTED_CODE,
  BESCHEID_DELETE_PROTECTED_CODE,
  DOKUMENT_PIN_DELETE_PROTECTED_CODE,
} from './document-delete-protection.js';

export const MODI = ['nur-frei', 'bezuege', 'dokumente'];

/** Fachlicher Fehler mit HTTP-Status — die Route mappt ihn nur noch durch. */
export class LoeschFehler extends Error {
  constructor(status, message, details = {}) {
    super(message);
    this.status = status;
    Object.assign(this, details);
  }
}

export function bestaetigungssatz(kurzname) {
  return `Alle Dokumente von ${kurzname} löschen`;
}

/**
 * Normalisierung für den Bestätigungssatz: case- und satzzeichenunempfindlich.
 * NFKC und das Entfernen unsichtbarer Zeichen verhindern, dass eine optisch
 * korrekte Eingabe (Copy/Paste, Mobiltastatur) technisch nicht matcht.
 * Bewusst `toLowerCase()` statt `toLocaleLowerCase()` — letzteres macht aus
 * einem `I` unter türkischer Locale ein `ı`.
 */
export function normalisiereBestaetigung(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .replace(/[\u200B\u200C\u200D\u2060\uFEFF]/g, "")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Alle Dokumente, an denen der Mensch hängt — klassifiziert danach, ob er der
 * einzige beteiligte Mensch ist.
 *
 * Ein Dokument gilt als Mischdokument, sobald irgendein Feld einen ANDEREN
 * Menschen nennt. Das umfasst nicht nur mehrere Patienten in einem
 * Erstattungsbescheid, sondern auch den häufigeren Fall „Rechnung adressiert an
 * ein Elternteil, Patient ist das Kind" — Adressat und Patient sind getrennte
 * Felder auf derselben Zeile.
 */
async function ermittleBetroffene(q, kurzname) {
  const { rows } = await q(
    `WITH beruehrt AS (
         SELECT postid FROM postbuch.postbuch WHERE familienmitglied = $1
         UNION SELECT postid FROM postbuch.arztrechnung WHERE behandelte_person = $1
         UNION SELECT postid FROM postbuch.arztbericht WHERE behandelte_person = $1
         UNION SELECT postid FROM postbuch.erstattungsbescheid_einzelposition WHERE behandelte_person = $1
       ),
       fremd AS (
         SELECT postid FROM postbuch.postbuch
           WHERE postid IN (SELECT postid FROM beruehrt)
             AND familienmitglied IS NOT NULL AND familienmitglied <> $1
         UNION SELECT postid FROM postbuch.arztrechnung
           WHERE postid IN (SELECT postid FROM beruehrt)
             AND behandelte_person IS NOT NULL AND behandelte_person <> $1
         UNION SELECT postid FROM postbuch.arztbericht
           WHERE postid IN (SELECT postid FROM beruehrt)
             AND behandelte_person IS NOT NULL AND behandelte_person <> $1
         UNION SELECT postid FROM postbuch.erstattungsbescheid_einzelposition
           WHERE postid IN (SELECT postid FROM beruehrt)
             AND behandelte_person IS NOT NULL AND behandelte_person <> $1
       )
       SELECT p.postid, p.betreff, p.dokumentart AS art,
              p.storage_id, p.storage_backend,
              (f.postid IS NOT NULL) AS misch
         FROM beruehrt b
         JOIN postbuch.postbuch p ON p.postid = b.postid
         LEFT JOIN fremd f ON f.postid = b.postid
        ORDER BY p.postid`,
    [kurzname],
  );
  return {
    komplett: rows.filter((r) => !r.misch),
    misch: rows.filter((r) => r.misch),
  };
}

/** Zählt die Referenzen je Kategorie — dieselbe Logik wie die Menschen-Liste. */
async function zaehleReferenzen(q, kurzname) {
  const { rows } = await q(
    `SELECT
       (SELECT count(*)::int FROM postbuch.arztrechnung WHERE behandelte_person = $1) AS arz,
       (SELECT count(*)::int FROM postbuch.arztbericht WHERE behandelte_person = $1) AS ab,
       (SELECT count(*)::int FROM postbuch.erstattungsbescheid_einzelposition WHERE behandelte_person = $1) AS eb,
       (SELECT count(*)::int FROM postbuch.postbuch WHERE familienmitglied = $1) AS adr`,
    [kurzname],
  );
  return rows[0];
}

async function ladeMensch(q, id, { fuerUpdate = false } = {}) {
  const { rows } = await q(
    `SELECT id, kurzname, anzeigename, archiviert, loginfaehig, anmeldename
       FROM postbuch.mensch WHERE id = $1${fuerUpdate ? ' FOR UPDATE' : ''}`,
    [id],
  );
  if (!rows.length) throw new LoeschFehler(404, 'Mensch nicht gefunden.');
  return rows[0];
}

/**
 * Vorbedingungen, die für JEDEN Modus gelten. Werden bei der Ausführung erneut
 * gegen die frisch gesperrte DB-Zeile geprüft, nie gegen Werte aus der Vorschau.
 */
function pruefeVorbedingungen(mensch) {
  if (!mensch.archiviert) {
    throw new LoeschFehler(409, 'Nur archivierte Personen können endgültig gelöscht werden. Bitte zuerst archivieren.');
  }
  if (mensch.loginfaehig) {
    throw new LoeschFehler(409, 'Dieser Mensch besitzt einen App-Zugang. Bitte zuerst den Zugang deaktivieren.');
  }
}

/** Lesende Vorschau: was würde passieren? Ändert nichts. */
export async function erstelleVorschau(id) {
  const mensch = await ladeMensch(query, id);
  const [referenzen, betroffene] = await Promise.all([
    zaehleReferenzen(query, mensch.kurzname),
    ermittleBetroffene(query, mensch.kurzname),
  ]);

  const { rows: perioden } = await query(
    `SELECT kostentraeger, periode, status::text AS status
       FROM postbuch.abrechnungsperiode_buch WHERE person = $1
      ORDER BY kostentraeger, periode`,
    [mensch.kurzname],
  );

  // Dynamische Saldo-Quellen tragen den Kurznamen als Literal in ihrem SQL.
  // Das kann keine Kaskade reparieren — der Nutzer muss es selbst nacharbeiten.
  // strpos statt ILIKE: ein `_` im Kurznamen wäre sonst ein Platzhalter.
  const { rows: saldoQuellen } = await query(
    `SELECT quelle_id, name FROM postbuch.saldo_quelle
      WHERE strpos(lower(buchungen_sql), lower($1)) > 0 ORDER BY quelle_id`,
    [mensch.kurzname],
  );

  // Perioden ANDERER Menschen, deren Erstattungsbescheid wir löschen würden:
  // dort fällt der Status per Trigger von COMPLETED auf SUBMITTED zurück.
  const komplettIds = betroffene.komplett.map((d) => d.postid);
  // Kein `.query()`-Objekt nötig: Vorschau ist read-only, Default-Parameter
  // (Pool) reicht. `query` aus db.js ist eine nackte Funktion ohne `.query`.
  const geschuetzteArztrechnungen = await ermittleArzLoeschschutzMehrere(komplettIds);
  const { rows: fremdePerioden } = komplettIds.length
    ? await query(
      `SELECT person, kostentraeger, periode, status::text AS status
         FROM postbuch.abrechnungsperiode_buch
        WHERE eb_postid = ANY($1) AND person <> $2
        ORDER BY person, kostentraeger, periode`,
      [komplettIds, mensch.kurzname],
    )
    : { rows: [] };

  const gesamt = betroffene.komplett.length + betroffene.misch.length;
  return {
    mensch: { id: mensch.id, kurzname: mensch.kurzname, anzeigename: mensch.anzeigename, archiviert: mensch.archiviert, loginfaehig: mensch.loginfaehig },
    bestaetigungssatz: bestaetigungssatz(mensch.kurzname),
    referenzen,
    dokumente: {
      gesamt,
      loeschbar: betroffene.komplett.length,
      misch: betroffene.misch.length,
      beispiele: betroffene.komplett.slice(0, 8).map((d) => ({ postid: d.postid, betreff: d.betreff, art: d.art })),
    },
    perioden,
    offenePerioden: perioden.filter((p) => p.status === 'SUBMITTED'),
    saldoQuellen,
    fremdePerioden,
    geschuetzteArztrechnungen,
    hatBezuege: gesamt > 0 || perioden.length > 0,
  };
}

/**
 * Schiebt die Dateien bereits gelöschter Dokumente in den Papierkorb der Ablage.
 *
 * Läuft nach dem COMMIT als Hintergrund-Job: pro Datei ein Netzwerk-Call zur
 * Ablage, das überschreitet bei größeren Beständen jedes Proxy-Timeout. Nicht
 * abbrechbar — ein halb abgearbeiteter Lauf hinterließe Dateien ohne DB-Eintrag,
 * über die niemand mehr stolpert. Fehlschläge landen als ERROR im Log, damit
 * keine Datei still verschwindet. `danach` läuft im Anschluss, auch ohne
 * Dateien – etwa das Aufräumen des Personenordners, das erst nach dem Leeren
 * sinnvoll ist.
 */
export function startePapierkorbLauf(papierkorb, kurzname, danach = null) {
  if (!papierkorb.length) {
    if (danach) danach().catch(() => {});
    return null;
  }
  const jobId = tracker.create('mensch-papierkorb',
    `Dateien von ${kurzname} in den Papierkorb (${papierkorb.length})`, papierkorb.length, false);
  (async () => {
    let ok = 0; let fehler = 0; let i = 0;
    for (const d of papierkorb) {
      tracker.setStep(jobId, ++i, d.postid);
      const erfolg = await verschiebeInPapierkorb({
        postid: d.postid, storageId: d.storage_id, storageBackend: d.storage_backend, betreff: d.betreff,
      });
      if (erfolg) ok++; else fehler++;
    }
    tracker.complete(jobId, { ok, fehler });
    if (fehler > 0) {
      appLog('ERROR', 'mensch',
        `Papierkorb-Lauf ${kurzname}: ${fehler} von ${papierkorb.length} Datei(en) nicht verschoben — die DB-Einträge sind bereits gelöscht.`,
        { entity: 'mensch' });
    } else {
      appLog('INFO', 'mensch', `Papierkorb-Lauf ${kurzname}: ${ok} Datei(en) verschoben.`, { entity: 'mensch' });
    }
    if (danach) await danach();
  })().catch((err) => {
    tracker.fail(jobId, err.message);
    appLog('ERROR', 'mensch', `Papierkorb-Lauf ${kurzname} abgebrochen: ${err.message}`, { entity: 'mensch' });
  });
  return jobId;
}

/**
 * Sperrt die Menschen-Löschung, solange eine aktive Abrechnungssession eine
 * ihrer Perioden als Ziel hat, und entfernt sonst deren historische
 * (`aktiv = false`) Zielzeilen. Ohne das würde der nachfolgende Bulk-DELETE
 * aller `abrechnungsperiode_buch`-Zeilen der Person an der `ON DELETE
 * RESTRICT`-FK von `_abrechnung_session_ziel` mit einer rohen FK-Exception
 * scheitern — derselbe Stuck-Zustand, der für Merge/Löschen einzelner
 * Perioden bereits in `abrechnungsperiode.js` behoben wurde.
 */
async function pruefeUndBereinigeSessionZiele(q, kurzname) {
  const aktiv = await q(
    `SELECT 1 FROM postbuch._abrechnung_session_ziel WHERE person = $1 AND aktiv LIMIT 1`,
    [kurzname],
  );
  if (aktiv.rows.length > 0) {
    throw new LoeschFehler(409, 'Mensch kann nicht gelöscht werden — eine Abrechnungssession ist noch aktiv. Bitte zuerst abschließen oder abbrechen.');
  }
  await q(`DELETE FROM postbuch._abrechnung_session_ziel WHERE person = $1 AND NOT aktiv`, [kurzname]);
}

/**
 * Entwertet alle Textbezüge auf den Kurznamen. Dokumente bleiben in der DB
 * unangetastet. Liefert die PostIDs, die dabei ihr Familienmitglied oder ihre
 * behandelte Person verloren haben – bei Personenablage kann sich deren
 * Personenordner dadurch ändern.
 */
async function loeseBezuege(q, kurzname, nurPostids = null) {
  const filter = nurPostids ? ' AND postid = ANY($2)' : '';
  const params = nurPostids ? [kurzname, nurPostids] : [kurzname];
  // Periodennummern mitnullen: die zugehörigen Perioden-Zeilen verschwinden
  // gleich mit, ein Verweis darauf wäre danach ins Leere gerichtet.
  const ar = await q(`UPDATE postbuch.arztrechnung
              SET behandelte_person = NULL, abrechnungsperiode_pkv = NULL, abrechnungsperiode_beihilfe = NULL
            WHERE behandelte_person = $1${filter} RETURNING postid`, params);
  const ab = await q(`UPDATE postbuch.arztbericht SET behandelte_person = NULL
            WHERE behandelte_person = $1${filter} RETURNING postid`, params);
  const r = await q(`UPDATE postbuch.postbuch SET familienmitglied = NULL
            WHERE familienmitglied = $1${filter} RETURNING postid`, params);
  return [...new Set([...ar.rows, ...ab.rows, ...r.rows].map((z) => z.postid))];
}

/**
 * Führt die Löschung aus. Die DB-Arbeit liegt komplett in einer Transaktion;
 * die Ablage-Moves laufen danach, weil ein externer API-Call sich nicht
 * zurückrollen lässt. Zurückgegeben werden die Dateien, die noch in den
 * Papierkorb müssen — der Aufrufer erledigt das im Hintergrund.
 */
export async function loescheMensch({ id, modus, bestaetigung, akteur = 'admin' }) {
  if (!MODI.includes(modus)) throw new LoeschFehler(400, 'Unbekannter Löschmodus.');
  const client = await getClient();
  const q = client.query.bind(client);
  try {
    await client.query('BEGIN');
    const mensch = await ladeMensch(q, id, { fuerUpdate: true });
    pruefeVorbedingungen(mensch);

    const betroffene = await ermittleBetroffene(q, mensch.kurzname);
    const gesamt = betroffene.komplett.length + betroffene.misch.length;

    if (modus === 'nur-frei' && gesamt > 0) {
      const r = await zaehleReferenzen(q, mensch.kurzname);
      const teile = [];
      if (r.arz > 0) teile.push(`${r.arz} Arztrechnung(en)`);
      if (r.ab > 0) teile.push(`${r.ab} Arztbericht(e)`);
      if (r.eb > 0) teile.push(`${r.eb} Erstattungs-Position(en)`);
      if (r.adr > 0) teile.push(`${r.adr} zugeordnete(s) Dokument(e)`);
      throw new LoeschFehler(409, `Mensch kann nicht gelöscht werden — ${teile.join(', ')} verknüpft.`);
    }

    // Der Bestätigungssatz wird gegen den Kurznamen aus der GESPERRTEN DB-Zeile
    // gebildet, nie gegen einen Wert aus dem Request — sonst gäbe der Client
    // sich die erwartete Phrase selbst vor.
    if (modus === 'dokumente') {
      const erwartet = normalisiereBestaetigung(bestaetigungssatz(mensch.kurzname));
      if (normalisiereBestaetigung(bestaetigung) !== erwartet) {
        throw new LoeschFehler(400, `Bestätigungssatz stimmt nicht. Erwartet: „${bestaetigungssatz(mensch.kurzname)}“`);
      }
    }

    // Vor irgendeinem Entknüpfen prüfen. Andernfalls könnten die nachfolgenden
    // DELETEs von Misch-EB-Positionen den Schutzbezug zuerst entfernen und die
    // anschließend gelöschte Arztrechnung fälschlich freigeben.
    if (modus === 'dokumente') {
      const komplettIds = betroffene.komplett.map((d) => d.postid).sort();
      try {
        await q(
          `SELECT postid FROM postbuch.postbuch
            WHERE postid = ANY($1::varchar[]) ORDER BY postid FOR UPDATE`,
          [komplettIds],
        );
        // Diese Guards erwarten ein Objekt mit `.query()` (Default: pool), kein
        // nacktes `client.query.bind(client)` wie `q` — deshalb hier bewusst
        // `client` selbst übergeben, nicht `q`.
        await pruefeMehrereArzLoeschschutzUnterLock(komplettIds, client);
        await pruefeMehrereBescheidLoeschschutzUnterLock(komplettIds, client);
        await pruefeMehrereDokumentPinLoeschschutzUnterLock(komplettIds, client);
        await pruefeErsetzungLoeschschutz(komplettIds, client);
      } catch (err) {
        if (err.code === DELETE_PROTECTED_CODE
          || err.code === BESCHEID_DELETE_PROTECTED_CODE
          || err.code === DOKUMENT_PIN_DELETE_PROTECTED_CODE
          || err.code === ERSETZUNG_DELETE_PROTECTED_CODE) {
          throw new LoeschFehler(409, err.message, {
            code: err.code,
            postid: err.postid,
            erstattungsbescheide: err.erstattungsbescheide,
            hinweis: err.hinweis,
          });
        }
        throw err;
      }
    }

    let geloeschteDocs = [];
    let ohnePerson = [];
    if (modus === 'dokumente') {
      // Mischdokumente zuerst bereinigen: danach sind beide Mengen unabhängig.
      const mischIds = betroffene.misch.map((d) => d.postid);
      if (mischIds.length) {
        await q(`DELETE FROM postbuch.erstattungsbescheid_einzelposition
                  WHERE postid = ANY($2) AND behandelte_person = $1`, [mensch.kurzname, mischIds]);
        ohnePerson = [...new Set([...mischIds, ...await loeseBezuege(q, mensch.kurzname, mischIds)])];
      }
      const komplettIds = betroffene.komplett.map((d) => d.postid);
      if (komplettIds.length) {
        // Ein Statement — die postid-Fremdschlüssel räumen per CASCADE alle
        // Detailtabellen ab (Einzelpositionen, Kürzungen, Akten-Zuordnung,
        // Wiedervorlagen, Datei-Cache) und setzen Saldo-Quellen auf NULL.
        await q('DELETE FROM postbuch.postbuch WHERE postid = ANY($1)', [komplettIds]);
        geloeschteDocs = betroffene.komplett;
      }
    } else if (modus === 'bezuege') {
      const eb = await q(`UPDATE postbuch.erstattungsbescheid_einzelposition SET behandelte_person = NULL
                WHERE behandelte_person = $1 RETURNING postid`, [mensch.kurzname]);
      ohnePerson = [...new Set([...eb.rows.map((z) => z.postid), ...await loeseBezuege(q, mensch.kurzname)])];
    }

    await pruefeUndBereinigeSessionZiele(q, mensch.kurzname);

    // `person` ist Teil des Primärschlüssels — hier ist Löschen die einzige Option.
    const perioden = await q('DELETE FROM postbuch.abrechnungsperiode_buch WHERE person = $1', [mensch.kurzname]);
    // Defense in Depth: läuft auch bei loginfaehig=false, falls ein früherer
    // PATCH den Zugang deaktiviert, aber Sitzungen stehengelassen hat.
    await revokeUserAccess({ menschId: mensch.id, username: mensch.anmeldename }, q);
    await q('DELETE FROM postbuch.mensch WHERE id = $1', [mensch.id]);
    await client.query('COMMIT');

    const zusammenfassung = {
      kurzname: mensch.kurzname,
      modus,
      dokumenteGeloescht: geloeschteDocs.length,
      dokumenteBereinigt: modus === 'dokumente' ? betroffene.misch.length : gesamt,
      periodenGeloescht: perioden.rowCount ?? 0,
    };
    appLog('INFO', 'mensch',
      `Mensch endgültig gelöscht: ${mensch.kurzname} (Modus ${modus}, ${zusammenfassung.dokumenteGeloescht} Dokument(e) gelöscht, `
      + `${zusammenfassung.dokumenteBereinigt} bereinigt, ${zusammenfassung.periodenGeloescht} Periode(n)) durch ${akteur}`,
      { entity: 'mensch', entityId: mensch.id });
    // Pro Dokument eine eigene Zeile: nur so bleibt jede einzelne PostID
    // hinterher auffindbar. Eine Sammelliste würde am Feldlimit abgeschnitten.
    for (const d of geloeschteDocs) {
      uiLog('DELETE', 'postbuch', d.postid,
        `Gelöscht mit Person ${mensch.kurzname} (${d.betreff || 'kein Betreff'})`).catch(() => {});
    }
    return { zusammenfassung, papierkorb: geloeschteDocs, ablage: { menschId: mensch.id, ohnePerson } };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
