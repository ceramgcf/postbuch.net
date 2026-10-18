/**
 * lib/scanner-dienst.js — Aufrufe an den Scanner-Dienst und dessen Token.
 *
 * Der Scanner-Dienst (scanner/scan_service.py) nimmt /scan/* nur mit gültigem
 * scanner_token an (Header X-Scanner-Token oder Query-Parameter token). Der Wert
 * liegt in _settings, der Scanner bezieht ihn über /api/internal/config.
 */

import { randomBytes } from 'node:crypto';
import pool from '../db.js';
import { loadDynamicSettings } from '../config.js';

export const SCANNER_URL = process.env.SCANNER_URL || 'http://scanner:8080';

/** Aktueller scanner_token oder null. */
export async function getScannerToken() {
  const s = await loadDynamicSettings();
  return typeof s.scanner_token === 'string' && s.scanner_token ? s.scanner_token : null;
}

/** Erzeugt einen neuen scanner_token; alte Webhook-URLs werden damit ungültig. */
export async function erneuereScannerToken() {
  const token = randomBytes(32).toString('hex');
  await pool.query(
    `INSERT INTO _settings (key, value) VALUES ('scanner_token', $1::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify(token)],
  );
  return token;
}

/**
 * fetch gegen den Scanner-Dienst mit Token-Header.
 * @param {string} pfadMitQuery z. B. '/scan/adf/simplex?dpi=300'
 */
export async function scannerFetch(pfadMitQuery, options = {}) {
  const token = await getScannerToken();
  const headers = { ...(options.headers || {}) };
  if (token) headers['X-Scanner-Token'] = token;
  return fetch(`${SCANNER_URL}${pfadMitQuery}`, { ...options, headers });
}
