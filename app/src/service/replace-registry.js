/**
 * service/replace-registry.js — Schmale In-Memory-Registry für Scanner-Ersetzungen.
 *
 * Wenn der Benutzer im Import-Screen im Replace-Modus einen Scan auslöst, wird
 * VOR dem Scanner-Aufruf eine "Pending-Replace"-Reservierung angelegt. Sobald
 * der Cleaner den fertigen Scan registriert (POST /webhooks/scan-registered)
 * konsumiert die Webhook-Route die Reservierung und merkt sich, dass dieser
 * konkrete jobId für den Austausch der OneDrive-Datei einer existierenden
 * Postbuch-PostID gedacht ist. Beim nachgelagerten /scan-complete-Webhook
 * verzweigt die Route dann in `replacePdf()` statt in die normale Pipeline.
 *
 * Entscheidungen:
 *   • Single-Slot statt Queue – das System ist im Wesentlichen single-user
 *     und der physische Scanner verarbeitet ohnehin nur einen Auftrag gleichzeitig.
 *     Eine zweite Reservierung verdrängt eine ältere (mit Log).
 *   • TTL: 10 Minuten. Ein nicht konsumierter Eintrag verfällt automatisch.
 *   • Persistenz: keine. Bei App-Neustart geht der Reservierungsstand verloren —
 *     ein laufender Scan würde dann als normales Dokument verarbeitet, nicht
 *     als Replace. Dieses Risiko ist akzeptabel.
 */

const PENDING_TTL_MS = 10 * 60 * 1000; // 10 Minuten
const JOB_TTL_MS = 60 * 60 * 1000;     // 1 Stunde – falls scan-complete nie kommt

let pendingReplace = null;             // { postid, expiresAt } | null
const replaceJobs = new Map();          // jobId → { postid, expiresAt }

/**
 * Reserviert die nächste eingehende Scan-Datei für einen Replace-Vorgang.
 * Eine bereits aktive Reservierung wird überschrieben.
 */
export function setPendingReplace(postid) {
  if (pendingReplace && pendingReplace.postid !== postid) {
    console.warn(`[replace-registry] Pending Replace überschrieben: ${pendingReplace.postid} → ${postid}`);
  }
  pendingReplace = { postid, expiresAt: Date.now() + PENDING_TTL_MS };
}

/**
 * Konsumiert die aktive Reservierung (löscht sie) und gibt die postid zurück
 * oder null, wenn keine aktive (oder eine abgelaufene) Reservierung vorliegt.
 */
export function consumePendingReplace() {
  if (!pendingReplace) return null;
  if (Date.now() > pendingReplace.expiresAt) {
    pendingReplace = null;
    return null;
  }
  const { postid } = pendingReplace;
  pendingReplace = null;
  return postid;
}

export function clearPendingReplace() {
  pendingReplace = null;
}

export function getPendingReplace() {
  if (!pendingReplace) return null;
  if (Date.now() > pendingReplace.expiresAt) {
    pendingReplace = null;
    return null;
  }
  return pendingReplace.postid;
}

/**
 * Markiert einen konkreten jobId als Replace-Auftrag für eine postid.
 * Wird in /webhooks/scan-registered direkt nachdem der Job angelegt wurde gesetzt.
 */
export function markReplaceJob(jobId, postid) {
  if (!jobId || !postid) return;
  replaceJobs.set(jobId, { postid, expiresAt: Date.now() + JOB_TTL_MS });
}

/**
 * Prüft, ob ein eingehender Scan-Complete-Webhook zu einem Replace-Auftrag
 * gehört. Konsumiert den Eintrag (one-shot). Gibt postid oder null zurück.
 */
export function consumeReplaceJob(jobId) {
  if (!jobId) return null;
  const entry = replaceJobs.get(jobId);
  if (!entry) return null;
  replaceJobs.delete(jobId);
  if (Date.now() > entry.expiresAt) return null;
  return entry.postid;
}

// Periodisches Aufräumen abgelaufener Job-Marker (klein gehalten, kein Crash bei stop)
setInterval(() => {
  const now = Date.now();
  for (const [jobId, entry] of replaceJobs) {
    if (now > entry.expiresAt) replaceJobs.delete(jobId);
  }
  if (pendingReplace && now > pendingReplace.expiresAt) pendingReplace = null;
}, 5 * 60 * 1000).unref?.();
