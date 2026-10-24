/**
 * Eingebauter Embedding-Dienst – einrichten, verwenden, abschalten (admin-only)
 *
 * Der Dienst ist ein eigenes Compose-Profil (`embedding`). Neue Installationen
 * schalten es ein; eine bestehende Instanz bekommt ihn erst, wenn sie ihn hier
 * wählt. Die App baut und startet nichts selbst: Sie schreibt den Hostauftrag
 * `module` = `embedding:an|aus`, der Host-Agent baut das Image, startet den
 * Dienst und meldet den Profilzustand im Heartbeat zurück.
 *
 * „Einrichten und verwenden“ wählt den Dienst erst nach erfolgreichem Lauf.
 * Der Server prüft beim Speichern mit einem Probeaufruf, ob er antwortet; eine
 * Wahl auf einen Dienst, der nicht läuft, gibt es dadurch nicht.
 *
 * Ohne Host-Agent mit Embedding-Fähigkeit (manuelle Compose-Installation,
 * älterer Agent) steht hier, wie das Profil von Hand eingeschaltet wird.
 */

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Dialog, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Testergebnis } from '@/components/ui/testergebnis';
import { EINGEBAUT_ID, EINGEBAUT_MODELL } from '@/lib/embedding-eingebaut';

const AUFTRAG_LIEGT = 'Der Host-Agent baut und startet den Dienst. Beim ersten Mal lädt er dabei das Modell; '
  + 'das dauert je nach Gerät und Leitung einige Minuten.';

/**
 * @param {object} props
 * @param {boolean} props.gewaehlt   Der eingebaute Dienst ist das gespeicherte Embedding-Modell.
 * @param {number}  props.bestand    Anzahl vorhandener Dokument-Embeddings (für die Rückfrage).
 * @param {Function} props.onGewaehlt Nach erfolgreicher Wahl (Abfragen auffrischen).
 * @param {boolean} props.assistent  Im Einrichtungsassistenten: nur einrichten und verwenden.
 */
