/**
 * service/stapel.js – Dokumentenstapel: Blätter sammeln, Trennung vorschlagen, aufteilen
 *
 * Ein Dokumentenstapel entsteht beim Scan aus dem Einzug mit der Quelle
 * „Dokumentenstapel“. Der Scanner schreibt je Blatt eine Datei
 * `adf_(duplex|simplex)_batch_stapel-<uuid>_<seq>v<n>.pdf`, der Cleaner
 * bereinigt jede für sich und meldet sie über die Webhooks. Statt jedes Blatt
 * einzeln in die Pipeline zu reihen, sammelt dieser Dienst die Blätter unter
 * /data/scan_buffer/stapel/<uuid>/ und teilt sie nach Vorschlag der KI und
 * Prüfung im Eingang in Dokumente auf.
 *
 * Zustände (postbuch._stapel.status):
 *   liest_ein  → Blätter kommen an; vollständig oder nach Ruhezeit weiter
 *   vorschlag  → die KI schlägt die Trennung vor
 *   wartet     → im Eingang unter „Dokumentenstapel“; mit automatisch_ab läuft der
 *                Countdown der Übernahme ohne Rückfrage
 *   teilt_auf  → Dokumente werden gebaut und dauerhaft eingereiht
 *   erledigt   → Zeile bleibt 30 Tage, Blattdateien sind gelöscht
 *
 * Jeder Statuswechsel ist ein bedingtes UPDATE. Wer zu spät kommt, bekommt
 * KonfliktError (409). Ein Blatt, das keinem offenen Stapel mehr zugeordnet
 * werden kann, läuft als normaler Einzelscan weiter: Der Cleaner wiederholt
 * eine abgewiesene Datei endlos, ein Fehler hier wäre also ein Stau, und
 * verloren gehen darf das Blatt nicht.
 *
 * Reine Logik (Prüfen, Aufteilen, Bedingungen der Automatik) steht in
 * service/stapel-aufteilung.js.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import pool from '../db.js';
import * as tracker from '../jobs/tracker.js';
import { reiheDauerhaftEin } from '../jobs/pipeline-queue.js';
import { SCAN_BUFFER_DIR, schreibeDauerhaft } from '../lib/scan-buffer.js';
import { countPdfPages, selectPages, mergePdfs, extractTextLayer, splitPages, rotatePdf } from '../lib/pdf.js';
import { loadDynamicSettings } from '../config.js';
import * as llm from '../lib/llm.js';
import { stapelTrennungPrompt } from '../prompts/stapel-trennung.js';
import { STAPEL_TRENNUNG_SCHEMA } from '../prompts/antwort-schemas.js';
import {
  pruefeVorschlag, pruefeEntscheidung, aufteilung, automatischMoeglich, blaetterMitInhalt,
} from './stapel-aufteilung.js';
import { holeVorschau } from './eingang-vorschau.js';
import { KonfliktError } from './offene-eingaenge.js';
import { appLog } from '../app-log.js';

export const STAPEL_DIR = path.join(SCAN_BUFFER_DIR, 'stapel');

export const MAX_BLAETTER = 200;
export const MAX_OFFEN = 5;
export const MAX_BYTES = 1024 * 1024 * 1024;
export const COUNTDOWN_S = 15;
const RUHEZEIT_MIN = 15;
const OHNE_BLATT_MAX_MIN = 120;
const ERLEDIGT_TAGE = 30;
const TAKT_MS = 15_000;
const FEHLER_PAUSE_MS = 5 * 60_000;
const TEXT_JE_SEITE = 1200;
const TEXT_GESAMT = 120_000;

const OFFEN = ['liest_ein', 'vorschlag', 'wartet'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NAME_RE = /^adf_(duplex|simplex)_batch_stapel-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_(\d{1,3})v(\d{1,3})\.pdf$/;
const JOB_LABEL = { einzug: 'Dokumentenstapel aus dem Einzug', upload: 'Dokumentenstapel aus einer PDF' };
const JOB_SCHRITTE = 3;

const inArbeit = new Set();      // Stapel-IDs mit laufendem Vorschlag oder Aufteilen
const fehlerAm = new Map();      // Stapel-ID → Zeitpunkt des letzten gescheiterten Aufteilens
let taktLaeuft = false;
let taktTimer = null;

export class StapelGrenzeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StapelGrenzeError';
    this.status = 429;
  }
}

export function istStapelId(id) {
  return typeof id === 'string' && UUID_RE.test(id);
}

/** Zerlegt einen Stapelnamen. @returns {{duplex:boolean,id:string,seq:number,n:number}|null} */
export function parseStapelName(name) {
  const m = typeof name === 'string' ? NAME_RE.exec(name) : null;
  if (!m) return null;
  const seq = Number(m[3]);
  const n = Number(m[4]);
  if (seq < 1 || n < 1 || seq > n || n > MAX_BLAETTER) return null;
  return { duplex: m[1] === 'duplex', id: m[2], seq, n };
}

/** Sieht nach Stapel aus, ohne gültig zu sein – nur fürs Protokoll. */
function siehtAusWieStapel(name) {
  return typeof name === 'string' && name.includes('_batch_stapel-');
}

const verzeichnis = (id) => path.join(STAPEL_DIR, id);
const blattPfad = (id, seq) => path.join(verzeichnis(id), `blatt_${seq}.pdf`);

async function loescheVerzeichnis(id) {
  if (!istStapelId(id)) return;
  await fs.rm(verzeichnis(id), { recursive: true, force: true }).catch((err) => {
    console.error(`[stapel] Verzeichnis ${id} nicht gelöscht: ${err.message}`);
  });
}

async function verzeichnisGroesse(id) {
  let summe = 0;
  try {
    for (const name of await fs.readdir(verzeichnis(id))) {
      const st = await fs.stat(path.join(verzeichnis(id), name)).catch(() => null);
      if (st?.isFile()) summe += st.size;
    }
  } catch { /* noch kein Verzeichnis */ }
  return summe;
}

function ohneRueckfrage(settings) {
  const v = settings?.stapel_ohne_rueckfrage;
  return !(v === false || v === 'false' || v === 0 || v === '0');
}

// ── Job unter Logs/Jobs ──────────────────────────────────────────────────────
// Ein Job je Stapel mit fester ID = Stapel-ID. Er läuft in den aktiven
// Phasen (Einlesen, Vorschlag, Aufteilen) und endet, sobald der Stapel auf
// den Nutzer wartet oder erledigt ist.

