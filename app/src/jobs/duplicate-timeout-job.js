/**
 * jobs/duplicate-timeout-job.js — Automatische Duplikat-Entscheidung nach Ablauf
 *
 * Läuft alle 60 Sekunden und prüft auf abgelaufene Suspensions.
 *
 * Logik:
 *   - new_confidence > match_confidence → Auto-Replace (bessere Qualität)
 *   - Sonst → Auto-Discard (Duplikat verwerfen)
 *
 * Der ursprüngliche Discord-Message-Button wird entfernt.
 */

import * as suspensionStore from '../service/suspension-store.js';
import { resolveDuplicate } from '../service/resolve-duplicate.js';
import { loadDynamicSettings } from '../config.js';
import { appLog } from '../app-log.js';

const SWEEP_INTERVAL_MS = 60_000;
let _intervalId = null;

export function startDuplicateTimeoutJob() {
  if (_intervalId) return; // Bereits gestartet

  console.log('[duplicate-timeout] Timeout-Sweeper gestartet');
  _intervalId = setInterval(_sweep, SWEEP_INTERVAL_MS);

  // Sofort beim Start einmal ausführen
  _sweep().catch(err => console.error('[duplicate-timeout] Erster Sweep fehlgeschlagen:', err.message));
}

export function stopDuplicateTimeoutJob() {
  if (_intervalId) {
    clearInterval(_intervalId);
    _intervalId = null;
    console.log('[duplicate-timeout] Timeout-Sweeper gestoppt');
  }
}

async function _sweep() {
  let expired;
  try {
    expired = await suspensionStore.listExpired();
  } catch (err) {
    console.error('[duplicate-timeout] DB-Abfrage fehlgeschlagen:', err.message);
    return;
  }

  if (expired.length === 0) return;
  console.log(`[duplicate-timeout] ${expired.length} abgelaufene Suspension(s) gefunden`);

  let s = null;
  try { s = await loadDynamicSettings(); } catch { /* fallback null */ }

  for (const suspension of expired) {
    const jobId = suspension.job_id;

    try {
      const newConf = Number(suspension.new_confidence || 0);
      const oldConf = Number(suspension.match_confidence || 0);

      // Besser: Auto-Replace; schlechter oder gleich: Auto-Discard
      const decision = newConf > oldConf ? 'replace' : 'discard';
      const reason = decision === 'replace'
        ? `Auto-Replace (neue Qualität ${Math.round(newConf * 100)}% > alte ${Math.round(oldConf * 100)}%)`
        : `Auto-Discard (neue Qualität ${Math.round(newConf * 100)}% ≤ alte ${Math.round(oldConf * 100)}%)`;

      console.log(`[duplicate-timeout] Job ${jobId}: ${reason}`);
      appLog('INFO', 'duplicate-timeout', `Job ${jobId}: ${reason}`);

      await resolveDuplicate({ jobId, decision, source: `timeout (${reason})` }, s);
    } catch (err) {
      console.error(`[duplicate-timeout] Fehler bei Job ${jobId}:`, err.message);
      appLog('ERROR', 'duplicate-timeout', `Job ${jobId}: ${err.message}`);
    }
  }
}
