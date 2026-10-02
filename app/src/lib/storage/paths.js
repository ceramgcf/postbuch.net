/**
 * lib/storage/paths.js — Dateinamen und Pfade für pfadbasierte Ablage-Backends
 *
 * Bei OneDrive ist alles ID-basiert: ein Dateiname ist reine Kosmetik, der Ort
 * steckt in der Parent-ID. Bei WebDAV **ist der Name der Ort**. Und der Name
 * kommt aus Quellen, die ein Angreifer beeinflussen kann:
 *
 *   • der LLM-Ausgabe (service/document-processor.js) — das analysierte PDF
 *     kann eingeschleust worden sein, Prompt Injection ins Dateisystem ist ein
 *     realer Pfad;
 *   • dem Header `X-Filename` an /api/webhooks/scan-complete;
 *   • Archiv-Importen;
 *   • dem Ablage-Backend selbst (meta.name — also dem, was ein Nutzer in der
 *     Nextcloud-Web-UI hingeschrieben hat).
 *
 * Deshalb wird NICHT an den ~15 Aufrufstellen saniert, sondern im Adapter, auf
 * jedes Segment, ohne Opt-out. Jede Aufrufstelle, die es vergessen könnte, ist
 * eine Lücke; der Adapter ist genau eine Stelle. Das entspricht der Rolle, die
 * assertItemId() im OneDrive-Adapter schon hat.
 *
 * Zwei Funktionen mit bewusst unterschiedlicher Semantik:
 *
 *   sanitizeSegment()  verlustbehaftet, wirft NIE, gibt null zurück, wenn nichts
 *                      Brauchbares übrig bleibt. Ein kaputter Dateiname darf ein
 *                      Dokument nicht nach _failed schicken — der Aufrufer fällt
 *                      auf einen Ersatznamen zurück.
 *   assertInsideRoot() wirft. Das ist die Sicherheitszusage, nicht die Kosmetik.
 *
 * Bewusst NICHT behandelt: Homoglyphen (kyrillisches „а" vs. lateinisches „a").
 * Eine Confusables-Prüfung produziert False Positives auf legitimen deutschen,
 * türkischen und griechischen Namen, und am Dateinamen hängt keine
 * Autorisierungsentscheidung — in welchen Ordner die Datei kommt, entscheidet
 * die App, nicht der Name. Akzeptiertes Restrisiko.
 */

/**
 * Steuerzeichen, Bidi-Overrides und unsichtbare Zeichen.
 *
 * Bewusst als numerische Codepoint-Bereiche statt als Zeichenklasse mit
 * Literalen: eine Regex, die diese Zeichen selbst enthält, ist im Editor
 * unsichtbar, im Diff unlesbar und beim nächsten „Aufräumen" versehentlich
 * kaputtgemacht. Hier steht schwarz auf weiß, was gemeint ist.
 */
const UNSICHTBARE_BEREICHE = [
  [0x0000, 0x001f], // C0-Steuerzeichen
  [0x007f, 0x007f], // DEL
  [0x00ad, 0x00ad], // SOFT HYPHEN
  [0x200b, 0x200f], // Zero-Width Space/NJ/J, LRM, RLM
  [0x202a, 0x202e], // Bidi-Embedding/Override — machen aus "fdp.txt" ein "txt.pdf"
  [0x2060, 0x2064], // Word Joiner, unsichtbare Operatoren
  [0x2066, 0x2069], // Bidi-Isolates
  [0xfeff, 0xfeff], // BOM / Zero-Width No-Break Space
];

/** Ist dieser Codepoint unsichtbar oder ein Steuerzeichen? */
function istUnsichtbar(codePoint) {
  return UNSICHTBARE_BEREICHE.some(([von, bis]) => codePoint >= von && codePoint <= bis);
}

/** Entfernt alle unsichtbaren Zeichen — codepoint-weise, surrogatsicher. */
function entferneUnsichtbare(str) {
  let out = '';
  for (const ch of str) {
    if (!istUnsichtbar(ch.codePointAt(0))) out += ch;
  }
  return out;
}

