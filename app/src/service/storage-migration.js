/**
 * service/storage-migration.js — Umzug der Ablage zwischen zwei Backends
 *
 * Symmetrisch (OneDrive → Nextcloud und zurück), resumable, mit Restliste.
 * Quelle→Ziel ist ein Parameter, kein zweiter Codepfad.
 *
 * ── Ablauf ───────────────────────────────────────────────────────────────────
 *   1. Ziel vorbereiten   Ordnerstruktur im Ziel-Backend (service/storage-setup.js)
 *   2. Trockenlauf        zählen, Ordner-Mapping prüfen, nichts schreiben
 *   3. Copy + Verify      je Zeile, siehe unten
 *   4. Umschalten         _settings.storage_backend — erst hier ändert sich das
 *                         Verhalten für Neuzugänge
 *   ·  Nachzügler         jederzeit vor Schritt 6: Dokumente, die zwischen
 *                         Trockenlauf und jetzt neu im Quell-Backend
 *                         aufgetaucht sind, an denselben Lauf anhängen
 *   5. Nachlauf           DR-Fingerprint gegen das Ziel
 *   6. Quelle aufräumen   nur nach expliziter Bestätigung, nur nach _trash
 *
 * ── Copy + Verify je Zeile ───────────────────────────────────────────────────
 *   Download Quelle → sha256 gegen postbuch.sha256 → Upload ins Ziel →
 *   dst_id SOFORT persistieren (status 'kopiert') → Re-Download vom Ziel +
 *   sha256 erneut → atomares UPDATE der postbuch-Zeile → status 'fertig'.
 *
 *   Der Re-Download ist nicht paranoid: ein Upload, den ein Reverse-Proxy
 *   abgeschnitten hat, antwortet trotzdem mit 200. Ohne ihn wäre die
 *   Beschädigung erst beim späteren Öffnen sichtbar — dann aber ohne Quelle.
 *
 *   Die Zwischenstufe 'kopiert' schließt das Fenster zwischen Upload und
 *   DB-Update: ein Crash dazwischen hinterlässt sonst eine verwaiste
 *   Zielkopie, die der Resume nur noch per Namenssuche fände.
 *
 * ── Resume ───────────────────────────────────────────────────────────────────
 *   Beim Wiederanlauf werden nur Items mit status IN ('offen','fehler','kopiert')
 *   angefasst. Pro Zeile wird zuerst geprüft, ob am Ziel bereits eine Datei mit
 *   passendem sha256 liegt → dann übersprungen. Der Vergleich läuft IMMER über
 *   sha256, nie über Namen oder Größe: ein abgebrochener PUT hinterlässt eine
 *   namensgleiche, abgeschnittene Datei.
 *
 * ── Der Rückumzug ist KEIN Rückspulen ────────────────────────────────────────
 *   Die Items eines Laufs sind Audit-Trail, kein Skript. Ein Rückumzug ist ein
 *   NEUER Lauf mit vertauschten Parametern über den AKTUELLEN DB-Zustand. Wer
 *   Lauf 1 rückwärts abspielt, arbeitet mit src_ids, die inzwischen im _trash
 *   liegen oder ersetzt wurden.
 *
 * ── Rückbau (Ausnahme von obigem Grundsatz) ─────────────────────────────────
 *   rueckbauVorschau()/rolleLaufZurueck() sind KEIN Rückumzug im obigen Sinn,
 *   sondern eine eng begrenzte Ausnahme: das In-place-Zurückdrehen GENAU der
 *   Items, die DIESER Lauf selbst gerade erst nach 'fertig' gesetzt hat, bevor
 *   Schritt 4 (Umschalten) oder Schritt 6 (Aufräumen) angefasst wurde. Kein
 *   neuer Lauf, kein Ersetzen von src_ids — die Werte stehen unverändert im
 *   Item selbst (src_id/src_name/src_link), die Zieldatei bleibt als
 *   harmlose Waise liegen (nie gelöscht, siehe unten). Erlaubt nur, solange
 *   der Lauf 'pausiert' ist (kein aktiver Worker schreibt parallel), noch
 *   nicht umgeschaltet wurde und cleaned_at NULL ist – dieselbe Bedingung wie
 *   bei nachzueglerAufnehmen(), aus demselben Grund: ist die Quelle schon
 *   geräumt oder das aktive Backend schon gewechselt, ist „zurückdrehen"
 *   keine sichere Operation mehr, sondern bräuchte den echten Rückumzug oben.
 *
 * ── Reversibilität (die Prämisse) ────────────────────────────────────────────
 *   • Die Quelle wird nie automatisch gelöscht — Schritt 6 ist ein eigener,
 *     zweistufig bestätigter Aufruf, und er verschiebt nach _trash statt zu
 *     löschen. `remove` wird in diesem Modul bewusst GAR NICHT importiert:
 *     ein fehlender Import ist eine Eigenschaft, ein Kommentar nur ein Merksatz.
 *   • _storage_migration_items hält beide Seiten.
 *   • Ein Abbruch hinterlässt einen lauffähigen Mischzustand.
 */

import { createHash, randomUUID } from 'node:crypto';
import pool from '../db.js';
import * as tracker from '../jobs/tracker.js';
import * as pipelineQueue from '../jobs/pipeline-queue.js';
import { appLog } from '../app-log.js';
import { loadDynamicSettings, getFolders, folderKeyById, getAblageStruktur } from '../config.js';
import { getAdapter, BACKENDS, legacyOnedriveWerte } from '../lib/storage/index.js';
import { clientSafeError } from '../lib/net-guard.js';
import { ensureAblageOrdner, ermittlePerson, ablageSchluessel } from './storage-setup.js';
import { istUmzugAktiv } from './storage-relocate.js';
import { oeffneSichereDokumentloeschung } from './document-delete-protection.js';

// Erlaubte Statuswerte. Bewusst hier und nicht als CHECK-Constraint: ein CHECK
// in einem idempotenten Vollschema erzwingt DROP+ADD gegen die Live-DB, sobald
// ein Wert dazukommt (siehe base_schema.sql).
export const RUN_STATUS = [
  'vorbereitet', 'trockenlauf', 'laeuft', 'pausiert', 'abgeschlossen',
  'abgeschlossen_mit_resten', 'abgebrochen', 'fehler',
];
export const ITEM_STATUS = [
  'offen', 'kopiert', 'fertig', 'fehler', 'hash_konflikt',
  'quelle_fehlt', 'kein_zielordner', 'ohne_datei', 'uebersprungen',
  'zurueckgebaut',
];

/** Item-Zustände, die einen Lauf unvollständig machen (Restliste). */
const REST_STATUS = ['fehler', 'hash_konflikt', 'quelle_fehlt', 'kein_zielordner'];

/** Zustände, die ein Resume erneut anfasst. */
const OFFEN_STATUS = ['offen', 'fehler', 'kopiert'];

// Konstanter Advisory-Lock-Key. Nie aus Nutzereingabe ableiten.
const LOCK_KEY_1 = 0x504f5354; // 'POST'
const LOCK_KEY_2 = 0x4d494752; // 'MIGR'

const MAX_PARALLEL = 2;   // ein Nextcloud auf einem Pi geht bei mehr in die Knie
const MAX_VERSUCHE = 3;

function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Fehlertext für die DB/den Client. Der Nextcloud-Adapter liegt potenziell im
 * privaten Netz — clientSafeError entfernt Hostnamen und aufgelöste IPs aus
 * NetGuard-Fehlern. Der Volltext geht nur ins appLog.
 */
function sichererFehler(err) {
  try {
    return String(clientSafeError(err) || 'Unbekannter Fehler').slice(0, 500);
  } catch {
    return 'Unbekannter Fehler';
  }
}

// ── Lauf-Zustand ──────────────────────────────────────────────────────────────

async function updateRun(runId, patch) {
  const fields = Object.keys(patch);
  if (fields.length === 0) return;
  const set = fields.map((f, i) => `${f} = $${i + 2}`).join(', ');
  await pool.query(
    `UPDATE postbuch._storage_migration_runs SET ${set}, updated_at = NOW() WHERE id = $1`,
    [runId, ...fields.map(f => patch[f])]
  );
}

async function updateItem(runId, postid, patch) {
  const fields = Object.keys(patch);
  if (fields.length === 0) return;
  const set = fields.map((f, i) => `${f} = $${i + 3}`).join(', ');
  await pool.query(
    `UPDATE postbuch._storage_migration_items SET ${set}, updated_at = NOW()
      WHERE run_id = $1 AND postid = $2`,
    [runId, postid, ...fields.map(f => patch[f])]
  );
}

export async function getRun(runId) {
  const r = await pool.query(
    `SELECT * FROM postbuch._storage_migration_runs WHERE id = $1`, [runId]
  );
  if (r.rows.length === 0) return null;
  const run = r.rows[0];
  const counts = await pool.query(
    `SELECT status, count(*)::int AS n FROM postbuch._storage_migration_items
      WHERE run_id = $1 GROUP BY status`,
    [runId]
  );
  run.itemCounts = Object.fromEntries(counts.rows.map(c => [c.status, c.n]));
  run.laeuftGerade = _aktiverLauf === runId;
  return run;
}

/** Restliste eines Laufs — Zeilen, die eine Nutzerentscheidung brauchen. */
export async function getRestliste(runId, limit = 500) {
  const r = await pool.query(
    `SELECT i.postid, i.status, i.fehler_text, i.src_id, i.src_name, i.sha256,
            p.betreff, p.dokumentart AS art
       FROM postbuch._storage_migration_items i
       LEFT JOIN postbuch.postbuch p ON p.postid = i.postid
      WHERE i.run_id = $1 AND i.status = ANY($2)
      ORDER BY i.postid
      LIMIT $3`,
    [runId, REST_STATUS, Math.min(limit, 500)]
  );
  return r.rows;
}

