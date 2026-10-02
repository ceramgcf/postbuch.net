import { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Document, Page, pdfjs } from 'react-pdf';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Progress } from '@/components/ui/progress';
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut, ExternalLink, Download, X, RotateCcw, RotateCw, RefreshCw, Printer } from 'lucide-react';
import { api } from '@/api/client';
import { useAuth } from '@/hooks/useAuth';
import { usePostbuchDetail } from '@/hooks/usePostbuch';
import { buildPdfFilename } from '@/lib/pdf-filename';
import { printPdf, printPdfBytes } from '@/lib/pdf-print';

import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

const formatMB = (bytes) => (bytes / (1024 * 1024)).toFixed(1).replace('.', ',');

// Wird von <Document loading={...}> gerendert, solange pdf.js die Datei lädt/parst.
// pdf.js liefert dafür keinen echten Fortschritt (siehe document-retriever.js für den
// Archiv-Download, der eigene Fortschritt hat) – nach 3s erscheint daher nur ein
// beruhigender Hinweistext statt einer vorgetäuschten Prozentanzeige.
function DocumentLoadingIndicator() {
  const [showHint, setShowHint] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setShowHint(true), 3000);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div className="flex flex-col items-center mt-20">
      <Spinner className="h-8 w-8" />
      {showHint && (
        <p className="mt-3 text-sm text-muted-foreground text-center px-6">
          Großes Dokument wird verarbeitet…
        </p>
      )}
    </div>
  );
}

// Worker aus dem gleichen Build statt externem CDN laden. Das vermeidet einen
// weiteren Laufzeit-Download und passt zu React-PDF 10 / PDF.js 5.
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

