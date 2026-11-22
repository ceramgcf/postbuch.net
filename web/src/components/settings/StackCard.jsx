/**
 * Reiter „Stack“ – alle Docker-Dienste dieser Instanz auf einen Blick (admin-only)
 *
 * Kerndienste laufen immer und haben keine Schalter. Optionale Dienste lassen
 * sich ein- und ausschalten und entfernen; „Einschalten“ richtet einen
 * entfernten Dienst neu ein. Die App schaltet nichts selbst: Sie schreibt den
 * Hostauftrag `module` = `<profil>:an|aus|entfernen`, der Host-Agent führt ihn
 * aus und meldet Zustand, Platz und Grafikkarte im Heartbeat (`stack`).
 *
 * Caddy wird bewusst nicht hier geschaltet – Abschalten kann aussperren. Dafür
 * gibt es unter „Allgemein“ den Erreichbarkeits-Ablauf mit Bestätigung.
 */

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Boxes, Cpu } from 'lucide-react';
import { api } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Dialog, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';
import { Testergebnis } from '@/components/ui/testergebnis';

const STUFEN = {
  'gpu-voll': 'Grafikkarte, vollständig',
  'gpu-10': 'Grafikkarte, verkleinerter Kontext',
  'gpu-teil': 'Grafikkarte und Prozessor',
  cpu: 'nur Prozessor',
};

function gb(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return null;
  const wert = bytes / 1e9;
  return `${wert.toLocaleString('de-DE', { maximumFractionDigits: wert < 10 ? 1 : 0 })} GB`;
}

function ramText(mib) {
  if (!Number.isFinite(mib) || mib <= 0) return null;
  return mib >= 1024
    ? `${(mib / 1024).toLocaleString('de-DE', { maximumFractionDigits: 1 })} GB`
    : `${mib} MB`;
}

