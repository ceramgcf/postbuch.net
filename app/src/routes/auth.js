import { Router } from 'express';
import { query, getClient } from '../db.js';
import { verifyPassword, hashPassword, needsPasswordRehash } from '../auth-salt.js';
import { loadDynamicSettings } from '../config.js';
import { requireAuth, hasValidSession } from '../middleware/auth.js';
import { revokeUserAccess } from '../service/session-revocation.js';
import {
  loginRateLimit,
  registerFailedLogin,
  clearLoginAttempts,
  WARN_THRESHOLD,
} from '../middleware/login-rate-limit.js';

const router = Router();
const ADMIN_USERNAME = 'admin';

/**
 * Einheitliche 401-Antwort für jeden Fehlversuch. Zählt den Versuch und gibt die
 * verbleibende Zahl nur mit, wenn es knapp wird — im Normalbetrieb soll das
 * Login-Formular keinen Zähler zeigen.
 */
function loginFailed(req, res) {
  const verbleibendeVersuche = registerFailedLogin(req);
  const body = { error: 'Falscher Benutzername oder Passwort' };
  if (verbleibendeVersuche <= WARN_THRESHOLD) body.verbleibendeVersuche = verbleibendeVersuche;
  return res.status(401).json(body);
}

function loginSuccess(req, res, username, role, menschId = null) {
  req.session.regenerate((regenerateErr) => {
    if (regenerateErr) {
      console.error('Session regeneration failed:', regenerateErr);
      return res.status(500).json({ error: 'Interner Fehler' });
    }
    req.session.authenticated = true;
    req.session.username = username;
    req.session.role = role;
    if (menschId) req.session.menschId = menschId;
    if (role === 'admin') {
      req.session.adminCredentialFingerprint = req.app.locals.adminCredentialFingerprint;
    }
    req.session.save((saveErr) => {
      if (saveErr) {
        console.error('Session save failed:', saveErr);
        return res.status(500).json({ error: 'Interner Fehler' });
      }
      return res.json({ success: true, username, role });
    });
  });
}

router.post('/login', loginRateLimit, async (req, res) => {
  const { password } = req.body;
  // Mobile Tastaturen setzen gern einen Großbuchstaben an den Anfang oder ein
  // Leerzeichen ans Ende; beides soll die Anmeldung nicht scheitern lassen.
  const username = String(req.body.username ?? '').trim();
  if (!username || !password) {
    return res.status(400).json({ error: 'Benutzername und Passwort erforderlich' });
  }

  // --- Admin check (env-based, not stored in DB) ---
  // Wie alle Anmeldenamen ohne Groß-/Kleinschreibung; „admin" ist für
  // DB-Nutzer in jeder Schreibweise reserviert (routes/menschen.js).
  if (username.toLowerCase() === ADMIN_USERNAME) {
    if (password !== process.env.APP_PASSWORD) {
      return loginFailed(req, res);
    }
    clearLoginAttempts(req);
    return loginSuccess(req, res, ADMIN_USERNAME, 'admin');
  }

  // --- DB user check ---
  try {
    // Anmeldenamen sind ohne Groß-/Kleinschreibung eindeutig (base_schema.sql,
    // routes/menschen.js) — genauso vergleicht der Login und die Sperre nach
    // Fehlversuchen. Ein exakter Treffer hat Vorrang, falls ein Altbestand
    // doch noch kollidierende Namen enthält. Ab hier gilt ausschließlich der
    // gespeicherte Name (Sitzung, Legacy-Hash, weitere Abfragen).
    const result = await query(
      `SELECT id, anmeldename AS username, password_hash, rolle AS role
         FROM postbuch.mensch
        WHERE lower(anmeldename) = lower($1) AND loginfaehig = true AND aktiv = true
        ORDER BY (anmeldename = $1) DESC
        LIMIT 1`,
      [username],
    );
    if (result.rows.length === 0) {
      return loginFailed(req, res);
    }
    const user = result.rows[0];
    if (!verifyPassword(user.username, password, user.password_hash)) {
      return loginFailed(req, res);
    }
    if (needsPasswordRehash(user.password_hash)) {
      const upgradedHash = hashPassword(user.username, password);
      // Compare-and-Swap: ein paralleler Login darf den Hash nicht doppelt ersetzen.
      await query(
        `UPDATE postbuch.mensch SET password_hash = $3, updated_at = now()
          WHERE id = $1 AND password_hash = $2`,
        [user.id, user.password_hash, upgradedHash],
      );
    }
    clearLoginAttempts(req);
    return loginSuccess(req, res, user.username, user.role, user.id);
  } catch (err) {
    console.error('Login DB error:', err);
    return res.status(500).json({ error: 'Interner Fehler' });
  }
});

