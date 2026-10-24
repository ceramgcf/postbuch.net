import { useNavigate, useLocation } from 'react-router';
import { useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import * as LucideIcons from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { DataView } from '@/components/listen/DataView';
import { useDarstellung } from '@/hooks/useDarstellung';
import { ArtBadge } from './ArtBadge';
import { LebensbereichBadge } from './LebensbereichBadge';
import { StatusBadge } from './StatusBadge';
import { formatDate, formatCurrency, cn } from '@/lib/utils';
import { Eye, EyeOff, StickyNote, FolderPlus, CalendarClock, User, Inbox, Send, ShieldCheck, ArrowLeftRight, PackageCheck } from 'lucide-react';

/** Markdown components – minimal inline Tailwind styling, no prose plugin needed */
const mdComponents = {
  h1: ({ children }) => <h1 className="text-sm font-bold mt-2 mb-0.5 first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="text-xs font-semibold mt-2 mb-0.5 first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="text-xs font-semibold mt-1.5 mb-0.5 first:mt-0">{children}</h3>,
  p: ({ children }) => <p className="mb-1.5 last:mb-0 leading-relaxed">{children}</p>,
  ul: ({ children }) => <ul className="list-disc list-inside mb-1.5 space-y-0.5 pl-1">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal list-inside mb-1.5 space-y-0.5 pl-1">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  del: ({ children }) => <del className="line-through opacity-60">{children}</del>,
  code: ({ inline, children }) =>
    inline
      ? <code className="bg-black/10 rounded px-1 py-0.5 text-[10px] font-mono">{children}</code>
      : <pre className="bg-black/10 rounded p-2 text-[10px] font-mono overflow-x-auto my-1.5 whitespace-pre-wrap"><code>{children}</code></pre>,
  pre: ({ children }) => <>{children}</>,
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-current/40 pl-2 my-1.5 opacity-70">{children}</blockquote>
  ),
  hr: () => <hr className="my-2 border-current/20" />,
};

function NoteTooltip({ notiz }) {
  const [visible, setVisible] = useState(false);
  const [tooltipStyle, setTooltipStyle] = useState({});
  const triggerRef = useRef(null);

  const handleMouseEnter = () => {
    if (triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      const TOOLTIP_WIDTH = 288; // 18rem
      const GAP = 8;

      // Clamp left so tooltip stays within the viewport
      const rawLeft = rect.left + rect.width / 2 - TOOLTIP_WIDTH / 2;
      const clampedLeft = Math.max(8, Math.min(rawLeft, window.innerWidth - TOOLTIP_WIDTH - 8));

      setTooltipStyle({
        position: 'fixed',
        bottom: window.innerHeight - rect.top + GAP,
        left: clampedLeft,
        width: TOOLTIP_WIDTH,
        zIndex: 9999,
      });
    }
    setVisible(true);
  };

  return (
    <>
      <span
        ref={triggerRef}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={() => setVisible(false)}
        className="inline-flex items-center text-amber-500 hover:text-amber-600 transition-colors cursor-default"
        aria-label="Notiz vorhanden"
      >
        <StickyNote className="h-3.5 w-3.5" />
      </span>
      {visible && createPortal(
        <div
          className="rounded-lg border border-border bg-popover text-popover-foreground shadow-lg px-3 py-2.5 text-xs max-h-56 overflow-y-hidden pointer-events-none"
          style={tooltipStyle}
        >
          <ReactMarkdown components={mdComponents} remarkPlugins={[remarkGfm]}>
            {notiz}
          </ReactMarkdown>
        </div>,
        document.body,
      )}
    </>
  );
}

function Richtung({ row }) {
  const aus = row.richtung === 'ausgang';
  const Icon = aus ? Send : Inbox;
  return (
    <span className="inline-flex items-center justify-center text-muted-foreground" title={aus ? 'Ausgangspost' : 'Eingangspost'}>
      <Icon className="h-3.5 w-3.5" />
    </span>
  );
}

