import { useEffect, useState } from 'react';
import { FileText } from 'lucide-react';
import { api } from '@/api/client';
import { cn } from '@/lib/utils';

/**
 * Vorschaubild eines Eingangs (Seite 1). Ist der Server gerade mit anderen
 * Bildern beschäftigt oder lässt sich das PDF nicht rendern, bleibt der
 * Platzhalter stehen; ein zweiter Versuch folgt einmalig nach kurzer Pause.
 */
export default function EingangVorschau({ schluessel, className }) {
  const [versuch, setVersuch] = useState(0);
  const [fehler, setFehler] = useState(false);
  const [geladen, setGeladen] = useState(false);

  useEffect(() => { setVersuch(0); setFehler(false); setGeladen(false); }, [schluessel]);

  useEffect(() => {
    if (!fehler || versuch >= 1) return undefined;
    const timer = setTimeout(() => { setFehler(false); setVersuch((n) => n + 1); }, 6000);
    return () => clearTimeout(timer);
  }, [fehler, versuch]);

  return (
    <div className={cn('relative flex items-center justify-center overflow-hidden bg-muted/40', className)}>
      {!geladen && <FileText className="h-10 w-10 text-muted-foreground/40" aria-hidden />}
      {!fehler && (
        <img
          key={versuch}
          src={`${api.eingang.vorschauUrl(schluessel)}${versuch ? `?v=${versuch}` : ''}`}
          alt=""
          loading="lazy"
          onLoad={() => setGeladen(true)}
          onError={() => setFehler(true)}
          className={cn('absolute inset-0 h-full w-full object-cover object-top', !geladen && 'opacity-0')}
        />
      )}
    </div>
  );
}
