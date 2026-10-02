import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Dialog, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { ArtBadge } from '@/components/postbuch/ArtBadge';
import { LebensbereichBadge } from '@/components/postbuch/LebensbereichBadge';
import { Pencil, Sparkles } from 'lucide-react';
import { useChangeType } from '@/hooks/usePostbuch';
import { useUndoHistory } from '@/hooks/useUndoHistory';
import { useAuth } from '@/hooks/useAuth';
import { useTaskStore } from '@/hooks/useTaskStore';
import { api } from '@/api/client';
import { TaxonomyBadgeSelect } from '@/components/postbuch/TaxonomyBadgeSelect';

const REPROCESS_POLL_INTERVAL = 3000;
const REPROCESS_TIMEOUT = 10 * 60 * 1000;

/** Zwei-Achsen-Editor. Die vollständige Taxonomie kommt immer vom Server. */
export function ArtBadgeEditor({ postid, currentArt, currentL, currentD, onChanged }) {
  const { canWrite } = useAuth();
  const [open, setOpen] = useState(false); const [tax, setTax] = useState(null);
  const [newL, setNewL] = useState(currentL || ''); const [newD, setNewD] = useState(currentD || '');
  const [pending, setPending] = useState(false); const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);
  const change = useChangeType();
  const { addTask, setTaskJobId, completeTask, failTask } = useTaskStore();
  const qc = useQueryClient();
  const { pushAction, clearHistory } = useUndoHistory();
  useEffect(() => { if (open && !tax) api.taxonomie.get().then(setTax).catch((e) => setError(e.message)); }, [open, tax]);
  if (!currentL || !currentD) return <ArtBadge art={currentArt} />;
  // Wird nur für kompatible Wechsel (undo/redo) benutzt – wirft, falls der
  // Server dafür überraschend doch eine Wiederverarbeitung verlangt.
  async function applyTypeChange(targetL, targetD) {
    const res = await change.mutateAsync({ postid, newL: targetL, newD: targetD });
    if (res.mode !== 'compatible' && res.mode !== 'noop') {
      throw new Error(`Rückgängig nicht möglich: Wechsel zu ${targetL}/${targetD} erfordert Wiederverarbeitung`);
    }
    qc.invalidateQueries({ queryKey: ['postbuch'] });
    onChanged?.();
  }
  async function submit(confirmReprocess = false) {
    setError('');
    setStarting(confirmReprocess);
    try {
      const res = await change.mutateAsync({ postid, newL, newD, confirmReprocess });
      if (res.mode === 'requires_reprocess') { setPending(true); return; }
      if (res.mode === 'noop') { setOpen(false); onChanged?.(); return; }
      if (res.mode === 'compatible') {
        setOpen(false);
        const fromL = currentL, fromD = currentD, toL = newL, toD = newD;
        pushAction(
          `Einordnung: ${fromL}/${fromD} → ${toL}/${toD}`,
          () => applyTypeChange(fromL, fromD),
          () => applyTypeChange(toL, toD),
        );
        onChanged?.();
        return;
      }
      if (res.mode === 'reprocessing') {
        clearHistory();
        setOpen(false);
        setPending(false);
        const taskId = addTask({ type: 'reprocess', postid, label: `LxD-Wechsel ${postid} → ${newL}/${newD}` });
        setTaskJobId(taskId, res.jobId);
        const deadline = Date.now() + REPROCESS_TIMEOUT;
        const poll = async () => {
          if (Date.now() > deadline) { failTask(taskId, 'Timeout: Pipeline hat nach 10 Minuten nicht geantwortet'); return; }
          try {
            const job = await api.jobs.get(res.jobId);
            if (job.status === 'done') {
              completeTask(taskId);
              qc.invalidateQueries({ queryKey: ['postbuch'] });
              onChanged?.();
            } else if (job.status === 'failed') {
              failTask(taskId, job.error_message || 'Verarbeitung fehlgeschlagen');
            } else if (job.status === 'cancelled') {
              failTask(taskId, 'Verarbeitung wurde abgebrochen');
            } else {
              setTimeout(poll, REPROCESS_POLL_INTERVAL);
            }
          } catch { setTimeout(poll, REPROCESS_POLL_INTERVAL); }
        };
        poll();
      }
    } catch (e) { setError(e.message || 'Änderung fehlgeschlagen'); } finally { setStarting(false); }
  }
  const editable = canWrite;
  function openEditor() {
    setNewL(currentL);
    setNewD(currentD);
    setError('');
    setOpen(true);
  }
  const BadgeAction = ({ children, label }) => editable ? (
    <button type="button" onClick={openEditor} title={`${label} ändern`}
      className="group relative inline-flex h-6 items-center align-middle rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <span className="inline-flex h-6 items-center transition-opacity group-hover:opacity-25">{children}</span>
      <span className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity group-hover:opacity-100" aria-hidden="true">
        <Pencil className="h-3.5 w-3.5" />
      </span>
    </button>
  ) : children;
  const lebensbereiche = tax?.lebensbereich?.filter((item) => item.aktiv) || [];
  const dokumentarten = tax?.dokumentart?.filter((item) => item.aktiv) || [];
  return <><span className="inline-flex h-6 items-center gap-1.5 align-middle"><BadgeAction label="Lebensbereich"><LebensbereichBadge lebensbereich={currentL} /></BadgeAction><BadgeAction label="Dokumentart"><ArtBadge art={currentD} /></BadgeAction></span>
    <Dialog open={open} onOpenChange={setOpen} size="lg"><DialogTitle>L×D-Einordnung ändern</DialogTitle><DialogDescription>Wähle Lebensbereich und Dokumentart. Beide Badges werden gemeinsam gespeichert.</DialogDescription>
      <div className="grid gap-5 py-5">
        <div className="space-y-2"><div><p className="text-sm font-medium">Lebensbereich</p><p className="text-xs text-muted-foreground">Worum geht es inhaltlich?</p></div><TaxonomyBadgeSelect kind="lebensbereich" value={newL} options={lebensbereiche} onChange={setNewL} placeholder="Lebensbereich wählen" disabled={!tax} /></div>
        <div className="space-y-2"><div><p className="text-sm font-medium">Dokumentart</p><p className="text-xs text-muted-foreground">Welche Form hat das Dokument?</p></div><TaxonomyBadgeSelect kind="dokumentart" value={newD} options={dokumentarten} onChange={setNewD} placeholder="Dokumentart wählen" disabled={!tax} /></div>
        {error && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
      </div>
      <DialogFooter><Button variant="outline" onClick={() => setOpen(false)}>Abbrechen</Button><Button disabled={change.isPending || !tax} onClick={() => submit(false)}>Speichern</Button></DialogFooter></Dialog>
    <Dialog open={pending} onOpenChange={setPending}><DialogTitle className="flex gap-2"><Sparkles className="h-4 w-4" />Wiederverarbeitung erforderlich</DialogTitle><DialogDescription>Der Wechsel aktiviert einen anderen Spezialpfad und benötigt eine neue Extraktion. Das läuft im Hintergrund und kann einige Sekunden bis Minuten dauern – der Fortschritt erscheint danach unten in der Aufgabenleiste.</DialogDescription>
      {error && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
      <DialogFooter><Button variant="outline" onClick={() => setPending(false)} disabled={starting}>Abbrechen</Button><Button disabled={starting} onClick={() => submit(true)}>{starting ? 'Wird gestartet…' : 'Starten'}</Button></DialogFooter></Dialog></>;
}
