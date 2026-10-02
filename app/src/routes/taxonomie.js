/** LxD-Taxonomie: breit lesbar, Pflege ausschließlich admin-only. */
import { Router } from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { query } from '../db.js';
import { getGesamteTaxonomie } from '../lib/taxonomie.js';

const router = Router();
const ERLAUBTE_FELDER = new Set(['label', 'erlaeuterung', 'aktiv', 'sortierung']);

function saubererText(value, max, feld) {
  if (typeof value !== 'string') throw new Error(`${feld} muss Text sein.`);
  const text = value.normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, '')
    .trim();
  if (!text || text.length > max) throw new Error(`${feld} ist ungültig.`);
  return text;
}

function normalisierePatch(body) {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  if (!input) throw new Error('Ungültiger Request-Body.');
  const keys = Object.keys(input);
  if (!keys.length || keys.some((key) => !ERLAUBTE_FELDER.has(key))) {
    throw new Error('Nur label, erlaeuterung, aktiv und sortierung dürfen geändert werden.');
  }
  const values = {};
  if ('label' in input) values.label = saubererText(input.label, 120, 'label');
  if ('erlaeuterung' in input) values.erlaeuterung = saubererText(input.erlaeuterung, 2000, 'erlaeuterung');
  if ('aktiv' in input) {
    if (typeof input.aktiv !== 'boolean') throw new Error('aktiv muss boolean sein.');
    values.aktiv = input.aktiv;
  }
  if ('sortierung' in input) {
    if (!Number.isInteger(input.sortierung) || input.sortierung < 1 || input.sortierung > 999) {
      throw new Error('sortierung muss eine ganze Zahl zwischen 1 und 999 sein.');
    }
    values.sortierung = input.sortierung;
  }
  return values;
}

router.get('/', async (_req, res) => {
  try {
    const t = await getGesamteTaxonomie();
    res.json({ lebensbereich: t.lebensbereiche, dokumentart: t.dokumentarten, sdAktivierung: t.aktivierungen });
  } catch (err) {
    console.error('[taxonomie] Lesen:', err);
    res.status(500).json({ error: 'Taxonomie konnte nicht geladen werden.' });
  }
});

function patchRoute(tabelle) {
  return async (req, res) => {
    let patch;
    try { patch = normalisierePatch(req.body); } catch (err) { return res.status(400).json({ error: err.message }); }
    const felder = Object.keys(patch);
    const assignments = felder.map((feld, i) => `${feld} = $${i + 1}`).join(', ');
    try {
      const result = await query(
        `UPDATE postbuch.${tabelle} SET ${assignments} WHERE code = $${felder.length + 1} RETURNING *`,
        [...felder.map((feld) => patch[feld]), req.params.code],
      );
      if (!result.rows[0]) return res.status(404).json({ error: 'Taxonomieeintrag nicht gefunden.' });
      res.json(result.rows[0]);
    } catch (err) {
      console.error('[taxonomie] Pflege:', err);
      res.status(500).json({ error: 'Taxonomieeintrag konnte nicht geändert werden.' });
    }
  };
}

router.patch('/lebensbereich/:code', requireAdmin, patchRoute('lebensbereich'));
router.patch('/dokumentart/:code', requireAdmin, patchRoute('dokumentart'));

export default router;
