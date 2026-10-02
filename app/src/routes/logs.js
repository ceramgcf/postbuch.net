import { Router } from 'express';
import { query } from '../db.js';

const router = Router();

// GET /api/logs?limit=50&offset=0  — Aktivitätslog (Benutzeraktionen)
router.get('/', async (req, res) => {
  try {
    const limitNum = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const offsetNum = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const [countResult, dataResult] = await Promise.all([
      query(`SELECT COUNT(*) AS total FROM ui_log`),
      query(
        `SELECT id, ts, action, entity, entity_id, details
         FROM ui_log
         ORDER BY ts DESC, id DESC
         LIMIT $1 OFFSET $2`,
        [limitNum, offsetNum]
      ),
    ]);

    res.json({
      data: dataResult.rows,
      total: parseInt(countResult.rows[0].total, 10),
      limit: limitNum,
      offset: offsetNum,
    });
  } catch (err) {
    console.error('GET /api/logs error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// GET /api/logs/system?limit=50&offset=0&level=ERROR  — Systemlog (Fehler, Warnungen, Service-Events)
router.get('/system', async (req, res) => {
  try {
    const limitNum = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const offsetNum = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const level = req.query.level; // optional: 'ERROR', 'WARN', 'INFO'

    const validLevels = ['ERROR', 'WARN', 'INFO'];
    const levelFilter = level && validLevels.includes(level.toUpperCase())
      ? level.toUpperCase()
      : null;

    const dataWhere = levelFilter ? 'WHERE level = $3' : '';
    const countWhere = levelFilter ? 'WHERE level = $1' : '';
    const dataParams = levelFilter
      ? [limitNum, offsetNum, levelFilter]
      : [limitNum, offsetNum];

    const [countResult, dataResult] = await Promise.all([
      query(
        `SELECT COUNT(*) AS total FROM app_log ${countWhere}`,
        levelFilter ? [levelFilter] : []
      ),
      query(
        `SELECT id, ts, level, source, message, details, entity, entity_id
         FROM app_log
         ${dataWhere}
         ORDER BY ts DESC, id DESC
         LIMIT $1 OFFSET $2`,
        dataParams
      ),
    ]);

    // Also return counts per level for the filter badges.
    // If 'since' is provided (ISO timestamp), count only entries newer than that
    // so the frontend can show an "unread since last view" badge.
    const since = req.query.since || null;
    const sinceDate = since && !isNaN(new Date(since).getTime()) ? since : null;
    const levelCounts = await query(
      sinceDate
        ? `SELECT level, COUNT(*)::int AS count FROM app_log WHERE ts > $1 GROUP BY level`
        : `SELECT level, COUNT(*)::int AS count FROM app_log GROUP BY level`,
      sinceDate ? [sinceDate] : []
    );
    const counts = { ERROR: 0, WARN: 0, INFO: 0 };
    for (const row of levelCounts.rows) {
      counts[row.level] = row.count;
    }

    res.json({
      data: dataResult.rows,
      total: parseInt(countResult.rows[0].total, 10),
      counts,
      limit: limitNum,
      offset: offsetNum,
    });
  } catch (err) {
    console.error('GET /api/logs/system error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// GET /api/logs/llm?limit=100&before=<iso>  — Token-/Cost-Log (jüngste zuerst)
router.get('/llm', async (req, res) => {
  const limitNum = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
  const before = req.query.before ? new Date(req.query.before) : null;
  try {
    const params = [];
    let where = '';
    if (before && !isNaN(before.getTime())) {
      params.push(before.toISOString());
      where = `WHERE ts < $${params.length}`;
    }
    params.push(limitNum);
    const r = await query(
      `SELECT id, ts, username, kategorie, provider, model,
              tokens_in, tokens_out, cache_creation_tokens, cache_read_tokens,
              cost_usd, cost_usd_notional, duration_ms,
              success, error_message, entity, entity_id, correlation_id
         FROM llm_call_log
         ${where}
        ORDER BY ts DESC, id DESC
        LIMIT $${params.length}`,
      params,
    );
    res.json({ items: r.rows, count: r.rows.length });
  } catch (err) {
    console.error('GET /api/logs/llm error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// GET /api/logs/llm/stats  — Summen 24h/7d/30d/total + Aufschlüsselung pro Kategorie
router.get('/llm/stats', async (req, res) => {
  try {
    // Abo (Pauschaltarif) und API getrennt aggregieren statt das Abo wegzulassen:
    // GROUP BY auf das is_abo-Flag liefert je eine Zeile für API- und Abo-Calls.
    // So lassen sich beide im UI nebeneinander zeigen, ohne die API-Zahlen mit
    // den (nicht vergleichbaren) Abo-Token zu vermischen.
    const r = await query(
      `SELECT
         (provider = 'subscription') AS is_abo,

         COUNT(*) FILTER (WHERE ts >= now() - INTERVAL '1 day')   AS calls_24h,
         COUNT(*) FILTER (WHERE ts >= now() - INTERVAL '7 days')  AS calls_7d,
         COUNT(*) FILTER (WHERE ts >= now() - INTERVAL '30 days') AS calls_30d,
         COUNT(*)                                                 AS calls_total,

         COALESCE(SUM(tokens_in)  FILTER (WHERE ts >= now() - INTERVAL '1 day'),   0) AS tokens_in_24h,
         COALESCE(SUM(tokens_out) FILTER (WHERE ts >= now() - INTERVAL '1 day'),   0) AS tokens_out_24h,
         COALESCE(SUM(cache_creation_tokens) FILTER (WHERE ts >= now() - INTERVAL '1 day'),   0) AS cache_write_24h,
         COALESCE(SUM(cache_read_tokens)     FILTER (WHERE ts >= now() - INTERVAL '1 day'),   0) AS cache_read_24h,
         COALESCE(SUM(cost_usd)   FILTER (WHERE ts >= now() - INTERVAL '1 day'),   0) AS cost_24h,
         COALESCE(SUM(cost_usd_notional) FILTER (WHERE ts >= now() - INTERVAL '1 day'),   0) AS cost_notional_24h,

         COALESCE(SUM(tokens_in)  FILTER (WHERE ts >= now() - INTERVAL '7 days'),  0) AS tokens_in_7d,
         COALESCE(SUM(tokens_out) FILTER (WHERE ts >= now() - INTERVAL '7 days'),  0) AS tokens_out_7d,
         COALESCE(SUM(cache_creation_tokens) FILTER (WHERE ts >= now() - INTERVAL '7 days'),  0) AS cache_write_7d,
         COALESCE(SUM(cache_read_tokens)     FILTER (WHERE ts >= now() - INTERVAL '7 days'),  0) AS cache_read_7d,
         COALESCE(SUM(cost_usd)   FILTER (WHERE ts >= now() - INTERVAL '7 days'),  0) AS cost_7d,
         COALESCE(SUM(cost_usd_notional) FILTER (WHERE ts >= now() - INTERVAL '7 days'),  0) AS cost_notional_7d,

         COALESCE(SUM(tokens_in)  FILTER (WHERE ts >= now() - INTERVAL '30 days'), 0) AS tokens_in_30d,
         COALESCE(SUM(tokens_out) FILTER (WHERE ts >= now() - INTERVAL '30 days'), 0) AS tokens_out_30d,
         COALESCE(SUM(cache_creation_tokens) FILTER (WHERE ts >= now() - INTERVAL '30 days'), 0) AS cache_write_30d,
         COALESCE(SUM(cache_read_tokens)     FILTER (WHERE ts >= now() - INTERVAL '30 days'), 0) AS cache_read_30d,
         COALESCE(SUM(cost_usd)   FILTER (WHERE ts >= now() - INTERVAL '30 days'), 0) AS cost_30d,
         COALESCE(SUM(cost_usd_notional) FILTER (WHERE ts >= now() - INTERVAL '30 days'), 0) AS cost_notional_30d,

         COALESCE(SUM(tokens_in),  0) AS tokens_in_total,
         COALESCE(SUM(tokens_out), 0) AS tokens_out_total,
         COALESCE(SUM(cache_creation_tokens), 0) AS cache_write_total,
         COALESCE(SUM(cache_read_tokens),     0) AS cache_read_total,
         COALESCE(SUM(cost_usd),   0) AS cost_total,
         COALESCE(SUM(cost_usd_notional), 0) AS cost_notional_total
       FROM llm_call_log
       GROUP BY 1`,
    );

    // Zwei Buckets (api / abo) befüllen. Leere Buckets mit 0 vorbelegen, damit das
    // Frontend nie auf undefined trifft, auch wenn (noch) keine Abo-Calls existieren.
    const PERIODS = ['24h', '7d', '30d', 'total'];
    const FIELDS  = ['calls', 'tokens_in', 'tokens_out', 'cache_write', 'cache_read', 'cost', 'cost_notional'];
    const emptyBucket = () => {
      const o = {};
      for (const p of PERIODS) for (const f of FIELDS) o[`${f}_${p}`] = 0;
      return o;
    };
    const out = { api: emptyBucket(), abo: emptyBucket() };
    for (const row of r.rows) {
      const bucket = row.is_abo ? out.abo : out.api;
      for (const [k, v] of Object.entries(row)) {
        if (k === 'is_abo') continue;
        bucket[k] = v == null ? 0 : Number(v);
      }
    }

    const byCat = await query(
      `SELECT kategorie,
              COUNT(*)                       AS calls,
              COALESCE(SUM(tokens_in),  0)   AS tokens_in,
              COALESCE(SUM(tokens_out), 0)   AS tokens_out,
              COALESCE(SUM(cache_creation_tokens), 0) AS cache_write,
              COALESCE(SUM(cache_read_tokens),     0) AS cache_read,
              COALESCE(SUM(cost_usd),   0)   AS cost
         FROM llm_call_log
        -- Abo ausklammern (siehe oben) — die Kategorie-Aggregate dienen dem Kostenvergleich.
        WHERE provider <> 'subscription'
        GROUP BY kategorie
        ORDER BY cost DESC`,
    );
    out.by_kategorie = byCat.rows.map((row) => ({
      kategorie:   row.kategorie,
      calls:       Number(row.calls),
      tokens_in:   Number(row.tokens_in),
      tokens_out:  Number(row.tokens_out),
      cache_write: Number(row.cache_write),
      cache_read:  Number(row.cache_read),
      cost:        Number(row.cost),
    }));

    // Kosten-Split Dokumentenanalyse ↔ Chat, getrennt nach API/Abo und Zeitraum
    // (für das Ring-Diagramm je Stat-Kachel). API nutzt echte Kosten (cost_usd),
    // Abo die fiktiven Pauschal-Kosten (cost_usd_notional) — konsistent mit den
    // übrigen Abo-Anzeigen oben.
    const bySplit = await query(
      `SELECT
         (provider = 'subscription') AS is_abo,
         (kategorie = 'chat')                           AS is_chat,
         COALESCE(SUM(cost_usd)          FILTER (WHERE ts >= now() - INTERVAL '1 day'),   0) AS cost_24h,
         COALESCE(SUM(cost_usd_notional) FILTER (WHERE ts >= now() - INTERVAL '1 day'),   0) AS cost_notional_24h,
         COALESCE(SUM(cost_usd)          FILTER (WHERE ts >= now() - INTERVAL '7 days'),  0) AS cost_7d,
         COALESCE(SUM(cost_usd_notional) FILTER (WHERE ts >= now() - INTERVAL '7 days'),  0) AS cost_notional_7d,
         COALESCE(SUM(cost_usd)          FILTER (WHERE ts >= now() - INTERVAL '30 days'), 0) AS cost_30d,
         COALESCE(SUM(cost_usd_notional) FILTER (WHERE ts >= now() - INTERVAL '30 days'), 0) AS cost_notional_30d,
         COALESCE(SUM(cost_usd),          0) AS cost_total,
         COALESCE(SUM(cost_usd_notional), 0) AS cost_notional_total
       FROM llm_call_log
       GROUP BY 1, 2`,
    );
    const SPLIT_PERIODS = ['24h', '7d', '30d', 'total'];
    const emptySplitBucket = () => {
      const o = {};
      for (const p of SPLIT_PERIODS) o[p] = { doku: 0, chat: 0 };
      return o;
    };
    const costSplit = { api: emptySplitBucket(), abo: emptySplitBucket() };
    for (const row of bySplit.rows) {
      const bucket = row.is_abo ? costSplit.abo : costSplit.api;
      const field = row.is_abo ? 'cost_notional' : 'cost';
      for (const p of SPLIT_PERIODS) {
        const v = Number(row[`${field}_${p}`]) || 0;
        bucket[p][row.is_chat ? 'chat' : 'doku'] += v;
      }
    }
    out.cost_split = costSplit;

    // Modell-Aufschlüsselung behält Abo-Zeilen ABSICHTLICH (eigene provider-Zeile
    // 'subscription'), damit die Abo-Nutzung sichtbar bleibt; das UI stellt sie nur
    // abgeschwächt (opacity) dar. Nur die obigen Cross-Provider-Aggregate klammern Abo aus.
    const byModel = await query(
      `SELECT model, provider,
              COUNT(*)                       AS calls,
              COALESCE(SUM(tokens_in),  0)   AS tokens_in,
              COALESCE(SUM(tokens_out), 0)   AS tokens_out,
              COALESCE(SUM(cache_creation_tokens), 0) AS cache_write,
              COALESCE(SUM(cache_read_tokens),     0) AS cache_read,
              COALESCE(SUM(cost_usd),   0)   AS cost,
              COALESCE(SUM(cost_usd_notional), 0) AS cost_notional
         FROM llm_call_log
        GROUP BY model, provider
        ORDER BY cost DESC, cost_notional DESC`,
    );
    out.by_model = byModel.rows.map((row) => ({
      model:         row.model,
      provider:      row.provider,
      calls:         Number(row.calls),
      tokens_in:     Number(row.tokens_in),
      tokens_out:    Number(row.tokens_out),
      cache_write:   Number(row.cache_write),
      cache_read:    Number(row.cache_read),
      cost:          Number(row.cost),
      cost_notional: Number(row.cost_notional),
    }));

    res.json(out);
  } catch (err) {
    console.error('GET /api/logs/llm/stats error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

export default router;
