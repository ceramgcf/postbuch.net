/**
 * Räumt nach der LxD-Dateireorganisation die früheren flachen Dokumentordner auf.
 *
 * Sicherheitsregeln:
 * - nur die fest bekannte Legacy-Key-Allowlist wird betrachtet;
 * - kein Cleanup solange Dokumente des Backends noch kein L/D besitzen;
 * - nur direkte Kinder derselben Postbuch-Wurzel werden verändert;
 * - IDs, die auch ein System-, Lebensbereichs- oder LxD-Key nutzt, bleiben physisch;
 * - nur nachweislich leere Ordner werden gelöscht, jeder nicht leere wird mit # markiert.
 */
import db from '../db.js';
import { loadDynamicSettings, getActiveBackendName, getFolders, getAblageEbenen } from '../config.js';
import { istStrukturSchluessel, gehoertZurStruktur } from './storage-setup.js';
import { getAdapter } from '../lib/storage/index.js';
import { appLog } from '../app-log.js';
import { fuerJedesBegrenzt } from '../lib/parallel.js';

// Gleichzeitige Prüf-/Löschvorgänge je Ordnerebene beim Aufräumen.
const AUFRAEUMEN_PARALLEL = 3;

export const LEGACY_DOCUMENT_FOLDER_KEYS = Object.freeze([
  'Arztrechnung', 'Laborrechnung', 'Rezept', 'Hilfsmittelrechnung',
  'Erstattungsbescheid', 'Arztbericht', 'Handwerkerrechnung', 'Rechnung',
  'Kaufbeleg', 'Vertrag', 'Angebot', 'Auto', 'Wohnen', 'Vorsorge',
  'Finanzen', 'Versorgung', 'Jobunterlage', 'Ausbildung', 'Freizeit',
  'Tier', 'Staatliches', 'Sonstiges',
]);

async function entferneVerarbeiteteLegacyKeys(backend, keys) {
  if (!keys.length) return;
  await db.query(
    `UPDATE postbuch._settings
        SET value = jsonb_set(value, ARRAY[$1::text],
                    COALESCE(value->$1::text, '{}'::jsonb) - $2::text[], false),
            updated_at = NOW()
      WHERE key = 'storage_folders'`,
    [backend, keys],
  );
}

/**
 * @param {{backendName?: string, dryRun?: boolean}} options
 */
