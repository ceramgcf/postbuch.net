import { useState, useEffect, useCallback } from 'react';
import { useSearchParams, Link } from 'react-router';
import { api } from '@/api/client';
import { GlowHeading } from '@/components/ui/GlowHeading';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Pagination } from '@/components/ui/Pagination';
import { PageLoader, EmptyState } from '@/components/ui/spinner';
import { ScrollText, AlertTriangle, AlertCircle, Info, ChevronDown, ChevronRight, Bug } from 'lucide-react';
import { JobsMonitor } from '@/components/JobsMonitor';
import TokenLogView from '@/components/logs/TokenLogView';

const PER_PAGE = 50;

// ── Shared helpers ──────────────────────────────────────────────────────────

function formatTs(ts) {
  if (!ts) return '–';
  const d = new Date(ts);
  const date = d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const time = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return `${date} ${time}`;
}

function entityLink(entity, entityId) {
  if (!entityId) return null;
  if (entity?.startsWith('akte')) return `/akten/${entityId}`;
  if (entityId?.match(/^P\d{6}$/)) return `/postbuch/${entityId}`;
  return null;
}

function EntityIdCell({ entity, entityId }) {
  const to = entityLink(entity, entityId);
  if (!to) return <span className="font-mono text-xs text-foreground/70">{entityId || '–'}</span>;
  return (
    <Link
      to={to}
      className="font-mono text-xs text-primary hover:underline underline-offset-2"
      onClick={(e) => e.stopPropagation()}
    >
      {entityId}
    </Link>
  );
}

// ── Debug-Mode Toggle ────────────────────────────────────────────────────────

