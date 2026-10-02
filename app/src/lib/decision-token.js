/**
 * lib/decision-token.js — HS256 Magic-Link-Token für Duplikat-Entscheidungen
 *
 * Verwendet session_secret aus _settings als Signing-Key.
 * Keine externe JWT-Lib — natives crypto.
 */

import { createHmac } from 'node:crypto';
import { loadDynamicSettings } from '../config.js';

function base64url(str) {
  return Buffer.from(str).toString('base64url');
}

function base64urlDecode(str) {
  return Buffer.from(str, 'base64url').toString('utf8');
}

async function getSecret() {
  const s = await loadDynamicSettings();
  const secret = s.session_secret || process.env.SESSION_SECRET;
  if (!secret) throw new Error('[decision-token] session_secret nicht konfiguriert');
  return String(secret);
}

/**
 * Erstellt ein HS256-Token für eine Duplikat-Entscheidung.
 * @param {object} payload - { jobId: string, exp: number (Unix-Timestamp in Sekunden) }
 * @returns {string} Kompaktes JWT-Token
 */
export async function sign({ jobId, exp }) {
  const secret = await getSecret();
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body   = base64url(JSON.stringify({ jobId, exp }));
  const sig = createHmac('sha256', secret)
    .update(`${header}.${body}`)
    .digest('base64url');
  return `${header}.${body}.${sig}`;
}

/**
 * Verifiziert ein Token und gibt die Payload zurück.
 * @param {string} token
 * @returns {{ jobId: string, exp: number }}
 * @throws Wenn Signatur ungültig oder Token abgelaufen
 */
export async function verify(token) {
  if (!token || typeof token !== 'string') throw new Error('Kein Token');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Ungültiges Token-Format');
  const [header, body, sig] = parts;

  const secret = await getSecret();
  const expectedSig = createHmac('sha256', secret)
    .update(`${header}.${body}`)
    .digest('base64url');

  if (sig !== expectedSig) throw new Error('Ungültige Token-Signatur');

  const payload = JSON.parse(base64urlDecode(body));
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error('Token abgelaufen');
  }
  return payload;
}
