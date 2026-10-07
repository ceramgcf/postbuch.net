/**
 * routes/settings.js — Settings-Endpunkte (ADMIN-ONLY)
 *
 * Der komplette Router hängt in index.js hinter `requireAdmin`. Hier stehen
 * API-Keys, OneDrive-Credentials, Discord-Token und der Ordner-Umzug — alles
 * Dinge, mit denen sich die gesamte Dokumentenverarbeitung umleiten ließe.
 * Was auch Nicht-Admins brauchen, steht in routes/settings-public.js.
 *
 * Implementiert:
 *   GET  /api/settings                                → alle non-secret Settings
 *   PUT  /api/settings/:key                           → einzelne Einstellung ändern (Whitelist)
 *   GET  /api/settings/onedrive-status                → OneDrive-Verbindungsstatus (Legacy)
 *   POST /api/settings/onedrive-folders/setup-wizard  → Ordnerstruktur erstellen (+ Datei-Umzug)
 *   POST /api/settings/onedrive-folders/relocate-all  → Manueller Gesamt-Umzug
 *   POST /api/settings/scanner/capabilities           → Gerätefähigkeiten ermitteln + speichern
 */

import { Router } from 'express';
import {
  loadDynamicSettings, getFolders, getActiveBackendName, getAblageStruktur, getAblageEbenen,
  normalisiereAblageEbenen, ABLAGE_VORLAGEN, ABLAGE_PERSON_QUELLEN, getAblagePersonQuelle,
} from '../config.js';
import db from '../db.js';
import { appLog } from '../app-log.js';
import { syncWithSettings as syncDiscordGateway } from '../lib/discord-gateway.js';
import { sendMessage as sendDiscordMessage } from '../lib/discord.js';
import * as onedriveAuth from '../lib/storage/onedrive.js';
import * as nextcloud from '../lib/storage/nextcloud.js';
import { getActiveAdapter, getAdapter, BACKENDS } from '../lib/storage/index.js';
import {
  setupFolderStructure, SYSTEM_FOLDERS, ermittleWurzelPfad, GEMEINSAM_ORDNER, OHNE_DATUM_ORDNER, RICHTUNG_ORDNER,
} from '../service/storage-setup.js';
import { getAktiveTaxonomie, getGesamteTaxonomie } from '../lib/taxonomie.js';
import { raeumeFremdeStrukturAuf } from '../service/storage-legacy-cleanup.js';
import { getOffenenLauf } from '../service/storage-migration.js';
import { runAdapterConformance } from '../service/storage-selftest.js';
import nextcloudRouter from './settings-nextcloud.js';
import migrationRouter from './settings-migration.js';
import { relocateAllDocuments, istUmzugAktiv } from '../service/storage-relocate.js';
import { scanForMissingFiles } from '../service/storage-scan.js';
import * as pipelineQueue from '../jobs/pipeline-queue.js';
import * as tracker from '../jobs/tracker.js';
import {
  startPolling as startOnedrivePolling,
  stopPolling as stopOnedrivePolling,
} from '../service/onedrive-watcher.js';
import { stopAutoCacheMode } from '../lib/cache-mode.js';
import { holeScannerCapabilities, normalisiereScannerEndpoint } from '../lib/scanner-capabilities.js';
import { scannerProfilAutoSchalten } from '../service/host-agent.js';
import {
  findeScannerImCidr, bauCidr, netzVorschlagAusIp,
} from '../service/scanner-discovery.js';
import { leseAgentStatus } from '../lib/update-agent-datei.js';
import { subscriptionFeatureUnlocked, testClaudeSubscription } from '../lib/claude-subscription.js';
import { buildAiHealth, invalidateAiHealthCache, listProviderModels } from '../lib/ai-health.js';
import { MODEL_CLASSES } from '../lib/llm/model-classes.js';
import { cloudfreiBericht } from '../lib/cloudfrei.js';
import { webpushErlaubt, setzeWebpushErlaubt, ermittlePushEmpfaenger } from '../lib/webpush.js';
import * as empfehlungen from '../lib/llm/empfehlungen.js';
import { resolveModelConfig } from '../lib/llm.js';
import {
  listProviders, getProvider, providerKeySetting, isProviderKeySetting,
  PROVIDER_ID_RE, PROVIDER_TYPES, PROVIDER_PRESETS, BUILTIN_PROVIDER_IDS,
  defaultCapsForType, CAP_KEYS, normalizeRasterMaxSeiten, RASTER_MAX_SEITEN_GRENZE,
  normalizeMaxOutputTokens, MAX_OUTPUT_TOKENS_MIN, MAX_OUTPUT_TOKENS_GRENZE,
} from '../lib/llm/registry.js';
// Nur für die Anzeige des Standardwerts im Provider-Dialog: der Default gehört
// dem Rasterizer, nicht der Provider-Registry.
import { RASTER_MAX_SEITEN } from '../lib/pdf.js';
import { clientSafeError } from '../lib/net-guard.js';
import {
  embeddingConfig, probeEmbeddingDimension, signatureOf, STORAGE_DIM,
} from '../lib/embedding.js';
import { getHelpEmbeddingStatus, startHelpEmbeddingJob } from '../service/help-corpus.js';
import { buildLxdClassificationPrompt } from '../prompts/classification-lxd.js';
import { PRE_ANALYSIS_SYSTEM_PROMPT, PRE_ANALYSIS_USER_MESSAGE } from '../prompts/pre-analysis.js';
import { buildEbParsePrompt, buildMatchKuerzungenPrompt } from '../prompts/erstattungsbescheid.js';

const router = Router();

// Keys die niemals an das Frontend zurückgegeben werden (Secrets).
// Blockliste — deshalb liegt der Router zusätzlich hinter requireAdmin: eine
// vergessene Zeile hier (wie jahrelang bei vapid_private_key) darf kein Geheimnis
// mehr an normale Nutzer ausliefern.
const SECRET_KEY_NAMES = new Set([
  // Kein Geheimnis, aber ausschließlich Eigentum der dedizierten admin-only
  // Einrichtung-Route; niemals als generisches Setting ausgeben/ändern.
  'einrichtung',
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
  'nextcloud_app_password',
]);

// Suffixregel ergaenzend zur Namensliste. Bewusst ENG gehalten: '_key'/'_token'
// pauschal zu sperren wuerde vapid_public_key mitnehmen, der absichtlich lesbar
// ist und vom Frontend gebraucht wird.
const SECRET_KEY_SUFFIX_RE = /(^|_)(password|passwort|secret|credentials)$/;

/**
 * Ist dieser Setting-Schlüssel ein Geheimnis?
 *
 * Namensliste PLUS Präfixregel `llm_provider_key_*` (frei konfigurierbare
 * Provider — die Menge ihrer Keys ist zur Übersetzungszeit nicht bekannt).
 * Wird bei GET **und** bei PUT eingesetzt: nur bei GET eingebaut hieße, dass
 * jeder Admin-Aufruf beliebige fremde Keys überschreiben könnte.
 */
function isSecretKey(key) {
  return SECRET_KEY_NAMES.has(key)
    || isProviderKeySetting(key)
    || SECRET_KEY_SUFFIX_RE.test(key);
}

// Keys, die über PUT /:key gesetzt werden dürfen — **Whitelist**.
// Vorher galt nur die SECRET_KEYS-Blockliste, d. h. jeder beliebige Key war
// setzbar, auch `app_admin_username`. Neue Einstellungen müssen hier bewusst
// eingetragen werden.
const ALLOWED_SETTING_KEYS = new Set([
  // Allgemein
  'instance_name',
  'app_host',
  'nav_visibility',
  'pipeline_max_parallel',
  // Salden-Quellen (freies SQL, ob an ein Dokument oder eine Dokumentklasse
  // gebunden) sind ein undokumentiertes Experten-Feature, per Default
  // deaktiviert (außer bei Altinstanzen mit bereits bestehenden Quellen).
  'salden_quellen_aktiv',
  // OneDrive
  'onedrive_polling',
  // KI: Modellwahl je Stufe
  'llm_model_preanalysis',
  'llm_model_large',
  'llm_model_leicht',
  'llm_model_mittel',
  'llm_model_schwierig',
  'llm_model_fallback',
  'chat_model_research',
  'chat_model_synthesis',
  'chat_model_title',
  'akte_model_vorschlag',
  // KI: Provider-Registry und Embeddings stehen hier BEWUSST NICHT.
  // Sie brauchen semantische Prüfung und liefen über den generischen PUT sonst
  // daran vorbei:
  //   llm_providers → normalisiereProviderEingabe() (Protokoll-Whitelist,
  //     Verbot von user:pass@ in der URL, Typ-Sperre für Built-ins, Label-Cap)
  //     — und `erlaubtPrivateZiele: true` wäre für alle Provider auf einmal
  //     setzbar gewesen.
  //   llm_embedding → probeEmbeddingDimension(). Eine erfundene `dim` erzeugt
  //     eine falsche embedding_signature und vergiftet still jede Vektorsuche.
  // Geschrieben wird ausschließlich über PUT /ai/providers/:id bzw. /ai/embedding.
  'llm_allow_private_targets',
  // KI: deaktivierter Rueckweg zum frueheren Online-Empfehlungsfeed. Der Cache
  // (llm_empfehlungen_cache) und der
  // Rückweg-Snapshot (llm_empfehlungen_snapshot) stehen hier BEWUSST NICHT:
  // sie tragen validierten Feed-Inhalt bzw. den Vorzustand der Modellwahl und
  // werden ausschließlich von Job und Empfehlungs-Routen geschrieben — aus
  // demselben Grund, aus dem llm_providers und llm_embedding hier fehlen.
  'llm_empfehlungen_abo',
  'llm_empfehlungen_auto',
  // Update-Prüfung. Der Cache update_status wird nur vom Job/der Route
  // geschrieben und steht deshalb ebenfalls nicht hier.
  'update_check_enabled',
  // Ablage: die uebrigen nextcloud_*-Keys stehen bewusst NICHT hier — sie
  // brauchen semantische Pruefung (URL-Form, Protokoll gegen Zielart) und
  // laufen deshalb ueber PUT /api/settings/nextcloud/config.
  'storage_allow_private_targets',
  // KI: Verhalten
  'classification_custom_rules',
  'llm_claude_subscription_enabled',
  'llm_cache_mode_enabled',
  'llm_cache_mode_auto',
  'llm_cache_mode_auto_tier',
  // Duplikaterkennung
  'duplicate_embedding_threshold',
  'duplicate_decision_timeout_min',
  // Scanner
  'scanner_device_url',
  'scanner_default_dpi',
  'scanner_default_mode',
  'scanner_has_adf',
  'scanner_supports_a3',
  'scanner_adf_duplex',
  // Cleaner (OCR/Bildbereinigung)
  'cleaner_ocr_enabled',
  'cleaner_ocr_langs',
  'cleaner_ocr_jobs',
  'cleaner_blank_mean_min',
  'cleaner_blank_stddev_max',
  'cleaner_blank_mean_min_single',
  'cleaner_blank_stddev_max_single',
  'cleaner_blank_content_threshold',
  'cleaner_blank_mask_max_content_px',
  'cleaner_crop_enabled',
  'cleaner_detect_dpi',
  'cleaner_content_threshold',
  'cleaner_content_denoise_min_px',
]);

// Kosten pro Modell werden dynamisch je Modell-ID abgelegt (llm_cost_<model-id>).
// Modell-IDs enthalten Punkte, Doppelpunkte und Bindestriche (z. B.
// "llm_cost_eu.anthropic.claude-haiku-4-5-20251001-v1:0").
const ALLOWED_SETTING_KEY_PATTERNS = [
  /^llm_cost_[A-Za-z0-9._:-]{1,120}$/,
];

function isAllowedSettingKey(key) {
  return ALLOWED_SETTING_KEYS.has(key)
    || ALLOWED_SETTING_KEY_PATTERNS.some((re) => re.test(key));
}

async function upsertSetting(key, value) {
  await db.query(
    `INSERT INTO postbuch._settings (key, value, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = NOW()`,
    [key, JSON.stringify(value)]
  );
}

// ── GET /api/settings ────────────────────────────────────────────────────────
// Gibt alle non-secret Settings zurück.

