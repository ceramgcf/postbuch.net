/**
 * AblageUmzugPage – der Migrationsassistent für den Dateiablage-Umzug.
 *
 * Ersetzt die frühere MigrationCard (zwei aufklappende Karten unten im
 * Dateiablage-Tab): Der Umzug-Knopf in den Einstellungen führt hierher, analog zum
 * Einrichtungsassistenten. Fünf Schritte, jeder baut auf dem vorigen auf:
 *
 *   1. ueberblick   – worum es geht, Ziel-Backend verbinden (inline, wie im
 *                      Einrichtungsassistenten – kein Rausschicken aus dem Flow)
 *   2. trockenlauf  – zählt nur, erfasst IMMER den gesamten Quellbestand
 *                      (kein Limit-Feld mehr – siehe Kopfkommentar von
 *                      service/storage-migration.js)
 *   3. kopieren     – der eigentliche Kopiervorgang samt Restliste. Der
 *                      Start-Trigger („Kopieren starten") lebt hier, nicht in
 *                      Schritt 2 – der Trockenlauf zählt nur.
 *   Abbrechen        – EIN Knopf im Header (solange nicht umgeschaltet/
 *                      aufgeräumt ist), egal in welchem Schritt: hält einen
 *                      aktiven Hintergrund-Worker zuerst an und rollt dann
 *                      bereits kopierte Items in-place auf die Quelle zurück
 *                      (brichLaufVollstaendigAb() im Backend).
 *   4. umschalten   – prüft Nachzügler UNMITTELBAR vorher noch einmal (nicht
 *                      nur beim Trockenlauf) und blockiert das Umschalten,
 *                      solange welche offen sind; ein Klick nimmt sie auf und
 *                      springt zurück zu „kopieren"
 *   5. abschluss    – optionales Aufräumen der Quelle (verschiebt in _trash)
 *                      plus der bleibende Hinweis: die alte Dateiablage wirklich
 *                      leerzuräumen (Papierkorb leeren, altes Konto kündigen
 *                      o.Ä.) ist Sache des Nutzers – postbuch.net löscht dort
 *                      nie endgültig etwas.
 *
 * Der Assistent lässt sich jederzeit schließen (X oben) – nicht destruktiv,
 * der Fortschritt steht im Lauf auf dem Server, nicht im Frontend-State.
 * Beim erneuten Öffnen (oder Reload mitten im Schritt) bestimmt
 * empfohlenerSchritt() aus dem Server-Zustand, wo es weitergeht.
 */
import { useEffect, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, ArrowLeft, ArrowRight, ArrowLeftRight, Ban, Check, CheckCircle2,
  Cloud, FileX, PauseCircle, PlayCircle, RefreshCw, Server,
  Sparkles, Trash2, Unlink2, Wand2, X, XCircle,
} from 'lucide-react';
import { api } from '@/api/client';
import { Logo } from '@/components/ui/Logo';
import { Testergebnis } from '@/components/ui/testergebnis';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Spinner } from '@/components/ui/spinner';
import OneDriveSection from '@/components/settings/OneDriveSection';
import NextcloudCard from '@/components/settings/NextcloudCard';
import { ablageLabel as label } from '@/lib/ablage';

const SCHRITTE = [
  { id: 'ueberblick', label: 'Überblick', icon: Sparkles, titel: 'Dateiablage umziehen', unter: 'Worum es geht, und wohin.' },
  { id: 'trockenlauf', label: 'Trockenlauf', icon: RefreshCw, titel: 'Trockenlauf', unter: 'Zählt nur – es wird noch nichts kopiert.' },
  { id: 'kopieren', label: 'Kopieren', icon: ArrowLeftRight, titel: 'Dokumente kopieren', unter: 'Die Originale bleiben dabei unangetastet.' },
  { id: 'umschalten', label: 'Umschalten', icon: Wand2, titel: 'Aktive Dateiablage umschalten', unter: 'Neue Dokumente landen ab hier im Ziel.' },
  { id: 'abschluss', label: 'Abschluss', icon: CheckCircle2, titel: 'Abschluss', unter: 'Aufräumen der Quelle – und was noch zu tun bleibt.' },
];

/** Wo geht's weiter? Einzige Wahrheit ist der Server-Zustand des Laufs.
 *  Exportiert, damit das Dashboard-Banner denselben Sprung berechnet.
 *
 *  switched_at + cleaned_at heißt: dieser Lauf ist vollständig fertig, es gibt
 *  nichts mehr zu tun. getOffenenLauf() liefert ihn im Backend bewusst
 *  trotzdem weiter zurück (siehe dortiger Kommentar), damit die Erfolgsseite
 *  erreichbar bleibt – hier aber darf er nicht mehr „der aktuelle Lauf" sein,
 *  sonst bleibt ein neuer Umzug in Gegenrichtung für immer im alten
 *  Abschluss-Schritt gefangen (z. B. „Dateiablage umziehen" nach abgeschlossenem
 *  OneDrive-Umzug zurück auf WebDAV starten). Ein frischer Assistent-Einstieg
 *  auf „ueberblick" lässt dann ganz normal einen neuen Lauf für das (jetzt
 *  umgekehrte) Backend-Paar entstehen. */
export function empfohlenerSchritt(run) {
  if (!run) return 'ueberblick';
  if (run.switched_at && run.cleaned_at) return 'ueberblick';
  if (run.switched_at) return 'abschluss';
  if (['vorbereitet', 'trockenlauf'].includes(run.status)) return 'trockenlauf';
  if (['abgeschlossen', 'abgeschlossen_mit_resten'].includes(run.status)) return 'umschalten';
  return 'kopieren';
}

/** Exportiert, damit DashboardPage denselben Rest-Zähler nutzen kann, um seinen
 *  Mischbestand-Hinweis direkt auf den Kopieren-Schritt statt nur auf die
 *  Dateiablage-Einstellungen zu verlinken (siehe StorageMischbestandBanner). */
export function offeneReste(r) {
  const c = r?.itemCounts || {};
  return (c.fehler || 0) + (c.hash_konflikt || 0) + (c.quelle_fehlt || 0) + (c.kein_zielordner || 0);
}

/** Rückfrage-Streifen statt window.confirm – gleicher Ton wie der Einrichtungsassistent. */
function Rueckfrage({ text, frage, bestaetigen, abbrechen, onBestaetigen, onAbbrechen, laeuft, gefahr }) {
  return (
    <div className={`rounded-lg border p-3 space-y-2 ${gefahr ? 'border-destructive/40 bg-destructive/[0.06]' : 'border-amber-500/40 bg-amber-500/[0.07]'}`}>
      {text && <p className="text-xs">{text}</p>}
      <p className="text-xs font-medium">{frage}</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant={gefahr ? 'destructive' : 'default'} onClick={onBestaetigen} disabled={laeuft}>
          {laeuft ? <Spinner className="h-3.5 w-3.5" /> : null}{bestaetigen}
        </Button>
        <Button size="sm" variant="outline" onClick={onAbbrechen}>{abbrechen}</Button>
      </div>
    </div>
  );
}

