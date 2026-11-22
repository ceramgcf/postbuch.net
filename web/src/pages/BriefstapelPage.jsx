/**
 * BriefstapelPage.jsx – Trennansicht eines Dokumentenstapels (aus dem Einzug oder einer PDF)
 *
 * Route: /import/eingang/t:<id> (EingangDetailPage leitet hierher weiter)
 *
 * Die Blätter stehen in Scanreihenfolge, gruppiert zu Dokumentkarten. Auf jeder
 * Naht zwischen zwei Blättern sitzt ein Knopf „Neues Dokument ab hier“ bzw.
 * „Gehört zum Blatt davor“. Unklare Stellen der KI sind markiert und lassen
 * sich einzeln entscheiden. Seiten können entfernt und einzeln gedreht werden.
 * Solange der Stapel noch eingelesen wird oder die KI noch vorschlägt, zeigt
 * die Ansicht nur die Blätter ohne Karten und Trennknöpfe. Erst „Übernehmen“
 * schickt die Entscheidung an den Server; bis dahin bleibt alles lokal.
 *
 * Beim Öffnen wird ein laufender Countdown der Übernahme ohne Rückfrage
 * angehalten.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, ArrowLeft, CheckCircle2, ChevronLeft, ChevronRight, FileText, Link2, MoreHorizontal,
  RefreshCw, RotateCw, Scissors, Sparkles, Trash2, Undo2, X,
} from 'lucide-react';
import { api } from '@/api/client';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Dialog, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog';
import { useAuth } from '@/hooks/useAuth';
import { useDarstellung } from '@/hooks/useDarstellung';
import { useZurueckSchliesst, useZurueckZiel } from '@/hooks/useBackButtonGuard';
import { SeitenLeiste, useSeitenTitel } from '@/hooks/useSeite';
import { OFFENE_EINGAENGE_KEY } from '@/hooks/useOffeneEingaenge';
import { eingangPfad, gruppeVon, zeitText } from '@/lib/eingang';
import {
  aufteilen, blaetterMitInhalt, mehrzahl, rollenText, seiteId, stelle, trennstellen,
} from '@/lib/stapel';
import { cn } from '@/lib/utils';

const ZURUECK = '/import?tab=eingang';

const STATUS_TEXT = {
  liest_ein: 'Die Blätter werden eingelesen. Die Trennung lässt sich prüfen, sobald alle Blätter da sind und die KI einen Vorschlag gemacht hat.',
  vorschlag: 'Die KI schlägt gerade die Trennung vor. Das dauert meist weniger als eine Minute.',
  teilt_auf: 'Die Dokumente werden übergeben und laufen dann einzeln durch die Verarbeitung.',
};

// ── Bausteine ────────────────────────────────────────────────────────────────

/** Seitenbild, lädt beim Sichtbarwerden; ist der Server beschäftigt, folgen bis zu drei Versuche. */
// Drehung im Uhrzeigersinn. Quer gedrehte Seiten werden verkleinert, damit sie
// in den Hochformatrahmen passen (1 : 1,414).
function drehStil(drehung) {
  if (!drehung) return undefined;
  return { transform: `rotate(${drehung}deg)${drehung % 180 ? ' scale(0.707)' : ''}` };
}

function SeitenBild({ id, seq, seite, gross = false, drehung = 0, className, onClick }) {
  const [versuch, setVersuch] = useState(0);
  const [fehler, setFehler] = useState(false);
  const [geladen, setGeladen] = useState(false);
  useEffect(() => {
    if (!fehler || versuch >= 3) return undefined;
    const t = setTimeout(() => { setFehler(false); setVersuch((n) => n + 1); }, 4000 * (versuch + 1));
    return () => clearTimeout(t);
  }, [fehler, versuch]);
  const bild = !fehler && (
    <img
      key={versuch}
      src={`${api.eingang.stapel.seiteUrl(id, seq, seite, gross)}${versuch ? `${gross ? '&' : '?'}v=${versuch}` : ''}`}
      alt={`Blatt ${seq}, ${seite === 1 ? 'Vorderseite' : 'Rückseite'}`}
      loading={gross ? 'eager' : 'lazy'}
      draggable={false}
      onLoad={() => setGeladen(true)}
      onError={() => setFehler(true)}
      style={drehStil(drehung)}
      className={gross
        // Großansicht: Das Bild behält sein Seitenverhältnis und wird nur in
        // den freien Platz eingepasst; der weiße Grund gehört zum Bild.
        ? cn('max-h-full max-w-full rounded-md bg-white object-contain shadow-sm transition-transform', !geladen && 'absolute opacity-0')
        : cn('absolute inset-0 h-full w-full object-contain transition-transform', !geladen && 'opacity-0')}
    />
  );
  if (gross) {
    return (
      <div className={cn('relative flex items-center justify-center', className)} onClick={onClick}>
        {!geladen && <FileText className="h-10 w-10 text-muted-foreground/40" aria-hidden />}
        {bild}
      </div>
    );
  }
  return (
    <div className={cn('relative flex items-center justify-center overflow-hidden bg-muted/40', className)}>
      {!geladen && <FileText className="h-8 w-8 text-muted-foreground/40" aria-hidden />}
      {bild}
    </div>
  );
}

/** Runder Knopf auf der Naht zwischen zwei Blättern. */
function TrennKnopf({ st, offen, gesperrt, onUmschalten, richtung }) {
  const markiert = st.unklar && !offen.geprueft;
  const Icon = st.trennen ? Scissors : Link2;
  const text = st.trennen
    ? `Nach Blatt ${st.nach}: neues Dokument ab hier`
    : `Nach Blatt ${st.nach}: gehört zum Blatt davor`;
  return (
    <button
      type="button"
      data-trennstelle={st.nach}
      data-unklar={markiert ? '1' : undefined}
      disabled={gesperrt}
      onClick={onUmschalten}
      aria-label={`${text}. ${st.trennen ? 'Zum Zusammenfügen' : 'Zum Trennen'} drücken.`}
      title={text}
      className={cn(
        'absolute z-10 flex h-11 w-11 items-center justify-center rounded-full border-2 shadow-md transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        richtung === 'rechts'
          // Mitte der Lücke zum nächsten Blatt (gap-x-11 bzw. space-y-11 = 2,75 rem).
          ? 'right-0 top-1/2 -translate-y-1/2 translate-x-[calc(50%+1.375rem)]'
          : 'bottom-0 left-1/2 -translate-x-1/2 translate-y-[calc(50%+1.375rem)]',
        st.trennen
          ? 'border-primary bg-primary text-primary-foreground hover:bg-primary/90'
          : 'border-border bg-background text-muted-foreground hover:text-foreground',
        markiert && 'ring-4 ring-amber-400/70 dark:ring-amber-500/60',
        gesperrt && 'opacity-60',
      )}
    >
      <Icon className="h-5 w-5" />
      {markiert && (
        <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-amber-500 text-[10px] font-bold text-white">?</span>
      )}
    </button>
  );
}

