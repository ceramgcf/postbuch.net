// Anzeige des Abrechnungsperioden-Status. DB und API sprechen weiter die
// Enum-Werte COLLECTING/SUBMITTED/COMPLETED/OMITTED/WITHHELD; in der Oberfläche
// erscheinen ausschließlich die deutschen Bezeichnungen.

export const PERIODEN_STATUS_LABEL = {
  COLLECTING: 'SAMMELT',
  SUBMITTED: 'EINGEREICHT',
  COMPLETED: 'ABGESCHLOSSEN',
  OMITTED: 'AUSGELASSEN',
  // Für die Beitragsrückerstattung zurückgehaltene Rechnungen eines Jahres.
  WITHHELD: 'ZURÜCKGEHALTEN',
};

export const PERIODEN_STATUS_STYLE = {
  COLLECTING: 'text-blue-700 bg-blue-50 border-blue-200',
  SUBMITTED: 'text-amber-700 bg-amber-50 border-amber-200',
  COMPLETED: 'text-green-700 bg-green-50 border-green-200',
  OMITTED: 'text-slate-600 bg-slate-100 border-slate-300',
  WITHHELD: 'text-violet-700 bg-violet-50 border-violet-200',
};

export function periodenStatusLabel(status) {
  return PERIODEN_STATUS_LABEL[status] || status || '';
}
