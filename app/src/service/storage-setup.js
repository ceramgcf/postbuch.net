/**
 * service/storage-setup.js — Ordnerstruktur-Assistent (backend-agnostisch)
 *
 * Erstellt die komplette postbuch-Ordnerstruktur im aktiven Ablage-Backend und
 * speichert alle Ordner-IDs in _settings.storage_folders[<backend>].
 *
 * Die Systemordner-Definition ist für alle Backends dieselbe; das
 * Anlegen läuft ausschließlich über adapter.findOrCreateFolder(…, {strict:true}).
 *
 * Sicherheitsregel: Bereits vorhandene Ordner werden NIEMALS überschrieben
 * oder gelöscht. Es wird nur die ID aus dem vorhandenen Ordner gelesen.
 */

import db from '../db.js';
import { loadDynamicSettings, getActiveBackendName, getFolders, getAblageStruktur } from '../config.js';
import { getAdapter } from '../lib/storage/index.js';
import { getAktiveTaxonomie, getGesamteTaxonomie } from '../lib/taxonomie.js';
import { appLog } from '../app-log.js';

/**
 * Systemordner-Definition. L-Ordner stammen aus der Taxonomie, D-Ordner werden
 * bei der ersten Belegung einer L×D-Zelle automatisch angelegt.
 * Bei System-Ordnern können mehrere Keys denselben physischen Ordner
 * referenzieren (z. B. inbox + directscan).
 * folder: Name des Ordners, der unter rootPath erstellt wird.
 * Es ist erlaubt, verschiedenen Einträgen dieselbe folder-ID manuell zuzuweisen,
 * aber der Assistent legt pro folder-Eintrag einen eigenen Ordner an.
 */
export const SYSTEM_FOLDERS = [
  // ── System-Ordner (mehrere Keys → gleicher physischer Ordner) ─────────────
  { folder: '_inbox',             keys: ['inbox', 'directscan'], description: 'Eingangsordner für neue Scans' },
  { folder: '_failed',            keys: ['failed'],            description: 'Fehlgeschlagene Verarbeitungen' },
  { folder: '_suspended',         keys: ['suspended'],         description: 'Pausierte Dokumente mit offenem Duplikat-Verdacht' },
  { folder: '_trash',             keys: ['trash'],             description: 'Papierkorb / Duplikate' },
  { folder: '_backup',            keys: ['backup'],            description: 'Datenbankbackups' },
  { folder: '_abrechnung_merged', keys: ['abrechnungMerged', 'abrechnung'], description: 'Zusammengeführte Abrechnungs-PDFs' },
  { folder: '_debug',             keys: ['debug'],                          description: 'KI-Pipeline-Debuglogs (nur bei aktiviertem Debug-Modus)' },
];

/**
 * Hauptfunktion: Erstellt alle Ordner unter rootFolderPath im angegebenen
 * Backend und speichert die IDs in _settings.storage_folders[<backend>].
 *
 * @param {string} rootFolderPath  Pfad des Root-Ordners (z. B. "/postbuch" oder "postbuch")
 * @param {string} [backendName]   Backend; Default: das aktive
 * @param {(fortschritt:{schritt:number,gesamt:number,name:string})=>void} [onProgress]
 * @returns {Array<{ folder, id, existed, keys }>}  Status für jeden Ordner
 */
