import { Camera } from 'lucide-react';
import { kameraVerfuegbar } from '@/lib/kamerascan/kamera';
import { useSeitenstapel } from './Seitenstapel';

/**
 * Kamerascan aus der Favoritenleiste: Knopf in der Mitte der Leiste. Der Scan
 * selbst liegt im Seitenstapel über allen Seiten und läuft weiter, auch wenn
 * die Leiste ausgeblendet wird (Tastatur, Menü). Ein offener Scan zeigt seine
 * Seitenzahl am Knopf.
 */
export function useKameraFavorit() {
  const stapel = useSeitenstapel();
  const verfuegbar = stapel.verfuegbar && (kameraVerfuegbar() || !!stapel.offenerScan);

  if (!verfuegbar) return { knopf: null };
  const anzahl = stapel.offenerScan?.anzahl ?? 0;

  // Aufbau wie die übrigen Einträge der Leiste; hervorgehoben ist nur das
  // Symbol: Strich im postbuch.net-Farbverlauf mit zartem Glow.
  const knopf = (
    <button
      type="button"
      onClick={() => stapel.oeffnen()}
      aria-label={anzahl ? `Offenen Scan mit ${anzahl === 1 ? '1 Seite' : `${anzahl} Seiten`} fortsetzen` : 'Mit Kamera scannen'}
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
      <span className="relative flex h-7 w-12 items-center justify-center">
        <Camera className="h-6 w-6" color="url(#kamera-favorit-verlauf)" strokeWidth={2.2}
          style={{ filter: 'drop-shadow(0 0 3px rgba(125, 45, 189, 0.35)) drop-shadow(0 0 5px rgba(44, 197, 221, 0.25))' }}
        />
        {anzahl > 0 && (
          <span className="absolute -top-1 right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-violet-600 px-1 text-[10px] font-bold leading-none text-white" aria-hidden>
            {anzahl}
          </span>
        )}
      </span>
      Scannen
    </button>
  );

  return { knopf };
}
