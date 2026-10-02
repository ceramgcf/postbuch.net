/**
 * middleware/mcp-auth.js — Bearer-Auth für den MCP-Adapter
 *
 * Zweiter, eigenständiger Auth-Adapter (neben der Session-Auth) — bewusst VOR
 * dem globalen requireAuth-/CSRF-/Write-Protection-Gate montiert (index.js),
 * analog zu /api/webhooks. Der MCP-Adapter setzt seine Rollen-/Read-only-Logik
 * selbst durch (runChatAgent mit writeEnabled=false).
 *
 * Prinzipal wird NICHT in req.session, sondern in req.mcp = { username, role }
 * abgelegt (stateless, kein Cookie).
 *
 * Sicherheit:
 *   - Nur SHA256(token) wird verglichen; der Klartext liegt nie in der DB.
 *   - Rolle wird bei JEDEM Request frisch aufgelöst (admin-Sonderfall ODER
 *     Lookup in postbuch.mensch) → Löschen/Deaktivieren wirkt sofort.
 *   - Abgelaufene (expires_at) oder deaktivierte (active=false) Tokens → 401.
 */

import { createHash } from 'crypto';
import { query } from '../db.js';

const ADMIN_USERNAME = 'admin';

function unauthorized(res, msg = 'Ungültiges oder fehlendes Bearer-Token') {
  res.setHeader('WWW-Authenticate', 'Bearer realm="postbuch-mcp"');
  return res.status(401).json({
    jsonrpc: '2.0',
    error: { code: -32001, message: msg },
    id: null,
  });
}

export async function requireBearer(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const m = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (!m) return unauthorized(res);
    const token = m[1].trim();
    if (!token) return unauthorized(res);

    const tokenHash = createHash('sha256').update(token).digest('hex');

    const r = await query(
      `SELECT id, username, mensch_id, expires_at
         FROM postbuch.mcp_tokens
        WHERE token_hash = $1 AND active = true`,
      [tokenHash],
    );
    if (r.rows.length === 0) return unauthorized(res);

    const row = r.rows[0];
    if (row.expires_at && new Date(row.expires_at) < new Date()) {
      return unauthorized(res, 'Bearer-Token abgelaufen');
    }

    // Rolle frisch auflösen. „admin" ist ENV-basiert und nicht in users →
    // Sonderfall. Jeder andere Prinzipal muss aktuell in users existieren,
    // sonst gilt das Token als widerrufen.
    let role;
    if (row.username === ADMIN_USERNAME) {
      role = 'admin';
    } else {
      const u = await query(
        `SELECT rolle AS role, lesebereich FROM postbuch.mensch
          WHERE id = $1 AND anmeldename = $2 AND loginfaehig = true AND aktiv = true`,
        [row.mensch_id, row.username],
      );
      if (u.rows.length === 0) return unauthorized(res, 'Zugehöriger Benutzer existiert nicht mehr');
      // Ein auf eigene Dokumente beschränkter Lesezugriff hat keinen MCP-Zugang:
      // Assistent und Werkzeuge sehen den ganzen Bestand.
      if (u.rows[0].lesebereich !== 'alle') return unauthorized(res, 'Kein MCP-Zugang für eingeschränkten Lesebereich');
      role = u.rows[0].role;
    }

    // last_used_at aktualisieren (fire-and-forget — darf den Request nicht blocken).
    query(`UPDATE postbuch.mcp_tokens SET last_used_at = now() WHERE id = $1`, [row.id])
      .catch(() => { /* Telemetrie-Update, Fehler ignorieren */ });

    req.mcp = { username: row.username, menschId: row.mensch_id, role, tokenId: row.id };
    next();
  } catch (err) {
    console.error('[mcp-auth] Fehler:', err.message);
    return res.status(500).json({
      jsonrpc: '2.0',
      error: { code: -32603, message: 'Interner Fehler bei der Authentifizierung' },
      id: null,
    });
  }
}
