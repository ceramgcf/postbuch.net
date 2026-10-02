/**
 * OneDriveSection – Einrichtung und Verbindung der OneDrive-Dateiablage.
 *
 * Aus SettingsPage.jsx herausgelöst, damit der Einrichtungsassistent denselben
 * Abschnitt inline rendern kann, statt den Nutzer aus dem Assistenten heraus in
 * die Einstellungen zu schicken. Bewusst nur die Verbindung: Polling,
 * Ordnerstruktur, Disaster-Recovery und Migration bleiben im Dateiablage-Tab bzw.
 * im Migrationsassistenten (AblageUmzugPage).
 */
import { useState, useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle, AlertTriangle, CheckCircle, Cloud, CloudOff, Copy, ExternalLink,
  Eye, EyeOff, Key, Link2, RefreshCw, Smartphone, Unlink2, XCircle,
} from 'lucide-react';
import { api } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import OneDriveVollzugriffWarnung from '@/components/OneDriveVollzugriffWarnung';
import { SetupGuideCard, SetupStepList } from '@/components/settings/SetupGuide';
import { schlankeHilfeUrl } from '@/lib/docs';

function OneDriveConnectionCard({ mode = 'device' }) {
  const qc = useQueryClient();
  const { data: status, isLoading, refetch } = useQuery({ queryKey: ['onedrive-status'], queryFn: () => api.onedrive.status(), retry: false });
  // Fehler aus dem Microsoft-Popup (Legacy-Redirect-Flow). Der Status allein
  // zeigt danach nur „nicht verbunden“ – ohne diese Meldung bliebe offen, was
  // schiefging (z. B. abgelaufenes oder falsches Client-Secret).
  const [oauthFehler, setOauthFehler] = useState(null);
  const connectMutation = useMutation({
    mutationFn: async () => {
      setOauthFehler(null);
      const returnTo = window.location.pathname.startsWith('/einrichtung/')
        ? '/einrichtung/ablage' : undefined;
      // Muss direkt im Klick-Stack geöffnet werden, sonst blockieren Browser
      // das Fenster nach dem asynchronen API-Aufruf als Popup.
      const popup = window.open('', 'postbuch-onedrive-oauth', 'popup=yes,width=620,height=760');
      try {
        const { authUrl } = await api.onedrive.authorize(returnTo);
        if (popup) popup.location.href = authUrl;
        else window.location.href = authUrl;
        return popup;
      } catch (err) {
        popup?.close();
        throw err;
      }
    },
  });
  const disconnectMutation = useMutation({ mutationFn: () => api.onedrive.disconnect(), onSuccess: () => { qc.invalidateQueries({ queryKey: ['onedrive-status'] }); } });
  useEffect(() => {
    function onMessage(event) {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type !== 'postbuch-onedrive-oauth') return;
      if (event.data.ok) {
        setOauthFehler(null);
      } else {
        const textOder = (v, d) => (typeof v === 'string' && v ? v.slice(0, 800) : d);
        setOauthFehler({
          titel: textOder(event.data.titel, 'OneDrive-Verbindung fehlgeschlagen'),
          text: textOder(event.data.text, 'Der Microsoft-Login konnte nicht abgeschlossen werden. Es wurde keine Verbindung gespeichert.'),
        });
      }
      refetch();
      qc.invalidateQueries({ queryKey: ['settings'] });
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [qc, refetch]);
  // Der Einrichtungsassistent beantwortet „Dateiablage verbunden?" nicht aus dieser
  // Karte, sondern aus GET /api/einrichtung. Ohne diese Invalidierung stand dort
  // oben weiter „OneDrive ist noch nicht verbunden", während hier unten bereits
  // „Verbunden als …" zu lesen war. Gilt für alle Wege gleichermaßen:
  // Gerätecode, Redirect-OAuth und Trennen.
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
  }, [status?.connected, qc]);
  // Im Device-Modus übernimmt OneDriveDeviceCard das Verbinden; hier dann nur Status/Trennen.
  const zeigeRedirectConnect = mode === 'legacy';
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          {status?.connected ? <Cloud className="h-5 w-5 text-emerald-500" /> : <CloudOff className="h-5 w-5 text-muted-foreground" />}
          <CardTitle className="text-base">OneDrive-Verbindung</CardTitle>
          {status?.connected && <Badge variant={status.tokenValid ? 'default' : 'destructive'} className="ml-auto text-xs">{status.tokenValid ? 'Token OK' : 'Token ungültig'}</Badge>}
        </div>
        {status?.connected && status.account && <CardDescription className="text-xs pt-1">Verbunden als <span className="font-medium text-foreground">{status.account}</span></CardDescription>}
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner className="h-4 w-4" />Verbindungsstatus wird geprüft…</div>}
        {!isLoading && !status?.connected && <p className="text-sm text-muted-foreground">Kein Microsoft-Konto verbunden.</p>}
        {!isLoading && !status?.connected && zeigeRedirectConnect && (
          <p className="text-xs text-amber-700 dark:text-amber-500">
            Mit dem Verbinden erteilst du postbuch.net Vollzugriff auf <span className="font-semibold">alle</span> Ordner dieses OneDrive – siehe Hinweis oben.
          </p>
        )}
        {!isLoading && status?.connected && !status?.tokenValid && (
          <div className="flex items-start gap-2 text-sm text-amber-600 dark:text-amber-500">
            <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
            <span>{status.authProblem === 'client_secret_abgelaufen'
              ? 'Das Client-Secret ist abgelaufen. Erzeuge in Azure ein neues Secret, trage es hier ein und verbinde OneDrive danach neu.'
              : status.authProblem === 'app_konfiguration_ungueltig'
                ? 'Microsoft erkennt die eingetragene App-Registrierung nicht. Prüfe Client-ID und Mandant, speichere sie und verbinde OneDrive danach neu.'
                : 'Die Microsoft-Anmeldung ist abgelaufen. Bitte Verbindung neu herstellen.'}</span>
          </div>
        )}
        {status?.secretDaysRemaining != null && status.secretDaysRemaining <= 60 && status.tokenValid && (
          <div className="flex items-start gap-2 text-sm text-amber-600 dark:text-amber-500">
            <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
            <span>Das Client-Secret läuft {status.secretDaysRemaining < 0 ? 'bereits abgelaufen' : `in ${status.secretDaysRemaining} Tagen ab`}. Erzeuge rechtzeitig ein neues Secret in Azure.</span>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          {!status?.connected ? (
            zeigeRedirectConnect && (
              <Button size="sm" onClick={() => connectMutation.mutate()} disabled={connectMutation.isPending}>
                {connectMutation.isPending ? <Spinner className="h-3.5 w-3.5 mr-1.5" /> : <Link2 className="h-3.5 w-3.5 mr-1.5" />}Mit Microsoft verbinden
              </Button>
            )
          ) : (
            <>
              <Button size="sm" variant="outline" onClick={() => refetch()} disabled={isLoading}><RefreshCw className="h-3.5 w-3.5 mr-1.5" />Status prüfen</Button>
              <Button size="sm" variant="destructive" onClick={() => disconnectMutation.mutate()} disabled={disconnectMutation.isPending}>
                {disconnectMutation.isPending ? <Spinner className="h-3.5 w-3.5 mr-1.5" /> : <Unlink2 className="h-3.5 w-3.5 mr-1.5" />}Verbindung trennen
              </Button>
            </>
          )}
        </div>
        {oauthFehler && !status?.connected && (
          <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
            <XCircle className="h-4 w-4 flex-shrink-0 mt-0.5 text-destructive" />
            <div className="space-y-1">
              <p className="font-medium text-destructive">{oauthFehler.titel}</p>
              <p className="text-muted-foreground">{oauthFehler.text}</p>
            </div>
          </div>
        )}
        {connectMutation.isError    && <p className="text-xs text-destructive">{connectMutation.error?.message}</p>}
        {disconnectMutation.isError && <p className="text-xs text-destructive">{disconnectMutation.error?.message}</p>}
      </CardContent>
    </Card>
  );
}

