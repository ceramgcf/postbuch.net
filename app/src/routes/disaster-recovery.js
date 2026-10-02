/**
 * routes/disaster-recovery.js — REST-API für die Disaster-Recovery-Funktion
 *
 * Endpunkte (alle mit Schreibrechten geschützt durch globalen /api-Auth-Gate):
 *
 *   GET  /api/dr/status              → Fingerprint-Stats (anteilig gehasht)
 *   POST /api/dr/fingerprint-run     → Fingerprint-Sync manuell antriggern
 *   POST /api/dr/recovery/resolve    → Stamm-Pfad/-ID zu OneDrive-Folder auflösen
 *   POST /api/dr/recovery/start      → Recovery-Lauf starten (returns sessionId, jobId)
 *   GET  /api/dr/recovery/:sid       → Aktuellen Session-Stand holen (polled vom UI)
 *   POST /api/dr/recovery/:sid/manual/link    { postid, fileId }
 *   POST /api/dr/recovery/:sid/manual/leave   { postid }
 *   POST /api/dr/recovery/:sid/manual/delete  { postid, confirm: true }
 *   GET  /api/dr/recovery/:sid/extras-search?q=…   → Extras durchsuchen für File-Picker
 */

import { Router } from 'express';
import * as drFingerprint from '../service/dr-fingerprint.js';
import * as drRecovery from '../service/dr-recovery.js';
import { runFingerprintSync } from '../jobs/dr-fingerprint-job.js';
import { istLoeschschutzFehler, loeschschutzAntwort } from '../service/document-delete-protection.js';

const router = Router();

router.get('/status', async (_req, res) => {
  try {
    const stats = await drFingerprint.getFingerprintStats();
    res.json(stats);
  } catch (err) {
    console.error('[dr] /status:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/fingerprint-run', async (_req, res) => {
  try {
    const jobId = await runFingerprintSync('DR-Fingerprint (manuell)');
    if (!jobId) return res.status(409).json({ error: 'Ein Fingerprint-Lauf läuft bereits' });
    res.json({ ok: true, jobId });
  } catch (err) {
    console.error('[dr] /fingerprint-run:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/recovery/resolve', async (req, res) => {
  try {
    const { input } = req.body || {};
    if (!input || !String(input).trim()) {
      return res.status(400).json({ error: 'input fehlt' });
    }
    const r = await drRecovery.resolveRoot(input);
    res.json(r);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/recovery/start', async (req, res) => {
  try {
    const { rootFolderId, rootLabel, backend } = req.body || {};
    if (!rootFolderId) {
      return res.status(400).json({ error: 'rootFolderId fehlt' });
    }
    // backend ist optional — ohne Angabe läuft der Scan gegen die aktive Ablage
    const r = await drRecovery.startRecovery({ rootFolderId, rootLabel, backend });
    res.json(r);
  } catch (err) {
    console.error('[dr] /recovery/start:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/recovery/:sid', async (req, res) => {
  try {
    const sess = await drRecovery.getSession(req.params.sid);
    if (!sess) return res.status(404).json({ error: 'Session nicht gefunden' });
    res.json(sess);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/recovery/:sid/manual/link', async (req, res) => {
  try {
    const { postid, fileId } = req.body || {};
    if (!postid || !fileId) return res.status(400).json({ error: 'postid + fileId erforderlich' });
    const r = await drRecovery.resolveManualLink(req.params.sid, postid, fileId);
    res.json(r);
  } catch (err) {
    console.error('[dr] manual/link:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/recovery/:sid/manual/leave', async (req, res) => {
  try {
    const { postid } = req.body || {};
    if (!postid) return res.status(400).json({ error: 'postid erforderlich' });
    const r = await drRecovery.resolveLeaveUnlinked(req.params.sid, postid);
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/recovery/:sid/manual/delete', async (req, res) => {
  try {
    const { postid, confirm } = req.body || {};
    if (!postid) return res.status(400).json({ error: 'postid erforderlich' });
    if (confirm !== true) return res.status(400).json({ error: 'confirm: true erforderlich' });
    const r = await drRecovery.resolveDeletePostbuchEntry(req.params.sid, postid);
    res.json(r);
  } catch (err) {
    if (istLoeschschutzFehler(err)) return res.status(409).json(loeschschutzAntwort(err));
    if (err.status === 404) return res.status(404).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
});

router.get('/recovery/:sid/extras-search', async (req, res) => {
  try {
    const sess = await drRecovery.getSession(req.params.sid);
    if (!sess) return res.status(404).json({ error: 'Session nicht gefunden' });
    const q = String(req.query.q || '').trim().toLowerCase();
    const extras = Array.isArray(sess.extras) ? sess.extras : (sess.extras || []);
    const filtered = q
      ? extras.filter(f => (f.name || '').toLowerCase().includes(q))
      : extras;
    res.json(filtered.slice(0, 100));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
