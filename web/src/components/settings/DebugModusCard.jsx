import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Bug } from 'lucide-react';
import { api } from '@/api/client';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { useDebugModus, DEBUG_MODUS_KEY } from '@/hooks/useDebugModus';

// Instanzweiter Debug-Modus. Wirkt sofort, unabhängig von „Einstellungen
// speichern“ der übrigen Karten.
export default function DebugModusCard() {
  const qc = useQueryClient();
  const an = useDebugModus();
  const umschalten = useMutation({
    mutationFn: (wert) => api.settingsPublic.setDebugMode(wert),
    onSuccess: (r) => qc.setQueryData(DEBUG_MODUS_KEY, { enabled: r.enabled }),
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2"><Bug className="h-5 w-5 text-primary" /><CardTitle className="text-base">Debug-Modus</CardTitle></div>
        <CardDescription className="text-xs pt-1">Zusätzliche Diagnosedaten für die Fehlersuche. Gilt für die ganze Instanz; nur Admins können ihn schalten.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex items-start justify-between gap-4">
          <span>
            <span className="block text-sm font-medium">Debug-Modus {an ? 'an' : 'aus'}</span>
            <span className="block text-xs text-muted-foreground">
              Speichert je verarbeitetem Dokument ein ausführliches Pipeline-Protokoll (JSON) im Ordner
              <code className="mx-1">_debug</code>der Ablage, zeigt auf der Seite Importieren den Knopf „Kamera-Diagnose“ und unter Persönlich die Wahl von Kamera und Livebild für den Kamerascan.
            </span>
          </span>
          <Switch checked={an} disabled={umschalten.isPending} onCheckedChange={(wert) => umschalten.mutate(wert)} label="Debug-Modus" />
        </div>
        {umschalten.isError && <p className="text-sm text-destructive">{umschalten.error?.message}</p>}
      </CardContent>
    </Card>
  );
}
