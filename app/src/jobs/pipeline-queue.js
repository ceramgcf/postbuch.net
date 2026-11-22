/**
 * jobs/pipeline-queue.js — Concurrency-Begrenzung für die Dokumenten-Pipeline.
 *
 * Statt processDocument() direkt aufzurufen, geben Caller ihre Jobs in diese Queue.
 * Es laufen maximal _maxParallel Pipelines gleichzeitig; weitere Jobs warten in FIFO.
 *
 * Settings-Key: pipeline_max_parallel (Default 3, Range 1-10).
 *
 * Zurückstellen: Meldet ein Auftrag tracker.ZurueckgestelltError (KI-Dienst
 * nicht erreichbar), gibt er seinen Platz frei und kommt nach WARTEZEITEN_MS
 * wieder dran. Nach dem letzten Wartefenster läuft er ohne diese Möglichkeit
 * und scheitert dann regulär (→ _failed).
 *
 * Dauerhaftigkeit: reiheDauerhaftEin() sichert PDF-Buffer und Auftrag vor der
 * Zusage an den Aufrufer (jobs/pipeline-auftrag.js); stelleAuftraegeWiederHer()
 * holt sie nach einem Neustart zurück.
 */

import { processDocument, claimInFlight, verwirfZurueckgestellt, inboxHatKopie } from '../service/document-processor.js';
import * as tracker from './tracker.js';
import { neuePausen } from './pipeline-pause.js';
import * as auftraege from './pipeline-auftrag.js';
import { noteDocumentArrival } from '../lib/cache-mode.js';
import { saveScanBuffer, readScanBuffer, scanBufferVorhanden, deleteScanBuffer } from '../lib/scan-buffer.js';
import { appLog } from '../app-log.js';

const _queue = [];           // Array<QueuedItem> — FIFO
const _running = new Set();  // Set<jobId>
const _laufend = new Map();  // jobId → QueuedItem der laufenden Pipelines (nur zum Lesen)
const _wartend = new Map();  // jobId → QueuedItem (zurückgestellt, siehe wecke())
let _maxParallel = 3;

export const WARTEZEITEN_MS = [60 * 1000, 10 * 60 * 1000, 60 * 60 * 1000];

// Pause-Gate für die Storage-Migration. Während ein Migrationslauf arbeitet,
// darf keine Pipeline starten: sie würde ihre Datei ins Quell-Backend
// hochladen, während bereits umgeschaltet wurde → verwaiste Datei.
//
// Jobs werden dabei ANGENOMMEN, nicht abgelehnt. Die Queue ist der natürliche
// Puffer, tracker.markQueued zeigt „In Warteschlange" bereits im UI, und ein
// abgelehnter Scanner-Webhook bedeutet Datenverlust bzw. einen Retry-Sturm.
//
// Bewusst nur In-Memory: die Pause gilt exakt so lange, wie ein Lauf läuft.
// Stirbt der Prozess, ist auch der Lauf gestorben (der Advisory-Lock fällt mit
// der DB-Verbindung) — eine über den Neustart persistierte Pause wäre dann ein
// Zustand, den niemand mehr aufhebt.
const _pausen = neuePausen();

function clamp(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 3;
  return Math.max(1, Math.min(10, Math.trunc(v)));
}

export function setMaxParallel(n) {
  const next = clamp(n);
  const prev = _maxParallel;
  _maxParallel = next;
  if (next !== prev) {
    console.log(`[pipeline-queue] maxParallel: ${prev} → ${next}`);
  }
  if (next > prev) _drain();
}

function herkunftVon(input, pufferJobId) {
  if (input?.fromScanner) return 'scanner';
  if (input?.pdfBuffer || pufferJobId) return 'upload';
  return 'ablage';
}

