import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { Testergebnis } from '@/components/ui/testergebnis';

/**
 * Fortschrittsbalken für einen einzelnen Hintergrund-Job (jobs/tracker.js).
 * Pollt, solange der Job läuft, und meldet sich einmalig über onDone, sobald
 * er einen Endzustand erreicht hat (done/failed/cancelled/interrupted).
 */
export function JobFortschritt({ jobId, titel, onDone }) {
  const gemeldet = useRef(null);
  const { data: job, isError } = useQuery({
    queryKey: ['job', jobId],
    queryFn: () => api.jobs.get(jobId),
    enabled: !!jobId,
    retry: false,
    refetchInterval: (query) => {
      const s = query.state.data?.status;
      return !s || s === 'running' || s === 'queued' ? 1000 : false;
    },
  });
  const status = job?.status;
  const step = Number(job?.step || 0);
  const total = Number(job?.totalSteps ?? job?.total_steps ?? 1);
  const label = job?.stepLabel ?? job?.step_label ?? 'Wird gestartet…';
  useEffect(() => {
    if (!jobId || !job || !['done', 'failed', 'cancelled', 'interrupted'].includes(status)) return;
    if (gemeldet.current === jobId) return;
    gemeldet.current = jobId;
    onDone?.(job);
  }, [jobId, job, status, onDone]);
  if (!jobId) return null;
  if (isError) return <Testergebnis status="fehler">Fortschritt konnte nicht gelesen werden.</Testergebnis>;
  if (status === 'failed' || status === 'interrupted' || status === 'cancelled') {
    return <Testergebnis status="fehler">{job?.errorMessage ?? job?.error_message ?? `${titel} ist fehlgeschlagen.`}</Testergebnis>;
  }
  const prozent = Math.min(100, Math.round((step / Math.max(1, total)) * 100));
  return (
    <div className="rounded-lg border bg-muted/20 p-3 space-y-2">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="font-medium">{titel}</span>
        <span className="tabular-nums text-muted-foreground">{step} von {total}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div className="h-full bg-primary transition-all" style={{ width: `${prozent}%` }} />
      </div>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}
