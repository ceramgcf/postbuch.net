/**
 * jobs/scan-vorgang.js – ein ausgelöster Scan ist sofort sichtbar.
 *
 * Zwischen dem Auslösen am Scanner und der Meldung des Cleaners
 * (/api/webhooks/scan-registered) vergehen bei einem langen ADF-Stapel
 * Minuten. Ohne eigenen Job wäre der Scan in dieser Zeit weder unter
 * Logs/Jobs noch im Eingang zu sehen. Dieser Job vom Typ `scan` deckt die
 * Lücke ab: Er entsteht beim Auslösen, zeigt „Scanner liest ein“ und danach
 * „Texterkennung läuft“, und endet, sobald der Cleaner jede Datei des Scans
 * angemeldet hat. Der Verarbeitungsauftrag übernimmt dann (`weiterJob`).
 *
 * Der Zustand liegt nur im Speicher: Nach einem Neustart der App läuft ein
 * angemeldeter Scan als normaler Verarbeitungsauftrag weiter.
 */

import * as tracker from './tracker.js';
import { appLog } from '../app-log.js';

// Spätestens dann muss der Cleaner die Dateien angemeldet haben.
const ANMELDE_FRIST_MS = 30 * 60_000;

const vorgaenge = new Map(); // scanJobId → { offen: Set<dateiname>, timer }
const nachDatei = new Map(); // dateiname → scanJobId

/** Legt den sichtbaren Job beim Auslösen an. @returns {string} jobId */
export function starteScanVorgang(beschreibung) {
  const jobId = tracker.create('scan', beschreibung, 2, false);
  tracker.setStep(jobId, 0, 'Scanner liest die Seiten ein');
  vorgaenge.set(jobId, { offen: new Set(), timer: null });
  return jobId;
}

/** Der Scanner hat geliefert; jetzt kommen Texterkennung und Anmeldung. */
export function scanGeliefert(jobId, dateien) {
  const v = vorgaenge.get(jobId);
  if (!v) return;
  const namen = (dateien || []).filter((d) => typeof d === 'string' && d);
  if (!namen.length) {
    // Ohne Dateinamen lässt sich der Auftrag nicht zuordnen; der Cleaner legt
    // ihn trotzdem an und er erscheint dann wie gewohnt.
    beende(jobId, null);
    return;
  }
  for (const n of namen) { v.offen.add(n); nachDatei.set(n, jobId); }
  tracker.setStep(jobId, 1, 'Texterkennung läuft');
  v.timer = setTimeout(() => {
    for (const n of v.offen) nachDatei.delete(n);
    vorgaenge.delete(jobId);
    tracker.fail(jobId, 'Das Scan-Ergebnis ist nicht bei der Verarbeitung angekommen. '
      + 'Bitte unter Logs/Jobs nach Fehlern der Texterkennung sehen und den Scan wiederholen.');
    appLog('WARN', 'import', `Scan ohne Anmeldung durch den Cleaner nach ${ANMELDE_FRIST_MS / 60_000} min abgebrochen`);
  }, ANMELDE_FRIST_MS);
  v.timer.unref?.();
}

/** Scanner-Aufruf gescheitert. */
export function scanFehlgeschlagen(jobId, meldung) {
  const v = vorgaenge.get(jobId);
  if (v?.timer) clearTimeout(v.timer);
  vorgaenge.delete(jobId);
  tracker.fail(jobId, meldung);
}

/**
 * Der Cleaner hat eine Datei angemeldet; ihr Verarbeitungsauftrag übernimmt.
 * Sind alle Dateien des Scans angemeldet, endet der Scan-Job.
 */
export function scanAngemeldet(dateiname, auftragsJobId) {
  const jobId = nachDatei.get(dateiname);
  if (!jobId) return;
  nachDatei.delete(dateiname);
  const v = vorgaenge.get(jobId);
  if (!v) return;
  v.offen.delete(dateiname);
  v.letzterAuftrag = auftragsJobId;
  if (!v.offen.size) beende(jobId, auftragsJobId);
}

function beende(jobId, weiterJob) {
  const v = vorgaenge.get(jobId);
  if (v?.timer) clearTimeout(v.timer);
  vorgaenge.delete(jobId);
  tracker.complete(jobId, weiterJob ? { weiterJob } : null);
}
