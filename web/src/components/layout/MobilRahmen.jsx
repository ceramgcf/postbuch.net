import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router';
import { Menu, X, LogOut, RotateCcw, RotateCw } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useNavigation } from '@/hooks/useNavigation';
import { useSeiteSlots } from '@/hooks/useSeite';
import { useTaskStore } from '@/hooks/useTaskStore';
import { useUndoHistory } from '@/hooks/useUndoHistory';
import { useZurueckSchliesst } from '@/hooks/useBackButtonGuard';
import { istAktiv, titelFuerPfad } from '@/lib/navigation';
import { GlowText, MarkeVoll } from './Marke';
import { TaskStatusBar } from './TaskStatusBar';
import { UndoRedoBar } from '@/components/ui/UndoRedoBar';
import { useKameraFavorit } from '@/components/kamerascan/KameraFavorit';

/**
 * Rahmen der mobilen Darstellung: Kopfleiste, Vollbild-Menü, Favoritenleiste.
 * Inhalte (Ziele, Branding, Statusleisten) kommen aus denselben Quellen wie
 * die Desktop-Sidebar – hier wird nur angeordnet.
 */

/**
 * Kopfleiste. Hochformat zweizeilig (Burger · Marke · Aktionen / Titel · Leiste),
 * Querformat einzeilig – dieselben Knoten, nur per CSS umgeordnet, damit die
 * Portal-Ziele der Seiten beim Drehen erhalten bleiben.
 */
export function MobilKopfleiste({ onMenue }) {
  const location = useLocation();
  const slots = useSeiteSlots();
  const { instanceName } = useNavigation();
  const { activeTasks } = useTaskStore();
  const titel = slots?.titel || titelFuerPfad(location.pathname);

  // Höhe als CSS-Variable --mobil-kopf: Vollflächen unter der Leiste (Dokument-
  // ansicht, Sheets) richten sich danach, auch nach dem Drehen.
  const kopfRef = useRef(null);
  useLayoutEffect(() => {
    const el = kopfRef.current;
    if (!el) return;
    const setzen = () => document.documentElement.style.setProperty('--mobil-kopf', `${el.getBoundingClientRect().height}px`);
    setzen();
    const ro = new ResizeObserver(setzen);
    ro.observe(el);
    return () => { ro.disconnect(); document.documentElement.style.removeProperty('--mobil-kopf'); };
  }, []);

  return (
    <header ref={kopfRef} className="relative z-30 shrink-0 pt-safe bg-background/90 backdrop-blur-md border-b border-border/60 shadow-sm shadow-primary/5">
      <div className="flex flex-wrap items-center gap-x-1.5 px-safe">
        <button
          type="button" onClick={onMenue} aria-label="Menü öffnen"
          className="relative -ml-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-foreground active:bg-primary/10"
        >
          <Menu className="h-6 w-6" />
          {activeTasks.length > 0 && (
            <span className="absolute right-2 top-2 h-2 w-2 rounded-full bg-blue-500 animate-pulse" aria-label="Vorgänge laufen" />
          )}
        </button>
        <Link to="/" className="flex h-14 min-w-0 shrink items-center" aria-label="Zum Dashboard">
          <MarkeVoll instanceName={instanceName} instanzBreite={150} />
        </Link>
        <div className="order-last flex min-h-11 min-w-0 basis-full items-center gap-2 border-t border-border/40 quer:order-none quer:basis-0 quer:flex-1 quer:border-0 quer:pl-3">
          {!slots?.ohneTitel && (
            <h1 className="min-w-0 flex-1 py-1 text-[18px] leading-tight">
              <GlowText kuerzen blur={4} style={{ fontSize: 'inherit', lineHeight: 'inherit', letterSpacing: 'normal' }}>{titel}</GlowText>
            </h1>
          )}
          <div ref={slots?.setLeisteKnoten} className={`flex items-center gap-1 empty:hidden ${slots?.ohneTitel ? 'min-w-0 flex-1' : 'shrink-0'}`} />
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-0.5 quer:ml-0">
          <KopfUndo />
          <div ref={slots?.setAktionenKnoten} className="flex items-center gap-0.5 empty:hidden" />
        </div>
      </div>
    </header>
  );
}

