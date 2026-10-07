import { useState, useEffect, useRef } from 'react';
import { NavLink, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/hooks/useAuth';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useIsPortrait } from '@/hooks/useOrientationLock';
import { api } from '@/api/client';
import {
  LayoutDashboard, FileText, AlertCircle, Scissors,
  CalendarRange, LogOut, Search, Wrench, Pin, PinOff,
  FolderOpen, ScrollText, Scale, Users, CalendarClock, Settings,
  Upload, MessageCircle, BookOpen, HeartPulse,
} from 'lucide-react';
import { TaskStatusBar } from './TaskStatusBar';
import { UndoRedoBar } from '@/components/ui/UndoRedoBar';

const NAV_ITEMS_BASE = [
  { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/import', icon: Upload, label: 'Importieren' },
  { to: '/postbuch', icon: FileText, label: 'Dokumente' },
  { to: '/akten', icon: FolderOpen, label: 'Akten' },
  { to: '/search', icon: Search, label: 'Suche' },
  { to: '/assistent', icon: MessageCircle, label: 'Assistent' },
];
// Logs is conditionally shown based on nav_visibility setting (always shown to admins)
const NAV_ITEM_LOGS = { to: '/logs', icon: ScrollText, label: 'Logs' };

const KRANKENVERSICHERUNG_ITEMS = [
  { to: '/analyse/kuerzungen', icon: Scissors, label: 'Kürzungen' },
  { to: '/analyse/perioden', icon: CalendarRange, label: 'Abrechnungsperioden' },
];
const ANALYSE_ITEMS_BASE = [
  { to: '/analyse/unbezahlt', icon: AlertCircle, label: 'Unbezahlt' },
  { to: '/analyse/handwerker', icon: Wrench, label: 'Handwerker' },
  { to: '/analyse/gesundheitskosten', icon: HeartPulse, label: 'Gesundheitskosten' },
  { to: '/analyse/wiedervorlagen', icon: CalendarClock, label: 'Kalender' },
];
const ANALYSE_ITEM_SALDEN = { to: '/analyse/salden', icon: Scale, label: 'Salden' };

function usePersistedBool(key, defaultVal) {
  const [val, setVal] = useState(() => {
    try {
      const s = localStorage.getItem(key);
      return s !== null ? s === 'true' : defaultVal;
    } catch {
      return defaultVal;
    }
  });
  useEffect(() => {
    try { localStorage.setItem(key, String(val)); } catch {}
  }, [key, val]);
  return [val, setVal];
}

/**
 * Gradient text with proper omnidirectional glow.
 * The blurred layer uses a solid colour (not background-clip:text) so the
 * gaussian blur spreads freely in all directions instead of being clipped to
 * the text outline.
 */
function GlowText({ children, fontSize }) {
  return (
    <span
      className="relative inline-block"
      style={{ fontSize, fontWeight: 700, letterSpacing: '-0.02em', lineHeight: 1.25 }}
    >
      {/* Blur layer – same gradient so teal spreads right-ward correctly */}
      <span
        aria-hidden
        style={{
          position: 'absolute', top: 0, left: 0,
          background: 'linear-gradient(90deg, #7d2dbd 0%, #a56bd8 50%, #2cc5dd 100%)',
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
          backgroundClip: 'text',
          filter: 'blur(6px)',
          opacity: 0.85,
          whiteSpace: 'nowrap',
          pointerEvents: 'none',
          userSelect: 'none',
        }}
      >
        {children}
      </span>
      {/* Sharp gradient text on top */}
      <span
        style={{
          position: 'relative',
          background: 'linear-gradient(90deg, #7d2dbd 0%, #a56bd8 50%, #2cc5dd 100%)',
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
          backgroundClip: 'text',
          whiteSpace: 'nowrap',
        }}
      >
        {children}
      </span>
    </span>
  );
}

// Logo size when expanded: 53 * 0.95 ≈ 50px
const LOGO_FULL_SIZE = 50;
// Icon size when collapsed: fixed to the same icon area so buttons don't jump
const LOGO_ICON_SIZE = 36;
// Fixed header height – must be identical in both modes to avoid layout shift
const HEADER_H = 72;

function SidebarLogoFull({ instanceName }) {
  const size = LOGO_FULL_SIZE;
  return (
    <div className="flex items-center gap-2.5 min-w-0">
      <div className="relative flex-shrink-0" style={{ width: size, height: size }}>
        <img src="/logo.svg" alt="" aria-hidden width={size} height={size}
          className="absolute inset-0" style={{ filter: 'blur(10px)', opacity: 0.55 }} />
        <img src="/logo.svg" alt="postbuch.net" width={size} height={size} className="relative" />
      </div>
      <div className="min-w-0">
        <GlowText fontSize={22}>
          postbuch<span style={{ fontSize: '1.8em', lineHeight: 1 }}>.</span><span style={{ fontSize: '0.47em', lineHeight: 1 }}>net</span>
        </GlowText>
        {instanceName && (
          <p className="text-[10px] text-muted-foreground/70 truncate mt-0.5 max-w-[120px]" title={instanceName}>{instanceName}</p>
        )}
      </div>
    </div>
  );
}

function SidebarLogoIcon() {
  const size = LOGO_ICON_SIZE;
  return (
    <div className="relative flex-shrink-0" style={{ width: size, height: size }}>
      <img src="/logo.svg" alt="" aria-hidden width={size} height={size}
        className="absolute inset-0" style={{ filter: 'blur(8px)', opacity: 0.55 }} />
      <img src="/logo.svg" alt="postbuch.net" width={size} height={size} className="relative" />
    </div>
  );
}


function SidebarInner({ isExpanded, isPinned, onTogglePin, onNavClick, onLogout }) {
  const { isAdmin, istEingeschraenkt } = useAuth();
  const itemBase = 'flex items-center h-9 rounded-lg text-sm font-medium transition-all duration-150';
  const itemExpanded = 'gap-3 px-3';
  const itemCollapsed = 'justify-center w-full';
  const itemActive = 'bg-primary/10 text-primary shadow-sm shadow-primary/5';
  const itemInactive = 'text-sidebar-foreground hover:bg-primary/5 hover:text-primary';

  const cls = (isActive) =>
    `${itemBase} ${isExpanded ? itemExpanded : itemCollapsed} ${isActive ? itemActive : itemInactive}`;

  const { data: personenData } = useQuery({
    queryKey: ['personen'],
    queryFn: () => api.personen.list(),
    staleTime: 5 * 60 * 1000,
  });
  const hasInsuredPerson = (personenData?.data ?? []).some((p) => p.pkv || p.beihilfe);

  // Nav visibility settings (only relevant for non-admins; admins always see everything)
  const { data: appSettings } = useQuery({
    queryKey: ['settings-public'],
    queryFn: () => api.settingsPublic.getAll(),
    staleTime: 5 * 60 * 1000,
  });
  const navVis = appSettings?.nav_visibility?.value || {};
  const showSalden = isAdmin || navVis.salden !== false;

  // Dezenter Punkt am Einstellungen-Eintrag, wenn ein Update bereitliegt.
  // Nur für Admins: /api/updates ist admin-only, und nur ein Admin kann das
  // Update überhaupt auslösen – ein Punkt, dem niemand folgen kann, ist Lärm.
  const { data: updateInfo } = useQuery({
    queryKey: ['updates'],
    queryFn: () => api.updates.get(),
    enabled: isAdmin,
    staleTime: 30 * 60 * 1000,
    retry: false,
  });
  const updateVerfuegbar = isAdmin && updateInfo?.updateVerfuegbar === true;
  const showLogs   = isAdmin || navVis.logs   !== false;

  // Nur eigene Dokumente: Dokumente und Suche, keine Analyse- oder
  // Verwaltungsbereiche – der Server sperrt sie für dieses Konto ohnehin.
  const navItems = istEingeschraenkt
    ? NAV_ITEMS_BASE.filter(({ to }) => to === '/postbuch' || to === '/search')
    : [
      ...NAV_ITEMS_BASE,
      ...(showLogs ? [NAV_ITEM_LOGS] : []),
    ];

  const analyseItems = istEingeschraenkt ? [] : [
    ...ANALYSE_ITEMS_BASE,
    ...(showSalden ? [ANALYSE_ITEM_SALDEN] : []),
  ];

  return (
    <div className="flex flex-col h-full overflow-hidden">

      {/* Header: fixed height so nav items never shift position on expand/collapse */}
      <div
        className={`flex items-center flex-shrink-0 ${isExpanded ? 'px-4 justify-between' : 'px-2 justify-center'}`}
        style={{ height: HEADER_H }}
      >
        {isExpanded ? <SidebarLogoFull instanceName={appSettings?.instance_name?.value} /> : <SidebarLogoIcon />}
        {isExpanded && onTogglePin && (
          <button
            onClick={onTogglePin}
            title={isPinned ? 'Sidebar lösen' : 'Sidebar anheften'}
            className="p-1.5 ml-2 flex-shrink-0 rounded-md text-muted-foreground hover:text-primary hover:bg-primary/5 transition-colors"
          >
            {isPinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
          </button>
        )}
      </div>

      <div className="mx-3 h-px bg-gradient-to-r from-primary/20 via-primary/10 to-transparent flex-shrink-0" />

      {/* Eingeklappt ohne sichtbare Scrollbar: die 6px-Scrollbar aus index.css
          verschmälert sonst den Inhaltsbereich des <nav> und schiebt die Icons
          in der 56px-Leiste um 3px aus der Mitte – sichtbar als Versatz gegen
          Hilfe, Zahnrad und Abmelden, die außerhalb des Scrollbereichs liegen.
          Gescrollt wird weiter per Rad/Wischen; ausgeklappt bleibt die
          Scrollbar sichtbar. */}
      <nav className={`flex-1 pt-3 space-y-0.5 overflow-y-auto overflow-x-hidden ${isExpanded ? 'px-2' : 'px-1 scrollbar-none'}`}>
        {navItems.map(({ to, icon: Icon, label }) => (
          <NavLink key={to} to={to} end={to === '/'} onClick={onNavClick}
            className={({ isActive }) => cls(isActive)}
          >
            <Icon className="h-4 w-4 flex-shrink-0" />
            {isExpanded && <span className="truncate">{label}</span>}
          </NavLink>
        ))}

        {hasInsuredPerson && !istEingeschraenkt && <>
          {/* Krankenversicherung is a peer navigation section to Analyse. */}
          <div className="h-10 flex items-center" style={{ paddingLeft: isExpanded ? '0.75rem' : 0, justifyContent: isExpanded ? 'flex-start' : 'center' }}>
            {isExpanded ? (
              <span className="text-[11px] font-semibold uppercase text-muted-foreground tracking-widest">
                Krankenversicherung
              </span>
            ) : (
              <div className="h-px w-6 bg-border/60" />
            )}
          </div>

          {KRANKENVERSICHERUNG_ITEMS.map(({ to, icon: Icon, label }) => (
            <NavLink key={to} to={to} onClick={onNavClick}
              className={({ isActive }) => cls(isActive)}
            >
              <Icon className="h-4 w-4 flex-shrink-0" />
              {isExpanded && <span className="truncate">{label}</span>}
            </NavLink>
          ))}
        </>}

        {/* Analyse section divider – fixed height so items below never jump */}
        {analyseItems.length > 0 && <div className="h-10 flex items-center" style={{ paddingLeft: isExpanded ? '0.75rem' : 0, justifyContent: isExpanded ? 'flex-start' : 'center' }}>
          {isExpanded ? (
            <span className="text-[11px] font-semibold uppercase text-muted-foreground tracking-widest">
              Analyse
            </span>
          ) : (
            <div className="h-px w-6 bg-border/60" />
          )}
        </div>}

        {analyseItems.map(({ to, icon: Icon, label }) => (
          <NavLink key={to} to={to} onClick={onNavClick}
            className={({ isActive }) => cls(isActive)}
          >
            <Icon className="h-4 w-4 flex-shrink-0" />
            {isExpanded && <span className="truncate">{label}</span>}
          </NavLink>
        ))}

      </nav>

      {/* Statusleisten gehören noch zum oberen, wechselnden Teil der Leiste:
          sie zeigen laufende Vorgänge, keine Ziele zum Hinklicken. */}
      {!istEingeschraenkt && <>
        <div className={`flex-shrink-0 py-1 ${isExpanded ? 'px-3' : 'px-1 flex justify-center'}`}>
          <UndoRedoBar compact={!isExpanded} />
        </div>

        <div className={`flex-shrink-0 py-1 ${isExpanded ? 'px-3' : 'px-1 flex justify-center'}`}>
          <TaskStatusBar compact={!isExpanded} />
        </div>
      </>}

      {/* Genau ein Strich trennt den festen Fußbereich vom Rest der Leiste. */}
      <div className="mx-3 mt-1 h-px bg-gradient-to-r from-primary/20 via-primary/10 to-transparent flex-shrink-0" />

      {/* Fußbereich: Hilfe, Einstellungen und Abmelden teilen sich einen
          gemeinsamen Block AUSSERHALB des scrollbaren <nav>. Dadurch stehen
          die drei in ein- wie ausgeklapptem Zustand pixelgenau an derselben
          Stelle und werden nie vom Overflow des Nav-Bereichs abgeschnitten.
          Bewusst ohne Abschnittslabel und ohne Trenner untereinander – nur
          Ausrichtung und horizontales Padding wechseln, nie die Höhe. */}
      <div className={`flex-shrink-0 space-y-0.5 pt-1 pb-2 ${isExpanded ? 'px-2' : 'px-1'}`}>
        <NavLink to="/hilfe" onClick={onNavClick}
          title={isExpanded ? undefined : 'Hilfe'}
          className={({ isActive }) => cls(isActive)}
        >
          <BookOpen className="h-4 w-4 flex-shrink-0" />
          {isExpanded && <span className="truncate">Hilfe</span>}
        </NavLink>

        <NavLink to="/einstellungen" onClick={onNavClick}
          title={isExpanded ? undefined : 'Einstellungen'}
          className={({ isActive }) => cls(isActive)}
        >
          <span className="relative flex-shrink-0">
            <Settings className="h-4 w-4" />
            {updateVerfuegbar && (
              <span
                className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-primary"
                title="Update verfügbar"
              />
            )}
          </span>
          {isExpanded && <span className="truncate">Einstellungen</span>}
        </NavLink>

        {/* Abmelden bewusst als schlichter Button in derselben Item-Geometrie
            wie die beiden Links darüber – nur die Hover-Farbe warnt. */}
        <button
          type="button" onClick={onLogout}
          title={isExpanded ? undefined : 'Abmelden'}
          className={`${itemBase} ${isExpanded ? itemExpanded : itemCollapsed} text-muted-foreground hover:bg-destructive/5 hover:text-destructive`}
        >
          <LogOut className="h-4 w-4 flex-shrink-0" />
          {isExpanded && <span className="truncate">Abmelden</span>}
        </button>
      </div>
    </div>
  );
}

export function Sidebar() {
  const [pinGewuenscht, setIsPinned] = usePersistedBool('sidebar-pinned', true);
  const [isHovered, setIsHovered] = useState(false);
  // Mobile: temporäres Ausklappen für 3 Sekunden per Tipp auf die eingeklappte Leiste
  const [tempExpanded, setTempExpanded] = useState(false);
  const tempTimerRef = useRef(null);
  const isMobile = useIsMobile();
  const isPortrait = useIsPortrait();
  // Hochformat auf dem Handy (Detailseite): eine angeheftete 256-px-Leiste
  // ließe dem Inhalt kaum Platz. Dort immer die schmale Leiste zeigen; die
  // gespeicherte Wahl gilt wieder, sobald das Gerät quer liegt.
  const pinErzwungenAus = isMobile && isPortrait;
  const isPinned = pinGewuenscht && !pinErzwungenAus;
  const { logout } = useAuth();
  const navigate = useNavigate();

  const isExpanded = isPinned || isHovered || tempExpanded;

  // Timer aufräumen beim Unmount
  useEffect(() => () => { if (tempTimerRef.current) clearTimeout(tempTimerRef.current); }, []);

  function handleTouchExpand() {
    setTempExpanded(true);
    if (tempTimerRef.current) clearTimeout(tempTimerRef.current);
    tempTimerRef.current = setTimeout(() => setTempExpanded(false), 3000);
  }

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  const handleNavClick = () => {
    if (!isPinned) {
      setIsHovered(false);
      setTempExpanded(false);
      if (tempTimerRef.current) clearTimeout(tempTimerRef.current);
    }
  };

  const handleTogglePin = () => {
    const next = !isPinned;
    setIsPinned(next);
    // When unpinning, immediately collapse
    if (!next) { setIsHovered(false); setTempExpanded(false); }
  };

  const innerProps = {
    isExpanded,
    isPinned,
    onTogglePin: pinErzwungenAus ? undefined : handleTogglePin,
    onNavClick: handleNavClick,
    onLogout: handleLogout,
  };

  // ── Pinned: normal flex child ──────────────────────────────────────────────
  if (isPinned) {
    return (
      <aside className="flex-shrink-0 w-64 border-r border-border/60 bg-sidebar h-full">
        <SidebarInner {...innerProps} />
      </aside>
    );
  }

  // ── Unpinned: thin flex spacer + fixed overlay sidebar ─────────────────────
  return (
    <>
      {/* Spacer holds the collapsed width so page content doesn't shift */}
      <div className="flex-shrink-0 w-14" aria-hidden />

      {/* Fixed sidebar – width animates on hover (desktop) or tap (mobile) */}
      <aside
        className={`fixed left-0 top-0 h-screen border-r border-border/60 bg-sidebar z-40
          transition-[width] duration-200 ease-in-out overflow-hidden
          ${isExpanded ? 'w-64 shadow-2xl shadow-primary/10' : 'w-14'}
        `}
        onMouseEnter={() => !isMobile && setIsHovered(true)}
        onMouseLeave={() => !isMobile && setIsHovered(false)}
        // Mobile: Tipp auf die eingeklappte Leiste → 3 Sekunden ausgeklappt
        onClickCapture={(e) => {
          if (isMobile && !isExpanded) {
            e.preventDefault();
            e.stopPropagation();
            handleTouchExpand();
          }
        }}
      >
        <SidebarInner {...innerProps} />
      </aside>
    </>
  );
}
