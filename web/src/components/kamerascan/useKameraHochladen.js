import { useCallback } from 'react';
import { useNavigate } from 'react-router';
import { api } from '@/api/client';
import { leseImportFolgen, folgenUrl } from '@/lib/importFolgen';

/**
 * Hochladen eines fertigen Kamerascans – gemeinsam für die Karte auf der
 * Importseite und den Kameraknopf der Favoritenleiste. Wie ein Datei-Upload
 * in die Pipeline (mit „Automatisch folgen“, wenn „Scannen“ eingeschaltet
 * ist) bzw. im Ersatz-Modus als neue Datei des Eintrags. Liefert eine
 * Meldung für den Fall, dass nicht weitergeleitet wurde.
 */
export function useKameraHochladen({ replaceForPostId = null, onReplaceComplete } = {}) {
  const navigate = useNavigate();
  return useCallback(async ({ dataB64, dateiname, seiten, groesse }) => {
    const groessenText = groesse < 1024 * 1024
      ? `${Math.max(1, Math.round(groesse / 1024))} KB`
      : `${(groesse / 1024 / 1024).toLocaleString('de-DE', { maximumFractionDigits: 1 })} MB`;
    const umfang = `${seiten} ${seiten === 1 ? 'Seite' : 'Seiten'}, ${groessenText}`;
    if (replaceForPostId) {
      const res = await api.postbuch.replacePdf(replaceForPostId, { dataB64 });
      onReplaceComplete?.(res);
      return `PDF ersetzt (${umfang}).`;
    }
    const res = await api.import.upload(dateiname, dataB64);
    if (leseImportFolgen().scan) {
      navigate(folgenUrl({ jobIds: [res.jobId] }));
      return null;
    }
    return `Kamerascan hochgeladen (${umfang}) · Job ${String(res.jobId).slice(0, 8)}…`;
  }, [navigate, replaceForPostId, onReplaceComplete]);
}
