import { useState, useEffect } from 'react';
import { X } from 'lucide-react';

// Countdown-Ring für automatische Weiterleitungen: 44px-Button, SVG-Ring läuft
// in 3s ab, Klick bricht die Weiterleitung ab. Bei reduced-motion Zahlen-Countdown.
// Die Positionierung (relative/absolute) kommt per className vom Aufrufer.
export function AutoForwardRing({ onCancel, className = 'relative' }) {
  const reduced = typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const [remaining, setRemaining] = useState(3);
  useEffect(() => {
    const iv = setInterval(() => setRemaining((r) => (r > 0 ? r - 1 : 0)), 1000);
    return () => clearInterval(iv);
  }, []);
  return (
    <button
      type="button"
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onCancel(); }}
      aria-label="Weiterleitung abbrechen"
      title="Weiterleitung abbrechen"
      className={`${className} flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-background/90 backdrop-blur-sm border border-border/60 shadow-sm text-primary transition-opacity`}
    >
      {reduced ? (
        <span className="text-sm font-semibold tabular-nums">{remaining}</span>
      ) : (
        <>
          <svg className="absolute inset-0 h-full w-full -rotate-90" viewBox="0 0 44 44" aria-hidden="true">
            <circle
              cx="22" cy="22" r="17" fill="none" stroke="currentColor" strokeWidth="2.5"
              strokeDasharray="106.8" className="animate-countdown-drain"
            />
          </svg>
          <X className="h-4 w-4" />
        </>
      )}
      <span role="timer" aria-live="assertive" className="sr-only">
        Weiterleitung in {remaining} Sekunden
      </span>
    </button>
  );
}
