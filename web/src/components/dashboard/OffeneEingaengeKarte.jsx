/**
 * OffeneEingaengeKarte.jsx – Dashboard-Karte „Offene Eingänge“
 *
 * Zeigt je Gruppe, wie viele angenommene PDFs noch kein Dokument sind, und
 * führt in den Eingang der Importseite. Ohne offenen Eingang erscheint sie nicht.
 */
import { Link } from 'react-router';
import { ArrowRight, Inbox } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { useOffeneEingaenge } from '@/hooks/useOffeneEingaenge';
import { GRUPPEN, anzahlGesamt, istDringend } from '@/lib/eingang';

export default function OffeneEingaengeKarte() {
  const { zaehler, isLoading, error } = useOffeneEingaenge();
  const gesamt = anzahlGesamt(zaehler);
  if (isLoading || error || gesamt === 0) return null;

  const dringend = istDringend(zaehler);
  return (
    <Link to="/import?tab=eingang" className="block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <Card className={`transition-colors ${dringend
        ? 'border-red-300 bg-red-50 hover:bg-red-100/70 dark:border-red-800 dark:bg-red-950/20 dark:hover:bg-red-950/40'
        : 'hover:bg-muted/40'}`}
      >
        <CardContent className="flex flex-wrap items-center gap-x-4 gap-y-2 py-4">
          <Inbox className={`h-5 w-5 shrink-0 ${dringend ? 'text-red-600 dark:text-red-400' : 'text-primary'}`} />
          <p className="text-sm font-semibold">Offene Eingänge</p>
          <div className="flex flex-wrap gap-1.5">
            {GRUPPEN.filter((g) => zaehler[g.id] > 0).map((g) => (
              <span key={g.id} className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${g.badge}`}>
                <span className="tabular-nums">{zaehler[g.id]}</span>
                {g.label}
              </span>
            ))}
          </div>
          <span className="ml-auto inline-flex items-center gap-1 text-sm font-medium text-primary">
            Ansehen
            <ArrowRight className="h-4 w-4" />
          </span>
        </CardContent>
      </Card>
    </Link>
  );
}