/**
 * Verbindung über den Device-Code-Flow (mit EIGENER Public-Client-App).
 * Setzt eine gespeicherte Client-ID voraus (kein Secret nötig). Kein Redirect,
 * kein Formular: Button → Code anzeigen → Nutzer bestätigt bei Microsoft →
 * Polling bis success. Der verbundene Zustand wird von OneDriveConnectionCard
 * gezeigt; diese Karte tritt dann zurück.
 */
function OneDriveDeviceCard({ clientIdVorhanden }) {
  const qc = useQueryClient();
  const { data: status, isLoading: statusLoading } = useQuery({ queryKey: ['onedrive-status'], queryFn: () => api.onedrive.status(), retry: false });
  const [flow, setFlow] = useState(null);   // { flowId, userCode, verificationUri, expiresIn }
  const [error, setError] = useState(null);
  const [codeCopied, setCodeCopied] = useState(false);
  const [restSekunden, setRestSekunden] = useState(null);

  const startMutation = useMutation({
    mutationFn: () => api.onedrive.deviceStart(),
    onMutate: () => { setError(null); setFlow(null); },
    onSuccess: (data) => setFlow({
      ...data,
      expiresAt: Date.now() + Math.max(1, Number(data.expiresIn) || 900) * 1000,
    }),
    onError: (e) => setError(
      `${e?.message || 'Verbindung konnte nicht gestartet werden.'} `
      + 'Prüfe in Azure besonders „Öffentliche Clientflows zulassen“ = Ja.',
    ),
  });

  useEffect(() => {
    if (!flow?.expiresAt) { setRestSekunden(null); return undefined; }
    const tick = () => setRestSekunden(Math.max(0, Math.ceil((flow.expiresAt - Date.now()) / 1000)));
    tick();
    const iv = setInterval(tick, 1000);
    return () => clearInterval(iv);
  }, [flow?.expiresAt]);

  // Solange ein Flow läuft: alle 2,5 s den Status pollen. Endet der Flow in
  // der Oberfläche (Abbrechen, Seite verlassen), wird er auch serverseitig
  // verworfen – sonst verbände eine spätere Freigabe OneDrive trotz Abbruch.
  // Nach einem Endzustand ist der Aufruf folgenlos.
  useEffect(() => {
    if (!flow?.flowId) return undefined;
    const flowId = flow.flowId;
    let abgebrochen = false;
    const iv = setInterval(async () => {
      try {
        const s = await api.onedrive.deviceStatus(flowId);
        if (abgebrochen) return;
        if (s.status === 'success') {
          setFlow(null);
          qc.invalidateQueries({ queryKey: ['onedrive-status'] });
          qc.invalidateQueries({ queryKey: ['settings'] });
        } else if (s.status === 'error' || s.status === 'expired' || s.status === 'unknown') {
          setFlow(null);
          setError(
            s.error
            || (s.status === 'expired' ? 'Der Code ist abgelaufen. Bitte erneut verbinden.'
              : 'Verbindung fehlgeschlagen. Bitte erneut versuchen.')
          );
        }
      } catch { /* Netzfehler: einfach weiter pollen */ }
    }, 2500);
    return () => {
      abgebrochen = true;
      clearInterval(iv);
      api.onedrive.deviceCancel(flowId).catch(() => {});
    };
  }, [flow?.flowId, qc]);

  function copyCode() {
    if (!flow?.userCode) return;
    navigator.clipboard.writeText(flow.userCode).then(() => {
      setCodeCopied(true);
      setTimeout(() => setCodeCopied(false), 2000);
    });
  }

  // Verbunden → diese Karte tritt zurück, OneDriveConnectionCard zeigt den Status.
  if (statusLoading || status?.connected) return null;

  const verifyUri = flow?.verificationUri || 'https://microsoft.com/devicelogin';

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <Smartphone className="h-5 w-5 text-primary" />
          <CardTitle className="text-base">OneDrive per Gerätecode verbinden</CardTitle>
        </div>
        <CardDescription className="text-xs pt-1">
          Verbindet dein Microsoft-Konto ohne Client Secret und ohne Redirect-URI – es genügt die oben gespeicherte Client-ID deiner eigenen App.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!clientIdVorhanden ? (
          <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <span>Trage zuerst oben die Client-ID deiner Azure-App ein und speichere sie, dann kannst du hier verbinden.</span>
          </div>
        ) : !flow ? (
          <>
            <Button size="sm" onClick={() => startMutation.mutate()} disabled={startMutation.isPending}>
              {startMutation.isPending ? <Spinner className="h-3.5 w-3.5 mr-1.5" /> : <Link2 className="h-3.5 w-3.5 mr-1.5" />}
              Mit Microsoft verbinden
            </Button>
            <p className="text-xs text-amber-700 dark:text-amber-500">
              Mit dem Bestätigen erteilst du postbuch.net Vollzugriff auf <span className="font-semibold">alle</span> Ordner dieses OneDrive – siehe Hinweis oben.
            </p>
            <p className="text-xs text-muted-foreground">
              Beim Bestätigen kann Microsoft einen Hinweis auf einen „nicht verifizierten Herausgeber" zeigen – bei einer eigenen, privaten App-Registrierung ist das normal und kein Fehler.
            </p>
            {error && <p className="text-xs text-destructive">{error}</p>}
          </>
        ) : (
          <div className="space-y-4">
            <div className="rounded-2xl border border-primary/30 bg-primary/5 p-4 space-y-3">
              <p className="text-sm">
                <span className="font-semibold">1.</span> Öffne{' '}
                <a href={verifyUri} target="_blank" rel="noopener noreferrer" className="font-semibold text-primary underline inline-flex items-center gap-1">
                  {verifyUri.replace(/^https?:\/\//, '')}
                  <ExternalLink className="h-3 w-3" />
                </a>
              </p>
              <div className="space-y-1">
                <p className="text-sm"><span className="font-semibold">2.</span> Gib diesen Code ein:</p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 text-2xl font-mono font-bold tracking-widest bg-background px-3 py-2 rounded-lg border border-border text-center select-all">
                    {flow.userCode || '…'}
                  </code>
                  <button
                    type="button"
                    onClick={copyCode}
                    title="Code kopieren"
                    className="shrink-0 flex items-center justify-center h-10 w-10 rounded-lg border border-border bg-background hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
                  >
                    {codeCopied ? <CheckCircle className="h-4 w-4 text-emerald-500" /> : <Copy className="h-4 w-4" />}
                  </button>
                </div>
              </div>
              <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                <span>Gib diesen Code nur ein, wenn du gerade selbst hier auf „Mit Microsoft verbinden" geklickt hast.</span>
              </div>
            </div>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner className="h-4 w-4" />
              Warte auf Bestätigung bei Microsoft…
            </div>
            {restSekunden != null && (
              <p className="text-xs text-muted-foreground tabular-nums">
                Code noch {Math.floor(restSekunden / 60)}:{String(restSekunden % 60).padStart(2, '0')} Minuten gültig.
              </p>
            )}
            <button
              type="button"
              onClick={() => { setFlow(null); setError(null); }}
              className="text-xs text-muted-foreground hover:text-foreground underline"
            >
              Abbrechen
            </button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function RedirectUriDisplay({ appHost }) {
  let redirectUrl;
  try {
    redirectUrl = new URL('/api/onedrive-auth/callback', String(appHost || window.location.origin).trim());
  } catch {
    redirectUrl = new URL('/api/onedrive-auth/callback', window.location.origin);
  }
  const redirectUri = redirectUrl.toString();
  const isHttps = redirectUrl.protocol === 'https:';
  const isLocalhost = ['localhost', '127.0.0.1'].includes(redirectUrl.hostname);
  const currentOriginDiffers = redirectUrl.origin !== window.location.origin;
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(redirectUri).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Azure Redirect URI (einzutragen im Azure Portal)</label>
      <div className="flex items-center gap-2">
        <code className="flex-1 text-xs bg-muted px-2.5 py-2 rounded border border-border font-mono break-all select-all">{redirectUri}</code>
        <button
          type="button"
          onClick={copy}
          title="In Zwischenablage kopieren"
          className="shrink-0 flex items-center justify-center h-8 w-8 rounded border border-border bg-background hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
        >
          {copied
            ? <CheckCircle className="h-3.5 w-3.5 text-emerald-500" />
            : <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
          }
        </button>
      </div>
      <p className="text-xs text-muted-foreground">
        Diese aus der konfigurierten App-URL gebildete Adresse im Azure Portal unter App Registrations → Authentication → Redirect URIs eintragen. Sie wird beim Verbinden oder erneuten Verbinden des Microsoft-Kontos benötigt.
      </p>
      {currentOriginDiffers && (
        <p className="text-xs text-amber-700">
          Du hast postbuch.net gerade über {window.location.origin} geöffnet; der Server verwendet für den Callback aber die oben angezeigte konfigurierte App-URL.
        </p>
      )}
      {isLocalhost && !isHttps && (
        <div className="rounded-xl border border-sky-300 bg-sky-50 px-3 py-2 text-xs text-sky-900 shadow-sm">
          <p className="font-semibold">Headless-Server: localhost per SSH weiterleiten</p>
          <p className="mt-1">Starte auf dem Browser-Rechner <code className="font-mono">ssh -N -L 3420:127.0.0.1:3420 &lt;benutzer&gt;@&lt;server&gt;</code>, öffne dort <code className="font-mono">http://localhost:3420</code> und lasse den Tunnel bis zum Abschluss der Verbindung offen.</p>
        </div>
      )}
      {!isHttps && !isLocalhost && (
        <div className="rounded-xl border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800 shadow-sm">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <div className="space-y-1">
              <p className="font-semibold">Diese HTTP-Redirect-URI ist bei Microsoft nicht zulässig</p>
              <p>Microsoft erlaubt unverschlüsselte HTTP-Callbacks nur für <code className="font-mono">localhost</code>. Verwende eine HTTPS-App-URL, wechsle für die Verbindung zu <code className="font-mono">http://localhost:3420</code> mit SSH-Tunnel oder nutze den Gerätecode.</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
function OneDriveCredentialsCard({ onSaved, appHost }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['onedrive-credentials'],
    queryFn: () => api.onedrive.getCredentials(),
    retry: false,
  });

  const [clientId, setClientId] = useState('');
  const [tenantId, setTenantId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [clientSecretExpiresAt, setClientSecretExpiresAt] = useState('');
  const [showSecret, setShowSecret] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!data) return;
    setClientId(data.clientId || '');
    setTenantId(data.tenantId || '');
    setClientSecret('');
    setClientSecretExpiresAt(data.clientSecretExpiresAt ? String(data.clientSecretExpiresAt).slice(0, 10) : '');
  }, [data]);

  const saveMutation = useMutation({
    mutationFn: () => {
      const payload = {
        clientId: clientId.trim(),
        tenantId: tenantId.trim(),
      };
      if (clientSecret.trim()) payload.clientSecret = clientSecret.trim();
      payload.clientSecretExpiresAt = clientSecretExpiresAt || null;
      return api.onedrive.saveCredentials(payload);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['settings'] });
      qc.invalidateQueries({ queryKey: ['onedrive-status'] });
      qc.invalidateQueries({ queryKey: ['onedrive-credentials'] });
      setClientSecret('');
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
      onSaved?.();
    },
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <Key className="h-5 w-5 text-primary" />
          <CardTitle className="text-base">OneDrive App-Credentials</CardTitle>
          {data?.hasClientSecret
            ? <Badge variant="default" className="ml-auto text-xs">Secret hinterlegt</Badge>
            : <Badge variant="secondary" className="ml-auto text-xs">Secret fehlt</Badge>}
        </div>
        <CardDescription className="text-xs pt-1">
          Azure App Registration Daten. Tenant ist optional; für Privatkonten kann Feld leer bleiben oder auf "consumers" gesetzt werden.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner className="h-4 w-4" />Lade…</div>
        ) : (
          <>
            <SetupGuideCard
              icon={Cloud}
              title="Azure-Einrichtung Schritt für Schritt"
              defaultOpen={false}
              subtitle="Diese Anleitung ist auf den empfohlenen postbuch.net-Flow zugeschnitten. Trage die Werte exakt so ein, dann lässt sich die OneDrive-Verbindung später ohne Nacharbeit herstellen."
              tone="sky"
            >
              <SetupStepList
                steps={[
                  <>In <a className="font-semibold underline" href="https://portal.azure.com" target="_blank" rel="noopener noreferrer">portal.azure.com</a> mit deinem Microsoft-Konto anmelden und bei Bedarf die kostenlose Azure-Testversion aktivieren.</>,
                  <>Im Suchfeld nach <a className="font-semibold underline" href="https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade" target="_blank" rel="noopener noreferrer">App-Registrierungen</a> suchen und <span className="font-semibold">Neue Registrierung</span> öffnen.</>,
                  <>Name <span className="font-mono">postbuch</span> vergeben, bei den unterstützten Kontotypen <span className="font-semibold">Alle Konten von Entra ID-Mandanten und persönliche Microsoft-Konten</span> wählen.</>,
                  <>Unter <span className="font-semibold">Umleitungs-URI</span> die Plattform <span className="font-semibold">Web</span> und exakt die unten angezeigte Redirect-URI eintragen.</>,
                  <>Nach dem Registrieren auf der Übersichtsseite die <span className="font-semibold">Anwendungs-ID</span> notieren. Genau dieser Wert gehört hier in das Feld <span className="font-mono">Client ID</span>.</>,
                  <>Unter <span className="font-semibold">Clientanmeldeinformationen</span> einen neuen geheimen Clientschlüssel anlegen, Beschreibung <span className="font-mono">postbuch_app</span> wählen und danach sofort den angezeigten <span className="font-semibold">Wert</span> kopieren. Die <span className="font-semibold">Geheime ID</span> ist nicht der richtige Wert.</>,
                  <>Unter <span className="font-semibold">API-Berechtigungen</span> Microsoft Graph → <span className="font-semibold">Delegierte Berechtigungen</span> öffnen und <span className="font-mono">Files.ReadWrite.All</span>, <span className="font-mono">User.Read</span> sowie <span className="font-mono">offline_access</span> hinzufügen. <span className="font-semibold">Achtung:</span> <span className="font-mono">Files.ReadWrite.All</span> ist Vollzugriff auf <span className="font-semibold">alle</span> Ordner dieses OneDrive – siehe Warnung oben. Eine engere Berechtigung gibt es nicht, ohne die Dateien in einen abgeschotteten App-Ordner zu sperren.</>,
                ]}
              />
            </SetupGuideCard>
            <RedirectUriDisplay appHost={appHost} />
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Client ID</label>
              <Input value={clientId} onChange={(e) => setClientId(e.target.value)} className="h-9 text-sm font-mono" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Ablaufdatum des Client-Secrets (optional)</label>
              <Input type="date" value={clientSecretExpiresAt} onChange={(e) => setClientSecretExpiresAt(e.target.value)} className="h-9 text-sm max-w-xs" />
              <p className="text-xs text-muted-foreground">Azure zeigt das Datum beim Erzeugen. postbuch.net kann es ohne zusätzliche Verzeichnisrechte nicht selbst auslesen und erinnert 60 Tage vorher.</p>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Tenant (optional)</label>
              <Input value={tenantId} onChange={(e) => setTenantId(e.target.value)} className="h-9 text-sm font-mono" placeholder="consumers | organizations | common" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Client Secret (optional, nur bei Änderung)</label>
              <div className="relative">
                <Input
                  type={showSecret ? 'text' : 'password'}
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                  className="h-9 text-sm font-mono pr-9"
                  placeholder={data?.hasClientSecret ? '••••••••••••••••' : 'Client Secret eingeben…'}
                  autoComplete="new-password"
                />
                <button type="button" onClick={() => setShowSecret(!showSecret)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                  {showSecret ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </button>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <Button size="sm" onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending || !clientId.trim()}>
                {saveMutation.isPending ? 'Speichern…' : 'Credentials speichern'}
              </Button>
              {saved && <span className="text-xs text-emerald-600 flex items-center gap-1"><CheckCircle className="h-3.5 w-3.5" />Gespeichert</span>}
            </div>
            {saveMutation.isError && <p className="text-xs text-destructive">{saveMutation.error?.message}</p>}
          </>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Client-ID-Eingabe für den Device-Modus (eigene Public-Client-App).
 * Bewusst schlanker als OneDriveCredentialsCard: kein Secret, keine Redirect-URI.
 * Speichert über denselben credentials-Endpunkt (nur Client-ID + Tenant).
 */
function OneDriveDeviceClientIdCard({ onSaved }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['onedrive-credentials'],
    queryFn: () => api.onedrive.getCredentials(),
    retry: false,
  });

  const [clientId, setClientId] = useState('');
  const [tenantId, setTenantId] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!data) return;
    setClientId(data.clientId || '');
    setTenantId(data.tenantId || '');
  }, [data]);

  const saveMutation = useMutation({
    mutationFn: () => api.onedrive.saveCredentials({ clientId: clientId.trim(), tenantId: tenantId.trim() }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['settings'] });
      qc.invalidateQueries({ queryKey: ['onedrive-status'] });
      qc.invalidateQueries({ queryKey: ['onedrive-credentials'] });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
      onSaved?.();
    },
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <Key className="h-5 w-5 text-primary" />
          <CardTitle className="text-base">Eigene Client-ID (Gerätecode)</CardTitle>
          {data?.clientId
            ? <Badge variant="default" className="ml-auto text-xs">Client-ID gesetzt</Badge>
            : <Badge variant="secondary" className="ml-auto text-xs">fehlt</Badge>}
        </div>
        <CardDescription className="text-xs pt-1">
          Du brauchst eine eigene Azure-App-Registrierung – aber nur die Client-ID, kein Secret und keine Redirect-URI.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner className="h-4 w-4" />Lade…</div>
        ) : (
          <>
            <SetupGuideCard
              icon={Smartphone}
              title="Azure-App für den Gerätecode einrichten"
              defaultOpen={false}
              subtitle="Einmalig für diese Instanz. Die Client-ID muss vom Benutzer bereitgestellt werden. Dafür muss eine App in Azure registriert werden. Diese Anleitung zeigt die Schritte."
              tone="sky"
            >
              <SetupStepList
                steps={[
                  <>Im Microsoft Azure Portal, <a className="font-semibold underline" href="https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade" target="_blank" rel="noopener noreferrer">App-Registrierungen</a> auf <span className="font-semibold">Neue Registrierung</span>.</>,
                  <>Name z. B. <span className="font-mono">postbuch</span>. Für ein privates OneDrive den Kontotyp <span className="font-semibold">Persönliche Microsoft-Konten</span> wählen und unten <span className="font-mono">consumers</span> verwenden. Für Privat- und Organisationskonten gemeinsam den weitesten Kontotyp wählen und unten <span className="font-mono">common</span> eintragen. Umleitungs-URI <span className="font-semibold">leer lassen</span>.</>,
                  <>Unter <span className="font-semibold">Authentifizierung</span> → <span className="font-semibold">Öffentliche Clientflows zulassen</span> auf <span className="font-semibold">Ja</span> stellen und speichern.</>,
                  <>Unter <span className="font-semibold">API-Berechtigungen</span> (Microsoft Graph, delegiert) <span className="font-mono">Files.ReadWrite.All</span>, <span className="font-mono">User.Read</span> und <span className="font-mono">offline_access</span> hinzufügen. <span className="font-semibold">Achtung:</span> <span className="font-mono">Files.ReadWrite.All</span> ist Vollzugriff auf <span className="font-semibold">alle</span> Ordner des OneDrive, das sich damit anmeldet – siehe Warnung oben.</>,
                  <>Auf der Übersichtsseite die <span className="font-semibold">Anwendungs-ID (Client)</span> kopieren und unten eintragen. Kein Secret nötig.</>,
                ]}
              />
              <p className="text-xs"><a href={schlankeHilfeUrl('onedrive-app-registrierung')} target="_blank" rel="noopener" className="font-semibold underline">Vollständige Anleitung in der Hilfe öffnen</a></p>
            </SetupGuideCard>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Client ID</label>
              <Input value={clientId} onChange={(e) => setClientId(e.target.value)} className="h-9 text-sm font-mono" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Tenant (optional)</label>
              <Input value={tenantId} onChange={(e) => setTenantId(e.target.value)} className="h-9 text-sm font-mono" placeholder="consumers | organizations | common" />
              <p className="text-xs text-muted-foreground"><span className="font-mono">consumers</span> für Privatkonten, <span className="font-mono">common</span> für die kombinierte Kontoauswahl.</p>
            </div>
            <div className="flex items-center gap-3">
              <Button size="sm" onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending || !clientId.trim()}>
                {saveMutation.isPending ? 'Speichern…' : 'Client-ID speichern'}
              </Button>
              {saved && <span className="text-xs text-emerald-600 flex items-center gap-1"><CheckCircle className="h-3.5 w-3.5" />Gespeichert</span>}
            </div>
            {saveMutation.isError && <p className="text-xs text-destructive">{saveMutation.error?.message}</p>}
          </>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * OneDrive-Abschnitt im Dateiablage-Tab – Auswahl zwischen zwei Verbindungswegen,
 * beide mit der EIGENEN Azure-App des Nutzers (keine mitgelieferte Client-ID).
 *
 * legacy: eigene App mit Client-ID + Secret + Redirect-URI, Browser-
 *   Redirect-OAuth.
 * device (Standard für neue Instanzen): eigene App, nur Client-ID, Gerätecode.
 */
