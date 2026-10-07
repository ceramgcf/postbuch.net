import express from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import { createHmac, randomBytes } from 'crypto';
import { requireAuth, requireWrite, requireAdmin } from './middleware/auth.js';
import { lesebereichGate } from './middleware/lesebereich.js';
import { loadDynamicSettings } from './config.js';
import * as jobTracker from './jobs/tracker.js';
import postbuchRouter from './routes/postbuch.js';
import searchRouter from './routes/search.js';
import filesRouter from './routes/files.js';
import statsRouter from './routes/stats.js';
import actionsRouter from './routes/actions.js';
import analyseRouter from './routes/analyse.js';
import authRouter from './routes/auth.js';
import aktenRouter from './routes/akten.js';
import logsRouter from './routes/logs.js';
import saldenRouter from './routes/salden.js';
import menschenRouter from './routes/menschen.js';
import kostentraegerProfileRouter from './routes/kostentraeger-profile.js';
import backupRouter from './routes/backup.js';
import wiedervorlagenRouter from './routes/wiedervorlagen.js';
import jobsRouter from './routes/jobs.js';
import onedriveAuthRouter from './routes/onedrive-auth.js';
import settingsRouter from './routes/settings.js';
import settingsPublicRouter from './routes/settings-public.js';
import webhooksRouter from './routes/webhooks.js';
import abrechnungsperiodeRouter from './routes/abrechnungsperiode.js';
import personenRouter from './routes/personen.js';
import importRouter, { raeumeArchivImportTempAuf } from './routes/import.js';
import exportRouter from './routes/export.js';
import disasterRecoveryRouter from './routes/disaster-recovery.js';
import pushRouter from './routes/push.js';
import setupRestoreRouter from './routes/setup-restore.js';
import verbleibRouter from './routes/verbleib.js';
import chatRouter from './routes/chat.js';
import mcpRouter from './routes/mcp.js';
import mcpTokensRouter from './routes/mcp-tokens.js';
import updatesRouter from './routes/updates.js';
import devUnlockRouter from './routes/dev-unlock.js';
import einrichtungRouter from './routes/einrichtung.js';
import taxonomieRouter from './routes/taxonomie.js';
import scannerTuningRouter from './routes/scanner-tuning.js';
import { requireBearer } from './middleware/mcp-auth.js';
import { startTokenKeepAlive } from './lib/storage/onedrive.js';
import { getActiveBackend } from './lib/storage/index.js';
import { startPolling as startOnedrivePolling } from './service/onedrive-watcher.js';
import { heileAblageWurzel } from './service/storage-setup.js';
import { startBackupJob, backupSchluesseldateiAbgleichen } from './jobs/backup.js';
import { startAbrechnungSessionCleaner, autoAbortExpiredAbrechnungsSessions } from './service/abrechnung-session.js';
import { startFingerprintJob } from './jobs/dr-fingerprint-job.js';
import { startDuplicateTimeoutJob } from './jobs/duplicate-timeout-job.js';
import { startReminderJob } from './jobs/reminder-job.js';
import { startScanRetryJob } from './jobs/scan-retry-job.js';
import { startCacheModeReaper } from './jobs/cache-mode-reaper.js';
import { startPostbuchFeedJob } from './jobs/postbuch-feed-job.js';
import { start as startDiscordGateway } from './lib/discord-gateway.js';
import { setButtonHandler } from './lib/discord-gateway.js';
import { resolveDuplicate } from './service/resolve-duplicate.js';
import * as pipelineQueue from './jobs/pipeline-queue.js';
import pool from './db.js';
import { initializeDevGate } from './lib/dev-gate.js';
import {
  recoverPending as recoverPendingPipelineFiles,
  acknowledgeEbComplete,
} from './service/pipeline-file-journal.js';
import { starteErstattungsbescheidVerarbeitung } from './service/document-inserter.js';
import { startHelpEmbeddingJob } from './service/help-corpus.js';

