/**
 * PendingDecisionsCard.jsx – Dashboard-Karte für ausstehende Duplikat-Entscheidungen
 */
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { Card, CardContent } from '@/components/ui/card';
import { api } from '@/api/client';

export default function PendingDecisionsCard() {
  const navigate = useNavigate();

  const { data: decisions = [], isLoading } = useQuery({
    queryKey: ['pending-decisions'],
    queryFn: () => api.pendingDecisions.list(),
    refetchInterval: 30_000,
  });

  if (isLoading || !decisions.length) return null;

  return (
    <Card
      className="border-amber-400 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-700 cursor-pointer hover:bg-amber-100 dark:hover:bg-amber-950/40 transition-colors"
      onClick={() => navigate('/logs')}
    >
      <CardContent className="py-4 flex items-center gap-4">
        <span className="text-2xl">⚠️</span>
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-amber-800 dark:text-amber-300 text-sm">
            Duplikat-Verdacht – Entscheidung erforderlich
          </p>
          <p className="text-xs text-amber-700 dark:text-amber-400 mt-0.5">
            In Logs/Jobs entscheiden →
          </p>
        </div>
        <span className="shrink-0 text-2xl font-bold text-amber-800 dark:text-amber-300 bg-amber-200 dark:bg-amber-900 px-3 py-1 rounded-full">
          {decisions.length}
        </span>
      </CardContent>
    </Card>
  );
}