function jobLaeuft(id, step, stepLabel, quelle = 'einzug') {
  if (tracker.isActive(id)) {
    tracker.setStep(id, step, stepLabel);
    return;
  }
  tracker.wiederherstellen(id, JOB_LABEL[quelle] || JOB_LABEL.einzug, JOB_SCHRITTE, {
    type: 'stapel', status: 'running', step, stepLabel, cancellable: false,
  }).catch(() => {});
}

// ── Anlegen ──────────────────────────────────────────────────────────────────

async function zaehleOffene(client = pool) {
  const { rows } = await client.query(
    'SELECT count(*)::int AS n FROM postbuch._stapel WHERE status = ANY($1)', [OFFEN]);
  return rows[0].n;
}

/**
 * Legt beim Auslösen einen Stapel an. Die ID entsteht hier, nie im Client.
 * @throws {StapelGrenzeError} bei zu vielen offenen Stapeln
 * @returns {Promise<string>} Stapel-ID
 */
export async function starteStapel({ duplex, hinweis = null }) {
  if (await zaehleOffene() >= MAX_OFFEN) {
    throw new StapelGrenzeError(`Es sind bereits ${MAX_OFFEN} Dokumentenstapel offen. `
      + 'Bitte prüfe sie zuerst im Eingang.');
  }
  const id = randomUUID();
  await pool.query(
    `INSERT INTO postbuch._stapel (id, duplex, hinweis) VALUES ($1, $2, $3)`,
    [id, !!duplex, hinweis || null]);
  jobLaeuft(id, 0, 'Scanner liest die Blätter ein');
  appLog('INFO', 'stapel', `Dokumentenstapel ausgelöst (${duplex ? 'Duplex' : 'Simplex'})`, { entity: 'stapel', entityId: id });
  return id;
}

/**
 * Upload im Modus „Stapel auftrennen“ (genau eine PDF): Jede Seite wird ein Blatt, danach
 * läuft der Stapel wie aus dem Einzug weiter (Vorschlag, Prüfung, Aufteilen).
 * Die Seiten gehen nicht durch den Cleaner; eine Textebene der PDF bleibt wie
 * beim Einzelupload erhalten und dient der KI für den Trennvorschlag.
 * @throws {StapelGrenzeError} bei zu vielen offenen Stapeln
 * @returns {Promise<{ id: string, blaetter: number }>}
 */
export async function stapelAusPdf({ pdfBuffer, hinweis = null }) {
  if (pdfBuffer.length > MAX_BYTES) {
    throw Object.assign(new Error('Die PDF ist für einen Dokumentenstapel zu groß (über 1 GB).'), { status: 400 });
  }
  const seiten = await splitPages(pdfBuffer);
  if (seiten.length > MAX_BLAETTER) {
    throw Object.assign(new Error(`Ein Dokumentenstapel hat höchstens ${MAX_BLAETTER} Seiten, die PDF hat ${seiten.length}.`), { status: 400 });
  }
  if (await zaehleOffene() >= MAX_OFFEN) {
    throw new StapelGrenzeError(`Es sind bereits ${MAX_OFFEN} Dokumentenstapel offen. `
      + 'Bitte prüfe sie zuerst im Eingang.');
  }
  const id = randomUUID();
  await pool.query(
    `INSERT INTO postbuch._stapel (id, duplex, blaetter_n, hinweis, quelle, letztes_blatt_am)
     VALUES ($1, false, $2, $3, 'upload', now())`, [id, seiten.length, hinweis || null]);
  jobLaeuft(id, 0, 'Seiten werden übernommen', 'upload');
  try {
    for (let i = 0; i < seiten.length; i++) {
      await schreibeDauerhaft(verzeichnis(id), `blatt_${i + 1}.pdf`, seiten[i]);
    }
    await pool.query(
      `INSERT INTO postbuch._stapel_blatt (stapel_id, seq, kennung, zustand, seiten)
       SELECT $1, g, gen_random_uuid(), 'da', 1 FROM generate_series(1, $2::int) g`,
      [id, seiten.length]);
  } catch (err) {
    await pool.query('DELETE FROM postbuch._stapel WHERE id = $1', [id]).catch(() => {});
    await loescheVerzeichnis(id);
    tracker.fail(id, `PDF nicht übernommen: ${err.message}`);
    throw err;
  }
  // Seiten ohne Textebene (Scan ohne Texterkennung) kann die KI nicht beurteilen.
  // Das Hochladen meldet sie, damit niemand auf einen Vorschlag wartet, der nicht kommt.
  let ohneText = 0;
  for (const seite of seiten) {
    const text = await extractTextLayer(seite).catch(() => '');
    if (!String(text || '').trim()) ohneText++;
  }
  appLog('INFO', 'stapel', `Dokumentenstapel aus einer PDF mit ${seiten.length} Seiten angelegt`
    + (ohneText ? `, ${ohneText} davon ohne Textebene` : ''), { entity: 'stapel', entityId: id });
  await pruefeVollstaendig(id);
  return { id, blaetter: seiten.length, ohneText };
}

/**
 * Der Scanner hat nicht geliefert: Ein Stapel ohne jedes Blatt wird wieder
 * gelöscht. Hat der Cleaner schon etwas gemeldet, bleibt er stehen.
 */
export async function verwirfLeerenStapel(id, meldung) {
  if (!istStapelId(id)) return;
  const { rowCount } = await pool.query(
    `DELETE FROM postbuch._stapel s
      WHERE s.id = $1 AND s.status = 'liest_ein'
        AND NOT EXISTS (SELECT 1 FROM postbuch._stapel_blatt b WHERE b.stapel_id = s.id)`, [id]);
  if (rowCount) {
    await loescheVerzeichnis(id);
    tracker.fail(id, meldung || 'Der Scanner hat keine Blätter geliefert.');
  }
}

// ── Webhooks ─────────────────────────────────────────────────────────────────

/**
 * Holt den Stapel eines Blatts unter Zeilensperre, legt ihn beim Weg ohne
 * Auslösen in der App an und prüft, ob er noch Blätter annimmt.
 * @returns {Promise<object|null>} Stapelzeile oder null (→ normaler Einzelscan)
 */
