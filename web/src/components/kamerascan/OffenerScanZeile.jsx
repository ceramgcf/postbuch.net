import { useState } from 'react';
import { Layers } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { useSeitenstapel } from './Seitenstapel';

function alterText(zeit) {
  const min = Math.max(0, Math.round((Date.now() - zeit) / 60000));
  if (min < 1) return 'gerade eben';
  if (min < 60) return `vor ${min} Min.`;
  const std = Math.round(min / 60);
  return `vor ${std} ${std === 1 ? 'Stunde' : 'Stunden'}`;
}

/** Hinweiszeile auf der Importseite, solange ein Scan auf diesem Gerät offen ist. */
export default function OffenerScanZeile() {
  const stapel = useSeitenstapel();
  const [frage, setFrage] = useState(false);
  const scan = stapel.offenerScan;
  if (!scan) return null;
  const seiten = scan.anzahl === 1 ? '1 Seite' : `${scan.anzahl} Seiten`;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-violet-500/40 bg-violet-500/[0.07] px-3.5 py-2.5 text-sm">
      <Layers className="h-4 w-4 shrink-0 text-violet-600 dark:text-violet-300" />
      <span className="min-w-0 flex-1">
        <span className="font-medium">Offener Scan</span>
        <span className="text-muted-foreground"> · {seiten} · {alterText(scan.zeit)}</span>
      </span>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={() => setFrage(true)}>Verwerfen</Button>
        <Button size="sm" onClick={() => stapel.oeffnen()}>Fortsetzen</Button>
      </div>
      <Dialog open={frage} onOpenChange={setFrage} size="sm">
        <DialogTitle>Offenen Scan verwerfen?</DialogTitle>
        <DialogDescription>
          {scan.anzahl === 1 ? 'Die Seite geht verloren.' : `Die ${scan.anzahl} Seiten gehen verloren.`}
        </DialogDescription>
        <DialogFooter>
          <Button variant="outline" onClick={() => setFrage(false)}>Abbrechen</Button>
          <Button variant="destructive" onClick={() => { setFrage(false); stapel.verwerfen(); }}>Verwerfen</Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
