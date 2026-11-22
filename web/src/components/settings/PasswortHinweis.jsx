/**
 * Sagt immer, warum „Verschlüsselung aktivieren“ noch gesperrt ist – ein
 * nur ausgegrauter Knopf lässt raten. Gilt für Assistent und Einstellungen.
 */
export const BACKUP_PASSWORT_MIN = 8;

export default function PasswortHinweis({ passwort, wiederholung }) {
  let text = null;
  let fehler = false;
  if (!passwort) {
    text = `Das Passwort braucht mindestens ${BACKUP_PASSWORT_MIN} Zeichen.`;
  } else if (passwort.length < BACKUP_PASSWORT_MIN) {
    const fehlt = BACKUP_PASSWORT_MIN - passwort.length;
    text = `Zu kurz: mindestens ${BACKUP_PASSWORT_MIN} Zeichen, es ${fehlt === 1 ? 'fehlt noch 1 Zeichen' : `fehlen noch ${fehlt} Zeichen`}.`;
    fehler = true;
  } else if (!wiederholung) {
    text = 'Bitte das Passwort zur Kontrolle wiederholen.';
  } else if (passwort !== wiederholung) {
    text = 'Passwörter stimmen nicht überein.';
    fehler = true;
  }
  if (!text) return null;
  return <p className={`text-xs ${fehler ? 'text-destructive' : 'text-muted-foreground'}`}>{text}</p>;
}
