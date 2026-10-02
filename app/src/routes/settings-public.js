/**
 * routes/settings-public.js — Settings-Endpunkte für ALLE eingeloggten Nutzer
 *
 * Gegenstück zu routes/settings.js, das komplett hinter `requireAdmin` liegt.
 * Hier steht ausschließlich, was das UI auch Nicht-Admins zeigen muss:
 *
 *   GET  /api/settings-public                  → Feld-Whitelist aus _settings
 *   GET  /api/settings-public/debug-mode
 *   POST /api/settings-public/debug-mode       (lesezugriff blockt die globale Write-Protection)
 *   GET  /api/settings-public/backup-status    → nur das enabled-Bit, für den Warnbanner
 *   GET  /api/settings-public/importwege       → aufgelöste Pfade für die Importwege-Seite
 *   GET  /api/settings-public/ai/health        → ohne Provider-Fehlertexte
 *   GET  /api/settings-public/ai/tier-models
 *   GET  /api/settings-public/ai/cache-mode
 *   PUT  /api/settings-public/ai/cache-mode
 *
 * Bewusst als **Whitelist** gebaut, nicht als Blockliste: eine neue Einstellung
 * ist damit standardmäßig nicht sichtbar. Genau die umgekehrte Logik hat die
 * SECRET_KEYS-Blockliste in settings.js fragil gemacht (der VAPID-Private-Key
 * stand jahrelang nicht darin).
 *
 * Der Router hängt hinter dem globalen requireAuth-Gate — "public" heißt
 * "für jede Rolle", nicht "ohne Login".
 */

import { Router } from 'express';
import { loadDynamicSettings, getFolders, getActiveBackendName } from '../config.js';
import { ermittleWurzelPfad } from '../service/storage-setup.js';
import db from '../db.js';
import { appLog } from '../app-log.js';
import { getCacheMode, setCacheMode } from '../lib/cache-mode.js';
import { subscriptionFeatureUnlocked } from '../lib/claude-subscription.js';
import { resolveTierModelConfig, capsForRef, providerForRef, kannDokumentSehen } from '../lib/llm.js';
import { buildAiHealthRedacted } from '../lib/ai-health.js';
import { gesamtbild as einrichtungGesamtbild } from './einrichtung.js';

const router = Router();

// Einstellungen, die jede Rolle lesen darf — jeweils mit dem UI, das sie braucht.
const PUBLIC_SETTING_KEYS = new Set([
  'instance_name',        // Sidebar/Dashboard-Titel, VerbleibBadge-Etikett
  'nav_visibility',       // Sidebar: Salden-/Logs-Einträge ein-/ausblenden
  'scanner_has_adf',      // ImportPage: verfügbare Scan-Quellen
  'scanner_supports_a3',  // ImportPage: verfügbare Formate
  'scanner_adf_duplex',   // ImportPage: Duplex-Option
  'scanner_default_dpi',  // ImportPage: Vorauswahl Auflösung
  'scanner_default_mode', // ImportPage: Vorauswahl Farbmodus
  // ImportPage: welche Auflösungen/Farbmodi je Quelle wirklich gehen. Enthält
  // per Konstruktion nur Gerätefähigkeiten — die Scanner-Adresse bleibt ein
  // Admin-Feld und wird in lib/scanner-capabilities.js nie mit übernommen.
  'scanner_capabilities',
]);

// ── GET /api/settings-public ─────────────────────────────────────────────────
// Gibt ausschließlich die oben gelisteten Keys zurück (Form wie /api/settings:
// { key: { value, updatedAt } }), damit die Frontend-Zugriffe identisch bleiben.

router.get('/', async (req, res) => {
  try {
    const rows = await db.query(
      'SELECT key, value, updated_at FROM postbuch._settings WHERE key = ANY($1) ORDER BY key',
      [[...PUBLIC_SETTING_KEYS]]
    );
    const result = {};
    for (const r of rows.rows) {
      result[r.key] = { value: r.value, updatedAt: r.updated_at };
    }
    res.json(result);
  } catch (err) {
    console.error('[settings-public] GET / Fehler:', err);
    res.status(500).json({ error: err.message });
  }
});

// Schlanker, geheimnisfreier Gate-Zustand für jede eingeloggte Rolle. Der
// eigentliche Assistent bleibt admin-only; Nicht-Admins brauchen nur die
// Information, dass die betreibende Person noch einrichtet.
router.get('/einrichtung-gate', async (req, res) => {
  try {
    const bild = await einrichtungGesamtbild();
    // Gesperrt wird ausschließlich eine Instanz, die der Installer als echte
    // Erstinstallation markiert hat (`bild.sperrt`). Ein nachträglich von Hand
    // geöffneter Assistent darf eine laufende Instanz — und erst recht ein
    // Update beim Kunden — niemals aussperren.
    const blockiert = bild.sperrt
      && bild.pflichtOffen.length > 0
      && req.session?.einrichtungBypass !== true;
    res.json({
      status: bild.status,
      blockiert,
      pflichtOffen: blockiert ? bild.pflichtOffen : [],
    });
  } catch (err) {
    console.error('[settings-public] einrichtung-gate Fehler:', err);
    res.status(500).json({ error: 'Einrichtungszustand konnte nicht gelesen werden.' });
  }
});

// ── GET /api/settings-public/debug-mode ──────────────────────────────────────

