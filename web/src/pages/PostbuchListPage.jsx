import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useZurueckZiel } from '@/hooks/useBackButtonGuard';
import { useSearchParams, useOutletContext, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { mobilScroller } from '@/lib/mobilScroller';
import { usePostbuchList, usePostbuchEndlos, usePostbuchKopf } from '@/hooks/usePostbuch';
import { useDarstellung } from '@/hooks/useDarstellung';
import { SeitenAktionen } from '@/hooks/useSeite';
import { useAddDocumentToAkte } from '@/hooks/useAkten';
import { useUndoHistory } from '@/hooks/useUndoHistory';
import { useExportJob } from '@/hooks/useExportJob';
import { api } from '@/api/client';
import { usePerPage } from '@/hooks/usePerPage';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useAuth } from '@/hooks/useAuth';
import { GlowHeading } from '@/components/ui/GlowHeading';
import { PostbuchTable, postbuchColumns } from '@/components/postbuch/PostbuchTable';
import { KARTE_EINHEITLICH_HOEHE, KARTEN_ABSTAND } from '@/components/listen/DataView';
import { ColumnSettings } from '@/components/table/ColumnSettings';
import { useColumnConfig } from '@/hooks/useColumnConfig';
import { FilterBar } from '@/components/postbuch/FilterBar';
import { SearchBar } from '@/components/search/SearchBar';
import { Pagination } from '@/components/ui/Pagination';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { PageLoader, EmptyState } from '@/components/ui/spinner';
import { ExportDialog } from '@/components/ExportDialog';
import { cn } from '@/lib/utils';
import { SlidersHorizontal, ArrowLeft, Archive, Download, X, ArrowUpDown, ArrowUp, Check, FilterX } from 'lucide-react';

// Sortierungen der mobilen Liste (die Tabelle sortiert per Spaltenkopf).
const MOBIL_SORTIERUNGEN = [
  { sort: 'postid', order: 'desc', label: 'Zuletzt erfasst' },
  { sort: 'postid', order: 'asc', label: 'Zuerst erfasst' },
  { sort: 'briefdatum', order: 'desc', label: 'Briefdatum, neueste zuerst' },
  { sort: 'briefdatum', order: 'asc', label: 'Briefdatum, älteste zuerst' },
  { sort: 'kontakt', order: 'asc', label: 'Kontakt A–Z' },
  { sort: 'betrag', order: 'desc', label: 'Betrag, höchster zuerst' },
  { sort: 'betrag', order: 'asc', label: 'Betrag, niedrigster zuerst' },
];
const SORTIERUNG_AEHNLICH = { sort: 'similarity', order: 'desc', label: 'Ähnlichkeit' };
const MOBIL_SEITE = 30;
// Desktop-Kartenumschaltung: Mindestbreite des Betreffs; zwei Kartenspalten ab @2xl
// (42rem) wie in KartenListe.
const BETREFF_MIN_BREITE = 240;
const KARTEN_ZWEISPALTIG_AB = 672;

