/**
 * Selbstverwaltung der Zwei-Faktor-Anmeldung (/api/auth/zweiter-faktor).
 *
 * In index.js vor dem globalen Gate, aber mit requireAuth montiert: Auch ein
 * Lesezugriff verwaltet seinen eigenen Faktor, die Write-Protection gilt hier
 * deshalb nicht. Jede Route wirkt ausschließlich auf das Konto der Sitzung.
 * Den zweiten Schritt der Anmeldung selbst behandelt routes/auth.js; die
 * Pflicht für alle setzt der Admin über routes/settings.js.
 */
import { Router } from 'express';
import { timingSafeEqual, createHash } from 'node:crypto';
import { query } from '../db.js';
import { verifyPassword } from '../auth-salt.js';
import * as zweiterFaktor from '../service/zweiter-faktor.js';
import {
  loginRateLimit, registerFailedLogin, clearLoginAttempts, WARN_THRESHOLD,
} from '../middleware/login-rate-limit.js';

const router = Router();

function kontoDerSitzung(req) {
  return zweiterFaktor.kontoAus({
    role: req.session.role, menschId: req.session.menschId, username: req.session.username,
  });
}

// Code- und Passwortprüfungen laufen durch dieselbe Bremse wie der Login.
function bremse(req, res, next) {
  req.loginAttemptIdentity = req.session?.username || '';
  return loginRateLimit(req, res, next);
}

function fehlversuch(req, res, text, gesperrt = 0) {
  if (gesperrt) {
    res.set('Retry-After', String(gesperrt));
    return res.status(429).json({ error: 'Zu viele falsche Codes. Bitte kurz warten.', retryAfterSec: gesperrt });
  }
  const verbleibendeVersuche = registerFailedLogin(req);
  const body = { error: text };
  if (verbleibendeVersuche <= WARN_THRESHOLD) body.verbleibendeVersuche = verbleibendeVersuche;
  return res.status(403).json(body);
}

function gleich(a, b) {
  const ha = createHash('sha256').update(String(a)).digest();
  const hb = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

async function passwortStimmt(req, passwort) {
  if (!passwort) return false;
  if (req.session.role === 'admin') return !!process.env.APP_PASSWORD && gleich(passwort, process.env.APP_PASSWORD);
  const r = await query(
    'SELECT anmeldename, password_hash FROM postbuch.mensch WHERE id = $1 AND loginfaehig = true',
    [req.session.menschId],
  );
  const m = r.rows[0];
  return !!m && verifyPassword(m.anmeldename, passwort, m.password_hash);
}

function fehler(res, err, wo) {
  console.error(`[zweiter-faktor] ${wo}:`, err);
  return res.status(500).json({ error: 'Interner Fehler' });
}

router.get('/', async (req, res) => {
  try {
    res.json(await zweiterFaktor.status(kontoDerSitzung(req)));
  } catch (err) { fehler(res, err, 'Status'); }
});

// Einrichten bzw. Gerät wechseln. Ist schon ein Faktor eingerichtet, muss ein
// gültiger Code (oder Wiederherstellungscode) beweisen, dass er vorliegt.
router.post('/einrichten', bremse, async (req, res) => {
  try {
    const konto = kontoDerSitzung(req);
    if (await zweiterFaktor.hatFaktor(konto)) {
      const ergebnis = await zweiterFaktor.pruefeMitSperre(konto, req.body?.code);
      if (!ergebnis.ok) return fehlversuch(req, res, 'Der Code stimmt nicht.', ergebnis.gesperrt);
      clearLoginAttempts(req);
    }
    res.json(await zweiterFaktor.beginneEinrichtung(req.session, konto));
  } catch (err) { fehler(res, err, 'Einrichten'); }
});

router.post('/bestaetigen', bremse, async (req, res) => {
  try {
    const ergebnis = await zweiterFaktor.schliesseEinrichtungAb(
      req.session, kontoDerSitzung(req), req.body?.code, req.sessionID);
    if (ergebnis.abgelaufen) return res.status(409).json({ error: 'Die Einrichtung ist abgelaufen. Bitte neu beginnen.' });
    if (!ergebnis.ok) return fehlversuch(req, res, 'Der Code stimmt nicht.');
    clearLoginAttempts(req);
    res.json({ wiederherstellungscodes: ergebnis.codes });
  } catch (err) { fehler(res, err, 'Bestätigen'); }
});

router.post('/abschalten', bremse, async (req, res) => {
  try {
    const konto = kontoDerSitzung(req);
    if (await zweiterFaktor.pflichtAktiv()) {
      return res.status(409).json({ error: 'Die Zwei-Faktor-Anmeldung ist für alle Zugänge vorgeschrieben.' });
    }
    if (!(await passwortStimmt(req, req.body?.passwort))) return fehlversuch(req, res, 'Das Passwort stimmt nicht.');
    const ergebnis = await zweiterFaktor.pruefeMitSperre(konto, req.body?.code);
    if (!ergebnis.ok) return fehlversuch(req, res, 'Der Code stimmt nicht.', ergebnis.gesperrt);
    clearLoginAttempts(req);
    await zweiterFaktor.entferne(konto, 'selbst abgeschaltet');
    res.json({ ok: true });
  } catch (err) { fehler(res, err, 'Abschalten'); }
});

router.post('/wiederherstellungscodes', bremse, async (req, res) => {
  try {
    const konto = kontoDerSitzung(req);
    const ergebnis = await zweiterFaktor.pruefeMitSperre(konto, req.body?.code);
    if (!ergebnis.ok) return fehlversuch(req, res, 'Der Code stimmt nicht.', ergebnis.gesperrt);
    clearLoginAttempts(req);
    res.json({ wiederherstellungscodes: await zweiterFaktor.neueWiederherstellungscodes(konto) });
  } catch (err) { fehler(res, err, 'Wiederherstellungscodes'); }
});

export default router;
