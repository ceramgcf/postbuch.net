import { useState, useRef, useMemo, useEffect, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Document, Page, pdfjs } from 'react-pdf';
import { PDFJS_DOCUMENT_OPTIONS } from '@/lib/pdfjs-worker';
import { Spinner } from '@/components/ui/spinner';
import { Progress } from '@/components/ui/progress';
import { Download, RotateCcw, RotateCw, RefreshCw, X, Loader2, Printer, Menu, Maximize2, Share2 } from 'lucide-react';
import { api } from '@/api/client';
import { useAuth } from '@/hooks/useAuth';
import { kannDateienTeilen, usePdfTeilen } from '@/components/ui/pdf-teilen';

import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

const formatMB = (bytes) => (bytes / (1024 * 1024)).toFixed(1).replace('.', ',');

// Wird von <Document loading={...}> gerendert, solange pdf.js die Datei lädt/parst.
// pdf.js liefert dafür keinen echten Fortschritt – nach 3s erscheint daher nur ein
// beruhigender Hinweistext statt einer vorgetäuschten Prozentanzeige.
function DocumentLoadingIndicator() {
  const [showHint, setShowHint] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setShowHint(true), 3000);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div style={{ color: '#ccc', textAlign: 'center' }}>
      <Spinner className="h-8 w-8" />
      {showHint && (
        <p style={{ marginTop: '0.75rem', fontSize: '0.875rem', padding: '0 1.5rem' }}>
          Großes Dokument wird verarbeitet…
        </p>
      )}
    </div>
  );
}

if (!pdfjs.GlobalWorkerOptions.workerSrc) {
  // Worker aus dem gleichen Build statt externem CDN laden.
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url,
  ).toString();
}

// Halbkreis-Menü: Radius der Knöpfe und Abstand zum unteren Rand (CSS-px).
const BR_ARC = 29;
const BR_MAIN = 29;
const UNTEN = 16;

/**
 * Touch-PDF-Viewer des Mobil-Layouts. Füllt die Fläche unter der Kopfleiste
 * (CSS-Variable --mobil-kopf).
 * - Seitenweise Navigation via Wischen links/rechts
 * - Pinch-Zoom via 2 Finger
 * - Einzelner Action-Button unten Mitte, öffnet 180°-Arc mit 5 Buttons
 * - Lädt /api/files/:postid/pdf, bei Fehler einmal aus dem Archiv nach
 *
 * Ohne Teilen-Unterstützung im Browser zeigt der Halbkreis „Drucken“ statt „Teilen“.
 */
