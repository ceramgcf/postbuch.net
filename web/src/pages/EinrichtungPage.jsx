/**
 * EinrichtungPage – der Einrichtungsassistent.
 *
 * Zwei Grundsätze, die hier teuer erkauft sind:
 *
 * 1. **Der Assistent wird nicht verlassen.** Dateiablage und KI werden inline mit
 *    denselben Karten gerendert wie in den Einstellungen (OneDriveSection,
 *    ProviderCard, EmbeddingCard). Wer in Schritt 4 klickt, landet nicht in
 *    einem anderen Bereich ohne Rückweg.
 * 2. **Es wird nichts geraten.** Jedes vorbelegte Feld stammt aus dem
 *    Ist-Zustand der Instanz. Ein hart einkodierter Vorgabewert hat einer
 *    Testinstanz schon den Wurzelordner der Produktivinstanz angeboten –
 *    mitsamt Umzug des gesamten Bestands dorthin. Ist ein Wert unbekannt,
 *    bleibt das Feld leer und sagt das auch.
 */
import { useEffect, useRef, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, ArrowLeft, ArrowRight, BellRing, BookOpen, Bot, Check, CheckCircle2, Circle,
  Cloud, Eye, EyeOff, FolderOpen, Globe, KeyRound, Lock, Network, Pencil, RefreshCw,
  ScanLine, Server, ShieldCheck, Sparkles, Users, Wand2, X,
} from 'lucide-react';
import { api } from '@/api/client';
import { pushApi } from '@/api/push';
import { einrichtungsGateFreigeben } from '@/lib/einrichtung-gate';
import { schlankeHilfeUrl } from '@/lib/docs';
import { usePushSubscription } from '@/hooks/usePushSubscription';
import { Logo } from '@/components/ui/Logo';
import { Testergebnis } from '@/components/ui/testergebnis';
import { JobFortschritt } from '@/components/ui/job-fortschritt';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import ScannerDiscoveryCard from '@/components/settings/ScannerDiscoveryCard';
import MenschenCard from '@/components/settings/MenschenCard';
import OneDriveSection from '@/components/settings/OneDriveSection';
import NextcloudCard from '@/components/settings/NextcloudCard';
import ProviderCard from '@/components/settings/ProviderCard';
import EmbeddingCard from '@/components/settings/EmbeddingCard';
import EmpfehlungenCard from '@/components/settings/EmpfehlungenCard';
import ModelSelector from '@/components/settings/ModelSelector';
import { MODEL_CLASSES } from '@/components/settings/modelClasses';

/**
 * `pruefungen` verknüpft den Schritt mit den serverseitigen Istprüfungen aus
 * GET /api/einrichtung. Daraus entsteht die Markierung in der Schrittleiste –
 * es gibt keinen zweiten, im Frontend gepflegten Fortschrittsbegriff.
 */
const SCHRITTE = [
  { id: 'willkommen',  label: 'Willkommen', icon: Sparkles,    titel: 'Willkommen bei postbuch.net', unter: 'Was dieser Assistent macht – und was nicht.', pruefungen: [] },
  { id: 'betrieb',     label: 'Instanz',    icon: Network,     titel: 'Instanz und Netzwerk',        unter: 'Name, Adresse und die Einstellungen, die auf dem Host wirken.', pruefungen: ['betrieb', 'hostAgent'] },
  { id: 'menschen',    label: 'Personen',   icon: Users,       titel: 'Personen und Zugänge',        unter: 'Wer taucht in Dokumenten auf, wer darf sich anmelden.', pruefungen: ['menschen'] },
  { id: 'ablage',      label: 'Dateiablage',     icon: Cloud,       titel: 'Dateiablage verbinden',            unter: 'Wo die Originaldateien liegen.', pruefungen: ['ablage'] },
  { id: 'ordner',      label: 'Ordner',     icon: FolderOpen,  titel: 'Ordnerstruktur',              unter: 'Wurzelordner festlegen, Ordnerstruktur anlegen und die Dateiablage optional durchtesten.', pruefungen: ['ordner', 'ablageSelbsttest'] },
  { id: 'ki',          label: 'KI',         icon: Bot,         titel: 'KI und Embeddings',           unter: 'Provider verbinden und das Embedding-Modell wählen.', pruefungen: ['kiLlm', 'kiEmbedding'] },
  { id: 'scanner',     label: 'Scanner',    icon: ScanLine,    titel: 'Scanner einrichten',          unter: 'Optional – für Papier, das direkt ins Postbuch soll.', pruefungen: ['scanner'] },
  { id: 'benachrichtigungen', label: 'Benachrichtigungen', icon: BellRing, titel: 'Benachrichtigungen', unter: 'Push auf diesem Gerät einrichten.', pruefungen: [] },
  { id: 'backup',      label: 'Backup',     icon: ShieldCheck, titel: 'Backup',                       unter: 'Sicherung aktivieren oder bewusst ohne Backup fortfahren.', pruefungen: ['backup'] },
  { id: 'abschluss',   label: 'Abschluss',  icon: Wand2,       titel: 'Abschlussprüfung',            unter: 'Alle Prüfungen auf einen Blick.', pruefungen: [] },
];

const SCHRITT_LABEL = Object.fromEntries(SCHRITTE.flatMap((s) => s.pruefungen.map((p) => [p, s.label])));
/** Prüfungs-ID → Schritt, in dem sie behoben wird. Macht jede Statuszeile anklickbar. */
const SCHRITT_VON_PRUEFUNG = Object.fromEntries(SCHRITTE.flatMap((s) => s.pruefungen.map((p) => [p, s.id])));

// Fasst die vom Gerät übernommene Ausstattung in einen Satz zusammen; das
// Backend hat scanner_has_adf/scanner_adf_duplex/scanner_supports_a3 zu
// diesem Zeitpunkt bereits gespeichert, keine weitere Bestätigung nötig.
function ausstattungText(ausstattung) {
  if (!ausstattung) return '';
  const teile = [];
  if (ausstattung.scanner_has_adf) teile.push('ADF');
  if (ausstattung.scanner_adf_duplex) teile.push('ADF-Duplex');
  if (ausstattung.scanner_supports_a3) teile.push('A3');
  return teile.length ? `${teile.join(', ')} wurden automatisch aktiviert.` : '';
}

function schrittZustand(def, status) {
  const p = def.pruefungen.map((id) => status?.pruefungen?.[id]).filter(Boolean);
  if (!p.length) return 'neutral';
  if (p.every((x) => x.ok)) return 'ok';
  if (p.some((x) => x.pflicht && !x.ok)) return 'pflicht';
  return 'offen';
}

// ── Bausteine ────────────────────────────────────────────────────────────────

/** Ein Abschnitt innerhalb eines Schritts – optisch die Karte der Einstellungen. */
function Abschnitt({ icon: Icon, titel, beschreibung, children }) {
  return (
    <section className="rounded-xl border bg-card shadow-sm">
      <div className="flex items-start gap-3 border-b px-4 py-3">
        {Icon && (
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
            <Icon className="h-4 w-4 text-primary" />
          </span>
        )}
        <div className="min-w-0">
          <p className="text-sm font-semibold">{titel}</p>
          {beschreibung && <p className="text-xs text-muted-foreground mt-0.5">{beschreibung}</p>}
        </div>
      </div>
      <div className="space-y-4 px-4 py-4">{children}</div>
    </section>
  );
}

function Feld({ label, hinweis, children }) {
  return (
    <div className="space-y-1.5">
      <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{label}</label>
      {children}
      {hinweis && <p className="text-xs text-muted-foreground">{hinweis}</p>}
    </div>
  );
}

/**
 * Die serverseitigen Istprüfungen als Zeilen – Wahrheit kommt nur von dort.
 *
 * Jede Zeile ist ein Sprung in den Schritt, der sie behebt. Eine Karte, die
 * „Pflicht für den Abschluss" sagt und dann nirgendwohin führt, ist eine
 * Sackgasse; das galt bis 2.8.9 für die gesamte Abschlussübersicht.
 */
function StatusZeilen({ status, nur, aktuellerSchritt, onSchritt }) {
  // `nur` gibt Auswahl UND Reihenfolge vor. Vorher entschied die Reihenfolge
  // des Serverobjekts: im Ordner-Schritt stand der Selbsttest oben, obwohl der
  // zugehörige Abschnitt darunter der letzte ist.
  const alle = status?.pruefungen || {};
  const entries = nur
    ? nur.filter((id) => alle[id]).map((id) => [id, alle[id]])
    : Object.entries(alle);
  if (!entries.length) return null;
  return (
    <div className="space-y-2">
      {entries.map(([id, p]) => {
        const ziel = SCHRITT_VON_PRUEFUNG[id];
        const springbar = !!onSchritt && !!ziel && ziel !== aktuellerSchritt;
        const inhalt = (
          <>
            {p.ok
              ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
              : p.pflicht
                ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-500" />
                : <Circle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />}
            <div className="min-w-0 flex-1">
              <p className="text-sm">{p.text}</p>
              {!p.ok && (
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {p.pflicht ? 'Pflicht für den Abschluss' : 'Optional – der Assistent lässt sich auch so abschließen'}
                </p>
              )}
            </div>
            {springbar && (
              <span className="mt-0.5 flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                {SCHRITT_LABEL[id]}<ArrowRight className="h-3.5 w-3.5" />
              </span>
            )}
          </>
        );
        const farbe = p.ok ? 'border-emerald-500/30 bg-emerald-500/[0.06]'
          : p.pflicht ? 'border-amber-500/40 bg-amber-500/[0.06]'
            : 'border-border/60';
        return springbar ? (
          <button
            key={id}
            type="button"
            onClick={() => onSchritt(ziel)}
            className={`flex w-full items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors hover:brightness-105 ${farbe}`}
          >
            {inhalt}
          </button>
        ) : (
          <div key={id} className={`flex items-start gap-2.5 rounded-lg border px-3 py-2.5 ${farbe}`}>
            {inhalt}
          </div>
        );
      })}
    </div>
  );
}

/** Rückfrage-Streifen statt window.confirm – gleicher Ton wie der Rest der App. */
function Rueckfrage({ text, frage, bestaetigen, abbrechen, onBestaetigen, onAbbrechen, laeuft }) {
  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/[0.07] p-3 space-y-2">
      {text && <p className="text-xs">{text}</p>}
      <p className="text-xs font-medium">{frage}</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={onBestaetigen} disabled={laeuft}>{bestaetigen}</Button>
        <Button size="sm" variant="outline" onClick={onAbbrechen}>{abbrechen}</Button>
      </div>
    </div>
  );
}

// Ergebnisse der DuckDNS-Prüfung, bei denen der TLS-Auftrag erst auf eine
// Entscheidung wartet. `nicht_pruefbar`/`lan_unbekannt` halten nicht an.
const DUCKDNS_HALT = new Set(['kein_eintrag', 'andere_adresse', 'rebind']);

