import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Dialog, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Ban, AlertTriangle, Sparkles } from 'lucide-react';
import { useInvalidateRechnung } from '@/hooks/usePostbuch';
import { useUndoHistory } from '@/hooks/useUndoHistory';
import { useAuth } from '@/hooks/useAuth';
import { useTaskStore } from '@/hooks/useTaskStore';
import { getDokumentartMeta } from '@/components/postbuch/ArtBadge';
import { api } from '@/api/client';

const POLL_INTERVAL = 3000;
const TIMEOUT = 10 * 60 * 1000;

/**
 * „Rechnung invalidieren" – für Dokumente, deren Rechnung durch eine
 * Korrekturrechnung ersetzt wurde.
 *
 * Anders als beim generischen Block genügt hier kein einfaches Löschen: Arzt-,
 * Handwerker- und Pflichttyp-Rechnungen hängen an ihrer LxD-Zelle. Der Server
 * schaltet deshalb auf Korrespondenz um und verarbeitet neu – das kündigt der
 * Dialog an, bevor irgendetwas passiert.
 */
export function InvalidateRechnungAction({ postid, onChanged }) {
  const { canWrite } = useAuth();
  const [open, setOpen] = useState(false);
  const [pruefung, setPruefung] = useState(null);   // Serverantwort auf den Vorablauf
  const [fehler, setFehler] = useState('');
  const [laeuft, setLaeuft] = useState(false);
  const invalidieren = useInvalidateRechnung();
  const { addTask, setTaskJobId, completeTask, failTask } = useTaskStore();
  const { clearHistory } = useUndoHistory();
  const qc = useQueryClient();

  if (!canWrite) return null;

  async function oeffnen() {
    setOpen(true);
    setPruefung(null);
    setFehler('');
    try {
      setPruefung(await invalidieren.mutateAsync({ postid, confirm: false }));
    } catch (e) {
      setFehler(e.message || 'Prüfung fehlgeschlagen');
    }
  }

  async function starten() {
    setFehler('');
    setLaeuft(true);
    try {
      const res = await invalidieren.mutateAsync({ postid, confirm: true });
      setOpen(false);
      clearHistory();
      const taskId = addTask({ type: 'reprocess', postid, label: `Rechnung invalidieren ${postid}` });
      setTaskJobId(taskId, res.jobId);
      const deadline = Date.now() + TIMEOUT;
      const poll = async () => {
        if (Date.now() > deadline) { failTask(taskId, 'Timeout: Pipeline hat nach 10 Minuten nicht geantwortet'); return; }
        try {
          const job = await api.jobs.get(res.jobId);
          if (job.status === 'done') {
            completeTask(taskId);
            qc.invalidateQueries({ queryKey: ['postbuch'] });
            onChanged?.();
          } else if (job.status === 'failed') {
            failTask(taskId, job.error_message || 'Invalidierung fehlgeschlagen');
          } else if (job.status === 'cancelled') {
            failTask(taskId, 'Invalidierung wurde abgebrochen');
          } else {
            setTimeout(poll, POLL_INTERVAL);
          }
        } catch { setTimeout(poll, POLL_INTERVAL); }
      };
      poll();
    } catch (e) {
      setFehler(e.message || 'Invalidierung fehlgeschlagen');
    } finally {
      setLaeuft(false);
    }
  }

  const zielL = pruefung?.ziel?.lebensbereich;
  const zielD = pruefung?.ziel?.dokumentart;
  const zielLabel = zielD ? (getDokumentartMeta(zielD)?.label || zielD) : 'Korrespondenz';

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 gap-1.5 text-destructive/60 hover:text-destructive hover:bg-destructive/10"
        onClick={oeffnen}
        title="Rechnung invalidieren – Rechnungsblock entfernen, weil eine Korrekturrechnung sie ersetzt"
      >
        <Ban className="h-3.5 w-3.5" />
        Rechnung invalidieren
      </Button>

      <Dialog open={open} onOpenChange={setOpen} size="lg">
        <DialogTitle className="flex items-center gap-2">
          <AlertTriangle className="h-5 w-5 text-destructive flex-shrink-0" />
          Rechnung invalidieren?
        </DialogTitle>
        <DialogDescription className="mt-2 space-y-2">
          {!pruefung && !fehler && <p>Wird geprüft…</p>}
          {pruefung && (
            <>
              <p>
                Der <strong>Rechnungsblock wird entfernt</strong>. Das Dokument ist danach keine
                Forderung mehr und verschwindet aus „Unbezahlt", aus der Summe offener Beträge und
                aus dem Fälligkeitskalender.
              </p>
              <p className="flex items-start gap-2 rounded-lg bg-muted px-3 py-2">
                <Sparkles className="mt-0.5 h-4 w-4 flex-shrink-0" />
                <span>
                  Dazu wird die Einordnung automatisch auf{' '}
                  <strong>{zielL}/{zielLabel}</strong> umgeschaltet und das Dokument{' '}
                  <strong>neu durch die KI verarbeitet</strong>. Die KI bekommt den Hinweis, dass die
                  Rechnung invalidiert wurde, und stellt dem Betreff{' '}
                  <strong>[Invalidierte Rechnung]</strong> voran. Die Datei wandert in den zugehörigen
                  Dateiablageordner.
                </span>
              </p>
              <p>
                <strong>Die Rechnungsdaten gehen dabei verloren</strong> – Beträge, Fälligkeit und
                Einzelpositionen. Notiz, Wiedervorlagen, Aktenzugehörigkeit und Archivstatus bleiben
                erhalten. Trage Zahlen, die du behalten willst, vorher in die Notiz ein.
              </p>
              <p>Der gesamte Undo-Verlauf wird dabei gelöscht.</p>
            </>
          )}
          {fehler && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{fehler}</p>}
        </DialogDescription>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={laeuft}>
            Abbrechen
          </Button>
          <Button variant="destructive" onClick={starten} disabled={laeuft || !pruefung}>
            {laeuft ? 'Wird gestartet…' : 'Invalidieren und neu verarbeiten'}
          </Button>
        </DialogFooter>
      </Dialog>
    </>
  );
}
