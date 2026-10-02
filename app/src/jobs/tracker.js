import { randomUUID } from 'node:crypto';
import pool from '../db.js';

/** In-memory store for active jobs */
const jobs = new Map();

/**
 * Wird geworfen, wenn ein laufender Job über requestCancel() abgebrochen wurde.
 * Zentral hier definiert (statt lokal in document-processor.js), damit auch
 * lib/llm.js sie werfen kann — z. B. während einer Retry-Wartezeit.
 */
export class CancellationError extends Error {
  constructor() { super('Verarbeitung abgebrochen'); this.name = 'CancellationError'; }
}

// jobId → Promise des INSERT in _jobs. create() schreibt bewusst
// fire-and-forget (der Aufrufer soll nicht auf die DB warten müssen), aber wer
// eine Fremdschlüssel-Referenz auf _jobs setzt, MUSS vorher awaitPersisted()
// aufrufen — sonst läuft er in eine FK-Verletzung, weil die Zeile noch nicht
// da ist.
const _persistPromises = new Map();

// Queue-Removal-Hook (Setter-Pattern, vermeidet zirkulären Import zur pipeline-queue).
let _queueRemover = null;
export function setQueueRemover(fn) { _queueRemover = fn; }

/**
 * Initialize the job tracker.
 * Marks all previously "running" or "queued" jobs as "interrupted" (stale from a crash/restart).
 * Jobs with status "awaiting_decision" survive restart — they are durable by design.
 */
export async function init() {
  const result = await pool.query(
    "UPDATE _jobs SET status = 'interrupted', updated_at = NOW(), completed_at = NOW() WHERE status IN ('running','queued')"
  );
  if (result.rowCount > 0) {
    console.log(`[job-tracker] Marked ${result.rowCount} stale running/queued job(s) as interrupted`);
  }
  console.log('[job-tracker] Initialized');
}

/**
 * Create a new tracked job.
 * @returns {string} jobId (UUID)
 */
export function create(type, label, totalSteps, cancellable = true, payload = null) {
  const id = randomUUID();
  const now = new Date();
  const job = {
    id, type, label,
    status: 'running',
    step: 0, totalSteps, stepLabel: '',
    cancellable, payload,
    startedAt: now, updatedAt: now,
    completedAt: null, errorMessage: null,
    _cancelRequested: false,
  };
  jobs.set(id, job);

  const p = pool.query(
    `INSERT INTO _jobs (id, type, label, status, step, total_steps, step_label, cancellable, payload)
     VALUES ($1, $2, $3, 'running', 0, $4, '', $5, $6)`,
    [id, type, label, totalSteps, cancellable, payload ? JSON.stringify(payload) : null]
  ).catch(err => console.error('[job-tracker] DB insert failed:', err.message));
  _persistPromises.set(id, p);
  p.finally(() => _persistPromises.delete(id));

  return id;
}

/**
 * Wartet, bis die _jobs-Zeile wirklich geschrieben ist.
 * Nötig für jeden, der einen Fremdschlüssel auf _jobs(id) setzt.
 */
export async function awaitPersisted(jobId) {
  const p = _persistPromises.get(jobId);
  if (p) await p;
}

/**
 * Update the current step of a job.
 */
export function setStep(jobId, step, stepLabel) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.step = step;
  job.stepLabel = stepLabel;
  job.updatedAt = new Date();

  pool.query(
    'UPDATE _jobs SET step = $1, step_label = $2, updated_at = NOW() WHERE id = $3',
    [step, stepLabel, jobId]
  ).catch(err => console.error('[job-tracker] DB step update failed:', err.message));
}

/** Passt die Gesamtschrittzahl an, sobald ein asynchroner Lauf sie kennt. */
export function setTotal(jobId, totalSteps) {
  const total = Math.max(1, Number(totalSteps) || 1);
  const job = jobs.get(jobId);
  if (job) {
    job.totalSteps = total;
    job.updatedAt = new Date();
  }
  pool.query(
    'UPDATE _jobs SET total_steps = $1, updated_at = NOW() WHERE id = $2',
    [total, jobId],
  ).catch(err => console.error('[job-tracker] DB total update failed:', err.message));
}

