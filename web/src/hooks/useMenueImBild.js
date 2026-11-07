import { useLayoutEffect, useState } from 'react';

// Hält ein aufklappendes Menü (absolut unter seiner relativen Hülle) im sichtbaren
// Bereich: Passt es unter dem Auslöser nicht mehr in den Scrollbereich, klappt es nach
// oben auf, sofern dort Platz ist; sonst wird es ins Bild gerollt. Wächst das Menü
// nachträglich (z. B. nachgeladene Vorschläge), wird erneut geprüft.
// Liefert true, solange das Menü nach oben aufklappen soll.
export function useMenueImBild(ref, offen) {
  const [oben, setOben] = useState(false);

  useLayoutEffect(() => {
    const menue = ref.current;
    if (!offen || !menue) {
      setOben(false);
      return;
    }
    const RAND = 8;
    const pruefen = () => {
      const bereich = sichtbereich(menue);
      const hoehe = menue.getBoundingClientRect().height;
      const huelle = menue.parentElement.getBoundingClientRect();
      if (hoehe <= bereich.bottom - huelle.bottom - RAND) setOben(false);
      else if (hoehe <= huelle.top - bereich.top - RAND) setOben(true);
      else {
        setOben(false);
        menue.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    };
    pruefen();
    const beobachter = new ResizeObserver(pruefen);
    beobachter.observe(menue);
    return () => beobachter.disconnect();
  }, [ref, offen]);

  return oben;
}

// Sichtbarer Ausschnitt des nächsten scrollenden Vorfahren (mobil: .mobil-inhalt)
function sichtbereich(el) {
  for (let e = el.parentElement; e; e = e.parentElement) {
    const o = getComputedStyle(e).overflowY;
    if ((o === 'auto' || o === 'scroll') && e.scrollHeight > e.clientHeight) {
      const r = e.getBoundingClientRect();
      return { top: Math.max(r.top, 0), bottom: Math.min(r.bottom, window.innerHeight) };
    }
  }
  return { top: 0, bottom: window.innerHeight };
}