function leseSicht(item, zustand) {
  const input = item.input || {};
  return {
    jobId: item.jobId,
    zustand,
    label: item.label || input.filename || input._eingangsname || null,
    storageId: input.onedriveFileId || null,
    storageBackend: input.storageBackend || null,
    pufferJobId: item.pufferJobId || input._retrySourceJobId || null,
    imSpeicher: !!input.pdfBuffer,
    herkunft: item.herkunft || herkunftVon(input, item.pufferJobId),
    eingereihtAm: item.enqueuedAt || null,
    versuch: item.versuch || 0,
    faelligAb: zustand === 'wartet' ? item.faelligAb || null : null,
    grund: zustand === 'wartet' ? item.grund || null : null,
    // Wiederverarbeitung eines vorhandenen Dokuments – kein neuer Eingang.
    bestehendesDokument: input.modifyPostID || null,
    manuell: !!input.manuelleErfassung,
  };
}

/**
 * Lesesicht aller Aufträge für die Eingangsgalerie: laufend, eingereiht und
 * zurückgestellt. Enthält keine PDF-Inhalte.
 */
export function leseAuftraege() {
  return [
    ...[..._laufend.values()].map((i) => leseSicht(i, 'laeuft')),
    ..._queue.map((i) => leseSicht(i, 'eingereiht')),
    ...[..._wartend.values()].map((i) => leseSicht(i, 'wartet')),
  ];
}

/** PDF eines Auftrags, solange es noch im Speicher liegt (sonst null). */
export function lesePdfImSpeicher(jobId) {
  const item = _laufend.get(jobId) || _wartend.get(jobId) || _queue.find((q) => q.jobId === jobId);
  return item?.input?.pdfBuffer || null;
}

/** Steht für diesen Puffer schon ein Auftrag in der Warteschlange oder läuft er? */
export function pufferInArbeit(pufferJobId) {
  const trifft = (i) => i.pufferJobId === pufferJobId || i.input?._retrySourceJobId === pufferJobId;
  return _queue.some(trifft) || [..._laufend.values()].some(trifft) || [..._wartend.values()].some(trifft);
}

/**
 * Holt einen zurückgestellten Auftrag sofort zurück in die Warteschlange.
 * @returns {boolean} false, wenn er nicht (mehr) wartet
 */
export function weckeJetzt(jobId) {
  const item = _wartend.get(jobId);
  if (!item) return false;
  _wartend.delete(jobId);
  _queue.push(item);
  tracker.markQueued(jobId);
  if (_wartend.size === 0 && _wecker) { clearInterval(_wecker); _wecker = null; }
  _drain();
  return true;
}

/**
 * Nimmt einen zurückgestellten Auftrag synchron aus der Wartemenge und gibt
 * ihn zurück, ohne ihn zu verwerfen. Der Aufrufer übernimmt damit Datei bzw.
 * Puffer samt In-Flight-Sperre und trägt den gesicherten Auftrag aus.
 * @returns {object|null} null, wenn der Wecker schneller war
 */
export function entnimmWartend(jobId) {
  const item = _wartend.get(jobId);
  if (!item) return null;
  _wartend.delete(jobId);
  if (_wartend.size === 0 && _wecker) { clearInterval(_wecker); _wecker = null; }
  return item;
}

/**
 * Reiht einen mit entnimmWartend() entnommenen Auftrag wieder ein, optional
 * mit ergänztem Input (z. B. `manuelleErfassung`). Job-ID, In-Flight-Sperre
 * und Aufräum-Hooks bleiben die des Auftrags.
 */
export function reiheWiederEin(item, inputZusatz = {}) {
  item.input = { ...item.input, ...inputZusatz };
  _queue.push(item);
  tracker.markQueued(item.jobId);
  _drain();
}

export function getSnapshot() {
  return {
    runningCount: _running.size,
    queuedCount: _queue.length,
    wartendCount: _wartend.size,
    maxParallel: _maxParallel,
    paused: _pausen.aktiv(),
    pauseGrund: _pausen.grund(),
  };
}

/**
 * Pausiert das Starten neuer Pipelines. Bereits laufende Pipelines laufen zu
 * Ende — der Aufrufer muss auf runningCount === 0 warten, bevor er das aktive
 * Backend umschaltet (siehe warteAufLeerlauf).
 */
