import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

export function Stepper({ schritte, aktuell, onSelect }) {
  return (
    <ol className="flex w-full items-start gap-2" aria-label="Fortschritt">
      {schritte.map((s, index) => {
        const fertig = index < aktuell;
        const aktiv = index === aktuell;
        return (
          <li key={s.id || index} className="min-w-0 flex-1">
            <button type="button" onClick={() => onSelect?.(index)} disabled={!onSelect}
              aria-current={aktiv ? 'step' : undefined} className="w-full text-left disabled:cursor-default">
              <span className={cn('mb-1 flex h-7 w-7 items-center justify-center rounded-full border text-xs font-semibold',
                fertig && 'border-primary bg-primary text-primary-foreground',
                aktiv && 'border-primary text-primary',
                !fertig && !aktiv && 'border-border text-muted-foreground')}>
                {fertig ? <Check className="h-4 w-4" /> : index + 1}
              </span>
              <span className={cn('block truncate text-xs', aktiv ? 'font-medium' : 'text-muted-foreground')}>{s.label}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
