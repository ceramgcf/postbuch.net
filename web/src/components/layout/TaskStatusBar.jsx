import { useState, useRef, useEffect } from 'react';
import { useTaskStore } from '@/hooks/useTaskStore';
import { Loader2, CheckCircle2, Clock, XCircle } from 'lucide-react';

function formatElapsed(startedAt) {
  const sec = Math.floor((Date.now() - startedAt) / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const s = sec % 60;
  return `${min}m ${s.toString().padStart(2, '0')}s`;
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

function TaskItem({ task }) {
  const [, setTick] = useState(0);

  // Re-render every second for elapsed time while active
  useEffect(() => {
    if (task.completedAt) return;
    const id = setInterval(() => setTick(n => n + 1), 1000);
    return () => clearInterval(id);
  }, [task.completedAt]);

  const isActive = !task.completedAt;
  const isFailed = task.result === 'error';

  const bgClass = isActive ? 'bg-blue-50/80' : isFailed ? 'bg-red-50/80' : 'bg-emerald-50/80';

  return (
    <div className={`flex items-start gap-2 px-3 py-2 text-xs ${bgClass} rounded-md`}>
      {isActive ? (
        <Loader2 className="h-3.5 w-3.5 mt-0.5 shrink-0 animate-spin text-blue-500" />
      ) : isFailed ? (
        <XCircle className="h-3.5 w-3.5 mt-0.5 shrink-0 text-red-500" />
      ) : (
        <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 shrink-0 text-emerald-500" />
      )}
      <div className="min-w-0 flex-1">
        <div className="font-medium text-foreground truncate">{task.label}</div>
        {isFailed && task.errorMessage && (
          <div className="text-red-600 mt-0.5 break-words">{task.errorMessage}</div>
        )}
        <div className="text-muted-foreground flex items-center gap-1 mt-0.5">
          <Clock className="h-3 w-3" />
          {isActive ? (
            <span>seit {formatTime(task.startedAt)} ({formatElapsed(task.startedAt)})</span>
          ) : (
            <span>{isFailed ? 'fehlgeschlagen' : 'fertig'} um {formatTime(task.completedAt)}</span>
          )}
        </div>
      </div>
    </div>
  );
}

export function TaskStatusBar({ compact = false }) {
  const { activeTasks, recentTasks } = useTaskStore();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const [, setTick] = useState(0);

  // Re-render every second to update "recentTasks" (TTL filtering)
  useEffect(() => {
    if (activeTasks.length === 0 && recentTasks.length === 0) return;
    const id = setInterval(() => setTick(n => n + 1), 1000);
    return () => clearInterval(id);
  }, [activeTasks.length, recentTasks.length]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const total = activeTasks.length + recentTasks.length;
  if (total === 0) return null;

  const hasError = recentTasks.some(t => t.result === 'error');

  const triggerButton = compact ? (
    <button
      className="flex items-center justify-center gap-1 py-2.5 w-full rounded-lg text-xs font-medium transition-colors hover:bg-primary/5"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onClick={() => setOpen(o => !o)}
      title={activeTasks.length > 0 ? `${activeTasks.length} laufend` : hasError ? 'Fehler' : 'Fertig'}
    >
      {activeTasks.length > 0 ? (
        <>
          <span className="relative flex h-4 w-4">
            <span className="absolute inset-0 rounded-full bg-blue-400 animate-ping opacity-40" />
            <Loader2 className="h-4 w-4 animate-spin text-blue-500 relative" />
          </span>
          <span className="text-blue-700 font-semibold">{activeTasks.length}</span>
        </>
      ) : hasError ? (
        <XCircle className="h-4 w-4 text-red-500" />
      ) : (
        <CheckCircle2 className="h-4 w-4 text-emerald-500" />
      )}
    </button>
  ) : (
    <button
      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors hover:bg-primary/5"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onClick={() => setOpen(o => !o)}
    >
      {activeTasks.length > 0 ? (
        <>
          <span className="relative flex h-4 w-4">
            <span className="absolute inset-0 rounded-full bg-blue-400 animate-ping opacity-40" />
            <Loader2 className="h-4 w-4 animate-spin text-blue-500 relative" />
          </span>
          <span className="text-blue-700">{activeTasks.length} laufend</span>
        </>
      ) : hasError ? (
        <>
          <XCircle className="h-4 w-4 text-red-500" />
          <span className="text-red-700">Fehler</span>
        </>
      ) : (
        <>
          <CheckCircle2 className="h-4 w-4 text-emerald-500" />
          <span className="text-emerald-700">fertig</span>
        </>
      )}
    </button>
  );

  return (
    <div ref={ref} className="relative">
      {triggerButton}

      {open && (
        <div
          className="absolute bottom-full left-0 mb-2 w-72 bg-white border border-border/60 rounded-xl shadow-xl z-50 overflow-hidden"
          style={{ left: compact ? '100%' : 0, bottom: compact ? 'auto' : '100%', top: compact ? 0 : 'auto', marginLeft: compact ? '0.5rem' : 0, marginBottom: compact ? 0 : '0.5rem' }}
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
        >
          <div className="px-3 py-2 border-b border-border/40 bg-muted/30">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              Hintergrundaufgaben
            </span>
          </div>
          <div className="p-2 space-y-1.5 max-h-64 overflow-y-auto">
            {activeTasks.map(t => <TaskItem key={t.id} task={t} />)}
            {recentTasks.map(t => <TaskItem key={t.id} task={t} />)}
          </div>
        </div>
      )}
    </div>
  );
}