export function pause(grund) {
  if (_pausen.setzen(grund)) console.log(`[pipeline-queue] pausiert: ${grund}`);
}

/**
 * Nimmt genau diesen Grund zurück. Wartende Jobs starten erst, wenn kein
 * anderer Vorgang die Pipeline mehr anhält (jobs/pipeline-pause.js).
 */
export function resume(grund) {
  if (!_pausen.aktiv(grund)) return;
  if (_pausen.aufheben(grund)) {
    console.log('[pipeline-queue] fortgesetzt');
    _drain();
  } else {
    console.log(`[pipeline-queue] Pause "${grund}" beendet, weiter angehalten: ${_pausen.grund()}`);
  }
}

/** Ohne Argument: irgendeine Pause aktiv? Mit Argument: genau diese? */
export function isPaused(grund) {
  return _pausen.aktiv(grund);
}

/**
 * Wartet, bis keine Pipeline mehr läuft (nach pause()).
 * @param {number} timeoutMs  Obergrenze; danach wird false geliefert.
 */
export async function warteAufLeerlauf(timeoutMs = 120000) {
  const bis = Date.now() + timeoutMs;
  while (_running.size > 0) {
    if (Date.now() > bis) return false;
    await new Promise(r => setTimeout(r, 500));
  }
  return true;
}

/**
 * Reiht ein Dokument in die Pipeline ein. Wird sofort gestartet, falls ein Slot frei ist.
 *
 * @param {object} input          - Wird unverändert an processDocument durchgereicht.
 * @param {string} jobId          - Bereits via tracker.create() vergebene Job-ID.
 * @param {number} stepOffset     - Pipeline-Step-Offset (0 oder 1).
 * @param {object} [options]
 * @param {(err: Error) => void} [options.onError]    - Pro-Caller-Fehlerhandler.
 * @param {() => void}           [options.onCleanup]  - finally-Hook (z.B. releaseInFlight).
 * @param {number}               [options.batchSize]  - Anzahl gleichzeitig übergebener
 *        Dokumente (für den Auto-Cache-Trigger; ≥2 ⇒ Cache cacht ab dem ersten Dokument).
 */
export function enqueueDocument(input, jobId, stepOffset = 0, options = {}) {
  // Auto-Cache-Trigger: jeder echte Eingang zählt (Neuzugänge + Reprocessing),
  // Duplikat-Resumes (`_resume`) nicht — die laufen ohnehin nur weiter.
  if (!input?._resume) {
    noteDocumentArrival({ batchSize: options.batchSize || 1 })
      .catch(err => console.error('[pipeline-queue] noteDocumentArrival fehlgeschlagen:', err?.message));
  }
  _queue.push({
    jobId,
    input,
    stepOffset,
    enqueuedAt: new Date(),
    onError: options.onError,
    onCleanup: options.onCleanup,
    label: options.label || input?.filename || null,
    pufferJobId: options.pufferJobId || null,
    dauerhaft: options.dauerhaft === true,
    versuch: 0,
    herkunft: options.herkunft || herkunftVon(input, options.pufferJobId),
  });
  tracker.markQueued(jobId);
  _drain();
}

/**
 * Wie enqueueDocument, aber für Buffer-Eingänge (Upload, Zusammenführen, Scan):
 * PDF und Auftrag liegen dauerhaft auf der Platte bzw. in der DB, bevor diese
 * Funktion zurückkehrt. Scheitert die Sicherung, wird trotzdem eingereiht –
 * dann mit dem bisherigen Risiko eines Verlusts beim Neustart. Mit
 * `options.streng` wird stattdessen geworfen und nichts eingereiht: Der
 * Dokumentenstapel löscht seine Blätter erst nach einer gesicherten Übergabe.
 */