export default function AblageUmzugPage() {
  const { schritt } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: () => api.settings.getAll(), retry: false });
  const { data: runRoh, refetch } = useQuery({
    queryKey: ['migration', 'aktuell'],
    queryFn: () => api.migration.aktuell(),
    refetchInterval: (q) => (q.state.data?.status === 'laeuft' ? 1500 : false),
  });
  const { data: ncStatus } = useQuery({ queryKey: ['nextcloud-status'], queryFn: () => api.nextcloud.status(), retry: false });
  const { data: odStatus } = useQuery({ queryKey: ['onedrive-status'], queryFn: () => api.onedrive.status(), retry: false });

  const aktiv = settings?.storage_backend?.value || 'onedrive';
  const zielVorgabe = aktiv === 'onedrive' ? 'nextcloud' : 'onedrive';
  // Ein Lauf, der bereits umgeschaltet UND aufgeräumt ist, ist rein historisch
  // (siehe empfohlenerSchritt()-Kommentar oben) – der gesamte Assistent
  // behandelt ihn ab hier wie „kein Lauf vorhanden", nicht nur die
  // Richtungsberechnung. Ohne das bliebe z. B. der Abschluss-Schritt grün und
  // zeigte weiter den alten, längst erledigten Stand, während Überblick/
  // Trockenlauf/Kopieren schon wieder bei null anfangen – widersprüchlich für
  // einen gerade neu gestarteten (auch umgekehrten) Umzug. `runRoh` bleibt nur
  // für empfohlenerSchritt() und die Lade-Prüfung unten ungefiltert, weil die
  // die historisch/nicht-historisch-Unterscheidung selbst treffen.
  const laufHistorisch = !!runRoh?.switched_at && !!runRoh?.cleaned_at;
  const run = laufHistorisch ? null : runRoh;
  const srcBackend = run ? run.src_backend : aktiv;
  const dstBackend = run ? run.dst_backend : zielVorgabe;
  const zielVerbunden = dstBackend === 'nextcloud' ? !!ncStatus?.connected : !!odStatus?.connected;
  const srcVerbunden = srcBackend === 'nextcloud' ? !!ncStatus?.connected : !!odStatus?.connected;

  const index = SCHRITTE.findIndex((s) => s.id === schritt);
  const aktuell = index >= 0 ? index : 0;
  const definition = SCHRITTE[aktuell];

  // Beim ersten Laden (oder nach einem Reload mitten im Assistenten) auf den
  // vom Server empfohlenen Schritt springen, statt den möglicherweise
  // veralteten URL-Schritt einfach zu rendern.
  const empfohlen = empfohlenerSchritt(runRoh);
  if (runRoh !== undefined && index < 0) {
    return <Navigate to={`/ablage-umzug/${empfohlen}`} replace />;
  }

  const [zielRootPath, setZielRootPath] = useState('');
  const zielWurzelQuery = useQuery({
    queryKey: ['ablage-wurzel', dstBackend], queryFn: () => api.onedrive.folderRoot(dstBackend), retry: false,
  });
  // Kein „|| 'postbuch'"-Rateversuch: laut Backend-Kontrakt (siehe Kommentar
  // über GET /onedrive-folders/root) heißt rootPath === null „noch nichts
  // eingerichtet oder nicht auflösbar" – dann bleibt das Feld bewusst leer,
  // statt einen frei erfundenen Ordnernamen vorzuschlagen. Ist im Zielbackend
  // (z. B. aus einer früheren Migration) bereits ein Wurzelordner bekannt
  // (etwa „postbuch_auf_magenta"), wird GENAU der übernommen.
  useEffect(() => {
    const w = zielWurzelQuery.data;
    if (w?.rootPath) setZielRootPath((alt) => alt || w.rootPath);
  }, [zielWurzelQuery.data]);

  const [bestaetigt, setBestaetigt] = useState(false);
  const [loeschDialog, setLoeschDialog] = useState(null);
  const [alleLoeschenFrage, setAlleLoeschenFrage] = useState(false);
  const [nachzuegler, setNachzuegler] = useState(null);
  const [umschaltFrage, setUmschaltFrage] = useState(false);
  const [aufraeumFrage, setAufraeumFrage] = useState(false);
  const [fehler, setFehler] = useState('');
  const [schliessenFrage, setSchliessenFrage] = useState(false);
  const [schliessenOhneAufraeumenFrage, setSchliessenOhneAufraeumenFrage] = useState(false);
  const [abbrechenFrage, setAbbrechenFrage] = useState(false);
  const [trockenJobId, setTrockenJobId] = useState(null);
  const [aufraeumJobId, setAufraeumJobId] = useState(null);

  const mVorbereiten = useMutation({
    mutationFn: () => api.migration.zielVorbereiten(dstBackend, zielRootPath.trim() || 'postbuch'),
    onSuccess: () => { setFehler(''); qc.invalidateQueries({ queryKey: ['settings'] }); refetch(); },
    onError: (e) => setFehler(e.message),
  });
  const mTrocken = useMutation({
    mutationFn: () => api.migration.trockenlauf(srcBackend, dstBackend),
    onSuccess: (d) => { setFehler(''); setTrockenJobId(d.jobId); refetch(); },
    onError: (e) => setFehler(e.message),
  });
  const { data: trockenJob } = useQuery({
    queryKey: ['jobs', trockenJobId],
    queryFn: () => api.jobs.get(trockenJobId),
    enabled: !!trockenJobId,
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 800 : false),
  });
  useEffect(() => {
    if (trockenJob && trockenJob.status !== 'running') { setTrockenJobId(null); refetch(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trockenJob?.status]);
  const mStart = useMutation({
    mutationFn: () => api.migration.start(run.id),
    onSuccess: () => { setFehler(''); setBestaetigt(false); refetch(); navigate('/ablage-umzug/kopieren'); },
    onError: (e) => setFehler(e.message),
  });
  const mPausieren = useMutation({
    mutationFn: () => api.migration.abbrechen(run.id),
    onSuccess: () => refetch(),
    onError: (e) => setFehler(e.message),
  });
  const mAbschliessen = useMutation({
    mutationFn: () => api.migration.abschliessen(run.id),
    onSuccess: () => refetch(),
    onError: (e) => setFehler(e.message),
  });
  const mRest = useMutation({
    mutationFn: ({ art, postid }) =>
      art === 'erneut' ? api.migration.restErneut(run.id, postid)
        : art === 'ohneDatei' ? api.migration.restOhneDatei(run.id, postid)
          : api.migration.restLoeschen(run.id, postid),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['migration'] }); refetch(); },
    onError: (e) => setFehler(e.message),
  });

  // Bulk-Variante für die Restliste: nacheinander (nicht parallel) über die
  // bestehenden Einzel-Endpunkte, damit dieselbe Serverlogik greift wie beim
  // Klick pro Zeile (inkl. des 409-Schutzes in restEintragLoeschen, wenn noch
  // eine Datei dranhängt). Einzelne Fehlschläge brechen den Lauf nicht ab,
  // sondern werden gesammelt und dem Nutzer konkret benannt.
  const mRestAlle = useMutation({
    mutationFn: async (art) => {
      const items = restliste || [];
      const fehlgeschlagen = [];
      for (const r of items) {
        try {
          if (art === 'erneut') await api.migration.restErneut(run.id, r.postid);
          else if (art === 'ohneDatei') await api.migration.restOhneDatei(run.id, r.postid);
          else await api.migration.restLoeschen(run.id, r.postid);
        } catch (e) {
          fehlgeschlagen.push(`${r.postid}: ${e.message}`);
        }
      }
      return fehlgeschlagen;
    },
    onSuccess: (fehlgeschlagen) => {
      setAlleLoeschenFrage(false);
      setFehler(fehlgeschlagen.length > 0
        ? `${fehlgeschlagen.length} von der Sammelaktion nicht bearbeitet: ${fehlgeschlagen.join('; ')}`
        : '');
      qc.invalidateQueries({ queryKey: ['migration'] }); refetch();
    },
    onError: (e) => { setAlleLoeschenFrage(false); setFehler(e.message); },
  });

  // Universeller Abbruch: EIN Aufruf, egal ob gerade gezählt/kopiert wird oder
  // der Lauf schon steht. Solange die Antwort 'wird_angehalten' meldet, läuft
  // im Hintergrund noch der Worker – dann einfach erneut aufrufen, bis der
  // Rückbau tatsächlich passiert ist. Kein separater Polling-State nötig, die
  // Mutation bleibt für die ganze Dauer „isPending".
  const mAbbrechenVollstaendig = useMutation({
    mutationFn: async () => {
      let res = await api.migration.abbrechenVollstaendig(run.id);
      while (res.phase === 'wird_angehalten') {
        await new Promise((r) => setTimeout(r, 1200));
        res = await api.migration.abbrechenVollstaendig(run.id);
      }
      return res;
    },
    onSuccess: () => {
      setFehler(''); setAbbrechenFrage(false);
      qc.invalidateQueries({ queryKey: ['migration'] });
      navigate('/einstellungen?tab=onedrive');
    },
    onError: (e) => { setFehler(e.message); setAbbrechenFrage(false); },
  });

  const mTrennenQuelle = useMutation({
    mutationFn: () => (srcBackend === 'nextcloud' ? api.nextcloud.disconnect() : api.onedrive.disconnect()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['nextcloud-status'] });
      qc.invalidateQueries({ queryKey: ['onedrive-status'] });
      qc.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  const mNachzueglerPruefen = useMutation({
    mutationFn: () => api.migration.nachzueglerPruefen(run.id),
    onSuccess: (d) => { setFehler(''); setNachzuegler(d); },
    onError: (e) => setFehler(e.message),
  });
  const mNachzueglerAufnehmen = useMutation({
    mutationFn: () => api.migration.nachzueglerAufnehmen(run.id),
    onSuccess: () => {
      setFehler(''); setNachzuegler(null);
      qc.invalidateQueries({ queryKey: ['migration'] });
      navigate('/ablage-umzug/kopieren');
    },
    onError: (e) => setFehler(e.message),
  });
  const mUmschalten = useMutation({
    mutationFn: () => api.migration.umschalten(dstBackend),
    onSuccess: () => {
      setFehler(''); setUmschaltFrage(false);
      qc.invalidateQueries({ queryKey: ['settings'] });
      qc.invalidateQueries({ queryKey: ['migration'] });
      navigate('/ablage-umzug/abschluss');
    },
    onError: (e) => {
      setUmschaltFrage(false);
      if (e.payload?.nachzuegler) { setNachzuegler({ anzahl: e.payload.nachzuegler.anzahl, srcBackend, dstBackend }); return; }
      setFehler(e.message);
    },
  });

  // Nachzügler unmittelbar vor dem Umschalten IMMER frisch prüfen – nicht nur
  // beim Trockenlauf. Einmal pro Betreten des Schritts, nicht bei jedem Render.
  useEffect(() => {
    if (definition.id === 'umschalten' && run && ['abgeschlossen', 'abgeschlossen_mit_resten'].includes(run.status)) {
      setNachzuegler(null);
      mNachzueglerPruefen.mutate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [definition.id, run?.id]);

  const bereitsUmgeschaltet = !!run?.switched_at;
  const { data: aufraeumVorschau } = useQuery({
    queryKey: ['migration', 'aufraeumen', run?.id],
    queryFn: () => api.migration.aufraeumenVorschau(run.id),
    enabled: !!run?.id && bereitsUmgeschaltet && !run.cleaned_at,
  });
  const mAufraeumen = useMutation({
    mutationFn: () => api.migration.aufraeumen(run.id, aufraeumVorschau.anzahl),
    onSuccess: (d) => {
      setFehler(''); setAufraeumFrage(false); setAufraeumJobId(d.jobId);
      qc.invalidateQueries({ queryKey: ['migration'] }); refetch();
    },
    onError: (e) => { setFehler(e.message); setAufraeumFrage(false); },
  });
  const { data: aufraeumJob } = useQuery({
    queryKey: ['jobs', aufraeumJobId],
    queryFn: () => api.jobs.get(aufraeumJobId),
    enabled: !!aufraeumJobId,
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 800 : false),
  });
  useEffect(() => {
    if (aufraeumJob && aufraeumJob.status !== 'running') {
      setAufraeumJobId(null);
      qc.invalidateQueries({ queryKey: ['migration'] }); refetch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aufraeumJob?.status]);
  const mSchliessenOhneAufraeumen = useMutation({
    mutationFn: () => api.migration.abschliessenOhneAufraeumen(run.id),
    onSuccess: () => {
      setFehler(''); setSchliessenOhneAufraeumenFrage(false);
      qc.invalidateQueries({ queryKey: ['migration'] });
      navigate('/einstellungen?tab=onedrive');
    },
    onError: (e) => { setFehler(e.message); setSchliessenOhneAufraeumenFrage(false); },
  });

  const { data: restliste } = useQuery({
    queryKey: ['migration', 'restliste', run?.id],
    queryFn: () => api.migration.restliste(run.id),
    enabled: !!run?.id && offeneReste(run) > 0,
  });

  const stats = run?.stats || {};
  const c = run?.itemCounts || {};
  const gesamt = Object.values(c).reduce((a, b) => a + b, 0);
  const fertig = c.fertig || 0;
  const zurueckgebaut = c.zurueckgebaut || 0;
  const prozent = gesamt > 0 ? Math.round((fertig / gesamt) * 100) : 0;
  const reste = offeneReste(run);

  // Läuft gerade irgendein Hintergrund-Worker für DIESEN Lauf (Zählen oder
  // Kopieren)? Bestimmt den Text der Abbrechen-Rückfrage weiter unten.
  const aktivArbeitet = run?.status === 'laeuft' || trockenJob?.status === 'running';
  // Solange umgeschaltet/aufgeräumt ist, ist „Abbrechen" sinnlos (siehe
  // brichLaufVollstaendigAb() im Backend, das ab da ohnehin 409 wirft).
  const abbrechenMoeglich = !!run && !run.switched_at && !run.cleaned_at;

  const ZielKarte = dstBackend === 'nextcloud'
    ? <NextcloudCard />
    : <OneDriveSection settings={settings} onSaved={() => qc.invalidateQueries({ queryKey: ['settings'] })} />;

  // ── Schrittinhalte ───────────────────────────────────────────────────────

  function inhaltUeberblick() {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-center gap-4 rounded-xl border border-border/60 bg-muted/20 px-4 py-5">
          <div className="flex flex-col items-center gap-1.5">
            {srcBackend === 'nextcloud' ? <Server className="h-7 w-7 text-muted-foreground" /> : <Cloud className="h-7 w-7 text-muted-foreground" />}
            <span className="text-xs font-medium">{label(srcBackend)}</span>
          </div>
          <ArrowRight className="h-5 w-5 text-muted-foreground" />
          <div className="flex flex-col items-center gap-1.5">
            {dstBackend === 'nextcloud' ? <Server className="h-7 w-7 text-primary" /> : <Cloud className="h-7 w-7 text-primary" />}
            <span className="text-xs font-medium">{label(dstBackend)}</span>
          </div>
        </div>
        <p className="text-sm text-muted-foreground">
          Dieser Assistent kopiert alle Dokumente von {label(srcBackend)} nach {label(dstBackend)}.
          Die Originale in {label(srcBackend)} bleiben während des gesamten Umzugs unangetastet –
          gelöscht wird nichts von selbst, und solange noch nicht umgeschaltet wurde, lässt sich
          jeder Fortschritt in Schritt „Kopieren" auch wieder zurückdrehen.
        </p>
        {run && (
          <Testergebnis>
            Es läuft bereits ein Migrationslauf {label(run.src_backend)} → {label(run.dst_backend)}
            (Status: {run.status}). Weiter geht es beim nächsten Schritt.
          </Testergebnis>
        )}
        {!zielVerbunden && (
          <div className="flex gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-xs">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" />
            <span>Bevor es weitergehen kann, muss {label(dstBackend)} als zweite Dateiablage verbunden sein.</span>
          </div>
        )}
        {zielVerbunden && (
          <Testergebnis status="erfolg">{label(dstBackend)} ist verbunden.</Testergebnis>
        )}
        {/* Immer sichtbar, nicht nur solange unverbunden: sonst gibt es innerhalb
            des Assistenten keine Möglichkeit mehr, eine (z. B. noch von einem
            früheren Umzug übrig gebliebene) Verbindung zu trennen und neu
            aufzusetzen. */}
        <div className="space-y-3">{ZielKarte}</div>
      </div>
    );
  }

  function inhaltTrockenlauf() {
    const zaehltGerade = !!trockenJob && trockenJob.status === 'running';
    if (!run || zaehltGerade || run.status === 'vorbereitet') {
      const total = trockenJob?.totalSteps ?? trockenJob?.total_steps ?? 0;
      const step = trockenJob?.step ?? 0;
      const stepLabel = trockenJob?.stepLabel ?? trockenJob?.step_label ?? '';
      return (
        <div className="space-y-3">
          <div className="rounded-lg border border-border/60 px-3 py-2.5 space-y-2">
            <p className="text-xs font-medium flex items-center gap-2">
              <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${
                mVorbereiten.isSuccess ? 'bg-emerald-500/20 text-emerald-600' : 'border border-border text-muted-foreground'}`}>
                {mVorbereiten.isSuccess ? <Check className="h-3 w-3" /> : '1'}
              </span>
              Ordnerstruktur in {label(dstBackend)} anlegen
            </p>
            {!mVorbereiten.isSuccess ? (
              <div className="space-y-2 pl-7">
                <p className="text-xs text-muted-foreground">
                  Vorhandene Ordner werden dabei nie überschrieben, nur gefunden – und das wird hier
                  bei jedem Lauf frisch geprüft, auch wenn zuvor schon einmal eine Ordnerstruktur
                  angelegt wurde. So fällt sofort auf, wenn draußen etwas gelöscht wurde.
                </p>
                <div className="flex items-end gap-2">
                  <div className="flex-1 space-y-1">
                    <label className="text-xs text-muted-foreground">Wurzelordner in {label(dstBackend)}</label>
                    <Input value={zielRootPath} onChange={(e) => setZielRootPath(e.target.value)}
                      placeholder={zielWurzelQuery.isPending ? 'wird gelesen…' : 'z. B. postbuch'}
                      className="h-8 text-sm font-mono" />
                  </div>
                  <Button size="sm" variant="outline" disabled={mVorbereiten.isPending || zielWurzelQuery.isPending}
                    onClick={() => mVorbereiten.mutate()}>
                    {mVorbereiten.isPending ? <Spinner className="h-3.5 w-3.5" /> : null}
                    Ordner anlegen
                  </Button>
                </div>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground pl-7">
                {mVorbereiten.data.anzahl} Ordner bereit ({mVorbereiten.data.neu} neu angelegt) unter „{mVorbereiten.data.rootPath}".
              </p>
            )}
          </div>

          <div className="rounded-lg border border-border/60 px-3 py-2.5 space-y-2">
            <p className="text-xs font-medium flex items-center gap-2">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-border text-[10px] font-semibold text-muted-foreground">2</span>
              Trockenlauf starten
            </p>
            <p className="text-xs text-muted-foreground pl-7">
              Zählt nur und erfasst dabei <strong className="text-foreground">immer den gesamten
              Bestand</strong> in {label(srcBackend)}. Es wird nichts kopiert und nichts geändert.
            </p>
            {zaehltGerade ? (
              <div className="pl-7 space-y-1.5">
                <Progress value={total > 0 ? Math.round((step / total) * 100) : 0} indeterminate={!total} className="h-2" />
                <p className="text-xs text-muted-foreground">{stepLabel || 'wird gezählt…'}</p>
              </div>
            ) : (
              <div className="pl-7 space-y-1.5">
                {!mVorbereiten.isSuccess && (
                  <p className="text-xs text-amber-600">Erst Schritt 1 abschließen – danach lässt sich der Trockenlauf starten.</p>
                )}
                <Button size="sm" disabled={!mVorbereiten.isSuccess || mTrocken.isPending} onClick={() => mTrocken.mutate()}>
                  {mTrocken.isPending ? <Spinner className="h-3.5 w-3.5" /> : null}Trockenlauf starten
                </Button>
              </div>
            )}
          </div>
        </div>
      );
    }
    return (
      <div className="space-y-3">
        <div className="rounded-lg border border-border/60 px-3 py-2.5 text-xs text-muted-foreground space-y-0.5">
          <div>{stats.bereit ?? 0} Dokument(e) bereit zum Kopieren</div>
          {stats.ohneDatei > 0 && <div>{stats.ohneDatei} ohne Datei (nichts zu kopieren)</div>}
          {stats.keinZielordner > 0 && <div className="text-amber-600">{stats.keinZielordner} ohne Zielordner</div>}
          {(stats.bleibtZurueck?.fehlgeschlageneDokumente > 0 || stats.bleibtZurueck?.pausierteDuplikate > 0) && (
            <div className="pt-1">
              Bleibt in {label(run.src_backend)}: {stats.bleibtZurueck.fehlgeschlageneDokumente} fehlgeschlagene,
              {' '}{stats.bleibtZurueck.pausierteDuplikate} pausierte Duplikate.
            </div>
          )}
        </div>
        <Testergebnis status="erfolg">
          Der Trockenlauf ist erledigt. Weiter geht's im nächsten Schritt „Kopieren".
        </Testergebnis>
      </div>
    );
  }

  function inhaltKopieren() {
    if (!run) {
      return <Testergebnis>Noch kein Lauf gestartet – zurück zu Schritt „Trockenlauf".</Testergebnis>;
    }
    if (run.status === 'vorbereitet') {
      return <Testergebnis>Der Trockenlauf ist noch nicht abgeschlossen – zurück zu Schritt „Trockenlauf".</Testergebnis>;
    }
    if (run.status === 'trockenlauf') {
      return (
        <div className="space-y-3">
          <div className="rounded-lg border border-border/60 px-3 py-2.5 text-xs text-muted-foreground space-y-0.5">
            <div>{stats.bereit ?? 0} Dokument(e) bereit zum Kopieren</div>
            {stats.ohneDatei > 0 && <div>{stats.ohneDatei} ohne Datei (nichts zu kopieren)</div>}
            {stats.keinZielordner > 0 && <div className="text-amber-600">{stats.keinZielordner} ohne Zielordner</div>}
            {(stats.bleibtZurueck?.fehlgeschlageneDokumente > 0 || stats.bleibtZurueck?.pausierteDuplikate > 0) && (
              <div className="pt-1">
                Bleibt in {label(run.src_backend)}: {stats.bleibtZurueck.fehlgeschlageneDokumente} fehlgeschlagene,
                {' '}{stats.bleibtZurueck.pausierteDuplikate} pausierte Duplikate.
              </div>
            )}
          </div>
          <label className="flex items-start gap-2 text-xs cursor-pointer">
            <input type="checkbox" checked={bestaetigt} className="mt-0.5" onChange={(e) => setBestaetigt(e.target.checked)} />
            <span>
              Mir ist klar, dass Dateien nach {label(run.dst_backend)} kopiert werden. Die Originale
              bleiben erhalten; solange nicht umgeschaltet ist, lässt sich der Lauf zurückdrehen.
            </span>
          </label>
          <Button disabled={!bestaetigt || mStart.isPending} onClick={() => mStart.mutate()}>
            {mStart.isPending ? <Spinner className="h-3.5 w-3.5" /> : <PlayCircle className="h-3.5 w-3.5" />}
            {mStart.isPending ? 'wird gestartet…' : 'Kopieren starten'}
          </Button>
        </div>
      );
    }
    return (
      <div className="space-y-4">
        <div className="rounded-lg border border-border/60 px-3 py-2.5 space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium">{label(run.src_backend)} → {label(run.dst_backend)}</span>
            <Badge variant="secondary" className="text-[10px]">{run.status}</Badge>
          </div>
          <Progress value={prozent} className="h-2" />
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>{fertig} / {gesamt} kopiert{zurueckgebaut > 0 ? ` · ${zurueckgebaut} zurückgebaut` : ''}</span>
            {reste > 0 && <span className="text-amber-600">{reste} offen</span>}
          </div>
        </div>

        {run.status === 'laeuft' && (
          <div className="space-y-2">
            <Button variant="outline" onClick={() => mPausieren.mutate()}>
              <PauseCircle className="h-3.5 w-3.5" />Pausieren
            </Button>
            <p className="text-xs text-muted-foreground">
              Pausieren ist sicher und jederzeit fortsetzbar – bereits kopierte Dateien bleiben auf
              beiden Dateiablagen, nichts wird gelöscht.
            </p>
          </div>
        )}

        {run.status === 'pausiert' && (
          <Button onClick={() => mStart.mutate()}><PlayCircle className="h-3.5 w-3.5" />Fortsetzen</Button>
        )}

        {reste > 0 && restliste?.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="text-xs font-medium">Nicht übertragen ({reste})</div>
              <div className="flex flex-wrap gap-1.5">
                <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" disabled={mRestAlle.isPending}
                  onClick={() => mRestAlle.mutate('erneut')}>
                  {mRestAlle.isPending ? <Spinner className="h-3 w-3" /> : <RefreshCw className="h-3 w-3" />}Alle erneut
                </Button>
                <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" disabled={mRestAlle.isPending}
                  onClick={() => mRestAlle.mutate('ohneDatei')}>
                  <FileX className="h-3 w-3" />Alle ohne Datei
                </Button>
                <Button size="sm" variant="destructive" className="h-6 px-2 text-[11px]" disabled={mRestAlle.isPending}
                  onClick={() => setAlleLoeschenFrage(true)}>
                  <Trash2 className="h-3 w-3" />Alle löschen
                </Button>
              </div>
            </div>
            {alleLoeschenFrage && (
              <Rueckfrage
                gefahr
                frage={`${reste} Datensätze unwiderruflich löschen?`}
                bestaetigen="Endgültig alle löschen"
                abbrechen="Abbrechen"
                laeuft={mRestAlle.isPending}
                onBestaetigen={() => mRestAlle.mutate('loeschen')}
                onAbbrechen={() => setAlleLoeschenFrage(false)}
              />
            )}
            <div className="space-y-1.5 max-h-64 overflow-y-auto">
              {restliste.map((r) => (
                <div key={r.postid} className="rounded border border-border/60 px-2.5 py-2 text-xs space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono">{r.postid}</span>
                    <Badge variant="outline" className="text-[10px]">{r.status}</Badge>
                  </div>
                  <div className="text-muted-foreground truncate">{r.betreff || r.src_name || '–'}</div>
                  {r.fehler_text && <div className="text-destructive">{r.fehler_text}</div>}
                  <div className="flex flex-wrap gap-1.5 pt-0.5">
                    <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => mRest.mutate({ art: 'erneut', postid: r.postid })}>
                      <RefreshCw className="h-3 w-3" />Erneut
                    </Button>
                    <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => mRest.mutate({ art: 'ohneDatei', postid: r.postid })}>
                      <FileX className="h-3 w-3" />Ohne Datei
                    </Button>
                    <Button size="sm" variant="destructive" className="h-6 px-2 text-[11px]" onClick={() => setLoeschDialog(r.postid)}>
                      <Trash2 className="h-3 w-3" />Löschen
                    </Button>
                  </div>
                  {loeschDialog === r.postid && (
                    <Rueckfrage
                      gefahr
                      frage={`Datensatz ${r.postid} unwiderruflich löschen?`}
                      bestaetigen="Endgültig löschen"
                      abbrechen="Abbrechen"
                      onBestaetigen={() => { mRest.mutate({ art: 'loeschen', postid: r.postid }); setLoeschDialog(null); }}
                      onAbbrechen={() => setLoeschDialog(null)}
                    />
                  )}
                </div>
              ))}
            </div>
            <Button size="sm" variant="outline" onClick={() => mAbschliessen.mutate()}>Trotzdem abschließen</Button>
          </div>
        )}

        {['abgeschlossen', 'abgeschlossen_mit_resten'].includes(run.status) && (
          <Testergebnis status="erfolg">
            Lauf beendet – {fertig} Dokument(e) liegen jetzt in {label(run.dst_backend)}. Weiter geht's beim Umschalten.
          </Testergebnis>
        )}
      </div>
    );
  }

  function inhaltUmschalten() {
    if (!run || !['abgeschlossen', 'abgeschlossen_mit_resten'].includes(run.status)) {
      return <Testergebnis>Der Kopiervorgang ist noch nicht abgeschlossen – zurück zu Schritt „Kopieren".</Testergebnis>;
    }
    // run.status bleibt nach dem Umschalten unverändert (nur switched_at/cleaned_at
    // laufen weiter) – ohne diese Prüfung würde ein erneuter Besuch dieses Schritts
    // (z. B. über die Seitenleiste oder einen alten Link) wieder den Nachzügler-Check
    // und den Umschalt-Button anbieten, obwohl längst umgeschaltet ist.
    if (run.switched_at) {
      return (
        <Testergebnis status="erfolg">
          Bereits umgeschaltet – aktive Dateiablage ist {label(run.dst_backend)}. Weiter geht's beim Abschluss.
        </Testergebnis>
      );
    }
    const pruefungLaeuft = mNachzueglerPruefen.isPending;
    const nachzueglerOffen = nachzuegler && nachzuegler.anzahl > 0;
    return (
      <div className="space-y-4">
        <div className="rounded-lg border border-border/60 px-3 py-2.5 text-xs space-y-1">
          <div className="flex items-center gap-2 font-medium">
            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
            {fertig} Dokument(e) liegen in {label(run.dst_backend)}. Neue Dokumente landen weiterhin
            in {label(aktiv)}, bis umgeschaltet wird.
          </div>
        </div>

        <div className="rounded-lg border border-border/60 px-3 py-2.5 space-y-2">
          <p className="text-xs font-medium">Nachzügler-Prüfung</p>
          <p className="text-xs text-muted-foreground">
            Unmittelbar vor dem Umschalten wird noch einmal geprüft, ob in {label(run.src_backend)}
            Dokumente liegen, die nicht Teil dieses Laufs sind (z. B. seither neu gescannt).
          </p>
          {pruefungLaeuft && <div className="flex items-center gap-2 text-xs text-muted-foreground"><Spinner className="h-3.5 w-3.5" />wird geprüft…</div>}
          {!pruefungLaeuft && nachzuegler && !nachzueglerOffen && (
            <Testergebnis status="erfolg">Alle Dokumente sind Teil dieses Laufs.</Testergebnis>
          )}
          {!pruefungLaeuft && nachzueglerOffen && (
            <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/[0.07] p-3">
              <p className="text-xs">
                <strong>{nachzuegler.anzahl}</strong> Dokument(e) in {label(run.src_backend)} sind
                noch nicht Teil dieses Laufs. Das Umschalten bleibt gesperrt, bis sie mit
                übernommen wurden.
              </p>
              <Button size="sm" disabled={mNachzueglerAufnehmen.isPending} onClick={() => mNachzueglerAufnehmen.mutate()}>
                {mNachzueglerAufnehmen.isPending ? <Spinner className="h-3.5 w-3.5" /> : null}
                Automatisch aufnehmen und weiter kopieren
              </Button>
            </div>
          )}
          {!pruefungLaeuft && !nachzuegler && (
            <Button size="sm" variant="outline" onClick={() => mNachzueglerPruefen.mutate()}>Jetzt prüfen</Button>
          )}
        </div>

        {!nachzueglerOffen && !pruefungLaeuft && nachzuegler && (
          <div className="rounded-lg border border-border/60 px-3 py-2.5 space-y-2">
            <p className="text-xs text-muted-foreground">
              Ab jetzt landen <strong className="text-foreground">neue</strong> Dokumente in {label(run.dst_backend)}.
              Bereits vorhandene Dokumente bleiben, wo sie liegen – beide Gruppen bleiben lesbar.
            </p>
            {!umschaltFrage ? (
              <Button onClick={() => setUmschaltFrage(true)}>Aktive Dateiablage auf {label(run.dst_backend)} umschalten</Button>
            ) : (
              <Rueckfrage
                frage={`${label(run.dst_backend)} wirklich zur aktiven Dateiablage machen?`}
                bestaetigen="Ja, umschalten"
                abbrechen="Abbrechen"
                laeuft={mUmschalten.isPending}
                onBestaetigen={() => mUmschalten.mutate()}
                onAbbrechen={() => setUmschaltFrage(false)}
              />
            )}
          </div>
        )}
      </div>
    );
  }

  function inhaltAbschluss() {
    if (!run?.switched_at) {
      return <Testergebnis>Noch nicht umgeschaltet – zurück zu Schritt „Umschalten".</Testergebnis>;
    }
    const raeumtGerade = !!aufraeumJobId;
    const totalA = aufraeumJob?.totalSteps ?? aufraeumJob?.total_steps ?? 0;
    const stepA = aufraeumJob?.step ?? 0;
    const stepLabelA = aufraeumJob?.stepLabel ?? aufraeumJob?.step_label ?? '';
    return (
      <div className="space-y-4">
        <Testergebnis status="erfolg">
          {label(run.dst_backend)} ist jetzt die aktive Dateiablage. Der Umzug ist inhaltlich abgeschlossen.
        </Testergebnis>

        <div className="rounded-lg border border-border/60 px-3 py-2.5 space-y-2">
          <p className="text-xs font-medium">Quelldateien in {label(run.src_backend)} aufräumen</p>
          <p className="text-xs text-muted-foreground">
            Verifizierte Kopien werden in {label(run.src_backend)} in den <span className="font-mono">_trash</span>-Ordner
            verschoben – nicht endgültig gelöscht. Optional, jederzeit später nachholbar.
          </p>
          {run.cleaned_at && <Testergebnis status="erfolg">Bereits aufgeräumt.</Testergebnis>}
          {!run.cleaned_at && raeumtGerade && (
            <div className="space-y-1.5">
              <Progress value={totalA > 0 ? Math.round((stepA / totalA) * 100) : 0} indeterminate={!totalA} className="h-2" />
              <p className="text-xs text-muted-foreground">{stepLabelA || 'wird aufgeräumt…'}</p>
            </div>
          )}
          {!run.cleaned_at && !raeumtGerade && aufraeumVorschau && aufraeumVorschau.anzahl > 0 && (
            <>
              <p className="text-xs">
                <strong>{aufraeumVorschau.anzahl}</strong> Quelldatei(en) könnten in den Papierkorb.
                {aufraeumVorschau.geschuetzt > 0 && <> {aufraeumVorschau.geschuetzt} bleiben liegen (offene Duplikat-/Fehlerentscheidung).</>}
              </p>
              {!aufraeumFrage ? (
                <Button variant="destructive" onClick={() => setAufraeumFrage(true)}>
                  <Trash2 className="h-3.5 w-3.5" />Quelldateien aufräumen
                </Button>
              ) : (
                <Rueckfrage
                  gefahr
                  frage={`${aufraeumVorschau.anzahl} Quelldatei(en) in den Papierkorb verschieben?`}
                  bestaetigen="Ja, in den Papierkorb"
                  abbrechen="Abbrechen"
                  laeuft={mAufraeumen.isPending}
                  onBestaetigen={() => mAufraeumen.mutate()}
                  onAbbrechen={() => setAufraeumFrage(false)}
                />
              )}
            </>
          )}
          {!run.cleaned_at && !raeumtGerade && aufraeumVorschau && aufraeumVorschau.anzahl === 0 && (
            <p className="text-xs text-muted-foreground">Nichts mehr aufzuräumen.</p>
          )}
        </div>

        <div className="rounded-lg border-2 border-amber-500/40 bg-amber-500/8 px-4 py-3 space-y-1.5">
          <p className="text-sm font-semibold text-amber-700 dark:text-amber-500 flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" />Noch zu erledigen: {label(run.src_backend)} selbst leeren
          </p>
          <p className="text-xs leading-relaxed text-amber-700/90 dark:text-amber-400/90">
            postbuch.net verschiebt Quelldateien nur in den Papierkorb von {label(run.src_backend)} –
            gelöscht wird dort nie endgültig etwas. Um den Speicherplatz wirklich freizugeben (z. B.
            den Papierkorb in {label(run.src_backend)} zu leeren oder ein nicht mehr gebrauchtes
            Konto zu kündigen), musst du selbst in {label(run.src_backend)} aktiv werden.
          </p>
        </div>

        {run.cleaned_at && srcVerbunden && (
          <div className="rounded-lg border border-border/60 px-3 py-2.5 space-y-2">
            <p className="text-xs font-medium">Verbindung zu {label(run.src_backend)} trennen?</p>
            <p className="text-xs text-muted-foreground">
              Der Umzug ist abgeschlossen und aufgeräumt – postbuch.net braucht die Verbindung zu{' '}
              {label(run.src_backend)} jetzt nicht mehr. Sie lässt sich auch später jederzeit unter
              Einstellungen → Dateiablage trennen.
            </p>
            <Button size="sm" variant="outline" onClick={() => mTrennenQuelle.mutate()} disabled={mTrennenQuelle.isPending}>
              {mTrennenQuelle.isPending ? <Spinner className="h-3.5 w-3.5 mr-1.5" /> : <Unlink2 className="h-3.5 w-3.5 mr-1.5" />}
              Verbindung zu {label(run.src_backend)} trennen
            </Button>
            {mTrennenQuelle.isError && <p className="text-xs text-destructive">{mTrennenQuelle.error?.message}</p>}
          </div>
        )}

        {run.cleaned_at ? (
          <Button onClick={() => navigate('/einstellungen?tab=onedrive')}>Fertig – zurück zu den Einstellungen</Button>
        ) : (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" onClick={() => navigate('/einstellungen?tab=onedrive')}>Jetzt nicht</Button>
              {!schliessenOhneAufraeumenFrage && (
                <Button variant="ghost" size="sm" className="text-muted-foreground"
                  onClick={() => setSchliessenOhneAufraeumenFrage(true)}>
                  Aufräumen dauerhaft überspringen
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              „Jetzt nicht" merkt sich den Umzug – der Hinweis dazu bleibt im Dashboard, bis
              aufgeräumt wird oder du das dauerhaft überspringst.
            </p>
            {schliessenOhneAufraeumenFrage && (
              <Rueckfrage
                text={`Die Quelldateien in ${label(run.src_backend)} bleiben dann unangetastet liegen – der Hinweis dazu verschwindet danach dauerhaft aus dem Dashboard.`}
                frage="Aufräumen wirklich dauerhaft überspringen?"
                bestaetigen="Ja, dauerhaft überspringen"
                abbrechen="Doch nicht"
                laeuft={mSchliessenOhneAufraeumen.isPending}
                onBestaetigen={() => mSchliessenOhneAufraeumen.mutate()}
                onAbbrechen={() => setSchliessenOhneAufraeumenFrage(false)}
              />
            )}
          </div>
        )}
      </div>
    );
  }

  const INHALT = {
    ueberblick: inhaltUeberblick,
    trockenlauf: inhaltTrockenlauf,
    kopieren: inhaltKopieren,
    umschalten: inhaltUmschalten,
    abschluss: inhaltAbschluss,
  };

  function schrittZustand(def) {
    // run ist bereits null, sobald der letzte Lauf historisch ist (siehe oben)
    // – ein Neustart zeigt dann konsequent überall „noch nichts getan", auch
    // im Abschluss-Schritt, statt dort weiter grün den alten Stand zu zeigen.
    if (!run) return def.id === 'ueberblick' ? 'neutral' : 'gesperrt';
    const i = SCHRITTE.findIndex((s) => s.id === def.id);
    const e = SCHRITTE.findIndex((s) => s.id === empfohlen);
    if (i < e) return 'ok';
    return 'neutral';
  }

  function weiter() {
    if (aktuell < SCHRITTE.length - 1) navigate(`/ablage-umzug/${SCHRITTE[aktuell + 1].id}`);
  }

  const fortschritt = Math.round(((aktuell + 1) / SCHRITTE.length) * 100);
  const weiterGesperrt = (definition.id === 'ueberblick' && !zielVerbunden)
    || (definition.id === 'trockenlauf' && (!run || run.status === 'vorbereitet'))
    || (definition.id === 'kopieren' && (!run || !['abgeschlossen', 'abgeschlossen_mit_resten'].includes(run.status)))
    || (definition.id === 'umschalten' && !run?.switched_at);

  return (
    <div className="min-h-screen bg-gradient-to-b from-muted/40 to-background">
      <header className="sticky top-0 z-20 border-b bg-background/85 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-3 py-2.5 sm:px-6">
          <Logo size={34} />
          <div className="min-w-0">
            <p className="text-sm font-semibold leading-tight">Dateiablage umziehen</p>
            <p className="text-[11px] text-muted-foreground leading-tight">Schritt {aktuell + 1} von {SCHRITTE.length}</p>
          </div>
          {!schliessenFrage ? (
            <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setSchliessenFrage(true)}>
              <X className="h-4 w-4 mr-1" /><span className="hidden sm:inline">Schließen</span>
            </Button>
          ) : (
            <div className="ml-auto flex items-center gap-2 text-xs">
              <span className="text-muted-foreground hidden sm:inline">Fortschritt bleibt erhalten.</span>
              <Button size="sm" onClick={() => navigate('/einstellungen?tab=onedrive')}>Ja, schließen</Button>
              <Button size="sm" variant="outline" onClick={() => setSchliessenFrage(false)}>Weiter hier</Button>
            </div>
          )}
        </div>
        <div className="h-0.5 w-full bg-muted">
          <div className="h-full bg-primary transition-all duration-300" style={{ width: `${fortschritt}%` }} />
        </div>
      </header>

      {abbrechenMoeglich && (
        <div className="mx-auto max-w-6xl px-3 pt-3 sm:px-6">
          {!abbrechenFrage ? (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs">
              <span className="text-muted-foreground">
                {aktivArbeitet
                  ? 'Läuft gerade – lässt sich jederzeit anhalten und vollständig zurückbauen.'
                  : `Lässt sich jederzeit vollständig zurückbauen – ${label(srcBackend)} bleibt dann die aktive Dateiablage.`}
              </span>
              <Button size="sm" variant="ghost" className="shrink-0 text-destructive hover:text-destructive" onClick={() => setAbbrechenFrage(true)}>
                <Ban className="h-3.5 w-3.5 mr-1" />Umzug abbrechen
              </Button>
            </div>
          ) : (
            <Rueckfrage
              gefahr
              text={aktivArbeitet
                ? `Der Umzug wird zuerst angehalten. Alle bereits nach ${label(dstBackend)} kopierten Dokumente werden danach wieder zurückgebaut.`
                : `Alle bereits nach ${label(dstBackend)} kopierten Dokumente werden zurückgebaut.`}
              frage={`Umzug wirklich abbrechen? ${label(srcBackend)} bleibt die aktive Dateiablage.`}
              bestaetigen="Ja, abbrechen und zurückbauen"
              abbrechen="Doch nicht"
              laeuft={mAbbrechenVollstaendig.isPending}
              onBestaetigen={() => mAbbrechenVollstaendig.mutate()}
              onAbbrechen={() => setAbbrechenFrage(false)}
            />
          )}
        </div>
      )}

      <div className="mx-auto max-w-6xl gap-6 px-3 py-4 sm:px-6 sm:py-6 lg:grid lg:grid-cols-[15rem_minmax(0,1fr)]">
        <nav aria-label="Umzugsschritte" className="mb-4 lg:mb-0">
          <ol className="flex gap-1.5 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible lg:pb-0">
            {SCHRITTE.map((s, i) => {
              const zustand = schrittZustand(s);
              const aktivSchritt = i === aktuell;
              return (
                <li key={s.id} className="shrink-0 lg:shrink">
                  <button type="button" onClick={() => navigate(`/ablage-umzug/${s.id}`)} aria-current={aktivSchritt ? 'step' : undefined}
                    className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors ${
                      aktivSchritt ? 'bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'}`}>
                    <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold ${
                      zustand === 'ok' ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                        : aktivSchritt ? 'border-primary text-primary' : 'border-border'}`}>
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
              <CardTitle className="text-lg">{definition.titel}</CardTitle>
              <CardDescription>{definition.unter}</CardDescription>
            </CardHeader>
            <CardContent className="pt-5 space-y-4">
              {fehler && (
                <div className="flex gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-xs">
                  <XCircle className="h-4 w-4 shrink-0 text-destructive" /><span>{fehler}</span>
                </div>
              )}
              {INHALT[definition.id]()}
            </CardContent>
          </Card>

          <footer className="mt-4 flex flex-wrap items-center justify-between gap-2">
            <Button variant="outline" onClick={() => navigate(`/ablage-umzug/${SCHRITTE[Math.max(0, aktuell - 1)].id}`)} disabled={aktuell === 0}>
              <ArrowLeft className="h-4 w-4 mr-1.5" />Zurück
            </Button>
            {definition.id !== 'abschluss' && (
              <Button onClick={weiter} disabled={weiterGesperrt}>Weiter<ArrowRight className="h-4 w-4 ml-1.5" /></Button>
            )}
          </footer>
        </main>
      </div>
    </div>
  );
}
