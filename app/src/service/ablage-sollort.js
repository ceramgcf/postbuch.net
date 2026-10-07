/**
 * service/ablage-sollort.js — ein Dokument an seinen Sollort in der Ablage bringen
 *
 * Der Sollort folgt aus den DB-Achsen der Zeile, soweit die aktive
 * Ablagestruktur sie als Ebene nutzt (Lebensbereich, Dokumentart,
 * familienmitglied bzw. behandelte Person, Jahr des Briefdatums, Richtung).
 * Aufrufer ändern zuerst die Zeile und rufen danach verschiebeAnSollort() auf:
 * Typwechsel, Änderung von Familienmitglied, behandelter Person, Briefdatum
 * oder Richtung, Löschen eines Menschen.
 *
 * Die Datei behält beim Verschieben ihre Item-ID; gespeicherte IDs bleiben gültig.
 * Ein Fehlschlag lässt die Datei am alten Ort – sie bleibt über ihre ID
 * erreichbar, und der nächste Gesamtumzug holt sie nach.
 */
import pool from '../db.js';
import { getAdapter } from '../lib/storage/index.js';
import { loadDynamicSettings, getAblageEbenen, getAblagePersonQuelle } from '../config.js';
import {
  ensureAblageOrdner, entfernePersonenSchluessel, istPersonenSchluessel, personSchluessel, behandeltePersonSql,
} from './storage-setup.js';
import { raeumeOrdnerAuf } from './storage-legacy-cleanup.js';
import { appLog } from '../app-log.js';

/**
 * @param {string} postid
 * @param {object} [settings]  bereits geladene Settings
 * @returns {Promise<{moved:boolean, newWebUrl:string|null}>}
 */
export async function verschiebeAnSollort(postid, settings = null) {
  const r = await pool.query(
    `SELECT p.storage_id, p.storage_backend, p.lebensbereich, p.dokumentart, p.familienmitglied,
            p.briefdatum, p.richtung::text AS richtung, ${behandeltePersonSql('p')} AS behandelte_person
       FROM postbuch.postbuch p WHERE p.postid = $1`,
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
 * Zieht ein Dokument nach einer Änderung seiner behandelten Person an den
 * Sollort nach – nur wenn diese den Personenordner überhaupt bestimmt. Best
 * effort: Ein Fehlschlag landet im Log, der nächste Gesamtumzug holt die
 * Datei nach. Das zurückgegebene Promise lehnt nie ab; wer den Abschluss
 * melden will (z. B. ein Job), wartet darauf, alle anderen nicht.
 */
export function zieheNachBehandelterPerson(postid) {
  return loadDynamicSettings()
    .then((settings) => getAblageEbenen(settings).includes('person')
      && getAblagePersonQuelle(settings) === 'behandelt'
      && verschiebeAnSollort(postid, settings))
    .catch((err) => appLog('ERROR', 'ablage', `${postid}: Umzug an neuen Ablageort fehlgeschlagen: ${err.message}`,
      { entity: 'postbuch', entityId: postid }));
}

/**
 * Nachlauf zum Löschen eines Menschen: Ist Person eine Ablageebene, wandern
 * seine verbliebenen Dokumente (Bezüge auf ihn bereits NULL) an ihren neuen
 * Sollort, also zum Adressaten bzw. nach „Gemeinsam“.
 * Danach werden seine Personenordner in allen Backends gelöscht, soweit sie
 * leer sind, und seine Cache-Schlüssel entfernt. Ein nicht leerer Ordner
 * bleibt physisch stehen. Best effort: Fehler landen im Log.
 *
 * @param {{menschId:string, kurzname:string, ohnePerson:string[]}} p
 */
export async function raeumeAblageNachLoeschung({ menschId, kurzname, ohnePerson }) {
  const settings = await loadDynamicSettings();
  let fehler = 0;
  if (getAblageEbenen(settings).includes('person')) {
    for (const postid of ohnePerson) {
      try {
        await verschiebeAnSollort(postid, settings);
      } catch (err) {
        fehler++;
        appLog('WARN', 'ablage', `${postid} nicht an Sollort verschoben: ${err.message}`, { entity: 'postbuch', entityId: postid });
      }
    }
  }
  const istZiel = (k) => istPersonenSchluessel(k, menschId);
  const backends = Object.entries(settings.storage_folders || {})
    .filter(([, f]) => f && Object.keys(f).some(istZiel))
    .map(([b]) => b);
  // Solange Dateien nicht umgezogen sind, bleibt der Ordner samt Schlüssel stehen.
  if (fehler === 0) {
    for (const backendName of backends) {
      try {
        await raeumeOrdnerAuf({ backendName, istZiel });
      } catch (err) {
        appLog('WARN', 'ablage', `Personenordner ${kurzname} (${backendName}) nicht aufgeräumt: ${err.message}`);
      }
    }
    await entfernePersonenSchluessel(menschId);
  }
}

/**
 * Benennt die Personenordner eines Menschen nach einer Kurzname-Änderung in
 * allen Backends um. Steht Person nicht auf erster Ebene, gibt es davon einen
 * je Vorebenen-Ordner. Die Dateien bleiben, wo sie sind: Der Cache hängt an der
 * mensch.id, nicht am Namen. Best effort – schlägt es fehl, stimmt nur der
 * sichtbare Ordnername nicht; die Ablage funktioniert weiter.
 */
export async function benennePersonenordnerUm(menschId, neuerKurzname) {
  const settings = await loadDynamicSettings();
  const schluessel = personSchluessel(menschId);
  const ordner = Object.entries(settings.storage_folders || {}).flatMap(([backendName, folders]) =>
    Object.entries(folders || {})
      .filter(([key, id]) => id && key.split('/').at(-1) === schluessel)
      .map(([, folderId]) => ({ backendName, folderId })));
  for (const { backendName, folderId } of ordner) {
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
