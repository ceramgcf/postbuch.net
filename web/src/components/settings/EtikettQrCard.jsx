import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { QrCode } from 'lucide-react';
import { api } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';

const KEY = 'etikett_qr_erkennung';

// Welche Etiketten-QR-Codes der Kamerascan als Sprung ins Dokument erkennt:
// immer die aktuelle Adresse, dazu Aliase – oder jede Adresse.
export default function EtikettQrCard() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['settings-public'],
    queryFn: () => api.settingsPublic.getAll(),
    staleTime: 60_000,
  });
  const gespeichert = data?.[KEY]?.value ?? { aliase: [], alleAdressen: false };
  const [aliase, setAliase] = useState('');
  const [alle, setAlle] = useState(false);

  useEffect(() => {
    setAliase((gespeichert.aliase ?? []).join('\n'));
    setAlle(gespeichert.alleAdressen === true);
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  const speichern = useMutation({
    mutationFn: (wert) => api.settings.update(KEY, wert),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['settings-public'] });
      qc.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  const liste = aliase.split(/[\s,;]+/).map((a) => a.trim()).filter(Boolean);
  const geaendert = alle !== (gespeichert.alleAdressen === true)
    || liste.join('\n') !== (gespeichert.aliase ?? []).join('\n');
  const host = typeof window !== 'undefined' ? window.location.host : '';

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <QrCode className="h-4 w-4 text-primary" />
          Etiketten im Kamerascan
        </CardTitle>
        <CardDescription>
          Hält jemand ein Etikett vor die Kamera, öffnet der Kamerascan das Dokument. Der QR-Code
          trägt die Adresse, unter der das Etikett gedruckt wurde. Erkannt wird immer die aktuelle
          Adresse <code>{host}</code>; alle anderen QR-Codes gelten als Teil des Papiers.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <label htmlFor="etikett-qr-aliase" className="text-sm font-medium">Weitere Adressen dieser Instanz</label>
          <textarea
            id="etikett-qr-aliase"
            value={aliase}
            onChange={(e) => setAliase(e.target.value)}
            disabled={alle}
            rows={3}
            placeholder={'192.168.1.20:3420\npostbuch.example.org'}
            className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
          />
          <p className="text-xs text-muted-foreground">
            Eine Adresse je Zeile, mit Port, falls einer im Etikett steht. Nützlich, wenn Etiketten
            auch über eine IP-Adresse oder eine frühere Domain gedruckt wurden.
          </p>
        </div>
        <div className="flex items-start justify-between gap-4">
          <span>
            <span className="block text-sm font-medium">Adresse nicht prüfen</span>
            <span className="block text-xs text-muted-foreground">
              Jeder QR-Code der Form <code>…/postbuch/P000123</code> öffnet das Dokument, gleich welche
              Adresse davor steht – auch Etiketten anderer Instanzen.
            </span>
          </span>
          <Switch checked={alle} onCheckedChange={setAlle} label="Adresse nicht prüfen" />
        </div>
        <div className="flex items-center gap-3">
          <Button size="sm" disabled={!geaendert || speichern.isPending}
            onClick={() => speichern.mutate({ aliase: liste, alleAdressen: alle })}>
            Speichern
          </Button>
          {speichern.isError && <span className="text-sm text-destructive">{speichern.error?.message}</span>}
          {speichern.isSuccess && !geaendert && <span className="text-xs text-muted-foreground">Gespeichert</span>}
        </div>
      </CardContent>
    </Card>
  );
}
