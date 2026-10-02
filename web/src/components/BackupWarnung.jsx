import { KeyRound, FileX } from 'lucide-react';

/**
 * Warnung zur Tragweite einer Backup-Datei.
 *
 * Zwei fachlich unterschiedliche Aussagen, deshalb zwei eigene Blöcke mit eigener
 * Überschrift statt einem Fließtext, gewichtet nach realem Schaden statt nach
 * theoretischem Risiko: (1) Die Dokumente selbst liegen NICHT im Dump (pg_dump
 * schließt post_files aus, Originale bleiben in OneDrive/Nextcloud) – das ist der
 * Fall, der Nutzer tatsächlich beim Restore/Datenverlust erwischt (falsche
 * Sicherheit, "ich hab doch ein Backup"), daher rot und an erster Stelle.
 * (2) Der Dump enthält bewusst alle Zugangsdaten (wer Zugriff aufs Backup hat, hat
 * ohnehin Zugriff auf die Dateiablage) – real, aber setzt voraus, dass die Backup-Datei
 * überhaupt geteilt wird, daher amber und an zweiter Stelle. Eine Komponente für
 * beide Oberflächen (Einstellungen → Backup und die Backup-Seite), damit der Text
 * nicht auseinanderläuft.
 *
 * Der Generalschlüssel-Hinweis gilt unabhängig vom Verschlüsselungsstatus: ein
 * abgeschaltetes oder nicht entschiedenes Backup liegt weiterhin im Klartext in
 * der Dateiablage. Die Komponente bekommt bewusst keine Props für den aktuellen
 * Verschlüsselungsstatus – der Hinweis auf die Backup-Verschlüsselung als
 * Gegenmaßnahme reicht als statischer Zusatz.
 */
export default function BackupWarnung() {
  return (
    <div className="space-y-2">
      <div className="rounded-lg border-2 border-destructive/50 bg-destructive/8 px-4 py-3">
        <div className="flex items-start gap-3">
          <FileX className="h-5 w-5 text-destructive flex-shrink-0 mt-0.5" />
          <div className="space-y-1.5">
            <p className="text-sm font-semibold text-destructive">
              Die Dokumente (PDFs) selbst sind nicht enthalten.
            </p>
            <p className="text-xs leading-relaxed text-destructive/90">
              Das Backup sichert nur postbuch.net-Einstellungen und Dokumentendaten, keine Dateien.
              Die Originale liegen ausschließlich in deiner Dateiablage (OneDrive/Nextcloud) – für
              deren Sicherung bist du selbst verantwortlich.
            </p>
          </div>
        </div>
      </div>

      <div className="rounded-lg border-2 border-amber-500/40 bg-amber-500/8 px-4 py-3">
        <div className="flex items-start gap-3">
          <KeyRound className="h-5 w-5 text-amber-600 dark:text-amber-500 flex-shrink-0 mt-0.5" />
          <div className="space-y-1.5">
            <p className="text-sm font-semibold text-amber-700 dark:text-amber-500">
              Die Backup-Datei ist ein Generalschlüssel.
            </p>
            <p className="text-xs leading-relaxed text-amber-700/90 dark:text-amber-400/90">
              Sie enthält die postbuch.net-Einstellungen und Dokumentendaten (Metadaten, Buchungen,
              Zuordnungen) sowie sämtliche Zugangsdaten dieser Instanz im Klartext: dein
              Anmeldepasswort, die Verbindung zu deiner Dateiablage (OneDrive/Nextcloud) und alle
              KI-Schlüssel. Wer die Datei hat, hat vollen Zugriff – bei OneDrive auf dein
              <strong> komplettes Laufwerk</strong>, nicht nur auf den postbuch-Ordner, denn das
              gespeicherte Token gilt für alle Ordner. Gib sie niemals weiter, auch nicht zur
              Fehlersuche, und lege sie nirgends öffentlich ab.
            </p>
            <p className="text-xs leading-relaxed text-amber-700/90 dark:text-amber-400/90">
              Mit aktivierter <strong>Backup-Verschlüsselung</strong> (weiter unten bzw. unter
              Einstellungen → Backup) ist die gesamte Datei inklusive dieser Zugangsdaten
              passwortgeschützt – solange das Passwort ausschließlich dir bekannt ist.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
