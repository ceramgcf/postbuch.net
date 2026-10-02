import { useEffect, useMemo, useState, useCallback } from 'react';
import { Link } from 'react-router';
import { api } from '@/api/client';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { PageLoader, EmptyState } from '@/components/ui/spinner';
import {
  Coins, Activity, Bot, ChevronRight, ChevronDown, Link2,
  RefreshCw, AlertCircle, Cpu,
} from 'lucide-react';

// ── Formatierung ────────────────────────────────────────────────────────────
// Einzeleinträge: Cent für kleine Beträge, Dollar ab $1.
function fmtUsd(v) {
  if (v == null || isNaN(Number(v))) return '–';
  const n = Number(v);
  if (n === 0) return '0 ¢';
  if (n < 0.01) return `${(n * 100).toFixed(3)} ¢`;
  if (n < 1)    return `${(n * 100).toFixed(2)} ¢`;
  return `$${n.toFixed(2)}`;
}

// Aggregierte Summen: immer in Dollar, damit Größenordnungen vergleichbar bleiben.
function fmtUsdSum(v) {
  if (v == null || isNaN(Number(v))) return '–';
  const n = Number(v);
  if (n === 0) return '$0.00';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function fmtInt(v) {
  if (v == null) return '–';
  return Number(v).toLocaleString('de-DE');
}

// Kosten-Zelle je Abrechnungsschiene:
//  - API/Bedrock: echte Kosten normal.
//  - Abo (Pauschaltarif): real wird nichts berechnet, daher die *fiktiven*
//    API-Kosten (cost_notional) durchgestrichen & gedimmt – nie in die echten
//    Summen gemischt, nur getrennt ausgewiesen.
function CostCell({ provider, cost, notional, sum = false }) {
  const fmt = sum ? fmtUsdSum : fmtUsd;
  if (provider === 'subscription') {
    const n = Number(notional) || 0;
    if (n <= 0) return <span className="text-muted-foreground">–</span>;
    return (
      <span className="line-through opacity-60" title="Fiktive API-Kosten – im Abo (Pauschaltarif) real nicht berechnet">
        {fmt(n)}
      </span>
    );
  }
  return <>{fmt(cost)}</>;
}

// Kosten einer Vorgangs-Gruppe: echte API-Kosten normal; falls die Gruppe auch
// Abo-Calls enthält, die fiktiven Kosten zusätzlich durchgestrichen darunter.
function GroupCost({ real, notional }) {
  const r = Number(real) || 0;
  const n = Number(notional) || 0;
  if (r > 0 && n > 0) {
    return (
      <span className="inline-flex flex-col items-end leading-tight">
        <span>{fmtUsd(r)}</span>
        <span className="line-through opacity-60 font-normal text-[10px]" title="zusätzlich fiktive Abo-Kosten (Pauschaltarif)">{fmtUsd(n)}</span>
      </span>
    );
  }
  if (n > 0) {
    return (
      <span className="line-through opacity-60" title="Fiktive API-Kosten – im Abo (Pauschaltarif) real nicht berechnet">
        {fmtUsd(n)}
      </span>
    );
  }
  return fmtUsd(r);
}

// Cache-Tokens: 0/null als Strich darstellen, um Rauschen zu vermeiden.
function fmtCache(v) {
  if (v == null || Number(v) === 0) return '–';
  return Number(v).toLocaleString('de-DE');
}

function fmtTs(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString('de-DE', {
    day: '2-digit', month: '2-digit', year: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

const KATEGORIE_LABEL = {
  preanalysis:         'Voranalyse',
  analysis:            'Dok-Analyse',
  erstattungsbescheid: 'EB-Parse',
  kuerzung:            'Kürzungs-Match',
  embedding:           'Embedding',
  search:              'Such-Embedding',
  akte_vorschlag:      'Akte-Vorschlag',
  other:               'Sonstiges',
};

// Kennzeichnet die Abrechnungsschiene eines Aufrufs durchgängig: „Abo" =
// Claude-Subscription (Pauschaltarif, keine Token-Kosten), „API" = klassischer
// API-Key/Bedrock (pro Token bezahlt). So ist in Liste, Details und Modell-
// Übersicht jederzeit eindeutig, wie ein Call abgerechnet wurde.
function ProviderBadge({ provider, className = '' }) {
  const isAbo = provider === 'subscription';
  return (
    <span
      className={`ml-1.5 inline-flex items-center rounded-full px-1.5 py-0 text-[10px] font-medium align-middle ${
        isAbo
          ? 'bg-violet-500/15 text-violet-600 dark:text-violet-300'
          : 'bg-sky-500/15 text-sky-600 dark:text-sky-300'
      } ${className}`}
      title={isAbo
        ? 'Über Claude-Subscription abgerechnet (Pauschaltarif, keine Token-Kosten)'
        : 'Über API-Key/Bedrock abgerechnet (pro Token)'}
    >
      {isAbo ? 'Abo' : 'API'}
    </span>
  );
}

function entityLink(entity, entityId) {
  if (!entityId) return null;
  if (entity === 'akte')     return `/akten/${entityId}`;
  if (entity === 'postbuch') return `/postbuch/${entityId}`;
  return null;
}

function EntityCell({ entity, entityId }) {
  if (!entityId) return <span className="text-muted-foreground">–</span>;
  const to = entityLink(entity, entityId);
  if (!to) return <span className="font-mono text-[11px]">{entityId}</span>;
  return (
    <Link
      to={to}
      className="font-mono text-[11px] text-primary hover:underline underline-offset-2"
      onClick={(e) => e.stopPropagation()}
    >
      {entityId}
    </Link>
  );
}

// ── Hauptkomponente ─────────────────────────────────────────────────────────

export default function TokenLogView() {
  const [limit, setLimit] = useState(100);
  const [stats, setStats] = useState(null);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [openGroups, setOpenGroups] = useState(() => new Set());

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [s, l] = await Promise.all([
        api.logs.llmStats(),
        api.logs.llm({ limit }),
      ]);
      setStats(s);
      setItems(l.items || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [limit]);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => {
    const id = setInterval(reload, 15_000);
    return () => clearInterval(id);
  }, [reload]);

  const groups = useMemo(() => groupByCorrelation(items), [items]);

  function toggleGroup(key) {
    setOpenGroups((prev) => {
      const n = new Set(prev);
      if (n.has(key)) n.delete(key); else n.add(key);
      return n;
    });
  }

  if (loading && items.length === 0 && !stats) return <PageLoader />;
  if (error) return <p className="text-destructive">Fehler: {error}</p>;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-end">
        <Button variant="ghost" size="sm" onClick={reload} className="gap-1.5">
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          <span>Aktualisieren</span>
        </Button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Heute (24h)" icon={Activity}
          api={pickPeriod(stats?.api, '24h')}  abo={pickPeriod(stats?.abo, '24h')}
          apiSplit={stats?.cost_split?.api?.['24h']} aboSplit={stats?.cost_split?.abo?.['24h']} />
        <StatCard label="7 Tage"      icon={Activity}
          api={pickPeriod(stats?.api, '7d')}   abo={pickPeriod(stats?.abo, '7d')}
          apiSplit={stats?.cost_split?.api?.['7d']} aboSplit={stats?.cost_split?.abo?.['7d']} />
        <StatCard label="30 Tage"     icon={Activity}
          api={pickPeriod(stats?.api, '30d')}  abo={pickPeriod(stats?.abo, '30d')}
          apiSplit={stats?.cost_split?.api?.['30d']} aboSplit={stats?.cost_split?.abo?.['30d']} />
        <StatCard label="Gesamt"      icon={Coins}
          api={pickPeriod(stats?.api, 'total')} abo={pickPeriod(stats?.abo, 'total')}
          apiSplit={stats?.cost_split?.api?.total} aboSplit={stats?.cost_split?.abo?.total} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {Array.isArray(stats?.by_kategorie) && stats.by_kategorie.length > 0 && (
          <Card className="p-3">
            <div className="flex items-center gap-2 mb-2">
              <Bot className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">Nach Kategorie (Gesamt)</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-muted-foreground border-b border-border">
                    <th className="py-1.5 pr-3">Kategorie</th>
                    <th className="py-1.5 pr-3 text-right">Calls</th>
                    <th className="py-1.5 pr-3 text-right">In</th>
                    <th className="py-1.5 pr-3 text-right">Out</th>
                    <th className="py-1.5 pr-3 text-right" title="Cache-Write">Cache↑</th>
                    <th className="py-1.5 pr-3 text-right" title="Cache-Read">Cache↓</th>
                    <th className="py-1.5 pr-3 text-right">Kosten</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.by_kategorie.map((r) => (
                    <tr key={r.kategorie} className="border-b border-border/40 last:border-0">
                      <td className="py-1.5 pr-3">{KATEGORIE_LABEL[r.kategorie] || r.kategorie}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{fmtInt(r.calls)}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{fmtInt(r.tokens_in)}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{fmtInt(r.tokens_out)}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums text-amber-600 dark:text-amber-400">{fmtCache(r.cache_write)}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums text-emerald-600 dark:text-emerald-400">{fmtCache(r.cache_read)}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{fmtUsdSum(r.cost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}

        {Array.isArray(stats?.by_model) && stats.by_model.length > 0 && (
          <Card className="p-3">
            <div className="flex items-center gap-2 mb-2">
              <Cpu className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">Nach Modell (Gesamt)</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-muted-foreground border-b border-border">
                    <th className="py-1.5 pr-3">Modell</th>
                    <th className="py-1.5 pr-3 text-right">Calls</th>
                    <th className="py-1.5 pr-3 text-right">In</th>
                    <th className="py-1.5 pr-3 text-right">Out</th>
                    <th className="py-1.5 pr-3 text-right" title="Cache-Write">Cache↑</th>
                    <th className="py-1.5 pr-3 text-right" title="Cache-Read">Cache↓</th>
                    <th className="py-1.5 pr-3 text-right">Kosten</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.by_model.map((r) => (
                    <tr
                      key={`${r.provider}-${r.model}`}
                      className={`border-b border-border/40 last:border-0 ${r.provider === 'subscription' ? 'opacity-50' : ''}`}
                      title={r.provider === 'subscription' ? 'Abo (Pauschaltarif) – nicht in den aggregierten Summen enthalten' : undefined}
                    >
                      <td className="py-1.5 pr-3 font-mono text-[11px]">{r.model}<ProviderBadge provider={r.provider} /></td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{fmtInt(r.calls)}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{fmtInt(r.tokens_in)}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{fmtInt(r.tokens_out)}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums text-amber-600 dark:text-amber-400">{fmtCache(r.cache_write)}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums text-emerald-600 dark:text-emerald-400">{fmtCache(r.cache_read)}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">
                        <CostCell provider={r.provider} cost={r.cost} notional={r.cost_notional} sum />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </div>

      <Card className="p-0 overflow-hidden">
        <div className="flex items-center justify-between px-3 py-2 border-b border-border">
          <span className="text-sm font-medium">Letzte {items.length} Aufrufe</span>
          <select
            className="h-7 text-xs rounded-md border border-border bg-background px-2"
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
          >
            <option value={50}>50</option>
            <option value={100}>100</option>
            <option value={200}>200</option>
            <option value={500}>500</option>
          </select>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-muted-foreground border-b border-border bg-muted/30">
                <th className="py-2 px-2">Zeitpunkt</th>
                <th className="py-2 px-2">Kategorie</th>
                <th className="py-2 px-2">Modell</th>
                <th className="py-2 px-2">Bezug</th>
                <th className="py-2 px-2 text-right">In</th>
                <th className="py-2 px-2 text-right">Out</th>
                <th className="py-2 px-2 text-right" title="Cache-Write (eigener Preis je Modell)">Cache↑</th>
                <th className="py-2 px-2 text-right" title="Cache-Read (eigener Preis je Modell)">Cache↓</th>
                <th className="py-2 px-2 text-right">Kosten</th>
                <th className="py-2 px-2 text-right">ms</th>
                <th className="py-2 px-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {!loading && groups.length === 0 && (
                <tr>
                  <td colSpan={11} className="p-0">
                    <EmptyState icon={Coins} title="Noch keine Einträge" description="LLM-Aufrufe (Anthropic / OpenAI) erscheinen hier mit Tokens und Kosten." />
                  </td>
                </tr>
              )}
              {groups.map((g) => (
                g.isGroup
                  ? <GroupRows
                      key={g.key}
                      group={g}
                      open={openGroups.has(g.key)}
                      onToggle={() => toggleGroup(g.key)}
                    />
                  : <CallRow key={g.items[0].id} call={g.items[0]} />
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

// ── Gruppierungs-Logik ─────────────────────────────────────────────────────
// Einträge mit gleicher correlation_id werden zu einer Gruppe zusammengefasst.
// Innerhalb der Gruppe ASC (erst Voranalyse, dann Analyse, …).
function groupByCorrelation(items) {
  const out = [];
  const seen = new Set();
  for (const it of items) {
    if (!it.correlation_id) {
      out.push({ key: `solo-${it.id}`, isGroup: false, items: [it] });
      continue;
    }
    const cid = it.correlation_id;
    if (seen.has(cid)) continue;
    seen.add(cid);
    const groupItems = items.filter((x) => x.correlation_id === cid);
    if (groupItems.length === 1) {
      out.push({ key: `c-${cid}`, isGroup: false, items: groupItems });
    } else {
      const sorted = [...groupItems].sort((a, b) => new Date(a.ts) - new Date(b.ts));
      out.push({ key: `c-${cid}`, isGroup: true, correlation_id: cid, items: sorted });
    }
  }
  return out;
}

function sumGroup(items) {
  return items.reduce((acc, r) => ({
    calls:        acc.calls + 1,
    tokens_in:    acc.tokens_in + (Number(r.tokens_in) || 0),
    tokens_out:   acc.tokens_out + (Number(r.tokens_out) || 0),
    cache_write:  acc.cache_write + (Number(r.cache_creation_tokens) || 0),
    cache_read:   acc.cache_read + (Number(r.cache_read_tokens) || 0),
    cost_usd:     acc.cost_usd + (Number(r.cost_usd) || 0),
    cost_notional: acc.cost_notional + (Number(r.cost_usd_notional) || 0),
    duration_ms:  acc.duration_ms + (Number(r.duration_ms) || 0),
    any_error:    acc.any_error || r.success === false,
  }), { calls: 0, tokens_in: 0, tokens_out: 0, cache_write: 0, cache_read: 0, cost_usd: 0, cost_notional: 0, duration_ms: 0, any_error: false });
}

function GroupRows({ group, open, onToggle }) {
  const sum = sumGroup(group.items);
  const first = group.items[0];
  const kategorieChips = useMemo(() => {
    const counts = {};
    for (const it of group.items) counts[it.kategorie] = (counts[it.kategorie] || 0) + 1;
    return Object.entries(counts).map(([k, n]) => `${KATEGORIE_LABEL[k] || k}${n > 1 ? ` ×${n}` : ''}`);
  }, [group.items]);
  // Fehlertexte der fehlgeschlagenen Calls für den Tooltip am Sammel-Icon –
  // sonst ist auf der eingeklappten Gruppe nicht sichtbar, WORAN es scheiterte.
  const errSummary = useMemo(() => (
    group.items
      .filter((r) => r.success === false)
      .map((r) => `${r.model} (${r.provider === 'subscription' ? 'Abo' : 'API'}): ${r.error_message || 'Fehler'}`)
      .join('\n')
  ), [group.items]);

  return (
    <>
      <tr
        className="border-b border-border/40 bg-primary/5 hover:bg-primary/10 cursor-pointer"
        onClick={onToggle}
      >
        <td className="py-1.5 px-2 tabular-nums whitespace-nowrap">
          <div className="flex items-center gap-1.5">
            {open
              ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
              : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
            <Link2 className="h-3 w-3 text-primary/70" />
            <span>{fmtTs(first.ts)}</span>
          </div>
        </td>
        <td className="py-1.5 px-2 text-[11px]" colSpan={2}>
          <span className="font-medium">Vorgang</span>
          <div className="text-muted-foreground mt-0.5">{kategorieChips.join(' · ')}</div>
        </td>
        <td className="py-1.5 px-2"><EntityCell entity={first.entity} entityId={first.entity_id} /></td>
        <td className="py-1.5 px-2 text-right tabular-nums">{fmtInt(sum.tokens_in)}</td>
        <td className="py-1.5 px-2 text-right tabular-nums">{fmtInt(sum.tokens_out)}</td>
        <td className="py-1.5 px-2 text-right tabular-nums text-amber-600 dark:text-amber-400">{fmtCache(sum.cache_write)}</td>
        <td className="py-1.5 px-2 text-right tabular-nums text-emerald-600 dark:text-emerald-400">{fmtCache(sum.cache_read)}</td>
        <td className="py-1.5 px-2 text-right tabular-nums font-semibold"><GroupCost real={sum.cost_usd} notional={sum.cost_notional} /></td>
        <td className="py-1.5 px-2 text-right tabular-nums">{sum.duration_ms || '–'}</td>
        <td className="py-1.5 px-2">
          <span className="text-[11px] text-muted-foreground">{sum.calls} Calls</span>
          {sum.any_error && (
            <AlertCircle
              className="inline h-3 w-3 text-destructive ml-1 cursor-help align-text-bottom"
              title={errSummary || 'Mindestens ein Aufruf ist fehlgeschlagen'}
            />
          )}
        </td>
      </tr>
      {open && group.items.map((r) => <CallRow key={r.id} call={r} indented />)}
    </>
  );
}

function CallRow({ call, indented = false }) {
  // Abo-Calls: Token/Kosten abgeschwächt darstellen – Pauschaltarif, nicht pro Stück
  // abgerechnet und nicht in den aggregierten Summen enthalten.
  const dim = call.provider === 'subscription'
    ? 'opacity-50'
    : '';
  const dimTitle = call.provider === 'subscription'
    ? 'Abo (Pauschaltarif) – Token-Info informativ, nicht abgerechnet'
    : undefined;
  return (
    <tr className={`border-b border-border/40 last:border-0 hover:bg-muted/20 ${indented ? 'bg-muted/10' : ''}`}>
      <td className={`py-1.5 px-2 tabular-nums whitespace-nowrap ${indented ? 'pl-7 text-muted-foreground' : ''}`}>
        {fmtTs(call.ts)}
      </td>
      <td className="py-1.5 px-2">{KATEGORIE_LABEL[call.kategorie] || call.kategorie}</td>
      <td className="py-1.5 px-2 font-mono text-[11px]">{call.model}<ProviderBadge provider={call.provider} /></td>
      <td className="py-1.5 px-2"><EntityCell entity={call.entity} entityId={call.entity_id} /></td>
      <td className={`py-1.5 px-2 text-right tabular-nums ${dim}`} title={dimTitle}>{fmtInt(call.tokens_in)}</td>
      <td className={`py-1.5 px-2 text-right tabular-nums ${dim}`} title={dimTitle}>{fmtInt(call.tokens_out)}</td>
      <td className={`py-1.5 px-2 text-right tabular-nums text-amber-600 dark:text-amber-400 ${dim}`} title={dimTitle || 'Cache-Write (eigener Preis je Modell)'}>{fmtCache(call.cache_creation_tokens)}</td>
      <td className={`py-1.5 px-2 text-right tabular-nums text-emerald-600 dark:text-emerald-400 ${dim}`} title={dimTitle || 'Cache-Read (eigener Preis je Modell)'}>{fmtCache(call.cache_read_tokens)}</td>
      <td className="py-1.5 px-2 text-right tabular-nums" title={dimTitle}>
        <CostCell provider={call.provider} cost={call.cost_usd} notional={call.cost_usd_notional} />
      </td>
      <td className="py-1.5 px-2 text-right tabular-nums">{call.duration_ms ?? '–'}</td>
      <td className="py-1.5 px-2">
        {call.success
          ? <span className="text-emerald-500">OK</span>
          : (
            <span
              className="text-destructive cursor-help underline decoration-dotted decoration-destructive/50 underline-offset-2"
              title={call.error_message || 'Aufruf fehlgeschlagen (kein Fehlertext protokolliert)'}
            >
              Fehler
            </span>
          )}
      </td>
    </tr>
  );
}

// Schneidet aus einem Bucket (stats.api / stats.abo) die Werte einer Periode
// (24h | 7d | 30d | total) in ein flaches Objekt für die StatCard.
function pickPeriod(src, suffix) {
  if (!src) return {};
  return {
    cost:         src[`cost_${suffix}`],
    costNotional: src[`cost_notional_${suffix}`],
    calls:      src[`calls_${suffix}`],
    tokensIn:   src[`tokens_in_${suffix}`],
    tokensOut:  src[`tokens_out_${suffix}`],
    cacheWrite: src[`cache_write_${suffix}`],
    cacheRead:  src[`cache_read_${suffix}`],
  };
}

// Ring-Diagramm: Kosten-Anteil Dokumentenanalyse (alle Pipeline-Kategorien)
// vs. Chat (Assistent). Farben nach fixer kategorialer Reihenfolge (blau/aqua),
// nicht zyklisch – Prozentzahlen stehen zusätzlich als Text daneben, damit die
// Zuordnung nie allein an der Farbe hängt.
const RING_SIZE = 34;
const RING_STROKE = 6;

function CostRing({ doku, chat }) {
  const d = Number(doku) || 0;
  const c = Number(chat) || 0;
  const total = d + c;
  if (total <= 0) return null;

  const r = (RING_SIZE - RING_STROKE) / 2;
  const circumference = 2 * Math.PI * r;
  const gap = 3; // 2px Surface-Gap zwischen den Segmenten (aufgerundet für Rendering-Toleranz)
  const dokuPct = Math.round((d / total) * 100);
  const chatPct = 100 - dokuPct;
  const dokuLen = Math.max((d / total) * circumference - gap, 0);
  const chatLen = Math.max((c / total) * circumference - gap, 0);

  return (
    <div className="flex items-center gap-2 mt-0.5">
      <svg
        width={RING_SIZE} height={RING_SIZE} viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
        className="shrink-0" role="img" aria-label={`Dok-Analyse ${dokuPct}% · Chat ${chatPct}%`}
      >
        <g transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}>
          <circle
            cx={RING_SIZE / 2} cy={RING_SIZE / 2} r={r} fill="none"
            className="stroke-[#2a78d6] dark:stroke-[#3987e5]"
            strokeWidth={RING_STROKE}
            strokeDasharray={`${dokuLen} ${circumference - dokuLen}`}
          />
          <circle
            cx={RING_SIZE / 2} cy={RING_SIZE / 2} r={r} fill="none"
            className="stroke-[#1baf7a] dark:stroke-[#199e70]"
            strokeWidth={RING_STROKE}
            strokeDasharray={`${chatLen} ${circumference - chatLen}`}
            strokeDashoffset={-(dokuLen + gap)}
          />
        </g>
      </svg>
      <div className="text-[10px] leading-tight tabular-nums">
        <div className="flex items-center gap-1">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-[#2a78d6] dark:bg-[#3987e5]" />
          <span className="text-muted-foreground">Dok-Analyse {dokuPct}%</span>
        </div>
        <div className="flex items-center gap-1">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-[#1baf7a] dark:bg-[#199e70]" />
          <span className="text-muted-foreground">Chat {chatPct}%</span>
        </div>
      </div>
    </div>
  );
}

function CacheLine({ write, read }) {
  const has = (Number(write) || 0) > 0 || (Number(read) || 0) > 0;
  if (!has) return <div className="text-[11px] text-muted-foreground">kein Cache</div>;
  return (
    <div className="text-[11px] tabular-nums" title="Cache-Write (Cache↑) / Cache-Read (Cache↓)">
      <span className="text-amber-600 dark:text-amber-400">Cache↑ {fmtInt(write)}</span>
      <span className="text-muted-foreground"> / </span>
      <span className="text-emerald-600 dark:text-emerald-400">Cache↓ {fmtInt(read)}</span>
    </div>
  );
}

function StatCard({ label, api = {}, abo = {}, apiSplit, aboSplit, icon: Icon }) {
  const showAbo = (Number(abo.calls) || 0) > 0;
  return (
    <Card className="p-3 flex flex-col gap-2">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        <span>{label}</span>
      </div>

      {/* API – pro Token abgerechnet */}
      <div className="flex flex-col gap-0.5">
        <div className="flex items-center gap-1.5">
          <ProviderBadge provider="api" className="ml-0" />
          <span className="text-lg font-semibold tabular-nums">{fmtUsdSum(api.cost)}</span>
        </div>
        <div className="text-[11px] text-muted-foreground tabular-nums">
          {fmtInt(api.calls)} Calls · {fmtInt(api.tokensIn)} in / {fmtInt(api.tokensOut)} out
        </div>
        <CacheLine write={api.cacheWrite} read={api.cacheRead} />
        <CostRing doku={apiSplit?.doku} chat={apiSplit?.chat} />
      </div>

      {/* Abo – Pauschaltarif, separat & gedimmt */}
      {showAbo && (
        <div className="flex flex-col gap-0.5 opacity-70 border-t border-border/40 pt-1.5">
          <div className="flex items-center gap-1.5">
            <ProviderBadge provider="subscription" className="ml-0" />
            <span
              className="text-lg font-semibold tabular-nums line-through decoration-1"
              title="Fiktive API-Kosten – im Abo (Pauschaltarif) real nicht berechnet"
            >
              {fmtUsdSum(abo.costNotional)}
            </span>
          </div>
          <div className="text-[10px] italic text-muted-foreground -mt-0.5">fiktiv · im Abo nicht berechnet</div>
          <div className="text-[11px] text-muted-foreground tabular-nums">
            {fmtInt(abo.calls)} Calls · {fmtInt(abo.tokensIn)} in / {fmtInt(abo.tokensOut)} out
          </div>
          <CacheLine write={abo.cacheWrite} read={abo.cacheRead} />
          <CostRing doku={aboSplit?.doku} chat={aboSplit?.chat} />
        </div>
      )}
    </Card>
  );
}
