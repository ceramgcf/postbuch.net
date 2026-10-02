/**
 * middleware/login-rate-limit.js — Brute-Force-Bremse für den Login
 *
 * 10 Fehlversuche pro 5 Minuten, Schlüssel aus IP + Benutzername. In-Memory
 * reicht: es gibt genau einen App-Container, und ein Neustart darf den Zähler
 * verlieren (er läuft ohnehin nach 5 Minuten ab).
 *
 * Bewusst als kleine Map statt `express-rate-limit`: gefordert sind
 * "verbleibende Versuche" in der 401-Antwort, ein voller Reset nach
 * erfolgreichem Login und `retryAfterSec` in der 429-Antwort. Das ist mit
 * eigener Zählung präziser als über die Store-API der Bibliothek — und kürzer.
 *
 * Hinweis zum IP-Anteil: nginx setzt im /api/-Block X-Forwarded-For per
 * $proxy_add_x_forwarded_for, sodass `trust proxy 1` eine nicht mehr vom Client
 * fälschbare Peer-IP als req.ip liefert. Beim direkten LAN-Zugriff ist das die
 * echte Client-IP; hinter Caddy kommt für alle externen Aufrufe dieselbe
 * Caddy-IP an. Der Benutzername-Anteil trägt also weiterhin die eigentliche
 * Schutzwirkung; das ist für Brute-Force auf ein Konto genau der richtige
 * Schlüssel. Ein echter Client-IP-Durchgriff hinter Caddy wäre eine eigene
 * Änderung an der Proxy-Kette (trust proxy 2 + Caddy-XFF).
 */

const WINDOW_MS    = 5 * 60 * 1000;
const MAX_ATTEMPTS = 10;
// Ab wann das Frontend "Noch X Versuche" anzeigt — im Normalbetrieb (1–2 Vertipper)
// soll kein Hinweis erscheinen.
export const WARN_THRESHOLD = 3;

/** key → { count, firstAt } */
const attempts = new Map();

function keyOf(req) {
  const user = String(req.loginAttemptIdentity ?? req.body?.username ?? '').trim().toLowerCase();
  return `${req.ip}|${user}`;
}

/** Entfernt abgelaufene Einträge (verhindert unbegrenztes Wachstum). */
function sweep(now) {
  for (const [k, e] of attempts) {
    if (now - e.firstAt >= WINDOW_MS) attempts.delete(k);
  }
}

/**
 * Blockt weitere Login-Versuche, sobald das Limit erreicht ist.
 * Hängt den Schlüssel als `req.loginAttemptKey` an, damit die Route danach
 * `registerFailedLogin` / `clearLoginAttempts` aufrufen kann.
 */
export function loginRateLimit(req, res, next) {
  const now = Date.now();
  if (attempts.size > 500) sweep(now);

  const key = keyOf(req);
  const entry = attempts.get(key);

  if (entry && now - entry.firstAt >= WINDOW_MS) {
    attempts.delete(key);
  } else if (entry && entry.count >= MAX_ATTEMPTS) {
    const retryAfterSec = Math.max(1, Math.ceil((entry.firstAt + WINDOW_MS - now) / 1000));
    res.set('Retry-After', String(retryAfterSec));
    return res.status(429).json({
      error: 'Zu viele Fehlversuche. Bitte kurz warten.',
      retryAfterSec,
    });
  }

  req.loginAttemptKey = key;
  next();
}

/**
 * Zählt einen Fehlversuch und liefert die Zahl der verbleibenden Versuche.
 * @returns {number}
 */
export function registerFailedLogin(req) {
  const key = req.loginAttemptKey ?? keyOf(req);
  const now = Date.now();
  const entry = attempts.get(key);

  if (!entry || now - entry.firstAt >= WINDOW_MS) {
    attempts.set(key, { count: 1, firstAt: now });
    return MAX_ATTEMPTS - 1;
  }

  entry.count += 1;
  return Math.max(0, MAX_ATTEMPTS - entry.count);
}

/** Erfolgreicher Login: Zähler vollständig zurücksetzen. */
export function clearLoginAttempts(req) {
  attempts.delete(req.loginAttemptKey ?? keyOf(req));
}

/** Nur für Tests/Diagnose. */
export function _attemptCount(key) {
  return attempts.get(key)?.count ?? 0;
}