function zustandAnzeige(d, bekannt) {
  if (!bekannt) return { text: 'Unbekannt', klasse: 'bg-muted text-muted-foreground' };
  if (!d.installiert) return { text: 'Nicht installiert', klasse: 'bg-muted text-muted-foreground' };
  // Eingeschaltet, aber das Modell fehlt noch: Der Dienst kann nicht antworten,
  // auch wenn sein Container schon steht.
  if (d.id === 'lokalki' && d.profilAktiv && d.lokalki && d.lokalki.vollstaendig === false) {
    return { text: 'Modell wird geladen', klasse: 'bg-amber-500/15 text-amber-700 dark:text-amber-400' };
  }
  if (d.zustand === 'running') {
    if (d.health === 'unhealthy') return { text: 'Gestört', klasse: 'bg-red-500/15 text-red-600 dark:text-red-400' };
    if (d.health === 'starting') return { text: 'Startet', klasse: 'bg-amber-500/15 text-amber-700 dark:text-amber-400' };
    return { text: 'Läuft', klasse: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400' };
  }
  if (d.profilAktiv) return { text: 'Läuft nicht', klasse: 'bg-red-500/15 text-red-600 dark:text-red-400' };
  return { text: 'Angehalten', klasse: 'bg-muted text-muted-foreground' };
}

function laeuftOderAn(d) {
  return d.zustand === 'running' || d.profilAktiv === true;
}

export default function StackCard() {
  const qc = useQueryClient();
  const [frage, setFrage] = useState(null); // { dienst, aktion, klassen? }
  const [auftrag, setAuftrag] = useState(null); // { nonce, id, aktion }

  const updates = useQuery({
    queryKey: ['updates'],
    queryFn: () => api.updates.get(),
    retry: false,
    refetchInterval: (q) => (q.state.data?.anforderung || q.state.data?.lauf?.status === 'laeuft' ? 3000 : false),
  });
  const beschaeftigtAgent = !!updates.data?.anforderung || updates.data?.lauf?.status === 'laeuft';
  const stack = useQuery({
    queryKey: ['updates-stack'],
    queryFn: () => api.updates.stack(),
    retry: false,
    refetchInterval: beschaeftigtAgent ? 3000 : 30000,
  });

  const schalten = useMutation({
    mutationFn: ({ dienst, aktion, bestaetigt }) =>
      api.updates.hostconfig('module', `${dienst.id}:${aktion}`, undefined, { bestaetigt }),
    onSuccess: (res, { dienst, aktion }) => {
      setAuftrag({ nonce: res.nonce, id: dienst.id, aktion });
      qc.invalidateQueries({ queryKey: ['updates'] });
    },
    onError: (err, vars) => {
      if (err.status === 409 && err.payload?.bestaetigungNoetig) {
        setFrage({ ...vars, klassen: err.payload.klassen || [] });
      }
    },
  });

  // Nach Ende eines Laufs den Stack sofort neu lesen, nicht erst beim nächsten Intervall.
  const laufStatus = updates.data?.lauf?.status;
  useEffect(() => {
    if (laufStatus && laufStatus !== 'laeuft') qc.invalidateQueries({ queryKey: ['updates-stack'] });
  }, [laufStatus, qc]);

  const daten = stack.data;
  const agent = daten?.agent;
  const steuerbar = !!agent?.stackFaehig;
  const gesperrt = schalten.isPending || beschaeftigtAgent;
  const lauf = auftrag && updates.data?.lauf?.nonce === auftrag.nonce ? updates.data.lauf : null;

  if (stack.isLoading) return <p className="text-sm text-muted-foreground">Stack wird gelesen…</p>;
  if (stack.error) return <Testergebnis status="fehler">{stack.error.message}</Testergebnis>;

  const kern = daten.dienste.filter((d) => d.art === 'kern');
  const optional = daten.dienste.filter((d) => d.art === 'optional');

  let meldung = null;
  if (schalten.error && !(schalten.error.status === 409 && schalten.error.payload?.bestaetigungNoetig)) {
    meldung = <Testergebnis status="fehler">{schalten.error.message}</Testergebnis>;
  } else if (gesperrt) {
    // Aus dem Agentenstatus, nicht aus dem lokalen Auftrag: Auch nach einem
    // Neuladen mitten im Modell-Download bleibt der Fortschritt sichtbar.
    const laufend = updates.data?.lauf?.status === 'laeuft' ? updates.data.lauf : null;
    meldung = <AuftragsFortschritt lauf={laufend} />;
  } else if (lauf && lauf.status !== 'erfolgreich') {
    meldung = <Testergebnis status="fehler">{lauf.meldung || 'Der Host-Agent konnte den Auftrag nicht ausführen.'}</Testergebnis>;
  } else if (lauf?.status === 'erfolgreich') {
    meldung = <Testergebnis status="erfolg">Erledigt.</Testergebnis>;
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2"><Boxes className="h-5 w-5 text-primary" /><CardTitle className="text-base">Stack</CardTitle></div>
        <CardDescription className="text-xs pt-1">
          Die Dienste dieser Instanz mit Zustand, Platz auf der Festplatte und Arbeitsspeicher unter Last.
          {gb(daten.platteFreiBytes) && ` Frei auf der Festplatte: ${gb(daten.platteFreiBytes)}.`}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {meldung}

        <Gruppe titel="Kern – läuft immer">
          {kern.map((d) => <DienstZeile key={d.id} dienst={d} bekannt={!!agent?.vorhanden && steuerbar} />)}
        </Gruppe>

        <Gruppe titel="Optional">
          {optional.map((d) => (
            <DienstZeile
              key={d.id}
              dienst={d}
              bekannt={!!agent?.vorhanden && steuerbar}
              gpu={daten.gpu}
              eignung={daten.lokalkiEignung}
              steuerbar={steuerbar}
              gesperrt={gesperrt}
              onAktion={(aktion) => setFrage({ dienst: d, aktion })}
            />
          ))}
        </Gruppe>

        <AgentZeile agent={agent} />
      </CardContent>

      <AktionsDialog
        frage={frage}
        platteFreiBytes={daten.platteFreiBytes}
        klassenAufLokalerKi={daten.klassenAufLokalerKi}
        onAbbrechen={() => setFrage(null)}
        onBestaetigen={(bestaetigt) => {
          const f = frage;
          setFrage(null);
          schalten.reset();
          schalten.mutate({ dienst: f.dienst, aktion: f.aktion, bestaetigt });
        }}
      />
    </Card>
  );
}

function Gruppe({ titel, children }) {
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{titel}</p>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function AuftragsFortschritt({ lauf }) {
  const gesamt = lauf?.gesamtBytes;
  const bytes = lauf?.fortschrittBytes;
  const mitWert = Number.isFinite(gesamt) && gesamt > 0 && Number.isFinite(bytes);
  return (
    <div className="space-y-2 rounded-lg border border-border/60 bg-muted/30 p-3">
      <p className="text-sm">{lauf?.meldung || 'Der Auftrag liegt beim Host-Agenten. Er holt ihn innerhalb einer Minute ab.'}</p>
      <Progress value={mitWert ? (bytes / gesamt) * 100 : 0} indeterminate={!mitWert} />
      {mitWert && <p className="text-xs text-muted-foreground">{gb(bytes) || '0 GB'} von {gb(gesamt)}</p>}
      <p className="text-xs text-muted-foreground">
        Diese Seite darf geschlossen werden; der Host-Agent arbeitet weiter. Bis der Auftrag fertig ist,
        sind die Schalter gesperrt.
      </p>
    </div>
  );
}

function DienstZeile({ dienst: d, bekannt, gpu, eignung, steuerbar, gesperrt, onAktion }) {
  const anzeige = zustandAnzeige(d, bekannt);
  const lk = d.id === 'lokalki' ? d.lokalki : null;
  // Zu wenig Speicher oder Platz: Einschalten gesperrt (prüfen Server und Agent auch).
  const lkSperre = d.id === 'lokalki' ? eignung?.sperrgrund || null : null;
  const platte = [
    gb(d.imageBytes) && `Image ${gb(d.imageBytes)}`,
    lk && (lk.vorhandenBytes > 0 || d.installiert) && gb(lk.vorhandenBytes) && `Modell ${gb(lk.vorhandenBytes)}`,
  ].filter(Boolean);
  const meta = [
    platte.length ? `Festplatte: ${platte.join(' + ')}` : null,
    ramText(d.ramMiB) && `Arbeitsspeicher bis etwa ${ramText(d.ramMiB)}`,
  ].filter(Boolean);

  let knoepfe = null;
  if (d.verweis === 'duckdns') {
    knoepfe = (
      <a href="/einstellungen?tab=allgemein" className="text-xs text-primary underline underline-offset-2">
        Unter „Allgemein“ → Erreichbarkeit
      </a>
    );
  } else if (steuerbar && d.aktionen.length) {
    const an = laeuftOderAn(d);
    knoepfe = (
      <>
        {lk?.modellVeraltet && an && (
          <Button size="sm" onClick={() => onAktion('an')} disabled={gesperrt || !!lkSperre} title={lkSperre || undefined}>Modell aktualisieren</Button>
        )}
        {!an && (
          <Button size="sm" onClick={() => onAktion('an')} disabled={gesperrt || !!lkSperre} title={lkSperre || undefined}>
            {d.installiert ? 'Einschalten' : 'Einrichten und einschalten'}
          </Button>
        )}
        {an && <Button size="sm" variant="outline" onClick={() => onAktion('aus')} disabled={gesperrt}>Ausschalten</Button>}
        {d.installiert && (
          <Button size="sm" variant="ghost" className="text-red-600 hover:text-red-700" onClick={() => onAktion('entfernen')} disabled={gesperrt}>
            Entfernen
          </Button>
        )}
      </>
    );
  }

  return (
    <div className="rounded-lg border border-border/60 bg-muted/30 p-3 space-y-2">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium">{d.label}</p>
            <span className={`rounded-md px-2 py-0.5 text-[11px] font-medium ${anzeige.klasse}`}>{anzeige.text}</span>
          </div>
          {meta.length > 0 && <p className="text-xs text-muted-foreground">{meta.join(' · ')}</p>}
        </div>
        {knoepfe && <div className="flex flex-wrap gap-2">{knoepfe}</div>}
      </div>
      {d.id === 'lokalki' && <LokaleKiDetails lk={lk} gpu={gpu} eignung={eignung} sperre={lkSperre} />}
    </div>
  );
}

function LokaleKiDetails({ lk, gpu, eignung, sperre }) {
  const bedarf = lk?.bedarf;
  const stufe = bedarf?.stufe || lk?.stufe;
  const teile = [
    ramText(eignung?.ramMiB) && `Arbeitsspeicher ${ramText(eignung.ramMiB)}`,
    gpu ? `${gpu.name || 'Grafikkarte'} (${ramText(gpu.vramMiB) || '?'})` : 'Keine Grafikkarte erkannt',
    stufe && `Betrieb: ${STUFEN[stufe] || stufe}`,
    Number.isFinite(bedarf?.kontext) && `Kontext ${bedarf.kontext.toLocaleString('de-DE')} Tokens`,
    !lk?.vollstaendig && gb(bedarf?.bytes) && `Download ${gb(bedarf.bytes)}`,
  ].filter(Boolean);
  return (
    <div className="space-y-2">
      <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
        <Cpu className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>{teile.join(' · ')}</span>
      </p>
      {gpu && gpu.dockerBereit === false && (
        <Testergebnis status="info">
          Richte die Grafikkarte im Installer unter „NVIDIA-Grafikkarte einrichten“ ein. Bis dahin verwendet
          die lokale KI den Prozessor.
        </Testergebnis>
      )}
      {sperre && <Testergebnis status="fehler">{sperre}</Testergebnis>}
      {!sperre && eignung?.langsam && (
        <p role="alert" className="rounded-lg border border-red-300 bg-red-50 p-2.5 text-xs font-medium text-red-700 dark:border-red-800 dark:bg-red-950/30 dark:text-red-300">
          Ohne mindestens 8 GB nutzbaren Grafikspeicher läuft die lokale KI extrem langsam: Ein Dokument kann
          viele Minuten dauern. Schneller und meist günstiger ist eine Cloud-KI per API-Schlüssel unter „KI“.
        </p>
      )}
      {!eignung?.langsam && (stufe === 'cpu' || stufe === 'gpu-teil') && (
        <Testergebnis status="info">
          {stufe === 'cpu'
            ? 'Ohne passende Grafikkarte arbeitet die KI auf dem Prozessor. Ein Dokument kann dann mehrere Minuten dauern.'
            : 'Die Grafikkarte fasst das Modell nicht ganz; ein Teil läuft auf dem Prozessor und ist entsprechend langsamer.'}
        </Testergebnis>
      )}
      {lk?.modellVeraltet && (
        <Testergebnis status="info">
          Mit dem letzten Update gibt es ein neues Modell. Der Host-Agent stellt selbst darauf um; das bisherige
          bleibt aktiv, bis das neue bereit ist, und wird danach gelöscht. Ist die Umstellung gescheitert,
          startet „Modell aktualisieren“ einen neuen Versuch.
        </Testergebnis>
      )}
    </div>
  );
}

function AgentZeile({ agent }) {
  let text;
  if (!agent?.vorhanden) {
    text = 'Kein Host-Agent erkannt. Die Dienste lassen sich hier nur ansehen, nicht schalten; ohne Agent '
      + 'gelten die Werte in COMPOSE_PROFILES der .env.';
  } else if (!agent.stackFaehig) {
    text = 'Der Host-Agent ist älter als diese Version und meldet den Stack noch nicht. Mit dem nächsten Update '
      + 'kommt die neue Fassung.';
  } else {
    const am = agent.letzterLaufAm ? new Date(agent.letzterLaufAm) : null;
    text = `Host-Agent aktiv${am ? `, zuletzt gemeldet um ${am.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} Uhr` : ''}. `
      + 'Unter Windows startet ihn eine geplante Aufgabe, unter Linux ein systemd-Timer.';
  }
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Steuerung</p>
      <p className="text-xs text-muted-foreground">{text}</p>
    </div>
  );
}

function AktionsDialog({ frage, platteFreiBytes, klassenAufLokalerKi, onAbbrechen, onBestaetigen }) {
  if (!frage) return <Dialog open={false} />;
  const { dienst: d, aktion, klassen } = frage;
  const istLk = d.id === 'lokalki';
  const lk = d.lokalki;

  let titel;
  let text;
  let knopf;
  let gefaehrlich = false;
  if (klassen) {
    titel = 'Lokale KI ist noch gewählt';
    text = `Diese Aufgaben nutzen noch die lokale KI: ${klassen.join(', ')}. Danach schlagen sie fehl, bis unter „KI“ ein anderer Anbieter gewählt ist.`;
    knopf = aktion === 'entfernen' ? 'Trotzdem entfernen' : 'Trotzdem ausschalten';
    gefaehrlich = true;
  } else if (aktion === 'an') {
    titel = d.installiert ? `${d.label} einschalten?` : `${d.label} einrichten und einschalten?`;
    if (istLk) {
      const fehlt = lk?.vollstaendig ? 0 : Math.max(0, (lk?.bedarf?.bytes || 0) - (lk?.vorhandenBytes || 0));
      const knapp = fehlt > 0 && Number.isFinite(platteFreiBytes) && platteFreiBytes < fehlt + 5 * 1024 ** 3;
      text = (fehlt > 0
        ? `Der Host-Agent lädt das Modell (${gb(fehlt) || 'mehrere GB'}) und startet den Dienst. Je nach Leitung kann das über eine Stunde dauern; ein abgebrochener Download wird beim nächsten Einschalten fortgesetzt.`
        : 'Der Host-Agent startet den Dienst; das Modell ist bereits vorhanden.')
        + (ramText(d.ramMiB) ? ` Im Betrieb braucht er bis zu ${ramText(d.ramMiB)} Arbeitsspeicher.` : '')
        + (knapp ? ` Achtung: Frei sind nur ${gb(platteFreiBytes)}.` : '')
        + ' Gewählt wird die lokale KI unter „KI“.';
    } else {
      text = `Der Host-Agent ${d.installiert ? 'startet' : 'richtet'} den Dienst ${d.installiert ? '' : 'ein und startet ihn'}`.trim()
        + '.' + (ramText(d.ramMiB) ? ` Im Betrieb braucht er bis zu ${ramText(d.ramMiB)} Arbeitsspeicher.` : '');
    }
    knopf = d.installiert ? 'Einschalten' : 'Einrichten';
  } else if (aktion === 'aus') {
    titel = `${d.label} ausschalten?`;
    text = 'Der Dienst wird angehalten und gibt seinen Arbeitsspeicher frei. Image'
      + (istLk ? ' und Modell bleiben' : ' bleibt')
      + ' erhalten; eingeschaltet ist er jederzeit wieder, ohne erneuten Download.';
    if (istLk && klassenAufLokalerKi?.length) text += ` Noch gewählt für: ${klassenAufLokalerKi.join(', ')}.`;
    knopf = 'Ausschalten';
  } else {
    titel = `${d.label} entfernen?`;
    text = 'Der Dienst wird angehalten und sein Image gelöscht'
      + (istLk ? `; die Modelldateien${gb(lk?.vorhandenBytes) ? ` (${gb(lk.vorhandenBytes)})` : ''} ebenso` : '')
      + '. Erneutes Einschalten lädt alles neu herunter.';
    if (istLk && klassenAufLokalerKi?.length) text += ` Noch gewählt für: ${klassenAufLokalerKi.join(', ')}.`;
    knopf = 'Entfernen';
    gefaehrlich = true;
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onAbbrechen(); }}>
      <DialogTitle>{titel}</DialogTitle>
      <DialogDescription className="mt-3">{text}</DialogDescription>
      <DialogFooter>
        <Button variant="outline" onClick={onAbbrechen}>Abbrechen</Button>
        <Button variant={gefaehrlich ? 'destructive' : 'default'} onClick={() => onBestaetigen(!!klassen || (istLk && aktion !== 'an' && klassenAufLokalerKi?.length > 0))}>{knopf}</Button>
      </DialogFooter>
    </Dialog>
  );
}
