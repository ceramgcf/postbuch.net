import { useState, useRef, useEffect, useCallback } from 'react';
import { api } from '@/api/client';

/**
 * Entscheidet zwischen direktem Blob-Download und Hintergrundjob (SSE-Fortschritt)
 * und kapselt beides hinter einem gemeinsamen Aufruf. Server liefert für
 * zip-archiv immer eine {jobId}-Antwort – ein Aufrufer, der stattdessen einen
 * Blob erwartet, bekäme die JSON-Antwort als kaputte Datei serviert. Von
 * Dokumentenliste und Aktenansicht gemeinsam genutzt, damit beide denselben
 * Pfad nehmen.
 */
export function useExportJob() {
  const [isExporting, setIsExporting]       = useState(false);
  const [exportProgress, setExportProgress] = useState(null); // null | { step, total, format }
  const esRef = useRef(null);

  useEffect(() => () => esRef.current?.close(), []);

  const runExport = useCallback(async ({ format, akteid, resolvePostIds }) => {
    setIsExporting(true);
    setExportProgress(null);
    try {
      const postids = await resolvePostIds();
      if (postids.length === 0) return;

      const useJobFlow = (postids.length > 10 || format === 'zip-archiv')
        && (format === 'zip' || format === 'pdf-merged' || format === 'zip-archiv');
      if (useJobFlow) {
        const { jobId } = await api.export.startJob({ format, postids, akteid });
        setExportProgress({ step: 0, total: postids.length, format });
        await new Promise((resolve, reject) => {
          const es = new EventSource(`/api/export/progress/${jobId}`);
          esRef.current = es;
          es.onmessage = (e) => {
            const d = JSON.parse(e.data);
            if (d.status === 'done') { es.close(); resolve(); }
            else if (d.status === 'error') { es.close(); reject(new Error(d.error || 'Export fehlgeschlagen')); }
            else { setExportProgress(prev => ({ ...prev, step: d.step ?? prev.step })); }
          };
          es.onerror = () => { es.close(); reject(new Error('Verbindung zum Server unterbrochen')); };
        });
        setExportProgress(prev => ({ ...prev, step: prev.total }));
        api.export.downloadJob(jobId);
      } else {
        await api.export.download({ format, postids, akteid });
      }
    } catch (err) {
      console.error('[export] Fehler:', err);
      alert(`Export fehlgeschlagen: ${err.message}`);
    } finally {
      setIsExporting(false);
      setExportProgress(null);
    }
  }, []);

  return { isExporting, exportProgress, runExport };
}
