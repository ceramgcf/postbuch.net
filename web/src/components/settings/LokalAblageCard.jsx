/**
 * LokalAblageCard – Dateiablage in einem Ordner auf diesem Rechner.
 *
 * Es gibt nichts zu verbinden: Der Ordner wird bei der Installation
 * eingebunden. Die Karte zeigt, welcher Ordner das ist, wie viel Platz frei
 * ist, bietet den Selbsttest der Ablage-Schnittstelle an und den Umzug in
 * einen anderen Ordner über den Host-Agenten.
 */

import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import LokalAblageOrdnerWechsel from './LokalAblageOrdnerWechsel';
import { HardDrive, CheckCircle2, XCircle, ShieldAlert, PlayCircle, AlertTriangle } from 'lucide-react';

function gb(bytes) {
  if (bytes == null) return '–';
  return `${(bytes / 1024 ** 3).toLocaleString('de-DE', { maximumFractionDigits: 1 })} GB`;
}

export default function LokalAblageCard() {
  const [selftest, setSelftest] = useState(null);
  const { data: status, isLoading } = useQuery({
    queryKey: ['lokal-ablage-status'],
    queryFn: () => api.storage.lokalStatus(),
    retry: false,
  });
  const selftestMutation = useMutation({
    mutationFn: () => api.storage.selftest('lokal'),
    onSuccess: (r) => setSelftest(r),
    onError: (e) => setSelftest({ ok: false, schritte: [], fehler: e.message }),
  });

  const bestanden = selftest?.schritte?.filter((s) => s.ok).length ?? 0;
  const gesamt = selftest?.schritte?.length ?? 0;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <HardDrive className={`h-5 w-5 ${status?.verfuegbar ? 'text-emerald-500' : 'text-muted-foreground'}`} />
          <CardTitle className="text-base">Ordner auf diesem Rechner</CardTitle>
          {status?.verfuegbar && <Badge variant="default" className="ml-auto text-xs">Bereit</Badge>}
          {status?.verfuegbar && !status?.aktiv && <Badge variant="secondary" className="text-xs">nicht aktiv</Badge>}
        </div>
        <CardDescription className="text-xs pt-1">
          Die Dokumente liegen als gewöhnliche PDF-Dateien in einem Ordner auf diesem Rechner. Du
          kannst sie dort jederzeit ansehen und mit deinem gewohnten Werkzeug sichern. Umbenannte oder
          verschobene Dateien findet postbuch.net über ihren Fingerabdruck wieder.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner className="h-4 w-4" />Wird geprüft…</div>
        ) : status?.verfuegbar ? (
          <div className="grid gap-2 text-sm sm:grid-cols-[auto_1fr]">
            <span className="text-muted-foreground">Ordner</span>
            <span className="font-mono break-all">{status.pfad}</span>
            <span className="text-muted-foreground">Frei</span>
            <span>{gb(status.freiBytes)} von {gb(status.gesamtBytes)}</span>
          </div>
        ) : (
          <div className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <p>{status?.meldung || 'Auf diesem Rechner ist kein lokaler Ablageordner eingebunden.'}</p>
            </div>
          </div>
        )}

        <div className="rounded-xl border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          Sicherung: postbuch.net sichert die Datenbank in den Ordner <span className="font-mono">_backup</span> der
          Ablage. Die Ablage selbst liegt nur auf diesem Rechner – sichere den ganzen Ordner regelmäßig
          auf ein anderes Laufwerk oder in einen Cloud-Speicher deiner Wahl.
        </div>

        {status && <LokalAblageOrdnerWechsel aktuell={status.pfad} festgelegt={status.festgelegt !== false} />}

        {status?.verfuegbar && (
          <div className="border-t border-border/60 pt-4 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div>
                <p className="text-sm font-medium">Selbsttest</p>
                <p className="text-xs text-muted-foreground">
                  Legt in einem eigenen Testordner Dateien an, prüft Umlaute, Namenskollisionen,
                  Prüfsummen und Pfadsicherheit – und räumt alles wieder ab.
                </p>
              </div>
              {selftest && gesamt > 0 && (
                <Badge variant={selftest.ok ? 'default' : 'secondary'} className="text-xs shrink-0">
                  {selftest.ok ? `Alle ${gesamt} bestanden` : `${gesamt - bestanden} von ${gesamt} fehlgeschlagen`}
                </Badge>
              )}
            </div>
            <Button size="sm" variant="outline" onClick={() => selftestMutation.mutate()} disabled={selftestMutation.isPending}>
              {selftestMutation.isPending ? <><Spinner className="h-3.5 w-3.5 mr-1.5" />Läuft…</> : <><PlayCircle className="h-3.5 w-3.5 mr-1.5" />Selbsttest starten</>}
            </Button>
            {selftest?.fehler && <p className="text-xs text-destructive">{selftest.fehler}</p>}
            {gesamt > 0 && (
              <div className="rounded-lg border border-border/60 divide-y divide-border/40">
                {selftest.schritte.map((s, i) => (
                  <div key={i} className="px-3 py-1.5">
                    <div className="flex items-center gap-2">
                      {s.ok
                        ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 flex-shrink-0" />
                        : s.sicherheitsrelevant
                          ? <ShieldAlert className="h-3.5 w-3.5 text-red-600 flex-shrink-0" />
                          : <XCircle className="h-3.5 w-3.5 text-amber-500 flex-shrink-0" />}
                      <span className="text-xs flex-1">{s.name}</span>
                      <span className="text-[10px] text-muted-foreground/60 font-mono">{s.dauerMs} ms</span>
                    </div>
                    {!s.ok && (
                      <p className="text-xs text-destructive pl-5.5 mt-0.5">
                        {s.sicherheitsrelevant && <span className="font-semibold">Sicherheitsrelevant: </span>}
                        {typeof s.detail === 'string' ? s.detail : JSON.stringify(s.detail)}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
