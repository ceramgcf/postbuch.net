/**
 * ModellwahlAuswahl.jsx – einfache oder gestaffelte Modellwahl der Dokumentanalyse
 *
 * Speichert sofort (`llm_modellwahl`), weil davon abhängt, welche Modellklassen
 * darunter überhaupt angezeigt werden. Die gespeicherten Modelle der jeweils
 * anderen Wahl bleiben erhalten und gelten beim Zurückschalten wieder.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';

const MODELLWAHLEN = {
  einfach: {
    titel: 'Ein Modell für alles',
    text: 'Ein Analysemodell liest jedes Dokument. Keine Voranalyse, Prompt-Caching immer an.',
  },
  gestaffelt: {
    titel: 'Nach Schwierigkeit gestaffelt',
    text: 'Eine Voranalyse schätzt jedes Dokument ein und wählt Leicht, Mittel, Schwierig oder Lange Dokumente.',
  },
};

export function ModellwahlAuswahl({ wert, onGespeichert, disabled }) {
  const qc = useQueryClient();
  const speichern = useMutation({
    mutationFn: (neu) => api.settings.update('llm_modellwahl', neu),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['settings'] });
      qc.invalidateQueries({ queryKey: ['cloudfrei-check'] });
      qc.invalidateQueries({ queryKey: ['cache-mode'] });
      qc.invalidateQueries({ queryKey: ['llm-empfehlungen'] });
      qc.invalidateQueries({ queryKey: ['ai-health'] });
      onGespeichert?.();
    },
  });

  return (
    <div className="space-y-1.5">
      <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Modellwahl der Dokumentanalyse">
        {Object.entries(MODELLWAHLEN).map(([id, m]) => (
          <button
            key={id} type="button" role="radio" aria-checked={wert === id}
            disabled={disabled || speichern.isPending}
            onClick={() => { if (wert !== id) speichern.mutate(id); }}
            className={`rounded-lg border px-3 py-2 text-left transition-colors disabled:opacity-60 ${wert === id ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50'}`}
          >
            <span className="text-sm font-medium">{m.titel}</span>
            <p className="mt-0.5 text-[11px] text-muted-foreground">{m.text}</p>
          </button>
        ))}
      </div>
      {speichern.isError && <p className="text-xs text-destructive">{speichern.error?.message}</p>}
    </div>
  );
}