/** Rückgängig/Wiederholen in der Kopfleiste, solange es etwas dazu gibt. */
function KopfUndo() {
  const { istEingeschraenkt } = useAuth();
  const { past, future, undoLast, redoLast } = useUndoHistory();
  const [laeuft, setLaeuft] = useState(false);
  if (istEingeschraenkt || (past.length === 0 && future.length === 0)) return null;
  const ausfuehren = async (fn) => {
    if (laeuft) return;
    setLaeuft(true);
    try { await fn(); } finally { setLaeuft(false); }
  };
  const knopf = 'flex h-10 w-10 items-center justify-center rounded-xl text-muted-foreground active:bg-primary/10 disabled:opacity-30';
  return (
    <>
      <button
        type="button" className={knopf} disabled={laeuft || past.length === 0}
        onClick={() => ausfuehren(undoLast)}
        aria-label={past.length ? `Rückgängig: ${past[past.length - 1].description}` : 'Rückgängig'}
      >
        <RotateCcw className="h-5 w-5" />
      </button>
      {future.length > 0 && (
        <button
          type="button" className={knopf} disabled={laeuft}
          onClick={() => ausfuehren(redoLast)}
          aria-label={`Wiederholen: ${future[future.length - 1].description}`}
        >
          <RotateCw className="h-5 w-5" />
        </button>
      )}
    </>
  );
}

const eintragKlasse = (aktiv) =>
  `flex items-center gap-3.5 h-12 px-3.5 rounded-xl text-[15px] font-medium transition-colors ${
    aktiv ? 'bg-primary/10 text-primary' : 'text-foreground active:bg-primary/5'
  }`;

/** Vollbild-Menü mit allen Zielen; scrollt, Fußbereich bleibt stehen. */
export function MobilMenue({ offen, onSchliessen }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { logout } = useAuth();
  const { haupt, gruppen, fuss, instanceName, updateVerfuegbar, istEingeschraenkt } = useNavigation();
  const { activeTasks, recentTasks } = useTaskStore();
  const { past, future } = useUndoHistory();
  const zeigeStatus = !istEingeschraenkt && (activeTasks.length + recentTasks.length + past.length + future.length > 0);

  useZurueckSchliesst(offen, onSchliessen);

  // Hintergrund nicht mitscrollen lassen
  useEffect(() => {
    if (!offen) return;
    const vorher = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const esc = (e) => { if (e.key === 'Escape') onSchliessen(); };
    window.addEventListener('keydown', esc);
    return () => { document.body.style.overflow = vorher; window.removeEventListener('keydown', esc); };
  }, [offen, onSchliessen]);

  const abmelden = async () => {
    onSchliessen();
    await logout();
    navigate('/login');
  };

  const eintrag = ({ to, icon: Icon, label }) => (
    <NavLink key={to} to={to} onClick={onSchliessen} className={eintragKlasse(istAktiv(to, location.pathname))}>
      <Icon className="h-5 w-5 shrink-0" />
      <span className="truncate">{label}</span>
    </NavLink>
  );

  return (
    <div
      role="dialog" aria-modal="true" aria-label="Navigation" aria-hidden={!offen}
      className={`fixed inset-0 z-50 flex flex-col bg-background pt-safe pb-safe transition-opacity duration-200 ${
        offen ? 'opacity-100' : 'pointer-events-none opacity-0'
      }`}
      inert={offen ? undefined : true}
    >
      <div className="box-content flex h-14 shrink-0 items-center gap-x-1.5 px-safe border-b border-border/60">
        <button
          type="button" onClick={onSchliessen} aria-label="Menü schließen"
          className="-ml-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-xl active:bg-primary/10"
        >
          <X className="h-6 w-6" />
        </button>
        <MarkeVoll instanceName={instanceName} instanzBreite={200} />
      </div>

      <nav className="flex-1 overflow-y-auto overscroll-contain px-safe py-3">
        {zeigeStatus && (
          <div className="mb-3 space-y-1 rounded-2xl border border-border/60 bg-card p-2 shadow-sm">
            <UndoRedoBar />
            <TaskStatusBar />
          </div>
        )}
        <div className="grid gap-0.5 quer:grid-cols-2">{haupt.map(eintrag)}</div>
        {gruppen.map(({ titel, items }) => (
          <section key={titel} className="mt-4">
            <h2 className="px-3.5 pb-1.5 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">{titel}</h2>
            <div className="grid gap-0.5 quer:grid-cols-2">{items.map(eintrag)}</div>
          </section>
        ))}
      </nav>

      <div className="grid shrink-0 grid-cols-3 gap-1 border-t border-border/60 px-safe py-2">
        {fuss.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to} to={to} onClick={onSchliessen}
            className={`flex flex-col items-center justify-center gap-1 rounded-xl py-2 text-xs font-medium ${
              istAktiv(to, location.pathname) ? 'bg-primary/10 text-primary' : 'text-muted-foreground active:bg-primary/5'
            }`}
          >
            <span className="relative">
              <Icon className="h-5 w-5" />
              {to === '/einstellungen' && updateVerfuegbar && (
                <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-primary" title="Update verfügbar" />
              )}
            </span>
            {label}
          </NavLink>
        ))}
        <button
          type="button" onClick={abmelden}
          className="flex flex-col items-center justify-center gap-1 rounded-xl py-2 text-xs font-medium text-muted-foreground active:bg-destructive/5 active:text-destructive"
        >
          <LogOut className="h-5 w-5" />
          Abmelden
        </button>
      </div>
    </div>
  );
}