export default function EingebauterEmbeddingDienst({ gewaehlt, bestand = 0, onGewaehlt, assistent = false }) {
  const [auftrag, setAuftrag] = useState(null); // { nonce, ziel: 'an'|'aus', verwenden }
  const [frage, setFrage] = useState(null); // 'verwenden' | 'einrichten' | 'abschalten'
  const wartetAufAgent = (d) => !!auftrag && (
    !!d?.anforderung || d?.lauf?.nonce !== auftrag.nonce || d.lauf.status === 'laeuft'
      || (d.lauf.status === 'erfolgreich' && d.agent?.embeddingProfilAktiv !== (auftrag.ziel === 'an'))
  );
  const updates = useQuery({
    queryKey: ['updates'],
    queryFn: () => api.updates.get(),
    retry: false,
    refetchInterval: (query) => (wartetAufAgent(query.state.data) ? 3000 : false),
  });
  const agent = updates.data?.agent;
  const steuerbar = !!agent?.vorhanden && !!agent.capabilities?.includes('embedding');
  const profilAktiv = steuerbar ? agent.embeddingProfilAktiv === true : null;
  const lauf = auftrag && updates.data?.lauf?.nonce === auftrag.nonce ? updates.data.lauf : null;

  const schalten = useMutation({
    mutationFn: ({ ziel }) => api.updates.hostconfig('module', `embedding:${ziel}`),
    onSuccess: (res, { ziel, verwenden }) => {
      setAuftrag({ nonce: res.nonce, ziel, verwenden: !!verwenden });
      updates.refetch();
    },
  });
  const verwenden = useMutation({
    mutationFn: () => api.settings.ai.embedding.set(EINGEBAUT_ID, EINGEBAUT_MODELL),
    onSuccess: () => onGewaehlt?.(),
  });

  const laeuft = schalten.isPending || wartetAufAgent(updates.data);
  const fertig = !!lauf && !laeuft && lauf.status === 'erfolgreich';

  // Nach erfolgreichem Einrichten genau einmal wählen.
  const gewaehltNachAuftrag = useRef(null);
  useEffect(() => {
    if (fertig && auftrag?.verwenden && gewaehltNachAuftrag.current !== auftrag.nonce) {
      gewaehltNachAuftrag.current = auftrag.nonce;
      verwenden.mutate();
    }
  }, [fertig, auftrag, verwenden]);

  const beschaeftigt = laeuft || verwenden.isPending;
  const meldung = schalten.error ? <Testergebnis status="fehler">{schalten.error.message}</Testergebnis>
    : laeuft ? <Testergebnis status="info">{auftrag?.ziel === 'aus' ? 'Der Host-Agent hält den Dienst an.' : AUFTRAG_LIEGT}</Testergebnis>
      : lauf && lauf.status !== 'erfolgreich'
        ? <Testergebnis status="fehler">{lauf.meldung || 'Der Host-Agent konnte den Dienst nicht einrichten.'}</Testergebnis>
        : verwenden.isPending ? <Testergebnis status="info">Der Dienst wird geprüft und gewählt…</Testergebnis>
          : verwenden.error ? <Testergebnis status="fehler">{verwenden.error.message}</Testergebnis>
            : null;

  let zustand;
  let knoepfe = null;
  if (gewaehlt && profilAktiv === false) {
    // Etwa nach dem Wiederherstellen einer Sicherung auf einer Instanz, auf
    // der das Profil nie eingeschaltet war: Suche und Duplikatprüfung stehen.
    zustand = (
      <Testergebnis status="fehler">
        Der eingebaute Dienst ist gewählt, läuft auf diesem Gerät aber nicht. Ähnlichkeitssuche,
        Duplikatprüfung und Hilfe arbeiten so lange ohne Vektoren.
      </Testergebnis>
    );
    knoepfe = (
      <Button size="sm" onClick={() => schalten.mutate({ ziel: 'an' })} disabled={beschaeftigt}>
        {laeuft ? 'Wird eingerichtet…' : 'Dienst einrichten'}
      </Button>
    );
  } else if (gewaehlt) {
    zustand = <p className="text-xs text-muted-foreground">Gewählt. Der Dienst läuft im eigenen Stack, ohne Cloud.</p>;
  } else if (profilAktiv) {
    zustand = <p className="text-xs text-muted-foreground">Eingerichtet und betriebsbereit, aber nicht gewählt.</p>;
    knoepfe = (
      <>
        <Button size="sm" onClick={() => (bestand > 0 ? setFrage('verwenden') : verwenden.mutate())} disabled={beschaeftigt}>
          Verwenden
        </Button>
        {!assistent && (
          <Button size="sm" variant="outline" onClick={() => setFrage('abschalten')} disabled={beschaeftigt}>
            Abschalten
          </Button>
        )}
      </>
    );
  } else if (steuerbar) {
    zustand = <p className="text-xs text-muted-foreground">Auf diesem Gerät noch nicht eingerichtet.</p>;
    knoepfe = (
      <Button size="sm" onClick={() => setFrage('einrichten')} disabled={beschaeftigt}>
        {beschaeftigt ? 'Wird eingerichtet…' : 'Einrichten und verwenden'}
      </Button>
    );
  } else {
    zustand = (
      <p className="text-xs text-muted-foreground">
        Ein- und ausgeschaltet wird der Dienst hier über den Host-Agenten. Ohne ihn
        gehört <code className="font-mono">embedding</code> in <code className="font-mono">COMPOSE_PROFILES</code> der{' '}
        <code className="font-mono">.env</code> (kommagetrennt, etwa <code className="font-mono">scanner,embedding</code>),
        danach <code className="font-mono">docker compose up -d --build embedding</code>. Läuft der Dienst,
        lässt er sich hier wählen.
      </p>
    );
    knoepfe = !gewaehlt && (
      <Button size="sm" variant="outline" onClick={() => (bestand > 0 ? setFrage('verwenden') : verwenden.mutate())} disabled={beschaeftigt}>
        Verwenden
      </Button>
    );
  }

  const neuBerechnen = bestand > 0
    ? ` Die ${bestand} vorhandenen Embeddings werden danach automatisch im Hintergrund neu berechnet; bis dahin findet die Suche weniger. Die Hilfe kommt mit fertigen Vektoren und muss nicht berechnet werden.`
    : '';

  return (
    <div className="rounded-lg border border-border/60 bg-muted/30 p-3 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-medium">Eingebauter Dienst: Snowflake Arctic Embed M v2.0</p>
          {zustand}
        </div>
        {knoepfe && <div className="flex flex-wrap gap-2">{knoepfe}</div>}
      </div>
      {meldung}

      <Dialog open={!!frage} onOpenChange={(o) => { if (!o) setFrage(null); }}>
        {frage === 'abschalten' ? (
          <>
            <DialogTitle>Eingebauten Dienst abschalten?</DialogTitle>
            <DialogDescription className="mt-3">
              Der Dienst wird angehalten und gibt seinen Arbeitsspeicher frei. Das Image bleibt erhalten;
              eingeschaltet ist er hier jederzeit wieder, ohne erneuten Download.
            </DialogDescription>
          </>
        ) : (
          <>
            <DialogTitle>{frage === 'einrichten' ? 'Eingebauten Dienst einrichten und verwenden?' : 'Eingebauten Dienst verwenden?'}</DialogTitle>
            <DialogDescription className="mt-3">
              {frage === 'einrichten'
                ? 'Der Host-Agent baut den Dienst und lädt dabei einmalig das Modell (rund 300 MB). Im Betrieb braucht er bis zu 640 MB Arbeitsspeicher. Ist er bereit, wird er automatisch gewählt.'
                : 'Der eingebaute Dienst wird zum Embedding-Modell dieser Instanz.'}
              {neuBerechnen}
            </DialogDescription>
          </>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => setFrage(null)}>Abbrechen</Button>
          <Button onClick={() => {
            const f = frage;
            setFrage(null);
            if (f === 'abschalten') schalten.mutate({ ziel: 'aus' });
            else if (f === 'einrichten') schalten.mutate({ ziel: 'an', verwenden: true });
            else verwenden.mutate();
          }}>
            {frage === 'abschalten' ? 'Abschalten' : frage === 'einrichten' ? 'Einrichten' : bestand > 0 ? 'Verwenden und neu berechnen' : 'Verwenden'}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
