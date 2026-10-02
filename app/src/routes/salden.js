import { Router } from 'express';
import { query, getClient } from '../db.js';
import { uiLog } from '../log.js';
import { requireAdmin } from '../middleware/auth.js';
import { loadDynamicSettings } from '../config.js';

const router = Router();

/**
 * Salden-Quellen (freies SQL, ob "statisch" an ein Dokument gebunden oder
 * "dynamisch" über eine Dokumentklasse — beide Typen sind reines Freitext-SQL)
 * sind ein undokumentiertes Experten-Feature und müssen in den Einstellungen
 * bewusst freigeschaltet werden.
 */
async function quellenErlaubt() {
  const settings = await loadDynamicSettings();
  return settings.salden_quellen_aktiv === true;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Execute a read-only SQL statement with safety checks (for saldo_quelle). */
async function executeSaldoSQL(sql) {
  const trimmed = sql.trim();
  if (!/^(SELECT|WITH)\s/i.test(trimmed)) {
    throw new Error('Nur SELECT/WITH-Statements erlaubt');
  }
  if (/;/.test(trimmed.slice(0, -1))) {
    // semicolons in the middle = multiple statements
    throw new Error('Mehrere Statements nicht erlaubt');
  }
  const client = await getClient();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query('SET LOCAL statement_timeout = 5000');
    await client.query("SET LOCAL search_path = postbuch, public");
    const result = await client.query(trimmed.replace(/;$/, ''));
    await client.query('COMMIT');
    return result.rows;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Compute all bookings (manual + SQL-derived) for a saldo. */
async function computeAllBuchungen(saldoId) {
  const [manuelleResult, quellenResult] = await Promise.all([
    query(`SELECT buchung_id, datum, zweck, betrag, saldo_art, created_at,
                  'manuell' AS quelle_typ, NULL::text AS quelle_name, NULL::varchar(7) AS postid
           FROM saldo_buchung_manuell WHERE saldo_id = $1`, [saldoId]),
    query(`SELECT * FROM saldo_quelle WHERE saldo_id = $1`, [saldoId]),
  ]);

  const buchungen = manuelleResult.rows.map(r => ({
    ...r,
    betrag: parseFloat(r.betrag),
  }));

  // Execute each quelle SQL and merge results
  for (const quelle of quellenResult.rows) {
    try {
      const rows = await executeSaldoSQL(quelle.buchungen_sql);
      for (const row of rows) {
        buchungen.push({
          datum: row.datum,
          zweck: row.zweck,
          betrag: parseFloat(row.betrag),
          saldo_art: quelle.saldo_art,
          postid: row.postid || null,
          quelle_typ: quelle.typ,
          quelle_name: quelle.name,
          quelle_id: quelle.quelle_id,
        });
      }
    } catch (err) {
      console.error(`Saldo quelle ${quelle.quelle_id} SQL error:`, err.message);
      // Add an error marker so the UI can show the problem
      buchungen.push({
        datum: null,
        zweck: `⚠ Fehler in Quelle "${quelle.name}": ${err.message}`,
        betrag: 0,
        saldo_art: quelle.saldo_art,
        postid: null,
        quelle_typ: quelle.typ,
        quelle_name: quelle.name,
        quelle_id: quelle.quelle_id,
        error: true,
      });
    }
  }

  // Sort by date DESC (nulls last)
  buchungen.sort((a, b) => {
    if (!a.datum && !b.datum) return 0;
    if (!a.datum) return 1;
    if (!b.datum) return -1;
    return new Date(b.datum) - new Date(a.datum);
  });

  return { buchungen, quellen: quellenResult.rows };
}

/** Compute the numeric saldo value from a list of buchungen. */
function computeSaldoValue(buchungen) {
  let total = 0;
  for (const b of buchungen) {
    if (b.error) continue;
    total += b.saldo_art === 'positiv' ? b.betrag : -b.betrag;
  }
  return Math.round(total * 100) / 100;
}

// ── POST /api/salden/test-sql — Test arbitrary SQL (for creation form) ──────
// MUST be before /:id routes to avoid matching 'test-sql' as :id
router.post('/test-sql', requireAdmin, async (req, res) => {
  try {
    const { sql } = req.body;
    if (!sql || !sql.trim()) {
      return res.status(400).json({ error: 'SQL-Statement ist erforderlich' });
    }

    const rows = await executeSaldoSQL(sql);
    res.json({ data: rows.slice(0, 50), count: rows.length });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── GET /api/salden — Overview (non-invisible salden with current balance + last 2 bookings) ──
router.get('/', async (req, res) => {
  try {
    const showAll = req.query.all === 'true';
    const condition = showAll ? '' : 'WHERE invisible = FALSE';
    const saldenResult = await query(`SELECT * FROM saldo ${condition} ORDER BY updated_at DESC`);

    const data = [];
    for (const saldo of saldenResult.rows) {
      const { buchungen } = await computeAllBuchungen(saldo.saldo_id);
      const aktueller_saldo = computeSaldoValue(buchungen);
      const letzte_buchungen = buchungen
        .filter(b => !b.error)
        .slice(0, 5);

      data.push({
        ...saldo,
        aktueller_saldo,
        anzahl_buchungen: buchungen.filter(b => !b.error).length,
        letzte_buchungen,
      });
    }

    res.json({ data });
  } catch (err) {
    console.error('GET /api/salden error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// ── GET /api/salden/:id — Detail with all bookings ──────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const saldoId = parseInt(req.params.id, 10);
    if (!Number.isFinite(saldoId)) {
      return res.status(400).json({ error: 'Ungültige Saldo-ID' });
    }

    const saldoResult = await query(`SELECT * FROM saldo WHERE saldo_id = $1`, [saldoId]);
    if (saldoResult.rows.length === 0) {
      return res.status(404).json({ error: 'Saldo nicht gefunden' });
    }

    const saldo = saldoResult.rows[0];
    const { buchungen, quellen } = await computeAllBuchungen(saldoId);
    const aktueller_saldo = computeSaldoValue(buchungen);

    res.json({
      saldo: { ...saldo, aktueller_saldo },
      quellen,
      buchungen,
    });
  } catch (err) {
    console.error('GET /api/salden/:id error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// ── POST /api/salden — Create new saldo ─────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const { name, beschreibung } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Name ist erforderlich' });
    }

    const result = await query(
      `INSERT INTO saldo (name, beschreibung) VALUES ($1, $2) RETURNING *`,
      [name.trim(), beschreibung || null]
    );

    res.status(201).json(result.rows[0]);
    uiLog('CREATE', 'saldo', String(result.rows[0].saldo_id), `name: ${name.trim().slice(0, 80)}`);
  } catch (err) {
    console.error('POST /api/salden error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// ── PATCH /api/salden/:id — Update saldo metadata ──────────────────────────
router.patch('/:id', async (req, res) => {
  try {
    const saldoId = parseInt(req.params.id, 10);
    if (!Number.isFinite(saldoId)) {
      return res.status(400).json({ error: 'Ungültige Saldo-ID' });
    }

    const allowedFields = ['name', 'beschreibung'];
    const updates = [];
    const params = [];
    let idx = 1;

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates.push(`${field} = $${idx}`);
        params.push(req.body[field]);
        idx++;
      }
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'Keine aktualisierbaren Felder angegeben' });
    }

    params.push(saldoId);
    const result = await query(
      `UPDATE saldo SET ${updates.join(', ')} WHERE saldo_id = $${idx} RETURNING *`,
      params
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Saldo nicht gefunden' });
    }

    res.json(result.rows[0]);
    uiLog('UPDATE', 'saldo', String(saldoId), `fields: ${Object.keys(req.body).join(', ')}`);
  } catch (err) {
    console.error('PATCH /api/salden/:id error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// ── DELETE /api/salden/:id — Soft-delete (set invisible) ────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const saldoId = parseInt(req.params.id, 10);
    if (!Number.isFinite(saldoId)) {
      return res.status(400).json({ error: 'Ungültige Saldo-ID' });
    }

    const result = await query(
      `UPDATE saldo SET invisible = TRUE WHERE saldo_id = $1 RETURNING saldo_id`,
      [saldoId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Saldo nicht gefunden' });
    }

    res.json({ success: true, saldo_id: saldoId });
    uiLog('DELETE', 'saldo', String(saldoId), 'soft-delete (invisible)');
  } catch (err) {
    console.error('DELETE /api/salden/:id error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// ── POST /api/salden/:id/buchungen — Add manual booking ─────────────────────
router.post('/:id/buchungen', async (req, res) => {
  try {
    const saldoId = parseInt(req.params.id, 10);
    if (!Number.isFinite(saldoId)) {
      return res.status(400).json({ error: 'Ungültige Saldo-ID' });
    }

    const { datum, zweck, betrag, saldo_art } = req.body;
    if (!datum) return res.status(400).json({ error: 'Datum ist erforderlich' });
    if (!zweck || !zweck.trim()) return res.status(400).json({ error: 'Zweck ist erforderlich' });
    if (betrag == null || isNaN(parseFloat(betrag))) return res.status(400).json({ error: 'Betrag ist erforderlich' });
    if (!['positiv', 'negativ'].includes(saldo_art)) return res.status(400).json({ error: 'Saldo-Art muss positiv oder negativ sein' });

    // Verify saldo exists
    const saldoCheck = await query(`SELECT saldo_id FROM saldo WHERE saldo_id = $1`, [saldoId]);
    if (saldoCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Saldo nicht gefunden' });
    }

    const result = await query(
      `INSERT INTO saldo_buchung_manuell (saldo_id, datum, zweck, betrag, saldo_art)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [saldoId, datum, zweck.trim(), parseFloat(betrag), saldo_art]
    );

    res.status(201).json(result.rows[0]);
    uiLog('CREATE', 'saldo_buchung', String(result.rows[0].buchung_id),
      `saldo ${saldoId}: ${zweck.trim().slice(0, 60)} ${betrag}`);
  } catch (err) {
    console.error('POST /api/salden/:id/buchungen error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// ── PATCH /api/salden/:id/buchungen/:buchungId — Edit manual booking (within 24h) ──
router.patch('/:id/buchungen/:buchungId', async (req, res) => {
  try {
    const saldoId = parseInt(req.params.id, 10);
    const buchungId = parseInt(req.params.buchungId, 10);
    if (!Number.isFinite(saldoId) || !Number.isFinite(buchungId)) {
      return res.status(400).json({ error: 'Ungültige IDs' });
    }

    // Check 24h window
    const existing = await query(
      `SELECT * FROM saldo_buchung_manuell WHERE buchung_id = $1 AND saldo_id = $2`,
      [buchungId, saldoId]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Buchung nicht gefunden' });
    }
    const ageMs = Date.now() - new Date(existing.rows[0].created_at).getTime();
    if (ageMs > 24 * 60 * 60 * 1000) {
      return res.status(403).json({ error: 'Buchung kann nur innerhalb von 24 Stunden bearbeitet werden' });
    }

    const allowedFields = ['datum', 'zweck', 'betrag', 'saldo_art'];
    const updates = [];
    const params = [];
    let idx = 1;

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        if (field === 'saldo_art' && !['positiv', 'negativ'].includes(req.body[field])) {
          return res.status(400).json({ error: 'Saldo-Art muss positiv oder negativ sein' });
        }
        if (field === 'betrag') {
          updates.push(`${field} = $${idx}`);
          params.push(parseFloat(req.body[field]));
        } else {
          updates.push(`${field} = $${idx}`);
          params.push(req.body[field]);
        }
        idx++;
      }
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'Keine aktualisierbaren Felder angegeben' });
    }

    params.push(buchungId, saldoId);
    const result = await query(
      `UPDATE saldo_buchung_manuell SET ${updates.join(', ')}
       WHERE buchung_id = $${idx} AND saldo_id = $${idx + 1} RETURNING *`,
      params
    );

    res.json(result.rows[0]);
    uiLog('UPDATE', 'saldo_buchung', String(buchungId), `saldo ${saldoId}`);
  } catch (err) {
    console.error('PATCH /api/salden/:id/buchungen/:buchungId error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// ── DELETE /api/salden/:id/buchungen/:buchungId — Delete manual booking (within 24h) ──
router.delete('/:id/buchungen/:buchungId', async (req, res) => {
  try {
    const saldoId = parseInt(req.params.id, 10);
    const buchungId = parseInt(req.params.buchungId, 10);
    if (!Number.isFinite(saldoId) || !Number.isFinite(buchungId)) {
      return res.status(400).json({ error: 'Ungültige IDs' });
    }

    const existing = await query(
      `SELECT * FROM saldo_buchung_manuell WHERE buchung_id = $1 AND saldo_id = $2`,
      [buchungId, saldoId]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Buchung nicht gefunden' });
    }
    const ageMs = Date.now() - new Date(existing.rows[0].created_at).getTime();
    if (ageMs > 24 * 60 * 60 * 1000) {
      return res.status(403).json({ error: 'Buchung kann nur innerhalb von 24 Stunden gelöscht werden' });
    }

    await query(
      `DELETE FROM saldo_buchung_manuell WHERE buchung_id = $1 AND saldo_id = $2`,
      [buchungId, saldoId]
    );

    res.json({ success: true });
    uiLog('DELETE', 'saldo_buchung', String(buchungId), `saldo ${saldoId}`);
  } catch (err) {
    console.error('DELETE /api/salden/:id/buchungen/:buchungId error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// ── POST /api/salden/:id/quellen — Add SQL source ──────────────────────────
router.post('/:id/quellen', requireAdmin, async (req, res) => {
  try {
    const saldoId = parseInt(req.params.id, 10);
    if (!Number.isFinite(saldoId)) {
      return res.status(400).json({ error: 'Ungültige Saldo-ID' });
    }

    const { typ, name, beschreibung, buchungen_sql, saldo_art, postid } = req.body;
    const effektiverTyp = typ ?? 'dynamisch';
    if (!['statisch', 'dynamisch'].includes(effektiverTyp)) {
      return res.status(400).json({ error: 'Typ muss statisch oder dynamisch sein' });
    }
    if (!(await quellenErlaubt())) {
      return res.status(403).json({ error: 'Salden-Quellen sind deaktiviert (Einstellungen → Allgemein)' });
    }
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name ist erforderlich' });
    if (!buchungen_sql || !buchungen_sql.trim()) return res.status(400).json({ error: 'SQL-Statement ist erforderlich' });
    if (!['positiv', 'negativ'].includes(saldo_art)) {
      return res.status(400).json({ error: 'Saldo-Art muss positiv oder negativ sein' });
    }

    // Validate SQL by executing it
    try {
      await executeSaldoSQL(buchungen_sql);
    } catch (err) {
      return res.status(400).json({ error: `SQL-Validierung fehlgeschlagen: ${err.message}` });
    }

    const result = await query(
      `INSERT INTO saldo_quelle (saldo_id, typ, name, beschreibung, buchungen_sql, saldo_art, postid)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [saldoId, effektiverTyp, name.trim(), beschreibung || null, buchungen_sql.trim(), saldo_art, postid || null]
    );

    res.status(201).json(result.rows[0]);
    uiLog('CREATE', 'saldo_quelle', String(result.rows[0].quelle_id),
      `saldo ${saldoId}: ${name.trim().slice(0, 60)} (${effektiverTyp})`);
  } catch (err) {
    console.error('POST /api/salden/:id/quellen error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// ── PATCH /api/salden/:id/quellen/:quelleId — Update SQL source ─────────────
router.patch('/:id/quellen/:quelleId', requireAdmin, async (req, res) => {
  try {
    const saldoId = parseInt(req.params.id, 10);
    const quelleId = parseInt(req.params.quelleId, 10);
    if (!Number.isFinite(saldoId) || !Number.isFinite(quelleId)) {
      return res.status(400).json({ error: 'Ungültige IDs' });
    }

    const bestehend = await query(`SELECT typ FROM saldo_quelle WHERE quelle_id = $1 AND saldo_id = $2`, [quelleId, saldoId]);
    if (bestehend.rows.length === 0) {
      return res.status(404).json({ error: 'Quelle nicht gefunden' });
    }
    if (!(await quellenErlaubt())) {
      return res.status(403).json({ error: 'Salden-Quellen sind deaktiviert (Einstellungen → Allgemein)' });
    }

    const allowedFields = ['typ', 'name', 'beschreibung', 'buchungen_sql', 'saldo_art', 'postid'];
    const updates = [];
    const params = [];
    let idx = 1;

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        if (field === 'typ' && !['statisch', 'dynamisch'].includes(req.body[field])) {
          return res.status(400).json({ error: 'Typ muss statisch oder dynamisch sein' });
        }
        if (field === 'saldo_art' && !['positiv', 'negativ'].includes(req.body[field])) {
          return res.status(400).json({ error: 'Saldo-Art muss positiv oder negativ sein' });
        }
        updates.push(`${field} = $${idx}`);
        params.push(req.body[field]);
        idx++;
      }
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'Keine aktualisierbaren Felder angegeben' });
    }

    // Validate SQL if it's being changed
    if (req.body.buchungen_sql) {
      try {
        await executeSaldoSQL(req.body.buchungen_sql);
      } catch (err) {
        return res.status(400).json({ error: `SQL-Validierung fehlgeschlagen: ${err.message}` });
      }
    }

    params.push(quelleId, saldoId);
    const result = await query(
      `UPDATE saldo_quelle SET ${updates.join(', ')}
       WHERE quelle_id = $${idx} AND saldo_id = $${idx + 1} RETURNING *`,
      params
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Quelle nicht gefunden' });
    }

    res.json(result.rows[0]);
    uiLog('UPDATE', 'saldo_quelle', String(quelleId), `saldo ${saldoId}`);
  } catch (err) {
    console.error('PATCH /api/salden/:id/quellen/:quelleId error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// ── DELETE /api/salden/:id/quellen/:quelleId — Delete SQL source ────────────
router.delete('/:id/quellen/:quelleId', requireAdmin, async (req, res) => {
  try {
    const saldoId = parseInt(req.params.id, 10);
    const quelleId = parseInt(req.params.quelleId, 10);
    if (!Number.isFinite(saldoId) || !Number.isFinite(quelleId)) {
      return res.status(400).json({ error: 'Ungültige IDs' });
    }

    const result = await query(
      `DELETE FROM saldo_quelle WHERE quelle_id = $1 AND saldo_id = $2 RETURNING quelle_id`,
      [quelleId, saldoId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Quelle nicht gefunden' });
    }

    res.json({ success: true });
    uiLog('DELETE', 'saldo_quelle', String(quelleId), `saldo ${saldoId}`);
  } catch (err) {
    console.error('DELETE /api/salden/:id/quellen/:quelleId error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// ── POST /api/salden/:id/quellen/:quelleId/test — Test SQL source ───────────
router.post('/:id/quellen/:quelleId/test', requireAdmin, async (req, res) => {
  try {
    const quelleId = parseInt(req.params.quelleId, 10);
    if (!Number.isFinite(quelleId)) {
      return res.status(400).json({ error: 'Ungültige ID' });
    }

    const quelleResult = await query(
      `SELECT * FROM saldo_quelle WHERE quelle_id = $1`,
      [quelleId]
    );
    if (quelleResult.rows.length === 0) {
      return res.status(404).json({ error: 'Quelle nicht gefunden' });
    }

    const rows = await executeSaldoSQL(quelleResult.rows[0].buchungen_sql);
    res.json({ data: rows, count: rows.length });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
