import { useMemo, useRef } from 'react';
import { useSearchParams, useLocation, useNavigate } from 'react-router';
import { useHandwerker } from '@/hooks/usePostbuch';
import { GlowHeading } from '@/components/ui/GlowHeading';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PageLoader, EmptyState } from '@/components/ui/spinner';
import { formatDate, formatCurrency } from '@/lib/utils';
import { Wrench, Archive } from 'lucide-react';

export default function HandwerkerPage() {
  const { data, isLoading, error } = useHandwerker();
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const defaultsApplied = useRef(false);

  // All years that have data, sorted descending
  const alleJahre = useMemo(() => {
    const j = (data?.data || []).map((y) => String(y.jahr ?? 'Ohne Zuordnung'));
    return j; // API already returns them sorted desc
  }, [data]);

  // Determine selected years: from URL or default to last 2
  const selectedJahre = useMemo(() => {
    const param = searchParams.get('jahre');
    if (param) return param.split(',');
    if (alleJahre.length === 0) return [];
    // Default: last 2 years (highest values = first entries since sorted desc)
    return alleJahre.slice(0, 2);
  }, [searchParams, alleJahre]);

  // Apply default URL params on first data load so the URL reflects the filter
  if (data && alleJahre.length > 0 && !searchParams.get('jahre') && !defaultsApplied.current) {
    defaultsApplied.current = true;
    const defaults = alleJahre.slice(0, 2).join(',');
    setSearchParams({ jahre: defaults }, { replace: true });
  }

  const toggleJahr = (jahr) => {
    const next = selectedJahre.includes(jahr)
      ? selectedJahre.filter((j) => j !== jahr)
      : [...selectedJahre, jahr];
    if (next.length > 0) {
      setSearchParams({ jahre: next.join(',') }, { replace: true });
    }
  };

  const selectAll = () => {
    setSearchParams({ jahre: alleJahre.join(',') }, { replace: true });
  };

  // navList covers ALL rechnungen across ALL years (not just filtered) for consistent prev/next navigation
  // Must be defined before early returns to satisfy React's rules of hooks
  const allNavList = useMemo(() =>
    (data?.data || []).flatMap(j => j.rechnungen || []),
  [data]);

  if (isLoading) return <PageLoader />;
  if (error) return <p className="p-6 text-destructive">Fehler: {error.message}</p>;

  const alleJahreData = data?.data || [];
  const selectedSet = new Set(selectedJahre);
  const filteredJahre = alleJahreData.filter((j) => selectedSet.has(String(j.jahr ?? 'Ohne Zuordnung')));

  const gesamtBetrag = filteredJahre.reduce((s, j) => s + parseFloat(j.summe_gesamt || 0), 0);
  const gesamtLohn   = filteredJahre.reduce((s, j) => s + parseFloat(j.summe_lohnkosten || 0), 0);
  // Archivierte Rechnungen zählen mit – der Anteil wird offen ausgewiesen.
  const gesamtArchiviert     = filteredJahre.reduce((s, j) => s + (j.anzahl_archiviert || 0), 0);
  const gesamtLohnArchiviert = filteredJahre.reduce((s, j) => s + parseFloat(j.summe_lohnkosten_archiviert || 0), 0);

  const fromUrl = location.pathname + location.search;

  return (
    <div className="px-6 pt-4 pb-6 lg:px-8 lg:pb-8 space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <GlowHeading>Handwerkerrechnungen</GlowHeading>
          <p className="text-muted-foreground mt-1">
            Rechnungs- und Lohnkostensummen nach Leistungsjahr.
          </p>
          {gesamtArchiviert > 0 && (
            <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
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
        <div className="flex flex-col items-end gap-1">
          <Badge variant="outline" className="text-base px-3 py-1 font-semibold">
            Gesamt: {formatCurrency(gesamtBetrag)}
          </Badge>
          <Badge variant="outline" className="text-sm px-3 py-1 text-amber-700 border-amber-200 bg-amber-50">
            Lohn gesamt: {formatCurrency(gesamtLohn)}
          </Badge>
        </div>
      </div>

      {/* Leistungsjahr Filter */}
      {alleJahre.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-muted-foreground mr-1">Leistungsjahr:</span>
          {alleJahre.map((jahr) => (
            <Button
              key={jahr}
              variant={selectedSet.has(jahr) ? 'default' : 'outline'}
              size="sm"
              className="h-7 px-3 text-xs"
              onClick={() => toggleJahr(jahr)}
            >
              {jahr}
            </Button>
          ))}
          {selectedJahre.length < alleJahre.length && (
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground" onClick={selectAll}>
              Alle
            </Button>
          )}
        </div>
      )}

      {filteredJahre.length === 0 ? (
        <EmptyState
          icon={Wrench}
          title="Keine Handwerkerrechnungen"
          description="Es wurden noch keine Handwerkerrechnungen erfasst."
        />
      ) : (
        filteredJahre.map((j) => {
          const jahr       = j.jahr ?? 'Ohne Zuordnung';
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
                      const navIndex = allNavList.findIndex(n => n.postid === r.postid);
                      return (
                      <TableRow
                        key={r.postid}
                        className={`cursor-pointer hover:bg-muted/50${r.historisch ? ' bg-muted/40' : ''}`}
                        onClick={() => navigate(`/postbuch/${r.postid}`, {
                          state: { from: fromUrl, navList: allNavList, navIndex },
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
                          </span>
                        </TableCell>
                        <TableCell className="font-medium">{r.name_unternehmen || '–'}</TableCell>
                        <TableCell className="max-w-xs truncate text-sm text-muted-foreground" title={r.leistung || ''}>
                          {r.leistung || '–'}
                        </TableCell>
                        <TableCell className="text-sm">{r.leistungsjahr ?? '–'}</TableCell>
                        <TableCell className="text-sm">{r.leistungsdatum || '–'}</TableCell>
                        <TableCell className="text-sm">{formatDate(r.rechnungsdatum)}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">{r.re_nr || '–'}</TableCell>
                        <TableCell className="text-right font-mono text-sm">
                          {r.gesamtbetrag != null ? formatCurrency(r.gesamtbetrag) : '–'}
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm">
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
                      <td colSpan={7} className="px-4 py-2 text-sm text-right text-muted-foreground">
                        Jahressumme {jahr}
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