export function PdfPanel({ postid, onClose, refreshKey = 0 }) {
  const { canWrite } = useAuth();
  // Detail-Query teilt sich den React-Query-Cache mit DocumentDetailPage –
  // i. d. R. kein zusätzlicher Roundtrip.
  const { data: detail } = usePostbuchDetail(postid);
  const downloadFilename = useMemo(
    () => buildPdfFilename(postid, detail?.postbuch?.briefdatum, detail?.postbuch?.betreff),
    [postid, detail?.postbuch?.briefdatum, detail?.postbuch?.betreff],
  );
  const [numPages, setNumPages] = useState(null);
  const [pageNumber, setPageNumber] = useState(1);
  // Natural page dimensions (at scale=1) once the first page loads
  const [pageNaturalSize, setPageNaturalSize] = useState(null);
  // Available content area size tracked via ResizeObserver
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  // Manual zoom offset on top of the auto-fit scale
  const [zoomOffset, setZoomOffset] = useState(0);
  // Archive fetch state: 'idle' | 'fetching' | 'error'
  const [archiveFetchState, setArchiveFetchState] = useState('idle');
  // Local key to bust the PDF URL after archive fetch or rotation
  const [localKey, setLocalKey] = useState(0);
  // Prevent multiple archive fetch attempts for the same document
  const hasFetchedFromArchiveRef = useRef(false);
  // Von pdf.js geladenes Dokument – liefert für den Druck die Originalbytes
  const pdfProxyRef = useRef(null);
  // Rotation loading state
  const [isRotating, setIsRotating] = useState(false);
  const [rotateError, setRotateError] = useState(false);
  // Druckzustand: das PDF wird für den Druck erst vollständig geladen
  const [isPrinting, setIsPrinting] = useState(false);
  const [printError, setPrintError] = useState(false);

  // Fortschritt eines laufenden Archiv-Downloads (gepollt, rein im Server-RAM gehalten –
  // zeigt auch dann den echten Stand, wenn der Download schon vor dem (Wieder-)Öffnen
  // dieses Dokuments gestartet wurde, z. B. weil der Nutzer zwischenzeitlich weg- und
  // zurückgewechselt hat)
  const { data: fetchProgress } = useQuery({
    queryKey: ['files', 'fetch-progress', postid],
    queryFn: () => api.files.fetchProgress(postid),
    enabled: archiveFetchState === 'fetching',
    refetchInterval: 800,
  });
  const progressPct = fetchProgress?.totalBytes
    ? Math.min(100, Math.round((fetchProgress.receivedBytes / fetchProgress.totalBytes) * 100))
    : null;

  const panelRef = useRef(null);
  const contentRef = useRef(null);
  // Refs for wheel handler (avoids stale closures without re-attaching listener)
  const numPagesRef = useRef(null);
  const lastWheelRef = useRef(0);

  // Keep numPagesRef current
  useEffect(() => { numPagesRef.current = numPages; }, [numPages]);

  // Reset everything when the document changes
  useEffect(() => {
    setNumPages(null);
    setPageNumber(1);
    setPageNaturalSize(null);
    setZoomOffset(0);
    setArchiveFetchState('idle');
    setLocalKey(0);
    hasFetchedFromArchiveRef.current = false;
    setIsRotating(false);
    setRotateError(false);
  }, [postid]);

  // Reset fit/natural-size when the PDF is refreshed after reprocessing
  useEffect(() => {
    if (refreshKey === 0) return;
    setNumPages(null);
    setPageNumber(1);
    setPageNaturalSize(null);
    setZoomOffset(0);
    hasFetchedFromArchiveRef.current = false;
  }, [refreshKey]);

  // Track content area dimensions
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const obs = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      setContainerSize({ width, height });
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // Mousewheel → page navigation (non-passive so we can preventDefault)
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const handleWheel = (e) => {
      e.preventDefault();
      const now = Date.now();
      if (now - lastWheelRef.current < 400) return; // debounce: max one flip per 400 ms
      lastWheelRef.current = now;
      if (e.deltaY > 0) {
        setPageNumber((p) => Math.min(numPagesRef.current ?? p, p + 1));
      } else if (e.deltaY < 0) {
        setPageNumber((p) => Math.max(1, p - 1));
      }
    };
    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, []); // attached once; state accessed only through refs

  // Auto-fit: scale so the page fills whichever dimension is tighter
  const autoScale = useMemo(() => {
    if (!containerSize.width || !containerSize.height || !pageNaturalSize) return 1.0;
    const padding = 32; // 16 px on each side
    const wScale = (containerSize.width - padding) / pageNaturalSize.width;
    const hScale = (containerSize.height - padding) / pageNaturalSize.height;
    return Math.max(0.1, Math.min(wScale, hScale));
  }, [containerSize, pageNaturalSize]);

  const scale = Math.max(0.1, Math.min(3.0, autoScale + zoomOffset));

  // Drag-to-resize handle on the left edge
  const onResizerMouseDown = useCallback((e) => {
    // Dialoge werden zentral über dem App-Layout gerendert. Diese zusätzliche
    // Sperre verhindert auch bei einem bereits laufenden oder fremden Overlay,
    // dass der globale Mousemove-Handler die Panelbreite verändert.
    if (document.querySelector('[role="dialog"]')) return;
    e.preventDefault();
    const panel = panelRef.current;
    if (!panel) return;
    const startX = e.clientX;
    const startWidth = panel.offsetWidth;
    const onMouseMove = (moveE) => {
      if (document.querySelector('[role="dialog"]')) return;
      const newWidth = Math.min(
        window.innerWidth * 0.8,
        Math.max(200, startWidth - (moveE.clientX - startX)),
      );
      panel.style.width = `${newWidth}px`;
    };
    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, []);

  function onDocumentLoadSuccess(pdf) {
    // Für den Druck: pdf.js hält die Originalbytes bereits im Speicher.
    pdfProxyRef.current = pdf;
    const n = pdf.numPages;
    setNumPages(n);
    setPageNumber(1);
  }

  // Capture natural page size after the first page renders (or after a refresh)
  function onPageLoadSuccess(page) {
    const viewport = page.getViewport({ scale: 1 });
    setPageNaturalSize({ width: viewport.width, height: viewport.height });
  }

  const handleRotate = async (winkel) => {
    setIsRotating(true);
    setRotateError(false);
    try {
      await api.files.rotatePdf(postid, winkel);
      setPageNaturalSize(null); // recalculate auto-fit (90° rotations change aspect ratio)
      setLocalKey((k) => k + 1);
    } catch (err) {
      console.error('PDF-Rotation fehlgeschlagen:', err);
      setRotateError(true);
    } finally {
      setIsRotating(false);
    }
  };

  // no-store on the backend prevents caching; localKey/refreshKey force-reload after explicit actions
  const pdfUrl = `${api.files.pdfUrl(postid)}${(refreshKey || localKey) ? `?v=${refreshKey}_${localKey}` : ''}`;
  const pdfOptions = useMemo(() => ({ withCredentials: true }), []);

  // Dokumentwechsel oder Neuladen (z. B. nach Rotation): alten pdf.js-Handle
  // verwerfen, sonst druckt der Button kurzzeitig noch den vorherigen Stand.
  useEffect(() => {
    pdfProxyRef.current = null;
  }, [postid, localKey, refreshKey]);

  // Druckweg samt Begründung: web/src/lib/pdf-print.js. Schlägt es fehl, öffnet sich
  // bewusst kein Tab mehr im Hintergrund – stattdessen ein Hinweis, denn der Button
  // „In neuem Tab öffnen" steht direkt daneben und druckt über den nativen Viewer.
  const handlePrint = useCallback(async () => {
    setPrintError(false);
    setIsPrinting(true);
    try {
      // Das angezeigte PDF liegt bereits im Browser – dessen Bytes verwenden,
      // statt es ein zweites Mal zu laden (der Endpunkt liefert no-store, ein
      // Cache-Treffer ist also ausgeschlossen). Nur falls die Anzeige noch nicht
      // geladen hat, wird nachgeladen.
      const daten = await pdfProxyRef.current?.getData();
      if (daten) await printPdfBytes(daten);
      else await printPdf(pdfUrl);
    } catch (err) {
      console.error('Drucken fehlgeschlagen:', err);
      setPrintError(true);
    } finally {
      setIsPrinting(false);
    }
  }, [pdfUrl]);

  function onDocumentLoadError() {
    if (hasFetchedFromArchiveRef.current) {
      setArchiveFetchState('error');
      return;
    }
    hasFetchedFromArchiveRef.current = true;
    setArchiveFetchState('fetching');
    api.files.fetchFromArchive(postid)
      .then(() => {
        setArchiveFetchState('idle');
        setLocalKey((k) => k + 1);
      })
      .catch(() => setArchiveFetchState('error'));
  }

  return (
    <div
      ref={panelRef}
      className="w-[40vw] min-w-[200px] border-l border-border/60 bg-card flex flex-col h-full overflow-hidden relative">
      {/* Drag-to-resize handle */}
      <div
        className="absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-primary/30 active:bg-primary/50 z-20 transition-colors"
        onMouseDown={onResizerMouseDown}
      />

      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-border/60 bg-sidebar flex-shrink-0">
        {/* Page navigation */}
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setPageNumber((p) => Math.max(1, p - 1))}
            disabled={pageNumber <= 1}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-sm text-muted-foreground min-w-[60px] text-center">
            {numPages ? `${pageNumber} / ${numPages}` : '–'}
          </span>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setPageNumber((p) => Math.min(numPages || 1, p + 1))}
            disabled={pageNumber >= (numPages || 1)}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>

        {/* Zoom + actions */}
        <div className="flex items-center gap-1">
          {/* Rotation buttons */}
          {canWrite && (
          <>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => handleRotate(90)}
            disabled={isRotating}
            title="90° nach links drehen"
          >
            <RotateCcw className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => handleRotate(180)}
            disabled={isRotating}
            title="180° drehen"
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => handleRotate(270)}
            disabled={isRotating}
            title="90° nach rechts drehen"
          >
            <RotateCw className="h-4 w-4" />
          </Button>
          <div className="w-px h-4 bg-border/60 mx-0.5" />
          </>
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setZoomOffset((d) => d - 0.15)}
            title="Verkleinern"
          >
            <ZoomOut className="h-4 w-4" />
          </Button>
          <span className="text-xs text-muted-foreground w-12 text-center">
            {Math.round(scale * 100)}%
          </span>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setZoomOffset((d) => d + 0.15)}
            title="Vergrößern"
          >
            <ZoomIn className="h-4 w-4" />
          </Button>
          <a href={pdfUrl} target="_blank" rel="noopener noreferrer">
            <Button variant="ghost" size="icon" title="In neuem Tab öffnen">
              <ExternalLink className="h-4 w-4" />
            </Button>
          </a>
          <a href={pdfUrl} download={downloadFilename}>
            <Button variant="ghost" size="icon" title="Herunterladen">
              <Download className="h-4 w-4" />
            </Button>
          </a>
          <Button variant="ghost" size="icon" onClick={handlePrint} disabled={isPrinting} title="Drucken">
            {isPrinting ? <Spinner className="h-4 w-4" /> : <Printer className="h-4 w-4" />}
          </Button>
          {onClose && (
            <Button variant="ghost" size="icon" onClick={onClose} title="Schließen">
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {/* PDF content area – measured by ResizeObserver for auto-fit */}
      <div
        ref={contentRef}
        className="flex-1 overflow-auto flex justify-center bg-muted/30 p-4 relative"
      >
        {/* Rotation overlay – shown while n8n rotates the PDF */}
        {isRotating && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-background/75 backdrop-blur-sm z-10">
            <Spinner className="h-12 w-12" />
            <p className="mt-4 text-sm text-muted-foreground text-center px-6">
              PDF wird gedreht…
            </p>
          </div>
        )}
        {/* Rotation error overlay – auto-dismissed by retrying */}
        {rotateError && !isRotating && (
          <div className="absolute inset-x-0 bottom-4 flex justify-center z-10 pointer-events-none">
            <p className="text-sm text-destructive bg-background/90 rounded-md px-3 py-1.5 shadow">
              PDF-Rotation fehlgeschlagen.
            </p>
          </div>
        )}
        {printError && !isPrinting && (
          <div className="absolute inset-x-0 bottom-4 flex justify-center z-10 pointer-events-none">
            <p className="text-sm text-destructive bg-background/90 rounded-md px-3 py-1.5 shadow">
              Drucken fehlgeschlagen – bitte über „In neuem Tab öffnen" drucken.
            </p>
          </div>
        )}
        {/* Archive-fetch overlay – shown while fetching from OneDrive */}
        {archiveFetchState === 'fetching' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-background/80 backdrop-blur-sm z-10 px-8">
            <p className="text-sm font-medium text-foreground text-center">
              Dokument wird aus Archiv geladen{progressPct != null ? ` (${progressPct} %)` : '…'}
            </p>
            <Progress value={progressPct ?? 0} indeterminate={progressPct == null} className="mt-4 max-w-xs" />
            {fetchProgress?.totalBytes ? (
              <p className="mt-2 text-xs text-muted-foreground">
                {formatMB(fetchProgress.receivedBytes)} / {formatMB(fetchProgress.totalBytes)} MB
              </p>
            ) : fetchProgress?.receivedBytes > 0 ? (
              <p className="mt-2 text-xs text-muted-foreground">{formatMB(fetchProgress.receivedBytes)} MB geladen…</p>
            ) : null}
          </div>
        )}
        <Document
          key={postid}
          file={pdfUrl}
          onLoadSuccess={onDocumentLoadSuccess}
          onLoadError={onDocumentLoadError}
          loading={<DocumentLoadingIndicator />}
          error={
            archiveFetchState === 'fetching'
              ? <></> // overlay is shown instead
              : archiveFetchState === 'error'
                ? <p className="text-sm text-destructive mt-20 text-center px-4">Dokument konnte nicht aus dem Archiv abgerufen werden.</p>
                : <p className="text-sm text-destructive mt-20 text-center px-4">PDF konnte nicht geladen werden.</p>
          }
          options={pdfOptions}
        >
          <Page
            pageNumber={pageNumber}
            scale={scale}
            onLoadSuccess={onPageLoadSuccess}
            loading={<Spinner className="h-6 w-6" />}
          />
        </Document>
      </div>
    </div>
  );
}
