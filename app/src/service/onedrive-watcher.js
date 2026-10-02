/**
 * service/onedrive-watcher.js — OneDrive-Polling der Inbox
 *
 * Ersetzt: n8n-Workflow "Dokumentenverarbeitung - Trigger OneDrive"
 *
 * Pollt den OneDrive-Inbox-Ordner in konfigurierbarem Intervall.
 * Für jede dort liegende Datei wird processDocument() (via pipeline-queue) gestartet.
 *
 * Doppelverarbeitung wird über die in-flight-Registry (claimInFlight) verhindert,
 * nicht über Zeitstempel — eine zurück-in-die-Inbox verschobene Datei ändert ihr
 * createdDateTime nicht und würde sonst übersehen.
 *
 * Steuerung über _settings.onedrive_polling = { enabled: true, intervalSec: 30 }
 */

import db from '../db.js';
import { loadDynamicSettings, getFolders } from '../config.js';
import { getActiveAdapterFor } from '../lib/storage/index.js';
import { claimInFlight, releaseInFlight } from './document-processor.js';
import { enqueueDocument, isPaused } from '../jobs/pipeline-queue.js';
import * as tracker from '../jobs/tracker.js';
import { appLog } from '../app-log.js';

let _pollInterval = null;

// Ein einzelner fehlgeschlagener Poll ist Normalbetrieb, kein Störfall: Graph
// antwortet gelegentlich mit 503/504, DNS hakt kurz, das WLAN ist einen Moment
// weg. Beim nächsten Durchlauf ist es vorbei. Als ERROR protokolliert füllt das
// „Logs → System" mit roten Zeilen, die niemand beheben kann und die echte
// Fehler zudecken. Gemeldet wird deshalb nach Beharrlichkeit statt nach
// Einzelereignis: die ersten Fehlschläge in Folge sind WARN, ab dem dritten ist
// die Ablage nicht mehr nur kurz zickig, sondern wirklich nicht erreichbar —
// das ist ein ERROR. Ein erfolgreicher Poll setzt den Zähler zurück und meldet
// die Erholung, damit eine eskalierte Störung nicht offen stehen bleibt.
const POLL_FEHLER_ESKALATION = 3;
let _pollFehlerInFolge = 0;

function meldePollFehler(err) {
  _pollFehlerInFolge++;
  console.error('[onedrive-watcher] Poll-Fehler:', err.message);
  if (_pollFehlerInFolge < POLL_FEHLER_ESKALATION) {
    appLog('WARN', 'onedrive-watcher', `Poll-Fehler (${_pollFehlerInFolge}. Versuch): ${err.message}`);
  } else {
    appLog('ERROR', 'onedrive-watcher',
      `Poll-Fehler seit ${_pollFehlerInFolge} Durchläufen in Folge: ${err.message}`);
  }
}

function meldePollErfolg() {
  if (_pollFehlerInFolge >= POLL_FEHLER_ESKALATION) {
    appLog('INFO', 'onedrive-watcher',
      `Eingangs-Polling wieder erfolgreich (nach ${_pollFehlerInFolge} Fehlversuchen).`);
  }
  _pollFehlerInFolge = 0;
}

/**
 * Startet das OneDrive-Polling, falls in _settings aktiviert.
 * Wird einmalig beim App-Start aufgerufen.
 */
export async function startPolling() {
  try {
    const settings = await loadDynamicSettings();
    let pollingConfig = settings.onedrive_polling;

    // Selbstheilung. Bis 2.8.9 hat `_settings.onedrive_polling` genau eine
    // Stelle geschrieben: der OneDrive-OAuth-Callback. Eine Nextcloud-Instanz
    // — und jede Erstinstallation ohne diesen Callback — blieb deshalb dauerhaft
    // ohne Eingangs-Polling, obwohl der Watcher selbst backend-agnostisch ist.
    // Fehlt der Schlüssel GANZ und ist zugleich ein `_inbox`-Ordner
    // konfiguriert, ist das keine Entscheidung, sondern eine Lücke: einmalig
    // einschalten. Ein bewusst auf `false` gesetztes Polling bleibt aus, weil
    // dann der Schlüssel existiert.
    if (pollingConfig === undefined && getFolders(settings).inbox) {
      pollingConfig = { enabled: true, intervalSec: 60 };
      await db.query(
        `INSERT INTO postbuch._settings (key, value, updated_at)
         VALUES ('onedrive_polling', $1::jsonb, NOW())
         ON CONFLICT (key) DO NOTHING`,
        [JSON.stringify(pollingConfig)],
      );
      appLog('INFO', 'onedrive-watcher', 'Eingangs-Polling war nie konfiguriert — mit 60 s aktiviert.');
    }

    if (!pollingConfig || !pollingConfig.enabled) {
      console.log('[onedrive-watcher] Polling deaktiviert (onedrive_polling.enabled != true)');
      return;
    }

    const intervalSec = pollingConfig.intervalSec || 60;

    // Falls bereits laufend, zuerst stoppen
    stopPolling();

    console.log(`[onedrive-watcher] Polling gestartet (Intervall: ${intervalSec}s)`);
    appLog('INFO', 'onedrive-watcher', `Polling gestartet (Intervall: ${intervalSec}s)`);

    _pollInterval = setInterval(
      () => pollOnce().then(meldePollErfolg, meldePollFehler),
      intervalSec * 1000,
    );

    // Erster Poll nach 5 Sekunden (nicht sofort beim Start)
    setTimeout(() => pollOnce().then(meldePollErfolg).catch(err => {
      console.error('[onedrive-watcher] Erster Poll fehlgeschlagen:', err.message);
    }), 5000);
  } catch (err) {
    console.error('[onedrive-watcher] Konnte nicht starten:', err.message);
    appLog('ERROR', 'onedrive-watcher', `Konnte nicht starten: ${err.message}`);
  }
}

