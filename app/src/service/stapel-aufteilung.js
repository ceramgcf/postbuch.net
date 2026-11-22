/**
 * service/stapel-aufteilung.js – reine Logik der Dokumentenstapel-Trennung
 *
 * Ohne Datenbank und Dateien, damit sie vollständig testbar ist:
 *   - pruefeVorschlag():      KI-Antwort gegen die Blattstruktur prüfen und normalisieren
 *   - pruefeEntscheidung():   Eingabe aus der Trennansicht prüfen und normalisieren
 *   - aufteilung():           Dokumente aus Blättern, Vorschlag und Entscheidung
 *   - automatischMoeglich():  Darf der Stapel ohne Rückfrage weitergehen?
 *
 * Begriffe: Ein Blatt hat die Nummer `seq` (1…n) und 1 oder 2 Seiten. Eine
 * Seite heißt `"<seq>:<seite>"`. Eine Trennstelle liegt zwischen zwei
 * aufeinanderfolgenden Blättern mit Inhalt und heißt nach dem Blatt davor.
 * Leere und fehlende Blätter haben keine Seiten und keine Trennstellen.
 */

export const ROLLEN = Object.freeze(['anlage', 'vorblatt', 'duplikat', 'beilage', 'fortsetzung', 'leer_oder_werbung']);
// Rollen, bei denen die Zuordnung genau der Fall ist, den ein Mensch sehen soll.
export const ZWEIFELSROLLEN = Object.freeze(['anlage', 'vorblatt', 'duplikat', 'beilage', 'leer_oder_werbung']);
export const SICHERHEITEN = Object.freeze(['sicher', 'wahrscheinlich', 'unklar']);
export const MAX_SEITEN_AUTO = 20;

const GRUND_MAX = 200;
const ART_MAX = 60;

const seiteId = (seq, s) => `${seq}:${s}`;

