/**
 * DuplikatVergleichPage.jsx – Duplikatverdacht im Vergleich alt/neu entscheiden
 *
 * Route: /import/duplikat/:jobId
 *
 * Links das vorhandene Dokument (alt), rechts das neu eingegangene. Beide
 * scrollen synchron, relativ zur Gesamthöhe, damit auch unterschiedlich lange
 * Dokumente gleichlaufen. Unten schweben drei Knöpfe:
 *   - mittig über dem alten Dokument „Alte Fassung behalten“ (discard: die neue
 *     Fassung kommt in den Papierkorb der Ablage),
 *   - mittig zwischen beiden „Beide Dokumente behalten (kein Duplikat)“ (keep_both),
 *   - mittig über dem neuen Dokument „Neue Fassung behalten“ (replace).
 * Auf schmalen Bildschirmen wechselt ein Umschalter zwischen alt und neu, die
 * drei Knöpfe stehen als feste Leiste unten.
 *
 * Ohne Entscheidung werden nach Ablauf der Frist beide Dokumente behalten.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, Copy, FileClock, FilePlus2, Info } from 'lucide-react';
import { api } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { PdfInlineViewer } from '@/components/ui/pdf-inline-viewer';
import { useAuth } from '@/hooks/useAuth';
import { useDarstellung } from '@/hooks/useDarstellung';
import { useZurueckZiel } from '@/hooks/useBackButtonGuard';
import { SeitenLeiste, useSeitenTitel } from '@/hooks/useSeite';
import { OFFENE_EINGAENGE_KEY } from '@/hooks/useOffeneEingaenge';
import { zeitText } from '@/lib/eingang';

const ZURUECK = '/import?tab=eingang';
// Vergleichsdokumente sind meist kurz; alle Seiten sofort rendern, damit die
// Gesamthöhe für das relative Synchronscrollen von Anfang an stimmt.
const SEITEN_SOFORT = 30;

const ERGEBNIS = {
  discard: 'Die alte Fassung bleibt. Die neue Fassung liegt im Papierkorb der Ablage.',
  replace: 'Die neue Fassung ersetzt das vorhandene Dokument und wird jetzt abgelegt.',
  keep_both: 'Beide Dokumente bleiben. Die neue Fassung wird jetzt als eigenes Dokument abgelegt.',
};

function datum(wert) {
  if (!wert) return null;
  const iso = String(wert).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return iso ? `${iso[3]}.${iso[2]}.${iso[1]}` : String(wert);
}

/** Fensterbreite unter 768 px (zusätzlich zum Mobil-Layout). */
function useSchmal() {
  const abfrage = '(max-width: 767px)';
  const [schmal, setSchmal] = useState(() => typeof window !== 'undefined' && window.matchMedia(abfrage).matches);
  useEffect(() => {
    const mq = window.matchMedia(abfrage);
    const neu = () => setSchmal(mq.matches);
    mq.addEventListener('change', neu);
    return () => mq.removeEventListener('change', neu);
  }, []);
  return schmal;
}

/** Zwei Scroll-Container relativ zur Gesamthöhe koppeln. */
function useSynchronScroll() {
  const links = useRef(null);
  const rechts = useRef(null);
  // Je Seite die Position, die zuletzt per Programm gesetzt wurde und deren Scroll-Ereignis
  // noch aussteht. Das Echo wird am Wert erkannt, nicht an einer Zeitsperre: Eine Sperre
  // verwarf unter Last echte Ereignisse der bewegten Seite, die andere blieb dann stehen.
  const erwartet = useRef({});

  const kopple = useCallback((von, nach, name, gegen) => () => {
    const a = von.current;
    const b = nach.current;
    if (!a || !b) return;
    const echo = erwartet.current[name];
    delete erwartet.current[name];
    if (echo !== undefined && Math.abs(a.scrollTop - echo) < 1) return;
    const max = a.scrollHeight - a.clientHeight;
    const anteil = max > 0 ? a.scrollTop / max : 0;
    const vorher = b.scrollTop;
    b.scrollTop = anteil * Math.max(0, b.scrollHeight - b.clientHeight);
    // Ohne Positionswechsel feuert die Gegenseite kein Ereignis, dann gibt es kein Echo
    if (Math.abs(b.scrollTop - vorher) >= 1) erwartet.current[gegen] = b.scrollTop;
  }, []);

  return {
    links, rechts,
    onScrollLinks: kopple(links, rechts, 'links', 'rechts'),
    onScrollRechts: kopple(rechts, links, 'rechts', 'links'),
  };
}

function Kopf({ titel, Icon, zeilen, ton }) {
  return (
    <div className={`flex items-start gap-2.5 rounded-lg border px-3 py-2 ${ton}`}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 text-sm">
        <p className="font-semibold">{titel}</p>
        {zeilen.filter(Boolean).map((z) => (
          <p key={z} className="truncate text-xs text-muted-foreground" title={z}>{z}</p>
        ))}
      </div>
    </div>
  );
}