async function sperreStapelFuerBlatt(client, p, dateiname) {
  const neu = await client.query(
    `INSERT INTO postbuch._stapel (id, duplex, blaetter_n) VALUES ($1, $2, $3)
     ON CONFLICT (id) DO NOTHING RETURNING id`, [p.id, p.duplex, p.n]);
  if (neu.rowCount) {
    // Weg ohne Auslösen in der App (Scan-Webhook-URL): erst hier entsteht der
    // Stapel. Die Obergrenze gilt trotzdem.
    if (await zaehleOffene(client) > MAX_OFFEN) {
      appLog('WARN', 'stapel', `Zu viele offene Dokumentenstapel – Blatt läuft als Einzelscan: ${dateiname}`);
      return null;
    }
  }
  const { rows } = await client.query(
    'SELECT * FROM postbuch._stapel WHERE id = $1 FOR UPDATE', [p.id]);
  const s = rows[0];
  if (!s || !OFFEN.includes(s.status)) {
    appLog('WARN', 'stapel',
      `Blatt für einen ${s ? 'bereits aufgeteilten' : 'unbekannten'} Dokumentenstapel – läuft als Einzelscan: ${dateiname}`,
      { entity: 'stapel', entityId: p.id });
    return null;
  }
  if (s.blaetter_n != null && s.blaetter_n !== p.n) {
    appLog('WARN', 'stapel', `Blattzahl passt nicht zum Dokumentenstapel – läuft als Einzelscan: ${dateiname}`,
      { entity: 'stapel', entityId: p.id });
    return null;
  }
  if (s.blaetter_n == null) {
    await client.query('UPDATE postbuch._stapel SET blaetter_n = $2 WHERE id = $1', [p.id, p.n]);
  }
  if (neu.rowCount) jobLaeuft(p.id, 0, 'Blätter kommen an');
  return s;
}

