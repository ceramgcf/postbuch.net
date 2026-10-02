/**
 * PdfInlineViewer – schlanke, eingebettete PDF-Vorschau.
 *
 * Warum kein `<iframe src="…/pdf">`: nginx liefert auf allen Antworten
 * `X-Frame-Options: DENY` aus (web/nginx.conf), Browser verweigern das Einbetten
 * deshalb auch für gleiche Herkunft. react-pdf lädt das PDF per XHR und rendert
 * es in ein <canvas> – der Header greift dort nicht. Denselben Weg geht bereits
 * PdfPanel.jsx; diese Variante ist die Toolbar-lose Vorschau für Review-Ansichten
 * (Abrechnungs-Wizard, Duplikat-Vergleich).
 *
 * Seiten werden untereinander gestapelt und auf Containerbreite skaliert. Um bei
 * umfangreichen Sammel-PDFs nicht Dutzende Canvas-Elemente auf einmal zu
 * rendern, wachsen sie beim Scrollen nach.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Document, Page } from 'react-pdf';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import '@/lib/pdfjs-worker';

import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

const ERSTE_SEITEN = 3;
const SEITEN_SCHRITT = 3;

// Gleiches Verhalten wie in PdfPanel.jsx: pdf.js liefert beim Laden/Parsen keinen
// echten Fortschritt, deshalb erscheint der beruhigende Hinweis erst nach 3s.
function LadeAnzeige() {
  const [hinweis, setHinweis] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setHinweis(true), 3000);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div className="flex flex-col items-center justify-center py-16">
      <Spinner className="h-7 w-7" />
      {hinweis && (
        <p className="mt-3 px-6 text-center text-sm text-muted-foreground">
          Großes Dokument wird verarbeitet…
        </p>
      )}
    </div>
  );
}

export function PdfInlineViewer({ file, className, style, fehlerText = 'PDF konnte nicht geladen werden.' }) {
  const scrollRef = useRef(null);
  const messRef = useRef(null);
  const sentinelRef = useRef(null);
  const [breite, setBreite] = useState(0);
  const [seitenGesamt, setSeitenGesamt] = useState(0);
  const [sichtbareSeiten, setSichtbareSeiten] = useState(ERSTE_SEITEN);

  // Cookie-Auth: react-pdf lädt das PDF per XHR, ohne credentials käme 401 zurück.
  const options = useMemo(() => ({ withCredentials: true }), []);

  // Neues Dokument → wieder oben und nur die ersten Seiten rendern.
  useEffect(() => {
    setSeitenGesamt(0);
    setSichtbareSeiten(ERSTE_SEITEN);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [file]);

  // Seitenbreite folgt dem Container (contentRect misst ohne Scrollbalken).
  useEffect(() => {
    const el = messRef.current;
    if (!el) return undefined;
    const beobachter = new ResizeObserver(([eintrag]) => {
      setBreite(Math.max(0, Math.floor(eintrag.contentRect.width)));
    });
    beobachter.observe(el);
    return () => beobachter.disconnect();
  }, []);

  // Nachladen, sobald das Ende der gerenderten Seiten in Sichtweite kommt.
  useEffect(() => {
    const ziel = sentinelRef.current;
    if (!ziel || sichtbareSeiten >= seitenGesamt) return undefined;
    const beobachter = new IntersectionObserver(
      ([eintrag]) => {
        if (eintrag.isIntersecting) {
          setSichtbareSeiten((n) => Math.min(n + SEITEN_SCHRITT, seitenGesamt));
        }
      },
      { root: scrollRef.current, rootMargin: '400px' },
    );
    beobachter.observe(ziel);
    return () => beobachter.disconnect();
  }, [sichtbareSeiten, seitenGesamt]);

  const onLoadSuccess = useCallback(({ numPages }) => {
    setSeitenGesamt(numPages);
    setSichtbareSeiten(Math.min(ERSTE_SEITEN, numPages));
  }, []);

  return (
    <div
      ref={scrollRef}
      className={cn('relative overflow-y-auto overflow-x-hidden rounded-lg border bg-muted/30', className)}
      style={style}
    >
      {seitenGesamt > 0 && (
        <div className="sticky top-2 z-10 flex justify-end pr-2">
          <span className="rounded-full bg-background/90 border px-2 py-0.5 text-xs text-muted-foreground shadow-sm backdrop-blur-sm">
            {seitenGesamt} Seite{seitenGesamt !== 1 ? 'n' : ''}
          </span>
        </div>
      )}
      <div ref={messRef} className="p-2">
        <Document
          file={file}
          options={options}
          onLoadSuccess={onLoadSuccess}
          loading={<LadeAnzeige />}
          error={<p className="py-16 text-center text-sm text-destructive px-4">{fehlerText}</p>}
          className="flex flex-col items-center"
        >
          {Array.from({ length: sichtbareSeiten }, (_, i) => (
            <Page
              key={i}
              pageNumber={i + 1}
              width={breite > 0 ? breite : undefined}
              className="mb-3 last:mb-0 shadow-sm"
              loading={
                <div className="flex items-center justify-center py-10">
                  <Spinner className="h-5 w-5" />
                </div>
              }
            />
          ))}
        </Document>
        <div ref={sentinelRef} className="h-px w-full" />
      </div>
    </div>
  );
}
