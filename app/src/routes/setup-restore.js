/**
 * routes/setup-restore.js — Admin-password-gated setup restore page
 *
 * Only active when the flag file /app/data/scan_buffer/.setup_restore_pending exists.
 * Created by install.sh before the stack is started.
 * Deleted automatically after a successful pg_restore.
 *
 *   GET  /setup/restore  → minimal HTML upload page (no React, no login)
 *   POST /setup/restore  → raw bytes (application/octet-stream), runs pg_restore
 *   POST /setup/restore/verlassen → Restore-Modus ohne Backup verlassen und
 *                          stattdessen den Einrichtungsassistenten vormerken
 */

import { Router } from 'express';
import express from 'express';
import { createHash, timingSafeEqual } from 'crypto';
import { promisify } from 'util';
import { writeFile, access, rm, mkdtemp } from 'fs/promises';
import { constants } from 'fs';
import { gunzip } from 'zlib';
import { atomicPgRestore, setupRestoreCleanupSql } from '../lib/pg-restore.js';
import { getClient } from '../db.js';
import {
  isEncryptedBackup, mitPasswortEntschluesseln, sidecarEintraege, BackupPasswortFalschError,
} from '../lib/backup-crypto.js';

const router = Router();
const gunzipAsync = promisify(gunzip);
const MAX_COMPRESSED_BYTES = 500 * 1024 * 1024;
const MAX_DUMP_BYTES = 1024 * 1024 * 1024;
const AUTH_WINDOW_MS = 5 * 60 * 1000;
const AUTH_MAX_ATTEMPTS = 10;
const authAttempts = new Map();

// Eigenständiges Rate-Limit für Backup-Passwort-Fehlversuche — unabhängig vom
// Adminpasswort-Limit oben, damit der GCM-Auth-Tag nicht zum Orakel für
// beliebig viele Versuche gegen das Backup-Passwort wird.
const BACKUP_PW_WINDOW_MS = 5 * 60 * 1000;
const BACKUP_PW_MAX_ATTEMPTS = 10;
const backupPasswortAttempts = new Map();

let restoreInProgress = false;

function passwordDigest(value) {
  return createHash('sha256').update(String(value ?? ''), 'utf8').digest();
}

function setupAuth(req, res, next) {
  const expected = process.env.APP_PASSWORD;
  if (!expected) {
    return res.status(503).json({ error: 'Adminpasswort ist nicht konfiguriert.' });
  }

  const key = String(req.ip || 'unknown');
  const now = Date.now();
  const previous = authAttempts.get(key);
  if (previous && now - previous.firstAt < AUTH_WINDOW_MS && previous.count >= AUTH_MAX_ATTEMPTS) {
    const retryAfterSec = Math.max(1, Math.ceil((previous.firstAt + AUTH_WINDOW_MS - now) / 1000));
    res.set('Retry-After', String(retryAfterSec));
    return res.status(429).json({ error: 'Zu viele Fehlversuche. Bitte kurz warten.', retryAfterSec });
  }
  if (previous && now - previous.firstAt >= AUTH_WINDOW_MS) authAttempts.delete(key);

  const supplied = req.get('X-Admin-Password') || '';
  if (!timingSafeEqual(passwordDigest(supplied), passwordDigest(expected))) {
    const current = authAttempts.get(key);
    if (!current) authAttempts.set(key, { count: 1, firstAt: now });
    else current.count += 1;
    return res.status(401).json({ error: 'Adminpasswort ist falsch.' });
  }

  authAttempts.delete(key);
  next();
}

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

const FLAG_FILE = '/data/scan_buffer/.setup_restore_pending';