/**
 * Der zuletzt angelegte, für den Assistenten relevante Lauf (für den UI-Einstieg).
 *
 * 'abgeschlossen' zählt bewusst weiter als „offen": erst nach dem Aufräumen der
 * Quelle (cleaned_at gesetzt, Schritt 5) ist inhaltlich nichts mehr zu tun.
 *
 * Absichtlich OHNE „cleaned_at IS NULL"-Filter: der Abschluss-Schritt im
 * Assistenten (AblageUmzugPage.jsx, inhaltAbschluss()) zeigt gerade für den
 * bereits aufgeräumten Zustand seine eigentliche Erfolgsseite („Fertig" +
 * Angebot, die Quellverbindung zu trennen) — die braucht weiterhin den vollen
 * Lauf-Datensatz. Mit dem Filter lieferte GET /aktuell direkt nach
 * erfolgreichem Aufräumen plötzlich null, und die Seite fiel fälschlich auf
 * „Noch nicht umgeschaltet" zurück, obwohl längst umgeschaltet UND aufgeräumt
 * war. Ein bereits abgeschlossener und aufgeräumter Lauf bleibt hier also
 * bewusst sichtbar, bis eine neue Migration (anderes Backend-Paar oder nach
 * erneutem Trockenlauf) eine jüngere Zeile anlegt — die per ORDER BY dann
 * automatisch Vorrang hat. Für Dashboard-Hinweise, die NICHT mehr nagen
 * sollen, sobald nichts mehr zu tun ist, prüfen die Aufrufer selbst
 * `run.cleaned_at` (siehe DashboardPage.jsx). findeOffenenLaufFuerPaar() unten
 * hat einen eigenen, separaten cleaned_at-Filter und ist von dieser Änderung
 * nicht betroffen — eine neue Migration für dasselbe Backend-Paar legt nach
 * einem sauberen Abschluss weiterhin eine frische Zeile an, statt die alte
 * wiederzubeleben.
 */
export async function getOffenenLauf() {
  const r = await pool.query(
    `SELECT id FROM postbuch._storage_migration_runs
      WHERE status IN ('vorbereitet','trockenlauf','laeuft','pausiert','abgeschlossen','abgeschlossen_mit_resten')
      ORDER BY created_at DESC LIMIT 1`
  );
  return r.rows[0] ? getRun(r.rows[0].id) : null;
}

/** Der jüngste offene Lauf für genau dieses (Quelle,Ziel)-Paar — reused von
 *  bereiteZielVor() und trockenlauf(), damit nicht bei jedem Klick eine neue,
 *  parallele Run-Zeile entsteht, die getOffenenLauf()s LIMIT 1 verdeckt. */