/**
 * Synchronous check whether cancellation was requested.
 */
export function isCancelled(jobId) {
  const job = jobs.get(jobId);
  return job?._cancelRequested || false;
}

/**
 * Mark a job as queued (waiting for a free pipeline slot).
 */
export function markQueued(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.status = 'queued';
  job.stepLabel = 'In Warteschlange';
  job.updatedAt = new Date();
  pool.query(
    "UPDATE _jobs SET status = 'queued', step_label = 'In Warteschlange', updated_at = NOW() WHERE id = $1",
    [jobId]
  ).catch(err => console.error('[job-tracker] DB queued update failed:', err.message));
}

/**
 * Mark a job as suspended (awaiting a user decision — e.g. duplicate resolution).
 * The pipeline slot is freed; the job status persists in the DB.
 */
export function markSuspended(jobId) {
  const job = jobs.get(jobId);
  if (job) {
    job.status = 'awaiting_decision';
    job.updatedAt = new Date();
    jobs.delete(jobId); // entfernt aus In-Memory-Map, aber bleibt in DB
  }
  pool.query(
    "UPDATE _jobs SET status = 'awaiting_decision', step_label = 'Warte auf Entscheidung', updated_at = NOW() WHERE id = $1",
    [jobId]
  ).catch(err => console.error('[job-tracker] DB markSuspended update failed:', err.message));
}

/**
 * Resume a suspended job: re-creates the in-memory entry (markSuspended deleted it)
 * and sets status back to 'queued' for re-enqueue. Without restoring the in-memory
 * entry, all subsequent setStep/markRunning/fail calls on the resumed pipeline would
 * silently no-op — including failures, which would never reach the DB.
 */
export async function resume(jobId) {
  try {
    const result = await pool.query(
      'SELECT type, label, total_steps, cancellable, started_at FROM _jobs WHERE id = $1',
      [jobId]
    );
    const row = result.rows[0];
    if (row) {
      jobs.set(jobId, {
        id: jobId,
        type: row.type,
        label: row.label,
        status: 'queued',
        step: 0,
        totalSteps: row.total_steps,
        stepLabel: 'Wird wiederaufgenommen',
        cancellable: row.cancellable,
        payload: null,
        startedAt: row.started_at,
        updatedAt: new Date(),
        completedAt: null,
        errorMessage: null,
        _cancelRequested: false,
      });
    }
  } catch (err) {
    console.error('[job-tracker] resume reload failed:', err.message);
  }
  await pool.query(
    "UPDATE _jobs SET status = 'queued', step_label = 'Wird wiederaufgenommen', updated_at = NOW() WHERE id = $1",
    [jobId]
  ).catch(err => console.error('[job-tracker] DB resume update failed:', err.message));
}

/**
 * Mark a job as running (transition from queued → running when a slot becomes free).
 */
export function markRunning(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.status = 'running';
  job.updatedAt = new Date();
  pool.query(
    "UPDATE _jobs SET status = 'running', updated_at = NOW() WHERE id = $1",
    [jobId]
  ).catch(err => console.error('[job-tracker] DB running update failed:', err.message));
}

/**
 * Request cancellation of a job. The running code must check isCancelled().
 * For queued jobs, removes from queue immediately and completes as cancelled.
 * @returns {boolean} true if the cancel request was accepted
 */
export function requestCancel(jobId) {
  const job = jobs.get(jobId);
  if (!job || !job.cancellable) return false;

  // Die Ablage-Migration ist eine Betreiber-Entscheidung. POST /api/jobs/:id/cancel
  // prüft KEINE Rolle und hängt nur hinter requireAuth — ohne diesen Guard
  // könnte ein vollzugriff-Nutzer den Lauf abbrechen. Der Abbruch läuft
  // ausschließlich über /api/settings/storage/migration/:runId/abbrechen.
  // Doppelt gesichert: der Job wird ohnehin mit cancellable: false erzeugt.
  if (job.type === 'storage-migration') return false;

  if (job.status === 'queued') {
    job._cancelRequested = true;
    if (_queueRemover) _queueRemover(jobId);
    complete(jobId);
    return true;
  }

  if (job.status !== 'running') return false;
  job._cancelRequested = true;
  return true;
}

