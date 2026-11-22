/**
 * service/offene-eingaenge.js – Lesemodell und Aktionen der Eingangsgalerie
 *
 * „Offene Eingänge“ sind angenommene PDFs, die noch nicht als Dokument in
 * postbuch.net stehen. Es gibt dafür keine eigene Tabelle: Die Liste entsteht
 * bei jedem Abruf aus den vorhandenen Quellen.
 *
 *   a:<job_id>      Auftrag der Pipeline (läuft, eingereiht oder zurückgestellt),
 *                   auch ein Scan vor seinem Auftrag (beim Scanner oder in der OCR)
 *   d:<job_id>      offene Duplikatentscheidung (_pipeline_suspensions)
 *   f:<storage_id>  Fehleintrag (_failed_documents)
 *   s:<job_id>      Scan, dessen Upload in die Ablage aussteht (_scan_retry_queue)
 *   t:<stapel_id>   Dokumentenstapel (_stapel, service/stapel.js); wartend in der
 *                   eigenen Gruppe „briefstapel“, sonst „verarbeitung“
 *
 * Eine Datei ergibt eine Kachel. Vorrang: Auftrag → Duplikatentscheidung →
 * Fehleintrag → Scan-Retry; die überlagerte Quelle bleibt als „letzter Fehler“
 * lesbar. Der Schlüssel ist keine Berechtigung – jede Ausgabe und jede Aktion
 * schlägt die Quelle neu nach.
 *
 * Konkurrenz lösen bedingte Übernahmen je Quelle (siehe Aktionen unten), keine
 * dauerhaften Sperren: Wer die Quelle nicht bekommt, erhält `KonfliktError`.
 */

import pool from '../db.js';
import * as tracker from '../jobs/tracker.js';
import * as queue from '../jobs/pipeline-queue.js';
import * as auftraege from '../jobs/pipeline-auftrag.js';
import { uebernimmVersuch, starteVersuch, vermerkeFehlversuch } from '../jobs/scan-retry-job.js';
import { readScanBuffer, scanBufferVorhanden } from '../lib/scan-buffer.js';
import { getAdapter } from '../lib/storage/index.js';
import { loadDynamicSettings, getActiveBackendName } from '../config.js';
import { claimInFlight, releaseInFlight, verwirfZurueckgestellt } from './document-processor.js';
import { appLog } from '../app-log.js';
import { uiLog } from '../log.js';
import { eingangsEintraege as stapelEintraege, verbleib as stapelVerbleib } from './stapel.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCHLUESSEL_MAX = 300;

const AKTIONEN_RUHEND = Object.freeze(['neu_ausloesen', 'manuell_ablegen', 'verwerfen']);

/** Die Quelle wurde inzwischen von jemand anderem übernommen oder ist erledigt. */
export class KonfliktError extends Error {
  constructor(message = 'Dieser Eingang wurde inzwischen verändert. Die Liste wird neu geladen.') {
    super(message);
    this.name = 'KonfliktError';
    this.status = 409;
  }
}