export default function PostbuchListPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { showPdf, closePdf, angezeigtePdfId } = useOutletContext();
  const navigate = useNavigate();
  const { istMobil } = useDarstellung();
  const [filterVisible, setFilterVisible] = useState(false);
  const [sortSheetOffen, setSortSheetOffen] = useState(false);
  const [perPage, setPerPage] = usePerPage();
  const [showHistorisch, setShowHistorisch] = useState(false);
  const columnConfig = useColumnConfig('postbuch', postbuchColumns);

  // Aktenmodus: passed as URL query params so sorting/filtering don't lose the context
  const aktenmodusAkteId = searchParams.get('aktenmodusAkteId') || null;
  const aktenmodusBetreff = searchParams.get('aktenmodusBetreff') || null;
  const aktenmodusBackTo = searchParams.get('aktenmodusBackTo') || null;
  const addDocMutation = useAddDocumentToAkte();
  const [confirmAddPostId, setConfirmAddPostId] = useState(null);
  const [justAddedPostIds, setJustAddedPostIds] = useState(() => new Set());
  const { pushAction } = useUndoHistory();
  const qc = useQueryClient();

  // Ähnliche-Dokumente-Modus: similarToPostId passed as URL query param
  const similarToPostId = searchParams.get('similarToPostId') || null;
  const similarToBetreff = searchParams.get('similarToBetreff') || null;

  // Verbleib-Filter-Modus: Rücksprung zur Originale-Verwaltung
  const verbleibBackTo = searchParams.get('verbleibBackTo') || null;
  const verbleibLabel = searchParams.get('verbleibLabel') || null;
  // Zurück-Taste folgt dem Zurück-Knopf des aktiven Modus; das Archiv selbst hat keinen.
  const zurueckZiel = aktenmodusAkteId ? (aktenmodusBackTo || `/akten/${aktenmodusAkteId}`)
    : similarToPostId ? `/postbuch/${similarToPostId}`
    : verbleibBackTo;
  useZurueckZiel(!!zurueckZiel, () => navigate(zurueckZiel, { state: { zurueck: true } }));

  // ── Export state ──────────────────────────────────────────────────────────────
  const [showExportDialog, setShowExportDialog]   = useState(false);
  const [exportPhase, setExportPhase]             = useState('scope'); // 'scope' | 'format'
  const [exportScope, setExportScope]             = useState(null);    // 'page'|'selection'|'all'
  const [selectionMode, setSelectionMode]         = useState(false);
  const [selectedPostIds, setSelectedPostIds]     = useState(() => new Set());
  const { isExporting, exportProgress, runExport } = useExportJob();
  // Nur eigene Dokumente: Export ist für diese Konten gesperrt.
  const { istEingeschraenkt } = useAuth();

  const handleExportButtonClick = () => {
    setExportPhase('scope');
    setShowExportDialog(true);
  };

  const handleScopeChosen = (scope) => {
    if (scope === 'selection') {
      setSelectionMode(true);
      setSelectedPostIds(new Set());
      setShowExportDialog(false);
    } else {
      setExportScope(scope);
      setExportPhase('format');
    }
  };

  const handleToggleSelect = (postid) => {
    setSelectedPostIds(prev => {
      const next = new Set(prev);
      if (next.has(postid)) next.delete(postid);
      else next.add(postid);
      return next;
    });
  };

  const handleCancelSelection = () => {
    setSelectionMode(false);
    setSelectedPostIds(new Set());
  };

  const handleProceedWithSelection = () => {
    setExportScope('selection');
    setExportPhase('format');
    setShowExportDialog(true);
  };

  const handleExport = async (format) => {
    await runExport({
      format,
      resolvePostIds: async () => {
        if (exportScope === 'page') return zeilen.map(d => d.postid);
        if (exportScope === 'selection') return [...selectedPostIds];
        return api.export.fetchAllPostIds(apiFilters);
      },
    });
    setShowExportDialog(false);
    if (exportScope !== 'selection') setExportScope(null);
  };

  const handleCloseExportDialog = () => {
    if (isExporting) return;
    setShowExportDialog(false);
  };

  // --- Column filter state (cf_<column> in URL) ---
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

  // --- Auto page size via ResizeObserver ---
  const containerRef = useRef(null);
  const [containerHeight, setContainerHeight] = useState(
    () => (typeof window !== 'undefined' ? window.innerHeight - 220 : 400)
  );
  const [containerWidth, setContainerWidth] = useState(0);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      setContainerHeight(entry.contentRect.height);
      setContainerWidth(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Reicht die Breite nicht für alle sichtbaren Spalten plus einen lesbaren Betreff
  // (elastische Restspalte), zeigt die Liste Karten statt einer abgeschnittenen Tabelle.
  const tabelleMinBreite = columnConfig.columns
    .filter((c) => c.visible && !c.elastic)
    .reduce((summe, c) => summe + (c.width ?? c.defaultWidth ?? 0), 0)
    + (columnConfig.columns.some((c) => c.visible && c.elastic) ? BETREFF_MIN_BREITE : 0)
    + (selectionMode ? 40 : 0);
  const alsKarten = containerWidth > 0 && containerWidth < tabelleMinBreite;

  const TABLE_HEAD_H = 44; // h-11
  const ROW_H = 44;        // py-3 * 2 + text-sm line
  // Reserve ~7% of container height as buffer (rounded up) to avoid overflow
  const AUTO_BUFFER_PX = Math.ceil(containerHeight * 0.06);
  const autoRows = alsKarten
    // Einheitliche Kartenhöhe: n Reihen brauchen n·Höhe + (n−1)·Abstand, ohne Puffer.
    ? Math.max(2, Math.floor((containerHeight + KARTEN_ABSTAND) / (KARTE_EINHEITLICH_HOEHE + KARTEN_ABSTAND)))
      * (containerWidth >= KARTEN_ZWEISPALTIG_AB ? 2 : 1)
    : Math.max(5, Math.floor((containerHeight - TABLE_HEAD_H - AUTO_BUFFER_PX) / ROW_H));
  const effectivePerPage = perPage === 'auto' ? autoRows : Number(perPage);

  const personFromLegacyAdressat = searchParams.get('adressat') || undefined;
  const personFromUrl = searchParams.get('person') || personFromLegacyAdressat || undefined;
  const personAsAdressatParam = searchParams.get('person_as_adressat');
  const personAsPatientParam = searchParams.get('person_as_patient');

  const filtersFromUrl = {
    art: searchParams.get('art') || undefined,
    lebensbereich: searchParams.get('lebensbereich') || undefined,
    dokumentart: searchParams.get('dokumentart') || undefined,
    status: searchParams.get('status') || undefined,
    richtung: searchParams.get('richtung') || undefined,
    person: personFromUrl,
    person_as_adressat: personFromUrl
      ? (personAsAdressatParam ?? 'true')
      : undefined,
    person_as_patient: personFromUrl
      ? (personAsPatientParam ?? 'false')
      : undefined,
    von: searchParams.get('von') || undefined,
    bis: searchParams.get('bis') || undefined,
    unbezahlt: searchParams.get('unbezahlt') || undefined,
    mit_notiz: searchParams.get('mit_notiz') || undefined,
    in_akte: searchParams.get('in_akte') || undefined,
    offene_wiedervorlage: searchParams.get('offene_wiedervorlage') || undefined,
    fehlt_in_ablage: searchParams.get('fehlt_in_ablage') || undefined,
    verbleib_kategorie_id: searchParams.get('verbleib_kategorie_id') || undefined,
    verbleib_ablage_id: searchParams.get('verbleib_ablage_id') || undefined,
    verbleib_ohne_ablage: searchParams.get('verbleib_ohne_ablage') || undefined,
    original_urkunde: searchParams.get('original_urkunde') || undefined,
    q: searchParams.get('q') || undefined,
    sort: searchParams.get('sort') || (aktenmodusAkteId || similarToPostId ? 'similarity' : 'postid'),
    order: searchParams.get('order') || 'desc',
    limit: perPage,
    offset: parseInt(searchParams.get('offset') || '0', 10),
  };

  const [filters, setFilters] = useState(filtersFromUrl);

  // Build the actual API params including debounced column filters
  // Always use effectivePerPage (auto-computed or fixed) as the limit
  const apiFilters = useMemo(() => {
    const params = { ...filters, limit: effectivePerPage };
    for (const [k, v] of Object.entries(debouncedCF)) {
      if (v) params[`cf_${k}`] = v;
    }
    if (showHistorisch) {
      params.historisch = filters.historisch === 'only' ? 'only' : 'all';
    }
    if (aktenmodusAkteId) {
      params.excludeAkteId = aktenmodusAkteId;
      params.akteId = aktenmodusAkteId;
    }
    if (similarToPostId) {
      params.similarToPostId = similarToPostId;
    }
    return params;
  }, [filters, debouncedCF, effectivePerPage, aktenmodusAkteId, similarToPostId, showHistorisch]);

  // Write sort/order defaults into the URL on first load so that
  // navigate-back from a detail page always restores the correct sort.
  useEffect(() => {
    setSearchParams((current) => {
      if (current.get('sort')) return current; // already set – no-op
      const next = new URLSearchParams(current);
      next.set('sort', aktenmodusAkteId || similarToPostId ? 'similarity' : 'postid');
      next.set('order', next.get('order') || 'desc');
      return next;
    }, { replace: true });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync debounced column filters → URL (and reset to page 1)
  useEffect(() => {
    const cfStr = JSON.stringify(debouncedCF);
    const urlCfStr = JSON.stringify(cfFromUrl);
    if (cfStr !== urlCfStr) {
      setFilters((prev) => ({ ...prev, offset: 0 }));
      setSearchParams((current) => {
        const next = new URLSearchParams(current);
        // Remove all old cf_ params
        for (const key of [...next.keys()]) {
          if (key.startsWith(CF_PREFIX)) next.delete(key);
        }
        // Add current cf_ params
        for (const [k, v] of Object.entries(debouncedCF)) {
          if (v) next.set(`${CF_PREFIX}${k}`, v);
        }
        next.set('offset', '0');
        return next;
      }, { replace: true });
    }
  }, [debouncedCF]); // eslint-disable-line react-hooks/exhaustive-deps

  // Desktop blättert seitenweise, mobil endlos – immer nur eine der beiden Abfragen läuft.
  const seitenweise = usePostbuchList(apiFilters, { enabled: !istMobil });
  const endlosFilter = useMemo(() => ({ ...apiFilters, limit: MOBIL_SEITE }), [apiFilters]);
  const endlos = usePostbuchEndlos(endlosFilter, { enabled: istMobil });
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = endlos;
  const aktiv = istMobil ? endlos : seitenweise;
  const { isLoading, isFetching, error } = aktiv;
  const zeilen = useMemo(
    () => (istMobil
      ? (endlos.data?.pages ?? []).flatMap((s) => s.data)
      : (seitenweise.data?.data ?? [])
    ).filter((row) => !justAddedPostIds.has(row.postid)),
    [istMobil, endlos.data, seitenweise.data, justAddedPostIds],
  );
  const gesamt = (istMobil ? endlos.data?.pages[0]?.total : seitenweise.data?.total) ?? 0;
  const geladen = istMobil ? !!endlos.data : !!seitenweise.data;

  // Mobil: nachladen, sobald das Listenende in Sichtweite kommt.
  const endeRef = useRef(null);
  useEffect(() => {
    const el = endeRef.current;
    if (!istMobil || !el) return;
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting && hasNextPage && !isFetchingNextPage) fetchNextPage();
    }, { root: mobilScroller(), rootMargin: '800px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [istMobil, hasNextPage, isFetchingNextPage, fetchNextPage, zeilen.length]);

  // Mobil: neue Filter/Sortierung beginnen oben. Der erste Lauf bleibt aus,
  // sonst überschriebe er die Scroll-Wiederherstellung beim Zurückkehren.
  const ersterFilterLauf = useRef(true);
  useEffect(() => {
    if (ersterFilterLauf.current) { ersterFilterLauf.current = false; return; }
    if (istMobil) mobilScroller().scrollTo({ top: 0 });
  }, [endlosFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  // Mobil: neue Dokumente oben nicht ungefragt einschieben (die Liste springt
  // sonst unter dem Finger), sondern als Hinweis anbieten.
  const kopfAktiv = istMobil && filters.sort === 'postid' && filters.order === 'desc' && !!endlos.data;
  const { data: neuestePostid } = usePostbuchKopf(apiFilters, { enabled: kopfAktiv });
  const erstePostid = endlos.data?.pages[0]?.data[0]?.postid;
  const neueVorhanden = kopfAktiv && neuestePostid && erstePostid && neuestePostid !== erstePostid;
  const neueLaden = () => {
    mobilScroller().scrollTo({ top: 0, behavior: 'smooth' });
    qc.resetQueries({ queryKey: ['postbuch', 'endlos'] });
  };

  const activeFilterCount = [
    filters.art,
    filters.lebensbereich,
    filters.dokumentart,
    filters.status,
    filters.richtung,
    filters.person,
    filters.von || filters.bis,
    filters.unbezahlt,
    filters.mit_notiz,
    filters.in_akte,
    filters.offene_wiedervorlage,
    filters.fehlt_in_ablage,
    filters.historisch === 'only',
    filters.verbleib_kategorie_id,
    filters.verbleib_ablage_id,
    filters.original_urkunde,
  ].filter(Boolean).length;

  const updateFilters = (newFilters) => {
    setFilters(newFilters);
    const params = {};
    for (const [k, v] of Object.entries(newFilters)) {
      if (v != null && v !== '' && v !== undefined && k !== 'limit') {
        params[k] = String(v);
      }
    }
    // Preserve column filter params in URL
    for (const [k, v] of Object.entries(debouncedCF)) {
      if (v) params[`${CF_PREFIX}${k}`] = v;
    }
    // Preserve aktenmodus params so the banner/button survives sort & filter changes
    if (aktenmodusAkteId) {
      params.aktenmodusAkteId = aktenmodusAkteId;
      if (aktenmodusBetreff) params.aktenmodusBetreff = aktenmodusBetreff;
      if (aktenmodusBackTo) params.aktenmodusBackTo = aktenmodusBackTo;
    }
    if (similarToPostId) {
      params.similarToPostId = similarToPostId;
      if (similarToBetreff) params.similarToBetreff = similarToBetreff;
    }
    if (verbleibBackTo) {
      params.verbleibBackTo = verbleibBackTo;
      if (verbleibLabel) params.verbleibLabel = verbleibLabel;
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

  // Pagination helpers
  const total = gesamt;
  const totalPages = Math.max(1, Math.ceil(total / effectivePerPage));
  const currentPage = Math.floor(filters.offset / effectivePerPage) + 1;

  const handlePageChange = (page) => {
    const newOffset = (page - 1) * effectivePerPage;
    updateFilters({ ...filters, offset: newOffset });
  };

  const handlePerPageChange = (value, { automatisch = false } = {}) => {
    setPerPage(value); // 'auto' or number
    // Automatischer Rückfall auf Auto (zu schmale Leiste) behält die Position.
    if (!automatisch) updateFilters({ ...filters, offset: 0 }); // reset to page 1
  };

  // Auge schaltet um: erneuter Klick auf das angezeigte Dokument schließt das Panel.
  const handleShowPdf = useCallback(
    (postid) => (postid === angezeigtePdfId ? closePdf() : showPdf(postid, { closeable: true })),
    [showPdf, closePdf, angezeigtePdfId],
  );

  // Das im PDF-Panel angezeigte Dokument bleibt sichtbar, wenn sich das Layout ändert
  // (Tabelle ↔ Karten, ein- ↔ zweispaltig) – etwa weil das Panel selbst Breite nimmt –,
  // und ebenso nach dem Schließen des Panels, auch wenn zwischendurch weitergeblättert
  // wurde. Dabei ändert sich die automatische Seitengröße; gemerkt wird deshalb die
  // absolute Position des Dokuments in der Ergebnisliste (Offset der Antwort + Index).
  const pdfPositionRef = useRef(null);
  useEffect(() => {
    const antwort = seitenweise.data;
    if (istMobil || !angezeigtePdfId || !antwort || seitenweise.isPlaceholderData) return;
    const i = (antwort.data ?? []).findIndex((row) => row.postid === angezeigtePdfId);
    if (i >= 0) pdfPositionRef.current = { postid: angezeigtePdfId, index: (antwort.offset ?? 0) + i };
  }, [istMobil, angezeigtePdfId, seitenweise.data, seitenweise.isPlaceholderData]);

  const pdfScrollOffenRef = useRef(false);
  // Auf die Seite wechseln, die das Dokument mit der aktuellen Seitengröße enthält,
  // und es nach dem Laden in den sichtbaren Bereich holen.
  const richteAufDokumentAus = (postid) => {
    const pos = pdfPositionRef.current;
    if (istMobil || !postid || pos?.postid !== postid) return;
    pdfScrollOffenRef.current = true;
    const zielOffset = Math.floor(pos.index / effectivePerPage) * effectivePerPage;
    if (zielOffset !== filters.offset) updateFilters({ ...filters, offset: zielOffset });
  };

  // Nach dem Schließen bleibt das zuletzt angezeigte Dokument kurz Ziel, damit auch der
  // Layoutwechsel durch das wegfallende Panel noch darauf ausgerichtet wird.
  const [nachlaufPdfId, setNachlaufPdfId] = useState(null);
  const vorigePdfIdRef = useRef(angezeigtePdfId);
  useEffect(() => {
    const vorige = vorigePdfIdRef.current;
    vorigePdfIdRef.current = angezeigtePdfId;
    if (angezeigtePdfId || !vorige) { setNachlaufPdfId(null); return undefined; }
    setNachlaufPdfId(vorige);
    richteAufDokumentAus(vorige);
    const t = setTimeout(() => setNachlaufPdfId(null), 1500);
    return () => clearTimeout(t);
  }, [angezeigtePdfId]); // eslint-disable-line react-hooks/exhaustive-deps
  const zielPdfId = angezeigtePdfId ?? nachlaufPdfId;

  const kartenSpalten = alsKarten ? (containerWidth >= KARTEN_ZWEISPALTIG_AB ? 2 : 1) : 0;
  const layoutSchluessel = `${kartenSpalten}/${effectivePerPage}`;
  const letztesLayoutRef = useRef(layoutSchluessel);
  useEffect(() => {
    if (letztesLayoutRef.current === layoutSchluessel) return;
    letztesLayoutRef.current = layoutSchluessel;
    richteAufDokumentAus(zielPdfId);
  }, [layoutSchluessel]); // eslint-disable-line react-hooks/exhaustive-deps

  // Nach dem Seiten- bzw. Layoutwechsel die Zeile/Karte in den sichtbaren Bereich holen.
  useEffect(() => {
    // Erst mit den Daten der neuen Seite scrollen, nicht mit der vorigen als Platzhalter.
    if (!pdfScrollOffenRef.current || seitenweise.isPlaceholderData) return;
    const el = containerRef.current?.querySelector('.pdf-ziel');
    if (!el) return;
    pdfScrollOffenRef.current = false;
    el.scrollIntoView({ block: 'nearest' });
  }, [zeilen, layoutSchluessel, zielPdfId, seitenweise.isPlaceholderData]);

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


  const hinweise = (
    <>
      {aktenmodusAkteId && (
        <div className="mt-2 flex items-center gap-2 text-sm flex-wrap">
          <Badge className="bg-primary/10 text-primary border-primary/30">Aktenmodus</Badge>
          <span className="text-muted-foreground">
            Dokumente zur Akte <span className="font-semibold">„{aktenmodusBetreff}"</span> hinzufügen
          </span>
          <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => navigate(aktenmodusBackTo || `/akten/${aktenmodusAkteId}`)}>
            <ArrowLeft className="h-3.5 w-3.5" />
            Zurück zur Akte
          </Button>
        </div>
      )}
      {similarToPostId && (
        <div className="mt-2 flex items-center gap-2 text-sm flex-wrap">
          <Badge className="bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/20">Ähnliche Dokumente</Badge>
          <span className="text-muted-foreground">
            Ähnlich zu{' '}
            <span className="font-mono font-semibold">{similarToPostId}</span>
            {similarToBetreff && similarToBetreff !== similarToPostId && (
              <span className="ml-1">– {similarToBetreff}</span>
            )}
          </span>
          <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => navigate(`/postbuch/${similarToPostId}`)}>
            <ArrowLeft className="h-3.5 w-3.5" />
            Zurück zum Dokument
          </Button>
        </div>
      )}
      {verbleibBackTo && (
        <div className="mt-2 flex items-center gap-2 text-sm flex-wrap">
          <Badge className="bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20">Sammelmappe</Badge>
          <span className="text-muted-foreground">
            Dokumente der Sammelmappe{verbleibLabel && <span className="font-semibold"> „{verbleibLabel}"</span>}
          </span>
          <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => navigate(verbleibBackTo)}>
            <ArrowLeft className="h-3.5 w-3.5" />
            Zurück zu Originale
          </Button>
        </div>
      )}
    </>
  );

  const dialoge = (
    <>
      {/* Aktenmodus: confirmation dialog */}
      <Dialog open={!!confirmAddPostId} onOpenChange={() => setConfirmAddPostId(null)}>
        <DialogTitle>Dokument zur Akte hinzufügen?</DialogTitle>
        <DialogDescription>
          Soll <span className="font-mono font-semibold">{confirmAddPostId}</span> zur Akte
          <span className="font-semibold"> „{aktenmodusBetreff}"</span> hinzugefügt werden?
        </DialogDescription>
        <DialogFooter>
          <Button variant="outline" onClick={() => setConfirmAddPostId(null)}>Abbrechen</Button>
          <Button
            onClick={async () => {
              try {
                const postIdToAdd = confirmAddPostId;
                const akteId = aktenmodusAkteId;
                setConfirmAddPostId(null);
                // Sofort aus der Liste entfernen (optimistisch)
                setJustAddedPostIds(prev => new Set([...prev, postIdToAdd]));
                addDocMutation.mutateAsync({ akteid: akteId, postid: postIdToAdd })
                  .then(() => {
                    qc.invalidateQueries({ queryKey: ['postbuch'] });
                    pushAction(
                      `Dokument ${postIdToAdd} zur Akte hinzugefügt`,
                      async () => { await api.akten.removeDocument(akteId, postIdToAdd); qc.invalidateQueries({ queryKey: ['akten'] }); },
                      async () => { await api.akten.addDocument(akteId, postIdToAdd); qc.invalidateQueries({ queryKey: ['akten'] }); },
                    );
                  })
                  .catch(err => {
                    // Optimistic update rückgängig machen bei Fehler
                    setJustAddedPostIds(prev => { const s = new Set(prev); s.delete(postIdToAdd); return s; });
                    console.error('Add to akte error:', err);
                  });
              } catch (err) {
                console.error('Add to akte error:', err);
              }
            }}
            disabled={addDocMutation.isPending}
          >
            {addDocMutation.isPending ? 'Wird hinzugefügt…' : 'Hinzufügen'}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* Export Dialog */}
      <ExportDialog
        open={showExportDialog}
        onClose={handleCloseExportDialog}
        phase={exportPhase}
        pageCount={zeilen.length}
        totalCount={gesamt}
        selectionCount={selectedPostIds.size}
        exportCount={
          exportScope === 'selection' ? selectedPostIds.size
          : exportScope === 'page'   ? zeilen.length
          :                            gesamt
        }
        allowPageScope={!istMobil}
        isAkte={false}
        onScopeChosen={handleScopeChosen}
        onExport={handleExport}
        isExporting={isExporting}
        exportProgress={exportProgress}
      />
    </>
  );

  if (istMobil) {
    const sortierungen = similarToPostId || aktenmodusAkteId
      ? [SORTIERUNG_AEHNLICH, ...MOBIL_SORTIERUNGEN]
      : MOBIL_SORTIERUNGEN;
    const aktSortierung = sortierungen.find((o) => o.sort === filters.sort && o.order === filters.order);
    const spaltenfilterAktiv = Object.values(columnFilters).some(Boolean);
    return (
      <div className="space-y-3">
        <SeitenAktionen>
          <button
            onClick={() => {
              const next = !showHistorisch;
              setShowHistorisch(next);
              if (!next && filters.historisch === 'only') {
                updateFilters({ ...filters, historisch: undefined, offset: 0 });
              }
            }}
            aria-pressed={showHistorisch}
            title={showHistorisch ? 'Historische Dokumente ausblenden' : 'Historische Dokumente einblenden'}
            className={cn('grid h-10 w-10 place-items-center rounded-full transition-colors', showHistorisch ? 'bg-primary/10 text-primary' : 'text-muted-foreground')}
          >
            <Archive className="h-5 w-5" />
          </button>
          {!aktenmodusAkteId && !istEingeschraenkt && (
            <button
              onClick={handleExportButtonClick}
              title="Dokumente exportieren"
              className="grid h-10 w-10 place-items-center rounded-full text-muted-foreground"
            >
              <Download className="h-5 w-5" />
            </button>
          )}
        </SeitenAktionen>

        <GlowHeading>Dokumentenarchiv</GlowHeading>
        {hinweise}

        <SearchBar
          aktenmodusAkteId={aktenmodusAkteId}
          aktenmodusBetreff={aktenmodusBetreff}
          aktenmodusBackTo={aktenmodusBackTo}
        />

        <div className="flex items-center gap-2">
          <Button
            variant={activeFilterCount ? 'secondary' : 'outline'}
            size="sm"
            onClick={() => setFilterVisible(true)}
            className="h-9 gap-1.5 rounded-full"
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
            Filter
            {activeFilterCount > 0 && (
              <span className="grid h-5 min-w-5 place-items-center rounded-full bg-primary px-1 text-[11px] font-bold text-primary-foreground">
                {activeFilterCount}
              </span>
            )}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setSortSheetOffen(true)} className="h-9 min-w-0 gap-1.5 rounded-full">
            <ArrowUpDown className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{aktSortierung?.label ?? 'Sortierung'}</span>
          </Button>
          {spaltenfilterAktiv && (
            <Button
              variant="secondary" size="sm" className="h-9 gap-1.5 rounded-full"
              onClick={() => handleColumnFilterChange('__clear_all__')}
              title="Spaltenfilter aus der Tabellenansicht entfernen"
            >
              <FilterX className="h-3.5 w-3.5" />
            </Button>
          )}
          {geladen && (
            <span className="ml-auto flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
              {isFetching && !isLoading && !isFetchingNextPage && (
                <span className="inline-block h-3 w-3 rounded-full border-2 border-primary border-t-transparent animate-spin" />
              )}
              {gesamt} Dokumente
            </span>
          )}
        </div>

        {selectionMode && (
          <div
            className="sticky z-10 -mx-3 flex items-center gap-2 border-y border-primary/20 bg-background/95 px-3 py-2 text-sm backdrop-blur"
            style={{ top: 0 }}
          >
            <span className="flex-1 text-muted-foreground">
              {selectedPostIds.size > 0
                ? <><span className="font-semibold text-foreground">{selectedPostIds.size}</span> ausgewählt</>
                : 'Dokumente antippen…'}
            </span>
            <Button size="sm" onClick={handleProceedWithSelection} disabled={selectedPostIds.size === 0} className="gap-1.5">
              <Download className="h-3.5 w-3.5" />
              Exportieren
            </Button>
            <button onClick={handleCancelSelection} className="grid h-9 w-9 place-items-center text-muted-foreground" title="Auswahlmodus beenden">
              <X className="h-5 w-5" />
            </button>
          </div>
        )}

        {neueVorhanden && (
          <div className="sticky z-10 flex justify-center" style={{ top: '0.5rem' }}>
            <button
              onClick={neueLaden}
              className="flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-lg shadow-primary/30"
            >
              <ArrowUp className="h-4 w-4" />
              Neue Dokumente
            </button>
          </div>
        )}

        {isLoading ? (
          <PageLoader />
        ) : error ? (
          <p className="p-6 text-destructive">Fehler: {error.message}</p>
        ) : (
          <>
            <PostbuchTable
              data={zeilen}
              sort={filters.sort}
              order={filters.order}
              onShowPdf={handleShowPdf}
              angezeigtePdfId={angezeigtePdfId}
              aktenmodusAkteId={aktenmodusAkteId}
              aktenmodusBetreff={aktenmodusBetreff}
              aktenmodusBackTo={aktenmodusBackTo}
              onAddToAkte={aktenmodusAkteId ? setConfirmAddPostId : undefined}
              similarToPostId={similarToPostId}
              selectionMode={selectionMode}
              selectedIds={selectedPostIds}
              onToggleSelect={handleToggleSelect}
            />
            <div ref={endeRef} className="flex h-16 items-center justify-center text-xs text-muted-foreground">
              {isFetchingNextPage
                ? <span className="inline-block h-5 w-5 rounded-full border-2 border-primary border-t-transparent animate-spin" />
                : (!hasNextPage && zeilen.length > 0 ? `${zeilen.length === gesamt ? 'Alle' : zeilen.length} Dokumente geladen` : null)}
            </div>
          </>
        )}

        <Dialog open={filterVisible} onOpenChange={setFilterVisible}>
          <FilterBar
            filters={filters}
            onChange={updateFilters}
            onClose={() => setFilterVisible(false)}
            showHistorisch={showHistorisch}
          />
        </Dialog>

        <Dialog open={sortSheetOffen} onOpenChange={setSortSheetOffen}>
          <DialogTitle>Sortierung</DialogTitle>
          <div className="mt-3 -mx-1">
            {sortierungen.map((o) => {
              const aktiv = o === aktSortierung;
              return (
                <button
                  key={o.sort + o.order}
                  onClick={() => { setSortSheetOffen(false); handleSort(o.sort, o.order); }}
                  className={cn('flex h-12 w-full items-center gap-3 rounded-lg px-3 text-left text-[15px]', aktiv ? 'bg-primary/10 font-medium text-primary' : 'active:bg-muted')}
                >
                  <span className="flex-1">{o.label}</span>
                  {aktiv && <Check className="h-4 w-4" />}
                </button>
              );
            })}
          </div>
        </Dialog>

        {dialoge}
      </div>
    );
  }

  return (
    <div className="flex h-full">
      {/* Sidebar Filters – conditionally rendered to reliably reclaim width */}
      {filterVisible && (
        <aside className="w-72 border-r border-border/60 bg-sidebar flex-shrink-0 h-full overflow-y-auto">
          <FilterBar
            filters={filters}
            onChange={updateFilters}
            onClose={() => setFilterVisible(false)}
            showHistorisch={showHistorisch}
          />
        </aside>
      )}

      {/* Main Content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Page title */}
        <div className="px-5 pt-4 pb-1">
          <GlowHeading>Dokumentenarchiv</GlowHeading>
          {hinweise}
        </div>
        {/* Header */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 py-3.5 border-b border-border/60 bg-card">
          {!filterVisible && (
            <div className="relative">
              <Button
                variant={activeFilterCount ? 'secondary' : 'outline'}
                size="sm"
                onClick={() => setFilterVisible(true)}
                title="Filter einblenden"
                className="flex-shrink-0 gap-1.5"
              >
                <SlidersHorizontal className="h-3.5 w-3.5" />
                Filter
              </Button>
              {activeFilterCount > 0 && (
                <span className="absolute -top-1 -right-1 inline-flex items-center justify-center h-5 w-5 rounded-full bg-primary text-primary-foreground text-[11px] font-bold">
                  {activeFilterCount}
                </span>
              )}
            </div>
          )}
          <SearchBar
            aktenmodusAkteId={aktenmodusAkteId}
            aktenmodusBetreff={aktenmodusBetreff}
            aktenmodusBackTo={aktenmodusBackTo}
          />
          {geladen && (
            <span className="text-sm text-muted-foreground whitespace-nowrap ml-auto flex items-center gap-2">
              {isFetching && !isLoading && (
                <span className="inline-block h-3 w-3 rounded-full border-2 border-primary border-t-transparent animate-spin" />
              )}
              {gesamt} Dokumente
            </span>
          )}
          <button
            onClick={() => {
              const next = !showHistorisch;
              setShowHistorisch(next);
              // Toggling off historisch also clears "nur historische" filter
              if (!next && filters.historisch === 'only') {
                updateFilters({ ...filters, historisch: undefined, offset: 0 });
              }
            }}
            title={showHistorisch ? 'Historische Dokumente ausblenden' : 'Historische Dokumente einblenden'}
            className={`flex-shrink-0 p-1.5 rounded-md transition-colors ${showHistorisch ? 'text-primary bg-primary/10' : 'text-muted-foreground/40 hover:text-muted-foreground hover:bg-muted/50'}`}
          >
            <Archive className="h-4 w-4" />
          </button>
          <ColumnSettings
            columns={columnConfig.columns}
            visibleCount={columnConfig.visibleCount}
            onToggle={columnConfig.toggleVisible}
            onReset={columnConfig.reset}
          />
          {!aktenmodusAkteId && !istEingeschraenkt && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleExportButtonClick}
              className="flex-shrink-0 gap-1.5"
              title="Dokumente exportieren"
            >
              <Download className="h-3.5 w-3.5" />
              Export
            </Button>
          )}
        </div>

        {/* Selection mode toolbar */}
        {selectionMode && (
          <div className="flex items-center gap-3 px-5 py-2 bg-primary/5 border-b border-primary/20 text-sm">
            <Badge className="bg-primary/10 text-primary border-primary/30 font-medium">Auswahlmodus</Badge>
            <span className="text-muted-foreground">
              {selectedPostIds.size > 0
                ? <><span className="font-semibold text-foreground">{selectedPostIds.size}</span> Dokument{selectedPostIds.size !== 1 ? 'e' : ''} ausgewählt</>
                : 'Dokumente per Checkbox auswählen…'
              }
            </span>
            <div className="ml-auto flex items-center gap-2">
              <Button
                size="sm"
                onClick={handleProceedWithSelection}
                disabled={selectedPostIds.size === 0}
                className="gap-1.5"
              >
                <Download className="h-3.5 w-3.5" />
                Exportieren ({selectedPostIds.size})
              </Button>
              <button
                onClick={handleCancelSelection}
                className="p-1 text-muted-foreground hover:text-foreground transition-colors"
                title="Auswahlmodus beenden"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}

        {/* Table */}
        <div ref={containerRef} className={cn('flex-1 overflow-auto', alsKarten && 'px-4 py-3')}>
          {isLoading ? (
            <PageLoader />
          ) : error ? (
            <p className="p-6 text-destructive">Fehler: {error.message}</p>
          ) : (
            <PostbuchTable
              data={zeilen}
              sort={filters.sort}
              order={filters.order}
              onSort={handleSort}
              onShowPdf={handleShowPdf}
              angezeigtePdfId={angezeigtePdfId}
              zielPdfId={zielPdfId}
              columnFilters={columnFilters}
              onColumnFilterChange={handleColumnFilterChange}
              aktenmodusAkteId={aktenmodusAkteId}
              aktenmodusBetreff={aktenmodusBetreff}
              aktenmodusBackTo={aktenmodusBackTo}
              onAddToAkte={aktenmodusAkteId ? setConfirmAddPostId : undefined}
              similarToPostId={similarToPostId}
              selectionMode={selectionMode}
              selectedIds={selectedPostIds}
              onToggleSelect={handleToggleSelect}
              columnConfig={columnConfig}
              alsKarten={alsKarten}
            />
          )}
        </div>

        {/* Pagination bottom */}
        {showPagination && !isLoading && (
          <div className="px-5 py-2 border-t border-border/60 bg-card">
            <Pagination {...paginationProps} />
          </div>
        )}
      </div>

      {dialoge}
    </div>
  );
}
