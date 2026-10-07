import { useMemo, useRef } from 'react';
import { useSearchParams, useLocation, useNavigate } from 'react-router';
import { useHandwerker } from '@/hooks/usePostbuch';
import { useGemerkteFilter } from '@/hooks/useGemerkteFilter';
import { api } from '@/api/client';
import { ExcelExportButton } from '@/components/ExcelExportButton';
import { AuswahlLeiste } from '@/components/AnalyseFilter';
import { GlowHeading } from '@/components/ui/GlowHeading';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PageLoader, EmptyState } from '@/components/ui/spinner';
import { formatDate, formatCurrency } from '@/lib/utils';
import { Wrench, Archive, Ban } from 'lucide-react';

// Jahresschlüssel der API: 'YYYY' oder 'offen' für noch nicht bezahlte Rechnungen.
const JAHR_OFFEN = 'offen';
const jahrLabel = (jahr) => (jahr === JAHR_OFFEN ? 'Noch nicht bezahlt' : jahr);

// § 35a-Filter: Standard sind die relevanten Rechnungen, also alle, die der
// Nutzer nicht ausdrücklich ausgeschlossen hat.
const RELEVANZ = [
  { wert: 'relevant', label: 'Relevante' },
  { wert: 'irrelevant', label: 'Ausgeschlossene' },
  { wert: 'alle', label: 'Alle' },
];

