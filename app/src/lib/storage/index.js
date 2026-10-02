/**
 * lib/storage/index.js — Registry und Facade der Ablage-Backends
 *
 * Alle Datei-Operationen laufen über einen Adapter. Es gibt genau zwei
 * Einstiegspunkte:
 *
 *   getActiveAdapter()          für Neuzugänge (Upload, Ordner-Initialisierung,
 *                               Backup) — nimmt das in _settings.storage_backend
 *                               konfigurierte Backend.
 *   getAdapter(row.storage_backend)  für zeilenbezogene Operationen — eine
 *                               bestehende Datei liegt dort, wo sie liegt, auch
 *                               wenn inzwischen umgeschaltet wurde.
 *
 * Damit ist ein Mischzustand (halb migriert) ein lauffähiger Zustand und kein
 * Sonderfall.
 *
 * ── Adapter-Schnittstelle ───────────────────────────────────────────────────
 *   name                                     Backend-Name ('onedrive' | 'nextcloud')
 *   label                                    Anzeigename
 *   capabilities                             deklarative Eigenschaften
 *   download(id, onProgress?)                → Buffer
 *   uploadNew(content, name, parentId)       → { id, webUrl, name }
 *   uploadContent(id, content)               → void
 *   move(id, destParentId, newName)          → { id, webUrl, name } (Datei oder Ordner)
 *   moveToTrash(id, trashName)               → { id, webUrl, name }
 *   remove(id)                               → void (Datei oder leerer Ordner)
 *   resolvePath(path)                        → { id, name }
 *   getPath(id)                              → string
 *   getRoot()                                → { id, name }  Nutzer-Speicher gesamt
 *   getAblageRoot()                          → { id, name }  Postbuch-Bereich darin
 *                                              (bei OneDrive identisch zu getRoot)
 *   createFolder(parentId, name)             → { id }
 *   findOrCreateFolder(parentId, name, {strict}) → { id, existed }
 *   listChildren(folderId)                   → [{ id, name, size, isFolder, … }]
 *   listAllFiles(folderId)                   → [{ id, name }]
 *   listAllFilesRecursive(rootId)            → [{ id, name, parentId, size, webUrl, lastModified }]
 *   getMeta(id)                              → { id, name, parentId, lastModified, webUrl, size, isFolder, sha256? }
 *   looksLikeId(str)                         → boolean   formale Heuristik ID vs. Pfad
 *   isValidId(str)                           → boolean   verbindliche ID-Prüfung
 *
 * Optional, nur bei pfadbasierten Backends (Nextcloud):
 *   leseAblageWurzelPfad()                   → string   '' = keine Grenze über getRoot() hinaus
 *   merkeAblageWurzelPfad(pfad)              → string   setzt die Pfadgrenze
 * Geschrieben wird sie ausschließlich von der Ordner-Initialisierung: Die
 * Grenze IST der Ordner, in dem die Struktur liegt. Ein zweiter Ort mit
 * Schreibrecht führt zwangsläufig zu einer Grenze ohne Inhalt.
 *
 * Zwei Zusagen, auf die sich JEDER Aufrufer verlassen darf:
 *
 *   • **Namen werden adapterseitig normalisiert.** Dateinamen stammen aus
 *     LLM-Ausgaben, dem X-Filename-Header, Archiv-Importen und dem Backend
 *     selbst — also aus fremdbestimmten Quellen. Der Adapter saniert jedes
 *     Pfadsegment (lib/storage/paths.js), keine Aufrufstelle muss das tun.
 *   • **Der tatsächlich vergebene Name steht im Rückgabewert.** Bei einer
 *     Namenskollision weicht der Adapter auf „Name (2)" aus. Wer den Namen
 *     nach storage_filename schreibt, MUSS `name` aus dem Ergebnis nehmen und
 *     nicht seinen Wunschnamen — sonst zeigt die DB auf einen Namen, den es so
 *     nicht gibt.
 *
 * Backend-spezifisches (OAuth-Flow, Token-Keep-Alive, Login-Flow v2) steht
 * bewusst NICHT im Interface — diese Funktionen importiert der jeweilige
 * Aufrufer direkt aus dem Adapter-Modul.
 */

import * as onedrive from './onedrive.js';
import * as nextcloud from './nextcloud.js';
import { loadDynamicSettings, getActiveBackendName } from '../../config.js';

const ADAPTERS = {
  onedrive,
  nextcloud,
};

/** Namen aller verfügbaren Backends. */
export const BACKENDS = Object.keys(ADAPTERS);

/**
 * Adapter zu einem Backend-Namen.
 * @param {string|null|undefined} backendName  Default 'onedrive' (Bestandszeilen
 *   ohne Marker stammen immer von dort).
 */
export function getAdapter(backendName) {
  const key = backendName || 'onedrive';
  const adapter = ADAPTERS[key];
  if (!adapter) {
    throw new Error(`Unbekanntes Ablage-Backend: "${key}"`);
  }
  return adapter;
}

/** Name des aktiven Backends laut _settings. */
export async function getActiveBackend() {
  const settings = await loadDynamicSettings();
  return getActiveBackendName(settings);
}

/** Adapter des aktiven Backends — für alles, was neu abgelegt wird. */
export async function getActiveAdapter() {
  return getAdapter(await getActiveBackend());
}

/**
 * Adapter des aktiven Backends, wenn die Settings beim Aufrufer schon geladen
 * sind (spart eine DB-Abfrage).
 */
export function getActiveAdapterFor(settings) {
  return getAdapter(getActiveBackendName(settings));
}

/**
 * Werte für die Legacy-Spalten onedrive_id / onedrive_filename /
 * onedrive_modified auf postbuch.postbuch.
 *
 * Diese Spalten stehen seit 1.7.1 nur noch als Rückweg da: sie erlauben, den
 * Code auf einen Stand VOR der Storage-Abstraktion zurückzurollen, der
 * `onedrive_*` liest und OneDrive annimmt. Genau deshalb gilt die Regel:
 *
 *   Die onedrive_*-Spalten beschreiben genau dann etwas, wenn dort
 *   tatsächlich eine OneDrive-Datei liegt.
 *
 * Eine Nextcloud-Fileid in onedrive_id wäre nicht bloß eine kosmetische
 * Unwahrheit — sie macht den Rückweg unbrauchbar, weil ein zurückgerollter
 * Stand diese IDs gegen Microsoft Graph auflösen würde. Bei jedem anderen
 * Backend liefert dieser Helfer deshalb null.
 *
 * Gilt NUR für postbuch.postbuch. In _failed_documents ist onedrive_id
 * Primärschlüssel und in _pipeline_suspensions Identität — dort wird
 * weiterhin die echte ID des jeweiligen Backends geschrieben, sonst bräche
 * der Retry-Pfad.
 *
 * @param {string|null} backend  Backend der Datei
 * @param {{id?: string|null, name?: string|null, modified?: any}} werte
 * @returns {{id: string|null, name: string|null, modified: any}}
 */
export function legacyOnedriveWerte(backend, { id = null, name = null, modified = null } = {}) {
  if ((backend || 'onedrive') !== 'onedrive') {
    return { id: null, name: null, modified: null };
  }
  return { id, name, modified };
}