export async function reiheDauerhaftEin(input, jobId, stepOffset = 0, options = {}) {
  const pufferJobId = input._retrySourceJobId || jobId;
  const label = options.label || input.filename || 'Dokument';
  let dauerhaft = false;
  try {
    await saveScanBuffer(pufferJobId, input.pdfBuffer);
    await auftraege.sichere({ jobId, label, stepOffset, input, pufferJobId });
    dauerhaft = true;
  } catch (err) {
    if (options.streng) throw err;
    console.error(`[pipeline-queue] Auftrag ${jobId} nicht dauerhaft gesichert: ${err.message}`);
    appLog('WARN', 'pipeline-queue', `Auftrag ${label} nicht dauerhaft gesichert: ${err.message}`);
  }
  enqueueDocument(input, jobId, stepOffset, { ...options, label, pufferJobId, dauerhaft });
}

function stelleZurueck(item, err) {
  const versuch = (item.versuch || 0) + 1;
  const wartezeit = WARTEZEITEN_MS[Math.min(versuch, WARTEZEITEN_MS.length) - 1];
  const faelligAb = new Date(Date.now() + wartezeit);
  if (err.storageId) {
    // Phase 0 hat schon hochgeladen: der nächste Versuch startet von der
    // Datei in der Ablage. Die In-Flight-Sperre hält der Auftrag weiter.
    const { pdfBuffer, ...rest } = item.input;
    item.input = { ...rest, onedriveFileId: err.storageId, storageBackend: err.storageBackend, preclaimedInFlight: true };
    item.pufferJobId = null;
  }
  item.versuch = versuch;
  parkiere(item, faelligAb, err.grund);
  auftraege.parke({
    jobId: item.jobId, label: item.label, stepOffset: item.stepOffset, input: item.input,
    pufferJobId: item.pufferJobId, versuch, faelligAb, grund: err.grund,
  }).then(() => { item.dauerhaft = true; })
    .catch(e => console.error(`[pipeline-queue] Zurückstellung von ${item.jobId} nicht gesichert: ${e.message}`));
  console.log(`[pipeline-queue] Job ${item.jobId} zurückgestellt (Versuch ${versuch}/${WARTEZEITEN_MS.length}) bis ${faelligAb.toISOString()}`);
  appLog('WARN', 'pipeline-queue',
    `${item.label || 'Dokument'} zurückgestellt bis ${faelligAb.toLocaleTimeString('de-DE')}: ${err.grund}`);
}

function parkiere(item, faelligAb, grund) {
  item.faelligAb = faelligAb;
  item.grund = grund || null;
  _wartend.set(item.jobId, item);
  tracker.markWartend(item.jobId, faelligAb, grund || undefined);
  starteWecker();
  if (new Date(faelligAb).getTime() <= Date.now()) wecke();
}

// Ein kurzer Takt gegen die Wanduhr statt eines langen setTimeout je Auftrag:
// Timer laufen auf der monotonen Uhr, die im Standby des Rechners (WSL-VM)
// stehen bleibt. Ein Auftrag mit einer Stunde Wartezeit liefe nach einer Nacht
// im Standby sonst erst eine Stunde nach dem Aufwachen weiter.
const WECK_TAKT_MS = 15 * 1000;
let _wecker = null;

function starteWecker() {
  if (_wecker) return;
  _wecker = setInterval(wecke, WECK_TAKT_MS);
  _wecker.unref?.();
}

function wecke() {
  const jetzt = Date.now();
  let freigegeben = false;
  for (const [jobId, item] of _wartend) {
    if (new Date(item.faelligAb).getTime() > jetzt) continue;
    _wartend.delete(jobId);
    _queue.push(item);
    tracker.markQueued(jobId);
    freigegeben = true;
  }
  if (_wartend.size === 0 && _wecker) { clearInterval(_wecker); _wecker = null; }
  if (freigegeben) _drain();
}

/**
 * Holt nach einem Neustart alle gesicherten Aufträge zurück. Muss nach der
 * Sequence-Synchronisation und vor dem Watcher-Start laufen, damit wartende
 * Inbox-Dateien ihre Sperre haben, bevor der Watcher sie sieht.
 */
