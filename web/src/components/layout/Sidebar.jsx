import { useState, useEffect, useRef } from 'react';
import { NavLink, useNavigate } from 'react-router';
import { useAuth } from '@/hooks/useAuth';
import { useDarstellung } from '@/hooks/useDarstellung';
import { useNavigation } from '@/hooks/useNavigation';
import { LogOut, Pin, PinOff } from 'lucide-react';
import { MarkeVoll, LogoBild } from './Marke';
import { TaskStatusBar } from './TaskStatusBar';
import { UndoRedoBar } from '@/components/ui/UndoRedoBar';

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

// Fixed header height – must be identical in both modes to avoid layout shift
const HEADER_H = 72;

function SidebarInner({ isExpanded, isPinned, onTogglePin, onNavClick, onLogout }) {
  const { istEingeschraenkt } = useAuth();
  const itemBase = 'flex items-center h-9 rounded-lg text-sm font-medium transition-all duration-150';
  const itemExpanded = 'gap-3 px-3';
  const itemCollapsed = 'justify-center w-full';
  const itemActive = 'bg-primary/10 text-primary shadow-sm shadow-primary/5';
  const itemInactive = 'text-sidebar-foreground hover:bg-primary/5 hover:text-primary';

  const cls = (isActive) =>
    `${itemBase} ${isExpanded ? itemExpanded : itemCollapsed} ${isActive ? itemActive : itemInactive}`;

  const { haupt: navItems, gruppen, fuss, instanceName, updateVerfuegbar } = useNavigation();
  const [navHilfe, navEinstellungen] = fuss;

  return (
    <div className="flex flex-col h-full overflow-hidden">

      {/* Header: fixed height so nav items never shift position on expand/collapse */}
      <div
        className={`flex items-center flex-shrink-0 ${isExpanded ? 'px-4 justify-between' : 'px-2 justify-center'}`}
        style={{ height: HEADER_H }}
      >
        {isExpanded ? <MarkeVoll instanceName={instanceName} /> : <LogoBild size={36} />}
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

      <div className="mx-3 h-px bg-linear-to-r from-primary/20 via-primary/10 to-transparent flex-shrink-0" />

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

        {gruppen.map(({ titel, items }) => (
          <div key={titel} className="space-y-0.5">
            {/* Abschnittstrenner mit fester Höhe, damit nichts springt */}
            <div className="h-10 flex items-center" style={{ paddingLeft: isExpanded ? '0.75rem' : 0, justifyContent: isExpanded ? 'flex-start' : 'center' }}>
              {isExpanded ? (
                <span className="text-[11px] font-semibold uppercase text-muted-foreground tracking-widest">
                  {titel}
                </span>
              ) : (
                <div className="h-px w-6 bg-border/60" />
              )}
            </div>
            {items.map(({ to, icon: Icon, label }) => (
              <NavLink key={to} to={to} onClick={onNavClick}
                className={({ isActive }) => cls(isActive)}
              >
                <Icon className="h-4 w-4 flex-shrink-0" />
                {isExpanded && <span className="truncate">{label}</span>}
              </NavLink>
            ))}
          </div>
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
      <div className="mx-3 mt-1 h-px bg-linear-to-r from-primary/20 via-primary/10 to-transparent flex-shrink-0" />

      {/* Fußbereich: Hilfe, Einstellungen und Abmelden teilen sich einen
          gemeinsamen Block AUSSERHALB des scrollbaren <nav>. Dadurch stehen
          die drei in ein- wie ausgeklapptem Zustand pixelgenau an derselben
          Stelle und werden nie vom Overflow des Nav-Bereichs abgeschnitten.
          Bewusst ohne Abschnittslabel und ohne Trenner untereinander – nur
          Ausrichtung und horizontales Padding wechseln, nie die Höhe. */}
      <div className={`flex-shrink-0 space-y-0.5 pt-1 pb-2 ${isExpanded ? 'px-2' : 'px-1'}`}>
        <NavLink to={navHilfe.to} onClick={onNavClick}
          title={isExpanded ? undefined : navHilfe.label}
          className={({ isActive }) => cls(isActive)}
        >
          <navHilfe.icon className="h-4 w-4 flex-shrink-0" />
          {isExpanded && <span className="truncate">{navHilfe.label}</span>}
        </NavLink>

        <NavLink to={navEinstellungen.to} onClick={onNavClick}
          title={isExpanded ? undefined : navEinstellungen.label}
          className={({ isActive }) => cls(isActive)}
        >
          <span className="relative flex-shrink-0">
            <navEinstellungen.icon className="h-4 w-4" />
            {updateVerfuegbar && (
              <span
                className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-primary"
                title="Update verfügbar"
              />
            )}
          </span>
          {isExpanded && <span className="truncate">{navEinstellungen.label}</span>}
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
  // Touch: kein Hover, Ausklappen per Tipp.
  const { istTouch } = useDarstellung();
  const isPinned = pinGewuenscht;
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
    onTogglePin: handleTogglePin,
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
        onMouseEnter={() => !istTouch && setIsHovered(true)}
        onMouseLeave={() => !istTouch && setIsHovered(false)}
        // Mobile: Tipp auf die eingeklappte Leiste → 3 Sekunden ausgeklappt
        onClickCapture={(e) => {
          if (istTouch && !isExpanded) {
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