function recoverPipeline(settings) {
  return recoverPendingPipelineFiles(settings, {
    onEbPending: (postid, journalJobId, { korrekturAnweisung, modelTier } = {}) => {
      starteErstattungsbescheidVerarbeitung(postid, korrekturAnweisung, { modelTier })
        .then(() => acknowledgeEbComplete(journalJobId))
        .catch((err) => console.error(
          `[pipeline-recovery] EB-Fachjob ${postid} bleibt vorgemerkt: ${err.message}`,
        ));
    },
  });
}

// ── Initialize job tracker + load dynamic settings from DB ────────────────────
await jobTracker.init();
raeumeArchivImportTempAuf().catch((err) => {
  console.error('[import] Aufräumen verwaister Archiv-Import-Tempdateien fehlgeschlagen:', err.message);
});
const settings = await loadDynamicSettings();
await initializeDevGate(settings);
// Muss vor Polling/Queue-Start laufen: nach einem harten Prozessabbruch können
// Dateien bereits außerhalb der Inbox liegen, obwohl ihr DB-Insert fehlte.
await recoverPipeline(settings).catch((err) => {
  console.error('[pipeline-recovery] Start-Recovery fehlgeschlagen:', err.message);
});
pipelineQueue.setMaxParallel(settings.pipeline_max_parallel ?? 3);
// ── Sequence-Sync: postbuch_seq auf MAX(postid) heben ─────────────────────────
// Bisher wurden PostIDs in der App per MAX+1 berechnet, sodass die Sequence weit
// hinter den real vergebenen IDs zurückliegen kann. Vor der ersten Pipeline-
// Vergabe heben wir sie auf das Maximum, damit nextval() keine Konflikte erzeugt.
// Wichtig ist dabei das is_called-Flag: Auf einer frischen Instanz ist noch keine
// Nummer vergeben, die Sequence muss unangetastet bei 1 stehen bleiben — sonst
// startet das erste Dokument bei P000002. Angehoben (und damit als vergeben
// markiert) wird nur, wenn es tatsächlich Dokumente gibt bzw. die Sequence schon
// gelaufen ist.
try {
  const seqSync = await pool.query(
    `WITH seq AS (
       SELECT last_value, is_called FROM postbuch.postbuch_seq
     ), vergeben AS (
       SELECT MAX(CAST(SUBSTRING(postid FROM 2) AS INTEGER)) AS max_nr FROM postbuch.postbuch
     )
     SELECT setval('postbuch.postbuch_seq',
       GREATEST(
         CASE WHEN seq.is_called THEN seq.last_value ELSE 1 END,
         COALESCE(vergeben.max_nr, 1)
       ),
       seq.is_called OR vergeben.max_nr IS NOT NULL
     ) AS new_value
     FROM seq, vergeben`
  );
  console.log(`[postbuch_seq] sync: last_value=${seqSync.rows[0].new_value}`);
} catch (err) {
  console.error('[postbuch_seq] sync FAILED:', err.message);
}

const app = express();
app.set('trust proxy', 1); // Korrekte req.protocol & req.ip hinter Caddy/nginx
const PORT = process.env.PORT || 3421;
const hasConfiguredSessionSecret = !!(settings.session_secret || process.env.SESSION_SECRET);
const sessionSecret = settings.session_secret || process.env.SESSION_SECRET || randomBytes(48).toString('hex');
app.locals.adminCredentialFingerprint = createHmac('sha256', sessionSecret)
  .update(String(process.env.APP_PASSWORD || ''), 'utf8')
  .digest('hex');

if (!hasConfiguredSessionSecret) {
  console.warn('[security] SESSION_SECRET fehlt (DB + ENV). Verwende temporäres Laufzeit-Secret bis zur Konfiguration.');
}

// Das globale 100-MB-Limit gibt es für Dokument-Uploads. Der Profil-Import ist
// ein Formular mit höchstens 4000 Zeichen Profiltext — der bekommt sein eigenes,
// kleines Limit. Muss VOR dem globalen Parser stehen: der erste greifende
// json-Parser setzt req._body, jeder weitere überspringt den Body dann.
app.use('/api/kostentraeger-profile', express.json({ limit: '100kb' }));
app.use(express.json({ limit: '100mb' }));

