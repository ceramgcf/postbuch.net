/**
 * Port-Freigaben über den Host-Agenten (admin-only)
 *
 *   • ScannerFreigabe – Scan-Webhook für andere Geräte im Netz (SCANNER_BIND).
 *   • ErreichbarkeitCard – Oberfläche nur über HTTPS (WEB_BIND).
 *
 * Die App ändert nichts selbst: Sie schreibt einen Hostauftrag „freigabe“, der
 * Host-Agent setzt den Wert in der .env und erstellt den betroffenen Container
 * neu. Den Ist-Zustand meldet der Agent bei jedem Lauf zurück.
 *
 * „Nur über HTTPS“ lässt sich nur aus einer HTTPS-Sitzung schalten und muss
 * danach binnen zwei Minuten bestätigt werden; sonst öffnet der Agent die
 * Oberfläche wieder für das Heimnetz.
 */

import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Dialog, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Testergebnis } from '@/components/ui/testergebnis';
import { Lock } from 'lucide-react';

const AUFTRAG_LIEGT = 'Der Auftrag liegt beim Host-Agenten. Er führt ihn beim nächsten Lauf aus (in der Regel innerhalb einer Minute).';

/** Gemeinsamer Zustand: Agent-Status, Auftrag und Polling bis zur Rückmeldung. */
function useFreigabe() {
  const [auftrag, setAuftrag] = useState(null); // { nonce, dienst, ziel }
  const nonce = auftrag?.nonce ?? null;
  // Wartet, bis der Lauf beendet ist und der Heartbeat den neuen Zustand meldet.
  const wartetAufAgent = (d) => !!auftrag && (
    !!d?.anforderung || d?.lauf?.nonce !== auftrag.nonce || d.lauf.status === 'laeuft'
      || (d.lauf.status === 'erfolgreich' && d.agent?.freigaben?.[auftrag.dienst] !== auftrag.ziel)
  );
  const updates = useQuery({
    queryKey: ['updates'],
    queryFn: () => api.updates.get(),
    retry: false,
    refetchInterval: (query) => {
      const d = query.state.data;
      return wartetAufAgent(d) || d?.agent?.webBestaetigungBis ? 3000 : false;
    },
  });
  const agent = updates.data?.agent;
  const lauf = nonce && updates.data?.lauf?.nonce === nonce ? updates.data.lauf : null;
  const schalten = useMutation({
    mutationFn: (wert) => api.updates.hostconfig('freigabe', wert),
    onSuccess: (res, wert) => {
      const [dienst, ziel] = wert.split(':');
      setAuftrag({ nonce: res.nonce, dienst, ziel });
      updates.refetch();
    },
  });
  const steuerbar = !!agent?.vorhanden && !!agent.capabilities?.includes('freigabe');
  const laeuft = schalten.isPending || wartetAufAgent(updates.data);
  return { updates, agent, lauf, nonce, schalten, steuerbar, laeuft };
}

function LaufMeldung({ lauf, laeuft, fehler }) {
  if (fehler) return <Testergebnis status="fehler">{fehler.message}</Testergebnis>;
  if (laeuft) return <Testergebnis status="info">{AUFTRAG_LIEGT}</Testergebnis>;
  if (lauf && lauf.status !== 'erfolgreich') {
    return <Testergebnis status="fehler">{lauf.meldung || 'Der Host-Agent konnte die Freigabe nicht ändern.'}</Testergebnis>;
  }
  return null;
}