export async function setupFolderStructure(rootFolderPath, backendName, onProgress) {
  const settings = await loadDynamicSettings();
  const backend = backendName || getActiveBackendName(settings);
  const adapter = getAdapter(backend);

  // 1) Root-Ordner auflösen (erstellen oder vorhandenen nehmen).
  // Der Pfad kann mehrstufig sein (z. B. "archiv/postbuch") → segmentweise.
  const cleanRoot = rootFolderPath.replace(/^\/+/, '').replace(/\/+$/, '') || 'postbuch';
  const segments = cleanRoot.split('/').filter(Boolean);

  // Bei Personenablage liegen die Lebensbereiche unter den Personenordnern und
  // werden dort lazy angelegt; an der Wurzel stünden sie nur leer herum.
  const personenablage = getAblageStruktur(settings) === 'person_lxd';
  const taxonomie = await getAktiveTaxonomie();
  const lebensbereiche = personenablage ? [] : taxonomie.lebensbereiche;
  const gesamt = segments.length + SYSTEM_FOLDERS.length + lebensbereiche.length;
  let schritt = 0;
  const melde = (name) => onProgress?.({ schritt: ++schritt, gesamt, name });

  const root = await adapter.getRoot();
  let currentParentId = root.id;
  for (const seg of segments) {
    const { id } = await adapter.findOrCreateFolder(currentParentId, seg, { strict: true });
    currentParentId = id;
    melde(seg);
  }
  const rootFolderId = currentParentId;

  // 2) Stabile System- und Lebensbereichsordner erstellen. Bestehende flache
  // Dokumenttyp-Keys bleiben in storage_folders unangetastet und dienen bis
  // zur Reorganisation weiterhin dem Legacy-Pfad.
  const results = [];
  for (const def of SYSTEM_FOLDERS) {
    const { id, existed } = await adapter.findOrCreateFolder(rootFolderId, def.folder, { strict: true });
    results.push({ folder: def.folder, id, existed, keys: def.keys });
    melde(def.folder);
  }
  for (const lebensbereich of lebensbereiche) {
    const { id, existed } = await adapter.findOrCreateFolder(rootFolderId, lebensbereich.label, { strict: true });
    results.push({ folder: lebensbereich.label, id, existed, keys: [lebensbereich.code] });
    melde(lebensbereich.label);
  }

  // 3) IDs in _settings speichern — nur der Teilbaum des eigenen Backends,
  //    bereits konfigurierte Keys bleiben erhalten.
  const patch = {};
  for (const r of results) {
    for (const key of r.keys) {
      patch[key] = r.id;
    }
  }
  await saveFolderIds(backend, patch, settings);

  // 4) Pfadgrenze des Backends nachziehen. Backends mit Pfad-Ortsmodell
  //    (Nextcloud) grenzen ID-aufgelöste Zugriffe zusätzlich auf den
  //    Postbuch-Wurzelordner ein. Diese Grenze ist kein zweiter, frei
  //    einstellbarer Wert, sondern genau der Ordner, in dem die Struktur
  //    gerade angelegt wurde — sonst laufen beide auseinander und jede
  //    Pfadprüfung schlägt fehl.
  if (typeof adapter.merkeAblageWurzelPfad === 'function') {
    await adapter.merkeAblageWurzelPfad(cleanRoot);
  }

  return results;
}

/**
 * Gleicht die gespeicherte Pfadgrenze mit dem tatsächlichen Wurzelordner ab
 * und korrigiert sie, wenn sie auseinanderlaufen.
 *
 * Nötig für Instanzen, auf denen die Grenze aus einer früheren Version stammt,
 * in der sie getrennt von der Ordneranlage gepflegt wurde. Wahrheit ist immer
 * der Ordner, in dem die Struktur wirklich liegt (ermittleWurzelPfad); die
 * gespeicherte Grenze ist nur dessen Zwischenspeicher.
 *
 * Ist das Backend gerade nicht erreichbar oder noch nichts eingerichtet,
 * passiert nichts — dann liefert ermittleWurzelPfad() null und ein Raten wäre
 * schlimmer als Nichtstun.
 *
 * @param {string} [backendName]  Backend; Default: das aktive
 * @returns {Promise<{vorher: string, nachher: string}|null>}  null = nichts zu tun
 */
export async function heileAblageWurzel(backendName) {
  const settings = await loadDynamicSettings();
  const backend = backendName || getActiveBackendName(settings);
  const adapter = getAdapter(backend);
  if (typeof adapter.merkeAblageWurzelPfad !== 'function'
      || typeof adapter.leseAblageWurzelPfad !== 'function') return null;

  const tatsaechlich = await ermittleWurzelPfad(backend);
  if (tatsaechlich === null) return null;

  const gespeichert = await adapter.leseAblageWurzelPfad();
  if (gespeichert === tatsaechlich) return null;

  await adapter.merkeAblageWurzelPfad(tatsaechlich);
  appLog('WARN', 'storage',
    `Pfadgrenze der Ablage korrigiert (${backend}): "${gespeichert}" → "${tatsaechlich}". `
    + 'Die Ordnerstruktur liegt nicht unter dem bisher eingetragenen Ordner.');
  return { vorher: gespeichert, nachher: tatsaechlich };
}