async function isSetupMode() {
  try {
    await access(FLAG_FILE, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function requireSetupMode(_req, res, next) {
  if (!await isSetupMode()) return res.status(404).json({ error: 'Not found' });
  return next();
}

const SETUP_HTML = `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>postbuch.net – Backup einspielen</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #f8f9fb;
      color: #1a1a2e;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .card {
      background: #fff;
      border: 1px solid #e2e8f0;
      border-radius: 12px;
      padding: 40px;
      width: 100%;
      max-width: 480px;
      box-shadow: 0 1px 4px rgba(0,0,0,0.07);
    }
    .logo {
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: #6366f1;
      margin-bottom: 6px;
    }
    h1 {
      font-size: 22px;
      font-weight: 600;
      margin-bottom: 8px;
      color: #1a1a2e;
    }
    .subtitle {
      font-size: 14px;
      color: #64748b;
      margin-bottom: 28px;
      line-height: 1.5;
    }
    .password-label { display: block; font-size: 14px; font-weight: 600; margin-bottom: 6px; }
    .password-input {
      width: 100%; border: 1px solid #cbd5e1; border-radius: 8px;
      padding: 10px 12px; font-size: 14px; margin-bottom: 18px;
    }
    .backup-password-field { display: none; }
    .backup-password-hint {
      font-size: 12px; color: #64748b; margin: -12px 0 14px; line-height: 1.4;
    }
    .keyfile-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; flex-wrap: wrap; }
    .keyfile-name { font-size: 13px; color: #6366f1; word-break: break-all; }
    #keyFileInput { display: none; }
    .drop-zone {
      border: 2px dashed #cbd5e1;
      border-radius: 8px;
      padding: 32px 20px;
      text-align: center;
      cursor: pointer;
      transition: border-color 0.15s, background 0.15s;
      margin-bottom: 20px;
      position: relative;
    }
    .drop-zone:hover, .drop-zone.over {
      border-color: #6366f1;
      background: #f5f3ff;
    }
    .drop-zone.has-file {
      border-color: #6366f1;
      border-style: solid;
    }
    .drop-icon {
      font-size: 32px;
      margin-bottom: 10px;
      display: block;
    }
    .drop-label {
      font-size: 14px;
      color: #64748b;
      margin-bottom: 10px;
    }
    .drop-label strong { color: #1a1a2e; }
    .file-name {
      font-size: 13px;
      color: #6366f1;
      font-weight: 500;
      margin-top: 8px;
      word-break: break-all;
    }
    #fileInput { display: none; }
    .btn-select {
      background: #f1f5f9;
      border: 1px solid #e2e8f0;
      color: #1a1a2e;
      font-size: 13px;
      padding: 7px 16px;
      border-radius: 6px;
      cursor: pointer;
      font-weight: 500;
    }
    .btn-select:hover { background: #e2e8f0; }
    .btn-upload {
      width: 100%;
      background: #6366f1;
      color: #fff;
      border: none;
      font-size: 15px;
      font-weight: 600;
      padding: 12px;
      border-radius: 8px;
      cursor: pointer;
      transition: background 0.15s, opacity 0.15s;
    }
    .btn-upload:hover:not(:disabled) { background: #4f46e5; }
    .btn-upload:disabled { opacity: 0.45; cursor: not-allowed; }
    .ohne-backup {
      margin-top: 24px; padding-top: 18px; border-top: 1px solid #e2e8f0;
      font-size: 13px; color: #64748b; line-height: 1.5;
    }
    .btn-secondary {
      margin-top: 10px; width: 100%; background: #fff; color: #1a1a2e;
      border: 1px solid #cbd5e1; font-size: 14px; font-weight: 500;
      padding: 10px; border-radius: 8px; cursor: pointer;
    }
    .btn-secondary:hover:not(:disabled) { background: #f1f5f9; }
    .btn-secondary:disabled { opacity: 0.45; cursor: not-allowed; }
    .status-actions { display: none; gap: 10px; margin-top: 12px; flex-wrap: wrap; }
    .status {
      margin-top: 18px;
      padding: 14px 16px;
      border-radius: 8px;
      font-size: 14px;
      display: none;
      line-height: 1.5;
    }
    .status.info    { background: #eff6ff; color: #1d4ed8; border: 1px solid #bfdbfe; }
    .status.success { background: #f0fdf4; color: #15803d; border: 1px solid #bbf7d0; }
    .status.error   { background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca; }
    .progress-bar-wrap {
      background: #e2e8f0;
      border-radius: 4px;
      height: 6px;
      margin-top: 12px;
      overflow: hidden;
      display: none;
    }
    .progress-bar {
      height: 100%;
      background: #6366f1;
      border-radius: 4px;
      transition: width 0.2s;
      width: 0%;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">postbuch.net</div>
    <h1>Backup einspielen</h1>
    <p class="subtitle">
      Wähle eine <strong>.pgdump.gz</strong>-Backup-Datei aus.<br>
      Zur Freigabe ist das bei der Installation gesetzte Adminpasswort erforderlich.
    </p>

    <label class="password-label" for="adminPassword">Adminpasswort</label>
    <input class="password-input" type="password" id="adminPassword"
      autocomplete="current-password" required>

    <div class="drop-zone" id="dropZone">
      <span class="drop-icon">📦</span>
      <p class="drop-label"><strong>Datei hierher ziehen</strong> oder</p>
      <button class="btn-select" type="button" onclick="document.getElementById('fileInput').click()">
        Datei auswählen
      </button>
      <input type="file" id="fileInput" accept=".gz,.pgdump.gz">
      <p class="file-name" id="fileName"></p>
    </div>

    <div class="backup-password-field" id="backupPasswordField">
      <label class="password-label" for="backupPassword">Backup-Passwort</label>
      <input class="password-input" type="password" id="backupPassword" autocomplete="off">
      <p class="backup-password-hint">
        Diese Backup-Datei ist verschlüsselt. Es genügt entweder das Passwort,
        das beim Erstellen dieser Datei gültig war, oder das zuletzt gesetzte
        Backup-Passwort zusammen mit der Schlüsseldatei unten.
      </p>
      <label class="password-label">Schlüsseldatei (optional)</label>
      <div class="keyfile-row">
        <button class="btn-select" type="button" onclick="document.getElementById('keyFileInput').click()">
          schluessel.json auswählen
        </button>
        <input type="file" id="keyFileInput" accept=".json,application/json">
        <span class="keyfile-name" id="keyFileName"></span>
      </div>
      <p class="backup-password-hint" style="margin-top: 0">
        Liegt im selben Backup-Ordner wie die Sicherungen
        (<code>_backup/schluessel.json</code>) und öffnet mit dem zuletzt
        gesetzten Backup-Passwort alle Schlüssel der bisherigen Installation.
      </p>
    </div>

    <button class="btn-upload" id="uploadBtn" disabled onclick="uploadBackup()">
      Backup einspielen
    </button>

    <div class="status" id="status"></div>
    <div class="status-actions" id="statusActions">
      <button class="btn-select" type="button" onclick="pollUntilReady()">Erneut prüfen</button>
      <button class="btn-select" type="button" onclick="window.location.href = '/login'">Zur Anmeldung</button>
    </div>
    <div class="progress-bar-wrap" id="progressWrap">
      <div class="progress-bar" id="progressBar"></div>
    </div>

    <div class="ohne-backup" id="ohneBackup">
      Kein Backup zur Hand oder doch neu anfangen? Dann richte postbuch.net
      ohne Backup ein. Die Datenbank ist noch leer, es geht nichts verloren.
      Das Adminpasswort oben ist auch dafür nötig.
      <button class="btn-secondary" id="ohneBackupBtn" type="button" disabled onclick="ohneBackupEinrichten()">
        Ohne Backup neu einrichten
      </button>
    </div>
  </div>

  <script>
    let selectedFile = null;
    let selectedFileEncrypted = false;

    const dropZone = document.getElementById('dropZone');
    const fileInput = document.getElementById('fileInput');
    const uploadBtn = document.getElementById('uploadBtn');
    const fileNameEl = document.getElementById('fileName');
    const statusEl = document.getElementById('status');
    const progressWrap = document.getElementById('progressWrap');
    const progressBar = document.getElementById('progressBar');
    const adminPassword = document.getElementById('adminPassword');
    const backupPasswordField = document.getElementById('backupPasswordField');
    const backupPassword = document.getElementById('backupPassword');
    const keyFileInput = document.getElementById('keyFileInput');
    const keyFileName = document.getElementById('keyFileName');
    let keyFileBase64 = null;

    // Die Schlüsseldatei ist klein (wenige hundert Byte je Schlüssel) und
    // reist deshalb Base64-kodiert im Header neben der rohen Backup-Datei.
    // 6 KB halten den Header sicher unter nginx' Grenze von 8 KB je Zeile.
    keyFileInput.addEventListener('change', async () => {
      const file = keyFileInput.files[0];
      keyFileBase64 = null;
      keyFileName.textContent = '';
      if (!file) return;
      if (file.size > 6 * 1024) {
        showStatus('error', 'Diese Datei ist zu groß für eine Schlüsseldatei (höchstens 6 KB).');
        return;
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binaer = '';
      for (const b of bytes) binaer += String.fromCharCode(b);
      keyFileBase64 = btoa(binaer);
      keyFileName.textContent = file.name;
    });

    const ohneBackupBtn = document.getElementById('ohneBackupBtn');
    const statusActions = document.getElementById('statusActions');
    let beschaeftigt = false;

    function updateButton() {
      const backupPwOk = !selectedFileEncrypted || backupPassword.value;
      uploadBtn.disabled = beschaeftigt || !selectedFile || !adminPassword.value || !backupPwOk;
      ohneBackupBtn.disabled = beschaeftigt || !adminPassword.value;
    }

    // Verschlüsselte Backups tragen die Magic-Bytes "PBE1" statt Gzips 0x1f 0x8b —
    // rein clientseitig geprüft, um das Passwortfeld nur bei Bedarf einzublenden.
    // Die verbindliche Prüfung passiert serverseitig beim Entschlüsseln.
    async function sniffEncrypted(file) {
      const head = await file.slice(0, 4).arrayBuffer();
      const bytes = new Uint8Array(head);
      return bytes[0] === 0x50 && bytes[1] === 0x42 && bytes[2] === 0x45 && bytes[3] === 0x31; // "PBE1"
    }

    async function setFile(file) {
      if (!file) return;
      selectedFile = file;
      fileNameEl.textContent = file.name;
      dropZone.classList.add('has-file');
      selectedFileEncrypted = await sniffEncrypted(file);
      backupPasswordField.style.display = selectedFileEncrypted ? 'block' : 'none';
      updateButton();
    }

    fileInput.addEventListener('change', () => setFile(fileInput.files[0]));
    adminPassword.addEventListener('input', updateButton);
    backupPassword.addEventListener('input', updateButton);

    dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('over'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('over'));
    dropZone.addEventListener('drop', e => {
      e.preventDefault();
      dropZone.classList.remove('over');
      setFile(e.dataTransfer.files[0]);
    });

    function showStatus(type, msg) {
      statusEl.className = 'status ' + type;
      statusEl.style.display = 'block';
      statusEl.textContent = msg;
    }

    // Während des Neustarts antwortet nginx mit 502/503 statt mit einem
    // Netzwerkfehler. Jede Antwort außer OK zählt deshalb als „noch nicht
    // bereit“; nach 120 s gibt es einen Endzustand mit Ausweg statt einer
    // endlosen Wartemeldung.
    let pollTimer = null;
    function pollUntilReady() {
      const start = Date.now();
      if (pollTimer) clearInterval(pollTimer);
      statusActions.style.display = 'none';
      showStatus('info', 'App startet neu, bitte warten...');
      pollTimer = setInterval(async () => {
        let bereit = false;
        try {
          const r = await fetch('/api/health', { cache: 'no-store' });
          bereit = r.ok;
        } catch (_) { /* Neustart läuft noch */ }
        if (bereit) {
          clearInterval(pollTimer);
          showStatus('success', 'postbuch.net ist bereit. Weiter zur Anmeldung...');
          setTimeout(() => { window.location.href = '/login'; }, 800);
        } else if (Date.now() - start > 120000) {
          clearInterval(pollTimer);
          showStatus('error', 'postbuch.net startet länger als erwartet. Du kannst erneut prüfen oder es direkt mit der Anmeldung versuchen.');
          statusActions.style.display = 'flex';
        }
      }, 2000);
    }

    async function ohneBackupEinrichten() {
      if (!adminPassword.value) return;
      if (!confirm('postbuch.net ohne Backup einrichten? Danach ist das Einspielen eines Backups nur noch über die Einstellungen möglich.')) return;
      beschaeftigt = true;
      updateButton();
      showStatus('info', 'Einrichtung wird vorbereitet...');
      try {
        const res = await fetch('/setup/restore/verlassen', {
          method: 'POST',
          headers: { 'X-Admin-Password': adminPassword.value },
        });
        let data = {};
        try { data = await res.json(); } catch (_) { /* leer */ }
        if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
        showStatus('success', 'Weiter zur Anmeldung. Der Einrichtungsassistent startet nach dem ersten Login.');
        setTimeout(() => { window.location.href = '/login'; }, 1200);
      } catch (err) {
        showStatus('error', 'Fehler: ' + err.message);
        beschaeftigt = false;
        updateButton();
      }
    }

    async function uploadBackup() {
      if (!selectedFile || !adminPassword.value) return;
      if (selectedFileEncrypted && !backupPassword.value) return;
      beschaeftigt = true;
      updateButton();
      progressWrap.style.display = 'block';
      progressBar.style.width = '0%';
      showStatus('info', 'Datei wird hochgeladen...');

      try {
        // Use XHR for upload progress
        await new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('POST', '/setup/restore');
          xhr.setRequestHeader('Content-Type', 'application/octet-stream');
          xhr.setRequestHeader('X-Filename', encodeURIComponent(selectedFile.name));
          xhr.setRequestHeader('X-Admin-Password', adminPassword.value);
          if (backupPassword.value) {
            xhr.setRequestHeader('X-Backup-Passwort', encodeURIComponent(backupPassword.value));
          }
          if (keyFileBase64) {
            xhr.setRequestHeader('X-Backup-Schluesseldatei', keyFileBase64);
          }
          xhr.upload.onprogress = e => {
            if (e.lengthComputable) {
              const pct = Math.round(e.loaded / e.total * 90);
              progressBar.style.width = pct + '%';
              if (pct < 90) showStatus('info', 'Datei wird hochgeladen (' + pct + '%)...');
              else showStatus('info', 'Backup wird eingespielt, bitte warten...');
            }
          };
          xhr.onload = () => {
            progressBar.style.width = '100%';
            if (xhr.status === 200) resolve(JSON.parse(xhr.responseText));
            else {
              let msg = 'Fehler';
              let code = null;
              try {
                const body = JSON.parse(xhr.responseText);
                msg = body.error || msg;
                code = body.code || null;
              } catch (_) {}
              if (code === 'PASSWORT_ERFORDERLICH') {
                selectedFileEncrypted = true;
                backupPasswordField.style.display = 'block';
              }
              if (code === 'BACKUP_PASSWORT_FALSCH') backupPassword.value = '';
              reject(new Error(msg));
            }
          };
          xhr.onerror = () => reject(new Error('Netzwerkfehler'));
          xhr.send(selectedFile);
        });

        document.getElementById('ohneBackup').style.display = 'none';
        showStatus('info', 'Backup eingespielt. App startet neu, bitte warten...');
        setTimeout(pollUntilReady, 3000);
      } catch (err) {
        showStatus('error', 'Fehler: ' + err.message);
        beschaeftigt = false;
        updateButton();
        progressWrap.style.display = 'none';
      }
    }
  </script>
</body>
</html>`;

// ── GET /setup/restore ────────────────────────────────────────────────────────

router.get('/restore', async (req, res) => {
  if (!await isSetupMode()) return res.status(404).send('Not found');
  res.type('html').send(SETUP_HTML);
});

// ── POST /setup/restore ───────────────────────────────────────────────────────

// ── POST /setup/restore/verlassen ─────────────────────────────────────────────
//
// Rückweg für den Fall, dass bei der Installation „Backup einspielen“ gewählt
// wurde, aber keins eingespielt werden soll. Nur solange die Datenbank noch
// keinen Dokumentbestand und keinen Einrichtungszustand hat; die Markierung
// wird erst nach dem COMMIT entfernt, damit ein Fehler dazwischen den
// Restore-Modus nicht ohne vorgemerkten Assistenten beendet.

router.post('/restore/verlassen',
  requireSetupMode,
  setupAuth,
  async (_req, res) => {
    if (restoreInProgress) {
      return res.status(409).json({ error: 'Ein Restore läuft bereits.' });
    }
    restoreInProgress = true;
    let client = null;
    try {
      client = await getClient();
      await client.query('BEGIN');
      const { rows: [stand] } = await client.query(
        `SELECT EXISTS (SELECT 1 FROM postbuch._settings WHERE key = 'einrichtung') AS eingerichtet,
                EXISTS (SELECT 1 FROM postbuch.postbuch) AS bestand`,
      );
      if (stand.eingerichtet || stand.bestand) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'Diese Datenbank ist nicht mehr leer. Der Restore-Modus kann hier nicht ohne Backup verlassen werden.',
        });
      }
      await client.query(
        `INSERT INTO postbuch._settings (key, value)
         VALUES ('einrichtung', $1::jsonb)
         ON CONFLICT (key) DO NOTHING`,
        // Gleiche Form wie der Installationsmarker in seed-settings.js:
        // quelle 'installation' sperrt die Oberfläche bis zum Abschluss.
        [JSON.stringify({ status: 'offen', quelle: 'installation', schritte: {}, eingeladenAm: null, abgeschlossenAm: null })],
      );
      await client.query('COMMIT');
      await rm(FLAG_FILE, { force: true });
      console.log('[setup-restore] Restore-Modus ohne Backup verlassen, Einrichtungsassistent vorgemerkt.');
      res.json({ ok: true });
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      console.error('[setup-restore] Verlassen des Restore-Modus fehlgeschlagen:', err);
      res.status(500).json({ error: 'Restore-Modus konnte nicht verlassen werden. Details stehen im Server-Log.' });
    } finally {
      client?.release();
      restoreInProgress = false;
    }
  },
);

