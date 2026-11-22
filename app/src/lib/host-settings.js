/**
 * lib/host-settings.js — `_settings`-Schlüssel, die zum Host gehören.
 *
 * Basisadresse, DuckDNS- und Port-Zustand beschreiben, wie DIESER Rechner
 * erreichbar ist (gesetzt von install.sh bzw. dem Host-Agenten), nicht den
 * Datenbestand. Eine Sicherung von einem anderen System brächte sonst dessen
 * Adresse mit: Links in Benachrichtigungen und die OneDrive-Redirect-URI
 * zeigten auf die alte Instanz, der Assistent auf deren Domain.
 * lib/pg-restore.js setzt sie deshalb nach dem Einspielen auf den Stand der
 * laufenden Instanz zurück.
 */

import pool from '../db.js';

export const HOSTGEBUNDENE_SETTINGS = ['app_host', 'hostconfig_duckdns', 'hostconfig_port'];

/**
 * Werte der laufenden Instanz als [{ key, value }]. Was die Instanz nicht hat,
 * erbt sie auch nicht aus der Sicherung (value null = entfernen): Ohne
 * hostconfig_duckdns hat dieser Rechner kein DuckDNS, und für den Port gilt
 * ohnehin WEB_PORT. Nur die Basisadresse darf nicht leer bleiben – sie kommt
 * dann aus APP_BASE_URL, die Installer und Host-Agent für diesen Rechner pflegen.
 */
export async function hostSettingsDerInstanz({ envBasis = process.env.APP_BASE_URL } = {}) {
  const { rows } = await pool.query(
    'SELECT key, value FROM postbuch._settings WHERE key = ANY($1)',
    [HOSTGEBUNDENE_SETTINGS],
  );
  return hostWerte(rows, envBasis);
}

/** Reiner Teil von hostSettingsDerInstanz (testbar ohne Datenbank). */
export function hostWerte(rows, envBasis) {
  const werte = new Map(rows.map((r) => [r.key, r.value]));
  const basis = String(envBasis || '').trim();
  return HOSTGEBUNDENE_SETTINGS.map((key) => {
    let value = werte.has(key) ? werte.get(key) : null;
    if (key === 'app_host' && !String(value ?? '').trim()) value = basis || null;
    return { key, value };
  });
}