/**
 * Ermittelt den aktuell konfigurierten Wurzelordner-Pfad eines Backends.
 *
 * Der Pfad selbst wird nirgends gespeichert — persistiert sind nur die
 * Ordner-IDs in _settings.storage_folders[<backend>]. Er wird deshalb aus einem
 * bereits konfigurierten Systemordner zurückgerechnet: dessen Pfad minus das
 * letzte Segment ist genau der Wert, den setupFolderStructure() als
 * rootFolderPath erwartet (beide Adapter liefern getPath() relativ zu dem
 * getRoot(), von dem auch die Ordneranlage ausgeht).
 *
 * Das ist die einzige verlässliche Quelle für die Vorbelegung des
 * Setup-Assistenten. Eine feste Vorgabe wie "postbuch" wäre auf jeder Instanz
 * mit abweichendem Wurzelordner schlicht falsch — und der Assistent zieht
 * anschließend alle Dokumente dorthin um.
 *
 * @param {string} [backendName]  Backend; Default: das aktive
 * @returns {Promise<string|null>}  z. B. "postbuch_testinstanz", oder null,
 *                                  wenn (noch) nichts konfiguriert bzw. der
 *                                  Ordner nicht mehr auflösbar ist
 */
export async function ermittleWurzelPfad(backendName) {
  const settings = await loadDynamicSettings();
  const backend = backendName || getActiveBackendName(settings);
  const folders = getFolders(settings, backend);

  // Nur Systemordner: sie liegen garantiert direkt unter dem Wurzelordner.
  // Lebensbereichs- und L/D-Ordner tun das nicht (bzw. nicht auf einer Ebene).
  for (const def of SYSTEM_FOLDERS) {
    const id = def.keys.map((k) => folders[k]).find(Boolean);
    if (!id) continue;
    try {
      const pfad = await getAdapter(backend).getPath(id);
      const segmente = String(pfad || '').split('/').filter(Boolean);
      if (segmente.pop() !== def.folder) continue;   // Ordner umbenannt/verschoben
      return segmente.join('/');                     // "" = direkt in der Wurzel
    } catch {
      // Ordner gelöscht oder Backend gerade nicht erreichbar → nächsten versuchen
    }
  }
  return null;
}

/**
 * Schreibt Ordner-IDs nach _settings.storage_folders[<backend>].
 * Nur die übergebenen Keys werden gesetzt; alles andere bleibt stehen — auch
 * die Ordner des jeweils anderen Backends (jsonb-Merge auf oberster Ebene).
 *
 * @param {string} backend            Backend-Name
 * @param {Record<string,string>} patch  { folderKey: id, … }
 * @param {object} [settings]         bereits geladene Settings (spart eine Abfrage)
 */
export async function saveFolderIds(backend, patch) {
  if (!patch || typeof patch !== 'object' || Object.keys(patch).length === 0) return {};
  await db.query(
    `INSERT INTO postbuch._settings AS s (key, value, updated_at)
     VALUES ('storage_folders', jsonb_build_object($1::text, $2::jsonb), NOW())
     ON CONFLICT (key) DO UPDATE
       SET value = jsonb_set(COALESCE(s.value, '{}'::jsonb), ARRAY[$1::text],
                    COALESCE(s.value->$1::text, '{}'::jsonb) || $2::jsonb, true),
           updated_at = NOW()`,
    [backend, JSON.stringify(patch)]
  );
  return patch;
}

/**
 * Legt den fehlenden Leaf-Ordner einer gültigen LxD-Zelle lazy und race-sicher an.
 *
 * @param {{force?:boolean}} [opts]  force=true überspringt die Cache-Treffer und
 *   löst L- und Leaf-Ordner ab der AKTUELLEN Wurzel neu auf. Gebraucht vom
 *   Gesamtumzug nach einem Wurzelordner- oder Strukturwechsel: gecachte L- und
 *   L×D-Keys können dann noch auf ihren alten (dort weiterhin gültigen) Ort
 *   zeigen – etwa ein L-Ordner, der beim Aufräumen wegen fremder Inhalte
 *   stehen blieb. Ohne Erzwingen würde relocateAllDocuments() solche Zellen
 *   fälschlich als "schon am richtigen Ort" behandeln.
 */
