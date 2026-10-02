/**
 * Hat ein Mensch die Backup-Konfiguration bewusst gespeichert?
 *
 * Neue Schreibvorgänge tragen dafür `backup.bewusst=true`. Alte Instanzen
 * besitzen den Marker noch nicht; außerhalb eines gerade offenen Assistenten
 * bleibt ihr vorhandener Backup-Eintrag deshalb aus Kompatibilitätsgründen
 * eine gültige Entscheidung.
 *
 * Die enge Ausnahme ist wichtig: Bis 2.8.14 aktivierte eine erfolgreiche
 * OneDrive-Verbindung das Backup automatisch. Solange der Assistent offen ist,
 * darf ein technisch vorhandener, markerloser Eintrag deshalb nicht als Klick
 * des Nutzers ausgegeben werden. Wer einen alten Assistenten manuell erneut
 * öffnet, bestätigt die Entscheidung damit einmalig nach.
 */
export function backupEntscheidungGespeichert(settings, einrichtung) {
  if (settings?.backup?.bewusst === true) return true;
  if (!Object.hasOwn(settings || {}, 'backup')) return false;
  return einrichtung?.status !== 'offen';
}

/**
 * Hat ein Mensch die Backup-VERSCHLÜSSELUNG bewusst entschieden (aktiviert
 * oder ausdrücklich abgelehnt)?
 *
 * `backup_encryption` ist ein Feature, das es vor Bestandsinstanzen nicht gab —
 * dessen bloßes Fehlen darf sie deshalb nie zwingen, das nachträglich zu
 * entscheiden. Nur eine ECHTE Erstinstallation (Quelle `installation`, noch
 * offen) muss die Frage im Assistenten beantworten; jede andere Instanz gilt
 * bereits als entschieden (= unverschlüsselt, änderbar in den Einstellungen).
 */
export function backupVerschluesselungEntschieden(settings, einrichtung) {
  if (settings?.backup_encryption?.bewusst === true) return true;
  return !(einrichtung?.quelle === 'installation' && einrichtung?.status === 'offen');
}
