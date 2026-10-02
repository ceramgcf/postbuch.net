/**
 * FailedDocumentsCard.jsx – Dashboard-Karte für fehlgeschlagene Dokumente
 */
import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { api } from '@/api/client';

export default function FailedDocumentsCard() {
  const queryClient = useQueryClient();
  const [confirmDelete, setConfirmDelete] = useState(null); // onedriveId
  // onedriveId -> Zeitpunkt des Klicks. Der _failed_documents-Eintrag bleibt
  // absichtlich bestehen, bis der Hintergrund-Job ihn auflöst (siehe Kommentar
  // in actions.js) — ohne diese Markierung sah ein Klick auf "Erneut
  // verarbeiten" deshalb aus wie ein Fehlschlag, weil die Karte einfach
  // stehen blieb, bis der 60s-Poll zufällig das Ergebnis einfing.
  const [retrying, setRetrying] = useState({});

  const { data: failed = [], isLoading } = useQuery({
    queryKey: ['failed-documents'],
    queryFn: () => api.failedDocuments.list(),
    refetchInterval: Object.keys(retrying).length > 0 ? 3_000 : 60_000,
  });

  // Sobald der Eintrag verschwindet (erfolgreich aufgelöst) oder mit neuerem
  // failed_at zurückkommt (erneut fehlgeschlagen), ist der Retry beantwortet.
  useEffect(() => {
    setRetrying((prev) => {
      const next = {};
      for (const [id, clickedAt] of Object.entries(prev)) {
        const doc = failed.find((d) => d.onedrive_id === id);
        if (doc && new Date(doc.failed_at).getTime() <= clickedAt) next[id] = clickedAt;
      }
      return next;
    });
  }, [failed]);

  const reprocessMutation = useMutation({
    mutationFn: (onedriveId) => api.failedDocuments.reprocess(onedriveId),
    onMutate: (onedriveId) => setRetrying((prev) => ({ ...prev, [onedriveId]: Date.now() })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['failed-documents'] }),
    onError: (err, onedriveId) => {
      setRetrying((prev) => {
        const { [onedriveId]: _entfernt, ...rest } = prev;
        return rest;
      });
      alert(`Fehler: ${err.message}`);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (onedriveId) => api.failedDocuments.delete(onedriveId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['failed-documents'] });
      setConfirmDelete(null);
    },
    onError: (err) => {
      alert(`Fehler: ${err.message}`);
      setConfirmDelete(null);
    },
  });

  if (isLoading) return null;
  if (!failed.length) return null;

  return (
    <Card className="border-red-400 bg-red-50 dark:bg-red-950/20 dark:border-red-700">
      <CardHeader className="pb-3">
        <CardTitle className="text-base font-semibold text-red-800 dark:text-red-300 flex items-center gap-2">
          ❌ Fehlgeschlagene Dokumente
          <span className="ml-auto text-sm font-normal bg-red-200 dark:bg-red-900 px-2 py-0.5 rounded-full">
            {failed.length}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {failed.map((doc) => {
          const isQuotaError = /quota|Guthaben|aufgebraucht|rate.?limit|billing|credit/i.test(doc.reason || '');
          const wirdWiederholt = doc.onedrive_id in retrying;
          return (
          <div
            key={doc.onedrive_id}
            className="rounded-md border border-red-300 dark:border-red-700 bg-white dark:bg-neutral-900 p-3 space-y-2"
          >
            <div className="space-y-0.5">
              <p className="font-medium text-sm truncate">{doc.betreff || doc.failed_filename || '(unbekannt)'}</p>
              <p className="text-xs text-red-600 dark:text-red-400 line-clamp-2">{doc.reason}</p>
              {isQuotaError && (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  API-Guthaben möglicherweise aufgebraucht.{' '}
                  <a href="/einstellungen?tab=ki" className="underline underline-offset-2 hover:text-amber-500">
                    KI-Einstellungen prüfen
                  </a>
                  {', dann '}„Erneut verarbeiten" klicken.
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                {new Date(doc.failed_at).toLocaleString('de-DE')}
                {doc.document_type ? ` · ${doc.document_type}` : ''}
              </p>
              {doc.web_url && (
                <a
                  href={doc.web_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-blue-600 hover:underline"
                >
                  Datei auf OneDrive ↗
                </a>
              )}
            </div>

            {wirdWiederholt ? (
              <p className="text-xs text-muted-foreground italic">Wird erneut verarbeitet …</p>
            ) : (
              <div className="flex gap-1.5">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={reprocessMutation.isPending}
                  onClick={() => reprocessMutation.mutate(doc.onedrive_id)}
                >
                  Erneut verarbeiten
                </Button>

                {confirmDelete === doc.onedrive_id ? (
                  <>
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => deleteMutation.mutate(doc.onedrive_id)}
                    >
                      Wirklich löschen
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setConfirmDelete(null)}
                    >
                      Abbrechen
                    </Button>
                  </>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-red-600 hover:text-red-700"
                    onClick={() => setConfirmDelete(doc.onedrive_id)}
                  >
                    Löschen
                  </Button>
                )}
              </div>
            )}
          </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
