import { useState, useRef } from 'react';
import { api } from '@/api/client';
import { formatDate } from '@/lib/utils';
import { FileText, Folder } from 'lucide-react';

// Chat-Eingabefeld mit #P/#A-Mention-Autocomplete.
//
// Beim Tippen von "#" + mind. 1 Zeichen öffnet sich ein Vorschlags-Popup
// (Live-Suche nach Nummer/Betreff/Kontakt über /api/search/suggest). Auswahl
// per Klick, Enter oder Tab ersetzt das Token durch "#P000123 ". Solange das
// Popup offen ist, sendet Enter NICHT die Nachricht. Das Popup ist über dem
// Eingabefeld verankert – auf Mobile bleibt es damit oberhalb der Tastatur
// sichtbar (das Eingabefeld ist am unteren Rand gedockt).

// #-Token unmittelbar vor der Cursor-Position (ohne Whitespace dazwischen)
function findMentionToken(text, caret) {
  const m = text.slice(0, caret).match(/#([^\s#]{0,30})$/);
  return m ? { token: m[1], start: caret - m[0].length } : null;
}

function suggestionLabel(s) {
  if (s.type === 'A') return s.betreff || '–';
  return [s.kontakt, s.betreff].filter(Boolean).join(' – ') || s.art || '–';
}

export default function ChatInput({ value, onChange, onSend, disabled, placeholder, textareaRef }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [hi, setHi] = useState(0);
  const debounceRef = useRef(null);
  const tokenRef = useRef(null); // { token, start } des aktiven #-Tokens

  const close = () => {
    clearTimeout(debounceRef.current);
    setOpen(false); setItems([]); setHi(0);
    tokenRef.current = null;
  };

  const updateTrigger = (text, caret) => {
    const tok = findMentionToken(text, caret);
    tokenRef.current = tok;
    clearTimeout(debounceRef.current);
    if (!tok || tok.token.length === 0) {
      if (open) { setOpen(false); setItems([]); setHi(0); }
      return;
    }
    debounceRef.current = setTimeout(async () => {
      try {
        const { suggestions } = await api.search.suggest(tok.token, 8);
        // Nur anwenden, wenn das Token inzwischen nicht weitergetippt wurde
        if (tokenRef.current?.token !== tok.token) return;
        setItems(suggestions || []);
        setHi(0);
        setOpen((suggestions || []).length > 0);
      } catch {
        close();
      }
    }, 200);
  };

  const apply = (s) => {
    const tok = tokenRef.current;
    if (!tok || !s) return;
    const caret = textareaRef.current?.selectionStart ?? value.length;
    const newValue = `${value.slice(0, tok.start)}#${s.id} ${value.slice(caret)}`;
    const newCaret = tok.start + s.id.length + 2;
    onChange(newValue);
    close();
    setTimeout(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(newCaret, newCaret);
    }, 0);
  };

  const handleKeyDown = (e) => {
    if (open && items.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setHi(h => (h + 1) % items.length); return; }
      if (e.key === 'ArrowUp')   { e.preventDefault(); setHi(h => (h - 1 + items.length) % items.length); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); apply(items[hi]); return; }
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  };

  return (
    <div className="relative flex-1 min-w-0">
      {open && (
        <div className="absolute bottom-full left-0 right-0 mb-2 z-30 rounded-xl border border-border bg-background shadow-lg max-h-64 overflow-y-auto">
          {items.map((s, i) => (
            <button
              key={`${s.type}-${s.id}`}
              type="button"
              onMouseDown={(e) => e.preventDefault() /* Fokus im Textarea behalten */}
              onClick={() => apply(s)}
              onMouseEnter={() => setHi(i)}
              className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${i === hi ? 'bg-accent' : ''}${s.historisch ? ' opacity-60' : ''}`}
            >
              {s.type === 'A'
                ? <Folder className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                : <FileText className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />}
              <span className="font-mono text-xs">{s.id}</span>
              <span className="truncate text-muted-foreground">({suggestionLabel(s)})</span>
              <span className="ml-auto flex-shrink-0 text-[11px] text-muted-foreground">
                {s.type === 'A'
                  ? `${s.dok_count ?? 0} Dok.`
                  : (s.briefdatum ? formatDate(s.briefdatum) : '')}
              </span>
            </button>
          ))}
        </div>
      )}
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => { onChange(e.target.value); updateTrigger(e.target.value, e.target.selectionStart); }}
        onSelect={(e) => updateTrigger(e.target.value, e.target.selectionStart)}
        onKeyDown={handleKeyDown}
        onBlur={() => setTimeout(close, 150)}
        placeholder={placeholder}
        rows={2}
        disabled={disabled}
        className="w-full resize-none rounded-xl border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
      />
    </div>
  );
}