/**
 * Mark a job as completed (done or cancelled, depending on cancel flag).
 * @param {object|null} result  Optional result payload to store (e.g. { postid, betreff }).
 */
export function complete(jobId, result = null) {
  const job = jobs.get(jobId);
  // Determine final status: cancelled if flag set, done otherwise.
  // If job not in memory (e.g. it was suspended), default to 'done'.
  const finalStatus = job?._cancelRequested ? 'cancelled' : 'done';
  if (job) {
    job.status = finalStatus;
    job.updatedAt = new Date();
    job.completedAt = new Date();
    jobs.delete(jobId);
  }

  // Always update DB — covers suspended jobs that were removed from in-memory map.
  pool.query(
    'UPDATE _jobs SET status = $1, updated_at = NOW(), completed_at = NOW(), payload = COALESCE($3::jsonb, payload) WHERE id = $2',
    [finalStatus, jobId, result ? JSON.stringify(result) : null]
  ).catch(err => console.error('[job-tracker] DB complete update failed:', err.message));
}

/**
 * Mark a job as failed.
 * @param {object|null} payload  Optionale Detaildaten (z. B. eine Fehlerliste
 *   je Dokument) — landen wie bei complete() in der payload-Spalte, damit das
 *   Frontend nach einem teilweise fehlgeschlagenen Lauf mehr sieht als nur die
 *   zusammengefasste Fehlermeldung.
 */
export function fail(jobId, errorMessage, payload = null) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.status = 'failed';
  job.errorMessage = errorMessage;
  if (payload) job.payload = payload;
  job.updatedAt = new Date();
  job.completedAt = new Date();
  jobs.delete(jobId);

  pool.query(
    'UPDATE _jobs SET status = $1, error_message = $2, updated_at = NOW(), completed_at = NOW(), payload = COALESCE($4::jsonb, payload) WHERE id = $3',
    ['failed', errorMessage, jobId, payload ? JSON.stringify(payload) : null]
  ).catch(err => console.error('[job-tracker] DB fail update failed:', err.message));
}

/**
 * List all currently active (in-memory) jobs — running or queued.
 */
export function listActive() {
  return Array.from(jobs.values())
    .filter(j => j.status === 'running' || j.status === 'queued')
    .map(({ _cancelRequested, ...rest }) => rest);
}

/**
 * O(1)-Liveness-Check für genau eine Job-ID. Bewusst kein Snapshot wie
 * listActive(): Ein Aufrufer, der über mehrere Zeilen/Awaits hinweg iteriert
 * (z. B. der Pipeline-Recovery-Sweep), muss pro Zeile den aktuellen Stand
 * sehen, nicht eine zu Beginn der Schleife eingefrorene Momentaufnahme.
 */
export function isActive(jobId) {
  const job = jobs.get(jobId);
  return !!job && (job.status === 'running' || job.status === 'queued');
}

/**
 * Get a specific job by ID (checks memory first, then DB).
 */
export async function get(jobId) {
  const job = jobs.get(jobId);
  if (job) {
    const { _cancelRequested, ...rest } = job;
    return rest;
  }
  const result = await pool.query('SELECT * FROM _jobs WHERE id = $1', [jobId]);
  return result.rows[0] || null;
}

/**
 * List suspended jobs waiting for a user decision.
 */
export async function listSuspended() {
  const result = await pool.query(
    "SELECT * FROM _jobs WHERE status = 'awaiting_decision' ORDER BY updated_at ASC"
  );
  return result.rows;
}

/**
 * List recently completed jobs from DB (excludes awaiting_decision — those appear in listSuspended).
 */
export async function listRecent(limit = 30) {
  const result = await pool.query(
    "SELECT * FROM _jobs WHERE status NOT IN ('running', 'awaiting_decision') ORDER BY completed_at DESC NULLS LAST LIMIT $1",
    [limit]
  );
  return result.rows;
}
