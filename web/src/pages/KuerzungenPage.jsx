import { useMemo, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { useKuerzungen, useSetOhneRechnungsbezug } from '@/hooks/usePostbuch';
import { useAuth } from '@/hooks/useAuth';
import { api } from '@/api/client';
import { GlowHeading } from '@/components/ui/GlowHeading';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PageLoader, EmptyState } from '@/components/ui/spinner';
import { ExcelExportButton } from '@/components/ExcelExportButton';
import { FilterPopover, FilterChip, FilterLeiste, AuswahlLeiste } from '@/components/AnalyseFilter';
import { formatDate, formatCurrency } from '@/lib/utils';
import { Scissors, Check } from 'lucide-react';
import { KuerzungStatusActions } from '@/components/detail/KuerzungStatusActions';

// URL-Parameter: gesehen = offen (Standard, ohne Parameter) | gesehen | alle;
// person, kostentraeger, jahre = kommagetrennt, ohne Parameter alle;
// periode = Nummer der PKV-Prüfperiode (Sprung aus der Periodenseite).
// Person `_ohne` = Kürzung ohne behandelte Person, Jahr `ohne` = Bescheid ohne Datum.
const STATUS = [
  { wert: 'offen', label: 'Offen (ungesehen)' },
  { wert: 'gesehen', label: 'Gesehen' },
  { wert: 'alle', label: 'Alle' },
];
const PERSON_OHNE = '_ohne';
const JAHR_OHNE = 'ohne';
const KOSTENTRAEGER = ['PKV', 'Beihilfe'];
const personLabel = (p) => (p === PERSON_OHNE ? 'Ohne Person' : p);
const jahrLabel = (j) => (j === JAHR_OHNE ? 'Ohne Datum' : j);
const jahrVon = (k) => (k.bescheiddatum ? String(k.bescheiddatum).slice(0, 4) : JAHR_OHNE);
const liste = (wert) => (wert ? wert.split(',').filter(Boolean) : null);

