import pool from './db.js';

export const config = {
  db: {
    connectionString: process.env.DATABASE_URL ||
      `postgresql://${process.env.POSTGRES_USER || 'postbuch'}:${process.env.POSTGRES_PASSWORD}@${process.env.POSTGRES_HOST || 'postgres'}:${process.env.POSTGRES_PORT || 5432}/${process.env.POSTGRES_DB || 'postbuch'}`
  }
};

export async function loadDynamicSettings() {
  const rows = await pool.query('SELECT key, value FROM _settings');
  const s = {};
  for (const r of rows.rows) s[r.key] = r.value;
  return s;
}

/**
 * Name des aktiven Ablage-Backends ('onedrive' | …).
 * Neuzugänge landen immer im aktiven Backend; bestehende Zeilen tragen ihr
 * eigenes Backend in postbuch.storage_backend.
 */
export function getActiveBackendName(settings) {
  return settings?.storage_backend || 'onedrive';
}

/**
 * Ordner-IDs eines Backends aus _settings.storage_folders.
 * Struktur: { onedrive: { inbox: '…', gesundheit: '…', 'gesundheit/arztrechnung': '…' }, … }
 * @param {object} settings  Ergebnis von loadDynamicSettings()
 * @param {string} [backend] Default: aktives Backend
 */
export function getFolders(settings, backend) {
  const name = backend || getActiveBackendName(settings);
  return settings?.storage_folders?.[name] || {};
}

/**
 * Ablagestruktur: 'lxd' = <Lebensbereich>/<Dokumentart> (Default),
 * 'person_lxd' = <Familienmitglied>/<Lebensbereich>/<Dokumentart>.
 * Umgeschaltet wird ausschließlich über POST /api/settings/ablage-struktur,
 * weil jeder Wechsel einen Gesamtumzug braucht.
 */
export function getAblageStruktur(settings) {
  return settings?.ablage_struktur === 'person_lxd' ? 'person_lxd' : 'lxd';
}

/** Reiner LxD-Reader: ein Leaf-Key ist immer `<lebensbereich>/<dokumentart>`. */
export function getFolderId(settings, lebensbereich, dokumentart, backend) {
  if (typeof lebensbereich !== 'string' || typeof dokumentart !== 'string') return undefined;
  return getFolders(settings, backend)[`${lebensbereich}/${dokumentart}`];
}

/**
 * Rückwärtsauflösung: Ordner-ID → Ordner-Key desselben Backends.
 *
 * Gegenstück zu getFolderId. Gebraucht von der Storage-Migration, die für eine
 * Datei den ZIELordner bestimmen muss: erst den Key ermitteln, in dem sie in
 * der Quelle tatsächlich liegt, dann denselben Key im Ziel-Backend nachschlagen.
 *
 * Warum nicht einfach über den Dokumenttyp: getFolderId fällt für unbekannte
 * Typen still auf 'Sonstiges' zurück, und Nutzer dürfen Ordner-IDs pro Typ
 * manuell umbiegen. Der Typ-Wert ist damit nicht zuverlässig deckungsgleich mit
 * dem physischen Ort — beim Umzug landete die Datei sonst woanders als sie lag,
 * ohne dass es jemand merkt.
 *
 * Mehrere Keys dürfen auf denselben Ordner zeigen (inbox+directscan,
 * abrechnungMerged+abrechnung). Bei Mehrdeutigkeit gewinnt der erste Treffer;
 * da beide Keys im Ziel ohnehin denselben Ordner meinen, ist die Wahl
 * folgenlos.
 *
 * @returns {string|null} Key oder null, wenn die ID zu keinem bekannten Ordner gehört
 */
export function folderKeyById(settings, backend, folderId) {
  if (!folderId) return null;
  const folders = getFolders(settings, backend);
  for (const [key, id] of Object.entries(folders)) {
    if (id === folderId) return key;
  }
  return null;
}
