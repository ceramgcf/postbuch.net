import { useEffect, useRef, useState } from 'react';
import { Check, Maximize, RotateCcw, X } from 'lucide-react';
import { istKonvex, klemme, standardEcken } from '@/lib/kamerascan/geometrie';

const LUPE = 132; // Durchmesser in CSS-Pixeln
const ZOOM = 3; // Vergrößerung gegenüber der Bildschirmdarstellung

// Begrenzungsviereck von Hand anpassen. Beim Ziehen einer Ecke erscheint eine
// Lupe auf der dem Finger abgewandten Seite (Autozoom), damit die Ecke unter
// dem Finger sichtbar bleibt. Die Ecke springt nicht unter den Finger, sondern
// folgt ihm mit dem Abstand vom Aufsetzen.
export default function EckenEditor({ fotoUrl, breite, hoehe, ecken: start, erkannt, onUebernehmen, onAbbrechen }) {
  const [ecken, setEcken] = useState(start);
  const [ziehend, setZiehend] = useState(null);
  const [lupeLinks, setLupeLinks] = useState(false);
  const svgRef = useRef(null);
  const lupeRef = useRef(null);
  const bildRef = useRef(null);
  const versatz = useRef({ x: 0, y: 0 });

  useEffect(() => { setEcken(start); }, [start]);

  useEffect(() => {
    const bild = new Image();
    bild.src = fotoUrl;
    bildRef.current = bild;
  }, [fotoUrl]);

  const lang = Math.max(breite, hoehe);
  const radius = lang * 0.022;

  function svgPunkt(ereignis) {
    const svg = svgRef.current;
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    const p = new DOMPoint(ereignis.clientX, ereignis.clientY).matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y, skala: ctm.a };
  }

  function zeichneLupe(i, liste) {
    const canvas = lupeRef.current;
    const bild = bildRef.current;
    const svg = svgRef.current;
    if (!canvas || !bild?.complete || !svg) return;
    const ctm = svg.getScreenCTM();
    const dpr = window.devicePixelRatio || 1;
    const groesse = Math.round(LUPE * dpr);
    if (canvas.width !== groesse) { canvas.width = groesse; canvas.height = groesse; }
    const ctx = canvas.getContext('2d');
    // Bildpunkte je Lupenpixel: Bildschirmmaßstab × Zoom
    const proPixel = 1 / (ctm.a * ZOOM * dpr);
    const fx = bild.naturalWidth / breite;
    const fy = bild.naturalHeight / hoehe;
    const p = liste[i];
    const halb = (groesse / 2) * proPixel;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, groesse, groesse);
    ctx.drawImage(bild, (p.x - halb) * fx, (p.y - halb) * fy, 2 * halb * fx, 2 * halb * fy, 0, 0, groesse, groesse);
    // Anliegende Kanten und Fadenkreuz
    const zuLupe = (q) => ({ x: groesse / 2 + (q.x - p.x) / proPixel, y: groesse / 2 + (q.y - p.y) / proPixel });
    const mitte = zuLupe(p);
    ctx.lineWidth = 2 * dpr;
    ctx.strokeStyle = 'rgba(139, 92, 246, 0.95)';
    ctx.beginPath();
    for (const n of [liste[(i + 1) % 4], liste[(i + 3) % 4]]) {
      const q = zuLupe(n);
      ctx.moveTo(mitte.x, mitte.y);
      ctx.lineTo(q.x, q.y);
    }
    ctx.stroke();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath();
    ctx.moveTo(groesse / 2 - 10 * dpr, groesse / 2); ctx.lineTo(groesse / 2 + 10 * dpr, groesse / 2);
    ctx.moveTo(groesse / 2, groesse / 2 - 10 * dpr); ctx.lineTo(groesse / 2, groesse / 2 + 10 * dpr);
    ctx.stroke();
  }

  function beginne(i, ereignis) {
    ereignis.preventDefault();
    const p = svgPunkt(ereignis);
    if (!p) return;
    svgRef.current.setPointerCapture(ereignis.pointerId);
    versatz.current = { x: ecken[i].x - p.x, y: ecken[i].y - p.y };
    setZiehend(i);
    setLupeLinks(ereignis.clientX > window.innerWidth / 2);
    requestAnimationFrame(() => zeichneLupe(i, ecken));
  }

  function bewege(ereignis) {
    if (ziehend == null) return;
    const p = svgPunkt(ereignis);
    if (!p) return;
    const neu = ecken.slice();
    neu[ziehend] = klemme({ x: p.x + versatz.current.x, y: p.y + versatz.current.y }, breite, hoehe);
    setEcken(neu);
    setLupeLinks(ereignis.clientX > window.innerWidth / 2);
    zeichneLupe(ziehend, neu);
  }

  function beende() {
    setZiehend(null);
  }

  const gueltig = istKonvex(ecken);
  const punkte = ecken.map((p) => `${p.x},${p.y}`).join(' ');

  return (
    <div className="flex h-full flex-col">
      <div className="relative min-h-0 flex-1">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${breite} ${hoehe}`}
          preserveAspectRatio="xMidYMid meet"
          className="absolute inset-0 h-full w-full touch-none select-none"
          onPointerMove={bewege}
          onPointerUp={beende}
          onPointerCancel={beende}
        >
          <image href={fotoUrl} x="0" y="0" width={breite} height={hoehe} />
          <path
            d={`M0,0 H${breite} V${hoehe} H0 Z M${punkte.replaceAll(' ', ' L')} Z`}
            fill="rgba(0,0,0,0.45)"
            fillRule="evenodd"
          />
          <polygon
            points={punkte}
            fill="none"
            stroke={gueltig ? 'rgb(139, 92, 246)' : 'rgb(239, 68, 68)'}
            strokeWidth={lang * 0.004}
            strokeLinejoin="round"
          />
          {ecken.map((p, i) => (
            <g key={i}>
              <circle
                cx={p.x} cy={p.y} r={radius}
                fill={ziehend === i ? 'rgba(139, 92, 246, 0.35)' : 'rgba(255,255,255,0.25)'}
                stroke="#fff" strokeWidth={lang * 0.003}
              />
              {/* großzügige, unsichtbare Trefferfläche für den Finger */}
              <circle
                cx={p.x} cy={p.y} r={radius * 2.6} fill="transparent"
                onPointerDown={(e) => beginne(i, e)}
                style={{ cursor: 'grab' }}
                aria-label={['Ecke oben links', 'Ecke oben rechts', 'Ecke unten rechts', 'Ecke unten links'][i]}
              />
            </g>
          ))}
        </svg>
        <canvas
          ref={lupeRef}
          aria-hidden
          style={{ width: LUPE, height: LUPE, display: ziehend == null ? 'none' : 'block' }}
          className={`pointer-events-none absolute top-3 rounded-full border-2 border-white shadow-xl ${lupeLinks ? 'left-3' : 'right-3'}`}
        />
        {!erkannt && ziehend == null && (
          <p className="pointer-events-none absolute inset-x-4 top-3 rounded-lg bg-black/70 px-3 py-2 text-center text-sm text-white">
            Kein Blatt erkannt – bitte die vier Ecken auf die Blattecken ziehen.
          </p>
        )}
        {!gueltig && (
          <p className="pointer-events-none absolute inset-x-4 bottom-3 rounded-lg bg-red-600/90 px-3 py-2 text-center text-sm text-white">
            Die Ecken überkreuzen sich.
          </p>
        )}
      </div>
      <div className="grid grid-cols-4 gap-1 bg-black px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2 text-white">
        <WerkzeugKnopf onClick={onAbbrechen} icon={X} label="Abbrechen" />
        <WerkzeugKnopf onClick={() => setEcken(start)} icon={RotateCcw} label="Zurücksetzen" />
        <WerkzeugKnopf onClick={() => setEcken(standardEcken(breite, hoehe, 0))} icon={Maximize} label="Ganzes Bild" />
        <WerkzeugKnopf onClick={() => onUebernehmen(ecken)} icon={Check} label="Übernehmen" disabled={!gueltig} betont />
      </div>
    </div>
  );
}

export function WerkzeugKnopf({ icon: Icon, label, betont = false, ...props }) {
  return (
    <button
      type="button"
      className={`flex min-h-14 flex-col items-center justify-center gap-1 rounded-lg px-1 py-1.5 text-[11px] font-medium leading-tight transition-colors disabled:opacity-40 ${betont ? 'text-violet-300' : 'text-white/90'} hover:bg-white/10 active:bg-white/15`}
      {...props}
    >
      <Icon className="h-5 w-5" />
      {label}
    </button>
  );
}
