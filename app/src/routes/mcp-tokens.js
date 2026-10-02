/**
 * routes/mcp-tokens.js — Verwaltung der MCP-Bearer-Tokens (pro Nutzer)
 *
 * Mount: /api/mcp-tokens (nur requireAuth in index.js, nach der Write-Protection).
 * Der Prinzipal eines neu erzeugten Tokens ist immer der aktuell eingeloggte
 * Nutzer (req.session.username) — für den ENV-Sonderuser „admin" also „admin",
 * für DB-Nutzer deren Username. Passend zum admin-Sonderfall/User-Lookup in
 * mcp-auth.js, das die Rolle bei jedem MCP-Request frisch auflöst.
 *
 * Zugriff/Scoping:
 *   - Erstellen dürfen nur schreibberechtigte Nutzer; lesezugriff wird bereits
 *     durch die globale Write-Protection (index.js) von POST/DELETE geblockt.
 *   - Jeder sieht/widerruft nur EIGENE Tokens; nur Admin sieht/verwaltet ALLE.
 *
 * Sicherheit:
 *   - Der Klartext-Token wird NUR EINMAL (bei POST) zurückgegeben und danach
 *     nie wieder — gespeichert wird ausschließlich SHA256(token).
 *   - Widerruf über DELETE (active=false) wirkt sofort (mcp-auth prüft active).
 */

import { Router } from 'express';
import { createHash, randomBytes } from 'crypto';
import { query } from '../db.js';
import { appLog } from '../app-log.js';

const router = Router();

// ── GET /api/mcp-tokens ── Liste (nie Klartext) ───────────────────────────────
// Nicht-Admins sehen nur eigene Tokens; Admin sieht alle (Oversight).
router.get('/', async (req, res) => {
  try {
    const isAdmin = req.session?.role === 'admin';
    const r = isAdmin
      ? await query(
          `SELECT id, username, description, created_at, last_used_at, expires_at, active
             FROM postbuch.mcp_tokens
            ORDER BY created_at DESC`,
        )
      : await query(
          `SELECT id, username, description, created_at, last_used_at, expires_at, active
             FROM postbuch.mcp_tokens
            WHERE username = $1
            ORDER BY created_at DESC`,
          [req.session.username],
        );
    res.json(r.rows);
  } catch (err) {
    console.error('[mcp-tokens] GET / Fehler:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/mcp-tokens ── Token erzeugen (Klartext einmalig) ────────────────
// Body: { description?: string, expiresAt?: string (ISO) }
router.post('/', async (req, res) => {
  const { description, expiresAt } = req.body || {};

  if (description !== undefined && description !== null && typeof description !== 'string') {
    return res.status(400).json({ error: '"description" muss ein String sein.' });
  }
  let expires = null;
  if (expiresAt !== undefined && expiresAt !== null && expiresAt !== '') {
    const d = new Date(expiresAt);
    if (Number.isNaN(d.getTime())) {
      return res.status(400).json({ error: '"expiresAt" ist kein gültiges Datum.' });
    }
    expires = d.toISOString();
  }

  try {
    // Format: pb_<43 url-safe chars> (256 Bit Entropie).
    const token = `pb_${randomBytes(32).toString('base64url')}`;
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const username = req.session.username; // Prinzipal = erzeugender Nutzer (admin nur wenn Admin einloggt)
    let menschId = req.session.role === 'admin' ? null : req.session.menschId;
    // Sessions aus der Zeit vor Phase 1A enthalten noch keine UUID. Einmalig
    // serverseitig nachbinden; niemals ein DB-Nutzer-Token ohne mensch_id anlegen.
    if (req.session.role !== 'admin' && !menschId) {
      const mensch = await query(
        `SELECT id FROM postbuch.mensch
          WHERE anmeldename=$1 AND loginfaehig=true AND aktiv=true`,
        [username],
      );
      if (!mensch.rowCount) return res.status(401).json({ error: 'Bitte erneut anmelden.' });
      menschId = mensch.rows[0].id;
      req.session.menschId = menschId;
      await new Promise((resolve, reject) => req.session.save((err) => (err ? reject(err) : resolve())));
    }

    const r = await query(
      `INSERT INTO postbuch.mcp_tokens (username, mensch_id, token_hash, description, expires_at)
       VALUES ($1, $2::uuid, $3, $4, $5::timestamptz)
       RETURNING id, username, description, created_at, last_used_at, expires_at, active`,
      [username, menschId, tokenHash, (description || '').trim() || null, expires],
    );

    appLog('INFO', 'mcp-tokens', `MCP-Token erzeugt (${r.rows[0].description || 'ohne Beschreibung'})`, {
      entity: 'settings', entityId: username,
    });

    // Klartext NUR hier — danach nie wieder abrufbar.
    res.json({ ...r.rows[0], token });
  } catch (err) {
    console.error('[mcp-tokens] POST / Fehler:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/mcp-tokens/:id ── widerrufen (active=false) ───────────────────
// Nicht-Admins dürfen nur eigene Tokens widerrufen (fremdes → kein Match → 404).
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const isAdmin = req.session?.role === 'admin';
    const r = isAdmin
      ? await query(
          `UPDATE postbuch.mcp_tokens SET active = false
            WHERE id = $1
            RETURNING id, description`,
          [id],
        )
      : await query(
          `UPDATE postbuch.mcp_tokens SET active = false
            WHERE id = $1 AND username = $2
            RETURNING id, description`,
          [id, req.session.username],
        );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Token nicht gefunden.' });
    appLog('INFO', 'mcp-tokens', `MCP-Token widerrufen (${r.rows[0].description || r.rows[0].id})`, {
      entity: 'settings', entityId: req.session?.username || null,
    });
    res.json({ ok: true, id: r.rows[0].id });
  } catch (err) {
    console.error('[mcp-tokens] DELETE Fehler:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
