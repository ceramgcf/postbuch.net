/**
 * jobs/backup.js — Automatisierter Datenbank-Backup
 *
 * Ersetzt: n8n-Workflow "Postbuch SQL Backup"
 *
 * Funktionen:
 *   - pg_dump (binary custom format) → komprimieren → auf OneDrive hochladen
 *   - pg_dump (plain SQL format)     → komprimieren → auf OneDrive hochladen
 *   - Retention-Policy: täglich / wöchentlich / monatlich / halbjährlich
 *   - Steuerbar über _settings.backup = { enabled: true, cron: "0 4 * * *" }
 *
 * Selbst ausgelöste Backups ("Jetzt sichern", Zwangssicherung vor einem Restore)
 * landen im Unterordner `_backup/user`. Sie sind damit aus der Retention heraus —
 * die Aufräumlogik sieht nur die Dateien direkt in `_backup` — und werden nie
 * automatisch gelöscht.
 *
 * Backup-Dateien pro Lauf:
 *   postbuch_TIMESTAMP_vVERSION.pgdump.gz  — binärer Custom-Dump (für pg_restore / Restore-Endpoint)
 *   postbuch_TIMESTAMP_vVERSION.sql.gz     — SQL-Textdump (Fallback, manuell via: psql postgres < dump.sql)
 *
 * SQL-Textdump Restore-Kommando:
 *   gunzip -c postbuch_TIMESTAMP.sql.gz | psql -h <host> -U <user> postgres
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { writeFile, readFile, unlink } from 'fs/promises';
import { gzip } from 'zlib';
import { createHash } from 'crypto';
import { loadDynamicSettings, getFolders } from '../config.js';
import { getActiveAdapter, getActiveAdapterFor } from '../lib/storage/index.js';
import { appLog } from '../app-log.js';
import db from '../db.js';
import { appVersion } from '../lib/app-version.js';
import { backupDatum, retentionKeepIds } from './backup-retention.js';
import { backupExcludeArgs } from './backup-policy.js';
import { aktuellerSchluesselbund, sidecarAbgleichen } from '../lib/backup-encryption.js';
import { buildEncryptedFile } from '../lib/backup-crypto.js';

const execFileAsync = promisify(execFile);
const gzipAsync = promisify(gzip);

let _cronJob = null;

/** Unterordner in `_backup` für selbst ausgelöste Sicherungen. */
export const USER_BACKUP_ORDNER = 'user';

// Zustand des letzten selbst ausgelösten Laufs. Bewusst nur im Speicher: er
// interessiert genau so lange, wie das UI darauf wartet — nach einem Restore
// startet die App ohnehin neu.
let _manuellerLauf = null;

/**
 * Ordner-ID von `_backup/user`. `anlegen: false` liefert null, wenn es ihn noch
 * nicht gibt (Listenansicht darf nichts erzeugen).
 */
export async function userBackupOrdnerId(storage, backupFolderId, { anlegen = false } = {}) {
  if (!backupFolderId) return null;
  if (anlegen) {
    const { id } = await storage.findOrCreateFolder(backupFolderId, USER_BACKUP_ORDNER, { strict: true });
    return id;
  }
  const kinder = await storage.listChildren(backupFolderId);
  return kinder.find(k => k.isFolder && k.name === USER_BACKUP_ORDNER)?.id ?? null;
}

/** Zustand des letzten selbst ausgelösten Backups (oder null). */
export function manuellerBackupStatus() {
  return _manuellerLauf;
}

/**
 * Startet ein selbst ausgelöstes Backup im Hintergrund und liefert sofort den
 * Zustandsdatensatz. Läuft bereits eines, wird dessen Zustand zurückgegeben —
 * zwei parallele pg_dump-Läufe bringen niemandem etwas.
 */
export function starteManuellesBackup() {
  if (_manuellerLauf?.status === 'laeuft') return _manuellerLauf;

  const lauf = {
    id: `manuell_${Date.now()}`,
    status: 'laeuft',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    dateiname: null,
    fehler: null,
  };
  _manuellerLauf = lauf;

  runBackup({ manuell: true })
    .then((ergebnis) => {
      lauf.status = 'fertig';
      lauf.dateiname = ergebnis?.binaryFileName ?? null;
      lauf.finishedAt = new Date().toISOString();
    })
    .catch((err) => {
      lauf.status = 'fehler';
      lauf.fehler = err.message;
      lauf.finishedAt = new Date().toISOString();
      console.error('[backup] Manuelles Backup fehlgeschlagen:', err.message);
    });

  return lauf;
}