/** Ist die Bildschirmtastatur offen? (visualViewport deutlich kleiner als das Layout) */
function useTastaturOffen() {
  const [offen, setOffen] = useState(false);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const pruefen = () => setOffen(window.innerHeight - vv.height > 150);
    vv.addEventListener('resize', pruefen);
    return () => vv.removeEventListener('resize', pruefen);
  }, []);
  return offen;
}

/**
 * Feste Leiste mit den wichtigsten Zielen am unteren Rand. In der Mitte sitzt,
 * wo die Kamera verfügbar ist und das Konto schreiben darf, der hervorgehobene
 * Kamerascan.
 */
export function FavoritenLeiste({ sichtbar }) {
  const location = useLocation();
  const { favoriten } = useNavigation();
  const tastatur = useTastaturOffen();
  const kamera = useKameraFavorit();
  const zeigen = sichtbar && !tastatur && favoriten.length >= 2;

  const ziele = favoriten.map(({ to, icon: Icon, label }) => {
    const aktiv = istAktiv(to, location.pathname);
    return (
      <NavLink
        key={to} to={to}
        className={`flex h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium ${
          aktiv ? 'text-primary' : 'text-muted-foreground'
        }`}
      >
        <span className={`flex h-7 w-12 items-center justify-center rounded-full transition-colors ${aktiv ? 'bg-primary/12' : ''}`}>
          <Icon className="h-5 w-5" />
        </span>
        {label}
      </NavLink>
    );
  });
  if (kamera.knopf) ziele.splice(Math.ceil(ziele.length / 2), 0, <div key="kamera" className="contents">{kamera.knopf}</div>);

  return (
    <>
      {zeigen && (
        <nav
          aria-label="Favoriten"
          className="relative z-30 shrink-0 border-t border-border/60 bg-background/95 backdrop-blur-md pb-safe"
        >
          <div className="mx-auto flex max-w-xl px-safe">
            {ziele}
          </div>
        </nav>
      )}
      {kamera.overlay}
    </>
  );
}
