import { useState, useMemo, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useAuth } from '@/hooks/useAuth';
import { useWiedervorlagenKalender, useUpdateWiedervorlage, useDeleteWiedervorlage } from '@/hooks/useWiedervorlagen';
import { useUndoHistory } from '@/hooks/useUndoHistory';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';
import { GlowHeading } from '@/components/ui/GlowHeading';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Dialog, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { PageLoader } from '@/components/ui/spinner';
import { formatDate } from '@/lib/utils';
import { ChevronLeft, ChevronRight, Check, Trash2, RotateCcw, CalendarClock, AlertTriangle } from 'lucide-react';

const WEEKDAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const MONTH_NAMES = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

// Use local date components to avoid UTC-offset issues (e.g. CET = UTC+2 gives wrong date)
function toISODate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getMonthStart(year, month) {
  return new Date(year, month, 1);
}

function getMonthEnd(year, month) {
  return new Date(year, month + 1, 0);
}

function getCalendarWeeks(year, month) {
  const start = getMonthStart(year, month);
  const end = getMonthEnd(year, month);
  // Monday = 0 in our system (ISO weekday)
  let dayOfWeek = (start.getDay() + 6) % 7; // Convert Sunday=0 to Monday=0
  const weeks = [];
  let currentWeek = new Array(dayOfWeek).fill(null);

  for (let d = 1; d <= end.getDate(); d++) {
    currentWeek.push(d);
    if (currentWeek.length === 7) {
      weeks.push(currentWeek);
      currentWeek = [];
    }
  }
  if (currentWeek.length > 0) {
    while (currentWeek.length < 7) currentWeek.push(null);
    weeks.push(currentWeek);
  }
  return weeks;
}

function WvCalendarEntry({ wv, todayStr, returnTo }) {
  const refId = wv.postid || wv.akteid;
  const linkTo = wv.postid ? `/postbuch/${wv.postid}` : `/akten/${wv.akteid}`;
  const isOverdue = !wv.erledigt && wv.faellig_am.split('T')[0] < todayStr;

  return (
    <Link
      to={linkTo}
      state={{ from: returnTo }}
      className={`block text-[9px] leading-tight rounded px-1 py-0.5 mb-0.5 transition-colors hover:ring-1 hover:ring-primary/30 overflow-hidden ${
        wv.erledigt
          ? 'bg-emerald-100/50 text-emerald-700/60'
          : isOverdue
            ? 'bg-red-100 text-red-800'
            : 'bg-primary/5 text-foreground'
      }`}
      title={`${refId} – ${wv.aktion}`}
    >
      <span className="font-semibold font-mono block truncate">{refId}</span>
      <span
        className="block truncate rounded-sm px-0.5"
        style={{ background: wv.erledigt ? 'rgba(16,185,129,0.15)' : 'rgba(250,204,21,0.40)' }}
      >
        {wv.aktion}
      </span>
    </Link>
  );
}

function FaelligkeitEntry({ f, returnTo }) {
  return (
    <Link
      to={`/postbuch/${f.postid}`}
      state={{ from: returnTo }}
      className="block text-[9px] leading-tight rounded px-1 py-0.5 mb-0.5 bg-gray-100/60 text-gray-400 hover:ring-1 hover:ring-gray-300 transition-colors overflow-hidden"
      title={`${f.postid}: ${f.betreff} – Fälligkeit ${f.typ}`}
    >
      <span className="font-mono block truncate">{f.postid}</span>
      <span className="block truncate italic">Fälligkeit</span>
    </Link>
  );
}

