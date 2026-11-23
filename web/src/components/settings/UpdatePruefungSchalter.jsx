/**
 * UpdatePruefungSchalter – die tägliche Update-Prüfung an- und abschalten.
 *
 * Eine Komponente für zwei Orte: die Karte „Version und Updates" in den
 * Einstellungen und den Schritt „Instanz und Netzwerk" im
 * Einrichtungsassistenten. Die Prüfung ist ab Werk an; wer nichts nach
 * draußen schicken will, schaltet sie hier sichtbar ab. Der Text sagt dafür
 * genau, was die Prüfung überträgt.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';

export function updatePruefungText(data) {
  if (!data?.checkAktiv) return 'Aus – es geht keine Anfrage nach draußen. Neue Versionen siehst du dann hier nicht.';
  if (!data?.bezugsquelleKonfiguriert) return 'Ausgesetzt, bis eine Bezugsquelle konfiguriert ist.';
  const quelle = data.kanalWaehlbar ? 'bei GitHub' : 'bei der Bezugsquelle';
  return `Fragt einmal täglich ${quelle} nach, ob es eine neue Version gibt. Übertragen wird dabei nur `
    + 'die Internetadresse deines Anschlusses, keine Dokumente und keine Daten. '
    + 'Installiert wird nur, wenn du es selbst anstößt.';
}

export default function UpdatePruefungSchalter({ className = '' }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['updates'], queryFn: () => api.updates.get() });
  const schalter = useMutation({
    mutationFn: (an) => api.settings.update('update_check_enabled', an),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['updates'] });
      qc.invalidateQueries({ queryKey: ['settings'] });
      qc.invalidateQueries({ queryKey: ['cloudfrei-check'] });
    },
  });
  const an = !!data?.checkAktiv;

  return (
    <div className={`flex items-center justify-between gap-4 ${className}`}>
      <div>
        <p className="text-sm font-medium">Täglich auf Updates prüfen</p>
        <p className="text-xs text-muted-foreground mt-0.5">{updatePruefungText(data)}</p>
        {schalter.isError && <p className="text-xs text-destructive mt-1">{schalter.error.message}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={an}
        aria-label="Täglich auf Updates prüfen"
        onClick={() => schalter.mutate(!an)}
        disabled={schalter.isPending || !data}
        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${an ? 'bg-primary' : 'bg-muted'}`}
      >
        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${an ? 'translate-x-6' : 'translate-x-1'}`} />
      </button>
    </div>
  );
}
