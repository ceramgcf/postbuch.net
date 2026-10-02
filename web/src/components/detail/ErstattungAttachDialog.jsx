import { useState } from 'react';
import { Dialog, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { formatCurrency } from '@/lib/utils';
import { usePostbuchDetail, useSetErstattungZuordnung } from '@/hooks/usePostbuch';
import { useUndoHistory } from '@/hooks/useUndoHistory';
import { DocumentPicker } from './DocumentPicker';

const EB_ARTEN = ['erstattungsbescheid'];

// Verknüpft von der Arztrechnungs-Seite aus eine Erstattungsbescheid-Position (EBP)
// mit DIESER Rechnung. Zweistufig: 1) Bescheid wählen, 2) Position wählen.
// Setzt anschließend EBP.arz_postid = invoicePostid (überschreibt eine ggf. andere Zuordnung).
export function ErstattungAttachDialog({ open, onOpenChange, invoicePostid }) {
  const [ebPostid, setEbPostid] = useState(null);
  const [error, setError] = useState(null);
  const { mutate, mutateAsync, isPending } = useSetErstattungZuordnung();
  const { pushAction } = useUndoHistory();
  const { data: ebData, isLoading } = usePostbuchDetail(ebPostid);
  const positionen = ebData?.erstattungsbescheid?.einzelpositionen ?? [];

  function reset() {
    setEbPostid(null);
    setError(null);
  }
  function close() {
    reset();
    onOpenChange(false);
  }

  function assign(subid) {
    setError(null);
    const ep = positionen.find((p) => p.subid === subid);
    const oldArzPostid = ep?.arz_postid ?? null;
    mutate(
      { postid: ebPostid, subid, arzPostid: invoicePostid },
      {
        onSuccess: (res) => {
          close();
          pushAction(
            'Erstattung zugeordnet',
            () => mutateAsync({ postid: ebPostid, subid, arzPostid: oldArzPostid, restoreKuerzungenArzSubid: res.prev_kuerzungen_arz_subid }),
            () => mutateAsync({ postid: ebPostid, subid, arzPostid: invoicePostid }),
          );
        },
        onError: (e) => setError(e.message || 'Zuordnung fehlgeschlagen'),
      }
    );
  }

  // Schritt 1: Bescheid wählen (eigener Picker-Dialog)
  if (open && !ebPostid) {
    return (
      <DocumentPicker
        open={open}
        onOpenChange={(v) => { if (!v) close(); }}
        arten={EB_ARTEN}
        title="Erstattung zuordnen – Bescheid wählen"
        description="Erstattungsbescheid suchen oder SymLink (Postnummer) einfügen."
        onSelect={(id) => setEbPostid(id)}
      />
    );
  }

  // Schritt 2: Position im gewählten Bescheid wählen
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) close(); }} size="lg">
      <DialogTitle>Position im Bescheid {ebPostid} wählen</DialogTitle>
      <DialogDescription>
        Die gewählte Position wird dieser Rechnung ({invoicePostid}) zugeordnet.
      </DialogDescription>

      <div className="mt-4 max-h-72 overflow-y-auto rounded-lg border border-border divide-y divide-border">
        {isLoading && <div className="px-3 py-3 text-sm text-muted-foreground">Lade Positionen…</div>}
        {!isLoading && positionen.length === 0 && (
          <div className="px-3 py-3 text-sm text-muted-foreground">Keine Positionen gefunden.</div>
        )}
        {positionen.map((ep) => {
          const bereitsHier = ep.arz_postid === invoicePostid;
          const andereRechnung = ep.arz_postid && ep.arz_postid !== invoicePostid;
          return (
            <button
              key={ep.subid}
              type="button"
              onClick={() => assign(ep.subid)}
              disabled={isPending || bereitsHier}
              className="flex w-full items-start gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-accent disabled:opacity-50"
            >
              <span className="font-mono text-xs mt-0.5">Pos. {ep.subid}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate">
                  {ep.behandelte_person || '–'} · Rechnung {formatCurrency(ep.rechnungsbetrag)} · erstattet {formatCurrency(ep.erstattungsbetrag)}
                </span>
                {bereitsHier && <span className="text-xs text-green-600">bereits dieser Rechnung zugeordnet</span>}
                {andereRechnung && <span className="text-xs text-amber-600">aktuell {ep.arz_postid} zugeordnet – wird umgehängt</span>}
              </span>
            </button>
          );
        })}
      </div>

      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}

      <DialogFooter>
        <Button variant="ghost" size="sm" onClick={reset} disabled={isPending}>Zurück</Button>
        <Button variant="ghost" size="sm" onClick={close} disabled={isPending}>Abbrechen</Button>
      </DialogFooter>
    </Dialog>
  );
}