export default function KuerzungenPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  // Immer alle laden – Statuswechsel braucht so keinen neuen Abruf, und der
  // Cache-Eintrag ist derselbe wie auf Periodenseite und im Abrechnungsassistenten.
  const { data, isLoading, error } = useKuerzungen('alle');
  const navigate = useNavigate();
  const location = useLocation();
  const { canWrite } = useAuth();
  const ohneRechnungsbezugMutation = useSetOhneRechnungsbezug();
  const [filterOffen, setFilterOffen] = useState(false);

  const status = STATUS.some((s) => s.wert === searchParams.get('gesehen')) ? searchParams.get('gesehen') : 'offen';
  const personenParam = liste(searchParams.get('person'));
  const kostentraegerParam = liste(searchParams.get('kostentraeger'));
  const jahreParam = liste(searchParams.get('jahre'));
  const periode = searchParams.get('periode') ? Number(searchParams.get('periode')) : null;

  const alleZeilen = useMemo(() => data?.data || [], [data]);

  // Auswahlwerte aus dem Bestand; Werte aus der URL, die es (gerade) nicht
  // gibt, bleiben wählbar, damit die Auswahl sichtbar und abwählbar ist.
  const allePersonen = (() => {
    const namen = new Set(alleZeilen.map((k) => k.behandelte_person).filter(Boolean));
    for (const p of personenParam || []) if (p !== PERSON_OHNE) namen.add(p);
    const sortiert = [...namen].sort((a, b) => a.localeCompare(b, 'de'));
    return alleZeilen.some((k) => !k.behandelte_person) || personenParam?.includes(PERSON_OHNE)
      ? [...sortiert, PERSON_OHNE] : sortiert;
  })();
  const alleJahre = useMemo(() => {
    const jahre = [...new Set(alleZeilen.map(jahrVon))];
    return [...jahre.filter((j) => j !== JAHR_OHNE).sort().reverse(), ...jahre.filter((j) => j === JAHR_OHNE)];
  }, [alleZeilen]);

  const selectedPersonen = personenParam || allePersonen;
  const selectedKostentraeger = kostentraegerParam || KOSTENTRAEGER;
  const selectedJahre = jahreParam || alleJahre;

  const setzeParam = (key, wert) => {
    const next = new URLSearchParams(searchParams);
    if (wert == null || wert === '') next.delete(key);
    else next.set(key, wert);
    setSearchParams(next, { replace: true });
  };
  // Mehrfachauswahl: alles gewählt = kein Parameter; die letzte Auswahl bleibt stehen.
  const toggle = (key, auswahl, alle) => (wert) => {
    const next = auswahl.includes(wert) ? auswahl.filter((w) => w !== wert) : [...auswahl, wert];
    if (next.length === 0) return;
    setzeParam(key, alle.every((w) => next.includes(w)) ? null : alle.filter((w) => next.includes(w)).join(','));
  };

  if (isLoading) return <PageLoader />;
  if (error) return <p className="p-6 text-destructive">Fehler: {error.message}</p>;

  const personSet = new Set(selectedPersonen);
  const ktSet = new Set(selectedKostentraeger);
  const jahrSet = new Set(selectedJahre);
  const rows = alleZeilen.filter((k) =>
    (status === 'alle' || (status === 'offen') === !k.gesehen_am)
    && (!personenParam || personSet.has(k.behandelte_person || PERSON_OHNE))
    && (!kostentraegerParam || ktSet.has(k.kostentraeger))
    && (!jahreParam || jahrSet.has(jahrVon(k)))
    && (periode == null || k.pkv_pruefung_periode === periode));

  const oeffneFilter = () => setFilterOffen(true);

  // Group by eb_postid
  const grouped = {};
  for (const row of rows) {
    if (!grouped[row.eb_postid]) {
      grouped[row.eb_postid] = {
        eb_postid: row.eb_postid,
        kostentraeger: row.kostentraeger,
        bescheiddatum: row.bescheiddatum,
        kuerzungen: [],
        summe: 0,
      };
    }
    grouped[row.eb_postid].kuerzungen.push(row);
    grouped[row.eb_postid].summe += parseFloat(row.kuerzungsbetrag_effektiv ?? row.kuerzungsbetrag ?? 0);
  }

  const groups = Object.values(grouped);
  const gesamtSumme = groups.reduce((s, g) => s + g.summe, 0);

  return (
    <div className="px-6 pt-4 pb-6 lg:px-8 lg:pb-8 space-y-6">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <GlowHeading>Kürzungen PKV & Beihilfe</GlowHeading>
          <p className="text-muted-foreground mt-1">Übersicht aller Erstattungskürzungen.</p>
        </div>
        <Badge variant="outline" className="text-red-600 border-red-200 bg-red-50 text-base px-3 py-1 font-semibold">
          Gesamt: {formatCurrency(gesamtSumme)}
        </Badge>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <FilterPopover offen={filterOffen} onOffenChange={setFilterOffen}>
          <AuswahlLeiste
            label="Status"
            optionen={STATUS}
            wert={status}
            onChange={(w) => setzeParam('gesehen', w === 'offen' ? null : w)}
          />
          {allePersonen.length > 1 && (
            <FilterLeiste
              label="Person"
              werte={allePersonen}
              ausgewaehlt={personSet}
              beschriftung={personLabel}
              onToggle={toggle('person', selectedPersonen, allePersonen)}
              onAlle={() => setzeParam('person', null)}
            />
          )}
          <FilterLeiste
            label="Kostenträger"
            werte={KOSTENTRAEGER}
            ausgewaehlt={ktSet}
            beschriftung={(k) => k}
            onToggle={toggle('kostentraeger', selectedKostentraeger, KOSTENTRAEGER)}
            onAlle={() => setzeParam('kostentraeger', null)}
          />
          {alleJahre.length > 1 && (
            <FilterLeiste
              label="Bescheidjahr"
              werte={alleJahre}
              ausgewaehlt={jahrSet}
              beschriftung={jahrLabel}
              onToggle={toggle('jahre', selectedJahre, alleJahre)}
              onAlle={() => setzeParam('jahre', null)}
            />
          )}
        </FilterPopover>
        <FilterChip
          onClick={oeffneFilter}
          onEntfernen={status !== 'offen' ? () => setzeParam('gesehen', null) : undefined}
        >
          {STATUS.find((s) => s.wert === status).label}
        </FilterChip>
        {personenParam && (
          <FilterChip onClick={oeffneFilter} onEntfernen={() => setzeParam('person', null)}>
            Person: {personenParam.map(personLabel).join(', ')}
          </FilterChip>
        )}
        {kostentraegerParam && (
          <FilterChip onClick={oeffneFilter} onEntfernen={() => setzeParam('kostentraeger', null)}>
            Kostenträger: {kostentraegerParam.join(', ')}
          </FilterChip>
        )}
        {jahreParam && (
          <FilterChip onClick={oeffneFilter} onEntfernen={() => setzeParam('jahre', null)}>
            Bescheidjahr: {jahreParam.map(jahrLabel).join(', ')}
          </FilterChip>
        )}
        {periode != null && (
          <FilterChip onClick={oeffneFilter} onEntfernen={() => setzeParam('periode', null)}>
            PKV-Prüfung Periode #{periode}
          </FilterChip>
        )}
        <div className="ml-auto">
          <ExcelExportButton
            onExport={() => api.analyse.kuerzungenExport({
              gesehen: status,
              person: personenParam,
              kostentraeger: kostentraegerParam,
              jahre: jahreParam,
              periode,
            })}
            disabled={rows.length === 0}
          />
        </div>
      </div>

      {groups.length === 0 ? (
        <EmptyState icon={Scissors} title="Keine Kürzungen" description="Für diese Auswahl gibt es keine Kürzungen." />
      ) : (
        groups.map((group) => {
          // Build navList for this EB group: EB itself first, then unique ARZ documents
          const seenArz = new Set();
          const groupNavList = [
            { postid: group.eb_postid },
            ...group.kuerzungen
              .filter(k => k.arz_postid && !seenArz.has(k.arz_postid) && seenArz.add(k.arz_postid))
              .map(k => ({ postid: k.arz_postid, kontakt: k.name_arzt })),
          ];

          return (
          <Card key={group.eb_postid}>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => navigate(`/postbuch/${group.eb_postid}`, {
                      state: { from: location.pathname + location.search, navList: groupNavList, navIndex: 0 },
                    })}
                    className="text-primary hover:underline font-mono font-bold cursor-pointer"
                  >
                    {group.eb_postid}
                  </button>
                  <Badge variant="outline">{group.kostentraeger}</Badge>
                  <span className="text-sm text-muted-foreground">{formatDate(group.bescheiddatum)}</span>
                </div>
                <span className="text-red-600 font-medium font-mono">{formatCurrency(group.summe)}</span>
              </div>
            </CardHeader>
            <CardContent>
              <Table className="table-fixed w-full">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-28">Arztrechnung</TableHead>
                    <TableHead className="w-28">Patient</TableHead>
                    <TableHead className="w-36">Arzt</TableHead>
                    <TableHead className="w-44">Leistung / Ziffer</TableHead>
                    <TableHead className="w-32 text-right">Kürzungsbetrag</TableHead>
                    <TableHead>Begründung</TableHead>
                    <TableHead className="w-56">Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {group.kuerzungen.map((k, i) => {
                    const arzNavIndex = groupNavList.findIndex(n => n.postid === k.arz_postid);
                    const bestaetigenPending = ohneRechnungsbezugMutation.isPending
                      && ohneRechnungsbezugMutation.variables?.postid === group.eb_postid
                      && ohneRechnungsbezugMutation.variables?.subid === k.eb_subid;

                    return (
                    <TableRow key={i}>
                      <TableCell>
                        {k.arz_postid ? (
                          <button
                            onClick={() => navigate(`/postbuch/${k.arz_postid}`, {
                              state: { from: location.pathname + location.search, navList: groupNavList, navIndex: arzNavIndex >= 0 ? arzNavIndex : undefined },
                            })}
                            className="text-primary hover:underline font-mono text-xs cursor-pointer"
                          >
                            {k.arz_postid}
                          </button>
                        ) : '–'}
                      </TableCell>
                      <TableCell>{k.behandelte_person || '–'}</TableCell>
                      <TableCell className="truncate">{k.name_arzt || '–'}</TableCell>
                      <TableCell>
                        {k.arz_leistung || '–'}
                        {k.arz_ziffer && <span className="ml-1 text-muted-foreground font-mono text-xs">({k.arz_ziffer})</span>}
                      </TableCell>
                      <TableCell className="text-right font-mono text-red-600">{formatCurrency(k.kuerzungsbetrag_effektiv ?? k.kuerzungsbetrag)}</TableCell>
                      <TableCell className="text-sm">{k.begruendung || '–'}</TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-1.5 items-start">
                          <KuerzungStatusActions
                            ebPostid={group.eb_postid}
                            ebSubid={k.eb_subid}
                            kuerzungId={k.kuerzung_id}
                            kostentraeger={k.kostentraeger}
                            gesehenAm={k.gesehen_am}
                            pkvStatus={k.pkv_pruefung_status}
                            pkvPeriode={k.pkv_pruefung_periode}
                            pkvErlaeuterung={k.pkv_pruefung_erlaeuterung}
                            arzPostid={k.arz_postid}
                            canWrite={canWrite}
                          />
                          {k.zuordnung_offen && (
                            <div className="flex items-center gap-1.5">
                              <Badge variant="outline" className="text-orange-700 border-orange-200 bg-orange-50">
                                Zuordnung offen
                              </Badge>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-6 px-2 text-xs"
                                disabled={bestaetigenPending}
                                onClick={() => ohneRechnungsbezugMutation.mutate({
                                  postid: group.eb_postid, subid: k.eb_subid, bestaetigt: true,
                                })}
                                title="Bestätigen, dass diese Position keiner Rechnung zugeordnet werden muss"
                              >
                                <Check className="h-3.5 w-3.5" />
                                Keine Zuordnung nötig
                              </Button>
                            </div>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
          );
        })
      )}
    </div>
  );
}