function backupIdFromFilename(filename) {
  const match = /^postbuch_(.+?)(?:_v(?:\d{1,3}\.\d{1,3}\.\d{1,3}|unbekannt))?\.pgdump\.gz$/.exec(filename);
  return match?.[1] ?? null;
}

/**
 * Schreibt die Herkunft eines Backups VOR dem pg_dump in die DB. Dadurch landet
 * genau dieser Datensatz in beiden Dump-Formaten und reist auch ohne seinen
 * Dateinamen mit. Die Version steht zusätzlich im Namen, damit sie bei einer
 * einzeln kopierten Datei sofort sichtbar bleibt.
 */
async function recordBackupMetadata(backupId, encrypted) {
  const schema = await readFile('/app/base_schema.sql');
  const schemaSha256 = createHash('sha256').update(schema).digest('hex');
  const { rows } = await db.query('SHOW server_version');

  await db.query(
    `INSERT INTO postbuch._backup_metadata
       (backup_id, app_version, schema_sha256, postgres_version, encrypted)
     VALUES ($1, $2, $3, $4, $5)`,
    [backupId, appVersion(), schemaSha256, rows[0].server_version, encrypted]
  );

  return { appVersion: appVersion(), schemaSha256 };
}

/**
 * Startet den Backup-Cron-Job, falls in _settings aktiviert.
 */
/**
 * Gleicht beim App-Start die Schlüsseldatei `_backup/schluessel.json` ab —
 * vor allem nach einer Wiederherstellung, die den Schlüsselbund erweitert hat
 * und danach die App neu startet.
 */
export async function backupSchluesseldateiAbgleichen() {
  const settings = await loadDynamicSettings();
  const backupFolderId = getFolders(settings).backup;
  if (!backupFolderId || !settings.backup_encryption_secret?.dek) return;
  const geschrieben = await sidecarAbgleichen(settings, getActiveAdapterFor(settings), backupFolderId);
  if (geschrieben) appLog('INFO', 'backup', 'Schlüsseldatei der Backup-Verschlüsselung aktualisiert');
}

export async function startBackupJob() {
  try {
    const settings = await loadDynamicSettings();
    const backupConfig = settings.backup;

    if (!backupConfig || !backupConfig.enabled) {
      console.log('[backup] Backup-Job deaktiviert');
      return;
    }

    const cronExpr = backupConfig.cron || '0 4 * * *';

    // node-cron dynamisch importieren (optional dependency)
    let cron;
    try {
      cron = await import('node-cron');
    } catch {
      console.warn('[backup] node-cron nicht installiert — Backup-Job kann nicht gestartet werden');
      appLog('WARN', 'backup', 'node-cron nicht installiert — Backup-Job deaktiviert');
      return;
    }

    if (_cronJob) {
      _cronJob.stop();
    }

    _cronJob = cron.default.schedule(cronExpr, () => {
      runBackup().catch(err => {
        console.error('[backup] Backup fehlgeschlagen:', err.message);
        appLog('ERROR', 'backup', `Backup fehlgeschlagen: ${err.message}`);
      });
    }, { timezone: 'Europe/Berlin' });

    console.log(`[backup] Cron-Job gestartet: ${cronExpr}`);
    appLog('INFO', 'backup', `Backup Cron-Job gestartet: ${cronExpr}`);
  } catch (err) {
    console.error('[backup] Backup-Job konnte nicht gestartet werden:', err.message);
    appLog('ERROR', 'backup', `Backup-Job Start fehlgeschlagen: ${err.message}`);
  }
}

/**
 * Führt ein einzelnes Backup durch (binärer Custom-Dump + SQL-Textdump).
 *
 * @param {{ manuell?: boolean }} optionen  manuell = selbst ausgelöst: Ablage in
 *   `_backup/user`, keine Retention.
 * @returns {{ binaryFileName: string, sqlFileName: string, manuell: boolean }}
 */
