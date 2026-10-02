/**
 * lib/cache-mode.js — Cache-Mode-Status für die Batch-Verarbeitung.
 *
 * Der Cache-Mode bündelt mehrere Dokumente auf EIN fixes Klassifikationsmodell
 * (Leicht/Mittel/Schwer), damit der gecachte System-Prompt-Prefix modellkonstant
 * wiederverwendet wird (Anthropic/Bedrock/OpenAI mit dynamischem Fallback). Er
 * gilt global für ALLE Eingänge (Import-Seite, Scanner, OneDrive, extern), weil
 * jede Verarbeitung durch analyzeDocument() läuft.
 *
 * Zustand liegt in _settings:
 *   llm_cache_mode_enabled : bool  — wird der Mode überhaupt angeboten? (Optionen → KI)
 *   llm_cache_mode         : { active, tier, activated_at, last_activity_at }
 *
 * Auto-Reset: nach 15 Minuten ohne verarbeitetes Dokument (last_activity_at) gilt der
 * Mode als inaktiv. Durchgesetzt wird das lazy in activeCacheTier() (Quelle der
 * Wahrheit fürs Routing); ein Minuten-Cron (jobs/cache-mode-reaper.js) flippt zusätzlich
 * das persistierte `active`-Flag, damit der UI-Status ohne Polling stimmt.
 *
 * Auto-Modus (zusätzlich, unabhängig vom manuellen "anbieten"-Flag):
 *   llm_cache_mode_auto      : bool   — automatisches Anspringen aktiv?
 *   llm_cache_mode_auto_tier : string — Tier-Vorgabe für die Auto-Aktivierung
 * Der Trigger (noteDocumentArrival) springt an, sobald ein Batch ≥2 Dokumente eingeht
 * ODER innerhalb von 5 Minuten ein zweites Einzeldokument eintrifft. Aktiviert wird mit
 * source:'auto' und derselbe 15-Min-Idle-Reset greift wie beim manuellen Mode.
 */

import pool from '../db.js';
import { appLog } from '../app-log.js';

export const CACHE_MODE_TIMEOUT_MS = 15 * 60 * 1000; // 15 Minuten Inaktivität
export const CACHE_MODE_AUTO_WINDOW_MS = 5 * 60 * 1000; // 2 Doks in 5 Min → Auto-Start
export const CACHE_TIERS = ['leicht', 'mittel', 'schwierig'];

// In-Memory-Zeitstempel des letzten gezählten Dokument-Eingangs (Single-Process-App).
// Nur für die "2 in 5 Min"-Erkennung im Auto-Modus; nicht persistiert.
let _lastArrivalAt = 0;

const SETTING_KEY_KEY_TO_MODEL = {
  leicht:    'llm_model_leicht',
  mittel:    'llm_model_mittel',
  schwierig: 'llm_model_schwierig',
};

async function readSetting(key) {
  const r = await pool.query('SELECT value FROM _settings WHERE key = $1', [key]);
  return r.rows[0]?.value ?? null;
}

async function writeSetting(key, value) {
  await pool.query(
    `INSERT INTO _settings (key, value, updated_at)
       VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = NOW()`,
    [key, JSON.stringify(value)],
  );
}

function isExpired(state) {
  if (!state?.active) return true;
  const last = state.last_activity_at ? Date.parse(state.last_activity_at) : 0;
  if (!last) return false; // gerade aktiviert, noch keine Aktivität
  return Date.now() - last > CACHE_MODE_TIMEOUT_MS;
}

// Löst aus den Settings den konkreten Modellnamen eines Tiers auf (für die UI-Anzeige
// "Mittel (claude-sonnet-4-6)"). Akzeptiert String- und {provider,model}-Schema.
function resolveTierModel(settings, tier) {
  const val = settings?.[SETTING_KEY_KEY_TO_MODEL[tier]];
  if (!val) return null;
  if (typeof val === 'object') return val.model || null;
  return String(val);
}

