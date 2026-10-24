import { useEffect, useState } from 'react';
import { Check, X } from 'lucide-react';
import { STROM_OPTIONEN, kameraListe, leseKameraStrom, leseKameraWahl } from '@/lib/kamerascan/kamera';

function Auswahl({ label, optionen, gewaehlt, onWaehle }) {
  return (
    <div className="space-y-1" role="radiogroup" aria-label={label}>
      {optionen.map(({ id, name, text, aktiv }) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={gewaehlt === id}
          onClick={() => onWaehle(id)}
          className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors
            ${gewaehlt === id ? 'bg-violet-600/45' : 'hover:bg-white/10'}`}
        >
          <span className="min-w-0 flex-1">
            <span className={`block truncate text-sm font-medium ${gewaehlt === id ? 'text-violet-200' : ''}`}>{name}</span>
            {text && <span className="block text-xs text-white/80">{text}</span>}
          </span>
          {aktiv && <span className="shrink-0 rounded-full bg-white/15 px-2 py-0.5 text-[10px] uppercase tracking-wide text-white/80">Aktiv</span>}
          {gewaehlt === id && <Check className="h-4 w-4 shrink-0 text-violet-200" />}
        </button>
      ))}
    </div>
  );
}

/**
 * Kamera und (im Debug-Modus) Livebild-Größe des Kamerascans, direkt über dem
 * laufenden Livebild. Jede Wahl gilt sofort und nur für diesen Browser;
 * `onKamera` bzw. `onStrom` speichern die Wahl und starten den Videostrom neu.
 */
export default function KameraEinstellungen({ geraetId, mitLivebild, onKamera, onStrom, onSchliessen }) {
  const [kameras, setKameras] = useState(null);
  const kamera = leseKameraWahl() ?? '';
  const strom = leseKameraStrom().id;

  // Neu lesen, sobald eine andere Kamera läuft: erst dann kennt der Browser alle Namen.
  useEffect(() => {
    let aktuell = true;
    kameraListe().then((l) => { if (aktuell) setKameras(l); });
    return () => { aktuell = false; };
  }, [geraetId]);

  const benannt = (kameras ?? []).filter((k) => k.label);
  const kameraOptionen = [
    { id: '', name: 'Automatisch', text: 'Rückkamera mit der kleinsten Nummer, meist die Hauptkamera' },
    ...benannt.map((k) => ({ id: k.label, name: k.label, aktiv: k.deviceId === geraetId })),
  ];
  // Gemerkte Kamera, die das Gerät gerade nicht meldet, trotzdem anzeigen.
  if (kameras && kamera && !kameraOptionen.some((o) => o.id === kamera)) {
    kameraOptionen.push({ id: kamera, name: kamera, text: 'Derzeit nicht gefunden' });
  }

  return (
    <div className="absolute inset-0 z-20 flex items-end justify-center" onClick={(e) => { e.stopPropagation(); onSchliessen(); }}>
      <div
        className="max-h-[60%] w-full max-w-md overflow-y-auto rounded-t-2xl bg-neutral-900/50 p-3 pb-4 [text-shadow:0_1px_3px_rgb(0_0_0/0.9)] sm:mb-3 sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Kamera-Einstellungen"
      >
        <div className="mb-2 flex items-center">
          <p className="flex-1 px-1 text-sm font-semibold">Kamera</p>
          <button type="button" onClick={onSchliessen} className="flex h-9 w-9 items-center justify-center rounded-full hover:bg-white/10" aria-label="Schließen">
            <X className="h-5 w-5" />
          </button>
        </div>
        {kameras === null
          ? <p className="px-1 text-xs text-white/80">Kameras werden gesucht …</p>
          : <Auswahl label="Kamera des Kamerascans" optionen={kameraOptionen} gewaehlt={kamera} onWaehle={onKamera} />}
        {mitLivebild && (
          <>
            <p className="mb-1 mt-4 px-1 text-sm font-semibold">Livebild</p>
            <p className="mb-2 px-1 text-xs text-white/80">
              Kleinere Größen laufen flüssiger, zeigen auf manchen Geräten aber nur die Bildmitte; das Foto wird
              dann auf diesen Ausschnitt zugeschnitten.
            </p>
            <Auswahl label="Livebild des Kamerascans" optionen={STROM_OPTIONEN} gewaehlt={strom} onWaehle={onStrom} />
          </>
        )}
      </div>
    </div>
  );
}