export default function HandwerkerPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const relevanz = RELEVANZ.some((r) => r.wert === searchParams.get('relevanz'))
    ? searchParams.get('relevanz') : 'relevant';
  const { data, isLoading, error } = useHandwerker(relevanz);
  const location = useLocation();
  const navigate = useNavigate();
  const defaultsApplied = useRef(false);
  const gemerkt = useGemerkteFilter('handwerker', searchParams);

  // All years that have data, sorted descending
  const alleJahre = useMemo(() => {
    // API liefert absteigend sortiert, „noch nicht bezahlt" am Ende
    return (data?.data || []).map((y) => String(y.jahr));
  }, [data]);

  // Default: die letzten zwei Zahljahre (ohne „noch nicht bezahlt")
  const defaultJahre = useMemo(() => {
    const bezahlt = alleJahre.filter((j) => j !== JAHR_OFFEN);
    return (bezahlt.length > 0 ? bezahlt : alleJahre).slice(0, 2);
  }, [alleJahre]);

  // Determine selected years: from URL or default
  const selectedJahre = useMemo(() => {
    const param = searchParams.get('jahre');
    if (param) return param.split(',');
    return defaultJahre;
  }, [searchParams, defaultJahre]);

  // Setzt einen URL-Parameter und lässt die übrigen Filter stehen
  const setzeParam = (key, wert) => {
    const next = new URLSearchParams(searchParams);
    if (wert == null) next.delete(key);
    else next.set(key, wert);
    setSearchParams(next, { replace: true });
  };

  // Apply default URL params on first data load so the URL reflects the filter
  if (data && alleJahre.length > 0 && !searchParams.get('jahre') && !defaultsApplied.current) {
    defaultsApplied.current = true;
    const wiederhergestellt = searchParams.size === 0 ? gemerkt.laden(alleJahre) : null;
    if (wiederhergestellt) setSearchParams(wiederhergestellt, { replace: true });
    else setzeParam('jahre', defaultJahre.join(','));
  }

  const toggleJahr = (jahr) => {
    const next = selectedJahre.includes(jahr)
      ? selectedJahre.filter((j) => j !== jahr)
      : [...selectedJahre, jahr];
    if (next.length > 0) setzeParam('jahre', next.join(','));
  };

  const selectAll = () => setzeParam('jahre', alleJahre.join(','));

  const setzeRelevanz = (wert) => setzeParam('relevanz', wert === 'relevant' ? null : wert);

  if (isLoading) return <PageLoader />;
  if (error) return <p className="p-6 text-destructive">Fehler: {error.message}</p>;

  const alleJahreData = data?.data || [];
  const selectedSet = new Set(selectedJahre);
  const filteredJahre = alleJahreData.filter((j) => selectedSet.has(String(j.jahr)));
  // Vor/Zurück in der Dokumentansicht folgt genau den angezeigten Rechnungen
  const navList = filteredJahre.flatMap((j) => j.rechnungen || []);

  const gesamtBetrag = filteredJahre.reduce((s, j) => s + parseFloat(j.summe_gesamt || 0), 0);
  const gesamtLohn   = filteredJahre.reduce((s, j) => s + parseFloat(j.summe_lohnkosten || 0), 0);
  // Archivierte Rechnungen zählen mit – der Anteil wird offen ausgewiesen.
  const gesamtArchiviert     = filteredJahre.reduce((s, j) => s + (j.anzahl_archiviert || 0), 0);
  const gesamtLohnArchiviert = filteredJahre.reduce((s, j) => s + parseFloat(j.summe_lohnkosten_archiviert || 0), 0);

  const fromUrl = location.pathname + location.search;

  return (
    <div className="px-6 pt-4 pb-6 lg:px-8 lg:pb-8 space-y-6">
      {/* Kopf: Titel + Export, darunter Jahresfilter links und Summen rechts */}
      <div className="space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div>
            <GlowHeading>Handwerkerrechnungen</GlowHeading>
            <p className="text-muted-foreground mt-1">
              Rechnungs- und Lohnkostensummen nach Zahljahr – für die Steuer zählt das Jahr der Zahlung.
            </p>
          </div>
          <ExcelExportButton
            onExport={() => api.analyse.handwerkerExport({ jahre: filteredJahre.map((j) => String(j.jahr)), relevanz })}
            disabled={filteredJahre.length === 0}
          />
        </div>

        <AuswahlLeiste label="§ 35a EStG" optionen={RELEVANZ} wert={relevanz} onChange={setzeRelevanz} />

        {alleJahre.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-medium text-muted-foreground mr-1">Zahljahr:</span>
              {alleJahre.map((jahr) => (
                <Button
                  key={jahr}
                  variant={selectedSet.has(jahr) ? 'default' : 'outline'}
                  size="sm"
                  className="h-7 px-3 text-xs"
                  onClick={() => toggleJahr(jahr)}
                >
                  {jahrLabel(jahr)}
                </Button>
              ))}
              {selectedJahre.length < alleJahre.length && (
                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground" onClick={selectAll}>
                  Alle
                </Button>
              )}
            </div>
            <div className="flex items-baseline gap-5 text-sm tabular-nums">
              <span className="text-muted-foreground">
                Gesamt <strong className="ml-1 text-base font-semibold text-foreground">{formatCurrency(gesamtBetrag)}</strong>
              </span>
              <span className="text-muted-foreground">
                davon Lohn <strong className="ml-1 text-base font-semibold text-amber-700 dark:text-amber-400">{formatCurrency(gesamtLohn)}</strong>
              </span>
            </div>
          </div>
        )}

        {gesamtArchiviert > 0 && relevanz !== 'irrelevant' && (
          <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Archive className="h-3.5 w-3.5 shrink-0" />
            <span>
              Enthält <strong className="font-semibold text-foreground">{gesamtArchiviert}</strong>{' '}
              archivierte {gesamtArchiviert === 1 ? 'Rechnung' : 'Rechnungen'}
              {gesamtLohnArchiviert !== 0 && <> mit {formatCurrency(gesamtLohnArchiviert)} Lohnanteil</>} – sie
              bleiben absetzbar und zählen deshalb mit.
            </span>
          </p>
        )}
      </div>

      {filteredJahre.length === 0 ? (
        <EmptyState
          icon={Wrench}
          title="Keine Handwerkerrechnungen"
          description={relevanz === 'irrelevant'
            ? 'Keine Rechnung ist für § 35a EStG ausgeschlossen.'
            : 'Für diese Auswahl gibt es keine Handwerkerrechnungen.'}
        />
      ) : (
        filteredJahre.map((j) => {
          const jahr       = jahrLabel(String(j.jahr));
          const rechnungen = j.rechnungen || [];
          const summeGesamt = parseFloat(j.summe_gesamt || 0);
          const summeLohn   = parseFloat(j.summe_lohnkosten || 0);
          const anzahlArchiviert = j.anzahl_archiviert || 0;
          const summeLohnArchiviert = parseFloat(j.summe_lohnkosten_archiviert || 0);

          return (
            <Card key={jahr}>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-lg font-bold">{jahr}</CardTitle>
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-muted-foreground">
                      {j.anzahl} Rechnung{j.anzahl !== 1 ? 'en' : ''}
                    </span>
                    {anzahlArchiviert > 0 && (
                      <Badge
                        variant="outline"
                        className="gap-1 text-xs font-medium text-slate-600 border-slate-300 bg-slate-100"
                        title="Archivierte Rechnungen bleiben absetzbar und sind in den Summen dieses Jahres enthalten."
                      >
                        <Archive className="h-3 w-3" />
                        {anzahlArchiviert} archiviert{summeLohnArchiviert !== 0 && <> · Lohn {formatCurrency(summeLohnArchiviert)}</>}
                      </Badge>
                    )}
                    <Badge variant="outline" className="font-mono font-semibold text-sm">
                      {formatCurrency(summeGesamt)}
                    </Badge>
                    {summeLohn !== 0 && (
                      <Badge
                        variant="outline"
                        className="font-mono font-semibold text-sm text-amber-700 border-amber-200 bg-amber-50"
                      >
                        Lohn: {formatCurrency(summeLohn)}
                      </Badge>
                    )}
                  </div>
                </div>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>PostID</TableHead>
                      <TableHead>Unternehmen</TableHead>
                      <TableHead>Leistung</TableHead>
                      <TableHead>Bezahlt am</TableHead>
                      <TableHead>Leistungsjahr</TableHead>
                      <TableHead>Leistungsdatum</TableHead>
                      <TableHead>Rechnungsdatum</TableHead>
                      <TableHead>Re.-Nr.</TableHead>
                      <TableHead className="text-right">Rechnungssumme</TableHead>
                      <TableHead className="text-right">Lohnkosten</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rechnungen.map((r) => {
                      const navIndex = navList.findIndex(n => n.postid === r.postid);
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
                                title="Archiviert – zählt trotzdem in die Jahressumme"
                              >
                                <Archive className="h-2.5 w-2.5" />
                                Archiviert
                              </span>
                            )}
                            {r.estg35a_irrelevant && (
                              <span
                                className="inline-flex items-center gap-1 rounded border border-slate-300 bg-slate-100 px-1.5 py-0.5 font-sans text-[10px] font-medium text-slate-600"
                                title="Für § 35a EStG ausgeschlossen"
                              >
                                <Ban className="h-2.5 w-2.5" />
                                § 35a ausgeschlossen
                              </span>
                            )}
                            {r.ersetzt_durch && (
                              <span
                                className="inline-flex items-center rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 font-sans text-[10px] font-medium text-amber-800"
                                title={`Ersetzt durch ${r.ersetzt_durch} – zählt in keiner Summe`}
                              >
                                Ersetzt
                              </span>
                            )}
                          </span>
                        </TableCell>
                        <TableCell className="font-medium">{r.name_unternehmen || '–'}</TableCell>
                        <TableCell className="max-w-xs truncate text-sm text-muted-foreground" title={r.leistung || ''}>
                          {r.leistung || '–'}
                        </TableCell>
                        <TableCell className="text-sm">{formatDate(r.zahldatum)}</TableCell>
                        <TableCell className="text-sm">{r.leistungsjahr ?? '–'}</TableCell>
                        <TableCell className="text-sm">{r.leistungsdatum || '–'}</TableCell>
                        <TableCell className="text-sm">{formatDate(r.rechnungsdatum)}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">{r.re_nr || '–'}</TableCell>
                        <TableCell className={`text-right font-mono text-sm${r.ersetzt_durch ? ' line-through text-muted-foreground' : ''}`}>
                          {r.gesamtbetrag != null ? formatCurrency(r.gesamtbetrag) : '–'}
                        </TableCell>
                        <TableCell className={`text-right font-mono text-sm${r.ersetzt_durch ? ' line-through opacity-60' : ''}`}>
                          {r.lohnkosten != null && parseFloat(r.lohnkosten) !== 0
                            ? <span className="text-amber-700">{formatCurrency(r.lohnkosten)}</span>
                            : <span className="text-muted-foreground">–</span>}
                        </TableCell>
                      </TableRow>
                      );
                    })}
                  </TableBody>
                  {/* Jahressummen-Zeile */}
                  <tfoot>
                    <tr className="border-t-2 border-border font-semibold bg-muted/30">
                      <td colSpan={8} className="px-4 py-2 text-sm text-right text-muted-foreground">
                        {j.jahr === JAHR_OFFEN ? 'Summe' : `Jahressumme ${jahr}`}
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-sm">
                        {formatCurrency(summeGesamt)}
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-sm text-amber-700">
                        {summeLohn !== 0 ? formatCurrency(summeLohn) : '–'}
                      </td>
                    </tr>
                  </tfoot>
                </Table>
                </div>
              </CardContent>
            </Card>
          );
        })
      )}
    </div>
  );
}