async function findeOffenenLaufFuerPaar(src, dst) {
  const r = await pool.query(
    `SELECT id FROM postbuch._storage_migration_runs
      WHERE src_backend = $1 AND dst_backend = $2
        AND status IN ('vorbereitet','trockenlauf','laeuft','pausiert','abgeschlossen','abgeschlossen_mit_resten')
        AND cleaned_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
    [src, dst]
  );
  return r.rows[0] ? getRun(r.rows[0].id) : null;
}

// ── Schritt 1: Ziel vorbereiten ───────────────────────────────────────────────

/**
 * Legt die Ordnerstruktur im ZIEL-Backend an.
 *
 * Bewusst nicht über POST /onedrive-folders/setup-wizard: die Route arbeitet
 * immer gegen das AKTIVE Backend und stößt anschließend relocateAllDocuments()
 * an — beim Vorbereiten eines Migrationsziels wäre das ein Umzug aller
 * Dokumente in der noch aktiven Quelle. Hier wird nur angelegt, nichts bewegt.
 *
 * findOrCreateFolder({strict:true}) überschreibt vorhandene Ordner nie, es
 * liest nur deren ID.
 *
 * Legt dabei — sofern `backend` vom aktuell aktiven Backend abweicht — eine
 * Lauf-Zeile mit Status 'vorbereitet' an (oder findet die vorhandene): schon
 * das Vorbereiten des Ziels ist der Beginn einer Migration, nicht erst der
 * Trockenlauf. Damit kann das Dashboard einen begonnenen Umzug anzeigen, auch
 * bevor je gezählt wurde (siehe getOffenenLauf()).
 */
export async function bereiteZielVor(backend, rootPath = 'postbuch') {
  if (!BACKENDS.includes(backend)) {
    const e = new Error('Unbekanntes Ablage-Backend'); e.statusCode = 400; throw e;
  }
  const { setupFolderStructure } = await import('./storage-setup.js');
  const results = await setupFolderStructure(rootPath, backend);
  appLog('INFO', 'storage-migration',
    `Ordnerstruktur für "${backend}" vorbereitet: ${results.length} Ordner unter "${rootPath}"`);

  let runId = null;
  const settings = await loadDynamicSettings();
  const aktiv = settings.storage_backend || 'onedrive';
  if (aktiv !== backend) {
    const bestehender = await findeOffenenLaufFuerPaar(aktiv, backend);
    if (bestehender) {
      runId = bestehender.id;
    } else {
      runId = randomUUID();
      await pool.query(
        `INSERT INTO postbuch._storage_migration_runs (id, src_backend, dst_backend, status)
         VALUES ($1, $2, $3, 'vorbereitet')`,
        [runId, aktiv, backend]
      );
    }
  }

  return {
    backend, rootPath, anzahl: results.length,
    neu: results.filter(r => !r.existed).length,
    vorhanden: results.filter(r => r.existed).length,
    runId,
  };
}

// ── Trockenlauf ───────────────────────────────────────────────────────────────

/**
 * Legt für eine Zeile ein Migrations-Item an. Trockenlauf UND Nachzügler-
 * Aufnahme teilen sich diese Logik — Quelle→Ziel bleibt ein Parameter, kein
 * zweiter Codepfad (siehe Kopfkommentar der Datei).
 */
async function itemAnlegen(runId, src, dst, srcAdapter, settings, row) {
  let status = 'offen';
  let dstFolderId = null;
  const srcName = row.storage_filename || null;

  if (!row.storage_id) {
    // Datensatz ohne PDF — die App kennt den Zustand über hat_pdf. Nichts zu
    // kopieren, die Zeile bleibt wie sie ist.
    status = 'ohne_datei';
  } else {
    dstFolderId = await ermittleZielordner(settings, src, dst, srcAdapter, row).catch(() => null);
    // D-Unterordner werden bewusst erst beim echten Lauf angelegt. Ein
    // Trockenlauf bleibt damit garantiert schreibfrei.
    if (!dstFolderId && !(row.lebensbereich && row.dokumentart)) status = 'kein_zielordner';
  }

  const ins = await pool.query(
    `INSERT INTO postbuch._storage_migration_items
       (run_id, postid, src_id, src_link, src_name, dst_folder_id, sha256, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (run_id, postid) DO NOTHING`,
    [runId, row.postid, row.storage_id, row.link, srcName, dstFolderId, row.sha256, status]
  );
  return { status, inserted: ins.rowCount > 0 };
}

/**
 * Legt einen Lauf an (oder findet den passenden 'vorbereitet'-Lauf aus
 * bereiteZielVor() wieder) und füllt im Hintergrund die Item-Tabelle, ohne
 * irgendetwas zu schreiben. Läuft wie starteLauf() asynchron unter dem
 * gemeinsamen Advisory-Lock — bei großem Bestand blockierte ein synchroner
 * Zähllauf sonst minutenlang den HTTP-Request, ohne dass die UI einen
 * Fortschritt anzeigen könnte.
 *
 * Erfasst IMMER den gesamten Quellbestand — eine Begrenzung gab es bis 2.9.0,
 * sie hat aber nur eine Falle erzeugt: der spätere scharfe Lauf blieb auf
 * ewig auf dieselbe Zahl gedeckelt (siehe ermittleNachzuegler()-Aufruf unten,
 * der diese Klasse von Lücke weiterhin für spontan neu hinzugekommene
 * Dokumente abdeckt, aber nicht mehr für eine selbst gewählte Begrenzung).
 *
 * @param {{src: string, dst: string}} opts
 * @returns {{runId: string, jobId: string}}
 */
export async function trockenlauf({ src, dst }) {
  if (!BACKENDS.includes(src) || !BACKENDS.includes(dst)) {
    const e = new Error('Unbekanntes Ablage-Backend'); e.statusCode = 400; throw e;
  }
  if (src === dst) {
    // Sonst kopiert der Lauf jede Datei ins selbe Backend, der Kollisionsschutz
    // vergibt „Name (2)", die Zeile zeigt danach auf die Kopie — und das
    // Original ist verwaist. Datenverlust plus Speicherverdopplung.
    const e = new Error('Quelle und Ziel sind identisch.'); e.statusCode = 400; throw e;
  }

  const settings = await loadDynamicSettings();
  const zielOrdner = getFolders(settings, dst);
  if (Object.keys(zielOrdner).length === 0) {
    const e = new Error(
      `Für "${dst}" ist noch keine Ordnerstruktur eingerichtet. Bitte zuerst die Ordner-Initialisierung ausführen.`
    );
    e.statusCode = 409; throw e;
  }

  // Wiederverwenden statt eines zweiten, parallelen Laufs für dasselbe Paar —
  // sonst verdeckt getOffenenLauf()s LIMIT 1 die erste Zeile für immer.
  const bestehender = await findeOffenenLaufFuerPaar(src, dst);
  let runId;
  if (bestehender) {
    if (!['vorbereitet', 'trockenlauf'].includes(bestehender.status)) {
      const e = new Error(
        `Für ${src} → ${dst} läuft bereits ein Migrationslauf (Status: ${bestehender.status}).`
      );
      e.statusCode = 409; throw e;
    }
    runId = bestehender.id;
  } else {
    runId = randomUUID();
    await pool.query(
      `INSERT INTO postbuch._storage_migration_runs (id, src_backend, dst_backend, status)
       VALUES ($1, $2, $3, 'vorbereitet')`,
      [runId, src, dst]
    );
  }

  return mitMigrationsLock(runId, async ({ freigeben, istWeg }) => {
    const jobId = tracker.create(
      'storage-migration',
      `Trockenlauf ${src} → ${dst}`,
      0,
      false,
      { runId }
    );
    try {
      await tracker.awaitPersisted(jobId);
      await updateRun(runId, { job_id: jobId });
    } catch (err) {
      tracker.fail(jobId, sichererFehler(err));
      await freigeben();
      throw err;
    }

    fuehreTrockenlaufAus({ runId, jobId, src, dst, settings, istWeg })
      .catch(err => console.error('[storage-migration] Trockenlauf:', err.message))
      .finally(freigeben);

    return { runId, jobId };
  });
}

async function fuehreTrockenlaufAus({ runId, jobId, src, dst, settings, istWeg }) {
  try {
    const rows = (await pool.query(
      `SELECT postid, art::text AS art, lebensbereich, dokumentart, familienmitglied, storage_id, storage_filename, link, sha256
         FROM postbuch.postbuch
        WHERE storage_backend = $1
        ORDER BY postid`,
      [src]
    )).rows;

    tracker.setTotal(jobId, rows.length);
    const srcAdapter = getAdapter(src);
    let ohneDatei = 0, keinZielordner = 0, bereit = 0, gezaehlt = 0;

    for (const row of rows) {
      if (_abbruchAngefordert || istWeg()) {
        await updateRun(runId, { status: 'pausiert' });
        tracker.complete(jobId, { pausiert: true, gezaehlt });
        appLog('INFO', 'storage-migration', `Trockenlauf ${runId} pausiert bei ${gezaehlt}/${rows.length}`);
        return;
      }
      const { status } = await itemAnlegen(runId, src, dst, srcAdapter, settings, row);
      if (status === 'ohne_datei') ohneDatei++;
      else if (status === 'kein_zielordner') keinZielordner++;
      else bereit++;
      gezaehlt++;
      tracker.setStep(jobId, gezaehlt, `${gezaehlt} / ${rows.length} gezählt`);
    }

    // Was NICHT mitwandert — sonst ist das eine stille Falle.
    const fremd = await zaehleFremdreferenzen(src);

    // Zwischen dem obigen SELECT und hier liegen mehrere awaits (Zielordner je
    // Zeile ermitteln) — in dieser Zeit kann bereits ein neues Dokument im
    // Quell-Backend gelandet sein. ermittleNachzuegler() fängt genau diese
    // Lücke auf, dieselbe Query bedient später auch den manuellen Klick auf
    // „Auf Nachzügler prüfen".
    const { anzahl: nichtErfasst } = await ermittleNachzuegler(runId);

    const stats = {
      gesamt: rows.length, bereit, ohneDatei, keinZielordner,
      ohneHash: rows.filter(r => r.storage_id && !r.sha256).length,
      bleibtZurueck: fremd,
      nichtErfasst,
    };
    await updateRun(runId, { status: 'trockenlauf', stats: JSON.stringify(stats) });
    tracker.setStep(jobId, rows.length, `Fertig: ${bereit} bereit`);
    tracker.complete(jobId, stats);

    appLog('INFO', 'storage-migration',
      `Trockenlauf ${runId}: ${src} → ${dst}, ${bereit} bereit, ${keinZielordner} ohne Zielordner` +
      (nichtErfasst > 0 ? `, ${nichtErfasst} zwischenzeitlich neu hinzugekommen` : ''));
  } catch (err) {
    appLog('ERROR', 'storage-migration', `Trockenlauf ${runId} fehlgeschlagen: ${err.message}`);
    await updateRun(runId, { status: 'fehler', error_message: sichererFehler(err) }).catch(() => {});
    tracker.fail(jobId, sichererFehler(err));
  } finally {
    _abbruchAngefordert = false;
  }
}

/**
 * Zielordner für eine Zeile.
 *
 * Primär über den QUELL-Elternordner: in welcher L×D-Zelle liegt die Datei
 * tatsächlich? Denselben Composite-Key im Ziel nachschlagen. Falls der lazy
 * D-Unterordner dort noch fehlt, liefert der Trockenlauf null; der echte Lauf
 * legt ihn aus den autoritativen DB-Achsen an.
 */
async function ermittleZielordner(settings, src, dst, srcAdapter, row) {
  // Personenablage: Ziel allein aus den DB-Achsen. Die Quellstruktur kann noch
  // LxD sein und darf nicht ins Ziel übernommen werden.
  if (getAblageStruktur(settings) === 'person_lxd') {
    if (!row.lebensbereich || !row.dokumentart) return null;
    const person = await ermittlePerson(row.familienmitglied);
    return getFolders(settings, dst)[ablageSchluessel(settings, { ...row, menschId: person?.id })] || null;
  }
  let key = null;
  try {
    const meta = await srcAdapter.getMeta(row.storage_id);
    key = folderKeyById(settings, src, meta.parentId);
  } catch {
    // Quelle nicht erreichbar — der Copy-Schritt meldet das als quelle_fehlt.
  }

  if (key?.includes('/') && !key.startsWith('@')) {
    const id = getFolders(settings, dst)[key];
    if (id) return id;
  }
  return getFolders(settings, dst)[`${row.lebensbereich}/${row.dokumentart}`] || null;
}

/**
 * Zählt Objekte, die im Quell-Backend zurückbleiben. Sie tragen ihr eigenes
 * storage_backend und funktionieren dort weiter (getAdapter(row.storage_backend)) —
 * aber der Nutzer muss wissen, dass die alte Ablage nicht leer wird.
 */
async function zaehleFremdreferenzen(src) {
  const q = async (sql) => (await pool.query(sql, [src])).rows[0]?.n ?? 0;
  return {
    fehlgeschlageneDokumente: await q(
      `SELECT count(*)::int AS n FROM postbuch._failed_documents WHERE storage_backend = $1`),
    pausierteDuplikate: await q(
      `SELECT count(*)::int AS n FROM postbuch._pipeline_suspensions WHERE storage_backend = $1`),
  };
}

// ── Der Lauf ──────────────────────────────────────────────────────────────────

// Läuft gerade ein Migrationslauf in DIESEM Prozess? Der Advisory-Lock ist die
// Wahrheit über „läuft jetzt", der DB-Status die Wahrheit über „wurde
// unterbrochen". Ein Resume darf sich deshalb NIE am DB-Status 'laeuft'
// festmachen — nach einem Crash wäre der Lauf sonst für immer blockiert.
// Wert ist die runId des gerade aktiven Laufs (nicht nur ein Bool), damit
// getRun() darüber `laeuftGerade` je Lauf beantworten kann.
let _aktiverLauf = null;

/**
 * Reserviert den globalen Migrations-Advisory-Lock für die Dauer von `fn` und
 * setzt währenddessen `_aktiverLauf`. Von starteLauf() UND rolleLaufZurueck()
 * genutzt — beide dürfen niemals gleichzeitig gegen dieselben Items schreiben.
 *
 * Advisory-Lock auf einem DEDIZIERTEN Client: pool.query() gäbe die
 * Verbindung sofort zurück in den Pool, der Session-Lock hinge dann an einer
 * Connection, die der Idle-Reaper (Default 10 s) schließt — der Lock fiele
 * still weg und ein zweiter Lauf startete parallel.
 *
 * `fn` bekommt `{ freigeben, istWeg }` übergeben und MUSS `freigeben()` selbst
 * aufrufen, sobald der geschützte Abschnitt vorbei ist. Bei starteLauf() ist
 * das erst nach dem Hintergrund-Worker (`.finally(freigeben)`), beim
 * synchronen Rückbau direkt am Ende des Aufrufs — deshalb kein `finally` hier.
 */
async function mitMigrationsLock(runId, fn) {
  if (_aktiverLauf) {
    const e = new Error('Es läuft bereits eine Migration.'); e.statusCode = 409; throw e;
  }

  const lockClient = await pool.connect();
  let locked = false;
  try {
    const r = await lockClient.query('SELECT pg_try_advisory_lock($1, $2) AS ok', [LOCK_KEY_1, LOCK_KEY_2]);
    locked = r.rows[0].ok === true;
  } catch (err) {
    lockClient.release();
    throw err;
  }
  if (!locked) {
    lockClient.release();
    const e = new Error('Es läuft bereits eine Migration (anderer Prozess).'); e.statusCode = 409; throw e;
  }

  // Verbindungsabriss ⇒ Lauf abbrechen statt ohne Lock weiterzuschreiben.
  let verbindungWeg = false;
  lockClient.on('error', (err) => {
    verbindungWeg = true;
    console.error('[storage-migration] Lock-Verbindung verloren:', err.message);
  });

  let freigegeben = false;
  const freigeben = async () => {
    if (freigegeben) return;
    freigegeben = true;
    _aktiverLauf = null;
    pipelineQueue.resume();
    try { await lockClient.query('SELECT pg_advisory_unlock($1, $2)', [LOCK_KEY_1, LOCK_KEY_2]); } catch { /* Verbindung ggf. tot */ }
    lockClient.release();
  };

  // Zweite Prüfung: zwischen dem ersten Check oben und dem Lock-Erwerb lag ein
  // await, in dem ein anderer Aufruf denselben Weg genommen haben kann.
  if (_aktiverLauf) {
    await freigeben();
    const e = new Error('Es läuft bereits eine Migration.'); e.statusCode = 409; throw e;
  }
  _aktiverLauf = runId;

  try {
    return await fn({ freigeben, istWeg: () => verbindungWeg });
  } catch (err) {
    await freigeben();
    throw err;
  }
}

/**
 * Startet oder setzt einen Lauf fort. Läuft im Hintergrund.
 * @returns {{runId: string, jobId: string}}
 */
export async function starteLauf(runId) {
  const run = await getRun(runId);
  if (!run) { const e = new Error('Lauf nicht gefunden'); e.statusCode = 404; throw e; }
  if (['abgeschlossen', 'abgebrochen'].includes(run.status)) {
    const e = new Error('Dieser Lauf ist bereits beendet.'); e.statusCode = 409; throw e;
  }
  if (istUmzugAktiv()) {
    const e = new Error('Es läuft gerade ein Dokumentumzug innerhalb der Ablage – bitte warten.'); e.statusCode = 409; throw e;
  }

  return mitMigrationsLock(runId, async ({ freigeben, istWeg }) => {
    // cancellable: false — /api/jobs/:id/cancel prüft KEINE Rolle. Ein
    // vollzugriff-Nutzer könnte sonst die Betreiber-Entscheidung abbrechen.
    // Abgebrochen wird ausschließlich über die Admin-Route dieses Moduls.
    const jobId = tracker.create(
      'storage-migration',
      `Ablage-Migration ${run.src_backend} → ${run.dst_backend}`,
      run.itemCounts?.offen ?? 0,
      false,
      { runId }
    );

    try {
      // job_id ist ein Fremdschlüssel auf _jobs — die Zeile muss geschrieben
      // sein, bevor wir sie referenzieren (tracker.create schreibt asynchron).
      await tracker.awaitPersisted(jobId);
      await updateRun(runId, { status: 'laeuft', job_id: jobId, error_message: null });
      // Kein Scan darf ins Quell-Backend schreiben, während umgeschaltet wird.
      pipelineQueue.pause('Ablage-Migration läuft');
    } catch (err) {
      tracker.fail(jobId, sichererFehler(err));
      await freigeben();
      throw err;
    }

    fuehreLaufAus({ runId, jobId, run, istWeg })
      .catch(err => console.error('[storage-migration] Hintergrund-Lauf:', err.message))
      .finally(freigeben);

    return { runId, jobId };
  });
}

async function fuehreLaufAus({ runId, jobId, run, istWeg }) {
  const src = run.src_backend, dst = run.dst_backend;
  const srcAdapter = getAdapter(src);
  const dstAdapter = getAdapter(dst);
  const settings = await loadDynamicSettings();

  try {
    appLog('INFO', 'storage-migration', `Lauf ${runId} gestartet: ${src} → ${dst}`);

    const offene = (await pool.query(
      `SELECT postid FROM postbuch._storage_migration_items
        WHERE run_id = $1 AND status = ANY($2) ORDER BY postid`,
      [runId, OFFEN_STATUS]
    )).rows.map(r => r.postid);

    await pool.query('UPDATE postbuch._jobs SET total_steps = $2 WHERE id = $1',
      [jobId, offene.length]);

    let fertig = 0, fehler = 0;
    const queue = [...offene];

    // Zielordner je L×D-Zelle werden höchstens einmal pro Lauf zwangsweise neu
    // aufgelöst (siehe migriereEine()) — sonst löste jedes Dokument derselben
    // Zelle einen eigenen, redundanten Graph-/WebDAV-Aufruf aus. Map statt Set:
    // der aufgelöste Wert muss für JEDES Item dieser Zelle verwendet werden.
    const frischAufgeloest = new Map();

    // Max. MAX_PARALLEL gleichzeitig — mehr bringt ein Nextcloud auf einem Pi
    // in die Knie.
    const worker = async () => {
      while (queue.length > 0) {
        if (_abbruchAngefordert || istWeg()) return;
        const postid = queue.shift();
        const ok = await migriereEine({ runId, postid, src, dst, srcAdapter, dstAdapter, settings, frischAufgeloest });
        if (ok) fertig++; else fehler++;
        // step_label trägt NUR Zähler: /api/jobs ist für jeden eingeloggten
        // Nutzer lesbar, auch lesezugriff. Keine Dateinamen, keine Fehlertexte.
        tracker.setStep(jobId, fertig + fehler, `${fertig + fehler} / ${offene.length}`);
      }
    };
    await Promise.all(Array.from({ length: MAX_PARALLEL }, worker));

    if (_abbruchAngefordert || istWeg()) {
      await updateRun(runId, { status: 'pausiert' });
      tracker.complete(jobId, { pausiert: true, fertig, fehler });
      appLog('INFO', 'storage-migration', `Lauf ${runId} pausiert bei ${fertig}/${offene.length}`);
      return;
    }

    const zaehle = async (stati) => (await pool.query(
      `SELECT count(*)::int AS n FROM postbuch._storage_migration_items
        WHERE run_id = $1 AND status = ANY($2)`,
      [runId, stati]
    )).rows[0].n;

    const reste = await zaehle(REST_STATUS);
    // Items, die noch einen Versuch verdient haben (z.B. nach einem
    // vorübergehenden Fehler unterhalb von MAX_VERSUCHE). Solange die
    // existieren, ist der Lauf NICHT abgeschlossen — sonst meldete er Erfolg,
    // während nichts übertragen wurde.
    const nochOffen = await zaehle(OFFEN_STATUS);

    if (nochOffen > 0) {
      await updateRun(runId, {
        status: 'pausiert',
        stats: JSON.stringify({ ...(run.stats || {}), fertig, fehler, reste, nochOffen }),
      });
      tracker.setStep(jobId, offene.length, `${fertig} kopiert, ${nochOffen} erneut versuchen`);
      tracker.complete(jobId, { fertig, fehler, nochOffen });
      appLog('WARN', 'storage-migration',
        `Lauf ${runId} unvollständig: ${fertig} kopiert, ${nochOffen} weiterhin offen — fortsetzbar`);
      return;
    }

    const status = reste > 0 ? 'abgeschlossen_mit_resten' : 'abgeschlossen';
    await updateRun(runId, {
      status,
      completed_at: reste > 0 ? null : new Date(),
      stats: JSON.stringify({ ...(run.stats || {}), fertig, fehler, reste }),
    });
    tracker.setStep(jobId, offene.length, `Fertig: ${fertig} kopiert, ${reste} offen`);
    tracker.complete(jobId, { fertig, fehler, reste });
    appLog('INFO', 'storage-migration',
      `Lauf ${runId} ${status}: ${fertig} kopiert, ${reste} in der Restliste`);
  } catch (err) {
    appLog('ERROR', 'storage-migration', `Lauf ${runId} fehlgeschlagen: ${err.message}`);
    await updateRun(runId, { status: 'fehler', error_message: sichererFehler(err) }).catch(() => {});
    tracker.fail(jobId, sichererFehler(err));
  } finally {
    _abbruchAngefordert = false;
  }
}

let _abbruchAngefordert = false;

/** Bricht den laufenden Lauf ab. Der Lauf bleibt fortsetzbar ('pausiert'). */
export function brichAb() {
  if (!_aktiverLauf) return false;
  _abbruchAngefordert = true;
  return true;
}

/**
 * Eine Zeile migrieren. Gibt true zurück, wenn sie danach 'fertig' ist.
 * Wirft nie — jeder Fehler landet als Item-Status.
 */
async function migriereEine({ runId, postid, src, dst, srcAdapter, dstAdapter, settings, frischAufgeloest }) {
  // ALLES in den try-Block: ein transienter DB-Fehler beim Einlesen darf nicht
  // durch worker() nach Promise.all propagieren und den GESAMTEN Lauf auf
  // 'fehler' setzen — betroffen ist immer nur diese eine Zeile.
  let it = null;
  try {
    it = (await pool.query(
      `SELECT * FROM postbuch._storage_migration_items WHERE run_id = $1 AND postid = $2`,
      [runId, postid]
    )).rows[0];
    if (!it) return false;

    // Aktueller DB-Zustand ist autoritativ, nicht der beim Trockenlauf erfasste.
    const row = (await pool.query(
      `SELECT storage_id, storage_backend, sha256, art::text AS art, lebensbereich, dokumentart, familienmitglied
         FROM postbuch.postbuch WHERE postid = $1`, [postid]
    )).rows[0];

    if (!row || !row.storage_id) {
      await updateItem(runId, postid, { status: 'ohne_datei' });
      return true;
    }
    if (row.storage_backend !== src) {
      // Zeile wurde zwischenzeitlich anderweitig umgehängt — nicht anfassen.
      await updateItem(runId, postid, { status: 'uebersprungen' });
      return true;
    }

    await pool.query(
      `UPDATE postbuch._storage_migration_items
          SET versuche = versuche + 1, updated_at = NOW()
        WHERE run_id = $1 AND postid = $2`, [runId, postid]
    );

    // ── 1. Quelle laden und verifizieren ────────────────────────────────────
    let buf;
    try {
      buf = await srcAdapter.download(row.storage_id);
    } catch (err) {
      appLog('WARN', 'storage-migration', `${postid}: Quelle nicht ladbar: ${err.message}`);
      await updateItem(runId, postid, { status: 'quelle_fehlt', fehler_text: sichererFehler(err) });
      return false;
    }

    const hash = sha256Hex(buf);
    if (row.sha256 && row.sha256 !== hash) {
      // Nicht migrieren: die Datei ist nicht die, die die DB beschreibt.
      await updateItem(runId, postid, {
        status: 'hash_konflikt',
        sha256: hash,
        fehler_text: `sha256 der Quelldatei weicht vom DB-Eintrag ab (DB ${row.sha256.slice(0, 12)}…, Datei ${hash.slice(0, 12)}…)`,
      });
      return false;
    }

    const srcMeta = await srcAdapter.getMeta(row.storage_id).catch(() => ({}));
    const wunschName = srcMeta.name || it.src_name || `${postid}.pdf`;

    // ── 2. Bereits am Ziel? (Resume-Skip, immer per sha256) ─────────────────
    let ziel = null;
    if (it.dst_id) {
      const vorhanden = await pruefeZiel(dstAdapter, it.dst_id, hash);
      if (vorhanden) ziel = { id: it.dst_id, webUrl: vorhanden.webUrl, name: vorhanden.name };
    }

    // ── 3. Upload ───────────────────────────────────────────────────────────
    if (!ziel) {
      // dst_folder_id kommt beim ersten Zugriff auf eine Zelle typischerweise
      // aus dem Trockenlauf — der liest nur den zu diesem Zeitpunkt gecachten
      // Settings-Wert (siehe ermittleZielordner()), OHNE ihn zu verifizieren.
      // Liegt zwischen Trockenlauf und echtem Lauf ein Wurzelordner-Wechsel
      // oder ein sonstiger Ordner-Umbau, zeigt diese ID ins Leere und JEDER
      // Upload schlägt mit „itemNotFound" fehl — nicht nur der erste. Deshalb
      // hier dieselbe Zwangsauflösung wie in storage-relocate.js: einmal pro
      // Zelle und Lauf wird der aktuelle Leaf-Ordner unter dem JETZIGEN
      // L-Ordner frisch nachgezogen, statt dem Cache blind zu vertrauen.
      //
      // frischAufgeloest ist eine Map (nicht nur ein Set!): der frisch
      // aufgelöste Wert muss für JEDES Item derselben Zelle gelten, nicht nur
      // für das erste — sonst griffen alle nachfolgenden Items dieser Zelle
      // weiterhin auf ihr eigenes, noch nicht aktualisiertes it.dst_folder_id
      // zurück (Bug, der genau die Hälfte der Uploads weiterhin scheitern
      // ließ: nur das jeweils erste Dokument je Zelle profitierte).
      //
      // Gespeichert wird das Promise, nicht erst das Ergebnis: Parallele Worker
      // derselben Zelle warten so auf dieselbe Auflösung, statt den Ordner
      // gleichzeitig anzulegen (Nextcloud antwortet darauf mit 423 Locked).
      // Die Person gehört nur bei Personenablage zur Zelle.
      const personTeil = getAblageStruktur(settings) === 'person_lxd' ? `${row.familienmitglied ?? ''}|` : '';
      const zelle = row.lebensbereich && row.dokumentart
        ? `${personTeil}${row.lebensbereich}/${row.dokumentart}` : null;
      let zielOrdner = it.dst_folder_id;
      if (zelle) {
        if (!frischAufgeloest.has(zelle)) {
          const aufloesung = ensureAblageOrdner(settings, row, dst, { force: true });
          frischAufgeloest.set(zelle, aufloesung);
          // Fehlschlag nicht zwischenspeichern: das nächste Item derselben Zelle versucht es neu.
          aufloesung.catch(() => frischAufgeloest.delete(zelle));
        }
        try {
          zielOrdner = await frischAufgeloest.get(zelle);
        } catch (err) {
          await updateItem(runId, postid, { status: 'kein_zielordner', fehler_text: sichererFehler(err) });
          return false;
        }
      }
      if (!zielOrdner) {
        await updateItem(runId, postid, { status: 'kein_zielordner', fehler_text: 'Kein Zielordner ermittelbar' });
        return false;
      }
      const up = await dstAdapter.uploadNew(buf, wunschName, zielOrdner);
      // dst_id SOFORT persistieren — vor dem Verify. Ein Crash dazwischen
      // hinterlässt sonst eine verwaiste Zielkopie. dst_folder_id gleich mit,
      // falls die Zwangsauflösung oben einen anderen Wert als den bisher
      // gespeicherten ergeben hat (Selbstheilung des Item-Eintrags).
      await updateItem(runId, postid, {
        status: 'kopiert', dst_id: up.id, dst_link: up.webUrl || null,
        dst_name: up.name || wunschName, sha256: hash, dst_folder_id: zielOrdner,
      });
      ziel = up;

      // ── 4. Re-Download + Verify ───────────────────────────────────────────
      const zurueck = await dstAdapter.download(up.id);
      if (sha256Hex(zurueck) !== hash) {
        // Schlechte Zielkopie sofort in den _trash des ZIELS, Quelle unberührt.
        await dstAdapter.moveToTrash(up.id, `[Unvollstaendig] ${postid}.pdf`).catch(() => {});
        await updateItem(runId, postid, {
          status: 'fehler', dst_id: null,
          fehler_text: 'Prüfsumme der Zielkopie stimmt nicht — Upload unvollständig. Quelle unverändert.',
        });
        return false;
      }
    }

    // ── 5. Atomares UPDATE der postbuch-Zeile ───────────────────────────────
    // Konkurrenzsicher: nur wenn die Zeile noch exakt da steht, wo wir sie
    // gelesen haben. Sonst überschriebe der Lauf eine zwischenzeitliche
    // Änderung durch type-change/document-replace und die neuere Datei wäre
    // verwaist.
    //
    // onedrive_* werden bei Ziel != onedrive NICHT angefasst: sie zeigen dann
    // weiterhin wahrheitsgemäß auf die noch existierende Quellkopie — der
    // beste denkbare Rückweg, und er ist gratis. Siehe legacyOnedriveWerte.
    const lg = legacyOnedriveWerte(dst, {
      id: ziel.id, name: ziel.name || wunschName, modified: null,
    });
    const setzeLegacy = dst === 'onedrive';

    // Parameterliste exakt passend zum SQL aufbauen: ein übergebener, aber im
    // Statement nicht referenzierter Platzhalter lässt Postgres mit
    // „could not determine data type" scheitern.
    const params = [
      postid,                              // $1
      dst,                                 // $2
      ziel.id,                             // $3
      ziel.name || wunschName,             // $4
      ziel.webUrl || null,                 // $5
      hash,                                // $6
    ];
    let legacySql = '';
    if (setzeLegacy) {
      params.push(lg.id, lg.name);         // $7, $8
      legacySql = ', onedrive_id = $7, onedrive_filename = $8, onedrive_modified = NOW()';
    }
    const pSrc = params.push(src);                 // Index der Quell-Bedingung
    const pSrcId = params.push(row.storage_id);

    const upd = await pool.query(
      `UPDATE postbuch.postbuch
          SET storage_backend = $2,
              storage_id = $3,
              storage_filename = $4,
              storage_modified = NOW(),
              link = $5,
              sha256 = COALESCE(sha256, $6)
              ${legacySql}
        WHERE postid = $1 AND storage_backend = $${pSrc} AND storage_id = $${pSrcId}`,
      params
    );

    if (upd.rowCount !== 1) {
      await updateItem(runId, postid, {
        status: 'fehler',
        fehler_text: 'Der Datensatz hat sich während der Migration geändert — Zeile übersprungen.',
      });
      return false;
    }

    await updateItem(runId, postid, {
      status: 'fertig', dst_id: ziel.id, dst_link: ziel.webUrl || null,
      dst_name: ziel.name || wunschName, sha256: hash, fehler_text: null,
    });
    return true;
  } catch (err) {
    appLog('ERROR', 'storage-migration', `${postid}: ${err.message}`);
    const versuche = (it?.versuche || 0) + 1;
    await updateItem(runId, postid, {
      status: versuche >= MAX_VERSUCHE ? 'fehler' : 'offen',
      fehler_text: sichererFehler(err),
    }).catch(() => { /* DB nicht erreichbar — der Lauf bricht ohnehin ab */ });
    // Backoff bei Überlast der Gegenstelle.
    if (/\b(429|503)\b/.test(String(err?.message))) {
      await new Promise(r => setTimeout(r, 3000));
    }
    return false;
  }
}

/** Liegt am Ziel unter dieser ID eine Datei mit passendem sha256? */
async function pruefeZiel(dstAdapter, dstId, hash) {
  try {
    const buf = await dstAdapter.download(dstId);
    if (sha256Hex(buf) !== hash) return null;
    const meta = await dstAdapter.getMeta(dstId).catch(() => ({}));
    return { webUrl: meta.webUrl || null, name: meta.name || null };
  } catch {
    return null;
  }
}

// ── Restlisten-Auflösung ──────────────────────────────────────────────────────

async function itemHolen(runId, postid) {
  const r = await pool.query(
    `SELECT * FROM postbuch._storage_migration_items WHERE run_id = $1 AND postid = $2`,
    [runId, postid]
  );
  if (r.rows.length === 0) { const e = new Error('Eintrag nicht gefunden'); e.statusCode = 404; throw e; }
  return r.rows[0];
}

/** „Erneut versuchen" — Zeile zurück auf offen. */
export async function restErneutVersuchen(runId, postid) {
  await itemHolen(runId, postid);
  await updateItem(runId, postid, { status: 'offen', versuche: 0, fehler_text: null });
  return { ok: true };
}

/**
 * „Ohne Datei weiterführen" — storage_id auf NULL. Die App kennt den Zustand
 * (hat_pdf), der Datensatz bleibt vollständig durchsuchbar, nur ohne PDF.
 */
export async function restOhneDatei(runId, postid) {
  await itemHolen(runId, postid);
  await pool.query(
    `UPDATE postbuch.postbuch
        SET storage_id = NULL, onedrive_id = NULL,
            storage_filename = NULL, onedrive_filename = NULL,
            storage_modified = NULL, onedrive_modified = NULL,
            link = NULL
      WHERE postid = $1`,
    [postid]
  );
  await updateItem(runId, postid, { status: 'ohne_datei', fehler_text: null });
  appLog('WARN', 'storage-migration',
    `${postid}: ohne Datei weitergeführt (Migration)`, { entity: 'postbuch', entityId: postid });
  return { ok: true };
}

/** „DB-Eintrag löschen" — nur mit confirm, und nur solange keine Datei dranhängt. */
export async function restEintragLoeschen(runId, postid) {
  const it = await itemHolen(runId, postid);
  const { client, document } = await oeffneSichereDokumentloeschung(postid);
  try {
    // Unter demselben Parent-Lock erneut prüfen; eine Vorabprüfung außerhalb
    // der Transaktion ließe ein Wiederverknüpfen der Datei dazwischen zu.
    if (document.storage_id) {
      const e = new Error(
        'Der Datensatz zeigt noch auf eine Datei. Bitte zuerst „Ohne Datei weiterführen" wählen.'
      );
      e.statusCode = 409;
      throw e;
    }
    // Der Item-Eintrag verschwindet per ON DELETE CASCADE mit.
    await client.query(`DELETE FROM postbuch.postbuch WHERE postid = $1`, [postid]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  appLog('WARN', 'storage-migration',
    `${postid}: Datensatz per Migrations-Restliste gelöscht (Quelle war ${it.src_id})`,
    { entity: 'postbuch', entityId: postid });
  return { ok: true };
}

/** „Trotzdem abschließen" — Lauf beenden, Restliste bleibt einsehbar. */
export async function laufAbschliessen(runId) {
  const run = await getRun(runId);
  if (!run) { const e = new Error('Lauf nicht gefunden'); e.statusCode = 404; throw e; }
  const reste = await getRestliste(runId);
  await updateRun(runId, {
    status: reste.length > 0 ? 'abgeschlossen_mit_resten' : 'abgeschlossen',
    completed_at: new Date(),
  });
  return getRun(runId);
}

// ── Schritt 4: Umschalten ─────────────────────────────────────────────────────

/**
 * Schaltet das aktive Backend um. Eigene Route mit serverseitigen
 * Vorbedingungen — bewusst NICHT über PUT /api/settings/storage_backend:
 * ein einzelnes PUT kippte das aktive Backend ohne jede Prüfung (unverbundenes
 * Ziel, unvollständige Ordner, laufende Migration) und Neuzugänge scheiterten
 * oder landeten falsch.
 *
 * Kein `runId`-Parameter (bewusst, Architektur-Entscheidung): der offene Lauf
 * wird intern über getOffenenLauf() aufgelöst. Ein clientseitig mitgegebener
 * runId wäre ohnehin nur der aktuell offene — ein zweiter Parameter, der nie
 * einen anderen Wert tragen darf, ist keiner.
 */
export async function schalteBackendUm(ziel) {
  if (!BACKENDS.includes(ziel)) {
    const e = new Error('Unbekanntes Ablage-Backend'); e.statusCode = 400; throw e;
  }
  if (_aktiverLauf) {
    const e = new Error('Während einer laufenden Migration kann nicht umgeschaltet werden.');
    e.statusCode = 409; throw e;
  }

  const settings = await loadDynamicSettings();
  const ordner = getFolders(settings, ziel);
  if (!ordner.inbox) {
    const e = new Error(`Für "${ziel}" ist die Ordnerstruktur nicht eingerichtet (inbox fehlt).`);
    e.statusCode = 409; throw e;
  }

  // Erneut prüfen: zwischen der Eingangsprüfung und hier lag ein await, in dem
  // ein Lauf gestartet sein kann. Ohne diese zweite Prüfung höbe das resume()
  // unten die Pause einer laufenden Migration vorzeitig auf.
  if (_aktiverLauf) {
    const e = new Error('Während einer laufenden Migration kann nicht umgeschaltet werden.');
    e.statusCode = 409; throw e;
  }

  // Keine Pipeline darf mitten im Umschalten schreiben.
  pipelineQueue.pause('Backend-Wechsel');
  try {
    const leer = await pipelineQueue.warteAufLeerlauf(60000);
    if (!leer) {
      const e = new Error('Es laufen noch Verarbeitungen. Bitte in einer Minute erneut versuchen.');
      e.statusCode = 409; throw e;
    }

    // Nachzügler-Gate: MUSS innerhalb des pausierten Fensters laufen, sonst
    // ist es nur ein UX-Hinweis statt einer echten Schranke — zwischen einer
    // Prüfung vor pipelineQueue.pause() und dem UPDATE unten könnte die
    // Pipeline noch ein weiteres Dokument in die Quelle geschrieben haben.
    // Betrifft nur den Lauf, dessen Ziel gerade aktiv werden soll — ein Lauf
    // in die andere Richtung ist von diesem Umschalten nicht betroffen.
    const offenerLauf = await getOffenenLauf();
    if (offenerLauf && offenerLauf.dst_backend === ziel) {
      const { anzahl } = await ermittleNachzuegler(offenerLauf.id);
      if (anzahl > 0) {
        const e = new Error(
          `${anzahl} Dokument(e) in ${offenerLauf.src_backend} sind noch nicht Teil des Migrationslaufs. ` +
          `Bitte zuerst die Nachzügler in den Lauf aufnehmen und übertragen, dann erneut umschalten.`
        );
        e.statusCode = 409;
        e.nachzuegler = { runId: offenerLauf.id, anzahl };
        throw e;
      }
    }

    await pool.query(
      `INSERT INTO postbuch._settings (key, value, updated_at)
       VALUES ('storage_backend', $1::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [JSON.stringify(ziel)]
    );
    // switched_at ist die serverseitige Wahrheit für „darf noch zurückgebaut
    // werden" (rolleLaufZurueck()) UND die Grundlage, aus der die UI den
    // aktuellen Assistenten-Schritt ableitet, ohne einen zweiten Endpunkt zu
    // brauchen.
    if (offenerLauf && offenerLauf.dst_backend === ziel) {
      await updateRun(offenerLauf.id, { switched_at: new Date() });
    }
    appLog('WARN', 'storage-migration', `Aktives Ablage-Backend umgeschaltet auf "${ziel}"`);
  } finally {
    pipelineQueue.resume();
  }
  return { ok: true, backend: ziel };
}

// ── Nachzügler ────────────────────────────────────────────────────────────────

/**
 * Dokumente, die NACH der Item-Erfassung dieses Laufs neu im Quell-Backend
 * aufgetaucht sind — typischerweise, weil zwischen Laufende und „Umschalten"
 * (oder sogar schon zwischen Trockenlauf und Laufstart) weiter gescannt
 * wurde. Sie tauchen weder in der Restliste noch in Schritt 6 auf, weil sie
 * schlicht nie Teil der Item-Liste waren — nicht verloren (Mischbestand ist
 * ein gültiger Zustand, siehe Kopfkommentar), aber auch nicht migriert, obwohl
 * ein abgeschlossener Lauf das nahelegt.
 */
export async function ermittleNachzuegler(runId) {
  const run = await getRun(runId);
  if (!run) { const e = new Error('Lauf nicht gefunden'); e.statusCode = 404; throw e; }
  const r = await pool.query(
    `SELECT count(*)::int AS n FROM postbuch.postbuch p
      WHERE p.storage_backend = $1
        AND NOT EXISTS (
          SELECT 1 FROM postbuch._storage_migration_items i
           WHERE i.run_id = $2 AND i.postid = p.postid
        )`,
    [run.src_backend, runId]
  );
  return { anzahl: r.rows[0].n, srcBackend: run.src_backend, dstBackend: run.dst_backend };
}

/**
 * Hängt Nachzügler als neue Items an den BESTEHENDEN Lauf an, statt einen
 * zweiten Lauf anzulegen: getOffenenLauf() liefert je Backend-Paar nur den
 * jüngsten nicht geräumten Lauf (ORDER BY created_at DESC LIMIT 1) — ein
 * zweiter, paralleler Lauf machte den ersten samt seinem noch ausstehenden
 * Schritt 6 für die UI unsichtbar.
 *
 * Der Lauf geht danach auf 'pausiert' zurück — der normale Fortsetzen-Knopf
 * (starteLauf, OFFEN_STATUS) holt die neuen Items ganz regulär ab, inklusive
 * Advisory-Lock und Pipeline-Pause während des Kopierens.
 *
 * Nur erlaubt, solange die Quelle dieses Laufs noch nicht aufgeräumt ist:
 * raeumeQuelleAuf() lässt sich pro Lauf nur EINMAL ausführen (cleaned_at).
 * Nachzügler in einen bereits geräumten Lauf zu hängen, entzöge ihren
 * Quelldateien für immer den Aufräumen-Schritt. Ist die Quelle schon geräumt,
 * ist ein neuer Trockenlauf der richtige Weg — der kollidiert nicht mit der
 * Sichtbarkeit, weil getOffenenLauf() geräumte Läufe ohnehin ausblendet.
 */
export async function nachzueglerAufnehmen(runId) {
  const run = await getRun(runId);
  if (!run) { const e = new Error('Lauf nicht gefunden'); e.statusCode = 404; throw e; }
  if (run.cleaned_at) {
    const e = new Error(
      'Die Quelle dieses Laufs wurde bereits aufgeräumt. Bitte einen neuen Trockenlauf starten, um neu hinzugekommene Dokumente zu übertragen.'
    );
    e.statusCode = 409; throw e;
  }
  if (run.status === 'laeuft' || _aktiverLauf) {
    const e = new Error('Es läuft bereits eine Migration.'); e.statusCode = 409; throw e;
  }

  const settings = await loadDynamicSettings();
  const srcAdapter = getAdapter(run.src_backend);

  const rows = (await pool.query(
    `SELECT p.postid, p.lebensbereich, p.dokumentart, p.familienmitglied, p.storage_id, p.storage_filename, p.link, p.sha256
       FROM postbuch.postbuch p
      WHERE p.storage_backend = $1
        AND NOT EXISTS (
          SELECT 1 FROM postbuch._storage_migration_items i
           WHERE i.run_id = $2 AND i.postid = p.postid
        )
      ORDER BY p.postid`,
    [run.src_backend, runId]
  )).rows;

  // Erneut prüfen: der obige SELECT liegt hinter einem await, in dem ein Lauf
  // gestartet sein kann. Ohne diese zweite Prüfung schriebe diese Funktion in
  // dieselbe Item-Tabelle wie ein parallel laufender fuehreLaufAus(), dessen
  // offene-Queue einmalig zu Laufbeginn gebaut wird — neue Items blieben dann
  // bis zum nächsten Resume unbeachtet.
  if (_aktiverLauf) {
    const e = new Error('Es läuft bereits eine Migration.'); e.statusCode = 409; throw e;
  }

  let aufgenommen = 0, ohneDatei = 0, keinZielordner = 0, bereit = 0;
  for (const row of rows) {
    const { status, inserted } = await itemAnlegen(runId, run.src_backend, run.dst_backend, srcAdapter, settings, row);
    if (!inserted) continue;
    aufgenommen++;
    if (status === 'ohne_datei') ohneDatei++;
    else if (status === 'kein_zielordner') keinZielordner++;
    else bereit++;
  }

  if (aufgenommen > 0) {
    await updateRun(runId, {
      status: 'pausiert',
      completed_at: null,
      stats: JSON.stringify({ ...(run.stats || {}), nachzuegler: { aufgenommen, bereit, ohneDatei, keinZielordner } }),
    });
    appLog('INFO', 'storage-migration',
      `Lauf ${runId}: ${aufgenommen} Nachzügler aus ${run.src_backend} aufgenommen (${bereit} bereit), Lauf wieder fortsetzbar`);
  }
  return { aufgenommen, bereit, ohneDatei, keinZielordner };
}

// ── Schritt 6: Quelle aufräumen ───────────────────────────────────────────────

/**
 * Ermittelt, welche Quelldateien geräumt werden dürften — ohne zu räumen.
 * Diese Menge ist die Grundlage für das Scope-Pinning: der Cleanup-Aufruf muss
 * dieselbe Anzahl mitschicken, sonst 409.
 */
export async function aufraeumenVorschau(runId) {
  const run = await getRun(runId);
  if (!run) { const e = new Error('Lauf nicht gefunden'); e.statusCode = 404; throw e; }

  const kandidaten = (await pool.query(
    `SELECT i.postid, i.src_id, i.dst_id, i.src_name
       FROM postbuch._storage_migration_items i
       JOIN postbuch.postbuch p ON p.postid = i.postid
      WHERE i.run_id = $1
        AND i.status = 'fertig'
        AND i.src_id IS NOT NULL
        AND i.dst_id IS NOT NULL
        AND p.storage_backend = $2
        AND p.storage_id = i.dst_id
        AND p.storage_id IS DISTINCT FROM i.src_id
      ORDER BY i.postid`,
    [runId, run.dst_backend]
  )).rows;

  // Fremdreferenzen ausschließen: _failed_documents und _pipeline_suspensions
  // zeigen mit eigenen IDs in die Quelle. Wird eine solche Datei mitgeräumt,
  // verliert ein wartender Duplikat-Entscheid bzw. ein Failed-Retry seine Datei.
  const geschuetzt = new Set([
    ...(await pool.query(
      `SELECT storage_id FROM postbuch._failed_documents WHERE storage_backend = $1 AND storage_id IS NOT NULL`,
      [run.src_backend])).rows.map(r => r.storage_id),
    ...(await pool.query(
      `SELECT storage_id FROM postbuch._pipeline_suspensions WHERE storage_backend = $1 AND storage_id IS NOT NULL`,
      [run.src_backend])).rows.map(r => r.storage_id),
  ]);

  const raeumbar = kandidaten.filter(k => !geschuetzt.has(k.src_id));
  return {
    runId,
    srcBackend: run.src_backend,
    dstBackend: run.dst_backend,
    anzahl: raeumbar.length,
    geschuetzt: kandidaten.length - raeumbar.length,
    // Vollständige Menge — die Räum-Schleife arbeitet darauf. Für die Anzeige
    // schneidet die Route ab, nicht diese Funktion.
    alle: raeumbar,
    items: raeumbar.slice(0, 50),
  };
}

/**
 * Verschiebt die Quelldateien in den _trash des QUELL-Backends.
 *
 * Niemals `remove` — das Modul importiert die Funktion gar nicht erst.
 * Scope-Pinning über erwarteteAnzahl: weicht sie von der serverseitig
 * berechneten Menge ab, wird abgebrochen. Sonst räumte eine veraltete
 * UI-Ansicht Zeilen mit, die der Nutzer nie gesehen hat.
 */
export async function raeumeQuelleAuf(runId, erwarteteAnzahl) {
  const run = await getRun(runId);
  if (!run) { const e = new Error('Lauf nicht gefunden'); e.statusCode = 404; throw e; }
  if (!['abgeschlossen', 'abgeschlossen_mit_resten'].includes(run.status)) {
    const e = new Error('Die Quelle kann erst nach Abschluss des Laufs geräumt werden.');
    e.statusCode = 409; throw e;
  }
  if (run.cleaned_at) {
    const e = new Error('Die Quelle dieses Laufs wurde bereits geräumt.'); e.statusCode = 409; throw e;
  }

  const vorschau = await aufraeumenVorschau(runId);
  if (Number(erwarteteAnzahl) !== vorschau.anzahl) {
    const e = new Error(
      `Die Anzahl hat sich geändert (erwartet ${erwarteteAnzahl}, tatsächlich ${vorschau.anzahl}). Bitte neu laden.`
    );
    e.statusCode = 409; throw e;
  }

  // Läuft im Hintergrund wie starteLauf()/trockenlauf() — bei vielen
  // Quelldateien blockierte ein synchroner Trash-Lauf sonst minutenlang den
  // HTTP-Request, ohne dass die UI einen Fortschritt anzeigen könnte.
  return mitMigrationsLock(runId, async ({ freigeben, istWeg }) => {
    const jobId = tracker.create(
      'storage-migration',
      `Quelle aufräumen: ${run.src_backend}`,
      vorschau.alle.length,
      false,
      { runId }
    );
    try {
      await tracker.awaitPersisted(jobId);
    } catch (err) {
      tracker.fail(jobId, sichererFehler(err));
      await freigeben();
      throw err;
    }

    fuehreAufraeumenAus({ runId, jobId, run, vorschau, istWeg })
      .catch(err => console.error('[storage-migration] Aufräumen:', err.message))
      .finally(freigeben);

    return { runId, jobId };
  });
}

async function fuehreAufraeumenAus({ runId, jobId, run, vorschau, istWeg }) {
  const srcAdapter = getAdapter(run.src_backend);
  let geraeumt = 0, fehler = 0, verarbeitet = 0;

  try {
    for (const k of vorschau.alle) {
      if (_abbruchAngefordert || istWeg()) break;

      // Per-Item-Verify unmittelbar vor dem Trash: die Zeile muss JETZT noch auf
      // das Ziel zeigen. Ein Resume-Lauf könnte sie zwischenzeitlich umgehängt
      // haben — dann räumten wir genau die Datei weg, auf die sie zeigt.
      const row = (await pool.query(
        `SELECT storage_backend, storage_id FROM postbuch.postbuch WHERE postid = $1`, [k.postid]
      )).rows[0];
      if (!row || row.storage_backend !== run.dst_backend || row.storage_id !== k.dst_id
          || row.storage_id === k.src_id) {
        verarbeitet++;
        continue;
      }
      try {
        await srcAdapter.moveToTrash(k.src_id, `[Migriert] ${k.postid}.pdf`);
        geraeumt++;
      } catch (err) {
        fehler++;
        appLog('WARN', 'storage-migration', `Aufräumen ${k.postid}: ${err.message}`);
      }
      verarbeitet++;
      tracker.setStep(jobId, verarbeitet, `${verarbeitet} / ${vorschau.alle.length}`);
    }

    if (_abbruchAngefordert || istWeg()) {
      tracker.complete(jobId, { pausiert: true, geraeumt, fehler });
      appLog('INFO', 'storage-migration', `Aufräumen ${runId} angehalten bei ${verarbeitet}/${vorschau.alle.length}`);
      return;
    }

    await updateRun(runId, { cleaned_at: new Date() });
    tracker.complete(jobId, { geraeumt, fehler });
    appLog('WARN', 'storage-migration',
      `Quelle von Lauf ${runId} geräumt: ${geraeumt} Datei(en) nach _trash (${run.src_backend}), ${fehler} Fehler`);
  } catch (err) {
    appLog('ERROR', 'storage-migration', `Aufräumen ${runId} fehlgeschlagen: ${err.message}`);
    tracker.fail(jobId, sichererFehler(err));
  } finally {
    _abbruchAngefordert = false;
  }
}

/**
 * Schließt den Lauf ab, OHNE die Quelldateien aufzuräumen — für Nutzer, die
 * das manuelle Aufräumen dauerhaft überspringen wollen. Setzt bewusst
 * dieselbe `cleaned_at`-Spalte wie raeumeQuelleAuf(): der Aufräum-Schritt ist
 * damit „erledigt" im Sinne von getOffenenLauf() (das Dashboard-Banner
 * verschwindet), ohne dass irgendetwas in der Quelle bewegt wurde.
 */
export async function schliesseOhneAufraeumenAb(runId) {
  const run = await getRun(runId);
  if (!run) { const e = new Error('Lauf nicht gefunden'); e.statusCode = 404; throw e; }
  if (!run.switched_at) {
    const e = new Error('Erst nach dem Umschalten lässt sich der Umzug abschließen.'); e.statusCode = 409; throw e;
  }
  if (run.cleaned_at) return getRun(runId);
  await updateRun(runId, { cleaned_at: new Date() });
  appLog('INFO', 'storage-migration', `Lauf ${runId} ohne Aufräumen der Quelle abgeschlossen`);
  return getRun(runId);
}

// ── Rückbau ───────────────────────────────────────────────────────────────────
//
// Siehe Kopfkommentar „Rückbau (Ausnahme von obigem Grundsatz)": kein neuer
// Lauf, kein Rückspulen — das In-place-Zurückdrehen der Items, die GENAU
// DIESER Lauf gerade erst kopiert hat, solange er pausiert, nicht umgeschaltet
// und nicht geräumt ist.

const RUECKBAUBARE_STATUS = [
  'vorbereitet', 'trockenlauf', 'pausiert', 'abgeschlossen', 'abgeschlossen_mit_resten', 'fehler',
];

function pruefeRueckbaubar(run) {
  if (!RUECKBAUBARE_STATUS.includes(run.status)) {
    const e = new Error(
      run.status === 'laeuft'
        ? 'Ein Rückbau ist nicht möglich, während der Lauf aktiv kopiert. Bitte zuerst anhalten.'
        : 'Ein Rückbau ist für diesen Lauf nicht (mehr) möglich.'
    );
    e.statusCode = 409; throw e;
  }
  if (run.cleaned_at) {
    const e = new Error('Die Quelle dieses Laufs wurde bereits aufgeräumt — ein Rückbau ist nicht mehr möglich.');
    e.statusCode = 409; throw e;
  }
  if (run.switched_at) {
    const e = new Error('Es wurde bereits auf das Ziel-Backend umgeschaltet — ein Rückbau ist nicht mehr möglich.');
    e.statusCode = 409; throw e;
  }
}

/**
 * Ermittelt, welche Items dieses Laufs zurückgebaut würden — ohne zu
 * schreiben. Scope-Pinning wie aufraeumenVorschau(): rolleLaufZurueck() muss
 * dieselbe Anzahl mitschicken, sonst 409.
 */
export async function rueckbauVorschau(runId) {
  const run = await getRun(runId);
  if (!run) { const e = new Error('Lauf nicht gefunden'); e.statusCode = 404; throw e; }
  pruefeRueckbaubar(run);

  const kandidaten = (await pool.query(
    `SELECT i.postid, i.src_id, i.src_name, i.src_link, i.dst_id
       FROM postbuch._storage_migration_items i
       JOIN postbuch.postbuch p ON p.postid = i.postid
      WHERE i.run_id = $1
        AND i.status = 'fertig'
        AND i.dst_id IS NOT NULL
        AND p.storage_backend = $2
        AND p.storage_id = i.dst_id
      ORDER BY i.postid`,
    [runId, run.dst_backend]
  )).rows;

  return {
    runId,
    srcBackend: run.src_backend,
    dstBackend: run.dst_backend,
    anzahl: kandidaten.length,
    alle: kandidaten,
    items: kandidaten.slice(0, 50),
  };
}

/**
 * Baut die von DIESEM Lauf bereits kopierten Items zurück: die postbuch-Zeile
 * zeigt danach wieder auf Backend UND Datei-ID der Quelle (nicht nur auf einen
 * Pfad — genau das hatte der Nutzer zurecht eingefordert). Die Zielkopie wird
 * NICHT gelöscht, sie bleibt als harmlose Waise liegen (Reversibilitätsprämisse
 * des Moduls, siehe Kopfkommentar: kein `remove`-Import).
 *
 * Läuft unter demselben Advisory-Lock wie starteLauf() — beide dürfen nicht
 * gleichzeitig gegen dieselben Items schreiben.
 */
export async function rolleLaufZurueck(runId, erwarteteAnzahl) {
  const run = await getRun(runId);
  if (!run) { const e = new Error('Lauf nicht gefunden'); e.statusCode = 404; throw e; }
  pruefeRueckbaubar(run);

  const vorschau = await rueckbauVorschau(runId);
  if (Number(erwarteteAnzahl) !== vorschau.anzahl) {
    const e = new Error(
      `Die Anzahl hat sich geändert (erwartet ${erwarteteAnzahl}, tatsächlich ${vorschau.anzahl}). Bitte neu laden.`
    );
    e.statusCode = 409; throw e;
  }

  return mitMigrationsLock(runId, async ({ freigeben }) => {
    try {
      // Erneut prüfen: zwischen der Eingangsprüfung und dem Lock-Erwerb lag
      // ein await, in dem sich der Lauf-Status geändert haben kann.
      pruefeRueckbaubar(await getRun(runId));
      // Kein Scan darf mitten im Rückbau in eine der beiden Ablagen schreiben.
      pipelineQueue.pause('Migrations-Rückbau');

      let zurueckgebaut = 0, uebersprungen = 0;
      for (const k of vorschau.alle) {
        const lg = legacyOnedriveWerte(run.src_backend, {
          id: k.src_id, name: k.src_name, modified: null,
        });
        const setzeLegacy = run.src_backend === 'onedrive';

        const params = [k.postid, run.src_backend, k.src_id, k.src_name, k.src_link];
        let legacySql = '';
        if (setzeLegacy) {
          params.push(lg.id, lg.name);
          legacySql = ', onedrive_id = $6, onedrive_filename = $7, onedrive_modified = NOW()';
        }
        const pDst = params.push(run.dst_backend);
        const pDstId = params.push(k.dst_id);

        // Guard spiegelt den Vorwärts-Fall in migriereEine(): nur zurückdrehen,
        // wenn die Zeile JETZT noch exakt auf die Zielkopie DIESES Laufs zeigt.
        const upd = await pool.query(
          `UPDATE postbuch.postbuch
              SET storage_backend = $2,
                  storage_id = $3,
                  storage_filename = $4,
                  storage_modified = NOW(),
                  link = $5
                  ${legacySql}
            WHERE postid = $1 AND storage_backend = $${pDst} AND storage_id = $${pDstId}`,
          params
        );

        if (upd.rowCount !== 1) {
          await updateItem(runId, k.postid, {
            status: 'uebersprungen',
            fehler_text: 'Der Datensatz zeigt nicht mehr auf die Zielkopie dieses Laufs — Rückbau übersprungen.',
          });
          uebersprungen++;
          continue;
        }

        await updateItem(runId, k.postid, { status: 'zurueckgebaut', fehler_text: null });
        zurueckgebaut++;
      }

      await updateRun(runId, { status: 'abgebrochen' });
      appLog('WARN', 'storage-migration',
        `Lauf ${runId} zurückgebaut: ${zurueckgebaut} Item(s) zeigen wieder auf ${run.src_backend}, ${uebersprungen} übersprungen`);

      return { zurueckgebaut, uebersprungen };
    } finally {
      await freigeben();
    }
  });
}

/**
 * Universeller „Abbrechen"-Einstieg für die gesamte Migration, unabhängig
 * davon, in welchem Schritt sie gerade steht. Zwei Fälle:
 *  - Ein Hintergrund-Worker zählt oder kopiert gerade FÜR DIESEN Lauf
 *    (`_aktiverLauf === runId`) → nur signalisieren (brichAb()), die Frontend-
 *    Seite pollt danach den Lauf und ruft diese Funktion bei Bedarf erneut auf,
 *    sobald der Worker auf 'pausiert' gefallen ist.
 *  - Sonst (nichts läuft, oder der Lauf ist bereits 'pausiert'/'trockenlauf'/
 *    'vorbereitet'/'fehler'/abgeschlossen-mit-Resten) → sofort zurückbauen.
 * Verweigert grundsätzlich, sobald umgeschaltet oder aufgeräumt wurde — ab
 * da ist „Abbrechen" nicht mehr sinnvoll, das deckt bereits pruefeRueckbaubar().
 */
export async function brichLaufVollstaendigAb(runId) {
  const run = await getRun(runId);
  if (!run) { const e = new Error('Lauf nicht gefunden'); e.statusCode = 404; throw e; }
  if (run.switched_at || run.cleaned_at) {
    const e = new Error('Es wurde bereits umgeschaltet oder aufgeräumt — ein Abbrechen ist nicht mehr möglich.');
    e.statusCode = 409; throw e;
  }

  if (_aktiverLauf === runId) {
    brichAb();
    return { phase: 'wird_angehalten' };
  }

  const vorschau = await rueckbauVorschau(runId);
  const ergebnis = await rolleLaufZurueck(runId, vorschau.anzahl);
  return { phase: 'zurueckgebaut', ...ergebnis };
}
