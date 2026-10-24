/**
 * Scrollbereich des Mobil-Layouts. Mobil scrollt nicht das Fenster, sondern
 * <main> zwischen Kopf- und Favoritenleiste – so endet auch der Scrollbalken
 * über der unteren Leiste. Außerhalb des Mobil-Layouts: das Dokument.
 */
export const MOBIL_SCROLLER_ID = 'mobil-scroller';

export function mobilScroller() {
  return document.getElementById(MOBIL_SCROLLER_ID) || document.scrollingElement;
}
