import { useState, useEffect, useMemo, useRef } from 'react';
import { Check, Printer } from 'lucide-react';
import { Dialog, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

const FRIST_MS = 3000;

/**
 * Auswahl vor dem Druck eines mehrteiligen Etiketts. Vorauswahl sind alle
 * Teile; läuft die Frist ohne Eingriff ab, wird alles gedruckt. Der erste Klick
 * auf eine Vorschau hält die Frist an, gedruckt wird dann erst per Knopf.
 *
 * Die Frist bleibt bewusst kurz: Ohne Druckerverbindung baut der Druck die
 * Bluetooth-Verbindung auf, und das erlaubt der Browser nur wenige Sekunden
 * nach dem auslösenden Klick.
 *
 * @param {{ etiketten: { canvas: HTMLCanvasElement, name: string }[],
 *           onDrucken: (auswahl: HTMLCanvasElement[]) => void,
 *           onAbbrechen: () => void }} props
 */
export function EtikettAuswahlDialog({ etiketten, onDrucken, onAbbrechen }) {
  const [gewaehlt, setGewaehlt] = useState(() => etiketten.map(() => true));
  const [laeuft, setLaeuft] = useState(true);
  const [rest, setRest] = useState(FRIST_MS / 1000);
  const erledigt = useRef(false);
  const bilder = useMemo(() => etiketten.map((e) => e.canvas.toDataURL('image/png')), [etiketten]);
  const anzahl = gewaehlt.filter(Boolean).length;

  function drucken(auswahl) {
    if (erledigt.current) return;
    erledigt.current = true;
    onDrucken(etiketten.filter((_, i) => auswahl[i]).map((e) => e.canvas));
  }

  useEffect(() => {
    if (!laeuft) return undefined;
    const ende = setTimeout(() => drucken(etiketten.map(() => true)), FRIST_MS);
    const takt = setInterval(() => setRest((r) => Math.max(0, r - 1)), 1000);
    return () => { clearTimeout(ende); clearInterval(takt); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [laeuft]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onAbbrechen(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onAbbrechen]);

  function umschalten(i) {
    setLaeuft(false);
    setGewaehlt((g) => g.map((v, j) => (j === i ? !v : v)));
  }

  const knopfText = anzahl === etiketten.length
    ? (etiketten.length === 2 ? 'Beide drucken' : 'Alle drucken')
    : anzahl === 1 ? '1 Etikett drucken' : `${anzahl} Etiketten drucken`;

  return (
    <Dialog open onOpenChange={() => onAbbrechen()}>
      <DialogTitle>Etiketten drucken</DialogTitle>
      <DialogDescription>
        {laeuft
          ? `Ohne Auswahl werden in ${rest} s alle Teile gedruckt. Tippe auf ein Etikett, um es ab- oder zuzuwählen.`
          : 'Tippe auf ein Etikett, um es ab- oder zuzuwählen.'}
      </DialogDescription>

      <div className="mt-4 space-y-3">
        {etiketten.map((e, i) => (
          <button
            key={e.name}
            type="button"
            aria-pressed={gewaehlt[i]}
            onClick={() => umschalten(i)}
            className={`relative block w-full rounded-lg border-2 p-2 text-left transition-colors ${
              gewaehlt[i] ? 'border-primary bg-primary/5' : 'border-border opacity-50 hover:opacity-80'
            }`}
          >
            <img
              src={bilder[i]}
              alt={`Vorschau: ${e.name}`}
              className="mx-auto w-full max-w-[320px] rounded border border-border/60 bg-white [image-rendering:pixelated]"
            />
            <span className="mt-1.5 flex items-center gap-2 text-sm">
              <span className={`flex h-4 w-4 items-center justify-center rounded border ${
                gewaehlt[i] ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/50'
              }`}>
                {gewaehlt[i] && <Check className="h-3 w-3" />}
              </span>
              {e.name}
            </span>
          </button>
        ))}
      </div>

      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onAbbrechen}>Abbrechen</Button>
        <Button
          onClick={() => drucken(gewaehlt)}
          disabled={anzahl === 0}
          className="relative overflow-hidden"
        >
          <Printer className="h-4 w-4" />
          {knopfText}
          {laeuft && (
            <span
              aria-hidden
              className="absolute inset-x-0 bottom-0 h-1 origin-left bg-primary-foreground/60 animate-countdown-bar"
            />
          )}
        </Button>
      </div>
    </Dialog>
  );
}
