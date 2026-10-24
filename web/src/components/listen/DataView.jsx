import { useState } from 'react';
import { ArrowUp, ArrowDown, Filter, FilterX } from 'lucide-react';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { ColumnResizer } from '@/components/table/ColumnResizer';
import { useDarstellung } from '@/hooks/useDarstellung';
import { cn } from '@/lib/utils';

/**
 * Datenliste mit einer Spaltendefinition für beide Layouts.
 *
 * Desktop: Tabelle (Sortierung, Spaltenfilter, Breiten aus useColumnConfig).
 * Mobil:   Karten – dieselben `zelle`-Renderer, angeordnet nach `mobil`.
 *
 * Spalte:
 *   key, label            Schlüssel und Kopfbeschriftung
 *   zelle(row, ctx)       einzige Render-Quelle des Inhalts (beide Layouts)
 *   zellKlasse            Klassen der Tabellenzelle (nur Desktop)
 *   mobil                 Platz in der Karte:
 *                           'meta'   Kopfzeile links, klein (Standard)
 *                           'rechts' Kopfzeile rechts (z. B. Betrag)
 *                           'titel'  fette Hauptzeile
 *                           'text'   Fließtext, zweizeilig gekürzt
 *                           'badges' Fußzeile links
 *                           'aktion' Fußzeile rechts (Icons/Knöpfe)
 *                           false    mobil nicht zeigen
 *   sortable, filterable, defaultWidth, minWidth, maxWidth, elastic, resizable
 *
 * `einheitlich` (nur Karten): alle Karten gleich hoch, Texte einzeilig gekürzt – für
 * seitenweise Listen, deren automatische Seitengröße mit der Kartenhöhe rechnet.
 *
 * Neue Spalten werden also genau einmal beschrieben; die Karte ordnet sie
 * ohne weiteren Code ein.
 */
export function DataView({ istMobil: erzwungen, ...props }) {
  const { istMobil } = useDarstellung();
  return (erzwungen ?? istMobil) ? <KartenListe {...props} /> : <DatenTabelle {...props} />;
}

const MOBIL_PLAETZE = ['meta', 'rechts', 'titel', 'text', 'badges', 'aktion'];

// Einheitliche Karten (seitenweise Liste mit automatischer Seitengröße): vier
// einzeilige Zeilen fester Höhe, Überlängen gekürzt. Höhe inklusive Rand.
export const KARTE_EINHEITLICH_HOEHE = 122;
export const KARTEN_ABSTAND = 8; // gap-2

function inhalt(spalte, row, ctx) {
  if (spalte.zelle) return spalte.zelle(row, ctx);
  const v = row[spalte.key];
  return v == null || v === '' ? '–' : v;
}

function istLeer(knoten) {
  return knoten == null || knoten === false || knoten === '';
}

