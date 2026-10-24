// Reine Geometrie des Kamerascanners – ohne OpenCV, damit sie im Hauptthread,
// im Worker und in den Node-Tests gleich läuft. Ecken sind immer
// [{x, y}, …] in der Reihenfolge oben links, oben rechts, unten rechts,
// unten links (im Bild, nicht im Dokument).

const WURZEL2 = Math.SQRT2;

/** Ordnet vier Punkte als oben links, oben rechts, unten rechts, unten links. */
export function ordneEcken(punkte) {
  const mx = punkte.reduce((s, p) => s + p.x, 0) / punkte.length;
  const my = punkte.reduce((s, p) => s + p.y, 0) / punkte.length;
  // Nach Winkel um den Schwerpunkt sortieren (im Uhrzeigersinn, da y nach unten
  // zeigt), dann so drehen, dass die Ecke mit kleinstem x+y vorn steht. Anders
  // als die reine Summen-/Differenzregel bleibt das auch bei ~45° stabil.
  const sortiert = punkte
    .map((p) => ({ x: p.x, y: p.y }))
    .sort((a, b) => Math.atan2(a.y - my, a.x - mx) - Math.atan2(b.y - my, b.x - mx));
  let start = 0;
  for (let i = 1; i < sortiert.length; i++) {
    if (sortiert[i].x + sortiert[i].y < sortiert[start].x + sortiert[start].y) start = i;
  }
  return [...sortiert.slice(start), ...sortiert.slice(0, start)];
}

function abstand(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Fläche des Vierecks (Gaußsche Trapezformel). */
export function flaeche(ecken) {
  let s = 0;
  for (let i = 0; i < ecken.length; i++) {
    const a = ecken[i];
    const b = ecken[(i + 1) % ecken.length];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

/** true, wenn das Viereck konvex und nicht verdreht ist. */
export function istKonvex(ecken) {
  let vorzeichen = 0;
  for (let i = 0; i < 4; i++) {
    const a = ecken[i];
    const b = ecken[(i + 1) % 4];
    const c = ecken[(i + 2) % 4];
    const kreuz = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(kreuz) < 1e-9) return false;
    const v = Math.sign(kreuz);
    if (vorzeichen && v !== vorzeichen) return false;
    vorzeichen = v;
  }
  return true;
}

/**
 * Größe des entzerrten Bilds: die längere der beiden gegenüberliegenden
 * Kanten, begrenzt auf `maxLang` Pixel an der langen Seite. Liegt das
 * Seitenverhältnis nahe an DIN A (√2), wird es darauf gerastet – die
 * Perspektive verkürzt sonst die fernere Kante, und fast alle Post ist A4.
 */
export function zielGroesse(ecken, maxLang = 3508) {
  const [tl, tr, br, bl] = ecken;
  let b = Math.max(abstand(tl, tr), abstand(bl, br));
  let h = Math.max(abstand(tl, bl), abstand(tr, br));
  const lang = Math.max(b, h);
  const kurz = Math.min(b, h);
  if (kurz > 0 && Math.abs(lang / kurz / WURZEL2 - 1) < 0.07) {
    if (h >= b) h = b * WURZEL2; else b = h * WURZEL2;
  }
  const faktor = Math.min(1, maxLang / Math.max(b, h));
  return { breite: Math.max(1, Math.round(b * faktor)), hoehe: Math.max(1, Math.round(h * faktor)) };
}

/**
 * Lange Bildseite in Pixeln für einheitliche PDF-Auflösung. Die kurze Seite
 * steht im PDF immer auf DIN-A4-Breite (8,27 Zoll, siehe pdfSchreiber.js);
 * bei höchstens `dpi` ergibt ein A4-Blatt 1654 × 2339 Pixel (200 dpi).
 * Kleinere Aufnahmen werden nicht hochgerechnet, die lange Seite ist auf das
 * Vierfache der kurzen gedeckelt (lange Kassenzettel).
 */
export function langeSeiteFuerDpi(ecken, dpi = 200) {
  const kurzMax = Math.round(8.27 * dpi);
  const { breite, hoehe } = zielGroesse(ecken, Infinity);
  const kurz = Math.min(breite, hoehe);
  const lang = Math.max(breite, hoehe);
  const faktor = Math.min(1, kurzMax / kurz, (kurzMax * 4) / lang);
  return Math.max(1, Math.round(lang * faktor));
}

/** Ecken mit einem Faktor skalieren (z. B. Analyse- → Fotoauflösung). */
export function skaliereEcken(ecken, fx, fy = fx) {
  return ecken.map((p) => ({ x: p.x * fx, y: p.y * fy }));
}

/** Größte Eckverschiebung zwischen zwei Vierecken, relativ zur Bilddiagonale. */
export function eckBewegung(a, b, breite, hoehe) {
  const diag = Math.hypot(breite, hoehe) || 1;
  let max = 0;
  for (let i = 0; i < 4; i++) max = Math.max(max, abstand(a[i], b[i]));
  return max / diag;
}

/** Vorgabeviereck, wenn nichts erkannt wurde: das Bild mit etwas Rand. */
export function standardEcken(breite, hoehe, rand = 0.06) {
  const dx = breite * rand;
  const dy = hoehe * rand;
  return [
    { x: dx, y: dy },
    { x: breite - dx, y: dy },
    { x: breite - dx, y: hoehe - dy },
    { x: dx, y: hoehe - dy },
  ];
}

/** Punkt in das Bild klemmen. */
export function klemme(p, breite, hoehe) {
  return { x: Math.min(Math.max(p.x, 0), breite), y: Math.min(Math.max(p.y, 0), hoehe) };
}

/**
 * Ecken aus der Live-Vorschau (Koordinaten eines Bilds breite × hoehe) auf
 * ein Foto desselben Ausschnitts übertragen. Liefert null, wenn die Lage
 * (hoch/quer) nicht zusammenpasst.
 */
export function hinweisAufFoto(hinweis, fotoBreite, fotoHoehe) {
  if (!hinweis?.ecken || !hinweis.breite || !hinweis.hoehe) return null;
  if ((hinweis.breite > hinweis.hoehe) !== (fotoBreite > fotoHoehe)) return null;
  const s = Math.min(fotoBreite / hinweis.breite, fotoHoehe / hinweis.hoehe);
  const dx = (fotoBreite - hinweis.breite * s) / 2;
  const dy = (fotoHoehe - hinweis.hoehe * s) / 2;
  return hinweis.ecken.map((p) => klemme({ x: p.x * s + dx, y: p.y * s + dy }, fotoBreite, fotoHoehe));
}
