/** Admin-Assistent zur Scanner-Kalibrierung – bewusst ohne DB-Testdokumente. */
import { Router } from 'express';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import db from '../db.js';
import { loadDynamicSettings } from '../config.js';
import { quelleAusCapabilities } from '../lib/scanner-capabilities.js';

const router = Router();
const ROOT = '/data/scanner_test';
const SCANNER_URL = process.env.SCANNER_URL || 'http://scanner:8080';
const CLEANER_URL = process.env.CLEANER_URL || 'http://cleaner:8090';
const SLOTS = [1, 2, 3];

const PARAMS = {
  blankMeanMin: { setting: 'cleaner_blank_mean_min', fallback: 240, min: 0, max: 255, integer: true },
  blankStddevMax: { setting: 'cleaner_blank_stddev_max', fallback: 12, min: 0, max: 255 },
  blankContentThreshold: { setting: 'cleaner_blank_content_threshold', fallback: 200, min: 0, max: 255, integer: true },
  blankMaskMaxContentPx: { setting: 'cleaner_blank_mask_max_content_px', fallback: 200, min: 0, max: 1000000, integer: true },
  contentThreshold: { setting: 'cleaner_content_threshold', fallback: 200, min: 0, max: 255, integer: true },
  contentDenoiseMinPx: { setting: 'cleaner_content_denoise_min_px', fallback: 10, min: 0, max: 20, integer: true },
  detectDpi: { setting: 'cleaner_detect_dpi', fallback: 75, min: 50, max: 300, integer: true },
};

function slotPath(slot) {
  return path.join(ROOT, `slot-${slot}.pdf`);
}

function previewPath(slot) {
  return path.join(ROOT, 'previews', `slot-${slot}.png`);
}

function rawPreviewPath(slot) {
  return path.join(ROOT, 'previews', `raw-slot-${slot}.png`);
}

function parseSlot(raw) {
  const slot = Number(raw);
  return SLOTS.includes(slot) ? slot : null;
}

function normalizeParameters(input) {
  const output = {};
  for (const [key, rule] of Object.entries(PARAMS)) {
    const value = Number(input?.[key]);
    if (!Number.isFinite(value) || value < rule.min || value > rule.max || (rule.integer && !Number.isInteger(value))) {
      throw new Error(`${key} muss zwischen ${rule.min} und ${rule.max} liegen${rule.integer ? ' und ganzzahlig sein' : ''}.`);
    }
    output[key] = value;
  }
  return output;
}

async function pageInfo(slot) {
  try {
    const info = await stat(slotPath(slot));
    return { slot, exists: true, updatedAt: info.mtime.toISOString(), size: info.size };
  } catch (err) {
    if (err.code === 'ENOENT') return { slot, exists: false };
    throw err;
  }
}

router.get('/', async (_req, res) => {
  try {
    await mkdir(ROOT, { recursive: true });
    const settings = await loadDynamicSettings();
    const flatbed = quelleAusCapabilities(settings.scanner_capabilities || null, 'flatbed');
    const parameters = Object.fromEntries(Object.entries(PARAMS).map(([key, rule]) => [
      key, settings[rule.setting] ?? rule.fallback,
    ]));
    res.json({
      pages: await Promise.all(SLOTS.map(pageInfo)),
      parameters,
      scanner: {
        resolutions: flatbed.aufloesungen,
        modes: flatbed.modi,
        sizes: settings.scanner_supports_a3 ? ['a3', 'a4', 'a5', 'a6'] : ['a4', 'a5', 'a6'],
        defaultDpi: settings.scanner_default_dpi ?? 300,
        defaultMode: settings.scanner_default_mode ?? 'gray',
      },
    });
  } catch (err) {
    console.error('[scanner-tuning] Status fehlgeschlagen:', err);
    res.status(500).json({ error: 'Kalibrierungsstatus konnte nicht geladen werden.' });
  }
});