/**
 * Liefert den gesamten Cache-Mode-Status für die UI.
 * @param {object} [settings] - bereits geladene Settings (für Modell-Namen)
 */
export async function getCacheMode(settings = null) {
  const enabled  = (await readSetting('llm_cache_mode_enabled')) === true;
  const auto     = (await readSetting('llm_cache_mode_auto')) === true;
  const autoTier = (await readSetting('llm_cache_mode_auto_tier')) || 'mittel';
  const state = (await readSetting('llm_cache_mode')) || {};
  const expired = isExpired(state);
  // Aktiv ist der Mode, wenn ER ÜBERHAUPT erlaubt ist (manuell angeboten ODER Auto an).
  const active = (enabled || auto) && state.active === true && !expired;
  const tier = active ? state.tier : null;
  const last = state.last_activity_at ? Date.parse(state.last_activity_at) : null;
  const expiresAt = active && last ? new Date(last + CACHE_MODE_TIMEOUT_MS).toISOString() : null;
  return {
    enabled,   // steuert die Sichtbarkeit des Import-Panels (manuelles Anbieten)
    auto,
    autoTier: CACHE_TIERS.includes(autoTier) ? autoTier : 'mittel',
    active,
    tier,
    source: active ? (state.source || 'manual') : null,
    tierModel: tier && settings ? resolveTierModel(settings, tier) : null,
    activatedAt: state.activated_at || null,
    lastActivityAt: state.last_activity_at || null,
    expiresAt,
  };
}

/**
 * Routing-Quelle der Wahrheit: gibt den aktiven Tier zurück oder null.
 * Setzt bei abgelaufenem Mode `active=false` lazy zurück.
 */
export async function activeCacheTier() {
  // Routing greift, wenn der Mode erlaubt ist — manuell angeboten ODER Auto-Modus an.
  const enabled = (await readSetting('llm_cache_mode_enabled')) === true;
  const auto    = (await readSetting('llm_cache_mode_auto')) === true;
  if (!enabled && !auto) return null;
  const state = (await readSetting('llm_cache_mode')) || {};
  if (state.active !== true) return null;
  if (isExpired(state)) {
    await writeSetting('llm_cache_mode', { ...state, active: false });
    return null;
  }
  return CACHE_TIERS.includes(state.tier) ? state.tier : null;
}

/**
 * Aktualisiert den Inaktivitäts-Timer. Wird pro verarbeitetem Dokument im
 * Cache-Mode aufgerufen. No-op wenn der Mode nicht aktiv ist.
 */
export async function touchCacheMode() {
  const state = (await readSetting('llm_cache_mode')) || {};
  if (state.active !== true) return;
  await writeSetting('llm_cache_mode', { ...state, last_activity_at: new Date().toISOString() });
}

/**
 * Schaltet den Cache-Mode an/aus und setzt den Tier. Validiert gegen das
 * "angeboten?"-Flag und gültige Tiers.
 */
export async function setCacheMode({ active, tier }) {
  const enabled = (await readSetting('llm_cache_mode_enabled')) === true;
  if (active && !enabled) {
    throw new Error('Cache-Mode ist in den KI-Optionen nicht aktiviert.');
  }
  if (active && !CACHE_TIERS.includes(tier)) {
    throw new Error(`Ungültiger Tier "${tier}". Erlaubt: ${CACHE_TIERS.join(', ')}.`);
  }
  const now = new Date().toISOString();
  const state = active
    ? { active: true, tier, activated_at: now, last_activity_at: now, source: 'manual' }
    : { active: false, tier: tier || null, activated_at: null, last_activity_at: null, source: null };
  await writeSetting('llm_cache_mode', state);
  return state;
}

