import { useNavigate, useSearchParams } from 'react-router';
import { useKuerzungen, useSetOhneRechnungsbezug } from '@/hooks/usePostbuch';
import { useAuth } from '@/hooks/useAuth';
import { GlowHeading } from '@/components/ui/GlowHeading';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { PageLoader, EmptyState } from '@/components/ui/spinner';
import { formatDate, formatCurrency } from '@/lib/utils';
import { Scissors, Check } from 'lucide-react';
import { KuerzungStatusActions } from '@/components/detail/KuerzungStatusActions';

const GESEHEN_OPTIONEN = [
  { value: 'offen', label: 'Offen (ungesehen)' },
  { value: 'alle', label: 'Alle' },
  { value: 'gesehen', label: 'Nur gesehene' },
];

export default function KuerzungenPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const gesehenFilter = ['offen', 'alle', 'gesehen'].includes(searchParams.get('gesehen'))
    ? searchParams.get('gesehen')
    : 'offen';
  const filterPerson = searchParams.get('person') || null;
  const filterPeriode = searchParams.get('periode') ? Number(searchParams.get('periode')) : null;
  const { data, isLoading, error } = useKuerzungen(gesehenFilter);
  const navigate = useNavigate();
  const { canWrite } = useAuth();
  const ohneRechnungsbezugMutation = useSetOhneRechnungsbezug();

  const setGesehenFilter = (value) => {
    const next = new URLSearchParams(searchParams);
    if (value === 'offen') next.delete('gesehen'); else next.set('gesehen', value);
    setSearchParams(next);
  };

  if (isLoading) return <PageLoader />;
  if (error) return <p className="p-6 text-destructive">Fehler: {error.message}</p>;

  let rows = data?.data || [];
  if (filterPerson) rows = rows.filter((r) => r.behandelte_person === filterPerson);
  if (filterPeriode != null) rows = rows.filter((r) => r.pkv_pruefung_periode === filterPeriode);

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
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <GlowHeading>Kürzungen PKV & Beihilfe</GlowHeading>
          <p className="text-muted-foreground mt-1">Übersicht aller Erstattungskürzungen.</p>
          {(filterPerson || filterPeriode != null) && (
            <button
              onClick={() => setSearchParams(gesehenFilter === 'offen' ? {} : { gesehen: gesehenFilter })}
              className="mt-1 text-xs text-primary hover:underline"
            >
              Gefiltert: {filterPerson}{filterPeriode != null ? ` · Periode #${filterPeriode}` : ''} – Filter entfernen
            </button>
          )}
        </div>
        <div className="flex items-center gap-3">
          <Select
            value={gesehenFilter}
            onChange={(e) => setGesehenFilter(e.target.value)}
            className="w-48"
          >
            {GESEHEN_OPTIONEN.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </Select>
          <Badge variant="outline" className="text-red-600 border-red-200 bg-red-50 text-base px-3 py-1 font-semibold">
            Gesamt: {formatCurrency(gesamtSumme)}
          </Badge>
        </div>
      </div>

      {groups.length === 0 ? (
        <EmptyState icon={Scissors} title="Keine Kürzungen" description="Es wurden keine Kürzungen erfasst." />
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
                      state: { from: '/analyse/kuerzungen', navList: groupNavList, navIndex: 0 },
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
                              state: { from: '/analyse/kuerzungen', navList: groupNavList, navIndex: arzNavIndex >= 0 ? arzNavIndex : undefined },
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
