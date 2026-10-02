import { useMemo } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import {
  FolderInput, Smartphone, FileUp, ScanLine, Webhook, Printer,
  ArrowRight, BookOpen, Check,
} from 'lucide-react';

/**
 * ImportwegePage – die sechs Eingangswege im Überblick
 *
 * Zwei Auftritte, eine Seite – die Überschrift folgt dem Anlass:
 *  • direkt nach dem Einrichtungsassistenten (`?nachEinrichtung=1`) heißt sie
 *    „Importiere dein erstes Dokument" und ist mit „Verstanden" quittierbar –
 *    danach geht es aufs Dashboard.
 *  • jederzeit über den Tipp ganz oben auf der Import-Seite; dort ist das erste
 *    Dokument längst importiert, also steht die Wege-Übersicht in der Überschrift.
 *
 * Pfade und Intervalle kommen aus `/api/settings-public/importwege` und werden
 * aufgelöst hingeschrieben. Ein Platzhalter wie `<Wurzelordner>/_inbox` nützt
 * niemandem, der die Datei gerade wirklich ablegen will.
 */

const BACKEND_LABEL = { onedrive: 'OneDrive', nextcloud: 'WebDAV-Speicher' };

function Pfad({ children }) {
  return <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em] break-all">{children}</code>;
}

