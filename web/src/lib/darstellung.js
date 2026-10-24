/**
 * Darstellung der Oberfläche – reine Entscheidungslogik ohne React.
 *
 * Zwei getrennte Fragen:
 *   - Eingabeart (`istTouch`): Hover, Zieh-Griffe, Tooltips. Gilt in jedem Layout.
 *   - Struktur (`layout`): 'mobil' (Kopfleiste, Karten, Endlosliste) oder
 *     'desktop' (Sidebar, Tabellen, Seitenumschaltung).
 *
 * Das Layout folgt allein der verfügbaren Breite; eine Wahl gibt es nicht.
 * Das Viewport-Meta steht fest auf device-width, `innerWidth` ist daher auf
 * jedem Gerät die echte Breite in CSS-px.
 */

// Ab dieser Breite (CSS-px) reicht der Platz für Sidebar + Tabellen.
export const LAYOUT_GRENZE = 1024;

export function entscheideLayout(breite) {
  return breite < LAYOUT_GRENZE ? 'mobil' : 'desktop';
}

/** Momentaufnahme aus dem Browser (für useSyncExternalStore). */
export function leseUmgebung() {
  if (typeof window === 'undefined') {
    return { istTouch: false, breite: 1280 };
  }
  const istTouch = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  return { istTouch, breite: window.innerWidth };
}
