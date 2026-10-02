/**
 * CloudfreiCard – „Verlässt hier gerade etwas das Haus?"
 *
 * Reines Rendering. Die Einstufung kommt vollständig aus
 * `GET /api/settings/cloudfree-check` (app/src/lib/cloudfrei.js) – eine
 * hartkodierte Liste „anthropic/openai = Cloud" im JSX würde einen frei
 * angelegten OpenRouter-Provider als lokal ausweisen und beim nächsten
 * Provider veralten. Als Frontend-Liste wäre die Karte Dekoration; als
 * Backend-Bericht ist sie die Regressionssicherung gegen künftige fest
 * verdrahtete Cloud-Aufrufe.
 *
 * Die Achse ist „verlässt Daten das Haus", nicht „lokal vs. Cloud": Discord,
 * Push und dynamisches DNS können nie lokal sein, stünden unter einer strikten
 * Lokal-Achse also immer auf Rot – auch wenn der Nutzer sie bewusst
 * eingeschaltet hat. Grün heißt dort schlicht „nicht aktiviert".
 *
 * Badge bewusst `secondary`, nie `destructive`: auch 0/13 ist eine Information
 * über eine getroffene Wahl, kein Fehlerzustand.
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { Home, ChevronDown, ChevronRight, Check, ArrowUpRight } from 'lucide-react';
import { PushEmpfaengerListe } from '@/components/settings/PushInstanzCard';

export default function CloudfreiCard() {
  const [offen, setOffen] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['cloudfrei-check'],
    queryFn: () => api.settings.cloudfreiCheck(),
    retry: false,
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Home className="h-5 w-5 text-muted-foreground" />
            <CardTitle className="text-base">Cloudfrei-Check</CardTitle>
            {data && (
              <Badge variant="secondary" className="text-[10px]">
                {data.lokal}/{data.gesamt} bleibt im Haus
              </Badge>
            )}
            {isLoading && <Spinner className="h-3.5 w-3.5" />}
          </div>
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setOffen(!offen)}>
            {offen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </Button>
        </div>
        <CardDescription className="text-xs pt-1">
          Wo verlassen Daten dieser Instanz das eigene Netz – und wo nicht.
        </CardDescription>
      </CardHeader>

      {offen && data && (
        <CardContent className="pt-0">
          <div className="divide-y divide-border/40">
            {data.zeilen.map((z) => (
              <div key={z.id} className="py-1.5">
                <div className="flex items-center gap-3">
                  {z.lokal
                    ? <Check className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                    : <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-amber-600" />}
                  <span className="text-xs flex-1 min-w-0 truncate">{z.label}</span>
                  <span className={`text-xs shrink-0 ${z.lokal ? 'text-muted-foreground' : 'text-amber-700 dark:text-amber-500'}`}>
                    {z.detail}
                  </span>
                </div>
                {z.personen?.length > 0 && (
                  <div className="mt-1.5 ml-6.5 space-y-1">
                    <PushEmpfaengerListe empfaenger={z.personen} />
                    <p className="text-[11px] text-muted-foreground">
                      Für alle abschaltbar unter Benachrichtigungen → Push auf dieser Instanz.
                    </p>
                  </div>
                )}
              </div>
            ))}
          </div>
          <p className="mt-3 text-[11px] text-muted-foreground">
            Grün heißt: bleibt im eigenen Netz oder ist nicht aktiviert. Amber ist keine
            Warnung – nur die Feststellung, dass hier etwas nach außen geht.
          </p>
        </CardContent>
      )}
    </Card>
  );
}