function bindAuthenticatedUsername(req, _res, next) {
  req.loginAttemptIdentity = req.session?.username || '';
  next();
}

router.post('/change-password', requireAuth, bindAuthenticatedUsername, loginRateLimit, async (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  const username = req.session.username;

  if (!oldPassword || !newPassword) {
    return res.status(400).json({ error: 'oldPassword und newPassword sind erforderlich' });
  }

  if (String(newPassword).length < 6) {
    return res.status(400).json({ error: 'Neues Passwort muss mindestens 6 Zeichen haben' });
  }

  if (username === ADMIN_USERNAME) {
    return res.status(403).json({ error: 'Admin-Passwort kann nur ueber die .env geaendert werden' });
  }

  try {
    const result = await query(
      `SELECT id, anmeldename AS username, password_hash
         FROM postbuch.mensch
        WHERE anmeldename = $1 AND loginfaehig = true AND aktiv = true`,
      [username],
    );
    if (result.rows.length === 0) {
      return loginFailed(req, res);
    }

    const user = result.rows[0];
    if (!verifyPassword(username, oldPassword, user.password_hash)) {
      return loginFailed(req, res);
    }

    const client = await getClient();
    try {
      await client.query('BEGIN');
      const nextHash = hashPassword(username, newPassword);
      const changed = await client.query(
        `UPDATE postbuch.mensch SET password_hash = $2, updated_at = now()
          WHERE anmeldename = $1 AND loginfaehig = true RETURNING anmeldename`,
        [username, nextHash],
      );
      if (changed.rowCount === 0) throw new Error('Benutzer waehrend Passwortwechsel verschwunden');
      await revokeUserAccess({ menschId: user.id, username }, client.query.bind(client));
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    clearLoginAttempts(req);

    return req.session.destroy((destroyErr) => {
      if (destroyErr) console.error('Session destroy after password change failed:', destroyErr);
      res.clearCookie('connect.sid');
      res.json({ success: true, reauthenticate: true });
    });
  } catch (err) {
    console.error('Change password error:', err);
    return res.status(500).json({ error: 'Interner Fehler' });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

router.get('/check', async (req, res) => {
  if (hasValidSession(req)) {
    // Lesebereich frisch aus der DB: steuert im Frontend die reduzierte
    // Navigation. Durchgesetzt wird er serverseitig (middleware/lesebereich.js).
    let lesebereich = 'alle';
    if (req.session.role === 'lesezugriff') {
      try {
        const r = await query(
          `SELECT lesebereich FROM postbuch.mensch
            WHERE id::text = $1 OR ($1 IS NULL AND anmeldename = $2)`,
          [req.session.menschId ?? null, req.session.username ?? null],
        );
        lesebereich = r.rows[0]?.lesebereich ?? 'eigene';
      } catch {
        lesebereich = 'eigene';
      }
    }
    return res.json({
      authenticated: true,
      username: req.session.username,
      role: req.session.role,
      lesebereich,
    });
  }
  if (req.session?.authenticated) req.session.destroy(() => {});
  res.status(401).json({ authenticated: false });
});

// Public — no auth required, used by LoginPage
router.get('/instance-name', async (req, res) => {
  try {
    const settings = await loadDynamicSettings();
    return res.json({ instanceName: String(settings.instance_name || '') });
  } catch {
    return res.json({ instanceName: '' });
  }
});

export default router;