/** Eingabe tolerant annehmen: klein, ohne Schema, Pfad und Leerzeichen. */
function duckdnsEingabe(wert) {
  return wert.toLowerCase().replace(/\s+/g, '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
}

function DuckdnsPruefHinweis({ pruefung, laeuft, onErneut, onTrotzdem }) {
  const { ergebnis, domain, lanIp, oeffentlich = [] } = pruefung;
  if (ergebnis === 'passt') {
    return <Testergebnis status="erfolg">{domain} zeigt auf {lanIp} (diesen Server), auch der Router löst sie auf.</Testergebnis>;
  }
  if (ergebnis === 'nicht_pruefbar') {
    return <Testergebnis>Die Domain ließ sich nicht prüfen (öffentliches DNS nicht erreichbar). Bitte bei DuckDNS selbst kontrollieren, ob dort die IP dieses Servers steht.</Testergebnis>;
  }
  if (ergebnis === 'lan_unbekannt') {
    return <Testergebnis>{domain} zeigt auf {oeffentlich.join(', ')}. Ob das dieser Server ist, lässt sich nicht prüfen, weil der Host-Agent keine LAN-Adresse meldet.</Testergebnis>;
  }
  const ip = lanIp ? <code className="font-mono">{lanIp}</code> : 'die IP dieses Servers';
  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/[0.07] p-3 space-y-2">
      {ergebnis === 'kein_eintrag' && (
        <p className="text-xs">
          Zu <code className="font-mono">{domain}</code> gibt es keinen DNS-Eintrag. Ist der Name falsch
          geschrieben, oder wurde die Subdomain auf duckdns.org noch nicht mit „add domain“ angelegt?
        </p>
      )}
      {ergebnis === 'andere_adresse' && (
        <p className="text-xs">
          <code className="font-mono">{domain}</code> zeigt auf <code className="font-mono">{oeffentlich.join(', ')}</code>,
          dieser Server hat {ip}.
          {pruefung.oeffentlicheAdresse && ' Das ist vermutlich deine öffentliche Internet-Adresse, die DuckDNS beim Anlegen automatisch einträgt.'}
          {' '}Trage auf duckdns.org bei dieser Domain {ip} ein und klicke „update ip“. Die Änderung ist meist
          nach spätestens einer Minute sichtbar.
        </p>
      )}
      {ergebnis === 'rebind' && (
        <p className="text-xs">
          <code className="font-mono">{domain}</code> zeigt korrekt auf {ip}, dein Router gibt diese Antwort aber
          nicht weiter (DNS-Rebind-Schutz). Dann funktionieren Domain, HTTPS und Push im Heimnetz nicht. Trage die
          Domain im Router als Ausnahme ein, statt den Schutz ganz abzuschalten. Fritz!Box: http://fritz.box →
          Heimnetz → Netzwerk → Netzwerkeinstellungen → DNS-Rebind-Schutz.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={onErneut} disabled={laeuft}>Erneut prüfen</Button>
        <Button size="sm" variant="outline" onClick={onTrotzdem} disabled={laeuft}>Trotzdem aktivieren</Button>
      </div>
    </div>
  );
}

// ── Seite ────────────────────────────────────────────────────────────────────

export default function EinrichtungPage() {
  const { schritt } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const index = SCHRITTE.findIndex((s) => s.id === schritt);
  const aktuell = index >= 0 ? index : 0;
  const definition = SCHRITTE[aktuell];

  const statusQuery = useQuery({ queryKey: ['einrichtung'], queryFn: () => api.einrichtung.status(), retry: false });
  const settingsQuery = useQuery({ queryKey: ['settings'], queryFn: () => api.settings.getAll(), retry: false });
  const wurzelQuery = useQuery({ queryKey: ['ablage-wurzel'], queryFn: () => api.onedrive.folderRoot(), retry: false });

  const status = statusQuery.data;
  const settings = settingsQuery.data;
  const hostconfig = status?.hostconfig;
  const agent = status?.pruefungen?.hostAgent;
  const backend = settings?.storage_backend?.value === 'nextcloud' ? 'nextcloud' : 'onedrive';
  // Der Server beantwortet dieselbe Frage in `pruefungen.ablage.gewaehlt` und
  // ist die Wahrheit – sonst zeigte das UI nach einer zurückgenommenen Wahl
  // weiter die Backend-Karte, weil noch eine Client-ID im Formular steht.
  const backendGewaehlt = status?.pruefungen?.ablage?.gewaehlt
    ?? (settings?.storage_backend_selected?.value === true
      || !!settings?.storage_folders?.value
      || !!settings?.onedrive_client_id?.value
      || !!settings?.nextcloud_base_url?.value);

  const [instanz, setInstanz] = useState('');
  const [basisUrl, setBasisUrl] = useState('');
  const [port, setPort] = useState('');
  const [duckDomain, setDuckDomain] = useState('');
  const [duckToken, setDuckToken] = useState('');
  const [duckTokenBearbeiten, setDuckTokenBearbeiten] = useState(false);
  const [tlsAusFrage, setTlsAusFrage] = useState(false);
  const [duckPruefung, setDuckPruefung] = useState(null);
  // Der Instanzschritt ist im Regelfall reine Information: install.sh hat Name,
  // Adresse, Port und TLS bereits gesetzt. Bearbeiten ist die Ausnahme und
  // beginnt deshalb mit einem ausdrücklichen Klick.
  const [betriebBearbeiten, setBetriebBearbeiten] = useState(false);
  const [letzterAuftrag, setLetzterAuftrag] = useState(null);
  const [hostAuftragInfo, setHostAuftragInfo] = useState(null);
  // Leer starten, NICHT 'postbuch': der Wurzelordner wird aus der Instanz
  // gelesen (siehe wurzelQuery). Ein geratener Vorgabewert hat hier schon
  // dafür gesorgt, dass eine Testinstanz den Ordner der Produktivinstanz
  // angeboten bekam – mitsamt Gesamt-Umzug aller Dokumente dorthin.
  const [rootPath, setRootPath] = useState('');
  const [wurzelWarnung, setWurzelWarnung] = useState(null);
  const [ordnerJobId, setOrdnerJobId] = useState(null);
  const [umzugJobId, setUmzugJobId] = useState(null);
  const [selbsttestJobId, setSelbsttestJobId] = useState(null);
  const [ordnerJobFehler, setOrdnerJobFehler] = useState('');
  const [umzugJobFehler, setUmzugJobFehler] = useState('');
  const [selbsttestJobFehler, setSelbsttestJobFehler] = useState('');
  const [scannerUrl, setScannerUrl] = useState('');
  const [scannerErgebnis, setScannerErgebnis] = useState(null);
  const [nobackupFrage, setNobackupFrage] = useState(false);
  const [ueberspringenFrage, setUeberspringenFrage] = useState(false);
  const [verschluesselungPasswort, setVerschluesselungPasswort] = useState('');
  const [verschluesselungPasswortWiederholung, setVerschluesselungPasswortWiederholung] = useState('');
  const [zeigeVerschluesselungPasswort, setZeigeVerschluesselungPasswort] = useState(false);
  const [ohneVerschluesselungFrage, setOhneVerschluesselungFrage] = useState(false);
  const [nachtraeglichVerschluesseln, setNachtraeglichVerschluesseln] = useState(false);

  useEffect(() => {
    if (!settings) return;
    setInstanz((alt) => alt || settings.instance_name?.value || '');
    setBasisUrl((alt) => alt || settings.app_host?.value || '');
    setScannerUrl((alt) => alt || settings.scanner_device_url?.value || '');
  }, [settings]);

  useEffect(() => {
    if (!hostconfig) return;
    setDuckDomain((alt) => alt || hostconfig.duckdns?.domain || '');
    setPort((alt) => alt || (hostconfig.port?.wert ? String(hostconfig.port.wert) : ''));
  }, [hostconfig]);

  useEffect(() => {
    const w = wurzelQuery.data;
    if (!w) return;
    // rootPath === null heißt: auf dieser Instanz ist noch nichts eingerichtet.
    // Nur dann ist 'postbuch' die richtige Vorgabe.
    setRootPath((alt) => alt || w.rootPath || 'postbuch');
  }, [wurzelQuery.data]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['einrichtung'] });
    qc.invalidateQueries({ queryKey: ['settings'] });
    qc.invalidateQueries({ queryKey: ['ablage-wurzel'] });
  };

  const pruefen = useMutation({ mutationFn: (mitStorage = false) => api.einrichtung.pruefen(mitStorage), onSuccess: refresh });
  // Beim Öffnen einmal still nachsehen, ob die KI-Provider wirklich antworten.
  // Ohne das meldet der Assistent nach einem eingespielten Backup „noch kein
  // KI-Provider erfolgreich getestet", obwohl die Instanz längst arbeitet: der
  // Restore verwirft die Prüfnachweise bewusst, und GET /einrichtung fragt von
  // sich aus keinen Provider. Fehler bleiben hier stumm – dafür stehen die
  // Knöpfe im KI-Schritt. Der Dateiablage-Selbsttest wird NICHT automatisch
  // gestartet: er legt Dateien in der Dateiablage an und gehört unter Kontrolle des
  // Nutzers.
  const kiErstpruefung = useMutation({ mutationFn: () => api.einrichtung.pruefen(false), onSuccess: refresh });
  const kiErstpruefungGestartet = useRef(false);
  useEffect(() => {
    if (kiErstpruefungGestartet.current) return;
    kiErstpruefungGestartet.current = true;
    kiErstpruefung.mutate();
  }, []);
  const schrittSpeichern = useMutation({ mutationFn: (id) => api.einrichtung.schritt(id, true), onSuccess: refresh });
  const instanzSpeichern = useMutation({
    mutationFn: async () => {
      await api.settings.update('instance_name', instanz.trim());
      await api.settings.update('app_host', basisUrl.trim());
    },
    onSuccess: refresh,
  });
  const hostAuftrag = useMutation({
    mutationFn: ({ typ, wert, secret }) => api.updates.hostconfig(typ, wert, secret),
    onMutate: ({ typ }) => { setLetzterAuftrag(typ); setTlsAusFrage(false); },
    // Der Token wird nach dem Absenden sofort aus dem Formular entfernt: er
    // gehört dem Host-Agenten, nicht dem Browserzustand.
    onSettled: () => { setDuckToken(''); setDuckTokenBearbeiten(false); },
    onSuccess: (data, variablen) => {
      setHostAuftragInfo({ ...data, wert: variablen.wert, angefordertAt: Date.now() });
      qc.invalidateQueries({ queryKey: ['updates'] });
      refresh();
    },
  });
  const tlsAktivieren = () => hostAuftrag.mutate({ typ: 'duckdns', wert: duckDomain, secret: duckToken });
  // Vor dem TLS-Auftrag prüfen, ob die Domain auf diesen Host zeigt. Nur ein
  // eindeutiger Fehler hält an; ist keine Prüfung möglich, geht es weiter.
  const duckdnsPruefen = useMutation({
    mutationFn: () => api.einrichtung.duckdnsPruefen(duckDomain),
    onMutate: () => setDuckPruefung(null),
    onSuccess: (ergebnis) => {
      setDuckPruefung(ergebnis);
      if (!DUCKDNS_HALT.has(ergebnis.ergebnis)) tlsAktivieren();
    },
    onError: (err) => setDuckPruefung({ ergebnis: 'nicht_pruefbar', fehler: err.message }),
  });
  const hostVollzug = useQuery({
    queryKey: ['updates', 'host-vollzug', hostAuftragInfo?.nonce],
    queryFn: () => api.updates.get(),
    enabled: !!hostAuftragInfo?.nonce,
    retry: false,
    refetchInterval: 2000,
  });
  const ordnerAnlegen = useMutation({
    mutationFn: (bestaetigt = false) => api.onedrive.setupWizard(rootPath.trim(), bestaetigt, true),
    onMutate: () => {
      setWurzelWarnung(null);
      setOrdnerJobFehler('');
      setUmzugJobFehler('');
    },
    onSuccess: (data) => { setOrdnerJobId(data.jobId || null); refresh(); },
    // 409 ist kein Fehler, sondern die Rückfrage des Servers bei abweichendem
    // Wurzelordner – sie bekommt eine eigene Bestätigung statt einer roten Zeile.
    onError: (err) => setWurzelWarnung(err?.payload?.code === 'WURZEL_ABWEICHUNG' ? err.payload : null),
  });
  const selbsttestStart = useMutation({
    mutationFn: () => api.einrichtung.storageSelbsttestStart(),
    onMutate: () => setSelbsttestJobFehler(''),
    onSuccess: (data) => setSelbsttestJobId(data.jobId),
  });
  // Die Adresse kommt als Argument, nicht aus dem State: nach einem Treffer der
  // Netzsuche wird sofort getestet, und das `setScannerUrl` davor ist beim
  // direkt folgenden `mutate()` noch nicht sichtbar.
  const scannerSpeichern = useMutation({
    mutationFn: async (url) => {
      const ziel = (url ?? scannerUrl).trim();
      await api.settings.update('scanner_device_url', ziel);
      const result = await api.settings.scannerCapabilities(ziel);
      setScannerErgebnis(result);
      return result;
    },
    onMutate: () => setScannerErgebnis(null),
    onSuccess: () => {
      // Ein Scanner, der antwortet, soll auch benutzt werden können. Das
      // Scannerprofil hinterher von Hand einzuschalten war ein zweiter Knopf
      // für eine Entscheidung, die mit dem erfolgreichen Test längst gefallen
      // ist – also übernimmt der Assistent sie. Nur, wenn der Host-Agent das
      // kann und das Profil nicht ohnehin schon läuft.
      const p = status?.pruefungen?.scanner;
      if (p?.profilSteuerbar && !p.profilAktiv && !hostAuftrag.isPending) {
        hostAuftrag.mutate({ typ: 'module', wert: 'scanner:an' });
      }
      refresh();
    },
  });
  const backendWaehlen = useMutation({
    mutationFn: (name) => api.storage.selectInitialBackend(name),
    onSuccess: refresh,
  });
  // Ein Fehlklick auf „OneDrive" darf keine Sackgasse sein. Ob die Wahl
  // folgenlos war, entscheidet der Server (`wechselMoeglich`) – nicht das UI.
  const backendZuruecknehmen = useMutation({
    mutationFn: () => api.storage.resetInitialBackend(),
    onSuccess: refresh,
  });
  const backup = useMutation({
    mutationFn: (aktiv) => api.backup.updateSettings(aktiv
      ? { enabled: true, cron: '0 4 * * *', bewusst: true }
      : { enabled: false, cron: '0 4 * * *', bestaetigung: 'NOBACKUP', bewusst: true }),
    onSuccess: () => { setNobackupFrage(false); refresh(); },
  });
  const verschluesselung = useMutation({
    mutationFn: (data) => api.backup.updateEncryption(data),
    onSuccess: () => {
      setVerschluesselungPasswort('');
      setVerschluesselungPasswortWiederholung('');
      setOhneVerschluesselungFrage(false);
      setNachtraeglichVerschluesseln(false);
      refresh();
    },
  });
  const discord = useMutation({ mutationFn: () => api.settings.notifications.discord.test() });
  const abschliessen = useMutation({
    mutationFn: () => api.einrichtung.abschliessen(),
    onSuccess: (data) => {
      refresh();
      einrichtungsGateFreigeben(qc, data.status);
      // Nicht direkt aufs Dashboard: eine eingerichtete Instanz ohne ein
      // einziges Dokument ist leer, und die Eingangswege sind der Punkt, an
      // dem es weitergeht. Die Seite wird mit „Verstanden" quittiert.
      navigate('/importwege?nachEinrichtung=1');
    },
  });
  const ueberspringen = useMutation({
    mutationFn: () => api.einrichtung.ueberspringen(),
    onSuccess: (data) => {
      refresh();
      einrichtungsGateFreigeben(qc, data.status);
      navigate('/');
    },
  });
  const trotzdemAnsehen = useMutation({
    mutationFn: () => api.einrichtung.trotzdemAnsehen(),
    onSuccess: () => {
      einrichtungsGateFreigeben(qc, 'offen');
      navigate('/');
    },
  });

  const geheZuSchritt = (id) => navigate(`/einrichtung/${id}`);

  function weiter() {
    schrittSpeichern.mutate(definition.id);
    // Die Istprüfung im Hintergrund anstoßen, statt sie dem Nutzer als
    // zusätzlichen Knopf aufzubürden: sie fragt die KI-Provider aktiv an, und
    // genau deren Ergebnis entscheidet, was der nächste Schritt anzeigt. Ohne
    // das stand im Abschluss „noch kein Provider getestet", obwohl gerade einer
    // eingerichtet worden war. Fehler bleiben stumm – im KI-Schritt steht der
    // ausdrückliche Knopf mit Fehlermeldung.
    if (!pruefen.isPending) pruefen.mutate(false);
    if (aktuell < SCHRITTE.length - 1) navigate(`/einrichtung/${SCHRITTE[aktuell + 1].id}`);
  }

  const auftragMeldung = (typ) => {
    if (letzterAuftrag !== typ) return null;
    if (hostAuftrag.isError) {
      // 429 heißt hier nie "fehlgeschlagen", sondern "ein gleichwertiger
      // Auftrag läuft schon" — typischerweise, weil der Scanner-Test im
      // Suchen-Dialog das Profil automatisch mit einschaltet (siehe oben) und
      // ein zweiter Klick auf "Speichern und testen" denselben Auftrag noch
      // einmal anstößt, während der erste auf dem Host-Agenten noch läuft.
      if (hostAuftrag.error.status === 429) {
        return (
          <Testergebnis>
            <span className="inline-flex items-center gap-2">
              <Spinner className="h-3.5 w-3.5" />
              Der Host-Agent verarbeitet bereits einen gleichwertigen Auftrag – das läuft im
              Hintergrund weiter, ein erneuter Versuch ist nicht nötig.
            </span>
          </Testergebnis>
        );
      }
      return <Testergebnis status="fehler">{hostAuftrag.error.message}</Testergebnis>;
    }
    if (!hostAuftragInfo || hostAuftragInfo.typ !== typ) return null;
    const daten = hostVollzug.data;
    const lauf = daten?.lauf?.nonce === hostAuftragInfo.nonce ? daten.lauf : null;
    const heartbeatNeu = Date.parse(daten?.agent?.letzterLaufAm || '') >= hostAuftragInfo.angefordertAt - 1000;
    const zielErreicht = typ !== 'module'
      || daten?.agent?.scannerProfilAktiv === (hostAuftragInfo.wert === 'scanner:an');
    if (lauf?.status === 'fehlgeschlagen' || lauf?.status === 'abgelehnt') {
      return <Testergebnis status="fehler">{lauf.meldung || 'Der Host-Agent konnte den Auftrag nicht ausführen.'}</Testergebnis>;
    }
    // Der Scanner-Auftrag ist der einzige, den ein Nutzer im Assistenten
    // beiläufig auslöst – und der einzige, bei dem Weitermachen unbedenklich
    // ist: der Scanner gilt bereits als eingerichtet, sobald die Fähigkeiten
    // gespeichert sind; der Host-Agent schaltet nur noch das Compose-Profil
    // scharf. „Warte auf bestätigten Zielzustand" las sich dort wie eine
    // Aufforderung, sitzen zu bleiben.
    const scannerProfil = typ === 'module' && String(hostAuftragInfo.wert || '').startsWith('scanner:');
    const scannerAn = hostAuftragInfo.wert === 'scanner:an';
    if (lauf?.status === 'erfolgreich' && heartbeatNeu && zielErreicht) {
      return (
        <Testergebnis status="erfolg">
          {scannerProfil
            ? (scannerAn
              ? 'Scanprofil ist aktiv – der Scanner-Dienst läuft.'
              : 'Scanprofil ist abgeschaltet.')
            : 'Auftrag ausgeführt und Zielzustand vom Host-Agenten bestätigt.'}
        </Testergebnis>
      );
    }
    const sekunden = Math.max(0, Math.floor((Date.now() - hostAuftragInfo.angefordertAt) / 1000));
    if (sekunden > 180 && !heartbeatNeu) {
      return <Testergebnis status="fehler">Der Host-Agent hat sich seit der Anforderung nicht mehr gemeldet. Prüfe den Agent-Dienst auf dem Server.</Testergebnis>;
    }
    return (
      <Testergebnis>
        <span className="inline-flex items-center gap-2">
          <Spinner className="h-3.5 w-3.5" />
          {scannerProfil
            ? (scannerAn
              ? 'Scanprofil wird aktiviert – das läuft im Hintergrund auf dem Server. Warten musst du nicht; sobald es steht, erscheint die Bestätigung hier.'
              : 'Scanprofil wird abgeschaltet – das läuft im Hintergrund auf dem Server.')
            : 'Auftrag übergeben – warte auf Ausführung und bestätigten Zielzustand…'}
        </span>
      </Testergebnis>
    );
  };

  // ── Schrittinhalte ─────────────────────────────────────────────────────────

  function inhaltWillkommen() {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Der Assistent geht die fachliche Einrichtung Schritt für Schritt durch. Alles, was hier
          eingestellt wird, steht danach genauso in den Einstellungen – der Assistent gibt eine
          sinnvolle Reihenfolge vor und stellt sicher, dass alles für einen reibungslosen Betrieb
          vorbereitet ist.
        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          {[
            { icon: Check, titel: 'Alles an einem Ort', text: 'Alle wichtigen Einstellungen werden direkt hier vorgenommen. Danach ist deine postbuch.net-App betriebsbereit.' },
            { icon: ShieldCheck, titel: 'Bestehendes bleibt erhalten', text: 'Ist etwas bereits konfiguriert, wird es vorbelegt und bleibt erhalten. Nur bei noch unbekannten Werten bleibt das Feld leer.' },
            { icon: ArrowRight, titel: 'Jederzeit pausieren', text: 'Der Assistent merkt sich den Fortschritt. „Später fortsetzen" bricht nichts ab. Über die Einstellungen geht es weiter.' },
          ].map((k) => (
            <div key={k.titel} className="rounded-xl border bg-muted/20 p-3.5">
              <k.icon className="h-4 w-4 text-primary" />
              <p className="mt-2 text-sm font-medium">{k.titel}</p>
              <p className="mt-1 text-xs text-muted-foreground">{k.text}</p>
            </div>
          ))}
        </div>
        <Testergebnis>
          Adminpasswort, die Zugangsdaten zur Bezugsquelle und die Erstinstallation auf dem
          Server bleiben Aufgabe des Installers.
        </Testergebnis>
      </div>
    );
  }

  function inhaltBetrieb() {
    const kann = (c) => !!agent?.capabilities?.includes(c);
    // „Hinterlegt" heißt hier: entweder über diese Oberfläche übergeben oder
    // vom Installer in die .env geschrieben. Letzteres meldet die App über eine
    // Compose-Variable, die nur die Tatsache trägt – nie den Wert.
    const tokenGesetzt = !!hostconfig?.duckdns?.tokenVorhanden;
    const tokenFeldOffen = duckTokenBearbeiten || !tokenGesetzt;

    if (!betriebBearbeiten) {
      return (
        <div className="space-y-4">
          <Abschnitt
            icon={Globe}
            titel="Diese Werte stehen bereits"
            beschreibung="Name, Adresse, Port und TLS hat der Installer bei der Einrichtung gesetzt. Hier sind sie nur zur Kontrolle – geändert wird nichts, solange du es nicht ausdrücklich willst."
          >
            <dl className="grid gap-3 sm:grid-cols-2">
              {[
                { t: 'Instanzname',   w: settings?.instance_name?.value || '–' },
                { t: 'Basisadresse',  w: settings?.app_host?.value || '–', mono: true },
                { t: 'Port der Weboberfläche', w: hostconfig?.port?.wert ? String(hostconfig.port.wert) : 'vom Host-Agenten nicht gemeldet' },
                { t: 'DuckDNS-Domain', w: hostconfig?.duckdns?.domain || 'keine', mono: true },
              ].map((z) => (
                <div key={z.t} className="rounded-lg border bg-muted/20 px-3 py-2.5">
                  <dt className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{z.t}</dt>
                  <dd className={`mt-1 break-all text-sm ${z.mono ? 'font-mono' : ''}`}>{z.w}</dd>
                </div>
              ))}
            </dl>

            {/* Punkte statt eines leeren Feldes: „nichts da" wäre die falsche
                Auskunft, wenn der Installer längst eines eingetragen hat. Der
                Wert selbst wird der Oberfläche nie gemeldet. */}
            <div className="rounded-lg border bg-muted/20 px-3 py-4 text-center">
              <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">DuckDNS-Token</p>
              {tokenGesetzt ? (
                <>
                  <p className="mt-2 select-none font-mono text-3xl leading-none tracking-[0.35em] text-foreground/80" aria-label="Token ist hinterlegt">
                    ••••••••
                  </p>
                  <p className="mt-2 text-xs text-muted-foreground">Hinterlegt.</p>
                </>
              ) : (
                <p className="mt-2 text-sm text-muted-foreground">Kein Token hinterlegt – TLS über DuckDNS ist damit nicht eingerichtet.</p>
              )}
            </div>

            <Button variant="outline" onClick={() => setBetriebBearbeiten(true)}>
              <Pencil className="h-4 w-4 mr-1.5" />Ändern
            </Button>
          </Abschnitt>

          <StatusZeilen status={status} nur={['betrieb', 'hostAgent']} aktuellerSchritt="betrieb" onSchritt={geheZuSchritt} />
        </div>
      );
    }
    // Die beiden Aufträge sind bewusst getrennt: `duckdns` schreibt Domain,
    // Token und Caddyfile, `netzwerk` schreibt APP_BASE_URL und app_host.
    // Wer nur die Domain wechselt, hat danach ein Zertifikat für die neue
    // Adresse, während App-Links und die OneDrive-Redirect-URI weiter auf die
    // alte zeigen. Zusammenlegen geht nicht – der Host-Agent nimmt immer nur
    // einen Auftrag an (429, solange einer offen ist). Also: darauf hinweisen
    // und das jeweils andere Feld auf einen Klick nachziehbar machen.
    const basisZiel = (() => {
      try {
        const u = new URL(basisUrl.trim());
        return { host: u.hostname.toLowerCase(), https: u.protocol === 'https:' };
      } catch { return null; }
    })();
    const duckGueltig = /^[a-z0-9-]{1,63}\.duckdns\.org$/.test(duckDomain);
    const adresseAbweichend = duckGueltig && basisZiel && basisZiel.host !== duckDomain;
    const adresseUnverschluesselt = duckGueltig && basisZiel && !adresseAbweichend && !basisZiel.https;
    const basisIstDuckdns = !!basisZiel && /^[a-z0-9-]{1,63}\.duckdns\.org$/.test(basisZiel.host);
    return (
      <div className="space-y-4">
        <Abschnitt icon={Globe} titel="Instanz" beschreibung="Name und Basisadresse dieser Installation. Beides steht in Benachrichtigungen und Links.">
          <div className="grid gap-3 sm:grid-cols-2">
            <Feld label="Instanzname">
              <Input value={instanz} onChange={(e) => setInstanz(e.target.value)} placeholder="Postbuch Familie Muster" />
            </Feld>
            <Feld label="Basisadresse" hinweis="Vollständig mit https:// – so, wie du postbuch.net im Browser aufrufst.">
              <Input className="font-mono" value={basisUrl} onChange={(e) => setBasisUrl(e.target.value)} placeholder="https://meinpostbuch.duckdns.org" />
            </Feld>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => instanzSpeichern.mutate()} disabled={instanzSpeichern.isPending || !instanz.trim() || !basisUrl.trim()}>
              {instanzSpeichern.isPending ? 'Speichern…' : 'Instanz speichern'}
            </Button>
            <Button variant="ghost" onClick={() => setBetriebBearbeiten(false)}>Bearbeiten beenden</Button>
          </div>
          {instanzSpeichern.isError && <Testergebnis status="fehler">{instanzSpeichern.error.message}</Testergebnis>}
          {instanzSpeichern.isSuccess && <Testergebnis status="erfolg">Gespeichert.</Testergebnis>}
          {basisUrl.trim() && basisUrl.trim() !== (settings?.app_host?.value || '') && (
            <p className="text-xs text-amber-600 dark:text-amber-500">
              Die eingetragene Basisadresse weicht von der gespeicherten ab und wirkt noch nicht.
              „Instanz speichern" schreibt sie in die Datenbank; läuft ein Host-Agent, trägt
              „Auf dem Host anwenden" sie zusätzlich in die <code className="font-mono">.env</code> ein.
            </p>
          )}
        </Abschnitt>

        <Abschnitt
          icon={Server}
          titel="Host-Agent"
          beschreibung="Änderungen am Host – Port, Adresse, TLS – führt nicht die App aus, sondern der Agent auf dem Server."
        >
          <StatusZeilen status={status} nur={['hostAgent']} aktuellerSchritt="betrieb" onSchritt={geheZuSchritt} />
          {!agent?.vorhanden ? (
            <Testergebnis>
              Ohne aktuellen Heartbeat bleibt dieser Abschnitt gesperrt. Die übrige Einrichtung
              funktioniert davon unabhängig weiter.
            </Testergebnis>
          ) : (
            <div className="space-y-5">
              {kann('port') && (
                <Feld
                  label="Port der Weboberfläche"
                  hinweis={hostconfig?.port?.wert
                    ? `Zuletzt an den Host übergeben: ${hostconfig.port.wert}.`
                    : 'Der Host-Agent meldet den aktuell aktiven Port nicht zurück. Das Feld bleibt deshalb leer, bis hier einmal einer gesetzt wurde – der Standard der Installation ist 3420.'}
                >
                  <div className="flex flex-wrap gap-2">
                    <Input type="number" min="1024" max="65535" className="w-40" placeholder="3420" value={port} onChange={(e) => setPort(e.target.value)} />
                    <Button variant="outline" onClick={() => hostAuftrag.mutate({ typ: 'port', wert: port })} disabled={hostAuftrag.isPending || !/^\d{4,5}$/.test(port)}>
                      Port anwenden
                    </Button>
                  </div>
                  {auftragMeldung('port')}
                </Feld>
              )}

              {kann('netzwerk') && (
                <>
                  <Feld
                    label="Oben eingetragene Basisadresse anwenden"
                    hinweis="Die Adresse änderst du oben in der Karte „Instanz“. Hier wird dieser Wert nur auf den Host übertragen; app und web starten dabei neu."
                  >
                    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed px-3 py-2">
                      <span className="text-xs text-muted-foreground">Wird angewendet:</span>
                      <code className="text-xs font-mono break-all">{basisUrl || '– oben noch keine Adresse eingetragen –'}</code>
                      <Button variant="outline" onClick={() => hostAuftrag.mutate({ typ: 'netzwerk', wert: basisUrl.trim() })} disabled={hostAuftrag.isPending || !basisUrl.trim()}>
                        Auf dem Host anwenden
                      </Button>
                    </div>
                    {auftragMeldung('netzwerk')}
                  </Feld>

                  <Feld
                    label="TLS über DuckDNS"
                    hinweis="Jede Änderung an Domain oder Zertifikat braucht den Token erneut."
                  >
                    <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
                      <Input
                        placeholder="name.duckdns.org"
                        value={duckDomain}
                        autoCapitalize="none"
                        autoCorrect="off"
                        onChange={(e) => { setDuckDomain(duckdnsEingabe(e.target.value)); setDuckPruefung(null); }}
                        onBlur={() => setDuckDomain((d) => (d && !d.includes('.') ? `${d}.duckdns.org` : d))}
                      />
                      {tokenFeldOffen ? (
                        <Input type="password" autoComplete="new-password" placeholder="DuckDNS-Token" value={duckToken} onChange={(e) => setDuckToken(e.target.value)} />
                      ) : (
                        <div className="flex items-center gap-2">
                          <Input value="••••••••••••" readOnly disabled className="font-mono tracking-widest" aria-label="Token ist hinterlegt" />
                          <Button variant="ghost" size="sm" className="shrink-0" onClick={() => { setDuckTokenBearbeiten(true); setDuckToken(''); }}>
                            <Pencil className="h-3.5 w-3.5 mr-1.5" />Ändern
                          </Button>
                        </div>
                      )}
                      <Button
                        variant="outline"
                        onClick={() => duckdnsPruefen.mutate()}
                        disabled={hostAuftrag.isPending || duckdnsPruefen.isPending || !/^[a-z0-9-]{1,63}\.duckdns\.org$/.test(duckDomain) || duckToken.length < 8}
                      >
                        {duckdnsPruefen.isPending ? 'Prüfe Domain…' : 'TLS aktivieren'}
                      </Button>
                    </div>
                    {duckPruefung && (
                      <DuckdnsPruefHinweis
                        pruefung={duckPruefung}
                        laeuft={duckdnsPruefen.isPending || hostAuftrag.isPending}
                        onErneut={() => duckdnsPruefen.mutate()}
                        onTrotzdem={() => { setDuckPruefung(null); tlsAktivieren(); }}
                      />
                    )}
                    {hostconfig?.duckdns?.domain && (
                      <p className="text-xs text-muted-foreground">
                        {hostconfig.duckdns.quelle === 'installer'
                          ? <>Bei der Installation gesetzt.</>
                          : hostconfig.duckdns.quelle === 'abgeleitet'
                            ? <>Vorschlag aus der Basisadresse.</>
                            : <>Zuletzt an den Host übergeben{hostconfig.duckdns.angefordertAm ? ` am ${new Date(hostconfig.duckdns.angefordertAm).toLocaleDateString('de-DE')}` : ''}.</>}
                        {tokenGesetzt ? ' Ein Token ist hinterlegt.' : ' Es ist kein Token hinterlegt.'}
                      </p>
                    )}
                    {!tokenFeldOffen && (
                      <Testergebnis>Zum Aktivieren wird der Token erneut gebraucht – auf „Ändern" klicken und ihn eingeben.</Testergebnis>
                    )}
                    {(adresseAbweichend || adresseUnverschluesselt) && (
                      <div className="rounded-lg border border-amber-500/40 bg-amber-500/[0.07] p-3 space-y-2">
                        <p className="text-xs">
                          {adresseAbweichend ? (
                            <>Die Basisadresse zeigt auf <code className="font-mono">{basisZiel.host}</code>,
                            das Zertifikat entstünde für <code className="font-mono">{duckDomain}</code>. Der
                            TLS-Auftrag ändert die Basisadresse nicht – Links in Benachrichtigungen und die
                            OneDrive-Redirect-URI blieben auf der alten Adresse.</>
                          ) : (
                            <>Die Basisadresse beginnt mit <code className="font-mono">http://</code>. Mit
                            aktivem TLS gehört <code className="font-mono">https://</code> davor, sonst passt
                            die OneDrive-Redirect-URI nicht mehr zum Eintrag in Azure.</>
                          )}
                        </p>
                        <p className="text-xs font-medium">
                          Reihenfolge: erst TLS aktivieren, dann die Basisadresse auf dem Host anwenden.
                        </p>
                        <div className="flex flex-wrap gap-2">
                          <Button size="sm" variant="outline" onClick={() => setBasisUrl(`https://${duckDomain}`)}>
                            Basisadresse auf https://{duckDomain} setzen
                          </Button>
                          {adresseAbweichend && basisIstDuckdns && (
                            <Button size="sm" variant="ghost" onClick={() => setDuckDomain(basisZiel.host)}>
                              Stattdessen {basisZiel.host} als Domain
                            </Button>
                          )}
                        </div>
                      </div>
                    )}
                    {auftragMeldung('duckdns')}
                    {tlsAusFrage ? (
                      <Rueckfrage
                        text="TLS wird abgeschaltet: Domain und Token werden aus der Host-Konfiguration entfernt und der caddy-Container gestoppt."
                        frage="Soll die Instanz wirklich wieder ohne TLS laufen?"
                        bestaetigen="Ja, TLS abschalten"
                        abbrechen="Abbrechen"
                        laeuft={hostAuftrag.isPending}
                        onBestaetigen={() => hostAuftrag.mutate({ typ: 'duckdns', wert: 'aus' })}
                        onAbbrechen={() => setTlsAusFrage(false)}
                      />
                    ) : (
                      <button type="button" className="text-xs text-muted-foreground underline hover:text-foreground" onClick={() => setTlsAusFrage(true)}>
                        TLS wieder abschalten
                      </button>
                    )}
                  </Feld>
                </>
              )}
            </div>
          )}
        </Abschnitt>
      </div>
    );
  }

  function inhaltMenschen() {
    return (
      <div className="space-y-4">
        <StatusZeilen status={status} nur={['menschen']} aktuellerSchritt="menschen" onSchritt={geheZuSchritt} />
        <p className="text-sm text-muted-foreground">
          Ein Mensch trägt beides: die fachliche Rolle in Dokumenten (Kurzname, PKV/Beihilfe) und
          optional einen Zugang zur Oberfläche. Für den Anfang genügt eine Person.
        </p>
        <MenschenCard eingebettet />
      </div>
    );
  }

  function inhaltAblage() {
    return (
      <div className="space-y-4">
        <StatusZeilen status={status} nur={['ablage']} aktuellerSchritt="ablage" onSchritt={geheZuSchritt} />
        {settingsQuery.isLoading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><Spinner className="h-4 w-4" />Einstellungen werden geladen…</div>
        ) : !backendGewaehlt ? (
          <Abschnitt icon={Cloud} titel="Dateiablage wählen" beschreibung="Diese einmalige Wahl ist auf der leeren Instanz noch kein Umzug. Spätere Wechsel laufen geführt und kopieren den Bestand.">
            <div className="grid gap-3 sm:grid-cols-2">
              <Button variant="outline" className="h-auto justify-start py-4" onClick={() => backendWaehlen.mutate('onedrive')} disabled={backendWaehlen.isPending}>
                <Cloud className="h-4 w-4 mr-2" />OneDrive
              </Button>
              <Button variant="outline" className="h-auto justify-start py-4" onClick={() => backendWaehlen.mutate('nextcloud')} disabled={backendWaehlen.isPending}>
                <Server className="h-4 w-4 mr-2" />Eigene Nextcloud / WebDAV
              </Button>
            </div>
            {backendWaehlen.isError && <Testergebnis status="fehler">{backendWaehlen.error.message}</Testergebnis>}
          </Abschnitt>
        ) : (
          <>
            {backend === 'nextcloud' ? <NextcloudCard /> : <OneDriveSection settings={settings} onSaved={refresh} />}
            {status?.pruefungen?.ablage?.wechselMoeglich && (
              <Abschnitt
                icon={Cloud}
                titel="Doch die andere Dateiablage?"
                beschreibung={`Aktuell gewählt: ${backend === 'nextcloud' ? 'Eigene Nextcloud / WebDAV' : 'OneDrive'}. Solange nichts verbunden und kein Ordner angelegt ist, ist diese Wahl folgenlos und lässt sich zurücknehmen.`}
              >
                <Button variant="outline" onClick={() => backendZuruecknehmen.mutate()} disabled={backendZuruecknehmen.isPending}>
                  <ArrowLeft className="h-4 w-4 mr-1.5" />
                  {backendZuruecknehmen.isPending ? 'Wird zurückgenommen…' : 'Andere Dateiablage wählen'}
                </Button>
                {backendZuruecknehmen.isError && <Testergebnis status="fehler">{backendZuruecknehmen.error.message}</Testergebnis>}
              </Abschnitt>
            )}
          </>
        )}
        <Testergebnis>
          Sobald die Dateiablage verbunden oder die Ordnerstruktur angelegt ist, ist ein Wechsel des
          Backends ein Umzug des Bestands – der läuft geführt unter Einstellungen → Dateiablage und ist
          bewusst kein Thema der Ersteinrichtung.
        </Testergebnis>
      </div>
    );
  }

  function inhaltOrdner() {
    const eingerichtet = wurzelQuery.data?.rootPath;
    return (
      <div className="space-y-4">
        <StatusZeilen status={status} nur={['ordner', 'ablageSelbsttest']} aktuellerSchritt="ordner" onSchritt={geheZuSchritt} />
        <Abschnitt
          icon={FolderOpen}
          titel="Wurzelordner"
          beschreibung="Unterhalb dieses Ordners legt postbuch.net seine komplette Struktur an. Alles andere entsteht automatisch."
        >
          <Feld
            label="Wurzelordner"
            hinweis={wurzelQuery.isPending
              ? 'Der eingerichtete Wurzelordner wird aus der Dateiablage gelesen…'
              : eingerichtet
                ? `Diese Instanz arbeitet derzeit in „${eingerichtet}".`
                : 'Auf dieser Instanz ist noch keine Struktur angelegt. „postbuch" ist die Vorgabe.'}
          >
            <div className="flex flex-wrap gap-2">
              <Input
                className="max-w-xs font-mono"
                value={rootPath}
                onChange={(e) => { setRootPath(e.target.value); setWurzelWarnung(null); }}
                placeholder={wurzelQuery.isPending ? 'wird gelesen…' : 'postbuch'}
                aria-label="Wurzelordner"
              />
              {/* Solange der eingerichtete Wurzelordner nicht feststeht, bleibt der
                  Knopf zu – er löst einen Umzug des gesamten Bestands aus. */}
              <Button onClick={() => ordnerAnlegen.mutate()} disabled={ordnerAnlegen.isPending || !!ordnerJobId || !!umzugJobId || wurzelQuery.isPending || !rootPath.trim()}>
                <FolderOpen className="h-4 w-4 mr-1.5" />
                {ordnerAnlegen.isPending || ordnerJobId || umzugJobId ? 'Wird verarbeitet…' : 'Ordnerstruktur neu anlegen'}
              </Button>
            </div>
          </Feld>
          {wurzelWarnung && (
            <Rueckfrage
              text={wurzelWarnung.error}
              frage="Sollen die Daten wirklich dorthin umgezogen werden?"
              bestaetigen="Ja, Dateiablage umziehen"
              abbrechen={`Abbrechen, bei „${wurzelWarnung.bisher}“ bleiben`}
              laeuft={ordnerAnlegen.isPending}
              onBestaetigen={() => ordnerAnlegen.mutate(true)}
              onAbbrechen={() => { setRootPath(wurzelWarnung.bisher); setWurzelWarnung(null); }}
            />
          )}
          {ordnerAnlegen.isError && !wurzelWarnung && <Testergebnis status="fehler">{ordnerAnlegen.error?.message}</Testergebnis>}
          <JobFortschritt
            jobId={ordnerJobId}
            titel="Ordnerstruktur"
            onDone={(job) => {
              if (job.status === 'done') {
                const relocateId = job?.payload?.relocateJobId;
                if (relocateId) setUmzugJobId(relocateId);
              } else {
                setOrdnerJobFehler(job?.errorMessage ?? job?.error_message ?? 'Die Ordnerstruktur konnte nicht angelegt werden.');
              }
              setOrdnerJobId(null);
              refresh();
            }}
          />
          {ordnerJobFehler && <Testergebnis status="fehler">{ordnerJobFehler}</Testergebnis>}
          <JobFortschritt
            jobId={umzugJobId}
            titel="Dokumente umziehen"
            onDone={(job) => {
              if (job.status !== 'done') {
                setUmzugJobFehler(job?.errorMessage ?? job?.error_message ?? 'Der Dokumentumzug ist fehlgeschlagen.');
              }
              setUmzugJobId(null);
              refresh();
            }}
          />
          {umzugJobFehler && <Testergebnis status="fehler">{umzugJobFehler}</Testergebnis>}
          {ordnerAnlegen.isSuccess && !wurzelWarnung && !ordnerJobId && !umzugJobId && !ordnerJobFehler && !umzugJobFehler && <Testergebnis status="erfolg">Ordnerstruktur und Dokumentumzug sind abgeschlossen.</Testergebnis>}
        </Abschnitt>

        <Abschnitt
          icon={ShieldCheck}
          titel="Dateiablage-Selbsttest (empfohlen)"
          beschreibung="Legt eine Wegwerfdatei in einem eigenen Testordner an, liest, verschiebt und löscht sie wieder. Der Wurzelordner oben wird dabei nicht berührt."
        >
          <Button variant="outline" onClick={() => selbsttestStart.mutate()} disabled={selbsttestStart.isPending || !!selbsttestJobId}>
            <RefreshCw className={`h-4 w-4 mr-1.5 ${selbsttestStart.isPending || selbsttestJobId ? 'animate-spin' : ''}`} />
            {selbsttestStart.isPending || selbsttestJobId ? 'Selbsttest läuft…' : 'Dateiablage-Selbsttest starten'}
          </Button>
          {selbsttestStart.isError && <Testergebnis status="fehler">{selbsttestStart.error.message}</Testergebnis>}
          <JobFortschritt
            jobId={selbsttestJobId}
            titel="Dateiablage-Selbsttest"
            onDone={(job) => {
              if (job.status !== 'done') {
                setSelbsttestJobFehler(job?.errorMessage ?? job?.error_message ?? 'Der Dateiablage-Selbsttest ist fehlgeschlagen.');
              }
              setSelbsttestJobId(null);
              refresh();
            }}
          />
          {selbsttestJobFehler && <Testergebnis status="fehler">{selbsttestJobFehler}</Testergebnis>}
        </Abschnitt>
      </div>
    );
  }

  function inhaltKi() {
    return <KiSchritt status={status} pruefen={pruefen} onSchritt={geheZuSchritt} />;
  }

  function inhaltScanner() {
    const p = status?.pruefungen?.scanner;
    return (
      <div className="space-y-4">
        <StatusZeilen status={status} nur={['scanner']} aktuellerSchritt="scanner" onSchritt={geheZuSchritt} />
        <Abschnitt icon={Network} titel="Empfohlen: Scanner im Netzwerk suchen" beschreibung="postbuch.net schlägt das lokale Netz vor und klopft es nach eSCL-Geräten ab. Die Suche startet erst auf Klick. Ein übernommener Treffer wird sofort gespeichert und getestet.">
          {/* Ein Gerät, das die Suche gefunden hat, hat bereits geantwortet –
              danach noch einen „Speichern und testen"-Knopf zu verlangen, wäre
              ein Klick für eine längst getroffene Entscheidung. */}
          <ScannerDiscoveryCard
            primary
            onSelect={(treffer) => { setScannerUrl(treffer.url); scannerSpeichern.mutate(treffer.url); }}
          />
          {scannerSpeichern.isPending && (
            <Testergebnis>Gefundener Scanner wird gespeichert und getestet…</Testergebnis>
          )}
        </Abschnitt>
        <Abschnitt icon={ScanLine} titel="Adresse selbst eintragen" beschreibung="Falls die Suche nichts findet, trägst du die eSCL-Adresse selbst ein. Erst der Test beweist, dass dort wirklich ein Scanner antwortet.">
          <Feld
            label="Scanner-URL"
            hinweis={p?.geraet ? `Zuletzt erfolgreich getestet: ${p.geraet}.` : undefined}
          >
            <Input className="font-mono" value={scannerUrl} onChange={(e) => setScannerUrl(e.target.value)} placeholder="http://192.168.x.x:80/eSCL" />
          </Feld>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => scannerSpeichern.mutate()} disabled={scannerSpeichern.isPending || !scannerUrl.trim()}>
              <ScanLine className="h-4 w-4 mr-1.5" />{scannerSpeichern.isPending ? 'Wird getestet…' : 'Speichern und testen'}
            </Button>
          </div>
          {scannerErgebnis && (
            <Testergebnis status="erfolg">
              {scannerErgebnis.capabilities?.geraet || 'Scanner'} antwortet; die Fähigkeiten wurden gespeichert.
              {' '}{ausstattungText(scannerErgebnis.ausstattung)}
              {p?.profilSteuerbar && ' Das Scannerprofil wird dabei automatisch eingeschaltet.'}
            </Testergebnis>
          )}
          {/* Abschalten gehört nicht in die Ersteinrichtung – wer den Assistenten
              durchläuft, will scannen. Der Rückweg steht unter
              Einstellungen → Scanner, dort hinter einer Rückfrage. */}
          {scannerSpeichern.isError && <Testergebnis status="fehler">{scannerSpeichern.error.message}</Testergebnis>}
          {auftragMeldung('module')}
        </Abschnitt>
      </div>
    );
  }

  function inhaltBenachrichtigungen() {
    const p = status?.pruefungen?.backup;
    return (
      <div className="space-y-4">
        <PushAbschnitt />
        {p?.discordKonfiguriert && (
          <Abschnitt icon={AlertTriangle} titel="Discord (experimentell)" beschreibung="Nicht empfohlen: eine Fehlkonfiguration kann Dokumentinhalte in einen fremden Kanal tragen.">
            <Button variant="outline" onClick={() => discord.mutate()} disabled={discord.isPending}>Discord testen</Button>
            {discord.isSuccess && <Testergebnis status="erfolg">Discord-Testnachricht wurde gesendet.</Testergebnis>}
            {discord.isError && <Testergebnis status="fehler">{discord.error.message}</Testergebnis>}
          </Abschnitt>
        )}
      </div>
    );
  }

  function inhaltBackup() {
    const p = status?.pruefungen?.backup;
    const wurzel = wurzelQuery.data?.rootPath;
    const backupPfad = wurzel === undefined || wurzel === null ? null : [wurzel, '_backup'].filter(Boolean).join('/');
    return (
      <div className="space-y-4">
        <StatusZeilen status={status} nur={['backup']} aktuellerSchritt="backup" onSchritt={geheZuSchritt} />
        <Abschnitt icon={ShieldCheck} titel="Backup" beschreibung="Eine bewusste Entscheidung ist Pflicht – entweder tägliche Sicherung oder ein ausdrückliches NOBACKUP.">
          <div className="rounded-lg border bg-muted/30 px-3.5 py-3 text-sm leading-relaxed space-y-2">
            <p>
              <span className="font-medium">Wohin:</span>{' '}
              {backupPfad
                ? <>in den Ordner <code className="rounded bg-background px-1.5 py-0.5 font-mono text-[0.85em] break-all">{backupPfad}</code> deiner Dateiablage</>
                : <>in den Ordner <code className="rounded bg-background px-1.5 py-0.5 font-mono text-[0.85em]">_backup</code> unter deinem Wurzelverzeichnis</>}
              {' '}– täglich um 04:00 Uhr, je Lauf ein Dump zum Zurückspielen und einer als lesbares SQL.
              Alte Sicherungen dünnt postbuch.net selbst aus: erst täglich, dann wöchentlich, monatlich, halbjährlich.
            </p>
            <p>
              <span className="font-medium">Was:</span> die Datenbank – also Postnummern, Zuordnungen,
              Auswertungen, Abrechnungen, Menschen und alle Einstellungen samt hinterlegter Zugangsdaten.
              Wer die Datei hat, hat diese Daten.
            </p>
            <p>
              <span className="font-medium">Was nicht:</span> die Dokumente selbst. Die liegen als Dateien
              in deiner Dateiablage und werden von dort nicht kopiert – sie sind ohnehin schon in der Cloud.
              Ohne Datenbanksicherung wären sie zwar noch da, aber ohne alles, was postbuch.net über sie weiß.
            </p>
          </div>
          {p?.backupEntschieden && p?.backupAktiv && <Testergebnis status="erfolg">Tägliche Sicherung ist aktiv (04:00 Uhr).</Testergebnis>}
          {!p?.backupEntschieden && p?.backupAktiv && (
            <Testergebnis>
              Die tägliche Sicherung läuft bereits, ist aber noch nicht als deine bewusste
              Entscheidung bestätigt. Bestätige sie unten oder wähle ausdrücklich NOBACKUP.
            </Testergebnis>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              variant={p?.backupEntschieden && p?.backupAktiv ? 'default' : 'outline'}
              onClick={() => backup.mutate(true)}
              disabled={backup.isPending}
            >
              <ShieldCheck className="h-4 w-4 mr-1.5" />
              {p?.backupAktiv && !p?.backupEntschieden ? 'Aktives Backup bestätigen' : 'Tägliches Backup aktivieren'}
            </Button>
            <Button
              variant={p?.backupEntschieden && !p?.backupAktiv ? 'default' : 'outline'}
              onClick={() => setNobackupFrage(true)}
              disabled={backup.isPending}
            >
              Ohne Backup betreiben
            </Button>
          </div>
          {nobackupFrage && (
            <Rueckfrage
              text="Ohne Backup gibt es bei einem Datenbankverlust keinen Weg zurück: Dokumente liegen zwar in der Dateiablage, aber alle Auswertungen, Zuordnungen und Abrechnungen stecken in der Datenbank."
              frage="Soll postbuch.net wirklich ohne Sicherung laufen?"
              bestaetigen="Ja, NOBACKUP bestätigen"
              abbrechen="Abbrechen"
              laeuft={backup.isPending}
              onBestaetigen={() => backup.mutate(false)}
              onAbbrechen={() => setNobackupFrage(false)}
            />
          )}
          {backup.isError && <Testergebnis status="fehler">{backup.error.message}</Testergebnis>}

          {p?.backupAktiv && (
            <div className="space-y-3 pt-3 border-t border-border/60">
              <div className="flex items-center gap-2">
                <KeyRound className="h-4 w-4 text-muted-foreground" />
                <p className="text-sm font-medium">Backup-Verschlüsselung</p>
              </div>

              {p?.verschluesselungAktiv ? (
                <Testergebnis status="erfolg">
                  Backup-Verschlüsselung ist aktiv. Passwort ändern oder einsehen: Einstellungen → Backup.
                </Testergebnis>
              ) : p?.verschluesselungEntschieden && !nachtraeglichVerschluesseln ? (
                <>
                  <Testergebnis>
                    Backups werden bewusst unverschlüsselt gespeichert. Lässt sich jederzeit unter
                    Einstellungen → Backup nachträglich aktivieren.
                  </Testergebnis>
                  <Button variant="outline" size="sm" onClick={() => setNachtraeglichVerschluesseln(true)}>
                    <KeyRound className="h-3.5 w-3.5 mr-1.5" />
                    Doch verschlüsseln
                  </Button>
                </>
              ) : (
                <>
                  <div className="rounded-lg border-2 border-amber-500/40 bg-amber-500/8 px-4 py-3 space-y-1.5">
                    <p className="text-sm font-semibold text-amber-700 dark:text-amber-500">
                      Notiere dir dieses Passwort jetzt – es verlässt dieses Gerät nie automatisch.
                    </p>
                    <p className="text-xs leading-relaxed text-amber-700/90 dark:text-amber-400/90">
                      Ohne dieses Passwort (bzw. das jeweils aktuelle nach einer späteren Änderung)
                      lässt sich ein verschlüsseltes Backup nicht wiederherstellen – es gibt keinen
                      Zurücksetzen-Mechanismus. Speichere es in einem Passwortmanager oder schreibe
                      es handschriftlich auf.
                    </p>
                  </div>

                  <div className="space-y-2 max-w-sm">
                    <div className="relative">
                      <Input
                        type={zeigeVerschluesselungPasswort ? 'text' : 'password'}
                        value={verschluesselungPasswort}
                        onChange={(e) => setVerschluesselungPasswort(e.target.value)}
                        placeholder="Backup-Passwort (mind. 8 Zeichen)"
                        className="h-9 text-sm pr-9"
                        autoComplete="new-password"
                      />
                      <button
                        type="button"
                        onClick={() => setZeigeVerschluesselungPasswort(!zeigeVerschluesselungPasswort)}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      >
                        {zeigeVerschluesselungPasswort
                          ? <EyeOff className="h-3.5 w-3.5" />
                          : <Eye className="h-3.5 w-3.5" />}
                      </button>
                    </div>
                    <Input
                      type={zeigeVerschluesselungPasswort ? 'text' : 'password'}
                      value={verschluesselungPasswortWiederholung}
                      onChange={(e) => setVerschluesselungPasswortWiederholung(e.target.value)}
                      placeholder="Passwort wiederholen"
                      className="h-9 text-sm"
                      autoComplete="new-password"
                    />
                    {verschluesselungPasswort && verschluesselungPasswortWiederholung
                      && verschluesselungPasswort !== verschluesselungPasswortWiederholung && (
                      <p className="text-xs text-destructive">Passwörter stimmen nicht überein.</p>
                    )}
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <Button
                      onClick={() => verschluesselung.mutate({
                        enabled: true,
                        passwort: verschluesselungPasswort,
                        passwortWiederholung: verschluesselungPasswortWiederholung,
                      })}
                      disabled={verschluesselung.isPending
                        || verschluesselungPasswort.length < 8
                        || verschluesselungPasswort !== verschluesselungPasswortWiederholung}
                    >
                      <KeyRound className="h-4 w-4 mr-1.5" />
                      Verschlüsselung aktivieren
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => setOhneVerschluesselungFrage(true)}
                      disabled={verschluesselung.isPending}
                    >
                      Ohne Verschlüsselung fortfahren
                    </Button>
                    {p?.verschluesselungEntschieden && (
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setNachtraeglichVerschluesseln(false);
                          setVerschluesselungPasswort('');
                          setVerschluesselungPasswortWiederholung('');
                        }}
                        disabled={verschluesselung.isPending}
                      >
                        Abbrechen
                      </Button>
                    )}
                  </div>

                  {ohneVerschluesselungFrage && (
                    <Rueckfrage
                      text="Backups liegen dann unverschlüsselt in deiner Dateiablage (OneDrive/Nextcloud) – wer Zugriff auf dieses Konto hat, kann sie lesen. Die Verschlüsselung lässt sich jederzeit später unter Einstellungen → Backup nachholen."
                      frage="Backups wirklich ohne Verschlüsselung speichern?"
                      bestaetigen="Ja, ohne Verschlüsselung fortfahren"
                      abbrechen="Abbrechen"
                      laeuft={verschluesselung.isPending}
                      onBestaetigen={() => verschluesselung.mutate({ enabled: false, bewusst: true })}
                      onAbbrechen={() => setOhneVerschluesselungFrage(false)}
                    />
                  )}
                </>
              )}

              {verschluesselung.isError && <Testergebnis status="fehler">{verschluesselung.error.message}</Testergebnis>}
            </div>
          )}
        </Abschnitt>
      </div>
    );
  }

  function inhaltAbschluss() {
    const offen = (status?.pflichtOffen || []).map((id) => SCHRITT_LABEL[id] || id);
    return (
      <div className="space-y-4">
        <StatusZeilen status={status} aktuellerSchritt="abschluss" onSchritt={geheZuSchritt} />
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => pruefen.mutate(false)} disabled={pruefen.isPending}>
            <RefreshCw className={`h-4 w-4 mr-1.5 ${pruefen.isPending ? 'animate-spin' : ''}`} />Istprüfung aktualisieren
          </Button>
        </div>
        {status?.bereit
          ? <Testergebnis status="erfolg">Alle Pflichtprüfungen sind erfüllt.</Testergebnis>
          : <Testergebnis>Noch offen: {offen.join(', ') || 'Status wird geladen'}</Testergebnis>}
        {abschliessen.isError && <Testergebnis status="fehler">{abschliessen.error.message}</Testergebnis>}
      </div>
    );
  }

  const INHALT = {
    willkommen: inhaltWillkommen,
    betrieb: inhaltBetrieb,
    menschen: inhaltMenschen,
    ablage: inhaltAblage,
    ordner: inhaltOrdner,
    ki: inhaltKi,
    scanner: inhaltScanner,
    benachrichtigungen: inhaltBenachrichtigungen,
    backup: inhaltBackup,
    abschluss: inhaltAbschluss,
  };

  if (index < 0) return <Navigate to="/einrichtung/willkommen" replace />;
  if (statusQuery.isLoading) return <div className="min-h-screen grid place-items-center"><Spinner className="h-8 w-8" /></div>;

  const fortschritt = Math.round(((aktuell + 1) / SCHRITTE.length) * 100);

  return (
    <div className="min-h-screen bg-gradient-to-b from-muted/40 to-background">
      <header className="sticky top-0 z-20 border-b bg-background/85 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-3 py-2.5 sm:px-6">
          <Logo size={34} />
          <div className="min-w-0">
            <p className="text-sm font-semibold leading-tight">Einrichtung</p>
            <p className="text-[11px] text-muted-foreground leading-tight">Schritt {aktuell + 1} von {SCHRITTE.length} · v{__APP_VERSION__}</p>
          </div>
          {/* Neuer Tab: der Assistent selbst wird nicht verlassen (Grundsatz 1). */}
          <a href={schlankeHilfeUrl()} target="_blank" rel="noopener" title="Hilfe in neuem Tab öffnen"
            className="ml-auto inline-flex h-8 items-center rounded-lg px-3 text-sm font-medium transition-all duration-150 hover:bg-accent hover:text-accent-foreground">
            <BookOpen className="h-4 w-4 sm:mr-1" /><span className="hidden sm:inline">Hilfe</span>
          </a>
          <Button variant="ghost" size="sm" onClick={() => trotzdemAnsehen.mutate()} disabled={trotzdemAnsehen.isPending}>
            <X className="h-4 w-4 mr-1" /><span className="hidden sm:inline">Trotzdem ansehen</span>
          </Button>
        </div>
        <div className="h-0.5 w-full bg-muted">
          <div className="h-full bg-primary transition-all duration-300" style={{ width: `${fortschritt}%` }} />
        </div>
      </header>

      <div className="mx-auto max-w-6xl gap-6 px-3 py-4 sm:px-6 sm:py-6 lg:grid lg:grid-cols-[15rem_minmax(0,1fr)]">
        {/* Schrittleiste: links als Liste, auf schmalen Geräten als Chip-Reihe. */}
        <nav aria-label="Einrichtungsschritte" className="mb-4 lg:mb-0">
          <ol className="flex gap-1.5 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible lg:pb-0">
            {SCHRITTE.map((s, i) => {
              const zustand = schrittZustand(s, status);
              const aktivSchritt = i === aktuell;
              return (
                <li key={s.id} className="shrink-0 lg:shrink">
                  <button
                    type="button"
                    onClick={() => navigate(`/einrichtung/${s.id}`)}
                    aria-current={aktivSchritt ? 'step' : undefined}
                    className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors ${
                      aktivSchritt ? 'bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'}`}
                  >
                    <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold ${
                      zustand === 'ok' ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                        : zustand === 'pflicht' ? 'border-amber-500/50 bg-amber-500/15 text-amber-600 dark:text-amber-500'
                          : aktivSchritt ? 'border-primary text-primary' : 'border-border'}`}
                    >
                      {zustand === 'ok' ? <Check className="h-3.5 w-3.5" /> : <s.icon className="h-3.5 w-3.5" />}
                    </span>
                    <span className={`text-xs ${aktivSchritt ? 'font-semibold' : ''}`}>{s.label}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>

        <main className="min-w-0">
          <Card className="overflow-hidden">
            <CardHeader className="border-b bg-muted/20">
              <div className="flex items-center gap-2">
                <CardTitle className="text-lg">{definition.titel}</CardTitle>
                {schrittZustand(definition, status) === 'ok' && <Badge className="text-[10px]">erledigt</Badge>}
              </div>
              <CardDescription>{definition.unter}</CardDescription>
            </CardHeader>
            <CardContent className="pt-5">{INHALT[definition.id]()}</CardContent>
          </Card>

          <footer className="mt-4 flex flex-wrap items-center justify-between gap-2">
            <Button variant="outline" onClick={() => navigate(`/einrichtung/${SCHRITTE[Math.max(0, aktuell - 1)].id}`)} disabled={aktuell === 0}>
              <ArrowLeft className="h-4 w-4 mr-1.5" />Zurück
            </Button>
            <div className="flex flex-wrap gap-2">
              {definition.id === 'abschluss' ? (
                <>
                  <Button variant="ghost" onClick={() => setUeberspringenFrage(true)} disabled={ueberspringen.isPending}>Assistent überspringen</Button>
                  <Button onClick={() => abschliessen.mutate()} disabled={!status?.bereit || abschliessen.isPending}>
                    <Wand2 className="h-4 w-4 mr-1.5" />Einrichtung abschließen
                  </Button>
                </>
              ) : (
                <Button onClick={weiter}>Weiter<ArrowRight className="h-4 w-4 ml-1.5" /></Button>
              )}
            </div>
          </footer>

          {ueberspringenFrage && (
            <div className="mt-3">
              <Rueckfrage
                text="Der Assistent wird als übersprungen vermerkt und meldet sich nicht mehr von selbst. Das macht Pflichtprüfungen nicht optional: Ohne funktionsfähige Dateiablage hat postbuch.net keine Dokumentenfunktion. Richte OneDrive oder WebDAV zwingend über Einstellungen → Dateiablage ein."
                frage="Assistent wirklich überspringen?"
                bestaetigen="Ja, überspringen"
                abbrechen="Abbrechen"
                laeuft={ueberspringen.isPending}
                onBestaetigen={() => ueberspringen.mutate()}
                onAbbrechen={() => setUeberspringenFrage(false)}
              />
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

/**
 * KI-Schritt – dieselben Karten wie Einstellungen → KI, aber **stufenweise**.
 *
 * Die Karte baut sich auf, statt alles auf einmal zu zeigen: erst der Provider,
 * dann Empfehlungen und Modellzuordnung, zuletzt das Embedding. Vorher standen
 * fünf Karten nebeneinander, von denen vier ohne konfigurierten Provider nur
 * Fehlermeldungen anzeigen konnten – das las sich wie ein kaputter Assistent.
 *
 * Sprachmodell und Embedding sind zwei getrennte Voraussetzungen. Ein
 * 2-in-1-Provider (OpenAI) erfüllt beide auf einmal, zwei getrennte Provider
 * gehen genauso. Beides ist Pflicht: ohne Embedding gibt es weder Ähnlichkeits-
 * suche noch Duplikatprüfung noch Anwenderhilfe.
 */
function Stufe({ nummer, titel, beschreibung, gesperrt, sperrgrund, children }) {
  return (
    <section className={`rounded-xl border bg-card shadow-sm ${gesperrt ? 'border-dashed' : ''}`}>
      {/* Die Trennlinie gehört zum Inhalt darunter – eine gesperrte Stufe hat
          keinen, und der Strich stünde sonst frei über der Kartenkante. */}
      <div className={`flex items-start gap-3 px-4 py-3 ${gesperrt ? '' : 'border-b'}`}>
        <span className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
          gesperrt ? 'bg-muted text-muted-foreground' : 'bg-primary/10 text-primary'}`}
        >
          {gesperrt ? <Lock className="h-3.5 w-3.5" /> : nummer}
        </span>
        <div className="min-w-0">
          <p className={`text-sm font-semibold ${gesperrt ? 'text-muted-foreground' : ''}`}>{titel}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{gesperrt ? sperrgrund : beschreibung}</p>
        </div>
      </div>
      {!gesperrt && <div className="space-y-4 px-4 py-4">{children}</div>}
    </section>
  );
}

function KiSchritt({ status, pruefen, onSchritt }) {
  const qc = useQueryClient();
  const { data: health, refetch: refetchHealth } = useQuery({
    queryKey: ['ai-health'], queryFn: () => api.settings.ai.health(), staleTime: 2 * 60 * 1000, retry: false,
  });
  const { data: providerData } = useQuery({ queryKey: ['ai-providers'], queryFn: () => api.settings.ai.providers.list(), retry: false });
  const { data: settings, isLoading: settingsLoading } = useQuery({ queryKey: ['settings'], queryFn: () => api.settings.getAll(), retry: false });
  const [modelValues, setModelValues] = useState({});
  const [modelSaved, setModelSaved] = useState(false);

  const providers = (providerData?.providers || []).map((p) => ({
    ...p,
    models: health?.providers?.[p.id]?.models || [],
    embeddingModels: health?.providers?.[p.id]?.embeddingModels || [],
  }));

  const llmPruefung = status?.pruefungen?.kiLlm;
  const embPruefung = status?.pruefungen?.kiEmbedding;
  const llmBereit = (llmPruefung?.llmProviders || []).length > 0;
  const embeddingBereit = (embPruefung?.embeddingProviders || []).length > 0;

  const klassenStatus = llmPruefung?.modellklassen || [];
  const statusMap = Object.fromEntries(klassenStatus.map((x) => [x.key, x]));
  const sortiert = [...MODEL_CLASSES].sort((a, b) => {
    const ao = statusMap[a.key]?.ok === false ? 0 : 1;
    const bo = statusMap[b.key]?.ok === false ? 0 : 1;
    return ao - bo;
  });

  /**
   * Nach JEDER Änderung an der Providerkonfiguration alles neu holen – auch die
   * serverseitige Istprüfung. Ohne den letzten Schritt blieben Empfehlungen und
   * Modellzuordnung auf dem Stand von vor dem Speichern stehen und meldeten
   * weiter „Provider nicht konfiguriert", während er längst eingerichtet war.
   */
  async function nachProviderAenderung() {
    await refetchHealth();
    await qc.invalidateQueries({ queryKey: ['ai-providers'] });
    await qc.invalidateQueries({ queryKey: ['ai-embedding'] });
    await qc.invalidateQueries({ queryKey: ['cloudfrei-check'] });
    await qc.invalidateQueries({ queryKey: ['llm-empfehlungen'] });
    await qc.invalidateQueries({ queryKey: ['settings'] });
    // ProviderCard und EmpfehlungenCard behandeln den Callback fire-and-forget.
    // Die Mutation selbst hält den Fehlerzustand für die sichtbare Meldung;
    // hier darf daraus deshalb kein unbehandeltes Promise-Rejection entstehen.
    await pruefen.mutateAsync(false).catch(() => null);
  }

  const saveModels = useMutation({
    mutationFn: async () => {
      for (const cls of MODEL_CLASSES) {
        if (modelValues[cls.key] !== undefined) {
          await api.settings.update(cls.settingKey, modelValues[cls.key]);
        }
      }
    },
    onSuccess: async () => {
      setModelValues({});
      setModelSaved(true);
      setTimeout(() => setModelSaved(false), 3000);
      await qc.invalidateQueries({ queryKey: ['settings'] });
      await refetchHealth();
      pruefen.mutate(false);
    },
  });

  return (
    <div className="space-y-4">
      <StatusZeilen status={status} nur={['kiLlm', 'kiEmbedding']} aktuellerSchritt="ki" onSchritt={onSchritt} />
      <Testergebnis>
        Ein einfacher Einstieg ist beispielsweise ein OpenAI-Entwicklerkonto mit kleinem
        Guthaben: ein Konto kann Sprachmodelle und Embeddings bereitstellen. Das ist ein
        möglicher kurzer Weg, keine Anbieterempfehlung. Cloudfrei geht es ebenso mit einem
        lokalen Chat- und Embedding-Modell.
      </Testergebnis>

      <Stufe
        nummer={1}
        titel="KI-Provider verbinden"
        beschreibung="Zugangsdaten eintragen und testen. Erst ein bestandener Test schaltet die nächsten Stufen frei."
      >
        <ProviderCard health={health} onChanged={nachProviderAenderung} />
      </Stufe>

      <Stufe
        nummer={2}
        titel="Modellempfehlungen"
        beschreibung="Die mit dieser Version ausgelieferte Auswahl – ein Klick belegt alle Aufgaben sinnvoll vor."
        gesperrt={!llmBereit && !embeddingBereit}
        sperrgrund="Wird frei, sobald ein Provider den Test bestanden hat."
      >
        <EmpfehlungenCard llmGesperrt={!llmBereit} embeddingGesperrt={!embeddingBereit} onChanged={nachProviderAenderung} />
      </Stufe>

      <Stufe
        nummer={3}
        titel="Modelle je Aufgabe"
        beschreibung="Jede Aufgabe braucht ein nutzbares Modell – alle zusammen sind Pflicht für den Abschluss."
        gesperrt={!llmBereit}
        sperrgrund="Wird frei, sobald ein Sprachmodell-Provider den Test bestanden hat."
      >
        {settingsLoading ? (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground"><Spinner className="h-4 w-4" />Lade Modelle…</div>
        ) : sortiert.map((cls) => {
          const k = statusMap[cls.key];
          return (
            <div key={cls.key} className={k?.ok === false ? 'rounded-lg bg-amber-500/[0.06] px-2' : 'px-2'}>
              {k?.ok === false && <p className="pt-2 text-xs text-amber-700 dark:text-amber-400">{k.grund}</p>}
              <ModelSelector
                cls={cls}
                wert={modelValues[cls.key]}
                aufgeloest={health?.models?.[cls.key]}
                providers={providers}
                laedt={!health}
                onChange={(key, value) => setModelValues((alt) => ({ ...alt, [key]: value }))}
                onCostChange={() => {}}
                zeigeKosten={false}
              />
            </div>
          );
        })}
        <div className="flex items-center gap-3">
          <Button size="sm" onClick={() => saveModels.mutate()} disabled={saveModels.isPending || Object.keys(modelValues).length === 0}>
            {saveModels.isPending ? 'Speichern…' : 'Modelle speichern'}
          </Button>
          {modelSaved && <span className="text-xs text-emerald-600">Gespeichert und neu geprüft.</span>}
        </div>
        {saveModels.isError && <p className="text-xs text-destructive">{saveModels.error?.message}</p>}
      </Stufe>

      <Stufe
        nummer={4}
        titel="Embedding-Modell"
        beschreibung="Grundlage für Ähnlichkeitssuche, Duplikatprüfung und die Anwenderhilfe."
        gesperrt={!embeddingBereit}
        sperrgrund="Wird frei, sobald ein Provider mit Embedding-Fähigkeit den Test bestanden hat. Ein Konto kann beides abdecken."
      >
        <Testergebnis>
          Die angezeigte Auswahl ist nur ein Vorschlag, bis du sie speicherst. Solange hier nichts
          gespeichert ist, richtet „Modellempfehlungen alle übernehmen“ das Embedding-Modell mit
          ein. Ein späterer Wechsel ändert die Signatur aus Provider, Modell und Dimension und
          macht eine Neuberechnung des Vektorbestands nötig – dafür gibt es eine eigene Rückfrage.
        </Testergebnis>
        <EmbeddingCard providers={providers} onChanged={nachProviderAenderung} />
      </Stufe>

      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => pruefen.mutate(false)} disabled={pruefen.isPending}>
          <RefreshCw className={`h-4 w-4 mr-1.5 ${pruefen.isPending ? 'animate-spin' : ''}`} />KI neu testen
        </Button>
      </div>
      {pruefen.isError && <Testergebnis status="fehler">{pruefen.error.message}</Testergebnis>}
    </div>
  );
}

/** Push-Einrichtung direkt im Assistenten – der empfohlene Benachrichtigungsweg. */
function PushAbschnitt() {
  const { supported, unsichererKontext, permission, subscribed, erlaubt, loading, error, subscribe, unsubscribe } = usePushSubscription();
  const { data: prefs } = useQuery({ queryKey: ['my-notification-prefs'], queryFn: () => pushApi.getMyPrefs(), retry: false });

  return (
    <Abschnitt icon={BellRing} titel="Benachrichtigungen (empfohlen)" beschreibung="Push im Browser bzw. in der installierten App. Zugestellt wird über den Push-Dienst des Browserherstellers, der Inhalt ist verschlüsselt.">
      {erlaubt === false ? (
        <Testergebnis>
          Push ist auf dieser Instanz abgeschaltet. Erlauben lässt es sich unter
          Einstellungen → Benachrichtigungen → Push auf dieser Instanz.
        </Testergebnis>
      ) : !supported ? (
        <Testergebnis>
          {unsichererKontext
            ? 'Push-Benachrichtigungen brauchen eine gesicherte Verbindung. Diese Seite läuft gerade '
              + 'unverschlüsselt oder über eine reine IP-Adresse – über den Hostnamen mit gültigem '
              + 'Zertifikat (https) funktioniert es im selben Browser.'
            : 'Dieser Browser unterstützt keine Web-Push-Benachrichtigungen. Auf iOS muss postbuch.net '
              + 'dafür zuerst über „Zum Home-Bildschirm" installiert werden.'}
        </Testergebnis>
      ) : subscribed ? (
        <div className="space-y-2">
          <Testergebnis status="erfolg">Dieses Gerät empfängt Benachrichtigungen.</Testergebnis>
          <Button variant="outline" size="sm" onClick={unsubscribe} disabled={loading}>Auf diesem Gerät abschalten</Button>
        </div>
      ) : (
        <div className="space-y-2">
          <Button onClick={subscribe} disabled={loading || permission === 'denied'}>
            <BellRing className="h-4 w-4 mr-1.5" />{loading ? 'Wird eingerichtet…' : 'Auf diesem Gerät aktivieren'}
          </Button>
          {permission === 'denied' && (
            <Testergebnis status="fehler">
              Benachrichtigungen sind für diese Seite im Browser blockiert. Die Sperre lässt sich
              nur in den Browser-Einstellungen aufheben.
            </Testergebnis>
          )}
        </div>
      )}
      {error && <Testergebnis status="fehler">{error}</Testergebnis>}
      {prefs && <p className="text-xs text-muted-foreground">Welche Ereignisse melden sollen, stellst du später unter Einstellungen → Benachrichtigungen ein.</p>}
    </Abschnitt>
  );
}
