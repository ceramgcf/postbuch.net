/**
 * EingangDetailPage.jsx – ein offener Eingang: PDF ansehen und behandeln
 *
 * Route: /import/eingang/:schluessel
 *
 * Welche Aktionen möglich sind, sagt der Server (`aktionen`). Nach „Neu
 * auslösen“ oder „Manuell ablegen“ folgt die Seite dem gestarteten Lauf, bis
 * der Eingang als Dokument abgelegt ist oder erneut scheitert.
 *
 * Ein Dokumentenstapel (Schlüssel „t:<id>“) hat eine eigene Trennansicht
 * (BriefstapelPage).
 */
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, CheckCircle2, FileText, Lightbulb, ListChecks, PenLine, RefreshCw, Trash2, GitCompareArrows,
} from 'lucide-react';
import { api } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Dialog, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog';
import { PdfInlineViewer } from '@/components/ui/pdf-inline-viewer';
import ManuellAblegenFormular, { leeresFormular } from '@/components/import/ManuellAblegenFormular';
import BriefstapelPage from '@/pages/BriefstapelPage';
import { useAuth } from '@/hooks/useAuth';
import { useDarstellung } from '@/hooks/useDarstellung';
import { useZurueckZiel } from '@/hooks/useBackButtonGuard';
import { SeitenLeiste, useSeitenTitel } from '@/hooks/useSeite';
import { OFFENE_EINGAENGE_KEY } from '@/hooks/useOffeneEingaenge';
import { gruppeVon, zustandText, herkunftText, zeitText, grundZeile, duplikatPfad } from '@/lib/eingang';

const ZURUECK = '/import?tab=eingang';

function AnsichtUmschalter({ ansicht, onWechsel }) {
  const knopf = (wert, Icon, label) => (
    <button
      type="button" role="tab" aria-selected={ansicht === wert}
      onClick={() => onWechsel(wert)}
      className={`flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium transition-colors ${
        ansicht === wert ? 'bg-background text-primary shadow-sm' : 'text-muted-foreground'
      }`}
    >
      <Icon className="h-4 w-4" />
      {label}
    </button>
  );
  return (
    <div role="tablist" aria-label="Ansicht" className="mx-auto flex rounded-full bg-muted p-0.5">
      {knopf('daten', ListChecks, 'Eingang')}
      {knopf('dokument', FileText, 'Dokument')}
    </div>
  );
}

