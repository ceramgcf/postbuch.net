// Gemeinsame SQL-Bedingung für offene Rechnungen. Die äußeren Klammern sind
// wichtig, weil der Aufrufer mehrere Filter mit AND verknüpft.
export const UNBEZAHLT_SQL_CONDITION = `(
  (a.bezahlt_am IS NULL AND a.gesamtbetrag > COALESCE(a.bestritten_betrag, 0))
  OR (h.bezahlt_am IS NULL AND h.gesamtbetrag > COALESCE(h.bestritten_betrag, 0))
  OR (g.bezahlt_am IS NULL AND g.gesamtbetrag > COALESCE(g.bestritten_betrag, 0))
)`;
