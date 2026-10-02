import { useEffect, useRef, useState } from 'react';
import { api } from '@/api/client';
import { formatDate } from '@/lib/utils';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { parsePostidToken } from '@/lib/erstattung';
import { Dialog, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FileText } from 'lucide-react';

// Dialog zum Auswählen eines Dokuments (auf `arten` eingeschränkt) – per Suche
// (Nummer/Betreff/Kontakt) ODER per direktem Einfügen eines SymLink-Tokens.
// Als Dialog ([role="dialog"]) bleibt er auch auf Mobile im Portrait sichtbar.
export function DocumentPicker({ open, onOpenChange, arten, title, description, onSelect, isPending }) {
  const [q, setQ] = useState('');
  const [items, setItems] = useState([]);
  const [hi, setHi] = useState(0);
  const [loading, setLoading] = useState(false);
  const debouncedQ = useDebouncedValue(q, 200);
  const reqIdRef = useRef(0);

  useEffect(() => {
    if (!open) { setQ(''); setItems([]); setHi(0); }
  }, [open]);

  useEffect(() => {
    const term = debouncedQ.trim();
    if (term.length < 2) { setItems([]); setLoading(false); return; }
    const rid = ++reqIdRef.current;
    setLoading(true);
    api.search.suggest(term, 8, { arten })
      .then(({ suggestions }) => {
        if (rid !== reqIdRef.current) return;
        setItems(suggestions || []);
        setHi(0);
      })
      .catch(() => { if (rid === reqIdRef.current) setItems([]); })
      .finally(() => { if (rid === reqIdRef.current) setLoading(false); });
  }, [debouncedQ, arten]);

  // Wenn die Eingabe ein gültiges SymLink-Token ist, „direkt zuordnen" anbieten.
  const pastedPostid = parsePostidToken(q);

  function choose(postid) {
    onSelect(postid);
  }

  function handleKeyDown(e) {
    if (items.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setHi(h => (h + 1) % items.length); return; }
      if (e.key === 'ArrowUp')   { e.preventDefault(); setHi(h => (h - 1 + items.length) % items.length); return; }
      if (e.key === 'Enter')     { e.preventDefault(); choose(items[hi].id); return; }
    } else if (e.key === 'Enter' && pastedPostid) {
      e.preventDefault(); choose(pastedPostid);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="lg">
      <DialogTitle>{title}</DialogTitle>
      {description && <DialogDescription>{description}</DialogDescription>}

      <div className="mt-4 space-y-3">
        <Input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Nummer, Betreff oder Kontakt… oder SymLink einfügen (P000123)"
          className="text-sm"
        />

        {pastedPostid && (
          <button
            type="button"
            onClick={() => choose(pastedPostid)}
            disabled={isPending}
            className="flex w-full items-center gap-2 rounded-lg border border-primary/40 bg-primary/5 px-3 py-2 text-left text-sm hover:bg-primary/10 disabled:opacity-50"
          >
            <FileText className="h-4 w-4 flex-shrink-0 text-primary" />
            <span>SymLink <span className="font-mono">{pastedPostid}</span> direkt zuordnen</span>
          </button>
        )}

        <div className="max-h-64 overflow-y-auto rounded-lg border border-border divide-y divide-border">
          {loading && <div className="px-3 py-3 text-sm text-muted-foreground">Suche…</div>}
          {!loading && items.length === 0 && debouncedQ.trim().length >= 2 && !pastedPostid && (
            <div className="px-3 py-3 text-sm text-muted-foreground">Keine Treffer.</div>
          )}
          {!loading && debouncedQ.trim().length < 2 && !pastedPostid && (
            <div className="px-3 py-3 text-sm text-muted-foreground">Mindestens 2 Zeichen eingeben.</div>
          )}
          {items.map((s, i) => (
            <button
              key={s.id}
              type="button"
              onClick={() => choose(s.id)}
              onMouseEnter={() => setHi(i)}
              disabled={isPending}
              className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors disabled:opacity-50 ${i === hi ? 'bg-accent' : ''}${s.historisch ? ' opacity-60' : ''}`}
            >
              <FileText className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
              <span className="font-mono text-xs">{s.id}</span>
              <span className="truncate text-muted-foreground">
                {[s.kontakt, s.betreff].filter(Boolean).join(' – ') || s.art || '–'}
              </span>
              <span className="ml-auto flex-shrink-0 text-[11px] text-muted-foreground">
                {s.briefdatum ? formatDate(s.briefdatum) : ''}
              </span>
            </button>
          ))}
        </div>
      </div>

      <DialogFooter>
        <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={isPending}>Abbrechen</Button>
      </DialogFooter>
    </Dialog>
  );
}
