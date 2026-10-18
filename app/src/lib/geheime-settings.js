/**
 * lib/geheime-settings.js — Welche `_settings`-Schlüssel sind Geheimnisse?
 *
 * Eine Regel für drei Stellen:
 *   - routes/settings.js gibt Geheimnisse nie aus und setzt sie nie generisch.
 *   - jobs/backup.js lässt sie aus unverschlüsselten Backups weg.
 *   - lib/pg-restore.js behält beim Einspielen eines Backups ohne sie die Werte
 *     der laufenden Instanz.
 */

import pool from '../db.js';
import { isProviderKeySetting } from './llm/registry.js';

// Blockliste — der Settings-Router liegt zusätzlich hinter requireAdmin: eine
// vergessene Zeile hier (wie jahrelang bei vapid_private_key) darf kein Geheimnis
// an normale Nutzer ausliefern.
const SECRET_KEY_NAMES = new Set([
  // Kein Geheimnis, aber ausschließlich Eigentum der dedizierten admin-only
  // Einrichtung-Route; niemals als generisches Setting ausgeben/ändern.
  'einrichtung',
  'onedrive_zugriff_umzug',
  'session_secret',
  'onedrive_client_secret',
  'onedrive_tokens',
  'onedrive_auth_state',
  'llm_openai_key',
  'llm_anthropic_key',
  'llm_bedrock_key',
  'llm_claude_oauth_token',
  'discord_webhook_url',
  'discord_bot_token',
  'discord_channel_id',
  'vapid_private_key',
  'webhook_token',
  'scanner_token',
  'nextcloud_app_password',
]);

// Suffixregel ergänzend zur Namensliste. Bewusst ENG gehalten: '_key'/'_token'
// pauschal zu sperren würde vapid_public_key mitnehmen, der absichtlich lesbar
// ist und vom Frontend gebraucht wird. Erfasst auch app_password und die
// Backup-Verschlüsselung (backup_encryption_secret/_passwort).
const SECRET_KEY_SUFFIX_RE = /(^|_)(password|passwort|secret|credentials)$/;

/**
 * Ist dieser Setting-Schlüssel ein Geheimnis?
 *
 * Namensliste PLUS Präfixregel `llm_provider_key_*` (frei konfigurierbare
 * Provider — die Menge ihrer Keys ist zur Übersetzungszeit nicht bekannt).
 */
export function isSecretKey(key) {
  return SECRET_KEY_NAMES.has(key)
    || isProviderKeySetting(key)
    || SECRET_KEY_SUFFIX_RE.test(key);
}

/** Schlüssel, die ein unverschlüsseltes Backup enthalten darf (alle übrigen). */
export async function nichtGeheimeSettingKeys() {
  const { rows } = await pool.query('SELECT key FROM postbuch._settings');
  return rows.map((r) => r.key).filter((k) => !isSecretKey(k));
}

/**
 * Geheimnisse der laufenden Instanz als [{ key, value }] – Grundlage dafür,
 * dass ein Backup ohne Zugangsdaten sie beim Einspielen nicht löscht.
 * vapid_public_key kommt mit: Er gehört zum privaten Schlüssel und muss mit
 * ihm zusammen übernommen werden.
 */
export async function geheimeSettingsDerInstanz() {
  const { rows } = await pool.query('SELECT key, value FROM postbuch._settings');
  return rows
    .filter((r) => isSecretKey(r.key) || r.key === 'vapid_public_key')
    .map((r) => ({ key: r.key, value: r.value }));
}