function Familienmitglied({ row }) {
  if (!row.familienmitglied) return null;
  return (
    <span
      className="inline-flex items-center justify-center"
      style={{ color: row.familienmitglied_farbe || '#6b7280' }}
      title={`${row.richtung === 'ausgang' ? 'Absender' : 'Adressat'}: ${row.familienmitglied}`}
    >
      <User className="h-4 w-4" fill="currentColor" stroke="none" />
    </span>
  );
}

function Verbleib({ row }) {
  if (!row.verbleib_id || row.verbleib_id === 1 || !row.verbleib_kategorie_icon) return null;
  const VIcon = LucideIcons[row.verbleib_kategorie_icon];
  return VIcon ? (
    <span className="inline-flex items-center justify-center text-muted-foreground" title={row.verbleib_kategorie_name ?? row.verbleib_kategorie_icon}>
      <VIcon className="h-3.5 w-3.5" />
    </span>
  ) : null;
}

function Status({ row, istMobil }) {
  return (
    <div className="flex items-center gap-1.5">
      <StatusBadge status={row.status} />
      {row.hat_wiedervorlage && (
        <span className="inline-flex items-center text-cyan-500 hover:text-cyan-600 transition-colors cursor-default" aria-label="Wiedervorlage vorhanden" title="Wiedervorlage vorhanden">
          <CalendarClock className="h-3.5 w-3.5" />
        </span>
      )}
      {/* Hover-Tooltip ergibt auf Touch keinen Sinn – mobil reicht das Symbol. */}
      {row.notiz && (istMobil
        ? <StickyNote className="h-3.5 w-3.5 text-amber-500" aria-label="Notiz vorhanden" />
        : <NoteTooltip notiz={row.notiz} />)}
    </div>
  );
}

function Aehnlichkeit({ row }) {
  if (row.similarity == null) return <span className="text-muted-foreground/40">–</span>;
  const farbe = row.similarity >= 0.7 ? 'text-green-600 dark:text-green-400'
    : row.similarity >= 0.6 ? 'text-amber-600 dark:text-amber-400'
    : 'text-muted-foreground';
  return <span className={`tabular-nums font-mono text-xs ${farbe}`}>{Math.round(row.similarity * 100)} %</span>;
}

