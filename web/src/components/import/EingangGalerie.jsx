/**
 * EingangGalerie.jsx – offene Eingänge als Kacheln (Reiter „Eingang“ der
 * Importseite): angenommene PDFs, die noch kein Dokument sind.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Inbox, Info } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { AutoForwardRing } from '@/components/ui/auto-forward-ring';
import { useOffeneEingaenge, OFFENE_EINGAENGE_KEY } from '@/hooks/useOffeneEingaenge';
import { useAuth } from '@/hooks/useAuth';
import { api } from '@/api/client';
import { mehrzahl } from '@/lib/stapel';
import {
  GRUPPEN, gruppeVon, zustandText, herkunftText, zeitText, grundZeile, eintragPfad, markiereFehlschlaegeGesehen,
} from '@/lib/eingang';
import EingangVorschau from './EingangVorschau';

/** Dokumentenstapel: Fächer aus Papierlagen hinter der ersten Seite. */
function StapelVorschau({ e }) {
  const lagen = Math.min(2, Math.max(0, (e.stapel?.blaetter || 1) - 1));
  return (
    <div className="relative aspect-[4/3] w-full border-b border-border/60 bg-muted/40">
      {lagen >= 2 && <div className="absolute inset-x-7 bottom-2 top-5 rotate-[4deg] rounded-md border border-border/70 bg-card shadow-sm" />}
      {lagen >= 1 && <div className="absolute inset-x-6 bottom-2.5 top-4 -rotate-[3deg] rounded-md border border-border/70 bg-card shadow-sm" />}
      <EingangVorschau
        schluessel={e.schluessel}
        className="absolute inset-x-5 bottom-3 top-3 rounded-md border border-border/70 shadow-md"
      />
    </div>
  );
}

/** Countdown der Übernahme ohne Rückfrage; ein Klick hält ihn an. */
function StapelCountdown({ e }) {
  const queryClient = useQueryClient();
  const { canWrite } = useAuth();
  const ab = e.stapel?.automatischAb;
  // Rest einmal je Zeitpunkt berechnen, damit der Ring beim Nachladen nicht springt.
  const rest = useMemo(() => (ab ? (new Date(ab).getTime() - Date.now()) / 1000 : 0), [ab]);
  if (!ab || rest <= 0) return null;
  const anhalten = () => {
    if (!canWrite) return;
    api.eingang.stapel.anhalten(e.jobId)
      .finally(() => queryClient.invalidateQueries({ queryKey: OFFENE_EINGAENGE_KEY }));
  };
  return (
    <AutoForwardRing
      onCancel={anhalten} dauer={15} rest={rest}
      label="Automatische Übernahme anhalten" ansage="Übernahme in"
      className="absolute right-2 top-2 z-10"
    />
  );
}

function Kachel({ e }) {
  const gruppe = gruppeVon(e.gruppe);
  const herkunft = herkunftText(e.herkunft);
  const grund = grundZeile(e);
  return (
    <Link
      to={eintragPfad(e)}
      className="group flex flex-col overflow-hidden rounded-xl border border-border/70 bg-card shadow-sm transition-all hover:border-primary/40 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="relative">
        {e.stapel
          ? <StapelVorschau e={e} />
          : <EingangVorschau schluessel={e.schluessel} className="aspect-[4/3] w-full border-b border-border/60" />}
        <span className={`absolute left-2 top-2 z-10 inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold shadow-sm ${gruppe.badge}`}>
          {(e.zustand === 'laeuft' || (e.stapel && e.gruppe === 'verarbeitung')) && <Spinner className="h-3 w-3" />}
          {zustandText(e)}
        </span>
        {e.stapel && <StapelCountdown e={e} />}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1 p-3">
        <p className="truncate text-sm font-medium" title={e.name}>{e.name}</p>
        {grund && <p className="line-clamp-2 text-xs text-muted-foreground">{grund}</p>}
        {e.zustand === 'stapel_wartet' && e.stapel?.unklar > 0 && (
          <span className="self-start rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800 dark:bg-amber-950/50 dark:text-amber-300">
            {mehrzahl(e.stapel.unklar, 'Stelle', 'Stellen')} unklar
          </span>
        )}
        <p className="mt-auto pt-1 text-[11px] text-muted-foreground/80">
          {[herkunft, zeitText(e.eingangAm)].filter(Boolean).join(' · ')}
        </p>
      </div>
    </Link>
  );
}

