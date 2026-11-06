/**
 * prompts/antwort-schemas.js — JSON-Schemata der Antworten mit fester Struktur
 *
 * Anthropic (API und Abo) erzwingt damit die Struktur der Antwort, statt sie
 * nur zu erbitten. Andere Provider ignorieren das Schema und bleiben beim
 * JSON-Modus. Jedes Schema bildet exakt die Ausgabeform des zugehörigen
 * Prompts ab: Ein Feld, das hier fehlt, liefert das Modell nicht mehr.
 *
 * Regeln von Anthropic: jedes Objekt mit additionalProperties: false und
 * allen Feldern in required; keine Zahlen-/Längengrenzen, keine Rekursion.
 * Optionale Werte sind deshalb nullbar statt weglassbar. Mehrere Typen außer
 * null stehen in anyOf statt im type-Array: Der Validator des Agent SDK (Abo)
 * lehnt Union-Typen im strikten Modus ab.
 */

const nullbar = (typ) => ({ type: [typ, 'null'] });
const objekt = (properties) => ({
  type: 'object',
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
const liste = (items) => ({ type: 'array', items });

/** prompts/arztrechnung-positionen.js (Erstlesung und Nachlese) */
export const POSITIONEN_SCHEMA = objekt({
  einzelpositionen: liste(objekt({
    behandlungsDatum: nullbar('string'),
    ziffer: nullbar('string'),
    leistung: nullbar('string'),
    begruendung: nullbar('string'),
    faktor: nullbar('number'),
    betrag: nullbar('number'),
    zusatzangaben: nullbar('string'),
    abschnitt: nullbar('string'),
    belegzeilen: liste(objekt({
      beleg: nullbar('string'),
      nummer: nullbar('string'),
      leistung: nullbar('string'),
      menge: nullbar('number'),
      einzelpreis: nullbar('number'),
      betrag: nullbar('number'),
    })),
  })),
  kontrollsummen: objekt({
    rechnungsbetrag: nullbar('number'),
    zwischensummen: liste(objekt({
      abschnitt: { type: 'string' },
      betrag: nullbar('number'),
    })),
  }),
});

/** buildEbParsePrompt() in prompts/erstattungsbescheid.js */
export const BESCHEID_SCHEMA = objekt({
  kostentraeger: nullbar('string'),
  erkanntesProfil: nullbar('string'),
  bescheiddatum: nullbar('string'),
  erstattungsbetrag: nullbar('number'),
  hinweise: nullbar('string'),
  einzelpositionen: liste(objekt({
    belegNr: { anyOf: [{ type: 'integer' }, { type: 'string' }, { type: 'null' }] },
    behandeltePerson: nullbar('string'),
    kostenart: nullbar('string'),
    bezugsdatum: nullbar('string'),
    rechnungsbetrag: nullbar('number'),
    erstattungsbetrag: nullbar('number'),
    kuerzungsbetrag: nullbar('number'),
    kuerzungen: liste(objekt({
      betrag: nullbar('number'),
      begruendung: nullbar('string'),
    })),
  })),
  qualityFlags: objekt({
    warnungen: liste({ type: 'string' }),
    sicherheitsgrad: nullbar('number'),
    vertrauensgrad: nullbar('string'),
  }),
});

/** buildZerlegungPrompt() / buildZerlegungNachlesePrompt() in prompts/erstattungsbescheid.js */
export const ZERLEGUNG_SCHEMA = objekt({
  kuerzungen: liste(objekt({
    eb_subid: { type: 'integer' },
    kuerzung_index: { type: 'integer' },
    anteile: liste(objekt({
      arz_subid: nullbar('integer'),
      betrag: { type: 'number' },
      saetze: liste({ type: 'integer' }),
      rechenweg: nullbar('string'),
    })),
  })),
});
