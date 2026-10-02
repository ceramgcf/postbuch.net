import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ArtBadge } from './ArtBadge';
import { LebensbereichBadge } from './LebensbereichBadge';

/**
 * Auswahl für eine LxD-Achse. Anders als ein natives <select> kann sie die
 * tatsächlichen Badges in Trigger und Optionsliste zeigen.
 */
export function TaxonomyBadgeSelect({
  kind,
  value,
  options = [],
  onChange,
  placeholder,
  className,
  disabled = false,
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const sortedOptions = useMemo(
    () => [...options].sort((a, b) => a.label.localeCompare(b.label, 'de')),
    [options],
  );
  const selected = options.find((option) => option.code === value);

  useEffect(() => {
    if (!open) return undefined;
    function closeOnOutsideClick(event) {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    }
    function closeOnEscape(event) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  const renderBadge = (code) => kind === 'lebensbereich'
    ? <LebensbereichBadge lebensbereich={code} />
    : <ArtBadge art={code} />;

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className={cn(
          'flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-input bg-background px-2 text-sm shadow-sm shadow-primary/[0.02]',
          'transition-all hover:bg-muted/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:border-primary/40',
          'disabled:cursor-not-allowed disabled:opacity-50',
          open && 'border-primary/40 ring-2 ring-ring/30',
        )}
      >
        <span className={cn('min-w-0', !selected && 'px-1 text-muted-foreground')}>
          {selected ? renderBadge(selected.code) : placeholder}
        </span>
        <ChevronDown className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute left-0 right-0 z-[70] mt-1 max-h-72 overflow-y-auto rounded-xl border border-border bg-popover p-1.5 text-popover-foreground shadow-xl shadow-black/10"
        >
          {placeholder && (
            <button
              type="button"
              role="option"
              aria-selected={!value}
              onClick={() => { onChange(''); setOpen(false); }}
              className="flex min-h-9 w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted/60"
            >
              <span>{placeholder}</span>
              {!value && <Check className="h-4 w-4 text-primary" />}
            </button>
          )}
          {sortedOptions.map((option) => (
            <button
              type="button"
              role="option"
              aria-selected={option.code === value}
              key={option.code}
              onClick={() => { onChange(option.code); setOpen(false); }}
              className={cn(
                'flex min-h-9 w-full items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-left hover:bg-muted/60',
                option.code === value && 'bg-primary/5',
              )}
            >
              {renderBadge(option.code)}
              {option.code === value && <Check className="h-4 w-4 shrink-0 text-primary" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
