/**
 * service/ablage-sollort.js — ein Dokument an seinen Sollort in der Ablage bringen
 *
 * Der Sollort folgt aus den DB-Achsen der Zeile (Lebensbereich, Dokumentart
 * und bei Personenablage familienmitglied). Aufrufer ändern zuerst die Zeile
 * und rufen danach verschiebeAnSollort() auf: Typwechsel, Änderung des
 * Familienmitglieds, Löschen eines Menschen.
 *
 * Die Datei behält beim Verschieben ihre Item-ID; gespeicherte IDs bleiben gültig.
 * Ein Fehlschlag lässt die Datei am alten Ort – sie bleibt über ihre ID
 * erreichbar, und der nächste Gesamtumzug holt sie nach.
 */
import pool from '../db.js';
import { getAdapter } from '../lib/storage/index.js';
import { loadDynamicSettings, getAblageStruktur } from '../config.js';
import { ensureAblageOrdner, entfernePersonenSchluessel, personSchluessel } from './storage-setup.js';
import { raeumeOrdnerAuf } from './storage-legacy-cleanup.js';
import { appLog } from '../app-log.js';

/**
 * @param {string} postid
 * @param {object} [settings]  bereits geladene Settings
 * @returns {Promise<{moved:boolean, newWebUrl:string|null}>}
 */
export async function verschiebeAnSollort(postid, settings = null) {
  const r = await pool.query(
    `SELECT storage_id, storage_backend, lebensbereich, dokumentart, familienmitglied
       FROM postbuch.postbuch WHERE postid = $1`,
    [postid],
  );
  const row = r.rows[0];
  if (!row?.storage_id || !row.lebensbereich || !row.dokumentart) return { moved: false, newWebUrl: null };

  const s = settings || await loadDynamicSettings();
  const folderId = await ensureAblageOrdner(s, row, row.storage_backend);
  const storage = getAdapter(row.storage_backend);
  const meta = await storage.getMeta(row.storage_id);
  if (meta.parentId === folderId) return { moved: false, newWebUrl: null };

  const moved = await storage.move(row.storage_id, folderId, meta.name);
  if (moved.webUrl) {
    await pool.query('UPDATE postbuch.postbuch SET link = $1 WHERE postid = $2', [moved.webUrl, postid]);
  }
  appLog('INFO', 'ablage', `${postid} an Sollort verschoben`, { entity: 'postbuch', entityId: postid });
  return { moved: true, newWebUrl: moved.webUrl || null };
}

/**
 * Nachlauf zum Löschen eines Menschen: Bei Personenablage wandern seine
 * verbliebenen Dokumente (familienmitglied bereits NULL) nach „Gemeinsam“.
 * Danach werden seine Personenordner in allen Backends gelöscht, soweit sie
 * leer sind, und seine Cache-Schlüssel entfernt. Ein nicht leerer Ordner
 * bleibt physisch stehen. Best effort: Fehler landen im Log.
 *
 * @param {{menschId:string, kurzname:string, ohnePerson:string[]}} p
 */
export async function raeumeAblageNachLoeschung({ menschId, kurzname, ohnePerson }) {
  const settings = await loadDynamicSettings();
  let fehler = 0;
  if (getAblageStruktur(settings) === 'person_lxd') {
    for (const postid of ohnePerson) {
      try {
        await verschiebeAnSollort(postid, settings);
      } catch (err) {
        fehler++;
        appLog('WARN', 'ablage', `${postid} nicht nach Gemeinsam verschoben: ${err.message}`, { entity: 'postbuch', entityId: postid });
      }
    }
  }
  const praefix = personSchluessel(menschId);
  const backends = Object.entries(settings.storage_folders || {})
    .filter(([, f]) => f && Object.keys(f).some((k) => k === praefix || k.startsWith(`${praefix}/`)))
    .map(([b]) => b);
  // Solange Dateien nicht umgezogen sind, bleibt der Ordner samt Schlüssel stehen.
  if (fehler === 0) {
    for (const backendName of backends) {
      try {
        await raeumeOrdnerAuf({ backendName, istZiel: (k) => k === praefix || k.startsWith(`${praefix}/`) });
      } catch (err) {
        appLog('WARN', 'ablage', `Personenordner ${kurzname} (${backendName}) nicht aufgeräumt: ${err.message}`);
      }
    }
    await entfernePersonenSchluessel(menschId);
  }
}

/**
 * Benennt den Personenordner eines Menschen nach einer Kurzname-Änderung in
 * allen Backends um. Die Dateien bleiben, wo sie sind: Der Cache hängt an der
 * mensch.id, nicht am Namen. Best effort – schlägt es fehl, stimmt nur der
 * sichtbare Ordnername nicht; die Ablage funktioniert weiter.
 */
export async function benennePersonenordnerUm(menschId, neuerKurzname) {
  const settings = await loadDynamicSettings();
  const schluessel = personSchluessel(menschId);
  for (const [backendName, folders] of Object.entries(settings.storage_folders || {})) {
    const folderId = folders?.[schluessel];
    if (!folderId) continue;
    try {
      const storage = getAdapter(backendName);
      const meta = await storage.getMeta(folderId);
      if (meta.name === neuerKurzname) continue;
      const ergebnis = await storage.move(folderId, meta.parentId, neuerKurzname);
      if (ergebnis.name && ergebnis.name !== neuerKurzname) {
        appLog('WARN', 'ablage', `Personenordner heißt „${ergebnis.name}“ statt „${neuerKurzname}“ (${backendName}): Name war belegt`);
      } else {
        appLog('INFO', 'ablage', `Personenordner in „${neuerKurzname}“ umbenannt (${backendName})`);
      }
    } catch (err) {
      appLog('WARN', 'ablage', `Personenordner nicht in „${neuerKurzname}“ umbenannt (${backendName}): ${err.message}`);
    }
  }
}