router.post('/restore',
  requireSetupMode,
  setupAuth,
  express.raw({ type: 'application/octet-stream', limit: MAX_COMPRESSED_BYTES }),
  async (req, res) => {
    if (restoreInProgress) {
      return res.status(409).json({ error: 'Ein Restore läuft bereits.' });
    }

    const rawBuffer = req.body;
    if (!Buffer.isBuffer(rawBuffer) || rawBuffer.length < 10) {
      return res.status(400).json({ error: 'Keine oder zu kleine Datei empfangen.' });
    }

    const istGzip = rawBuffer[0] === 0x1f && rawBuffer[1] === 0x8b;
    const istVerschluesselt = isEncryptedBackup(rawBuffer);
    if (!istGzip && !istVerschluesselt) {
      return res.status(400).json({ error: 'Keine gültige .gz-Datei (falscher Magic-Header).' });
    }

    // Hier existiert noch keine _settings/Ablage-Instanz — geprüft wird gegen
    // den in der Datei eingebetteten Header (Passwort zum Erstellungszeitpunkt)
    // und, falls mitgeschickt, gegen die Schlüsseldatei (aktuelles Passwort).
    let compressed = rawBuffer;
    let zusatzDeks = [];
    if (istVerschluesselt) {
      const rawBackupPasswort = req.get('X-Backup-Passwort');
      const backupPasswort = rawBackupPasswort ? decodeURIComponent(rawBackupPasswort) : undefined;
      if (!backupPasswort) {
        return res.status(409).json({
          error: 'Diese Backup-Datei ist verschlüsselt. Backup-Passwort erforderlich.',
          code: 'PASSWORT_ERFORDERLICH',
        });
      }

      const gesperrtFuer = backupPasswortRateLimitGreift(req);
      if (gesperrtFuer) {
        return res.status(429).json({ error: `Zu viele Fehlversuche. Bitte in ${gesperrtFuer}s erneut versuchen.` });
      }

      let sidecar = null;
      const rawSidecar = req.get('X-Backup-Schluesseldatei');
      if (rawSidecar) {
        try {
          sidecar = JSON.parse(Buffer.from(rawSidecar, 'base64').toString('utf8'));
        } catch {
          return res.status(400).json({ error: 'Die Schlüsseldatei ist kein gültiges JSON.' });
        }
        if (!sidecarEintraege(sidecar).length) {
          return res.status(400).json({ error: 'Die Datei enthält keine Backup-Schlüssel (schluessel.json erwartet).' });
        }
      }

      try {
        const ergebnis = await mitPasswortEntschluesseln(rawBuffer, { passwort: backupPasswort, sidecar });
        compressed = ergebnis.daten;
        zusatzDeks = ergebnis.sidecarDeks.map(dek => dek.toString('base64'));
      } catch (err) {
        if (err instanceof BackupPasswortFalschError) {
          backupPasswortFehlversuchVermerken(req);
          return res.status(401).json({
            error: sidecar
              ? 'Backup-Passwort passt weder zu dieser Datei noch zur Schlüsseldatei.'
              : 'Backup-Passwort ist falsch. Mit dem zuletzt gesetzten Passwort bitte zusätzlich die Schlüsseldatei auswählen.',
            code: 'BACKUP_PASSWORT_FALSCH',
          });
        }
        throw err;
      }
    }

    restoreInProgress = true;
    let tempDir = null;

    try {
      tempDir = await mkdtemp('/tmp/postbuch-setup-restore-');
      const tempPath = `${tempDir}/backup.pgdump`;
      const dumpBuffer = await gunzipAsync(compressed, { maxOutputLength: MAX_DUMP_BYTES });
      await writeFile(tempPath, dumpBuffer, { mode: 0o600 });

      const pgEnv = { ...process.env, PGPASSWORD: process.env.POSTGRES_PASSWORD };
      await atomicPgRestore(
        tempPath,
        process.env.POSTGRES_HOST || 'postgres',
        process.env.POSTGRES_PORT || '5432',
        process.env.POSTGRES_USER || 'postbuch',
        process.env.POSTGRES_DB   || 'postbuch',
        pgEnv,
        setupRestoreCleanupSql({ zusatzDeks }),
      );

      await rm(FLAG_FILE, { force: true });

      res.json({ ok: true });
      setTimeout(() => process.exit(0), 1500);
    } catch (err) {
      console.error('[setup-restore] Restore fehlgeschlagen:', err);
      res.status(500).json({ error: 'Restore fehlgeschlagen. Details stehen im Server-Log.' });
    } finally {
      if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      restoreInProgress = false;
    }
  }
);

export default router;
