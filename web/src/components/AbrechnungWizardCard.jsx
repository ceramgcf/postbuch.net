/**
 * AbrechnungWizardCard – 4-Schritte-Assistent für Abrechnungsperioden-Abschluss
 *
 * Schritt 1: Personen + Kostenträger auswählen → Abrechnung starten
 *            (bei überwachter Beitragsrückerstattung mit BRE-Vorschau, siehe BreAuswahl)
 * Schritt 2: Gemergtes PDF pro Gruppe prüfen + herunterladen
 * Schritt 3: PDFs extern bei PKV/Beihilfe einreichen
 * Schritt 4: Zusammenfassung bestätigen oder gesamte Abrechnung verwerfen
 *
 * Session-Persistenz: Offene Sessions überleben Browser-Neustarts.
 * Beim Mounten wird /api/abrechnungsperiode/sessions abgefragt.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useQuery, useQueries, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';
import { useKuerzungen } from '@/hooks/usePostbuch';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loader2, Play, Check, X, Download, ChevronLeft, ChevronRight, ChevronDown, FileText, Clock, AlertTriangle, ExternalLink, ClipboardCheck } from 'lucide-react';
import { useIsMobile } from '@/hooks/useIsMobile';
import { lockLandscape, unlockOrientation, useIsPortrait } from '@/hooks/useOrientationLock';
import { useAllowPortrait } from '@/hooks/usePortraitAllowed';
import { useAbrechnungLauncher } from '@/hooks/useAbrechnungLauncher';
import { MobilePdfOverlay } from '@/components/layout/MobilePdfOverlay';
import { PdfInlineViewer } from '@/components/ui/pdf-inline-viewer';
import { cn, formatCurrency } from '@/lib/utils';

// ─── Hilfsfunktion: Bytes lesbar formatieren ─────────────────────────────────
function fmtBytes(bytes) {
  if (!bytes) return '';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

// ─── Dateinamen der Downloads ────────────────────────────────────────────────
// Identisch mit den Namen in der Ablage und den Content-Disposition-Headern
// (routes/abrechnungsperiode.js), damit „Prüfen“ und „Einreichen“ gleich benennen.
function groupFileName(group) {
  return group.fileName || `${group.fileNamePart || 'Abrechnung'}.pdf`;
}

function chunkFileName(group, chunkIndex) {
  return groupFileName(group).replace(/\.pdf$/i, `_Teil${chunkIndex + 1}.pdf`);
}

// ─── Step-Indicator ───────────────────────────────────────────────────────────
function StepIndicator({ step }) {
  const steps = ['Auswahl', 'Prüfen', 'Einreichen', 'Bestätigen'];
  return (
    <div className="flex items-center gap-1 text-xs text-muted-foreground">
      {steps.map((label, i) => (
        <span key={label} className="flex items-center gap-1">
          {i > 0 && <ChevronRight className="h-3 w-3 opacity-40" />}
          <span className={cn(
            'px-1.5 py-0.5 rounded',
            i + 1 === step ? 'bg-primary/10 text-primary font-medium' : ''
          )}>
            {label}
          </span>
        </span>
      ))}
    </div>
  );
}

function PdfIdentity({ group }) {
  return (
    <div className="flex flex-wrap gap-1.5 text-xs">
      <span className={cn('rounded-full px-2 py-0.5 font-semibold', group.kostentraeger === 'PKV' ? 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200' : 'bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-200')}>
        {group.kostentraeger}
      </span>
      {(group.persons ?? []).map((person, index) => (
        <span key={person} className={cn('rounded-full px-2 py-0.5 font-medium', index % 2 === 0 ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200' : 'bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-200')}>
          {person}
        </span>
      ))}
      {(group.perioden ?? []).map((periode) => <span key={periode} className="rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-200">Periode {periode}</span>)}
    </div>
  );
}

// ─── SelectToggle – Touch-freundliche Checkbox-Alternative ───────────────────
function SelectToggle({ label, selected, onToggle, disabled }) {
  return (
    <button
      type="button"
      onClick={() => !disabled && onToggle()}
      disabled={disabled}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm transition-all select-none',
        selected
          ? 'border-primary/50 bg-primary/10 text-primary font-medium'
          : 'border-border bg-background text-foreground hover:bg-muted/50',
        disabled && 'opacity-40 cursor-not-allowed'
      )}
    >
      <span className={cn(
        'flex h-4 w-4 items-center justify-center rounded border text-[10px]',
        selected ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/40'
      )}>
        {selected && <Check className="h-3 w-3" />}
      </span>
      {label}
    </button>
  );
}

// ─── Beitragsrückerstattung im Schritt 1 ─────────────────────────────────────
// Zeigt je PKV-Person mit überwachter BRE bzw. zurückgehaltenen Perioden, was
// zurückgehalten wird und welche BRE-Jahre sich aufzugeben lohnen. Alle
// Zahlen und Folgen kommen fertig aus GET /api/analyse/bre-vorschau
// (service/bre.js); hier wird nur die passende Kombination nachgeschlagen.
// Verbindlich rechnet das Backend beim Start unter der Periodensperre neu.

function findeKombination(vorschau, aufgeben) {
  const soll = [...new Set(aufgeben)].sort((a, b) => a - b).join(',');
  return (vorschau?.kombinationen ?? []).find((k) => k.aufgeben.join(',') === soll) || null;
}

function anzahlRechnungen(n) {
  return `${n} Rechnung${n !== 1 ? 'en' : ''}`;
}

function vorzeichenBetrag(wert) {
  const n = Number(wert) || 0;
  return `${n >= 0 ? '+' : '−'}${formatCurrency(Math.abs(n))}`;
}

function BreAuswahl({ person, query, gewaehlt, onChange, detailsOffen }) {
  const [offen, setOffen] = useState(!!detailsOffen);
  if (query.isLoading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Beitragsrückerstattung {person} wird geprüft…
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="flex items-start gap-2 rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2 text-sm text-red-700">
        <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
        <span>Beitragsrückerstattung {person}: {query.error?.message}</span>
      </div>
    );
  }
  const v = query.data;
  if (!v?.relevant) return null;
  const jahre = v.entscheidungsjahre ?? [];
  const ohneJahr = (v.ohneJahr ?? []).filter((o) => !o.istWithheld);
  if (jahre.length === 0 && ohneJahr.length === 0) return null;

  const auswahl = gewaehlt ?? v.vorschlag ?? [];
  const kombi = findeKombination(v, auswahl);
  const kombiVorschlag = findeKombination(v, v.vorschlag ?? []);
  const kombiLeer = findeKombination(v, []);
  const toggle = (jahr) => {
    const next = auswahl.includes(jahr) ? auswahl.filter((j) => j !== jahr) : [...auswahl, jahr];
    onChange(next.sort((a, b) => a - b));
  };

  return (
    <div className="rounded-lg border border-violet-200 bg-violet-50/60 p-3 text-sm space-y-2 dark:border-violet-900 dark:bg-violet-950/30">
      <p className="text-xs font-semibold text-violet-800 dark:text-violet-200 uppercase tracking-wider">
        Beitragsrückerstattung {person}
      </p>
      {!v.ueberwachen && (
        <p className="text-xs text-muted-foreground">
          Die Überwachung ist ausgeschaltet. Es wird nichts Neues zurückgehalten; zurückgehaltene Perioden lassen sich unten mit einreichen.
        </p>
      )}

      {/* Vorschlag: je Jahr ein vorausgewähltes Häkchen */}
      {(v.vorschlag ?? []).map((jahr) => {
        const a = kombiVorschlag?.aufgegeben?.find((x) => x.jahr === jahr);
        const n = a?.anzahlZurueckgehalten ?? 0;
        return (
          <label key={jahr} className="flex items-start gap-2 cursor-pointer">
            <input type="checkbox" checked={auswahl.includes(jahr)} onChange={() => toggle(jahr)} className="mt-0.5 accent-violet-600" />
            <span>
              <span className="font-medium">
                BRE {jahr} aufgeben{n > 0 && <> und {n} zurückgehaltene Rechnung{n !== 1 ? 'en' : ''} mit einreichen</>}
              </span>
              {v.vorschlag.length === 1 && kombiVorschlag && (
                <span className="text-muted-foreground"> ({vorzeichenBetrag(kombiVorschlag.wert)})</span>
              )}
            </span>
          </label>
        );
      })}

      {/* Infozeilen: was mit der aktuellen Wahl zurückgehalten wird */}
      {(kombi?.haltejahre ?? []).map((h) => (
        <p key={h.jahr} className="text-xs text-violet-900 dark:text-violet-100">
          {anzahlRechnungen(h.anzahl)} {h.anzahl !== 1 ? 'werden' : 'wird'} für die BRE {h.jahr} zurückgehalten
          {h.anzahlNeu > 0 && h.anzahlNeu < h.anzahl ? ` (davon ${h.anzahlNeu} neu)` : ''}
          {' – '}erwartete Erstattung {formatCurrency(h.summe)} von {formatCurrency(h.schwelle)} Schwelle.
        </p>
      ))}
      {ohneJahr.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {anzahlRechnungen(ohneJahr.length)} ohne bekanntes Behandlungsjahr {ohneJahr.length !== 1 ? 'werden' : 'wird'} eingereicht
          ({ohneJahr.map((o) => o.postid).join(', ')}).
        </p>
      )}

      {/* Details: alle offenen Jahre frei wählbar */}
      {jahre.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setOffen((o) => !o)}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            {offen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            Details
          </button>
          {offen && (
            <div className="mt-1.5 space-y-1.5 pl-1">
              {jahre.map((jahr) => {
                const gehalten = kombiLeer?.haltejahre?.find((h) => h.jahr === jahr);
                return (
                  <label key={jahr} className="flex items-start gap-2 text-xs cursor-pointer">
                    <input type="checkbox" checked={auswahl.includes(jahr)} onChange={() => toggle(jahr)} className="mt-0.5 accent-violet-600" />
                    <span>
                      <span className="font-medium">BRE {jahr} aufgeben</span>
                      <span className="text-muted-foreground">
                        {' · '}Schwelle {formatCurrency(v.schwellen?.[jahr] ?? 0)}
                        {' · '}ohne Aufgeben zurückgehalten {formatCurrency(gehalten?.summe ?? 0)}
                      </span>
                    </span>
                  </label>
                );
              })}
              {kombi && (
                <p className="text-xs text-muted-foreground">
                  Gewählte Kombination: zusätzlich eingereicht {formatCurrency(kombi.summe)}, abzüglich der Schwellen der aufgegebenen Jahre
                  {' = '}<span className={cn('font-medium', kombi.wert >= 0 ? 'text-green-700' : 'text-orange-700')}>{vorzeichenBetrag(kombi.wert)}</span>
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Schritt 1: Auswahl ───────────────────────────────────────────────────────
function Step1Selection({ onStart, onCancel, istTier, vorauswahl }) {
  const { data, isLoading } = useQuery({
    queryKey: ['analyse', 'perioden', 'collecting'],
    queryFn: () => api.analyse.collectingPerioden(),
    staleTime: 30_000,
  });
  // Für die Prüffälle-Badge: vorgemerkte PKV-Kürzungen, clientseitig nach
  // Person+Periode gefiltert statt über einen eigenen Endpoint (Cache wird
  // bereits von Kürzungsübersicht/PeriodenPage geteilt).
  const { data: kuerzungenData } = useKuerzungen('alle');

  const collectingRows = (data?.data ?? []).filter((row) => !!row.ist_tier === istTier);
  const availablePersons = [...new Set(collectingRows.map((r) => r.person))].sort();
  const availableKT = [...new Set(collectingRows.map((r) => r.kostentraeger))].sort();

  const [selectedPersons, setSelectedPersons] = useState(new Set(vorauswahl?.persons ?? availablePersons));
  const [selectedKT, setSelectedKT] = useState(new Set(vorauswahl?.kostentraeger ?? availableKT));
  // Gewählte BRE-Jahre je Person; fehlt eine Person, gilt der Vorschlag.
  const [breWahl, setBreWahl] = useState(vorauswahl?.breAufgeben ?? {});
  const [bestrittenAck, setBestrittenAck] = useState(false);

  // Personen/KT initialisieren sobald Daten da sind
  useEffect(() => {
    if (availablePersons.length > 0 && selectedPersons.size === 0) {
      setSelectedPersons(new Set(availablePersons));
    }
    if (availableKT.length > 0 && selectedKT.size === 0) {
      setSelectedKT(new Set(availableKT));
    }
  }, [availablePersons.length, availableKT.length]); // eslint-disable-line

  const togglePerson = (p) => setSelectedPersons((prev) => {
    const next = new Set(prev);
    next.has(p) ? next.delete(p) : next.add(p);
    return next;
  });

  const toggleKT = (kt) => setSelectedKT((prev) => {
    const next = new Set(prev);
    next.has(kt) ? next.delete(kt) : next.add(kt);
    return next;
  });

  // Anzahl Dokumente in der Auswahl (geschätzt aus collectingRows)
  const relevantRows = collectingRows.filter(
    (r) => selectedPersons.has(r.person) && selectedKT.has(r.kostentraeger)
  );

  // Beitragsrückerstattung: Vorschau je ausgewählter PKV-Person (nur Menschen).
  const brePersonen = !istTier && selectedKT.has('PKV')
    ? [...new Set(relevantRows.filter((r) => r.kostentraeger === 'PKV').map((r) => r.person))].sort()
    : [];
  const breQueries = useQueries({
    queries: brePersonen.map((person) => ({
      queryKey: ['analyse', 'bre-vorschau', person],
      queryFn: () => api.analyse.breVorschau(person),
      staleTime: 30_000,
      retry: false,
    })),
  });

  // Bestrittene Rechnungen in der Auswahl: werden nie mit eingereicht, sondern
  // laufen automatisch in die neue Sammelperiode weiter (siehe Backend).
  const bestrittenCount = relevantRows.reduce((sum, r) => sum + (r.bestritten_count || 0), 0);

  // Ändert sich die Auswahl, muss der Hinweis erneut bestätigt werden.
  useEffect(() => { setBestrittenAck(false); }, [bestrittenCount]);

  const canStart = selectedPersons.size > 0 && selectedKT.size > 0 && relevantRows.length > 0
    && (bestrittenCount === 0 || bestrittenAck);

  // Prüffälle-Zahl über alle ausgewählten PKV-Zielperioden (person+periode).
  const pkvZiele = relevantRows.filter((r) => r.kostentraeger === 'PKV');
  const pruefFaelleCount = selectedKT.has('PKV')
    ? (kuerzungenData?.data ?? []).filter((k) =>
        k.pkv_pruefung_status === 'VORGEMERKT'
        && pkvZiele.some((z) => z.person === k.behandelte_person && z.periode === k.pkv_pruefung_periode)
      ).length
    : 0;

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Lade aktive Perioden…
      </div>
    );
  }

  if (availablePersons.length === 0) {
    return (
      <div className="py-3 text-sm text-muted-foreground">
        Keine aktiven SAMMELT-Perioden mit Dokumenten vorhanden.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Personen */}
      <div>
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">{istTier ? 'Tiere' : 'Menschen'}</p>
        <div className="flex flex-wrap gap-2">
          {availablePersons.map((p) => (
            <SelectToggle key={p} label={p} selected={selectedPersons.has(p)} onToggle={() => togglePerson(p)} />
          ))}
        </div>
      </div>

      {/* Kostenträger */}
      <div>
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Kostenträger</p>
        <div className="flex flex-wrap gap-2">
          {availableKT.map((kt) => (
            <SelectToggle key={kt} label={kt} selected={selectedKT.has(kt)} onToggle={() => toggleKT(kt)} />
          ))}
        </div>
      </div>

      {/* Beitragsrückerstattung je PKV-Person */}
      {brePersonen.map((person, i) => (
        <BreAuswahl
          key={person}
          person={person}
          query={breQueries[i]}
          gewaehlt={breWahl[person]}
          onChange={(jahre) => setBreWahl((prev) => ({ ...prev, [person]: jahre }))}
          detailsOffen={!!vorauswahl?.breAufgeben?.[person]}
        />
      ))}

      {/* Hinweis: bestrittene Rechnungen werden übersprungen */}
      {bestrittenCount > 0 && (
        <label className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 cursor-pointer dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100">
          <input
            type="checkbox"
            checked={bestrittenAck}
            onChange={(e) => setBestrittenAck(e.target.checked)}
            className="mt-0.5 accent-amber-600"
          />
          <span>
            <span className="font-medium">
              {bestrittenCount} bestrittene Rechnung{bestrittenCount !== 1 ? 'en' : ''} in dieser Auswahl{' '}
              {bestrittenCount !== 1 ? 'werden' : 'wird'} nicht mit eingereicht.
            </span>{' '}
            Sie {bestrittenCount !== 1 ? 'bleiben' : 'bleibt'} zunächst in ihrer Periode und {bestrittenCount !== 1 ? 'wandern' : 'wandert'} beim
            Bestätigen automatisch in die neue Sammelperiode – in der Hoffnung, dass der Streitfall bis zu deren
            Abschluss gelöst ist.
          </span>
        </label>
      )}

      {/* Zusammenfassung + Aktionen */}
      <div className="flex items-center justify-between pt-1 border-t gap-2">
        <span className="text-xs text-muted-foreground flex items-center gap-2 flex-wrap">
          {relevantRows.length > 0
            ? `${relevantRows.length} Periode${relevantRows.length !== 1 ? 'n' : ''} ausgewählt`
            : 'Keine passenden Perioden'}
          {pruefFaelleCount > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 text-amber-800 px-2 py-0.5 font-medium">
              <ClipboardCheck className="h-3 w-3" />
              {pruefFaelleCount} Prüffall{pruefFaelleCount !== 1 ? '-Fälle' : ''} (PKV) werden mit eingereicht
            </span>
          )}
        </span>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Abbrechen
          </Button>
          <Button size="sm" disabled={!canStart} onClick={() => {
            // Nur Personen mit geladener Vorschau mitschicken; sonst gilt
            // im Backend der Vorschlag.
            const breAufgeben = {};
            brePersonen.forEach((person, i) => {
              const v = breQueries[i]?.data;
              if (!v?.relevant || (v.entscheidungsjahre ?? []).length === 0) return;
              breAufgeben[person] = (breWahl[person] ?? v.vorschlag ?? [])
                .filter((j) => v.entscheidungsjahre.includes(j));
            });
            onStart([...selectedPersons], [...selectedKT], Object.keys(breAufgeben).length > 0 ? breAufgeben : undefined);
          }}>
            <Play className="h-3.5 w-3.5" />
            Abrechnung starten
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── Schritt 2: Prüfen (PDF-Ansicht pro Gruppe) ───────────────────────────────
function Step2Review({ session, onNext, onCancel, isRejecting }) {
  const [activeGroup, setActiveGroup] = useState(0);
  const isMobile = useIsMobile();
  const isPortrait = useIsPortrait();

  const groups = session?.groups ?? [];
  const group = groups[activeGroup];

  // Teilt der AppShell mit, dass Hochformat während Step 2 zulässig ist,
  // damit sie nicht das LandscapeOnly-Overlay einblendet (was Step2Review
  // unmounten und den Lock-Cleanup triggern würde – Endlos-Flipflop).
  useAllowPortrait(isMobile);

  // Mobile: Orientation-Lock aufheben, damit User ins Portrait drehen kann um PDF zu sehen.
  // Beim Verlassen von Step 2: wieder zurück zu Landscape.
  useEffect(() => {
    if (!isMobile) return;
    unlockOrientation();
    return () => { lockLandscape(); };
  }, [isMobile]);

  // Portrait-Fullscreen-PDF-Viewer: exakt wie bei DocumentDetailPage
  if (isMobile && isPortrait && group) {
    return (
      <MobilePdfOverlay
        pdfUrl={api.abrechnungsperiode.pdfUrl(session.sessionId, activeGroup)}
        fileName={groupFileName(group)}
      />
    );
  }

  return (
    <div className="space-y-3">
      {/* Gruppen-Tabs */}
      {groups.length > 1 && (
        <div className="flex gap-1.5 border-b pb-2">
          {groups.map((g, i) => (
            <button
              key={g.kostentraeger}
              onClick={() => setActiveGroup(i)}
              className={cn(
                'px-3 py-1 rounded text-sm transition-colors',
                i === activeGroup
                  ? 'bg-primary/10 text-primary font-medium'
                  : 'text-muted-foreground hover:bg-muted/50'
              )}
            >
              {g.kostentraeger}
              <Badge variant="outline" className="ml-1.5 text-[10px] px-1 py-0">
                {g.documentCount}
              </Badge>
              {g.pruefungCount > 0 && (
                <Badge variant="outline" className="ml-1 text-[10px] px-1 py-0 text-amber-700 border-amber-200 bg-amber-50">
                  <ClipboardCheck className="h-2.5 w-2.5" />{g.pruefungCount}
                </Badge>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Gruppen-Info + Download */}
      {group && (
        <div className="space-y-2">
          <div className="flex items-start justify-between text-sm gap-3">
            <div className="text-muted-foreground">
              <PdfIdentity group={group} />
              <div className="mt-1">
              {group.documentCount} Dokument{group.documentCount !== 1 ? 'e' : ''}
              </div>
              {group.pruefungCount > 0 && (
                <div className="mt-1 flex items-center gap-1 text-amber-700">
                  <ClipboardCheck className="h-3.5 w-3.5 shrink-0" />
                  {group.pruefungCount} Prüffall{group.pruefungCount !== 1 ? '-Fälle' : ''}: am Ende dieses PDFs
                  folgt ein Vorblatt mit gekennzeichneten Beihilfebescheiden und Rechnungen zur Gegenprüfung durch die PKV.
                </div>
              )}
            </div>
            <div className="flex flex-col items-end gap-1 shrink-0">
              <a
                href={api.abrechnungsperiode.pdfUrl(session.sessionId, activeGroup)}
                download={groupFileName(group)}
                className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline"
              >
                <Download className="h-3.5 w-3.5" />
                PDF herunterladen{group.totalSizeBytes ? ` (${fmtBytes(group.totalSizeBytes)})` : ''}
              </a>
              {/* Die eingebettete Vorschau rendert ohne Browser-Toolbar; wer Zoom,
                  Volltextsuche oder Drucken braucht, öffnet das PDF nativ. */}
              <a
                href={api.abrechnungsperiode.pdfUrl(session.sessionId, activeGroup)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground hover:underline"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                In neuem Tab öffnen
              </a>
            </div>
          </div>

          {/* Chunk-Downloads für Kostenträger-Upload wenn Datei > 3 MB */}
          {group.chunks && group.chunks.length > 1 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50/80 dark:bg-amber-950/30 dark:border-amber-800 p-3 space-y-2">
              <div className="flex items-center gap-1.5 text-xs text-amber-800 dark:text-amber-400 font-medium">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                Datei zu groß für Kostenträger-Upload – aufgeteilt in {group.chunks.length} Teile
              </div>
              <div className="flex flex-wrap gap-2">
                {group.chunks.map((chunk, ci) => (
                  <a
                    key={ci}
                    href={api.abrechnungsperiode.chunkUrl(session.sessionId, activeGroup, ci)}
                    download={chunkFileName(group, ci)}
                    className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-900 dark:text-amber-200 bg-white dark:bg-amber-900/30 border border-amber-300 dark:border-amber-700 rounded-md px-2.5 py-1.5 hover:bg-amber-50 dark:hover:bg-amber-900/50 transition-colors"
                  >
                    <Download className="h-3.5 w-3.5" />
                    {chunk.label}{chunk.sizeBytes ? ` · ${fmtBytes(chunk.sizeBytes)}` : ''}
                  </a>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* PDF-Viewer */}
      {group && (
        isMobile ? (
          <div className="rounded-lg border bg-muted/20 p-4 space-y-3">
            <div className="flex flex-col items-center gap-2">
              <FileText className="h-8 w-8 text-muted-foreground/50" />
              <p className="text-sm text-muted-foreground text-center">
                Zum Anzeigen: Gerät hochkant drehen
              </p>
            </div>
            <a
              href={api.abrechnungsperiode.pdfUrl(session.sessionId, activeGroup)}
              download={groupFileName(group)}
              className="flex items-center justify-center gap-1.5 text-sm text-primary font-medium w-full rounded-md border border-primary/30 py-2"
            >
              <Download className="h-4 w-4" />
              {group.kostentraeger}-Abrechnung{group.totalSizeBytes ? ` (${fmtBytes(group.totalSizeBytes)})` : ''}
            </a>
            {group.chunks && group.chunks.length > 1 && (
              <div className="space-y-2">
                <p className="text-xs text-amber-700 font-medium text-center flex items-center justify-center gap-1">
                  <AlertTriangle className="h-3 w-3" />
                  Für Kostenträger-Upload ({group.chunks.length} Teile):
                </p>
                <div className="flex flex-col gap-2">
                  {group.chunks.map((chunk, ci) => (
                    <a
                      key={ci}
                      href={api.abrechnungsperiode.chunkUrl(session.sessionId, activeGroup, ci)}
                      download={chunkFileName(group, ci)}
                      className="flex items-center justify-center gap-1.5 text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded-md py-2 font-medium"
                    >
                      <Download className="h-4 w-4" />
                      {chunk.label}{chunk.sizeBytes ? ` · ${fmtBytes(chunk.sizeBytes)}` : ''}
                    </a>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <PdfInlineViewer
            key={`${session.sessionId}-${activeGroup}`}
            file={api.abrechnungsperiode.pdfUrl(session.sessionId, activeGroup)}
            className="w-full"
            style={{ height: '65vh', minHeight: '400px' }}
          />
        )
      )}

      {/* Navigation */}
      <div className="flex items-center justify-between pt-1 border-t gap-2">
        <Button variant="outline" size="sm" onClick={onCancel} disabled={isRejecting}>
          {isRejecting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
          Abbrechen
        </Button>
        <div className="flex items-center gap-2">
          {groups.length > 1 && (
            <div className="flex gap-1">
              <Button variant="ghost" size="sm" disabled={activeGroup === 0}
                onClick={() => setActiveGroup((i) => i - 1)}>
                <ChevronLeft className="h-3.5 w-3.5" />
              </Button>
              <Button variant="ghost" size="sm" disabled={activeGroup === groups.length - 1}
                onClick={() => setActiveGroup((i) => i + 1)}>
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          )}
          <Button size="sm" onClick={onNext}>
            Weiter
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── Schritt 3: Extern einreichen ───────────────────────────────────────────
function Step3Submit({ session, onNext, onBack, onCancel, isRejecting }) {
  const groups = session?.groups ?? [];
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 text-sm space-y-2">
        <p className="font-semibold">Jetzt außerhalb von postbuch.net einreichen</p>
        <ol className="list-decimal pl-5 space-y-1 text-muted-foreground">
          <li>Alle PDFs herunterladen und speichern.</li>
          <li>Bei PKV und/oder Beihilfe im Portal hochladen. Für eine Handy-App die Dateien aufs Handy übertragen, z. B. per E-Mail an sich selbst oder über ein USB-Datenkabel.</li>
          <li>Nach der externen Einreichung unten weitergehen.</li>
        </ol>
      </div>
      <div className="space-y-3">
        {groups.map((group, groupIndex) => (
          <div key={`${group.kostentraeger}-${groupIndex}`} className="rounded-lg border p-3 space-y-2">
            <PdfIdentity group={group} />
            <p className="text-base font-semibold break-all">{groupFileName(group)}</p>
            <p className="text-xs text-muted-foreground">{group.documentCount} Dokument{group.documentCount !== 1 ? 'e' : ''}{group.totalSizeBytes ? ` · ${fmtBytes(group.totalSizeBytes)}` : ''}</p>
            <a href={api.abrechnungsperiode.pdfUrl(session.sessionId, groupIndex)} download={groupFileName(group)} className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">
              <Download className="h-4 w-4" />PDF herunterladen
            </a>
            {group.chunks?.length > 1 && <div className="rounded-md bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-200 space-y-1.5"><p className="font-medium">Für den Upload bei {group.kostentraeger} bitte diese Teil-PDFs verwenden:</p>{group.chunks.map((chunk, chunkIndex) => <a key={chunkIndex} href={api.abrechnungsperiode.chunkUrl(session.sessionId, groupIndex, chunkIndex)} download={chunkFileName(group, chunkIndex)} className="flex items-center gap-1 underline"><Download className="h-3.5 w-3.5" />{chunk.label}</a>)}</div>}
          </div>
        ))}
      </div>
      <p className="text-xs font-medium text-amber-700">Wichtig: Auf der nächsten Seite muss der Abschluss noch bestätigt werden. Erst dann werden die Perioden geschlossen und die temporären PDFs gelöscht.</p>
      <div className="flex items-center justify-between border-t pt-3 gap-2">
        <Button variant="outline" size="sm" onClick={onCancel} disabled={isRejecting}><X className="h-3.5 w-3.5" />Abbrechen</Button>
        <div className="flex gap-2"><Button variant="ghost" size="sm" onClick={onBack}>Zurück</Button><Button size="sm" onClick={onNext}>Zur Bestätigung<ChevronRight className="h-3.5 w-3.5" /></Button></div>
      </div>
    </div>
  );
}

// ─── Schritt 4: Bestätigen ──────────────────────────────────────────────────
function Step4Confirm({ session, breEntscheidung, onConfirm, onReject, isConfirming, isRejecting }) {
  const groups = session?.groups ?? [];
  const [acknowledged, setAcknowledged] = useState(false);

  return (
    <div className="space-y-4">
      <div className="rounded-lg bg-muted/30 border p-3 space-y-2">
        <p className="text-sm font-medium">Folgende Perioden werden abgeschlossen:</p>
        <ul className="space-y-1">
          {groups.map((g) => (
            <li key={g.kostentraeger} className="text-sm flex items-start gap-2">
              <Check className="h-3.5 w-3.5 mt-0.5 text-green-600 flex-shrink-0" />
              <span>
                <span className="font-medium">{g.kostentraeger}</span>
                {' – '}
                {g.persons?.join(', ')}
                {g.perioden?.length > 0 && (
                  <span className="text-muted-foreground"> (Periode {g.perioden.map((p) => `${p} → ${p + 1}`).join(', ')})</span>
                )}
                <span className="text-muted-foreground ml-1">· {g.documentCount} Dok.</span>
                {g.pruefungCount > 0 && (
                  <span className="text-amber-700 ml-1">· {g.pruefungCount} Prüffall{g.pruefungCount !== 1 ? '-Fälle' : ''} mit Vorblatt + gekennzeichneten Anlagen</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      </div>
      <p className="text-xs text-muted-foreground">
        Nach der Bestätigung werden die Perioden auf EINGEREICHT gesetzt und neue SAMMELT-Perioden angelegt.
        Die temporären PDFs auf OneDrive werden automatisch gelöscht.
        {breEntscheidung && Object.keys(breEntscheidung).length > 0 && (
          <> Für die Beitragsrückerstattung zurückgehaltene Rechnungen wandern dabei in ZURÜCKGEHALTEN-Perioden.</>
        )}
      </p>
      <label className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 cursor-pointer dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100">
        <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} className="mt-0.5 accent-amber-600" />
        <span className="font-medium">Ich habe die PDFs gespeichert und extern eingereicht bzw. führe die Einreichung jetzt außerhalb von postbuch.net durch.</span>
      </label>

      <div className="flex items-center justify-between pt-1 border-t gap-2">
        <Button variant="outline" size="sm" onClick={onReject} disabled={isRejecting || isConfirming}>
          {isRejecting
            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
            : <X className="h-3.5 w-3.5" />}
          Abbrechen
        </Button>
        <Button size="sm" onClick={onConfirm} disabled={!acknowledged || isConfirming || isRejecting}>
          {isConfirming
            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
            : <Check className="h-3.5 w-3.5" />}
          Jetzt bestätigen
        </Button>
      </div>
    </div>
  );
}

// ─── AbrechnungWizardCard (Haupt-Export) ──────────────────────────────────────
export default function AbrechnungWizardCard({ istTier = false }) {
  const qc = useQueryClient();
  const { launchRequest, consumeLaunch } = useAbrechnungLauncher();

  // Schritt 0 = Wizard geschlossen, 1–4 = aktive Schritte
  const [step, setStep] = useState(0);
  const [session, setSession] = useState(null); // { sessionId, groups }
  // Hinweis nach dem Bestätigen, falls seit dem PDF-Bau etwas dazugekommen ist
  // und automatisch in die neue Periode verschoben wurde (siehe confirmAbrechnungsperiode).
  const [nachlaufHinweis, setNachlaufHinweis] = useState(null);
  // Beitragsrückerstattung: Entscheidung aus /start (für Schritt 4) und
  // Ergebnis des Bestätigens (Hinweis im geschlossenen Zustand).
  const [breEntscheidung, setBreEntscheidung] = useState(null);
  const [breHinweis, setBreHinweis] = useState(null);
  // Vorauswahl für Schritt 1 (z. B. „Einreichen“ an einer BRE-Periode).
  const [vorauswahl, setVorauswahl] = useState(null);

  // Offene Sessions beim Mounten prüfen
  const { data: pendingData } = useQuery({
    queryKey: ['abrechnungsperiode', 'sessions'],
    queryFn: () => api.abrechnungsperiode.sessions(),
    staleTime: 60_000,
  });
  const pendingSessions = pendingData?.sessions ?? [];

  // ── Start-Job per SSE ──────────────────────────────────────────────────────
  // progress: null = kein laufender Job, { done, total, label } = läuft
  const [startProgress, setStartProgress] = useState(null); // { done, total, label }
  const [startError, setStartError]       = useState(null);
  const esRef = useRef(null); // EventSource-Referenz für Cleanup
  // Laufender Start: Session-ID aus der Startantwort (vor 'done' noch nicht in
  // `session`) und ob der Nutzer inzwischen abgebrochen hat. Ohne beides
  // bliebe eine abgebrochene Session auf dem Server liegen und sperrte die
  // Perioden für den nächsten Start.
  const startRef = useRef(null); // { sessionId, abgebrochen }

  const launchJob = useCallback((payload) => {
    setStartProgress({ done: 0, total: 0, label: 'Starte…' });
    setStartError(null);

    setBreEntscheidung(null);
    const lauf = { sessionId: null, abgebrochen: false };
    startRef.current = lauf;
    api.abrechnungsperiode.start(payload).then(({ jobId, sessionId, bre }) => {
      lauf.sessionId = sessionId;
      if (lauf.abgebrochen) {
        verwirfAbgebrocheneSession(sessionId);
        return;
      }
      setBreEntscheidung(bre ?? null);
      const es = new EventSource(api.abrechnungsperiode.progressUrl(jobId));
      esRef.current = es;
      let settled = false;

      es.addEventListener('progress', (e) => {
        setStartProgress(JSON.parse(e.data));
      });

      es.addEventListener('done', (e) => {
        settled = true;
        if (startRef.current === lauf) startRef.current = null;
        es.close();
        esRef.current = null;
        const data = JSON.parse(e.data);
        setStartProgress(null);
        setSession(data);
        setStep(2);
        qc.invalidateQueries({ queryKey: ['abrechnungsperiode', 'sessions'] });
      });

      es.addEventListener('error', (e) => {
        settled = true;
        es.close();
        esRef.current = null;
        let msg = 'Die PDF-Erstellung wurde unterbrochen. Bitte erneut versuchen; bei wiederholtem Auftreten die Protokolle prüfen.';
        if (e.data) {
          try { msg = JSON.parse(e.data).message || msg; } catch { msg = String(e.data); }
        }
        setStartProgress(null);
        setStartError(msg);
        setStep(1); // zurück zur Auswahl
      });

      es.onerror = () => {
        if (settled) return;
        settled = true;
        es.close();
        esRef.current = null;
        setStartProgress(null);
        setStartError('Die Verbindung zur PDF-Erstellung wurde unterbrochen. Bitte erneut versuchen; bei wiederholtem Auftreten die Protokolle prüfen.');
        setStep(1);
      };
    }).catch((err) => {
      if (lauf.abgebrochen) return;
      setStartProgress(null);
      setStartError(err?.message ?? 'Unbekannter Fehler');
      setStep(1);
    });
  }, [qc]); // eslint-disable-line

  // Eine noch im Aufbau befindliche Session verwerfen; der Server bricht den
  // Aufbau dann ab und gibt die Perioden frei.
  function verwirfAbgebrocheneSession(sessionId) {
    if (!sessionId) return;
    api.abrechnungsperiode.reject(sessionId)
      .catch(() => {})
      .finally(() => qc.invalidateQueries({ queryKey: ['abrechnungsperiode', 'sessions'] }));
  }

  // Cleanup bei Unmount
  useEffect(() => () => { esRef.current?.close(); }, []);

  // ── Mutations ──────────────────────────────────────────────────────────────
  const confirmMutation = useMutation({
    mutationFn: () => api.abrechnungsperiode.confirm(session.sessionId),
    onSuccess: (result) => {
      setStep(0);
      setSession(null);
      const teile = [];
      if (result?.verschobeneRechnungen > 0) teile.push(`${result.verschobeneRechnungen} Rechnung(en)`);
      if (result?.verschobenePruefungen > 0) teile.push(`${result.verschobenePruefungen} Prüfvormerkung(en)`);
      if (result?.verschobenePins > 0) teile.push(`${result.verschobenePins} Anpinnung(en)`);
      setNachlaufHinweis(teile.length > 0
        ? `Nach der PDF-Erstellung sind noch dazugekommen und wurden automatisch in die neue Periode verschoben: ${teile.join(', ')}.`
        : null);
      const breTeile = (result?.bre ?? []).map((b) => {
        const t = [];
        if (b.aufgeben?.length > 0) t.push(`BRE ${b.aufgeben.join(', ')} aufgegeben`);
        if (b.zurueckgehalten?.length > 0) {
          const jahre = [...new Set(b.zurueckgehalten.map((z) => z.jahr))].sort((x, y) => x - y);
          t.push(`${anzahlRechnungen(b.zurueckgehalten.length)} für die BRE ${jahre.join(', ')} zurückgehalten`);
        }
        for (const n of b.neuePerioden ?? []) t.push(`neue ZURÜCKGEHALTEN-Periode #${n.periode} (BRE ${n.jahr})`);
        return t.length > 0 ? `${b.person}: ${t.join(', ')}` : null;
      }).filter(Boolean);
      setBreHinweis(breTeile.length > 0 ? `Beitragsrückerstattung – ${breTeile.join('; ')}.` : null);
      setBreEntscheidung(null);
      qc.invalidateQueries({ queryKey: ['analyse', 'perioden'] });
      qc.invalidateQueries({ queryKey: ['analyse', 'bre-vorschau'] });
      qc.invalidateQueries({ queryKey: ['abrechnungsperiode', 'sessions'] });
    },
  });

  const rejectMutation = useMutation({
    mutationFn: () => api.abrechnungsperiode.reject(session.sessionId),
    onSuccess: () => {
      setStep(0);
      setSession(null);
      qc.invalidateQueries({ queryKey: ['abrechnungsperiode', 'sessions'] });
    },
  });

  // ── Handlers ───────────────────────────────────────────────────────────────
  function handleStart(persons, kostentraeger, breAufgeben) {
    setStep(1);
    launchJob(breAufgeben ? { persons, kostentraeger, bre_aufgeben: breAufgeben } : { persons, kostentraeger });
  }

  function handleResumeSession(s) {
    setSession({ sessionId: s.id, groups: s.groups });
    setStep(2);
  }

  // Extern ausgelöstes Starten mit einer konkreten Periode (von PeriodenPage)
  useEffect(() => {
    if (!launchRequest) return;
    if (step !== 0) return; // kollidiert mit offenem Wizard? → einfach ignorieren
    if (pendingSessions.length > 0) return; // Wiederaufnahme hat Vorrang
    const sel = launchRequest.selection;
    if (!sel) return;
    if (sel.breJahr != null) {
      // „Einreichen“ an einer BRE-Periode: Auswahl mit diesem Jahr
      // angehakt öffnen statt direkt zu starten – die Einreichung läuft über
      // die PKV-Sammelperiode der Person, und der Nutzer sieht die Folgen.
      setVorauswahl({
        id: launchRequest.id,
        persons: [sel.person],
        kostentraeger: ['PKV'],
        breAufgeben: { [sel.person]: [sel.breJahr] },
      });
      setStartError(null);
      setStep(1);
      consumeLaunch();
      return;
    }
    setStep(1);
    launchJob({ selections: [{ person: sel.person, kostentraeger: sel.kostentraeger, periode: sel.periode }] });
    consumeLaunch();
  }, [launchRequest, step, pendingSessions.length]); // eslint-disable-line

  function handleCancel() {
    esRef.current?.close();
    esRef.current = null;
    setStartProgress(null);
    if (session) {
      rejectMutation.mutate();
    } else {
      const lauf = startRef.current;
      if (lauf && !lauf.abgebrochen) {
        lauf.abgebrochen = true;
        verwirfAbgebrocheneSession(lauf.sessionId); // ohne ID: erledigt der Start-Callback
      }
      setStep(0);
    }
  }

  // ── Render: geschlossen ────────────────────────────────────────────────────
  if (step === 0) {
    return (
      <Card>
        <CardContent className="pt-4 pb-4">
          {nachlaufHinweis && (
            <div className="flex items-start gap-2 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 mb-3">
              <AlertTriangle className="h-4 w-4 text-amber-700 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-amber-800 flex-1">{nachlaufHinweis}</p>
              <button
                onClick={() => setNachlaufHinweis(null)}
                className="text-amber-700 hover:text-amber-900 flex-shrink-0"
                aria-label="Hinweis schließen"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          )}
          {breHinweis && (
            <div className="flex items-start gap-2 rounded-lg bg-violet-50 border border-violet-200 px-3 py-2 mb-3 dark:bg-violet-950/30 dark:border-violet-900">
              <Check className="h-4 w-4 text-violet-700 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-violet-900 dark:text-violet-100 flex-1">{breHinweis}</p>
              <button
                onClick={() => setBreHinweis(null)}
                className="text-violet-700 hover:text-violet-900 flex-shrink-0"
                aria-label="Hinweis schließen"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          )}
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2 text-sm">
              <FileText className="h-4 w-4 text-muted-foreground" />
              <span className="font-medium">Abrechnung einreichen</span>
              <span className="text-muted-foreground text-xs">PDFs mergen + Perioden abschließen</span>
            </div>
            <div className="flex items-center gap-2">
              {/* Banner: offene Session */}
              {pendingSessions.length > 0 && (
                <button
                  onClick={() => handleResumeSession(pendingSessions[0])}
                  className="inline-flex items-center gap-1.5 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5 hover:bg-amber-100 transition-colors"
                >
                  <Clock className="h-3.5 w-3.5" />
                  Offene Abrechnung fortsetzen
                </button>
              )}
              <Button size="sm" onClick={() => { setVorauswahl(null); setStep(1); }}>
                <Play className="h-3.5 w-3.5" />
                Starten
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  // ── Render: Wizard offen ───────────────────────────────────────────────────
  const isLoading = startProgress !== null;
  const progressPct = (isLoading && startProgress.total > 0)
    ? Math.round((startProgress.done / startProgress.total) * 100)
    : null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">Neue Abrechnung</CardTitle>
          <StepIndicator step={step} />
        </div>
        {startError && (
          <div className="flex items-start gap-2 rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2 mt-2">
            <AlertTriangle className="h-4 w-4 text-red-600 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-red-700">{startError}</p>
          </div>
        )}
        {confirmMutation.isError && (
          <div className="flex items-start gap-2 rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2 mt-2">
            <AlertTriangle className="h-4 w-4 text-red-600 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-red-700">{confirmMutation.error?.message}</p>
          </div>
        )}
      </CardHeader>

      <CardContent>
        {/* Schritt 1: Auswahl (inkl. Fortschrittsbalken nach Start) */}
        {step === 1 && (
          isLoading ? (
            <div className="flex flex-col gap-4 py-6">
              {/* Balken */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>{startProgress.label}</span>
                  {progressPct !== null && <span>{progressPct} %</span>}
                </div>
                <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full rounded-full bg-primary transition-all duration-300"
                    style={{ width: progressPct !== null ? `${progressPct}%` : '0%' }}
                  />
                </div>
                {startProgress.total > 0 && (
                  <p className="text-xs text-muted-foreground text-right">
                    {startProgress.done} / {startProgress.total} Schritte
                  </p>
                )}
              </div>
              <Button variant="outline" size="sm" className="self-start" onClick={handleCancel}>
                <X className="h-3.5 w-3.5" />
                Abbrechen
              </Button>
            </div>
          ) : (
            <Step1Selection
              key={vorauswahl?.id ?? 'standard'}
              vorauswahl={vorauswahl}
              onStart={handleStart}
              onCancel={() => { setStartError(null); setStep(0); }}
              istTier={istTier}
            />
          )
        )}

        {/* Schritt 2: PDF-Prüfung */}
        {step === 2 && (
          <Step2Review
            session={session}
            onNext={() => setStep(3)}
            onCancel={handleCancel}
            isRejecting={rejectMutation.isPending}
          />
        )}

        {/* Schritt 3: Extern einreichen */}
        {step === 3 && (
          <Step3Submit
            session={session}
            onNext={() => setStep(4)}
            onBack={() => setStep(2)}
            onCancel={handleCancel}
            isRejecting={rejectMutation.isPending}
          />
        )}

        {/* Schritt 4: Bestätigung */}
        {step === 4 && <Step4Confirm session={session} breEntscheidung={breEntscheidung} onConfirm={() => confirmMutation.mutate()} onReject={handleCancel} isConfirming={confirmMutation.isPending} isRejecting={rejectMutation.isPending} />}
      </CardContent>
    </Card>
  );
}
