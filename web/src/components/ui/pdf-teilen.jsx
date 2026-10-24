/**
 * PDF über das Teilen-Menü des Betriebssystems weitergeben (Web Share API
 * mit Datei), etwa direkt an die App von PKV oder Beihilfe.
 *
 * usePdfTeilen – Logik für eigene Bedienelemente (z. B. Halbkreis-Menü)
 * PdfTeilenButton – fertiger Knopf; wird nur gerendert, wenn der Browser
 *                   Dateien teilen kann
 *
 * navigator.share() verlangt eine frische Nutzergeste. Dauert das Laden des
 * PDFs zu lange, verweigert der Browser das Teilen (NotAllowedError) – dann
 * liegt die Datei schon bereit und ein zweites Tippen teilt sofort.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Share2 } from 'lucide-react';

let teilenUnterstuetzt;

export function kannDateienTeilen() {
  if (teilenUnterstuetzt !== undefined) return teilenUnterstuetzt;
  try {
    teilenUnterstuetzt = typeof navigator !== 'undefined'
      && typeof navigator.share === 'function'
      && typeof navigator.canShare === 'function'
      && navigator.canShare({ files: [new File([''], 'probe.pdf', { type: 'application/pdf' })] });
  } catch {
    teilenUnterstuetzt = false;
  }
  return teilenUnterstuetzt;
}

// Dateiname aus Content-Disposition, falls der Aufrufer keinen kennt.
function dateinameAusAntwort(res) {
  const cd = res.headers.get('content-disposition') || '';
  const utf8 = cd.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8) {
    try { return decodeURIComponent(utf8[1]); } catch { /* ASCII-Variante nehmen */ }
  }
  const ascii = cd.match(/filename="([^"]+)"/i);
  return ascii ? ascii[1] : 'Dokument.pdf';
}

/**
 * @returns {{ zustand: 'bereit'|'laedt'|'nochmal'|'fehler', teilen: () => Promise<boolean> }}
 *          teilen() liefert true, sobald das Teilen-Menü abgeschlossen ist.
 */
export function usePdfTeilen(url, fileName) {
  const [zustand, setZustand] = useState('bereit');
  const dateiRef = useRef(null);
  const laeuftRef = useRef(false);

  useEffect(() => {
    dateiRef.current = null;
    setZustand('bereit');
  }, [url, fileName]);

  const teilen = useCallback(async () => {
    if (laeuftRef.current) return false;
    laeuftRef.current = true;
    try {
      let datei = dateiRef.current;
      if (!datei) {
        setZustand('laedt');
        const res = await fetch(url, { credentials: 'include' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        datei = new File([blob], fileName || dateinameAusAntwort(res), { type: 'application/pdf' });
        dateiRef.current = datei;
      }
      await navigator.share({ files: [datei] });
      setZustand('bereit');
      return true;
    } catch (err) {
      // Nutzer hat das Teilen-Menü geschlossen.
      if (err?.name === 'AbortError') { setZustand('bereit'); return true; }
      // Nutzergeste beim Laden verfallen: Datei liegt bereit, zweites Tippen teilt.
      if (err?.name === 'NotAllowedError' && dateiRef.current) { setZustand('nochmal'); return false; }
      console.warn('PDF teilen fehlgeschlagen:', err);
      setZustand('fehler');
      return false;
    } finally {
      laeuftRef.current = false;
    }
  }, [url, fileName]);

  return { zustand, teilen };
}

const BESCHRIFTUNG = {
  laedt: 'Wird geladen …',
  nochmal: 'Bereit – nochmal tippen',
  fehler: 'Teilen fehlgeschlagen – erneut versuchen',
};

// onTeilen läuft beim Tippen, bevor das PDF geladen wird (z. B. um zu vermerken,
// dass die Datei die App verlassen hat).
export function PdfTeilenButton({ url, fileName, label = 'Teilen', className, iconClassName = 'h-3.5 w-3.5', onTeilen }) {
  const { zustand, teilen } = usePdfTeilen(url, fileName);

  if (!kannDateienTeilen()) return null;

  return (
    <button type="button" onClick={() => { onTeilen?.(); teilen(); }} disabled={zustand === 'laedt'} className={className}>
      {zustand === 'laedt'
        ? <Loader2 className={`${iconClassName} animate-spin`} />
        : <Share2 className={iconClassName} />}
      {zustand === 'bereit' ? label : BESCHRIFTUNG[zustand]}
    </button>
  );
}
