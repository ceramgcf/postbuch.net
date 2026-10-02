/**
 * UpdateCard – Versionsstand und In-GUI-Update (Allgemein-Tab, admin-only)
 *
 * Drei Zustände, die klar auseinandergehalten werden müssen:
 *
 *   • **aktuell** – dezent, grün, keine Handlungsaufforderung.
 *   • **Update verfügbar** – Hinweis; bei `sicherheitsrelevant` in Amber. Das
 *     ist die einzige Stelle, an der Dringlichkeit gezeigt wird.
 *   • **kein Agent** – der Regelfall auf einem selbst gepflegten System (auch
 *     auf dem Master-System hier). Dann gibt es **keinen Installieren-Button**,
 *     sondern eine Erklärung und einen Kopierbefehl. Ein Button, dessen Klick
 *     garantiert ins Leere geht, ist schlechter als kein Button.
 *
 * Vor dem Start steht ein Bestätigungsdialog, der ausdrücklich benennt, was
 * passiert: automatisches Backup inkl. DB-Dump, mehrere Minuten
 * Nichtverfügbarkeit, `.env` bleibt erhalten, Rückweg über `install.sh
 * --rollback`. Ein Update ist der eingreifendste Knopf der ganzen Anwendung.
 */

import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { Dialog, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import UpdateLaufDialog from './UpdateLaufDialog';
import {
  Download, CheckCircle, ShieldAlert, Copy, Check, RefreshCw, Terminal, ShieldCheck, ShieldQuestion,
} from 'lucide-react';

/**
 * Die Signaturzeile.
 *
 * Sie ist bewusst immer sichtbar und nicht nur im Fehlerfall: eine Instanz, die
 * Signaturen gar nicht prüfen kann, sähe sonst genauso aus wie eine geschützte.
 * Der Admin läse „Signaturprüfung" im Changelog und hielte sich für abgesichert,
 * obwohl auf seinem System nie etwas geprüft wird.
 *
 * Drei Aussagen, die nicht zu einem „ungeprüft" verschmelzen dürfen:
 *   • geprüft und gültig          – grün, beiläufig
 *   • Prüfung noch nicht scharf   – neutral, erklärend (Übergangszustand)
 *   • Pflicht, aber nicht erfüllt – amber, das ist ein echter Befund
 */
function SignaturZeile({ signatur }) {
  if (!signatur?.moeglich) return null;

  if (signatur.status == null) {
    return (
      <p className="text-xs flex items-start gap-1.5 text-muted-foreground">
        <ShieldQuestion className="h-3.5 w-3.5 shrink-0 mt-px" />
        <span>Noch nicht geprüft – die Signatur wird beim nächsten Update-Check verifiziert.</span>
      </p>
    );
  }

  const gueltig = signatur.status === 'gueltig';
  const scharf  = signatur.pflicht;

  const [Icon, farbe, text] = gueltig
    ? [ShieldCheck, 'text-emerald-600 dark:text-emerald-500',
        scharf
          ? 'Release-Signatur geprüft. Updates ohne gültige Signatur werden abgelehnt.'
          : 'Release-Signatur geprüft.']
    : scharf
      ? [ShieldAlert, 'text-amber-600 dark:text-amber-500',
          `${signatur.text ?? 'Signatur nicht in Ordnung'} – diese Instanz verlangt eine gültige `
          + 'Signatur und installiert deshalb nichts.']
      : [ShieldQuestion, 'text-muted-foreground',
          'Noch kein signiertes Release gesehen. Sobald einmal eine gültige Signatur geprüft '
          + 'wurde, sind Updates ohne gültige Signatur gesperrt.'];

  return (
    <p className={`text-xs flex items-start gap-1.5 ${farbe}`}>
      <Icon className="h-3.5 w-3.5 shrink-0 mt-px" />
      <span>{text}</span>
    </p>
  );
}

export default function UpdateCard() {
  const qc = useQueryClient();
  const [bestaetigen, setBestaetigen] = useState(false);
  const [backupFrage, setBackupFrage] = useState(false);
  const [laufOffen, setLaufOffen] = useState(false);
  const [laufNonce, setLaufNonce] = useState(null);
  const [kopiert, setKopiert] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['updates'],
    queryFn: () => api.updates.get(),
    retry: false,
  });

  // Gleicher queryKey wie BackupTab, damit beide denselben Cache-Eintrag teilen.
  const { data: backupStatus } = useQuery({
    queryKey: ['backup', 'settings'],
    queryFn: () => api.backup.getSettings(),
    retry: false,
  });
  const backupAktiv = backupStatus ? (backupStatus.enabled && backupStatus.backupFolderConfigured) : true;

  const backupAktivieren = useMutation({
    mutationFn: () => api.backup.updateSettings({ enabled: true, cron: backupStatus?.cron || '0 4 * * *' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['backup', 'settings'] });
      qc.invalidateQueries({ queryKey: ['backup-status-public'] });
      setBackupFrage(false);
      setBestaetigen(true);
    },
  });

  // Ein Lauf, der bereits aktiv ist (etwa nach einem Browser-Reload mitten im
  // Update), öffnet den Fortschrittsdialog von selbst – der Zustand liegt auf
  // der Platte des Hosts, nicht in diesem Component.
  useEffect(() => {
    if (data?.lauf?.status === 'laeuft' || data?.anforderung) setLaufOffen(true);
  }, [data?.lauf?.status, data?.anforderung]);

  const pruefen = useMutation({
    mutationFn: () => api.updates.pruefen(),
    onSuccess: (d) => qc.setQueryData(['updates'], d),
  });

  const starten = useMutation({
    mutationFn: () => api.updates.starten(),
    onSuccess: ({ nonce }) => {
      setBestaetigen(false);
      setLaufNonce(nonce);
      setLaufOffen(true);
      qc.invalidateQueries({ queryKey: ['updates'] });
    },
  });

  const schalter = useMutation({
    mutationFn: (an) => api.settings.update('update_check_enabled', an),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['updates'] });
      qc.invalidateQueries({ queryKey: ['settings'] });
      qc.invalidateQueries({ queryKey: ['cloudfrei-check'] });
    },
  });

  // Der Server prüft nach dem Umschalten gleich im neuen Kanal nach und
  // liefert das fertige Gesamtbild zurück.
  const kanal = useMutation({
    mutationFn: (an) => api.updates.kanal(an),
    onSuccess: (d) => qc.setQueryData(['updates'], d),
  });

  function kopiere(text) {
    navigator.clipboard?.writeText(text).then(() => {
      setKopiert(true);
      setTimeout(() => setKopiert(false), 2000);
    });
  }

  if (isLoading) {
    return (
      <Card><CardContent className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
        <Spinner className="h-4 w-4" />Lade Versionsstand …
      </CardContent></Card>
    );
  }

  const verfuegbar = data?.updateVerfuegbar;
  const sicherheit = verfuegbar && data?.sicherheitsrelevant;
  const agentDa = data?.agent?.vorhanden && data?.agent?.schreibbar;
  const quelleKonfiguriert = data?.bezugsquelleKonfiguriert;

  return (
    <>
      <Card className={sicherheit ? 'border-amber-500/50' : undefined}>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            {sicherheit
              ? <ShieldAlert className="h-5 w-5 text-amber-500" />
              : verfuegbar
                ? <Download className="h-5 w-5 text-primary" />
                : <CheckCircle className="h-5 w-5 text-emerald-500" />}
            <CardTitle className="text-base">Version und Updates</CardTitle>
            {verfuegbar && (
              <Badge variant={sicherheit ? 'destructive' : 'secondary'} className="text-[10px]">
                {sicherheit ? 'Sicherheitsupdate' : 'Update verfügbar'}
              </Badge>
            )}
          </div>
          <CardDescription className="text-xs pt-1">
            {verfuegbar
              ? `Installiert ${data.installiert ?? '–'} · verfügbar ${data.verfuegbar}`
              : data?.bezugsquelleGeaendert
                ? 'Die Bezugsquelle wurde geändert. Bitte Versionsstand erneut prüfen.'
              : data?.installiert
                ? `Installiert: ${data.installiert} – auf dem neuesten bekannten Stand.`
                : 'Die installierte Version ist nicht ermittelbar.'}
          </CardDescription>
        </CardHeader>

        <CardContent className="pt-0 space-y-4">
          {/* Die installierte Version ist unbekannt, wenn die docker-compose.yml
              den VERSION-Mount noch nicht hat – bei Instanzen, die von einer
              älteren Version kommen, genau einmal der Fall. */}
          {!data?.installiert && (
            <p className="text-xs text-amber-700 dark:text-amber-500">
              Diese Instanz kennt ihre eigene Version nicht. Nach einem einmaligen manuellen
              Update auf dem Server funktioniert die Anzeige.
            </p>
          )}

          <SignaturZeile signatur={data?.signatur} />

          {!quelleKonfiguriert && (
            <p className="text-xs rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-amber-800 dark:text-amber-400">
              Keine Bezugsquelle eingerichtet. Setze auf dem Server
              {' '}<code className="font-mono">POSTBUCH_FEED_BASE_URL</code> in der
              {' '}.env und starte die App neu; bis dahin bleibt der Update-Check
              ohne Netzwerkzugriff. Modellempfehlungen sind im Release enthalten.
            </p>
          )}

          {verfuegbar && !!data.changelog?.length && (
            <div>
              <p className="text-xs font-medium mb-1">
                Neu in {data.verfuegbar}
                {data.veroeffentlichtAm && (
                  <span className="text-muted-foreground font-normal">
                    {' '}· {new Date(data.veroeffentlichtAm).toLocaleDateString('de-DE')}
                  </span>
                )}
              </p>
              <ul className="text-xs text-muted-foreground space-y-0.5 list-disc pl-4">
                {data.changelog.map((z, i) => <li key={i}>{z}</li>)}
              </ul>
            </div>
          )}

          {/* Kein Agent: erklären statt einen toten Button anbieten. */}
          {verfuegbar && !agentDa && (
            <div className="rounded-md border border-border bg-muted/30 p-3 space-y-2">
              <p className="text-xs font-medium flex items-center gap-1.5">
                <Terminal className="h-3.5 w-3.5" />Automatische Updates sind nicht eingerichtet
              </p>
              <p className="text-xs text-muted-foreground">
                {data.agent?.vorhanden && !data.agent?.schreibbar
                  ? 'Auf dem Server läuft ein Update-Agent, er darf aber nicht in das Übergabeverzeichnis schreiben.'
                  : 'postbuch.net aktualisiert sich nicht selbst. Führe diesen Befehl auf dem Server aus:'}
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 min-w-0 truncate rounded bg-background px-2 py-1 text-[11px] font-mono">
                  {data.kopierbefehl}
                </code>
                <Button variant="outline" size="sm" className="h-7 shrink-0" onClick={() => kopiere(data.kopierbefehl)}>
                  {kopiert ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                </Button>
              </div>
            </div>
          )}

          <div className="flex items-center justify-between border-t border-border pt-3">
            <div>
              <p className="text-sm font-medium">Täglich auf Updates prüfen</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {data?.checkAktiv
                  ? quelleKonfiguriert
                    ? 'Fragt einmal täglich bei der konfigurierten Bezugsquelle nach neuen Versionen.'
                    : 'Ausgesetzt, bis eine Bezugsquelle konfiguriert ist.'
                  : 'Aus – es geht kein Request nach draußen.'}
              </p>
            </div>
            <button
              type="button"
              onClick={() => schalter.mutate(!data?.checkAktiv)}
              disabled={schalter.isPending}
              className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${data?.checkAktiv ? 'bg-primary' : 'bg-muted'}`}
            >
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${data?.checkAktiv ? 'translate-x-6' : 'translate-x-1'}`} />
            </button>
          </div>

          {/* Nur bei GitHub-Quellen: dort tragen Releases den Pre-release-Haken. */}
          {data?.kanalWaehlbar && (
            <div className="flex items-center justify-between border-t border-border pt-3">
              <div>
                <p className="text-sm font-medium">Vorabversionen erhalten</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {data.vorabversionen
                    ? 'Bietet auch Vorabversionen an. Sie sind neuer, aber weniger erprobt.'
                    : 'Nur stabile Versionen. Vorabversionen sind neuer, aber weniger erprobt.'}
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={!!data.vorabversionen}
                aria-label="Vorabversionen erhalten"
                onClick={() => kanal.mutate(!data.vorabversionen)}
                disabled={kanal.isPending}
                className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${data.vorabversionen ? 'bg-primary' : 'bg-muted'}`}
              >
                <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${data.vorabversionen ? 'translate-x-6' : 'translate-x-1'}`} />
              </button>
            </div>
          )}

          {(pruefen.isError || starten.isError || kanal.isError) && (
            <p className="text-sm text-destructive">{(pruefen.error || starten.error || kanal.error)?.message}</p>
          )}
          {data?.fehler && !pruefen.isError && (
            <p className="text-xs text-amber-700 dark:text-amber-500">Letzte Prüfung: {data.fehler}</p>
          )}

          <div className="flex items-center gap-3 flex-wrap">
            <Button
              size="sm" variant="outline"
              onClick={() => pruefen.mutate()}
              disabled={pruefen.isPending || !data?.checkAktiv || !quelleKonfiguriert}
            >
              {pruefen.isPending ? <Spinner className="h-3.5 w-3.5 mr-1.5" /> : <RefreshCw className="h-3.5 w-3.5 mr-1.5" />}
              Jetzt prüfen
            </Button>
            {verfuegbar && agentDa && (
              <Button size="sm" onClick={() => (backupAktiv ? setBestaetigen(true) : setBackupFrage(true))}>
                <Download className="h-3.5 w-3.5 mr-1.5" />
                Update installieren
                {data.agent.modus === 'dry-run' && ' (Probelauf)'}
              </Button>
            )}
            {data?.geprueftAm && (
              <span className="text-[11px] text-muted-foreground">
                zuletzt geprüft: {new Date(data.geprueftAm).toLocaleString('de-DE')}
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Kein Backdrop-/Escape-Dismiss (onOpenChange no-op): der Nutzer muss die
          Frage bewusst mit Ja oder Nein beantworten, bevor es weitergeht. */}
      <Dialog open={backupFrage} onOpenChange={() => {}} size="md">
        <DialogTitle>Kein Backup aktiv</DialogTitle>
        <DialogDescription>
          Aktuell läuft kein automatisches Backup. Ein Update ist ein eingreifender Vorgang –
          ohne laufendes Backup gibt es im Fehlerfall keinen Weg zurück zu zwischenzeitlich
          gesicherten Daten.
        </DialogDescription>
        {backupAktivieren.isError && (
          <p className="mt-2 text-sm text-destructive">{backupAktivieren.error.message}</p>
        )}
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => { setBackupFrage(false); setBestaetigen(true); }}>
            Nein, ohne Backup fortfahren
          </Button>
          <Button size="sm" onClick={() => backupAktivieren.mutate()} disabled={backupAktivieren.isPending}>
            {backupAktivieren.isPending ? 'Aktiviere …' : 'Ja, Backup jetzt aktivieren'}
          </Button>
        </DialogFooter>
      </Dialog>

      <Dialog open={bestaetigen} onOpenChange={setBestaetigen} size="lg">
        <DialogTitle>Update auf {data?.verfuegbar} installieren?</DialogTitle>
        <DialogDescription>
          Das Update wird auf dem Server ausgeführt. Was dabei passiert:
        </DialogDescription>
        <ul className="mt-3 space-y-1.5 text-sm list-disc pl-5">
          <li>Vorher wird automatisch eine <strong>Sicherung inkl. Datenbank-Dump</strong> angelegt.</li>
          <li>Die Anwendung ist mehrere Minuten <strong>nicht erreichbar</strong> – auf schwacher Hardware bis zu 35 Minuten.</li>
          <li>Deine <code className="font-mono text-xs">.env</code> und alle Daten <strong>bleiben erhalten</strong>.</li>
          <li>Rückweg: <code className="font-mono text-xs">install.sh --rollback</code> auf dem Server.</li>
        </ul>
        {data?.agent?.modus === 'dry-run' && (
          <p className="mt-3 text-xs rounded-md border border-amber-500/40 bg-amber-500/10 p-2">
            Der Agent läuft im <strong>Probelauf-Modus</strong>: Download, Prüfsumme und Backup laufen
            durch, danach bricht er ab. Es wird nichts ersetzt.
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => setBestaetigen(false)}>Abbrechen</Button>
          <Button size="sm" onClick={() => starten.mutate()} disabled={starten.isPending}>
            {starten.isPending ? 'Starte …' : 'Update starten'}
          </Button>
        </DialogFooter>
      </Dialog>

      <UpdateLaufDialog
        open={laufOffen}
        onOpenChange={setLaufOffen}
        erwarteteNonce={laufNonce}
      />
    </>
  );
}
