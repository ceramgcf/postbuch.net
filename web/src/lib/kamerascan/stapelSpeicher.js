// Dauerhafter Seitenstapel: Ein unfertiger Scan übersteht Verlassen und
// Neuladen der App, damit sich z. B. nacheinander geteilte Fotos zu einem
// Dokument sammeln lassen. Gespeichert werden nur die Rohdaten je Seite
// (Foto, Ecken, Drehung, Herkunft) – die fertigen Seiten rechnet der Scanner
// daraus beim Fortsetzen neu. Alles bleibt auf dem Gerät (IndexedDB)
// und verfällt nach einem Tag, wie geteilte Dateien.

const DB_NAME = 'postbuch-stapel';
const SEITEN = 'seiten';
const META = 'meta';
const HOECHSTALTER_MS = 24 * 60 * 60 * 1000;
export const STAPEL_EREIGNIS = 'postbuch-stapel';

let dbPromise = null;

function oeffne() {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('IndexedDB fehlt'));
  dbPromise ??= new Promise((resolve, reject) => {
    const anfrage = indexedDB.open(DB_NAME, 1);
    anfrage.onupgradeneeded = () => {
      const db = anfrage.result;
      if (!db.objectStoreNames.contains(SEITEN)) db.createObjectStore(SEITEN);
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
    };
    anfrage.onsuccess = () => resolve(anfrage.result);
    anfrage.onerror = () => { dbPromise = null; reject(anfrage.error); };
  });
  return dbPromise;
}

function fertig(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function wert(anfrage) {
  return new Promise((resolve, reject) => {
    anfrage.onsuccess = () => resolve(anfrage.result);
    anfrage.onerror = () => reject(anfrage.error);
  });
}

function melden() {
  try { window.dispatchEvent(new Event(STAPEL_EREIGNIS)); } catch { /* ohne Fenster kein Badge */ }
}

/** Neuer, gerätweit eindeutiger Schlüssel für eine Seite. */
export function neuerSchluessel() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Was von einer Seite gespeichert wird. Das Live-Vorschaubild (ImageBitmap)
// lässt sich nicht ablegen und wird nur für die erste Berechnung gebraucht.
function datensatz(s) {
  const hinweis = s.liveHinweis ? { ecken: s.liveHinweis.ecken, breite: s.liveHinweis.breite, hoehe: s.liveHinweis.hoehe } : null;
  return {
    foto: s.foto, ecken: s.ecken, drehung: s.drehung, erkannt: s.erkannt, pruefen: !!s.pruefen, quelle: s.quelle, liveHinweis: hinweis,
  };
}

function gleich(a, b) {
  return a.foto === b.foto && a.drehung === b.drehung && a.erkannt === b.erkannt && a.pruefen === b.pruefen
    && JSON.stringify(a.ecken) === JSON.stringify(b.ecken);
}

async function leseMeta(db) {
  return wert(db.transaction(META).objectStore(META).get('stapel'));
}

/** Kurzinfo für Badge und Fortsetzen-Zeile: { anzahl, zeit } oder null. */
export async function stapelInfo() {
  try {
    const meta = await leseMeta(await oeffne());
    if (!meta?.reihenfolge?.length || Date.now() - meta.zeit > HOECHSTALTER_MS) return null;
    return { anzahl: meta.reihenfolge.length, zeit: meta.zeit };
  } catch {
    return null;
  }
}

/**
 * Lädt den gespeicherten Stapel: { zeit, seiten: [{ schluessel, foto, ecken,
 * drehung, erkannt, pruefen, quelle, liveHinweis }] } oder null. Ein abgelaufener
 * Stapel wird dabei verworfen.
 */
export async function stapelLaden() {
  try {
    const db = await oeffne();
    const meta = await leseMeta(db);
    if (!meta?.reihenfolge?.length) return null;
    if (Date.now() - meta.zeit > HOECHSTALTER_MS) {
      await stapelLeeren();
      return null;
    }
    const store = db.transaction(SEITEN).objectStore(SEITEN);
    const seiten = [];
    for (const schluessel of meta.reihenfolge) {
      const s = await wert(store.get(schluessel));
      if (s?.foto) seiten.push({ schluessel, ...s });
    }
    return seiten.length ? { zeit: meta.zeit, seiten } : null;
  } catch {
    return null;
  }
}

/** Entfernt den gespeicherten Stapel vollständig. */
export async function stapelLeeren() {
  try {
    const db = await oeffne();
    const tx = db.transaction([SEITEN, META], 'readwrite');
    tx.objectStore(SEITEN).clear();
    tx.objectStore(META).clear();
    await fertig(tx);
  } catch { /* nichts gespeichert */ }
  melden();
}

/**
 * Speichert den Stapel inkrementell: Seiten, deren Rohdaten sich nicht
 * geändert haben, werden nicht erneut geschrieben (Fotos sind groß), und der
 * Zeitstempel ändert sich nur mit dem Inhalt – er zeigt die letzte echte
 * Änderung. Schreibvorgänge laufen nacheinander, damit ein schnelles
 * Umsortieren nicht von einem älteren Stand überholt wird.
 * `beiFehler` meldet, wenn das Gerät den Stapel nicht ablegen konnte (Quota).
 */
export function erstelleStapelSpeicher({ beiFehler } = {}) {
  let gespeichert = new Map(); // schluessel → datensatz
  let reihenfolge = '';
  let kette = Promise.resolve();

  async function schreibe(seiten) {
    const d = await oeffne();
    const tx = d.transaction([SEITEN, META], 'readwrite');
    const store = tx.objectStore(SEITEN);
    const neu = new Map();
    let geaendert = false;
    for (const s of seiten) {
      const satz = datensatz(s);
      const alt = gespeichert.get(s.schluessel);
      if (!alt || !gleich(alt, satz)) { store.put(satz, s.schluessel); geaendert = true; }
      neu.set(s.schluessel, satz);
    }
    for (const schluessel of gespeichert.keys()) {
      if (!neu.has(schluessel)) { store.delete(schluessel); geaendert = true; }
    }
    const neueReihenfolge = seiten.map((s) => s.schluessel).join(',');
    if (neueReihenfolge !== reihenfolge) geaendert = true;
    if (!geaendert) { tx.abort(); return false; }
    if (seiten.length) tx.objectStore(META).put({ reihenfolge: seiten.map((s) => s.schluessel), zeit: Date.now() }, 'stapel');
    else { store.clear(); tx.objectStore(META).clear(); }
    await fertig(tx);
    gespeichert = neu;
    reihenfolge = neueReihenfolge;
    melden();
    return true;
  }

  return {
    /** Stand übernehmen, der gerade geladen wurde (nichts neu schreiben). */
    kennt(seiten) {
      gespeichert = new Map(seiten.map((s) => [s.schluessel, datensatz(s)]));
      reihenfolge = seiten.map((s) => s.schluessel).join(',');
    },
    /** Liefert true, wenn sich der gespeicherte Stand dadurch geändert hat. */
    speichern(seiten) {
      const lauf = kette.then(() => schreibe(seiten)).catch((err) => { beiFehler?.(err); return false; });
      kette = lauf;
      return lauf;
    },
    leeren() {
      gespeichert = new Map();
      reihenfolge = '';
      kette = kette.then(() => stapelLeeren());
      return kette;
    },
  };
}
