/**
 * AnalyseFilter.jsx – gemeinsame Filterbausteine der Analyse-Seiten
 *
 * Aufbau: ein Knopf „Filter“ öffnet ein Popover mit Auswahlleisten, daneben
 * zeigen Chips die aktiven Einschränkungen. Ein Klick auf einen Chip öffnet
 * das Popover, das X setzt die jeweilige Einschränkung zurück.
 */
import { useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { SlidersHorizontal, X } from 'lucide-react';

/** Knopf „Filter“ mit Popover; schließt bei Klick außerhalb und mit Escape. */
export function FilterPopover({ offen, onOffenChange, children }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!offen) return undefined;
    const schliessen = (e) => {
      if (e.type === 'keydown' ? e.key === 'Escape' : !ref.current?.contains(e.target)) onOffenChange(false);
    };
    document.addEventListener('mousedown', schliessen);
    document.addEventListener('keydown', schliessen);
    return () => {
      document.removeEventListener('mousedown', schliessen);
      document.removeEventListener('keydown', schliessen);
    };
  }, [offen, onOffenChange]);

  return (
    <div className="relative" ref={ref}>
      <Button
        variant="outline"
        size="sm"
        className="h-8 gap-1.5"
        onClick={() => onOffenChange(!offen)}
        aria-expanded={offen}
      >
        <SlidersHorizontal className="h-3.5 w-3.5" />
        Filter
      </Button>
      {offen && (
        <div className="absolute left-0 top-full mt-1 z-50 w-[36rem] max-w-[calc(100vw-2rem)] space-y-3 rounded-md border bg-popover p-3 shadow-md">
          {children}
        </div>
      )}
    </div>
  );
}

/** Aktiver Filter als Chip neben dem Filterknopf; mit onEntfernen zurücksetzbar */
export function FilterChip({ children, onClick, onEntfernen }) {
  return (
    <span className="inline-flex items-center rounded-full border bg-muted/40 text-xs">
      <button type="button" className="px-2.5 py-1 hover:text-foreground" onClick={onClick}>{children}</button>
      {onEntfernen && (
        <button type="button" className="pr-2 text-muted-foreground hover:text-foreground" onClick={onEntfernen} title="Filter zurücksetzen">
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}

/** Mehrfachauswahl; „Alle“ erscheint, solange nicht alles gewählt ist. */
export function FilterLeiste({ label, werte, ausgewaehlt, beschriftung, onToggle, onAlle }) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-sm font-medium text-muted-foreground mr-1">{label}:</span>
      {werte.map((w) => (
        <Button
          key={w}
          variant={ausgewaehlt.has(w) ? 'default' : 'outline'}
          size="sm"
          className="h-7 px-3 text-xs"
          onClick={() => onToggle(w)}
        >
          {beschriftung(w)}
        </Button>
      ))}
      {ausgewaehlt.size < werte.length && (
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground" onClick={onAlle}>
          Alle
        </Button>
      )}
    </div>
  );
}

/** Einfachauswahl; optionen: [{ wert, label }] */
export function AuswahlLeiste({ label, optionen, wert, onChange }) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-sm font-medium text-muted-foreground mr-1">{label}:</span>
      {optionen.map((o) => (
        <Button
          key={o.wert}
          variant={wert === o.wert ? 'default' : 'outline'}
          size="sm"
          className="h-7 px-3 text-xs"
          onClick={() => onChange(o.wert)}
        >
          {o.label}
        </Button>
      ))}
    </div>
  );
}
