import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';
import { PageLoader, EmptyState } from '@/components/ui/spinner';
import { PdfInlineViewer } from '@/components/ui/pdf-inline-viewer';
import {
  Activity, CheckCircle2, XCircle, Ban, AlertTriangle, Loader2,
  Check, X, Clock, Workflow, PauseCircle, GitMerge, Trash2, Copy,
  Eye, ExternalLink,
} from 'lucide-react';

const POLL_INTERVAL_MS = 3000;

// ── Helpers ─────────────────────────────────────────────────────────────────

function toMillis(value) {
  if (!value) return null;
  const ms = typeof value === 'number' ? value : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function formatElapsed(ms) {
  if (ms == null || ms < 0) return '–';
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return `${min}m ${sec.toString().padStart(2, '0')}s`;
  const hr = Math.floor(min / 60);
  const m = min % 60;
  return `${hr}h ${m.toString().padStart(2, '0')}m`;
}

function formatRelative(ms) {
  if (ms == null) return '–';
  const delta = Date.now() - ms;
  if (delta < 60_000) return 'gerade eben';
  const min = Math.floor(delta / 60_000);
  if (min < 60) return `vor ${min} min`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `vor ${hr} h`;
  const days = Math.floor(hr / 24);
  return `vor ${days} Tg.`;
}

function normalizeJob(raw) {
  // In-memory jobs use camelCase; DB rows use snake_case – unify.
  return {
    id: raw.id,
    type: raw.type,
    label: raw.label,
    status: raw.status,
    step: raw.step ?? 0,
    totalSteps: raw.totalSteps ?? raw.total_steps ?? 0,
    stepLabel: raw.stepLabel ?? raw.step_label ?? '',
    cancellable: raw.cancellable ?? false,
    payload: raw.payload ?? null,
    startedAt: toMillis(raw.startedAt ?? raw.started_at),
    updatedAt: toMillis(raw.updatedAt ?? raw.updated_at),
    completedAt: toMillis(raw.completedAt ?? raw.completed_at),
    errorMessage: raw.errorMessage ?? raw.error_message ?? null,
    failedOnedriveId: raw.failedOnedriveId ?? raw.failed_onedrive_id ?? null,
    // Suspension-specific fields (only present for awaiting_decision jobs)
    matchPostid: raw.matchPostid ?? null,
    matchWeburl: raw.matchWeburl ?? null,
    onedriveId: raw.onedriveId ?? null,
    onedriveWeburl: raw.onedriveWeburl ?? null,
    reservedPostid: raw.reservedPostid ?? null,
    similarity: raw.similarity ?? null,
    suspBetreff: raw.suspBetreff ?? null,
    newConfidence: raw.newConfidence ?? null,
    matchConfidence: raw.matchConfidence ?? null,
    expiresAt: toMillis(raw.expiresAt ?? raw.expires_at),
  };
}

const JOB_TYPE_LABELS = {
  'doc-process':   'Dokument-Verarbeitung',
  'doc-reprocess': 'Wiederverarbeitung',
  'backup':        'Backup',
  'eb-matching':   'Erstattungsbescheid-Abgleich',
};

function jobTypeLabel(type) {
  return JOB_TYPE_LABELS[type] || type;
}

// Known step labels per job type.
// doc-process supports two variants: 10 steps (OneDrive-Eingang) und 11 Schritte (Scanner-Eingang).
const STEP_TEMPLATES = {
  'doc-process': {
    10: [
      'Upload zu OneDrive', 'Download von OneDrive', 'KI-Analyse', 'Duplikaterkennung',
      'Duplikat-Handling', 'OneDrive-Sortierung', 'Benachrichtigung', 'PDF rotieren',
      'Datenbank', 'Embedding',
    ],
    11: [
      'Scan & OCR', 'Upload zu OneDrive', 'Download von OneDrive', 'KI-Analyse', 'Duplikaterkennung',
      'Duplikat-Handling', 'OneDrive-Sortierung', 'Benachrichtigung', 'PDF rotieren',
      'Datenbank', 'Embedding',
    ],
  },
  'doc-reprocess': [
    'Upload zu OneDrive', 'Download von OneDrive', 'KI-Analyse', 'Duplikaterkennung',
    'Duplikat-Handling', 'OneDrive-Sortierung', 'Benachrichtigung', 'PDF rotieren',
    'Datenbank', 'Embedding',
  ],
};

// ── Status visuals ──────────────────────────────────────────────────────────

const STATUS_CONFIG = {
  awaiting_decision: {
    label: 'Entscheidung ausstehend',
    icon: PauseCircle,
    iconCls: 'text-violet-400',
    badgeCls: 'bg-violet-500/15 text-violet-400 border-violet-500/30',
    ringCls: 'ring-violet-500/40',
  },
  queued: {
    label: 'wartet',
    icon: Clock,
    iconCls: 'text-amber-300',
    badgeCls: 'bg-amber-400/15 text-amber-300 border-amber-400/30',
    ringCls: 'ring-amber-400/30',
  },
  running: {
    label: 'läuft',
    icon: Loader2,
    iconCls: 'text-sky-400 animate-spin',
    badgeCls: 'bg-sky-500/15 text-sky-400 border-sky-500/30',
    ringCls: 'ring-sky-500/40',
  },
  done: {
    label: 'fertig',
    icon: CheckCircle2,
    iconCls: 'text-emerald-400',
    badgeCls: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
    ringCls: 'ring-emerald-500/30',
  },
  failed: {
    label: 'fehlgeschlagen',
    icon: XCircle,
    iconCls: 'text-red-400',
    badgeCls: 'bg-red-500/15 text-red-400 border-red-500/30',
    ringCls: 'ring-red-500/30',
  },
  cancelled: {
    label: 'abgebrochen',
    icon: Ban,
    iconCls: 'text-muted-foreground',
    badgeCls: 'bg-muted/50 text-muted-foreground border-border',
    ringCls: 'ring-border',
  },
  interrupted: {
    label: 'unterbrochen',
    icon: AlertTriangle,
    iconCls: 'text-amber-400',
    badgeCls: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
    ringCls: 'ring-amber-500/30',
  },
};

function StatusBadge({ status }) {
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.running;
  const Icon = cfg.icon;
  return (
    <span className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-semibold ${cfg.badgeCls}`}>
      <Icon className={`h-3 w-3 ${status === 'running' ? 'animate-spin' : ''}`} />
      {cfg.label}
    </span>
  );
}

// ── Stepper (process visualization) ─────────────────────────────────────────

function Stepper({ job }) {
  const { step, totalSteps, stepLabel, status, type } = job;
  if (!totalSteps || totalSteps <= 0) return null;

  const tpl = STEP_TEMPLATES[type];
  const template = Array.isArray(tpl) ? tpl : (tpl?.[totalSteps] ?? tpl?.[10]);
  const isRunning = status === 'running';
  const isDone = status === 'done';
  const isFailed = status === 'failed';
  const currentIndex = step;

  return (
    <div className="flex items-center gap-0 w-full">
      {Array.from({ length: totalSteps }).map((_, i) => {
        const isCompleted = isDone || i < currentIndex;
        const isCurrent = isRunning && i === currentIndex;
        const isFailedHere = isFailed && i === currentIndex;
        const label = template?.[i] || (i === currentIndex && stepLabel) || `Schritt ${i + 1}`;

        let dotCls = 'border-border/70 bg-background text-muted-foreground/50';
        let iconEl = <span className="text-[10px] font-semibold">{i + 1}</span>;
        let connectorCls = 'bg-border/60';

        if (isCompleted) {
          dotCls = 'border-emerald-500/60 bg-emerald-500/20 text-emerald-400';
          iconEl = <Check className="h-3 w-3" strokeWidth={3} />;
          connectorCls = 'bg-emerald-500/50';
        } else if (isCurrent) {
          dotCls = 'border-sky-500 bg-sky-500/25 text-sky-300 ring-2 ring-sky-500/30';
          iconEl = <Loader2 className="h-3 w-3 animate-spin" strokeWidth={3} />;
        } else if (isFailedHere) {
          dotCls = 'border-red-500/70 bg-red-500/20 text-red-400';
          iconEl = <X className="h-3 w-3" strokeWidth={3} />;
        }

        return (
          <div key={i} className="flex items-center flex-1 last:flex-initial min-w-0 group" title={label}>
            <div className={`relative shrink-0 flex h-6 w-6 items-center justify-center rounded-full border-2 transition-colors ${dotCls}`}>
              {iconEl}
              {isCurrent && (
                <span className="absolute inset-0 rounded-full bg-sky-500/20 animate-ping" />
              )}
            </div>
            {i < totalSteps - 1 && (
              <div className={`flex-1 h-0.5 mx-1 transition-colors ${connectorCls}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Suspended job card (awaiting duplicate decision) ────────────────────────

function SuspendedJobCard({ job, onDecide }) {
  const [busy, setBusy] = useState(null);
  const [showOldPdf, setShowOldPdf] = useState(false);
  const [showNewPdf, setShowNewPdf] = useState(false);

  const handleDecide = async (decision) => {
    if (busy) return;
    setBusy(decision);
    try {
      await onDecide(job.id, decision);
    } catch (err) {
      console.error('[jobs] decision failed:', err.message);
      alert(`Entscheidung fehlgeschlagen: ${err.message}`);
      setBusy(null);
    }
  };

  const oldPdfUrl = job.matchPostid ? api.files.pdfUrl(job.matchPostid) : null;
  const newPdfUrl = job.onedriveId ? api.files.suspendedPdfUrl(job.onedriveId) : null;
  const simPct = job.similarity != null ? Math.round(job.similarity * 100) : null;

  // Auto-decision: replace when new doc is better quality, else discard
  const autoIsReplace = job.newConfidence != null && job.matchConfidence != null
    ? job.newConfidence > job.matchConfidence
    : null;
  const expiresLabel = job.expiresAt
    ? new Date(job.expiresAt).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    : null;

  return (
    <div className="rounded-xl border border-violet-500/40 bg-gradient-to-br from-violet-500/5 via-background to-background p-4 shadow-sm space-y-3">
      {/* Header */}
      <div className="flex items-start gap-3">
        <PauseCircle className="h-4 w-4 text-violet-400 shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-semibold text-violet-400 uppercase tracking-wide">Duplikat-Verdacht</span>
            <StatusBadge status="awaiting_decision" />
            {simPct != null && (
              <span className="text-[11px] text-muted-foreground">Ähnlichkeit: {simPct}%</span>
            )}
          </div>
          <h3 className="mt-1 text-sm font-medium text-foreground truncate">
            {job.suspBetreff || job.label}
          </h3>
          {job.stepLabel && (
            <p className="mt-0.5 text-xs text-muted-foreground">{job.stepLabel}</p>
          )}
        </div>
      </div>

      {/* Document links row */}
      {(job.matchPostid || job.reservedPostid || job.matchWeburl || job.onedriveWeburl) && (
        <div className="flex flex-wrap gap-2 text-[11px]">
          {/* Old document */}
          {job.matchPostid && (
            <div className="flex items-center gap-1.5 rounded-md border border-border/60 bg-muted/30 px-2 py-1">
              <span className="text-muted-foreground">Bestehendes Dok:</span>
              <span className="font-mono font-medium text-foreground">{job.matchPostid}</span>
              {oldPdfUrl && (
                <button
                  onClick={() => { setShowOldPdf(v => !v); setShowNewPdf(false); }}
                  title="PDF anzeigen"
                  className="ml-0.5 text-violet-400 hover:text-violet-300 transition-colors"
                >
                  <Eye className="h-3.5 w-3.5" />
                </button>
              )}
              {job.matchWeburl && (
                <a
                  href={job.matchWeburl}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Auf OneDrive öffnen"
                  className="text-muted-foreground hover:text-foreground transition-colors"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              )}
            </div>
          )}

          {/* New document */}
          {(job.reservedPostid || job.onedriveId) && (
            <div className="flex items-center gap-1.5 rounded-md border border-border/60 bg-muted/30 px-2 py-1">
              <span className="text-muted-foreground">Neues Dok:</span>
              {job.reservedPostid && (
                <span className="font-mono font-medium text-foreground">{job.reservedPostid}</span>
              )}
              {newPdfUrl && (
                <button
                  onClick={() => { setShowNewPdf(v => !v); setShowOldPdf(false); }}
                  title="PDF anzeigen"
                  className="ml-0.5 text-violet-400 hover:text-violet-300 transition-colors"
                >
                  <Eye className="h-3.5 w-3.5" />
                </button>
              )}
              {job.onedriveWeburl && (
                <a
                  href={job.onedriveWeburl}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Auf OneDrive öffnen"
                  className="text-muted-foreground hover:text-foreground transition-colors"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              )}
            </div>
          )}
        </div>
      )}

      {/* Inline PDF viewer */}
      {(showOldPdf || showNewPdf) && (
        <div className="rounded-lg border border-border/50 overflow-hidden">
          <PdfInlineViewer
            key={showOldPdf ? oldPdfUrl : newPdfUrl}
            file={showOldPdf ? oldPdfUrl : newPdfUrl}
            className="w-full border-0 rounded-none"
            style={{ height: '55vh', minHeight: '320px' }}
          />
        </div>
      )}

      {/* Auto-decision hint */}
      {autoIsReplace != null && (
        <div className={`flex items-start gap-2 rounded-md border px-3 py-2 text-[11px] ${autoIsReplace ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-300' : 'border-red-500/30 bg-red-500/5 text-red-300'}`}>
          <span className="mt-0.5 shrink-0">{autoIsReplace ? '🔄' : '🗑️'}</span>
          <span>
            <span className="font-semibold">Keine Reaktion bis {expiresLabel || '–'}:</span>
            {autoIsReplace
              ? ` Auto-Replace – neues Dok. (${Math.round(job.newConfidence * 100)}%) hat höhere Qualität als ${job.matchPostid} (${Math.round(job.matchConfidence * 100)}%), wird übernommen`
              : ` Auto-Discard – neues Dok. (${Math.round(job.newConfidence * 100)}%) hat keine höhere Qualität als ${job.matchPostid} (${Math.round(job.matchConfidence * 100)}%), wird verworfen`
            }
          </span>
        </div>
      )}

      {/* Decision buttons */}
      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={() => handleDecide('replace')}
          disabled={!!busy}
          className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-xs font-semibold text-emerald-400 hover:bg-emerald-500/20 hover:border-emerald-500/60 transition-colors disabled:opacity-50 disabled:cursor-wait"
        >
          {busy === 'replace' ? <Loader2 className="h-3 w-3 animate-spin" /> : <GitMerge className="h-3 w-3" />}
          Bestehendes ersetzen
        </button>
        <button
          onClick={() => handleDecide('keep_both')}
          disabled={!!busy}
          className="inline-flex items-center gap-1.5 rounded-md border border-sky-500/40 bg-sky-500/10 px-3 py-1.5 text-xs font-semibold text-sky-400 hover:bg-sky-500/20 hover:border-sky-500/60 transition-colors disabled:opacity-50 disabled:cursor-wait"
        >
          {busy === 'keep_both' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Copy className="h-3 w-3" />}
          Beide behalten
        </button>
        <button
          onClick={() => handleDecide('discard')}
          disabled={!!busy}
          className="inline-flex items-center gap-1.5 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-xs font-semibold text-red-400 hover:bg-red-500/20 hover:border-red-500/60 transition-colors disabled:opacity-50 disabled:cursor-wait"
        >
          {busy === 'discard' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
          Duplikat verwerfen
        </button>
      </div>
    </div>
  );
}

// ── Active job card ─────────────────────────────────────────────────────────

function ActiveJobCard({ job, onCancel }) {
  const [, forceTick] = useState(0);
  const [cancelling, setCancelling] = useState(false);

  // Live elapsed-time ticker
  useEffect(() => {
    const id = setInterval(() => forceTick(n => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const handleCancel = async () => {
    if (cancelling) return;
    if (!window.confirm(`Job "${job.label}" wirklich abbrechen?`)) return;
    setCancelling(true);
    try {
      await onCancel(job.id);
    } catch (err) {
      console.error('[jobs] cancel failed:', err.message);
      alert(`Abbruch fehlgeschlagen: ${err.message}`);
      setCancelling(false);
    }
  };

  const elapsed = job.startedAt ? Date.now() - job.startedAt : 0;
  const progress = job.totalSteps ? Math.min(100, Math.round((job.step / job.totalSteps) * 100)) : 0;

  return (
    <div className="rounded-xl border border-sky-500/30 bg-gradient-to-br from-sky-500/5 via-background to-background p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <Workflow className="h-4 w-4 text-sky-400 shrink-0" />
            <span className="text-xs font-semibold text-sky-400 uppercase tracking-wide">
              {jobTypeLabel(job.type)}
            </span>
            <StatusBadge status={job.status} />
          </div>
          <h3 className="mt-1 text-sm font-medium text-foreground truncate">{job.label}</h3>
        </div>
        {job.cancellable && (
          <button
            onClick={handleCancel}
            disabled={cancelling}
            className="shrink-0 inline-flex items-center gap-1 rounded-md border border-red-500/40 bg-red-500/10 px-2.5 py-1 text-xs font-medium text-red-400 hover:bg-red-500/20 hover:border-red-500/60 transition-colors disabled:opacity-50 disabled:cursor-wait"
          >
            <Ban className="h-3.5 w-3.5" />
            {cancelling ? 'Abbrechen…' : 'Abbrechen'}
          </button>
        )}
      </div>

      <div className="mb-3">
        <Stepper job={job} />
      </div>

      <div className="flex items-center justify-between gap-3 flex-wrap text-xs">
        <div className="flex items-center gap-1.5 text-foreground/90">
          <span className="tabular-nums font-semibold text-sky-400">{job.step}/{job.totalSteps}</span>
          <span className="text-muted-foreground">·</span>
          <span className="truncate">{job.stepLabel || '…'}</span>
        </div>
        <div className="flex items-center gap-3 text-muted-foreground tabular-nums">
          <span className="inline-flex items-center gap-1">
            <span className="tabular-nums font-semibold text-foreground/80">{progress}%</span>
          </span>
          <span className="inline-flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {formatElapsed(elapsed)}
          </span>
        </div>
      </div>
    </div>
  );
}

// ── Retry button for failed/interrupted recent jobs ─────────────────────────

function RetryButton({ onedriveId, onRetried }) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => api.failedDocuments.reprocess(onedriveId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['failed-documents'] });
      onRetried?.();
    },
    onError: (err) => alert(`Fehler beim Wiederverarbeiten: ${err.message}`),
  });

  return (
    <button
      onClick={(e) => { e.stopPropagation(); mutation.mutate(); }}
      disabled={mutation.isPending}
      className="inline-flex items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-400 hover:bg-amber-500/20 hover:border-amber-500/60 transition-colors disabled:opacity-50 disabled:cursor-wait"
    >
      {mutation.isPending ? 'Wird gestartet…' : '↺ Wiederholen'}
    </button>
  );
}

// ── Recent job row ──────────────────────────────────────────────────────────

function RecentJobRow({ job }) {
  const navigate = useNavigate();
  const cfg = STATUS_CONFIG[job.status] || STATUS_CONFIG.done;
  const Icon = cfg.icon;
  const duration = (job.startedAt && job.completedAt) ? job.completedAt - job.startedAt : null;
  const postid = job.status === 'done' ? job.payload?.postid : null;

  return (
    <div
      className={`flex items-start gap-3 rounded-lg border border-border/70 bg-card/50 px-3 py-2.5 hover:bg-card transition-colors${postid ? ' cursor-pointer' : ''}`}
      onClick={postid ? () => navigate(`/postbuch/${postid}`) : undefined}
    >
      <Icon className={`h-4 w-4 mt-0.5 shrink-0 ${cfg.iconCls}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2 flex-wrap">
          <div className="min-w-0 flex items-center gap-2 flex-wrap">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              {jobTypeLabel(job.type)}
            </span>
            <StatusBadge status={job.status} />
          </div>
          <span className="text-[11px] text-muted-foreground tabular-nums shrink-0">
            {formatRelative(job.completedAt ?? job.updatedAt)}
          </span>
        </div>
        <div className="mt-0.5 text-sm text-foreground/90 truncate">{job.label}</div>
        {job.status === 'done' && job.payload?.betreff && (
          <div className="mt-0.5 text-[11px] text-primary/80 truncate font-medium">{job.payload.betreff}</div>
        )}

        {job.totalSteps > 0 && (
          <div className="mt-1.5 text-[11px] text-muted-foreground flex items-center gap-2 flex-wrap">
            {job.status === 'done' ? (
              <span className="tabular-nums">{job.totalSteps}/{job.totalSteps} Schritte abgeschlossen</span>
            ) : (
              <span className="tabular-nums">Schritt {job.step}/{job.totalSteps}{job.stepLabel ? ` · ${job.stepLabel}` : ''}</span>
            )}
            {duration != null && (
              <>
                <span>·</span>
                <span className="inline-flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  {formatElapsed(duration)}
                </span>
              </>
            )}
          </div>
        )}

        {job.errorMessage && (
          <div className="mt-1.5 text-[11px] text-red-400 break-words whitespace-pre-wrap">
            {job.errorMessage}
          </div>
        )}
        {(job.status === 'failed' || job.status === 'interrupted') && job.failedOnedriveId && (
          <div className="mt-1.5">
            <RetryButton onedriveId={job.failedOnedriveId} />
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main tab ────────────────────────────────────────────────────────────────

export function JobsMonitor() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const inFlight = useRef(false);

  const fetchJobs = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const result = await api.jobs.list();
      setData({
        active: (result.active || []).map(normalizeJob),
        recent: (result.recent || []).map(normalizeJob),
      });
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    fetchJobs();
    const id = setInterval(fetchJobs, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchJobs]);

  const handleCancel = useCallback(async (id) => {
    await api.jobs.cancel(id);
    await fetchJobs();
  }, [fetchJobs]);

  const handleDecide = useCallback(async (jobId, decision) => {
    await api.pendingDecisions.decide(jobId, decision);
    await fetchJobs();
  }, [fetchJobs]);

  if (loading && !data) return <PageLoader />;
  if (error && !data) return <p className="text-destructive">Fehler: {error}</p>;

  const allActive = data?.active || [];
  const suspended = allActive.filter(j => j.status === 'awaiting_decision');
  const active = allActive.filter(j => j.status !== 'awaiting_decision');
  const recent = data?.recent || [];
  const hasAny = allActive.length > 0 || recent.length > 0;

  if (!hasAny) {
    return (
      <EmptyState
        icon={Activity}
        title="Keine Jobs"
        description="Hier erscheinen laufende und kürzlich abgeschlossene Hintergrundaufgaben."
      />
    );
  }

  return (
    <div className="space-y-6">
      <p className="text-muted-foreground text-sm">
        {active.length > 0
          ? `${active.length} laufend · ${recent.length} kürzlich · alle 3 s aktualisiert`
          : `${recent.length} kürzlich · alle 3 s aktualisiert`}
      </p>

      {suspended.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-xs font-semibold text-violet-400 uppercase tracking-wider flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              <span className="absolute inset-0 rounded-full bg-violet-400 animate-ping opacity-70" />
              <span className="relative rounded-full h-2 w-2 bg-violet-400" />
            </span>
            Offene Entscheidungen
          </h2>
          <div className="space-y-3">
            {suspended.map(job => (
              <SuspendedJobCard key={job.id} job={job} onDecide={handleDecide} />
            ))}
          </div>
        </section>
      )}

      {active.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-xs font-semibold text-sky-400 uppercase tracking-wider flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              <span className="absolute inset-0 rounded-full bg-sky-400 animate-ping opacity-70" />
              <span className="relative rounded-full h-2 w-2 bg-sky-400" />
            </span>
            Laufende Jobs
          </h2>
          <div className="space-y-3">
            {active.map(job => (
              <ActiveJobCard key={job.id} job={job} onCancel={handleCancel} />
            ))}
          </div>
        </section>
      )}

      {recent.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            Verlauf
          </h2>
          <div className="space-y-1.5">
            {recent.map(job => (
              <RecentJobRow key={job.id} job={job} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
