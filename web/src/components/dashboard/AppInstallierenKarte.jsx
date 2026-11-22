/**
 * Dashboard-Kachel „Als App registrieren“. Erscheint nur, solange der Browser
 * die Installation anbietet (beforeinstallprompt) und postbuch.net nicht schon
 * als App läuft. „Kein Interesse“ blendet sie nach Rückfrage auf diesem Gerät
 * dauerhaft aus (localStorage).
 */
import { useState } from 'react';
import { AppWindow } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { usePwaInstallation, pwaInstallieren } from '@/lib/pwa-installation';

const SCHLUESSEL = 'postbuch.appInstallieren.keinInteresse';

function ausgeblendet() {
  try { return localStorage.getItem(SCHLUESSEL) === '1'; } catch { return false; }
}

export default function AppInstallierenKarte() {
  const { installierbar } = usePwaInstallation();
  const [weg, setWeg] = useState(ausgeblendet);
  const [fragen, setFragen] = useState(false);

  if (!installierbar || weg) return null;

  const keinInteresse = () => {
    try { localStorage.setItem(SCHLUESSEL, '1'); } catch { /* nur für diese Sitzung */ }
    setFragen(false);
    setWeg(true);
  };

  return (
    <div className="rounded-lg border border-primary/25 bg-primary/5 px-4 py-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex items-start gap-3 flex-1 min-w-0">
          <AppWindow className="h-4 w-4 mt-0.5 flex-shrink-0 text-primary" />
          <div className="min-w-0">
            <p className="text-sm font-medium">postbuch.net als App registrieren</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Eigenes Fenster, Symbol im Startmenü bzw. auf dem Startbildschirm und PDFs direkt aus anderen Apps teilen. Heruntergeladen wird nichts.
              Im Fenster, das der Browser danach zeigt, auf „Installieren“ klicken.
            </p>
          </div>
        </div>
        <div className="flex gap-2 sm:flex-shrink-0">
          <Button variant="ghost" size="sm" onClick={() => setFragen(true)}>Kein Interesse</Button>
          <Button size="sm" className="btn-gradient text-white font-semibold" onClick={() => pwaInstallieren()}>
            <AppWindow className="h-4 w-4" />
            Registrieren
          </Button>
        </div>
      </div>

      <Dialog open={fragen} onOpenChange={setFragen}>
        <DialogTitle>App-Registrierung ausblenden?</DialogTitle>
        <DialogDescription>Ohne Registrierung läuft postbuch.net weiter im Browser. Dabei fehlt:</DialogDescription>
        <ul className="mt-3 space-y-1.5 text-sm list-disc pl-5">
          <li>ein eigenes Fenster ohne Adressleiste und Browser-Tabs</li>
          <li>ein Symbol im Startmenü, auf dem Desktop bzw. auf dem Startbildschirm</li>
          <li>das Teilen von PDFs und Fotos aus anderen Apps direkt an postbuch.net</li>
          <li>der schnelle Start, ohne erst den Browser zu öffnen</li>
        </ul>
        <p className="mt-3 text-xs text-muted-foreground">
          Die Kachel erscheint auf diesem Gerät nicht mehr. Registrieren lässt sich die App weiterhin über das Menü des Browsers.
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={keinInteresse}>Ausblenden</Button>
          <Button className="btn-gradient text-white font-semibold" onClick={() => { setFragen(false); pwaInstallieren(); }}>
            Doch registrieren
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