export async function ensureFolderId(settings, lebensbereichCode, dokumentartCode, backendName, opts = {}) {
  if (typeof lebensbereichCode !== 'string' || typeof dokumentartCode !== 'string') {
    throw new Error('Ablageziel braucht Lebensbereich und Dokumentart.');
  }
  const backend = backendName || getActiveBackendName(settings);
  const key = `${lebensbereichCode}/${dokumentartCode}`;
  const folders = getFolders(settings, backend);
  if (folders[key] && !opts.force) return folders[key];

  // Bestandsdokumente duerfen weiterhin in Taxonomie-Zellen liegen, die erst
  // nach ihrer Ablage deaktiviert wurden. Nur der Setup-Wizard und die neue
  // Klassifikation arbeiten aktiv-only; die Ordneraufloesung braucht alle.
  const taxonomie = await getGesamteTaxonomie();
  const lebensbereich = taxonomie.lebensbereiche.find((x) => x.code === lebensbereichCode);
  const dokumentart = taxonomie.dokumentarten.find((x) => x.code === dokumentartCode);
  if (!lebensbereich || !dokumentart) throw new Error(`Unbekannte LxD-Zelle "${key}".`);

  const adapter = getAdapter(backend);
  let lFolderId = opts.force ? null : folders[lebensbereichCode];
  if (!lFolderId) {
    const anchorId = folders.inbox || folders.failed || folders.suspended || folders.trash;
    if (!anchorId) throw new Error(`Ablage für Backend "${backend}" ist noch nicht eingerichtet.`);
    const anchor = await adapter.getMeta(anchorId);
    const created = await adapter.findOrCreateFolder(anchor.parentId, lebensbereich.label, { strict: true });
    lFolderId = created.id;
    await saveFolderIds(backend, { [lebensbereichCode]: lFolderId });
  }
  // OneDrive verbietet u.a. Schrägstriche, die in lesbaren Taxonomie-Labels
  // fachlich sinnvoll sein können. Der technische Ordnername bleibt stabil,
  // die Anzeige in der App kommt weiterhin aus der unveränderten Taxonomie.
  const folderName = ordnerName(dokumentart.label);
  const leaf = await adapter.findOrCreateFolder(lFolderId, folderName, { strict: true });
  await saveFolderIds(backend, { [key]: leaf.id });
  return leaf.id;
}

// ── Personenablage ────────────────────────────────────────────────────────────

/** Ordner für Dokumente ohne Familienmitglied bei Personenablage. */
export const GEMEINSAM_ORDNER = 'Gemeinsam';

/**
 * Cache-Schlüssel der Personenablage in storage_folders[<backend>]. Eigener
 * Namensraum mit `@`, damit er nie mit einem LxD-Schlüssel `<L>/<D>` oder einem
 * Systemordner-Schlüssel verwechselt wird. Die Person hängt an der Mensch-UUID,
 * nicht am Kurznamen – eine Umbenennung ändert nur den Ordnernamen.
 */
export function personSchluessel(menschId) {
  return menschId ? `@${menschId}` : '@gemeinsam';
}

/**
 * Cache-Schlüssel des Blattordners für eine Dokumentzeile im aktuellen
 * Ablagemodus. Reine Funktion; menschId muss bereits aufgelöst sein.
 */
export function ablageSchluessel(settings, { lebensbereich, dokumentart, menschId }) {
  const zelle = `${lebensbereich}/${dokumentart}`;
  return getAblageStruktur(settings) === 'person_lxd' ? `${personSchluessel(menschId)}/${zelle}` : zelle;
}

/**
 * Löst familienmitglied (exakter Kurzname) auf die Mensch-UUID auf.
 * Kein Treffer oder kein familienmitglied → null (Sammelordner).
 */
export async function ermittlePerson(familienmitglied) {
  if (!familienmitglied) return null;
  const r = await db.query('SELECT id, kurzname FROM postbuch.mensch WHERE kurzname = $1', [familienmitglied]);
  return r.rows[0] ?? null;
}