function Weg({ icon: Icon, art, titel, children }) {
  const papier = art === 'Papier';
  return (
    <Card className="h-full">
      <CardHeader className="pb-3">
        <div className="flex items-start gap-3">
          <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${
            papier ? 'bg-amber-500/12 text-amber-600 dark:text-amber-500' : 'bg-primary/10 text-primary'}`}
          >
            <Icon className="h-6 w-6" />
          </span>
          <div className="min-w-0 space-y-1.5">
            <Badge variant={papier ? 'secondary' : 'default'} className="uppercase tracking-wide">{art}</Badge>
            <CardTitle className="text-base leading-snug">{titel}</CardTitle>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-2 text-sm leading-relaxed text-muted-foreground">{children}</CardContent>
    </Card>
  );
}

export default function ImportwegePage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const nachEinrichtung = params.get('nachEinrichtung') === '1';

  const { data, isLoading } = useQuery({
    queryKey: ['importwege'],
    queryFn: () => api.settingsPublic.importwege(),
    retry: false,
  });
  const { data: portData } = useQuery({
    queryKey: ['scanner-port'],
    queryFn: () => api.import.scannerPort(),
    staleTime: Infinity,
    retry: false,
  });

  const ablage = BACKEND_LABEL[data?.backend] || 'deiner Dateiablage';
  const inbox = data?.inboxPfad || null;
  const intervall = data?.polling?.intervalSec ?? 60;
  const pollingAn = data?.polling?.enabled !== false;
  const webhookBasis = useMemo(
    () => (portData?.port ? `http://${window.location.hostname}:${portData.port}/scan/` : null),
    [portData?.port],
  );

  if (isLoading) return <div className="grid min-h-[50vh] place-items-center"><Spinner className="h-8 w-8" /></div>;

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 md:p-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          {nachEinrichtung ? 'Importiere dein erstes Dokument' : 'Sechs Wege, ein Dokument hereinzubekommen'}
        </h1>
        <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
          postbuch.net verarbeitet <strong className="text-foreground">PDF-Dateien</strong> und{' '}
          <strong className="text-foreground">Papier</strong>. Papier wird dabei zuerst zu einer PDF –
          gescannt oder abfotografiert. Andere Formate wie Word-Dateien, Bilder oder E-Mails nimmt die
          Verarbeitung nicht an: Die KI-Analyse, die Dateiablage in der Cloud und jede spätere Ansicht
          arbeiten mit einem einzigen, seitengetreuen Format. Wandle solche Dateien vorher in eine PDF um.
        </p>
        <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
          Alle Wege münden in dieselbe Warteschlange – was danach passiert, ist überall gleich.
        </p>
      </header>

      <div className="grid gap-4 md:grid-cols-2">
        <Weg icon={FolderInput} art="PDF" titel={`PDF in den überwachten Ordner ${inbox ? 'legen' : 'der Dateiablage legen'}`}>
          <p>
            {inbox
              ? <>Alles, was in <Pfad>{inbox}</Pfad> in {ablage} landet, holt postbuch.net von selbst ab.</>
              : <>Alles, was im Ordner <Pfad>_inbox</Pfad> deiner Dateiablage landet, holt postbuch.net von selbst ab.</>}
            {' '}
            {pollingAn
              ? <>Nachgesehen wird alle <strong className="text-foreground">{intervall} Sekunden</strong>.</>
              : <>Diese Abholung ist derzeit ausgeschaltet (<em>Einstellungen → Dateiablage</em>).</>}
          </p>
          <p>
            Mehrere Dateien auf einmal sind ausdrücklich vorgesehen – jede wird ein eigenes Dokument.
          </p>
          <p>
            Das ist der bequemste Weg, wenn die Cloud ohnehin auf deinem Gerät eingebunden ist: unter
            Windows als Ordner im Explorer, unter Android kann jedes PDF über „Teilen“ zur Cloud-App geschickt und dort in
            <Pfad>_inbox</Pfad> abgelegt werden.
          </p>
        </Weg>

        <Weg icon={Smartphone} art="Papier" titel="Mit dem Smartphone abfotografieren">
          <p>
            Die App deiner Cloudablage kann Dokumente scannen: In OneDrive und Nextcloud gibt es dafür
            einen Dokumentenscan, der die Seite entzerrt, zuschneidet und als PDF speichert – mehrere
            Seiten kommen in eine Datei.
          </p>
          <p>
            Als Ziel {inbox ? <>den Ordner <Pfad>{inbox}</Pfad></> : <>den Ordner <Pfad>_inbox</Pfad></>} wählen.
            Damit läuft der Scan über denselben überwachten Ordner wie oben – ohne Scanner im Haus.
          </p>
        </Weg>

        <Weg icon={FileUp} art="PDF" titel="Über „Importieren“ hochladen">
          <p>
            Auf der Seite <Link to="/import" className="font-medium text-primary hover:underline">Importieren</Link> per
            Drag &amp; Drop oder Dateiauswahl. Zwei Modi:
          </p>
          <p>
            <strong className="text-foreground">Sammlung</strong> führt alle abgelegten PDFs zu{' '}
            <em>einem</em> Dokument zusammen (Reihenfolge änderbar) – für ein Schreiben, das in Teilen
            vorliegt. <strong className="text-foreground">Batch</strong> verarbeitet jede Datei einzeln,
            jede bekommt ihre eigene Postnummer.
          </p>
        </Weg>

        <Weg icon={ScanLine} art="Papier" titel="Scannen über „Importieren“">
          <p>
            Ist ein Netzwerkscanner eingerichtet, löst du den Scan direkt in postbuch.net aus:{' '}
            Quelle (Einzug oder Flachbett), Auflösung, Farbe und Format wählen, scannen – die Seiten
            werden bereinigt, mit einer Textebene versehen und laufen weiter in die Verarbeitung.
          </p>
          <p>
            {data?.scannerKonfiguriert
              ? 'Auf dieser Instanz ist ein Scanner eingerichtet.'
              : 'Auf dieser Instanz ist noch kein Scanner eingerichtet (Einstellungen → Scanner).'}
          </p>
        </Weg>

        <Weg icon={Webhook} art="Papier" titel="Scan aus dem eigenen Netz auslösen">
          <p>
            Jede Scan-Einstellung auf der Import-Seite hat eine eigene Adresse – sie wird dort als
            <strong className="text-foreground"> Webhook-URL</strong> zum Kopieren angezeigt und ändert
            sich mit Quelle, Auflösung, Farbe und Format.
          </p>
          <p>
            {webhookBasis
              ? <>Sie beginnt mit <Pfad>{webhookBasis}</Pfad> und wird direkt aufgerufen – ein Aufruf, ein Scan.</>
              : <>Sie zeigt auf den Scanner-Dienst dieser Instanz und wird direkt aufgerufen – ein Aufruf, ein Scan.</>}
          </p>
          <p>
            Das ist eine technische Schnittstelle für andere Geräte im selben Netz: ein Smarthome-Knopf
            neben dem Scanner, eine Taste am Schreibtisch, ein Skript. Von außen ist sie nicht erreichbar.
          </p>
        </Weg>

        <Weg icon={Printer} art="Papier" titel="Scanner legt direkt in der Cloud ab">
          <p>
            Manche Netzwerkscanner können selbst in eine Cloud speichern. Richte dort{' '}
            {inbox ? <>als Ziel <Pfad>{inbox}</Pfad></> : <>als Ziel den Ordner <Pfad>_inbox</Pfad></>} ein,
            und postbuch.net holt die Scans wie jede andere Datei ab.
          </p>
          <p>
            Das können nur wenige Geräte – und postbuch.net ist daran unbeteiligt: Ob es geht, entscheidet
            allein der Scanner.
          </p>
        </Weg>
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t pt-4">
        <Link to="/hilfe/dokumente-importieren" className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline">
          <BookOpen className="h-4 w-4" />Ausführlich in der Hilfe
        </Link>
        <div className="ml-auto flex gap-2">
          {nachEinrichtung ? (
            <Button onClick={() => navigate('/', { replace: true })}>
              <Check className="mr-1.5 h-4 w-4" />Verstanden
            </Button>
          ) : (
            <Button onClick={() => navigate('/import')}>
              Zum Importieren<ArrowRight className="ml-1.5 h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
