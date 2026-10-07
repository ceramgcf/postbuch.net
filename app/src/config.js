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
 * 'person_lxd' = <Familienmitglied>/<Lebensbereich>/<Dokumentart>,
 * 'benutzerdefiniert' = frei gewählte Ebenen aus _settings.ablage_ebenen.
 * Umgeschaltet wird ausschließlich über POST /api/settings/ablage-struktur,
 * weil jeder Wechsel einen Gesamtumzug braucht.
 */
export function getAblageStruktur(settings) {
  const s = settings?.ablage_struktur;
  if (s === 'person_lxd') return 'person_lxd';
  if (s === 'benutzerdefiniert' && normalisiereAblageEbenen(settings?.ablage_ebenen)) return 'benutzerdefiniert';
  return 'lxd';
}

/** Mögliche Ordnerebenen der Ablage, in der Reihenfolge der Auswahlliste. */
export const ABLAGE_EBENEN = Object.freeze(['person', 'lebensbereich', 'dokumentart', 'jahr', 'richtung']);
export const ABLAGE_EBENEN_MAX = 4;

/** Feste Ebenenfolgen der beiden vordefinierten Strukturen. */
export const ABLAGE_VORLAGEN = Object.freeze({
  lxd: Object.freeze(['lebensbereich', 'dokumentart']),
  person_lxd: Object.freeze(['person', 'lebensbereich', 'dokumentart']),
});

/**
 * Prüft eine Ebenenfolge: 1 bis 4 verschiedene bekannte Ebenen.
 * @returns {string[]|null}  bereinigte Kopie oder null bei ungültiger Eingabe
 */
export function normalisiereAblageEbenen(ebenen) {
  if (!Array.isArray(ebenen) || ebenen.length < 1 || ebenen.length > ABLAGE_EBENEN_MAX) return null;
  if (!ebenen.every((e) => ABLAGE_EBENEN.includes(e))) return null;
  if (new Set(ebenen).size !== ebenen.length) return null;
  return [...ebenen];
}

/**
 * Ordnerebenen der aktiven Ablagestruktur von der Wurzel zum Blattordner.
 * Einzige Quelle für alle Pfadberechnungen; die Vorlagen sind nur Namen für
 * bestimmte Ebenenfolgen.
 */
export function getAblageEbenen(settings) {
  const struktur = getAblageStruktur(settings);
  if (struktur === 'benutzerdefiniert') return normalisiereAblageEbenen(settings.ablage_ebenen);
  return [...ABLAGE_VORLAGEN[struktur]];
}

/**
 * Wer den Personenordner bestimmt, wenn Person eine Ablageebene ist:
 * 'adressat' = familienmitglied (Default), 'behandelt' = die behandelte
 * Person bzw. das behandelte Tier bei Arztrechnung, Arztbericht und
 * Erstattungsbescheid. Ohne eindeutige behandelte Person gilt der Adressat.
 */
export const ABLAGE_PERSON_QUELLEN = Object.freeze(['adressat', 'behandelt']);

export function getAblagePersonQuelle(settings) {
  return settings?.ablage_person_quelle === 'behandelt' ? 'behandelt' : 'adressat';
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
