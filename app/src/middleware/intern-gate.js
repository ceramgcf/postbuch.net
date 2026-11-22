/**
 * middleware/intern-gate.js – dienstinterne Routen nie über den Web-Proxy
 *
 * `/api/internal/*` und `/api/webhooks/*` rufen ausschließlich Scanner und
 * Cleaner direkt über das Docker-Netz auf (app:3421). Die interne
 * Konfigurationsroute liefert dabei die Dienst-Tokens ohne Anmeldung.
 *
 * nginx sperrt beide Pfade. Darauf allein verlässt sich die App nicht: Express
 * ordnet Routen ohne Rücksicht auf Groß- und Kleinschreibung zu, eine
 * Pfadsperre im Proxy muss das Gleiche tun, und jede künftige Proxy-Regel
 * müsste es wieder tun. Dieses Gate prüft deshalb selbst – mit derselben
 * Schreibweisen-Toleranz wie der Router – und weist jede Anfrage ab, die die
 * Proxy-Header trägt. nginx setzt `X-Real-IP` und `X-Forwarded-For` auf jeder
 * weitergereichten API-Anfrage; ein Client kann sie nicht entfernen. Scanner
 * und Cleaner senden sie nicht.
 */

const INTERN_RE = /^\/api\/(?:internal|webhooks)(?:\/|$)/i;

/** Gehört der Pfad zu den dienstinternen Routen? */
export function istInternerPfad(pfad) {
  return INTERN_RE.test(String(pfad ?? ''));
}

/** Trägt die Anfrage einen Header, den nur der Web-Proxy setzt? */
export function kamUeberWebProxy(req) {
  return Boolean(req.get('X-Real-IP') || req.get('X-Forwarded-For'));
}

export function internGate(req, res, next) {
  if (istInternerPfad(req.path) && kamUeberWebProxy(req)) {
    return res.status(404).json({ error: 'Not found' });
  }
  next();
}