router.get('/', async (req, res) => {
  try {
    const rows = await db.query('SELECT key, value, updated_at FROM postbuch._settings ORDER BY key');
    const result = {};
    for (const r of rows.rows) {
      if (!isSecretKey(r.key)) {
        result[r.key] = { value: r.value, updatedAt: r.updated_at };
      }
    }
    res.json(result);
  } catch (err) {
    console.error('[settings] GET / Fehler:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/settings/onedrive/credentials ────────────────────────────────
// Liefert OneDrive-App-Credentials ohne Secret-Wert.

router.get('/onedrive/credentials', async (_req, res) => {
  try {
    const settings = await loadDynamicSettings();
    const secretRow = await db.query(
      `SELECT EXISTS (
         SELECT 1
         FROM postbuch._settings
         WHERE key = 'onedrive_client_secret'
           AND COALESCE(NULLIF(value::text, '""'), 'null') <> 'null'
       ) AS has_secret`
    );

    res.json({
      clientId: settings.onedrive_client_id || '',
      tenantId: settings.onedrive_tenant_id || '',
      clientSecretExpiresAt: settings.onedrive_client_secret_expires_at || null,
      hasClientSecret: !!secretRow.rows[0]?.has_secret,
    });
  } catch (err) {
    console.error('[settings] onedrive/credentials GET Fehler:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/settings/onedrive/credentials ────────────────────────────────
// Aktualisiert OneDrive-App-Credentials inkl. Secret.
// Body: { clientId: string, tenantId?: string, clientSecret?: string }

router.put('/onedrive/credentials', async (req, res) => {
  const { clientId, tenantId, clientSecret, clientSecretExpiresAt } = req.body || {};

  if (typeof clientId !== 'string' || !clientId.trim()) {
    return res.status(400).json({ error: '"clientId" fehlt oder ist leer.' });
  }
  if (tenantId !== undefined && tenantId !== null && typeof tenantId !== 'string') {
    return res.status(400).json({ error: '"tenantId" muss ein String sein.' });
  }
  if (clientSecret !== undefined && clientSecret !== null && typeof clientSecret !== 'string') {
    return res.status(400).json({ error: '"clientSecret" muss ein String sein.' });
  }
  if (clientSecretExpiresAt !== undefined && clientSecretExpiresAt !== null
      && clientSecretExpiresAt !== '' && Number.isNaN(Date.parse(clientSecretExpiresAt))) {
    return res.status(400).json({ error: 'Das Ablaufdatum des Client-Secrets ist ungültig.' });
  }

  try {
    await upsertSetting('onedrive_client_id', clientId.trim());

    const tenant = (tenantId || '').trim();
    if (tenant) {
      await upsertSetting('onedrive_tenant_id', tenant);
    } else {
      await db.query(`DELETE FROM postbuch._settings WHERE key = 'onedrive_tenant_id'`);
    }

    const secret = (clientSecret || '').trim();
    if (secret) {
      await upsertSetting('onedrive_client_secret', secret);
    }
    if (clientSecretExpiresAt !== undefined) {
      if (clientSecretExpiresAt) await upsertSetting('onedrive_client_secret_expires_at', clientSecretExpiresAt);
      else await db.query("DELETE FROM postbuch._settings WHERE key = 'onedrive_client_secret_expires_at'");
    }

    // Neue Credentials müssen sofort greifen.
    onedriveAuth.resetMsalClient();

    appLog('INFO', 'settings', 'OneDrive-App-Credentials aktualisiert', {
      entity: 'settings',
      entityId: req.session?.username || null,
    });

    const secretRow = await db.query(
      `SELECT EXISTS (
         SELECT 1
         FROM postbuch._settings
         WHERE key = 'onedrive_client_secret'
           AND COALESCE(NULLIF(value::text, '""'), 'null') <> 'null'
       ) AS has_secret`
    );

    res.json({
      ok: true,
      clientId: clientId.trim(),
      tenantId: tenant,
      clientSecretExpiresAt: clientSecretExpiresAt || null,
      hasClientSecret: !!secretRow.rows[0]?.has_secret,
    });
  } catch (err) {
    console.error('[settings] onedrive/credentials PUT Fehler:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/settings/onedrive/auth-mode ───────────────────────────────────
// Wählt den OneDrive-Verbindungsweg: 'legacy' (eigene App mit Client-ID +
// Secret + Redirect-URI) oder 'device' (Standard: eigene App, nur Client-ID,
// Device-Code-Flow). Kein Geheimnis — der Wert ist über GET /api/settings
// lesbar. Bewusst eigener Endpunkt statt generischem PUT, weil der Wert gegen
// eine feste Menge geprüft werden muss. Router liegt hinter requireAdmin.
router.put('/onedrive/auth-mode', async (req, res) => {
  const { mode } = req.body || {};
  if (mode !== 'legacy' && mode !== 'device') {
    return res.status(400).json({ error: '"mode" muss "legacy" oder "device" sein.' });
  }
  try {
    const aktuell = await loadDynamicSettings();
    const aktuellerModus = aktuell.onedrive_auth_mode
      || (aktuell.onedrive_tokens ? 'legacy' : 'device');
    if (aktuell.onedrive_tokens && aktuellerModus !== mode) {
      return res.status(409).json({
        error: 'Eine bestehende OneDrive-Verbindung kann nicht automatisch zwischen den Anmeldewegen wechseln. Bitte zuerst bewusst trennen und danach neu verbinden.',
        code: 'ONEDRIVE_RECONNECT_REQUIRED',
      });
    }
    await upsertSetting('onedrive_auth_mode', mode);
    // Moduswechsel: MSAL-Clients verwerfen, damit der nächste Token-Zugriff den
    // passenden Client-Typ neu aufbaut.
    onedriveAuth.resetMsalClient();
    res.json({ ok: true, mode });
  } catch (err) {
    console.error('[settings] onedrive/auth-mode PUT Fehler:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/settings/storage/initial-backend ───────────────────────────────
// Einmalige Wahl auf einer wirklich leeren Instanz. Danach ist jeder Wechsel
// ausschließlich eine Migration; so kann der Assistent kein belegtes Backend
// ohne Kopie/Prüfung umschalten.
router.put('/storage/initial-backend', async (req, res) => {
  const backend = req.body?.backend;
  if (!['onedrive', 'nextcloud'].includes(backend)) {
    return res.status(400).json({ error: 'Backend muss "onedrive" oder "nextcloud" sein.' });
  }
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const auswahl = await client.query(
      `SELECT key, value FROM postbuch._settings
        WHERE key IN ('storage_backend', 'storage_backend_selected')
        FOR UPDATE`,
    );
    const bereitsGewaehlt = auswahl.rows
      .some((row) => row.key === 'storage_backend_selected' && row.value === true);
    if (bereitsGewaehlt) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Das anfängliche Ablage-Backend wurde bereits gewählt. Bitte den geführten Ablage-Umzug verwenden.' });
    }
    const { rows: [{ anzahl }] } = await client.query(
      `SELECT (SELECT count(*) FROM postbuch.postbuch)
            + (SELECT count(*) FROM postbuch._pipeline_suspensions)
            + (SELECT count(*) FROM postbuch._failed_documents) AS anzahl`,
    );
    const ordner = await client.query(
      "SELECT 1 FROM postbuch._settings WHERE key = 'storage_folders'",
    );
    if (Number(anzahl) > 0 || ordner.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Die Instanz ist nicht mehr leer. Bitte den geführten Ablage-Umzug verwenden.' });
    }
    await client.query(
      `INSERT INTO postbuch._settings (key, value, updated_at)
       VALUES ('storage_backend', $1::jsonb, NOW()), ('storage_backend_selected', 'true'::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [JSON.stringify(backend)],
    );
    await client.query('COMMIT');
    res.json({ ok: true, backend });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ── DELETE /api/settings/storage/initial-backend ────────────────────────────
// Der Rückweg zur Auswahl. Ein Klick im Einrichtungsassistenten darf keine
// Sackgasse sein, solange er folgenlos war: nichts verbunden, keine Ordner
// angelegt, kein Dokument vorhanden. Genau dann — und nur dann — wird die
// Markierung wieder entfernt und der Assistent zeigt die Auswahl erneut.
// Die Bedingungen sind bewusst dieselben wie im PUT, plus „nicht verbunden":
// eine hinterlegte Zugangsdatenkombination ist bereits mehr als ein Fehlklick.
router.delete('/storage/initial-backend', async (_req, res) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT key, value FROM postbuch._settings
        WHERE key IN ('storage_backend', 'storage_backend_selected', 'storage_folders',
                      'onedrive_tokens', 'nextcloud_base_url', 'nextcloud_username',
                      'nextcloud_app_password')
        FOR UPDATE`,
    );
    const vorhanden = new Map(rows.map((row) => [row.key, row.value]));
    const verbunden = !!vorhanden.get('onedrive_tokens')
      || !!(vorhanden.get('nextcloud_base_url') && vorhanden.get('nextcloud_username')
        && vorhanden.get('nextcloud_app_password'));
    const { rows: [{ anzahl }] } = await client.query(
      `SELECT (SELECT count(*) FROM postbuch.postbuch)
            + (SELECT count(*) FROM postbuch._pipeline_suspensions)
            + (SELECT count(*) FROM postbuch._failed_documents) AS anzahl`,
    );
    if (verbunden || vorhanden.has('storage_folders') || Number(anzahl) > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'Die Ablage ist bereits in Benutzung. Ein Wechsel läuft nur über den geführten Ablage-Umzug.',
      });
    }
    // Nicht nur die Wahl selbst, auch angefangene (aber nie verbundene)
    // Nextcloud-Zugangsdaten zurücksetzen. `gewaehlt` (Frontend-Fallback wie
    // Server-Prüfung) leitet sich u. a. aus `nextcloud_base_url` ab — der
    // MagentaCLOUD-Schnellknopf setzt genau dieses Feld sofort. Bliebe es
    // stehen, während `storage_backend` hier gelöscht wird (Default danach:
    // onedrive), hinge der Assistent auf der falschen Backend-Karte fest und
    // „gewählt" bliebe fälschlich wahr — der Reset-Button wäre eine Sackgasse.
    // `onedrive_client_id`/`_secret` bleiben bewusst unangetastet: die kommen
    // typischerweise aus der Installation (Azure-App-Registrierung), nicht
    // aus einem Fehlklick im Assistenten.
    await client.query(
      `DELETE FROM postbuch._settings WHERE key IN (
        'storage_backend', 'storage_backend_selected',
        'nextcloud_base_url', 'nextcloud_username', 'nextcloud_app_password',
        'nextcloud_allow_insecure', 'storage_allow_private_targets'
      )`,
    );
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

const BACKEND_LABEL = { onedrive: 'OneDrive', nextcloud: 'Nextcloud' };

// Mischbestand: Dokumente, deren storage_backend vom aktuell aktiven Backend
// abweicht — Rest eines angefangenen, nicht abgeschlossenen Ablage-Umzugs
// (service/storage-migration.js). Das ist ein gültiger Zustand (beide
// Backends bleiben lesbar), aber auf Dauer soll niemand zwei Ablagen pflegen
// müssen — deshalb bekommt der Zustand einen eigenen Warnbanner statt einer
// stillen Duldung.
async function ermittleMischbestand(backend) {
  const { rows } = await db.query(
    `SELECT storage_backend, count(*)::int AS anzahl
       FROM postbuch.postbuch
      GROUP BY storage_backend`,
  );
  const fremd = rows.filter((r) => r.storage_backend !== backend);
  const fremdAnzahl = fremd.reduce((sum, r) => sum + r.anzahl, 0);
  if (fremdAnzahl === 0) return null;
  return {
    fremdAnzahl,
    fremdBackends: fremd.map((r) => ({
      backend: r.storage_backend,
      label: BACKEND_LABEL[r.storage_backend] || r.storage_backend,
      anzahl: r.anzahl,
    })),
  };
}

// ── GET /api/settings/storage/status ────────────────────────────────────────
// Backend-agnostischer Zustand der Ablage — für den Warnbanner auf dem
// Dashboard. Der hat bis 2.8.9 stur den OneDrive-Status abgefragt und deshalb
// auf einer Nextcloud-Instanz gemeldet, „OneDrive ist nicht verbunden",
// während die Ablage tadellos lief. Gemeckert wird ab jetzt nur über das
// Backend, das diese Instanz tatsächlich benutzt.
router.get('/storage/status', async (_req, res) => {
  try {
    const settings = await loadDynamicSettings();
    const backend = getActiveBackendName(settings);
    const mischbestand = await ermittleMischbestand(backend);

    if (backend === 'nextcloud') {
      const konfiguriert = !!(settings.nextcloud_base_url && settings.nextcloud_username
        && settings.nextcloud_app_password);
      if (!konfiguriert) {
        return res.json({
          backend, label: 'Nextcloud', konfiguriert: false, verbunden: false, problem: null, mischbestand,
        });
      }
      // Ein PROPFIND auf den Wurzelordner — dasselbe, was der Verbindungstest
      // der Einstellungen macht. Ohne echten Aufruf wäre „verbunden" nur die
      // Aussage, dass drei Felder gefüllt sind.
      try {
        await nextcloud.testeVerbindung();
        return res.json({
          backend, label: 'Nextcloud', konfiguriert: true, verbunden: true, problem: null, mischbestand,
        });
      } catch (err) {
        return res.json({
          backend, label: 'Nextcloud', konfiguriert: true, verbunden: false,
          problem: 'nicht_erreichbar', meldung: clientSafeError(err), mischbestand,
        });
      }
    }

    const konfiguriert = !!settings.onedrive_tokens;
    if (!konfiguriert) {
      return res.json({
        backend, label: 'OneDrive', konfiguriert: false, verbunden: false, problem: null, mischbestand,
      });
    }
    try {
      await onedriveAuth.getAccessToken();
      res.json({
        backend, label: 'OneDrive', konfiguriert: true, verbunden: true, problem: null, mischbestand,
      });
    } catch (err) {
      res.json({
        backend, label: 'OneDrive', konfiguriert: true, verbunden: false,
        problem: err?.postbuchAuthProblem || onedriveAuth.classifyAuthError(err) || 'nicht_erreichbar',
        mischbestand,
      });
    }
  } catch (err) {
    console.error('[settings] storage/status Fehler:', err);
    res.status(500).json({ error: 'Ablage-Status konnte nicht ermittelt werden.' });
  }
});

// ── GET /api/settings/notifications/discord ───────────────────────────────
// Liefert Discord-Benachrichtigungsstatus ohne Secret-Wert.

router.get('/notifications/discord', async (_req, res) => {
  try {
    const s = await loadDynamicSettings();
    const hasWebhook = !!s.discord_webhook_url;
    const hasBotToken = !!s.discord_bot_token;
    const hasChannelId = !!s.discord_channel_id;
    const hasBotConfig = hasBotToken && hasChannelId;
    const mode = hasBotConfig ? 'bot' : (hasWebhook ? 'webhook' : 'none');

    res.json({
      enabled: hasWebhook || hasBotConfig,
      hasWebhook,
      hasBotToken,
      hasChannelId,
      hasBotConfig,
      mode,
    });
  } catch (err) {
    console.error('[settings] notifications/discord GET Fehler:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/settings/notifications/discord/bot ───────────────────────────
// Setzt oder entfernt Discord Bot-Credentials.
// Body: { botToken: string, channelId: string, risikoBestaetigt?: boolean }

router.put('/notifications/discord/bot', async (req, res) => {
  const { botToken, channelId, risikoBestaetigt } = req.body || {};

  if (typeof botToken !== 'string' || typeof channelId !== 'string') {
    return res.status(400).json({ error: '"botToken" und "channelId" müssen Strings sein.' });
  }

  const token = botToken.trim();
  const channel = channelId.trim();

  try {
    // Leere Werte in beiden Feldern bedeuten: Bot-Modus deaktivieren.
    if (!token && !channel) {
      await db.query(`DELETE FROM postbuch._settings WHERE key IN ('discord_bot_token', 'discord_channel_id')`);
      await syncDiscordGateway();
      appLog('INFO', 'settings', 'Discord-Bot-Modus deaktiviert', {
        entity: 'settings',
        entityId: req.session?.username || null,
      });
      return res.json({ ok: true, hasBotConfig: false, enabled: false });
    }

    if (!token || !channel) {
      return res.status(400).json({ error: 'Für Bot-Modus müssen Bot-Token und Channel-ID gesetzt sein.' });
    }
    if (risikoBestaetigt !== true) {
      return res.status(400).json({
        error: 'Discord ist experimentell. Vor dem Speichern muss das Risiko einer möglichen Datenoffenlegung bestätigt werden.',
      });
    }

    await upsertSetting('discord_bot_token', token);
    await upsertSetting('discord_channel_id', channel);
    await syncDiscordGateway();

    appLog('INFO', 'settings', 'Discord-Bot-Credentials aktualisiert', {
      entity: 'settings',
      entityId: req.session?.username || null,
    });

    res.json({ ok: true, hasBotConfig: true, enabled: true, mode: 'bot' });
  } catch (err) {
    console.error('[settings] notifications/discord/bot PUT Fehler:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/settings/notifications/discord ───────────────────────────────
// Setzt oder entfernt den Discord-Webhook.
// Body: { webhookUrl: string, risikoBestaetigt?: boolean }

router.put('/notifications/discord', async (req, res) => {
  const { webhookUrl, risikoBestaetigt } = req.body || {};

  if (typeof webhookUrl !== 'string') {
    return res.status(400).json({ error: '"webhookUrl" fehlt oder ist kein String.' });
  }

  const trimmed = webhookUrl.trim();
  if (trimmed && !/^https:\/\/discord\.com\/api\/webhooks\//.test(trimmed)) {
    return res.status(400).json({ error: 'Ungültige Discord-Webhook-URL.' });
  }

  try {
    if (!trimmed) {
      await db.query(`DELETE FROM postbuch._settings WHERE key = 'discord_webhook_url'`);
      appLog('INFO', 'settings', 'Discord-Benachrichtigungen deaktiviert', {
        entity: 'settings',
        entityId: req.session?.username || null,
      });
      return res.json({ ok: true, enabled: false, hasWebhook: false });
    }
    if (risikoBestaetigt !== true) {
      return res.status(400).json({
        error: 'Discord ist experimentell. Vor dem Speichern muss das Risiko einer möglichen Datenoffenlegung bestätigt werden.',
      });
    }

    await upsertSetting('discord_webhook_url', trimmed);

    appLog('INFO', 'settings', 'Discord-Webhook aktualisiert', {
      entity: 'settings',
      entityId: req.session?.username || null,
    });

    res.json({ ok: true, enabled: true, hasWebhook: true });
  } catch (err) {
    console.error('[settings] notifications/discord PUT Fehler:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/notifications/discord/test', async (req, res) => {
  try {
    await sendDiscordMessage('✅ Postbuch-Testnachricht: Discord ist erfolgreich verbunden.');
    appLog('INFO', 'settings', 'Discord-Verbindung erfolgreich getestet', {
      entity: 'settings', entityId: req.session?.username || null,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[settings] Discord-Test fehlgeschlagen:', err?.message);
    res.status(502).json({ ok: false, error: 'Discord konnte nicht erreicht werden.' });
  }
});

// ── Web-Push instanzweit ───────────────────────────────────────────────────
// GET liefert den Instanzschalter und wer gerade tatsächlich Push bekommt
// (nur Namen, Geräteanzahl und Anbieter des Push-Dienstes – keine Endpunkte).
router.get('/notifications/webpush', async (_req, res) => {
  try {
    res.json({ erlaubt: await webpushErlaubt(), empfaenger: await ermittlePushEmpfaenger() });
  } catch (err) {
    console.error('[settings] notifications/webpush GET Fehler:', err);
    res.status(500).json({ error: 'Interner Fehler' });
  }
});

// PUT Body: { erlaubt: boolean }. Abschalten löscht alle gespeicherten
// Abonnements (siehe setzeWebpushErlaubt).
router.put('/notifications/webpush', async (req, res) => {
  const { erlaubt } = req.body || {};
  if (typeof erlaubt !== 'boolean') {
    return res.status(400).json({ error: '"erlaubt" muss boolean sein.' });
  }
  try {
    const ergebnis = await setzeWebpushErlaubt(erlaubt);
    appLog('INFO', 'settings', erlaubt
      ? 'Push-Benachrichtigungen instanzweit erlaubt'
      : `Push-Benachrichtigungen instanzweit abgeschaltet, ${ergebnis.entfernteGeraete} Geräte-Abonnements entfernt`, {
      entity: 'settings',
      entityId: req.session?.username || null,
    });
    res.json(ergebnis);
  } catch (err) {
    console.error('[settings] notifications/webpush PUT Fehler:', err);
    res.status(500).json({ error: 'Interner Fehler' });
  }
});

// ── PUT /api/settings/:key ───────────────────────────────────────────────────
// Aktualisiert eine einzelne Einstellung. Secrets können nicht über diese
// Route geändert werden.

router.put('/:key', async (req, res) => {
  const { key } = req.params;
  const { value } = req.body;

  // Geheimnisse gehen NIE über die generische Route — dafür gibt es
  // PUT /ai/providers/:id/key mit eigener Validierung.
  if (isSecretKey(key) || !isAllowedSettingKey(key)) {
    return res.status(403).json({ error: 'Dieser Schlüssel kann nicht über die API geändert werden.' });
  }
  if (['llm_empfehlungen_auto', 'llm_claude_subscription_enabled'].includes(key)
      && !subscriptionFeatureUnlocked()) {
    return res.status(403).json({ error: 'Diese Funktion ist nicht freigeschaltet.' });
  }

  if (value === undefined) {
    return res.status(400).json({ error: 'Feld "value" fehlt im Body.' });
  }

  // Polling-Config robust normalisieren, damit NaN/ungueltige Werte nicht persistiert werden.
  let normalizedValue = value;
  // Vom Admin gepflegter Freitext für den Klassifikations-Prompt: Typ erzwingen +
  // Längen-Cap (Schutz vor Runaway-Kosten, da der Text in JEDEN Analyse-Prompt fliesst).
  if (key === 'classification_custom_rules') {
    normalizedValue = typeof value === 'string' ? value.slice(0, 6000) : '';
  }
  if (key === 'onedrive_polling') {
    const rawInterval = Number(value?.intervalSec);
    normalizedValue = {
      enabled: value?.enabled === true,
      intervalSec: Number.isFinite(rawInterval) ? Math.max(10, Math.floor(rawInterval)) : 60,
    };
  }
  if (key === 'scanner_device_url') {
    try {
      normalizedValue = normalisiereScannerEndpoint(value);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }

  try {
    let alteScannerUrl = null;
    if (key === 'scanner_device_url') {
      const alt = await db.query("SELECT value FROM postbuch._settings WHERE key = 'scanner_device_url'");
      alteScannerUrl = alt.rows[0]?.value ?? null;
    }
    await upsertSetting(key, normalizedValue);
    if (key === 'scanner_device_url' && alteScannerUrl !== null && alteScannerUrl !== normalizedValue) {
      // Fähigkeiten gehören exakt zu einer Geräteadresse. Bei einem Wechsel
      // darf der Importdialog niemals Werte des vorigen Scanners anbieten.
      await db.query("DELETE FROM postbuch._settings WHERE key = 'scanner_capabilities'");
    }
    // Scanner entfernt (URL geleert): das Compose-Profil hat dann nichts mehr
    // zu tun. Best-effort — kein Host-Agent oder ein laufender Auftrag darf
    // das Löschen der Einstellung nicht verhindern.
    if (key === 'scanner_device_url' && alteScannerUrl !== null && normalizedValue === null) {
      scannerProfilAutoSchalten(false, req.session?.username || null).catch((err) => {
        console.error('[settings] Scannerprofil-Auto-Aus fehlgeschlagen:', err.message);
      });
    }
    appLog('INFO', 'settings', `Einstellung "${key}" aktualisiert`, {
      entity: 'settings',
      entityId: req.session?.username || null,
    });

    if (key === 'pipeline_max_parallel') {
      pipelineQueue.setMaxParallel(normalizedValue);
    }

    if (key === 'onedrive_polling') {
      if (normalizedValue.enabled) {
        await startOnedrivePolling();
      } else {
        stopOnedrivePolling();
      }
    }

    // Auto-Cache-Schalter ausgeschaltet → laufenden AUTO-gestarteten Mode stoppen
    // (ein manuell gestarteter Mode bleibt unberührt).
    if (key === 'llm_cache_mode_auto' && normalizedValue !== true) {
      try { await stopAutoCacheMode(); } catch (e) {
        console.error('[settings] stopAutoCacheMode fehlgeschlagen:', e?.message);
      }
    }

    res.json({ ok: true, key, value: normalizedValue });
  } catch (err) {
    console.error(`[settings] PUT /${key} Fehler:`, err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/settings/onedrive-status ────────────────────────────────────────
// Legacy-Endpunkt: bleibt aus Abwärtskompatibilität erhalten.

router.get('/onedrive-status', async (req, res) => {
  try {
    const settings = await loadDynamicSettings();
    const tokens = settings.onedrive_tokens;
    const folders = getFolders(settings, 'onedrive');

    if (!tokens) {
      return res.json({
        connected: false,
        message: 'Kein OAuth-Token gespeichert. Bitte OAuth-Flow durchführen.',
        setupUrl: '/api/onedrive-auth/start',
      });
    }

    let account = null;
    try {
      const cache = typeof tokens === 'string' ? JSON.parse(tokens) : tokens;
      const accountEntries = Object.values(cache.Account || {});
      if (accountEntries.length > 0) {
        account = accountEntries[0].username || accountEntries[0].homeAccountId || null;
      }
    } catch (_) {}

    const taxonomie = await getAktiveTaxonomie();
    const expectedFolders = [...new Set([
      ...SYSTEM_FOLDERS.flatMap((def) => def.keys),
      ...taxonomie.lebensbereiche.map((x) => x.code),
    ])];
    const missingFolders = expectedFolders.filter((k) => !folders[k]);

    res.json({
      connected: true,
      account,
      client_id_last8: settings.onedrive_client_id
        ? '***' + String(settings.onedrive_client_id).slice(-8)
        : null,
      folders_configured: Object.keys(folders).length,
      missing_folders: missingFolders.length > 0 ? missingFolders : null,
      polling_enabled: settings.onedrive_polling?.enabled ?? false,
    });
  } catch (err) {
    console.error('[settings] onedrive-status Fehler:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/settings/onedrive-folders/item-path ─────────────────────────────
// Gibt den menschenlesbaren Pfad eines Ablage-Items anhand seiner ID zurück.
// Query: ?id=<itemId>
// Response: { path: string }  (z. B. "/postbuch/Arztrechnung")

router.get('/onedrive-folders/item-path', async (req, res) => {
  const { id } = req.query;
  if (!id || typeof id !== 'string') {
    return res.status(400).json({ error: '"id" als Query-Parameter fehlt.' });
  }
  try {
    const storage = await getActiveAdapter();
    res.json({ path: await storage.getPath(id) });
  } catch (err) {
    console.error('[settings] item-path Fehler:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/settings/onedrive-folders/root ──────────────────────────────────
// Der aktuell konfigurierte Wurzelordner eines Backends, zurückgerechnet aus
// einer gespeicherten Systemordner-ID. Vorbelegung für den Setup-Assistenten
// UND für die Migrations-Karte (dort für das ZIEL-Backend, nicht das aktive):
// die Oberfläche darf hier NIE einen Namen raten.
//   ?backend=<name>  optional, Default: das aktive Backend
//   { backend, rootPath: string|null, konfiguriert: boolean }
// rootPath === null heißt „noch nichts eingerichtet oder nicht auflösbar" —
// dann bleibt das Eingabefeld leer, statt einen falschen Ordner anzubieten.

router.get('/onedrive-folders/root', async (req, res) => {
  try {
    const settings = await loadDynamicSettings();
    const angefragt = String(req.query.backend || '');
    const backend = BACKENDS.includes(angefragt) ? angefragt : getActiveBackendName(settings);
    const rootPath = await ermittleWurzelPfad(backend);
    res.json({ backend, rootPath, konfiguriert: rootPath !== null });
  } catch (err) {
    console.error('[settings] onedrive-folders/root Fehler:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/settings/onedrive-folders/setup-wizard ─────────────────────────
// Erstellt die komplette postbuch-Ordnerstruktur und speichert alle IDs.
// Body: { rootPath: string, bestaetigt?: boolean }
// Nach Abschluss werden ALLE DB-Dokumente automatisch in die neuen Ordner verschoben.
//
// Ein abweichender Wurzelordner ist eine gewollte Funktion — so zieht man die
// Ablage um. Genau deshalb ist er auch die folgenreichste Eingabe dieses
// Endpunkts: er legt die Struktur neu an und verschiebt den GESAMTEN
// Dokumentenbestand dorthin. Als beiläufiger Nebeneffekt eines Klicks auf
// „Ordner anlegen" darf das nicht passieren, deshalb wird der Umzug einmal
// ausdrücklich bestätigt statt stillschweigend ausgeführt.

router.post('/onedrive-folders/setup-wizard', async (req, res) => {
  const rootPath = (req.body?.rootPath || '').trim();
  if (!rootPath) {
    return res.status(400).json({ error: 'Es wurde kein Wurzelordner angegeben.' });
  }
  // Früher, klarer Fehlschlag statt eines Laufs, der erst nach dem (idempotenten,
  // aber sichtbaren) Ordner-Schritt am eigentlichen Umzug scheitert.
  if (istUmzugAktiv()) {
    return res.status(409).json({ error: 'Es läuft bereits ein Dokumentumzug — bitte warten, bis er abgeschlossen ist.' });
  }

  try {
    const bisher = await ermittleWurzelPfad().catch(() => null);
    if (bisher !== null && bisher !== rootPath && req.body?.bestaetigt !== true) {
      appLog('WARN', 'settings',
        `Setup-Assistent: Umzugsbestätigung angefordert — Wurzelordner "${bisher}" → "${rootPath}"`,
        { entity: 'settings', entityId: req.session?.username || null });
      return res.status(409).json({
        error: `Der Wurzelordner wurde geändert: bisher "${bisher}", jetzt "${rootPath}". `
          + `Beim Anlegen entsteht die Ordnerstruktur unter "${rootPath}" und der gesamte `
          + `Dokumentenbestand wird dorthin umgezogen.`,
        code: 'WURZEL_ABWEICHUNG',
        bisher,
        angefragt: rootPath,
      });
    }

    appLog('INFO', 'settings', `Setup-Assistent gestartet (rootPath="${rootPath}")`, {
      entity: 'settings', entityId: req.session?.username || null,
    });

    if (req.body?.async === true) {
      const jobId = tracker.create('storage-setup', `Ordnerstruktur „${rootPath}“`, 1, false);
      res.status(202).json({ ok: true, jobId });
      void (async () => {
        let relocateJobId = null;
        try {
          await tracker.awaitPersisted(jobId);
          const results = await setupFolderStructure(rootPath, undefined, ({ schritt, gesamt, name }) => {
            tracker.setTotal(jobId, gesamt);
            tracker.setStep(jobId, schritt, name);
          });
          await aktivierePollingNachSetup();
          relocateJobId = tracker.create('storage-relocate', 'Dokumente in neue Ablageordner verschieben', 1, false);
          tracker.complete(jobId, { ok: true, rootPath, folders: results, relocateJobId });
          await tracker.awaitPersisted(relocateJobId);
          const result = await relocateAllDocuments(({ schritt, gesamt, name }) => {
            tracker.setTotal(relocateJobId, gesamt);
            tracker.setStep(relocateJobId, schritt, name);
          });
          if (result.errors > 0) {
            tracker.fail(relocateJobId, `Dokumentumzug mit ${result.errors} Fehler(n) beendet.`,
              { fehlerListe: result.fehlerListe });
          } else {
            tracker.complete(relocateJobId, result);
          }
        } catch (err) {
          tracker.fail(relocateJobId || jobId, err.message);
          appLog('ERROR', 'settings', `Asynchroner Setup-Assistent fehlgeschlagen: ${err.message}`);
        }
      })();
      return;
    }

    const results = await setupFolderStructure(rootPath);

    appLog('INFO', 'settings', `Setup-Assistent abgeschlossen: ${results.length} Ordner`, {
      entity: 'settings', entityId: req.session?.username || null,
    });

    await aktivierePollingNachSetup();

    // Alle Dokumente im Hintergrund in die neuen Ordner verschieben
    appLog('INFO', 'settings', 'Gesamt-Umzug aller Dokumente nach Setup-Assistent gestartet');
    relocateAllDocuments().catch((err) => {
      appLog('ERROR', 'settings', `Gesamt-Umzug fehlgeschlagen: ${err.message}`);
    });

    res.json({ ok: true, rootPath, folders: results, relocating: true });
  } catch (err) {
    console.error('[settings] setup-wizard Fehler:', err);
    appLog('ERROR', 'settings', `Setup-Assistent fehlgeschlagen: ${err.message}`, {
      entity: 'settings', entityId: req.session?.username || null,
    });
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/settings/onedrive-folders/scan-missing ─────────────────────────
// Prüft für jedes Dokument mit gesetzter Ablage-ID, ob die Datei dort noch
// existiert (nur bestätigte 404s lösen die Verknüpfung, siehe storage-missing.js).
// Läuft als Hintergrundjob, damit große Bestände nicht die Anfrage blockieren.
router.post('/onedrive-folders/scan-missing', async (req, res) => {
  const jobId = tracker.create('storage-scan', 'Ablage auf fehlende Dateien prüfen', 1, false);
  res.status(202).json({ ok: true, jobId });
  void (async () => {
    try {
      await tracker.awaitPersisted(jobId);
      const result = await scanForMissingFiles(({ schritt, gesamt, name }) => {
        tracker.setTotal(jobId, gesamt);
        tracker.setStep(jobId, schritt, name);
      });
      tracker.complete(jobId, result);
    } catch (err) {
      tracker.fail(jobId, err.message);
      appLog('ERROR', 'settings', `Fehlende-Dateien-Scan fehlgeschlagen: ${err.message}`);
    }
  })();
});

/**
 * Eingangs-Polling nach dem ersten erfolgreichen Ordner-Setup einschalten.
 *
 * Bis 2.8.9 hat `_settings.onedrive_polling` genau eine Stelle geschrieben: der
 * OneDrive-OAuth-Callback. Eine Nextcloud-Instanz — und jede Erstinstallation,
 * die OneDrive nicht über OAuth verbindet — bekam den Schlüssel deshalb nie und
 * pollte den `_inbox`-Ordner nicht, obwohl der Watcher selbst längst
 * backend-agnostisch über `getActiveAdapterFor` arbeitet.
 *
 * Der Haken hängt hier, weil das Ordner-Setup der erste Moment ist, in dem
 * `_inbox` garantiert existiert. Geschrieben wird NUR, wenn der Schlüssel noch
 * gar nicht da ist: ein bewusst abgeschaltetes Polling bleibt abgeschaltet.
 */
async function aktivierePollingNachSetup() {
  try {
    const { rowCount } = await db.query(
      `INSERT INTO postbuch._settings (key, value, updated_at)
       VALUES ('onedrive_polling', '{"enabled":true,"intervalSec":60}'::jsonb, NOW())
       ON CONFLICT (key) DO NOTHING`,
    );
    if (rowCount > 0) {
      appLog('INFO', 'settings', 'Eingangs-Polling nach Ordner-Setup aktiviert (60 s).');
      await startOnedrivePolling();
    }
  } catch (err) {
    appLog('WARN', 'settings', `Eingangs-Polling konnte nicht aktiviert werden: ${err.message}`);
  }
}

// ── GET /api/settings/scanner/netzvorschlag ──────────────────────────────────
// Schlägt ein Start-Netz für die Scanner-Suche vor. Quellen, in dieser
// Reihenfolge:
//   1. die echte LAN-Schnittstelle laut Host-Agent — nur diese kennt die
//      tatsächliche Subnetzmaske. Der app-Container hängt in einer Docker-Bridge
//      (172.x) und sieht die eigentliche Netzmaske des Hosts nicht.
//   2. die private IP des anfragenden Admins (req.ip, dank `trust proxy 1`
//      korrekt hinter Caddy/nginx) — daraus ist nur ein /24 ableitbar.
//   3. eine private IPv4 im konfigurierten app_host.
// Der Wert ist reines UI-Prefill; der eigentliche Scan validiert unabhängig
// gegen private Ranges.
router.get('/scanner/netzvorschlag', async (req, res) => {
  try {
    let vorschlag = null;
    const agent = await leseAgentStatus();
    if (agent.vorhanden && agent.lan) {
      vorschlag = netzVorschlagAusIp(agent.lan.ip, agent.lan.prefix);
    }
    if (!vorschlag) vorschlag = netzVorschlagAusIp(req.ip);
    if (!vorschlag) {
      const settings = await loadDynamicSettings();
      const host = (() => {
        try { return new URL(String(settings.app_host || '')).hostname; } catch { return ''; }
      })();
      vorschlag = netzVorschlagAusIp(host);
    }
    res.json({ vorschlag });
  } catch {
    res.json({ vorschlag: null });
  }
});

// ── POST /api/settings/scanner/discover ──────────────────────────────────────
router.post('/scanner/discover', async (req, res) => {
  try {
    const cidr = bauCidr(req.body?.ip, req.body?.maske);
    const treffer = await findeScannerImCidr(cidr, {
      port: req.body?.port ?? 'alle',
      protokoll: req.body?.protokoll ?? 'alle',
      timeoutMs: 900,
    });
    res.json({ treffer });
  } catch (err) {
    const status = err.code === 'SCAN_LAEUFT' ? 409 : (err.code === 'SCAN_RATE_LIMIT' ? 429 : 400);
    res.status(status).json({ error: err.message });
  }
});

// ── POST /api/settings/scanner/capabilities ──────────────────────────────────
// Fragt das Gerät nach seinen Fähigkeiten (Auflösungen/Farbmodi je Quelle) und
// speichert das Ergebnis in `_settings.scanner_capabilities`. Schreibt dabei
// auch scanner_has_adf/scanner_adf_duplex/scanner_supports_a3 direkt aus der
// Geräteantwort fort — keine separate Bestätigung nötig.
//
// Body: { deviceUrl?: string }  — ohne Angabe gilt die gespeicherte Scanner-URL.
//
// scanner_capabilities steht bewusst NICHT in ALLOWED_SETTING_KEYS: er trägt
// einen abgeleiteten, geprüften Wert und wird ausschließlich hier geschrieben.
// Über den generischen PUT ließe sich sonst beliebiges JSON unterschieben, das
// anschließend über settings-public an jede Rolle ausgeliefert wird.
//
// Freiwillig: Solange nie ermittelt wurde, fehlen die Keys und alles verhält
// sich wie zuvor. Ein Fehlversuch überschreibt einen vorhandenen Stand nicht.

router.post('/scanner/capabilities', async (req, res) => {
  const settings = await loadDynamicSettings();
  let deviceUrl;
  try {
    deviceUrl = normalisiereScannerEndpoint(req.body?.deviceUrl || settings.scanner_device_url || '');
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  if (!deviceUrl) {
    res.status(400).json({ error: 'Keine Scanner-Adresse konfiguriert' });
    return;
  }

  try {
    const { geraet, quellen } = await holeScannerCapabilities(deviceUrl);

    // Explizit neu aufgebaut statt durchgereicht — so kann nie versehentlich
    // Roh-XML, die Seriennummer oder die Geräteadresse mitwandern.
    const capabilities = {
      geraet,
      quellen,
      ermitteltAm: new Date().toISOString(),
    };
    // Nach dem Netzaufruf erneut aus der DB lesen. Sonst könnte ein paralleler
    // URL-Wechsel zwischen Snapshot und Probe alte Fähigkeiten zurückschreiben.
    const aktuell = await db.query("SELECT value FROM postbuch._settings WHERE key = 'scanner_device_url'");
    let gespeicherteUrl = null;
    try { gespeicherteUrl = normalisiereScannerEndpoint(aktuell.rows[0]?.value || ''); } catch { /* noch unkonfiguriert */ }
    const persistiert = gespeicherteUrl === deviceUrl;

    // Ausstattung wird direkt aus der Geräteantwort übernommen, nicht nur
    // vorgeschlagen: Das Gerät hat gerade live geantwortet, was es kann — eine
    // zusätzliche Bestätigung wäre nur ein Klick für eine Tatsache, die der
    // Scan-Selbsttest längst bewiesen hat. Jede erneute Ermittlung schreibt
    // den aktuellen Gerätestand, ein manuell abweichend gesetzter Schalter
    // wird also beim nächsten Test wieder überschrieben.
    const ausstattung = {
      scanner_has_adf: Boolean(quellen.adf || quellen['adf-duplex']),
      scanner_adf_duplex: Boolean(quellen['adf-duplex']),
      scanner_supports_a3: (quellen.flatbed?.maxBreiteMm || 0) >= 297
        && (quellen.flatbed?.maxHoeheMm || 0) >= 420,
    };

    if (persistiert) {
      await db.query(
        `INSERT INTO postbuch._settings (key, value, updated_at)
         SELECT 'scanner_capabilities', $1::jsonb, NOW()
          WHERE (SELECT value FROM postbuch._settings WHERE key = 'scanner_device_url') = $2::jsonb
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [JSON.stringify(capabilities), JSON.stringify(deviceUrl)],
      );
      for (const [k, v] of Object.entries(ausstattung)) {
        await db.query(
          `INSERT INTO postbuch._settings (key, value, updated_at)
           SELECT $1, $2::jsonb, NOW()
            WHERE (SELECT value FROM postbuch._settings WHERE key = 'scanner_device_url') = $3::jsonb
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
          [k, JSON.stringify(v), JSON.stringify(deviceUrl)],
        );
      }
    }

    appLog('INFO', 'settings', `Scanner-Fähigkeiten ermittelt${persistiert ? ' und gespeichert' : ''}: ${geraet || 'unbekanntes Gerät'} (${Object.keys(quellen).join(', ')})`, {
      entity: 'settings', entityId: req.session?.username || null,
    });

    res.json({ ok: true, persistiert, capabilities, ausstattung });
  } catch (err) {
    console.error('[settings] Scanner-Fähigkeiten konnten nicht ermittelt werden.');
    appLog('WARN', 'settings', 'Ermittlung der Scanner-Fähigkeiten fehlgeschlagen', {
      entity: 'settings', entityId: req.session?.username || null,
    });
    res.status(502).json({ error: clientSafeError(err) });
  }
});

// ── POST /api/settings/onedrive-folders/relocate-all ─────────────────────────
// Manueller Auslöser: verschiebt alle DB-Dokumente in ihre konfigurierten Ordner.
// Nützlich nach manuellen Ordner-Konfigurationsänderungen oder zur Fehlerkorrektur.

router.post('/onedrive-folders/relocate-all', async (req, res) => {
  if (istUmzugAktiv()) {
    return res.status(409).json({ error: 'Es läuft bereits ein Dokumentumzug — bitte warten, bis er abgeschlossen ist.' });
  }

  appLog('INFO', 'settings', 'Manueller Gesamt-Umzug angefordert', {
    entity: 'settings', entityId: req.session?.username || null,
  });

  // Sofortige Antwort — Umzug läuft im Hintergrund
  res.json({ ok: true, message: 'Umzug gestartet — Fortschritt im System-Log sichtbar' });

  relocateAllDocuments().catch((err) => {
    appLog('ERROR', 'settings', `Manueller Gesamt-Umzug fehlgeschlagen: ${err.message}`);
  });
});

// ── Ablagestruktur (Vorlage oder benutzerdefinierte Ebenen) ──────────────────
// Umschalten und Gesamtumzug sind untrennbar: ein Wechsel ohne Umzug ließe einen
// Mischbestand ohne Besitzer zurück. ablage_struktur und ablage_ebenen stehen
// deshalb bewusst NICHT in ALLOWED_SETTING_KEYS. Ein erneuter Aufruf mit der
// aktuellen Struktur setzt einen abgebrochenen Umzug fort (relocateAllDocuments
// ist idempotent).

/**
 * Löst eine Anfrage auf Struktur und Ebenen auf. Eine benutzerdefinierte
 * Folge, die einer Vorlage entspricht, wird zu dieser Vorlage.
 * @returns {{struktur:string, ebenen:string[]}|null}
 */
function loeseStrukturAuf(struktur, ebenen) {
  if (Object.hasOwn(ABLAGE_VORLAGEN, struktur)) return { struktur, ebenen: [...ABLAGE_VORLAGEN[struktur]] };
  if (struktur !== 'benutzerdefiniert') return null;
  const normal = normalisiereAblageEbenen(ebenen);
  if (!normal) return null;
  const vorlage = Object.entries(ABLAGE_VORLAGEN).find(([, v]) => v.join('/') === normal.join('/'));
  return vorlage ? { struktur: vorlage[0], ebenen: normal } : { struktur, ebenen: normal };
}

/**
 * Kurznamen, die als Personenordner kollidieren würden. Steht Person auf
 * erster Ebene, liegen die Personenordner während des Umzugs neben den
 * Ordnern der bisherigen ersten Ebene – gleichnamige Ordner würden dann
 * verwechselt.
 */
async function personenordnerKollisionen(ebenen) {
  if (!ebenen.includes('person')) return [];
  const menschen = (await db.query('SELECT kurzname FROM postbuch.mensch ORDER BY kurzname')).rows;
  const taxonomie = await getGesamteTaxonomie();
  const belegt = new Map();
  if (ebenen[0] === 'person') {
    for (const l of taxonomie.lebensbereiche) belegt.set(String(l.label).toLowerCase(), 'gleichnamiger Lebensbereich');
    for (const d of taxonomie.dokumentarten) belegt.set(String(d.label).toLowerCase(), 'gleichnamige Dokumentart');
    for (const r of Object.values(RICHTUNG_ORDNER)) belegt.set(r.toLowerCase(), 'gleichnamiger Richtungsordner');
    belegt.set(OHNE_DATUM_ORDNER.toLowerCase(), 'gleichnamiger Jahresordner');
  }
  const gesehen = new Map();
  const kollisionen = [];
  for (const { kurzname } of menschen) {
    const klein = kurzname.toLowerCase();
    if (klein === GEMEINSAM_ORDNER.toLowerCase()) kollisionen.push({ kurzname, grund: 'reservierter Sammelordner' });
    else if (/^[_.]/.test(kurzname)) kollisionen.push({ kurzname, grund: 'beginnt mit _ oder .' });
    else if (belegt.has(klein)) kollisionen.push({ kurzname, grund: belegt.get(klein) });
    else if (ebenen[0] === 'person' && /^\d{4}$/.test(kurzname)) kollisionen.push({ kurzname, grund: 'gleichnamiger Jahresordner' });
    else if (gesehen.has(klein)) kollisionen.push({ kurzname, grund: `nur in Groß-/Kleinschreibung verschieden von „${gesehen.get(klein)}“` });
    gesehen.set(klein, kurzname);
  }
  return kollisionen;
}

router.get('/ablage-struktur', async (_req, res) => {
  try {
    const settings = await loadDynamicSettings();
    res.json({
      struktur: getAblageStruktur(settings),
      ebenen: getAblageEbenen(settings),
      // Zuletzt gespeicherte eigene Folge, zum Vorbelegen der Auswahl.
      benutzerEbenen: normalisiereAblageEbenen(settings.ablage_ebenen),
      personQuelle: getAblagePersonQuelle(settings),
      umzugAktiv: istUmzugAktiv() || !!strukturUmzug,
    });
  } catch (err) {
    res.status(500).json({ error: clientSafeError(err) });
  }
});

// Laufender Strukturumzug { jobId, controller, fertig }. Eine neue Strukturwahl
// bricht ihn ab und ersetzt ihn durch einen Umzug in die neue Struktur.
let strukturUmzug = null;
// Serialisiert Wechselanfragen: Abbruch des alten Laufs, Umschalten und Start
// des neuen bilden einen kritischen Abschnitt. Ohne ihn könnten zwei schnelle
// Klicks das Setting umschalten, während der jeweils andere Lauf noch zieht.
let wechselSperre = Promise.resolve();

/** Startet den Gesamtumzug samt Aufräumen im Hintergrund. */
function starteStrukturUmzug() {
  const jobId = tracker.create('storage-relocate', 'Dokumente in neue Ablagestruktur verschieben', 1, false);
  const controller = new AbortController();
  const lauf = { jobId, controller, fertig: null };
  lauf.fertig = (async () => {
    try {
      await tracker.awaitPersisted(jobId);
      const result = await relocateAllDocuments(({ schritt, gesamt, name }) => {
        tracker.setTotal(jobId, gesamt);
        tracker.setStep(jobId, schritt, name);
      }, { signal: controller.signal });
      // Ersetzt, bevor aufgeräumt wurde: Das Aufräumen übernimmt der neue
      // Lauf, sonst löschte dieser hier womöglich frisch angelegte Ordner.
      if (result.abgebrochen || controller.signal.aborted) {
        tracker.completeAsCancelled(jobId, { ...result, ersetzt: true });
        return;
      }
      if (result.errors > 0 || result.unresolved > 0) {
        tracker.fail(jobId,
          `Umzug mit ${result.errors} Fehler(n) und ${result.unresolved} ungeklärten Zielen beendet. `
          + 'Alte Ordner bleiben stehen; der Umzug kann erneut gestartet werden.',
          { fehlerListe: result.fehlerListe });
        return;
      }
      const aufraeumen = await raeumeFremdeStrukturAuf({ taxonomie: await getGesamteTaxonomie() });
      tracker.complete(jobId, { ...result, aufraeumen });
    } catch (err) {
      tracker.fail(jobId, err.message);
      appLog('ERROR', 'settings', `Wechsel der Ablagestruktur fehlgeschlagen: ${err.message}`);
    } finally {
      if (strukturUmzug === lauf) strukturUmzug = null;
    }
  })();
  strukturUmzug = lauf;
  return jobId;
}

router.post('/ablage-struktur', async (req, res) => {
  const ziel = loeseStrukturAuf(req.body?.struktur, req.body?.ebenen);
  if (!ziel) {
    return res.status(400).json({ error: 'Unbekannte Ablagestruktur oder ungültige Ebenenauswahl (1 bis 4 verschiedene Ebenen).' });
  }
  const { struktur, ebenen } = ziel;
  const personQuelleRoh = req.body?.personQuelle;
  if (personQuelleRoh !== undefined && !ABLAGE_PERSON_QUELLEN.includes(personQuelleRoh)) {
    return res.status(400).json({ error: 'Unbekannte Personenquelle (adressat oder behandelt).' });
  }
  const vorige = wechselSperre;
  let freigeben;
  wechselSperre = new Promise((resolve) => { freigeben = resolve; });
  try {
    await vorige;
    // Ein Umzug, der nicht von hier stammt (Setup-Assistent, manueller
    // Gesamtumzug), wird nicht abgebrochen.
    if (istUmzugAktiv() && !strukturUmzug) {
      return res.status(409).json({ error: 'Es läuft bereits ein Dokumentumzug – bitte warten, bis er abgeschlossen ist.' });
    }
    // Nur ein laufender oder noch nicht umgeschalteter Speicherumzug sperrt;
    // getOffenenLauf() liefert auch längst umgeschaltete Läufe.
    const speicherumzug = await getOffenenLauf();
    if (speicherumzug && (speicherumzug.laeuftGerade || (!speicherumzug.switched_at && !speicherumzug.cleaned_at))) {
      return res.status(409).json({ error: 'Es ist noch ein Ablage-Umzug zwischen zwei Speichern offen. Bitte diesen zuerst abschließen.' });
    }
    const settings = await loadDynamicSettings();
    if (!getFolders(settings).inbox) {
      return res.status(409).json({ error: 'Die Ablage ist noch nicht eingerichtet.' });
    }
    const kollisionen = await personenordnerKollisionen(ebenen);
    if (kollisionen.length) {
      return res.status(409).json({
        error: 'Einige Kurznamen eignen sich nicht als Ordnername. Bitte zuerst umbenennen.',
        code: 'KURZNAME_KOLLISION',
        kollisionen,
      });
    }

    // Erst nach allen Prüfungen abbrechen: Eine abgelehnte Anfrage darf den
    // laufenden Umzug nicht stoppen. Das gerade bewegte Dokument wird noch
    // fertig verschoben, danach endet der alte Lauf als abgebrochen.
    const ersetzt = strukturUmzug;
    if (ersetzt) {
      appLog('INFO', 'settings', `Laufender Strukturumzug ${ersetzt.jobId} wird durch neue Strukturwahl ersetzt`);
      ersetzt.controller.abort();
      await ersetzt.fertig;
    }

    const vorher = getAblageEbenen(settings).join('/');
    const personQuelle = personQuelleRoh ?? getAblagePersonQuelle(settings);
    // Ebenen zuerst: getAblageStruktur() fällt bei 'benutzerdefiniert' ohne
    // gültige Ebenen auf LxD zurück. Bei einer Vorlage bleibt die eigene Folge
    // zum späteren Vorbelegen stehen.
    if (struktur === 'benutzerdefiniert') await upsertSetting('ablage_ebenen', ebenen);
    await upsertSetting('ablage_person_quelle', personQuelle);
    await upsertSetting('ablage_struktur', struktur);
    appLog('INFO', 'settings', `Ablagestruktur: ${vorher} → ${ebenen.join('/')} (${struktur}, Person: ${personQuelle}), Gesamtumzug gestartet`, {
      entity: 'settings', entityId: req.session?.username || null,
    });

    const jobId = starteStrukturUmzug();
    res.status(202).json({ ok: true, jobId, struktur, ebenen, personQuelle, ersetztJobId: ersetzt?.jobId || null });
  } catch (err) {
    console.error('[settings] Ablagestruktur:', err);
    if (!res.headersSent) res.status(500).json({ error: clientSafeError(err) });
  } finally {
    freigeben();
  }
});

// ── Nextcloud-Verbindung ─────────────────────────────────────────────────────
// Eigener Router, aber INNERHALB dieses bereits requireAdmin-montierten
// Routers — kein neuer Top-Level-Mount in index.js.
router.use('/nextcloud', nextcloudRouter);

// ── Ablage-Migration ─────────────────────────────────────────────────────────
// Ebenfalls INNERHALB dieses requireAdmin-montierten Routers. Eine Migration
// ist eine Betreiber-Entscheidung; ein eigener Top-Level-Mount in index.js
// wäre die Fallstrick-Variante (über dem Auth-Gate = Bypass, darunter ohne
// explizites requireAdmin = jeder vollzugriff-Nutzer migriert).
//
// Muss VOR '/storage/:backend/selftest' stehen: sonst fängt ':backend' den
// Pfad 'migration' ab.
router.use('/storage/migration', migrationRouter);

// ── POST /api/settings/storage/:backend/selftest ─────────────────────────────
// Konformitaetstest der Ablage-Schnittstelle (service/storage-selftest.js).
//
// Nimmt AUSSCHLIESSLICH den Backend-Namen entgegen — kein Pfad, kein
// Dateiname, keine URL, keine Zugangsdaten aus dem Body. Alles andere kommt
// aus den persistierten Einstellungen; sonst waere die Route ein
// Datei-Proxy mit Schreibrecht auf ein frei waehlbares Ziel.

router.post('/storage/:backend/selftest', async (req, res) => {
  const { backend } = req.params;
  if (!/^[a-z][a-z0-9_-]{1,30}$/.test(backend)) {
    return res.status(400).json({ error: 'Ungueltiger Backend-Name.' });
  }
  try {
    appLog('INFO', 'settings', `Ablage-Selbsttest fuer "${backend}" angefordert`, {
      entity: 'settings', entityId: req.session?.username || null,
    });
    res.json(await runAdapterConformance(backend));
  } catch (err) {
    if (err?.code === 'BEREITS_AKTIV') return res.status(409).json({ error: err.message });
    console.error('[settings] selftest Fehler:', err);
    res.status(400).json({ error: clientSafeError(err) });
  }
});

router.get('/storage/:backend/free-space', async (req, res) => {
  try {
    const adapter = getAdapter(req.params.backend);
    if (!adapter.capabilities?.freierSpeicher || typeof adapter.getFreeSpace !== 'function') {
      return res.json({ verfuegbar: false, freiBytes: null });
    }
    const wert = await adapter.getFreeSpace();
    res.json({ verfuegbar: true, freiBytes: wert?.freiBytes ?? null });
  } catch (err) {
    res.status(400).json({ error: clientSafeError(err) });
  }
});

// ── AI Settings ──────────────────────────────────────────────────────────────

// GET /api/settings/ai/health — Key presence + model availability (cached by client)
// Vollversion inkl. Provider-Fehlertexte. Die entschaerfte Variante fuer alle
// eingeloggten Nutzer liegt in routes/settings-public.js.
router.get('/ai/health', async (req, res) => {
  try {
    // Ohne ?fresh=1 aus dem 60-Sekunden-Cache: das UI pollt diese Route, und ein
    // nicht erreichbares LAN-Ziel würde sie sonst bei jedem Aufruf blockieren.
    res.json(await buildAiHealth({ fresh: req.query.fresh === '1' }));
  } catch (err) {
    console.error('[settings] ai/health Fehler:', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/settings/ai/key — update a secret API key
// Body: { provider: 'openai'|'anthropic'|'bedrock'|'subscription', key: string, region?: string }
const AI_KEY_SETTING = {
  openai: 'llm_openai_key',
  anthropic: 'llm_anthropic_key',
  bedrock: 'llm_bedrock_key',
  subscription: 'llm_claude_oauth_token',
};
router.put('/ai/key', async (req, res) => {
  const { provider, key, region } = req.body;
  if (!AI_KEY_SETTING[provider]) {
    return res.status(400).json({ error: '"provider" muss "openai", "anthropic", "bedrock" oder "subscription" sein.' });
  }
  // Subscription-Pfad nur, wenn das dev-Key-Feature freigeschaltet ist.
  if (provider === 'subscription' && !subscriptionFeatureUnlocked()) {
    return res.status(403).json({ error: 'Claude-Subscription ist auf dieser Instanz nicht freigeschaltet.' });
  }
  if (typeof key !== 'string') {
    return res.status(400).json({ error: '"key" fehlt oder ist kein String.' });
  }
  const settingKey = AI_KEY_SETTING[provider];
  try {
    await db.query(
      `INSERT INTO postbuch._settings (key, value, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = NOW()`,
      [settingKey, JSON.stringify(key.trim())]
    );
    // Bedrock: optional die Region mitspeichern (kein Secret).
    if (provider === 'bedrock' && typeof region === 'string' && region.trim()) {
      await db.query(
        `INSERT INTO postbuch._settings (key, value, updated_at)
         VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = NOW()`,
        ['llm_bedrock_region', JSON.stringify(region.trim())]
      );
    }
    appLog('INFO', 'settings', `API-Key für "${provider}" aktualisiert`, {
      entity: 'settings', entityId: req.session?.username || null,
    });
    res.json({ ok: true, provider });
  } catch (err) {
    console.error('[settings] ai/key Fehler:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── LLM-Provider-Registry ────────────────────────────────────────────────────
//
// _settings.llm_providers ist die Liste (nicht geheim, damit das UI listen kann),
// _settings.llm_provider_key_<id> das jeweilige Geheimnis. Die vier Built-ins
// (anthropic, openai, bedrock, subscription) sind immer vorhanden und können
// bearbeitet, aber nicht gelöscht werden — bestehende llm_model_*-Werte zeigen
// über providerFromModel auf genau diese IDs.

// GET /api/settings/ai/providers — Liste inkl. „Key hinterlegt?", nie der Key selbst
router.get('/ai/providers', async (_req, res) => {
  try {
    const settings = await loadDynamicSettings();
    const liste = listProviders(settings)
      .filter((p) => p.typ !== 'subscription' || subscriptionFeatureUnlocked())
      .map((p) => {
      const voll = getProvider(settings, p.id);
      return { ...p, hatKey: !!voll?.apiKey };
    });
    res.json({
      providers: liste,
      presets: PROVIDER_PRESETS,
      capKeys: CAP_KEYS,
      builtinIds: BUILTIN_PROVIDER_IDS,
      allowPrivateGlobal: settings.llm_allow_private_targets === true,
      rasterMaxSeitenDefault: RASTER_MAX_SEITEN,
      rasterMaxSeitenGrenze: RASTER_MAX_SEITEN_GRENZE,
      maxOutputTokensMin: MAX_OUTPUT_TOKENS_MIN,
      maxOutputTokensGrenze: MAX_OUTPUT_TOKENS_GRENZE,
    });
  } catch (err) {
    console.error('[settings] ai/providers Fehler:', err);
    res.status(500).json({ error: err.message });
  }
});

function normalisiereProviderEingabe(body, vorhanden) {
  const typ = vorhanden?.builtin
    ? vorhanden.typ
    : (PROVIDER_TYPES.includes(body.typ) ? body.typ : 'openai-compatible');
  const caps = { ...defaultCapsForType(typ), ...(vorhanden?.caps || {}) };
  if (body.caps && typeof body.caps === 'object') {
    for (const k of CAP_KEYS) if (typeof body.caps[k] === 'boolean') caps[k] = body.caps[k];
  }
  // Fehlt das Feld im Body, bleibt der bestehende Wert stehen — die Route
  // ersetzt den Eintrag vollständig, ein Save ohne das Feld dürfte die
  // Einstellung nicht still zurücksetzen. Leer/null heißt ausdrücklich
  // „kein eigener Wert" und fällt auf den Rasterizer-Default zurück.
  let rasterMaxSeiten = vorhanden?.rasterMaxSeiten;
  if ('rasterMaxSeiten' in body) {
    const roh = body.rasterMaxSeiten;
    if (roh === null || roh === '' || roh === undefined) {
      rasterMaxSeiten = undefined;
    } else if (!Number.isFinite(Number(roh))) {
      throw new Error('Seitenlimit beim Rastern muss eine Zahl sein.');
    } else {
      rasterMaxSeiten = normalizeRasterMaxSeiten(roh);
    }
  }
  // Dieselbe Semantik wie beim Seitenlimit: leer = kein eigener Wert.
  let maxOutputTokens = vorhanden?.maxOutputTokens;
  if ('maxOutputTokens' in body) {
    const roh = body.maxOutputTokens;
    if (roh === null || roh === '' || roh === undefined) {
      maxOutputTokens = undefined;
    } else if (!Number.isFinite(Number(roh))) {
      throw new Error('Limit für Antwort-Tokens muss eine Zahl sein.');
    } else {
      maxOutputTokens = normalizeMaxOutputTokens(roh);
    }
  }
  const eintrag = {
    id: vorhanden?.id,
    typ,
    label: typeof body.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 80) : (vorhanden?.label || vorhanden?.id),
    baseUrl: typeof body.baseUrl === 'string' ? body.baseUrl.trim() : (vorhanden?.baseUrl ?? null),
    dialekt: ['openai', 'ollama', 'anthropic', 'lmstudio'].includes(body.dialekt) ? body.dialekt : (vorhanden?.dialekt || 'openai'),
    aktiv: body.aktiv !== false,
    caps,
    rasterMaxSeiten,
    maxOutputTokens,
    erlaubtPrivateZiele: body.erlaubtPrivateZiele === true,
  };
  // Ein openai-kompatibles Ziel ohne baseUrl ist unbrauchbar.
  if (eintrag.typ === 'openai-compatible' && !eintrag.baseUrl) {
    throw new Error('Für einen OpenAI-kompatiblen Provider ist eine Basis-URL erforderlich (z. B. http://10.0.0.5:11434/v1).');
  }
  if (eintrag.baseUrl) {
    let u;
    try { u = new URL(eintrag.baseUrl); } catch { throw new Error('Basis-URL ist keine gültige URL.'); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Basis-URL muss http:// oder https:// verwenden.');
    if (u.username || u.password) throw new Error('Zugangsdaten gehören nicht in die URL — bitte den Key separat hinterlegen.');
  }
  return eintrag;
}

async function speichereProviderListe(liste) {
  // Built-ins mitspeichern, damit UI-Änderungen an ihnen (Label, Caps) bestehen.
  await upsertSetting('llm_providers', liste);
  invalidateAiHealthCache();
}

// PUT /api/settings/ai/providers/:id — anlegen oder ändern (ohne Key)
router.put('/ai/providers/:id', async (req, res) => {
  const id = String(req.params.id || '').toLowerCase();
  if (!PROVIDER_ID_RE.test(id)) {
    return res.status(400).json({ error: 'Ungültige Provider-ID (erlaubt: a–z, 0–9, - und _, max. 49 Zeichen).' });
  }
  try {
    const settings = await loadDynamicSettings();
    const vorhanden = listProviders(settings).find((p) => p.id === id);
    const eintrag = { ...normalisiereProviderEingabe(req.body || {}, vorhanden), id };
    if (eintrag.typ === 'subscription' && !subscriptionFeatureUnlocked()) {
      return res.status(403).json({ error: 'Diese Funktion ist nicht freigeschaltet.' });
    }

    const bestand = Array.isArray(settings.llm_providers) ? settings.llm_providers : [];
    const ohne = bestand.filter((p) => p?.id !== id);
    await speichereProviderListe([...ohne, eintrag]);

    // Nur die ID loggen, nie einen Wert.
    appLog('INFO', 'settings', `LLM-Provider "${id}" gespeichert`, {
      entity: 'settings', entityId: req.session?.username || null,
    });
    res.json({ ok: true, provider: eintrag });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/settings/ai/providers/:id — Built-ins sind gesperrt
router.delete('/ai/providers/:id', async (req, res) => {
  const id = String(req.params.id || '').toLowerCase();
  if (BUILTIN_PROVIDER_IDS.includes(id)) {
    return res.status(400).json({ error: 'Eingebaute Provider können nicht gelöscht werden — sie lassen sich aber deaktivieren.' });
  }
  try {
    const settings = await loadDynamicSettings();

    // Löschschutz: verweist noch eine Modellklasse hierauf, bräche die
    // Klassifikation lautlos. Deshalb vorher benennen, wer betroffen ist.
    const benutztVon = [];
    for (const cls of MODEL_CLASSES) {
      const cfg = resolveModelConfig(settings[cls.settingKey], null, null);
      if (cfg.providerId === id) benutztVon.push(cls.label);
    }
    if (embeddingConfig(settings).providerId === id) benutztVon.push('Embeddings');
    if (benutztVon.length && req.query.force !== '1') {
      return res.status(409).json({
        error: 'Provider wird noch verwendet.',
        benutztVon,
      });
    }

    const bestand = Array.isArray(settings.llm_providers) ? settings.llm_providers : [];
    await speichereProviderListe(bestand.filter((p) => p?.id !== id));
    await db.query('DELETE FROM postbuch._settings WHERE key = $1', [providerKeySetting(id)]);
    appLog('INFO', 'settings', `LLM-Provider "${id}" gelöscht`, {
      entity: 'settings', entityId: req.session?.username || null,
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/settings/ai/providers/:id/key — Geheimnis setzen (leer = löschen)
router.put('/ai/providers/:id/key', async (req, res) => {
  const id = String(req.params.id || '').toLowerCase();
  if (!PROVIDER_ID_RE.test(id)) return res.status(400).json({ error: 'Ungültige Provider-ID.' });
  const { key } = req.body || {};
  if (typeof key !== 'string') return res.status(400).json({ error: '"key" fehlt oder ist kein String.' });
  try {
    const settings = await loadDynamicSettings();
    if (!listProviders(settings).some((p) => p.id === id)) {
      return res.status(404).json({ error: 'Provider nicht gefunden.' });
    }
    const provider = getProvider(settings, id);
    if (provider?.typ === 'subscription' && !subscriptionFeatureUnlocked()) {
      return res.status(403).json({ error: 'Diese Funktion ist nicht freigeschaltet.' });
    }
    const settingKey = providerKeySetting(id);
    if (!key.trim()) {
      await db.query('DELETE FROM postbuch._settings WHERE key = $1', [settingKey]);
    } else {
      await upsertSetting(settingKey, key.trim());
    }
    invalidateAiHealthCache();
    // Nur die Provider-ID im Log, nie der Wert.
    appLog('INFO', 'settings', `API-Key für LLM-Provider "${id}" ${key.trim() ? 'gesetzt' : 'entfernt'}`, {
      entity: 'settings', entityId: req.session?.username || null,
    });
    res.json({ ok: true, id, hatKey: !!key.trim() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/settings/ai/providers/:id/test — Verbindungstest + Modell-Listing
router.post('/ai/providers/:id/test', async (req, res) => {
  const id = String(req.params.id || '').toLowerCase();
  try {
    const settings = await loadDynamicSettings();
    const prov = getProvider(settings, id);
    if (!prov) return res.status(404).json({ error: 'Provider nicht gefunden.' });

    if (prov.typ === 'subscription') {
      if (!subscriptionFeatureUnlocked()) return res.status(403).json({ error: 'Diese Funktion ist nicht freigeschaltet.' });
      if (!prov.apiKey) return res.status(400).json({ error: 'Kein Subscription-Token hinterlegt.' });
      return res.json(await testClaudeSubscription(prov.apiKey));
    }
    // Ohne Key liefert das Listing still eine leere Liste — ein "ok, 0 Modelle"
    // wäre die unbrauchbarste denkbare Antwort auf einen Verbindungstest.
    // Ausnahme: lokale openai-kompatible Ziele brauchen typischerweise keinen Key.
    const brauchtKey = prov.typ !== 'openai-compatible' || prov.id === 'openai';
    const hatKey = !!prov.apiKey
      || (prov.typ === 'bedrock' && !!(process.env.BEDROCK_API_KEY || process.env.AWS_BEARER_TOKEN_BEDROCK));
    if (brauchtKey && !hatKey) {
      return res.status(400).json({ error: `Für "${prov.label}" ist noch kein API-Key hinterlegt.` });
    }

    // Ausdrücklicher Klick ⇒ am Cache vorbei. Danach steht das frische Ergebnis
    // im selben Cache, aus dem /ai/health liest — ein Test aktualisiert also
    // auch gleich die Statusanzeige.
    const models = await listProviderModels(settings, id, { fresh: true });
    // Zweiter Zugriff trifft den Cache (derselbe Aufruf mit fresh:true hat ihn
    // gerade erst befüllt) — kein zweiter Netzwerk-Request.
    const embeddingModels = await listProviderModels(settings, id, { kind: 'embedding' });

    // Capabilities werden VORGESCHLAGEN, nicht erzwungen: ein Modell nimmt einen
    // PDF-Block entgegen und ignoriert ihn still, deshalb bleibt die
    // Deklaration beim Nutzer (siehe lib/llm/registry.js).
    const vorschlag = {
      embeddings: embeddingModels.length > 0,
      vision:     models.some((m) => /vision|llava|vl\b|-vl-|gemma3|qwen2?\.?5?-vl/i.test(m.id)),
    };
    res.json({ ok: true, models, capsVorschlag: vorschlag });
  } catch (err) {
    // Fehler-Body eines privaten Ziels NICHT durchreichen — sonst wäre diese
    // Route ein generisches HTTP-Lesegerät fürs LAN.
    console.warn(`[settings] Provider-Test "${id}" fehlgeschlagen:`, err.message);
    res.status(502).json({ ok: false, error: clientSafeError(err) });
  }
});

// ── Embedding-Slot ───────────────────────────────────────────────────────────

// GET /api/settings/ai/embedding — aktuelle Konfiguration + Bestandsverteilung
router.get('/ai/embedding', async (_req, res) => {
  try {
    const settings = await loadDynamicSettings();
    const cfg = embeddingConfig(settings);
    // Ohne gewähltes Modell gibt es keine aktive Signatur — `null` statt einer
    // Scheinangabe wie "null/null/3072", auf die kein Bestand passen kann.
    const aktiv = cfg.model ? signatureOf(cfg) : null;
    const verteilung = await db.query(
      `SELECT embedding_signature AS signatur, count(*)::int AS anzahl
         FROM postbuch.postbuch WHERE embedding IS NOT NULL
        GROUP BY embedding_signature ORDER BY anzahl DESC`
    );
    const passend = verteilung.rows.find((r) => r.signatur === aktiv)?.anzahl || 0;
    const gesamt = verteilung.rows.reduce((n, r) => n + r.anzahl, 0);
    const hilfe = await getHelpEmbeddingStatus(settings);
    res.json({
      ...cfg,
      signature: aktiv,
      storageDim: STORAGE_DIM,
      bestand: { passend, gesamt, veraltet: gesamt - passend, verteilung: verteilung.rows },
      hilfe,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/settings/ai/embedding — { providerId, model }
// Die Dimension wird NICHT vom Client übernommen, sondern per Probing ermittelt:
// ein einziger embed("test")-Call, Ergebnis autoritativ. Das ist die einzige
// Stelle mit Capability-Probing im System — hier ist es richtig, weil die
// Dimension eine harte, prüfbare Zahl ist.
router.put('/ai/embedding', async (req, res) => {
  const { providerId, model } = req.body || {};
  if (!providerId || typeof model !== 'string' || !model.trim()) {
    return res.status(400).json({ error: '"providerId" und "model" sind erforderlich.' });
  }
  try {
    const settings = await loadDynamicSettings();
    const prov = getProvider(settings, providerId);
    if (!prov) return res.status(404).json({ error: 'Provider nicht gefunden.' });
    if (!prov.caps?.embeddings) {
      return res.status(400).json({ error: `Der Provider "${prov.label}" ist nicht als embedding-fähig konfiguriert.` });
    }

    const dim = await probeEmbeddingDimension(providerId, model.trim(), settings);
    const cfg = { providerId, model: model.trim(), dim };
    await upsertSetting('llm_embedding', cfg);
    await upsertSetting('llm_embedding_signature', signatureOf(cfg));
    appLog('INFO', 'settings', `Embedding-Modell gesetzt: ${signatureOf(cfg)}`, {
      entity: 'settings', entityId: req.session?.username || null,
    });
    res.json({ ok: true, ...cfg, signature: signatureOf(cfg) });
    // Erstinstallation und Providerwechsel: Die Antwort wartet nicht auf den
    // externen Anbieter; der idempotente Job ist in der Aufgabenanzeige sichtbar.
    startHelpEmbeddingJob({ reason: 'provider-konfiguriert' });
  } catch (err) {
    console.warn('[settings] Embedding-Konfiguration fehlgeschlagen:', err.message);
    res.status(400).json({ error: clientSafeError(err) });
  }
});

// ── Kuratierte Modellempfehlungen ────────────────────────────────────────────
//
// Liegt innerhalb dieses Routers und erbt damit requireAdmin. Kein Gegenstück
// in settings-public.js: Empfehlungen sind admin-only, PUBLIC_SETTING_KEYS
// bleibt unverändert.
//
// Im Release-Modus kommt die Liste immer aus der lokalen, mitgelieferten Datei.
// Der erhaltene Online-Rueckweg bleibt strenger: ohne Abo kein Feed-Request.

// GET /api/settings/ai/empfehlungen
router.get('/ai/empfehlungen', async (_req, res) => {
  try {
    const [abo, auto] = await Promise.all([empfehlungen.aboAktiv(), empfehlungen.autoAktiv()]);
    if (empfehlungen.ONLINE_EMPFEHLUNGEN_AKTIV && !abo) {
      return res.json({ abo: false, auto, klassen: [], stand: null, geholtAm: null, hinweis: '', fehler: null, snapshotVorhanden: await empfehlungen.snapshotVorhanden() });
    }
    const [auf, snapshotVorhanden] = await Promise.all([
      empfehlungen.aufloesen(),
      empfehlungen.snapshotVorhanden(),
    ]);
    res.json({ abo, auto, snapshotVorhanden, ...auf });
  } catch (err) {
    console.error('[settings] ai/empfehlungen Fehler:', err);
    res.status(500).json({ error: clientSafeError(err) });
  }
});

// POST /api/settings/ai/empfehlungen/pruefen — Feed jetzt holen
router.post('/ai/empfehlungen/pruefen', async (_req, res) => {
  try {
    if (!empfehlungen.ONLINE_EMPFEHLUNGEN_AKTIV) {
      return res.status(410).json({ error: 'Online-Modellempfehlungen sind in dieser Version deaktiviert.' });
    }
    if (!(await empfehlungen.aboAktiv())) {
      return res.status(409).json({ error: 'Die Empfehlungen sind nicht abonniert.' });
    }
    const cache = await empfehlungen.leseCache();
    const letzte = cache.geholtAm ? Date.parse(cache.geholtAm) : 0;
    const abstand = Date.now() - letzte;
    if (Number.isFinite(letzte) && letzte > 0 && abstand < empfehlungen.PRUEF_ABSTAND_MS) {
      return res.status(429).json({
        error: 'Zu häufig geprüft. Bitte kurz warten.',
        retryAfterSec: Math.ceil((empfehlungen.PRUEF_ABSTAND_MS - abstand) / 1000),
      });
    }
    await empfehlungen.holeEmpfehlungen();
    const [auf, auto, snapshotVorhanden] = await Promise.all([
      empfehlungen.aufloesen({ fresh: true }),
      empfehlungen.autoAktiv(),
      empfehlungen.snapshotVorhanden(),
    ]);
    res.json({ abo: true, auto, snapshotVorhanden, ...auf });
  } catch (err) {
    res.status(502).json({ error: clientSafeError(err) });
  }
});

// POST /api/settings/ai/empfehlungen/abonnieren — Abo einschalten + ersten Stand holen
// Ein einzelner Endpunkt verhindert den Zwischenzustand „abonniert, aber noch
// keine Empfehlungen im Cache“, der nach einem separaten PUT im UI sichtbar wäre.
router.post('/ai/empfehlungen/abonnieren', async (_req, res) => {
  try {
    if (!empfehlungen.ONLINE_EMPFEHLUNGEN_AKTIV) {
      return res.status(410).json({ error: 'Online-Modellempfehlungen sind in dieser Version deaktiviert.' });
    }
    await empfehlungen.abonnierenUndHolen();
    const [auf, auto, snapshotVorhanden] = await Promise.all([
      empfehlungen.aufloesen({ fresh: true }),
      empfehlungen.autoAktiv(),
      empfehlungen.snapshotVorhanden(),
    ]);
    res.json({ abo: true, auto, snapshotVorhanden, ...auf });
  } catch (err) {
    // Das Abo bleibt bewusst aktiv: ein vorübergehend nicht erreichbarer Feed
    // soll nicht die ausdrücklich gewünschte tägliche Aktualisierung widerrufen.
    res.status(502).json({ error: clientSafeError(err) });
  }
});

// POST /api/settings/ai/empfehlungen/automatik — sofort übernehmen + künftig automatisch
router.post('/ai/empfehlungen/automatik', async (req, res) => {
  if (!empfehlungen.ONLINE_EMPFEHLUNGEN_AKTIV) {
    return res.status(410).json({ error: 'Online-Modellempfehlungen sind in dieser Version deaktiviert.' });
  }
  if (!subscriptionFeatureUnlocked()) return res.status(403).json({ error: 'Diese Funktion ist nicht freigeschaltet.' });
  try {
    const ergebnis = await empfehlungen.automatikAktivierenUndAnwenden({
      von: req.session?.username || 'admin',
    });
    const [auf, snapshotVorhanden] = await Promise.all([
      empfehlungen.aufloesen({ fresh: true }),
      empfehlungen.snapshotVorhanden(),
    ]);
    res.json({ abo: true, auto: true, snapshotVorhanden, ergebnis, ...auf });
  } catch (err) {
    console.error('[settings] ai/empfehlungen/automatik Fehler:', err);
    res.status(err.status || 500).json({ error: clientSafeError(err) });
  }
});

// POST /api/settings/ai/empfehlungen/anwenden — Body { klassen: [...] | 'alle' }
router.post('/ai/empfehlungen/anwenden', async (req, res) => {
  try {
    if (empfehlungen.ONLINE_EMPFEHLUNGEN_AKTIV && !(await empfehlungen.aboAktiv())) {
      return res.status(409).json({ error: 'Die Empfehlungen sind nicht abonniert.' });
    }
    const roh = req.body?.klassen;
    const klassen = roh === 'alle'
      ? 'alle'
      : (Array.isArray(roh) ? roh.filter((k) => typeof k === 'string').slice(0, 50) : null);
    if (!klassen || (Array.isArray(klassen) && !klassen.length)) {
      return res.status(400).json({ error: 'Es wurde keine Klasse angegeben.' });
    }
    const ergebnis = await empfehlungen.anwenden(klassen, { von: req.session?.username || 'admin' });
    res.json(ergebnis);
  } catch (err) {
    console.error('[settings] ai/empfehlungen/anwenden Fehler:', err);
    res.status(err.status || 500).json({ error: clientSafeError(err) });
  }
});

// POST /api/settings/ai/empfehlungen/zuruecksetzen — Snapshot wiederherstellen
router.post('/ai/empfehlungen/zuruecksetzen', async (_req, res) => {
  try {
    res.json(await empfehlungen.zuruecksetzen());
  } catch (err) {
    res.status(err.status || 500).json({ error: clientSafeError(err) });
  }
});

// ── Cloudfrei-Check ──────────────────────────────────────────────────────────

// GET /api/settings/cloudfree-check — „Verlässt hier gerade etwas das Haus?"
//
// Liegt bewusst INNERHALB dieses Routers und erbt damit requireAdmin. Ein
// eigener Top-Level-Mount würde die Reihenfolge in index.js (unprotected →
// requireAuth → Write-Protection → geschützt) umgehen; und die Zeilenliste ist
// eine vollständige Karte aller Datenabflüsse dieser Instanz — nichts, was ein
// lesezugriff-Nutzer bekommen soll. Die Antwort selbst enthält nur Booleans
// und Anzeigenamen, keine Hosts (siehe lib/cloudfrei.js).
router.get('/cloudfree-check', async (_req, res) => {
  try {
    res.json(cloudfreiBericht(await loadDynamicSettings(), {
      pushEmpfaenger: await ermittlePushEmpfaenger(),
    }));
  } catch (err) {
    console.error('[settings] cloudfree-check Fehler:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/settings/ai/subscription/test — Lebendigkeits-Test des Subscription-Tokens
router.post('/ai/subscription/test', async (req, res) => {
  if (!subscriptionFeatureUnlocked()) {
    return res.status(403).json({ error: 'Claude-Subscription ist auf dieser Instanz nicht freigeschaltet.' });
  }
  try {
    const settings = await loadDynamicSettings();
    const token = settings.llm_claude_oauth_token;
    if (!token) return res.status(400).json({ error: 'Kein Subscription-Token hinterlegt.' });
    const result = await testClaudeSubscription(token);
    res.json(result);
  } catch (err) {
    console.error('[settings] ai/subscription/test Fehler:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Hinweis: /ai/tier-models und /ai/cache-mode liegen jetzt in
// routes/settings-public.js — sie werden auch von Nicht-Admins gebraucht
// (Wiederverarbeitungs-Dialog bzw. Cache-Mode-Panel auf der Import-Seite).

// GET /api/settings/ai/models/:provider — Modell-Liste für das Dropdown.
// :provider ist seit 1.7.0 eine providerId, nicht mehr einer von drei festen
// Namen. Für die Built-ins bleibt das wertgleich (ihre IDs heißen genauso).
//
// Seit 1.8.0 nur noch ein Wrapper um listProviderModels() aus lib/ai-health.js:
// die Listing-Logik stand vorher zweimal im Code (einmal hier mit Anzeigenamen
// und OpenAI-Filter, einmal dort mit Cache) und wäre zwangsläufig gedriftet.
// Das Frontend liest die Listen inzwischen aus /ai/health mit; diese Route
// bleibt für den ausdrücklichen „Testen"-Klick (?fresh=1).
router.get('/ai/models/:provider', async (req, res) => {
  const id = String(req.params.provider || '').toLowerCase();
  try {
    const settings = await loadDynamicSettings();
    const prov = getProvider(settings, id);
    if (!prov) return res.status(400).json({ error: 'Unbekannter Provider.' });

    if (prov.typ === 'subscription') {
      if (!subscriptionFeatureUnlocked()) return res.status(403).json({ error: 'Diese Funktion ist nicht freigeschaltet.' });
      // Das Abo hat kein eigenes Listing und nutzt Anthropic-Modell-IDs.
      return res.json(await listProviderModels(settings, 'anthropic', { fresh: req.query.fresh === '1' })
        .catch(() => []));
    }
    res.json(await listProviderModels(settings, id, { fresh: req.query.fresh === '1' }));
  } catch (err) {
    // listProviderModels wirft bereits mit client-sicherem Text.
    console.warn(`[settings] ai/models "${id}" Fehler:`, err.message);
    res.status(502).json({ error: clientSafeError(err) });
  }
});

// Hinweis: /debug-mode (GET + POST) liegt jetzt in routes/settings-public.js —
// der Umschalter sitzt auf der Logs-Seite, die auch Nicht-Admins sehen koennen.

// ── GET /api/settings/prompts-preview ───────────────────────────────────────
// Nur informatorisch (Admin-only): liefert ALLE an das LLM gesendeten System-
// Prompts mit zur Laufzeit aufgelösten Variablen (Personen-/Patientenlisten,
// eigene Klassifikations-Hinweise). Keine Änderungsmöglichkeit, reine Anzeige.
//
// Hinweis: Prompts, deren Variablen erst pro Dokument zur Laufzeit feststehen
// (z. B. die EB-Kürzungs-Zuordnung mit konkreten Belegen/Rechnungspositionen),
// werden mit Beispieldaten befüllt und als `dynamic: true` markiert.

router.get('/prompts-preview', async (req, res) => {
  try {
    const settings = await loadDynamicSettings();

    // Aktive Menschen → Klassifikations-Prompt (wie in document-processor.js)
    const activePersons = await db.query(
      `SELECT kurzname, anzeigename AS vollname, ist_tier, pkv, beihilfe, pkv_satz, beihilfe_satz, archiviert
         FROM postbuch.mensch
        WHERE archiviert = false
        ORDER BY kurzname`
    );

    // Alle PKV/Beihilfe-Patienten (auch archivierte) → EB-Parse-Prompt
    // (wie in service/erstattungsbescheid.js)
    const ebPatients = await db.query(
      `SELECT kurzname, anzeigename AS vollname, ist_tier, pkv, beihilfe, pkv_satz, beihilfe_satz
         FROM postbuch.mensch
        WHERE pkv = true OR beihilfe = true
        ORDER BY kurzname`
    );

    const customRules = settings.classification_custom_rules || '';

    // Beispieldaten für den ausschließlich zur Laufzeit befüllten Match-Prompt,
    // damit Struktur und Einbettung sichtbar werden.
    const beispielKuerzungen = {
      'Beleg 1': [
        { eb_subid: 1, kuerzung_index: 0, betrag: 12.5, begruendung: '(Beispiel) Höchstbetrag nach GOÄ überschritten' },
      ],
    };
    const beispielEinzelpositionen = [
      { postid: 'P000001', subid: 1, goaeZiffer: '1', leistung: '(Beispiel) Beratung', betrag: 25.0 },
    ];

    const prompts = [
      {
        id: 'classification',
        title: 'Dokument-Klassifikation',
        description: 'Haupt-Systemprompt der KI-Analyse (lib/llm.js → analyzeDocument). Variablen: aktive Familienmitglieder/Patienten und eigene Klassifikations-Hinweise.',
        dynamic: false,
        system: buildLxdClassificationPrompt(activePersons.rows, customRules, await getAktiveTaxonomie()),
      },
      {
        id: 'pre-analysis',
        title: 'Vorab-Schwierigkeitseinschätzung',
        description: 'Voranalyse zur Modellwahl (lib/llm.js → assessDifficulty). Statisch, keine Variablen.',
        dynamic: false,
        system: PRE_ANALYSIS_SYSTEM_PROMPT,
        userMessage: PRE_ANALYSIS_USER_MESSAGE,
      },
      {
        id: 'eb-parse',
        title: 'Erstattungsbescheid-Parsing',
        description: 'Extraktion aus Erstattungsbescheiden/Leistungsmitteilungen (service/erstattungsbescheid.js). Variable: alle PKV/Beihilfe-Patienten (auch archivierte).',
        dynamic: false,
        system: buildEbParsePrompt(ebPatients.rows),
      },
      {
        id: 'eb-match',
        title: 'EB-Kürzungs-Zuordnung',
        description: 'Ordnet EB-Kürzungen den Arztrechnungs-Einzelpositionen zu (service/erstattungsbescheid.js). Die Kürzungen und Rechnungspositionen stehen erst pro Dokument zur Laufzeit fest — hier mit Beispieldaten gefüllt.',
        dynamic: true,
        system: buildMatchKuerzungenPrompt(beispielKuerzungen, beispielEinzelpositionen),
      },
    ];

    res.json({ prompts });
  } catch (err) {
    console.error('[settings] GET /prompts-preview Fehler:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
