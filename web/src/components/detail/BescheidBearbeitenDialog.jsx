import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Dialog, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useBescheidBearbeiten } from '@/hooks/usePostbuch';

const KOPFFELDER = [
  ['kostentraeger', 'Kostenträger', 'kostentraeger'],
  ['bescheiddatum', 'Bescheiddatum', 'date'],
  ['erstattungsbetrag', 'Erstattungsbetrag (€)', 'betrag'],
  ['hinweise', 'Hinweise', 'textarea'],
];
const POSITIONSFELDER = [
  ['behandelte_person', 'Behandelte Person', 'person'],
  ['kostenart', 'Kostenart'],
  ['bezugsdatum', 'Bezugsdatum', 'date'],
  ['beleg_nr', 'Belegnummer'],
  ['rechnungsbetrag', 'Rechnungsbetrag (€)', 'betrag'],
  ['erstattungsbetrag', 'Erstattungsbetrag (€)', 'betrag'],
];

export function BescheidBearbeitenDialog({ postid, istTier, position, datensatz, loeschen, schliessen }) {
  const felder = position ? POSITIONSFELDER : KOPFFELDER;
  const neu = !datensatz;
  const [anfang] = useState(() => Object.fromEntries(
    felder.map(([feld, , typ]) => [feld, String(datensatz?.[feld] ?? (typ === 'kostentraeger' && istTier && neu ? 'PKV' : ''))]),
  ));
  const [werte, setWerte] = useState(anfang);
  const { mutate, isPending, error } = useBescheidBearbeiten();
  const { data: personen } = useQuery({
    queryKey: ['personen'],
    queryFn: () => api.personen.list(),
    enabled: position && !loeschen,
    staleTime: 5 * 60 * 1000,
  });
  const nameVorhanden = anfang.behandelte_person;
  const optionen = (personen?.data ?? [])
    .filter((p) => p.ist_tier === istTier && (!p.archiviert || p.kurzname === nameVorhanden))
    .map((p) => p.kurzname);
  if (nameVorhanden && !optionen.includes(nameVorhanden)) optionen.unshift(nameVorhanden);

  function speichern(event) {
    event.preventDefault();
    const daten = {};
    if (!neu) daten.stand = datensatz.stand;
    if (!loeschen) {
      for (const [feld] of felder) {
        if (neu || werte[feld] !== anfang[feld]) daten[feld] = werte[feld].trim() || null;
      }
    }
    mutate({ postid, position, subid: datensatz?.subid, daten, neu, loeschen }, { onSuccess: schliessen });
  }

  const titel = loeschen ? 'Position löschen?' : position
    ? (neu ? 'Position hinzufügen' : 'Position bearbeiten')
    : (neu ? 'Bescheiddaten erfassen' : 'Bescheiddaten bearbeiten');
  const geaendert = neu || loeschen || felder.some(([feld]) => werte[feld] !== anfang[feld]);
  return (
    <Dialog open onOpenChange={() => { if (!isPending) schliessen(); }}>
      <form onSubmit={speichern}>
        <DialogTitle>{titel}</DialogTitle>
        {loeschen && <DialogDescription>Position {datensatz.subid} wird aus diesem Bescheid gelöscht.</DialogDescription>}
        {!loeschen && (
          <div className="mt-4 grid grid-cols-2 gap-3">
            {felder.map(([feld, label, typ = 'text']) => {
              const props = {
                value: werte[feld],
                onChange: (e) => setWerte({ ...werte, [feld]: e.target.value }),
                disabled: isPending,
              };
              const auswahl = typ === 'person' ? optionen : istTier ? ['PKV'] : ['Beihilfe', 'PKV'];
              return (
                <label key={feld} className={`grid gap-1 text-sm ${typ === 'textarea' ? 'col-span-2' : ''}`}>
                  {label}
                  {typ === 'kostentraeger' || typ === 'person' ? (
                    <select {...props} required={typ === 'kostentraeger' && neu}
                      className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
                      <option value="">–</option>
                      {auswahl.map((wert) => <option key={wert} value={wert}>{wert}</option>)}
                    </select>
                  ) : typ === 'textarea' ? (
                    <textarea {...props} rows={3} className="w-full rounded-md border border-input bg-background px-3 py-2" />
                  ) : (
                    <Input {...props} type={typ === 'date' ? 'date' : 'text'}
                      inputMode={typ === 'betrag' ? 'decimal' : undefined} />
                  )}
                </label>
              );
            })}
          </div>
        )}
        {error && <p role="alert" className="mt-3 text-sm text-destructive">{error.message}</p>}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={schliessen} disabled={isPending}>Abbrechen</Button>
          <Button type="submit" variant={loeschen ? 'destructive' : 'default'} disabled={isPending || !geaendert}>
            {loeschen ? 'Löschen' : 'Speichern'}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