export async function stelleAuftraegeWiederHer() {
  let rows;
  try {
    rows = await auftraege.alle();
  } catch (err) {
    console.error(`[pipeline-queue] Gesicherte Aufträge nicht lesbar: ${err.message}`);
    return 0;
  }
  let n = 0;
  for (const row of rows) {
    try {
      const input = { ...row.eingang };
      let claimId = null;
      if (input.onedriveFileId && row.status !== 'wartet') {
        // Phase 0 war durch: Die Datei liegt in der Inbox (Watcher) oder ist
        // schon weiter (Pipeline-Recovery). Ein Rest des Puffers entfällt.
        if (row.puffer_job_id) await deleteScanBuffer(row.puffer_job_id).catch(() => {});
        await auftraege.entferne(row.job_id);
        continue;
      }
      if (input.onedriveFileId) {
        // Wiederverarbeitung und Duplikat-Fortsetzung tragen Zustand, der nur
        // im laufenden Prozess gilt – sie werden nicht automatisch fortgesetzt.
        if (input.modifyPostID || input._resume || !claimInFlight(input.onedriveFileId)) {
          await auftraege.entferne(row.job_id);
          appLog('WARN', 'pipeline-queue', `Gesicherter Auftrag ${row.label} nach Neustart nicht fortgesetzt`);
          continue;
        }
        claimId = input.onedriveFileId;
        input.preclaimedInFlight = true;
      } else if (row.puffer_job_id && await scanBufferVorhanden(row.puffer_job_id)) {
        const puffer = await readScanBuffer(row.puffer_job_id);
        if (await inboxHatKopie(puffer)) {
          await deleteScanBuffer(row.puffer_job_id).catch(() => {});
          await auftraege.entferne(row.job_id);
          appLog('INFO', 'pipeline-queue', `${row.label}: schon in der Inbox, der Watcher übernimmt`);
          continue;
        }
        input.pdfBuffer = puffer;
      } else {
        // Puffer schon hochgeladen (Phase 0) → die Datei liegt in der Inbox
        // und der Watcher übernimmt sie.
        await auftraege.entferne(row.job_id);
        continue;
      }
      await tracker.wiederherstellen(row.job_id, row.label, 10 + (row.step_offset || 0));
      const item = {
        jobId: row.job_id, input, stepOffset: row.step_offset, enqueuedAt: new Date(),
        label: row.label, pufferJobId: claimId ? null : row.puffer_job_id,
        dauerhaft: true, versuch: row.versuch,
        herkunft: herkunftVon(input, row.puffer_job_id),
      };
      if (row.status === 'wartet' && row.faellig_ab && new Date(row.faellig_ab) > new Date()) {
        parkiere(item, new Date(row.faellig_ab), row.letzter_fehler?.replace(/^Zurückgestellt: /, '') || undefined);
      } else {
        _queue.push(item);
        tracker.markQueued(item.jobId);
      }
      n++;
    } catch (err) {
      console.error(`[pipeline-queue] Auftrag ${row.job_id} nicht wiederhergestellt: ${err.message}`);
    }
  }
  if (n > 0) {
    console.log(`[pipeline-queue] ${n} gesicherte(n) Auftrag/Aufträge nach Neustart übernommen`);
    appLog('INFO', 'pipeline-queue', `${n} gesicherte(n) Auftrag/Aufträge nach Neustart übernommen`);
  }
  _drain();
  return n;
}

/**
 * Entfernt einen wartenden Job aus der Queue (wird von tracker.requestCancel aufgerufen).
 * Ruft synchron onCleanup, damit z.B. OneDrive-In-Flight-Locks freigegeben werden.
 *
 * @returns {boolean} true, wenn der Job in der Queue gefunden wurde.
 */
