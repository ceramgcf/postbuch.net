/**
 * jobs/pipeline-queue.js — Concurrency-Begrenzung für die Dokumenten-Pipeline.
 *
 * Statt processDocument() direkt aufzurufen, geben Caller ihre Jobs in diese Queue.
 * Es laufen maximal _maxParallel Pipelines gleichzeitig; weitere Jobs warten in FIFO.
 *
 * Settings-Key: pipeline_max_parallel (Default 3, Range 1-10).
 */

import { processDocument } from '../service/document-processor.js';
import * as tracker from './tracker.js';
import { noteDocumentArrival } from '../lib/cache-mode.js';

const _queue = [];           // Array<QueuedItem> — FIFO
const _running = new Set();  // Set<jobId>
let _maxParallel = 3;

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
let _paused = false;
let _pauseGrund = null;

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

export function getSnapshot() {
  return {
    runningCount: _running.size,
    queuedCount: _queue.length,
    maxParallel: _maxParallel,
    paused: _paused,
    pauseGrund: _pauseGrund,
  };
}

/**
 * Pausiert das Starten neuer Pipelines. Bereits laufende Pipelines laufen zu
 * Ende — der Aufrufer muss auf runningCount === 0 warten, bevor er das aktive
 * Backend umschaltet (siehe warteAufLeerlauf).
 */
export function pause(grund = 'Wartungsarbeiten') {
  if (_paused) return;
  _paused = true;
  _pauseGrund = grund;
  console.log(`[pipeline-queue] pausiert: ${grund}`);
}

/** Hebt die Pause auf und startet wartende Jobs sofort. */
export function resume() {
  if (!_paused) return;
  _paused = false;
  _pauseGrund = null;
  console.log('[pipeline-queue] fortgesetzt');
  _drain();
}

export function isPaused() {
  return _paused;
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
  });
  tracker.markQueued(jobId);
  _drain();
}

/**
 * Entfernt einen wartenden Job aus der Queue (wird von tracker.requestCancel aufgerufen).
 * Ruft synchron onCleanup, damit z.B. OneDrive-In-Flight-Locks freigegeben werden.
 *
 * @returns {boolean} true, wenn der Job in der Queue gefunden wurde.
 */
export function removeFromQueue(jobId) {
  const idx = _queue.findIndex(item => item.jobId === jobId);
  if (idx === -1) return false;
  const [item] = _queue.splice(idx, 1);
  try { item.onCleanup?.(); } catch (err) {
    console.error('[pipeline-queue] onCleanup während removeFromQueue fehlgeschlagen:', err?.message);
  }
  return true;
}

function _drain() {
  if (_paused) return;
  while (_running.size < _maxParallel && _queue.length > 0) {
    const item = _queue.shift();
    _running.add(item.jobId);
    tracker.markRunning(item.jobId);

    processDocument(item.input, item.jobId, item.stepOffset)
      .catch(err => {
        try { item.onError?.(err); } catch (e) {
          console.error('[pipeline-queue] onError-Handler warf:', e?.message);
        }
      })
      .finally(() => {
        try { item.onCleanup?.(); } catch (e) {
          console.error('[pipeline-queue] onCleanup nach Pipeline warf:', e?.message);
        }
        _running.delete(item.jobId);
        _drain();
      });
  }
}

// Setter-Wiring: tracker ruft removeFromQueue beim Cancel von queued Jobs.
tracker.setQueueRemover(removeFromQueue);