function MonthCalendar({ year, month, wvByDate, faelligkeitenByDate, todayStr, returnTo }) {
  const weeks = getCalendarWeeks(year, month);

  return (
    <div>
      <h3 className="text-sm font-semibold text-center mb-2">
        {MONTH_NAMES[month]} {year}
      </h3>
      <div className="grid grid-cols-7 gap-px bg-border/40 rounded-lg overflow-hidden border border-border/40">
        {/* Weekday headers */}
        {WEEKDAYS.map((d) => (
          <div key={d} className="bg-muted/50 text-center text-[10px] font-semibold text-muted-foreground py-1">
            {d}
          </div>
        ))}
        {/* Days */}
        {weeks.flat().map((day, idx) => {
          if (day === null) {
            return <div key={`empty-${idx}`} className="bg-background min-h-[80px]" />;
          }
          const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
          const isToday = dateStr === todayStr;
          const isPast = dateStr < todayStr;
          const dayWvs = wvByDate[dateStr] || [];
          const dayFaell = faelligkeitenByDate[dateStr] || [];

          return (
            <div
              key={dateStr}
              className={`min-h-[80px] p-0.5 ${
                isToday ? 'bg-background ring-2 ring-inset ring-primary/50' :
                isPast ? 'bg-muted/20' : 'bg-background'
              }`}
            >
              <div className={`text-[11px] font-medium mb-0.5 px-0.5 ${
                isToday ? 'text-primary font-bold' :
                isPast ? 'text-muted-foreground/40' : 'text-muted-foreground'
              }`}>
                {day}
              </div>
              {dayWvs.map((wv) => (
                <WvCalendarEntry key={wv.wv_id} wv={wv} todayStr={todayStr} returnTo={returnTo} />
              ))}
              {dayFaell.map((f, fi) => (
                <FaelligkeitEntry key={`f-${fi}`} f={f} returnTo={returnTo} />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function WiedervorlagenPage() {
  const { canWrite } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  // Compute today in local time (toISODate uses local components, avoiding UTC offset bugs)
  const todayStr = useMemo(() => toISODate(new Date()), []);
  const today = useMemo(() => { const [y, m, d] = todayStr.split('-').map(Number); return new Date(y, m - 1, d); }, [todayStr]);
  const initialYearFromUrl = Number.parseInt(searchParams.get('y') || '', 10);
  const initialMonthFromUrl = Number.parseInt(searchParams.get('m') || '', 10);
  const hasValidYear = Number.isInteger(initialYearFromUrl) && initialYearFromUrl >= 1970 && initialYearFromUrl <= 3000;
  const hasValidMonth = Number.isInteger(initialMonthFromUrl) && initialMonthFromUrl >= 1 && initialMonthFromUrl <= 12;

  // Calendar navigation: start from current month
  const [baseYear, setBaseYear] = useState(() => (hasValidYear ? initialYearFromUrl : today.getFullYear()));
  const [baseMonth, setBaseMonth] = useState(() => (hasValidMonth ? initialMonthFromUrl - 1 : today.getMonth()));

  // Keep visible month in URL so document detail can return to the same calendar position.
  useEffect(() => {
    const y = String(baseYear);
    const m = String(baseMonth + 1);
    if (searchParams.get('y') === y && searchParams.get('m') === m) return;
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set('y', y);
    nextParams.set('m', m);
    setSearchParams(nextParams, { replace: true });
  }, [baseYear, baseMonth, searchParams, setSearchParams]);

  const returnTo = useMemo(() => `/analyse/wiedervorlagen?y=${baseYear}&m=${baseMonth + 1}`, [baseYear, baseMonth]);

  // Calculate date range to fetch: from first visible overdue to end of second month
  const von = useMemo(() => {
    // Go back up to 1 year to capture overdue WVs
    const d = new Date(baseYear, baseMonth - 12, 1);
    return toISODate(d);
  }, [baseYear, baseMonth]);

  const bis = useMemo(() => {
    const d = getMonthEnd(baseYear, baseMonth + 1 > 11 ? 0 : baseMonth + 1);
    const endYear = baseMonth + 1 > 11 ? baseYear + 1 : baseYear;
    return toISODate(new Date(endYear, (baseMonth + 2) % 12 === 0 ? 12 : (baseMonth + 2) % 12, 0));
  }, [baseYear, baseMonth]);

  // Better date range calculation
  const dateRange = useMemo(() => {
    const startDate = new Date(baseYear, baseMonth - 12, 1);
    // End of second visible month
    let endMonth = baseMonth + 1;
    let endYear = baseYear;
    if (endMonth > 11) { endMonth -= 12; endYear += 1; }
    const endDate = getMonthEnd(endYear, endMonth);
    return { von: toISODate(startDate), bis: toISODate(endDate) };
  }, [baseYear, baseMonth]);

  const { data, isLoading } = useWiedervorlagenKalender(dateRange.von, dateRange.bis);
  const updateWv = useUpdateWiedervorlage();
  const deleteWv = useDeleteWiedervorlage();
  const { pushAction } = useUndoHistory();
  const qc = useQueryClient();

  const [deleteConfirm, setDeleteConfirm] = useState(null);

  // Separate overdue (not erledigt, past) from the rest
  const { overdueList, wvByDate, faelligkeitenByDate } = useMemo(() => {
    if (!data) return { overdueList: [], wvByDate: {}, faelligkeitenByDate: {} };

    const overdue = [];
    const byDate = {};

    for (const wv of data.wiedervorlagen) {
      const d = wv.faellig_am?.split('T')[0] || wv.faellig_am;
      if (!wv.erledigt && d < todayStr) {
        overdue.push(wv);
      }
      if (!byDate[d]) byDate[d] = [];
      byDate[d].push(wv);
    }

    const fByDate = {};
    for (const f of data.faelligkeiten || []) {
      const d = f.faelligkeit?.split('T')[0] || f.faelligkeit;
      if (!fByDate[d]) fByDate[d] = [];
      fByDate[d].push(f);
    }

    overdue.sort((a, b) => a.faellig_am.localeCompare(b.faellig_am));

    return { overdueList: overdue, wvByDate: byDate, faelligkeitenByDate: fByDate };
  }, [data, todayStr]);

  const handleToggle = (wv) => {
    const wasErledigt = wv.erledigt;
    updateWv.mutate(
      { id: wv.wv_id, data: { erledigt: !wasErledigt } },
      {
        onSuccess: () => {
          pushAction(
            wasErledigt ? 'Wiedervorlage als offen markiert' : 'Wiedervorlage als erledigt markiert',
            async () => {
              await api.wiedervorlagen.update(wv.wv_id, { erledigt: wasErledigt });
              qc.invalidateQueries({ queryKey: ['wiedervorlagen'] });
            },
            async () => {
              await api.wiedervorlagen.update(wv.wv_id, { erledigt: !wasErledigt });
              qc.invalidateQueries({ queryKey: ['wiedervorlagen'] });
            },
          );
        },
      },
    );
  };

  const handleDelete = async () => {
    if (!deleteConfirm) return;
    const wvSnapshot = { ...deleteConfirm };
    await deleteWv.mutateAsync(wvSnapshot.wv_id);
    pushAction(
      `Wiedervorlage gelöscht: "${wvSnapshot.aktion}"`,
      async () => {
        await api.wiedervorlagen.create({
          postid: wvSnapshot.postid || null,
          akteid: wvSnapshot.akteid || null,
          faellig_am: wvSnapshot.faellig_am,
          aktion: wvSnapshot.aktion,
        });
        qc.invalidateQueries({ queryKey: ['wiedervorlagen'] });
      },
      async () => {
        await api.wiedervorlagen.delete(wvSnapshot.wv_id);
        qc.invalidateQueries({ queryKey: ['wiedervorlagen'] });
      },
    );
    setDeleteConfirm(null);
  };

  const navigateMonth = (delta) => {
    let m = baseMonth + delta;
    let y = baseYear;
    if (m > 11) { m -= 12; y += 1; }
    if (m < 0) { m += 12; y -= 1; }
    setBaseMonth(m);
    setBaseYear(y);
  };

  // Second month
  let month2 = baseMonth + 1;
  let year2 = baseYear;
  if (month2 > 11) { month2 -= 12; year2 += 1; }

  if (isLoading) return <PageLoader />;

  return (
    <div className="px-6 pt-4 pb-6 lg:px-8 lg:pb-8 space-y-6 max-w-6xl">
      <div>
        <GlowHeading>Kalender</GlowHeading>
        <p className="text-muted-foreground mt-1">Terminübersicht und Fälligkeiten.</p>
      </div>

      {/* Überfällige Liste */}
      {overdueList.length > 0 && (
        <Card className="border-red-200/60 bg-red-50/30">
          <CardHeader className="pb-2">
            <CardTitle className="text-base font-semibold text-red-700 flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" />
              Überfällige Wiedervorlagen ({overdueList.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-1">
              {overdueList.map((wv) => {
                const [wy, wmo, wd] = wv.faellig_am.slice(0, 10).split('-').map(Number);
                const due = new Date(wy, wmo - 1, wd); // local midnight, avoids UTC offset
                const diffDays = Math.round((today - due) / (1000 * 60 * 60 * 24));
                const refId = wv.postid || wv.akteid;
                const betreff = wv.post_betreff || wv.akte_betreff || '–';
                const linkTo = wv.postid ? `/postbuch/${wv.postid}` : `/akten/${wv.akteid}`;

                return (
                  <div
                    key={wv.wv_id}
                    className="flex items-center gap-3 px-2.5 py-2 rounded-lg bg-red-100/50 border border-red-200/60"
                  >
                    <Link to={linkTo} state={{ from: returnTo }} className="flex items-center gap-3 flex-1 min-w-0 hover:opacity-80 transition-opacity">
                      <span className="font-mono text-xs text-red-800 w-20 tabular-nums flex-shrink-0">
                        {formatDate(wv.faellig_am)}
                      </span>
                      <span className="text-xs font-bold text-red-600 w-28 flex-shrink-0">
                        seit {diffDays} {diffDays === 1 ? 'Tag' : 'Tagen'}
                      </span>
                      <span className="font-mono text-xs text-red-700 w-16 tabular-nums flex-shrink-0">{refId}</span>
                      <span className="text-sm font-semibold truncate flex-1">{betreff}</span>
                      <span className="text-xs bg-amber-200 text-amber-800 rounded px-1.5 py-0.5 truncate max-w-[220px] flex-shrink-0">
                        {wv.aktion}
                      </span>
                    </Link>
                    {canWrite && (
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <button
                          onClick={() => handleToggle(wv)}
                          className="p-1.5 rounded text-red-400 hover:text-emerald-600 hover:bg-emerald-50 transition-colors"
                          title="Als erledigt markieren"
                        >
                          <Check className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() => setDeleteConfirm(wv)}
                          className="p-1.5 rounded text-red-400 hover:text-red-700 hover:bg-red-100 transition-colors"
                          title="Löschen"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Calendar Navigation */}
      <div className="flex items-center justify-between">
        <Button variant="outline" size="sm" onClick={() => navigateMonth(-1)}>
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <span className="text-sm font-medium text-muted-foreground">
          {MONTH_NAMES[baseMonth]} {baseYear} – {MONTH_NAMES[month2]} {year2}
        </span>
        <Button variant="outline" size="sm" onClick={() => navigateMonth(1)}>
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>

      {/* Two-month calendar */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <MonthCalendar
          year={baseYear}
          month={baseMonth}
          wvByDate={wvByDate}
          faelligkeitenByDate={faelligkeitenByDate}
          todayStr={todayStr}
          returnTo={returnTo}
        />
        <MonthCalendar
          year={year2}
          month={month2}
          wvByDate={wvByDate}
          faelligkeitenByDate={faelligkeitenByDate}
          todayStr={todayStr}
          returnTo={returnTo}
        />
      </div>

      {/* All non-overdue pending WV as list below calendars for quick actions */}
      {data?.wiedervorlagen?.some(wv => !wv.erledigt) && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base font-semibold flex items-center gap-2">
              <CalendarClock className="h-4 w-4 text-primary" />
              Alle offenen Wiedervorlagen
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-1">
              {data.wiedervorlagen
                .filter(wv => !wv.erledigt)
                .sort((a, b) => a.faellig_am.localeCompare(b.faellig_am))
                .map((wv) => {
                  const due = new Date(wv.faellig_am);
                  due.setHours(0, 0, 0, 0);
                  const diffDays = Math.round((due - today) / (1000 * 60 * 60 * 24));
                  const isOverdue = diffDays < 0;
                  const isDueToday = diffDays === 0;
                  const refId = wv.postid || wv.akteid;
                  const betreff = wv.post_betreff || wv.akte_betreff || '–';
                  const linkTo = wv.postid ? `/postbuch/${wv.postid}` : `/akten/${wv.akteid}`;

                  return (
                    <div
                      key={wv.wv_id}
                      className={`flex items-center gap-3 px-2.5 py-2 rounded-lg border transition-colors ${
                        isOverdue ? 'bg-red-50/50 border-red-200/60' :
                        isDueToday ? 'bg-amber-50/50 border-amber-200/60' :
                        'border-border/50 hover:bg-primary/[0.02]'
                      }`}
                    >
                      <Link to={linkTo} state={{ from: returnTo }} className="flex items-center gap-3 flex-1 min-w-0 hover:opacity-80 transition-opacity">
                        <span className={`font-mono text-xs w-20 tabular-nums flex-shrink-0 ${
                          isOverdue ? 'text-red-600 font-bold' : isDueToday ? 'text-amber-600 font-bold' : 'text-muted-foreground'
                        }`}>{formatDate(wv.faellig_am)}</span>
                        <span className="font-mono text-xs text-muted-foreground w-16 tabular-nums flex-shrink-0">{refId}</span>
                        <span className="text-sm font-semibold truncate flex-1">{betreff}</span>
                        <span className="text-xs bg-amber-100 text-amber-800 rounded px-1.5 py-0.5 truncate max-w-[220px] flex-shrink-0">
                          {wv.aktion}
                        </span>
                      </Link>
                      {canWrite && (
                        <div className="flex items-center gap-1 flex-shrink-0">
                          <button
                            onClick={() => handleToggle(wv)}
                            className="p-1.5 rounded text-muted-foreground hover:text-emerald-600 hover:bg-emerald-50 transition-colors"
                            title="Als erledigt markieren"
                          >
                            <Check className="h-4 w-4" />
                          </button>
                          <button
                            onClick={() => setDeleteConfirm(wv)}
                            className="p-1.5 rounded text-muted-foreground hover:text-destructive hover:bg-red-50 transition-colors"
                            title="Löschen"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Delete Confirm Dialog */}
      <Dialog open={!!deleteConfirm} onOpenChange={() => setDeleteConfirm(null)}>
        <DialogTitle>Wiedervorlage löschen?</DialogTitle>
        <DialogDescription>
          Die Wiedervorlage &quot;{deleteConfirm?.aktion}&quot; ({formatDate(deleteConfirm?.faellig_am)}) wird unwiderruflich gelöscht.
        </DialogDescription>
        <DialogFooter>
          <Button variant="outline" onClick={() => setDeleteConfirm(null)}>Abbrechen</Button>
          <Button variant="destructive" onClick={handleDelete} disabled={deleteWv.isPending}>
            {deleteWv.isPending ? 'Lösche...' : 'Endgültig löschen'}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
