/**
 * Hilfsfunktionen für die In-App-Hilfe (/hilfe).
 *
 * Die Kapitel unter `docs/` werden unverändert ausgeliefert und im Browser
 * gerendert. Damit die dort gepflegten Querverweise weiter funktionieren,
 * müssen zwei Dinge exakt zur Markdown-Quelle passen:
 *
 *   1. die Anker der Überschriften – sie werden nach demselben Verfahren
 *      gebildet wie auf GitHub (`github-slugger`), weil die Kapitel und das
 *      Stichwortverzeichnis genau dagegen geschrieben und geprüft sind;
 *   2. die Ziele der `.md`-Links – sie zeigen im Repo auf Dateien, in der App
 *      auf Routen.
 */

/** Kapiteldatei, die als Übersicht dient. */
export const DOCS_INDEX = 'README';

/**
 * Anker einer Überschrift nach dem Verfahren von `github-slugger`:
 * kleinschreiben, alles außer Buchstaben, Ziffern, kombinierenden Zeichen,
 * Unterstrich und Bindestrich entfernen, Leerraum zu Bindestrichen.
 *
 * Das ist der Grund, warum aus `Archivieren („Historisch")` der Anker
 * `archivieren-historisch` wird und aus `Teil 1 – Die Datenbank sichern`
 * einer mit zwei Bindestrichen. Nicht „vereinfachen" – die Links in den
 * Kapiteln sind gegen genau dieses Verhalten verifiziert.
 */
export function docsAnker(text) {
  return String(text)
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\p{Pc}\s-]/gu, '')
    .replace(/\s/g, '-');
}

/**
 * Erzeugt eine Funktion, die Anker innerhalb eines Kapitels vergibt und dabei
 * Dubletten wie GitHub durchnummeriert (`titel`, `titel-1`, …). Pro gerendertem
 * Kapitel eine eigene Instanz anlegen.
 */
export function ankerZaehler() {
  const gesehen = new Map();
  return (text) => {
    const basis = docsAnker(text);
    const n = gesehen.get(basis) ?? 0;
    gesehen.set(basis, n + 1);
    return n === 0 ? basis : `${basis}-${n}`;
  };
}

/** Kapitelnamen, die als Route zulässig sind – schützt den fetch-Pfad. */
export const KAPITEL_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Route zu einem Kapitel; die Übersicht liegt auf /hilfe selbst. */
export function kapitelRoute(name, anker) {
  const basis = name === DOCS_INDEX ? '/hilfe' : `/hilfe/${name}`;
  return anker ? `${basis}#${anker}` : basis;
}

/**
 * Schlanke Hilfe: Kapitel ohne App-Navigation, für Links aus Assistenten, die
 * in einem neuen Tab öffnen. Der Merker liegt in der sessionStorage dieses
 * Tabs, damit er beim Blättern zwischen Kapiteln (Links ohne Query) erhalten
 * bleibt.
 */
const SCHLANK_PARAM = 'rahmen';
const SCHLANK_KEY = 'postbuch.hilfe.schlank';

export function schlankeHilfeUrl(name = DOCS_INDEX, anker) {
  const basis = name === DOCS_INDEX ? '/hilfe' : `/hilfe/${name}`;
  return `${basis}?${SCHLANK_PARAM}=schlank${anker ? `#${anker}` : ''}`;
}

export function istSchlankeHilfe(search) {
  if (new URLSearchParams(search).get(SCHLANK_PARAM) === 'schlank') {
    try { sessionStorage.setItem(SCHLANK_KEY, '1'); } catch { /* ohne Speicher gilt nur die URL */ }
    return true;
  }
  try { return sessionStorage.getItem(SCHLANK_KEY) === '1'; } catch { return false; }
}

/**
 * Deutet einen Link aus einem Markdown-Kapitel.
 *
 * - `extern`    – http(s)/mailto, wird in einem neuen Tab geöffnet
 * - `anker`     – Sprung innerhalb des Kapitels
 * - `kapitel`   – anderes Kapitel, ggf. mit Anker
 * - `unbekannt` – alles, was in der App kein Ziel hat (etwa `../README.md`
 *                 oder ein Verweis auf ein Verzeichnis). Wird als Text
 *                 gerendert statt als toter Link.
 */
export function deuteLink(href) {
  if (!href) return { typ: 'unbekannt' };
  if (/^(https?:|mailto:)/i.test(href)) return { typ: 'extern', ziel: href };
  if (href.startsWith('#')) return { typ: 'anker', anker: decodeURIComponent(href.slice(1)) };

  const [pfad, anker] = href.split('#');
  if (!pfad || pfad.includes('/')) return { typ: 'unbekannt' };
  if (!pfad.endsWith('.md')) return { typ: 'unbekannt' };

  const name = pfad.slice(0, -3);
  if (!KAPITEL_RE.test(name) && name !== DOCS_INDEX) return { typ: 'unbekannt' };
  return { typ: 'kapitel', name, anker: anker ? decodeURIComponent(anker) : undefined };
}

/** Bildpfade sind relativ zu `docs/` gepflegt und liegen ausgeliefert unter /docs/. */
export function bildQuelle(src) {
  if (!src) return undefined;
  if (/^(https?:|data:)/i.test(src)) return src;
  return `/docs/${src.replace(/^\.?\//, '')}`;
}

/**
 * Sammelt die `##`-Überschriften eines Kapitels für das Inhaltsverzeichnis.
 * Code-Blöcke werden vorher entfernt – sonst landet etwa die Beispielausgabe
 * `# {"status":"ok"}` aus dem Betriebskapitel im Verzeichnis.
 */
export function inhaltsverzeichnis(markdown) {
  const ohneCode = markdown.replace(/^```[\s\S]*?^```/gm, '');
  const anker = ankerZaehler();
  const eintraege = [];
  for (const zeile of ohneCode.split('\n')) {
    const treffer = /^(#{1,3})\s+(.+?)\s*$/.exec(zeile);
    if (!treffer) continue;
    const text = treffer[2].replace(/\*\*|`|__/g, '');
    const id = anker(text);
    if (treffer[1].length === 2) eintraege.push({ text, id });
  }
  return eintraege;
}
