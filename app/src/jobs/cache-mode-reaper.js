/**
 * jobs/cache-mode-reaper.js — Auto-Reset des Cache-Mode nach Inaktivität.
 *
 * Läuft minütlich und flippt das persistierte `active`-Flag auf false, sobald 15
 * Minuten lang kein Dokument mehr verarbeitet wurde. Rein kosmetisch: das Routing
 * stützt sich ohnehin auf die lazy Prüfung in lib/cache-mode.js → activeCacheTier().
 * Der Reaper sorgt nur dafür, dass der UI-Status ohne Polling korrekt ist.
 */

import { reapCacheMode } from '../lib/cache-mode.js';
import { appLog } from '../app-log.js';

const SWEEP_INTERVAL_MS = 60_000;
let _intervalId = null;

export function startCacheModeReaper() {
  if (_intervalId) return;
  console.log('[cache-mode-reaper] gestartet');
  _intervalId = setInterval(_sweep, SWEEP_INTERVAL_MS);
}

export function stopCacheModeReaper() {
  if (_intervalId) {
    clearInterval(_intervalId);
    _intervalId = null;
    console.log('[cache-mode-reaper] gestoppt');
  }
}

async function _sweep() {
  try {
    const reset = await reapCacheMode();
    if (reset) {
      console.log('[cache-mode-reaper] Cache-Mode nach Inaktivität zurückgesetzt');
      appLog('INFO', 'cache-mode', 'Cache-Mode nach 15 Min Inaktivität automatisch deaktiviert');
    }
  } catch (err) {
    console.error('[cache-mode-reaper] Sweep fehlgeschlagen:', err.message);
  }
}
