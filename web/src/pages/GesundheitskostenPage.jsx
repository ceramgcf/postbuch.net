import { useMemo, useRef, useState } from 'react';
import { useSearchParams, useLocation, useNavigate } from 'react-router';
import { useGesundheitskosten } from '@/hooks/usePostbuch';
import { useGemerkteFilter } from '@/hooks/useGemerkteFilter';
import { api } from '@/api/client';
import { GlowHeading } from '@/components/ui/GlowHeading';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { PageLoader, EmptyState } from '@/components/ui/spinner';
import { ExcelExportButton } from '@/components/ExcelExportButton';
import { FilterPopover, FilterChip, FilterLeiste, AuswahlLeiste } from '@/components/AnalyseFilter';
import { formatDate, formatCurrency } from '@/lib/utils';
import { HeartPulse, Archive, Hourglass, PawPrint, AlertTriangle, CheckCircle2 } from 'lucide-react';

// Schlüssel der API: Jahr 'YYYY' oder 'offen' (noch nicht bezahlt),
// Person = Kurzname, 'ohne' (Mensch ohne Zuordnung) oder 'ohne_tier'.
const JAHR_OFFEN = 'offen';
const PERSON_OHNE = 'ohne';
const TIER_OHNE = 'ohne_tier';
const jahrLabel = (jahr) => (jahr === JAHR_OFFEN ? 'Noch nicht bezahlt' : jahr);
const personLabel = (person) => (person === PERSON_OHNE ? 'Ohne Person'
  : person === TIER_OHNE ? 'Tier ohne Zuordnung' : person);

const GRUPPEN = [
  { wert: 'personen', label: 'Alle Personen' },
  { wert: 'tiere', label: 'Alle Tiere' },
  { wert: 'alle', label: 'Alle Tiere und Personen' },
];
const passtZurGruppe = (istTier, gruppe) =>
  gruppe === 'alle' || (gruppe === 'tiere' ? istTier : !istTier);

const cent = (wert) => Math.round(parseFloat(wert || 0) * 100);
const summiere = (gruppen) => gruppen.reduce((s, g) => ({
  anzahl: s.anzahl + g.anzahl,
  rechnung: s.rechnung + cent(g.summe_rechnung),
  erstattet: s.erstattet + cent(g.summe_erstattet),
  eigenbehalt: s.eigenbehalt + cent(g.summe_eigenbehalt),
}), { anzahl: 0, rechnung: 0, erstattet: 0, eigenbehalt: 0 });

// Personensummen aus den (ggf. gefilterten) Einzelrechnungen, in Cent gerechnet
const mitSummen = (p, rechnungen) => {
  const sum = (feld) => (rechnungen.reduce((s, r) => s + cent(r[feld]), 0) / 100).toFixed(2);
  return {
    ...p, rechnungen, anzahl: rechnungen.length,
    summe_rechnung: sum('rechnungssumme'), summe_erstattet: sum('erstattet'), summe_eigenbehalt: sum('eigenbehalt'),
  };
};

function Betraege({ rechnung, erstattet, eigenbehalt }) {
  return (
    <div className="flex items-center gap-2 flex-wrap justify-end">
      <Badge variant="outline" className="font-mono text-xs" title="Rechnungssumme">
        {formatCurrency(rechnung / 100)}
      </Badge>
      <Badge
        variant="outline"
        className="font-mono text-xs text-emerald-700 border-emerald-200 bg-emerald-50"
        title="Erstattet"
      >
        {formatCurrency(erstattet / 100)}
      </Badge>
      <Badge
        variant="outline"
        className="font-mono font-semibold text-sm text-rose-700 border-rose-200 bg-rose-50"
        title="Eigenbehalt"
      >
        Eigenbehalt: {formatCurrency(eigenbehalt / 100)}
      </Badge>
    </div>
  );
}