export async function runBackup({ manuell = false } = {}) {
  const startTime = Date.now();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupId = timestamp;

  // Temp-Pfade
  const binaryDumpPath = `/tmp/postbuch_backup_${timestamp}.pgdump`;
  const binaryGzPath   = `${binaryDumpPath}.gz`;
  const sqlDumpPath    = `/tmp/postbuch_backup_${timestamp}.sql`;
  const sqlGzPath      = `${sqlDumpPath}.gz`;

  const dbUser = process.env.POSTGRES_USER || 'postbuch';
  const dbName = process.env.POSTGRES_DB   || 'postbuch';
  const dbHost = process.env.POSTGRES_HOST || 'postgres';
  const dbPort = process.env.POSTGRES_PORT || '5432';
  const pgEnv  = { ...process.env, PGPASSWORD: process.env.POSTGRES_PASSWORD };

  // Gemeinsame pg_dump-Basisargumente
  const baseArgs = [
    '-h', dbHost, '-p', dbPort, '-U', dbUser, '-d', dbName,
    '--no-owner', '--no-acl',
    // Reine Caches: Tabellenstruktur sichern, Inhalt nach Restore neu aufbauen.
    ...backupExcludeArgs(),
  ];

  try {
    const settings = await loadDynamicSettings();
    const storage = getActiveAdapterFor(settings);
    const backupFolderId = getFolders(settings).backup;

    if (!backupFolderId) {
      console.warn('[backup] Kein Backup-Ordner konfiguriert (storage_folders.<backend>.backup)');
      appLog('WARN', 'backup', 'Backup nicht erstellt: kein Ablage-Ordner konfiguriert');
      return;
    }

    // Selbst ausgelöste Sicherungen liegen im Unterordner — die Retention räumt
    // ausschließlich in `_backup` selbst auf und sieht sie damit nie.
    const zielOrdnerId = manuell
      ? await userBackupOrdnerId(storage, backupFolderId, { anlegen: true })
      : backupFolderId;

    // Schlüsseldatei vor jeder Sicherung auf den Stand von Schlüsselbund und
    // Passwort bringen (nach Restore, Backend-Wechsel oder gescheitertem
    // Upload). Darf die Sicherung selbst nie verhindern.
    await sidecarAbgleichen(settings, storage, backupFolderId).catch((err) => {
      appLog('WARN', 'backup', `Schlüsseldatei konnte nicht abgeglichen werden: ${err.message}`);
    });

    const schluessel = await aktuellerSchluesselbund();
    const dek = schluessel?.dek ? Buffer.from(schluessel.dek, 'base64') : null;
    const verschluesselt = settings.backup_encryption?.enabled === true && !!dek;
    const wrappedDekCurrent = schluessel?.wrappedDekCurrent ?? null;

    const metadata = await recordBackupMetadata(backupId, verschluesselt);
    const versionLabel = metadata.appVersion ? `v${metadata.appVersion}` : 'vunbekannt';
    const binaryFileName = `postbuch_${backupId}_${versionLabel}.pgdump.gz`;
    const sqlFileName    = `postbuch_${backupId}_${versionLabel}.sql.gz`;

    // 1a. Binärer Custom-Dump (für pg_restore / Restore-Endpoint)
    //     post_files und der semantische Hilfekorpus sind regenerierbare Caches;
    //     ihre Daten werden bewusst nicht in den Dump geschrieben.
    await execFileAsync('pg_dump', [
      ...baseArgs,
      '-F', 'c',
      '-f', binaryDumpPath,
    ], { env: pgEnv });

    // 1b. SQL-Textdump (Fallback für manuelles Restore via psql)
    //   --create    → beinhaltet CREATE DATABASE + \connect
    //   --clean     → beinhaltet DROP ... vor jeder CREATE-Anweisung
    //   --if-exists → vermeidet Fehler wenn DB/Objekte noch nicht existieren
    //   Restore: gunzip -c dump.sql.gz | psql -h <host> -U <user> postgres
    await execFileAsync('pg_dump', [
      ...baseArgs,
      '--create', '--clean', '--if-exists',
      '-F', 'p',
      '-f', sqlDumpPath,
    ], { env: pgEnv });

    // 2. Beide Dumps komprimieren (parallel)
    const [binaryData, sqlData] = await Promise.all([
      readFile(binaryDumpPath),
      readFile(sqlDumpPath),
    ]);
    const [binaryCompressed, sqlCompressed] = await Promise.all([
      gzipAsync(binaryData),
      gzipAsync(sqlData),
    ]);
    await Promise.all([
      writeFile(binaryGzPath, binaryCompressed),
      writeFile(sqlGzPath, sqlCompressed),
    ]);

    const binarySizeMB = (binaryCompressed.length / 1024 / 1024).toFixed(2);
    const sqlSizeMB    = (sqlCompressed.length    / 1024 / 1024).toFixed(2);
    console.log(`[backup] Binary-Dump: ${binarySizeMB} MB, SQL-Dump: ${sqlSizeMB} MB (je komprimiert)`);

    // 2b. Bei aktiver Verschlüsselung: Gzip-Bytes 1:1 durch die verschlüsselte
    //     Form ersetzen. Dateiname/Extension bleiben unverändert — die
    //     Erkennung beim Restore läuft über die Magic-Bytes am Anfang, nicht
    //     über den Namen (siehe lib/backup-crypto.js).
    const binaryUpload = verschluesselt ? buildEncryptedFile(binaryCompressed, dek, wrappedDekCurrent) : binaryCompressed;
    const sqlUpload    = verschluesselt ? buildEncryptedFile(sqlCompressed, dek, wrappedDekCurrent) : sqlCompressed;

    // 3. In die Ablage hochladen
    await storage.uploadNew(binaryUpload, binaryFileName, zielOrdnerId);
    console.log(`[backup] Binary-Backup hochgeladen: ${binaryFileName}${verschluesselt ? ' (verschlüsselt)' : ''}`);

    await storage.uploadNew(sqlUpload, sqlFileName, zielOrdnerId);
    console.log(`[backup] SQL-Backup hochgeladen: ${sqlFileName}${verschluesselt ? ' (verschlüsselt)' : ''}`);

    appLog('INFO', 'backup',
      `${manuell ? 'Selbst ausgelöstes Backup' : 'Backup'} erfolgreich: ${binaryFileName} (${binarySizeMB} MB) + ${sqlFileName} (${sqlSizeMB} MB) in ${((Date.now() - startTime) / 1000).toFixed(1)}s`
    );

    // 4. Retention-Policy anwenden — nur für die automatischen Läufe.
    if (!manuell) await applyRetention(backupFolderId);

    return { binaryFileName, sqlFileName, manuell };
  } catch (err) {
    appLog('ERROR', 'backup', `Backup fehlgeschlagen: ${err.message}`, { details: err.stack?.slice(0, 1000) });
    throw err;
  } finally {
    await Promise.all([
      unlink(binaryDumpPath).catch(() => {}),
      unlink(binaryGzPath).catch(() => {}),
      unlink(sqlDumpPath).catch(() => {}),
      unlink(sqlGzPath).catch(() => {}),
    ]);
  }
}

