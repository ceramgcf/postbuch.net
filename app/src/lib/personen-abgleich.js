/**
 * lib/personen-abgleich.js — Namensangabe auf einen erfassten Kurznamen abbilden
 *
 * Dokumente verweisen per Text auf `postbuch.mensch.kurzname` (bewusst ohne FK).
 * Ein Name, der dort nicht exakt steht, ist ein Verweis ins Leere: das Dokument
 * fällt aus Personenfiltern, Abrechnungsperioden und dem Bescheid-Matching.
 *
 * Abgleich in zwei Stufen, beide deterministisch:
 *  1. exakt auf den Kurznamen,
 *  2. normalisiert (Groß-/Kleinschreibung, Leerraum, diakritische Zeichen, ß)
 *     auf Kurz- ODER Anzeigenamen — nur bei genau einem Kandidaten.
 * Alles andere wird verworfen statt geraten.
 */

export function normalisiereName(wert) {
  return String(wert ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss')
    .toLocaleLowerCase('de-DE')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Bewusst ohne Tippfehlertoleranz: dieser Abgleich läuft auch ohne menschliche
 * Prüfung (KI-Pipeline), und eine falsche Person ist schlimmer als keine.
 *
 * @param {unknown} roh - Namensangabe (z. B. KI-Ausgabe)
 * @param {{kurzname: string, anzeigename?: string|null}[]} menschen - gültige Ziele
 * @returns {{kurzname: string|null, art: 'leer'|'exakt'|'normalisiert'|'verworfen'}}
 */
export function gleichePersonAb(roh, menschen) {
  if (typeof roh !== 'string' || !roh.trim()) return { kurzname: null, art: 'leer' };
  const wert = roh.trim();
  if (menschen.some((m) => m.kurzname === wert)) return { kurzname: wert, art: 'exakt' };

  const ziel = normalisiereName(wert);
  const treffer = new Set(
    menschen
      .filter((m) => normalisiereName(m.kurzname) === ziel
        || (m.anzeigename && normalisiereName(m.anzeigename) === ziel))
      .map((m) => m.kurzname),
  );
  if (treffer.size === 1) return { kurzname: [...treffer][0], art: 'normalisiert' };
  return { kurzname: null, art: 'verworfen' };
}


function editierabstand(a, b) {
  const zeile = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = zeile[0];
    zeile[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const oben = zeile[j];
      zeile[j] = Math.min(zeile[j] + 1, zeile[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = oben;
    }
  }
  return zeile[b.length];
}

/**
 * Zuordnungsvorschlag für den Import einer Dokumentenübergabe. Anders als
 * `gleichePersonAb` darf hier auch ein Tippfehlerabstand greifen: jeder
 * Vorschlag wird vor dem Import von einem Menschen bestätigt oder geändert.
 *
 * @param {string} quellname - Kurzname in der Quellinstanz
 * @param {{anzeigename?: string|null}|null} legende - Eintrag aus der Personenlegende des Pakets
 * @param {{kurzname: string, anzeigename?: string|null}[]} menschen - Menschen der Zielinstanz
 * @returns {{kurzname: string|null, art: 'exakt'|'aehnlich'|null, grund: string|null}}
 */
export function schlageZuordnungVor(quellname, legende, menschen) {
  const quellAnzeige = legende?.anzeigename ? normalisiereName(legende.anzeigename) : '';

  const gleich = menschen.find((m) => m.kurzname === quellname);
  if (gleich) {
    if (quellAnzeige && gleich.anzeigename && normalisiereName(gleich.anzeigename) !== quellAnzeige) {
      return { kurzname: gleich.kurzname, art: 'aehnlich', grund: 'Kurzname gleich, Anzeigename abweichend' };
    }
    return { kurzname: gleich.kurzname, art: 'exakt', grund: 'Kurzname identisch' };
  }

  const schreibweise = gleichePersonAb(quellname, menschen);
  if (schreibweise.kurzname) return { kurzname: schreibweise.kurzname, art: 'aehnlich', grund: 'andere Schreibweise' };

  if (quellAnzeige) {
    const ueberAnzeige = gleichePersonAb(legende.anzeigename, menschen);
    if (ueberAnzeige.kurzname) return { kurzname: ueberAnzeige.kurzname, art: 'aehnlich', grund: 'gleicher Anzeigename' };
  }

  const suchwerte = [normalisiereName(quellname), quellAnzeige].filter(Boolean);
  let bester = Infinity;
  let kandidaten = new Set();
  for (const m of menschen) {
    for (const ziel of [m.kurzname, m.anzeigename].filter(Boolean).map(normalisiereName)) {
      for (const such of suchwerte) {
        const grenze = Math.max(such.length, ziel.length) <= 5 ? 1 : 2;
        const d = editierabstand(such, ziel);
        if (d > grenze) continue;
        if (d < bester) { bester = d; kandidaten = new Set([m.kurzname]); }
        else if (d === bester) kandidaten.add(m.kurzname);
      }
    }
  }
  if (kandidaten.size === 1) return { kurzname: [...kandidaten][0], art: 'aehnlich', grund: 'ähnliche Schreibweise' };
  return { kurzname: null, art: null, grund: null };
}
