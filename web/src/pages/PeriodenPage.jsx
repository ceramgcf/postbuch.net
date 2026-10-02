import { useState, useCallback, useMemo, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { usePerioden, usePeriodenRechnungen, useKuerzungen, useEntfernePkvPruefung } from '@/hooks/usePostbuch';
import { useUndoHistory } from '@/hooks/useUndoHistory';
import { useAbrechnungLauncher } from '@/hooks/useAbrechnungLauncher';
import { useAuth } from '@/hooks/useAuth';
import { api } from '@/api/client';
import { GlowHeading } from '@/components/ui/GlowHeading';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import { PageLoader, EmptyState } from '@/components/ui/spinner';
import { formatCurrency, formatDate } from '@/lib/utils';
import {
  CalendarRange, ChevronDown, ChevronRight, Loader2,
  RotateCcw, Trash2, SkipForward, CheckCircle2, AlertTriangle, Combine, FileText,
  Users, PawPrint, Archive, ClipboardCheck, BookmarkX, Split,
} from 'lucide-react';
import { Link, useNavigate } from 'react-router';
import AbrechnungWizardCard from '@/components/AbrechnungWizardCard';

const STATUS_STYLES = {
  COLLECTING: 'text-blue-700 bg-blue-50 border-blue-200',
  SUBMITTED: 'text-amber-700 bg-amber-50 border-amber-200',
  COMPLETED: 'text-green-700 bg-green-50 border-green-200',
  OMITTED: 'text-slate-600 bg-slate-100 border-slate-300',
};

/**
 * Baut je Periode die vollständige Ableitungskette auf, in der sie steht.
 *
 * Eine Restperiode kennt über `ursprungsperiode` nur ihre direkte Elternperiode.
 * Für die Anzeige interessiert aber der ganze zusammenhängende Ast — deshalb
 * wird von jeder Periode aus nach oben UND nach unten traversiert. Kind- und
 * Elternperiode zeigen dadurch dieselbe Kette („Periode 8 aus 5", „Periode 5
 * aus 2"), nur die eigene Zeile ist jeweils hervorgehoben.
 *
 * @returns {Map<number, Array<{periode: number, ursprungsperiode: number}>>}
 */
function buildAbleitungen(perioden) {
  const nachNummer = new Map(perioden.map((p) => [p.periode, p]));
  const kinder = new Map();
  for (const p of perioden) {
    if (!Number.isInteger(p.ursprungsperiode)) continue;
    if (!kinder.has(p.ursprungsperiode)) kinder.set(p.ursprungsperiode, []);
    kinder.get(p.ursprungsperiode).push(p.periode);
  }

  const ketten = new Map();
  for (const start of perioden) {
    const gesehen = new Set([start.periode]);
    const stapel = [start.periode];
    while (stapel.length > 0) {
      const aktuell = stapel.pop();
      const eltern = nachNummer.get(aktuell)?.ursprungsperiode;
      if (Number.isInteger(eltern) && !gesehen.has(eltern)) {
        gesehen.add(eltern);
        stapel.push(eltern);
      }
      for (const kind of kinder.get(aktuell) || []) {
        if (!gesehen.has(kind)) {
          gesehen.add(kind);
          stapel.push(kind);
        }
      }
    }
    ketten.set(start.periode, [...gesehen]
      .map((nr) => nachNummer.get(nr))
      .filter((x) => x && Number.isInteger(x.ursprungsperiode))
      .map((x) => ({ periode: x.periode, ursprungsperiode: x.ursprungsperiode }))
      .sort((a, b) => b.periode - a.periode));
  }
  return ketten;
}

// ─── Ableitungshinweis ────────────────────────────────────────────────────────
function AbleitungsHinweis({ periode, kette }) {
  if (!kette || kette.length === 0) return null;
  return (
    <div className="mt-2 flex w-fit items-start gap-1.5 rounded-md border border-violet-200 bg-violet-50 px-2.5 py-1.5 text-xs text-violet-900">
      <Split className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
      <div className="leading-relaxed">
        <p className="font-medium">Teilabrechnung</p>
        {kette.map((k) => (
          <p
            key={k.periode}
            className={k.periode === periode || k.ursprungsperiode === periode ? 'font-medium' : 'text-violet-900/70'}
          >
            Periode {k.periode} aus {k.ursprungsperiode}
          </p>
        ))}
      </div>
    </div>
  );
}

// ─── RechnungenList ───────────────────────────────────────────────────────────
function RechnungenList({ person, kostentraeger, periode, backPath }) {
  const { data, isLoading, error } = usePeriodenRechnungen(person, kostentraeger, periode);
  const navigate = useNavigate();

  if (isLoading) return (
    <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" /> Lade Rechnungen…
    </div>
  );
  if (error) return <p className="py-2 text-sm text-destructive">Fehler: {error.message}</p>;

  const rows = data?.data ?? [];
  if (rows.length === 0) return (
    <p className="py-2 text-sm text-muted-foreground italic">Keine Rechnungen in dieser Periode.</p>
  );

  const navList = rows.map((r) => ({
    postid: r.postid,
    betreff: r.re_nr ?? r.name_arzt ?? '',
    art: r.art,
  }));

  const anyErwartet = rows.some((r) => r.erwartete_erstattung != null);

  return (
    <div className="mt-2 rounded-md border overflow-hidden">
      <table className="w-full text-xs">
        <thead className="bg-muted/40">
          <tr>
            <th className="text-left px-2 py-1.5 font-medium text-muted-foreground">Datum</th>
            <th className="text-left px-2 py-1.5 font-medium text-muted-foreground">Arzt</th>
            <th className="text-left px-2 py-1.5 font-medium text-muted-foreground">Re-Nr.</th>
            <th className="text-right px-2 py-1.5 font-medium text-muted-foreground">Betrag</th>
            {anyErwartet && <th className="text-right px-2 py-1.5 font-medium text-muted-foreground">Erwartet</th>}
            <th className="text-right px-2 py-1.5 font-medium text-muted-foreground">Erstattet</th>
            <th className="text-left px-2 py-1.5 font-medium text-muted-foreground">Bezahlt</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, idx) => {
            const gesamt = parseFloat(r.gesamtbetrag) || 0;
            const erstattet = parseFloat(r.erstattungsbetrag_gesamt) || 0;
            const pct = gesamt > 0 ? Math.round(erstattet / gesamt * 100) : null;
            const erwartet = r.erwartete_erstattung != null ? parseFloat(r.erwartete_erstattung) : null;
            const satzLabel = r.satz_override != null
              ? `${parseFloat(r.satz_override)} % (rechnungsspez.)`
              : r.personen_satz != null
                ? `${parseFloat(r.personen_satz)} % (Standard)`
                : null;
            return (
              <tr
                key={r.postid}
                className="border-t hover:bg-muted/30 cursor-pointer transition-colors"
                onClick={() =>
                  navigate(`/postbuch/${r.postid}`, {
                    state: { from: backPath, navList, navIndex: idx },
                  })
                }
              >
                <td className="px-2 py-1.5 whitespace-nowrap">
                  <span className="flex items-center gap-1.5">
                    {formatDate(r.briefdatum ?? r.rechnungsdatum)}
                    {r.historisch && (
                      <span
                        className="inline-flex items-center gap-1 rounded border border-slate-300 bg-slate-100 px-1 py-0.5 text-[10px] font-medium text-slate-600"
                        title="Archiviert – bleibt bis zur Abrechnung in dieser Periode"
                      >
                        <Archive className="h-2.5 w-2.5" />
                        Archiviert
                      </span>
                    )}
                  </span>
                </td>
                <td className="px-2 py-1.5 truncate max-w-[140px]">{r.name_arzt ?? '–'}</td>
                <td className="px-2 py-1.5 text-muted-foreground truncate max-w-[80px]">{r.re_nr ?? '–'}</td>
                <td className="px-2 py-1.5 text-right font-mono whitespace-nowrap">{formatCurrency(r.gesamtbetrag)}</td>
                {anyErwartet && (
                  <td className="px-2 py-1.5 text-right font-mono whitespace-nowrap" title={satzLabel ?? undefined}>
                    {erwartet != null
                      ? <span className="text-blue-700">{formatCurrency(erwartet)}</span>
                      : <span className="text-muted-foreground/40">–</span>}
                  </td>
                )}
                <td className="px-2 py-1.5 text-right whitespace-nowrap">
                  {pct !== null
                    ? <span className={pct >= 100 ? 'text-green-700 font-medium' : pct > 0 ? 'text-green-600' : 'text-muted-foreground/50'}>{pct} %</span>
                    : <span className="text-muted-foreground/50">–</span>}
                </td>
                <td className="px-2 py-1.5 whitespace-nowrap">
                  {r.bezahlt_am
                    ? <span className="text-green-700">{formatDate(r.bezahlt_am)}</span>
                    : <span className="text-muted-foreground/50">–</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── PeriodeActions ───────────────────────────────────────────────────────────
// Inline-Buttons in der Perioden-Überschrift, je nach Status.
function PeriodeActions({ p, person, kostentraeger, collectingCount, highestCollectingPeriode, onRequestRemove, onConfirmOmit, onConfirmMergeOmitted }) {
  const qc = useQueryClient();
  const { pushAction } = useUndoHistory();
  const { launchWithSelection } = useAbrechnungLauncher();

  const invalidate = () => qc.invalidateQueries({ queryKey: ['analyse', 'perioden'] });

  const handleRevert = async (e) => {
    e.stopPropagation();
    await api.abrechnungsperiode.setStatus(person, kostentraeger, p.periode, 'COLLECTING', 'SUBMITTED');
    invalidate();
    pushAction(
      `Periode ${person}/${kostentraeger}/#${p.periode} auf COLLECTING zurückgestuft`,
      async () => {
        await api.abrechnungsperiode.setStatus(person, kostentraeger, p.periode, 'SUBMITTED', 'COLLECTING');
        invalidate();
      },
      async () => {
        await api.abrechnungsperiode.setStatus(person, kostentraeger, p.periode, 'COLLECTING', 'SUBMITTED');
        invalidate();
      },
    );
  };

  const handleOmitClick = (e) => {
    e.stopPropagation();
    onConfirmOmit?.({ person, kostentraeger, periode: p.periode });
  };

  const handleUndoOmit = async (e) => {
    e.stopPropagation();
    await api.abrechnungsperiode.undoOmit(person, kostentraeger, p.periode, null);
    invalidate();
    pushAction(
      `Periode ${person}/${kostentraeger}/#${p.periode} von OMITTED auf COLLECTING zurückgesetzt`,
      async () => {
        await api.abrechnungsperiode.setStatus(person, kostentraeger, p.periode, 'OMITTED', 'COLLECTING');
        invalidate();
      },
      async () => {
        await api.abrechnungsperiode.setStatus(person, kostentraeger, p.periode, 'COLLECTING', 'OMITTED');
        invalidate();
      },
    );
  };

  const handleMergeOmittedClick = (e) => {
    e.stopPropagation();
    onConfirmMergeOmitted?.({
      person,
      kostentraeger,
      periode: p.periode,
      targetPeriode: highestCollectingPeriode,
    });
  };

  const handleClose = (e) => {
    e.stopPropagation();
    launchWithSelection({ person, kostentraeger, periode: p.periode });
  };

  const handleRemove = (e) => {
    e.stopPropagation();
    onRequestRemove?.();
  };

  const btnCls = 'inline-flex items-center justify-center h-7 w-7 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground';

  if (p.status === 'SUBMITTED') {
    return (
      <button className={btnCls} onClick={handleRevert} title="Zurückstufen auf COLLECTING">
        <RotateCcw className="h-3.5 w-3.5" />
      </button>
    );
  }

  if (p.status === 'COLLECTING') {
    return (
      <div className="flex items-center gap-0.5">
        <button
          className={btnCls}
          onClick={handleClose}
          title="Periode abschließen (Wizard)"
        >
          <CheckCircle2 className="h-3.5 w-3.5 text-primary" />
        </button>
        <button
          className={btnCls}
          onClick={handleOmitClick}
          title="Auf Abrechnung verzichten (OMITTED)"
        >
          <SkipForward className="h-3.5 w-3.5" />
        </button>
        {collectingCount >= 2 && (
          <button
            className={btnCls}
            onClick={handleRemove}
            title="Periode löschen…"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    );
  }

  if (p.status === 'OMITTED') {
    return (
      <div className="flex items-center gap-0.5">
        <button
          className={btnCls}
          onClick={handleUndoOmit}
          title="Auf COLLECTING zurücksetzen (Verzicht aufheben)"
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </button>
        {Number.isInteger(highestCollectingPeriode) && (
          <button
            className={btnCls}
            onClick={handleMergeOmittedClick}
            title={`In COLLECTING #${highestCollectingPeriode} mergen`}
          >
            <Combine className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    );
  }

  return null;
}

// ─── PruefFaelleSection ─────────────────────────────────────────────────────
// Zeigt die für diese PKV-Periode vorgemerkten bzw. bereits eingereichten
// Kürzungen zur Gegenprüfung. Wiederverwendet den bereits im Dashboard/in
// der Kürzungsübersicht gepflegten Cache statt eines eigenen Endpoints.
function PruefFaelleSection({ person, periode }) {
  const { data } = useKuerzungen('alle');
  const { canWrite } = useAuth();
  const { mutate: entfernen, isPending, variables } = useEntfernePkvPruefung();

  const rows = (data?.data || []).filter((r) =>
    r.behandelte_person === person
    && r.pkv_pruefung_periode === periode
    && (r.pkv_pruefung_status === 'VORGEMERKT' || r.pkv_pruefung_status === 'EINGEREICHT')
  );

  if (rows.length === 0) return null;

  return (
    <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-900">
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <span className="font-medium flex items-center gap-1.5">
          <ClipboardCheck className="h-3.5 w-3.5" />
          Prüffälle ({rows.length})
        </span>
        <Link
          to={`/analyse/kuerzungen?gesehen=alle&person=${encodeURIComponent(person)}&periode=${periode}`}
          className="text-amber-700 hover:underline flex items-center gap-0.5"
        >
          Zur Kürzungsübersicht <ChevronRight className="h-3 w-3" />
        </Link>
      </div>
      <div className="space-y-1">
        {rows.map((k) => {
          const removing = isPending && variables?.kuerzungId === k.kuerzung_id;
          return (
            <div key={k.kuerzung_id} className="flex items-center justify-between gap-2">
              <span className="truncate">
                {formatCurrency(k.kuerzungsbetrag_effektiv ?? k.kuerzungsbetrag)}
                {k.name_arzt ? ` – ${k.name_arzt}` : ''}
              </span>
              {k.pkv_pruefung_status === 'VORGEMERKT' ? (
                canWrite && (
                  <button
                    type="button"
                    disabled={removing}
                    onClick={() => entfernen({ postid: k.eb_postid, kuerzungId: k.kuerzung_id, ebSubid: k.eb_subid, arzPostid: k.arz_postid })}
                    title="Vormerkung entfernen"
                    className="text-amber-600/60 hover:text-amber-800 transition-colors disabled:opacity-40 flex-shrink-0"
                  >
                    <BookmarkX className="h-3.5 w-3.5" />
                  </button>
                )
              ) : (
                <Badge variant="outline" className="text-emerald-700 border-emerald-200 bg-emerald-100 text-[10px] px-1.5 py-0 flex-shrink-0">
                  Eingereicht
                </Badge>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── PeriodeRow ───────────────────────────────────────────────────────────────
function PeriodeRow({ p, person, kostentraeger, backPath, onOpen, onClose, isHighestCollecting, collectingCount, highestCollectingPeriode, ableitung, onRequestRemove, onConfirmOmit, onConfirmMergeOmitted }) {
  const [open, setOpen] = useState(false);
  const kette = ableitung || [];
  const restperioden = kette.filter((k) => k.ursprungsperiode === p.periode);
  const ableitungsTitel = kette.map((k) => `Periode ${k.periode} aus ${k.ursprungsperiode}`).join(' · ');

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) onOpen?.();
    else onClose?.();
  };

  return (
    <div className="border rounded-lg overflow-hidden">
      <div className="flex items-center gap-2 p-2.5 hover:bg-muted/30 transition-colors">
        <button
          className="flex items-center gap-2 min-w-0 flex-1 text-left"
          onClick={toggle}
        >
          {open
            ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
            : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />}
          <div className="flex flex-col min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-mono font-bold">#{p.periode}</span>
              <Badge className={`${STATUS_STYLES[p.status] || ''} text-[10px] px-1.5 py-0`} variant="outline">
                {p.status}
              </Badge>
              {Number.isInteger(p.ursprungsperiode) && (
                <Badge
                  className="text-[10px] px-1.5 py-0 text-violet-700 bg-violet-50 border-violet-200"
                  variant="outline"
                  title={ableitungsTitel}
                >
                  aus #{p.ursprungsperiode}
                </Badge>
              )}
              {restperioden.length > 0 && (
                <Badge
                  className="text-[10px] px-1.5 py-0 text-violet-700 bg-violet-50 border-violet-200"
                  variant="outline"
                  title={ableitungsTitel}
                >
                  Rest → {restperioden.map((k) => `#${k.periode}`).join(', ')}
                </Badge>
              )}
            </div>
            {p.referenz_datum && (
              <span className="text-[10px] text-muted-foreground leading-tight mt-0.5">
                {p.status === 'COMPLETED' ? 'Bescheid: ' : 'Letzte Rg.: '}
                {formatDate(p.referenz_datum)}
              </span>
            )}
          </div>
        </button>
        <div className="flex items-center flex-shrink-0 mr-3">
          <PeriodeActions
            p={p}
            person={person}
            kostentraeger={kostentraeger}
            collectingCount={collectingCount}
            highestCollectingPeriode={highestCollectingPeriode}
            onRequestRemove={onRequestRemove}
            onConfirmOmit={onConfirmOmit}
            onConfirmMergeOmitted={onConfirmMergeOmitted}
          />
        </div>
        <div className="flex items-center gap-3 text-xs text-right flex-shrink-0">
          <span className="text-muted-foreground"><span className="font-medium text-foreground">{p.anzahl_rechnungen}</span> Rg.</span>
          {p.hat_satz && parseFloat(p.summe_erwartet) > 0
            ? (
              <span className="flex flex-col items-end leading-tight">
                <span className="font-mono font-medium text-blue-700" title="Erwartete Erstattung">{formatCurrency(p.summe_erwartet)}</span>
                <span className="font-mono text-muted-foreground/60 text-[10px]">{formatCurrency(p.summe_rechnungen)}</span>
              </span>
            )
            : <span className="font-mono font-medium">{formatCurrency(p.summe_rechnungen)}</span>
          }
        </div>
      </div>
      {open && (
        <div className="border-t bg-muted/10 px-2.5 pb-2.5">
          {p.status === 'COMPLETED' && p.eb_postid && (
            <Link
              to={`/postbuch/${p.eb_postid}`}
              state={{ from: backPath }}
              className="mt-2 flex w-fit items-center gap-1.5 rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-xs font-medium text-emerald-800 transition-colors hover:bg-emerald-100"
            >
              <FileText className="h-3.5 w-3.5" />
              Erstattungsbescheid
              <span className="font-mono">{p.eb_postid}</span>
              <ChevronRight className="h-3.5 w-3.5" />
            </Link>
          )}
          <AbleitungsHinweis periode={p.periode} kette={kette} />
          <RechnungenList
            person={person}
            kostentraeger={kostentraeger}
            periode={p.periode}
            backPath={backPath}
          />
          {kostentraeger === 'PKV' && (
            <PruefFaelleSection person={person} periode={p.periode} />
          )}
        </div>
      )}
    </div>
  );
}

// ─── PersonSection ────────────────────────────────────────────────────────────
function PersonSection({ person, kostentraeger, perioden, backPath, onOpen, onClose, onRequestRemove, onConfirmOmit, onConfirmMergeOmitted }) {
  const [showOldClosed, setShowOldClosed] = useState(false);

  const sorted = [...perioden].sort((a, b) => b.periode - a.periode);
  const closedStatuses = new Set(['COMPLETED', 'OMITTED']);
  const notClosed = sorted.filter((p) => !closedStatuses.has(p.status));
  const closed = sorted.filter((p) => closedStatuses.has(p.status));
  const latestClosed = closed.slice(0, 1);
  const oldClosed = closed.slice(1);

  const ableitungen = useMemo(() => buildAbleitungen(perioden), [perioden]);

  const { highestCollectingPeriode, collectingCount } = useMemo(() => {
    const colls = perioden.filter((p) => p.status === 'COLLECTING').map((p) => p.periode);
    return {
      highestCollectingPeriode: colls.length > 0 ? Math.max(...colls) : null,
      collectingCount: colls.length,
    };
  }, [perioden]);

  const renderRow = (p) => (
    <PeriodeRow
      key={p.periode}
      p={p}
      person={person}
      kostentraeger={kostentraeger}
      backPath={backPath}
      onOpen={onOpen}
      onClose={onClose}
      isHighestCollecting={p.status === 'COLLECTING' && p.periode === highestCollectingPeriode}
      collectingCount={collectingCount}
      highestCollectingPeriode={highestCollectingPeriode}
      ableitung={ableitungen.get(p.periode)}
      onRequestRemove={() => onRequestRemove?.({
        person,
        kostentraeger,
        periode: p.periode,
        isHighest: p.periode === highestCollectingPeriode,
        highestCollectingPeriode,
      })}
      onConfirmOmit={onConfirmOmit}
      onConfirmMergeOmitted={onConfirmMergeOmitted}
    />
  );

  return (
    <div>
      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">{person}</p>
      <div className="space-y-1.5">
        {notClosed.map(renderRow)}
        {latestClosed.map(renderRow)}
        {oldClosed.length > 0 && (
          <>
            <button
              className="w-full text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 py-0.5"
              onClick={() => setShowOldClosed((v) => !v)}
            >
              {showOldClosed
                ? <ChevronDown className="h-3 w-3" />
                : <ChevronRight className="h-3 w-3" />}
              {showOldClosed
                ? 'Ältere ausblenden'
                : `${oldClosed.length} ältere abgeschlossene anzeigen`}
            </button>
            {showOldClosed && oldClosed.map(renderRow)}
          </>
        )}
      </div>
    </div>
  );
}

// ─── KostentraegerColumn ──────────────────────────────────────────────────────
function KostentraegerColumn({ label, persons, byPerson, backPath, onOpen, onClose, onRequestRemove, onConfirmOmit, onConfirmMergeOmitted }) {
  const hasSomething = persons.some((p) => (byPerson[p]?.[label]?.length ?? 0) > 0);

  return (
    <Card className="h-full">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{label}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {hasSomething
          ? persons.map((person) => {
              const perioden = byPerson[person]?.[label] ?? [];
              if (perioden.length === 0) return null;
              return (
                <PersonSection
                  key={person}
                  person={person}
                  kostentraeger={label}
                  perioden={perioden}
                  backPath={backPath}
                  onOpen={onOpen}
                  onClose={onClose}
                  onRequestRemove={onRequestRemove}
                  onConfirmOmit={onConfirmOmit}
                  onConfirmMergeOmitted={onConfirmMergeOmitted}
                />
              );
            })
          : <p className="text-sm text-muted-foreground italic">Keine Perioden.</p>}
      </CardContent>
    </Card>
  );
}

// ─── RemoveCollectingDialog ───────────────────────────────────────────────────
// Einheitlicher Dialog für das Entfernen einer COLLECTING-Periode.
// Bietet 3 Optionen:
//   1. Umbuchen auf höchste verbleibende COLLECTING-Periode (default)
//   2. Periode stattdessen auf OMITTED setzen (nicht löschen)
//   3. AP-Zuordnung der Rechnungen nullen + Periode löschen (gefährlich, rot, 2. Bestätigung)
function RemoveCollectingDialog({ open, request, onClose }) {
  const qc = useQueryClient();
  const { pushAction } = useUndoHistory();
  const [choice, setChoice] = useState('redirect');
  const [confirmNull, setConfirmNull] = useState(false);
  const [busy, setBusy] = useState(false);

  // Reset bei neuem Request
  useEffect(() => {
    if (open) {
      setChoice('redirect');
      setConfirmNull(false);
    }
  }, [open, request?.periode, request?.person, request?.kostentraeger]);

  if (!request) return null;
  const { person, kostentraeger, periode, isHighest, highestCollectingPeriode } = request;

  const invalidate = () => qc.invalidateQueries({ queryKey: ['analyse', 'perioden'] });

  async function executeRedirect() {
    if (isHighest) {
      // Höchste löschen → Rechnungen auf nächst-niedrigere COLLECTING
      const result = await api.abrechnungsperiode.deleteHighest(person, kostentraeger, periode);
      invalidate();
      pushAction(
        `Höchste COLLECTING #${periode} gelöscht (${person}/${kostentraeger})`,
        async () => {
          await api.abrechnungsperiode.restore(person, kostentraeger, periode, result.movedPostIds || [], undefined, result.movedKuerzungen || []);
          invalidate();
        },
        async () => {
          await api.abrechnungsperiode.deleteHighest(person, kostentraeger, periode);
          invalidate();
        },
      );
    } else {
      // Niedrigere → Merge in die höchste COLLECTING
      const result = await api.abrechnungsperiode.merge(person, kostentraeger, periode, highestCollectingPeriode);
      invalidate();
      pushAction(
        `Periode #${periode} in #${highestCollectingPeriode} gemergt (${person}/${kostentraeger})`,
        async () => {
          await api.abrechnungsperiode.restore(person, kostentraeger, periode, result.movedPostIds || [], undefined, result.movedKuerzungen || []);
          invalidate();
        },
        async () => {
          await api.abrechnungsperiode.merge(person, kostentraeger, periode, highestCollectingPeriode);
          invalidate();
        },
      );
    }
  }

  async function executeOmit() {
    const result = await api.abrechnungsperiode.omit(person, kostentraeger, periode);
    invalidate();
    pushAction(
      `Periode ${person}/${kostentraeger}/#${periode} auf OMITTED gesetzt`,
      async () => {
        await api.abrechnungsperiode.undoOmit(person, kostentraeger, periode, result?.createdPeriode ?? null);
        invalidate();
      },
      async () => {
        await api.abrechnungsperiode.omit(person, kostentraeger, periode);
        invalidate();
      },
    );
  }

  async function executeNullAP() {
    const result = await api.abrechnungsperiode.nullAP(person, kostentraeger, periode);
    invalidate();
    pushAction(
      `Periode #${periode} (${person}/${kostentraeger}) entfernt, AP genullt (${result.clearedPostIds?.length || 0} Rg.)`,
      async () => {
        await api.abrechnungsperiode.restore(person, kostentraeger, periode, result.clearedPostIds || []);
        invalidate();
      },
      async () => {
        await api.abrechnungsperiode.nullAP(person, kostentraeger, periode);
        invalidate();
      },
    );
  }

  const handleExecute = async () => {
    // Option 3 braucht zweite Bestätigung
    if (choice === 'null-ap' && !confirmNull) {
      setConfirmNull(true);
      return;
    }
    setBusy(true);
    try {
      if (choice === 'redirect') await executeRedirect();
      else if (choice === 'omit') await executeOmit();
      else if (choice === 'null-ap') await executeNullAP();
      onClose();
    } catch (err) {
      alert(`Fehler: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const redirectTarget = isHighest
    ? `nächst-niedrigeren COLLECTING-Periode`
    : `höchsten COLLECTING-Periode (#${highestCollectingPeriode})`;

  const radioCls = (selected) => `flex items-start gap-2 p-2.5 rounded-md border cursor-pointer transition-colors ${
    selected ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/40'
  }`;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogTitle>Periode #{periode} entfernen</DialogTitle>
      <DialogDescription>
        Person: <strong>{person}</strong>, Kostenträger: <strong>{kostentraeger}</strong>
      </DialogDescription>

      <div className="space-y-2 mt-2">
        <label className={radioCls(choice === 'redirect')}>
          <input
            type="radio"
            name="remove-choice"
            value="redirect"
            checked={choice === 'redirect'}
            onChange={() => { setChoice('redirect'); setConfirmNull(false); }}
            className="mt-0.5"
          />
          <div className="text-sm">
            <div className="font-medium">Rechnungen in die höchste COLLECTING umbuchen</div>
            <div className="text-xs text-muted-foreground mt-0.5">
              Die Rechnungen werden der {redirectTarget} zugeordnet, Periode #{periode} wird gelöscht.
            </div>
          </div>
        </label>

        <label className={radioCls(choice === 'omit')}>
          <input
            type="radio"
            name="remove-choice"
            value="omit"
            checked={choice === 'omit'}
            onChange={() => { setChoice('omit'); setConfirmNull(false); }}
            className="mt-0.5"
          />
          <div className="text-sm">
            <div className="font-medium">Doch nicht löschen – auf OMITTED setzen</div>
            <div className="text-xs text-muted-foreground mt-0.5">
              Periode #{periode} bleibt bestehen, wird als „nicht abgerechnet" markiert. Rechnungen bleiben zugeordnet.
            </div>
          </div>
        </label>

        <label className={`${radioCls(choice === 'null-ap')} ${choice === 'null-ap' ? 'border-red-500 bg-red-50' : ''}`}>
          <input
            type="radio"
            name="remove-choice"
            value="null-ap"
            checked={choice === 'null-ap'}
            onChange={() => { setChoice('null-ap'); setConfirmNull(false); }}
            className="mt-0.5 accent-red-600"
          />
          <div className="text-sm">
            <div className="font-medium text-red-700 flex items-center gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5" />
              AP-Zuordnung der Rechnungen entfernen
            </div>
            <div className="text-xs text-red-700/80 mt-0.5">
              Rechnungen werden <strong>keiner</strong> Abrechnungsperiode mehr zugeordnet, Periode #{periode} wird gelöscht.
            </div>
          </div>
        </label>
      </div>

      {choice === 'null-ap' && confirmNull && (
        <div className="mt-3 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          <div className="font-medium flex items-center gap-1.5">
            <AlertTriangle className="h-4 w-4" />
            Bist du sicher?
          </div>
          <div className="text-xs mt-1">
            Die AP-Zuordnung wird bei allen Rechnungen der Periode auf NULL gesetzt. Nochmal „Ausführen" klicken bestätigt.
          </div>
        </div>
      )}

      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={busy}>Abbrechen</Button>
        <Button
          onClick={handleExecute}
          disabled={busy}
          variant={choice === 'null-ap' ? 'destructive' : 'default'}
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          {choice === 'null-ap' && !confirmNull ? 'AP nullen…' : 'Ausführen'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

// ─── ConfirmOmitDialog ────────────────────────────────────────────────────────
// Bestätigung bevor eine COLLECTING-Periode auf OMITTED gesetzt wird.
// Erklärt, was OMITTED bedeutet ("Auf Abrechnung verzichten").
function ConfirmOmitDialog({ open, request, onClose }) {
  const qc = useQueryClient();
  const { pushAction } = useUndoHistory();
  const [busy, setBusy] = useState(false);

  if (!request) return null;
  const { person, kostentraeger, periode } = request;
  const invalidate = () => qc.invalidateQueries({ queryKey: ['analyse', 'perioden'] });

  const handleConfirm = async () => {
    setBusy(true);
    try {
      const result = await api.abrechnungsperiode.omit(person, kostentraeger, periode);
      invalidate();
      pushAction(
        `Periode ${person}/${kostentraeger}/#${periode} auf OMITTED gesetzt`,
        async () => {
          await api.abrechnungsperiode.undoOmit(person, kostentraeger, periode, result?.createdPeriode ?? null);
          invalidate();
        },
        async () => {
          await api.abrechnungsperiode.omit(person, kostentraeger, periode);
          invalidate();
        },
      );
      onClose();
    } catch (err) {
      alert(`Fehler: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogTitle>Periode #{periode} auf „OMITTED" setzen?</DialogTitle>
      <DialogDescription>
        Person: <strong>{person}</strong>, Kostenträger: <strong>{kostentraeger}</strong>
      </DialogDescription>

      <div className="mt-3 rounded-md border bg-muted/30 p-3 text-sm space-y-2">
        <div className="font-medium">Was bedeutet OMITTED?</div>
        <p className="text-muted-foreground">
          „OMITTED" heißt: <strong>auf Abrechnung verzichten</strong>. Die Periode wird
          nicht abgerechnet (kein PDF, kein Versand an PKV/Beihilfe). Die Rechnungen
          bleiben der Periode zugeordnet, gelten aber als nicht-abrechnungsrelevant.
        </p>
        <p className="text-muted-foreground">
          Es wird automatisch eine neue COLLECTING-Periode mit der nächsthöheren
          Nummer angelegt (sofern noch keine existiert). Die Aktion ist umkehrbar
          („Rückgängig" oder das Pfeil-Icon an der OMITTED-Periode).
        </p>
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={busy}>Abbrechen</Button>
        <Button onClick={handleConfirm} disabled={busy}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          Auf OMITTED setzen
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

// ─── ConfirmMergeOmittedDialog ────────────────────────────────────────────────
// Bestätigung für: OMITTED-Periode → in höchste COLLECTING mergen.
function ConfirmMergeOmittedDialog({ open, request, onClose }) {
  const qc = useQueryClient();
  const { pushAction } = useUndoHistory();
  const [busy, setBusy] = useState(false);

  if (!request) return null;
  const { person, kostentraeger, periode, targetPeriode } = request;
  const invalidate = () => qc.invalidateQueries({ queryKey: ['analyse', 'perioden'] });

  const handleConfirm = async () => {
    setBusy(true);
    try {
      const result = await api.abrechnungsperiode.merge(person, kostentraeger, periode, targetPeriode);
      invalidate();
      pushAction(
        `OMITTED-Periode #${periode} in COLLECTING #${targetPeriode} gemergt (${person}/${kostentraeger})`,
        async () => {
          await api.abrechnungsperiode.restore(person, kostentraeger, periode, result.movedPostIds || [], 'OMITTED', result.movedKuerzungen || []);
          invalidate();
        },
        async () => {
          await api.abrechnungsperiode.merge(person, kostentraeger, periode, targetPeriode);
          invalidate();
        },
      );
      onClose();
    } catch (err) {
      alert(`Fehler: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogTitle>OMITTED-Periode #{periode} mergen?</DialogTitle>
      <DialogDescription>
        Person: <strong>{person}</strong>, Kostenträger: <strong>{kostentraeger}</strong>
      </DialogDescription>

      <div className="mt-3 rounded-md border bg-muted/30 p-3 text-sm">
        <p className="text-muted-foreground">
          Alle Rechnungen aus Periode <strong>#{periode}</strong> werden in die
          höchste COLLECTING-Periode <strong>#{targetPeriode}</strong> umgebucht.
          Periode #{periode} wird anschließend gelöscht.
        </p>
        <p className="text-muted-foreground mt-2">
          Damit gelten die Rechnungen wieder als abrechnungsrelevant (Bestandteil
          der nächsten Abrechnung). Die Aktion ist umkehrbar („Rückgängig").
        </p>
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={busy}>Abbrechen</Button>
        <Button onClick={handleConfirm} disabled={busy}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          In #{targetPeriode} mergen
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

// ─── PeriodenPage ─────────────────────────────────────────────────────────────
export default function PeriodenPage() {
  const { data, isLoading, error } = usePerioden();
  const backPath = '/analyse/perioden';

  const [colState, setColState] = useState({ PKV: 0, Beihilfe: 0, active: null });
  const [removeRequest, setRemoveRequest] = useState(null);
  const [omitRequest, setOmitRequest] = useState(null);
  const [mergeOmittedRequest, setMergeOmittedRequest] = useState(null);
  const [tierTab, setTierTab] = useState(false);

  const handleOpen = useCallback((col) => {
    setColState((prev) => ({ ...prev, [col]: prev[col] + 1, active: col }));
  }, []);

  const handleClose = useCallback((col) => {
    setColState((prev) => {
      const next = { ...prev, [col]: Math.max(0, prev[col] - 1) };
      const pkvOpen = next.PKV > 0;
      const beihilfeOpen = next.Beihilfe > 0;
      if (!pkvOpen && !beihilfeOpen) next.active = null;
      else if (!pkvOpen) next.active = 'Beihilfe';
      else if (!beihilfeOpen) next.active = 'PKV';
      return next;
    });
  }, []);

  if (isLoading) return <PageLoader />;
  if (error) return <p className="p-6 text-destructive">Fehler: {error.message}</p>;

  const rows = data?.data || [];
  const patientGroups = data?.patientGroups || [];
  if (rows.length === 0 && patientGroups.length === 0) {
    return (
      <div className="px-6 pt-4 pb-6 lg:px-8 lg:pb-8">
        <GlowHeading className="mb-2">Abrechnungsperioden PKV & Beihilfe</GlowHeading>
        <EmptyState icon={CalendarRange} title="Keine Perioden" description="Noch keine Abrechnungsperioden erfasst." />
      </div>
    );
  }

  const hatMenschPkv = patientGroups.some((r) => !r.ist_tier);
  const hatTierPkv = patientGroups.some((r) => !!r.ist_tier);
  const brauchtTabs = hatMenschPkv && hatTierPkv;
  const aktiveTierGruppe = brauchtTabs ? tierTab : (!hatMenschPkv && hatTierPkv);
  const gruppenRows = rows.filter((r) => !!r.ist_tier === aktiveTierGruppe);
  const persons = [...new Set(gruppenRows.map((r) => r.person))].sort();
  const byPerson = {};
  for (const row of gruppenRows) {
    if (!byPerson[row.person]) byPerson[row.person] = { PKV: [], Beihilfe: [] };
    if (row.kostentraeger === 'PKV') byPerson[row.person].PKV.push(row);
    else if (row.kostentraeger === 'Beihilfe') byPerson[row.person].Beihilfe.push(row);
  }

  const { active } = colState;
  const zeigeBeihilfe = !aktiveTierGruppe;
  // calc(X% - 8px) kompensiert den 16px gap, damit beide Spalten zusammen
  // exakt 100% breit sind (und somit bündig mit der Wizard-Card abschließen).
  const pkvWidth = !zeigeBeihilfe ? '100%' : active === null ? 'calc(50% - 8px)' : active === 'PKV' ? 'calc(75% - 8px)' : 'calc(25% - 8px)';
  const beihilfeWidth = active === null ? 'calc(50% - 8px)' : active === 'Beihilfe' ? 'calc(75% - 8px)' : 'calc(25% - 8px)';

  return (
    <div className="px-6 pt-4 pb-6 lg:px-8 lg:pb-8 space-y-4">
      <div>
        <GlowHeading>Abrechnungsperioden PKV &amp; Beihilfe</GlowHeading>
        <p className="text-muted-foreground mt-1">Übersicht der Abrechnungsperioden nach Kostenträger. Menschen und Tiere werden nie gemeinsam abgerechnet.</p>
      </div>

      {brauchtTabs && (
        <div className="flex flex-wrap gap-1 border-b border-border pb-2" role="tablist" aria-label="Patientengruppe">
          <button
            role="tab"
            aria-selected={!tierTab}
            onClick={() => setTierTab(false)}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md transition-colors
              ${!tierTab ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground hover:bg-muted'}`}
          >
            <Users className="h-3.5 w-3.5" />Menschen
          </button>
          <button
            role="tab"
            aria-selected={tierTab}
            onClick={() => setTierTab(true)}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md transition-colors
              ${tierTab ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground hover:bg-muted'}`}
          >
            <PawPrint className="h-3.5 w-3.5" />Tiere
          </button>
        </div>
      )}

      <AbrechnungWizardCard istTier={aktiveTierGruppe} />

      <div className="flex gap-4 items-start" style={{ width: '100%' }}>
        <div style={{ width: pkvWidth, transition: 'width 0.3s ease', flexShrink: 0, minWidth: 0, overflow: 'hidden' }}>
          <KostentraegerColumn
            label="PKV"
            persons={persons}
            byPerson={byPerson}
            backPath={backPath}
            onOpen={() => handleOpen('PKV')}
            onClose={() => handleClose('PKV')}
            onRequestRemove={setRemoveRequest}
            onConfirmOmit={setOmitRequest}
            onConfirmMergeOmitted={setMergeOmittedRequest}
          />
        </div>

        {zeigeBeihilfe && <div style={{ width: beihilfeWidth, transition: 'width 0.3s ease', flexShrink: 0, minWidth: 0, overflow: 'hidden' }}>
          <KostentraegerColumn
            label="Beihilfe"
            persons={persons}
            byPerson={byPerson}
            backPath={backPath}
            onOpen={() => handleOpen('Beihilfe')}
            onClose={() => handleClose('Beihilfe')}
            onRequestRemove={setRemoveRequest}
            onConfirmOmit={setOmitRequest}
            onConfirmMergeOmitted={setMergeOmittedRequest}
          />
        </div>}
      </div>

      <RemoveCollectingDialog
        open={!!removeRequest}
        request={removeRequest}
        onClose={() => setRemoveRequest(null)}
      />
      <ConfirmOmitDialog
        open={!!omitRequest}
        request={omitRequest}
        onClose={() => setOmitRequest(null)}
      />
      <ConfirmMergeOmittedDialog
        open={!!mergeOmittedRequest}
        request={mergeOmittedRequest}
        onClose={() => setMergeOmittedRequest(null)}
      />
    </div>
  );
}