/** OneDrive verbietet u. a. Schrägstriche in Ordnernamen. */
function ordnerName(label) {
  return String(label).replace(/[\\/:*?"<>|]/g, ' – ').replace(/\s{2,}/g, ' ').trim();
}

/**
 * Liefert (und legt lazy an) den Zielordner eines Dokuments im aktuellen
 * Ablagemodus. Einziger Einstieg für alle Ablagepfade (Pipeline, Import,
 * Typwechsel, PDF-Ersatz, Umzug, Backend-Migration).
 *
 * @param {object} settings
 * @param {{lebensbereich:string, dokumentart:string, familienmitglied?:string|null}} row
 * @param {string} [backendName]  Default: aktives Backend
 * @param {{force?:boolean}} [opts]  force=true löst die gesamte Kette ab der
 *   Wurzel neu auf, statt gecachten IDs zu vertrauen (nach Wurzelordner-Wechsel).
 */
export async function ensureAblageOrdner(settings, row, backendName, opts = {}) {
  if (getAblageStruktur(settings) !== 'person_lxd') {
    return ensureFolderId(settings, row.lebensbereich, row.dokumentart, backendName, opts);
  }
  const { lebensbereich: lCode, dokumentart: dCode } = row;
  if (typeof lCode !== 'string' || typeof dCode !== 'string') {
    throw new Error('Ablageziel braucht Lebensbereich und Dokumentart.');
  }
  const backend = backendName || getActiveBackendName(settings);
  const person = await ermittlePerson(row.familienmitglied);
  const pKey = personSchluessel(person?.id);
  const lKey = `${pKey}/${lCode}`;
  const leafKey = `${lKey}/${dCode}`;
  const folders = getFolders(settings, backend);
  if (folders[leafKey] && !opts.force) return folders[leafKey];

  const taxonomie = await getGesamteTaxonomie();
  const lebensbereich = taxonomie.lebensbereiche.find((x) => x.code === lCode);
  const dokumentart = taxonomie.dokumentarten.find((x) => x.code === dCode);
  if (!lebensbereich || !dokumentart) throw new Error(`Unbekannte LxD-Zelle "${lCode}/${dCode}".`);

  const adapter = getAdapter(backend);
  const anchorId = folders.inbox || folders.failed || folders.suspended || folders.trash;
  if (!anchorId) throw new Error(`Ablage für Backend "${backend}" ist noch nicht eingerichtet.`);

  const patch = {};
  const loese = async (key, parentId, name) => {
    if (folders[key] && !opts.force) return folders[key];
    const { id } = await adapter.findOrCreateFolder(parentId, ordnerName(name), { strict: true });
    // Dieselbe Ordner-ID unter einem anderen Schlüssel hieße: zwei logische
    // Ziele teilen sich einen physischen Ordner (z. B. Kurzname = Lebensbereich
    // nach späterer Umbenennung eines Labels). Lieber abbrechen als vermischen.
    const fremd = Object.entries(folders).find(([k, v]) => v === id && k !== key);
    if (fremd) {
      throw new Error(`Ordner "${name}" ist bereits als "${fremd[0]}" belegt – Namenskollision in der Ablage.`);
    }
    patch[key] = id;
    folders[key] = id;
    return id;
  };

  const rootId = (await adapter.getMeta(anchorId)).parentId;
  const personId = await loese(pKey, rootId, person ? person.kurzname : GEMEINSAM_ORDNER);
  const lId = await loese(lKey, personId, lebensbereich.label);
  const leafId = await loese(leafKey, lId, dokumentart.label);
  await saveFolderIds(backend, patch);
  return leafId;
}

/**
 * Entfernt alle Cache-Schlüssel einer Person (`@<uuid>…`) aus allen Backends.
 * Nach dem Löschen eines Menschen, damit ein später gleichnamig angelegter
 * Mensch nicht an der ID-Kollisionsprüfung scheitert.
 */
export async function entfernePersonenSchluessel(menschId) {
  if (!menschId) return;
  const praefix = personSchluessel(menschId);
  await db.query(
    `UPDATE postbuch._settings s
        SET value = (
              SELECT COALESCE(jsonb_object_agg(b.key, (
                       SELECT COALESCE(jsonb_object_agg(f.key, f.value), '{}'::jsonb)
                         FROM jsonb_each(b.value) f
                        WHERE f.key <> $1 AND f.key NOT LIKE $1 || '/%'
                     )), '{}'::jsonb)
                FROM jsonb_each(s.value) b
            ),
            updated_at = NOW()
      WHERE s.key = 'storage_folders'`,
    [praefix],
  );
}
