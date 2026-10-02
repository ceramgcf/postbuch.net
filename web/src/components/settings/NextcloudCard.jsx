/**
 * NextcloudCard – Verbindung zu einem eigenen WebDAV-Speicher.
 *
 * Der Adapter spricht die ownCloud-WebDAV-Familie (oc:fileid), im UI daher der
 * Oberbegriff „WebDAV-Speicher" mit den drei geläufigsten Beispielen Nextcloud,
 * ownCloud und MagentaCLOUD. „Schnell verbinden" (Login-Flow v2) gibt es nur bei
 * Nextcloud; ownCloud/MagentaCLOUD/andere verbinden per Benutzername +
 * App-Passwort (gleichwertig angeboten, nicht mehr versteckt). Für MagentaCLOUD
 * steht die Adresse für alle Kunden fest – dafür gibt es die Ein-Klick-Vorlage
 * am Adressfeld.
 *
 * Die Karte klappt von selbst auf, wenn bereits etwas konfiguriert ist. Umschalten
 * des aktiven Backends und die Migration selbst laufen über den Migrations-
 * assistenten (AblageUmzugPage), nicht hier.
 */

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import {
  Server, Link2, Unlink2, CheckCircle2, XCircle, AlertTriangle, ShieldAlert,
  Eye, EyeOff, ExternalLink, Copy, Check, PlayCircle, ChevronUp, KeyRound, Cloud,
} from 'lucide-react';

/** MagentaCLOUD ist für alle Kunden derselbe Server. */
const MAGENTACLOUD_URL = 'https://magentacloud.de';
import { wirktPrivat } from '@/lib/net-heuristics';

