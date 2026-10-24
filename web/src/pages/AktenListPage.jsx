import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useSearchParams, useNavigate, useLocation, useOutletContext } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useAktenList, useCreateAkte, useAddDocumentToAkte } from '@/hooks/useAkten';
import { useUndoHistory } from '@/hooks/useUndoHistory';
import { api } from '@/api/client';
import { usePerPage } from '@/hooks/usePerPage';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { Pagination } from '@/components/ui/Pagination';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DataView } from '@/components/listen/DataView';
import { ColumnSettings } from '@/components/table/ColumnSettings';
import { useColumnConfig } from '@/hooks/useColumnConfig';
import { useDarstellung } from '@/hooks/useDarstellung';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { PageLoader, EmptyState } from '@/components/ui/spinner';
import { formatRelativeTime } from '@/lib/utils';
import { FolderOpen, Plus, Search, CalendarClock, Archive } from 'lucide-react';

// Kanonische Spaltendefinition (Single-Point-of-Truth); `elastic` schluckt die Restbreite.
// `zelle`/`mobil` siehe DataView: dieselbe Definition liefert Tabelle und Karte.
const aktenColumns = [
  { key: 'akteid', label: 'ID', sortable: true, filterable: true, defaultWidth: 88, minWidth: 64,
    mobil: 'meta', zellKlasse: 'font-mono text-xs overflow-hidden',
    zelle: (row, { istMobil }) => istMobil ? <span className="font-mono">{row.akteid}</span> : row.akteid },
  { key: 'betreff', label: 'Betreff', sortable: true, filterable: true, elastic: true,
    mobil: 'titel', zellKlasse: 'truncate',
    zelle: (row) => (
      <span className="inline-flex max-w-full items-center gap-1.5">
        {row.historisch && <Archive className="h-3 w-3 flex-shrink-0 text-muted-foreground" title="Historisch" />}
        <span className="truncate">{row.betreff || '–'}</span>
        {row.wv_active_count > 0 && (
          <CalendarClock className="h-3.5 w-3.5 flex-shrink-0 text-amber-500" title={`${row.wv_active_count} aktive Wiedervorlage${row.wv_active_count > 1 ? 'n' : ''}`} />
        )}
      </span>
    ) },
  { key: 'dok_count', label: 'Dokumente', defaultWidth: 108, minWidth: 80,
    mobil: 'rechts', zellKlasse: 'text-center overflow-hidden',
    zelle: (row, { istMobil }) => istMobil
      ? <span className="text-xs font-medium text-muted-foreground">{row.dok_count} Dok.</span>
      : <Badge variant="secondary" className="text-xs">{row.dok_count}</Badge> },
  { key: 'schlagwoerter', label: 'Schlagwörter', defaultWidth: 220, minWidth: 110,
    mobil: 'badges', zellKlasse: 'overflow-hidden whitespace-nowrap',
    zelle: (row) => {
      const sw = row.schlagwoerter || [];
      if (sw.length === 0) return null;
      return (
        <div className="flex gap-1 items-center overflow-hidden whitespace-nowrap">
          {sw.slice(0, 3).map((w) => (
            <Badge key={w} variant="outline" className="text-[10px] truncate">{w}</Badge>
          ))}
          {sw.length > 3 && <Badge variant="outline" className="text-[10px]">+{sw.length - 3}</Badge>}
        </div>
      );
    } },
  { key: 'updated_at', label: 'Aktualisiert', sortable: true, defaultWidth: 128, minWidth: 96,
    mobil: 'meta', zellKlasse: 'text-xs text-muted-foreground whitespace-nowrap overflow-hidden',
    zelle: (row) => formatRelativeTime(row.updated_at) },
];

const spalteEinfuegen = {
  key: '_select', label: '', width: 128, resizable: false, mobil: 'aktion',
  zelle: (row, { onSelectAkte }) => (
    <Button
      size="sm"
      variant="secondary"
      onClick={(e) => { e.stopPropagation(); onSelectAkte(row); }}
      className="text-xs"
    >
      Hier einfügen
    </Button>
  ),
};

const MOBIL_AKTEN = 200;