function DebugModeToggle() {
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.settingsPublic.getDebugMode().then((r) => setEnabled(r.enabled ?? false)).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const toggle = async () => {
    setSaving(true);
    try {
      const next = !enabled;
      await api.settingsPublic.setDebugMode(next);
      setEnabled(next);
    } catch (err) {
      console.error('Debug-Mode toggle fehlgeschlagen:', err.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return null;

  return (
    <button
      onClick={toggle}
      disabled={saving}
      title="Debug-Modus: Detaillierte Pipeline-Logs (JSON) werden pro Dokument in OneDrive gespeichert"
      className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium border transition-colors ${
        enabled
          ? 'border-amber-500/60 bg-amber-500/15 text-amber-400 hover:bg-amber-500/25'
          : 'border-border text-muted-foreground hover:text-foreground hover:border-border/80'
      } ${saving ? 'opacity-50 cursor-wait' : ''}`}
    >
      <Bug className="h-3.5 w-3.5" />
      Debug-Modus {enabled ? 'AN' : 'AUS'}
    </button>
  );
}

// ── Tab bar ─────────────────────────────────────────────────────────────────

function TabBar({ tab, onTabChange, systemCounts, activeJobCount }) {
  const errorCount = systemCounts?.ERROR || 0;
  const warnCount = systemCounts?.WARN || 0;
  const tabs = [
    { id: 'jobs', label: 'Jobs', badge: activeJobCount, badgeCls: 'bg-sky-500/20 text-sky-400' },
    { id: 'token', label: 'Token-Kosten' },
    { id: 'activity', label: 'Aktivität' },
    { id: 'system', label: 'System', badge: errorCount + warnCount, badgeCls: 'bg-destructive/20 text-destructive' },
  ];
  return (
    <div className="flex flex-wrap gap-1 border-b border-border pb-2">
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => onTabChange(t.id)}
          className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors
            ${tab === t.id
              ? 'bg-primary/10 text-primary'
              : 'text-muted-foreground hover:text-foreground hover:bg-muted'
            }`}
        >
          {t.label}
          {t.badge > 0 && (
            <span className={`ml-1.5 inline-flex items-center justify-center rounded-full text-[10px] font-bold min-w-[18px] h-[18px] px-1 ${t.badgeCls || 'bg-destructive/20 text-destructive'}`}>
              {t.badge > 99 ? '99+' : t.badge}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

// ── Activity log tab ────────────────────────────────────────────────────────

const ACTION_COLORS = {
  CREATE:        'text-emerald-400',
  UPDATE:        'text-sky-400',
  DELETE:        'text-red-400',
  AI_EMBEDDING:  'text-purple-400',
  AI_CALL:       'text-violet-400',
  WEBHOOK:       'text-amber-400',
  RESTORE:       'text-teal-400',
};

function ActionBadge({ action }) {
  const cls = ACTION_COLORS[action] || 'text-muted-foreground';
  return <span className={`font-mono text-xs font-semibold ${cls}`}>{action}</span>;
}

function ActivityTab({ page, onPageChange }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchLogs = useCallback(async (p) => {
    try {
      setLoading(true);
      const result = await api.logs.list({ limit: PER_PAGE, offset: (p - 1) * PER_PAGE });
      setData(result);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchLogs(page); }, [page, fetchLogs]);
  useEffect(() => {
    if (page !== 1) return;
    const id = setInterval(() => fetchLogs(1), 15_000);
    return () => clearInterval(id);
  }, [page, fetchLogs]);

  const rows = data?.data || [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));

  if (loading && rows.length === 0) return <PageLoader />;
  if (error) return <p className="text-destructive">Fehler: {error}</p>;
  if (rows.length === 0) return <EmptyState icon={ScrollText} title="Noch keine Einträge" description="Schreiboperationen werden hier protokolliert." />;

  return (
    <>
      <p className="text-muted-foreground text-sm">
        {total} Einträge · max. 1 000 gespeichert · aktualisiert alle 15 s (Seite 1)
      </p>
      {totalPages > 1 && (
        <Pagination page={page} totalPages={totalPages} perPage={PER_PAGE} total={total} onPageChange={onPageChange} />
      )}
      <div className="rounded-lg border border-border overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-44">Zeitstempel</TableHead>
              <TableHead className="w-36">Aktion</TableHead>
              <TableHead className="w-44">Entität</TableHead>
              <TableHead className="w-32">ID</TableHead>
              <TableHead>Details</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id} className="text-xs">
                <TableCell className="text-muted-foreground tabular-nums whitespace-nowrap">{formatTs(row.ts)}</TableCell>
                <TableCell><ActionBadge action={row.action} /></TableCell>
                <TableCell className="font-mono text-xs text-foreground/80">{row.entity}</TableCell>
                <TableCell><EntityIdCell entity={row.entity} entityId={row.entity_id} /></TableCell>
                <TableCell className="text-muted-foreground max-w-md break-words whitespace-pre-wrap">{row.details || '–'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {totalPages > 1 && (
        <Pagination page={page} totalPages={totalPages} perPage={PER_PAGE} total={total} onPageChange={onPageChange} />
      )}
    </>
  );
}

// ── System log tab ──────────────────────────────────────────────────────────

const LEVEL_CONFIG = {
  ERROR: { icon: AlertCircle,   cls: 'text-red-400',    bgCls: 'bg-red-500/15 text-red-400' },
  WARN:  { icon: AlertTriangle, cls: 'text-amber-400',  bgCls: 'bg-amber-500/15 text-amber-400' },
  INFO:  { icon: Info,          cls: 'text-sky-400',     bgCls: 'bg-sky-500/15 text-sky-400' },
};

function LevelBadge({ level }) {
  const cfg = LEVEL_CONFIG[level] || LEVEL_CONFIG.INFO;
  const Icon = cfg.icon;
  return (
    <span className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-semibold ${cfg.bgCls}`}>
      <Icon className="h-3 w-3" />
      {level}
    </span>
  );
}

function LevelFilter({ level, onLevelChange, counts }) {
  const levels = [
    { id: null,    label: 'Alle',     count: (counts.ERROR || 0) + (counts.WARN || 0) + (counts.INFO || 0) },
    { id: 'ERROR', label: 'Fehler',   count: counts.ERROR || 0 },
    { id: 'WARN',  label: 'Warnungen', count: counts.WARN || 0 },
    { id: 'INFO',  label: 'Info',     count: counts.INFO || 0 },
  ];
  return (
    <div className="flex gap-1.5 flex-wrap">
      {levels.map((l) => (
        <button
          key={l.id ?? 'all'}
          onClick={() => onLevelChange(l.id)}
          className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors border
            ${level === l.id
              ? 'border-primary/40 bg-primary/10 text-primary'
              : 'border-border text-muted-foreground hover:text-foreground hover:border-border/80'
            }`}
        >
          {l.label}
          <span className="tabular-nums opacity-70">{l.count}</span>
        </button>
      ))}
    </div>
  );
}

function ExpandableDetails({ details }) {
  const [open, setOpen] = useState(false);
  if (!details) return <span className="text-muted-foreground">–</span>;
  if (details.length < 120) return <span className="text-muted-foreground whitespace-pre-wrap break-words">{details}</span>;
  const Icon = open ? ChevronDown : ChevronRight;
  return (
    <div>
      <button onClick={() => setOpen(!open)} className="inline-flex items-center gap-0.5 text-muted-foreground hover:text-foreground transition-colors">
        <Icon className="h-3 w-3 shrink-0" />
        <span className={open ? 'whitespace-pre-wrap break-words' : 'truncate max-w-xs inline-block align-bottom'}>{details}</span>
      </button>
    </div>
  );
}

function SystemTab({ page, onPageChange }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [level, setLevel] = useState(null);

  const fetchLogs = useCallback(async (p, lvl) => {
    try {
      setLoading(true);
      const params = { limit: PER_PAGE, offset: (p - 1) * PER_PAGE };
      if (lvl) params.level = lvl;
      const result = await api.logs.system(params);
      setData(result);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchLogs(page, level); }, [page, level, fetchLogs]);
  useEffect(() => {
    if (page !== 1) return;
    const id = setInterval(() => fetchLogs(1, level), 15_000);
    return () => clearInterval(id);
  }, [page, level, fetchLogs]);

  const handleLevelChange = (l) => {
    setLevel(l);
    onPageChange(1);
  };

  const rows = data?.data || [];
  const total = data?.total ?? 0;
  const counts = data?.counts || { ERROR: 0, WARN: 0, INFO: 0 };
  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));

  return (
    <>
      <div className="flex items-center justify-between flex-wrap gap-2">
        <p className="text-muted-foreground text-sm">
          {total} Einträge · max. 2 000 gespeichert · aktualisiert alle 15 s (Seite 1)
        </p>
        <LevelFilter level={level} onLevelChange={handleLevelChange} counts={counts} />
      </div>
      {loading && rows.length === 0 ? (
        <PageLoader />
      ) : error ? (
        <p className="text-destructive">Fehler: {error}</p>
      ) : rows.length === 0 ? (
        <EmptyState icon={ScrollText} title="Keine Systemereignisse" description="Fehler, Warnungen und Service-Events erscheinen hier." />
      ) : (
        <>
          {totalPages > 1 && (
            <Pagination page={page} totalPages={totalPages} perPage={PER_PAGE} total={total} onPageChange={onPageChange} />
          )}
          <div className="rounded-lg border border-border overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-44">Zeitstempel</TableHead>
                  <TableHead className="w-24">Level</TableHead>
                  <TableHead className="w-36">Quelle</TableHead>
                  <TableHead className="w-32">ID</TableHead>
                  <TableHead>Nachricht</TableHead>
                  <TableHead className="w-72">Details</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id} className="text-xs">
                    <TableCell className="text-muted-foreground tabular-nums whitespace-nowrap">{formatTs(row.ts)}</TableCell>
                    <TableCell><LevelBadge level={row.level} /></TableCell>
                    <TableCell className="font-mono text-xs text-foreground/80">{row.source}</TableCell>
                    <TableCell><EntityIdCell entity={row.entity} entityId={row.entity_id} /></TableCell>
                    <TableCell className="text-foreground/90 max-w-sm break-words whitespace-pre-wrap">{row.message}</TableCell>
                    <TableCell className="text-xs"><ExpandableDetails details={row.details} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {totalPages > 1 && (
            <Pagination page={page} totalPages={totalPages} perPage={PER_PAGE} total={total} onPageChange={onPageChange} />
          )}
        </>
      )}
    </>
  );
}

