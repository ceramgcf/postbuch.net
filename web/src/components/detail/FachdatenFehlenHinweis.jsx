/**
 * FachdatenFehlenHinweis.jsx – Erstattungsbescheid ohne ausgewertete Fachdaten
 * (z. B. nach einer manuellen Ablage). Mit Schreibrecht lässt sich die
 * KI-Auswertung von hier starten.
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Sparkles } from 'lucide-react';
import { api } from '@/api/client';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/useAuth';
import { useReprocess } from '@/hooks/usePostbuch';
import { useTaskStore } from '@/hooks/useTaskStore';
import { BescheidBearbeitenDialog } from './BescheidBearbeitenDialog';

export function FachdatenFehlenHinweis({ postid, istTier, onFertig }) {
  const { canWrite } = useAuth();
  const qc = useQueryClient();
  const reprocess = useReprocess();
  const { addTask, setTaskJobId, completeTask, failTask } = useTaskStore();
  const [laeuft, setLaeuft] = useState(false);
  const [editorOffen, setEditorOffen] = useState(false);
  const [fehler, setFehler] = useState(null);

  const starte = async () => {
    setFehler(null);
    setLaeuft(true);
    const taskId = addTask({ type: 'reprocess', postid, label: `KI-Auswertung ${postid}` });
    try {
      const { jobId } = await reprocess.mutateAsync({ postid, instructions: '', textebeneEntfernen: false, modelTier: 'auto' });
      setTaskJobId(taskId, jobId);
      const ende = Date.now() + 10 * 60 * 1000;
      const pruefe = async () => {
        if (Date.now() > ende) { failTask(taskId, 'Timeout: Die Auswertung hat nach 10 Minuten nicht geantwortet'); setLaeuft(false); return; }
        try {
          const job = await api.jobs.get(jobId);
          if (job.status === 'done') {
            completeTask(taskId);
            qc.invalidateQueries({ queryKey: ['postbuch'] });
            onFertig?.();
            setLaeuft(false);
            return;
          }
          if (job.status === 'failed' || job.status === 'cancelled') {
            const text = job.error_message || 'Die Auswertung ist fehlgeschlagen';
            failTask(taskId, text);
            setFehler(text);
            setLaeuft(false);
            return;
          }
        } catch { /* nächster Versuch */ }
        setTimeout(pruefe, 3000);
      };
      setTimeout(pruefe, 3000);
    } catch (err) {
      failTask(taskId, err.message);
      setFehler(err.message);
      setLaeuft(false);
    }
  };

  return (
    <Card className="border-amber-300 bg-amber-50 dark:border-amber-700/60 dark:bg-amber-950/20">
      <CardContent className="flex flex-wrap items-center gap-3 py-4 text-sm">
        <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="min-w-0 flex-1 basis-64">
          <p className="font-semibold text-amber-900 dark:text-amber-100">Fachdaten fehlen</p>
          <p className="text-amber-900/90 dark:text-amber-100/90">
            Dieser Erstattungsbescheid ist ohne KI-Auswertung abgelegt: Erstattungsbetrag, Positionen und die
            Zuordnung zu Rechnungen fehlen. In Auswertungen zählt er deshalb nicht mit.
          </p>
          {fehler && <p className="mt-1 text-red-600 dark:text-red-400">{fehler}</p>}
        </div>
        {canWrite && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={laeuft} onClick={() => setEditorOffen(true)}>
              Bescheiddaten erfassen
            </Button>
            <Button size="sm" className="gap-1.5" disabled={laeuft} onClick={starte}>
              <Sparkles className="h-4 w-4" />
              {laeuft ? 'Wird ausgewertet …' : 'Mit KI auswerten'}
            </Button>
          </div>
        )}
        {editorOffen && <BescheidBearbeitenDialog postid={postid} istTier={istTier} schliessen={() => setEditorOffen(false)} />}
      </CardContent>
    </Card>
  );
}
