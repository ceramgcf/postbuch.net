/**
 * Navigationsziele der App – eine Definition für Sidebar (Desktop),
 * Burgermenü und Favoritenleiste (mobil). Neue Seiten werden nur hier
 * eingetragen; Filterregeln (Rolle, Sichtbarkeit) ebenfalls nur hier.
 */
import {
  LayoutDashboard, FileText, AlertCircle, Scissors,
  CalendarRange, Search, Wrench,
  FolderOpen, ScrollText, Scale, CalendarClock, Settings,
  Upload, MessageCircle, BookOpen, HeartPulse,
} from 'lucide-react';

export const NAV_HAUPT = [
  { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/import', icon: Upload, label: 'Importieren' },
  { to: '/postbuch', icon: FileText, label: 'Dokumente' },
  { to: '/akten', icon: FolderOpen, label: 'Akten' },
  { to: '/search', icon: Search, label: 'Suche' },
  { to: '/assistent', icon: MessageCircle, label: 'Assistent' },
];
// Logs: per nav_visibility abschaltbar (Admins sehen sie immer)
export const NAV_LOGS = { to: '/logs', icon: ScrollText, label: 'Logs' };

export const NAV_KRANKENVERSICHERUNG = [
  { to: '/analyse/kuerzungen', icon: Scissors, label: 'Kürzungen' },
  { to: '/analyse/perioden', icon: CalendarRange, label: 'Abrechnungsperioden' },
];
export const NAV_ANALYSE = [
  { to: '/analyse/unbezahlt', icon: AlertCircle, label: 'Unbezahlt' },
  { to: '/analyse/handwerker', icon: Wrench, label: 'Handwerker' },
  { to: '/analyse/gesundheitskosten', icon: HeartPulse, label: 'Gesundheitskosten' },
  { to: '/analyse/wiedervorlagen', icon: CalendarClock, label: 'Kalender' },
];
export const NAV_SALDEN = { to: '/analyse/salden', icon: Scale, label: 'Salden' };

export const NAV_HILFE = { to: '/hilfe', icon: BookOpen, label: 'Hilfe' };
export const NAV_EINSTELLUNGEN = { to: '/einstellungen', icon: Settings, label: 'Einstellungen' };

// Ziele der mobilen Favoritenleiste, in dieser Reihenfolge – sofern erlaubt.
const FAVORITEN = ['/', '/postbuch', '/search', '/analyse/wiedervorlagen'];

/**
 * Sichtbare Navigation für das aktuelle Konto.
 * @returns {{ haupt, gruppen: {titel, items}[], fuss, favoriten }}
 */
export function bildeNavigation({ isAdmin = false, istEingeschraenkt = false, navVis = {}, hasInsuredPerson = false } = {}) {
  // Nur eigene Dokumente: Dokumente und Suche – der Server sperrt den Rest ohnehin.
  if (istEingeschraenkt) {
    const haupt = NAV_HAUPT.filter(({ to }) => to === '/postbuch' || to === '/search');
    return { haupt, gruppen: [], fuss: [NAV_HILFE, NAV_EINSTELLUNGEN], favoriten: haupt };
  }
  const showLogs = isAdmin || navVis.logs !== false;
  const showSalden = isAdmin || navVis.salden !== false;
  const haupt = [...NAV_HAUPT, ...(showLogs ? [NAV_LOGS] : [])];
  const gruppen = [
    ...(hasInsuredPerson ? [{ titel: 'Krankenversicherung', items: NAV_KRANKENVERSICHERUNG }] : []),
    { titel: 'Analyse', items: [...NAV_ANALYSE, ...(showSalden ? [NAV_SALDEN] : [])] },
  ];
  const alle = [...haupt, ...gruppen.flatMap(g => g.items)];
  const favoriten = FAVORITEN.map(to => alle.find(i => i.to === to)).filter(Boolean);
  return { haupt, gruppen, fuss: [NAV_HILFE, NAV_EINSTELLUNGEN], favoriten };
}

const ALLE_ZIELE = [
  ...NAV_HAUPT, NAV_LOGS, ...NAV_KRANKENVERSICHERUNG, ...NAV_ANALYSE, NAV_SALDEN, NAV_HILFE, NAV_EINSTELLUNGEN,
];

// Unterseiten ohne eigenen Navigationseintrag
const UNTERSEITEN = [
  [/^\/postbuch\/[^/]+/, 'Dokument'],
  [/^\/akten\/(elektronisch|originale)$/, 'Akten'],
  [/^\/akten\/[^/]+/, 'Akte'],
  [/^\/analyse\/salden\/[^/]+/, 'Saldo'],
  [/^\/hilfe\/[^/]+/, 'Hilfe'],
  [/^\/importwege/, 'Importwege'],
];

/** Fallback-Titel der mobilen Kopfleiste, wenn eine Seite keinen eigenen setzt. */
export function titelFuerPfad(pathname) {
  for (const [muster, titel] of UNTERSEITEN) if (muster.test(pathname)) return titel;
  const treffer = ALLE_ZIELE
    .filter(({ to }) => (to === '/' ? pathname === '/' : pathname === to || pathname.startsWith(to + '/')))
    .sort((a, b) => b.to.length - a.to.length)[0];
  return treffer?.label ?? '';
}

/** Aktiv-Logik wie NavLink (end nur für '/'). */
export function istAktiv(to, pathname) {
  return to === '/' ? pathname === '/' : pathname === to || pathname.startsWith(to + '/');
}
