import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Search, ScanLine, Info } from 'lucide-react';
import { api } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Testergebnis } from '@/components/ui/testergebnis';
import { Dialog, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';

const QUELLEN = { flatbed: 'Flachbett', adf: 'ADF', 'adf-duplex': 'ADF duplex' };

// Der Suchbereich lebt bewusst in einem eigenen Dialog, nicht in den
// Einstellungen. Grund: Netzadresse und Subnetzmaske hier legen nur fest,
// welchen Adressbereich Postbuch einmalig abklopft – sie ändern nichts an der
// Konfiguration. Im Einstellungsformular nebeneinander würde der Nutzer sonst
// annehmen, hier eine LAN-Einstellung von Postbuch zu setzen.
// `primary` = der auffällige Verlaufsknopf des Assistenten. Ein automatisches
// Öffnen gibt es bewusst nicht: ein Dialog, der ungefragt aufspringt, sobald
// man einen Schritt betritt, nimmt dem Nutzer die Entscheidung ab, ob er
// überhaupt suchen will.
export default function ScannerDiscoveryCard({ onSelect, primary = false }) {
  const [offen, setOffen] = useState(false);

  return (
    <>
      <Button
        type="button"
        variant={primary ? 'default' : 'outline'}
        size={primary ? 'lg' : 'sm'}
        className={primary ? 'btn-gradient w-full text-white font-semibold sm:w-auto' : 'h-8 text-xs'}
        onClick={() => setOffen(true)}
      >
        <Search className="h-4 w-4 mr-1.5" />
        Scanner im Netzwerk suchen
      </Button>
      <DiscoveryDialog
        open={offen}
        onOpenChange={setOffen}
        onSelect={(treffer) => { onSelect?.(treffer); setOffen(false); }}
      />
    </>
  );
}

function DiscoveryDialog({ open, onOpenChange, onSelect }) {
  const [ip, setIp] = useState('192.168.1.0');
  const [maske, setMaske] = useState('255.255.255.0');
  const [selbstEditiert, setSelbstEditiert] = useState(false);
  const [port, setPort] = useState('alle');
  const [protokoll, setProtokoll] = useState('alle');

  // Postbuch schlägt anhand seiner eigenen LAN-Adresse ein Startnetz vor. Nur
  // solange der Nutzer die Felder noch nicht selbst angefasst hat und nur,
  // solange der Dialog offen ist.
  const vorschlag = useQuery({
    queryKey: ['scanner-netzvorschlag'],
    queryFn: () => api.settings.scannerNetzvorschlag(),
    staleTime: 5 * 60 * 1000,
    enabled: open,
  });
  useEffect(() => {
    const v = vorschlag.data?.vorschlag;
    if (v && !selbstEditiert) { setIp(v.ip); setMaske(v.maske); }
  }, [vorschlag.data, selbstEditiert]);

  const suche = useMutation({ mutationFn: () => api.settings.scannerDiscover(ip, maske, port, protokoll) });
  const treffer = suche.data?.treffer || [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="xl">
      <DialogTitle className="flex items-center gap-1.5">
        <Search className="h-4 w-4 text-primary" />Scanner im Netzwerk suchen
      </DialogTitle>
      <DialogDescription>
        Diese Suche durchsucht einmalig einen Adressbereich nach eSCL-Geräten.
      </DialogDescription>

      <div className="mt-4 space-y-3">
        <div className="flex items-start gap-2 rounded-md border border-border/60 bg-muted/40 p-2.5 text-xs text-muted-foreground">
          <Info className="h-4 w-4 shrink-0 text-primary mt-0.5" />
          <p>
            Netzadresse und Subnetzmaske gehören nur zu dieser Suche – sie ändern nichts an postbuch.net,
            sondern legen fest, welchen Bereich die Suche abklopft. Geprüft werden ausschließlich
            private IPv4-Netze (Maske 255.255.0.0 bis 255.255.255.252). Port und Verschlüsselung
            werden unabhängig getestet – auch unverschlüsseltes HTTP auf Port 443 und HTTPS;
            Scanner-Zertifikate dürfen self-signed, abgelaufen oder namensfalsch sein.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Input
            value={ip}
            onChange={(e) => { setIp(e.target.value); setSelbstEditiert(true); }}
            placeholder="192.168.1.0"
            aria-label="Netzadresse (IPv4)"
            className="h-9 min-w-40 flex-1 font-mono text-sm"
          />
          <Input
            value={maske}
            onChange={(e) => { setMaske(e.target.value); setSelbstEditiert(true); }}
            placeholder="255.255.255.0"
            aria-label="Subnetzmaske"
            className="h-9 min-w-40 flex-1 font-mono text-sm"
          />
          <select
            value={protokoll}
            onChange={(e) => setProtokoll(e.target.value)}
            aria-label="Scanner-Protokoll"
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="alle">HTTP und HTTPS</option>
            <option value="http">Nur HTTP</option>
            <option value="https">Nur HTTPS</option>
          </select>
          <select
            value={port}
            onChange={(e) => setPort(e.target.value === 'alle' ? 'alle' : Number(e.target.value))}
            aria-label="Scanner-Port"
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="alle">Ports 80, 443 und 8080</option>
            <option value={80}>Port 80</option>
            <option value={443}>Port 443</option>
            <option value={8080}>Port 8080</option>
          </select>
          <Button type="button" className="h-9" onClick={() => suche.mutate()} disabled={suche.isPending}>
            <Search className={`h-4 w-4 mr-1.5 ${suche.isPending ? 'animate-pulse' : ''}`} />
            {suche.isPending ? 'Suche läuft…' : 'Durchsuchen'}
          </Button>
        </div>

        {suche.isError && <Testergebnis status="fehler">{suche.error?.message || 'Netzwerksuche fehlgeschlagen.'}</Testergebnis>}
        {suche.isSuccess && treffer.length === 0 && (
          <Testergebnis>Kein eSCL-Scanner gefunden. Prüfe Netz und Port oder trage die Geräte-URL manuell ein.</Testergebnis>
        )}
        {treffer.length > 0 && (
          <div className="space-y-2 max-h-72 overflow-y-auto" aria-live="polite">
            {treffer.map((t) => (
              <div key={t.url} className="flex flex-wrap items-center gap-3 rounded-md border bg-background p-3">
                <ScanLine className="h-4 w-4 text-primary shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{t.geraet || 'eSCL-Scanner'}</p>
                  <p className="font-mono text-xs text-muted-foreground break-all">{t.url}</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {Object.entries(t.capabilities?.quellen || {}).map(([id, q]) => (
                      `${QUELLEN[id] || id}: ${(q.aufloesungen || []).join('/')} dpi`
                    )).join(' · ')}
                  </p>
                </div>
                <Button type="button" size="sm" onClick={() => onSelect?.(t)}>
                  Übernehmen
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => onOpenChange?.(false)}>Schließen</Button>
      </DialogFooter>
    </Dialog>
  );
}
