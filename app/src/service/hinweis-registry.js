/**
 * service/hinweis-registry.js — In-Memory-Registry für Benutzer-Hinweise an die KI.
 *
 * Wenn der Benutzer im ScannerCard einen Hinweis eingibt und einen Scan auslöst,
 * wird der Hint NACH erfolgreichem Scanner-Proxy hier abgelegt — gekoppelt an den
 * vom Scanner vergebenen DATEINAMEN. Dieser Dateiname ist der verlässliche
 * End-to-End-Korrelationsschlüssel: der Scanner gibt ihn in `data.file` zurück
 * (basename der Ausgabedatei), und der Cleaner sendet EXAKT denselben Namen als
 * `X-Filename` an /scan-registered und /scan-complete (siehe cleaner/run_loop.sh).
 *
 * Dadurch können parallele/aufeinanderfolgende Scans mit unterschiedlichen (oder
 * fehlenden) Hinweisen sich nicht mehr überkreuzen — im Gegensatz zum früheren
 * globalen Einzel-Slot. Die Webhook-Route (/scan-registered) liest den Hint per
 * Dateiname aus und verknüpft ihn mit der jobId; /scan-complete konsumiert ihn
 * dann (per jobId, mit Dateiname als Fallback) und gibt ihn an enqueueDocument
 * weiter, wo er als userHinweis in den KI-Prompt einfließt.
 */

const PENDING_TTL_MS = 10 * 60 * 1000; // 10 Minuten
const JOB_TTL_MS    = 60 * 60 * 1000;  // 1 Stunde

const pendingByFile = new Map();        // filename → { hinweis, expiresAt }
const hinweisJobs   = new Map();        // jobId → { hinweis, expiresAt }

function normFile(filename) {
  return typeof filename === 'string' ? filename.trim() : '';
}

/** Legt einen Hint gekoppelt an den Scanner-Dateinamen ab. */
export function setPendingHinweis(filename, hinweis) {
  const key = normFile(filename);
  if (!key || !hinweis) return;
  pendingByFile.set(key, { hinweis, expiresAt: Date.now() + PENDING_TTL_MS });
}

/** Konsumiert den Hint für einen Dateinamen (one-shot). null wenn keiner/abgelaufen. */
export function consumePendingHinweisByFile(filename) {
  const key = normFile(filename);
  if (!key) return null;
  const entry = pendingByFile.get(key);
  if (!entry) return null;
  pendingByFile.delete(key);
  if (Date.now() > entry.expiresAt) return null;
  return entry.hinweis;
}

export function clearPendingHinweis(filename) {
  const key = normFile(filename);
  if (key) pendingByFile.delete(key);
}

/** Verknüpft einen jobId mit einem Hint (wird in /scan-registered gesetzt). */
export function markHinweisJob(jobId, hinweis) {
  if (!jobId || !hinweis) return;
  hinweisJobs.set(jobId, { hinweis, expiresAt: Date.now() + JOB_TTL_MS });
}

/** Konsumiert den Hint für einen jobId (one-shot). Gibt null zurück wenn keiner. */
export function consumeHinweisJob(jobId) {
  if (!jobId) return null;
  const entry = hinweisJobs.get(jobId);
  if (!entry) return null;
  hinweisJobs.delete(jobId);
  if (Date.now() > entry.expiresAt) return null;
  return entry.hinweis;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of hinweisJobs) {
    if (now > entry.expiresAt) hinweisJobs.delete(id);
  }
  for (const [file, entry] of pendingByFile) {
    if (now > entry.expiresAt) pendingByFile.delete(file);
  }
}, 5 * 60 * 1000).unref?.();