router.post('/pages/:slot/scan', async (req, res) => {
  const slot = parseSlot(req.params.slot);
  if (!slot) return res.status(400).json({ error: 'Testseiten-Slot muss 1, 2 oder 3 sein.' });
  const { dpi = 300, mode = 'gray', size = 'a4' } = req.body || {};
  try {
    const settings = await loadDynamicSettings();
    const allowed = quelleAusCapabilities(settings.scanner_capabilities || null, 'flatbed');
    if (!allowed.aufloesungen.includes(Number(dpi))) {
      return res.status(400).json({ error: `DPI muss einer von ${allowed.aufloesungen.join(', ')} sein.` });
    }
    if (!allowed.modi.includes(mode)) return res.status(400).json({ error: 'Dieser Farbmodus wird vom Flachbett nicht unterstützt.' });
    if (!['a3', 'a4', 'a5', 'a6'].includes(size)) return res.status(400).json({ error: 'Ungültiges Papierformat.' });
    if (size === 'a3' && !settings.scanner_supports_a3) return res.status(400).json({ error: 'A3 ist in den Scanner-Einstellungen deaktiviert.' });

    const query = new URLSearchParams({ slot: String(slot), dpi: String(Number(dpi)), mode, size });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);
    let response;
    try {
      response = await fetch(`${SCANNER_URL}/scan/test/single?${query}`, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return res.status(response.status).json({ error: data.msg || data.error || 'Test-Scan fehlgeschlagen.' });
    res.json({ ok: true, page: await pageInfo(slot) });
  } catch (err) {
    console.error('[scanner-tuning] Test-Scan fehlgeschlagen:', err);
    res.status(err.name === 'AbortError' ? 504 : 502).json({ error: err.name === 'AbortError' ? 'Scanner-Timeout nach zwei Minuten.' : `Scanner nicht erreichbar: ${err.message}` });
  }
});

router.delete('/pages/:slot', async (req, res) => {
  const slot = parseSlot(req.params.slot);
  if (!slot) return res.status(400).json({ error: 'Testseiten-Slot muss 1, 2 oder 3 sein.' });
  try {
    await Promise.all([
      rm(slotPath(slot), { force: true }),
      rm(previewPath(slot), { force: true }),
      rm(rawPreviewPath(slot), { force: true }),
    ]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Testseite konnte nicht gelöscht werden.' });
  }
});

router.delete('/pages', async (_req, res) => {
  try {
    await Promise.all(SLOTS.flatMap((slot) => [
      rm(slotPath(slot), { force: true }), rm(previewPath(slot), { force: true }),
      rm(rawPreviewPath(slot), { force: true }),
    ]));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Testseiten konnten nicht gelöscht werden.' });
  }
});

router.post('/render', async (_req, res) => {
  try {
    const pages = await Promise.all(SLOTS.map(pageInfo));
    const slots = pages.filter((page) => page.exists).map((page) => page.slot);
    const response = await fetch(`${CLEANER_URL}/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slots }),
      signal: AbortSignal.timeout(90_000),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return res.status(response.status).json({ error: data.error || 'Vorschau fehlgeschlagen.' });
    res.json(data);
  } catch (err) {
    console.error('[scanner-tuning] Rohvorschau fehlgeschlagen:', err);
    res.status(502).json({ error: 'Cleaner für die Rohvorschau nicht erreichbar.' });
  }
});

router.post('/analyze', async (req, res) => {
  try {
    const parameters = normalizeParameters(req.body?.parameters);
    const pages = await Promise.all(SLOTS.map(pageInfo));
    const slots = pages.filter((page) => page.exists).map((page) => page.slot);
    const response = await fetch(`${CLEANER_URL}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slots, parameters }),
      signal: AbortSignal.timeout(90_000),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return res.status(response.status).json({ error: data.error || 'Analyse fehlgeschlagen.' });
    res.json(data);
  } catch (err) {
    if (err.message?.includes('muss zwischen')) return res.status(400).json({ error: err.message });
    console.error('[scanner-tuning] Analyse fehlgeschlagen:', err);
    res.status(502).json({ error: 'Cleaner für die Liveanalyse nicht erreichbar.' });
  }
});

router.get('/previews/:slot', async (req, res) => {
  const slot = parseSlot(req.params.slot);
  if (!slot) return res.status(400).json({ error: 'Ungültiger Slot.' });
  res.set('Cache-Control', 'no-store');
  res.sendFile(previewPath(slot), (err) => {
    if (err && !res.headersSent) res.status(err.code === 'ENOENT' ? 404 : 500).json({ error: 'Vorschau nicht verfügbar.' });
  });
});

router.get('/raw-previews/:slot', async (req, res) => {
  const slot = parseSlot(req.params.slot);
  if (!slot) return res.status(400).json({ error: 'Ungültiger Slot.' });
  res.set('Cache-Control', 'no-store');
  res.sendFile(rawPreviewPath(slot), (err) => {
    if (err && !res.headersSent) res.status(err.code === 'ENOENT' ? 404 : 500).json({ error: 'Rohvorschau nicht verfügbar.' });
  });
});

router.post('/apply', async (req, res) => {
  let parameters;
  try {
    parameters = normalizeParameters(req.body?.parameters);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    for (const [key, value] of Object.entries(parameters)) {
      const setting = PARAMS[key].setting;
      await client.query(
        `INSERT INTO postbuch._settings (key, value, updated_at)
         VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [setting, JSON.stringify(value)],
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true, parameters });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[scanner-tuning] Übernahme fehlgeschlagen:', err);
    res.status(500).json({ error: 'Kalibrierungswerte konnten nicht übernommen werden.' });
  } finally {
    client.release();
  }
});

export default router;