export function KartenListe({
  spalten, daten, zeilenKey = 'id', onZeile, ctx, auswahl, leerText = 'Keine Einträge gefunden.', zeilenKlasse,
  einheitlich = false,
}) {
  const e = einheitlich;
  const nachPlatz = Object.fromEntries(MOBIL_PLAETZE.map((p) => [p, []]));
  for (const s of spalten) {
    const platz = s.mobil === undefined ? 'meta' : s.mobil;
    if (platz && nachPlatz[platz]) nachPlatz[platz].push(s);
  }

  if (daten.length === 0) {
    return <p className="py-12 text-center text-sm text-muted-foreground">{leerText}</p>;
  }

  return (
    <div className="@container">
      <ul className="grid grid-cols-1 gap-2 @2xl:grid-cols-2">
        {daten.map((row) => {
          const id = row[zeilenKey];
          const gewaehlt = auswahl?.aktiv && auswahl.ids?.has(id);
          const teile = (platz) => nachPlatz[platz]
            .map((s) => ({ s, k: inhalt(s, row, ctx) }))
            .filter(({ k }) => !istLeer(k));
          const meta = teile('meta');
          const rechts = teile('rechts');
          const titel = e ? teile('titel').slice(0, 1) : teile('titel');
          const text = e ? teile('text').slice(0, 1) : teile('text');
          const badges = teile('badges');
          const aktion = teile('aktion');
          return (
            <li key={id}>
              <div
                role="button" tabIndex={0}
                onClick={() => (auswahl?.aktiv ? auswahl.toggle(id) : onZeile?.(row))}
                onKeyDown={(e) => { if (e.key === 'Enter') (auswahl?.aktiv ? auswahl.toggle(id) : onZeile?.(row)); }}
                className={cn(
                  'flex gap-3 rounded-2xl border border-border/60 bg-card px-3.5 py-3 shadow-sm shadow-primary/5 transition-colors active:bg-primary/5',
                  gewaehlt && 'border-primary/50 bg-primary/5',
                  e && 'overflow-hidden',
                  zeilenKlasse?.(row),
                )}
                style={e ? { height: KARTE_EINHEITLICH_HOEHE } : undefined}
              >
                {auswahl?.aktiv && (
                  <input
                    type="checkbox" checked={!!gewaehlt} readOnly tabIndex={-1}
                    className="mt-0.5 h-5 w-5 shrink-0 accent-primary pointer-events-none"
                    aria-label="Auswählen"
                  />
                )}
                <div className="min-w-0 flex-1 space-y-1">
                  {(e || meta.length > 0 || rechts.length > 0) && (
                    <div className={cn('flex items-center gap-2 text-xs text-muted-foreground', e && 'h-5')}>
                      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden whitespace-nowrap">
                        {meta.map(({ s, k }, i) => (
                          <span key={s.key} className="flex shrink-0 items-center gap-1.5 last:shrink last:truncate">
                            {i > 0 && <span className="text-muted-foreground/40" aria-hidden>·</span>}
                            {k}
                          </span>
                        ))}
                      </div>
                      {rechts.map(({ s, k }) => (
                        <span key={s.key} className="shrink-0 text-sm font-semibold text-foreground tabular-nums">{k}</span>
                      ))}
                    </div>
                  )}
                  {titel.map(({ s, k }) => (
                    <div key={s.key} className={cn('truncate text-[15px] font-semibold text-foreground', e ? 'h-5 leading-5' : 'leading-snug')}>{k}</div>
                  ))}
                  {e && titel.length === 0 && <div className="h-5" />}
                  {text.map(({ s, k }) => (
                    <div key={s.key} className={cn('text-sm text-muted-foreground', e ? 'h-5 truncate leading-5' : 'line-clamp-2 leading-snug')}>{k}</div>
                  ))}
                  {e && text.length === 0 && <div className="h-5" />}
                  {(e || badges.length > 0 || aktion.length > 0) && (
                    <div className={cn('flex items-center gap-2', e ? 'h-6' : 'pt-0.5')}>
                      <div className={cn('flex min-w-0 flex-1 items-center gap-1.5', e ? 'overflow-hidden' : 'flex-wrap')}>
                        {badges.map(({ s, k }) => <span key={s.key} className={cn('flex min-w-0 items-center gap-1.5', e && 'shrink-0 whitespace-nowrap')}>{k}</span>)}
                      </div>
                      {aktion.length > 0 && (
                        <div className="flex shrink-0 items-center gap-2.5 text-muted-foreground">
                          {aktion.map(({ s, k }) => <span key={s.key} className="flex items-center">{k}</span>)}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function DatenTabelle({
  spalten, daten, zeilenKey = 'id', onZeile, ctx, auswahl, leerText = 'Keine Einträge gefunden.', zeilenKlasse,
  sort, order, onSort, columnFilters, onColumnFilterChange, columnConfig,
}) {
  const { istTouch } = useDarstellung();
  const [openFilters, setOpenFilters] = useState(() =>
    new Set(Object.keys(columnFilters || {}).filter((k) => columnFilters[k]))
  );

  const handleSort = (key) => {
    if (!onSort || !spalten.find((c) => c.key === key)?.sortable) return;
    onSort(key, sort === key && order === 'asc' ? 'desc' : 'asc');
  };
  const openFilter = (key) => setOpenFilters((prev) => new Set([...prev, key]));
  const closeFilter = (key) => {
    setOpenFilters((prev) => { const s = new Set(prev); s.delete(key); return s; });
    onColumnFilterChange?.(key, '');
  };

  const mitAuswahl = !!auswahl?.aktiv;
  const alleGewaehlt = mitAuswahl && daten.length > 0 && daten.every((r) => auswahl.ids?.has(r[zeilenKey]));
  const einigeGewaehlt = mitAuswahl && !alleGewaehlt && daten.some((r) => auswahl.ids?.has(r[zeilenKey]));
  const breite = (col) => col.width ?? col.defaultWidth;

  return (
    <Table className="table-fixed">
      {/* colgroup steuert die Spaltenbreiten (table-fixed). Elastische Spalte ohne Breite
          schluckt die Restbreite; ColumnResizer mutiert diese <col>-Elemente live. */}
      <colgroup>
        {mitAuswahl && <col data-colkey="_select" style={{ width: '40px' }} />}
        {spalten.map((col) => (
          <col
            key={col.key}
            data-colkey={col.key}
            style={!col.elastic && breite(col) ? { width: `${breite(col)}px` } : undefined}
          />
        ))}
      </colgroup>
      <TableHeader>
        <TableRow>
          {mitAuswahl && (
            <TableHead className="w-[40px] text-center">
              <input
                type="checkbox"
                checked={alleGewaehlt}
                ref={(el) => { if (el) el.indeterminate = einigeGewaehlt; }}
                onChange={() => {
                  daten.forEach((r) => {
                    const id = r[zeilenKey];
                    if (alleGewaehlt ? auswahl.ids?.has(id) : !auswahl.ids?.has(id)) auswahl.toggle(id);
                  });
                }}
                className="h-4 w-4 cursor-pointer accent-primary"
              />
            </TableHead>
          )}
          {spalten.map((col) => {
            const isOpen = openFilters.has(col.key);
            const hasValue = !!(columnFilters?.[col.key]);
            const filterbar = col.filterable && onColumnFilterChange;
            const showResizer = !istTouch && columnConfig && col.resizable !== false && !col.elastic;
            return (
              <TableHead
                key={col.key}
                className={`relative ${col.sortable && onSort && !isOpen ? 'cursor-pointer select-none' : ''} ${col.kopfKlasse ?? ''}`}
                onClick={() => !isOpen && handleSort(col.key)}
              >
                <div className="flex items-center gap-1 min-w-0">
                  {filterbar && isOpen ? (
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
                    <span className="flex-1 truncate">
                      {col.label}
                      {sort === col.key && (order === 'asc'
                        ? <ArrowUp className="h-3 w-3 inline ml-1" />
                        : <ArrowDown className="h-3 w-3 inline ml-1" />)}
                    </span>
                  )}
                  {filterbar && (
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
                    onCommit={(px) => columnConfig.setWidth(col.key, px)}
                    onReset={() => columnConfig.resetWidth(col.key)}
                  />
                )}
              </TableHead>
            );
          })}
        </TableRow>
      </TableHeader>
      <TableBody>
        {daten.length === 0 && (
          <TableRow>
            <TableCell colSpan={spalten.length + (mitAuswahl ? 1 : 0)} className="h-32 text-center text-muted-foreground text-sm">
              {leerText}
            </TableCell>
          </TableRow>
        )}
        {daten.map((row) => {
          const id = row[zeilenKey];
          return (
            <TableRow
              key={id}
              className={cn(onZeile || mitAuswahl ? 'cursor-pointer' : '', mitAuswahl && auswahl.ids?.has(id) && 'bg-primary/8', zeilenKlasse?.(row))}
              onClick={() => (mitAuswahl ? auswahl.toggle(id) : onZeile?.(row))}
            >
              {mitAuswahl && (
                <TableCell className="w-[40px] text-center" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={auswahl.ids?.has(id) ?? false}
                    onChange={() => auswahl.toggle(id)}
                    className="h-4 w-4 cursor-pointer accent-primary"
                  />
                </TableCell>
              )}
              {spalten.map((col) => (
                <TableCell key={col.key} className={col.zellKlasse ?? 'overflow-hidden'}>
                  {inhalt(col, row, ctx)}
                </TableCell>
              ))}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