function Zeile({ label, children }) {
  if (children == null || children === '') return null;
  return (
    <div className="grid grid-cols-[8.5rem_1fr] gap-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

/** Der Eingang ist als Dokument abgelegt: tatsächlichen Namen zeigen. */
function AbgelegtHinweis({ postid }) {
  const { data } = useQuery({
    queryKey: ['postbuch', 'dateiname', postid],
    queryFn: () => api.postbuch.dateiname.get(postid),
    retry: false,
  });
  return (
    <div className="space-y-3 rounded-xl border border-emerald-300 bg-emerald-50 p-4 dark:border-emerald-800 dark:bg-emerald-950/30">
      <p className="flex items-center gap-2 font-semibold text-emerald-800 dark:text-emerald-200">
        <CheckCircle2 className="h-5 w-5" />
        Als Dokument {postid} abgelegt
      </p>
      {data?.dateiname && (
        <p className="break-words text-sm text-emerald-900 dark:text-emerald-100">
          Dateiname in der Ablage: <span className="font-medium">{data.dateiname}</span>
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Link to={`/postbuch/${postid}`}><Button size="sm">Dokument öffnen</Button></Link>
        <Link to={ZURUECK}><Button size="sm" variant="outline">Zum Eingang</Button></Link>
      </div>
    </div>
  );
}

export default function EingangDetailPage() {
  const { schluessel } = useParams();
  if (schluessel?.startsWith('t:')) return <BriefstapelPage key={schluessel} id={schluessel.slice(2)} />;
  return <EingangDetail key={schluessel} schluessel={schluessel} />;
}

function EingangDetail({ schluessel }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { canWrite } = useAuth();
  const { istMobil } = useDarstellung();
  useSeitenTitel('Eingang');
  useZurueckZiel(true, () => navigate(ZURUECK));

  // Nach einer eigenen Aktion läuft der Eingang als Auftrag weiter.
  const [verfolgt, setVerfolgt] = useState(null); // 'a:<jobId>'
  const [verfolgtSeit, setVerfolgtSeit] = useState(0);
  const [hinweis, setHinweis] = useState(null);
  const [aktionsFehler, setAktionsFehler] = useState(null);
  const [formularOffen, setFormularOffen] = useState(false);
  const [formular, setFormular] = useState(null);
  const [formularFehler, setFormularFehler] = useState(null);
  const [verwerfenOffen, setVerwerfenOffen] = useState(false);
  const [verworfen, setVerworfen] = useState(false);
  const [ansicht, setAnsicht] = useState('daten');

  const aktiv = verfolgt || schluessel;
  const { data: eintrag, error, isLoading, dataUpdatedAt } = useQuery({
    queryKey: ['eingang', aktiv],
    queryFn: () => api.eingang.get(aktiv),
    retry: false,
    enabled: !verworfen,
    refetchInterval: (q) => {
      if (q.state.error) return false;
      const d = q.state.data;
      const inArbeit = d?.gruppe === 'verarbeitung' || d?.zustand === 'eingereiht';
      return inArbeit || q.state.dataUpdatedAt <= verfolgtSeit ? 3_000 : 30_000;
    },
  });

  const weg = error?.status === 404;
  const abgelegtAls = weg ? error.payload?.postid || null : null;
  const weiterAls = weg ? error.payload?.weiter || null : null;

  // Der verfolgte Lauf wartet jetzt als anderer Eintrag (etwa auf eine
  // Duplikatentscheidung): diesem folgen.
  useEffect(() => {
    if (weiterAls && weiterAls !== aktiv) setVerfolgt(weiterAls);
  }, [weiterAls, aktiv]);

  // Der verfolgte Lauf ist ohne Dokument zu Ende gegangen: zurück zum
  // ursprünglichen Eintrag, dort steht der neue Fehler.
  useEffect(() => {
    if (weg && !abgelegtAls && !weiterAls && verfolgt && verfolgt !== schluessel) {
      setVerfolgt(null);
      setHinweis('Der Lauf ist ohne Ergebnis zu Ende gegangen. Der Eingang steht weiter zur Verfügung.');
    }
  }, [weg, abgelegtAls, weiterAls, verfolgt, schluessel]);

  useEffect(() => {
    if (eintrag && !formular) setFormular(leeresFormular());
  }, [eintrag, formular]);

  const nachAktion = () => {
    queryClient.invalidateQueries({ queryKey: OFFENE_EINGAENGE_KEY });
    queryClient.invalidateQueries({ queryKey: ['failed-documents'] });
  };
  const folge = (jobId) => {
    setVerfolgtSeit(Date.now());
    setVerfolgt(`a:${jobId}`);
    queryClient.invalidateQueries({ queryKey: ['eingang'] });
    nachAktion();
  };
  const beiFehler = (setzer) => (err) => {
    setzer(err.message);
    // Konflikt: Der Eingang hat sich geändert – Stand neu laden, Eingaben bleiben.
    if (err.status === 409 || err.status === 404) {
      queryClient.invalidateQueries({ queryKey: ['eingang'] });
      nachAktion();
    }
  };

  const neuAusloesen = useMutation({
    mutationFn: () => api.eingang.neuAusloesen(aktiv),
    onMutate: () => { setAktionsFehler(null); setHinweis(null); },
    onSuccess: ({ jobId }) => folge(jobId),
    onError: beiFehler(setAktionsFehler),
  });
  const manuellAblegen = useMutation({
    mutationFn: () => api.eingang.manuellAblegen(aktiv, {
      lebensbereich: formular.lebensbereich,
      dokumentart: formular.dokumentart,
      briefdatum: formular.briefdatum || null,
      name: formular.name,
      istRechnung: formular.istRechnung,
    }),
    onMutate: () => { setFormularFehler(null); setHinweis(null); },
    onSuccess: ({ jobId }) => folge(jobId),
    onError: beiFehler(setFormularFehler),
  });
  const verwerfen = useMutation({
    mutationFn: () => api.eingang.verwerfen(aktiv),
    onMutate: () => setAktionsFehler(null),
    onSuccess: () => { setVerwerfenOffen(false); setVerworfen(true); nachAktion(); },
    onError: (err) => { setVerwerfenOffen(false); beiFehler(setAktionsFehler)(err); },
  });

  const beschaeftigt = neuAusloesen.isPending || manuellAblegen.isPending || verwerfen.isPending;
  // Bis zur ersten Antwort nach einer Aktion gilt der alte Stand nicht mehr.
  const laeuft = eintrag?.gruppe === 'verarbeitung' || eintrag?.zustand === 'eingereiht'
    || dataUpdatedAt <= verfolgtSeit;
  const aktionen = canWrite && !laeuft ? (eintrag?.aktionen ?? []) : [];
  const kann = (a) => aktionen.includes(a);

  const zurueck = (
    <Link to={ZURUECK}>
      <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" />
        Eingang
      </Button>
    </Link>
  );

  if (verworfen) {
    return (
      <div className="mx-auto max-w-2xl space-y-4 p-4 md:p-6">
        {zurueck}
        <div className="space-y-3 rounded-xl border border-border/70 bg-card p-4">
          <p className="font-semibold">Eingang verworfen</p>
          <p className="text-sm text-muted-foreground">Das PDF liegt im Papierkorb der Ablage.</p>
          <Link to={ZURUECK}><Button size="sm">Zum Eingang</Button></Link>
        </div>
      </div>
    );
  }
  if (abgelegtAls) {
    return (
      <div className="mx-auto max-w-2xl space-y-4 p-4 md:p-6">
        {zurueck}
        <AbgelegtHinweis postid={abgelegtAls} />
      </div>
    );
  }
  if (isLoading && !eintrag) {
    return <div className="flex justify-center py-20"><Spinner className="h-6 w-6" /></div>;
  }
  if (!eintrag) {
    return (
      <div className="mx-auto max-w-2xl space-y-4 p-4 md:p-6">
        {zurueck}
        <div className="space-y-3 rounded-xl border border-border/70 bg-card p-4">
          <p className="font-semibold">{weg ? (error?.payload?.fehlgeschlagen ? 'Vorgang fehlgeschlagen' : 'Eingang bereits erledigt') : 'Eingang nicht erreichbar'}</p>
          <p className="text-sm text-muted-foreground">
            {error?.message || 'Der Eingang konnte nicht geladen werden.'}
          </p>
          <Link to={ZURUECK}><Button size="sm">Zum Eingang</Button></Link>
        </div>
      </div>
    );
  }

  const gruppe = gruppeVon(eintrag.gruppe);
  const zeigeFormular = formularOffen && formular && (kann('manuell_ablegen') || manuellAblegen.isPending || (laeuft && eintrag.manuell));
  const versuche = eintrag.versuche != null
    // Eine Benutzeraktion nach dem letzten automatischen Versuch zählt mit,
    // die Anzeige bleibt aber bei „n von n“.
    ? (eintrag.maxVersuche
      ? `${Math.min(eintrag.versuche, eintrag.maxVersuche)} von ${eintrag.maxVersuche}`
      : `${eintrag.versuche}`)
    : null;

  // Der Server empfiehlt je Fehlerart eine Aktion; sie wird zum Hauptknopf.
  // Ohne Empfehlung bleibt „Neu auslösen“ der Hauptknopf.
  const empfehlung = eintrag.empfehlung && kann(eintrag.empfehlung.aktion) ? eintrag.empfehlung : null;
  const hauptAktion = empfehlung?.aktion ?? 'neu_ausloesen';
  const aktionsKnoepfe = (
    <>
      {kann('neu_ausloesen') && (
        <Button variant={hauptAktion === 'neu_ausloesen' ? 'default' : 'outline'} className="gap-1.5" disabled={beschaeftigt} onClick={() => neuAusloesen.mutate()}>
          <RefreshCw className="h-4 w-4" />
          {eintrag.zustand === 'scan_retry' ? 'Jetzt erneut versuchen' : 'Neu auslösen'}
        </Button>
      )}
      {kann('manuell_ablegen') && !formularOffen && (
        <Button variant={hauptAktion === 'manuell_ablegen' ? 'default' : 'outline'} className="gap-1.5" disabled={beschaeftigt} onClick={() => { setFormularOffen(true); setAnsicht('daten'); }}>
          <PenLine className="h-4 w-4" />
          Manuell ablegen
        </Button>
      )}
      {kann('verwerfen') && (
        <Button
          variant={hauptAktion === 'verwerfen' ? 'destructive' : 'ghost'}
          className={hauptAktion === 'verwerfen' ? 'gap-1.5' : 'gap-1.5 text-red-600 hover:text-red-700'}
          disabled={beschaeftigt}
          onClick={() => setVerwerfenOffen(true)}
        >
          <Trash2 className="h-4 w-4" />
          Verwerfen
        </Button>
      )}
      {eintrag.aktionen.includes('entscheiden') && canWrite && eintrag.jobId && (
        <Link to={duplikatPfad(eintrag.jobId)}>
          <Button className="gap-1.5">
            <GitCompareArrows className="h-4 w-4" />
            Alt und neu vergleichen
          </Button>
        </Link>
      )}
    </>
  );
  const hatKnoepfe = aktionen.length > 0 || (eintrag.aktionen.includes('entscheiden') && canWrite);

  const daten = (
    <div className="space-y-4">
      <div className="space-y-2">
        <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${gruppe.badge}`}>
          {laeuft && <Spinner className="h-3 w-3" />}
          {zustandText(eintrag)}
        </span>
        <h1 className="break-words text-xl font-semibold">{eintrag.name}</h1>
      </div>

      {hinweis && (
        <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/30 dark:text-amber-100">{hinweis}</p>
      )}
      {aktionsFehler && (
        <p className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/30 dark:text-red-300">{aktionsFehler}</p>
      )}

      {empfehlung && !laeuft && (
        <p className="flex gap-2 rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm">
          <Lightbulb className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <span><span className="font-medium">Empfehlung: </span>{empfehlung.text}</span>
        </p>
      )}

      <dl className="space-y-1.5 rounded-xl border border-border/70 bg-card p-4">
        <Zeile label="Stand">{grundZeile(eintrag)}</Zeile>
        <Zeile label="Herkunft">{herkunftText(eintrag.herkunft)}</Zeile>
        <Zeile label="Eingang">{zeitText(eintrag.eingangAm)}</Zeile>
        <Zeile label="Versuche">{versuche}</Zeile>
        <Zeile label="Nächster Versuch">{zeitText(eintrag.naechsterVersuch)}</Zeile>
        <Zeile label="Entscheidung bis">{zeitText(eintrag.entscheidungBis)}</Zeile>
        {eintrag.letzterFehler && eintrag.letzterFehler !== grundZeile(eintrag) && (
          <Zeile label="Letzter Fehler">
            {eintrag.letzterFehler}
            {eintrag.letzterFehlerAm ? ` (${zeitText(eintrag.letzterFehlerAm)})` : ''}
          </Zeile>
        )}
      </dl>

      {eintrag.zustand === 'duplikat' && (
        <p className="text-sm text-muted-foreground">
          Ohne Entscheidung werden nach Ablauf der Frist beide Dokumente behalten.
        </p>
      )}
      {!canWrite && (
        <p className="text-sm text-muted-foreground">Mit Lesezugriff lassen sich Eingänge ansehen, aber nicht behandeln.</p>
      )}

      {zeigeFormular && (
        <div className="space-y-3 rounded-xl border border-border/70 bg-card p-4">
          <div>
            <h2 className="font-semibold">Manuell ablegen</h2>
            <p className="text-sm text-muted-foreground">
              Legt das PDF ohne KI-Analyse als Dokument ab. Hier genügen wenige Angaben – alles Weitere lässt sich bei Bedarf in der Dokumentansicht nachtragen.
            </p>
          </div>
          <ManuellAblegenFormular
            wert={formular}
            onChange={setFormular}
            onAbsenden={() => manuellAblegen.mutate()}
            onAbbrechen={() => { setFormularOffen(false); setFormularFehler(null); }}
            gesperrt={manuellAblegen.isPending || laeuft}
            fehler={formularFehler}
          />
        </div>
      )}
    </div>
  );

  const viewer = (hoehe) => (eintrag.zustand === 'scan_laeuft' ? (
    <div style={{ height: hoehe }} className="flex flex-col items-center justify-center gap-3 rounded-xl border border-border/70 bg-muted/30 p-6 text-center text-sm text-muted-foreground">
      <Spinner className="h-6 w-6" />
      <p>Der Scan läuft noch. Das PDF erscheint hier, sobald die Seiten eingelesen und erkannt sind.</p>
    </div>
  ) : (
    <PdfInlineViewer
      file={api.eingang.pdfUrl(aktiv)}
      style={{ height: hoehe }}
      fehlerText="Das PDF ist gerade nicht erreichbar."
    />
  ));

  const dialog = (
    <Dialog open={verwerfenOffen} onOpenChange={(o) => { if (!verwerfen.isPending) setVerwerfenOffen(o); }}>
      <DialogTitle>Eingang verwerfen?</DialogTitle>
      <DialogDescription>
        „{eintrag.name}“ wird nicht als Dokument abgelegt. Das PDF wandert in den Papierkorb der Ablage
        und lässt sich von dort bei Bedarf zurückholen.
      </DialogDescription>
      <DialogFooter>
        <Button variant="ghost" onClick={() => setVerwerfenOffen(false)} disabled={verwerfen.isPending}>Abbrechen</Button>
        <Button variant="destructive" onClick={() => verwerfen.mutate()} disabled={verwerfen.isPending}>
          {verwerfen.isPending ? 'Wird verworfen …' : 'Verwerfen'}
        </Button>
      </DialogFooter>
    </Dialog>
  );

  if (istMobil) {
    return (
      <div className="flex min-h-full flex-col">
        <SeitenLeiste>
          <AnsichtUmschalter ansicht={ansicht} onWechsel={setAnsicht} />
        </SeitenLeiste>
        <div className="flex-1 space-y-4 p-4">
          {/* Der Viewer bleibt eingehängt und wird nur verborgen. */}
          <div style={{ display: ansicht === 'dokument' ? 'block' : 'none' }}>
            {viewer('calc(100dvh - var(--mobil-kopf, 3.5rem) - 13rem)')}
          </div>
          <div style={{ display: ansicht === 'daten' ? 'block' : 'none' }}>{daten}</div>
        </div>
        {hatKnoepfe && (
          <div className="sticky bottom-0 z-20 flex flex-wrap gap-2 border-t border-border/60 bg-background/95 px-4 py-3 backdrop-blur-md [&>*]:flex-1 [&_button]:w-full">
            {aktionsKnoepfe}
          </div>
        )}
        {dialog}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl space-y-4 p-6 lg:p-8">
      {zurueck}
      <div className="grid gap-6 lg:grid-cols-2">
        {viewer('calc(100vh - 9rem)')}
        <div className="space-y-4">
          {daten}
          {hatKnoepfe && <div className="flex flex-wrap gap-2">{aktionsKnoepfe}</div>}
        </div>
      </div>
      {dialog}
    </div>
  );
}
