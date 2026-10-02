/**
 * lib/app-version.js — die eigene Version, zur Laufzeit
 *
 * Bis 2.1.x kannte das Backend seine Version gar nicht: `VERSION` wird nur zu
 * Buildzeit ins Frontend gebacken (`__APP_VERSION__`), und im Archiv-Export
 * stand deshalb dauerhaft `appVersion: null`. Für den Update-Check ist das die
 * halbe Miete — ohne installierte Version gibt es nichts zu vergleichen.
 *
 * Zwei Quellen, in dieser Reihenfolge:
 *   1. ENV `APP_VERSION` (setzt der Update-Agent/Installer, wenn er will)
 *   2. Datei `/app/VERSION` — beim Image-Build aus dem per `.dockerignore`
 *      streng begrenzten Root-Buildkontext kopiert (siehe app/Dockerfile).
 *
 * Einmal gelesen und gecacht: die Datei ändert sich innerhalb eines
 * Container-Lebens nicht (ein Update erzeugt neue Container).
 */

import { readFileSync } from 'node:fs';

const SEMVER_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const VERSION_PFAD = process.env.APP_VERSION_FILE || '/app/VERSION';

let _cache;   // undefined = noch nicht gelesen, null = nicht ermittelbar

/**
 * @returns {string|null} z. B. "2.2.0", oder null wenn nicht ermittelbar
 */
export function appVersion() {
  if (_cache !== undefined) return _cache;

  const ausEnv = String(process.env.APP_VERSION || '').trim();
  if (SEMVER_RE.test(ausEnv)) {
    _cache = ausEnv;
    return _cache;
  }

  try {
    const roh = readFileSync(VERSION_PFAD, 'utf8').trim();
    _cache = SEMVER_RE.test(roh) ? roh : null;
    if (!_cache) console.warn(`[app-version] "${VERSION_PFAD}" enthält kein Semver: ${roh.slice(0, 40)}`);
  } catch {
    // Kein Fehler, sondern der erwartete Zustand auf einer Instanz, deren
    // docker-compose.yml den Mount noch nicht hat (Henne-Ei beim Erstupdate).
    _cache = null;
  }
  return _cache;
}

/** Nur für Tests: erzwingt erneutes Lesen. */
export function resetAppVersionCache() {
  _cache = undefined;
}
