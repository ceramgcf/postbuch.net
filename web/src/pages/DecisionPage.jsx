/**
 * DecisionPage.jsx – Magic-Link-Zielpunkt für Duplikat-Entscheidungen
 *
 * Route: /entscheidung/:jobId?token=...
 *
 * Wird aufgerufen wenn der Benutzer den Magic-Link aus der Discord-Webhook-Nachricht klickt.
 * Zeigt Duplikat-Details und drei Entscheidungs-Buttons.
 */
import { useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { api } from '@/api/client';

export default function DecisionPage() {
  const { jobId } = useParams();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') || undefined;

  const [result, setResult] = useState(null); // { decision, ok }
  const [error, setError] = useState(null);

  const { data: suspension, isLoading, error: loadError, refetch, isFetching } = useQuery({
    queryKey: ['pending-decision', jobId],
    queryFn: () => api.pendingDecisions.get(jobId, token),
    retry: false,
    enabled: !!jobId,
  });

  const decideMutation = useMutation({
    mutationFn: (decision) => api.pendingDecisions.decide(jobId, decision, token),
    onSuccess: (_, decision) => setResult({ decision, ok: true }),
    onError: (err) => setError(err.message),
  });

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-muted-foreground">Lade Entscheidungs-Details…</p>
      </div>
    );
  }

  // Nur „gibt es nicht (mehr)“ bzw. „Link ungültig“ ist endgültig. Ein
  // Server- oder Netzwerkfehler darf nicht wie eine erledigte Entscheidung
  // aussehen, sonst geht die offene Duplikatfrage unbemerkt verloren.
  const endgueltig = !loadError || [401, 403, 404, 410].includes(loadError.status);
  if (loadError && !endgueltig) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <Card className="max-w-md w-full">
          <CardHeader>
            <CardTitle className="text-amber-600">Gerade nicht erreichbar</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Die Entscheidung konnte nicht geladen werden. Sie ist dadurch nicht verloren – bitte gleich noch einmal versuchen.
            </p>
            <Button onClick={() => refetch()} disabled={isFetching}>
              {isFetching ? 'Lade…' : 'Erneut versuchen'}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (loadError || !suspension) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Card className="max-w-md w-full">
          <CardHeader>
            <CardTitle className="text-red-600">Nicht gefunden</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Diese Entscheidung wurde bereits getroffen oder der Link ist abgelaufen.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (result) {
    const labels = {
      replace: '✅ Bestehendes wurde ersetzt',
      discard: '🗑️ Duplikat wurde verworfen',
      keep_both: '📋 Beide Dokumente werden behalten',
    };
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Card className="max-w-md w-full border-green-400 bg-green-50 dark:bg-green-950/20">
          <CardHeader>
            <CardTitle className="text-green-700 dark:text-green-300">
              {labels[result.decision] || 'Entscheidung gespeichert'}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Das Dokument wird jetzt weiterverarbeitet. Diese Seite kann geschlossen werden.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const simPct = Math.round((suspension.similarity || 0) * 100);
  const newConfPct = Math.round((suspension.newConfidence || 0) * 100);
  const oldConfPct = Math.round((suspension.matchConfidence || 0) * 100);
  const betterQuality = (suspension.newConfidence || 0) > (suspension.matchConfidence || 0);
  const expiresStr = new Date(suspension.expiresAt).toLocaleString('de-DE', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <Card className="max-w-lg w-full border-amber-400 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-700">
        <CardHeader>
          <CardTitle className="text-amber-800 dark:text-amber-300">
            ⚠️ Duplikat-Verdacht – Ihre Entscheidung ist erforderlich
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-md border border-amber-200 dark:border-amber-800 bg-white dark:bg-neutral-900 p-3 space-y-1">
            <p className="font-medium">{suspension.betreff || '(kein Betreff)'}</p>
            <p className="text-sm text-muted-foreground">
              Datum: {suspension.briefdatum || '–'} · Typ: {suspension.dokumentTyp || '–'}
            </p>
            <p className="text-sm text-muted-foreground">
              Ähnlichkeit zu <span className="font-mono font-medium">{suspension.matchPostid}</span>: {simPct}%
            </p>
            <p className="text-sm text-muted-foreground">
              Neue Qualität: {newConfPct}% · Alte Qualität: {oldConfPct}%
            </p>
            {betterQuality && (
              <p className="text-sm font-medium text-green-700 dark:text-green-400">
                📌 Empfehlung: Bestehendes ersetzen (bessere Qualität)
              </p>
            )}
            {suspension.matchWeburl && (
              <a
                href={suspension.matchWeburl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-blue-600 hover:underline"
              >
                Bestehendes Dokument auf OneDrive ansehen ↗
              </a>
            )}
          </div>

          <p className="text-xs text-amber-700 dark:text-amber-400">
            ⏱ Automatische Entscheidung bis {expiresStr}
            {betterQuality ? ' (Auto-Ersetzen)' : ' (Auto-Verwerfen)'}
          </p>

          {error && (
            <p className="text-sm text-red-600">{error}</p>
          )}

          <div className="flex gap-2 flex-wrap">
            <Button
              className="bg-green-600 hover:bg-green-700 text-white"
              disabled={decideMutation.isPending}
              onClick={() => decideMutation.mutate('replace')}
            >
              Bestehendes ersetzen
            </Button>
            <Button
              variant="outline"
              disabled={decideMutation.isPending}
              onClick={() => decideMutation.mutate('keep_both')}
            >
              Beide behalten
            </Button>
            <Button
              variant="destructive"
              disabled={decideMutation.isPending}
              onClick={() => decideMutation.mutate('discard')}
            >
              Duplikat verwerfen
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
