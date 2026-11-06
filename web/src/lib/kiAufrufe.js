// Bezeichnungen der Aufrufkategorien aus dem Token-Log (llm_call_log.kategorie),
// gemeinsam für das Token-Log und die KI-Aufschlüsselung am Dokument.
export const KI_KATEGORIE_LABEL = {
  preanalysis:                 'Voranalyse',
  analysis:                    'Klassifizierung',
  positionen:                  'Einzelpositionen',
  positionen_nachlese:         'Einzelpositionen – Nachlese',
  repair:                      'Reparatur',
  erstattungsbescheid:         'Bescheid-Auswertung',
  kuerzung:                    'Kürzungszerlegung',
  kuerzung_nachlese:           'Kürzungszerlegung – Nachlese',
  embedding:                   'Embedding',
  search:                      'Such-Embedding',
  akte_vorschlag:              'Akte-Vorschlag',
  'kostentraeger-profilierung': 'Kostenträger-Profil',
  chat:                        'Assistent',
  chat_title:                  'Assistent-Titel',
  other:                       'Sonstiges',
};

export const kiKategorieLabel = (k) => KI_KATEGORIE_LABEL[k] || k;

/** Kosten in Cent; null = kein Preis hinterlegt. */
export const kostenText = (usd) => (usd == null ? '–' : `${(Number(usd) * 100).toFixed(2)} ¢`);
