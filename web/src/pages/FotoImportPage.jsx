import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { AlertCircle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useAuth } from '@/hooks/useAuth';
import { geteilteFotosAbholen, hatGeteilteDateien } from '@/lib/geteilteDateien';
import { useSeitenstapel } from '@/components/kamerascan/Seitenstapel';

// Ziel des Share-Targets für Fotos: Der Service-Worker legt sie im Cache ab
// und leitet hierher. Die Fotos kommen in den Seitenstapel – an einen offenen
// Scan angehängt oder als neuer Scan; nach dem Hochladen folgt postbuch.net
// dem Job wie bei geteilten PDFs. Mitgeteilte PDFs gehen gleichzeitig an die
// Jobs-Ansicht, der Scan liegt darüber.
export default function FotoImportPage() {
  const { canWrite } = useAuth();
  const navigate = useNavigate();
  const stapel = useSeitenstapel();
  const [fotos, setFotos] = useState(null); // null = wird abgeholt
  const geholt = useRef(false);

  useEffect(() => {
    if (geholt.current) return;
    geholt.current = true;
    geteilteFotosAbholen().then(async (liste) => {
      if (!canWrite || liste.length === 0) {
        setFotos(liste);
        return;
      }
      stapel.oeffnen({ fotos: liste, folgen: true });
      navigate((await hatGeteilteDateien()) ? '/logs?geteilt=1' : '/import', { replace: true });
    });
  }, [canWrite, stapel, navigate]);

  async function weiter() {
    navigate((await hatGeteilteDateien()) ? '/logs?geteilt=1' : '/', { replace: true });
  }

  let meldung = null;
  if (fotos && !canWrite) meldung = 'Mit Lesezugriff lassen sich keine Dokumente importieren.';
  else if (fotos && fotos.length === 0) meldung = 'Es wartet kein geteiltes Foto (mehr). Teile das Foto bitte erneut.';

  return (
    <div className="mx-auto max-w-md p-4">
      {!meldung && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Geteilte Fotos werden übernommen …
        </p>
      )}
      {meldung && (
        <Card>
          <CardContent className="space-y-3 pt-6">
            <p className="flex items-start gap-2 text-sm">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" /> {meldung}
            </p>
            <Button variant="outline" onClick={weiter}>Weiter</Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
