import { FolderTree, KeyRound } from 'lucide-react';

/**
 * Warnung zum Zugriffsumfang der OneDrive-Verbindung.
 *
 * Zwei fachlich getrennte Aussagen, deshalb zwei Blöcke – nach dem Muster von
 * BackupWarnung.jsx, damit beide Warnungen im UI gleich „klingen":
 *   (1) Umfang: je nach Modus `Files.ReadWrite.AppFolder` (nur der eigene
 *       App-Ordner unter Apps/) oder `Files.ReadWrite.All` (alle Ordner).
 *       Neutral – beides ist eine bewusste Entscheidung, keine Panne.
 *   (2) Folge: das Token liegt im Klartext in `_settings.onedrive_tokens` und damit
 *       auch in jedem Datenbank-Backup. Wer Server, Datenbank oder Backup-Datei
 *       hat, hat alles, was das Token erreicht. Beim Vollzugriff ist das das
 *       gesamte OneDrive, daher rot und mit den Gegenmaßnahmen direkt daneben;
 *       im App-Ordner-Modus genügt ein sachlicher Satz im Infokasten.
 *
 * Eine Komponente für alle Oberflächen (Einstellungen → Dateiablage und
 * Einrichtungsassistent), damit der Text nicht auseinanderläuft. `kompakt`
 * kürzt für Kontexte, in denen die Warnung nur zum Einstieg steht und die
 * ausführliche Fassung einen Klick entfernt ist.
 */
export default function OneDriveVollzugriffWarnung({ kompakt = false, modus = 'vollzugriff' }) {
  const appOrdner = modus === 'appordner';
  return (
    <div className="space-y-2">
      {appOrdner ? (
        <div className="rounded-lg border-2 border-sky-500/40 bg-sky-500/8 px-4 py-3">
          <div className="flex items-start gap-3">
            <FolderTree className="h-5 w-5 text-sky-600 dark:text-sky-400 flex-shrink-0 mt-0.5" />
            <div className="space-y-1.5">
              <p className="text-sm font-semibold text-sky-800 dark:text-sky-300">
                postbuch.net erhält nur Zugriff auf seinen eigenen App-Ordner.
              </p>
              <p className="text-xs leading-relaxed text-sky-800/90 dark:text-sky-300/90">
                Beim Verbinden erteilst du die Berechtigung <span className="font-mono">Files.ReadWrite.AppFolder</span>.
                Microsoft legt dafür in deinem OneDrive den Ordner <span className="font-mono">Apps/</span> mit
                einem Unterordner für deine App-Registrierung an; darin liegt die Ablage. Du siehst und
                öffnest ihn wie jeden anderen Ordner – in der OneDrive-App, im Explorer oder auf onedrive.com.
                Alles außerhalb dieses Ordners bleibt für postbuch.net unerreichbar.
              </p>
              <p className="text-xs leading-relaxed text-sky-800/90 dark:text-sky-300/90">
                Das Zugangs-Token liegt in der Datenbank und damit auch in Backups – behandle
                Backup-Dateien deshalb vertraulich.
              </p>
            </div>
          </div>
        </div>
      ) : (
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
                postbuch-Ordner. Dafür kann die Ablage an jeder Stelle deines OneDrive liegen
                (z. B. <span className="font-mono">/postbuch/…</span>). Enger geht es mit dem App-Ordner:
                postbuch.net sieht dann nur noch seinen eigenen Ordner unter <span className="font-mono">Apps/</span> –
                umstellbar weiter unten unter „Zugriffsumfang“.
              </p>
            </div>
          </div>
        </div>
      )}

      {!appOrdner && (
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
                  <li>Wenn dir das zu weit geht: auf den App-Ordner umstellen, ein eigenes Microsoft-Konto nur für postbuch.net anlegen – oder statt OneDrive einen eigenen WebDAV-Speicher nutzen. Ganz ohne Dateiablage funktioniert postbuch.net nicht.</li>
                  <li>Zugriff nur für Wartung, Neuverbindung oder Backend-Wechsel entziehen: hier „Verbindung trennen" und zusätzlich im Microsoft-Konto unter Datenschutz → Apps und Dienste die Berechtigung widerrufen. Bis zur Neuverbindung stehen die Dokumentfunktionen still.</li>
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
