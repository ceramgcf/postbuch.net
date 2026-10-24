import { useState, useCallback, useRef, useEffect } from 'react';
import { Outlet, useLocation } from 'react-router';
import { Sidebar } from './Sidebar';
import { PdfPanel } from './PdfPanel';
import { MobilKopfleiste, MobilMenue, FavoritenLeiste } from './MobilRahmen';
import { MOBIL_SCROLLER_ID } from '@/lib/mobilScroller';
import { useDarstellung } from '@/hooks/useDarstellung';
import { SeiteProvider } from '@/hooks/useSeite';
import { useScrollWiederherstellung } from '@/hooks/useScrollWiederherstellung';
import { useBackButtonGuard } from '@/hooks/useBackButtonGuard';
import { Dialog, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

export function AppShell() {
  const [pdfPostId, setPdfPostId] = useState(null);
  const [pdfOpen, setPdfOpen] = useState(false);
  const [pdfKey, setPdfKey] = useState(0);
  const pdfCloseableRef = useRef(false);
  const { istMobil } = useDarstellung();
  const [menueOffen, setMenueOffen] = useState(false);
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

  // Menü schließt bei jedem Seitenwechsel
  useEffect(() => { setMenueOffen(false); }, [location.pathname]);
  const schliesseMenue = useCallback(() => setMenueOffen(false), []);

  useScrollWiederherstellung(istMobil);

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

  const isDetailPage = /^\/postbuch\/[^/]+/.test(location.pathname);


  const exitDialog = (
    <Dialog open={showExitDialog} onOpenChange={open => { if (!open) cancelExit(); }}>
      <DialogTitle>App beenden?</DialogTitle>
      <DialogDescription>
        Zum Beenden bitte erneut die Hardware‑Zurück‑Taste drücken. Oder Abbrechen wählen.
      </DialogDescription>
      <DialogFooter>
        <Button variant="outline" onClick={cancelExit}>Abbrechen</Button>
      </DialogFooter>
    </Dialog>
  );
  // Im Panel tatsächlich angezeigtes Dokument (für Hervorhebung und Auge-Umschalter der Listen).
  const angezeigtePdfId = pdfOpen ? pdfPostId : null;
  const outletContext = { showPdf, closePdf, pdfPostId, angezeigtePdfId, refreshPdf };

  if (istMobil) {
    // Mobil: Kopfleiste, Scrollbereich, Favoritenleiste untereinander. Es
    // scrollt nur <main> (siehe lib/mobilScroller.js). Kein PdfPanel –
    // Dokumente zeigt die Detailseite selbst.
    return (
      <SeiteProvider>
        <div className="flex h-dvh flex-col bg-background">
          <MobilKopfleiste onMenue={() => setMenueOffen(true)} />
          <main
            id={MOBIL_SCROLLER_ID}
            className="mobil-inhalt relative min-h-0 flex-1 overflow-y-auto overscroll-y-contain px-safe pt-3"
            style={{ paddingBottom: isDetailPage ? 'calc(1rem + env(safe-area-inset-bottom, 0px))' : '1rem' }}
          >
            <Outlet context={outletContext} />
          </main>
          <FavoritenLeiste sichtbar={!isDetailPage && !menueOffen} />
          <MobilMenue offen={menueOffen} onSchliessen={schliesseMenue} />
          {exitDialog}
        </div>
      </SeiteProvider>
    );
  }

  return (
    <SeiteProvider>
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
          <Outlet context={outletContext} />
        </main>
        {pdfOpen && pdfPostId && (
          <PdfPanel
            postid={pdfPostId}
            refreshKey={pdfKey}
            onClose={pdfCloseableRef.current ? closePdf : undefined}
          />
        )}

        {/* Exit-Bestätigungsdialog (Hardware-Zurück-Taste im PWA-Modus) */}
        {exitDialog}
      </div>
    </SeiteProvider>
  );
}
