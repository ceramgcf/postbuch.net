/**
 * jobs/backup-nachholen.js — Entscheidung, ob eine verpasste automatische
 * Sicherung nachzuholen ist.
 *
 * Der Cron-Termin (Standard 04:00) greift nur, wenn die App in diesem Moment
 * läuft. Ein Rechner, der nachts aus ist oder schläft, bekäme sonst nie eine
 * automatische Sicherung. Deshalb merkt sich der Backup-Job nach jedem
 * erfolgreichen Lauf den nächsten fälligen Termin (`_settings.backup_faellig`)
 * und prüft beim Start und danach stündlich, ob dieser Termin verstrichen ist.
 * Dann läuft die Sicherung sofort – höchstens einmal, egal wie viele Termine
 * dazwischen lagen.
 */

/** Setting-Schlüssel für den nächsten fälligen automatischen Lauf (ISO-Zeit). */
export const FAELLIG_KEY = 'backup_faellig';

/** Wartezeit nach dem App-Start, damit der Hochlauf nicht gebremst wird. */
export const START_VERZOEGERUNG_MS = 10 * 60 * 1000;

/** Abstand der Prüfungen im laufenden Betrieb. */
export const PRUEF_INTERVALL_MS = 60 * 60 * 1000;

/** Vorrang des Cron-Termins: So lange nach Fälligkeit wird nicht nachgeholt. */
export const KARENZ_MS = 15 * 60 * 1000;

/** Nach einem Fehlschlag frühestens nach dieser Pause erneut versuchen. */
export const FEHLER_PAUSE_MS = 6 * 60 * 60 * 1000;

/**
 * Ist eine Sicherung nachzuholen?
 *
 * @param {Date|null} faellig        gespeicherter nächster Termin (null = unbekannt)
 * @param {Date} jetzt
 * @param {number} letzterFehlschlag Zeitpunkt (ms) des letzten gescheiterten Laufs, 0 = keiner
 */
export function istNachzuholen(faellig, jetzt, letzterFehlschlag = 0) {
  if (!(faellig instanceof Date) || Number.isNaN(faellig.getTime())) return false;
  if (letzterFehlschlag && jetzt.getTime() - letzterFehlschlag < FEHLER_PAUSE_MS) return false;
  return faellig.getTime() + KARENZ_MS <= jetzt.getTime();
}

/** Liest den gespeicherten Setting-Wert (JSON-String mit ISO-Zeit) als Date. */
export function faelligkeitAusWert(wert) {
  if (typeof wert !== 'string') return null;
  const datum = new Date(wert);
  return Number.isNaN(datum.getTime()) ? null : datum;
}