export function removeFromQueue(jobId) {
  let item = _wartend.get(jobId);
  if (item) {
    _wartend.delete(jobId);
  } else {
    const idx = _queue.findIndex(q => q.jobId === jobId);
    if (idx === -1) return false;
    [item] = _queue.splice(idx, 1);
  }
  // Abgebrochen wird das Dokument, nicht nur der Platz in der Schlange: die
  // schon hochgeladene Datei eines zurückgestellten Auftrags geht in den
  // Papierkorb, ein lokal gepuffertes PDF wird gelöscht.
  const storageId = item.versuch > 0 && item.input?.onedriveFileId ? item.input.onedriveFileId : null;
  if (storageId || item.pufferJobId) {
    // Der gesicherte Auftrag wird erst ausgetragen, wenn das Verwerfen
    // entschieden ist; scheitert es, bleibt der Eingang über Fehl- bzw.
    // Retry-Eintrag sichtbar (siehe verwirfZurueckgestellt).
    verwirfZurueckgestellt({
      jobId, storageId, storageBackend: item.input?.storageBackend, pufferJobId: item.pufferJobId, label: item.label,
    }).then((ergebnis) => {
      if (!ergebnis.ok) {
        appLog('WARN', 'pipeline-queue',
          `Abgebrochener Auftrag ${item.label || jobId} nicht verworfen, bleibt als Eingang sichtbar: ${ergebnis.fehler}`);
      }
    }).catch((err) => {
      appLog('ERROR', 'pipeline-queue', `Verwerfen von ${item.label || jobId} fehlgeschlagen: ${err.message}`);
    }).finally(() => {
      if (item.dauerhaft) auftraege.entferne(jobId).catch(() => {});
    });
  } else if (item.dauerhaft) {
    auftraege.entferne(jobId).catch(() => {});
  }
  try { item.onCleanup?.(); } catch (err) {
    console.error('[pipeline-queue] onCleanup während removeFromQueue fehlgeschlagen:', err?.message);
  }
  return true;
}

function _drain() {
  if (_pausen.aktiv()) return;
  while (_running.size < _maxParallel && _queue.length > 0) {
    const item = _queue.shift();
    _running.add(item.jobId);
    _laufend.set(item.jobId, item);
    tracker.markRunning(item.jobId);

    let zurueckgestellt = false;
    const zurueckstellbar = (item.versuch || 0) < WARTEZEITEN_MS.length;
    const input = { ...item.input, _zurueckstellbar: zurueckstellbar, _letzterVersuch: !zurueckstellbar };
    processDocument(input, item.jobId, item.stepOffset)
      .catch(err => {
        if (err instanceof tracker.ZurueckgestelltError) {
          if (!tracker.isCancelled(item.jobId)) {
            zurueckgestellt = true;
            stelleZurueck(item, err);
            return;
          }
          // Abbruch während des letzten KI-Versuchs: wie ein normaler Abbruch.
          verwirfZurueckgestellt({
            jobId: item.jobId, storageId: err.storageId, storageBackend: err.storageBackend,
            pufferJobId: err.storageId ? null : item.pufferJobId, label: item.label,
          }).catch(() => {});
          tracker.complete(item.jobId);
          return;
        }
        try { item.onError?.(err); } catch (e) {
          console.error('[pipeline-queue] onError-Handler warf:', e?.message);
        }
      })
      .finally(() => {
        if (!zurueckgestellt) {
          try { item.onCleanup?.(); } catch (e) {
            console.error('[pipeline-queue] onCleanup nach Pipeline warf:', e?.message);
          }
          if (item.dauerhaft) {
            auftraege.entferne(item.jobId)
              .catch(e => console.error(`[pipeline-queue] Auftrag ${item.jobId} nicht ausgetragen: ${e.message}`));
          }
        }
        _running.delete(item.jobId);
        _laufend.delete(item.jobId);
        _drain();
      });
  }
}

// Setter-Wiring: tracker ruft removeFromQueue beim Cancel von queued Jobs.
tracker.setQueueRemover(removeFromQueue);