// Sessions in Postgres statt im MemoryStore: überleben `--force-recreate` (hier
// Alltag) und leaken keinen Speicher. Tabelle steht in base_schema.sql, deshalb
// kein createTableIfMissing.
const PgSession = connectPgSimple(session);

app.use(session({
  store: new PgSession({
    pool,
    schemaName: 'postbuch',
    tableName: 'session',
    createTableIfMissing: false,
    pruneSessionInterval: 60 * 15, // abgelaufene Sessions alle 15 Min aufräumen
  }),
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'strict',
    // 'auto' statt hart true: setzt das Secure-Flag genau dann, wenn die Anfrage
    // wirklich über HTTPS kam (via trust proxy + X-Forwarded-Proto von Caddy).
    // Hart true würde den direkten LAN-Zugriff über http://<host>:3420 aussperren.
    secure: 'auto',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 Tage
  },
}));

// Digital Asset Links — PWA-Link-Capturing auf Android Chrome
// Dynamisch: nutzt req.protocol (via trust proxy 1 + X-Forwarded-Proto von Caddy)
app.get('/.well-known/assetlinks.json', (req, res) => {
  const site = `${req.protocol}://${req.hostname}`;
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.json([{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: { namespace: 'web', site },
  }]);
});

// Health check (unprotected)
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Auth routes (unprotected — login/logout/check)
app.use('/api/auth', authRouter);

// OneDrive OAuth callback (unprotected — kommt als Browser-Redirect von Microsoft)
// Sicherheit: CSRF-State-Verifikation in der Route selbst
app.use('/api/onedrive-auth', onedriveAuthRouter);

// Scanner-Webhook (keine Session-Auth — wird vom internen Cleaner-Container gerufen).
// Sicherheit: eigener Token-Check im Router (X-Webhook-Token, timingSafeEqual) plus
// 404-Block in web/nginx.conf. Der frühere Kommentar "nur im internen Docker-Netz
// erreichbar" war falsch — nginx proxied /api/ pauschal an app:3421.
app.use('/api/webhooks', webhooksRouter);

// Interne Config-Route für Scanner + Cleaner (keine Session-Auth).
// Sicherheit: in web/nginx.conf mit 404 geblockt, damit sie nur über das Docker-Netz
// erreichbar ist. Sie verteilt u. a. den webhook_token an den Cleaner.
app.get('/api/internal/config', async (req, res) => {
  try {
    const { loadDynamicSettings } = await import('./config.js');
    const s = await loadDynamicSettings();
    res.json({
      webhook_token: s.webhook_token ?? null,
      scanner: {
        device_url:   s.scanner_device_url   ?? null,
        default_dpi:  s.scanner_default_dpi  ?? 300,
        default_mode: s.scanner_default_mode ?? 'gray',
        has_adf:      s.scanner_has_adf      ?? false,
        supports_a3:  s.scanner_supports_a3  ?? false,
        adf_duplex:   s.scanner_adf_duplex   ?? false,
      },
      cleaner: {
        ocr_enabled:             s.cleaner_ocr_enabled             ?? true,
        ocr_langs:               s.cleaner_ocr_langs               ?? 'deu',
        ocr_jobs:                s.cleaner_ocr_jobs                ?? 1,
        blank_mean_min:          s.cleaner_blank_mean_min          ?? 240,
        blank_stddev_max:        s.cleaner_blank_stddev_max        ?? 12,
        blank_mean_min_single:   s.cleaner_blank_mean_min_single   ?? 253,
        blank_stddev_max_single: s.cleaner_blank_stddev_max_single ?? 4,
        blank_content_threshold: s.cleaner_blank_content_threshold ?? 200,
        blank_mask_max_content_px: s.cleaner_blank_mask_max_content_px ?? 200,
        crop_enabled:            s.cleaner_crop_enabled            ?? true,
        detect_dpi:              s.cleaner_detect_dpi              ?? 75,
        content_threshold:       s.cleaner_content_threshold       ?? 200,
        content_denoise_min_px:  s.cleaner_content_denoise_min_px  ?? 10,
      },
    });
  } catch (err) {
    console.error('[internal/config] Fehler:', err);
    res.status(500).json({ error: err.message });
  }
});
// ── Öffentliche Metadaten-Endpunkte (kein Login nötig) ─────────────────────
app.get('/api/public/scanner-port', (_req, res) => {
  res.json({ port: process.env.SCANNER_PORT || '8080' });
});
// Setup-Restore: nur bei gesetztem Einmal-Flag; Upload zusätzlich mit dem
// aktuellen Adminpasswort geschützt. Die GET-Seite enthält keine Secrets.
app.use('/setup', setupRestoreRouter);

