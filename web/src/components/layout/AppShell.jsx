import { useState, useCallback, useRef, useEffect } from 'react';
import { Outlet, useLocation } from 'react-router';
import { Sidebar } from './Sidebar';
import { PdfPanel } from './PdfPanel';
import { useIsMobile } from '@/hooks/useIsMobile';
import { lockLandscape, unlockOrientation, useIsPortrait } from '@/hooks/useOrientationLock';
import { useIsPortraitAllowed } from '@/hooks/usePortraitAllowed';
import { useBackButtonGuard } from '@/hooks/useBackButtonGuard';
import { Dialog, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { RotateCcw } from 'lucide-react';

function LandscapeOnlyOverlay() {
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 99999,
      background: '#0a0a0f',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      gap: '3rem',
    }}>
      <RotateCcw style={{ width: 168, height: 168, color: '#7c3aed', opacity: 0.9 }} />
      <p style={{ color: '#d1d5db', fontSize: '1.75rem', textAlign: 'center', maxWidth: 500, lineHeight: 1.6, padding: '0 1.5rem' }}>
        Bitte Gerät in Querformat drehen.
      </p>
    </div>
  );
}

export function AppShell() {
  const [pdfPostId, setPdfPostId] = useState(null);
  const [pdfOpen, setPdfOpen] = useState(false);
  const [pdfKey, setPdfKey] = useState(0);
  const pdfCloseableRef = useRef(false);
  const isMobile = useIsMobile();
  const isPortrait = useIsPortrait();
  const portraitAllowed = useIsPortraitAllowed();
  const location = useLocation();

  // PWA detection: prefer display-mode, but fall back to Android UA or forced flag.
  const urlParams = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
  const forceBackGuard = typeof window !== 'undefined' && (
    (window.localStorage && window.localStorage.getItem('pwaBackForce') === '1') ||
    (urlParams && urlParams.get('pwaBackDebug') === '1')
  );
  const isStandalone = typeof window !== 'undefined' && (
    (window.matchMedia && (
      window.matchMedia('(display-mode: standalone)').matches ||
      window.matchMedia('(display-mode: fullscreen)').matches ||
      window.matchMedia('(display-mode: minimal-ui)').matches
    )) || window.navigator?.standalone === true
  );
  const isAndroidUA = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent || '');
  const isPwa = isStandalone || forceBackGuard || isAndroidUA;
  if (typeof window !== 'undefined') console.log('[AppShell] pwa-detection', { isStandalone, isAndroidUA, forceBackGuard, ua: navigator.userAgent });
  const { showExitDialog, confirmExit, cancelExit } = useBackButtonGuard({ enabled: isPwa });

  // Auf Mobile: Landscape erzwingen als best-effort (klappt sicher in installierten PWAs).
  // Nach Tab-Wechsel/App-Pause erneut versuchen.
  // Ausnahme: Wenn eine Kindkomponente portraitAllowed signalisiert (z. B. Fullscreen-
  // PDF-Viewer oder DocumentDetailPage), wird aktiv entsperrt statt nur der Lock
  // unterdrückt – das behebt die Race Condition bei Direktaufruf einer Detail-URL:
  // React führt Child-Effects vor Parent-Effects aus, d. h. AppShell würde sonst
  // den Unlock der Kindkomponente auf initialem Mount überschreiben.
  useEffect(() => {
    if (!isMobile) return;
    if (portraitAllowed) {
      unlockOrientation();
    } else {
      lockLandscape();
    }
    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && !portraitAllowed) lockLandscape();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [isMobile, portraitAllowed]);

  const showPdf = useCallback((postid, { closeable = false } = {}) => {
    pdfCloseableRef.current = closeable;
    setPdfPostId(postid);
    setPdfOpen(true);
  }, []);

  const closePdf = useCallback(() => {
    setPdfOpen(false);
  }, []);

  const refreshPdf = useCallback((postid) => {
    setPdfPostId(current => {
      if (current === postid) setPdfKey(k => k + 1);
      return current;
    });
  }, []);

  // Detail-Pages haben eigene Portrait-Logik (MobilePdfOverlay) – dort kein Overlay.
  const isDetailPage = /^\/postbuch\/[^/]+/.test(location.pathname);

  // CSS-Fallback: wenn JS-Lock fehlschlug und Nutzer ins Hochformat dreht.
  // Überspringen, wenn DetailPage (URL-basiert) oder eine Kindkomponente sich per
  // useAllowPortrait registriert hat (z. B. Abrechnungs-Wizard in Step 2).
  if (isMobile && isPortrait && !isDetailPage && !portraitAllowed) {
    console.warn('[AppShell] Showing LandscapeOnlyOverlay – isMobile:', isMobile, 'isPortrait:', isPortrait, 'isDetailPage:', isDetailPage, 'portraitAllowed:', portraitAllowed, 'path:', location.pathname);
    return <LandscapeOnlyOverlay />;
  }

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Decorative faded background logo */}
      <div
        className="fixed inset-0 pointer-events-none select-none flex items-center justify-center overflow-hidden"
        style={{ zIndex: 0 }}
        aria-hidden="true"
      >
        <img
          src="/logo.svg"
          alt=""
          className="w-full h-full object-contain"
          style={{ opacity: 0.15, filter: 'grayscale(30%) blur(9px)' }}
        />
      </div>
      <Sidebar />
      <main className="flex-1 overflow-auto min-w-0" style={{ position: 'relative', zIndex: 1 }}>
        <Outlet context={{ showPdf, closePdf, pdfPostId, refreshPdf }} />
      </main>
      {/* PdfPanel: auf Mobile/Tablet grundsätzlich gesperrt (Regel 2).
           Auf Desktop immer sichtbar wie bisher. */}
      {pdfOpen && pdfPostId && !isMobile && (
        <PdfPanel
          postid={pdfPostId}
          refreshKey={pdfKey}
          onClose={pdfCloseableRef.current ? closePdf : undefined}
        />
      )}

      {/* Exit-Bestätigungsdialog (Hardware-Zurück-Taste im PWA-Modus) */}
      <Dialog open={showExitDialog} onOpenChange={open => { if (!open) cancelExit(); }}>
        <DialogTitle>App beenden?</DialogTitle>
        <DialogDescription>
          Zum Beenden bitte erneut die Hardware‑Zurück‑Taste drücken. Oder Abbrechen wählen.
        </DialogDescription>
        <DialogFooter>
          <Button variant="outline" onClick={cancelExit}>Abbrechen</Button>
        </DialogFooter>
      </Dialog>

      {/* No debug control in minimal build */}
    </div>
  );
}
