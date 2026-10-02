/**
 * routes/backup.js — Backup-Management-Endpunkte (Admin only)
 *
 *   GET  /api/backup/files          → Liste der Backup-Dateien aus der Ablage
 *   GET  /api/backup/settings       → Backup-Konfiguration
 *   PUT  /api/backup/settings       → Backup-Konfiguration aktualisieren
 *   POST /api/backup/manuell        → selbst ausgelöste Sicherung starten
 *   GET  /api/backup/manuell        → Zustand der laufenden/letzten Sicherung
 *   POST /api/backup/restore        → Datenbank aus Backup (Ablage) wiederherstellen
 *   POST /api/backup/restore-upload → Datenbank aus hochgeladener Datei wiederherstellen
 *
 * Vor jedem Restore steht eine Zwangssicherung: Der Client startet sie über
 * /manuell, wartet ihr Ende ab und schickt ihre `vorabSicherungId` mit. Ohne
 * diesen Nachweis antwortet der Restore mit 428 — es sei denn, der Client
 * setzt nach ausdrücklicher Warnung `ohneVorabSicherung: true`. Die Prüfung
 * liegt bewusst hier und nicht nur im UI: ein Restore ist unumkehrbar.
 */

import express, { Router } from 'express';
import { timingSafeEqual, createHash } from 'crypto';
import { writeFile, unlink } from 'fs/promises';
import { gunzip } from 'zlib';
import { promisify } from 'util';
import { loadDynamicSettings, getFolders } from '../config.js';
import db from '../db.js';
import { appLog } from '../app-log.js';
import { getActiveAdapter, getActiveAdapterFor } from '../lib/storage/index.js';
import { startBackupJob, starteManuellesBackup, manuellerBackupStatus, userBackupOrdnerId } from '../jobs/backup.js';
import { appVersion } from '../lib/app-version.js';
import { istNeuer } from '../lib/postbuch-feed.js';
import { atomicPgRestore, adminRestoreCleanupSql } from '../lib/pg-restore.js';
import { isEncryptedBackup } from '../lib/backup-crypto.js';
import {
  verschluesselungsStatus, aktiviere, setzePasswort, deaktiviere,
  gespeichertesPasswort, restoreEntschluesseln, verschluesselungFuerRestore,
} from '../lib/backup-encryption.js';

const router = Router();
const gunzipAsync = promisify(gunzip);

const MIN_BACKUP_PASSWORT_LAENGE = 8;

// Eigenständiges Rate-Limit für den Passwort-Reveal (Step-up): unabhängig von
// der normalen Admin-Session, damit eine gekaperte Session nicht beliebig oft
// gegen APP_PASSWORD raten kann.
const REVEAL_WINDOW_MS = 5 * 60 * 1000;
const REVEAL_MAX_ATTEMPTS = 10;
const revealAttempts = new Map();

// Eigenständiges Rate-Limit für Backup-Passwort-Versuche beim Upload-Restore —
// unabhängig von der Admin-Session, damit der GCM-Auth-Tag nicht zum
// Passwort-Orakel für beliebig viele Versuche wird.
const BACKUP_PW_WINDOW_MS = 5 * 60 * 1000;
const BACKUP_PW_MAX_ATTEMPTS = 10;
const backupPasswortAttempts = new Map();

function backupPasswortRateLimitGreift(req) {
  const key = String(req.ip || 'unknown');
  const now = Date.now();
  const previous = backupPasswortAttempts.get(key);
  if (previous && now - previous.firstAt < BACKUP_PW_WINDOW_MS && previous.count >= BACKUP_PW_MAX_ATTEMPTS) {
    return Math.max(1, Math.ceil((previous.firstAt + BACKUP_PW_WINDOW_MS - now) / 1000));
  }
  if (previous && now - previous.firstAt >= BACKUP_PW_WINDOW_MS) backupPasswortAttempts.delete(key);
  return null;
}

function backupPasswortFehlversuchVermerken(req) {
  const key = String(req.ip || 'unknown');
  const current = backupPasswortAttempts.get(key);
  if (!current) backupPasswortAttempts.set(key, { count: 1, firstAt: Date.now() });
  else current.count += 1;
}

