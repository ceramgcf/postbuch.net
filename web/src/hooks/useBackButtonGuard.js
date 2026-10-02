import { useEffect, useState, useCallback, useRef } from 'react';
import { useLocation } from 'react-router';

// Simplified, robust sentinel approach:
// - On first back: open dialog and push a sentinel state.
// - On second back (sentinel popped): exit attempt.
// - Cancel removes the sentinel without re-opening the dialog.
export function useBackButtonGuard({ enabled = true } = {}) {
  const [showExitDialog, setShowExitDialog] = useState(false);
  const location = useLocation();
  const dialogOpenRef = useRef(false);
  const sentinelAddedRef = useRef(false);
  const handlerRef = useRef(null);

  useEffect(() => {
    if (!enabled) return;

    const debug = typeof window !== 'undefined' && window.localStorage && window.localStorage.getItem('pwaBackDebug') === '1';

    const ensureSentinel = () => {
      try {
        if (!window.history.state || !window.history.state.pwa_sentinel) {
          window.history.pushState({ pwa_sentinel: true }, '', window.location.href);
          sentinelAddedRef.current = true;
          if (debug) console.log('[pwa-back] sentinel pushed (ensure)');
        }
      } catch (e) {
        if (debug) console.warn('[pwa-back] pushState failed (ensure)', e);
      }
    };

    // Ensure sentinel right away so it exists before any back press
    ensureSentinel();

    const onPop = (event) => {
      if (debug) console.log('[pwa-back] popstate', { dialogOpen: dialogOpenRef.current, sentinelAdded: sentinelAddedRef.current, href: window.location.href });

      if (!dialogOpenRef.current) {
        // First back: restore sentinel immediately to avoid navigation, then show dialog
        if (debug) console.log('[pwa-back] first back -> restore sentinel and show dialog');
        ensureSentinel();
        dialogOpenRef.current = true;
        setShowExitDialog(true);
      } else {
        // Second back while dialog open -> confirm exit
        if (debug) console.log('[pwa-back] second back -> confirming exit');
        sentinelAddedRef.current = false;
        dialogOpenRef.current = false;
        setShowExitDialog(false);
        try { window.close(); } catch (e) { if (debug) console.warn('[pwa-back] window.close() failed', e); }
        setTimeout(() => { try { window.history.go(-window.history.length); } catch (e) { if (debug) console.warn('[pwa-back] history.go failed', e); } }, 50);
      }
    };

    window.addEventListener('popstate', onPop);
    handlerRef.current = onPop;
    return () => {
      window.removeEventListener('popstate', onPop);
      handlerRef.current = null;
    };
  }, [enabled]);

  // On navigation, ensure sentinel is present for the new page and clear dialog state
  useEffect(() => {
    if (!enabled) return;
    try {
      if (!window.history.state || !window.history.state.pwa_sentinel) {
        window.history.pushState({ pwa_sentinel: true }, '', window.location.href);
        sentinelAddedRef.current = true;
      }
    } catch (e) {
      // ignore
    }
    dialogOpenRef.current = false;
    setShowExitDialog(false);
  }, [location.pathname, location.search, enabled]);

  const cancelExit = useCallback(() => {
    // Keep sentinel active; just close dialog.
    dialogOpenRef.current = false;
    setShowExitDialog(false);
  }, []);

  const confirmExit = useCallback(() => {
    if (handlerRef.current) {
      try { window.removeEventListener('popstate', handlerRef.current); } catch (e) { /* ignore */ }
      handlerRef.current = null;
    }
    dialogOpenRef.current = false;
    setShowExitDialog(false);
    try { window.close(); } catch (e) { /* ignore */ }
    setTimeout(() => { try { window.history.go(-window.history.length); } catch (e) { /* ignore */ } }, 50);
  }, []);

  return { showExitDialog, confirmExit, cancelExit };
}
