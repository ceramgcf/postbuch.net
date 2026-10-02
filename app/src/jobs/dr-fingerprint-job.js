/**
 * jobs/dr-fingerprint-job.js — Wöchentlicher Sync der DR-Fingerabdrücke
 *
 * Aufgaben:
 *   1. Beim App-Start: Wenn Zeilen mit storage_id aber ohne sha256 existieren,
 *      einmalig im Hintergrund einen Initial-Population-Lauf anstoßen
 *      (5 Min Verzögerung, damit die Ablage-Verbindung etabliert ist).
 *   2. Wöchentlicher Cron (Sonntag 03:00 Berlin): syncFingerprints() läuft
 *      über alle Zeilen, gleicht den Änderungszeitpunkt ab, hasht bei Bedarf neu.
 *
 * Nutzt jobs/tracker.js für Fortschrittsanzeige im UI.
 */

import { syncFingerprints, getFingerprintStats } from '../service/dr-fingerprint.js';
import * as tracker from './tracker.js';
import { appLog } from '../app-log.js';

let _cronJob = null;
let _running = false;

const CRON_EXPR = '0 3 * * 0'; // Sonntag 03:00 Europe/Berlin
const STARTUP_DELAY_MS = 5 * 60 * 1000;

/**
 * Führt einen Sync-Lauf durch, im Tracker erfasst.
 * Mehrfachläufe werden vermieden — bei laufendem Job wird der Aufruf ignoriert.
 *
 * @param {string} label  Job-Label (z. B. 'DR-Fingerprint (Initial)' oder 'DR-Fingerprint (wöchentlich)')
 * @returns {Promise<string|null>}  Job-ID, oder null wenn ein Lauf bereits läuft
 */
export async function runFingerprintSync(label = 'DR-Fingerprint Sync') {
  if (_running) {
    return null;
  }
  _running = true;

  // Anzahl betroffener Zeilen für total_steps
  const stats = await getFingerprintStats();
  const total = stats.withOnedrive;
  const jobId = tracker.create('dr-fingerprint', label, total, true);

  // Im Hintergrund laufen lassen — Aufrufer bekommt sofort die jobId zurück
  (async () => {
    const start = Date.now();
    try {
      const result = await syncFingerprints({ jobId });
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      const summary = `${result.hashed} neu gehasht, ${result.renamed} umbenannt, ${result.missing} als fehlend markiert, ${result.skipped} unverändert, ${result.errors} Fehler (${elapsed}s)`;
      appLog('INFO', 'dr-fingerprint', `${label}: ${summary}`);
      tracker.complete(jobId, result);
    } catch (err) {
      appLog('ERROR', 'dr-fingerprint', `${label} fehlgeschlagen: ${err.message}`);
      tracker.fail(jobId, err.message);
    } finally {
      _running = false;
    }
  })();

  return jobId;
}

/**
 * Startet den wöchentlichen Cron-Job + Initial-Population.
 * Wird einmalig beim App-Start aufgerufen.
 */
export async function startFingerprintJob() {
  // Cron-Job starten
  try {
    const cron = await import('node-cron');
    if (_cronJob) _cronJob.stop();
    _cronJob = cron.default.schedule(CRON_EXPR, () => {
      runFingerprintSync('DR-Fingerprint (wöchentlich)').catch(err => {
        console.error('[dr-fingerprint] Wöchentlicher Lauf fehlgeschlagen:', err.message);
      });
    }, { timezone: 'Europe/Berlin' });
    console.log(`[dr-fingerprint] Cron-Job gestartet: ${CRON_EXPR}`);
  } catch {
    console.warn('[dr-fingerprint] node-cron nicht installiert — wöchentlicher Sync deaktiviert');
    appLog('WARN', 'dr-fingerprint', 'node-cron fehlt — wöchentlicher Sync deaktiviert');
  }

  // Initial-Population, falls Zeilen ohne sha256 existieren
  setTimeout(async () => {
    try {
      const stats = await getFingerprintStats();
      if (stats.missingSha256 > 0) {
        console.log(`[dr-fingerprint] ${stats.missingSha256} Zeile(n) ohne SHA256 — starte Initial-Lauf`);
        appLog('INFO', 'dr-fingerprint',
          `Initial-Population gestartet: ${stats.missingSha256} Zeile(n) ohne SHA256`);
        await runFingerprintSync('DR-Fingerprint (Initial)');
      } else {
        console.log('[dr-fingerprint] Alle Zeilen bereits gehasht — kein Initial-Lauf nötig');
      }
    } catch (err) {
      console.warn('[dr-fingerprint] Initial-Check übersprungen:', err.message);
    }
  }, STARTUP_DELAY_MS);
}