export default function EingangGalerie() {
  const { istEingeschraenkt } = useAuth();
  const { eintraege, zaehler, isLoading, error } = useOffeneEingaenge();
  const [filter, setFilter] = useState('alle');

  // Wer die Galerie sieht, hat die fehlgeschlagenen Dokumente gesehen.
  useEffect(() => { if (eintraege.length) markiereFehlschlaegeGesehen(); }, [eintraege]);

  if (istEingeschraenkt) {
    return (
      <p className="rounded-lg border border-border/70 bg-muted/30 p-4 text-sm text-muted-foreground">
        Offene Eingänge sind noch keiner Person zugeordnet und deshalb mit diesem Zugang nicht einsehbar.
      </p>
    );
  }

  const sichtbar = filter === 'alle' ? eintraege : eintraege.filter((e) => e.gruppe === filter);
  const chip = (id, label, anzahl, punkt) => (
    <button
      key={id} type="button" aria-pressed={filter === id}
      onClick={() => setFilter(id)}
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm font-medium transition-colors ${
        filter === id
          ? 'border-primary/40 bg-primary/10 text-primary'
          : 'border-border/70 text-muted-foreground hover:bg-muted hover:text-foreground'
      }`}
    >
      {punkt && <span className={`h-2 w-2 rounded-full ${punkt}`} />}
      {label}
      <span className="tabular-nums text-xs opacity-80">{anzahl}</span>
    </button>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2.5 rounded-lg border border-border/70 bg-muted/30 px-3.5 py-2.5 text-sm text-muted-foreground">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <p>
          Hier stehen angenommene PDFs, die noch kein Dokument sind: in Verarbeitung, wartend,
          mit Handlungsbedarf oder mit Duplikatverdacht. Ein Scan erscheint, sobald Scan und Texterkennung abgeschlossen sind –
          bis dahin zeigt ihn der Task-Monitor. Dateien im überwachten Ordner der Ablage erscheinen,
          sobald postbuch.net sie übernommen hat. Ein Dokumentenstapel aus dem Einzug erscheint schon beim
          Einlesen; unter „Dokumentenstapel“ prüfst du, wo ein Dokument endet und der nächste beginnt.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {chip('alle', 'Alle', eintraege.length)}
        {GRUPPEN.map((g) => chip(g.id, g.label, zaehler[g.id] ?? 0, g.punkt))}
      </div>

      {isLoading && (
        <div className="flex justify-center py-12"><Spinner className="h-6 w-6" /></div>
      )}
      {error && !isLoading && (
        <p className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/30 dark:text-red-300">
          Die Eingänge konnten nicht geladen werden: {error.message}
        </p>
      )}
      {!isLoading && !error && sichtbar.length === 0 && (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border py-12 text-center">
          <Inbox className="h-8 w-8 text-muted-foreground/50" />
          <p className="text-sm font-medium">
            {eintraege.length === 0 ? 'Kein offener Eingang' : 'Kein Eingang in dieser Gruppe'}
          </p>
          {eintraege.length === 0 && (
            <p className="max-w-sm text-xs text-muted-foreground">
              Alles, was angenommen wurde, ist als Dokument abgelegt.
            </p>
          )}
        </div>
      )}

      {sichtbar.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {sichtbar.map((e) => <Kachel key={e.schluessel} e={e} />)}
        </div>
      )}
    </div>
  );
}
