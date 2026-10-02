import { Router } from 'express';
import * as jobTracker from '../jobs/tracker.js';
import * as suspensionStore from '../service/suspension-store.js';
import { starteManuellesBackup } from '../jobs/backup.js';
import pool from '../db.js';

const router = Router();
const ADMIN_JOB_TYPES = new Set(['storage-setup', 'storage-relocate', 'storage-selftest', 'storage-migration']);

router.get('/', async (req, res) => {
  try {
    let active = jobTracker.listActive();
    let suspended = await jobTracker.listSuspended();
    let recent = await jobTracker.listRecent();
    if (req.session?.role !== 'admin') {
      active = active.filter((j) => !ADMIN_JOB_TYPES.has(j.type));
      suspended = suspended.filter((j) => !ADMIN_JOB_TYPES.has(j.type));
      recent = recent.filter((j) => !ADMIN_JOB_TYPES.has(j.type));
    }

    // Enrich suspended jobs with suspension details (matchPostid, urls, etc.)
    if (suspended.length > 0) {
      const suspDetails = await suspensionStore.listAll();
      const suspMap = Object.fromEntries(suspDetails.map(s => [s.job_id, s]));
      for (const job of suspended) {
        const s = suspMap[job.id];
        if (!s) continue;
        job.matchPostid = s.match_postid;
        job.matchWeburl = s.match_weburl;
        job.onedriveId = s.storage_id;
        job.onedriveWeburl = s.onedrive_weburl;
        job.reservedPostid = s.reserved_postid;
        job.similarity = Number(s.similarity);
        job.newConfidence = Number(s.new_confidence);
        job.matchConfidence = Number(s.match_confidence);
        job.expiresAt = s.expires_at;
        job.suspBetreff = s.payload?.extractedData?.postbuch?.betreff || null;
      }
    }

    // Suspended jobs appear in the active section so the user sees them prominently.

    // Enrich recent failed/interrupted jobs with failed document info (for retry button)
    const failedRecent = recent.filter(j => j.status === 'failed' || j.status === 'interrupted');
    if (failedRecent.length > 0) {
      const jobIds = failedRecent.map(j => j.id);
      try {
        const failedResult = await pool.query(
          `SELECT source_job_id, storage_id FROM postbuch._failed_documents
           WHERE source_job_id = ANY($1::uuid[])`,
          [jobIds]
        );
        const failedMap = Object.fromEntries(
          failedResult.rows.map(r => [r.source_job_id, r.storage_id])
        );
        for (const job of failedRecent) {
          if (failedMap[job.id]) job.failed_onedrive_id = failedMap[job.id];
        }
      } catch (enrichErr) {
        console.warn('[jobs] Konnte failedOnedriveId nicht anreichern:', enrichErr.message);
      }
    }

    res.json({ active: [...active, ...suspended], recent });
  } catch (err) {
    console.error('[jobs] List error:', err.message);
    res.status(500).json({ error: 'Interner Fehler' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const job = await jobTracker.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job nicht gefunden' });
    if (req.session?.role !== 'admin' && ADMIN_JOB_TYPES.has(job.type)) {
      return res.status(404).json({ error: 'Job nicht gefunden' });
    }
    res.json(job);
  } catch (err) {
    console.error('[jobs] Get error:', err.message);
    res.status(500).json({ error: 'Interner Fehler' });
  }
});

router.post('/:id/cancel', (req, res) => {
  const sichtbar = jobTracker.listActive().find(j => j.id === req.params.id);
  if (req.session?.role !== 'admin' && ADMIN_JOB_TYPES.has(sichtbar?.type)) {
    return res.status(404).json({ error: 'Aktiver Job nicht gefunden' });
  }
  const cancelled = jobTracker.requestCancel(req.params.id);
  if (cancelled) return res.json({ ok: true });

  // Determine why it failed
  const active = jobTracker.listActive().find(j => j.id === req.params.id);
  if (!active) return res.status(404).json({ error: 'Aktiver Job nicht gefunden' });
  return res.status(409).json({ error: 'Job kann nicht abgebrochen werden' });
});

// POST /api/jobs/backup/run — Manuelles Backup auslösen (Admin)
// Altpfad; identisch zu POST /api/backup/manuell und damit ebenfalls eine
// selbst ausgelöste Sicherung nach `_backup/user`.
router.post('/backup/run', (_req, res) => {
  const lauf = starteManuellesBackup();
  res.json({ ok: true, message: 'Backup gestartet (läuft im Hintergrund)', lauf });
});

export default router;