/** Eine Seite im Raster: Tippen öffnet die Großansicht, die Ecke entfernt sie. */
function Seite({ id, seq, seite, entfernt, rolle, drehung = 0, gesperrt, onEntfernen, onDrehen, onOeffnen, breit }) {
  return (
    <div className={cn('relative', breit ? 'min-w-0 flex-1' : 'w-36 xl:w-44 2xl:w-52')}>
      <button
        type="button" onClick={onOeffnen}
        className="block w-full cursor-zoom-in rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={`Blatt ${seq}, ${seite === 1 ? 'Vorderseite' : 'Rückseite'} groß ansehen`}
      >
        <SeitenBild
          id={id} seq={seq} seite={seite} drehung={drehung}
          className={cn(
            'aspect-[1/1.414] w-full rounded-md border border-border/70 bg-white shadow-sm transition',
            entfernt && 'border-dashed opacity-35 grayscale',
          )}
        />
      </button>
      {rolle && !entfernt && (
        <span className="pointer-events-none absolute bottom-1.5 left-1.5 rounded-full bg-amber-100/95 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800 shadow-sm dark:bg-amber-950/90 dark:text-amber-300">
          {rollenText(rolle)}
        </span>
      )}
      {entfernt && (
        <span className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 text-center text-[11px] font-semibold text-foreground/80">
          entfernt
        </span>
      )}
      {!gesperrt && (
        <button
          type="button" onClick={onEntfernen}
          aria-label={entfernt ? `Blatt ${seq}, Seite ${seite} zurückholen` : `Blatt ${seq}, Seite ${seite} entfernen`}
          title={entfernt ? 'Zurückholen' : 'Seite entfernen'}
          className="absolute -right-2 -top-2 flex h-8 w-8 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-sm hover:text-foreground"
        >
          {entfernt ? <Undo2 className="h-4 w-4" /> : <X className="h-4 w-4" />}
        </button>
      )}
      {!gesperrt && !entfernt && onDrehen && (
        <button
          type="button" onClick={onDrehen}
          aria-label={`Blatt ${seq}, ${seite === 1 ? 'Vorderseite' : 'Rückseite'} drehen`}
          title="Seite drehen"
          className={cn(
            'absolute -bottom-2 -right-2 flex h-8 w-8 items-center justify-center rounded-full border shadow-sm',
            drehung ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background text-muted-foreground hover:text-foreground',
          )}
        >
          <RotateCw className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

function Platzhalter({ b, breit, einlesen = false }) {
  return (
    <div className={cn(
      'flex flex-col items-center justify-center gap-1 rounded-md border-2 border-dashed border-border p-2 text-center text-[11px] text-muted-foreground',
      breit ? 'min-h-24 w-full' : 'aspect-[1/1.414] w-36 xl:w-44 2xl:w-52',
    )}
    >
      {b.zustand === 'leer' ? `Blatt ${b.seq} war leer` : einlesen ? (
        <>
          <Spinner className="h-4 w-4" />
          {`Blatt ${b.seq} wird noch eingelesen`}
        </>
      ) : (
        <>
          <AlertTriangle className="h-4 w-4 text-amber-500" />
          {`Blatt ${b.seq} ist nicht angekommen`}
        </>
      )}
    </div>
  );
}

// ── Großansicht ──────────────────────────────────────────────────────────────

function Grossansicht({ id, inhalt, start, stellen, entfernt, rollen, drehungen, vorlaeufig, gesperrt, onSchliessen, onUmschalten, onEntfernen, onDrehen }) {
  const leiste = useRef(null);
  const [index, setIndex] = useState(start);
  useZurueckSchliesst(true, onSchliessen);

  useEffect(() => {
    const el = leiste.current;
    if (el) el.scrollTo({ left: start * el.clientWidth, behavior: 'instant' });
  }, [start]);

  const gehe = useCallback((i) => {
    const el = leiste.current;
    if (!el) return;
    const ziel = Math.max(0, Math.min(inhalt.length - 1, i));
    el.scrollTo({ left: ziel * el.clientWidth, behavior: 'smooth' });
  }, [inhalt.length]);

  useEffect(() => {
    const taste = (e) => {
      if (e.key === 'Escape') onSchliessen();
      else if (e.key === 'ArrowRight') gehe(index + 1);
      else if (e.key === 'ArrowLeft') gehe(index - 1);
    };
    window.addEventListener('keydown', taste);
    return () => window.removeEventListener('keydown', taste);
  }, [index, gehe, onSchliessen]);

  const blatt = inhalt[index];
  const davor = index > 0 ? stellen.get(inhalt[index - 1].seq) : null;

  return createPortal(
    <div className="fixed inset-0 z-[1000] flex flex-col bg-background" role="dialog" aria-modal="true" aria-label="Großansicht">
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2 pt-safe">
        <p className="flex-1 text-sm font-medium tabular-nums">Blatt {blatt?.seq} · {index + 1} von {inhalt.length}</p>
        <Button variant="ghost" size="icon" onClick={onSchliessen} aria-label="Großansicht schließen">
          <X className="h-5 w-5" />
        </Button>
      </div>
      <div
        ref={leiste}
        onScroll={(e) => {
          const el = e.currentTarget;
          const i = Math.round(el.scrollLeft / Math.max(1, el.clientWidth));
          if (i !== index) setIndex(i);
        }}
        className="flex min-h-0 flex-1 snap-x snap-mandatory overflow-x-auto overscroll-x-contain"
      >
        {inhalt.map((b) => (
          <div key={b.seq} className="flex h-full w-full shrink-0 snap-center flex-col items-center justify-center gap-3 p-3 landscape:flex-row lg:flex-row">
            {Array.from({ length: Math.min(2, b.seiten) }, (_, k) => k + 1).map((s) => {
              const sid = seiteId(b.seq, s);
              const weg = entfernt.has(sid);
              return (
                <div key={s} className="flex min-h-0 min-w-0 flex-1 flex-col items-center gap-2 self-stretch">
                  <SeitenBild
                    id={id} seq={b.seq} seite={s} gross drehung={drehungen[sid] || 0} onClick={onSchliessen}
                    // Ein Klick auf die Seite schließt die Großansicht wieder.
                    className={cn('min-h-0 w-full flex-1 cursor-zoom-out', weg && 'opacity-35 grayscale')}
                  />
                  <div className="flex items-center gap-2">
                    {rollen[sid] && (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800 dark:bg-amber-950/50 dark:text-amber-300">
                        {rollenText(rollen[sid])}
                      </span>
                    )}
                    {!gesperrt && !weg && (
                      <Button size="sm" variant="ghost" className="gap-1.5" onClick={() => onDrehen(sid)}>
                        <RotateCw className="h-4 w-4" />
                        Drehen
                      </Button>
                    )}
                    {!gesperrt && (
                      <Button size="sm" variant={weg ? 'outline' : 'ghost'} className="gap-1.5" onClick={() => onEntfernen(sid)}>
                        {weg ? <Undo2 className="h-4 w-4" /> : <Trash2 className="h-4 w-4" />}
                        {weg ? 'Seite zurückholen' : 'Seite entfernen'}
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 border-t border-border/60 px-3 py-2 pb-[calc(0.5rem+env(safe-area-inset-bottom,0px))]">
        <Button variant="ghost" size="icon" disabled={index === 0} onClick={() => gehe(index - 1)} aria-label="Vorheriges Blatt">
          <ChevronLeft className="h-5 w-5" />
        </Button>
        <div className="flex flex-1 justify-center">
          {davor && !vorlaeufig && (
            <Button
              variant={davor.trennen ? 'default' : 'outline'} className="gap-1.5" disabled={gesperrt}
              onClick={() => onUmschalten(davor.nach)}
              aria-pressed={davor.trennen}
            >
              {davor.trennen ? <Scissors className="h-4 w-4" /> : <Link2 className="h-4 w-4" />}
              {davor.trennen ? 'Neues Dokument ab hier' : 'Gehört zum Blatt davor'}
            </Button>
          )}
        </div>
        <Button variant="ghost" size="icon" disabled={index >= inhalt.length - 1} onClick={() => gehe(index + 1)} aria-label="Nächstes Blatt">
          <ChevronRight className="h-5 w-5" />
        </Button>
      </div>
    </div>,
    document.body,
  );
}

// ── Entscheidung einer unklaren Stelle ───────────────────────────────────────

function StellenDialog({ id, st, offen, drehungen, gesperrt, onEntscheiden, onZuruecksetzen, onSchliessen, onWeiter }) {
  if (!st) return null;
  const vor = st.nach;
  const nach = st.vor;
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onSchliessen(); }} size="lg">
      <DialogTitle>Beginnt mit Blatt {nach} ein neues Dokument?</DialogTitle>
      <DialogDescription>
        {st.ki
          ? `Vorschlag der KI: ${st.ki.trennen ? 'trennen' : 'zusammen lassen'}${st.ki.sicherheit !== 'sicher' ? ` (${st.ki.sicherheit})` : ''}.`
          : 'Für diese Stelle gibt es keinen Vorschlag der KI.'}
        {st.ki?.grund ? ` ${st.ki.grund}` : ''}
      </DialogDescription>
      <div className="my-4 grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">Ende von Blatt {vor}</p>
          <SeitenBild id={id} seq={vor} seite={st.vorSeiten} drehung={drehungen[seiteId(vor, st.vorSeiten)] || 0} className="aspect-[1/1.414] w-full rounded-md border border-border/70 bg-white" />
        </div>
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">Anfang von Blatt {nach}</p>
          <SeitenBild id={id} seq={nach} seite={1} drehung={drehungen[seiteId(nach, 1)] || 0} className="aspect-[1/1.414] w-full rounded-md border border-border/70 bg-white" />
        </div>
      </div>
      <DialogFooter className="flex-wrap gap-2">
        {offen.geaendert && (
          <Button variant="ghost" className="mr-auto gap-1.5" disabled={gesperrt} onClick={onZuruecksetzen}>
            <Undo2 className="h-4 w-4" />
            Zurück zum Vorschlag
          </Button>
        )}
        <Button
          variant={!st.trennen ? 'default' : 'outline'} className="gap-1.5" disabled={gesperrt}
          onClick={() => { onEntscheiden(false); onWeiter(); }}
        >
          <Link2 className="h-4 w-4" />
          Zusammen lassen
        </Button>
        <Button
          variant={st.trennen ? 'default' : 'outline'} className="gap-1.5" disabled={gesperrt}
          onClick={() => { onEntscheiden(true); onWeiter(); }}
        >
          <Scissors className="h-4 w-4" />
          Trennen
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

// ── Seite ────────────────────────────────────────────────────────────────────

function Erledigt({ error }) {
  const teile = error?.payload?.teile || [];
  return (
    <div className="mx-auto max-w-2xl space-y-4 p-4 md:p-6">
      <div className={cn(
        'space-y-3 rounded-xl border p-4',
        teile.length
          ? 'border-emerald-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/30'
          : 'border-border/70 bg-card',
      )}
      >
        <p className="flex items-center gap-2 font-semibold">
          {teile.length > 0 && <CheckCircle2 className="h-5 w-5 text-emerald-600" />}
          {teile.length ? 'Dokumentenstapel aufgeteilt' : 'Dokumentenstapel nicht mehr da'}
        </p>
        <p className="text-sm text-muted-foreground">{error?.message}</p>
        {teile.length > 0 && (
          <ul className="space-y-1 text-sm">
            {teile.map((jobId, i) => (
              <li key={jobId}>
                <Link className="text-primary underline-offset-2 hover:underline" to={eingangPfad(`a:${jobId}`)}>
                  Dokument {i + 1} im Eingang ansehen
                </Link>
              </li>
            ))}
          </ul>
        )}
        <Link to={ZURUECK}><Button size="sm">Zum Eingang</Button></Link>
      </div>
    </div>
  );
}

/**
 * Schmale Breite (Handy hochkant): Blätter untereinander, Trennknopf unter dem
 * Blatt. Ab 640 px (Handy quer, Tablet) reicht der Platz für Zeilen wie am
 * Desktop, auch wenn die übrige Oberfläche noch im Mobil-Layout ist.
 */
// Hintergrund der Dokumentkarten, abwechselnd: blasser Verlauf ins Cremeweiße.
const KARTEN_GRUND = [
  'bg-[linear-gradient(45deg,#ddd0f7_0%,#fdfbf5_85%)] dark:bg-[linear-gradient(45deg,rgb(91_33_182/0.35)_0%,transparent_85%)]',
  'bg-[linear-gradient(45deg,#c4ebe4_0%,#fdfbf5_85%)] dark:bg-[linear-gradient(45deg,rgb(15_118_110/0.35)_0%,transparent_85%)]',
];

const SCHMAL = '(max-width: 639px)';
function useSchmal() {
  const [schmal, setSchmal] = useState(() => window.matchMedia?.(SCHMAL).matches ?? false);
  useEffect(() => {
    const mq = window.matchMedia?.(SCHMAL);
    if (!mq) return undefined;
    const neu = () => setSchmal(mq.matches);
    mq.addEventListener('change', neu);
    return () => mq.removeEventListener('change', neu);
  }, []);
  return schmal;
}

export default function BriefstapelPage({ id }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { canWrite } = useAuth();
  const { istMobil } = useDarstellung();
  const spalte = useSchmal();
  useSeitenTitel('Dokumentenstapel');

  const [trennungen, setTrennungen] = useState({});
  const [entfernt, setEntfernt] = useState(() => new Set());
  const [drehungen, setDrehungen] = useState({}); // Seite → 90 | 180 | 270
  const [zuletztEntfernt, setZuletztEntfernt] = useState(null);
  const [gross, setGross] = useState(null); // Index in `inhalt`
  const [stellenDialog, setStellenDialog] = useState(null); // nach-Blatt
  const [menue, setMenue] = useState(false);
  const [verwerfenOffen, setVerwerfenOffen] = useState(false);
  const [verlassenZiel, setVerlassenZiel] = useState(null);
  const [konflikt, setKonflikt] = useState(null);
  const [fehler, setFehler] = useState(null);
  const [fertig, setFertig] = useState(null); // { dokumente } oder 'verworfen'
  const angehalten = useRef(false);
  const raster = useRef(null);

  const { data: stapel, error, isLoading, refetch } = useQuery({
    queryKey: ['stapel', id],
    queryFn: () => api.eingang.stapel.get(id),
    retry: false,
    enabled: !fertig,
    refetchInterval: (q) => {
      if (q.state.error) return false;
      return q.state.data?.status === 'wartet' ? 30_000 : 3_000;
    },
  });

  const wartet = stapel?.status === 'wartet';
  // Noch kein Vorschlag: nur die Blätter zeigen, ohne Karten und Trennknöpfe.
  const vorlaeufig = stapel?.status === 'liest_ein' || stapel?.status === 'vorschlag';
  const gesperrt = !canWrite || !wartet;
  const geaendert = Object.keys(trennungen).length > 0 || entfernt.size > 0 || Object.keys(drehungen).length > 0;
  const schuetzen = geaendert && !fertig;

  // Ein laufender Countdown endet, sobald jemand die Trennansicht öffnet.
  useEffect(() => {
    if (!canWrite || angehalten.current || !stapel?.automatischAb || stapel.status !== 'wartet') return;
    angehalten.current = true;
    api.eingang.stapel.anhalten(id)
      .then(() => { refetch(); queryClient.invalidateQueries({ queryKey: OFFENE_EINGAENGE_KEY }); })
      .catch(() => {});
  }, [canWrite, stapel?.automatischAb, stapel?.status, id, refetch, queryClient]);

  // Ungeprüfte Änderungen: Rückfrage beim Neuladen und bei Links aus der Seite.
  useEffect(() => {
    if (!schuetzen) return undefined;
    const vorEntladen = (e) => { e.preventDefault(); e.returnValue = ''; };
    const beiKlick = (e) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = e.target instanceof Element ? e.target.closest('a[href]') : null;
      if (!a || (a.target && a.target !== '_self') || a.hasAttribute('download')) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin || url.pathname === window.location.pathname) return;
      e.preventDefault();
      e.stopPropagation();
      setVerlassenZiel(url.pathname + url.search + url.hash);
    };
    window.addEventListener('beforeunload', vorEntladen);
    document.addEventListener('click', beiKlick, true);
    return () => {
      window.removeEventListener('beforeunload', vorEntladen);
      document.removeEventListener('click', beiKlick, true);
    };
  }, [schuetzen]);

  const verlassen = useCallback(() => {
    if (schuetzen) setVerlassenZiel(ZURUECK); else navigate(ZURUECK);
  }, [schuetzen, navigate]);
  useZurueckZiel(true, verlassen);

  const blaetter = useMemo(() => stapel?.blaetter ?? [], [stapel]);
  const vorschlag = stapel?.vorschlag ?? null;
  const inhalt = useMemo(() => blaetterMitInhalt(blaetter), [blaetter]);
  const rollen = vorschlag?.rollen ?? {};

  // Trennstellen mit Zustand und Nachbarn.
  const stellen = useMemo(() => {
    const m = new Map();
    inhalt.forEach((b, i) => {
      if (i === inhalt.length - 1) return;
      const st = stelle(b.seq, vorschlag, trennungen);
      m.set(b.seq, { ...st, vor: inhalt[i + 1].seq, vorSeiten: Math.min(2, b.seiten) });
    });
    return m;
  }, [inhalt, vorschlag, trennungen]);
  const istOffen = (nach) => ({ geaendert: String(nach) in trennungen, geprueft: String(nach) in trennungen });
  const ungeprueft = [...stellen.values()].filter((st) => st.unklar && !(String(st.nach) in trennungen));

  const dokumente = useMemo(
    () => aufteilen(blaetter, vorschlag, trennungen, entfernt),
    [blaetter, vorschlag, trennungen, entfernt],
  );
  const entstehen = dokumente.filter((d) => d.seiten > 0).length;

  // Gruppen für die Anzeige: Dokumentkarten aus Blättern und Platzhaltern.
  const karten = useMemo(() => {
    const liste = [];
    let karte = null;
    let vorheriges = null;
    for (const b of blaetter) {
      const mitInhalt = b.zustand === 'da' && b.seiten >= 1;
      const neu = !karte || (mitInhalt && vorheriges != null && stelle(vorheriges, vorschlag, trennungen).trennen);
      if (neu && (mitInhalt || !karte)) {
        karte = { einheiten: [], nr: liste.length + 1 };
        liste.push(karte);
      }
      karte.einheiten.push(b);
      if (mitInhalt) vorheriges = b.seq;
    }
    // Dokumentdaten an die Karten mit Inhalt hängen.
    let d = 0;
    for (const k of liste) {
      if (k.einheiten.some((b) => b.zustand === 'da' && b.seiten >= 1)) k.dokument = dokumente[d++] || null;
    }
    return liste;
  }, [blaetter, vorschlag, trennungen, dokumente]);

  // Die Naht sitzt am letzten Element vor dem nächsten Blatt mit Inhalt.
  const nahtAn = useMemo(() => {
    const m = new Map(); // seq des Elements → nach-Blatt der Trennstelle
    let offen = null;
    let letztes = null;
    for (const b of blaetter) {
      const mitInhalt = b.zustand === 'da' && b.seiten >= 1;
      if (mitInhalt) {
        if (offen != null) m.set(letztes, offen);
        offen = stellen.has(b.seq) ? b.seq : null;
      }
      letztes = b.seq;
    }
    return m;
  }, [blaetter, stellen]);

  const umschalten = (nach) => {
    setTrennungen((alt) => ({ ...alt, [nach]: !stelle(nach, vorschlag, alt).trennen }));
  };
  const entscheiden = (nach, trennen) => setTrennungen((alt) => ({ ...alt, [nach]: trennen }));
  const zuruecksetzen = (nach) => setTrennungen((alt) => {
    const neu = { ...alt };
    delete neu[nach];
    return neu;
  });
  const alle = (trennen) => setTrennungen(Object.fromEntries(trennstellen(blaetter).map((n) => [n, trennen])));
  const entfernen = (sid) => {
    const zurueckholen = entfernt.has(sid);
    setEntfernt((alt) => {
      const neu = new Set(alt);
      if (zurueckholen) neu.delete(sid); else neu.add(sid);
      return neu;
    });
    setZuletztEntfernt(zurueckholen ? null : sid);
  };
  const drehen = (sid) => setDrehungen((alt) => {
    const neu = { ...alt };
    const grad = ((alt[sid] || 0) + 90) % 360;
    if (grad) neu[sid] = grad; else delete neu[sid];
    return neu;
  });

  const naechsteUnklare = () => {
    const nach = ungeprueft[0]?.nach;
    if (nach == null) return;
    raster.current?.querySelector(`[data-trennstelle="${nach}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setStellenDialog(nach);
  };

  const nachAktion = () => {
    queryClient.invalidateQueries({ queryKey: OFFENE_EINGAENGE_KEY });
    queryClient.invalidateQueries({ queryKey: ['stapel', id] });
  };
  const beiFehler = (err) => {
    if (err.status === 409 || err.status === 404) setKonflikt(err.message);
    else setFehler(err.message);
  };

  const uebernehmen = useMutation({
    mutationFn: () => api.eingang.stapel.uebernehmen(id, { trennungen, entfernt: [...entfernt], drehungen }),
    onMutate: () => { setFehler(null); setKonflikt(null); },
    onSuccess: (r) => { setFertig({ dokumente: r.dokumente }); nachAktion(); },
    onError: beiFehler,
  });
  const neuVorschlagen = useMutation({
    mutationFn: () => api.eingang.stapel.neuVorschlagen(id),
    onMutate: () => { setFehler(null); setKonflikt(null); setMenue(false); },
    onSuccess: () => { setTrennungen({}); nachAktion(); },
    onError: beiFehler,
  });
  const verwerfen = useMutation({
    mutationFn: () => api.eingang.stapel.verwerfen(id),
    onMutate: () => { setFehler(null); setKonflikt(null); },
    onSuccess: () => { setVerwerfenOffen(false); setFertig('verworfen'); nachAktion(); },
    onError: (err) => { setVerwerfenOffen(false); beiFehler(err); },
  });
  const beschaeftigt = uebernehmen.isPending || neuVorschlagen.isPending || verwerfen.isPending;

  // Tastatur (Desktop): Pfeile wandern über die Trennstellen, U springt zur nächsten unklaren.
  const beiTaste = (e) => {
    if (gross != null || stellenDialog != null) return;
    if (e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    const knoepfe = [...(raster.current?.querySelectorAll('[data-trennstelle]') ?? [])];
    if (!knoepfe.length) return;
    const jetzt = knoepfe.indexOf(document.activeElement);
    let ziel = null;
    if (['ArrowRight', 'ArrowDown'].includes(e.key)) ziel = knoepfe[Math.min(knoepfe.length - 1, jetzt + 1)];
    else if (['ArrowLeft', 'ArrowUp'].includes(e.key)) ziel = knoepfe[Math.max(0, jetzt < 0 ? 0 : jetzt - 1)];
    else if (e.key === 'u' || e.key === 'U') {
      ziel = knoepfe.slice(jetzt + 1).find((k) => k.dataset.unklar) || knoepfe.find((k) => k.dataset.unklar);
    }
    if (ziel) {
      e.preventDefault();
      ziel.focus();
      ziel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  };

  // ── Zustände ohne Trennansicht ──

  const zurueck = (
    <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground hover:text-foreground" onClick={verlassen}>
      <ArrowLeft className="h-4 w-4" />
      Eingang
    </Button>
  );

  if (fertig) {
    return (
      <div className="mx-auto max-w-2xl space-y-4 p-4 md:p-6">
        <div className="space-y-3 rounded-xl border border-emerald-300 bg-emerald-50 p-4 dark:border-emerald-800 dark:bg-emerald-950/30">
          <p className="flex items-center gap-2 font-semibold text-emerald-800 dark:text-emerald-200">
            <CheckCircle2 className="h-5 w-5" />
            {fertig === 'verworfen' ? 'Dokumentenstapel verworfen' : `${mehrzahl(fertig.dokumente, 'Dokument', 'Dokumente')} übernommen`}
          </p>
          <p className="text-sm text-emerald-900 dark:text-emerald-100">
            {fertig === 'verworfen'
              ? 'Die Blätter sind gelöscht.'
              : 'Die Dokumente laufen jetzt einzeln durch die Verarbeitung und erscheinen im Eingang, bis sie abgelegt sind.'}
          </p>
          <Link to={ZURUECK}><Button size="sm">Zum Eingang</Button></Link>
        </div>
      </div>
    );
  }
  // Inzwischen aufgeteilt oder gelöscht (auch während die Seite offen ist).
  if (error?.status === 404) return <Erledigt error={error} />;
  if (isLoading && !stapel) return <div className="flex justify-center py-20"><Spinner className="h-6 w-6" /></div>;
  if (!stapel) {
    return (
      <div className="mx-auto max-w-2xl space-y-4 p-4 md:p-6">
        {zurueck}
        <p className="rounded-xl border border-border/70 bg-card p-4 text-sm">{error?.message || 'Der Dokumentenstapel konnte nicht geladen werden.'}</p>
      </div>
    );
  }

  const z = stapel.zusammenfassung;
  const gruppe = gruppeVon(wartet ? 'briefstapel' : 'verarbeitung');

  // ── Bausteine der Ansicht ──

  const kopf = (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${gruppe.badge}`}>
          {!wartet && <Spinner className="h-3 w-3" />}
          {wartet ? 'Trennung prüfen' : 'In Verarbeitung'}
        </span>
        <span className="text-xs text-muted-foreground">
          {[mehrzahl(z.seiten, 'Seite', 'Seiten'), stapel.quelle === 'upload' ? 'aus einer PDF' : (stapel.duplex ? 'beidseitig' : 'einseitig'), zeitText(stapel.erstelltAm)].filter(Boolean).join(' · ')}
        </span>
      </div>
      {!istMobil && <h1 className="text-xl font-semibold">Dokumentenstapel</h1>}
      {stapel.hinweis && <p className="text-sm text-muted-foreground">Hinweis: {stapel.hinweis}</p>}
    </div>
  );

  const meldungen = (
    <>
      {!wartet && STATUS_TEXT[stapel.status] && (
        <p className="flex gap-2 rounded-lg border border-sky-300 bg-sky-50 p-3 text-sm text-sky-900 dark:border-sky-800 dark:bg-sky-950/30 dark:text-sky-100">
          <Spinner className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {STATUS_TEXT[stapel.status]}
            {stapel.status === 'liest_ein' && stapel.blaetterN ? ` ${z.blaetter + z.leer} von ${stapel.blaetterN} Blättern sind da.` : ''}
          </span>
        </p>
      )}
      {wartet && !vorschlag && (
        <p className="flex gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/30 dark:text-amber-100">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Die KI konnte keinen Vorschlag machen{stapel.letzterFehler ? ` (${stapel.letzterFehler.replace(/[.\s]+$/, '')})` : ''}. Alle Seiten
            liegen deshalb vorerst in einem Dokument; setze die Trennungen von Hand.
          </span>
        </p>
      )}
      {wartet && z.fehlend > 0 && (
        <p className="flex gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/30 dark:text-amber-100">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {mehrzahl(z.fehlend, 'Blatt ist', 'Blätter sind')} nicht angekommen. Entferne die Seiten des
            unvollständigen Dokuments und übernimm den Rest; das fehlende Blatt scannst du mit seinem Dokument neu.
          </span>
        </p>
      )}
      {konflikt && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/30 dark:text-amber-100">
          <span className="flex-1">{konflikt}</span>
          <Button size="sm" variant="outline" className="gap-1.5" onClick={() => { setKonflikt(null); refetch(); }}>
            <RefreshCw className="h-4 w-4" />
            Neu laden
          </Button>
        </div>
      )}
      {fehler && (
        <p className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/30 dark:text-red-300">{fehler}</p>
      )}
      {zuletztEntfernt && entfernt.has(zuletztEntfernt) && (
        <div className="flex items-center gap-2 rounded-lg border border-border/70 bg-muted/40 px-3 py-2 text-sm">
          <span className="flex-1">
            Blatt {zuletztEntfernt.split(':')[0]}, {zuletztEntfernt.endsWith(':1') ? 'Vorderseite' : 'Rückseite'} entfernt
          </span>
          <Button size="sm" variant="ghost" className="gap-1.5" onClick={() => entfernen(zuletztEntfernt)}>
            <Undo2 className="h-4 w-4" />
            Rückgängig
          </Button>
        </div>
      )}
      {!canWrite && (
        <p className="text-sm text-muted-foreground">Mit Lesezugriff lässt sich ein Dokumentenstapel ansehen, aber nicht trennen.</p>
      )}
    </>
  );

  const schnellwahl = !gesperrt && (
    <div className="flex flex-wrap gap-2">
      <Chip onClick={() => alle(false)}>Ein Dokument</Chip>
      <Chip onClick={() => alle(true)}>Jedes Blatt einzeln</Chip>
      {Object.keys(trennungen).length > 0 && vorschlag && (
        <Chip onClick={() => setTrennungen({})}><Sparkles className="h-3.5 w-3.5" />Vorschlag der KI</Chip>
      )}
    </div>
  );

  const vorlaeufigesRaster = (
    <div className={cn(spalte ? 'space-y-4' : 'flex flex-wrap items-start gap-x-6 gap-y-6')}>
      {blaetter.map((b) => (
        <div key={b.seq} className={cn(spalte && 'w-full')}>
          {b.zustand === 'da' && b.seiten >= 1 ? (
            <div className={cn('flex gap-2', spalte && (b.seiten >= 2 ? 'w-full' : 'mx-auto w-full max-w-xs'))}>
              {Array.from({ length: Math.min(2, b.seiten) }, (_, i) => i + 1).map((s) => (
                <Seite
                  key={s} id={id} seq={b.seq} seite={s} breit={spalte} gesperrt
                  drehung={drehungen[seiteId(b.seq, s)] || 0}
                  onOeffnen={() => setGross(inhalt.findIndex((x) => x.seq === b.seq))}
                />
              ))}
            </div>
          ) : <Platzhalter b={b} breit={spalte} einlesen={stapel.status === 'liest_ein'} />}
        </div>
      ))}
    </div>
  );

  const rasterInhalt = vorlaeufig ? vorlaeufigesRaster : (
    <div
      ref={raster}
      onKeyDown={beiTaste}
      className={cn(spalte ? 'space-y-8' : 'flex flex-wrap items-start gap-x-8 gap-y-6')}
    >
      {karten.map((k) => {
        const leer = !k.dokument;
        const weg = k.dokument && k.dokument.seiten === 0;
        return (
          <section
            key={k.einheiten[0].seq}
            className={cn(
              'rounded-xl border p-3 shadow-sm',
              // Dokumente wechseln zwischen Flieder und Türkis, damit man auf einen
              // Blick sieht, wo eins endet; Lücken ohne Dokument bleiben neutral.
              leer ? 'bg-card' : KARTEN_GRUND[dokumente.indexOf(k.dokument) % 2],
              weg ? 'border-dashed border-border/70 opacity-70' : 'border-border/70',
              leer && 'border-dashed',
            )}
          >
            {k.dokument && (
              <header className="mb-2 flex min-w-0 items-baseline gap-2 pr-6 text-sm">
                <span className="font-semibold">Dokument {dokumente.indexOf(k.dokument) + 1}</span>
                <span className="text-muted-foreground">
                  · {weg ? 'entsteht nicht' : mehrzahl(k.dokument.seiten, 'Seite', 'Seiten')}
                </span>
                {k.dokument.art && !weg && <span className="truncate text-muted-foreground">· {k.dokument.art}</span>}
              </header>
            )}
            <div className={cn(spalte ? 'space-y-11' : 'flex flex-wrap gap-x-11 gap-y-6')}>
              {k.einheiten.map((b) => {
                const naht = nahtAn.get(b.seq);
                const st = naht != null ? stellen.get(naht) : null;
                return (
                  <div key={b.seq} className={cn('relative', spalte && 'w-full')}>
                    {b.zustand === 'da' && b.seiten >= 1 ? (
                      // Mobil: einseitige Blätter schmaler, damit mehr vom Stapel ins Bild passt.
                      <div className={cn('flex gap-2', spalte && (b.seiten >= 2 ? 'w-full' : 'mx-auto w-full max-w-xs'))}>
                        {Array.from({ length: Math.min(2, b.seiten) }, (_, i) => i + 1).map((s) => (
                          <Seite
                            key={s} id={id} seq={b.seq} seite={s} breit={spalte}
                            entfernt={entfernt.has(seiteId(b.seq, s))}
                            rolle={rollen[seiteId(b.seq, s)]}
                            drehung={drehungen[seiteId(b.seq, s)] || 0}
                            gesperrt={gesperrt}
                            onEntfernen={() => entfernen(seiteId(b.seq, s))}
                            onDrehen={() => drehen(seiteId(b.seq, s))}
                            onOeffnen={() => setGross(inhalt.findIndex((x) => x.seq === b.seq))}
                          />
                        ))}
                      </div>
                    ) : <Platzhalter b={b} breit={spalte} />}
                    {st && (
                      <TrennKnopf
                        st={st} offen={istOffen(st.nach)} gesperrt={gesperrt}
                        richtung={spalte ? 'unten' : 'rechts'}
                        onUmschalten={() => (st.unklar && !(String(st.nach) in trennungen)
                          ? setStellenDialog(st.nach)
                          : umschalten(st.nach))}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );

  const hauptKnopf = (
    <Button
      className="gap-1.5" disabled={gesperrt || beschaeftigt || entstehen === 0}
      onClick={() => uebernehmen.mutate()}
    >
      {uebernehmen.isPending ? <Spinner className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
      {entstehen === 1 ? '1 Dokument übernehmen' : `${entstehen} Dokumente übernehmen`}
    </Button>
  );
  const ungeprueftText = wartet && ungeprueft.length > 0
    ? `${mehrzahl(ungeprueft.length, 'Stelle', 'Stellen')} ungeprüft, ${ungeprueft.length === 1 ? 'bleibt' : 'bleiben'} ${vorschlag ? 'beim Vorschlag' : 'zusammen'}`
    : null;

  const nebenAktionen = canWrite && wartet && (
    <>
      <Button variant="ghost" className="justify-start gap-1.5" disabled={beschaeftigt} onClick={() => neuVorschlagen.mutate()}>
        <Sparkles className="h-4 w-4" />
        Neu vorschlagen
      </Button>
      <Button variant="ghost" className="justify-start gap-1.5 text-red-600 hover:text-red-700" disabled={beschaeftigt} onClick={() => { setMenue(false); setVerwerfenOffen(true); }}>
        <Trash2 className="h-4 w-4" />
        Dokumentenstapel verwerfen
      </Button>
    </>
  );

  const offeneStelle = stellenDialog != null ? stellen.get(stellenDialog) : null;
  const dialoge = (
    <>
      {gross != null && inhalt.length > 0 && (
        <Grossansicht
          id={id} inhalt={inhalt} start={Math.max(0, gross)} stellen={stellen} entfernt={entfernt} rollen={rollen}
          drehungen={drehungen} vorlaeufig={vorlaeufig} gesperrt={gesperrt}
          onDrehen={drehen}
          onSchliessen={() => setGross(null)}
          onUmschalten={umschalten}
          onEntfernen={entfernen}
        />
      )}
      {offeneStelle && (
        <StellenDialog
          id={id} st={offeneStelle} offen={istOffen(offeneStelle.nach)} drehungen={drehungen} gesperrt={gesperrt}
          onEntscheiden={(t) => entscheiden(offeneStelle.nach, t)}
          onZuruecksetzen={() => { zuruecksetzen(offeneStelle.nach); setStellenDialog(null); }}
          onSchliessen={() => setStellenDialog(null)}
          onWeiter={() => setStellenDialog(null)}
        />
      )}
      <Dialog open={menue} onOpenChange={setMenue}>
        <DialogTitle>Dokumentenstapel</DialogTitle>
        <div className="mt-3 flex flex-col gap-1">{nebenAktionen}</div>
      </Dialog>
      <Dialog open={verwerfenOffen} onOpenChange={(o) => { if (!verwerfen.isPending) setVerwerfenOffen(o); }}>
        <DialogTitle>Dokumentenstapel verwerfen?</DialogTitle>
        <DialogDescription>
          Alle {mehrzahl(z.seiten, 'Seite', 'Seiten')} werden gelöscht, es entsteht kein Dokument. Das lässt sich
          nicht rückgängig machen; die Dokumente müssen dann neu gescannt werden.
        </DialogDescription>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setVerwerfenOffen(false)} disabled={verwerfen.isPending}>Abbrechen</Button>
          <Button variant="destructive" onClick={() => verwerfen.mutate()} disabled={verwerfen.isPending}>
            {verwerfen.isPending ? 'Wird verworfen …' : 'Verwerfen'}
          </Button>
        </DialogFooter>
      </Dialog>
      <Dialog open={verlassenZiel != null} onOpenChange={(o) => { if (!o) setVerlassenZiel(null); }}>
        <DialogTitle>Änderungen verwerfen?</DialogTitle>
        <DialogDescription>
          Deine Trennungen, gedrehten und entfernten Seiten sind noch nicht übernommen. Der Dokumentenstapel bleibt im Eingang
          und wartet weiter.
        </DialogDescription>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setVerlassenZiel(null)}>Hierbleiben</Button>
          <Button
            variant="destructive"
            onClick={() => {
              const ziel = verlassenZiel;
              setVerlassenZiel(null);
              setTrennungen({});
              setEntfernt(new Set());
              setDrehungen({});
              // Erst nach dem Abbau des Schutzes navigieren.
              setTimeout(() => navigate(ziel), 0);
            }}
          >
            Verwerfen und gehen
          </Button>
        </DialogFooter>
      </Dialog>
    </>
  );

  if (istMobil) {
    return (
      <div className="flex min-h-full flex-col">
        <SeitenLeiste>
          {wartet && (ungeprueft.length > 0 ? (
            <button
              type="button" onClick={naechsteUnklare}
              className="mx-auto flex h-8 items-center gap-1.5 rounded-full bg-amber-100 px-3 text-[13px] font-medium text-amber-900 dark:bg-amber-950/60 dark:text-amber-200"
            >
              Nächste unklare Stelle ({ungeprueft.length})
            </button>
          ) : (
            <span className="mx-auto flex h-8 items-center gap-1.5 rounded-full bg-muted px-3 text-[13px] font-medium text-muted-foreground">
              <CheckCircle2 className="h-4 w-4" />
              Alles geprüft
            </span>
          ))}
        </SeitenLeiste>
        <div className={cn('flex-1 space-y-4 px-4 pb-4', !spalte && 'pr-8')}>
          {kopf}
          {meldungen}
          {schnellwahl}
          {rasterInhalt}
        </div>
        <div className="sticky bottom-0 z-20 border-t border-border/60 bg-background/95 px-3 py-2.5 backdrop-blur-md">
          <div className="flex items-center gap-2 landscape:flex-nowrap">
            <Button variant="ghost" size="icon" onClick={verlassen} aria-label="Zurück zum Eingang">
              <ArrowLeft className="h-5 w-5" />
            </Button>
            {/* Seitenzahl und ungeprüfte Stellen stehen schon oben; hier zählt der Platz. */}
            <div className="flex-1" />
            {canWrite && wartet && (
              <Button variant="ghost" size="icon" onClick={() => setMenue(true)} aria-label="Weitere Aktionen">
                <MoreHorizontal className="h-5 w-5" />
              </Button>
            )}
            {wartet && hauptKnopf}
          </div>
        </div>
        {dialoge}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1600px] space-y-4 p-6 lg:p-8">
      {zurueck}
      <div className="grid gap-8 lg:grid-cols-[1fr_18rem]">
        <div className="min-w-0 space-y-4">
          {kopf}
          {meldungen}
          {schnellwahl}
          {/* Rand rechts, damit der Knopf auf der letzten Naht einer Zeile Platz hat. */}
          <div className="pr-8">{rasterInhalt}</div>
        </div>
        <aside className="space-y-5 lg:sticky lg:top-6 lg:self-start">
          <div className="space-y-2">
            <h2 className="text-sm font-semibold">Dokumente</h2>
            {vorlaeufig && (
              <p className="text-sm text-muted-foreground">Die Dokumente erscheinen, sobald die KI die Trennung vorgeschlagen hat.</p>
            )}
            <ol className={cn('space-y-1 text-sm', vorlaeufig && 'hidden')}>
              {dokumente.map((d, i) => (
                <li key={d.start} className={cn('flex gap-2', d.seiten === 0 && 'text-muted-foreground line-through')}>
                  <span className={cn('mt-1 h-3 w-3 shrink-0 rounded-sm border border-border/60', KARTEN_GRUND[i % 2])} aria-hidden />
                  <span className="tabular-nums text-muted-foreground">{i + 1}.</span>
                  <span className="min-w-0 flex-1 truncate">{d.art || `Ab Blatt ${d.start}`}</span>
                  <span className="tabular-nums text-muted-foreground">{d.seiten} S.</span>
                </li>
              ))}
            </ol>
          </div>
          {wartet && stellen.size > 0 && (
            <div className="space-y-2">
              <h2 className="text-sm font-semibold">Unklare Stellen</h2>
              {[...stellen.values()].filter((st) => st.unklar).length === 0 ? (
                <p className="text-sm text-muted-foreground">Die KI ist sich bei allen Trennstellen sicher.</p>
              ) : (
                <ul className="space-y-1">
                  {[...stellen.values()].filter((st) => st.unklar).map((st) => {
                    const geprueft = String(st.nach) in trennungen;
                    return (
                      <li key={st.nach}>
                        <button
                          type="button" onClick={() => setStellenDialog(st.nach)}
                          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
                        >
                          <span className={cn('h-2 w-2 shrink-0 rounded-full', geprueft ? 'bg-emerald-500' : 'bg-amber-500')} />
                          <span className="flex-1">Zwischen Blatt {st.nach} und {st.vor}</span>
                          <span className="text-xs text-muted-foreground">{st.trennen ? 'trennen' : 'zusammen'}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
          {wartet && (
            <div className="space-y-2 border-t border-border/60 pt-4">
              <div className="flex flex-col">{hauptKnopf}</div>
              {ungeprueftText && <p className="text-xs text-muted-foreground">{ungeprueftText}</p>}
              <div className="flex flex-col pt-2">{nebenAktionen}</div>
              <p className="pt-2 text-xs text-muted-foreground">
                Pfeiltasten wandern über die Trennstellen, Leertaste schaltet um, U springt zur nächsten unklaren Stelle. Der Drehknopf an jeder Seite dreht sie um 90 Grad.
              </p>
            </div>
          )}
        </aside>
      </div>
      {dialoge}
    </div>
  );
}

function Chip({ children, onClick }) {
  return (
    <button
      type="button" onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-full border border-border/70 px-3 py-1 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      {children}
    </button>
  );
}
