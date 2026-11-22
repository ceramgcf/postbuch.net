/**
 * Bezeichnungen und Farben der offenen Eingänge – gemeinsam für Galerie,
 * Detailseite und Dashboard-Karte.
 */

// Zeitpunkt, zu dem der Nutzer fehlgeschlagene Dokumente zuletzt gesehen hat
// (Galerie oder Logs/Jobs); das Dashboard-Banner meldet nur neuere.
export const FAILED_DOCS_LAST_SEEN_KEY = 'failed_docs_last_seen';

export function markiereFehlschlaegeGesehen() {
  try { localStorage.setItem(FAILED_DOCS_LAST_SEEN_KEY, Date.now().toString()); } catch { /* privater Modus */ }
}

export const GRUPPEN = [
  {
    id: 'handlung', label: 'Handlung nötig',
    badge: 'bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300',
    punkt: 'bg-red-500',
  },
  {
    id: 'duplikatverdacht', label: 'Duplikatverdacht',
    badge: 'bg-violet-100 text-violet-700 dark:bg-violet-950/50 dark:text-violet-300',
    punkt: 'bg-violet-500',
  },
  {
    id: 'wartet', label: 'Wartet',
    badge: 'bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300',
    punkt: 'bg-amber-500',
  },
  {
    id: 'briefstapel', label: 'Dokumentenstapel',
    badge: 'bg-teal-100 text-teal-800 dark:bg-teal-950/50 dark:text-teal-300',
    punkt: 'bg-teal-500',
  },
  {
    id: 'verarbeitung', label: 'In Verarbeitung',
    badge: 'bg-sky-100 text-sky-700 dark:bg-sky-950/50 dark:text-sky-300',
    punkt: 'bg-sky-500',
  },
];

// Gruppen, die auf den Nutzer warten: roter Punkt an „Importieren“, rote
// Dashboard-Karte, Zahl am Reiter „Eingang“.
const DRINGEND = ['handlung', 'duplikatverdacht', 'briefstapel'];

export function anzahlDringend(zaehler) {
  return DRINGEND.reduce((n, id) => n + (zaehler?.[id] || 0), 0);
}

export function istDringend(zaehler) {
  return anzahlDringend(zaehler) > 0;
}

export function anzahlGesamt(zaehler) {
  return GRUPPEN.reduce((n, g) => n + (zaehler?.[g.id] || 0), 0);
}

export function gruppeVon(id) {
  return GRUPPEN.find((g) => g.id === id) || GRUPPEN[0];
}

const ZUSTAENDE = {
  laeuft: 'Wird verarbeitet',
  scan_laeuft: 'Scan läuft',
  eingereiht: 'Eingereiht',
  zurueckgestellt: 'Zurückgestellt',
  duplikat: 'Duplikatverdacht',
  fehlgeschlagen: 'Fehlgeschlagen',
  scan_retry: 'Upload wird wiederholt',
  scan_retry_erschoepft: 'Upload fehlgeschlagen',
  stapel_liest_ein: 'Wird eingelesen',
  stapel_vorschlag: 'Trennung wird vorgeschlagen',
  stapel_wartet: 'Trennung prüfen',
  stapel_teilt_auf: 'Wird aufgeteilt',
};

export function zustandText(e) {
  if (e.zustand === 'laeuft' && e.manuell) return 'Wird manuell abgelegt';
  return ZUSTAENDE[e.zustand] || e.zustand;
}

const HERKUNFT = { scanner: 'Scanner', upload: 'Upload', ablage: 'Ablage' };

export function herkunftText(herkunft) {
  return HERKUNFT[herkunft] || null;
}

export function zeitText(wert) {
  if (!wert) return null;
  const d = new Date(wert);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString('de-DE', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/** Kurze Zeile unter dem Namen: was gerade mit dem Eingang ist. */
export function grundZeile(e) {
  if (e.zustand === 'laeuft') return e.schritt || 'Verarbeitung läuft';
  if (e.zustand === 'scan_laeuft') return e.schritt || 'Scan läuft';
  if (e.stapel) return stapelZeile(e) || e.schritt || e.grund || null;
  if (e.zustand === 'eingereiht') return 'Wartet auf einen freien Platz in der Verarbeitung';
  if (e.zustand === 'duplikat') {
    const bis = zeitText(e.entscheidungBis);
    return [e.grund, bis && `Entscheidung bis ${bis}, danach werden beide behalten`].filter(Boolean).join(' · ');
  }
  return e.grund || e.letzterFehler || null;
}

const mehrzahl = (n, eins, viele) => `${n} ${n === 1 ? eins : viele}`;

/** Zeile unter einem Dokumentenstapel: „12 Seiten · 4 Dokumente vorgeschlagen“. */
export function stapelZeile(e) {
  const z = e.stapel;
  if (!z || e.zustand !== 'stapel_wartet') return e.schritt || null;
  const teile = [mehrzahl(z.seiten, 'Seite', 'Seiten')];
  teile.push(z.vorschlag ? `${mehrzahl(z.dokumente, 'Dokument', 'Dokumente')} vorgeschlagen` : 'ohne Vorschlag');
  if (z.fehlend) teile.push(mehrzahl(z.fehlend, 'Blatt fehlt', 'Blätter fehlen'));
  return teile.join(' · ');
}

export function eingangPfad(schluessel) {
  return `/import/eingang/${encodeURIComponent(schluessel)}`;
}

/** Vergleichsansicht alt/neu eines Duplikatverdachts. */
export function duplikatPfad(jobId) {
  return `/import/duplikat/${encodeURIComponent(jobId)}`;
}

/** Ziel einer Kachel: Duplikatverdacht öffnet den Vergleich, alles andere die Detailseite. */
export function eintragPfad(e) {
  return e.zustand === 'duplikat' && e.jobId ? duplikatPfad(e.jobId) : eingangPfad(e.schluessel);
}
