/**
 * Dokumentenstapel-Trennung im Browser: Aufteilung live berechnen, während der
 * Nutzer Trennstellen umschaltet und Seiten entfernt.
 *
 * Gegenstück zu app/src/service/stapel-aufteilung.js (aufteilung(),
 * trennstellen()). Beide müssen dieselbe Reihenfolge anwenden: Entscheidung
 * des Nutzers → Vorschlag der KI → Standard „nicht trennen“ (ohne Vorschlag ein Dokument). Der Server rechnet
 * beim Übernehmen selbst nach; diese Fassung dient nur der Anzeige.
 */

export const seiteId = (seq, seite) => `${seq}:${seite}`;

/** Blätter mit Inhalt in Scanreihenfolge (fehlende und leere fallen weg). */
export function blaetterMitInhalt(blaetter) {
  return (blaetter || []).filter((b) => b.zustand === 'da' && b.seiten >= 1);
}

/** Nummern der Blätter, nach denen eine Trennstelle liegt. */
export function trennstellen(blaetter) {
  return blaetterMitInhalt(blaetter).slice(0, -1).map((b) => b.seq);
}

/** Wirksamer Zustand einer Trennstelle samt Herkunft. */
export function stelle(nach, vorschlag, trennungen) {
  const k = String(nach);
  const ki = vorschlag?.grenzen?.[k] || null;
  const nutzer = trennungen?.[k];
  const geaendert = typeof nutzer === 'boolean';
  return {
    nach,
    trennen: geaendert ? nutzer : ki ? ki.trennen : false,
    geaendert,
    ki,
    // Unklar ist jede Stelle, die die KI nicht als sicher beurteilt hat.
    unklar: !ki || ki.sicherheit !== 'sicher',
  };
}

/**
 * Teilt die Blätter in Dokumente. Jedes Dokument kennt seine Blätter (für die
 * Anzeige) und die verbleibenden Seiten (ohne entfernte).
 */
export function aufteilen(blaetter, vorschlag, trennungen, entfernt) {
  const weg = entfernt instanceof Set ? entfernt : new Set(entfernt || []);
  const inhalt = blaetterMitInhalt(blaetter);
  const dokumente = [];
  let aktuell = null;
  inhalt.forEach((b, i) => {
    if (i === 0 || stelle(inhalt[i - 1].seq, vorschlag, trennungen).trennen) {
      aktuell = { blaetter: [], seiten: 0, start: b.seq };
      dokumente.push(aktuell);
    }
    aktuell.blaetter.push(b.seq);
    for (let s = 1; s <= Math.min(2, b.seiten); s++) {
      if (!weg.has(seiteId(b.seq, s))) aktuell.seiten++;
    }
  });
  // Ein Dokument behält die Art der KI, solange es genau ihre Blätter umfasst.
  const arten = artenDerKi(inhalt, vorschlag);
  dokumente.forEach((d) => { d.art = arten.get(d.blaetter.join(',')) || null; });
  return dokumente;
}

/** Wie artenDerKi() in app/src/service/stapel-aufteilung.js. */
function artenDerKi(inhalt, vorschlag) {
  const arten = new Map();
  if (!vorschlag?.arten?.length) return arten;
  const gruppen = [];
  inhalt.forEach((b, i) => {
    const ki = i > 0 ? vorschlag.grenzen?.[String(inhalt[i - 1].seq)] : null;
    if (i === 0 || (ki ? ki.trennen : true)) gruppen.push([]);
    gruppen[gruppen.length - 1].push(b.seq);
  });
  if (gruppen.length !== vorschlag.arten.length) return arten;
  gruppen.forEach((g, i) => { if (vorschlag.arten[i]) arten.set(g.join(','), vorschlag.arten[i]); });
  return arten;
}

const ROLLEN = {
  anlage: 'Anlage',
  vorblatt: 'Vorblatt',
  duplikat: 'Duplikat',
  beilage: 'Beilage',
  fortsetzung: 'Fortsetzung',
  leer_oder_werbung: 'Leer oder Werbung',
};

export function rollenText(rolle) {
  return ROLLEN[rolle] || null;
}

export const mehrzahl = (n, eins, viele) => `${n} ${n === 1 ? eins : viele}`;