/** Setzt das "angeboten?"-Flag. Beim Deaktivieren wird ein laufender Mode gestoppt. */
export async function setCacheModeEnabled(enabled) {
  await writeSetting('llm_cache_mode_enabled', enabled === true);
  if (enabled !== true) {
    const state = (await readSetting('llm_cache_mode')) || {};
    if (state.active) await writeSetting('llm_cache_mode', { ...state, active: false });
  }
}

/**
 * Auto-Trigger: meldet den Eingang eines (oder mehrerer) Dokumente. Wird zentral aus
 * der pipeline-queue für jeden gezählten Eingang aufgerufen (Neuzugänge + Reprocessing;
 * Duplikat-Resumes zählen NICHT).
 *
 * Logik:
 *   • Auto-Modus aus → No-op (und Fenster zurücksetzen).
 *   • batchSize ≥ 2  → Schwung: sofort aktivieren, damit schon das ERSTE Dokument cacht.
 *   • Einzeldokument → nur aktivieren, wenn der vorige Eingang < 5 Min zurückliegt.
 *
 * @param {object}  [opts]
 * @param {number}  [opts.batchSize=1] - Anzahl gleichzeitig übergebener Dokumente.
 */
export async function noteDocumentArrival({ batchSize = 1 } = {}) {
  let auto;
  try {
    auto = (await readSetting('llm_cache_mode_auto')) === true;
  } catch {
    return; // Settings nicht lesbar → still ignorieren, nie die Pipeline stören
  }
  if (!auto) { _lastArrivalAt = 0; return; }

  const now = Date.now();
  const prev = _lastArrivalAt;
  _lastArrivalAt = now;

  const batch = Number(batchSize) >= 2;
  const within = prev > 0 && (now - prev) <= CACHE_MODE_AUTO_WINDOW_MS;
  if (!batch && !within) return; // erstes Einzeldokument oder Fenster zu alt → noch nicht

  const tierSetting = await readSetting('llm_cache_mode_auto_tier');
  const tier = CACHE_TIERS.includes(tierSetting) ? tierSetting : 'mittel';
  await autoActivateCacheMode(tier, batch ? `Batch (${batchSize} Dokumente)` : '2 Dokumente in 5 Min');
}

/**
 * Aktiviert den Cache-Mode automatisch mit dem Auto-Tier. No-op, wenn der Mode bereits
 * läuft (manuell oder auto) — ein laufender manueller Mode wird nicht überschrieben.
 * @returns {Promise<boolean>} true, wenn jetzt frisch aktiviert wurde.
 */
export async function autoActivateCacheMode(tier, reason = '') {
  if (!CACHE_TIERS.includes(tier)) return false;
  if ((await readSetting('llm_cache_mode_auto')) !== true) return false;
  const state = (await readSetting('llm_cache_mode')) || {};
  if (state.active === true && !isExpired(state)) return false; // läuft bereits
  const now = new Date().toISOString();
  await writeSetting('llm_cache_mode', {
    active: true, tier, activated_at: now, last_activity_at: now, source: 'auto',
  });
  try {
    await appLog('INFO', 'cache-mode', `Cache-Mode automatisch aktiviert (${tier})${reason ? ` — ${reason}` : ''}`);
  } catch { /* Logging nie fatal */ }
  return true;
}

/**
 * Stoppt einen AUTO-gestarteten Cache-Mode (z.B. wenn der Auto-Schalter ausgeht).
 * Ein manuell gestarteter Mode bleibt unberührt.
 */
export async function stopAutoCacheMode() {
  const state = (await readSetting('llm_cache_mode')) || {};
  if (state.active === true && state.source === 'auto') {
    await writeSetting('llm_cache_mode', { ...state, active: false });
    return true;
  }
  return false;
}

/** Cron-Helfer: flippt ein abgelaufenes `active`-Flag auf false (rein kosmetisch). */
export async function reapCacheMode() {
  const state = (await readSetting('llm_cache_mode')) || {};
  if (state.active === true && isExpired(state)) {
    await writeSetting('llm_cache_mode', { ...state, active: false });
    return true;
  }
  return false;
}
