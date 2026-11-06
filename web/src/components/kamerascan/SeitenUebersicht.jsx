import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, Loader2, Trash2 } from 'lucide-react';
import { WerkzeugKnopf } from './EckenEditor';

const LANGDRUCK_MS = 350;
const TOLERANZ_PX = 8;

/** Verschiebt die ausgewählten Seiten um einen Platz, ihre Reihenfolge bleibt. */
function verschiebe(seiten, ausgewaehlt, richtung) {
  const neu = seiten.slice();
  const indizes = neu.map((s, i) => (ausgewaehlt.has(s.id) ? i : -1)).filter((i) => i >= 0);
  if (richtung < 0) {
    for (const i of indizes) {
      if (i > 0 && !ausgewaehlt.has(neu[i - 1].id)) [neu[i - 1], neu[i]] = [neu[i], neu[i - 1]];
    }
  } else {
    for (const i of indizes.reverse()) {
      if (i < neu.length - 1 && !ausgewaehlt.has(neu[i + 1].id)) [neu[i + 1], neu[i]] = [neu[i], neu[i + 1]];
    }
  }
  return neu;
}

/**
 * Rasteransicht „Seiten ordnen“: Antippen wählt eine Seite aus (ebenso der
 * Kreis in der Ecke). Ausgewählte Seiten lassen sich nach vorn/hinten
 * verschieben oder entfernen (auch ohne Ziehen bedienbar). Die Ansicht ändert
 * nur einen Entwurf – übernommen wird er erst mit „Fertig“. Gezogen wird mit
 * der Maus direkt, auf Touch nach kurzem Gedrückthalten – sonst bliebe das
 * Raster nicht scrollbar.
 */