// MCP-Adapter (unprotected gegenüber Session/CSRF — eigene Bearer-Auth).
// Bewusst VOR dem globalen requireAuth-Gate montiert (analog /api/webhooks):
// externe KI-Agenten authentifizieren sich per Bearer-Token, nicht per Cookie.
// Read-only per Konstruktion (runChatAgent writeEnabled=false im Adapter).
app.use('/api/mcp', requireBearer, mcpRouter);

// ── Global auth gate for all remaining /api/* routes ──────────────────────────
app.use('/api', requireAuth);

// ── Eingeschränkter Lesebereich: Positivliste für „nur eigene Dokumente“ ─────
app.use('/api', lesebereichGate);

// ── Write protection: lesezugriff users may not modify any data ───────────────
app.use('/api', (req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && req.session?.role === 'lesezugriff') {
    return res.status(403).json({ error: 'Keine Schreibrechte' });
  }
  next();
});

// ── Protected routes ──────────────────────────────────────────────────────────
app.use('/api/postbuch', postbuchRouter);
app.use('/api/search', searchRouter);
app.use('/api/files', filesRouter);
app.use('/api/stats', statsRouter);
app.use('/api/actions', actionsRouter);
app.use('/api/analyse', analyseRouter);
app.use('/api/akten', aktenRouter);
app.use('/api/logs', logsRouter);
app.use('/api/salden', saldenRouter);
app.use('/api/wiedervorlagen', wiedervorlagenRouter);
app.use('/api/jobs', jobsRouter);
app.use('/api/abrechnungsperiode', abrechnungsperiodeRouter);
app.use('/api/personen', personenRouter);
app.use('/api/verbleib', verbleibRouter);
app.use('/api/import', importRouter);
app.use('/api/export', exportRouter);
app.use('/api/dr', disasterRecoveryRouter);
app.use('/api/taxonomie', taxonomieRouter);

// Push-Benachrichtigungen
app.use('/api/push', pushRouter);

// Büroassistent (Chat)
app.use('/api/chat', chatRouter);

// Settings, die jede Rolle lesen darf (Feld-Whitelist, keine Secrets)
app.use('/api/settings-public', settingsPublicRouter);

// ── Admin-only: Settings, Nutzerverwaltung, Backup ───────────────────────────
// /api/settings enthält API-Keys, OneDrive-Credentials, Discord-Token und den
// Ordner-Umzug. Ohne requireAdmin könnte jeder vollzugriff-Nutzer den LLM-Provider
// umbiegen — d. h. jedes PDF an einen fremden Host schicken.
app.use('/api/settings', requireAdmin, settingsRouter);
app.use('/api/menschen', requireAdmin, menschenRouter);
app.use('/api/kostentraeger-profile', requireAdmin, kostentraegerProfileRouter);
app.use('/api/backup', requireAdmin, backupRouter);
// In-GUI-Updates: admin-only. Ein Update baut den gesamten Stack neu — das ist
// keine Aktion, die ein vollzugriff-Nutzer auslösen darf. Ausgeführt wird es
// ohnehin nie hier, sondern vom unprivilegierten Host-Agenten (siehe Router).
app.use('/api/updates', requireAdmin, updatesRouter);
app.use('/api/dev', requireAdmin, devUnlockRouter);
app.use('/api/einrichtung', requireAdmin, einrichtungRouter);
app.use('/api/scanner-tuning', requireAdmin, scannerTuningRouter);
// MCP-Token-Verwaltung: jeder eingeloggte Nutzer verwaltet eigene Tokens
// (lesezugriff wird durch die Write-Protection oben von POST/DELETE geblockt;
//  Admin sieht/verwaltet zusätzlich alle — Scoping in der Route).
app.use('/api/mcp-tokens', mcpTokensRouter);
// /start ist Admin-only: nur Admins dürfen den OAuth-Flow initiieren
// (callback ist weiter oben als unprotected registriert)