function text(wert, max) {
  if (typeof wert !== 'string') return null;
  const t = wert.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Blätter mit Inhalt in Scanreihenfolge. */
export function blaetterMitInhalt(blaetter) {
  return [...(blaetter || [])]
    .filter((b) => b.zustand === 'da' && Number(b.seiten) >= 1)
    .sort((a, b) => a.seq - b.seq);
}

/** Alle Seiten in Scanreihenfolge mit fortlaufender Nummer. */
export function seitenliste(blaetter) {
  const liste = [];
  for (const b of blaetterMitInhalt(blaetter)) {
    for (let s = 1; s <= Math.min(2, Number(b.seiten)); s++) {
      liste.push({ id: seiteId(b.seq, s), seq: b.seq, seite: s, nr: liste.length + 1 });
    }
  }
  return liste;
}

/** Nummern der Blätter, nach denen eine Trennstelle liegt. */
export function trennstellen(blaetter) {
  return blaetterMitInhalt(blaetter).slice(0, -1).map((b) => b.seq);
}

/**
 * Prüft die KI-Antwort gegen die Blattstruktur.
 * Unbekannte Stellen und Seiten werden verworfen, fehlende Stellen gelten als
 * „unklar, nicht trennen“. Wirft nur, wenn die Antwort gar keine Form hat.
 *
 * @returns {{ grenzen: Object<string,{trennen:boolean,sicherheit:string,grund:string|null}>,
 *             rollen: Object<string,string>, arten: string[], eindeutig: boolean, vollstaendig: boolean }}
 */
export function pruefeVorschlag(roh, blaetter) {
  if (!roh || typeof roh !== 'object' || !Array.isArray(roh.grenzen)) {
    throw new Error('Antwort ohne Trennstellen');
  }
  const stellen = new Set(trennstellen(blaetter));
  const grenzen = {};
  for (const g of roh.grenzen) {
    const nach = Number(g?.nach_blatt);
    if (!Number.isInteger(nach) || !stellen.has(nach) || grenzen[nach]) continue;
    grenzen[nach] = {
      trennen: g.trennen === true,
      sicherheit: SICHERHEITEN.includes(g.sicherheit) ? g.sicherheit : 'unklar',
      grund: text(g.grund, GRUND_MAX),
    };
  }
  let vollstaendig = true;
  for (const nach of stellen) {
    if (!grenzen[nach]) {
      vollstaendig = false;
      grenzen[nach] = { trennen: false, sicherheit: 'unklar', grund: null };
    }
  }

  const seiten = seitenliste(blaetter);
  const nachNr = new Map(seiten.map((s) => [s.nr, s.id]));
  const rollen = {};
  for (const r of Array.isArray(roh.seiten) ? roh.seiten : []) {
    const id = nachNr.get(Number(r?.seite));
    if (id && ROLLEN.includes(r.rolle)) rollen[id] = r.rolle;
  }

  const arten = (Array.isArray(roh.dokumente) ? roh.dokumente : [])
    .map((d) => text(d?.art, ART_MAX) || '')
    .slice(0, 200);

  return { grenzen, rollen, arten, eindeutig: roh.eindeutig === true, vollstaendig };
}

/**
 * Prüft die Entscheidung aus der Trennansicht.
 * @param {{ trennungen?: object, entfernt?: string[], drehungen?: object }} body
 * @returns {{ fehler: string } | { wert: { trennungen: Object<string,boolean>, entfernt: string[],
 *                                         drehungen: Object<string,number> } }}
 */
export function pruefeEntscheidung(body, blaetter) {
  const stellen = new Set(trennstellen(blaetter).map(String));
  const seiten = new Set(seitenliste(blaetter).map((s) => s.id));
  const trennungen = {};
  const roh = body?.trennungen;
  if (roh != null) {
    if (typeof roh !== 'object' || Array.isArray(roh)) return { fehler: 'trennungen muss ein Objekt sein' };
    for (const [k, v] of Object.entries(roh)) {
      if (!stellen.has(k)) return { fehler: `Unbekannte Trennstelle nach Blatt ${String(k).slice(0, 10)}` };
      if (typeof v !== 'boolean') return { fehler: 'Trennstellen sind true oder false' };
      trennungen[k] = v;
    }
  }
  const entfernt = [];
  if (body?.entfernt != null) {
    if (!Array.isArray(body.entfernt) || body.entfernt.length > 400) return { fehler: 'entfernt muss eine Liste sein' };
    for (const id of body.entfernt) {
      if (typeof id !== 'string' || !seiten.has(id)) return { fehler: 'Unbekannte Seite in entfernt' };
      if (!entfernt.includes(id)) entfernt.push(id);
    }
  }
  // Drehung je Seite im Uhrzeigersinn; 0 wird weggelassen.
  const drehungen = {};
  const rohD = body?.drehungen;
  if (rohD != null) {
    if (typeof rohD !== 'object' || Array.isArray(rohD)) return { fehler: 'drehungen muss ein Objekt sein' };
    for (const [id, grad] of Object.entries(rohD)) {
      if (!seiten.has(id)) return { fehler: 'Unbekannte Seite in drehungen' };
      if (![0, 90, 180, 270].includes(grad)) return { fehler: 'Drehungen sind 0, 90, 180 oder 270 Grad' };
      if (grad) drehungen[id] = grad;
    }
  }
  return { wert: { trennungen, entfernt, drehungen } };
}

/**
 * Teilt den Stapel auf.
 *
 * Reihenfolge je Trennstelle: Entscheidung des Nutzers → Vorschlag der KI →
 * Standard „nicht trennen“ (ohne Vorschlag liegen alle Seiten vorerst in einem
 * Dokument; der Nutzer trennt von Hand). Sind alle Seiten eines Dokuments entfernt,
 * entsteht es nicht.
 *
 * @returns {{ dokumente: Array<{ seiten: Array<{seq:number,seite:number,drehung:number}>, art: string|null }>,
 *             grenzen: Array<{ nach:number, vor:number, trennen:boolean, quelle:'nutzer'|'ki'|'standard',
 *                              sicherheit:string|null, grund:string|null }> }}
 */
export function aufteilung({ blaetter, vorschlag = null, entscheidung = null }) {
  const inhalt = blaetterMitInhalt(blaetter);
  const entfernt = new Set(entscheidung?.entfernt || []);
  const drehungen = entscheidung?.drehungen || {};
  const grenzen = [];
  const roh = [];
  let aktuell = [];
  inhalt.forEach((b, i) => {
    if (i > 0) {
      const vorher = inhalt[i - 1].seq;
      const k = String(vorher);
      const ki = vorschlag?.grenzen?.[k] || null;
      const nutzer = entscheidung?.trennungen?.[k];
      const trennen = typeof nutzer === 'boolean' ? nutzer : ki ? ki.trennen : false;
      grenzen.push({
        nach: vorher, vor: b.seq, trennen,
        quelle: typeof nutzer === 'boolean' ? 'nutzer' : ki ? 'ki' : 'standard',
        sicherheit: ki?.sicherheit || null,
        grund: ki?.grund || null,
      });
      if (trennen) { roh.push(aktuell); aktuell = []; }
    }
    for (let s = 1; s <= Math.min(2, Number(b.seiten)); s++) {
      aktuell.push({ seq: b.seq, seite: s, drehung: drehungen[seiteId(b.seq, s)] || 0 });
    }
  });
  if (aktuell.length) roh.push(aktuell);

  const arten = artenDerKi(inhalt, vorschlag);
  const dokumente = [];
  roh.forEach((seiten) => {
    const bleibt = seiten.filter((s) => !entfernt.has(seiteId(s.seq, s.seite)));
    const blaetterDesTeils = [...new Set(seiten.map((s) => s.seq))];
    if (bleibt.length) dokumente.push({ seiten: bleibt, art: arten.get(blaetterDesTeils.join(',')) || null });
  });
  return { dokumente, grenzen };
}

/**
 * Art je Dokument der KI-Aufteilung, nach seinen Blättern („3,4,5“). Ein
 * Dokument behält seinen Namen, solange es genau diese Blätter umfasst, auch
 * wenn der Nutzer an anderer Stelle neu trennt.
 * @returns {Map<string,string>}
 */
export function artenDerKi(inhalt, vorschlag) {
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

/**
 * Prüft die Bedingungen für die Übernahme ohne Rückfrage. Das Selbsturteil der
 * KI allein genügt nie; jede Bedingung wird hier nachgerechnet.
 *
 * @returns {{ ja: boolean, grund: string|null }}
 */
export function automatischMoeglich({ eingeschaltet, vorschlag, blaetter, blaetterN }) {
  const nein = (grund) => ({ ja: false, grund });
  if (!eingeschaltet) return nein('Übernahme ohne Rückfrage ist ausgeschaltet');
  if (!vorschlag) return nein('Kein Trennvorschlag der KI');
  if (!vorschlag.eindeutig) return nein('Die KI hält den Stapel nicht für eindeutig');
  if (!vorschlag.vollstaendig) return nein('Die KI hat nicht jede Trennstelle beurteilt');
  const alle = blaetter || [];
  if (!blaetterN || alle.length !== blaetterN || alle.some((b) => b.zustand === 'angemeldet')) {
    return nein('Es fehlen Blätter');
  }
  // Ein Blatt, das erst nach dem Vorschlag ankam, hat keine beurteilte Stelle.
  if (trennstellen(alle).some((seq) => !vorschlag.grenzen?.[String(seq)])) {
    return nein('Nicht jede Trennstelle hat einen Vorschlag');
  }
  if (Object.values(vorschlag.grenzen || {}).some((g) => g.sicherheit !== 'sicher')) {
    return nein('Mindestens eine Trennstelle ist nicht sicher');
  }
  if (Object.values(vorschlag.rollen || {}).some((r) => ZWEIFELSROLLEN.includes(r))) {
    return nein('Der Stapel enthält Anlagen, Vorblätter, Duplikate oder Beilagen');
  }
  const { dokumente } = aufteilung({ blaetter: alle, vorschlag });
  if (!dokumente.length) return nein('Der Stapel hat keine Seiten');
  if (dokumente.some((d) => d.seiten.length > MAX_SEITEN_AUTO)) {
    return nein(`Ein Dokument hat mehr als ${MAX_SEITEN_AUTO} Seiten`);
  }
  return { ja: true, grund: null };
}