export async function cleanupLegacyDocumentFolders({ backendName, dryRun = false } = {}) {
  const settings = await loadDynamicSettings();
  const backend = backendName || getActiveBackendName(settings);
  const folders = getFolders(settings, backend);
  const storage = getAdapter(backend);
  const legacySet = new Set(LEGACY_DOCUMENT_FOLDER_KEYS);
  const legacyEntries = Object.entries(folders).filter(([key, id]) => legacySet.has(key) && id);

  const summary = {
    backend, dryRun, blocked: false, deleted: 0, marked: 0,
    alreadyMarked: 0, shared: 0, skipped: 0, errors: 0,
    configKeysRemoved: 0, items: [],
  };
  if (!legacyEntries.length) return summary;

  // Ein Fremdsystem darf den neuen Code vor seiner eigenen LxD-Migration
  // installieren. In diesem Zustand bleiben Altordner und Aliase unangetastet.
  const offen = await db.query(
    `SELECT count(*)::int AS anzahl
       FROM postbuch.postbuch
      WHERE COALESCE(storage_backend, 'onedrive') = $1
        AND (lebensbereich IS NULL OR dokumentart IS NULL)`,
    [backend],
  );
  if (Number(offen.rows[0].anzahl) > 0) {
    summary.blocked = true;
    summary.reason = `${offen.rows[0].anzahl} Dokument(e) ohne vollständige LxD-Zuordnung`;
    appLog('WARN', 'legacy-folder-cleanup', `Cleanup für ${backend} blockiert: ${summary.reason}`);
    return summary;
  }

  // Alle nicht-legacy Schlüssel schützen. Das fängt insbesondere physisch
  // gemeinsam genutzte IDs wie Tier/tier oder Wohnen/wohnen ab.
  const protectedIds = new Set(
    Object.entries(folders)
      .filter(([key, id]) => !legacySet.has(key) && id)
      .map(([, id]) => id),
  );

  const anchorIds = [folders.inbox, folders.failed, folders.trash]
    .concat(Object.entries(folders).filter(([key]) => !legacySet.has(key) && !key.includes('/')).map(([, id]) => id))
    .filter(Boolean);
  let rootId = null;
  for (const id of [...new Set(anchorIds)]) {
    try {
      const meta = await storage.getMeta(id);
      if (meta?.isFolder && meta.parentId) { rootId = meta.parentId; break; }
    } catch { /* nächsten sicheren Anker versuchen */ }
  }
  if (!rootId) {
    summary.blocked = true;
    summary.reason = 'Postbuch-Wurzel konnte nicht sicher aus aktuellen Ordnern bestimmt werden';
    appLog('ERROR', 'legacy-folder-cleanup', `Cleanup für ${backend} blockiert: ${summary.reason}`);
    return summary;
  }

  let rootChildren;
  try {
    rootChildren = await storage.listChildren(rootId);
  } catch (err) {
    summary.blocked = true;
    summary.reason = `Postbuch-Wurzel nicht lesbar: ${err.message}`;
    appLog('ERROR', 'legacy-folder-cleanup', `Cleanup für ${backend} blockiert: ${summary.reason}`);
    return summary;
  }
  const rootNames = new Set(rootChildren.map((item) => item.name));

  // Mehrere Legacy-Keys dürfen dieselbe physische ID referenzieren.
  const byId = new Map();
  for (const [key, id] of legacyEntries) {
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(key);
  }
  const processedKeys = [];

  for (const [id, keys] of byId) {
    if (protectedIds.has(id)) {
      summary.shared++;
      summary.items.push({ keys, id, action: 'shared-current-folder' });
      processedKeys.push(...keys);
      continue;
    }

    try {
      const meta = await storage.getMeta(id);
      if (!meta?.isFolder) throw new Error('Konfigurierte ID ist kein Ordner');
      if (meta.parentId !== rootId) {
        summary.skipped++;
        summary.items.push({ keys, id, name: meta.name, action: 'skipped-outside-root' });
        appLog('WARN', 'legacy-folder-cleanup', `Legacy-ID ${id} (${meta.name}) liegt außerhalb der Postbuch-Wurzel — unangetastet`);
        continue;
      }

      const children = await storage.listChildren(id);
      if (children.length === 0) {
        summary.items.push({ keys, id, name: meta.name, action: dryRun ? 'would-delete-empty' : 'deleted-empty' });
        if (!dryRun) await storage.remove(id);
        summary.deleted++;
        processedKeys.push(...keys);
        continue;
      }

      if (meta.name.startsWith('#')) {
        summary.alreadyMarked++;
        summary.items.push({ keys, id, name: meta.name, children: children.length, action: 'already-marked' });
        processedKeys.push(...keys);
        continue;
      }

      let markedName = `#${meta.name}`;
      let suffix = 2;
      while (rootNames.has(markedName)) markedName = `#${meta.name} (Altbestand ${suffix++})`;
      summary.items.push({ keys, id, name: meta.name, markedName, children: children.length, action: dryRun ? 'would-mark-nonempty' : 'marked-nonempty' });
      if (!dryRun) await storage.move(id, rootId, markedName);
      summary.marked++;
      rootNames.add(markedName);
      processedKeys.push(...keys);
    } catch (err) {
      summary.errors++;
      summary.items.push({ keys, id, action: 'error', error: err.message });
      appLog('ERROR', 'legacy-folder-cleanup', `Legacy-Ordner ${keys.join('/')} (${id}) blieb unangetastet: ${err.message}`);
    }
  }

  if (!dryRun) {
    await entferneVerarbeiteteLegacyKeys(backend, [...new Set(processedKeys)]);
    summary.configKeysRemoved = new Set(processedKeys).size;
  }
  appLog(summary.errors ? 'WARN' : 'INFO', 'legacy-folder-cleanup',
    `Legacy-Ordner ${backend}: gelöscht=${summary.deleted}, markiert=${summary.marked}, geteilt=${summary.shared}, Fehler=${summary.errors}`);
  return summary;
}