app.listen(PORT, () => {
  console.log(`Postbuch API running on port ${PORT}`);
  // OneDrive Refresh Token niemals ablaufen lassen — nur wenn OneDrive auch
  // das aktive Backend ist, sonst warnt eine reine Nextcloud-Instanz für immer.
  getActiveBackend()
    .then(backend => { if (backend === 'onedrive') startTokenKeepAlive(); })
    .catch(err => console.warn('[index] Aktives Ablage-Backend nicht ermittelbar:', err.message));
  // Pfadgrenze der Ablage mit dem tatsächlich benutzten Wurzelordner
  // abgleichen. Betrifft nur pfadbasierte Backends und korrigiert einen
  // Altbestand, bei dem beide Werte getrennt gepflegt wurden.
  heileAblageWurzel().catch(err => console.warn('[storage] Pfadgrenze nicht abgleichbar:', err.message));
  // OneDrive-Polling starten (falls in _settings aktiviert)
  startOnedrivePolling();
  // Backup-Cron-Job starten (falls in _settings aktiviert)
  startBackupJob();
  backupSchluesseldateiAbgleichen().catch(err => console.warn('[backup] Schlüsseldatei nicht abgleichbar:', err.message));
  // Abgelaufene Abrechnungs-Sessions automatisch aufräumen (alle 15 Minuten).
  // Einmaliger Lauf direkt beim Start deckt den Crash-/Neustart-Fall ab, bei
  // dem eine 'building'-Session ohne funktionierenden Heartbeat zurückbleibt.
  startAbrechnungSessionCleaner();
  autoAbortExpiredAbrechnungsSessions().catch(err => console.warn('[abrechnungsperiode] Auto-Abort beim Start fehlgeschlagen:', err.message));
  // DR-Fingerprint-Job: wöchentlicher Sync + Initial-Population beim ersten Start
  startFingerprintJob();
  // Duplikat-Timeout-Sweeper: löst abgelaufene Suspensions automatisch auf
  startDuplicateTimeoutJob();
  // Erinnerungs-Pushes: täglich Wiedervorlagen + Zahlungsfälligkeiten
  startReminderJob();
  // Scan-Retry: exponentieller Backoff für fehlgeschlagene Phase-0-Uploads (alle 5 Minuten)
  startScanRetryJob();
  // Auch transiente _failed-/Backend-Ausfälle werden ohne weiteren Neustart
  // erneut reconciled. Journalzeilen begrenzen den Lauf auf bekannte Dateien.
  const pipelineRecoveryTimer = setInterval(() => {
    loadDynamicSettings()
      .then(recoverPipeline)
      .catch(err => console.error('[pipeline-recovery] Wiederholung fehlgeschlagen:', err.message));
  }, 5 * 60 * 1000);
  pipelineRecoveryTimer.unref();
  // Cache-Mode: Auto-Reset nach 15 Min Inaktivität (minütlicher Sweep, kosmetisch)
  startCacheModeReaper();
  // Update-Manifest täglich mit Jitter. Der erhaltene Online-Rueckweg fuer
  // Modellempfehlungen ist hart deaktiviert; Empfehlungen kommen aus dem Release.
  startPostbuchFeedJob();
  // Neuinstallation + jeder Containerstart nach einem Release: Version und
  // Dokumentationshash werden idempotent abgeglichen. Ohne einsatzbereiten
  // Embedding-Provider bleibt der Job ausstehend und wird beim Konfigurieren
  // desselben über routes/settings.js erneut angestoßen.
  startHelpEmbeddingJob({ reason: 'app-start' });
  // Discord-Gateway: Button-Interactions für Duplikat-Entscheidungen (nur wenn Bot konfiguriert)
  setButtonHandler(async (jobId, decision, _interactionId, _token, username) => {
    await resolveDuplicate({ jobId, decision, source: `discord:${username}` });
  });
  startDiscordGateway();
});
