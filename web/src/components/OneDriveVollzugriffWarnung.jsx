import { FolderTree, KeyRound } from 'lucide-react';

/**
 * Warnung zum Zugriffsumfang der OneDrive-Verbindung.
 *
 * Zwei fachlich getrennte Aussagen, deshalb zwei Blöcke – nach dem Muster von
 * BackupWarnung.jsx, damit beide Warnungen im UI gleich „klingen":
 *   (1) Umfang: die Verbindung erteilt `Files.ReadWrite.All`, also Vollzugriff auf
 *       ALLE OneDrive-Ordner. Das ist gewollt: nur so liegen die Dokumente im
 *       normalen Dateibaum und bleiben ohne postbuch.net erreichbar. Neutral
 *       (amber) – es ist eine bewusste Design-Entscheidung, keine Panne.
 *   (2) Folge: das Token liegt im Klartext in `_settings.onedrive_tokens` und damit
 *       auch in jedem Datenbank-Backup. Wer Server, Datenbank oder Backup-Datei
 *       hat, hat das gesamte OneDrive. Das ist der Teil, der Nutzer real trifft,
 *       daher rot und mit den Gegenmaßnahmen direkt daneben.
 *
 * Eine Komponente für alle Oberflächen (Einstellungen → Dateiablage und
 * Einrichtungsassistent), damit der Text nicht auseinanderläuft. `kompakt`
 * kürzt für Kontexte, in denen die Warnung nur zum Einstieg steht und die
 * ausführliche Fassung einen Klick entfernt ist.
 */
export default function OneDriveVollzugriffWarnung({ kompakt = false }) {
  return (
    <div className="space-y-2">
      <div className="rounded-lg border-2 border-amber-500/40 bg-amber-500/8 px-4 py-3">
        <div className="flex items-start gap-3">
          <FolderTree className="h-5 w-5 text-amber-600 dark:text-amber-500 flex-shrink-0 mt-0.5" />
          <div className="space-y-1.5">
            <p className="text-sm font-semibold text-amber-700 dark:text-amber-500">
              postbuch.net erhält Zugriff auf dein <span className="underline decoration-2 underline-offset-2">gesamtes</span> OneDrive.
            </p>
            <p className="text-xs leading-relaxed text-amber-700/90 dark:text-amber-400/90">
              Beim Verbinden erteilst du die Berechtigung <span className="font-mono">Files.ReadWrite.All</span>:
              lesen, ändern und löschen in <strong>allen</strong> Ordnern deines OneDrive – nicht nur im
              postbuch-Ordner. Das ist Absicht und technisch nötig: Nur so liegen deine Dokumente im
              gewöhnlichen Dateibaum (z. B. <span className="font-mono">/postbuch/…</span>) und du kommst
              jederzeit auch ohne postbuch.net an sie heran – über die OneDrive-App, den Explorer oder
              onedrive.com. Ein abgeschotteter App-Ordner würde die Dateien darin einsperren.
            </p>
          </div>
        </div>
      </div>

      <div className="rounded-lg border-2 border-destructive/50 bg-destructive/8 px-4 py-3">
        <div className="flex items-start gap-3">
          <KeyRound className="h-5 w-5 text-destructive flex-shrink-0 mt-0.5" />
          <div className="space-y-1.5">
            <p className="text-sm font-semibold text-destructive">
              Damit liegt ein Generalschlüssel zu deinem OneDrive in dieser Instanz.
            </p>
            <p className="text-xs leading-relaxed text-destructive/90">
              Das Zugangs-Token steht unverschlüsselt in der Datenbank – und damit auch in
              jeder Backup-Datei, die postbuch.net erzeugt. <strong>Wer Zugriff auf den Server, auf die
              Datenbank oder auf eine Backup-Datei hat, hat vollen Zugriff auf dein komplettes
              OneDrive</strong>, auch auf alles, was mit postbuch.net nichts zu tun hat.
            </p>
            {!kompakt && (
              <ul className="text-xs leading-relaxed text-destructive/90 list-disc pl-4 space-y-1">
                <li>Instanz im eigenen Netz oder hinter einem VPN betreiben, nicht offen im Internet.</li>
                <li>Backup-Dateien so behandeln wie dein Microsoft-Passwort: niemals weitergeben, auch nicht zur Fehlersuche.</li>
                <li>Wenn dir das zu weit geht: ein eigenes Microsoft-Konto nur für postbuch.net anlegen – oder statt OneDrive einen eigenen WebDAV-Speicher nutzen. Ganz ohne Dateiablage funktioniert postbuch.net nicht.</li>
                <li>Zugriff nur für Wartung, Neuverbindung oder Backend-Wechsel entziehen: hier „Verbindung trennen" und zusätzlich im Microsoft-Konto unter Datenschutz → Apps und Dienste die Berechtigung widerrufen. Bis zur Neuverbindung stehen die Dokumentfunktionen still.</li>
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
