import { useNavigate, useLocation } from 'react-router';
import { useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import * as LucideIcons from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { ColumnResizer } from '@/components/table/ColumnResizer';
import { useIsMobile } from '@/hooks/useIsMobile';
import { ArtBadge } from './ArtBadge';
import { LebensbereichBadge } from './LebensbereichBadge';
import { StatusBadge } from './StatusBadge';
import { formatDate, formatCurrency } from '@/lib/utils';
import { Eye, ArrowUp, ArrowDown, StickyNote, Filter, FilterX, FolderPlus, CalendarClock, User, Inbox, Send, ShieldCheck, ArrowLeftRight, PackageCheck } from 'lucide-react';

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

// Kanonische Spaltendefinition (Single-Point-of-Truth für Reihenfolge + Defaults).
// `name` = Klartext für die Spaltenauswahl (namenlose Icon-Spalten), `icon` = Symbol dort.
// `defaultWidth`/min/max in px; `elastic` schluckt die Restbreite (nicht resizebar);
// `resizable: false` = kein Zieh-Griff (schmale Icon-/Aktions-Spalten).
export const postbuchColumns = [
  { key: 'postid',           label: 'ID',      sortable: true,  filterable: true,  defaultWidth: 88,  minWidth: 64 },
  { key: 'briefdatum',       label: 'Datum',   sortable: true,  filterable: true,  defaultWidth: 104, minWidth: 84 },
  { key: 'richtung',         label: '', name: 'Richtung',              icon: ArrowLeftRight, defaultWidth: 40, resizable: false },
  { key: 'familienmitglied', label: '', name: 'Familienmitglied',      icon: User,           defaultWidth: 40, resizable: false },
  { key: 'kontakt',          label: 'Kontakt', sortable: true,  filterable: true,  defaultWidth: 192, minWidth: 80 },
  { key: 'art',              label: 'Typ',                            defaultWidth: 120, minWidth: 80 },
  { key: 'betreff',          label: 'Betreff', filterable: true, elastic: true },
  { key: 'betrag',           label: 'Betrag',  sortable: true,  filterable: true,  defaultWidth: 132, minWidth: 90 },
  { key: 'status',           label: 'Status',                         defaultWidth: 160, minWidth: 110 },
  { key: 'verbleib',         label: '', name: 'Verbleib des Originals', icon: PackageCheck,  defaultWidth: 44, resizable: false },
  { key: 'urkunde',          label: '', name: 'Urkunde',              icon: ShieldCheck,     defaultWidth: 44, resizable: false },
  { key: 'pdf',              label: 'PDF', name: 'PDF-Anhang',         icon: Eye,             defaultWidth: 56, resizable: false },
];

// Feste Breiten der modusabhängigen Spalten (nicht konfigurierbar/persistiert).
const DYN_WIDTHS = { _select: 40, similarity: 72, _akte: 56 };

export function PostbuchTable({ data, sort, order, onSort, onShowPdf, columnFilters, onColumnFilterChange, aktenmodusAkteId, aktenmodusBetreff, aktenmodusBackTo, onAddToAkte, similarToPostId, selectionMode, selectedIds, onToggleSelect, columnConfig }) {
  const navigate = useNavigate();
  const location = useLocation();
  const isMobile = useIsMobile();
  const [openFilters, setOpenFilters] = useState(() =>
    new Set(Object.keys(columnFilters || {}).filter((k) => columnFilters[k]))
  );

  // Similarity column is only meaningful when at least one row actually has a similarity score.
  // This hides the column when the akte/document has no embedding (all values would be null).
  const hasSimilarity = data.some((row) => row.similarity != null);
  const inSimilarityMode = !!(aktenmodusAkteId || similarToPostId);

  // Nutzer-Konfiguration (Sichtbarkeit + Breite). Fallback: alle sichtbar mit Default-Breite.
  const cfgColumns = columnConfig?.columns
    ?? postbuchColumns.map((c) => ({ ...c, visible: true, width: c.defaultWidth ?? null }));
  const visibleStatic = cfgColumns.filter((c) => c.visible);
  const visibleKeys = new Set(visibleStatic.map((c) => c.key));

  // Finale Renderreihenfolge: [dyn. Prefix] + [konfigurierte sichtbare Statik] + [dyn. Suffix].
  // Modusabhängige Spalten bleiben außerhalb der Konfiguration.
  const allColumns = [...visibleStatic];
  if (selectionMode) {
    allColumns.unshift({ key: '_select', label: '', width: DYN_WIDTHS._select, resizable: false });
  }
  if (inSimilarityMode && hasSimilarity) {
    allColumns.push({ key: 'similarity', label: 'Ähnl.', sortable: true, width: DYN_WIDTHS.similarity, resizable: false });
  }
  if (aktenmodusAkteId) {
    allColumns.push({ key: '_akte', label: '', width: DYN_WIDTHS._akte, resizable: false });
  }

  const handleSort = (key) => {
    if (!allColumns.find((c) => c.key === key)?.sortable) return;
    onSort(key, sort === key && order === 'asc' ? 'desc' : 'asc');
  };

  const SortIcon = ({ col }) => {
    if (sort !== col) return null;
    return order === 'asc'
      ? <ArrowUp className="h-3 w-3 inline ml-1" />
      : <ArrowDown className="h-3 w-3 inline ml-1" />;
  };

  const openFilter = (key) => setOpenFilters((prev) => new Set([...prev, key]));
  const closeFilter = (key) => {
    setOpenFilters((prev) => { const s = new Set(prev); s.delete(key); return s; });
    onColumnFilterChange?.(key, '');
  };

  return (
    <Table className={isMobile ? undefined : 'table-fixed'}>
      {/* colgroup steuert die Spaltenbreiten (nur Desktop/table-fixed). Elastische Spalte ohne
          Breite schluckt die Restbreite; ColumnResizer mutiert diese <col>-Elemente live. */}
      {!isMobile && (
        <colgroup>
          {allColumns.map((col) => (
            <col
              key={col.key}
              data-colkey={col.key}
              style={!col.elastic && col.width ? { width: `${col.width}px` } : undefined}
            />
          ))}
        </colgroup>
      )}
      <TableHeader>
        <TableRow>
          {allColumns.map((col) => {
            if (col.key === '_select') {
              const allSelected = data.length > 0 && data.every(r => selectedIds?.has(r.postid));
              const someSelected = !allSelected && data.some(r => selectedIds?.has(r.postid));
              return (
                <TableHead key="_select" className="w-[40px] text-center">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    ref={el => { if (el) el.indeterminate = someSelected; }}
                    onChange={() => {
                      if (allSelected) {
                        data.forEach(r => selectedIds?.has(r.postid) && onToggleSelect?.(r.postid));
                      } else {
                        data.forEach(r => !selectedIds?.has(r.postid) && onToggleSelect?.(r.postid));
                      }
                    }}
                    className="h-4 w-4 cursor-pointer accent-primary"
                  />
                </TableHead>
              );
            }
            const isOpen = openFilters.has(col.key);
            const hasValue = !!(columnFilters?.[col.key]);
            const showResizer = !isMobile && col.resizable !== false && !col.elastic;
            return (
              <TableHead
                key={col.key}
                className={`relative ${col.sortable && !isOpen ? 'cursor-pointer select-none' : ''}`}
                onClick={() => !isOpen && col.sortable && handleSort(col.key)}
              >
                <div className="flex items-center gap-1 min-w-0">
                  {/* When filter is open: show input in place of label */}
                  {col.filterable && onColumnFilterChange && isOpen ? (
                    <input
                      autoFocus
                      type="text"
                      value={columnFilters?.[col.key] || ''}
                      onChange={(e) => onColumnFilterChange(col.key, e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      placeholder={col.label + '…'}
                      className="min-w-0 flex-1 h-5 px-1 text-xs rounded border border-input bg-background font-normal placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-ring/50 focus:border-primary/40"
                    />
                  ) : (
                    <span className="flex-1 truncate">{col.label}{col.sortable && <SortIcon col={col.key} />}</span>
                  )}
                  {/* Filter toggle button */}
                  {col.filterable && onColumnFilterChange && (
                    isOpen || hasValue
                      ? <button
                          onClick={(e) => { e.stopPropagation(); closeFilter(col.key); }}
                          className="flex-shrink-0 text-primary hover:text-primary/70"
                          title="Filter löschen und schließen"
                        ><FilterX className="h-3 w-3" /></button>
                      : <button
                          onClick={(e) => { e.stopPropagation(); openFilter(col.key); }}
                          className="flex-shrink-0 text-muted-foreground/40 hover:text-muted-foreground"
                          title="Spalte filtern"
                        ><Filter className="h-3 w-3" /></button>
                  )}
                </div>
                {showResizer && (
                  <ColumnResizer
                    columnKey={col.key}
                    min={col.minWidth ?? 40}
                    max={col.maxWidth ?? 600}
                    onCommit={(px) => columnConfig?.setWidth(col.key, px)}
                    onReset={() => columnConfig?.resetWidth(col.key)}
                  />
                )}
              </TableHead>
            );
          })}
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.length === 0 && (
          <TableRow>
            <TableCell colSpan={allColumns.length} className="h-32 text-center text-muted-foreground text-sm">
              Keine Dokumente gefunden.
            </TableCell>
          </TableRow>
        )}
        {data.map((row) => (
          <TableRow
            key={row.postid}
            className={`cursor-pointer ${row.historisch ? 'opacity-50' : ''} ${selectionMode && selectedIds?.has(row.postid) ? 'bg-primary/8' : ''}`}
          onClick={() => {
            if (selectionMode) { onToggleSelect?.(row.postid); return; }
            navigate(`/postbuch/${row.postid}`, {
            state: {
              from: location.pathname + location.search,
              navList: data.map(r => ({ postid: r.postid, betreff: r.betreff, art: r.art, kontakt: r.kontakt })),
              navIndex: data.findIndex(r => r.postid === row.postid),
              ...(aktenmodusAkteId ? { aktenmodusAkteId, aktenmodusBetreff, aktenmodusBackTo } : {}),
            },
          })}}
          >
            {selectionMode && (
              <TableCell className="w-[40px] text-center" onClick={(e) => e.stopPropagation()}>
                <input
                  type="checkbox"
                  checked={selectedIds?.has(row.postid) ?? false}
                  onChange={() => onToggleSelect?.(row.postid)}
                  className="h-4 w-4 cursor-pointer accent-primary"
                />
              </TableCell>
            )}
            {visibleKeys.has('postid') && <TableCell className="font-mono text-xs overflow-hidden">{row.postid}</TableCell>}
            {visibleKeys.has('briefdatum') && <TableCell className="whitespace-nowrap overflow-hidden">{formatDate(row.briefdatum)}</TableCell>}
            {visibleKeys.has('richtung') && (
            <TableCell className="p-0 text-center overflow-hidden">
              {row.richtung === 'ausgang' ? (
                <span
                  className="inline-flex items-center justify-center text-muted-foreground"
                  title="Ausgangspost"
                >
                  <Send className="h-3.5 w-3.5" />
                </span>
              ) : (
                <span
                  className="inline-flex items-center justify-center text-muted-foreground"
                  title="Eingangspost"
                >
                  <Inbox className="h-3.5 w-3.5" />
                </span>
              )}
            </TableCell>
            )}
            {visibleKeys.has('familienmitglied') && (
            <TableCell className="p-0 text-center overflow-hidden">
              {row.familienmitglied ? (
                <span
                  className="inline-flex items-center justify-center"
                  style={{ color: row.familienmitglied_farbe || '#6b7280' }}
                  title={`${row.richtung === 'ausgang' ? 'Absender' : 'Adressat'}: ${row.familienmitglied}`}
                >
                  <User className="h-4 w-4" fill="currentColor" stroke="none" />
                </span>
              ) : null}
            </TableCell>
            )}
            {visibleKeys.has('kontakt') && <TableCell className={`truncate ${isMobile ? 'max-w-[160px]' : ''}`}>{row.kontakt || '–'}</TableCell>}
            {visibleKeys.has('art') && (
              <TableCell className="overflow-hidden">
                <div className="flex items-center gap-1.5 min-w-0">
                  <LebensbereichBadge lebensbereich={row.lebensbereich} compact />
                  <ArtBadge art={row.dokumentart || row.art} truncate />
                </div>
              </TableCell>
            )}
            {visibleKeys.has('betreff') && <TableCell className={`truncate ${isMobile ? 'max-w-[160px]' : ''}`}>{row.betreff || '–'}</TableCell>}
            {visibleKeys.has('betrag') && (
            <TableCell className="whitespace-nowrap text-right font-mono overflow-hidden">
              {formatCurrency(row.betrag)}
            </TableCell>
            )}
            {visibleKeys.has('status') && (
            <TableCell className="overflow-hidden">
              <div className="flex items-center gap-1.5">
                <StatusBadge status={row.status} />
                {row.hat_wiedervorlage && (
                  <span className="inline-flex items-center text-cyan-500 hover:text-cyan-600 transition-colors cursor-default" aria-label="Wiedervorlage vorhanden" title="Wiedervorlage vorhanden">
                    <CalendarClock className="h-3.5 w-3.5" />
                  </span>
                )}
                {row.notiz && <NoteTooltip notiz={row.notiz} />}
              </div>
            </TableCell>
            )}
            {visibleKeys.has('verbleib') && (
            <TableCell className="p-0 text-center overflow-hidden">
              {row.verbleib_id && row.verbleib_id !== 1 && row.verbleib_kategorie_icon && (() => {
                const VIcon = LucideIcons[row.verbleib_kategorie_icon];
                return VIcon ? (
                  <span
                    className="inline-flex items-center justify-center text-muted-foreground"
                    title={row.verbleib_kategorie_name ?? row.verbleib_kategorie_icon}
                  >
                    <VIcon className="h-3.5 w-3.5" />
                  </span>
                ) : null;
              })()}
            </TableCell>
            )}
            {visibleKeys.has('urkunde') && (
            <TableCell className="p-0 text-center overflow-hidden">
              {row.original_urkunde && (
                <span
                  className="inline-flex items-center justify-center text-amber-600"
                  title="Urkunde (niemals aussondern)"
                  aria-label="Urkunde"
                >
                  <ShieldCheck className="h-3.5 w-3.5" />
                </span>
              )}
            </TableCell>
            )}
            {visibleKeys.has('pdf') && (
            <TableCell className="overflow-hidden">
              {row.hat_pdf && (
                <button
                  className="text-muted-foreground hover:text-primary transition-colors"
                  onClick={(e) => { e.stopPropagation(); onShowPdf(row.postid); }}
                  title="PDF anzeigen"
                >
                  <Eye className="h-4 w-4" />
                </button>
              )}
            </TableCell>
            )}
            {inSimilarityMode && hasSimilarity && (
              <TableCell className="text-right tabular-nums font-mono text-xs pr-3">
                {row.similarity != null ? (
                  <span className={
                    row.similarity >= 0.7 ? 'text-green-600 dark:text-green-400' :
                    row.similarity >= 0.6 ? 'text-amber-600 dark:text-amber-400' :
                    'text-muted-foreground'
                  }>
                    {Math.round(row.similarity * 100)} %
                  </span>
                ) : <span className="text-muted-foreground/40">–</span>}
              </TableCell>
            )}
            {aktenmodusAkteId && (
              <TableCell>
                <button
                  className="text-muted-foreground hover:text-primary transition-colors"
                  onClick={(e) => { e.stopPropagation(); onAddToAkte?.(row.postid); }}
                  title="Zur Akte hinzufügen"
                >
                  <FolderPlus className="h-4 w-4" />
                </button>
              </TableCell>
            )}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
