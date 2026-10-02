import { Router } from 'express';
import { unlockDevFeatures, devFeatureUnlocked } from '../lib/dev-gate.js';
import { appLog } from '../app-log.js';

const router = Router();
const versuche = new Map();
const FENSTER_MS = 15 * 60 * 1000;
const MAX_VERSUCHE = 5;

function rateKey(req) { return `${req.ip || 'unknown'}:${req.session?.username || 'admin'}`; }

router.get('/status', (_req, res) => res.json({ unlocked: devFeatureUnlocked() }));
router.post('/unlock', async (req, res) => {
  const id = rateKey(req);
  const now = Date.now();
  for (const [key, wert] of versuche) {
    if (now - wert.seit > FENSTER_MS) versuche.delete(key);
  }
  if (!versuche.has(id) && versuche.size >= 500) {
    return res.status(429).json({ error: 'Freischaltung derzeit nicht möglich. Bitte später erneut versuchen.' });
  }
  const alt = versuche.get(id);
  const stand = !alt || now - alt.seit > FENSTER_MS ? { seit: now, anzahl: 0 } : alt;
  if (stand.anzahl >= MAX_VERSUCHE) {
    return res.status(429).json({ error: 'Freischaltung derzeit nicht möglich. Bitte später erneut versuchen.' });
  }
  stand.anzahl += 1;
  versuche.set(id, stand);
  const ok = await unlockDevFeatures(req.body?.key);
  await appLog(ok ? 'INFO' : 'WARN', 'dev-gate', ok ? 'Dev-Funktionen freigeschaltet' : 'Dev-Freischaltung abgelehnt', {
    entity: 'settings', entityId: req.session?.username || 'admin',
  });
  if (!ok) return res.status(403).json({ error: 'Freischaltung nicht möglich.' });
  versuche.delete(id);
  return res.json({ unlocked: true });
});
export default router;
