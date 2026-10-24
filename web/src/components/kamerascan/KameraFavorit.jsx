import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { Camera, CheckCircle2 } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { kameraVerfuegbar } from '@/lib/kamerascan/kamera';
import KameraScan from './KameraScan';
import { useKameraHochladen } from './useKameraHochladen';
import { etikettPfad } from '@/lib/kamerascan/postbuchQr';

/**
 * Kamerascan aus der Favoritenleiste: Knopf in der Mitte der Leiste. Knopf und Overlay sind getrennt, damit der Scan weiterläuft, auch
 * wenn die Leiste selbst ausgeblendet wird (Tastatur, Menü).
 */
export function useKameraFavorit() {
  const { canWrite } = useAuth();
  const [offen, setOffen] = useState(false);
  const [meldung, setMeldung] = useState(null);
  const hochladen = useKameraHochladen();
  const navigate = useNavigate();
  const verfuegbar = canWrite && kameraVerfuegbar();

  useEffect(() => {
    if (!meldung) return undefined;
    const t = setTimeout(() => setMeldung(null), 5000);
    return () => clearTimeout(t);
  }, [meldung]);

  if (!verfuegbar) return { knopf: null, overlay: null };

  // Aufbau wie die übrigen Einträge der Leiste; hervorgehoben ist nur das
  // Symbol: Strich im postbuch.net-Farbverlauf mit zartem Glow.
  const knopf = (
    <button
      type="button"
      onClick={() => { setMeldung(null); setOffen(true); }}
      aria-label="Mit Kamera scannen"
      className="flex h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium text-muted-foreground transition-transform active:scale-95"
    >
      <svg width="0" height="0" className="absolute" aria-hidden focusable="false">
        <defs>
          <linearGradient id="kamera-favorit-verlauf" x1="2" y1="4" x2="22" y2="20" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#7d2dbd" />
            <stop offset="0.5" stopColor="#a56bd8" />
            <stop offset="1" stopColor="#2cc5dd" />
          </linearGradient>
        </defs>
      </svg>
      <span className="flex h-7 w-12 items-center justify-center">
        <Camera className="h-6 w-6" color="url(#kamera-favorit-verlauf)" strokeWidth={2.2}
          style={{ filter: 'drop-shadow(0 0 3px rgba(125, 45, 189, 0.35)) drop-shadow(0 0 5px rgba(44, 197, 221, 0.25))' }}
        />
      </span>
      Scannen
    </button>
  );

  const overlay = (
    <>
      <KameraScan
        offen={offen}
        onSchliessen={() => setOffen(false)}
        onFertig={async (scan) => {
          const text = await hochladen(scan);
          if (text) setMeldung(text);
        }}
        zielText="Hochladen"
        onPostbuchQr={(kennung) => navigate(etikettPfad(kennung))}
      />
      {meldung && (
        <div
          role="status"
          className="pointer-events-none fixed inset-x-4 bottom-[calc(5.5rem+env(safe-area-inset-bottom))] z-40 mx-auto flex max-w-md items-center gap-2 rounded-xl bg-foreground px-4 py-3 text-sm text-background shadow-lg"
        >
          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
          {meldung}
        </div>
      )}
    </>
  );

  return { knopf, overlay };
}