// In Datei-/Ordnernamen auf mindestens einem der Zielsysteme verboten.
// Der Backslash ist besonders wichtig: der WHATWG-URL-Parser behandelt ihn bei
// http/https wie einen Slash.
// eslint-disable-next-line no-control-regex
const VERBOTEN_RE = /[/\\:*?"<>|]/g;

// Windows-Gerätenamen. Kein Sicherheitsproblem, aber der Desktop-Sync-Client
// des Nutzers stolpert darüber — und der ist bei Nextcloud der Normalfall.
const RESERVIERT_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** ext4 und Nextcloud limitieren auf 255 Bytes; wir lassen Luft für Suffixe. */
export const MAX_SEGMENT_BYTES = 200;
/** Harte Obergrenze — darüber lehnt das Dateisystem ab. */
export const MAX_SEGMENT_BYTES_HART = 255;

const utf8 = new TextEncoder();

/** Länge in UTF-8-Bytes (nicht in Zeichen — „ä" ist zwei Bytes). */
export function byteLength(str) {
  return utf8.encode(str).length;
}

/**
 * Kürzt auf maxBytes UTF-8-Bytes, ohne eine Mehrbyte-Sequenz zu zerschneiden.
 * Codepoint-bewusst über den Spread-Operator (nicht slice()) — sonst zerfällt
 * ein Emoji in zwei kaputte Surrogate.
 */
function truncateBytes(str, maxBytes) {
  if (byteLength(str) <= maxBytes) return str;
  let out = '';
  let len = 0;
  for (const ch of str) {
    const chLen = byteLength(ch);
    if (len + chLen > maxBytes) break;
    out += ch;
    len += chLen;
  }
  return out;
}

/**
 * Macht aus einem beliebigen String ein sicheres Pfadsegment.
 *
 * Reihenfolge ist Teil der Zusage, nicht Geschmack:
 *   1. NFC-Normalisierung ZUERST — sonst umgehen kombinierende Zeichen jede
 *      Zeichen-Blockliste (und NFD-Namen aus der macOS-Welt kollidieren später
 *      im Cache-Vergleich).
 *   2. Unsichtbare/Steuerzeichen raus.
 *   3. Verbotene Zeichen raus.
 *   4. Whitespace zusammenfassen, Punkte/Spaces an den Rändern abschneiden.
 *   5. ERST DANN validieren — "\x00..\x00" muss nach dem Strippen als ".."
 *      auffallen, nicht vorher durchrutschen.
 *
 * @param {unknown} rawName
 * @param {{ maxBytes?: number }} [opts]
 * @returns {string|null} sicheres Segment oder null, wenn nichts übrig bleibt
 */
export function sanitizeSegment(rawName, opts = {}) {
  const maxBytes = opts.maxBytes ?? MAX_SEGMENT_BYTES;
  if (typeof rawName !== 'string') return null;

  let s = rawName.normalize('NFC');
  s = entferneUnsichtbare(s);
  s = s.replace(VERBOTEN_RE, '');
  s = s.replace(/\s+/g, ' ');
  // Führende/abschließende Punkte und Leerzeichen: Windows schneidet sie still
  // ab, wodurch zwei verschiedene Namen auf dieselbe Datei zeigen können.
  s = s.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');

  if (!s) return null;
  if (s === '.' || s === '..') return null;

  if (RESERVIERT_RE.test(s)) s = `_${s}`;

  s = truncateBytes(s, maxBytes);
  // Nach dem Kürzen erneut trimmen und prüfen — die Kürzung kann einen Punkt
  // oder ein Leerzeichen an den Rand geschoben haben.
  s = s.replace(/[.\s]+$/, '');
  if (!s || s === '.' || s === '..') return null;
  if (byteLength(s) > MAX_SEGMENT_BYTES_HART) return null;

  return s;
}

/**
 * sanitizeSegment für einen Dateinamen mit Endung: die Endung bleibt erhalten,
 * gekürzt wird nur der Namensteil. Ohne das würde aus einem langen Namen ein
 * „…rechnung-vom-maerz" ohne .pdf.
 *
 * @param {unknown} rawName
 * @param {string} fallbackBasename  wird verwendet, wenn vom Namen nichts bleibt
 * @returns {string} immer ein brauchbarer Dateiname
 */
export function sanitizeFilename(rawName, fallbackBasename = 'Dokument') {
  const raw = typeof rawName === 'string' ? rawName : '';
  const m = raw.match(/^(.*?)(\.[A-Za-z0-9]{1,10})?$/s);
  const rohBasis = m?.[1] ?? raw;
  const rohExt = m?.[2] ?? '';

  const ext = sanitizeSegment(rohExt.replace(/^\./, ''), { maxBytes: 10 });
  const extTeil = ext ? `.${ext}` : '';

  const basis = sanitizeSegment(rohBasis, { maxBytes: MAX_SEGMENT_BYTES - byteLength(extTeil) })
    ?? sanitizeSegment(fallbackBasename)
    ?? 'Dokument';

  return `${basis}${extTeil}`;
}

/**
 * Baut aus Root-URL und Segmenten eine URL und stellt sicher, dass sie den Root
 * nicht verlässt.
 *
 * Die Prüfung muss NACH dem URL-Parsen stehen, weil der WHATWG-Parser „..“
 * auflöst — genau der Fehler, der in Phase 0.2 in der Graph-URL steckte. Sie
 * darf sich außerdem nicht auf ein reines startsWith verlassen:
 *
 *   • Root ohne abschließenden Slash wäre Präfix eines Nachbarn:
 *     /dav/files/user  ist Präfix von  /dav/files/user2/geheim.pdf
 *   • ein „?“ oder „#“, das in einem Segment landet, würde die Assertion
 *     bestehen und trotzdem eine andere Ressource treffen
 *   • der Origin muss identisch sein, nicht nur der Pfad
 *
 * @param {URL} rootUrl   Wurzel des erlaubten Bereichs (Slash wird erzwungen)
 * @param {string[]} segments  bereits über sanitizeSegment gelaufene Segmente
 * @returns {URL}
 * @throws {Error} wenn das Ergebnis den Root verließe
 */
export function buildUrlInsideRoot(rootUrl, segments) {
  const root = new URL(rootUrl.href.endsWith('/') ? rootUrl.href : `${rootUrl.href}/`);

  // Jedes Segment einzeln enkodieren, dann mit '/' joinen. NIEMALS encodeURI
  // auf den Gesamtpfad — das ließe '/' und '..' durch.
  const encoded = segments
    .filter((s) => s !== undefined && s !== null && s !== '')
    .map((s) => encodeURIComponent(String(s)))
    .join('/');

  const finalUrl = new URL(encoded, root);
  assertInsideRoot(finalUrl, root);
  return finalUrl;
}

/**
 * Wirft, wenn finalUrl außerhalb von rootUrl liegt.
 * @param {URL} finalUrl
 * @param {URL} rootUrl
 */
export function assertInsideRoot(finalUrl, rootUrl) {
  const root = rootUrl.href.endsWith('/') ? rootUrl : new URL(`${rootUrl.href}/`);

  if (finalUrl.origin !== root.origin) {
    throw new Error('Pfadprüfung: Ziel liegt auf einem anderen Server als die konfigurierte Ablage.');
  }
  if (finalUrl.search !== '' || finalUrl.hash !== '') {
    throw new Error('Pfadprüfung: Query oder Fragment im Pfad ist nicht zulässig.');
  }
  if (finalUrl.href !== root.href && !finalUrl.href.startsWith(root.href)) {
    throw new Error('Pfadprüfung: Ziel liegt außerhalb des konfigurierten Ablage-Ordners.');
  }

  // Invariante gegen doppelt dekodierende Reverse-Proxies: der einmal
  // dekodierte Pfad darf weder ein '..'-Segment noch einen Backslash enthalten.
  let decoded;
  try {
    decoded = decodeURIComponent(finalUrl.pathname);
  } catch {
    throw new Error('Pfadprüfung: Pfad ist nicht dekodierbar.');
  }
  if (decoded.includes('\\') || decoded.split('/').some((seg) => seg === '..')) {
    throw new Error('Pfadprüfung: Pfad enthält unzulässige Segmente.');
  }
}

/**
 * Zerlegt einen vom Nutzer eingegebenen Pfad („/postbuch/Arztrechnung") in
 * sichere Segmente. Leere Segmente und '.' fallen weg; '..' wird abgelehnt,
 * nicht still entfernt — sonst würde „a/../b" klammheimlich zu „a/b".
 *
 * @param {string} path
 * @returns {string[]}
 */
export function splitSafePath(path) {
  const teile = String(path || '').split('/').map((s) => s.trim()).filter((s) => s !== '' && s !== '.');
  const out = [];
  for (const teil of teile) {
    if (teil === '..') {
      throw new Error('Pfadprüfung: ".." ist im Pfad nicht zulässig.');
    }
    const sicher = sanitizeSegment(teil);
    if (!sicher) {
      throw new Error(`Pfadprüfung: Segment "${teil.slice(0, 40)}" ergibt keinen gültigen Ordnernamen.`);
    }
    out.push(sicher);
  }
  return out;
}