export default function OneDriveSection({ settings, onSaved }) {
  const qc = useQueryClient();
  // Kein Feld ohne Token-Cache ist eine Neuinstanz und damit Gerätecode. Alte
  // Verbindungen werden serverseitig beim Seed ausdrücklich auf legacy gesetzt.
  const mode = settings?.onedrive_auth_mode?.value === 'legacy' ? 'legacy' : 'device';
  const clientIdVorhanden = !!settings?.onedrive_client_id?.value;

  const modeMutation = useMutation({
    mutationFn: (m) => api.onedrive.setAuthMode(m),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['settings'] });
      qc.invalidateQueries({ queryKey: ['onedrive-status'] });
    },
  });

  const Selector = (
    <div className="inline-flex rounded-lg border border-border p-0.5 bg-muted/40">
      {[
        { id: 'device', label: 'Gerätecode (empfohlen)', icon: Smartphone },
        { id: 'legacy', label: 'App mit Secret', icon: Key },
      ].map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          type="button"
          onClick={() => { if (id !== mode) modeMutation.mutate(id); }}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md transition-colors ${mode === id ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
        >
          <Icon className="h-3.5 w-3.5" />{label}
        </button>
      ))}
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
          <Cloud className="h-5 w-5 text-primary" />
        </span>
        <h3 className="text-base font-semibold">OneDrive einrichten</h3>
      </div>

      <OneDriveVollzugriffWarnung />

      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">OneDrive-Verbindungsweg</p>
        {Selector}
        <p className="text-xs text-muted-foreground">
          {mode === 'legacy'
            ? 'Eigene Azure-App mit Client-ID, Secret und Redirect-URI. Das Secret läuft ab und muss rechtzeitig erneuert werden.'
            : 'Empfohlen: eigene Azure-App, nur Client-ID nötig – kein Secret, keine Redirect-URI. Ein Wechsel erfordert bewusstes Trennen und Neuverbinden.'}
        </p>
        {mode === 'legacy' && (
          <p className="rounded-md border border-amber-300/60 bg-amber-50/60 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950/20 dark:text-amber-200">
            Du möchtest künftig ohne ablaufendes Secret arbeiten? Trenne zuerst die bestehende Verbindung,
            wähle danach „Gerätecode“ und verbinde dasselbe Microsoft-Konto neu. Dokumente werden dabei nicht verschoben.
          </p>
        )}
        {modeMutation.isError && <p className="text-xs text-destructive">{modeMutation.error?.message}</p>}
      </div>

      {mode === 'legacy' ? (
        <>
          <OneDriveCredentialsCard onSaved={onSaved} appHost={settings?.app_host?.value} />
          <OneDriveConnectionCard mode="legacy" />
        </>
      ) : (
        <>
          <OneDriveDeviceClientIdCard onSaved={onSaved} />
          <OneDriveDeviceCard clientIdVorhanden={clientIdVorhanden} />
          <OneDriveConnectionCard mode="device" />
        </>
      )}
    </div>
  );
}

// `backend` dient hier nur der Beschriftung: setupFolderStructure() läuft
// serverseitig ohnehin immer gegen das aktive Dateiablage-Backend. Vorher stand hier
// hart „in OneDrive" – auf einer Nextcloud-Instanz eine glatte Falschaussage.