/**
 * Wendet die Retention-Policy an: 0–6 Tage vollständig, 7–30 Tage wöchentlich,
 * 31–365 Tage monatlich, danach halbjährlich ohne zeitliches Ende.
 * Entscheidungsbasis: binäre .pgdump.gz-Dateien direkt in `_backup`;
 * `_backup/user` wird nicht betreten und bleibt damit unangetastet.
 * Korrespondierende .sql.gz-Dateien werden synchron mitgelöscht.
 */
async function applyRetention(folderId) {
  try {
    const storage = await getActiveAdapter();
    const files = await storage.listChildren(folderId);

    // Binäre Dumps als Entscheidungsbasis
    const binaryBackups = files
      .filter(f => f.name.startsWith('postbuch_') && f.name.endsWith('.pgdump.gz'))
      .sort((a, b) => (backupDatum(b)?.getTime() ?? 0) - (backupDatum(a)?.getTime() ?? 0));

    // SQL-Dumps als Map (Basis-Timestamp → Datei-Objekt)
    const sqlByBase = new Map(
      files
        .filter(f => f.name.startsWith('postbuch_') && f.name.endsWith('.sql.gz'))
        .map(f => [f.name.replace('.sql.gz', ''), f])
    );

    const keep = retentionKeepIds(binaryBackups);

    // Nicht-behaltene löschen (Binary + korrespondierender SQL-Dump)
    const toDelete = binaryBackups.filter(b => !keep.has(b.id));
    for (const b of toDelete) {
      await storage.remove(b.id);
      console.log(`[backup] Retention: ${b.name} gelöscht`);

      const sqlBase = b.name.replace('.pgdump.gz', '');
      const sqlFile = sqlByBase.get(sqlBase);
      if (sqlFile) {
        await storage.remove(sqlFile.id);
        console.log(`[backup] Retention: ${sqlFile.name} gelöscht`);
      }

      const backupId = backupIdFromFilename(b.name);
      if (backupId) {
        await db.query('DELETE FROM postbuch._backup_metadata WHERE backup_id = $1', [backupId]);
      }
    }

    if (toDelete.length > 0) {
      appLog('INFO', 'backup', `Retention: ${toDelete.length} alte Backup-Paare gelöscht`);
    }
  } catch (err) {
    console.error('[backup] Retention-Fehler:', err.message);
    appLog('WARN', 'backup', `Retention-Policy fehlgeschlagen: ${err.message}`);
  }
}