export default function SeitenUebersicht({ seiten, aktivId, onReihenfolge, onEntfernen }) {
  const [ausgewaehlt, setAusgewaehlt] = useState(() => new Set());
  const [zug, setZug] = useState(null); // { id, ziel }
  const zugRef = useRef(null);
  const druckRef = useRef(null); // { id, x, y, timer, pointerId, typ, element }
  const rasterRef = useRef(null);

  // Ausgewählte Seiten, die es nicht mehr gibt, fallen aus der Auswahl.
  useEffect(() => {
    setAusgewaehlt((alt) => {
      const ids = new Set(seiten.map((s) => s.id));
      const neu = new Set([...alt].filter((id) => ids.has(id)));
      return neu.size === alt.size ? alt : neu;
    });
  }, [seiten]);

  // Während des Ziehens darf der Finger die Ansicht nicht scrollen.
  useEffect(() => {
    const el = rasterRef.current;
    if (!el) return undefined;
    const sperre = (e) => { if (zugRef.current) e.preventDefault(); };
    el.addEventListener('touchmove', sperre, { passive: false });
    return () => el.removeEventListener('touchmove', sperre);
  }, []);

  const umschalten = (id) => setAusgewaehlt((alt) => {
    const neu = new Set(alt);
    if (neu.has(id)) neu.delete(id); else neu.add(id);
    return neu;
  });

  function zielUnter(x, y) {
    const el = document.elementFromPoint(x, y)?.closest('[data-seiten-index]');
    return el ? Number(el.dataset.seitenIndex) : null;
  }

  function starteZug(id) {
    const z = { id, ziel: seiten.findIndex((s) => s.id === id) };
    zugRef.current = z;
    setZug(z);
    const d = druckRef.current;
    if (d?.element) { try { d.element.setPointerCapture(d.pointerId); } catch { /* Zeiger schon weg */ } }
    if (d?.typ !== 'mouse') navigator.vibrate?.(15);
  }

  function druecken(e, id) {
    if (e.button > 0) return;
    const d = { id, x: e.clientX, y: e.clientY, pointerId: e.pointerId, typ: e.pointerType, element: e.currentTarget, timer: null };
    if (e.pointerType !== 'mouse') d.timer = setTimeout(() => starteZug(id), LANGDRUCK_MS);
    druckRef.current = d;
  }

  function bewegen(e) {
    const d = druckRef.current;
    if (!d) return;
    if (!zugRef.current) {
      const weit = Math.hypot(e.clientX - d.x, e.clientY - d.y) > TOLERANZ_PX;
      if (!weit) return;
      // Maus zieht sofort, ein Finger, der sich vor dem Langdruck bewegt, scrollt.
      if (d.typ === 'mouse') starteZug(d.id);
      else { clearTimeout(d.timer); druckRef.current = null; return; }
    }
    const ziel = zielUnter(e.clientX, e.clientY);
    if (ziel != null && ziel !== zugRef.current.ziel) {
      zugRef.current = { ...zugRef.current, ziel };
      setZug(zugRef.current);
    }
  }

  function loslassen() {
    const d = druckRef.current;
    if (d) clearTimeout(d.timer);
    druckRef.current = null;
    const z = zugRef.current;
    zugRef.current = null;
    setZug(null);
    if (!z) return false;
    const von = seiten.findIndex((s) => s.id === z.id);
    if (von >= 0 && z.ziel !== von) {
      const neu = seiten.slice();
      const [s] = neu.splice(von, 1);
      neu.splice(z.ziel, 0, s);
      onReihenfolge(neu);
    }
    return true;
  }

  // Vorschau der Reihenfolge während des Ziehens
  let anzeige = seiten;
  if (zug) {
    const von = seiten.findIndex((s) => s.id === zug.id);
    if (von >= 0) {
      anzeige = seiten.slice();
      const [s] = anzeige.splice(von, 1);
      anzeige.splice(zug.ziel, 0, s);
    }
  }

  const anzahl = ausgewaehlt.size;

  return (
    <>
      <div ref={rasterRef} className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6" role="list" aria-label="Seiten">
          {anzeige.map((s, i) => {
            const gewaehlt = ausgewaehlt.has(s.id);
            const gezogen = zug?.id === s.id;
            return (
              <div
                key={s.id}
                role="listitem"
                data-seiten-index={i}
                onPointerDown={(e) => druecken(e, s.id)}
                onPointerMove={bewegen}
                onPointerUp={() => { if (!loslassen()) umschalten(s.id); }}
                onPointerCancel={loslassen}
                onContextMenu={(e) => e.preventDefault()}
                className={`relative aspect-[3/4] cursor-grab touch-pan-y select-none overflow-hidden rounded-lg border-2 bg-white/10 transition-transform [-webkit-touch-callout:none] ${
                  gezogen ? 'z-10 scale-105 border-violet-400 shadow-2xl' : gewaehlt ? 'border-violet-400' : s.id === aktivId ? 'border-white/50' : 'border-transparent'
                }`}
              >
                {s.vorschauUrl && <img src={s.vorschauUrl} alt={`Seite ${i + 1}`} draggable={false} className="pointer-events-none h-full w-full object-cover" />}
                {s.rechnet && <Loader2 className="absolute inset-0 m-auto h-5 w-5 animate-spin" />}
                <span className="absolute bottom-1 left-1 rounded bg-black/70 px-1.5 text-xs font-semibold">{i + 1}</span>
                <button
                  type="button"
                  data-auswahl
                  onPointerDown={(e) => e.stopPropagation()}
                  onPointerUp={(e) => e.stopPropagation()}
                  onClick={() => umschalten(s.id)}
                  className="absolute right-0 top-0 flex h-11 w-11 items-start justify-end p-1.5"
                  role="checkbox"
                  aria-checked={gewaehlt}
                  aria-label={`Seite ${i + 1} auswählen`}
                >
                  <span className={`flex h-6 w-6 items-center justify-center rounded-full border-2 ${gewaehlt ? 'border-violet-400 bg-violet-500' : 'border-white bg-black/40'}`}>
                    {gewaehlt && <Check className="h-4 w-4" />}
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      </div>
      <div className="px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-1">
        {anzahl > 0 ? (
          <div className="grid grid-cols-3 gap-1">
            <WerkzeugKnopf icon={ArrowLeft} label="Nach vorn" onClick={() => onReihenfolge(verschiebe(seiten, ausgewaehlt, -1))} />
            <WerkzeugKnopf icon={ArrowRight} label="Nach hinten" onClick={() => onReihenfolge(verschiebe(seiten, ausgewaehlt, 1))} />
            <WerkzeugKnopf
              icon={Trash2}
              label={anzahl === 1 ? '1 Seite entfernen' : `${anzahl} Seiten entfernen`}
              onClick={() => { onEntfernen(new Set(ausgewaehlt)); setAusgewaehlt(new Set()); }}
            />
          </div>
        ) : (
          <p className="flex min-h-14 items-center justify-center px-4 text-center text-xs text-white/70">
            {seiten.length === 0
              ? 'Alle Seiten entfernt – „Fertig“ übernimmt das, das X oben bricht ab.'
              : 'Seite gedrückt halten und an die neue Stelle ziehen – oder antippen, um sie auszuwählen und zu verschieben oder zu entfernen.'}
          </p>
        )}
      </div>
    </>
  );
}