// ── Main page ───────────────────────────────────────────────────────────────

const VALID_TABS = ['jobs', 'token', 'activity', 'system'];
const SYSTEM_VIEWED_KEY = 'systemLogsLastViewed';

export default function LogsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const urlPage = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
  const urlTab = VALID_TABS.includes(searchParams.get('tab')) ? searchParams.get('tab') : 'jobs';

  const [tab, setTab] = useState(urlTab);
  const [page, setPage] = useState(urlPage);
  const [systemCounts, setSystemCounts] = useState({ ERROR: 0, WARN: 0, INFO: 0 });
  const [activeJobCount, setActiveJobCount] = useState(0);

  // Fetch badge counts: only entries newer than last time the System tab was viewed
  const fetchBadge = useCallback(() => {
    const since = localStorage.getItem(SYSTEM_VIEWED_KEY);
    const params = { limit: 1, offset: 0 };
    if (since) params.since = since;
    api.logs.system(params).then((r) => {
      if (r.counts) setSystemCounts(r.counts);
    }).catch(() => {});
  }, []);

  // On mount: if landing directly on System tab mark as viewed, otherwise load badge
  useEffect(() => {
    if (urlTab === 'system') {
      try { localStorage.setItem(SYSTEM_VIEWED_KEY, new Date().toISOString()); } catch {}
    } else {
      fetchBadge();
    }
    if (urlTab === 'jobs') {
      // Mark failed docs as seen when landing directly on Jobs tab
      try { localStorage.setItem('failed_docs_last_seen', Date.now().toString()); } catch {}
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll badge every 15 s – but not while the user is already on the System tab
  useEffect(() => {
    if (tab === 'system') return;
    const id = setInterval(fetchBadge, 15_000);
    return () => clearInterval(id);
  }, [tab, fetchBadge]);

  // Poll active job count for the Jobs tab badge (every 5 s)
  useEffect(() => {
    let cancelled = false;
    const load = () => api.jobs.list()
      .then((r) => { if (!cancelled) setActiveJobCount((r.active || []).length); })
      .catch(() => {});
    load();
    const id = setInterval(load, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const handleTabChange = (t) => {
    if (t === 'system') {
      // Mark System logs as viewed – reset the unread badge
      try { localStorage.setItem(SYSTEM_VIEWED_KEY, new Date().toISOString()); } catch {}
      setSystemCounts({ ERROR: 0, WARN: 0, INFO: 0 });
    }
    if (t === 'jobs') {
      // Mark failed documents as seen – clears FailedDocumentsBanner on Dashboard
      try { localStorage.setItem('failed_docs_last_seen', Date.now().toString()); } catch {}
    }
    setTab(t);
    setPage(1);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (t === 'jobs') next.delete('tab');
      else next.set('tab', t);
      next.delete('page');
      return next;
    }, { replace: true });
  };

  const handlePageChange = (p) => {
    setPage(p);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (p <= 1) next.delete('page');
      else next.set('page', String(p));
      return next;
    }, { replace: true });
  };

  return (
    <div className="px-6 pt-4 pb-6 lg:px-8 lg:pb-8 space-y-4">
      <div className="flex items-center justify-between gap-4">
        <GlowHeading>Aktivitätslog</GlowHeading>
        <DebugModeToggle />
      </div>
      <TabBar tab={tab} onTabChange={handleTabChange} systemCounts={systemCounts} activeJobCount={activeJobCount} />
      <div className="space-y-4">
        {tab === 'jobs' ? (
          <JobsMonitor />
        ) : tab === 'token' ? (
          <TokenLogView />
        ) : tab === 'activity' ? (
          <ActivityTab page={page} onPageChange={handlePageChange} />
        ) : (
          <SystemTab page={page} onPageChange={handlePageChange} />
        )}
      </div>
    </div>
  );
}
