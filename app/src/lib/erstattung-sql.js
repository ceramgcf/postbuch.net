/**
 * lib/erstattung-sql.js — gemeinsamer SQL-Baustein für die erwartete
 * Erstattung einer Arztrechnung.
 *
 * Periodenübersicht (routes/analyse.js) und Beitragsrückerstattung
 * (service/bre.js) rechnen mit derselben Formel, damit beide nie
 * auseinanderlaufen:
 *
 *   gesamtbetrag × COALESCE(Satz-Override der Rechnung, Satz der Periode,
 *                           Satz der Person) / 100
 *
 * Maßgeblich ist der Satz der Periode, in der die Rechnung gerade liegt. Die
 * Ausdrücke liefern NULL, wenn Betrag oder jeder Satz fehlt.
 *
 * Alle Parameter sind Tabellen-Aliase aus dem Code, nie Nutzereingaben.
 */

const SPALTEN = {
  PKV: { override: 'pkv_satz_override', person: 'pkv_satz' },
  Beihilfe: { override: 'beihilfe_satz_override', person: 'beihilfe_satz' },
};

function spalten(kostentraeger) {
  const s = SPALTEN[kostentraeger];
  if (!s) throw new Error(`Unbekannter Kostenträger: ${kostentraeger}`);
  return s;
}

/**
 * Effektiver Erstattungssatz in Prozent.
 * @param {'PKV'|'Beihilfe'} kostentraeger
 * @param {{rechnung?: string, periode?: string, person?: string}} [aliase]
 */
export function erstattungsSatzSql(kostentraeger, { rechnung = 'a', periode = 'ab', person = 'per' } = {}) {
  const s = spalten(kostentraeger);
  return `COALESCE(${rechnung}.${s.override}, ${periode}.satz, ${person}.${s.person})`;
}

/**
 * Erwartete Erstattung in Euro (NULL, wenn Betrag oder Satz fehlen).
 * @param {'PKV'|'Beihilfe'} kostentraeger
 * @param {{rechnung?: string, periode?: string, person?: string}} [aliase]
 */
export function erwarteteErstattungSql(kostentraeger, aliase = {}) {
  const rechnung = aliase.rechnung ?? 'a';
  const satz = erstattungsSatzSql(kostentraeger, aliase);
  return `CASE WHEN ${rechnung}.gesamtbetrag IS NOT NULL AND ${satz} IS NOT NULL
            THEN ${rechnung}.gesamtbetrag * ${satz} / 100.0 ELSE NULL END`;
}