async function inTransaktion(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ergebnis = await fn(client);
    await client.query(ergebnis == null ? 'ROLLBACK' : 'COMMIT');
    return ergebnis;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function warnungUngueltig(dateiname) {
  if (siehtAusWieStapel(dateiname)) {
    appLog('WARN', 'stapel', `Ungültiger Dokumentenstapel-Dateiname – läuft als Einzelscan: ${String(dateiname).slice(0, 120)}`);
  }
}

/**
 * scan-registered: meldet ein Blatt an.
 * @returns {Promise<string|null>} Blattkennung (an den Cleaner als jobId) oder
 *   null, wenn die Datei als normaler Scan weiterlaufen soll
 */
export async function blattAngemeldet(dateiname) {
  const p = parseStapelName(dateiname);
  if (!p) { warnungUngueltig(dateiname); return null; }
  const kennung = randomUUID();
  const ok = await inTransaktion(async (client) => {
    const s = await sperreStapelFuerBlatt(client, p, dateiname);
    if (!s) return null;
    await client.query(
      `INSERT INTO postbuch._stapel_blatt (stapel_id, seq, kennung) VALUES ($1, $2, $3)
       ON CONFLICT (stapel_id, seq) DO UPDATE
         SET kennung = EXCLUDED.kennung,
             zustand = CASE WHEN postbuch._stapel_blatt.zustand = 'da' THEN 'da' ELSE 'angemeldet' END`,
      [p.id, p.seq, kennung]);
    await client.query(
      `UPDATE postbuch._stapel SET letztes_blatt_am = now(), automatisch_ab = NULL, geaendert_am = now()
        WHERE id = $1`, [p.id]);
    return true;
  });
  if (!ok) return null;
  jobLaeuft(p.id, 0, `Texterkennung, Blatt ${p.seq} von ${p.n}`);
  return kennung;
}

/**
 * scan-complete: legt das bereinigte Blatt dauerhaft ab.
 * @returns {Promise<{stapelId:string, seq:number}|null>} null → normaler Scan
 */
export async function blattEingegangen(dateiname, kennung, pdfBuffer) {
  const p = parseStapelName(dateiname);
  if (!p) { warnungUngueltig(dateiname); return null; }
  let seiten;
  try {
    seiten = await countPdfPages(pdfBuffer);
  } catch (err) {
    appLog('WARN', 'stapel', `Blatt nicht lesbar – läuft als Einzelscan: ${dateiname}: ${err.message}`, { entity: 'stapel', entityId: p.id });
    return null;
  }
  if (!(seiten >= 1 && seiten <= 2)) {
    appLog('WARN', 'stapel', `Blatt mit ${seiten} Seiten – läuft als Einzelscan: ${dateiname}`, { entity: 'stapel', entityId: p.id });
    return null;
  }
  const ok = await inTransaktion(async (client) => {
    const s = await sperreStapelFuerBlatt(client, p, dateiname);
    if (!s) return null;
    if (await verzeichnisGroesse(p.id) + pdfBuffer.length > MAX_BYTES) {
      appLog('WARN', 'stapel', `Dokumentenstapel über 1 GB – Blatt läuft als Einzelscan: ${dateiname}`, { entity: 'stapel', entityId: p.id });
      return null;
    }
    // Unter der Zeilensperre: Wer den Stapel aufteilt, wartet auf diese
    // Transaktion und sieht das Blatt danach sicher.
    await schreibeDauerhaft(verzeichnis(p.id), `blatt_${p.seq}.pdf`, pdfBuffer);
    await client.query(
      `INSERT INTO postbuch._stapel_blatt (stapel_id, seq, kennung, zustand, seiten)
       VALUES ($1, $2, $3, 'da', $4)
       ON CONFLICT (stapel_id, seq) DO UPDATE SET zustand = 'da', seiten = EXCLUDED.seiten`,
      [p.id, p.seq, istStapelId(kennung) ? kennung : randomUUID(), seiten]);
    await client.query(
      `UPDATE postbuch._stapel SET letztes_blatt_am = now(), automatisch_ab = NULL, geaendert_am = now()
        WHERE id = $1`, [p.id]);
    return true;
  });
  if (!ok) return null;
  await pruefeVollstaendig(p.id);
  return { stapelId: p.id, seq: p.seq };
}

/**
 * scan-aborted: Der Cleaner hat ein ganz leeres Blatt verworfen.
 * @returns {Promise<boolean>} true, wenn die Kennung zu einem Stapelblatt gehört
 */
export async function blattLeer(kennung) {
  if (!istStapelId(kennung)) return false;
  const { rows } = await pool.query(
    `SELECT b.stapel_id, b.zustand, s.status FROM postbuch._stapel_blatt b
       JOIN postbuch._stapel s ON s.id = b.stapel_id WHERE b.kennung = $1`, [kennung]);
  if (!rows.length) return false;
  const { rowCount } = await pool.query(
    `UPDATE postbuch._stapel_blatt b SET zustand = 'leer'
      WHERE b.kennung = $1 AND b.zustand = 'angemeldet'
        AND EXISTS (SELECT 1 FROM postbuch._stapel s WHERE s.id = b.stapel_id AND s.status = ANY($2))`,
    [kennung, OFFEN]);
  if (rowCount) {
    await pool.query(
      `UPDATE postbuch._stapel SET letztes_blatt_am = now(), geaendert_am = now() WHERE id = $1`,
      [rows[0].stapel_id]);
    await pruefeVollstaendig(rows[0].stapel_id);
  }
  return true;
}

async function pruefeVollstaendig(id) {
  const { rowCount } = await pool.query(
    `UPDATE postbuch._stapel s SET status = 'vorschlag', geaendert_am = now()
      WHERE s.id = $1 AND s.status = 'liest_ein' AND s.blaetter_n IS NOT NULL
        AND (SELECT count(*) FROM postbuch._stapel_blatt b
              WHERE b.stapel_id = s.id AND b.zustand IN ('da', 'leer')) >= s.blaetter_n`, [id]);
  if (rowCount) starteVorschlag(id);
}

// ── Lesen ────────────────────────────────────────────────────────────────────

async function ladeStapel(id) {
  if (!istStapelId(id)) return null;
  const [s, b] = await Promise.all([
    pool.query('SELECT * FROM postbuch._stapel WHERE id = $1', [id]),
    pool.query('SELECT seq, zustand, seiten FROM postbuch._stapel_blatt WHERE stapel_id = $1 ORDER BY seq', [id]),
  ]);
  if (!s.rows.length) return null;
  return { ...s.rows[0], blaetter: b.rows };
}

/** Blätter samt Platzhaltern für nicht angekommene Nummern. */
function blattliste(stapel) {
  const nachSeq = new Map(stapel.blaetter.map((b) => [b.seq, b]));
  const n = Math.max(stapel.blaetter_n || 0, ...stapel.blaetter.map((b) => b.seq), 0);
  const liste = [];
  for (let seq = 1; seq <= n; seq++) {
    const b = nachSeq.get(seq);
    liste.push({
      seq,
      zustand: !b || b.zustand === 'angemeldet' ? 'fehlt' : b.zustand,
      seiten: b?.zustand === 'da' ? b.seiten : 0,
    });
  }
  return liste;
}

function zusammenfassung(stapel) {
  const { dokumente, grenzen } = aufteilung({ blaetter: stapel.blaetter, vorschlag: stapel.vorschlag });
  const seiten = blaetterMitInhalt(stapel.blaetter).reduce((n, b) => n + Math.min(2, b.seiten), 0);
  const unklar = grenzen.filter((g) => g.quelle !== 'ki' || g.sicherheit !== 'sicher').length;
  const da = stapel.blaetter.filter((b) => b.zustand === 'da').length;
  const leer = stapel.blaetter.filter((b) => b.zustand === 'leer').length;
  return {
    blaetter: da,
    leer,
    blaetterN: stapel.blaetter_n,
    fehlend: stapel.blaetter_n ? Math.max(0, stapel.blaetter_n - da - leer) : 0,
    seiten,
    dokumente: dokumente.length,
    unklar,
    vorschlag: !!stapel.vorschlag,
    automatischAb: stapel.automatisch_ab,
  };
}

/**
 * Die Trennansicht: Blätter, Vorschlag, gespeicherte Entscheidung und die
 * Aufteilung nach dem Vorschlag.
 */
export async function detail(id) {
  const s = await ladeStapel(id);
  if (!s) return null;
  return {
    id: s.id,
    status: s.status,
    duplex: s.duplex,
    quelle: s.quelle,
    hinweis: s.hinweis,
    blaetterN: s.blaetter_n,
    blaetter: blattliste(s),
    vorschlag: s.vorschlag,
    entscheidung: s.entscheidung,
    automatischAb: s.automatisch_ab,
    countdownS: COUNTDOWN_S,
    letzterFehler: s.letzter_fehler,
    erstelltAm: s.erstellt_am,
    geaendertAm: s.geaendert_am,
    jetzt: new Date().toISOString(),
    aufteilung: aufteilung({ blaetter: s.blaetter, vorschlag: s.vorschlag }),
    zusammenfassung: zusammenfassung(s),
  };
}

const SCHRITT = {
  liest_ein: 'Blätter werden eingelesen',
  vorschlag: 'Trennung wird vorgeschlagen',
  teilt_auf: 'Dokumente werden übergeben',
};

/** Einträge für die Eingangsgalerie (service/offene-eingaenge.js). */
export async function eingangsEintraege() {
  const [s, b] = await Promise.all([
    pool.query(`SELECT * FROM postbuch._stapel WHERE status <> 'erledigt'`),
    pool.query(
      `SELECT b.stapel_id, b.seq, b.zustand, b.seiten FROM postbuch._stapel_blatt b
         JOIN postbuch._stapel s ON s.id = b.stapel_id WHERE s.status <> 'erledigt' ORDER BY b.seq`),
  ]);
  return s.rows.map((zeile) => {
    const stapel = { ...zeile, blaetter: b.rows.filter((x) => x.stapel_id === zeile.id) };
    const z = zusammenfassung(stapel);
    const wartet = zeile.status === 'wartet';
    let schritt = SCHRITT[zeile.status] || null;
    if (zeile.status === 'liest_ein') {
      schritt = z.blaetterN
        ? `${z.blaetter + z.leer} von ${z.blaetterN} Blättern eingelesen`
        : 'Scanner liest die Blätter ein';
    }
    const erstes = blaetterMitInhalt(stapel.blaetter)[0] || null;
    return {
      schluessel: `t:${zeile.id}`,
      gruppe: wartet ? 'briefstapel' : 'verarbeitung',
      zustand: `stapel_${zeile.status}`,
      name: 'Dokumentenstapel',
      herkunft: zeile.quelle === 'upload' ? 'upload' : 'scanner',
      eingangAm: zeile.erstellt_am,
      schritt: wartet ? null : schritt,
      grund: wartet && z.fehlend ? `${z.fehlend} ${z.fehlend === 1 ? 'Blatt fehlt' : 'Blätter fehlen'}` : null,
      letzterFehler: zeile.letzter_fehler || null,
      letzterFehlerAm: null,
      versuche: null,
      maxVersuche: null,
      naechsterVersuch: null,
      jobId: zeile.id,
      manuell: false,
      aktionen: [],
      stapel: z,
      _quelle: { art: 't', id: zeile.id, ersteSeq: erstes?.seq || null },
    };
  });
}

/** Verbleib eines Stapels, der nicht mehr im Eingang steht. */
export async function verbleib(id) {
  if (!istStapelId(id)) return { postid: null };
  const { rows } = await pool.query(
    `SELECT s.status, array_remove(array_agg(t.job_id::text ORDER BY t.nr), NULL) AS teile
       FROM postbuch._stapel s LEFT JOIN postbuch._stapel_teil t ON t.stapel_id = s.id
      WHERE s.id = $1 GROUP BY s.status`, [id]);
  const teile = rows[0]?.teile || [];
  if (!teile.length) return { postid: null };
  return { postid: null, teile, ...(teile.length === 1 ? { weiter: `a:${teile[0]}` } : {}) };
}

/** PDF eines Blatts, auf eine Seite reduziert, wenn verlangt. */
async function ladeSeite(id, seq, seite, seiten) {
  const buf = await fs.readFile(blattPfad(id, seq));
  return seiten > 1 ? selectPages(buf, seite, seite) : buf;
}

/** Vorschaubild für die Kachel: erste Seite des ersten Blatts mit Inhalt. */
export async function kachelBild(quelle) {
  if (!quelle?.ersteSeq) throw Object.assign(new Error('Noch keine Seite da.'), { status: 404 });
  return holeVorschau(`t:${quelle.id}:${quelle.ersteSeq}:1`,
    () => fs.readFile(blattPfad(quelle.id, quelle.ersteSeq)), { langeKante: 320 });
}

/**
 * Seitenbild der Trennansicht.
 * @param {boolean} gross  Großansicht (1200 px) statt Raster (320 px)
 */
export async function seitenbild(id, seq, seite, gross) {
  if (!istStapelId(id) || !Number.isInteger(seq) || seq < 1 || seq > MAX_BLAETTER
    || (seite !== 1 && seite !== 2)) {
    throw Object.assign(new Error('Ungültige Seite.'), { status: 400 });
  }
  const { rows } = await pool.query(
    `SELECT b.seiten FROM postbuch._stapel_blatt b JOIN postbuch._stapel s ON s.id = b.stapel_id
      WHERE b.stapel_id = $1 AND b.seq = $2 AND b.zustand = 'da' AND s.status <> 'erledigt'`, [id, seq]);
  const seiten = rows[0]?.seiten;
  if (!seiten || seite > seiten) throw Object.assign(new Error('Seite nicht vorhanden.'), { status: 404 });
  return holeVorschau(`t:${id}:${seq}:${seite}`, () => ladeSeite(id, seq, seite, seiten),
    { langeKante: gross ? 1200 : 480 });
}

// ── Vorschlag der KI ─────────────────────────────────────────────────────────

function kuerze(text, max) {
  const t = String(text || '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (t.length <= max) return t;
  const kopf = Math.round(max * 0.7);
  return `${t.slice(0, kopf)}\n[…]\n${t.slice(t.length - (max - kopf))}`;
}

async function seitentexte(id, inhalt) {
  const roh = [];
  let nr = 0;
  for (const b of inhalt) {
    const buf = await fs.readFile(blattPfad(id, b.seq));
    const seiten = [];
    for (let s = 1; s <= Math.min(2, b.seiten); s++) {
      nr++;
      const text = await extractTextLayer(buf, { abSeite: s, bisSeite: s }).catch(() => '');
      seiten.push({ nr, text: text || '' });
    }
    roh.push({ seq: b.seq, seiten });
  }
  const anzahl = Math.max(1, nr);
  const jeSeite = Math.max(200, Math.min(TEXT_JE_SEITE, Math.floor(TEXT_GESAMT / anzahl)));
  for (const b of roh) for (const s of b.seiten) s.text = kuerze(s.text, jeSeite);
  return roh;
}

/**
 * Ein KI-Aufruf je Stapel, bei ungültiger Antwort ein zweiter.
 * @returns {Promise<{ vorschlag: object|null, fehler: string|null }>}
 */
async function frageKi(id, stapel, inhalt, settings) {
  const texte = await seitentexte(id, inhalt);
  if (!texte.some((b) => b.seiten.some((s) => s.text))) {
    return { vorschlag: null, fehler: 'Auf den Seiten ist kein lesbarer Text; ohne Text gibt es keinen Vorschlag.' };
  }
  const ref = llm.resolveKlassenModell('komplex', settings);
  if (!ref?.model) return { vorschlag: null, fehler: 'Kein KI-Modell eingerichtet.' };
  const prompt = stapelTrennungPrompt({ blaetter: texte, hinweis: stapel.hinweis });
  let letzterFehler = null;
  for (let versuch = 1; versuch <= 2; versuch++) {
    try {
      const r = await llm.callLLM(ref,
        versuch === 1 ? prompt : `${prompt}\n\nDeine vorige Antwort war unbrauchbar (${letzterFehler}). Antworte nur mit dem verlangten JSON.`,
        { jsonMode: true, jsonSchema: STAPEL_TRENNUNG_SCHEMA },
        settings, { kategorie: 'stapel', correlationId: id });
      if (r.abgeschnitten) throw new Error('Antwort am Ausgabelimit abgeschnitten');
      const v = pruefeVorschlag(llm.parseJsonFromText(r.text), stapel.blaetter);
      return { vorschlag: { ...v, modell: ref.model, am: new Date().toISOString() }, fehler: null };
    } catch (err) {
      letzterFehler = String(err.message || err).slice(0, 200);
      appLog('WARN', 'stapel', `Trennvorschlag, Versuch ${versuch}: ${letzterFehler}`, { entity: 'stapel', entityId: id });
    }
  }
  return { vorschlag: null, fehler: `Die KI hat keinen brauchbaren Vorschlag geliefert: ${letzterFehler}` };
}

function starteVorschlag(id, opts) {
  if (inArbeit.has(id)) return;
  inArbeit.add(id);
  erstelleVorschlag(id, opts)
    .catch(async (err) => {
      console.error(`[stapel] Vorschlag für ${id} gescheitert:`, err);
      appLog('ERROR', 'stapel', `Trennvorschlag gescheitert: ${err.message}`, { entity: 'stapel', entityId: id });
      // Ohne Vorschlag in den Eingang: Die Blätter sind da, der Mensch entscheidet.
      await pool.query(
        `UPDATE postbuch._stapel SET status = 'wartet', vorschlag = NULL, automatisch_ab = NULL,
                letzter_fehler = $2, geaendert_am = now()
          WHERE id = $1 AND status = 'vorschlag'`,
        [id, `Kein Trennvorschlag: ${String(err.message).slice(0, 300)}`]).catch(() => {});
      tracker.complete(id, { stapel: id, status: 'wartet' });
    })
    .finally(() => inArbeit.delete(id));
}

async function erstelleVorschlag(id, { automatik = true } = {}) {
  const stapel = await ladeStapel(id);
  if (!stapel || stapel.status !== 'vorschlag') return;
  jobLaeuft(id, 1, 'Trennung wird vorgeschlagen', stapel.quelle);
  const inhalt = blaetterMitInhalt(stapel.blaetter);
  if (!inhalt.length) {
    await pool.query(`DELETE FROM postbuch._stapel WHERE id = $1 AND status = 'vorschlag'`, [id]);
    await loescheVerzeichnis(id);
    tracker.fail(id, 'Alle Blätter des Dokumentenstapels waren leer.');
    appLog('INFO', 'stapel', 'Dokumentenstapel ohne Inhalt verworfen (alle Blätter leer)', { entity: 'stapel', entityId: id });
    return;
  }

  const settings = await loadDynamicSettings();
  let vorschlag = null;
  let fehler = null;
  if (inhalt.length === 1) {
    // Ein Blatt ist ein Dokument; es gibt nichts zu trennen.
    vorschlag = { grenzen: {}, rollen: {}, arten: [], eindeutig: true, vollstaendig: true, am: new Date().toISOString() };
  } else {
    ({ vorschlag, fehler } = await frageKi(id, stapel, inhalt, settings));
  }

  // Mit dem aktuellen Stand prüfen: Inzwischen angekommene Blätter zählen mit.
  const aktuell = await ladeStapel(id);
  if (!aktuell || aktuell.status !== 'vorschlag') return;
  const auto = automatik
    ? automatischMoeglich({
      eingeschaltet: ohneRueckfrage(settings), vorschlag, blaetter: aktuell.blaetter, blaetterN: aktuell.blaetter_n,
    })
    : { ja: false };
  const { rowCount } = await pool.query(
    `UPDATE postbuch._stapel
        SET status = 'wartet', vorschlag = $2::jsonb, letzter_fehler = $3, geaendert_am = now(),
            automatisch_ab = CASE WHEN $4 THEN now() + make_interval(secs => $5) ELSE NULL END
      WHERE id = $1 AND status = 'vorschlag'`,
    [id, vorschlag ? JSON.stringify(vorschlag) : null, fehler, auto.ja, COUNTDOWN_S]);
  if (!rowCount) return;
  const anzahl = aufteilung({ blaetter: aktuell.blaetter, vorschlag }).dokumente.length;
  tracker.complete(id, { stapel: id, status: 'wartet', dokumente: anzahl, automatisch: auto.ja });
  appLog('INFO', 'stapel',
    `Trennvorschlag: ${anzahl} Dokument(e)${auto.ja ? `, Übernahme ohne Rückfrage in ${COUNTDOWN_S} s` : `, wartet auf Prüfung${auto.grund ? ` (${auto.grund})` : ''}`}`,
    { entity: 'stapel', entityId: id });
}

// ── Aktionen aus dem Eingang ─────────────────────────────────────────────────

/** Countdown anhalten (Öffnen der Trennansicht oder jede Interaktion). */
export async function anhalten(id) {
  if (!istStapelId(id)) return false;
  const { rowCount } = await pool.query(
    `UPDATE postbuch._stapel SET automatisch_ab = NULL, geaendert_am = now()
      WHERE id = $1 AND status = 'wartet' AND automatisch_ab IS NOT NULL`, [id]);
  return rowCount > 0;
}

/**
 * Übernimmt die Trennung und teilt den Stapel auf.
 * @param {object|null} body  { trennungen, entfernt } aus der Trennansicht
 * @returns {Promise<{ dokumente: number }>}
 */
export async function uebernehmen(id, body, benutzer) {
  const stapel = await ladeStapel(id);
  if (!stapel) throw new KonfliktError('Diesen Dokumentenstapel gibt es nicht mehr.');
  const geprueft = pruefeEntscheidung(body || {}, stapel.blaetter);
  if (geprueft.fehler) throw Object.assign(new Error(geprueft.fehler), { status: 400 });
  const entscheidung = { ...geprueft.wert, von: benutzer || null, am: new Date().toISOString(), automatisch: false };
  const { rowCount } = await pool.query(
    `UPDATE postbuch._stapel SET status = 'teilt_auf', entscheidung = $2::jsonb, automatisch_ab = NULL,
            letzter_fehler = NULL, geaendert_am = now()
      WHERE id = $1 AND status = 'wartet'`, [id, JSON.stringify(entscheidung)]);
  if (!rowCount) throw new KonfliktError('Dieser Dokumentenstapel wurde inzwischen verändert. Bitte neu laden.');
  appLog('INFO', 'stapel', `Trennung übernommen von ${benutzer || 'unbekannt'}`, { entity: 'stapel', entityId: id });
  const anzahl = aufteilung({ blaetter: stapel.blaetter, vorschlag: stapel.vorschlag, entscheidung }).dokumente.length;
  starteAufteilen(id);
  return { dokumente: anzahl };
}

async function uebernimmAutomatisch(id) {
  const settings = await loadDynamicSettings();
  const stapel = await ladeStapel(id);
  if (!stapel || stapel.status !== 'wartet') return;
  // Unmittelbar vor der Übernahme noch einmal alle Bedingungen prüfen.
  const auto = automatischMoeglich({
    eingeschaltet: ohneRueckfrage(settings), vorschlag: stapel.vorschlag,
    blaetter: stapel.blaetter, blaetterN: stapel.blaetter_n,
  });
  if (!auto.ja) {
    await pool.query(`UPDATE postbuch._stapel SET automatisch_ab = NULL WHERE id = $1 AND status = 'wartet'`, [id]);
    return;
  }
  // Bei der Übernahme ohne Rückfrage wird keine Seite entfernt.
  const entscheidung = { trennungen: {}, entfernt: [], von: null, am: new Date().toISOString(), automatisch: true };
  const { rowCount } = await pool.query(
    `UPDATE postbuch._stapel SET status = 'teilt_auf', entscheidung = $2::jsonb, automatisch_ab = NULL,
            geaendert_am = now()
      WHERE id = $1 AND status = 'wartet' AND automatisch_ab IS NOT NULL AND automatisch_ab <= now()`,
    [id, JSON.stringify(entscheidung)]);
  if (!rowCount) return;
  appLog('INFO', 'stapel', 'Eindeutiger Dokumentenstapel ohne Rückfrage übernommen', { entity: 'stapel', entityId: id });
  starteAufteilen(id);
}

/** Verwirft den Vorschlag und fragt die KI neu (ohne anschließende Automatik). */
export async function neuVorschlagen(id) {
  if (!istStapelId(id)) throw new KonfliktError('Diesen Dokumentenstapel gibt es nicht mehr.');
  const { rowCount } = await pool.query(
    `UPDATE postbuch._stapel SET status = 'vorschlag', vorschlag = NULL, automatisch_ab = NULL,
            letzter_fehler = NULL, geaendert_am = now()
      WHERE id = $1 AND status = 'wartet'`, [id]);
  if (!rowCount) throw new KonfliktError('Dieser Dokumentenstapel wurde inzwischen verändert. Bitte neu laden.');
  starteVorschlag(id, { automatik: false });
}

/** Löscht einen wartenden Stapel samt Blättern. */
export async function verwerfen(id, benutzer) {
  if (!istStapelId(id)) throw new KonfliktError('Diesen Dokumentenstapel gibt es nicht mehr.');
  const { rowCount } = await pool.query(
    `DELETE FROM postbuch._stapel WHERE id = $1 AND status = 'wartet'`, [id]);
  if (!rowCount) throw new KonfliktError('Dieser Dokumentenstapel wurde inzwischen verändert. Bitte neu laden.');
  await loescheVerzeichnis(id);
  appLog('INFO', 'stapel', `Dokumentenstapel verworfen von ${benutzer || 'unbekannt'}`, { entity: 'stapel', entityId: id });
}

// ── Aufteilen ────────────────────────────────────────────────────────────────

function starteAufteilen(id) {
  if (inArbeit.has(id)) return;
  inArbeit.add(id);
  teileAuf(id)
    .then(() => fehlerAm.delete(id))
    .catch(async (err) => {
      fehlerAm.set(id, Date.now());
      console.error(`[stapel] Aufteilen von ${id} unterbrochen:`, err);
      appLog('ERROR', 'stapel', `Aufteilen unterbrochen, nächster Versuch in 5 Minuten: ${err.message}`, { entity: 'stapel', entityId: id });
      await pool.query(
        `UPDATE postbuch._stapel SET letzter_fehler = $2, geaendert_am = now() WHERE id = $1`,
        [id, `Aufteilen unterbrochen: ${String(err.message).slice(0, 300)}`]).catch(() => {});
    })
    .finally(() => inArbeit.delete(id));
}

/** Ist ein Teil aus einem früheren Lauf schon sicher übergeben? */
async function teilSchonUebergeben(jobId) {
  const { rows } = await pool.query(
    `SELECT EXISTS (SELECT 1 FROM postbuch._pipeline_auftrag WHERE job_id = $1)
         OR EXISTS (SELECT 1 FROM postbuch._jobs WHERE id = $1
                     AND status IN ('done', 'failed', 'awaiting_decision', 'cancelled')) AS da`, [jobId]);
  return rows[0].da;
}

async function baueDokument(id, seiten, blattSeiten) {
  const teile = [];
  for (let i = 0; i < seiten.length;) {
    const seq = seiten[i].seq;
    const vomBlatt = [];
    while (i < seiten.length && seiten[i].seq === seq) vomBlatt.push(seiten[i++]);
    const buf = await fs.readFile(blattPfad(id, seq));
    if (vomBlatt.length >= blattSeiten.get(seq) && vomBlatt.every((s) => !s.drehung)) {
      teile.push(buf);
      continue;
    }
    // Einzelne Seiten des Blatts, jede mit ihrer eigenen Drehung aus der Trennansicht.
    for (const s of vomBlatt) {
      const seite = await selectPages(buf, s.seite, s.seite);
      teile.push(s.drehung ? await rotatePdf(seite, s.drehung) : seite);
    }
  }
  return teile.length === 1 ? teile[0] : mergePdfs(teile);
}

async function teileAuf(id) {
  const stapel = await ladeStapel(id);
  if (!stapel || stapel.status !== 'teilt_auf') return;
  jobLaeuft(id, 2, 'Dokumente werden übergeben', stapel.quelle);
  const { dokumente } = aufteilung({
    blaetter: stapel.blaetter, vorschlag: stapel.vorschlag, entscheidung: stapel.entscheidung,
  });
  const blattSeiten = new Map(stapel.blaetter.map((b) => [b.seq, Math.min(2, b.seiten || 0)]));
  const vorhanden = new Map((await pool.query(
    'SELECT nr, job_id, eingereiht FROM postbuch._stapel_teil WHERE stapel_id = $1', [id])).rows
    .map((t) => [t.nr, t]));
  const kurz = id.slice(0, 8);
  const k = dokumente.length;
  const jobIds = [];

  for (let i = 0; i < k; i++) {
    const nr = i + 1;
    const alt = vorhanden.get(nr);
    if (alt && (alt.eingereiht || await teilSchonUebergeben(alt.job_id))) {
      if (!alt.eingereiht) {
        await pool.query('UPDATE postbuch._stapel_teil SET eingereiht = true WHERE stapel_id = $1 AND nr = $2', [id, nr]);
      }
      jobIds.push(alt.job_id);
      continue;
    }
    const label = `Dokumentenstapel, Dokument ${nr} von ${k}`;
    tracker.setStep(id, 2, `Dokument ${nr} von ${k} wird übergeben`);
    const pdfBuffer = await baueDokument(id, dokumente[i].seiten, blattSeiten);
    const jobId = tracker.create('doc-process', label, 10);
    await pool.query(
      `INSERT INTO postbuch._stapel_teil (stapel_id, nr, job_id) VALUES ($1, $2, $3)
       ON CONFLICT (stapel_id, nr) DO UPDATE SET job_id = EXCLUDED.job_id, eingereiht = false`,
      [id, nr, jobId]);
    try {
      await reiheDauerhaftEin({
        pdfBuffer,
        filename: `briefstapel_${kurz}_dokument_${nr}.pdf`,
        // Aus dem Einzug: Tesseract-Textebene wie bei jedem Scan entfernen.
        // Aus einer PDF: wie beim Einzelupload unverändert lassen.
        ...(stapel.quelle === 'upload' ? {} : { fromScanner: true }),
        ...(stapel.hinweis ? { userHinweis: stapel.hinweis } : {}),
      }, jobId, 0, {
        batchSize: k,
        streng: true,
        label,
        herkunft: stapel.quelle === 'upload' ? 'upload' : 'scanner',
        onError: (err) => appLog('ERROR', 'stapel', `${label}: ${err.message}`, { entity: 'stapel', entityId: id }),
      });
    } catch (err) {
      tracker.fail(jobId, `Übergabe gescheitert: ${err.message}`);
      throw err;
    }
    await pool.query('UPDATE postbuch._stapel_teil SET eingereiht = true WHERE stapel_id = $1 AND nr = $2', [id, nr]);
    jobIds.push(jobId);
  }

  const { rowCount } = await pool.query(
    `UPDATE postbuch._stapel SET status = 'erledigt', letzter_fehler = NULL, geaendert_am = now()
      WHERE id = $1 AND status = 'teilt_auf'`, [id]);
  if (rowCount) {
    await loescheVerzeichnis(id);
    tracker.complete(id, { stapel: id, status: 'erledigt', teile: jobIds });
    appLog('INFO', 'stapel', `Dokumentenstapel aufgeteilt: ${k} Dokument(e) übergeben`, { entity: 'stapel', entityId: id });
  }
}

// ── Takt und Wiederaufnahme ──────────────────────────────────────────────────

async function takt() {
  if (taktLaeuft) return;
  taktLaeuft = true;
  try {
    // Ruhezeit: Fehlen Blätter, geht der Stapel nach 15 Minuten ohne neues
    // Blatt mit Lücke weiter. Ohne ein einziges angekommenes Blatt wird er
    // nach zwei Stunden gelöscht.
    const ruhig = await pool.query(
      `SELECT s.id,
              (SELECT count(*) FROM postbuch._stapel_blatt b
                WHERE b.stapel_id = s.id AND b.zustand IN ('da', 'leer'))::int AS angekommen,
              COALESCE(s.letztes_blatt_am, s.erstellt_am) < now() - make_interval(mins => $2) AS verwaist
         FROM postbuch._stapel s
        WHERE s.status = 'liest_ein'
          AND COALESCE(s.letztes_blatt_am, s.erstellt_am) < now() - make_interval(mins => $1)`,
      [RUHEZEIT_MIN, OHNE_BLATT_MAX_MIN]);
    for (const r of ruhig.rows) {
      if (r.angekommen > 0) {
        const { rowCount } = await pool.query(
          `UPDATE postbuch._stapel SET status = 'vorschlag', geaendert_am = now()
            WHERE id = $1 AND status = 'liest_ein'`, [r.id]);
        if (rowCount) {
          appLog('WARN', 'stapel', `Dokumentenstapel unvollständig, nach ${RUHEZEIT_MIN} Minuten Ruhe weiter`, { entity: 'stapel', entityId: r.id });
          starteVorschlag(r.id);
        }
      } else if (r.verwaist) {
        const { rowCount } = await pool.query(
          `DELETE FROM postbuch._stapel WHERE id = $1 AND status = 'liest_ein'`, [r.id]);
        if (rowCount) {
          await loescheVerzeichnis(r.id);
          tracker.fail(r.id, 'Vom Dokumentenstapel ist kein Blatt angekommen.');
          appLog('WARN', 'stapel', 'Dokumentenstapel ohne angekommenes Blatt nach zwei Stunden gelöscht', { entity: 'stapel', entityId: r.id });
        }
      }
    }

    const offen = await pool.query(
      `SELECT id, status, (automatisch_ab IS NOT NULL AND automatisch_ab <= now()) AS faellig
         FROM postbuch._stapel WHERE status IN ('vorschlag', 'teilt_auf', 'wartet')`);
    for (const r of offen.rows) {
      if (inArbeit.has(r.id)) continue;
      if (r.status === 'vorschlag') starteVorschlag(r.id);
      else if (r.status === 'teilt_auf') {
        if (Date.now() - (fehlerAm.get(r.id) || 0) >= FEHLER_PAUSE_MS) starteAufteilen(r.id);
      } else if (r.faellig) {
        await uebernimmAutomatisch(r.id).catch((err) =>
          appLog('ERROR', 'stapel', `Übernahme ohne Rückfrage gescheitert: ${err.message}`, { entity: 'stapel', entityId: r.id }));
      }
    }

    await pool.query(
      `DELETE FROM postbuch._stapel WHERE status = 'erledigt' AND geaendert_am < now() - make_interval(days => $1)`,
      [ERLEDIGT_TAGE]);
  } catch (err) {
    console.error('[stapel] Takt fehlgeschlagen:', err.message);
  } finally {
    taktLaeuft = false;
  }
}

/**
 * Beim Start: Verzeichnisse ohne Zeile löschen, fehlende Blattdateien
 * zurück auf „angemeldet“ setzen, Jobs der aktiven Stapel zurückholen und
 * den Takt starten. Vorschlag und Aufteilen setzt der erste Takt fort.
 */
export async function starteStapelDienst() {
  try {
    const { rows } = await pool.query(`SELECT id, status, quelle FROM postbuch._stapel`);
    const bekannt = new Map(rows.map((r) => [r.id, r.status]));
    const quelleVon = new Map(rows.map((r) => [r.id, r.quelle]));
    let namen = [];
    try { namen = await fs.readdir(STAPEL_DIR); } catch { /* noch nie benutzt */ }
    for (const name of namen) {
      const st = bekannt.get(name);
      if (!st || st === 'erledigt') await loescheVerzeichnis(name);
    }
    const blaetter = await pool.query(
      `SELECT b.stapel_id, b.seq FROM postbuch._stapel_blatt b
         JOIN postbuch._stapel s ON s.id = b.stapel_id
        WHERE b.zustand = 'da' AND s.status IN ('liest_ein', 'vorschlag', 'wartet', 'teilt_auf')`);
    for (const b of blaetter.rows) {
      const da = await fs.access(blattPfad(b.stapel_id, b.seq)).then(() => true, () => false);
      if (da) continue;
      await pool.query(
        `UPDATE postbuch._stapel_blatt SET zustand = 'angemeldet', seiten = NULL WHERE stapel_id = $1 AND seq = $2`,
        [b.stapel_id, b.seq]);
      await pool.query(
        `UPDATE postbuch._stapel SET letzter_fehler = $2, automatisch_ab = NULL WHERE id = $1`,
        [b.stapel_id, `Die Datei von Blatt ${b.seq} fehlt nach einem Neustart.`]);
      appLog('ERROR', 'stapel', `Blattdatei ${b.seq} fehlt nach Neustart`, { entity: 'stapel', entityId: b.stapel_id });
    }
    for (const [id, status] of bekannt) {
      const schritt = { liest_ein: 0, vorschlag: 1, teilt_auf: 2 }[status];
      if (schritt != null) jobLaeuft(id, schritt, SCHRITT[status], quelleVon.get(id));
    }
  } catch (err) {
    console.error('[stapel] Start fehlgeschlagen:', err.message);
  }
  if (!taktTimer) {
    taktTimer = setInterval(() => { takt(); }, TAKT_MS);
    taktTimer.unref?.();
    takt();
  }
}
