/**
 * routes/personen.js — lesender Alias auf die Menschen.
 *
 *   GET /api/personen — Liste aller Menschen (inkl. archivierter) + Verknüpfungs-Counts
 *
 * Schreibend ist ausschließlich `routes/menschen.js` zuständig: fachliche Person
 * und App-Zugang liegen gemeinsam in `postbuch.mensch`. Diese Route bleibt als
 * schlanke Lesequelle für Dropdowns, Filter und Badges im Frontend bestehen.
 */

import { Router } from 'express';
import { query } from '../db.js';
import { eigeneDokumenteBedingung } from '../middleware/lesebereich.js';

const router = Router();

// ── GET / ────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    // Eingeschränkter Lesebereich: nur die eigene Person.
    const params = [];
    const eigene = eigeneDokumenteBedingung(req, 'p.kurzname', params);
    const result = await query(
      `SELECT p.kurzname, p.anzeigename AS vollname, p.ist_tier, p.pkv, p.beihilfe, p.pkv_satz, p.beihilfe_satz, p.archiviert, p.farbe,
              p.created_at, p.updated_at,
              (SELECT COUNT(*)::int FROM postbuch.arztrechnung WHERE behandelte_person = p.kurzname) AS arz_count,
              (SELECT COUNT(*)::int FROM postbuch.arztbericht WHERE behandelte_person = p.kurzname) AS ab_count,
              (SELECT COUNT(*)::int FROM postbuch.erstattungsbescheid_einzelposition WHERE behandelte_person = p.kurzname) AS eb_count,
              (SELECT COUNT(*)::int FROM postbuch.postbuch WHERE familienmitglied = p.kurzname) AS adressat_count
       FROM postbuch.mensch p
       ${eigene ? `WHERE ${eigene}` : ''}
       ORDER BY p.archiviert ASC, p.kurzname ASC`,
      params,
    );
    const data = result.rows.map((r) => ({
      ...r,
      // Behandelter Patient: medizinisch verknüpft (3 Tabellen)
      behandelt_count: (r.arz_count || 0) + (r.ab_count || 0) + (r.eb_count || 0),
      // Familienmitglied (Adressat oder Absender): postbuch.familienmitglied
      link_count: (r.arz_count || 0) + (r.ab_count || 0) + (r.eb_count || 0) + (r.adressat_count || 0),
    }));
    res.json({ data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