function digest(value) {
  return createHash('sha256').update(String(value ?? ''), 'utf8').digest();
}

function backupIdFromFilename(filename) {
  const match = /^postbuch_(.+?)(?:_v(?:\d{1,3}\.\d{1,3}\.\d{1,3}|unbekannt))?\.pgdump\.gz$/.exec(filename);
  return match?.[1] ?? null;
}

function appVersionFromFilename(filename) {
  const match = /_v(\d{1,3}\.\d{1,3}\.\d{1,3})\.pgdump\.gz$/.exec(filename);
  return match?.[1] ?? null;
}

function istBackupDatei(f) {
  return !f.isFolder && f.name.startsWith('postbuch_') && f.name.endsWith('.pgdump.gz');
}

/**
 * Alle wiederherstellbaren Sicherungen: die automatischen direkt in `_backup`,
 * die selbst ausgelösten aus `_backup/user`. Zweite Ebene wird nur gelesen,
 * nie angelegt.
 */
async function sammleBackupDateien(storage, backupFolderId) {
  const kinder = await storage.listChildren(backupFolderId);
  const dateien = kinder.filter(istBackupDatei).map(f => ({ ...f, manuell: false }));

  const userOrdnerId = await userBackupOrdnerId(storage, backupFolderId);
  if (userOrdnerId) {
    const userKinder = await storage.listChildren(userOrdnerId);
    dateien.push(...userKinder.filter(istBackupDatei).map(f => ({ ...f, manuell: true })));
  }
  return dateien;
}

/**
 * Nachweis der Zwangssicherung. Gültig ist ausschließlich der zuletzt hier
 * gestartete Lauf, und nur wenn er sauber durchgelaufen ist.
 */
function vorabSicherungGeprueft(vorabSicherungId) {
  const lauf = manuellerBackupStatus();
  return !!vorabSicherungId && lauf?.id === vorabSicherungId && lauf.status === 'fertig';
}

function vorabSicherungFehlt(req, res) {
  const { vorabSicherungId, ohneVorabSicherung } = req.body ?? {};
  if (vorabSicherungGeprueft(vorabSicherungId)) return false;
  if (ohneVorabSicherung === true) {
    appLog('WARN', 'backup', 'Restore ohne erfolgreiche Zwangssicherung — bewusst bestätigt', {
      entity: 'backup',
      entityId: req.session?.username || null,
    });
    return false;
  }
  res.status(428).json({
    error: 'Vor dem Wiederherstellen muss eine Sicherung des aktuellen Standes durchgelaufen sein.',
    code: 'VORAB_SICHERUNG_ERFORDERLICH',
  });
  return true;
}

// ── GET /api/backup/files ─────────────────────────────────────────────────────
// Gibt alle .pgdump.gz-Backups aus dem konfigurierten Backup-Ordner der Ablage zurück,
// sortiert nach Erstellungsdatum (neueste zuerst).

