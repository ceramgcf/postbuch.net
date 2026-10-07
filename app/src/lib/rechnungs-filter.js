// Zentrale SQL-Bausteine für den Zahlstatus von Rechnungen. Jede Abfrage, die
// „offene Rechnungen“ meint, setzt sich hieraus zusammen – sonst tauchen etwa
// durch eine Korrekturrechnung ersetzte Rechnungen in einzelnen Listen wieder auf.

// Wahr, wenn die Rechnungszeile mit Alias `alias` durch eine andere Rechnung
// ersetzt wurde (postbuch.dokument_beziehung, art 'ersetzt'). Eine ersetzte
// Rechnung ist erledigt: Ihre Zahlungen sind auf die Nachfolgerin umgezogen,
// ihr Streitfall endet mit der Ersetzung.
export function istErsetztSql(alias) {
  return `EXISTS (SELECT 1 FROM postbuch.dokument_beziehung db
     WHERE db.zu_postid = ${alias}.postid AND db.art = 'ersetzt')`;
}

// Wahr, wenn die Rechnungszeile mit Alias `alias` offen ist: nicht bezahlt,
// nicht vollständig bestritten und nicht ersetzt.
export function offeneRechnungSql(alias) {
  return `(${alias}.bezahlt_am IS NULL
    AND ${alias}.gesamtbetrag > COALESCE(${alias}.bestritten_betrag, 0)
    AND NOT ${istErsetztSql(alias)})`;
}

// Gemeinsame SQL-Bedingung für offene Rechnungen über die drei Rechnungsblöcke
// mit den Aliasen a/h/g. Die äußeren Klammern sind wichtig, weil der Aufrufer
// mehrere Filter mit AND verknüpft.
export const UNBEZAHLT_SQL_CONDITION = `(
  ${offeneRechnungSql('a')}
  OR ${offeneRechnungSql('h')}
  OR ${offeneRechnungSql('g')}
)`;

// Offener, nicht bestrittener Restbetrag einer Rechnungszeile mit Alias
// `alias`: Rechnungsbetrag − bestrittener Betrag − Summe der Zahlungen
// (postbuch.rechnung_zahlung). Für offene Rechnungen ist das der Betrag, der
// noch zu überweisen ist.
export function offenerBetragSql(alias) {
  return `(${alias}.gesamtbetrag - COALESCE(${alias}.bestritten_betrag, 0)
    - COALESCE((SELECT sum(z.betrag) FROM postbuch.rechnung_zahlung z WHERE z.postid = ${alias}.postid), 0))`;
}

// Zahldatum einer Rechnungszeile mit Alias `alias`, maßgeblich für das
// steuerliche Jahr (Abflussprinzip): das Datum der vollständigen Bezahlung,
// ersatzweise die jüngste Teilzahlung. NULL heißt: noch nichts gezahlt.
// Teilzahlungen über mehrere Jahre werden nicht aufgeteilt; die Rechnung
// zählt im Jahr ihrer letzten Zahlung.
export function zahldatumSql(alias) {
  return `COALESCE(${alias}.bezahlt_am,
    (SELECT max(z.datum) FROM postbuch.rechnung_zahlung z WHERE z.postid = ${alias}.postid))`;
}
