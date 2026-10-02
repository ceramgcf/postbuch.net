/**
 * UpdateLaufDialog – Fortschritt eines laufenden Updates
 *
 * Zwei Dinge machen diesen Dialog untypisch:
 *
 *  1. **Die Anwendung stirbt unter ihm weg.** `app` und `web` werden mitten im
 *     Lauf neu erstellt. Der Dialog muss den Verbindungsabbruch als *erwarteten*
 *     Teil des Ablaufs zeigen („Anwendung startet neu …"), nicht als Fehler.
 *  2. **Der Zustand liegt nicht hier.** Er steht in `status.json` auf dem Host.
 *     Ein Browser-Reload mitten im Lauf rekonstruiert die Anzeige daraus – die
 *     Karte öffnet den Dialog von selbst wieder, wenn ein Lauf aktiv ist.
 */

import { useEffect, useState } from 'react';
import { Dialog, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { api } from '@/api/client';
import { useUpdateStatus, leiteLaufPhaseAb } from '@/hooks/useUpdateStatus';
import { CheckCircle, AlertTriangle, RefreshCw, Clock } from 'lucide-react';

export default function UpdateLaufDialog({ open, onOpenChange, erwarteteNonce = null }) {
  const { daten, unerreichbar } = useUpdateStatus(open);
  const [log, setLog] = useState('');
  const [logOffen, setLogOffen] = useState(false);
  const [zuruecknehmen, setZuruecknehmen] = useState(false);

  const laufPasst = !erwarteteNonce || daten?.lauf?.nonce === erwarteteNonce;
  const aktuelleDaten = laufPasst ? daten : (daten ? { ...daten, lauf: null } : daten);
  const statusPhase = leiteLaufPhaseAb(aktuelleDaten, unerreichbar);
  // Derselbe Mechanismus (Anforderung → Lauf → Status) bedient auch reine
  // Host-Konfigurationsaufträge (Scanner-Modul, Port, DuckDNS) – die dürfen
  // nicht als Software-„Update" beschriftet werden, sonst behauptet der
  // Dialog fälschlich einen Versionswechsel.
  const laufTyp = aktuelleDaten?.lauf?.typ ?? aktuelleDaten?.anforderung?.typ ?? 'update';
  const istHostauftrag = laufTyp !== 'update';
  // Der Agent löscht das alte Log vor jedem Lauf. Daher ist dieser eindeutige
  // Abschlussmarker ein sicherer Fallback, falls nur die komplexere Statusroute
  // nach dem Recreate noch nicht wieder antwortet.
  const logGehoertZumLauf = !erwarteteNonce || log.includes(`nonce=${erwarteteNonce}`);
  const logErfolgreich = logGehoertZumLauf && (
    /##PHASE:fertig[\s\S]*Installer beendet:[^\n]*\(Exit-Code 0\)/.test(log)
      || /Update auf [0-9]+\.[0-9]+\.[0-9]+ abgeschlossen\./.test(log)
  );
  const phase = logErfolgreich
    ? { art: 'erfolgreich', text: 'Update abgeschlossen.' }
    : statusPhase;

  const fertig = ['erfolgreich', 'fehlgeschlagen', 'abgelehnt'].includes(phase.art);
  const wartetAufAgenten = phase.art === 'wartet' || phase.art === 'nicht_abgeholt';

  // Der Dialog bleibt beim Schließen gemountet. Ohne Reset würde ein neuer
  // Lauf zunächst den React-State des alten Protokolls zeigen.
  useEffect(() => {
    if (!open) return;
    setLog('');
    setLogOffen(false);
  }, [open]);

  useEffect(() => {
    if (!open || (!logOffen && !fertig && phase.art !== 'neustart')) return undefined;
    let weg = false;
    const holen = () => api.updates.log().then((t) => { if (!weg) setLog(t); }).catch(() => {});
    holen();
    const id = setInterval(holen, 6000);
    return () => { weg = true; clearInterval(id); };
  }, [open, logOffen, fertig, phase.art]);

  async function anforderungZuruecknehmen() {
    setZuruecknehmen(true);
    try { await api.updates.abbrechen(); } catch { /* Anzeige bleibt, Poll korrigiert */ }
    setZuruecknehmen(false);
  }

  const ikone = {
    erfolgreich:    <CheckCircle className="h-5 w-5 text-emerald-500" />,
    fehlgeschlagen: <AlertTriangle className="h-5 w-5 text-destructive" />,
    abgelehnt:      <AlertTriangle className="h-5 w-5 text-amber-500" />,
    nicht_abgeholt: <Clock className="h-5 w-5 text-amber-500" />,
    neustart:       <RefreshCw className="h-5 w-5 text-primary animate-spin" />,
  }[phase.art] || <Spinner className="h-5 w-5" />;

  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="lg">
      <DialogTitle>
        {istHostauftrag
          ? (wartetAufAgenten ? 'Host-Konfiguration wird vorbereitet' : 'Host-Konfiguration wird ausgeführt')
          : (wartetAufAgenten ? 'Update wird vorbereitet' : 'Update wird ausgeführt')}
      </DialogTitle>
      <DialogDescription>
        {istHostauftrag
          ? (wartetAufAgenten
            ? 'Die Anforderung wurde an den Server übergeben. Der Agent wendet die Konfiguration in Kürze an.'
            : 'Der Host-Agent wendet die Konfiguration auf dem Server an. Dieses Fenster darf geschlossen werden – der Fortschritt geht dabei nicht verloren.')
          : (wartetAufAgenten
            ? 'Die Anforderung wurde an den Server übergeben. Der Agent startet das Update in Kürze.'
            : 'Das Update läuft auf dem Server. Dieses Fenster darf geschlossen werden – der Fortschritt geht dabei nicht verloren.')}
      </DialogDescription>

      <div className="mt-4 space-y-4">
        <div className="flex items-start gap-3 rounded-md border border-border bg-muted/30 p-3">
          <div className="mt-0.5 shrink-0">{ikone}</div>
          <div className="min-w-0">
            <p className="text-sm font-medium">{phase.text}</p>
            {laufPasst && daten?.lauf?.seit && (
              <p className="text-xs text-muted-foreground mt-0.5">
                Begonnen: {new Date(daten.lauf.seit).toLocaleString('de-DE')}
              </p>
            )}
            {phase.art === 'neustart' && (
              <p className="text-xs text-muted-foreground mt-1">
                Die Verbindung zur Anwendung ist unterbrochen. Das ist während des Neuaufbaus
                normal und kein Fehler.
              </p>
            )}
          </div>
        </div>

        {phase.art === 'nicht_abgeholt' && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 space-y-2">
            <p className="text-xs">
              Seit über drei Minuten hat kein Agent die Anforderung abgeholt. Vermutlich läuft
              der Timer auf dem Server nicht.
            </p>
            <Button size="sm" variant="outline" onClick={anforderungZuruecknehmen} disabled={zuruecknehmen}>
              {zuruecknehmen ? 'Nehme zurück …' : 'Anforderung zurücknehmen'}
            </Button>
          </div>
        )}

        {phase.art === 'erfolgreich' && !istHostauftrag && (
          <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3">
            <p className="text-xs">
              Bitte die Seite neu laden, damit die neue Oberfläche geladen wird.
            </p>
            <Button size="sm" className="mt-2" onClick={() => window.location.reload(true)}>
              Seite neu laden
            </Button>
          </div>
        )}

        <div>
          <button
            type="button"
            className="text-xs text-muted-foreground underline underline-offset-2"
            onClick={() => setLogOffen((v) => !v)}
          >
            {logOffen ? 'Protokoll ausblenden' : 'Protokoll anzeigen'}
          </button>
          {(logOffen || fertig) && (
            <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-muted/50 p-2 text-[11px] leading-tight font-mono whitespace-pre-wrap">
              {log || '(noch kein Protokoll)'}
            </pre>
          )}
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>Schließen</Button>
      </DialogFooter>
    </Dialog>
  );
}