export function ScannerFreigabe() {
  const { agent, lauf, schalten, steuerbar, laeuft } = useFreigabe();
  const [frage, setFrage] = useState(false);
  if (!steuerbar) {
    return (
      <p className="text-xs text-muted-foreground">
        Ob der Scan-Webhook für andere Geräte im Netz erreichbar ist, steuert hier der Host-Agent. Ohne ihn
        gilt <code className="font-mono">SCANNER_BIND</code> in der <code className="font-mono">.env</code>:
        leer für freigegeben, <code className="font-mono">127.0.0.1</code> für geschlossen; danach den
        Scanner-Container neu erstellen.
      </p>
    );
  }
  const zustand = agent.freigaben?.scanner;
  const offen = zustand === 'lan';

  return (
    <div className="rounded-lg border border-border/60 bg-muted/30 p-3 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium">Scan-Webhook für andere Geräte im Netz</p>
          <p className="text-xs text-muted-foreground">
            {zustand === 'anders'
              ? 'Von Hand auf eine bestimmte Adresse beschränkt (SCANNER_BIND in der .env).'
              : offen
                ? 'Freigegeben: Smarthome-Knöpfe und Skripte im Heimnetz können mit der Webhook-URL Scans auslösen.'
                : 'Geschlossen: Nur postbuch.net selbst steuert den Scanner. Die Webhook-URL ist nicht erreichbar.'}
          </p>
        </div>
        {zustand !== 'anders' && (offen ? (
          <Button size="sm" variant="outline" onClick={() => setFrage(true)} disabled={laeuft}>
            Schließen
          </Button>
        ) : (
          <Button size="sm" onClick={() => schalten.mutate('scanner:lan')} disabled={laeuft}>
            {laeuft ? 'Wird geschaltet…' : 'Freigeben'}
          </Button>
        ))}
      </div>
      <LaufMeldung lauf={lauf} laeuft={laeuft} fehler={schalten.error} />

      <Dialog open={frage} onOpenChange={(o) => { if (!o) setFrage(false); }}>
        <DialogTitle>Scan-Webhook schließen?</DialogTitle>
        <DialogDescription className="mt-3">
          Kopierte Webhook-URLs auf Smarthome-Knöpfen oder in Skripten funktionieren danach nicht mehr.
          Scannen über postbuch.net selbst bleibt möglich. Freigeben lässt sich der Webhook hier jederzeit wieder.
        </DialogDescription>
        <DialogFooter>
          <Button variant="outline" onClick={() => setFrage(false)}>Abbrechen</Button>
          <Button onClick={() => { setFrage(false); schalten.mutate('scanner:lokal'); }}>Schließen</Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}

function Countdown({ bis }) {
  const [jetzt, setJetzt] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setJetzt(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const rest = Math.max(0, Math.round((Date.parse(bis) - jetzt) / 1000));
  return <span className="tabular-nums">{Math.floor(rest / 60)}:{String(rest % 60).padStart(2, '0')}</span>;
}

export function ErreichbarkeitCard() {
  const { agent, lauf, schalten, steuerbar, laeuft, updates } = useFreigabe();
  const [frage, setFrage] = useState(false);
  // Aus dem Status statt aus dem lokalen Auftrag: Auch nach einem Neuladen der
  // Seite muss sich die offene Bestätigung abschließen lassen.
  const letzterLauf = updates.data?.lauf;
  const offenerLauf = agent?.webBestaetigungBis && letzterLauf?.typ === 'freigabe'
    && letzterLauf.status === 'erfolgreich' ? letzterLauf : null;
  const bestaetigen = useMutation({
    mutationFn: () => api.updates.hostconfigBestaetigen(offenerLauf?.nonce),
    onSuccess: () => updates.refetch(),
  });
  const ueberHttps = typeof window !== 'undefined' && window.location.protocol === 'https:';
  if (!agent?.vorhanden) return null;

  const zustand = agent.freigaben?.web;
  const nurHttps = zustand === 'lokal';
  const offeneBestaetigung = !!offenerLauf;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2"><Lock className="h-5 w-5 text-primary" /><CardTitle className="text-base">Erreichbarkeit</CardTitle></div>
        <CardDescription className="text-xs pt-1">
          {!steuerbar
            ? 'Der installierte Host-Agent kann die Erreichbarkeit noch nicht umschalten. Nach dem nächsten Update geht das hier.'
            : zustand === 'anders'
              ? 'Die Oberfläche ist von Hand auf eine bestimmte Adresse beschränkt (WEB_BIND in der .env).'
              : nurHttps
                ? 'Die Oberfläche ist nur über HTTPS erreichbar. Der direkte Zugang über die IP-Adresse im Heimnetz ist geschlossen.'
                : 'Die Oberfläche ist über HTTPS und zusätzlich direkt über die IP-Adresse im Heimnetz erreichbar, dort ohne Verschlüsselung.'}
        </CardDescription>
      </CardHeader>
      {steuerbar && zustand !== 'anders' && (
        <CardContent className="space-y-3">
          {offeneBestaetigung ? (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 space-y-2">
              <p className="text-sm">
                Kommst du über HTTPS weiter hinein? Dann bestätige jetzt. Ohne Bestätigung öffnet postbuch.net
                die Oberfläche in <Countdown bis={agent.webBestaetigungBis} /> wieder für das Heimnetz.
              </p>
              {bestaetigen.isSuccess ? (
                <Testergebnis status="erfolg">Bestätigt. Der Host-Agent übernimmt das beim nächsten Lauf.</Testergebnis>
              ) : (
                <Button size="sm" onClick={() => bestaetigen.mutate()} disabled={bestaetigen.isPending}>
                  {bestaetigen.isPending ? 'Wird bestätigt…' : 'Bestätigen'}
                </Button>
              )}
              {bestaetigen.isError && <Testergebnis status="fehler">{bestaetigen.error.message}</Testergebnis>}
            </div>
          ) : !ueberHttps ? (
            <p className="text-xs text-muted-foreground">
              Umschalten geht nur, wenn du über HTTPS angemeldet bist.
            </p>
          ) : nurHttps ? (
            <Button size="sm" variant="outline" onClick={() => schalten.mutate('web:lan')} disabled={laeuft}>
              {laeuft ? 'Wird geschaltet…' : 'Im Heimnetz wieder öffnen'}
            </Button>
          ) : (
            <Button size="sm" onClick={() => setFrage(true)} disabled={laeuft}>
              {laeuft ? 'Wird geschaltet…' : 'Nur noch über HTTPS erreichbar machen'}
            </Button>
          )}
          {!offeneBestaetigung && <LaufMeldung lauf={lauf} laeuft={laeuft} fehler={schalten.error} />}
        </CardContent>
      )}

      <Dialog open={frage} onOpenChange={(o) => { if (!o) setFrage(false); }}>
        <DialogTitle>Nur noch über HTTPS erreichbar machen?</DialogTitle>
        <DialogDescription className="mt-3 space-y-2">
          <span className="block">
            Danach erreichst du postbuch.net nur noch über https://{window.location.host}, auch zu Hause.
            Der Zugang über die IP-Adresse des Geräts ist dann geschlossen.
          </span>
          <span className="block">
            Nach dem Umschalten bestätigst du binnen zwei Minuten, dass du weiter hineinkommst. Sonst öffnet
            postbuch.net den Zugang im Heimnetz von selbst wieder. Fällt HTTPS später aus, hilft der Notausgang
            aus der Hilfe (Kapitel Sicherheit).
          </span>
        </DialogDescription>
        <DialogFooter>
          <Button variant="outline" onClick={() => setFrage(false)}>Abbrechen</Button>
          <Button onClick={() => { setFrage(false); schalten.mutate('web:lokal'); }}>Umschalten</Button>
        </DialogFooter>
      </Dialog>
    </Card>
  );
}