/**
 * Räumt nach einem Wechsel der Ablagestruktur die Ordner früherer Strukturen
 * auf: alle Strukturschlüssel (Lebensbereich, Dokumentart, Person, Jahr,
 * Richtung in beliebiger Folge), die nicht zur Kette der aktiven Struktur
 * gehören. System- und Legacy-Schlüssel bleiben unberührt.
 *
 * Sicherheitsregeln wie oben: nur Ordner aus dem eigenen Cache, von unten nach
 * oben, nur nachweislich leere Ordner werden gelöscht. Nicht leere bleiben
 * unangetastet stehen und werden gemeldet – sie enthalten dann Dateien, die
 * nicht von postbuch.net stammen. IDs, die auch ein Schlüssel der aktiven
 * Struktur nutzt, bleiben physisch erhalten.
 *
 * @param {{backendName?: string, taxonomie: {lebensbereiche: Array<{code:string}>, dokumentarten: Array<{code:string}>}}} options
 */
export async function raeumeFremdeStrukturAuf({ backendName, taxonomie }) {
  const settings = await loadDynamicSettings();
  const istStruktur = istStrukturSchluessel(taxonomie);
  const aktiv = gehoertZurStruktur(getAblageEbenen(settings), taxonomie);
  return raeumeOrdnerAuf({
    backendName,
    istZiel: (key) => istStruktur(key) && !aktiv(key),
  });
}

/**
 * Löscht die Ordner aller Cache-Schlüssel, auf die istZiel zutrifft, von unten
 * nach oben – nur nachweislich leere. Schlüssel gelöschter oder nicht mehr
 * vorhandener Ordner werden entfernt; nicht leere Ordner bleiben samt
 * Schlüssel stehen und werden gemeldet.
 *
 * @param {{backendName?: string, istZiel: (key:string) => boolean}} options
 */
export async function raeumeOrdnerAuf({ backendName, istZiel }) {
  const settings = await loadDynamicSettings();
  const backend = backendName || getActiveBackendName(settings);
  const folders = getFolders(settings, backend);
  const storage = getAdapter(backend);

  const ziele = Object.entries(folders).filter(([key, id]) => id && istZiel(key));
  const geschuetzt = new Set(Object.entries(folders).filter(([key, id]) => id && !istZiel(key)).map(([, id]) => id));
  // Von unten nach oben: Eine Ebene wird erst angefasst, wenn alle tieferen
  // fertig sind. Innerhalb einer Ebene sind die Ordner voneinander unabhängig
  // und werden begrenzt parallel geprüft und gelöscht. Schlüssel derselben
  // Ebene mit derselben ID bilden einen Vorgang, sonst liefe die zweite
  // Löschung ins Leere.
  const ebenen = new Map();
  for (const [key, id] of ziele) {
    const tiefe = key.split('/').length;
    if (!ebenen.has(tiefe)) ebenen.set(tiefe, new Map());
    const ebene = ebenen.get(tiefe);
    if (!ebene.has(id)) ebene.set(id, []);
    ebene.get(id).push(key);
  }

  const summary = { backend, deleted: 0, kept: 0, errors: 0, items: [] };
  const entfernen = [];
  const raeumeEinen = async ([id, keys]) => {
    const key = keys.join(', ');
    if (geschuetzt.has(id)) { entfernen.push(...keys); return; }
    try {
      let children;
      try {
        children = await storage.listChildren(id);
      } catch (err) {
        if (err?.status === 404 || err?.statusCode === 404) { entfernen.push(...keys); return; }
        throw err;
      }
      if (children.length === 0) {
        await storage.remove(id);
        summary.deleted++;
        entfernen.push(...keys);
      } else {
        summary.kept++;
        summary.items.push({ key, id, children: children.length, action: 'kept-nonempty' });
        appLog('WARN', 'ablage-struktur', `Ordner ${key} ist nicht leer (${children.length} Einträge) und bleibt stehen`);
      }
    } catch (err) {
      summary.errors++;
      summary.items.push({ key, id, action: 'error', error: err.message });
      appLog('ERROR', 'ablage-struktur', `Ordner ${key} (${id}) blieb unangetastet: ${err.message}`);
    }
  };
  for (const tiefe of [...ebenen.keys()].sort((a, b) => b - a)) {
    await fuerJedesBegrenzt([...ebenen.get(tiefe)], AUFRAEUMEN_PARALLEL, raeumeEinen);
  }
  await entferneVerarbeiteteLegacyKeys(backend, entfernen);
  appLog(summary.errors ? 'WARN' : 'INFO', 'ablage-struktur',
    `Ordner aufgeräumt (${backend}): gelöscht=${summary.deleted}, belassen=${summary.kept}, Fehler=${summary.errors}`);
  return summary;
}
