import { useState, useRef, useMemo, useEffect, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { createPortal } from 'react-dom';
import { Document, Page, pdfjs } from 'react-pdf';
import { Spinner } from '@/components/ui/spinner';
import { Progress } from '@/components/ui/progress';
import { Download, RotateCcw, RotateCw, RefreshCw, X, Loader2, Printer, Menu, Maximize2 } from 'lucide-react';
import { api } from '@/api/client';
import { useAuth } from '@/hooks/useAuth';

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

// Arc geometry constants
const BR_ARC = 85;   // arc button radius → 170 px diameter
const BR_MAIN = 85;  // main button radius → 170 px diameter
const MAIN_BOTTOM = 20; // main button bottom offset from screen edge

/**
 * Fullscreen-Portrait-PDF-Viewer für Mobile.
 * - Seitenweise Navigation via Wischen links/rechts
 * - Pinch-Zoom via 2 Finger
 * - Einzelner Action-Button unten Mitte, öffnet 180°-Arc mit 5 Buttons
 *
 * Zwei Modi:
 *   1. Postbuch-Dokument: { postid, hasPdf } – nutzt /api/files/:postid/pdf + Archive-Fallback
 *   2. Externes PDF:     { pdfUrl, fileName? } – nutzt direkt die URL, kein Archive-Fallback
 */
export function MobilePdfOverlay({ postid, hasPdf, pdfUrl: externalPdfUrl, fileName }) {
  const useExternalUrl = !!externalPdfUrl;
  const resetKey = useExternalUrl ? externalPdfUrl : postid;

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
  const contentRef = useRef(null);
  const pinchRef = useRef(null);
  const swipeRef = useRef(null);
  const zoomRef = useRef(1);
  const panRef = useRef({ x: 0, y: 0 });
  const lastTapRef = useRef({ time: 0, x: 0, y: 0 });
  const resetAnimTimerRef = useRef(null);

  const { canWrite } = useAuth();
  const canRotate = !useExternalUrl && canWrite;

  const { data: fetchProgress } = useQuery({
    queryKey: ['files', 'fetch-progress', postid],
    queryFn: () => api.files.fetchProgress(postid),
    enabled: !useExternalUrl && archiveFetchState === 'fetching',
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
    () => useExternalUrl
      ? externalPdfUrl
      : `${api.files.pdfUrl(postid)}${localKey ? `?v=${localKey}` : ''}`,
    [useExternalUrl, externalPdfUrl, postid, localKey],
  );
  const pdfOptions = useMemo(() => ({ withCredentials: true }), []);

  function onDocumentLoadSuccess({ numPages: n }) {
    setNumPages(n);
  }

  function onDocumentLoadError() {
    if (useExternalUrl) { setArchiveFetchState('error'); return; }
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
    a.download = fileName || '';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, [pdfUrl, fileName]);

  const handlePrint = useCallback(() => {
    setMenuOpen(false);
    window.open(pdfUrl, '_blank');
  }, [pdfUrl]);

  const isViewTransformed = zoom !== 1 || panX !== 0 || panY !== 0;

  // Arc geometry: 5 buttons at angles -90°, -45°, 0°, 45°, 90° from vertical (upward = 0°)
  // Radius R = half screen width minus 2× arc button radius, so ±90° buttons sit BR_ARC
  // pixels from each screen edge.
  const arcButtons = useMemo(() => {
    const vw = typeof window !== 'undefined' ? window.innerWidth : 390;
    const R = vw / 2 - 2 * BR_ARC;
    const mainCY = MAIN_BOTTOM + BR_MAIN; // main button center Y from screen bottom

    return [
      { angle: -90, label: 'Links',   icon: RotateCcw, action: () => handleRotate(270), disabled: !canRotate },
      { angle: -45, label: 'Download',icon: Download,   action: handleDownload,          disabled: false },
      { angle:   0, label: '180°',    icon: RefreshCw,  action: () => handleRotate(180), disabled: !canRotate },
      { angle:  45, label: 'Drucken', icon: Printer,    action: handlePrint,             disabled: false },
      { angle:  90, label: 'Rechts',  icon: RotateCw,   action: () => handleRotate(90),  disabled: !canRotate },
    ].map((d, i) => {
      const rad = d.angle * Math.PI / 180;
      const cx = vw / 2 + R * Math.sin(rad);
      const cy = mainCY + R * Math.cos(rad);
      return { ...d, i, left: Math.round(cx - BR_ARC), bottom: Math.round(cy - BR_ARC) };
    });
  }, [handleRotate, handleDownload, handlePrint, canRotate]);

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

  if (!useExternalUrl && !hasPdf) {
    return createPortal(
      <div style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: '#000', color: '#aaa',
        display: 'flex', justifyContent: 'center', alignItems: 'center',
      }}>
        <p style={{ fontSize: '0.875rem', textAlign: 'center', padding: '1rem' }}>
          Kein PDF verfügbar – Gerät drehen zum Zurückkehren.
        </p>
      </div>,
      document.body,
    );
  }

  return createPortal(
    <div
      ref={containerRef}
      style={{ position: 'fixed', inset: 0, zIndex: 9999, background: '#000', touchAction: 'none' }}
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
                width={window.innerWidth}
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
      {arcButtons.map(({ label, icon: Icon, left, bottom, action, disabled, i }) => {
        // Bloom-Animation: Mitte zuerst beim Öffnen, Ränder zuerst beim Schließen
        const distFromCenter = Math.abs(i - 2);
        const delay = menuOpen ? distFromCenter * 45 : (2 - distFromCenter) * 30;
        return (
          <button
            key={label}
            onClick={(e) => { e.stopPropagation(); if (!disabled) action(); }}
            title={label}
            style={{
              position: 'absolute',
              left,
              bottom,
              zIndex: 10002,
              width: BR_ARC * 2,
              height: BR_ARC * 2,
              ...glassBtnBase,
              background: disabled ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.18)',
              opacity: menuOpen ? (disabled ? 0.35 : 1) : 0,
              transform: menuOpen ? 'scale(1)' : 'scale(0.25)',
              transition: 'opacity 0.2s ease, transform 0.25s cubic-bezier(0.34,1.56,0.64,1)',
              transitionDelay: `${delay}ms`,
              pointerEvents: menuOpen && !disabled ? 'auto' : 'none',
              gap: 2,
            }}
          >
            <Icon size={75} />
            <span style={{
              fontSize: 13, fontWeight: 700, letterSpacing: 0.3,
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
          bottom: MAIN_BOTTOM,
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 10003,
          width: BR_MAIN * 2,
          height: BR_MAIN * 2,
          ...glassBtnBase,
          background: menuOpen
            ? 'rgba(239,68,68,0.35)'
            : isViewTransformed
              ? 'rgba(59,130,246,0.35)'
              : isRotating
                ? 'rgba(255,255,255,0.12)'
                : 'rgba(255,255,255,0.22)',
          border: menuOpen
            ? '1px solid rgba(239,68,68,0.6)'
            : isViewTransformed
              ? '1px solid rgba(59,130,246,0.6)'
              : '1px solid rgba(255,255,255,0.3)',
          transition: 'background 0.25s, border-color 0.25s',
        }}
      >
        {isRotating ? (
          <Loader2 size={75} style={{ animation: 'spin 1s linear infinite' }} />
        ) : isViewTransformed ? (
          <Maximize2 size={75} />
        ) : menuOpen ? (
          <X size={75} />
        ) : (
          <Menu size={75} />
        )}
      </button>

      {/* ── Fehler-Badge ─────────────────────────────────────────── */}
      {rotateError && (
        <div style={{
          position: 'absolute',
          bottom: MAIN_BOTTOM + BR_MAIN * 2 + 14,
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
    </div>,
    document.body,
  );
}
