import { query } from '../db.js';

/**
 * Widerruft alle Web-Sitzungen eines DB-Nutzers.
 *
 * connect-pg-simple speichert die express-session-Nutzdaten als JSON in
 * postbuch.session.sess. Der Benutzername wird beim Login immer auf der
 * obersten Ebene gesetzt. Der optionale Executor erlaubt es den User-Routen,
 * Passwort-/Rollenänderung und Widerruf in derselben DB-Transaktion auszuführen.
 */
export async function revokeUserSessions(username, executor = query) {
  if (!username) return 0;
  const result = await executor(
    `DELETE FROM postbuch.session
      WHERE sess ->> 'username' = $1`,
    [String(username)],
  );
  return result.rowCount || 0;
}

/**
 * Widerruft Web-Sitzungen und MCP-Tokens atomar mit einer Mensch-/Loginmutation.
 * Der UUID-Pfad ist kanonisch; der Name bleibt während des Rollbackfensters
 * als Fallback für alte Sessions und Tokens erhalten.
 */
export async function revokeUserAccess({ menschId = null, username = null }, executor = query) {
  const sid = await executor(
    `DELETE FROM postbuch.session
      WHERE ($1::uuid IS NOT NULL AND sess ->> 'menschId' = $1::text)
         OR ($2::text IS NOT NULL AND sess ->> 'username' = $2)`,
    [menschId, username],
  );
  const tokens = await executor(
    `UPDATE postbuch.mcp_tokens SET active = false
      WHERE ($1::uuid IS NOT NULL AND mensch_id = $1)
         OR ($2::text IS NOT NULL AND username = $2)`,
    [menschId, username],
  );
  return { sessions: sid.rowCount || 0, tokens: tokens.rowCount || 0 };
}
