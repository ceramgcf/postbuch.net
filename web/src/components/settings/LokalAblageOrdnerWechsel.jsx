/**
 * LokalAblageOrdnerWechsel – anderen Ordner für die lokale Ablage wählen.
 *
 * Den Ordner bindet Docker beim Start der Anwendung ein; ändern kann ihn
 * deshalb nur der Host-Agent (Auftrag `ablage`). Er hält die Anwendung an,
 * kopiert die Ablage in den neuen Ordner und startet sie mit ihm neu. Der
 * bisherige Ordner bleibt unverändert liegen. Ohne Agent mit dieser Fähigkeit
 * (oder ohne Admin-Sitzung) erscheint der Abschnitt nicht.
 */

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderInput } from 'lucide-react';
import { api } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';
import { Testergebnis } from '@/components/ui/testergebnis';

/** Liegt der Pfad in einem OneDrive-Ordner („OneDrive“ bzw. „OneDrive - <Organisation>“)? */
const ONEDRIVE = /[\\/]OneDrive( - [^\\/]+)?([\\/]|$)/i;

function gb(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return null;
  return `${(bytes / 1024 ** 3).toLocaleString('de-DE', { maximumFractionDigits: 1 })} GB`;
}

export default function LokalAblageOrdnerWechsel({ aktuell, festgelegt = true }) {
  const qc = useQueryClient();
  const [offen, setOffen] = useState(false);
  const [pfad, setPfad] = useState('');
  const [fragen, setFragen] = useState(false);
  // Erstmals festlegen oder umziehen – gemerkt beim Öffnen, der Status wechselt danach.
  const [umzug, setUmzug] = useState(festgelegt);
  const [auftrag, setAuftrag] = useState(null); // nonce

  const updates = useQuery({
    queryKey: ['updates'],
    queryFn: () => api.updates.get(),
    // Während des Neustarts ist die Anwendung kurz nicht erreichbar; ohne
    // Admin-Recht (403) gibt es nichts nachzufragen.
    retry: (n, err) => ![401, 403].includes(err?.status) && n < 20,
    refetchInterval: (q) => (auftrag || q.state.data?.anforderung || q.state.data?.lauf?.status === 'laeuft' ? 3000 : false),
  });

  const senden = useMutation({
    mutationFn: () => api.updates.hostconfig('ablage', 'setzen', undefined, { pfad: pfad.trim() }),
    onSuccess: (res) => {
      setAuftrag(res.nonce);
      setFragen(false);
      qc.invalidateQueries({ queryKey: ['updates'] });
    },
    onError: () => setFragen(false),
  });

  const daten = updates.data;
  const lauf = auftrag && daten?.lauf?.nonce === auftrag ? daten.lauf : null;
  const fertig = lauf && lauf.status !== 'laeuft';
  // Auch ein Umzug, der vor dem Öffnen der Seite begann, zeigt seinen Fortschritt.
  const laufendWoanders = !auftrag && daten?.lauf?.typ === 'ablage' && daten.lauf.status === 'laeuft' ? daten.lauf : null;
  useEffect(() => {
    if (lauf?.status === 'erfolgreich') qc.invalidateQueries({ queryKey: ['lokal-ablage-status'] });
  }, [lauf?.status, qc]);

  if (!daten?.agent?.capabilities?.includes('ablage') && !auftrag) return null;

  const beschaeftigt = !!daten?.anforderung || daten?.lauf?.status === 'laeuft';
  let meldung = null;
  if (senden.error) {
    meldung = <Testergebnis status="fehler">{senden.error.message}</Testergebnis>;
  } else if ((auftrag && !fertig) || laufendWoanders) {
    const anzeige = lauf || laufendWoanders;
    const gesamt = anzeige?.gesamtBytes;
    meldung = (
      <div className="space-y-2 rounded-lg border border-border/60 bg-muted/30 p-3">
        <p className="text-sm">
          {updates.isError
            ? 'Die Anwendung startet neu …'
            : anzeige?.meldung || 'Der Auftrag liegt beim Host-Agenten. Er holt ihn innerhalb einer Minute ab.'}
        </p>
        <Progress value={0} indeterminate />
        {gb(gesamt) && <p className="text-xs text-muted-foreground">Umfang der Ablage: {gb(gesamt)}</p>}
        <p className="text-xs text-muted-foreground">
          Während des Umzugs ist postbuch.net kurz nicht erreichbar. Diese Seite darf geschlossen werden.
        </p>
      </div>
    );
  } else if (lauf?.status === 'erfolgreich') {
    meldung = (
      <Testergebnis status="erfolg">
        {umzug
          ? 'Die Ablage liegt jetzt im neuen Ordner. Der bisherige Ordner ist unverändert erhalten; löschen kannst du ihn, sobald du dich überzeugt hast, dass alles da ist.'
          : 'Der Ablageordner ist festgelegt.'}
      </Testergebnis>
    );
  } else if (lauf) {
    meldung = <Testergebnis status="fehler">{lauf.meldung || 'Der Ordner wurde nicht geändert.'}</Testergebnis>;
  }

  return (
    <div className="border-t border-border/60 pt-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">{festgelegt ? 'Ordner ändern' : 'Ordner festlegen'}</p>
          <p className="text-xs text-muted-foreground">
            {festgelegt
              ? 'Die Ablage in einen anderen Ordner auf diesem Rechner umziehen, etwa auf ein größeres Laufwerk.'
              : 'Lege fest, in welchem Ordner auf diesem Rechner die Originale liegen.'}
          </p>
        </div>
        {!offen && (
          <Button size="sm" variant="outline" className="shrink-0" onClick={() => { setOffen(true); setUmzug(festgelegt); setAuftrag(null); senden.reset(); }} disabled={beschaeftigt}>
            <FolderInput className="h-3.5 w-3.5 mr-1.5" />{festgelegt ? 'Ordner ändern' : 'Ordner festlegen'}
          </Button>
        )}
      </div>
      {offen && !auftrag && (
        <form
          className="space-y-2"
          onSubmit={(e) => { e.preventDefault(); if (pfad.trim()) setFragen(true); }}
        >
          <Input
            value={pfad}
            onChange={(e) => setPfad(e.target.value)}
            placeholder="z. B. D:\postbuch-ablage oder /home/name/postbuch-ablage"
            className="font-mono"
            autoFocus
            aria-label="Neuer Ablageordner"
          />
          <p className="text-xs text-muted-foreground">
            Der Ordner wird angelegt, falls es ihn noch nicht gibt; ein vorhandener Ordner muss leer sein.
            Erlaubt sind Ordner im eigenen Benutzerverzeichnis und auf weiteren Laufwerken, nicht aber im
            Installationsverzeichnis von postbuch.net: Eine Deinstallation löscht es, der Ablageordner bleibt.
          </p>
          {ONEDRIVE.test(pfad.trim()) && (
            <Testergebnis status="info">
              Dieser Ordner liegt in OneDrive. Windows synchronisiert die Ablage dann in die Microsoft-Cloud.
            </Testergebnis>
          )}
          <div className="flex gap-2">
            <Button size="sm" type="submit" disabled={!pfad.trim() || beschaeftigt || senden.isPending}>Weiter</Button>
            <Button size="sm" type="button" variant="ghost" onClick={() => { setOffen(false); senden.reset(); }}>Abbrechen</Button>
          </div>
        </form>
      )}
      {meldung}
      <Dialog open={fragen} onOpenChange={(o) => { if (!o) setFragen(false); }}>
        <DialogTitle>{festgelegt ? 'Ablage umziehen?' : 'Ablageordner festlegen?'}</DialogTitle>
        {festgelegt ? (
          <DialogDescription className="mt-3">
            postbuch.net hält kurz an, kopiert alle Dateien aus <span className="font-mono break-all">{aktuell}</span> nach{' '}
            <span className="font-mono break-all">{pfad.trim()}</span> und startet mit dem neuen Ordner neu. Je nach Größe
            der Ablage dauert das einige Minuten. Der bisherige Ordner bleibt unverändert erhalten.
          </DialogDescription>
        ) : (
          <DialogDescription className="mt-3">
            postbuch.net legt <span className="font-mono break-all">{pfad.trim()}</span> an, falls nötig, und startet
            mit diesem Ordner kurz neu.
          </DialogDescription>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => setFragen(false)}>Abbrechen</Button>
          <Button onClick={() => senden.mutate()} disabled={senden.isPending}>{festgelegt ? 'Umziehen' : 'Festlegen'}</Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