function kurz(text, max = 500) {
  if (!text) return null;
  // Fehlerseiten von Gegenstellen kommen als HTML in die Meldung; angezeigt
  // wird nur der Text davor.
  const s = String(text).replace(/\s*<(!doctype|html|head|body)\b[\s\S]*$/i, '').replace(/[:\s]+$/, '');
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// Fehlerarten, aus den Präfixen und Meldungen von classifyApiError() und den
// Ablage-Adaptern. Reihenfolge in empfehlungFuer() ist wichtig.
const KI_GESPERRT_RE = /API-Guthaben|API-Key ungültig|API-Zugriff verweigert/i;
const VORUEBERGEHEND_RE = /Rate-Limit|API-Server nicht erreichbar|KI-Dienst nicht erreichbar|Zeitüberschreitung|timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|fetch failed|socket hang up/i;
const ABLAGE_RE = /Ablage|Nextcloud|OneDrive|WebDAV|Upload|Download|Speicherplatz|\b(423|507)\b/i;
const KI_RE = /\bKI\b|KI-|LLM|Analyse|Klassifikation|Einordnung|JSON|Modell|Ausgabe|Extraktion/i;
const PDF_RE = /PDF|beschädigt|verschlüsselt|Passwort/i;

/**
 * Empfohlene Aktion für einen ruhenden Eingang, abgeleitet aus der Fehlerart.
 * Eine kaputte Ablage heilt Neu auslösen, nicht Manuell ablegen; scheitert
 * dagegen die KI, ersetzt Manuell ablegen sie.
 *
 * @param {'f'|'s'|'a'} art   Quelle des Eintrags
 * @param {string|null} fehlertext
 * @returns {{ aktion: 'neu_ausloesen'|'manuell_ablegen'|'verwerfen', text: string }|null}
 */
export function empfehlungFuer(art, fehlertext) {
  const neu = (text) => ({ aktion: 'neu_ausloesen', text });
  const manuell = (text) => ({ aktion: 'manuell_ablegen', text });
  if (art === 's') {
    return neu('Der Scan liegt sicher im Zwischenspeicher. Ist die Ablage wieder erreichbar, genügt es, ihn neu auszulösen.');
  }
  if (art === 'a') {
    return neu('Der KI-Dienst war nicht erreichbar. Neu auslösen startet die Verarbeitung sofort; ohne KI geht es mit Manuell ablegen.');
  }
  const t = String(fehlertext || '');
  if (!t) return null;
  if (KI_GESPERRT_RE.test(t)) {
    return manuell('Die KI ist derzeit nicht nutzbar (Guthaben oder Zugang beim Anbieter). Manuell ablegen kommt ohne KI aus; nach einer Klärung beim Anbieter hilft auch Neu auslösen.');
  }
  if (VORUEBERGEHEND_RE.test(t)) {
    return neu('Der Fehler war vermutlich vorübergehend. Meist genügt es, den Eingang neu auszulösen.');
  }
  if (ABLAGE_RE.test(t)) {
    return neu('Die Ablage war nicht erreichbar. Manuell ablegen hilft hier nicht – ist die Ablage wieder da, genügt es, den Eingang neu auszulösen.');
  }
  if (KI_RE.test(t)) {
    return manuell('Die KI konnte das Dokument nicht auswerten. Ein neuer Versuch kann gelingen; verlässlich ist Manuell ablegen.');
  }
  if (PDF_RE.test(t)) {
    return { aktion: 'verwerfen', text: 'Die PDF ließ sich nicht lesen und ist vermutlich unbrauchbar. Meist ist Verwerfen richtig; zeigt die Vorschau sie doch lesbar an, geht Manuell ablegen.' };
  }
  return null;
}

function anzeigename(...kandidaten) {
  for (const k of kandidaten) {
    if (typeof k === 'string' && k.trim() && !/^orphaned_/.test(k)) return k.trim();
  }
  return 'Dokument';
}

// ── Quellen lesen ────────────────────────────────────────────────────────────

async function leseQuellen() {
  const [fehl, retry, susp, gesichert] = await Promise.all([
    pool.query(
      `SELECT f.onedrive_id, COALESCE(f.storage_id, f.onedrive_id) AS storage_id, f.storage_backend,
              f.failed_filename, f.original_filename, f.reason, f.failed_at, f.source_job_id
         FROM postbuch._failed_documents f`),
    pool.query(
      `SELECT job_id, original_filename, created_at, next_retry_at, retry_count, max_retries,
              last_error, status, (next_retry_at > now()) AS gesperrt
         FROM postbuch._scan_retry_queue`),
    pool.query(
      `SELECT job_id, storage_id, storage_backend, reserved_postid, match_postid, created_at, expires_at,
              begruendung,
              COALESCE(payload->>'_eingangsname', payload->>'filename',
                       payload->'extractedData'->'postbuch'->>'dateiname') AS name
         FROM postbuch._pipeline_suspensions`),
    pool.query(
      `SELECT job_id, erstellt_am, letzter_fehler FROM postbuch._pipeline_auftrag`),
  ]);
  return { fehl: fehl.rows, retry: retry.rows, susp: susp.rows, gesichert: gesichert.rows };
}

/**
 * Baut die Liste aller offenen Eingänge (intern, mit Quellbezug in `_quelle`).
 * Liest nur Datenbank und Prozesszustand – kein Zugriff auf die Ablage.
 */
export async function leseEingaenge() {
  const { fehl, retry, susp, gesichert } = await leseQuellen();
  const aktiveJobs = new Map(tracker.listActive().map((j) => [j.id, j]));
  const gesichertNach = new Map(gesichert.map((g) => [g.job_id, g]));
  const fehlNachDatei = new Map(fehl.map((f) => [f.storage_id, f]));
  const retryNachJob = new Map(retry.map((r) => [r.job_id, r]));
  const verbraucht = new Set(); // 'f:<id>' / 's:<id>' – von einer Kachel mit Vorrang überlagert

  const eintraege = [];

  // 1. Aufträge der Pipeline. Wiederverarbeitungen vorhandener Dokumente sind
  //    kein Eingang.
  for (const a of queue.leseAuftraege()) {
    if (a.bestehendesDokument) continue;
    const job = aktiveJobs.get(a.jobId);
    const spur = gesichertNach.get(a.jobId);
    const alterFehl = a.storageId ? fehlNachDatei.get(a.storageId) : null;
    const alterRetry = a.pufferJobId ? retryNachJob.get(a.pufferJobId) : null;
    if (alterFehl) verbraucht.add(`f:${alterFehl.onedrive_id}`);
    if (alterRetry) verbraucht.add(`s:${alterRetry.job_id}`);

    const wartet = a.zustand === 'wartet';
    eintraege.push({
      schluessel: `a:${a.jobId}`,
      gruppe: a.zustand === 'laeuft' ? 'verarbeitung' : 'wartet',
      zustand: a.zustand === 'laeuft' ? 'laeuft' : wartet ? 'zurueckgestellt' : 'eingereiht',
      name: anzeigename(alterFehl?.original_filename, alterRetry?.original_filename, a.label),
      herkunft: alterRetry ? 'scanner' : a.herkunft,
      eingangAm: alterRetry?.created_at || spur?.erstellt_am || job?.startedAt || a.eingereihtAm,
      schritt: a.zustand === 'laeuft' ? (job?.stepLabel || null) : null,
      grund: wartet ? (a.grund || 'KI-Dienst nicht erreichbar') : null,
      letzterFehler: kurz(alterFehl?.reason || alterRetry?.last_error
        || (wartet ? spur?.letzter_fehler : null)),
      letzterFehlerAm: alterFehl?.failed_at || null,
      versuche: alterRetry ? alterRetry.retry_count : (a.versuch || null),
      maxVersuche: alterRetry ? alterRetry.max_retries : (wartet ? queue.WARTEZEITEN_MS.length : null),
      naechsterVersuch: wartet ? a.faelligAb : null,
      jobId: a.jobId,
      manuell: a.manuell,
      aktionen: wartet ? AKTIONEN_RUHEND : [],
      empfehlung: wartet ? empfehlungFuer('a') : null,
      _quelle: {
        art: 'a', jobId: a.jobId, storageId: a.storageId, storageBackend: a.storageBackend,
        pufferJobId: a.pufferJobId, imSpeicher: a.imSpeicher,
      },
    });
  }

  // 1b. Scans vor dem Pipeline-Auftrag: ausgelöst und noch beim Scanner
  //     (Job `scan`, jobs/scan-vorgang.js) oder angemeldet und noch in der
  //     Texterkennung (Auftrag in Schritt 0, noch nicht eingereiht). Nur zum
  //     Ansehen – es gibt noch keine Datei, mit der man etwas tun könnte.
  const eingereiht = new Set(eintraege.map((e) => e._quelle.jobId));
  for (const job of aktiveJobs.values()) {
    const scanLaeuft = job.type === 'scan';
    const ocrLaeuft = job.type === 'doc-process' && job.totalSteps === 11 && job.step === 0;
    if ((!scanLaeuft && !ocrLaeuft) || eingereiht.has(job.id)) continue;
    eintraege.push({
      schluessel: `a:${job.id}`,
      gruppe: 'verarbeitung',
      zustand: 'scan_laeuft',
      name: anzeigename(scanLaeuft ? null : job.label, 'Scan'),
      herkunft: 'scanner',
      eingangAm: job.startedAt,
      schritt: job.stepLabel || (scanLaeuft ? 'Scanner liest die Seiten ein' : 'Texterkennung läuft'),
      grund: null,
      letzterFehler: null,
      letzterFehlerAm: null,
      versuche: null,
      maxVersuche: null,
      naechsterVersuch: null,
      jobId: job.id,
      manuell: false,
      aktionen: [],
      _quelle: { art: 'a', jobId: job.id },
    });
  }

  // 2. Offene Duplikatentscheidungen.
  for (const d of susp) {
    const alterFehl = fehlNachDatei.get(d.storage_id);
    if (alterFehl) verbraucht.add(`f:${alterFehl.onedrive_id}`);
    eintraege.push({
      schluessel: `d:${d.job_id}`,
      gruppe: 'duplikatverdacht',
      zustand: 'duplikat',
      name: anzeigename(d.name),
      herkunft: null,
      eingangAm: d.created_at,
      schritt: null,
      grund: `Mögliches Duplikat von ${d.match_postid}`,
      vergleichMit: d.match_postid,
      begruendung: d.begruendung || null,
      letzterFehler: null,
      letzterFehlerAm: null,
      versuche: null,
      maxVersuche: null,
      naechsterVersuch: null,
      entscheidungBis: d.expires_at,
      jobId: d.job_id,
      manuell: false,
      aktionen: ['entscheiden'],
      _quelle: { art: 'd', jobId: d.job_id, storageId: d.storage_id, storageBackend: d.storage_backend },
    });
  }

  // 3. Fehleinträge.
  for (const f of fehl) {
    if (verbraucht.has(`f:${f.onedrive_id}`)) continue;
    eintraege.push({
      schluessel: `f:${f.onedrive_id}`,
      gruppe: 'handlung',
      zustand: 'fehlgeschlagen',
      name: anzeigename(f.original_filename, f.failed_filename),
      herkunft: null,
      eingangAm: f.failed_at,
      schritt: null,
      grund: kurz(f.reason),
      letzterFehler: kurz(f.reason),
      letzterFehlerAm: f.failed_at,
      versuche: null,
      maxVersuche: null,
      naechsterVersuch: null,
      jobId: null,
      manuell: false,
      aktionen: AKTIONEN_RUHEND,
      empfehlung: empfehlungFuer('f', f.reason),
      _quelle: {
        art: 'f', id: f.onedrive_id, storageId: f.storage_id, storageBackend: f.storage_backend,
        merkmal: new Date(f.failed_at).getTime(),
      },
    });
  }

  // 4. Scans, deren Upload in die Ablage aussteht.
  for (const r of retry) {
    if (verbraucht.has(`s:${r.job_id}`)) continue;
    const erschoepft = r.status === 'manual_only';
    eintraege.push({
      schluessel: `s:${r.job_id}`,
      gruppe: erschoepft ? 'handlung' : 'wartet',
      zustand: erschoepft ? 'scan_retry_erschoepft' : 'scan_retry',
      name: anzeigename(r.original_filename),
      herkunft: 'scanner',
      eingangAm: r.created_at,
      schritt: null,
      grund: erschoepft
        ? 'Upload in die Ablage mehrfach fehlgeschlagen'
        : 'Upload in die Ablage fehlgeschlagen, wird automatisch wiederholt',
      letzterFehler: kurz(r.last_error),
      letzterFehlerAm: null,
      versuche: r.retry_count,
      maxVersuche: r.max_retries,
      naechsterVersuch: erschoepft ? null : r.next_retry_at,
      jobId: null,
      manuell: false,
      // Ausgeschöpft: Während der Sperrfrist läuft bereits eine Aktion. Wartend:
      // „Jetzt erneut versuchen“, solange kein Lauf mit diesem Scan unterwegs ist.
      aktionen: erschoepft
        ? (r.gesperrt ? [] : AKTIONEN_RUHEND)
        : (queue.pufferInArbeit(r.job_id) ? [] : ['neu_ausloesen']),
      empfehlung: erschoepft ? empfehlungFuer('s', r.last_error) : null,
      _quelle: { art: 's', jobId: r.job_id, pufferJobId: r.job_id },
    });
  }

  // 5. Dokumentenstapel. Aktionen laufen über die eigenen Stapelrouten.
  eintraege.push(...await stapelEintraege());

  eintraege.sort((x, y) => new Date(y.eingangAm || 0) - new Date(x.eingangAm || 0));
  return eintraege;
}

/** Eintrag ohne interne Felder, für die API-Antwort. */
export function oeffentlich(e) {
  const { _quelle, ...rest } = e;
  return rest;
}

export function zaehle(eintraege) {
  const z = { verarbeitung: 0, wartet: 0, handlung: 0, duplikatverdacht: 0, briefstapel: 0 };
  for (const e of eintraege) z[e.gruppe]++;
  return z;
}

export function istSchluessel(schluessel) {
  if (typeof schluessel !== 'string' || schluessel.length > SCHLUESSEL_MAX) return false;
  const art = schluessel[0];
  const id = schluessel.slice(2);
  if (schluessel[1] !== ':' || !id) return false;
  if (art === 'a' || art === 'd' || art === 's' || art === 't') return UUID_RE.test(id);
  return art === 'f';
}

/** Schlägt einen Eintrag live nach. @returns {Promise<object|null>} */
export async function findeEingang(schluessel) {
  if (!istSchluessel(schluessel)) return null;
  return (await leseEingaenge()).find((e) => e.schluessel === schluessel) || null;
}

/**
 * Wohin ein nicht mehr vorhandener Eingang gegangen ist – soweit bekannt:
 * abgelegt als Dokument (`postid`) oder weiter als anderer Eintrag (`weiter`),
 * etwa ein Auftrag, der in eine Duplikatentscheidung übergegangen oder
 * fehlgeschlagen ist.
 * @returns {Promise<{ postid: string|null, weiter?: string, fehler?: string|null }>}
 */
export async function verbleibVon(schluessel) {
  if (!istSchluessel(schluessel)) return { postid: null };
  const id = schluessel.slice(2);
  if (schluessel[0] === 't') return stapelVerbleib(id.toLowerCase());
  try {
    if (schluessel[0] === 'a') {
      const { rows } = await pool.query(
        'SELECT 1 FROM postbuch._pipeline_suspensions WHERE job_id = $1', [id]);
      if (rows.length) return { postid: null, weiter: `d:${id}` };
      // Fehlgeschlagen: der Eingang steht jetzt als Fehleintrag der Datei da.
      const fehl = await pool.query(
        'SELECT onedrive_id FROM postbuch._failed_documents WHERE source_job_id = $1 LIMIT 1', [id]);
      if (fehl.rows.length) return { postid: null, weiter: `f:${fehl.rows[0].onedrive_id}` };
    }
    if (schluessel[0] === 'f') {
      const { rows } = await pool.query(
        'SELECT postid FROM postbuch.postbuch WHERE storage_id = $1 LIMIT 1', [id]);
      return { postid: rows[0]?.postid || null };
    }
    const { rows } = await pool.query(
      `SELECT status, error_message, payload->>'postid' AS postid, payload->>'weiterJob' AS weiter_job
         FROM postbuch._jobs WHERE id = $1`, [id]);
    const zeile = rows[0];
    // Ein Scan-Job endet, sobald der Verarbeitungsauftrag übernimmt.
    if (zeile?.status === 'done' && zeile.weiter_job && UUID_RE.test(zeile.weiter_job)) {
      return { postid: null, weiter: `a:${zeile.weiter_job}` };
    }
    if (zeile?.status === 'failed' && !zeile.postid) {
      return { postid: null, fehler: zeile.error_message || null };
    }
    const postid = zeile?.status === 'done' ? zeile.postid || null : null;
    if (!postid) return { postid: null };
    const vorhanden = await pool.query('SELECT 1 FROM postbuch.postbuch WHERE postid = $1', [postid]);
    return { postid: vorhanden.rows.length ? postid : null };
  } catch {
    return { postid: null };
  }
}

// ── PDF und Vorschau ─────────────────────────────────────────────────────────

/**
 * Cacheschlüssel der Vorschau: die zugrunde liegende Datei, nicht die Kachel –
 * so überlebt das Bild einen Wechsel der Quelle (z. B. Fehleintrag → Lauf).
 */
export function vorschauSchluessel(e) {
  const q = e._quelle;
  if (q.art === 't') return `t:${q.id}:${q.ersteSeq}:1`;
  if (q.pufferJobId) return `p:${q.pufferJobId}`;
  if (q.storageId) return `d:${q.storageBackend || ''}:${q.storageId}:${q.merkmal || ''}`;
  return `j:${q.jobId}`;
}

/**
 * Lädt das PDF eines Eingangs: aus dem Speicher des Auftrags, aus dem lokalen
 * Puffer oder über den Adapter des Backends, in dem die Datei liegt.
 * @throws {Error} mit `status`, wenn das PDF nicht erreichbar ist
 */
export async function ladePdf(e) {
  const q = e._quelle;
  if (q.art === 't') {
    // Ein Dokumentenstapel hat kein einzelnes PDF; die Trennansicht lädt Seitenbilder.
    throw Object.assign(new Error('Ein Dokumentenstapel hat kein einzelnes PDF.'), { status: 404 });
  }
  if (q.art === 'a') {
    const imSpeicher = queue.lesePdfImSpeicher(q.jobId);
    if (imSpeicher) return imSpeicher;
  }
  if (q.pufferJobId && UUID_RE.test(q.pufferJobId) && await scanBufferVorhanden(q.pufferJobId)) {
    return readScanBuffer(q.pufferJobId);
  }
  if (q.storageId) {
    const backend = q.storageBackend || getActiveBackendName(await loadDynamicSettings());
    const adapter = getAdapter(backend);
    // Fail-closed: eine ID, die der Adapter nicht als eigene erkennt, wird nie
    // an das Backend durchgereicht.
    if (!adapter.isValidId(q.storageId)) {
      throw Object.assign(new Error('PDF nicht verfügbar.'), { status: 404 });
    }
    return adapter.download(q.storageId);
  }
  throw Object.assign(new Error('PDF nicht verfügbar.'), { status: 404 });
}

// ── Aktionen ─────────────────────────────────────────────────────────────────

function pruefeAktion(e, aktion) {
  if (!e) throw new KonfliktError();
  if (!e.aktionen.includes(aktion)) {
    throw new KonfliktError('Diese Aktion ist für den Eingang gerade nicht möglich. Die Liste wird neu geladen.');
  }
}

/**
 * Startet einen Lauf für einen Fehleintrag. Die Datei wird sofort als „in
 * Arbeit“ beansprucht; die Fehlzeile bleibt stehen, bis der Lauf sie erledigt.
 *
 * @param {object} fehlzeile  Zeile aus _failed_documents
 * @param {{ manuelleErfassung?: object|null }} [opts]
 * @returns {string} Job-ID
 * @throws {KonfliktError} wenn die Datei bereits verarbeitet wird
 */
export function starteFehleintragLauf(fehlzeile, { manuelleErfassung = null } = {}) {
  const storageId = fehlzeile.storage_id || fehlzeile.onedrive_id;
  if (!claimInFlight(storageId)) {
    throw new KonfliktError('Dieses Dokument wird bereits verarbeitet.');
  }
  const name = anzeigename(fehlzeile.original_filename, fehlzeile.failed_filename);
  let jobId;
  try {
    jobId = tracker.create('doc-process',
      manuelleErfassung ? `Manuelle Ablage: ${name}` : `Wiederverarbeitung ${name}`, 10);
    queue.enqueueDocument({
      onedriveFileId: storageId,
      storageBackend: fehlzeile.storage_backend,
      preclaimedInFlight: true,
      _eingangsname: fehlzeile.original_filename || null,
      ...(manuelleErfassung ? { manuelleErfassung } : {}),
    }, jobId, 0, {
      label: name,
      herkunft: 'ablage',
      onError: (err) => {
        console.error('[eingang] Lauf für Fehleintrag %s fehlgeschlagen:', storageId, err.message);
        appLog('ERROR', 'eingang', `Lauf für Fehleintrag fehlgeschlagen: ${err.message}`);
      },
      // Auch processDocument gibt frei; hier zählt der Abbruch vor dem Start.
      onCleanup: () => releaseInFlight(storageId),
    });
  } catch (err) {
    releaseInFlight(storageId);
    throw err;
  }
  return jobId;
}

async function ladeFehlzeile(id) {
  const { rows } = await pool.query(
    'SELECT * FROM postbuch._failed_documents WHERE onedrive_id = $1', [id]);
  if (!rows[0]) throw new KonfliktError();
  return rows[0];
}

async function starteScanLauf(jobId, manuelleErfassung, { sofortBeiVersuch = null } = {}) {
  const row = await uebernimmVersuch(jobId, { auchAusgeschoepft: true, sofortBeiVersuch });
  if (!row) throw new KonfliktError();
  try {
    return await starteVersuch(row, { manuelleErfassung });
  } catch (err) {
    await vermerkeFehlversuch(row, err);
    throw new Error(err.code === 'ENOENT'
      ? 'Die gepufferte Scan-Datei ist nicht mehr vorhanden.'
      : `Der Scan konnte nicht gelesen werden: ${err.message}`);
  }
}

/**
 * „Neu auslösen“: normaler KI-Lauf über den vorhandenen Weg der Quelle.
 * @returns {Promise<{ jobId: string }>}
 */
export async function loeseNeuAus(schluessel, benutzer) {
  const e = await findeEingang(schluessel);
  pruefeAktion(e, 'neu_ausloesen');
  const q = e._quelle;
  let jobId;
  if (q.art === 'f') {
    jobId = starteFehleintragLauf(await ladeFehlzeile(q.id));
  } else if (q.art === 's') {
    // Ein noch wartender Scan startet sofort, ohne auf seinen Termin zu warten.
    jobId = await starteScanLauf(q.jobId, null,
      { sofortBeiVersuch: e.zustand === 'scan_retry' ? e.versuche : null });
  } else {
    if (!queue.weckeJetzt(q.jobId)) throw new KonfliktError();
    jobId = q.jobId;
  }
  appLog('INFO', 'eingang', `Eingang neu ausgelöst: ${e.name} (${benutzer || 'unbekannt'})`);
  return { jobId };
}

/**
 * „Manuell ablegen“: Basisablage ohne KI als gewöhnlicher Pipeline-Lauf.
 * @param {object} wert  geprüfte Formularwerte (pruefeManuelleErfassung)
 * @returns {Promise<{ jobId: string }>}
 */
export async function legeManuellAb(schluessel, wert, benutzer) {
  const e = await findeEingang(schluessel);
  pruefeAktion(e, 'manuell_ablegen');
  const q = e._quelle;
  const manuelleErfassung = { ...wert, eingangsname: e.name };
  let jobId;
  if (q.art === 'f') {
    jobId = starteFehleintragLauf(await ladeFehlzeile(q.id), { manuelleErfassung });
  } else if (q.art === 's') {
    jobId = await starteScanLauf(q.jobId, manuelleErfassung);
  } else {
    const item = queue.entnimmWartend(q.jobId);
    if (!item) throw new KonfliktError();
    if (item.input?.onedriveFileId && item.dauerhaft) {
      // Die Datei liegt in der Ablage: Nach einem Neustart findet sie der
      // Watcher; die gesicherte Spur würde nur einen zweiten KI-Lauf anstoßen.
      await auftraege.entferne(q.jobId).catch(() => {});
      item.dauerhaft = false;
    }
    queue.reiheWiederEin(item, { manuelleErfassung });
    jobId = q.jobId;
  }
  uiLog('CREATE', 'eingang', null, `Manuell abgelegt: ${e.name} (${wert.lebensbereich}/${wert.dokumentart})`);
  appLog('INFO', 'eingang', `Eingang wird manuell abgelegt: ${e.name} (${benutzer || 'unbekannt'})`);
  return { jobId };
}

/**
 * „Verwerfen“: Das PDF geht in den Papierkorb der Ablage; erst danach
 * verschwindet die Quelle. Scheitert der Papierkorb, bleibt der Eingang
 * sichtbar und der Fehler wird gemeldet.
 */
export async function verwirf(schluessel, benutzer) {
  const e = await findeEingang(schluessel);
  pruefeAktion(e, 'verwerfen');
  const q = e._quelle;
  let ergebnis;

  if (q.art === 'f') {
    if (!claimInFlight(q.storageId)) throw new KonfliktError('Dieses Dokument wird bereits verarbeitet.');
    ergebnis = await verwirfZurueckgestellt({
      storageId: q.storageId, storageBackend: q.storageBackend, label: e.name,
      praefix: 'Verworfen', ohneFehleintrag: true,
    });
    if (ergebnis.ok) {
      await pool.query('DELETE FROM postbuch._failed_documents WHERE onedrive_id = $1', [q.id]);
    }
  } else if (q.art === 's') {
    // Die Übernahme sperrt den Eintrag gegen eine zweite Aktion; nach einem
    // Fehlschlag gibt verwirfZurueckgestellt ihn wieder frei.
    const row = await uebernimmVersuch(q.jobId, { auchAusgeschoepft: true });
    if (!row) throw new KonfliktError();
    ergebnis = await verwirfZurueckgestellt({
      pufferJobId: q.jobId, label: e.name, praefix: 'Verworfen',
    });
  } else {
    const item = queue.entnimmWartend(q.jobId);
    if (!item) throw new KonfliktError();
    const storageId = item.input?.onedriveFileId || null;
    const settings = storageId && !item.input.storageBackend ? await loadDynamicSettings() : null;
    ergebnis = await verwirfZurueckgestellt({
      jobId: q.jobId,
      storageId,
      storageBackend: storageId ? (item.input.storageBackend || getActiveBackendName(settings)) : null,
      pufferJobId: storageId ? null : item.pufferJobId,
      label: e.name,
      praefix: 'Verworfen',
    });
    // Auch nach einem Fehlschlag ist der Auftrag beendet: Der Eingang steht
    // dann als Fehl- bzw. Scan-Retry-Eintrag weiter in der Galerie.
    if (item.dauerhaft) await auftraege.entferne(q.jobId).catch(() => {});
    try { item.onCleanup?.(); } catch { /* Aufräum-Hook darf nicht stören */ }
    tracker.completeAsCancelled(q.jobId, { verworfen: ergebnis.ok });
  }

  if (!ergebnis.ok) {
    throw Object.assign(
      new Error(`Verwerfen fehlgeschlagen, der Eingang bleibt erhalten: ${ergebnis.fehler}`),
      { status: 502 });
  }
  uiLog('DELETE', 'eingang', null, `Verworfen: ${e.name}`);
  appLog('INFO', 'eingang', `Eingang verworfen: ${e.name} (${benutzer || 'unbekannt'})`);
  return { ok: true };
}