router.get('/files', async (req, res) => {
  try {
    const settings = await loadDynamicSettings();
    const backupFolderId = getFolders(settings).backup;

    if (!backupFolderId) {
      return res.status(404).json({ error: 'Backup-Ordner nicht konfiguriert (storage_folders.<backend>.backup)' });
    }

    const backupFiles = (await sammleBackupDateien(getActiveAdapterFor(settings), backupFolderId))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const backupIds = backupFiles.map(f => backupIdFromFilename(f.name)).filter(Boolean);
    const { rows: metadataRows } = backupIds.length
      ? await db.query(
        `SELECT backup_id, app_version, schema_sha256, postgres_version, captured_at, encrypted
           FROM postbuch._backup_metadata
          WHERE backup_id = ANY($1::text[])`,
        [backupIds]
      )
      : { rows: [] };
    const metadataById = new Map(metadataRows.map(row => [row.backup_id, row]));
    const installedVersion = appVersion();

    const backups = backupFiles.map(f => {
      const metadata = metadataById.get(backupIdFromFilename(f.name));
      const backupVersion = metadata?.app_version ?? appVersionFromFilename(f.name);
      return {
        id: f.id,
        name: f.name,
        size: f.size,
        createdDateTime: f.createdAt,
        appVersion: backupVersion,
        manuell: f.manuell === true,
        schemaFingerprint: metadata?.schema_sha256 ?? null,
        postgresVersion: metadata?.postgres_version ?? null,
        encrypted: metadata?.encrypted === true,
        newerThanInstalled: !!(backupVersion && installedVersion && istNeuer(backupVersion, installedVersion)),
      };
    });

    res.json(backups);
  } catch (err) {
    console.error('[backup] GET /files Fehler:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/backup/settings ──────────────────────────────────────────────────

router.get('/settings', async (req, res) => {
  try {
    const settings = await loadDynamicSettings();
    const backupConfig = settings.backup ?? { enabled: false, cron: '0 4 * * *' };
    res.json({
      enabled: backupConfig.enabled ?? false,
      cron: backupConfig.cron ?? '0 4 * * *',
      backupFolderConfigured: !!getFolders(settings).backup,
      encryption: verschluesselungsStatus(settings),
    });
  } catch (err) {
    console.error('[backup] GET /settings Fehler:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/backup/settings ──────────────────────────────────────────────────
// Body: { enabled: boolean, cron: string }

router.put('/settings', async (req, res) => {
  const { enabled, cron, bestaetigung, bewusst } = req.body;

  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'Feld "enabled" muss ein Boolean sein.' });
  }
  if (!cron || typeof cron !== 'string') {
    return res.status(400).json({ error: 'Feld "cron" fehlt oder ist kein String.' });
  }
  if (enabled === false && (bestaetigung !== 'NOBACKUP' || bewusst !== true)) {
    return res.status(400).json({
      error: 'Zum Abschalten des Backups sind die Bestätigung NOBACKUP und eine ausdrückliche Zustimmung erforderlich.',
    });
  }

  // Cron-Ausdruck validieren (node-cron)
  let nodeCron;
  try {
    nodeCron = await import('node-cron');
  } catch {
    return res.status(500).json({ error: 'node-cron nicht verfügbar.' });
  }
  if (!nodeCron.default.validate(cron)) {
    return res.status(400).json({ error: `Ungültiger Cron-Ausdruck: "${cron}"` });
  }

  try {
    await db.query(
      `INSERT INTO postbuch._settings (key, value, updated_at)
       VALUES ('backup', $1::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $1::jsonb, updated_at = NOW()`,
      // Jeder Aufruf dieser schreibenden Admin-Route ist eine ausdrückliche
      // Entscheidung. Der Marker trennt sie von alten Automatismen, die einen
      // technisch aktiven Default ohne Nutzerwahl angelegt hatten.
      [JSON.stringify({ enabled, cron, bewusst: true })]
    );

    appLog('INFO', 'backup', `Backup-Einstellungen aktualisiert: enabled=${enabled}, cron="${cron}"`, {
      entity: 'settings',
      entityId: req.session?.username || null,
    });

    // Cron-Job neu starten mit den neuen Einstellungen
    await startBackupJob();

    res.json({ ok: true, enabled, cron });
  } catch (err) {
    console.error('[backup] PUT /settings Fehler:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/backup/encryption ────────────────────────────────────────────────
// Aktiviert/deaktiviert die Verschlüsselung künftiger Backups oder ändert das
// Passwort. Body-Varianten:
//   { enabled: true,  passwort, passwortWiederholung }  → aktivieren (auch erneut)
//   { enabled: true,  passwort, passwortWiederholung, neuesPasswort: true } → Passwort ändern
//   { enabled: false, bewusst: true }                    → deaktivieren / bewusst ablehnen
//
// Der DEK einer Instanz entsteht genau einmal und bleibt bei Passwortwechsel und
// Wiedereinschalten unverändert (siehe lib/backup-encryption.js) — nur seine
// Wrapping in _settings und in der Schlüsseldatei wird erneuert. Bereits
// bestehende Backup-Dateien behalten ihren zum Erstellungszeitpunkt gültigen
// eingebetteten Header unangetastet.

router.put('/encryption', async (req, res) => {
  const { enabled, passwort, passwortWiederholung, neuesPasswort, bewusst } = req.body ?? {};

  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'Feld "enabled" muss ein Boolean sein.' });
  }

  if (enabled === false) {
    if (bewusst !== true) {
      return res.status(400).json({
        error: 'Zum Abschalten bzw. bewussten Ablehnen der Verschlüsselung ist eine ausdrückliche Zustimmung erforderlich.',
      });
    }
    try {
      await deaktiviere();
      appLog('INFO', 'backup', 'Backup-Verschlüsselung deaktiviert bzw. bewusst abgelehnt', {
        entity: 'settings', entityId: req.session?.username || null,
      });
      return res.json({ ok: true, enabled: false });
    } catch (err) {
      console.error('[backup] PUT /encryption (deaktivieren) Fehler:', err);
      return res.status(500).json({ error: err.message });
    }
  }

  if (typeof passwort !== 'string' || passwort.length < MIN_BACKUP_PASSWORT_LAENGE) {
    return res.status(400).json({ error: `Backup-Passwort muss mindestens ${MIN_BACKUP_PASSWORT_LAENGE} Zeichen haben.` });
  }
  if (passwort !== passwortWiederholung) {
    return res.status(400).json({ error: 'Passwort und Wiederholung stimmen nicht überein.' });
  }

  try {
    const settings = await loadDynamicSettings();
    const backupFolderId = getFolders(settings).backup;
    if (!backupFolderId) {
      return res.status(400).json({ error: 'Backup-Ordner nicht konfiguriert.' });
    }
    const storage = getActiveAdapterFor(settings);
    const bereitsAktiv = settings.backup_encryption?.enabled === true && !!settings.backup_encryption_secret?.dek;

    if (bereitsAktiv || neuesPasswort === true) {
      await setzePasswort({ neuesPasswort: passwort, settings, storage, backupFolderId });
      appLog('INFO', 'backup', 'Backup-Passwort geändert', { entity: 'settings', entityId: req.session?.username || null });
    } else {
      await aktiviere({ passwort, settings, storage, backupFolderId });
      appLog('INFO', 'backup', 'Backup-Verschlüsselung aktiviert', { entity: 'settings', entityId: req.session?.username || null });
    }
    res.json({ ok: true, enabled: true });
  } catch (err) {
    console.error('[backup] PUT /encryption Fehler:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/backup/encryption/reveal ────────────────────────────────────────
// Zeigt das gespeicherte Backup-Passwort im Klartext — nur nach erneuter
// Eingabe des Adminpassworts (Step-up), unabhängig von der laufenden Session.
// Body: { appPasswort: string }

router.post('/encryption/reveal', async (req, res) => {
  const key = String(req.ip || 'unknown');
  const now = Date.now();
  const previous = revealAttempts.get(key);
  if (previous && now - previous.firstAt < REVEAL_WINDOW_MS && previous.count >= REVEAL_MAX_ATTEMPTS) {
    const retryAfterSec = Math.max(1, Math.ceil((previous.firstAt + REVEAL_WINDOW_MS - now) / 1000));
    res.set('Retry-After', String(retryAfterSec));
    return res.status(429).json({ error: 'Zu viele Fehlversuche. Bitte kurz warten.', retryAfterSec });
  }
  if (previous && now - previous.firstAt >= REVEAL_WINDOW_MS) revealAttempts.delete(key);

  const appPasswort = req.body?.appPasswort;
  const expected = process.env.APP_PASSWORD;
  if (!expected || !appPasswort || !timingSafeEqual(digest(appPasswort), digest(expected))) {
    const current = revealAttempts.get(key);
    if (!current) revealAttempts.set(key, { count: 1, firstAt: now });
    else current.count += 1;
    return res.status(401).json({ error: 'Adminpasswort ist falsch.' });
  }
  revealAttempts.delete(key);

  try {
    const settings = await loadDynamicSettings();
    const passwort = gespeichertesPasswort(settings);
    if (!passwort) return res.status(404).json({ error: 'Es ist kein Backup-Passwort hinterlegt.' });
    res.json({ passwort });
  } catch (err) {
    console.error('[backup] POST /encryption/reveal Fehler:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/backup/manuell ─────────────────────────────────────────────────
// Startet eine selbst ausgelöste Sicherung nach `_backup/user`. Antwortet
// sofort mit dem Zustandsdatensatz; der Client pollt GET /manuell.

router.post('/manuell', async (req, res) => {
  try {
    const settings = await loadDynamicSettings();
    if (!getFolders(settings).backup) {
      return res.status(400).json({ error: 'Backup-Ordner nicht konfiguriert.' });
    }
    const lauf = starteManuellesBackup();
    appLog('INFO', 'backup', 'Sicherung von Hand gestartet', {
      entity: 'backup',
      entityId: req.session?.username || null,
    });
    res.json(lauf);
  } catch (err) {
    console.error('[backup] POST /manuell Fehler:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/backup/manuell ──────────────────────────────────────────────────
// Zustand der laufenden bzw. zuletzt gelaufenen Handsicherung. `null`, solange
// seit dem letzten App-Start keine lief.

router.get('/manuell', (_req, res) => {
  res.json(manuellerBackupStatus());
});

// ── POST /api/backup/restore ──────────────────────────────────────────────────
// Spielt ein Backup aus der Ablage in die Datenbank ein.
// Body: { fileId: string, vorabSicherungId?: string, ohneVorabSicherung?: boolean,
//         backupPasswort?: string }  (nur nötig, wenn der Schlüsselbund der Instanz nicht passt)
//
// Sicherheitsmaßnahmen:
//   - Zwangssicherung durchgelaufen (oder bewusst übergangen, siehe Kopf)
//   - fileId wird gegen den Inhalt des Backup-Ordners samt `user`-Unterordner geprüft
//   - Dateiname muss auf .pgdump.gz enden
//   - Eigenständiges Rate-Limit für Backup-Passwort-Fehlversuche (s.o.)
//   - --single-transaction: atomarer Rollback bei Fehler
//   - Nach Erfolg: process.exit(0) → Docker-Restart → Entrypoint → Schema (no-ops) → App

router.post('/restore', async (req, res) => {
  const { fileId, backupPasswort } = req.body ?? {};

  if (!fileId || typeof fileId !== 'string') {
    return res.status(400).json({ error: 'Feld "fileId" fehlt oder ist kein String.' });
  }
  if (vorabSicherungFehlt(req, res)) return;

  const settings = await loadDynamicSettings();
  const backupFolderId = getFolders(settings).backup;
  const storage = getActiveAdapterFor(settings);

  if (!backupFolderId) {
    return res.status(400).json({ error: 'Backup-Ordner nicht konfiguriert.' });
  }

  // Sicherheitsprüfung: fileId muss im Backup-Ordner (oder in `_backup/user`)
  // liegen und .pgdump.gz sein
  let targetFile;
  try {
    const files = await sammleBackupDateien(storage, backupFolderId);
    targetFile = files.find(f => f.id === fileId);
  } catch (err) {
    return res.status(500).json({ error: `Backup-Ordner konnte nicht gelesen werden: ${err.message}` });
  }

  if (!targetFile) {
    return res.status(400).json({ error: 'Datei nicht gefunden oder kein gültiges Backup (.pgdump.gz).' });
  }

  const tempDumpPath = `/tmp/restore_${Date.now()}.pgdump`;

  try {
    appLog('INFO', 'backup', `Restore gestartet: ${targetFile.name}`, {
      entity: 'backup',
      entityId: req.session?.username || null,
    });

    // 1. Backup aus der Ablage herunterladen
    const downloaded = await storage.download(fileId);

    // 2. Bei Bedarf entschlüsseln (Alt-Backups laufen unverändert durch)
    let gzipBuffer;
    try {
      if (backupPasswort) {
        const gesperrtFuer = backupPasswortRateLimitGreift(req);
        if (gesperrtFuer) {
          return res.status(429).json({ error: `Zu viele Fehlversuche. Bitte in ${gesperrtFuer}s erneut versuchen.` });
        }
      }
      gzipBuffer = await restoreEntschluesseln(downloaded, { settings, passwort: backupPasswort, storage, backupFolderId });
    } catch (err) {
      if (err.code === 'PASSWORT_ERFORDERLICH') return res.status(409).json({ error: err.message, code: err.code });
      if (err.code === 'BACKUP_PASSWORT_FALSCH') {
        backupPasswortFehlversuchVermerken(req);
        return res.status(401).json({ error: err.message, code: err.code });
      }
      throw err;
    }

    // 3. Entpacken
    const dumpBuffer = await gunzipAsync(gzipBuffer);

    // 4. In temporäre Datei schreiben
    await writeFile(tempDumpPath, dumpBuffer);

    // 5. Atomar wiederherstellen
    const dbHost = process.env.POSTGRES_HOST || 'postgres';
    const dbPort = process.env.POSTGRES_PORT || '5432';
    const dbUser = process.env.POSTGRES_USER || 'postbuch';
    const dbName = process.env.POSTGRES_DB   || 'postbuch';
    const pgEnv  = { ...process.env, PGPASSWORD: process.env.POSTGRES_PASSWORD };

    await atomicPgRestore(tempDumpPath, dbHost, dbPort, dbUser, dbName, pgEnv, adminRestoreCleanupSql(verschluesselungFuerRestore(settings)));

    appLog('INFO', 'backup', `Restore erfolgreich: ${targetFile.name}`, {
      entity: 'backup',
      entityId: req.session?.username || null,
    });

    res.json({ ok: true, restoredFile: targetFile.name });

    // App neu starten damit Sessions, Pool und Caches sauber sind.
    // Docker-Restart-Policy bringt den Container wieder hoch.
    setTimeout(() => process.exit(0), 1500);
  } catch (err) {
    console.error('[backup] Restore fehlgeschlagen:', err);
    appLog('ERROR', 'backup', `Restore fehlgeschlagen: ${err.message}`, {
      entity: 'backup',
      entityId: req.session?.username || null,
      details: err.stderr || err.stack?.slice(0, 1000),
    });
    res.status(500).json({ error: err.message });
  } finally {
    await unlink(tempDumpPath).catch(() => {});
  }
});

// ── POST /api/backup/restore-upload ──────────────────────────────────────────
// Spielt eine lokal hochgeladene .pgdump.gz-Datei in die Datenbank ein.
// Body: rohe Bytes (Content-Type: application/octet-stream)
// Header X-Filename: Dateiname für das Log (optional)
// Header X-Vorab-Sicherung: ID der Zwangssicherung, alternativ
//        X-Ohne-Vorab-Sicherung: 1 nach ausdrücklicher Warnung
// Header X-Backup-Passwort: Passwort für verschlüsselte Backups (optional,
//        URL-kodiert wegen möglicher Sonderzeichen in HTTP-Headern)
//
// Sicherheitsmaßnahmen:
//   - Zwangssicherung wie bei /restore
//   - Magic-Bytes werden geprüft: Gzip (0x1f 0x8b) ODER verschlüsselt (PBE1)
//   - Eigenständiges Rate-Limit für Backup-Passwort-Fehlversuche (s.o.)
//   - Limit: 500 MB
//   - Ansonsten identischer Restore-Ablauf wie /restore

router.post('/restore-upload',
  express.raw({ type: 'application/octet-stream', limit: '500mb' }),
  async (req, res) => {
    const compressed = req.body;

    // Der Body ist hier roh — der Nachweis reist deshalb im Header.
    const vorabReq = {
      session: req.session,
      body: {
        vorabSicherungId: req.get('X-Vorab-Sicherung') || undefined,
        ohneVorabSicherung: req.get('X-Ohne-Vorab-Sicherung') === '1',
      },
    };
    if (vorabSicherungFehlt(vorabReq, res)) return;

    if (!Buffer.isBuffer(compressed) || compressed.length < 10) {
      return res.status(400).json({ error: 'Keine oder zu kleine Datei empfangen.' });
    }

    // Magic-Bytes prüfen: entweder Gzip (0x1f 0x8b) oder verschlüsselt (PBE1)
    const istGzip = compressed[0] === 0x1f && compressed[1] === 0x8b;
    if (!istGzip && !isEncryptedBackup(compressed)) {
      return res.status(400).json({ error: 'Datei ist keine gültige .gz-Datei (falscher Magic-Header).' });
    }

    const rawBackupPasswort = req.get('X-Backup-Passwort');
    const backupPasswort = rawBackupPasswort ? decodeURIComponent(rawBackupPasswort) : undefined;

    const rawName = req.headers['x-filename'] || '';
    // Dateinamen von URL-Encoding befreien und auf sichere Zeichen beschränken
    const filename = decodeURIComponent(rawName).replace(/[^a-zA-Z0-9._\-]/g, '_') || `upload_${Date.now()}.pgdump.gz`;

    const tempDumpPath = `/tmp/restore_upload_${Date.now()}.pgdump`;

    try {
      appLog('INFO', 'backup', `Upload-Restore gestartet: ${filename}`, {
        entity: 'backup',
        entityId: req.session?.username || null,
      });

      // Bei Bedarf entschlüsseln (Alt-Backups laufen unverändert durch)
      const settings = await loadDynamicSettings();
      const backupFolderId = getFolders(settings).backup;
      const storage = getActiveAdapterFor(settings);

      let gzipBuffer;
      try {
        if (backupPasswort) {
          const gesperrtFuer = backupPasswortRateLimitGreift(req);
          if (gesperrtFuer) {
            return res.status(429).json({ error: `Zu viele Fehlversuche. Bitte in ${gesperrtFuer}s erneut versuchen.` });
          }
        }
        gzipBuffer = await restoreEntschluesseln(compressed, { settings, passwort: backupPasswort, storage, backupFolderId });
      } catch (err) {
        if (err.code === 'PASSWORT_ERFORDERLICH') return res.status(409).json({ error: err.message, code: err.code });
        if (err.code === 'BACKUP_PASSWORT_FALSCH') {
          backupPasswortFehlversuchVermerken(req);
          return res.status(401).json({ error: err.message, code: err.code });
        }
        throw err;
      }

      // Entpacken
      const dumpBuffer = await gunzipAsync(gzipBuffer);

      // In temporäre Datei schreiben
      await writeFile(tempDumpPath, dumpBuffer);

      // Atomar wiederherstellen
      const dbHost = process.env.POSTGRES_HOST || 'postgres';
      const dbPort = process.env.POSTGRES_PORT || '5432';
      const dbUser = process.env.POSTGRES_USER || 'postbuch';
      const dbName = process.env.POSTGRES_DB   || 'postbuch';
      const pgEnv  = { ...process.env, PGPASSWORD: process.env.POSTGRES_PASSWORD };

      await atomicPgRestore(tempDumpPath, dbHost, dbPort, dbUser, dbName, pgEnv, adminRestoreCleanupSql(verschluesselungFuerRestore(settings)));

      appLog('INFO', 'backup', `Upload-Restore erfolgreich: ${filename}`, {
        entity: 'backup',
        entityId: req.session?.username || null,
      });

      res.json({ ok: true, restoredFile: filename });

      // App neu starten damit Sessions, Pool und Caches sauber sind.
      setTimeout(() => process.exit(0), 1500);
    } catch (err) {
      console.error('[backup] Upload-Restore fehlgeschlagen:', err);
      appLog('ERROR', 'backup', `Upload-Restore fehlgeschlagen: ${err.message}`, {
        entity: 'backup',
        entityId: req.session?.username || null,
        details: err.stderr || err.stack?.slice(0, 1000),
      });
      res.status(500).json({ error: err.message });
    } finally {
      await unlink(tempDumpPath).catch(() => {});
    }
  });

export default router;
