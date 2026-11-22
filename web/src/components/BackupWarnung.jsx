import { FileX } from 'lucide-react';

/**
 * Warnung zur Tragweite einer Backup-Datei: Die Dokumente selbst liegen NICHT im
 * Dump (pg_dump schließt post_files aus, Originale bleiben in der Dateiablage).
 * Das ist der Fall, der Nutzer beim Restore/Datenverlust tatsächlich erwischt
 * (falsche Sicherheit, "ich hab doch ein Backup"), daher rot. Was mit den
 * Zugangsdaten passiert, erklärt die Karte Backup-Verschlüsselung daneben. Eine
 * Komponente für beide Oberflächen (Einstellungen → Backup und die Backup-Seite),
 * damit der Text nicht auseinanderläuft.
 */
const ABLAGE_TEXT = {
  lokal: 'in deinem Ablageordner auf diesem Rechner',
  onedrive: 'in deiner Dateiablage (OneDrive)',
  nextcloud: 'in deiner Dateiablage (Nextcloud)',
};

/** @param {{ backend?: 'lokal'|'onedrive'|'nextcloud' }} props  aktive Dateiablage */
export default function BackupWarnung({ backend }) {
  return (
    <div className="rounded-lg border-2 border-destructive/50 bg-destructive/8 px-4 py-3">
      <div className="flex items-start gap-3">
        <FileX className="h-5 w-5 text-destructive flex-shrink-0 mt-0.5" />
        <div className="space-y-1.5">
          <p className="text-sm font-semibold text-destructive">
            Die Dokumente (PDFs) selbst sind nicht enthalten.
          </p>
          <p className="text-xs leading-relaxed text-destructive/90">
            Das Backup sichert nur postbuch.net-Einstellungen und Dokumentendaten, keine Dateien.
            Die Originale liegen ausschließlich {ABLAGE_TEXT[backend] ?? 'in deiner Dateiablage'} – für
            deren Sicherung bist du selbst verantwortlich.
          </p>
        </div>
      </div>
    </div>
  );
}
