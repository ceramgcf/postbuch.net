import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import {
  useDeletePostbuch, useUpdateStatus, useMarkPaid, useReprocess,
} from '@/hooks/usePostbuch';
import { useTaskStore } from '@/hooks/useTaskStore';
import { useAuth } from '@/hooks/useAuth';
import { useUndoHistory } from '@/hooks/useUndoHistory';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';
import { Trash2, RefreshCw, CheckCheck, Banknote, AlertTriangle, Archive, FileUp, MessageCircle } from 'lucide-react';
import { useNavigate } from 'react-router';

// Auswahl der Modellstufe bei der Wiederverarbeitung. 'auto' = normales
// difficulty-Routing inkl. Preclassifier; alle anderen erzwingen das jeweils
// konfigurierte Modell und überspringen die Voranalyse.
const MODEL_TIER_OPTIONS = [
  { key: 'auto',      label: 'Auto' },
  { key: 'large',     label: 'Lang' },
  { key: 'leicht',    label: 'Leicht' },
  { key: 'mittel',    label: 'Mittel' },
  { key: 'schwierig', label: 'Schwer' },
];

export function ActionBar({ postid, currentStatus, art, hasRechnung, isBezahlt, isHistorisch, hatPdf = true, onReprocessComplete, backTo }) {
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [reprocessOpen, setReprocessOpen] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [instructions, setInstructions] = useState('');
  // Textebene (OCR) bei der Wiederverarbeitung verwerfen – Default wird aus der
  // PDF-Analyse vorbelegt (empfohlen bei eingescannten Dokumenten mit OCR-Ebene).
  const [textebeneEntfernen, setTextebeneEntfernen] = useState(false);
  const [textebeneInfo, setTextebeneInfo] = useState(null); // { hatTextebene, hatScanBild, empfehlungEntfernen }
  // Modellwahl für die Wiederverarbeitung: 'auto' (Default) oder eine feste Stufe.
  const [modelTier, setModelTier] = useState('auto');
  const [tierModels, setTierModels] = useState(null); // { tiers: {leicht,mittel,schwierig,large}, subscription:{enabled} }
  const [statusValue, setStatusValue] = useState(currentStatus);
  // Sperrstatus der Wiederverarbeitung – wird beim Laden des Dokuments einmal
  // geprüft, damit der Knopf von Anfang an gesperrt erscheint statt erst nach
  // einem fehlschlagenden Klick (409 vom Server).
  const [reprocessSchutz, setReprocessSchutz] = useState(null); // { geschuetzt, gruende } | null (noch nicht geladen)

  const navigate = useNavigate();
  const { canWrite, istEingeschraenkt } = useAuth();
  const { pushAction, clearHistory } = useUndoHistory();
  const qc = useQueryClient();
  const deleteMutation = useDeletePostbuch();
  const statusMutation = useUpdateStatus();
  const paidMutation = useMarkPaid();
  const reprocessMutation = useReprocess();
  const { addTask, setTaskJobId, completeTask, failTask } = useTaskStore();

  // Sperrstatus einmal je Dokument laden, unabhängig vom Dialog – der Knopf
  // selbst muss den Zustand schon vor dem ersten Klick zeigen.
  useEffect(() => {
    if (!canWrite) return undefined;
    let abgebrochen = false;
    setReprocessSchutz(null);
    api.actions.reprocessStatus(postid)
      .then((status) => { if (!abgebrochen) setReprocessSchutz(status); })
      .catch(() => { if (!abgebrochen) setReprocessSchutz({ geschuetzt: false, gruende: [] }); });
    return () => { abgebrochen = true; };
  }, [postid, canWrite]);

  // Beim Öffnen des Wiederverarbeitungs-Dialogs prüfen, ob das PDF eine
  // OCR-Textebene über einem Scan-Bild trägt, und die Checkbox entsprechend
  // vorbelegen (an = empfohlen).
  useEffect(() => {
    if (!reprocessOpen) return;
    let abgebrochen = false;
    setTextebeneInfo(null);
    api.actions.textebeneStatus(postid)
      .then((info) => {
        if (abgebrochen) return;
        setTextebeneInfo(info);
        setTextebeneEntfernen(!!info?.empfehlungEntfernen);
      })
      .catch(() => { if (!abgebrochen) setTextebeneInfo({ hatTextebene: false }); });
    return () => { abgebrochen = true; };
  }, [reprocessOpen, postid]);

  // Modellstufen + konkrete Modell-IDs (für die Anzeige in der Auswahl) laden,
  // sobald der Wiederverarbeitungs-Dialog geöffnet wird. Auswahl auf 'auto' zurücksetzen.
  useEffect(() => {
    if (!reprocessOpen) return;
    let abgebrochen = false;
    setModelTier('auto');
    api.settingsPublic.ai.tierModels()
      .then((d) => { if (!abgebrochen) setTierModels(d); })
      .catch(() => { if (!abgebrochen) setTierModels(null); });
    return () => { abgebrochen = true; };
  }, [reprocessOpen]);

  // Zeigt die gewählte Modellstufe auf einen Provider ohne PDF-/Vision-Fähigkeit?
  // Dann ist die OCR-Textebene das EINZIGE, was das Modell überhaupt zu sehen
  // bekommt – sie zu verwerfen hieße, ein leeres Dokument zu schicken.
  // Bei 'auto' kann die Kette auf einen beliebigen Provider absteigen; die
  // Entscheidung fällt dort serverseitig pro Kettenglied (lib/llm.js).
  const gewaehlteStufe = modelTier === 'auto' ? null : tierModels?.tiers?.[modelTier];
  const stufeIstTextOnly = gewaehlteStufe?.textOnly === true;

  // Text-only-Stufe gewählt → Schalter zwangsweise aus.
  useEffect(() => {
    if (stufeIstTextOnly) setTextebeneEntfernen(false);
  }, [stufeIstTextOnly]);

  const handleDelete = async () => {
    clearHistory();
    await deleteMutation.mutateAsync(postid);
    navigate(backTo || '/postbuch');
  };

  const handleStatusChange = (newStatus) => {
    const oldStatus = statusValue;
    setStatusValue(newStatus);
    statusMutation.mutate(
      { postid, status: newStatus },
      {
        onSuccess: () => {
          pushAction(
            `Status: "${oldStatus}" → "${newStatus}"`,
            async () => {
              await api.postbuch.updateStatus(postid, oldStatus);
              qc.invalidateQueries({ queryKey: ['postbuch'] });
            },
            async () => {
              await api.postbuch.updateStatus(postid, newStatus);
              qc.invalidateQueries({ queryKey: ['postbuch'] });
            },
          );
        },
      },
    );
  };

  const handleMarkPaid = () => {
    const dateStr = new Date().toISOString().split('T')[0];
    paidMutation.mutate(
      { postid, date: dateStr },
      {
        onSuccess: () => {
          pushAction(
            'Als bezahlt markiert',
            async () => {
              await api.postbuch.markPaid(postid, null);
              qc.invalidateQueries({ queryKey: ['postbuch'] });
            },
            async () => {
              await api.postbuch.markPaid(postid, dateStr);
              qc.invalidateQueries({ queryKey: ['postbuch'] });
            },
          );
        },
      },
    );
  };

  const handleReprocess = async () => {
    clearHistory();
    setReprocessOpen(false);
    setInstructions('');
    const ocrEntfernen = textebeneEntfernen;
    const tierWahl = modelTier;
    const taskId = addTask({ type: 'reprocess', postid, label: `KI-Wiederverarbeitung ${postid}` });
    try {
      // Startet die Pipeline und gibt sofort {jobId} zurück
      const { jobId } = await reprocessMutation.mutateAsync({ postid, instructions, textebeneEntfernen: ocrEntfernen, modelTier: tierWahl });
      setTaskJobId(taskId, jobId);

      // Auf Job-Abschluss pollen (alle 3s, max 10min)
      const POLL_INTERVAL = 3000;
      const TIMEOUT = 10 * 60 * 1000;
      const deadline = Date.now() + TIMEOUT;

      const poll = async () => {
        if (Date.now() > deadline) {
          failTask(taskId, 'Timeout: Pipeline hat nach 10 Minuten nicht geantwortet');
          return;
        }
        try {
          const job = await api.jobs.get(jobId);
          if (job.status === 'done') {
            completeTask(taskId);
            qc.invalidateQueries({ queryKey: ['postbuch'] });
            onReprocessComplete?.();
          } else if (job.status === 'failed') {
            failTask(taskId, job.error_message || 'Verarbeitung fehlgeschlagen');
          } else if (job.status === 'cancelled') {
            failTask(taskId, 'Verarbeitung wurde abgebrochen');
          } else {
            // Noch in Bearbeitung → weiter pollen
            setTimeout(poll, POLL_INTERVAL);
          }
        } catch {
          // Kurze Netzwerkunterbrechung → trotzdem weiter versuchen
          setTimeout(poll, POLL_INTERVAL);
        }
      };

      setTimeout(poll, POLL_INTERVAL);
    } catch (err) {
      failTask(taskId, err?.message ?? 'Unbekannter Fehler');
    }
  };

  const handleConfirmReplace = () => {
    setReplaceOpen(false);
    navigate(`/import?replace=${postid}`);
  };

  const handleToggleHistorisch = () => {
    const newVal = !isHistorisch;
    api.postbuch.update(postid, { historisch: newVal }).then(() => {
      qc.invalidateQueries({ queryKey: ['postbuch'] });
      pushAction(
        newVal ? 'Als historisch markiert' : 'Historisch-Markierung entfernt',
        async () => {
          await api.postbuch.update(postid, { historisch: !newVal });
          qc.invalidateQueries({ queryKey: ['postbuch'] });
        },
        async () => {
          await api.postbuch.update(postid, { historisch: newVal });
          qc.invalidateQueries({ queryKey: ['postbuch'] });
        },
      );
    });
  };

  const isUserClearance = statusValue === 'UserClearance';
  const isAiClearance = statusValue === 'AIClearance';
  const isNeedsUserReview = statusValue === 'NeedsUserReview';

  const handleGrantUserClearance = () => {
    handleStatusChange('UserClearance');
  };

  let freigabeVariant = 'outline';
  let freigabeClass = '';
  if (isNeedsUserReview) {
    freigabeVariant = 'default';
    freigabeClass = 'bg-green-600 hover:bg-green-700 text-white';
  } else if (isAiClearance) {
    freigabeVariant = 'outline';
    freigabeClass = 'border-green-500 text-green-600 hover:bg-green-50 hover:text-green-700';
  } else if (isUserClearance) {
    freigabeVariant = 'outline';
    freigabeClass = 'opacity-50 cursor-not-allowed';
  }

  // Chat-Einstieg mit vorbelegter Referenz – auch für Lesezugriff (der Chat
  // funktioniert read-only), daher außerhalb des canWrite-Guards.
  const chatButton = (
    <Button
      variant="outline"
      size="sm"
      onClick={() => navigate('/assistent', { state: { prefill: `#${postid} ` } })}
      title="Assistenten-Chat mit Referenz auf dieses Dokument starten"
    >
      <MessageCircle className="h-4 w-4 mr-1" />
      Im Chat besprechen
    </Button>
  );

  // Read-only users see no write buttons at all
  if (!canWrite) {
    // Nur eigene Dokumente: kein Assistent, also auch kein Chat-Einstieg.
    if (istEingeschraenkt) return null;
    return <div className="flex items-center gap-2 flex-wrap">{chatButton}</div>;
  }

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        {/* Gruppe 1 – Workflow-Status */}
        <div className="flex items-center gap-2 flex-wrap">
          {/* Freigabe erteilen (primäre CTA) */}
          <Button
            variant={freigabeVariant}
            size="sm"
            onClick={handleGrantUserClearance}
            disabled={isUserClearance || statusMutation.isPending}
            className={freigabeClass}
          >
            <CheckCheck className="h-4 w-4 mr-1" />
            {isUserClearance ? 'Freigabe erteilt' : 'Freigabe erteilen'}
          </Button>

          {/* Bezahlt markieren */}
          {hasRechnung && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleMarkPaid}
              disabled={paidMutation.isPending || isBezahlt}
              className={isBezahlt ? 'opacity-50 cursor-not-allowed' : ''}
              title={isBezahlt ? 'Bereits bezahlt' : undefined}
            >
              <Banknote className="h-4 w-4 mr-1" />
              {isBezahlt ? 'Bezahlt' : 'Als bezahlt markieren'}
            </Button>
          )}

        </div>

        {/* Gruppe 2 – Diskussion: Chat */}
        <div className="flex items-center gap-1.5 flex-wrap">
          {chatButton}
        </div>

        {/* Gruppe 3 – Lifecycle: Archivieren */}
        <div className="flex items-center gap-1.5 flex-wrap">
          {/* Historisch markieren */}
          <Button
            variant="outline"
            size="sm"
            onClick={handleToggleHistorisch}
            className={isHistorisch ? 'border-primary text-primary' : ''}
            title={isHistorisch ? 'Historisch-Markierung entfernen' : 'Als historisch archivieren'}
          >
            <Archive className="h-4 w-4 mr-1" />
            {isHistorisch ? 'Historisch' : 'Archivieren'}
          </Button>
        </div>

        {/* Gruppe 4 – technische Dokument-Operationen */}
        <div className="flex items-center gap-1.5 flex-wrap">
          {/* Wiederverarbeiten */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setReprocessOpen(true)}
            disabled={!!reprocessSchutz?.geschuetzt}
            className={reprocessSchutz?.geschuetzt ? 'opacity-50 cursor-not-allowed' : ''}
            title={reprocessSchutz?.geschuetzt ? `Wiederverarbeitung gesperrt: ${reprocessSchutz.gruende.join('; ')}` : undefined}
          >
            <RefreshCw className="h-4 w-4 mr-1" />
            Wiederverarbeiten
          </Button>

          {/* PDF ersetzen (bzw. reimportieren, wenn die Datei nachweislich fehlt) */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setReplaceOpen(true)}
            className={!hatPdf ? 'border-amber-400 text-amber-700 dark:text-amber-400' : ''}
            title={!hatPdf ? 'Die Datei ist in der Dateiablage nicht mehr vorhanden' : undefined}
          >
            <FileUp className="h-4 w-4 mr-1" />
            {hatPdf ? 'PDF ersetzen' : 'Fehlende PDF reimportieren'}
          </Button>
        </div>

        {/* Gruppe 5 – destruktiv: Löschen */}
        <div className="flex items-center gap-1.5 flex-wrap">
          {/* Löschen */}
          <Button variant="destructive" size="sm" onClick={() => setDeleteOpen(true)}>
            <Trash2 className="h-4 w-4 mr-1" />
            Löschen
          </Button>
        </div>
      </div>

      {/* Delete Confirm Dialog */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogTitle>Dokument löschen?</DialogTitle>
        <DialogDescription>
          Das Dokument {postid} und alle verknüpften Daten werden unwiderruflich gelöscht.
          Die PDF wird in <span className="font-mono">&lt;Wurzelordner&gt;/_trash</span> verschoben.
          Das ist der eigene Papierkorb von postbuch.net, nicht der Papierkorb von OneDrive oder Nextcloud;
          er wird nicht automatisch geleert.
        </DialogDescription>
        <div className="mt-3 flex items-start gap-2 rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
          <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5 text-amber-600" />
          <span>Wegen der Komplexität dieser Aktion <strong>kann sie nicht rückgängig gemacht werden</strong>. Der gesamte Undo-Verlauf wird dabei gelöscht.</span>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setDeleteOpen(false)}>Abbrechen</Button>
          <Button variant="destructive" onClick={handleDelete} disabled={deleteMutation.isPending}>
            {deleteMutation.isPending ? 'Lösche...' : 'Endgültig löschen'}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* Replace-PDF Confirm Dialog */}
      <Dialog open={replaceOpen} onOpenChange={setReplaceOpen}>
        <DialogTitle>{hatPdf ? 'PDF ersetzen?' : 'Fehlende PDF reimportieren?'}</DialogTitle>
        <DialogDescription>
          {hatPdf
            ? <>Die mit Eintrag <span className="font-mono font-semibold">{postid}</span> verknüpfte PDF-Datei wird durch ein neues Dokument ersetzt. Alle anderen Metadaten (Betreff, Adressat, Detail-Tabellen, Aktenzuordnung, Notizen) bleiben unverändert.</>
            : <>Die mit Eintrag <span className="font-mono font-semibold">{postid}</span> verknüpfte Datei ist in der Dateiablage nicht mehr vorhanden. Ein neues Dokument wird an ihrer Stelle in den passenden Ordner hochgeladen. Alle anderen Metadaten (Betreff, Adressat, Detail-Tabellen, Aktenzuordnung, Notizen) bleiben unverändert.</>}
        </DialogDescription>
        <div className="mt-3 space-y-2 text-xs text-muted-foreground">
          <div>Im nächsten Schritt kannst du entweder einen neuen Scan auslösen oder eine (oder mehrere) PDF-Dateien hochladen, die zu einer neuen Version zusammengeführt werden.</div>
          {hatPdf
            ? <div>Die alte Datei wird in <span className="font-mono">&lt;Wurzelordner&gt;/_trash</span> verschoben – den eigenen Papierkorb von postbuch.net. Die Aktion ist über Strg+Z rückgängig zu machen.</div>
            : <div>Da keine alte Datei mehr existiert, gibt es hier nichts rückgängig zu machen.</div>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setReplaceOpen(false)}>Abbrechen</Button>
          <Button onClick={handleConfirmReplace}>
            <FileUp className="h-4 w-4 mr-1" />
            Weiter zum Import
          </Button>
        </DialogFooter>
      </Dialog>

      {/* Reprocess Dialog */}
      <Dialog open={reprocessOpen} onOpenChange={setReprocessOpen}>
        <DialogTitle>Wiederverarbeitung</DialogTitle>
        <DialogDescription>
          Optionale Hinweise für die KI-Wiederverarbeitung:
        </DialogDescription>
        {art === 'erstattungsbescheid' && (
          <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            ⚠️ Achtung: Manuelle Korrekturen an Zuordnungen und Kürzungen dieses Bescheids
            werden dabei vollständig durch die KI überschrieben.
          </div>
        )}
        <textarea
          className="w-full mt-3 p-2 border rounded-md text-sm min-h-[80px] resize-y"
          placeholder="z.B. Bitte die Einzelpositionen genauer extrahieren..."
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
        />
        {/* Modellwahl: Auto (Default) oder feste Stufe mit Anzeige des konkreten Modells */}
        <div className="mt-4">
          <div className="text-sm font-medium mb-1.5">KI-Modell</div>
          <div className="space-y-0.5">
            {MODEL_TIER_OPTIONS.map((opt) => {
              const info = opt.key === 'auto' ? null : tierModels?.tiers?.[opt.key];
              const showAbo = !!info && tierModels?.subscription?.enabled && info.providerId === 'anthropic';
              return (
                <label
                  key={opt.key}
                  className="flex items-center gap-2 cursor-pointer text-sm rounded-md px-2 py-1 hover:bg-muted/40"
                >
                  <input
                    type="radio"
                    name="modelTier"
                    className="h-4 w-4 flex-shrink-0"
                    checked={modelTier === opt.key}
                    onChange={() => setModelTier(opt.key)}
                  />
                  <span className="font-medium w-14">{opt.label}</span>
                  {opt.key === 'auto' ? (
                    <span className="text-xs text-gray-500">Standard – automatische Schwierigkeitseinschätzung</span>
                  ) : (
                    <>
                      <span className="font-mono text-xs text-gray-500">{info?.model || '…'}</span>
                      {info?.textOnly && (
                        <span
                          className="inline-flex items-center rounded-full bg-slate-500/15 px-1.5 py-0 text-[10px] font-medium text-slate-600 dark:text-slate-300"
                          title="Dieser Provider verarbeitet weder PDFs noch Bilder – das Dokument wird als extrahierter Text übergeben."
                        >
                          nur Text
                        </span>
                      )}
                      {showAbo && (
                        <span
                          className="inline-flex items-center rounded-full bg-violet-500/15 px-1.5 py-0 text-[10px] font-medium text-violet-600 dark:text-violet-300"
                          title="Wird über die Claude-Subscription abgerechnet (Pauschaltarif)"
                        >
                          Abo
                        </span>
                      )}
                    </>
                  )}
                </label>
              );
            })}
          </div>
          {modelTier !== 'auto' && (
            <p className="text-xs text-gray-500 mt-1 px-2">
              Die Voranalyse (Preclassifier) wird übersprungen – das gewählte Modell wird direkt verwendet.
            </p>
          )}
        </div>

        {textebeneInfo?.hatTextebene && (
          <label className={`mt-3 flex items-start gap-2 text-sm ${stufeIstTextOnly ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}>
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 flex-shrink-0"
              checked={textebeneEntfernen}
              disabled={stufeIstTextOnly}
              onChange={(e) => setTextebeneEntfernen(e.target.checked)}
            />
            <span>
              <span className="font-medium">Eingescannten Text verwerfen (nur das Bild an die KI geben)</span>
              <span className="block text-xs text-gray-500 mt-0.5">
                {stufeIstTextOnly
                  ? `Nicht möglich: „${gewaehlteStufe?.model}" (${gewaehlteStufe?.providerLabel}) kann weder PDFs noch Bilder verarbeiten und bekommt nur den extrahierten Text. Ohne Textebene bliebe nichts übrig.`
                  : textebeneInfo.empfehlungEntfernen
                    ? 'Empfohlen: Dieses Dokument ist eingescannt und enthält eine automatisch erkannte Textebene (OCR), die oft fehlerhaft ist und die KI in die Irre führen kann.'
                    : 'Das Dokument enthält eingebetteten Text. Nur aktivieren, wenn dieser fehlerhaft erkannt wurde – sonst wird der vorhandene Text genutzt.'}
              </span>
            </span>
          </label>
        )}
        <div className="mt-3 flex items-start gap-2 rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
          <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5 text-amber-600" />
          <span>Diese Aktion ruft einen externen Dienst auf und <strong>kann nicht rückgängig gemacht werden</strong>. Der gesamte Undo-Verlauf wird dabei gelöscht.</span>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setReprocessOpen(false)}>Abbrechen</Button>
          <Button onClick={handleReprocess} disabled={reprocessMutation.isPending}>
            {reprocessMutation.isPending ? 'Sende...' : 'Verarbeitung starten'}
          </Button>
        </DialogFooter>
      </Dialog>
    </>
  );
}
