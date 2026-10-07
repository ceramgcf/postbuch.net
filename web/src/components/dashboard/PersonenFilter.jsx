/**
 * PersonenFilter.jsx – Personenauswahl ganz oben auf dem Dashboard
 *
 * Mehrfachauswahl aller nicht archivierten Personen plus „ohne Zuordnung“.
 * Die Auswahl wirkt nur auf das Dashboard und wird je Browser und Benutzer in
 * localStorage gemerkt. Keine Auswahl heißt: alle anzeigen.
 *
 * Sichtbar nur für Zugänge, die alle Dokumente sehen (admin, vollzugriff,
 * lesezugriff mit Lesebereich „alle“), und erst ab zwei Personen.
 */
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { User } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { api } from '@/api/client';
import { cn } from '@/lib/utils';

/** Filterwert für „ohne Personenzuordnung“ (Kurznamen beginnen nie mit _). */
export const PERSON_OHNE = '_ohne';
const STORAGE_PREFIX = 'dashboard-personenfilter:';
const GRAU = '#6b7280';

function lesen(key) {
  if (!key) return [];
  try {
    const werte = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(werte) ? werte.filter((w) => typeof w === 'string') : [];
  } catch {
    return [];
  }
}

function schreiben(key, werte) {
  if (!key) return;
  try {
    if (werte.length) localStorage.setItem(key, JSON.stringify(werte));
    else localStorage.removeItem(key);
  } catch { /* privater Modus o. Ä.: Auswahl gilt dann nur bis zum Neuladen */ }
}

/**
 * @returns {{
 *   bereit: boolean,          // Personen geladen – erst dann die Kennzahlen abfragen
 *   sichtbar: boolean,
 *   optionen: Array<{kurzname:string, vollname?:string, farbe?:string}>,
 *   auswahl: string[],        // bereinigt, in stabiler Reihenfolge; leer = alle
 *   umschalten: (wert:string) => void,
 *   zuruecksetzen: () => void,
 * }}
 */
export function useDashboardPersonenFilter() {
  const { username, istEingeschraenkt } = useAuth();
  const key = username ? `${STORAGE_PREFIX}${username}` : null;
  const [gespeichert, setGespeichert] = useState(() => lesen(key));
  useEffect(() => { setGespeichert(lesen(key)); }, [key]);

  const { data: personenData, isLoading } = useQuery({
    queryKey: ['personen'],
    queryFn: () => api.personen.list(),
    staleTime: 5 * 60 * 1000,
    enabled: !istEingeschraenkt,
  });

  const optionen = useMemo(
    () => (personenData?.data ?? []).filter((p) => !p.archiviert),
    [personenData],
  );
  const sichtbar = !istEingeschraenkt && optionen.length > 1;

  // Gespeicherte Werte gegen die aktuellen Personen prüfen: Umbenannte,
  // archivierte oder gelöschte Personen fallen still heraus.
  const auswahl = useMemo(() => {
    if (!sichtbar) return [];
    const gewaehlt = new Set(gespeichert);
    const namen = optionen.map((p) => p.kurzname).filter((k) => gewaehlt.has(k));
    return gewaehlt.has(PERSON_OHNE) ? [...namen, PERSON_OHNE] : namen;
  }, [sichtbar, gespeichert, optionen]);

  const setzen = (werte) => {
    setGespeichert(werte);
    schreiben(key, werte);
  };

  return {
    bereit: istEingeschraenkt || !isLoading,
    sichtbar,
    optionen,
    auswahl,
    umschalten: (wert) => setzen(auswahl.includes(wert) ? auswahl.filter((w) => w !== wert) : [...auswahl, wert]),
    zuruecksetzen: () => setzen([]),
  };
}

function Chip({ aktiv, farbe, onClick, title, children }) {
  const f = farbe || GRAU;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={aktiv}
      title={title}
      className={cn(
        'inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-xs font-medium transition-colors',
        !aktiv && 'border-border bg-background text-muted-foreground hover:border-foreground/30 hover:text-foreground',
        aktiv && 'shadow-sm',
        // „Alle“ hat keine Personenfarbe und wird neutral hervorgehoben.
        aktiv && farbe === undefined && 'border-foreground/50 bg-muted text-foreground',
      )}
      style={aktiv && farbe !== undefined
        ? { borderColor: f, color: f, backgroundColor: `color-mix(in srgb, ${f} 14%, transparent)` }
        : undefined}
    >
      {farbe !== undefined && (
        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: f }} aria-hidden />
      )}
      {children}
    </button>
  );
}

/** @param {ReturnType<typeof useDashboardPersonenFilter>} props.filter */
export default function PersonenFilter({ filter }) {
  if (!filter.sichtbar) return null;
  const { optionen, auswahl, umschalten, zuruecksetzen } = filter;
  const alle = auswahl.length === 0;

  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Dashboard nach Personen filtern">
      <span className="mr-1 inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <User className="h-3.5 w-3.5" aria-hidden />
        Personen
      </span>
      <Chip
        aktiv={alle}
        onClick={zuruecksetzen}
        title="Alle Personen anzeigen"
      >
        Alle
      </Chip>
      {optionen.map((p) => (
        <Chip
          key={p.kurzname}
          aktiv={auswahl.includes(p.kurzname)}
          farbe={p.farbe || null}
          onClick={() => umschalten(p.kurzname)}
          title={p.vollname && p.vollname !== p.kurzname ? p.vollname : undefined}
        >
          {p.kurzname}
        </Chip>
      ))}
      <Chip
        aktiv={auswahl.includes(PERSON_OHNE)}
        farbe={null}
        onClick={() => umschalten(PERSON_OHNE)}
        title="Dokumente ohne Personenzuordnung"
      >
        ohne Zuordnung
      </Chip>
    </div>
  );
}