/**
 * Stoppt das Polling.
 */
export function stopPolling() {
  if (_pollInterval) {
    clearInterval(_pollInterval);
    _pollInterval = null;
    _pollFehlerInFolge = 0;
    console.log('[onedrive-watcher] Polling gestoppt');
  }
}

/**
 * Führt einen einzelnen Poll-Durchgang durch.
 */
async function pollOnce() {
  // Während einer Storage-Migration nicht claimen: die Datei landete sonst in
  // der in-flight-Registry, ohne verarbeitet zu werden, und bliebe dort bis zum
  // Ende des Laufs hängen. Sie bleibt einfach in der Inbox liegen und wird beim
  // nächsten Poll nach dem Fortsetzen gefunden.
  if (isPaused()) return;

  const settings = await loadDynamicSettings();
  const inboxId = getFolders(settings).inbox;

  if (!inboxId) {
    console.warn('[onedrive-watcher] Kein Inbox-Ordner konfiguriert (storage_folders.<backend>.inbox)');
    return;
  }

  // Alle Dateien in der Inbox listen (nicht nur "neue").
  // Begründung: Beim Zurückverschieben aus _failed o.ä. ändert sich createdDateTime
  // nicht — eine Filterung nach Zeitstempel würde solche Dateien dauerhaft ignorieren.
  // Doppelverarbeitung wird durch claimInFlight() verhindert: bereits laufende oder
  // in der pipeline-queue wartende Dateien sind dort registriert und werden übersprungen.
  const children = await getActiveAdapterFor(settings).listChildren(inboxId);
  const inboxFiles = children.filter((c) => !c.isFolder);

  const claimed = [];
  for (const file of inboxFiles) {
    if (!claimInFlight(file.id)) {
      // Datei wird bereits verarbeitet oder wartet in der Queue — überspringen, keine Log-Zeile.
      continue;
    }
    claimed.push(file);
  }

  if (claimed.length > 0) {
    console.log(`[onedrive-watcher] ${claimed.length} Datei(en) zur Verarbeitung übergeben (von ${inboxFiles.length} in Inbox)`);
    appLog('INFO', 'onedrive-watcher', `${claimed.length} Datei(en) zur Verarbeitung übergeben (von ${inboxFiles.length} in Inbox)`);
  }

  for (const file of claimed) {
    const jobId = tracker.create('doc-process', file.name, 10);
    enqueueDocument(
      {
        onedriveFileId: file.id,
        preclaimedInFlight: true,
        // Aus der Inbox des Backends, das beim Claim aktiv war.
        storageBackend: getActiveAdapterFor(settings).name,
      },
      jobId,
      0,
      {
        // Schwung aus der Inbox → Auto-Cache cacht ab dem ersten Dokument.
        batchSize: claimed.length,
        onError: (err) => {
          console.error(`[onedrive-watcher] Verarbeitung fehlgeschlagen für ${file.name}: ${err.message}`);
          appLog('ERROR', 'onedrive-watcher', `Verarbeitung fehlgeschlagen für ${file.name}: ${err.message}`);
        },
        // releaseInFlight wird auch von processDocument selbst (finally) aufgerufen.
        // Hier ist es nur für den Cancel-vor-Start-Fall relevant; die Doppelung ist idempotent.
        onCleanup: () => releaseInFlight(file.id),
      }
    );
  }
}