// Seitensummen als ruhige Textzeile neben dem Filter (wie auf der Handwerkerseite)
function GesamtZeile({ rechnung, erstattet, eigenbehalt }) {
  return (
    <div className="flex items-baseline gap-5 text-sm tabular-nums flex-wrap">
      <span className="text-muted-foreground">
        Rechnungen <strong className="ml-1 text-base font-semibold text-foreground">{formatCurrency(rechnung / 100)}</strong>
      </span>
      <span className="text-muted-foreground">
        erstattet <strong className="ml-1 text-base font-semibold text-emerald-700 dark:text-emerald-400">{formatCurrency(erstattet / 100)}</strong>
      </span>
      <span className="text-muted-foreground">
        Eigenbehalt <strong className="ml-1 text-base font-semibold text-rose-700 dark:text-rose-400">{formatCurrency(eigenbehalt / 100)}</strong>
      </span>
    </div>
  );
}

export default function GesundheitskostenPage() {
  const { data, isLoading, error } = useGesundheitskosten();
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const defaultsApplied = useRef(false);
  const gemerkt = useGemerkteFilter('gesundheitskosten', searchParams);

  const gruppe = GRUPPEN.some((g) => g.wert === searchParams.get('gruppe'))
    ? searchParams.get('gruppe') : 'personen';

  const alleJahre = useMemo(() => data?.filter?.jahre || [], [data]);
  const allePersonen = useMemo(() =>
    (data?.filter?.personen || []).filter((p) => passtZurGruppe(p.ist_tier, gruppe)).map((p) => p.person),
  [data, gruppe]);

  // Default: die letzten zwei Zahljahre (ohne „noch nicht bezahlt")
  const defaultJahre = useMemo(() => {
    const bezahlt = alleJahre.filter((j) => j !== JAHR_OFFEN);
    return (bezahlt.length > 0 ? bezahlt : alleJahre).slice(0, 2);
  }, [alleJahre]);

  const selectedJahre = useMemo(() => {
    const param = searchParams.get('jahre');
    return param ? param.split(',') : defaultJahre;
  }, [searchParams, defaultJahre]);

  // Personen: ohne Parameter alle
  const selectedPersonen = useMemo(() => {
    const param = searchParams.get('personen');
    return param ? param.split(',') : allePersonen;
  }, [searchParams, allePersonen]);

  if (data && alleJahre.length > 0 && !searchParams.get('jahre') && !defaultsApplied.current) {
    defaultsApplied.current = true;
    const next = (searchParams.size === 0 ? gemerkt.laden(alleJahre) : null) || new URLSearchParams(searchParams);
    if (!next.get('jahre')) next.set('jahre', defaultJahre.join(','));
    setSearchParams(next, { replace: true });
  }

  const setzeParam = (key, werte, alle) => {
    const next = new URLSearchParams(searchParams);
    if (key === 'personen' && werte.length === alle.length) next.delete(key);
    else next.set(key, werte.join(','));
    setSearchParams(next, { replace: true });
  };

  // Gruppenwechsel setzt die Personenauswahl zurück, Standard „personen" ohne Parameter
  const setzeGruppe = (wert) => {
    const next = new URLSearchParams(searchParams);
    next.delete('personen');
    if (wert === 'personen') next.delete('gruppe');
    else next.set('gruppe', wert);
    setSearchParams(next, { replace: true });
  };

  const toggle = (key, auswahl, alle) => (wert) => {
    const next = auswahl.includes(wert) ? auswahl.filter((w) => w !== wert) : [...auswahl, wert];
    if (next.length > 0) setzeParam(key, next, alle);
  };

  // „Nur endabgerechnete" ist Standard: ausgeblendet wird, was einer noch
  // laufenden Abrechnungsperiode zugeordnet ist (maßgeblich ist die AP der
  // Rechnung). Zur Prüfung lassen sie sich mit ?laufende=1 einblenden.
  const nurEndabgerechnet = searchParams.get('laufende') !== '1';
  const setzeNurEndabgerechnet = (wert) => {
    const next = new URLSearchParams(searchParams);
    if (wert) next.delete('laufende');
    else next.set('laufende', '1');
    setSearchParams(next, { replace: true });
  };

  // Vollständig erstattete Rechnungen sind standardmäßig ausgeblendet –
  // für die Steuer zählt nur der Eigenbehalt. ?vollerstattet=1 blendet sie ein.
  const mitVollerstatteten = searchParams.get('vollerstattet') === '1';
  const setzeMitVollerstatteten = (wert) => {
    const next = new URLSearchParams(searchParams);
    if (wert) next.set('vollerstattet', '1');
    else next.delete('vollerstattet');
    setSearchParams(next, { replace: true });
  };

  const [filterOffen, setFilterOffen] = useState(false);

  if (isLoading) return <PageLoader />;
  if (error) return <p className="p-6 text-destructive">Fehler: {error.message}</p>;

  const jahrSet = new Set(selectedJahre);
  const personSet = new Set(selectedPersonen);
  const gefiltert = (data?.data || [])
    .filter((j) => jahrSet.has(j.jahr))
    .map((j) => {
      const personen = j.personen
        .filter((p) => passtZurGruppe(p.ist_tier, gruppe) && personSet.has(p.person))
        .map((p) => (nurEndabgerechnet || !mitVollerstatteten
          ? mitSummen(p, p.rechnungen.filter((r) =>
            !(nurEndabgerechnet && r.erstattung_ausstehend?.length > 0)
            && (mitVollerstatteten || !r.vollerstattet)))
          : p))
        .filter((p) => p.rechnungen.length > 0);
      return { ...j, personen, summe: summiere(personen) };
    })
    .filter((j) => j.personen.length > 0);

  // Vor/Zurück in der Dokumentansicht folgt genau den angezeigten Rechnungen
  // in Anzeigereihenfolge; eine Rechnung für mehrere Personen zählt einmal.
  const navList = [...new Map(gefiltert
    .flatMap((j) => j.personen.flatMap((p) => p.rechnungen))
    .map((r) => [r.postid, { postid: r.postid, betreff: r.betreff, kontakt: r.gegenstelle }])).values()];

  const gesamt = gefiltert.reduce((s, j) => ({
    rechnung: s.rechnung + j.summe.rechnung,
    erstattet: s.erstattet + j.summe.erstattet,
    eigenbehalt: s.eigenbehalt + j.summe.eigenbehalt,
  }), { rechnung: 0, erstattet: 0, eigenbehalt: 0 });

  const allePersonenGewaehlt = selectedPersonen.length === allePersonen.length;
  const personenLabel = gruppe === 'tiere' ? 'Tier' : gruppe === 'alle' ? 'Person/Tier' : 'Person';
  const oeffneFilter = () => setFilterOffen(true);

  const fromUrl = location.pathname + location.search;

  return (
    <div className="px-6 pt-4 pb-6 lg:px-8 lg:pb-8 space-y-6">
      {/* Kopf: Titel + Export, darunter Filter links und Summen rechts */}
      <div className="space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <GlowHeading>Gesundheitskosten</GlowHeading>
            <p className="text-muted-foreground mt-1">
              {mitVollerstatteten
                ? 'Alle Rechnungen, auch vollständig erstattete'
                : 'Rechnungen, die nicht vollständig erstattet wurden'}, nach Zahljahr und behandelter Person –
              der Eigenbehalt ist der Betrag für die Steuererklärung.
            </p>
          </div>
          <ExcelExportButton
            onExport={() => api.analyse.gesundheitskostenExport({
              gruppe,
              endabgerechnet: nurEndabgerechnet ? '1' : '0',
              vollerstattet: mitVollerstatteten ? '1' : '0',
              jahre: gefiltert.map((j) => j.jahr),
              personen: allePersonenGewaehlt ? [] : selectedPersonen,
            })}
            disabled={gefiltert.length === 0}
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <FilterPopover offen={filterOffen} onOffenChange={setFilterOffen}>
              <AuswahlLeiste
                label="Anzeigen"
                optionen={GRUPPEN}
                wert={gruppe}
                onChange={setzeGruppe}
              />
              {alleJahre.length > 0 && (
                <FilterLeiste
                  label="Zahljahr"
                  werte={alleJahre}
                  ausgewaehlt={jahrSet}
                  beschriftung={jahrLabel}
                  onToggle={toggle('jahre', selectedJahre, alleJahre)}
                  onAlle={() => setzeParam('jahre', alleJahre, alleJahre)}
                />
              )}
              {allePersonen.length > 1 && (
                <FilterLeiste
                  label={personenLabel}
                  werte={allePersonen}
                  ausgewaehlt={personSet}
                  beschriftung={personLabel}
                  onToggle={toggle('personen', selectedPersonen, allePersonen)}
                  onAlle={() => setzeParam('personen', allePersonen, allePersonen)}
                />
              )}
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={nurEndabgerechnet} onCheckedChange={setzeNurEndabgerechnet} label="Nur endabgerechnete" />
                <span>
                  Nur endabgerechnete
                  <span className="block text-xs text-muted-foreground">
                    Blendet Rechnungen aus, deren Abrechnungsperiode noch sammelt oder eingereicht ist.
                  </span>
                </span>
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={mitVollerstatteten} onCheckedChange={setzeMitVollerstatteten} label="Auch vollerstattete" />
                <span>
                  Auch vollerstattete
                  <span className="block text-xs text-muted-foreground">
                    Zeigt zusätzlich Rechnungen, die vollständig erstattet wurden und keinen Eigenbehalt haben.
                  </span>
                </span>
              </label>
            </FilterPopover>
            <FilterChip onClick={oeffneFilter}>{GRUPPEN.find((g) => g.wert === gruppe).label}</FilterChip>
            {selectedJahre.length > 0 && (
              <FilterChip onClick={oeffneFilter}>
                Zahljahr: {alleJahre.filter((j) => jahrSet.has(j)).map(jahrLabel).join(', ')}
              </FilterChip>
            )}
            {!allePersonenGewaehlt && (
              <FilterChip onClick={oeffneFilter} onEntfernen={() => setzeParam('personen', allePersonen, allePersonen)}>
                {personenLabel}: {selectedPersonen.map(personLabel).join(', ')}
              </FilterChip>
            )}
            {nurEndabgerechnet && (
              <FilterChip onClick={oeffneFilter} onEntfernen={() => setzeNurEndabgerechnet(false)}>
                Nur endabgerechnete
              </FilterChip>
            )}
            {mitVollerstatteten && (
              <FilterChip onClick={oeffneFilter} onEntfernen={() => setzeMitVollerstatteten(false)}>
                Auch vollerstattete
              </FilterChip>
            )}
            </div>
          <GesamtZeile {...gesamt} />
        </div>
      </div>

      {gefiltert.length === 0 ? (
        <EmptyState
          icon={HeartPulse}
          title="Keine Gesundheitskosten"
          description={mitVollerstatteten
            ? 'Für diese Auswahl gibt es keine Rechnungen.'
            : 'Für diese Auswahl gibt es keine Rechnungen mit Eigenbehalt.'}
        />
      ) : (
        gefiltert.map((j) => (
          <Card key={j.jahr}>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <CardTitle className="text-lg font-bold">{jahrLabel(j.jahr)}</CardTitle>
                <div className="flex items-center gap-3 flex-wrap justify-end">
                  <span className="text-sm text-muted-foreground">
                    {j.summe.anzahl} Rechnung{j.summe.anzahl !== 1 ? 'en' : ''}
                  </span>
                  <Betraege {...j.summe} />
                </div>
              </div>
            </CardHeader>
            <CardContent className="pt-0 space-y-6">
              {j.personen.map((p) => (
                <div key={p.person}>
                  <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
                    {p.ist_tier && <PawPrint className="h-3.5 w-3.5 text-muted-foreground" />}
                    {personLabel(p.person)}
                  </h3>
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>PostID</TableHead>
                          <TableHead>Bezahlt am</TableHead>
                          <TableHead>Gegenstelle</TableHead>
                          <TableHead>Betreff</TableHead>
                          <TableHead className="text-right">Rechnungssumme</TableHead>
                          <TableHead className="text-right">Erstattet</TableHead>
                          <TableHead className="text-right">Eigenbehalt</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {p.rechnungen.map((r) => {
                          const navIndex = navList.findIndex((n) => n.postid === r.postid);
                          const ausstehend = r.erstattung_ausstehend || [];
                          return (
                            <TableRow
                              key={r.postid}
                              className={`cursor-pointer hover:bg-muted/50${r.historisch ? ' bg-muted/40' : ''}`}
                              onClick={() => navigate(`/postbuch/${r.postid}`, {
                                state: { from: fromUrl, navList, navIndex },
                              })}
                            >
                              <TableCell className="font-mono font-bold text-primary">
                                <span className="flex items-center gap-1.5">
                                  {r.postid}
                                  {r.historisch && (
                                    <span
                                      className="inline-flex items-center gap-1 rounded border border-slate-300 bg-slate-100 px-1.5 py-0.5 font-sans text-[10px] font-medium text-slate-600"
                                      title="Archiviert – zählt trotzdem mit"
                                    >
                                      <Archive className="h-2.5 w-2.5" />
                                      Archiviert
                                    </span>
                                  )}
                                  {r.vollerstattet && (
                                    <span
                                      className="inline-flex items-center gap-1 rounded border border-emerald-300 bg-emerald-50 px-1.5 py-0.5 font-sans text-[10px] font-medium text-emerald-800"
                                      title="Vollständig erstattet – kein Eigenbehalt"
                                    >
                                      <CheckCircle2 className="h-2.5 w-2.5" />
                                      Voll erstattet
                                    </span>
                                  )}
                                  {ausstehend.length > 0 && (
                                    <span
                                      className="inline-flex items-center gap-1 rounded border border-sky-300 bg-sky-50 px-1.5 py-0.5 font-sans text-[10px] font-medium text-sky-800"
                                      title={`Steckt in einer laufenden Abrechnungsperiode (${ausstehend.join(', ')}) – der Eigenbehalt ist vorläufig`}
                                    >
                                      <Hourglass className="h-2.5 w-2.5" />
                                      {ausstehend.join('/')} ausstehend
                                    </span>
                                  )}
                                </span>
                              </TableCell>
                              <TableCell className="text-sm whitespace-nowrap">{formatDate(r.zahldatum)}</TableCell>
                              <TableCell className="font-medium">{r.gegenstelle || '–'}</TableCell>
                              <TableCell className="max-w-xs truncate text-sm text-muted-foreground" title={r.betreff || ''}>
                                {r.betreff || '–'}
                              </TableCell>
                              <TableCell
                                className="text-right font-mono text-sm whitespace-nowrap"
                                title={r.bestritten_betrag != null
                                  ? `Unbestrittener Teil – ${formatCurrency(r.bestritten_betrag)} von ${formatCurrency(r.gesamtbetrag)} bestritten`
                                  : undefined}
                              >
                                <span className="inline-flex items-center justify-end gap-1">
                                  {r.bestritten_betrag != null && <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />}
                                  {formatCurrency(r.rechnungssumme)}
                                </span>
                              </TableCell>
                              <TableCell className="text-right font-mono text-sm whitespace-nowrap text-emerald-700">
                                {parseFloat(r.erstattet) !== 0 ? formatCurrency(r.erstattet) : <span className="text-muted-foreground">–</span>}
                              </TableCell>
                              <TableCell className={`text-right font-mono text-sm whitespace-nowrap ${r.vollerstattet ? 'text-rose-400/60 dark:text-rose-400/40' : 'font-semibold text-rose-700'}`}>
                                {r.vollerstattet ? '–' : formatCurrency(r.eigenbehalt)}
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                      <tfoot>
                        <tr className="border-t-2 border-border font-semibold bg-muted/30">
                          <td colSpan={4} className="px-4 py-2 text-sm text-right text-muted-foreground">
                            Summe {personLabel(p.person)}
                          </td>
                          <td className="px-4 py-2 text-right font-mono text-sm whitespace-nowrap">
                            {formatCurrency(p.summe_rechnung)}
                          </td>
                          <td className="px-4 py-2 text-right font-mono text-sm whitespace-nowrap text-emerald-700">
                            {formatCurrency(p.summe_erstattet)}
                          </td>
                          <td className="px-4 py-2 text-right font-mono text-sm whitespace-nowrap text-rose-700">
                            {formatCurrency(p.summe_eigenbehalt)}
                          </td>
                        </tr>
                      </tfoot>
                    </Table>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}