export function DokumentViewer({ postid, hasPdf }) {
  const brArc = BR_ARC;
  const brMain = BR_MAIN;
  const iconGr = 26;
  // Symbole und Beschriftung im Halbkreis etwas kleiner, damit sie nicht gequetscht wirken.
  const arcIconGr = Math.round(iconGr * 0.9);
  const arcSchrift = 9 * 0.9;
  const unten = UNTEN;
  const resetKey = postid;

  const [numPages, setNumPages] = useState(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [localKey, setLocalKey] = useState(0);
  const [archiveFetchState, setArchiveFetchState] = useState('idle');
  const hasFetchedFromArchiveRef = useRef(false);

  const [panX, setPanX] = useState(0);
  const [panY, setPanY] = useState(0);

  const [menuOpen, setMenuOpen] = useState(false);
  const [isRotating, setIsRotating] = useState(false);
  const [rotateError, setRotateError] = useState(false);
  const rotateErrorTimerRef = useRef(null);

  const containerRef = useRef(null);
  const [flaeche, setFlaeche] = useState(() => ({
    w: typeof window !== 'undefined' ? window.innerWidth : 390,
    h: typeof window !== 'undefined' ? window.innerHeight : 844,
  }));
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => setFlaeche({
      w: Math.round(e.contentRect.width) || window.innerWidth,
      h: Math.round(e.contentRect.height) || window.innerHeight,
    }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const breite = flaeche.w;
  // Im Querformat ganze Seite in die Höhe einpassen statt seitenbreit
  // (sonst wäre der untere Teil nur per Zoom erreichbar).
  const seitenMass = flaeche.w > flaeche.h ? { height: flaeche.h } : { width: flaeche.w };
  const contentRef = useRef(null);
  const pinchRef = useRef(null);
  const swipeRef = useRef(null);
  const zoomRef = useRef(1);
  const panRef = useRef({ x: 0, y: 0 });
  const lastTapRef = useRef({ time: 0, x: 0, y: 0 });
  const resetAnimTimerRef = useRef(null);

  const { canWrite } = useAuth();
  const canRotate = canWrite;

  const { data: fetchProgress } = useQuery({
    queryKey: ['files', 'fetch-progress', postid],
    queryFn: () => api.files.fetchProgress(postid),
    enabled: archiveFetchState === 'fetching',
    refetchInterval: 800,
  });
  const progressPct = fetchProgress?.totalBytes
    ? Math.min(100, Math.round((fetchProgress.receivedBytes / fetchProgress.totalBytes) * 100))
    : null;

  useEffect(() => { zoomRef.current = zoom; }, [zoom]);

  // Keep the DOM transform in sync with committed zoom + pan (after gesture / reset)
  useEffect(() => {
    if (contentRef.current) {
      contentRef.current.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
    }
    panRef.current.x = panX;
    panRef.current.y = panY;
  }, [zoom, panX, panY]);

  useEffect(() => {
    setNumPages(null);
    setPageNumber(1);
    setZoom(1);
    zoomRef.current = 1;
    setPanX(0);
    setPanY(0);
    panRef.current = { x: 0, y: 0 };
    setLocalKey(0);
    setArchiveFetchState('idle');
    hasFetchedFromArchiveRef.current = false;
    setMenuOpen(false);
  }, [resetKey]);

  useEffect(() => () => {
    if (rotateErrorTimerRef.current) clearTimeout(rotateErrorTimerRef.current);
    if (resetAnimTimerRef.current) clearTimeout(resetAnimTimerRef.current);
  }, []);

  // Non-passive touchmove: Pinch-Zoom + Single-Finger-Pan (when zoomed)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handleMove = (e) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const dist = Math.hypot(dx, dy);
        const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        if (pinchRef.current?.prevDist) {
          const ratio = dist / pinchRef.current.prevDist;
          const next = Math.max(0.5, Math.min(6, zoomRef.current * ratio));
          zoomRef.current = next;
          // Pan along the movement of the two-finger midpoint
          panRef.current.x += midX - pinchRef.current.prevMidX;
          panRef.current.y += midY - pinchRef.current.prevMidY;
          if (contentRef.current) {
            contentRef.current.style.transform = `translate(${panRef.current.x}px, ${panRef.current.y}px) scale(${next})`;
          }
        }
        pinchRef.current = { prevDist: dist, prevMidX: midX, prevMidY: midY };
      } else if (e.touches.length === 1 && swipeRef.current && zoomRef.current > 1.05) {
        e.preventDefault();
        const dx = e.touches[0].clientX - swipeRef.current.startX;
        const dy = e.touches[0].clientY - swipeRef.current.startY;
        panRef.current.x = swipeRef.current.panStartX + dx;
        panRef.current.y = swipeRef.current.panStartY + dy;
        if (contentRef.current) {
          contentRef.current.style.transform = `translate(${panRef.current.x}px, ${panRef.current.y}px) scale(${zoomRef.current})`;
        }
      }
    };
    el.addEventListener('touchmove', handleMove, { passive: false });
    return () => el.removeEventListener('touchmove', handleMove);
  }, []);

  const pdfUrl = useMemo(
    () => `${api.files.pdfUrl(postid)}${localKey ? `?v=${localKey}` : ''}`,
    [postid, localKey],
  );
  const pdfOptions = PDFJS_DOCUMENT_OPTIONS;

  function onDocumentLoadSuccess({ numPages: n }) {
    setNumPages(n);
  }

  function onDocumentLoadError() {
    if (hasFetchedFromArchiveRef.current) { setArchiveFetchState('error'); return; }
    hasFetchedFromArchiveRef.current = true;
    setArchiveFetchState('fetching');
    api.files.fetchFromArchive(postid)
      .then(() => { setArchiveFetchState('idle'); setLocalKey((k) => k + 1); })
      .catch(() => setArchiveFetchState('error'));
  }

  function handleTouchStart(e) {
    // Laufende Reset-Animation abbrechen, damit die Geste verzögerungsfrei greift
    if (contentRef.current) contentRef.current.style.transition = '';
    if (e.touches.length === 1) {
      swipeRef.current = {
        startX: e.touches[0].clientX,
        startY: e.touches[0].clientY,
        panStartX: panRef.current.x,
        panStartY: panRef.current.y,
      };
      pinchRef.current = null;
    } else if (e.touches.length >= 2) {
      pinchRef.current = null; // prevDist is seeded on first touchmove
      swipeRef.current = null;
    }
  }

  function handleTouchEnd(e) {
    if (e.touches.length === 0) {
      // Doppeltipp-Geste (zwei kurze Tipps am selben Ort) → Ansicht zurücksetzen.
      // Nur bei Single-Finger-Gesten (swipeRef gesetzt, kein Pinch).
      if (swipeRef.current && !pinchRef.current) {
        const t = e.changedTouches[0];
        const moved = Math.hypot(
          t.clientX - swipeRef.current.startX,
          t.clientY - swipeRef.current.startY,
        );
        if (moved < 12) {
          const now = Date.now();
          const last = lastTapRef.current;
          const isDoubleTap =
            now - last.time < 300 &&
            Math.hypot(t.clientX - last.x, t.clientY - last.y) < 40;
          if (isDoubleTap) {
            lastTapRef.current = { time: 0, x: 0, y: 0 };
            swipeRef.current = null;
            pinchRef.current = null;
            // Nur zurücksetzen, wenn die Ansicht überhaupt transformiert ist
            if (zoomRef.current !== 1 || panRef.current.x !== 0 || panRef.current.y !== 0) {
              handleResetView();
            }
            return;
          }
          lastTapRef.current = { time: now, x: t.clientX, y: t.clientY };
        }
      }
      // Page navigation via swipe only when not zoomed (single-finger gesture)
      if (swipeRef.current && zoomRef.current <= 1.05) {
        const touch = e.changedTouches[0];
        const dx = touch.clientX - swipeRef.current.startX;
        const dy = touch.clientY - swipeRef.current.startY;
        if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) {
          if (dx < 0) {
            setPageNumber(p => Math.min(p + 1, numPages || 1));
          } else {
            setPageNumber(p => Math.max(p - 1, 1));
          }
        }
      }
      // Commit live (DOM-driven) zoom + pan back into React state once the gesture ends.
      if (zoomRef.current !== zoom) setZoom(zoomRef.current);
      if (panRef.current.x !== panX) setPanX(panRef.current.x);
      if (panRef.current.y !== panY) setPanY(panRef.current.y);
      swipeRef.current = null;
      pinchRef.current = null;
    }
  }

  const handleRotate = useCallback(async (winkel) => {
    setMenuOpen(false);
    setIsRotating(true);
    setRotateError(false);
    try {
      await api.files.rotatePdf(postid, winkel);
      setLocalKey((k) => k + 1);
    } catch (err) {
      console.error('PDF-Rotation fehlgeschlagen:', err);
      setRotateError(true);
      rotateErrorTimerRef.current = setTimeout(() => setRotateError(false), 3000);
    } finally {
      setIsRotating(false);
    }
  }, [postid]);

  const handleResetView = useCallback(() => {
    // Sanfte Rückführung zur Ausgangsansicht: Transition aktivieren und Transform
    // direkt auf Identität setzen (der State-Sync-Effekt setzt denselben Wert,
    // löst also keine zweite Animation aus). Transition danach wieder entfernen,
    // damit folgende Gesten verzögerungsfrei reagieren.
    if (contentRef.current) {
      contentRef.current.style.transition = 'transform 0.32s cubic-bezier(0.22,1,0.36,1)';
      contentRef.current.style.transform = 'translate(0px, 0px) scale(1)';
    }
    if (resetAnimTimerRef.current) clearTimeout(resetAnimTimerRef.current);
    resetAnimTimerRef.current = setTimeout(() => {
      if (contentRef.current) contentRef.current.style.transition = '';
    }, 340);
    setZoom(1);
    zoomRef.current = 1;
    setPanX(0);
    setPanY(0);
    panRef.current = { x: 0, y: 0 };
    setMenuOpen(false);
  }, []);

  const handleDownload = useCallback(() => {
    setMenuOpen(false);
    const a = document.createElement('a');
    a.href = pdfUrl;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, [pdfUrl]);

  const handlePrint = useCallback(() => {
    setMenuOpen(false);
    window.open(pdfUrl, '_blank');
  }, [pdfUrl]);

  const zeigeTeilen = kannDateienTeilen();
  const { zustand: teilenZustand, teilen: pdfTeilen } = usePdfTeilen(pdfUrl);
  const handleShare = useCallback(async () => {
    // Menü bleibt offen, solange geladen wird bzw. ein zweites Tippen nötig ist.
    if (await pdfTeilen()) setMenuOpen(false);
  }, [pdfTeilen]);
  const teilenLabel = { laedt: 'Lädt …', nochmal: 'Nochmal', fehler: 'Fehler' }[teilenZustand] || 'Teilen';

  const isViewTransformed = zoom !== 1 || panX !== 0 || panY !== 0;

  // Arc geometry: 5 buttons at angles -90°, -45°, 0°, 45°, 90° from vertical (upward = 0°)
  // Radius R = half screen width minus 2× arc button radius, so ±90° buttons sit BR_ARC
  // pixels from each screen edge.
  const arcButtons = useMemo(() => {
    const vw = breite;
    const R = Math.min(vw / 2 - 2 * brArc, 150);
    const mainCY = unten + brMain; // main button center Y from screen bottom

    return [
      { angle: -90, label: 'Links',   icon: RotateCcw, action: () => handleRotate(270), disabled: !canRotate },
      { angle: -45, label: 'Download',icon: Download,   action: handleDownload,          disabled: false },
      { angle:   0, label: '180°',    icon: RefreshCw,  action: () => handleRotate(180), disabled: !canRotate },
      zeigeTeilen
        ? { angle: 45, key: 'teilen', label: teilenLabel, icon: teilenZustand === 'laedt' ? Loader2 : Share2, action: handleShare, disabled: teilenZustand === 'laedt' }
        : { angle: 45, label: 'Drucken', icon: Printer,    action: handlePrint,             disabled: false },
      { angle:  90, label: 'Rechts',  icon: RotateCw,   action: () => handleRotate(90),  disabled: !canRotate },
    ].map((d, i) => {
      const rad = d.angle * Math.PI / 180;
      const cx = vw / 2 + R * Math.sin(rad);
      const cy = mainCY + R * Math.cos(rad);
      return { ...d, i, left: Math.round(cx - brArc), bottom: Math.round(cy - brArc) };
    });
  }, [handleRotate, handleDownload, handlePrint, handleShare, zeigeTeilen, teilenLabel, teilenZustand, canRotate, breite, brArc, brMain, unten]);

  // Dunkles Glas: Die weißen Symbole bleiben auch über weißem Papier lesbar.
  const glassBtnBase = {
    backdropFilter: 'blur(6px)',
    WebkitBackdropFilter: 'blur(6px)',
    border: '1px solid rgba(255,255,255,0.25)',
    boxShadow: '0 2px 12px rgba(0,0,0,0.4)',
    display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center',
    color: '#fff', cursor: 'pointer',
    borderRadius: '50%',
    WebkitTapHighlightColor: 'transparent',
  };

  // Bewusst kein Portal: Ein Portal-Knoten blieb nach dem Wechsel zu „Daten“
  // oder auf eine andere Seite im <body> stehen.
  const rahmen = { position: 'fixed', top: 'var(--mobil-kopf, 0px)', left: 0, right: 0, bottom: 0, zIndex: 20, background: '#141218' };

  if (!hasPdf) {
    return (
      <div style={{
        ...rahmen, color: '#aaa',
        display: 'flex', justifyContent: 'center', alignItems: 'center',
      }}>
        <p style={{ fontSize: '0.875rem', textAlign: 'center', padding: '1rem' }}>
          Zu diesem Eintrag gibt es kein PDF.
        </p>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      style={{ ...rahmen, touchAction: 'none' }}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      {/* ── Seiteninhalt ─────────────────────────────────────────── */}
      <div style={{
        width: '100%', height: '100%',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        overflow: 'hidden',
      }}>
        {archiveFetchState === 'fetching' && (
          <div style={{ color: '#ccc', textAlign: 'center', padding: '0 2rem' }}>
            <p style={{ fontSize: '0.875rem', fontWeight: 500 }}>
              Dokument wird aus Archiv geladen{progressPct != null ? ` (${progressPct} %)` : '…'}
            </p>
            <div style={{ marginTop: '1rem', maxWidth: 220, marginInline: 'auto' }}>
              <Progress value={progressPct ?? 0} indeterminate={progressPct == null} />
            </div>
            {fetchProgress?.totalBytes ? (
              <p style={{ marginTop: '0.5rem', fontSize: '0.75rem', color: '#999' }}>
                {formatMB(fetchProgress.receivedBytes)} / {formatMB(fetchProgress.totalBytes)} MB
              </p>
            ) : fetchProgress?.receivedBytes > 0 ? (
              <p style={{ marginTop: '0.5rem', fontSize: '0.75rem', color: '#999' }}>
                {formatMB(fetchProgress.receivedBytes)} MB geladen…
              </p>
            ) : null}
          </div>
        )}
        {archiveFetchState === 'error' && (
          <p style={{ color: '#f87171', fontSize: '0.875rem', textAlign: 'center', padding: '1rem' }}>
            Dokument konnte nicht geladen werden.
          </p>
        )}
        {archiveFetchState === 'idle' && (
          <div
            ref={contentRef}
            style={{ transformOrigin: 'center center', willChange: 'transform' }}
          >
            <Document
              suspense={false}
              file={pdfUrl}
              onLoadSuccess={onDocumentLoadSuccess}
              onLoadError={onDocumentLoadError}
              loading={<DocumentLoadingIndicator />}
              error={
                <p style={{ color: '#f87171', fontSize: '0.875rem', textAlign: 'center', padding: '1rem' }}>
                  PDF konnte nicht geladen werden.
                </p>
              }
              options={pdfOptions}
            >
              <Page
                pageNumber={pageNumber}
                {...seitenMass}
                loading={null}
              />
            </Document>
          </div>
        )}
      </div>

      {/* ── Seitenanzeige oben Mitte ──────────────────────────────── */}
      {numPages != null && numPages > 1 && (
        <div style={{
          position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)',
          background: 'rgba(0,0,0,0.55)', color: '#ddd', fontSize: 13,
          borderRadius: 12, padding: '3px 10px', pointerEvents: 'none',
        }}>
          {pageNumber} / {numPages}
        </div>
      )}

      {/* ── Backdrop: schließt Menü bei Tipp außerhalb ───────────── */}
      {menuOpen && (
        <div
          onClick={() => setMenuOpen(false)}
          style={{
            position: 'absolute', inset: 0, zIndex: 10000,
            background: 'rgba(0,0,0,0.45)',
          }}
        />
      )}

      {/* ── Arc-Buttons (5 Stück, 180°-Halbkreis) ───────────────── */}
      {arcButtons.map(({ key, label, icon: Icon, left, bottom, action, disabled, i }) => {
        // Bloom-Animation: Mitte zuerst beim Öffnen, Ränder zuerst beim Schließen
        const distFromCenter = Math.abs(i - 2);
        const delay = menuOpen ? distFromCenter * 45 : (2 - distFromCenter) * 30;
        return (
          <button
            key={key || label}
            onClick={(e) => { e.stopPropagation(); if (!disabled) action(); }}
            title={label}
            style={{
              position: 'absolute',
              left,
              bottom,
              zIndex: 10002,
              width: brArc * 2,
              height: brArc * 2,
              ...glassBtnBase,
              background: disabled ? 'rgba(20,18,24,0.35)' : 'rgba(20,18,24,0.62)',
              opacity: menuOpen ? (disabled ? 0.35 : 1) : 0,
              transform: menuOpen ? 'scale(1)' : 'scale(0.25)',
              transition: 'opacity 0.2s ease, transform 0.25s cubic-bezier(0.34,1.56,0.64,1)',
              transitionDelay: `${delay}ms`,
              pointerEvents: menuOpen && !disabled ? 'auto' : 'none',
              gap: 2,
            }}
          >
            <Icon size={arcIconGr} style={Icon === Loader2 ? { animation: 'spin 1s linear infinite' } : undefined} />
            <span style={{
              fontSize: arcSchrift, fontWeight: 700, letterSpacing: 0.3,
              opacity: 0.9, textAlign: 'center', lineHeight: 1,
            }}>
              {label}
            </span>
          </button>
        );
      })}

      {/* ── Zentraler Action-Button (Mitte unten) ────────────────── */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          if (isViewTransformed) {
            handleResetView();
          } else {
            setMenuOpen(o => !o);
          }
        }}
        title={isViewTransformed ? 'Ansicht zurücksetzen' : menuOpen ? 'Abbrechen' : 'Aktionen'}
        style={{
          position: 'absolute',
          bottom: `calc(${unten}px + env(safe-area-inset-bottom, 0px))`,
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 10003,
          width: brMain * 2,
          height: brMain * 2,
          ...glassBtnBase,
          background: menuOpen
            ? 'rgba(220,38,38,0.78)'
            : isViewTransformed
              ? 'rgba(37,99,235,0.78)'
              : isRotating
                ? 'rgba(20,18,24,0.45)'
                : 'rgba(20,18,24,0.62)',
          border: menuOpen
            ? '1px solid rgba(239,68,68,0.6)'
            : isViewTransformed
              ? '1px solid rgba(59,130,246,0.6)'
              : '1px solid rgba(255,255,255,0.3)',
          transition: 'background 0.25s, border-color 0.25s',
        }}
      >
        {isRotating ? (
          <Loader2 size={iconGr} style={{ animation: 'spin 1s linear infinite' }} />
        ) : isViewTransformed ? (
          <Maximize2 size={iconGr} />
        ) : menuOpen ? (
          <X size={iconGr} />
        ) : (
          <Menu size={iconGr} />
        )}
      </button>

      {/* ── Fehler-Badge ─────────────────────────────────────────── */}
      {rotateError && (
        <div style={{
          position: 'absolute',
          bottom: unten + brMain * 2 + 14,
          left: 0, right: 0,
          display: 'flex', justifyContent: 'center',
          zIndex: 10003,
          pointerEvents: 'none',
        }}>
          <span style={{
            background: 'rgba(239,68,68,0.88)',
            backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)',
            color: '#fff', fontSize: 12, fontWeight: 600,
            borderRadius: 10, padding: '5px 14px',
            boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
            animation: 'fadeIn 0.2s ease',
          }}>
            Rotation fehlgeschlagen
          </span>
        </div>
      )}

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
      `}</style>
    </div>
  );
}