// Kanonische Spaltendefinition (Single-Point-of-Truth für Reihenfolge, Defaults und Darstellung).
// `name` = Klartext für die Spaltenauswahl (namenlose Icon-Spalten), `icon` = Symbol dort.
// `defaultWidth`/min/max in px; `elastic` schluckt die Restbreite (nicht resizebar);
// `resizable: false` = kein Zieh-Griff (schmale Icon-/Aktions-Spalten).
// `zelle` rendert den Inhalt für Tabelle UND Karte, `mobil` legt den Platz in der Karte fest
// (siehe components/listen/DataView.jsx). Neue Spalten brauchen also keinen Mobilcode.
export const postbuchColumns = [
  { key: 'postid', label: 'ID', sortable: true, filterable: true, defaultWidth: 88, minWidth: 64,
    mobil: 'meta', zellKlasse: 'font-mono text-xs overflow-hidden',
    zelle: (row, { istMobil }) => istMobil ? <span className="font-mono">{row.postid}</span> : row.postid },
  { key: 'briefdatum', label: 'Datum', sortable: true, filterable: true, defaultWidth: 104, minWidth: 84,
    mobil: 'meta', zellKlasse: 'whitespace-nowrap overflow-hidden',
    zelle: (row) => formatDate(row.briefdatum) },
  { key: 'richtung', label: '', name: 'Richtung', icon: ArrowLeftRight, defaultWidth: 40, resizable: false,
    mobil: 'meta', zellKlasse: 'p-0 text-center overflow-hidden',
    zelle: (row) => <Richtung row={row} /> },
  { key: 'familienmitglied', label: '', name: 'Familienmitglied', icon: User, defaultWidth: 40, resizable: false,
    mobil: 'meta', zellKlasse: 'p-0 text-center overflow-hidden',
    zelle: (row, { istMobil }) => istMobil
      ? (row.familienmitglied ? <span className="flex items-center gap-1 truncate"><Familienmitglied row={row} />{row.familienmitglied}</span> : null)
      : <Familienmitglied row={row} /> },
  { key: 'kontakt', label: 'Kontakt', sortable: true, filterable: true, defaultWidth: 192, minWidth: 80,
    mobil: 'titel', zellKlasse: 'truncate',
    zelle: (row) => row.kontakt || '–' },
  { key: 'art', label: 'Typ', defaultWidth: 120, minWidth: 80,
    mobil: 'badges', zellKlasse: 'overflow-hidden',
    zelle: (row) => (
      <div className="flex items-center gap-1.5 min-w-0">
        <LebensbereichBadge lebensbereich={row.lebensbereich} compact />
        <ArtBadge art={row.dokumentart || row.art} truncate />
      </div>
    ) },
  { key: 'betreff', label: 'Betreff', filterable: true, elastic: true,
    mobil: 'text', zellKlasse: 'truncate',
    zelle: (row, { istMobil }) => row.betreff || (istMobil ? null : '–') },
  { key: 'betrag', label: 'Betrag', sortable: true, filterable: true, defaultWidth: 132, minWidth: 90,
    mobil: 'rechts', zellKlasse: 'whitespace-nowrap text-right font-mono overflow-hidden',
    zelle: (row, { istMobil }) => (istMobil && row.betrag == null ? null : formatCurrency(row.betrag)) },
  { key: 'status', label: 'Status', defaultWidth: 160, minWidth: 110,
    mobil: 'badges', zellKlasse: 'overflow-hidden',
    zelle: (row, { istMobil }) => <Status row={row} istMobil={istMobil} /> },
  { key: 'verbleib', label: '', name: 'Verbleib des Originals', icon: PackageCheck, defaultWidth: 44, resizable: false,
    mobil: 'aktion', zellKlasse: 'p-0 text-center overflow-hidden',
    zelle: (row) => <Verbleib row={row} /> },
  { key: 'urkunde', label: '', name: 'Urkunde', icon: ShieldCheck, defaultWidth: 44, resizable: false,
    mobil: 'aktion', zellKlasse: 'p-0 text-center overflow-hidden',
    zelle: (row) => row.original_urkunde ? (
      <span className="inline-flex items-center justify-center text-amber-600" title="Urkunde (niemals aussondern)" aria-label="Urkunde">
        <ShieldCheck className="h-3.5 w-3.5" />
      </span>
    ) : null },
  // Mobil öffnet der Tipp auf die Karte das Dokument samt Ansicht-Umschalter – ein eigener
  // PDF-Knopf wäre doppelt.
  { key: 'pdf', label: 'PDF', name: 'PDF-Anhang', icon: Eye, defaultWidth: 56, resizable: false,
    mobil: false, zellKlasse: 'overflow-hidden',
    zelle: (row, { onShowPdf, angezeigtePdfId }) => {
      if (!row.hat_pdf) return null;
      const angezeigt = row.postid === angezeigtePdfId;
      return (
        <button
          className={`${angezeigt ? 'text-primary' : 'text-muted-foreground'} hover:text-primary transition-colors`}
          onClick={(e) => { e.stopPropagation(); onShowPdf?.(row.postid); }}
          title={angezeigt ? 'PDF schließen' : 'PDF anzeigen'}
          aria-pressed={angezeigt}
        >
          {angezeigt ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      );
    } },
];

// Modusabhängige Spalten (nicht konfigurierbar/persistiert).
const spalteAehnlichkeit = {
  key: 'similarity', label: 'Ähnl.', sortable: true, width: 72, resizable: false,
  mobil: 'rechts', zellKlasse: 'text-right pr-3', zelle: (row) => <Aehnlichkeit row={row} />,
};
const spalteAkte = {
  key: '_akte', label: '', width: 56, resizable: false, mobil: 'aktion',
  zelle: (row, { onAddToAkte, istMobil }) => (
    <button
      className={`text-muted-foreground hover:text-primary transition-colors ${istMobil ? 'p-1.5 -m-1.5 text-primary' : ''}`}
      onClick={(e) => { e.stopPropagation(); onAddToAkte?.(row.postid); }}
      title="Zur Akte hinzufügen"
    >
      <FolderPlus className={istMobil ? 'h-5 w-5' : 'h-4 w-4'} />
    </button>
  ),
};

/** Liste der Postbuch-Dokumente – Tabelle am Desktop, Karten mobil (DataView). */
export function PostbuchTable({ data, sort, order, onSort, onShowPdf, columnFilters, onColumnFilterChange, aktenmodusAkteId, aktenmodusBetreff, aktenmodusBackTo, onAddToAkte, similarToPostId, selectionMode, selectedIds, onToggleSelect, columnConfig, alsKarten = false, angezeigtePdfId = null, zielPdfId = null }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { istMobil: mobilLayout } = useDarstellung();
  // Karten mobil oder am Desktop, wenn die Breite für die Tabelle nicht reicht.
  const istMobil = mobilLayout || alsKarten;

  // Ähnlichkeit nur, wenn mindestens eine Zeile einen Wert hat (ohne Embedding wären alle leer).
  const hasSimilarity = data.some((row) => row.similarity != null);
  const inSimilarityMode = !!(aktenmodusAkteId || similarToPostId);

  // Tabelle: Nutzer-Konfiguration (Sichtbarkeit + Breite). Karten zählen nur `mobil` der Spalte –
  // die Karte hat keine Spaltenbreiten, ausgeblendete Tabellenspalten bleiben dort sichtbar.
  // Desktop-Karten behalten das Auge fürs PDF-Panel; mobil zeigt die Detailseite das Dokument.
  const basis = istMobil
    ? (mobilLayout ? postbuchColumns : postbuchColumns.map((c) => (c.key === 'pdf' ? { ...c, mobil: 'aktion' } : c)))
    : (columnConfig?.columns ?? postbuchColumns.map((c) => ({ ...c, visible: true, width: c.defaultWidth ?? null })))
        .filter((c) => c.visible);
  const spalten = [...basis];
  if (inSimilarityMode && hasSimilarity) spalten.push(spalteAehnlichkeit);
  if (aktenmodusAkteId) spalten.push(spalteAkte);

  const oeffne = (row) => navigate(`/postbuch/${row.postid}`, {
    state: {
      from: location.pathname + location.search,
      navList: data.map((r) => ({ postid: r.postid, betreff: r.betreff, art: r.art, kontakt: r.kontakt })),
      navIndex: data.findIndex((r) => r.postid === row.postid),
      ...(aktenmodusAkteId ? { aktenmodusAkteId, aktenmodusBetreff, aktenmodusBackTo } : {}),
    },
  });

  return (
    <DataView
      spalten={spalten}
      daten={data}
      zeilenKey="postid"
      istMobil={istMobil}
      einheitlich={alsKarten && !mobilLayout}
      onZeile={oeffne}
      ctx={{ istMobil, onShowPdf, onAddToAkte, angezeigtePdfId }}
      auswahl={selectionMode ? { aktiv: true, ids: selectedIds, toggle: (id) => onToggleSelect?.(id) } : null}
      leerText="Keine Dokumente gefunden."
      zeilenKlasse={(row) => cn(
        row.historisch && 'opacity-50',
        // Im PDF-Panel angezeigtes Dokument hervorheben (Tabellenzeile wie Karte).
        row.postid === angezeigtePdfId && 'border-primary/50 bg-primary/10 hover:bg-primary/10',
        // Marker fürs Hineinscrollen nach Layoutwechsel oder Schließen des Panels.
        row.postid === zielPdfId && 'pdf-ziel',
      )}
      sort={sort}
      order={order}
      onSort={onSort}
      columnFilters={columnFilters}
      onColumnFilterChange={onColumnFilterChange}
      columnConfig={columnConfig}
    />
  );
}
