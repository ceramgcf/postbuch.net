/**
 * Tabellen, deren Struktur für den Restore gebraucht wird, deren Inhalt aber
 * nicht in eine Sicherung gehört: regenerierbare Caches (werden beim
 * anschließenden App-Start aus kanonischen Dateien bzw. der Ablage neu
 * aufgebaut) und Web-Sitzungen (ein Restore bringt keine alten Anmeldungen
 * zurück; Sitzungstokens haben in einer Backup-Datei nichts verloren).
 */
export const BACKUP_EXCLUDED_TABLE_DATA = Object.freeze([
  'postbuch.post_files',
  'postbuch._hilfe_abschnitt',
  'postbuch._hilfe_korpus',
  'postbuch.session',
]);

export function backupExcludeArgs() {
  return BACKUP_EXCLUDED_TABLE_DATA.map(tabelle => `--exclude-table-data=${tabelle}`);
}