function mmss(sek) {
  const s = Math.max(0, Math.floor(sek));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export default function NextcloudCard({ onCollapse }) {
  const qc = useQueryClient();

  const { data: status, refetch } = useQuery({
    queryKey: ['nextcloud-status'],
    queryFn: () => api.nextcloud.status(),
    retry: false,
    // Während der Anmeldevorgang läuft, häufiger nachsehen – das ist die
    // einzige Stelle, an der sich der Zustand ohne Zutun des Nutzers ändert.
    refetchInterval: (q) => (q.state.data?.flow?.status === 'wartet' ? 3000 : false),
  });

  const [baseUrl, setBaseUrl] = useState('');
  const [allowInsecure, setAllowInsecure] = useState(false);
  const [manuell, setManuell] = useState(false);
  const [ncUser, setNcUser] = useState('');
  const [ncPass, setNcPass] = useState('');
  const [zeigePass, setZeigePass] = useState(false);
  const [kopiert, setKopiert] = useState(false);
  const [testErgebnis, setTestErgebnis] = useState(null);
  const [selftest, setSelftest] = useState(null);
  const geladen = useRef(false);

  useEffect(() => {
    if (!status || geladen.current) return;
    geladen.current = true;
    setBaseUrl(status.baseUrl || '');
    setAllowInsecure(!!status.allowInsecure);
    setNcUser(status.username || '');
  }, [status]);

  // Wie bei OneDrive: der Einrichtungsassistent liest den Dateiablage-Status aus
  // GET /api/einrichtung. Verbinden und Trennen passieren hier teils ohne
  // Mutation (Login-Flow v2 wird gepollt), deshalb hängt die Invalidierung am
  // Zustandswechsel selbst.
  const zuletztVerbunden = useRef(null);
  useEffect(() => {
    if (status?.connected === undefined) return;
    const jetzt = !!status.connected;
    const erstwert = zuletztVerbunden.current === null;
    if (zuletztVerbunden.current === jetzt) return;
    zuletztVerbunden.current = jetzt;
    if (erstwert) return;   // Nur echte Wechsel, nicht das erste Laden.
    qc.invalidateQueries({ queryKey: ['einrichtung'] });
    qc.invalidateQueries({ queryKey: ['ablage-wurzel'] });
    // Auch der Settings-Blob: er traegt nextcloud_base_url, aus dem der
    // Dateiablage-Tab ableitet, ob die zweite Dateiablage ueberhaupt existiert.
    qc.invalidateQueries({ queryKey: ['settings'] });
  }, [status?.connected, qc]);

  const flow = status?.flow || { status: 'aus' };
  const istHttp = baseUrl.trim().toLowerCase().startsWith('http://');
  const privat = istHttp && wirktPrivat(baseUrl.trim());
  const oeffentlichUnverschluesselt = istHttp && !privat;

  // Die Adresse kommt als Argument, nicht aus dem State: die Ein-Klick-Vorlage
  // setzt Feld und Konfiguration in einem Rutsch, und ein `setState` ist beim
  // direkt folgenden `mutate()` noch nicht sichtbar.
  const configMutation = useMutation({
    mutationFn: (url) => api.nextcloud.saveConfig({
      baseUrl: (url ?? baseUrl).trim(),
      allowInsecure,
      allowPrivateTargets: privat ? true : undefined,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['nextcloud-status'] });
      qc.invalidateQueries({ queryKey: ['settings'] });
      setTestErgebnis(null);
    },
  });

  const flowMutation = useMutation({
    mutationFn: () => api.nextcloud.flowStart(),
    onSuccess: () => refetch(),
  });
  const cancelMutation = useMutation({
    mutationFn: () => api.nextcloud.flowCancel(),
    onSuccess: () => refetch(),
  });
  const credMutation = useMutation({
    mutationFn: () => api.nextcloud.saveCredentials({ username: ncUser.trim(), appPassword: ncPass }),
    onSuccess: () => {
      setNcPass(''); setManuell(false);
      qc.invalidateQueries({ queryKey: ['nextcloud-status'] });
      qc.invalidateQueries({ queryKey: ['settings'] });
    },
  });
  const testMutation = useMutation({
    mutationFn: () => api.nextcloud.test(),
    onSuccess: (r) => setTestErgebnis({ ok: true, text: `Verbunden als „${r.username}"` }),
    onError: (e) => setTestErgebnis({ ok: false, text: e.message }),
  });
  const disconnectMutation = useMutation({
    mutationFn: () => api.nextcloud.disconnect(),
    onSuccess: () => {
      setNcPass(''); setTestErgebnis(null); setSelftest(null);
      qc.invalidateQueries({ queryKey: ['nextcloud-status'] });
      qc.invalidateQueries({ queryKey: ['settings'] });
    },
  });
  const selftestMutation = useMutation({
    mutationFn: () => api.storage.selftest('nextcloud'),
    onSuccess: (r) => setSelftest(r),
    onError: (e) => setSelftest({ ok: false, schritte: [], fehler: e.message }),
  });

  function kopiereLink(url) {
    navigator.clipboard.writeText(url).then(() => {
      setKopiert(true);
      setTimeout(() => setKopiert(false), 2000);
    });
  }

  const bestanden = selftest?.schritte?.filter((s) => s.ok).length ?? 0;
  const gesamt = selftest?.schritte?.length ?? 0;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <Server className={`h-5 w-5 ${status?.connected ? 'text-emerald-500' : 'text-muted-foreground'}`} />
          <CardTitle className="text-base">Eigener WebDAV-Speicher</CardTitle>
          {status?.connected && (
            <Badge variant="default" className="ml-auto text-xs">Verbunden</Badge>
          )}
          {status?.connected && !status?.isActiveBackend && (
            <Badge variant="secondary" className="text-xs">nicht aktiv</Badge>
          )}
          {onCollapse && (
            <button
              type="button"
              onClick={onCollapse}
              className="ml-auto text-muted-foreground hover:text-foreground"
              title="Einklappen"
            >
              <ChevronUp className="h-4 w-4" />
            </button>
          )}
        </div>
        <CardDescription className="text-xs pt-1">
          {status?.connected
            ? status.isActiveBackend
              ? <>Verbunden als <span className="font-medium text-foreground">{status.username}</span>. Dieser WebDAV-Speicher ist die aktive Dateiablage – neue Dokumente landen hier.</>
              : <>Verbunden als <span className="font-medium text-foreground">{status.username}</span>. Aktive Dateiablage ist derzeit OneDrive; umgestellt wird am Ende eines Migrationslaufs.</>
            : status?.isActiveBackend
              ? <>Der WebDAV-Speicher ist als Dateiablage eingestellt, aber noch nicht verbunden. Trage die Server-Adresse ein und melde dich an – danach den Setup-Assistenten weiter unten ausführen, damit die Ordner angelegt werden.</>
              : <>postbuch.net kann seine Dokumente statt in OneDrive in deinem eigenen WebDAV-Speicher ablegen – <span className="font-medium text-foreground">Nextcloud, ownCloud, MagentaCLOUD</span> und andere. Umgestellt wird die aktive Dateiablage am Ende eines Migrationslaufs.</>}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* ── Server-Adresse ─────────────────────────────────────────────── */}
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Server-Adresse</label>
          <Input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://cloud.example.de"
            className="h-9 text-sm font-mono"
          />
          <p className="text-xs text-muted-foreground">
            Die Adresse, unter der du deinen WebDAV-Speicher (Nextcloud, ownCloud, MagentaCLOUD …) im Browser aufrufst – ohne <span className="font-mono">/index.php</span> oder Unterseite.
          </p>

          {/* MagentaCLOUD hat für alle Kunden dieselbe Adresse – die muss
              niemand abtippen. Der Klick trägt sie ein, speichert sie und
              öffnet gleich die Anmeldung mit App-Passwort, denn den
              Ein-Klick-Login gibt es dort nicht. */}
          {!status?.connected && (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <span className="text-xs text-muted-foreground">Telekom-Kunde?</span>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={() => {
                  setBaseUrl(MAGENTACLOUD_URL);
                  setAllowInsecure(false);
                  setManuell(true);
                  configMutation.mutate(MAGENTACLOUD_URL);
                }}
                disabled={configMutation.isPending}
              >
                <Cloud className="h-3.5 w-3.5 mr-1.5" />MagentaCLOUD verwenden
              </Button>
            </div>
          )}

          {oeffentlichUnverschluesselt && (
            <div className="rounded-xl border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                <p>
                  Diese Adresse ist über das Internet erreichbar, aber nicht verschlüsselt. Aus
                  Sicherheitsgründen kann postbuch.net sich so nicht verbinden. Richte für öffentlich
                  erreichbare Server ein gültiges https-Zertifikat ein – zum Beispiel kostenlos
                  über Let’s Encrypt.
                </p>
              </div>
            </div>
          )}

          {privat && (
            <div className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 space-y-2">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                <p>
                  Diese Adresse ist unverschlüsselt (http statt https). Für einen Nextcloud-Server
                  im eigenen Heimnetz ist das üblich – aber Daten könnten von anderen Geräten im
                  selben Netzwerk mitgelesen werden, wenn das Netzwerk nicht vertrauenswürdig ist.
                </p>
              </div>
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={allowInsecure}
                  onChange={(e) => setAllowInsecure(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  <span className="font-semibold">Unverschlüsselte Verbindung zu diesem Server im lokalen Netzwerk zulassen</span>
                  <br />
                  Nur aktivieren, wenn sich der Server in deinem eigenen Heim- oder Firmennetzwerk
                  befindet. Für Adressen, die aus dem Internet erreichbar sind, immer https verwenden.
                </span>
              </label>
            </div>
          )}
        </div>

        {/* Der Dateiablageordner ist hier bewusst nur Anzeige. Er wird beim Anlegen
            der Ordnerstruktur festgelegt und ist zugleich die Pfadgrenze, gegen
            die jeder Zugriff geprüft wird. Ein zweites Eingabefeld daneben hat
            genau einen Effekt: Es setzt die Grenze auf einen Ordner, in dem
            nichts liegt – und dann scheitert jeder Download. */}
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Ordner im WebDAV-Speicher</label>
          <p className="font-mono text-sm">
            {status?.rootPath
              ? status.rootPath
              : <span className="font-sans text-muted-foreground">noch nicht angelegt</span>}
          </p>
          <p className="text-xs text-muted-foreground">
            postbuch.net arbeitet ausschließlich unterhalb dieses Ordners und rührt nichts an, was
            daneben liegt. Festgelegt wird er beim Anlegen der Ordnerstruktur – im
            Einrichtungsassistenten im Schritt „Ordner“, später unter Einstellungen → Dateiablage.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            onClick={() => configMutation.mutate()}
            disabled={configMutation.isPending || !baseUrl.trim() || oeffentlichUnverschluesselt}
            title={oeffentlichUnverschluesselt ? 'Unverschlüsselte Verbindung zu einem öffentlich erreichbaren Server ist nicht möglich.' : undefined}
          >
            {configMutation.isPending ? 'Speichern…' : 'Adresse speichern'}
          </Button>
          {configMutation.isSuccess && <span className="text-xs text-emerald-600 flex items-center gap-1"><CheckCircle2 className="h-3.5 w-3.5" />Gespeichert</span>}
          {configMutation.isError && <span className="text-xs text-destructive">{configMutation.error?.message}</span>}
        </div>

        {/* ── Anmeldung ──────────────────────────────────────────────────── */}
        {status?.configured && (
          <div className="border-t border-border/60 pt-4 space-y-3">
            {flow.status === 'wartet' ? (
              <div className="space-y-2">
                <p className="text-sm font-medium">Warte auf Bestätigung in Nextcloud …</p>
                <p className="text-xs text-muted-foreground">
                  Öffne den Link, melde dich in Nextcloud an und bestätige den Zugriff.
                  Noch <span className="font-mono">{mmss(flow.verbleibendSek)}</span>.
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  {/* Bewusst ein echtes <a target="_blank"> statt window.open() nach
                      dem Request: ein programmatisches Öffnen nach einem await
                      gilt nicht mehr als Nutzergeste und wird von Popup-Blockern
                      verworfen – der Flow schlüge dann lautlos fehl. */}
                  <a
                    href={flow.confirmUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />Bei Nextcloud anmelden
                  </a>
                  <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => kopiereLink(flow.confirmUrl)}>
                    {kopiert ? <Check className="h-3.5 w-3.5 mr-1 text-emerald-500" /> : <Copy className="h-3.5 w-3.5 mr-1" />}
                    Link kopieren
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => cancelMutation.mutate()}>
                    Abbrechen
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  {!status.connected ? (
                    <>
                      <Button size="sm" onClick={() => flowMutation.mutate()} disabled={flowMutation.isPending}>
                        {flowMutation.isPending ? <Spinner className="h-3.5 w-3.5 mr-1.5" /> : <Link2 className="h-3.5 w-3.5 mr-1.5" />}
                        Schnell verbinden (Nextcloud)
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setManuell(!manuell)}>
                        <KeyRound className="h-3.5 w-3.5 mr-1.5" />
                        Benutzername &amp; App-Passwort
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button size="sm" variant="outline" onClick={() => testMutation.mutate()} disabled={testMutation.isPending}>
                        {testMutation.isPending ? <Spinner className="h-3.5 w-3.5 mr-1.5" /> : <PlayCircle className="h-3.5 w-3.5 mr-1.5" />}
                        Verbindung prüfen
                      </Button>
                      <Button size="sm" variant="destructive" onClick={() => disconnectMutation.mutate()} disabled={disconnectMutation.isPending}>
                        <Unlink2 className="h-3.5 w-3.5 mr-1.5" />Verbindung trennen
                      </Button>
                      <button
                        type="button"
                        onClick={() => setManuell(!manuell)}
                        className="text-xs text-muted-foreground underline hover:text-foreground"
                      >
                        App-Passwort manuell eintragen
                      </button>
                    </>
                  )}
                </div>
                {!status.connected && (
                  <p className="text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">Schnell verbinden</span> gibt es nur bei Nextcloud (Ein-Klick-Login).
                    Für <span className="font-medium text-foreground">ownCloud</span>, <span className="font-medium text-foreground">MagentaCLOUD</span> oder andere WebDAV-Server nimm Benutzername &amp; App-Passwort.
                  </p>
                )}
              </div>
            )}

            {flow.status === 'abgelaufen' && (
              <p className="text-xs text-amber-600">
                Die Bestätigung ist nicht rechtzeitig eingetroffen. Das passiert z. B., wenn der Tab
                geschlossen wurde, bevor die Anmeldung bestätigt war.
              </p>
            )}
            {flow.status === 'fehler' && <p className="text-xs text-destructive">{flow.fehler}</p>}
            {flow.status === 'abgebrochen' && <p className="text-xs text-muted-foreground">Vorgang abgebrochen.</p>}
            {flowMutation.isError && <p className="text-xs text-destructive">{flowMutation.error?.message}</p>}
            {disconnectMutation.isError && <p className="text-xs text-destructive">{disconnectMutation.error?.message}</p>}
            {testErgebnis && (
              <p className={`text-xs flex items-center gap-1 ${testErgebnis.ok ? 'text-emerald-600' : 'text-destructive'}`}>
                {testErgebnis.ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
                {testErgebnis.text}
              </p>
            )}

            {manuell && (
              <div className="rounded-lg border border-border/60 p-3 space-y-2">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Benutzername</label>
                  <Input value={ncUser} onChange={(e) => setNcUser(e.target.value)} className="h-8 text-sm font-mono" />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">App-Passwort</label>
                  <div className="relative">
                    <Input
                      type={zeigePass ? 'text' : 'password'}
                      value={ncPass}
                      onChange={(e) => setNcPass(e.target.value)}
                      className="h-8 text-sm font-mono pr-9"
                      autoComplete="new-password"
                    />
                    <button type="button" onClick={() => setZeigePass(!zeigePass)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                      {zeigePass ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                    </button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Kein normales Passwort – erzeuge ein eigenes App-Passwort für postbuch.net:
                    in Nextcloud/MagentaCLOUD unter <span className="font-medium">Einstellungen → Sicherheit</span>,
                    in ownCloud unter <span className="font-medium">Einstellungen → Sicherheit → App-Passwörter</span>.
                    Trage hier niemals dein reguläres Anmeldepasswort ein.
                  </p>
                </div>
                <Button size="sm" onClick={() => credMutation.mutate()} disabled={credMutation.isPending || !ncUser.trim() || !ncPass}>
                  {credMutation.isPending ? 'Speichern…' : 'App-Passwort speichern'}
                </Button>
                {credMutation.isError && <p className="text-xs text-destructive">{credMutation.error?.message}</p>}
              </div>
            )}
          </div>
        )}

        {/* ── Selbsttest ─────────────────────────────────────────────────── */}
        {status?.connected && (
          <div className="border-t border-border/60 pt-4 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div>
                <p className="text-sm font-medium">Selbsttest</p>
                <p className="text-xs text-muted-foreground">
                  Legt in einem eigenen Testordner Dateien an, prüft Umlaute, Namenskollisionen,
                  Prüfsummen und Pfadsicherheit – und räumt alles wieder ab.
                </p>
              </div>
              {selftest && gesamt > 0 && (
                <Badge variant={selftest.ok ? 'default' : 'secondary'} className="text-xs shrink-0">
                  {selftest.ok ? `Alle ${gesamt} bestanden` : `${gesamt - bestanden} von ${gesamt} fehlgeschlagen`}
                </Badge>
              )}
            </div>
            <Button size="sm" variant="outline" onClick={() => selftestMutation.mutate()} disabled={selftestMutation.isPending}>
              {selftestMutation.isPending ? <><Spinner className="h-3.5 w-3.5 mr-1.5" />Läuft…</> : <><PlayCircle className="h-3.5 w-3.5 mr-1.5" />Selbsttest starten</>}
            </Button>
            {selftest?.fehler && <p className="text-xs text-destructive">{selftest.fehler}</p>}
            {gesamt > 0 && (
              <div className="rounded-lg border border-border/60 divide-y divide-border/40">
                {selftest.schritte.map((s, i) => (
                  <div key={i} className="px-3 py-1.5">
                    <div className="flex items-center gap-2">
                      {s.ok
                        ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 flex-shrink-0" />
                        : s.sicherheitsrelevant
                          ? <ShieldAlert className="h-3.5 w-3.5 text-red-600 flex-shrink-0" />
                          : <XCircle className="h-3.5 w-3.5 text-amber-500 flex-shrink-0" />}
                      <span className="text-xs flex-1">{s.name}</span>
                      <span className="text-[10px] text-muted-foreground/60 font-mono">{s.dauerMs} ms</span>
                    </div>
                    {!s.ok && (
                      <p className="text-xs text-destructive pl-5.5 mt-0.5">
                        {s.sicherheitsrelevant && <span className="font-semibold">Sicherheitsrelevant: </span>}
                        {typeof s.detail === 'string' ? s.detail : JSON.stringify(s.detail)}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