export default function DuplikatVergleichPage() {
  const { jobId } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { canWrite } = useAuth();
  const { istMobil } = useDarstellung();
  const schmal = useSchmal() || istMobil;
  useSeitenTitel('Duplikatverdacht');
  useZurueckZiel(true, () => navigate(ZURUECK));

  const [seite, setSeite] = useState('neu');
  const [ergebnis, setErgebnis] = useState(null);
  const sync = useSynchronScroll();

  const { data: s, error, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['pending-decision', jobId],
    queryFn: () => api.pendingDecisions.get(jobId),
    retry: false,
    enabled: !!jobId && !ergebnis,
  });

  const entscheiden = useMutation({
    mutationFn: (decision) => api.pendingDecisions.decide(jobId, decision),
    onSuccess: (_, decision) => {
      setErgebnis(decision);
      queryClient.invalidateQueries({ queryKey: OFFENE_EINGAENGE_KEY });
      queryClient.invalidateQueries({ queryKey: ['pending-decisions'] });
    },
  });

  const zurueck = (
    <Link to={ZURUECK}>
      <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" />
        Eingang
      </Button>
    </Link>
  );

  if (ergebnis) {
    return (
      <div className="mx-auto max-w-xl space-y-4 p-6">
        <div className="flex items-start gap-3 rounded-xl border border-emerald-300 bg-emerald-50 p-4 text-sm dark:border-emerald-800 dark:bg-emerald-950/30">
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
          <p>{ERGEBNIS[ergebnis]}</p>
        </div>
        {zurueck}
      </div>
    );
  }

  if (isLoading) {
    return <div className="flex justify-center py-16"><Spinner className="h-6 w-6" /></div>;
  }

  if (error || !s) {
    const endgueltig = !error || [401, 403, 404, 410].includes(error.status);
    return (
      <div className="mx-auto max-w-xl space-y-4 p-6">
        <p className="rounded-xl border border-border/70 bg-muted/30 p-4 text-sm text-muted-foreground">
          {endgueltig
            ? 'Dieser Duplikatverdacht ist bereits entschieden oder nicht mehr vorhanden.'
            : 'Der Vergleich konnte gerade nicht geladen werden. Die Entscheidung ist dadurch nicht verloren.'}
        </p>
        <div className="flex gap-2">
          {zurueck}
          {!endgueltig && (
            <Button size="sm" onClick={() => refetch()} disabled={isFetching}>Erneut versuchen</Button>
          )}
        </div>
      </div>
    );
  }

  const alt = s.match || { postid: s.matchPostid };
  const bis = zeitText(s.expiresAt);
  const aehnlich = Number.isFinite(s.similarity) ? `${Math.round(s.similarity * 100)} % ähnlich` : null;
  const beschaeftigt = entscheiden.isPending;

  const kopfAlt = (
    <Kopf
      titel={`Vorhanden: ${alt.postid}`}
      Icon={FileClock}
      ton="border-border/70 bg-card"
      zeilen={[
        alt.betreff,
        [alt.briefdatum && `Briefdatum ${datum(alt.briefdatum)}`, alt.erfassungsdatum && `erfasst ${datum(alt.erfassungsdatum)}`]
          .filter(Boolean).join(' · '),
      ]}
    />
  );
  const kopfNeu = (
    <Kopf
      titel="Neu eingegangen"
      Icon={FilePlus2}
      ton="border-violet-300 bg-violet-50/60 dark:border-violet-800 dark:bg-violet-950/20"
      zeilen={[
        s.betreff,
        [s.briefdatum && `Briefdatum ${datum(s.briefdatum)}`, s.createdAt && `eingegangen ${zeitText(s.createdAt)}`]
          .filter(Boolean).join(' · '),
      ]}
    />
  );

  const viewerAlt = (hoehe) => (
    <PdfInlineViewer
      file={api.files.pdfUrl(alt.postid)}
      style={{ height: hoehe }}
      scrollerRef={sync.links}
      onScroll={schmal ? undefined : sync.onScrollLinks}
      ersteSeiten={SEITEN_SOFORT}
      fehlerText="Das vorhandene Dokument ist gerade nicht erreichbar."
    />
  );
  const viewerNeu = (hoehe) => (
    <PdfInlineViewer
      file={api.files.suspendedPdfUrl(s.onedriveId)}
      style={{ height: hoehe }}
      scrollerRef={sync.rechts}
      onScroll={schmal ? undefined : sync.onScrollRechts}
      ersteSeiten={SEITEN_SOFORT}
      fehlerText="Das neue Dokument ist gerade nicht erreichbar."
    />
  );

  const knopf = (decision, label, variant = 'default') => (
    <Button
      key={decision}
      variant={variant}
      className="shadow-lg"
      disabled={beschaeftigt}
      onClick={() => entscheiden.mutate(decision)}
    >
      {beschaeftigt && entscheiden.variables === decision && <Spinner className="mr-1.5 h-4 w-4" />}
      {label}
    </Button>
  );

  const hinweis = (
    <div className="space-y-2">
      <div className="flex items-start gap-2.5 rounded-lg border border-border/70 bg-muted/30 px-3.5 py-2.5 text-sm">
        <Copy className="mt-0.5 h-4 w-4 shrink-0 text-violet-600" />
        <div className="min-w-0 space-y-0.5">
          <p>
            Das neue Dokument ist möglicherweise ein Duplikat von <span className="font-medium">{alt.postid}</span>
            {aehnlich ? ` (${aehnlich})` : ''}.
          </p>
          {s.begruendung && <p className="text-xs text-muted-foreground">Begründung: {s.begruendung}</p>}
          {bis && (
            <p className="text-xs text-muted-foreground">
              Entscheidung bis {bis}. Danach werden beide Dokumente behalten.
            </p>
          )}
        </div>
      </div>
      {!canWrite && (
        <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Info className="h-4 w-4" />
          Mit Lesezugriff lässt sich der Vergleich ansehen, aber nicht entscheiden.
        </p>
      )}
      {entscheiden.error && (
        <p className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/30 dark:text-red-300">
          Die Entscheidung konnte nicht gespeichert werden: {entscheiden.error.message}
        </p>
      )}
    </div>
  );

  if (schmal) {
    const umschalter = (
      <div role="tablist" className="flex rounded-full bg-muted p-1">
        {[['alt', 'Alt'], ['neu', 'Neu']].map(([wert, label]) => (
          <button
            key={wert} type="button" role="tab" aria-selected={seite === wert}
            onClick={() => setSeite(wert)}
            className={`h-8 rounded-full px-4 text-[13px] font-medium transition-colors ${
              seite === wert ? 'bg-background text-primary shadow-sm' : 'text-muted-foreground'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
    );
    const hoehe = 'calc(100dvh - var(--mobil-kopf, 3.5rem) - 19rem)';
    return (
      <div className="flex min-h-full flex-col">
        {istMobil ? <SeitenLeiste>{umschalter}</SeitenLeiste> : null}
        <div className="flex-1 space-y-3 p-4">
          {!istMobil && <div className="flex items-center justify-between gap-2">{zurueck}{umschalter}</div>}
          {hinweis}
          {seite === 'alt' ? kopfAlt : kopfNeu}
          {/* Beide Viewer bleiben eingehängt, damit der Wechsel nicht neu lädt. */}
          <div style={{ display: seite === 'alt' ? 'block' : 'none' }}>{viewerAlt(hoehe)}</div>
          <div style={{ display: seite === 'neu' ? 'block' : 'none' }}>{viewerNeu(hoehe)}</div>
        </div>
        {canWrite && (
          <div className="sticky bottom-0 z-20 grid grid-cols-3 gap-2 border-t border-border/60 bg-background/95 px-3 py-3 backdrop-blur-md [&_button]:h-auto [&_button]:min-h-9 [&_button]:w-full [&_button]:whitespace-normal [&_button]:px-2 [&_button]:py-1.5 [&_button]:text-xs [&_button]:shadow-none">
            {knopf('discard', 'Alte Fassung behalten', 'outline')}
            {knopf('keep_both', 'Beide behalten (kein Duplikat)')}
            {knopf('replace', 'Neue Fassung behalten', 'outline')}
          </div>
        )}
      </div>
    );
  }

  const hoehe = 'calc(100vh - 17rem)';
  return (
    <div className="mx-auto max-w-[1600px] space-y-3 p-6 lg:p-8">
      {zurueck}
      {hinweis}
      <div className="relative">
        <div className="grid grid-cols-2 gap-4">
          <div className="min-w-0 space-y-2">
            {kopfAlt}
            {viewerAlt(hoehe)}
          </div>
          <div className="min-w-0 space-y-2">
            {kopfNeu}
            {viewerNeu(hoehe)}
          </div>
        </div>
        {canWrite && (
          // Schwebende Knöpfe: je mittig über ihrem Dokument, der dritte in der Mitte.
          <div className="pointer-events-none absolute inset-x-0 bottom-6 z-20 grid grid-cols-2 gap-4">
            <div className="flex justify-center">
              <div className="pointer-events-auto">{knopf('discard', 'Alte Fassung behalten', 'outline')}</div>
            </div>
            <div className="flex justify-center">
              <div className="pointer-events-auto">{knopf('replace', 'Neue Fassung behalten', 'outline')}</div>
            </div>
            {/* Auf mittelbreiten Bildschirmen eine Zeile höher, damit sich nichts überdeckt. */}
            <div className="absolute left-1/2 top-0 -translate-x-1/2 max-xl:-translate-y-[calc(100%+0.75rem)]">
              <div className="pointer-events-auto">{knopf('keep_both', 'Beide Dokumente behalten (kein Duplikat)')}</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