function AktenTable({ data, sort, order, onSort, columnFilters, onColumnFilterChange, onRowClick, aktenwahlPostId, onSelectAkte, columnConfig }) {
  const { istMobil } = useDarstellung();
  // Desktop: Nutzer-Konfiguration; mobil zählt nur `mobil` der Spalte.
  const basis = istMobil
    ? aktenColumns
    : (columnConfig?.columns ?? aktenColumns.map((c) => ({ ...c, visible: true, width: c.defaultWidth ?? null })))
        .filter((c) => c.visible);
  const spalten = aktenwahlPostId ? [...basis, spalteEinfuegen] : basis;

  return (
    <DataView
      spalten={spalten}
      daten={data}
      zeilenKey="akteid"
      onZeile={onRowClick}
      ctx={{ istMobil, onSelectAkte }}
      leerText="Keine Akten gefunden."
      zeilenKlasse={(row) => (row.historisch ? 'opacity-50' : '')}
      sort={sort}
      order={order}
      onSort={onSort}
      columnFilters={columnFilters}
      onColumnFilterChange={onColumnFilterChange}
      columnConfig={columnConfig}
    />
  );
}

export default function AktenListPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { closePdf } = useOutletContext();
  const [perPage, setPerPage] = usePerPage();
  const { istMobil } = useDarstellung();
  const columnConfig = useColumnConfig('akten', aktenColumns);

  // Aktenwahlmodus: a postid is passed when user wants to add a document to an akte
  const aktenwahlPostId = location.state?.aktenwahlPostId || null;
  const aktenwahlBackTo = location.state?.aktenwahlBackTo || null;

  // Column filters
  const CF_PREFIX = 'cf_';
  const cfFromUrl = useMemo(() => {
    const cf = {};
    for (const [k, v] of searchParams.entries()) {
      if (k.startsWith(CF_PREFIX) && v) cf[k.slice(CF_PREFIX.length)] = v;
    }
    return cf;
  }, [searchParams]);
  const [columnFilters, setColumnFilters] = useState(cfFromUrl);
  const debouncedCF = useDebouncedValue(columnFilters, 100);

  // Auto page size
  const containerRef = useRef(null);
  const [containerHeight, setContainerHeight] = useState(
    () => (typeof window !== 'undefined' ? window.innerHeight - 220 : 400)
  );
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setContainerHeight(entry.contentRect.height));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const ROW_H = 44;
  const TABLE_HEAD_H = 44;
  // Reserve ~5.5% of container height as buffer (rounded up) to avoid overflow
  const AUTO_BUFFER_PX = Math.ceil(containerHeight * 0.06);
  const autoRows = Math.max(5, Math.floor((containerHeight - TABLE_HEAD_H - AUTO_BUFFER_PX) / ROW_H));
  // Mobil: Karten in einem Stück (Akten sind wenige; 200 = Höchstgrenze der API).
  const effectivePerPage = istMobil ? MOBIL_AKTEN : perPage === 'auto' ? autoRows : Number(perPage);

  const filtersFromUrl = {
    q: searchParams.get('q') || undefined,
    sort: searchParams.get('sort') || 'updated_at',
    order: searchParams.get('order') || 'desc',
    limit: perPage,
    offset: parseInt(searchParams.get('offset') || '0', 10),
  };
  const [filters, setFilters] = useState(filtersFromUrl);

  // Archiv-Anzeige (historische Akten)
  const [showHistorisch, setShowHistorisch] = useState(false);

  const apiFilters = useMemo(() => {
    const params = { ...filters, limit: effectivePerPage };
    if (showHistorisch) params.historisch = 'all';
    for (const [k, v] of Object.entries(debouncedCF)) {
      if (v) params[`cf_${k}`] = v;
    }
    return params;
  }, [filters, debouncedCF, effectivePerPage, showHistorisch]);

  // Sync column filters to URL
  useEffect(() => {
    const cfStr = JSON.stringify(debouncedCF);
    const urlCfStr = JSON.stringify(cfFromUrl);
    if (cfStr !== urlCfStr) {
      setFilters((prev) => ({ ...prev, offset: 0 }));
      setSearchParams((current) => {
        const next = new URLSearchParams(current);
        for (const key of [...next.keys()]) {
          if (key.startsWith(CF_PREFIX)) next.delete(key);
        }
        for (const [k, v] of Object.entries(debouncedCF)) {
          if (v) next.set(`${CF_PREFIX}${k}`, v);
        }
        next.set('offset', '0');
        return next;
      }, { replace: true });
    }
  }, [debouncedCF]); // eslint-disable-line react-hooks/exhaustive-deps

  const { data, isLoading, isFetching, error } = useAktenList(apiFilters);

  const [searchInput, setSearchInput] = useState(filters.q || '');
  const debouncedQ = useDebouncedValue(searchInput, 300);
  useEffect(() => {
    if (debouncedQ !== (filters.q || '')) {
      updateFilters({ ...filters, q: debouncedQ || undefined, offset: 0 });
    }
  }, [debouncedQ]); // eslint-disable-line react-hooks/exhaustive-deps

  // New akte dialog
  const [showNewDialog, setShowNewDialog] = useState(false);
  const [newBetreff, setNewBetreff] = useState('');
  const createAkte = useCreateAkte();

  // Aktenwahlmodus confirmation
  const [confirmAkte, setConfirmAkte] = useState(null);
  const addDocToAkteMutation = useAddDocumentToAkte();
  const { pushAction } = useUndoHistory();
  const qc = useQueryClient();

  useEffect(() => { closePdf(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const updateFilters = (newFilters) => {
    setFilters(newFilters);
    const params = {};
    for (const [k, v] of Object.entries(newFilters)) {
      if (v != null && v !== '' && v !== undefined && k !== 'limit') {
        params[k] = String(v);
      }
    }
    for (const [k, v] of Object.entries(debouncedCF)) {
      if (v) params[`${CF_PREFIX}${k}`] = v;
    }
    setSearchParams(params, { replace: true });
  };

  const handleSort = (key, direction) => {
    updateFilters({ ...filters, sort: key, order: direction });
  };

  const handleColumnFilterChange = useCallback((key, value) => {
    if (key === '__clear_all__') {
      setColumnFilters({});
    } else {
      setColumnFilters((prev) => {
        const next = { ...prev };
        if (value) next[key] = value;
        else delete next[key];
        return next;
      });
    }
  }, []);

  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / effectivePerPage));
  const currentPage = Math.floor(filters.offset / effectivePerPage) + 1;

  const handlePageChange = (page) => {
    updateFilters({ ...filters, offset: (page - 1) * effectivePerPage });
  };

  const handlePerPageChange = (value, { automatisch = false } = {}) => {
    setPerPage(value);
    if (!automatisch) updateFilters({ ...filters, offset: 0 });
  };

  const handleCreateAkte = async () => {
    if (!newBetreff.trim()) return;
    try {
      const akte = await createAkte.mutateAsync({ betreff: newBetreff.trim() });
      setShowNewDialog(false);
      setNewBetreff('');
      pushAction(
        `Akte „${akte.betreff}" erstellt`,
        async () => { await api.akten.delete(akte.akteid); qc.invalidateQueries({ queryKey: ['akten'] }); navigate('/akten'); },
        async () => { const re = await api.akten.create({ betreff: akte.betreff }); qc.invalidateQueries({ queryKey: ['akten'] }); navigate(`/akten/${re.akteid}`); },
      );
      navigate(`/akten/${akte.akteid}`);
    } catch (err) {
      console.error('Create akte error:', err);
    }
  };

  const handleRowClick = (row) => {
    if (aktenwahlPostId) {
      // In Aktenwahlmodus: navigate to akte detail to allow insertion there
      navigate(`/akten/${row.akteid}`, {
        state: { aktenwahlPostId, aktenwahlBackTo },
      });
    } else {
      navigate(`/akten/${row.akteid}`);
    }
  };

  const handleSelectAkte = async (akte) => {
    setConfirmAkte(akte);
  };

  const handleConfirmInsert = async () => {
    if (!confirmAkte || !aktenwahlPostId) return;
    const akteToInsert = confirmAkte;
    try {
      await addDocToAkteMutation.mutateAsync({ akteid: akteToInsert.akteid, postid: aktenwahlPostId });
      setConfirmAkte(null);
      pushAction(
        `Dokument ${aktenwahlPostId} zur Akte hinzugefügt`,
        async () => { await api.akten.removeDocument(akteToInsert.akteid, aktenwahlPostId); qc.invalidateQueries({ queryKey: ['akten'] }); },
        async () => { await api.akten.addDocument(akteToInsert.akteid, aktenwahlPostId); qc.invalidateQueries({ queryKey: ['akten'] }); },
      );
      // Navigate back to document
      if (aktenwahlBackTo) {
        navigate(aktenwahlBackTo);
      } else {
        navigate(`/postbuch/${aktenwahlPostId}`);
      }
    } catch (err) {
      console.error('Add document to akte error:', err);
    }
  };

  const showPagination = total > effectivePerPage || totalPages > 1;

  const paginationProps = {
    page: currentPage,
    totalPages,
    perPage: effectivePerPage,
    perPageRaw: perPage,
    autoRows,
    total,
    onPageChange: handlePageChange,
    onPerPageChange: handlePerPageChange,
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden h-full">
      {/* Aktenwahlmodus-Banner */}
      {aktenwahlPostId && (
        <div className="px-5 pt-3 pb-1">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge className="bg-primary/10 text-primary border-primary/30">Aktenwahlmodus</Badge>
            <span className="text-muted-foreground">
              Wählen Sie eine Akte für Dokument <span className="font-mono font-semibold">{aktenwahlPostId}</span>
            </span>
            <Button variant="ghost" size="sm" onClick={() => {
              if (aktenwahlBackTo) navigate(aktenwahlBackTo);
              else navigate(`/postbuch/${aktenwahlPostId}`);
            }}>
              Abbrechen
            </Button>
          </div>
        </div>
      )}

      <div className="flex items-center gap-3 px-5 py-3.5 border-b border-border/60 bg-card max-sm:gap-2 max-sm:px-4">
        <div className="relative flex-1 max-w-sm min-w-0">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            type="text"
            placeholder="Akten durchsuchen…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="pl-9 h-9"
          />
        </div>
        <Button size="sm" onClick={() => setShowNewDialog(true)} className="gap-1.5" title="Neue Akte">
          <Plus className="h-3.5 w-3.5" />
          <span className="max-sm:sr-only">Neue Akte</span>
        </Button>
        <button
          onClick={() => setShowHistorisch(!showHistorisch)}
          title={showHistorisch ? 'Historische Akten ausblenden' : 'Historische Akten einblenden'}
          className={`flex-shrink-0 p-1.5 rounded-md transition-colors ${showHistorisch ? 'text-primary bg-primary/10' : 'text-muted-foreground/40 hover:text-muted-foreground hover:bg-muted/50'}`}
        >
          <Archive className="h-4 w-4" />
        </button>
        {!istMobil && (
          <ColumnSettings
            columns={columnConfig.columns}
            visibleCount={columnConfig.visibleCount}
            onToggle={columnConfig.toggleVisible}
            onReset={columnConfig.reset}
          />
        )}
        {data && (
          <span className="text-sm text-muted-foreground whitespace-nowrap ml-auto flex items-center gap-2 max-sm:text-xs">
            {isFetching && !isLoading && (
              <span className="inline-block h-3 w-3 rounded-full border-2 border-primary border-t-transparent animate-spin" />
            )}
            {data.total} Akten
          </span>
        )}
      </div>

      {/* Table */}
      <div ref={containerRef} className={`flex-1 overflow-auto ${istMobil ? 'p-3' : ''}`}>
        {isLoading ? (
          <PageLoader />
        ) : error ? (
          <p className="p-6 text-destructive">Fehler: {error.message}</p>
        ) : data?.data?.length === 0 && !filters.q ? (
          <EmptyState icon={FolderOpen} title="Noch keine Akten" description="Erstellen Sie Ihre erste Akte, um Dokumente zu gruppieren.">
            <Button size="sm" onClick={() => setShowNewDialog(true)} className="gap-1.5">
              <Plus className="h-3.5 w-3.5" />
              Neue Akte
            </Button>
          </EmptyState>
        ) : (
          <AktenTable
            data={data?.data ?? []}
            sort={filters.sort}
            order={filters.order}
            onSort={handleSort}
            columnFilters={columnFilters}
            onColumnFilterChange={handleColumnFilterChange}
            onRowClick={handleRowClick}
            aktenwahlPostId={aktenwahlPostId}
            onSelectAkte={handleSelectAkte}
            columnConfig={columnConfig}
          />
        )}
      </div>

      {/* Pagination */}
      {showPagination && !isLoading && (
        <div className="px-5 py-2 border-t border-border/60 bg-card">
          <Pagination {...paginationProps} />
        </div>
      )}

      {/* New Akte Dialog */}
      <Dialog open={showNewDialog} onOpenChange={setShowNewDialog}>
        <DialogTitle>Neue Akte anlegen</DialogTitle>
        <DialogDescription>Geben Sie einen Betreff für die neue Akte ein.</DialogDescription>
        <div className="mt-4">
          <Input
            autoFocus
            placeholder="Betreff der Akte…"
            value={newBetreff}
            onChange={(e) => setNewBetreff(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCreateAkte()}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => { setShowNewDialog(false); setNewBetreff(''); }}>
            Abbrechen
          </Button>
          <Button onClick={handleCreateAkte} disabled={!newBetreff.trim() || createAkte.isPending}>
            {createAkte.isPending ? 'Wird angelegt…' : 'Anlegen'}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* Aktenwahlmodus Confirmation Dialog */}
      <Dialog open={!!confirmAkte} onOpenChange={() => setConfirmAkte(null)}>
        <DialogTitle>Dokument in Akte einfügen?</DialogTitle>
        <DialogDescription>
          Soll <span className="font-mono font-semibold">{aktenwahlPostId}</span> in die Akte
          <span className="font-semibold"> „{confirmAkte?.betreff}"</span> eingefügt werden?
        </DialogDescription>
        <DialogFooter>
          <Button variant="outline" onClick={() => setConfirmAkte(null)}>Abbrechen</Button>
          <Button onClick={handleConfirmInsert}>Einfügen</Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
