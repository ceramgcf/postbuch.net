/**
 * PushInstanzCard – Web-Push für die ganze Instanz erlauben oder abschalten.
 *
 * Admin-only. Die persönlichen Push-Schalter darunter gelten je Nutzer; diese
 * Karte ist der eine Schalter, mit dem ein Admin sicherstellt, dass keine
 * Benachrichtigung über den Push-Dienst eines Browserherstellers läuft.
 * Abschalten löscht serverseitig alle Geräte-Abonnements; nach dem
 * Wiedererlauben abonniert jede Person selbst neu.
 *
 * Die Empfängerliste kommt vom Server (ermittlePushEmpfaenger in
 * app/src/lib/webpush.js) und enthält nur Name, Geräteanzahl und den
 * Anbieternamen des Push-Dienstes, nie die Endpunkte.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Dialog, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import { BellOff, Smartphone, ShieldCheck } from 'lucide-react';

function geraeteText(n) {
  return n === 1 ? '1 Gerät' : `${n} Geräte`;
}

/** Wer gerade Push bekommt – auch im Cloudfrei-Check verwendet. */
export function PushEmpfaengerListe({ empfaenger }) {
  if (!empfaenger?.length) return null;
  return (
    <ul className="space-y-1">
      {empfaenger.map((e, i) => (
        <li key={`${e.name}-${i}`} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
          <Smartphone className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="font-medium">{e.name}</span>
          <span className="text-muted-foreground">
            {geraeteText(e.geraete)} · {e.dienste.join(', ')}
          </span>
        </li>
      ))}
    </ul>
  );
}

export default function PushInstanzCard() {
  const qc = useQueryClient();
  const [bestaetigen, setBestaetigen] = useState(false);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['webpush-instanz'],
    queryFn: () => api.settings.notifications.webpush.get(),
    retry: false,
  });

  const umschalten = useMutation({
    mutationFn: (erlaubt) => api.settings.notifications.webpush.set(erlaubt),
    onSuccess: () => {
      setBestaetigen(false);
      qc.invalidateQueries({ queryKey: ['webpush-instanz'] });
      qc.invalidateQueries({ queryKey: ['push-status'] });
      qc.invalidateQueries({ queryKey: ['cloudfrei-check'] });
    },
  });

  const erlaubt = data?.erlaubt !== false;
  const empfaenger = data?.empfaenger ?? [];

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center gap-2">
          {erlaubt ? <ShieldCheck className="h-5 w-5 text-primary" /> : <BellOff className="h-5 w-5 text-muted-foreground" />}
          <CardTitle className="text-base">Push auf dieser Instanz</CardTitle>
          {data && (
            <Badge variant="secondary" className="text-xs">{erlaubt ? 'Erlaubt' : 'Abgeschaltet'}</Badge>
          )}
          {isLoading && <Spinner className="h-3.5 w-3.5" />}
        </div>
        <CardDescription className="text-xs pt-1">
          Push-Nachrichten laufen über den Push-Dienst des jeweiligen Browserherstellers
          (Google, Mozilla, Apple, Microsoft). Abgeschaltet gilt das für alle Personen
          dieser Instanz.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {isError && <p className="text-sm text-destructive">Status konnte nicht geladen werden.</p>}

        {data && erlaubt && (
          empfaenger.length > 0 ? (
            <div className="space-y-1.5">
              <p className="text-xs text-muted-foreground">Bekommt gerade Push-Nachrichten:</p>
              <PushEmpfaengerListe empfaenger={empfaenger} />
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              Derzeit bekommt niemand Push-Nachrichten. Jede Person kann Push für sich
              einschalten, solange es hier erlaubt ist.
            </p>
          )
        )}

        {data && !erlaubt && (
          <p className="text-xs text-muted-foreground">
            Niemand kann Push abonnieren, und es werden keine Push-Nachrichten verschickt.
          </p>
        )}

        {data && (
          erlaubt ? (
            <Button size="sm" variant="outline" onClick={() => setBestaetigen(true)} disabled={umschalten.isPending}>
              Für alle abschalten
            </Button>
          ) : (
            <Button size="sm" onClick={() => umschalten.mutate(true)} disabled={umschalten.isPending}>
              {umschalten.isPending ? 'Speichern…' : 'Wieder erlauben'}
            </Button>
          )
        )}
        {umschalten.isError && !bestaetigen && <p className="text-sm text-destructive">{umschalten.error?.message}</p>}
      </CardContent>

      <Dialog open={bestaetigen} onOpenChange={(o) => { if (!o && !umschalten.isPending) setBestaetigen(false); }}>
        <DialogTitle>Push für alle abschalten?</DialogTitle>
        <DialogDescription className="mt-2 space-y-2">
          <span className="block">
            Alle gespeicherten Geräte-Abonnements werden gelöscht
            {empfaenger.length > 0 ? ` – das betrifft ${empfaenger.map((e) => e.name).join(', ')}` : ''}.
            Danach verschickt postbuch.net keine Push-Nachrichten mehr.
          </span>
          <span className="block">
            Wird Push später wieder erlaubt, muss jede Person ihr Gerät neu abonnieren.
            Die persönlichen Einstellungen bleiben erhalten.
          </span>
        </DialogDescription>
        {umschalten.isError && <p className="mt-3 text-sm text-destructive">{umschalten.error?.message}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => setBestaetigen(false)} disabled={umschalten.isPending}>Abbrechen</Button>
          <Button variant="destructive" onClick={() => umschalten.mutate(false)} disabled={umschalten.isPending}>
            {umschalten.isPending ? 'Abschalten…' : 'Für alle abschalten'}
          </Button>
        </DialogFooter>
      </Dialog>
    </Card>
  );
}
