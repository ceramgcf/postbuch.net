export function hasValidSession(req) {
  if (req.session?.authenticated !== true) return false;
  if (req.session.role !== 'admin') return true;
  const expected = req.app?.locals?.adminCredentialFingerprint;
  return !!expected && req.session.adminCredentialFingerprint === expected;
}

export function requireAuth(req, res, next) {
  if (hasValidSession(req)) return next();
  if (req.session?.authenticated) req.session.destroy(() => {});
  res.status(401).json({ error: 'Nicht authentifiziert' });
}

/** Blocks users with role 'lesezugriff' from all write operations. */
export function requireWrite(req, res, next) {
  if (req.session?.role === 'lesezugriff') {
    return res.status(403).json({ error: 'Keine Schreibrechte' });
  }
  next();
}

/** Only the admin (role === 'admin') may access user management routes. */
export function requireAdmin(req, res, next) {
  if (req.session?.role !== 'admin') {
    return res.status(403).json({ error: 'Nur Administratoren erlaubt' });
  }
  next();
}