router.get('/debug-mode', async (req, res) => {
  try {
    const settings = await loadDynamicSettings();
    res.json({ enabled: settings.debug_mode?.enabled ?? false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/settings-public/debug-mode ─────────────────────────────────────
// Body: { enabled: true|false }
// Schreibberechtigt, nicht admin-only: der Umschalter sitzt auf der Logs-Seite,
// die auch Nicht-Admins sehen können (nav_visibility). Kein Geheimnis betroffen.

router.post('/debug-mode', async (req, res) => {
  try {
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'Feld "enabled" muss boolean sein' });
    }
    await db.query(
      `INSERT INTO postbuch._settings (key, value, updated_at)
       VALUES ('debug_mode', $1::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $1::jsonb, updated_at = NOW()`,
      [JSON.stringify({ enabled })]
    );
    appLog('INFO', 'settings', `Debug-Modus ${enabled ? 'aktiviert' : 'deaktiviert'}`, {
      entity: 'postbuch',
      entityId: req.session?.username || null,
    });
    res.json({ enabled });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/settings-public/backup-status ───────────────────────────────────
// Für den Warnbanner auf dem Dashboard (alle Rollen) und den Update-Dialog.
// Nur das Bit, das für die Warnung zählt — Cron-Ausdruck & Co. bleiben
// admin-only in /api/backup/settings. Ein Cron, der mangels Ablage-Ordner
// jede Nacht folgenlos abbricht (siehe jobs/backup.js), zählt hier als aus.

router.get('/backup-status', async (req, res) => {
  try {
    const settings = await loadDynamicSettings();
    const backupConfig = settings.backup ?? { enabled: false };
    res.json({ enabled: backupConfig.enabled === true && !!getFolders(settings).backup });
  } catch (err) {
    console.error('[settings-public] backup-status Fehler:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/settings-public/importwege ──────────────────────────────────────
// Für die Seite „Dokumente importieren" (alle Rollen). Sie nennt konkrete
// Pfade und Intervalle statt Platzhaltern — geraten wird davon nichts.
//   { backend, rootPath, inboxPfad, polling: {enabled, intervalSec}, scannerKonfiguriert }
// rootPath/inboxPfad === null heißt „Ablage noch nicht eingerichtet oder gerade
// nicht erreichbar"; die Seite schreibt dann keinen Pfad hin.

router.get('/importwege', async (_req, res) => {
  try {
    const settings = await loadDynamicSettings();
    const backend = getActiveBackendName(settings);
    let rootPath = null;
    try {
      rootPath = await ermittleWurzelPfad(backend);
    } catch {
      // Backend gerade nicht erreichbar — die Seite kommt ohne Pfad aus.
    }
    const polling = settings.onedrive_polling || {};
    res.json({
      backend,
      rootPath,
      inboxPfad: rootPath === null ? null : [rootPath, '_inbox'].filter(Boolean).join('/'),
      polling: {
        enabled: polling.enabled === true,
        intervalSec: Number(polling.intervalSec) > 0 ? Number(polling.intervalSec) : 60,
      },
      scannerKonfiguriert: !!String(settings.scanner_device_url || '').trim(),
    });
  } catch (err) {
    console.error('[settings-public] importwege Fehler:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/settings-public/ai/health ───────────────────────────────────────
// Für das Warnbanner auf dem Dashboard. Ohne Provider-Fehlertexte und ohne Region.

router.get('/ai/health', async (req, res) => {
  try {
    res.json(await buildAiHealthRedacted());
  } catch (err) {
    console.error('[settings-public] ai/health Fehler:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/settings-public/ai/tier-models ──────────────────────────────────
// Modellstufen für die Auswahl bei der Wiederverarbeitung (ActionBar).

router.get('/ai/tier-models', async (req, res) => {
  try {
    const settings = await loadDynamicSettings();
    const tiers = {};
    for (const t of ['leicht', 'mittel', 'schwierig', 'large']) {
      const cfg = resolveTierModelConfig(t, settings);
      const caps = capsForRef(settings, cfg);
      // textOnly steuert im Wiederverarbeitungs-Dialog den Schalter „Textebene
      // verwerfen": nur bei einem Provider, der weder PDF noch Bilder sehen
      // kann (kannDokumentSehen), ist die OCR-Ebene das einzige verwertbare
      // Signal — sie zu verwerfen hieße, dem Modell ein leeres Dokument zu
      // schicken. Ein vision-Provider sieht die Seite stattdessen über den
      // Rasterizer (lib/pdf.js renderPdfToImages), Verwerfen ist dort erwünscht.
      tiers[t] = {
        ...cfg,
        providerLabel: providerForRef(settings, cfg)?.label || cfg.providerId,
        caps,
        textOnly: !kannDokumentSehen(caps),
      };
    }
    const subscriptionEnabled =
      subscriptionFeatureUnlocked() && settings.llm_claude_subscription_enabled === true;
    res.json({ tiers, subscription: { enabled: subscriptionEnabled } });
  } catch (err) {
    console.error('[settings-public] ai/tier-models Fehler:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET/PUT /api/settings-public/ai/cache-mode ───────────────────────────────
// Batch-Modus-Panel auf der Import-Seite. Kein Geheimnis, kein Provider-Wechsel —
// nur ein Umschalter auf eine bereits konfigurierte Modellstufe.

router.get('/ai/cache-mode', async (req, res) => {
  try {
    const settings = await loadDynamicSettings();
    res.json(await getCacheMode(settings));
  } catch (err) {
    console.error('[settings-public] ai/cache-mode GET Fehler:', err);
    res.status(500).json({ error: err.message });
  }
});

// Body: { active: boolean, tier?: 'leicht'|'mittel'|'schwierig' }
router.put('/ai/cache-mode', async (req, res) => {
  const { active, tier } = req.body || {};
  try {
    await setCacheMode({ active: active === true, tier });
    const settings = await loadDynamicSettings();
    appLog('INFO', 'cache-mode', `Cache-Mode ${active ? `aktiviert (${tier})` : 'deaktiviert'}`, {
      entity: 'settings', entityId: req.session?.username || null,
    });
    res.json(await getCacheMode(settings));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
