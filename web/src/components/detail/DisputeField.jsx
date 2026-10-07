import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog';
import { formatCurrency } from '@/lib/utils';
import { api } from '@/api/client';
import { useAuth } from '@/hooks/useAuth';
import { useUndoHistory } from '@/hooks/useUndoHistory';

/** Reine Statusanzeige für das Datenraster der Rechnung. */
export function DisputeStatus({ gesamtbetrag, bestritten_betrag, offen }) {
  const total = Number(gesamtbetrag || 0);
  const disputedAmount = Number(bestritten_betrag || 0);
  const disputed = bestritten_betrag != null && disputedAmount > 0;
  // „Noch fällig“ berücksichtigt erfasste Zahlungen, sofern bekannt.
  const remaining = offen != null ? Number(offen) : Math.max(0, total - disputedAmount);
  return (
    <div>
      <dt className="text-muted-foreground mb-1">Streitfall</dt>
      <dd className="font-medium">
        {disputed ? <span className="text-amber-700">{disputedAmount >= total ? 'Vollständig bestritten' : `${formatCurrency(disputedAmount)} bestritten`}</span> : <span className="text-muted-foreground">Nicht bestritten</span>}
      </dd>
      {disputed && <p className="text-xs text-muted-foreground mt-0.5">Noch fällig: {formatCurrency(remaining)}</p>}
    </div>
  );
}

/**
 * Dialog „Rechnung bestreiten“ für alle Rechnungstypen. Mit `open`/
 * `onOpenChange` gesteuert (Menü „Rechnung“), sonst mit eigenem Knopf.
 */
export function DisputeAction({ postid, gesamtbetrag, bestritten_betrag, open: openProp, onOpenChange }) {
  const gesteuert = openProp !== undefined;
  const [openIntern, setOpenIntern] = useState(false);
  const open = gesteuert ? openProp : openIntern;
  const setOpen = gesteuert ? onOpenChange : setOpenIntern;
  const [draft, setDraft] = useState('');
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const { canWrite } = useAuth();
  const qc = useQueryClient();
  const { pushAction } = useUndoHistory();
  const disputed = bestritten_betrag != null && Number(bestritten_betrag) > 0;
  const total = Number(gesamtbetrag || 0);
  const disputedAmount = Number(bestritten_betrag || 0);

  function vorbelegen() {
    setDraft(disputed ? String(bestritten_betrag) : String(gesamtbetrag || ''));
    setError(null);
  }
  function start() {
    vorbelegen();
    setOpen(true);
  }
  useEffect(() => {
    if (gesteuert && openProp) vorbelegen();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gesteuert, openProp]);

  async function applyBestritten(amount) {
    await api.postbuch.setBestritten(postid, amount);
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['postbuch'] }),
      qc.invalidateQueries({ queryKey: ['analyse'] }),
      qc.invalidateQueries({ queryKey: ['stats'] }),
    ]);
  }

  async function save(amount) {
    setSaving(true);
    setError(null);
    const oldAmount = bestritten_betrag ?? null;
    try {
      await applyBestritten(amount);
      pushAction(
        amount == null ? 'Streitfall aufgehoben' : 'Rechnung bestritten',
        () => applyBestritten(oldAmount),
        () => applyBestritten(amount),
      );
      setOpen(false);
    } catch (err) {
      setError(err?.message || 'Der Streitstatus konnte nicht gespeichert werden.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      {canWrite && !gesteuert && <Button variant="outline" size="sm" className="h-8 gap-1.5 border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100 hover:text-amber-900 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-200 dark:hover:bg-amber-950/50" onClick={start}><AlertTriangle className="h-3.5 w-3.5" />{disputed ? 'Streitfall bearbeiten' : 'Rechnung bestreiten'}</Button>}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTitle className="flex items-center gap-2"><AlertTriangle className="h-4 w-4 text-amber-600" />Rechnung bestreiten</DialogTitle>
        <DialogDescription className="space-y-2">
          <p>Der bestrittene Anteil wird vorerst nicht als fällig behandelt. Bei einem Teilbestritt bleibt nur der unbestrittene Restbetrag fällig; bei vollem Bestritt nichts.</p>
          <p>Zahlungen des unbestrittenen Teils erfassen Sie unter „Bezahlt am“ bzw. als Teilzahlung. Was bestritten wird und wie die Klärung ausgeht, halten Sie am besten in der Dokumentnotiz fest.</p>
        </DialogDescription>
        <div className="space-y-1.5 py-2">
          <label className="text-sm font-medium" htmlFor={`bestritten-${postid}`}>Bestrittener Betrag (max. {formatCurrency(total)})</label>
          <Input id={`bestritten-${postid}`} inputMode="decimal" value={draft} onChange={(e) => setDraft(e.target.value)} />
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          {disputed && <Button variant="ghost" className="mr-auto text-destructive" disabled={saving} onClick={() => save(null)}><X className="h-4 w-4" />Streitfall aufheben</Button>}
          <Button variant="outline" disabled={saving} onClick={() => setOpen(false)}>Abbrechen</Button>
          <Button disabled={saving} onClick={() => save(draft)}>{saving ? 'Speichern…' : 'Speichern'}</Button>
        </DialogFooter>
      </Dialog>
    </>
  );
}
