/**
 * routes/verbleib.js — Originalverbleib-Kategorien + physische Ablagen
 *
 * Kategorien (admin-only):
 *   GET    /api/verbleib            — Aktive Kategorien (Badge-Dropdown)
 *   GET    /api/verbleib/all        — Alle inkl. archivierter
 *   POST   /api/verbleib            — Neue Kategorie anlegen
 *   PUT    /api/verbleib/:id        — Kategorie umbenennen / Icon ändern
 *   DELETE /api/verbleib/:id        — Archivieren
 *
 * Ablagen (ab Schreibzugriff):
 *   GET    /api/verbleib/ablagen                  — Liste (Query: kategorie_id?, archived?)
 *   POST   /api/verbleib/ablagen                  — Neue Ablage anlegen
 *   PUT    /api/verbleib/ablagen/:id              — Umbenennen / Kategorie ändern
 *   PATCH  /api/verbleib/ablagen/:id/archive      — Archivieren / Reaktivieren toggle
 *   POST   /api/verbleib/ablagen/:id/aufloesen    — Auflösen mit Dokument-Migration
 */

import { Router } from 'express';
import { query } from '../db.js';
import { requireAdmin, requireWrite } from '../middleware/auth.js';
import { appLog } from '../app-log.js';

const router = Router();

const ICON_NAME_RE = /^[A-Z][a-zA-Z0-9]+$/;

function validateIcon(icon) {
  return typeof icon === 'string' && ICON_NAME_RE.test(icon) && icon.length <= 40;
}

// GET / — aktive Kategorien, sortiert nach sort_order
router.get('/', async (_req, res) => {
  try {
    const result = await query(
      `SELECT id, name, icon, sort_order, archived
       FROM postbuch.verbleib_kategorie
       WHERE archived = false
       ORDER BY sort_order ASC, id ASC`
    );
    res.json({ data: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /all — alle inkl. archivierter (Admin)
router.get('/all', requireAdmin, async (_req, res) => {
  try {
    const result = await query(
      `SELECT id, name, icon, sort_order, archived, created_at,
              (SELECT COUNT(*)::int FROM postbuch.postbuch WHERE verbleib_id = vk.id) AS doc_count
       FROM postbuch.verbleib_kategorie vk
       ORDER BY archived ASC, sort_order ASC, id ASC`
    );
    res.json({ data: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST / — neue Kategorie anlegen (Admin)
router.post('/', requireAdmin, async (req, res) => {
  try {
    const { name, icon, sort_order } = req.body || {};
    if (typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ error: 'name fehlt oder ist leer' });
    }
    if (!validateIcon(icon)) {
      return res.status(400).json({ error: 'icon muss ein gültiger Lucide-Icon-Name sein (z. B. Folder)' });
    }
    const sortVal = typeof sort_order === 'number' ? sort_order : 99;
    const result = await query(
      `INSERT INTO postbuch.verbleib_kategorie (name, icon, sort_order)
       VALUES ($1, $2, $3)
       RETURNING id, name, icon, sort_order, archived`,
      [name.trim(), icon, sortVal]
    );
    appLog('INFO', 'verbleib', `Kategorie angelegt: ${name.trim()}`);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /:id — umbenennen / Icon / sort_order ändern (Admin)
router.put('/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({ error: 'Ungültige ID' });
    }
    const { name, icon, sort_order } = req.body || {};
    const updates = [];
    const params = [];
    let idx = 1;

    if (name !== undefined) {
      if (typeof name !== 'string' || name.trim().length === 0) {
        return res.status(400).json({ error: 'name darf nicht leer sein' });
      }
      updates.push(`name = $${idx++}`);
      params.push(name.trim());
    }
    if (icon !== undefined) {
      if (!validateIcon(icon)) {
        return res.status(400).json({ error: 'icon muss ein gültiger Lucide-Icon-Name sein' });
      }
      updates.push(`icon = $${idx++}`);
      params.push(icon);
    }
    if (sort_order !== undefined) {
      updates.push(`sort_order = $${idx++}`);
      params.push(sort_order);
    }
    if (updates.length === 0) {
      return res.status(400).json({ error: 'Keine Felder zum Aktualisieren angegeben' });
    }
    params.push(id);
    const result = await query(
      `UPDATE postbuch.verbleib_kategorie SET ${updates.join(', ')}
       WHERE id = $${idx}
       RETURNING id, name, icon, sort_order, archived`,
      params
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Kategorie nicht gefunden' });
    }
    appLog('INFO', 'verbleib', `Kategorie ${id} aktualisiert`);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /:id — archivieren, kein Hard-Delete; id=1 (Unbekannt) ist geschützt (Admin)
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({ error: 'Ungültige ID' });
    }
    if (id === 1) {
      return res.status(400).json({ error: 'Die Kategorie "Unbekannt" (id=1) kann nicht archiviert werden' });
    }
    await query(
      `UPDATE postbuch.verbleib_kategorie SET archived = true WHERE id = $1`,
      [id]
    );
    const result2 = await query(
      `SELECT id, name, archived,
              (SELECT COUNT(*)::int FROM postbuch.postbuch WHERE verbleib_id = vk.id) AS doc_count
       FROM postbuch.verbleib_kategorie vk WHERE id = $1`,
      [id]
    );
    if (result2.rows.length === 0) {
      return res.status(404).json({ error: 'Kategorie nicht gefunden' });
    }
    appLog('INFO', 'verbleib', `Kategorie ${id} archiviert`);
    res.json({ ok: true, ...result2.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Ablagen-Routen (ab Schreibzugriff)
// ---------------------------------------------------------------------------

// GET /ablagen — Liste; Query-Params: kategorie_id, archived ('true'/'false'/'all')
// Enthält auch Kategorien mit losen Dokumenten (verbleib_ablage_id IS NULL, verbleib_id != 1)
router.get('/ablagen', async (req, res) => {
  try {
    const { kategorie_id, archived } = req.query;
    const ablageConditions = [];
    const ablageParams = [];
    let idx = 1;

    let kid = null;
    if (kategorie_id) {
      kid = parseInt(kategorie_id, 10);
      if (!Number.isInteger(kid) || kid < 1) {
        return res.status(400).json({ error: 'Ungültige kategorie_id' });
      }
      ablageConditions.push(`va.kategorie_id = $${idx++}`);
      ablageParams.push(kid);
    }
    if (archived !== 'all') {
      ablageConditions.push(`va.archived = $${idx++}`);
      ablageParams.push(archived === 'true');
    }

    const ablageWhere = ablageConditions.length ? `WHERE ${ablageConditions.join(' AND ')}` : '';
    const ablageResult = await query(
      `SELECT va.id, va.kategorie_id, va.name, va.archived, va.created_at,
              vk.name AS kategorie_name, vk.icon AS kategorie_icon,
              COUNT(p.postid)::int AS doc_count,
              COUNT(p.postid) FILTER (WHERE p.original_urkunde = true)::int AS urkunden_count
       FROM postbuch.verbleib_ablage va
       JOIN postbuch.verbleib_kategorie vk ON vk.id = va.kategorie_id
       LEFT JOIN postbuch.postbuch p ON p.verbleib_ablage_id = va.id
       ${ablageWhere}
       GROUP BY va.id, vk.name, vk.icon, vk.sort_order
       ORDER BY va.archived ASC, vk.sort_order ASC, va.name ASC`,
      ablageParams
    );

    // Lose Kategorien nur wenn nicht explizit nach archivierten gefiltert wird
    let looseRows = [];
    if (archived !== 'true') {
      const looseParams = [];
      let looseIdx = 1;
      let looseExtra = '';
      if (kid) {
        looseExtra = `AND vk.id = $${looseIdx++}`;
        looseParams.push(kid);
      }
      const looseResult = await query(
        `SELECT vk.id AS kategorie_id, vk.name AS kategorie_name, vk.icon AS kategorie_icon,
                COUNT(p.postid)::int AS doc_count,
                COUNT(p.postid) FILTER (WHERE p.original_urkunde = true)::int AS urkunden_count
         FROM postbuch.verbleib_kategorie vk
         JOIN postbuch.postbuch p ON p.verbleib_id = vk.id AND p.verbleib_ablage_id IS NULL
         WHERE vk.id != 1 AND NOT vk.archived ${looseExtra}
         GROUP BY vk.id, vk.name, vk.icon, vk.sort_order
         HAVING COUNT(p.postid) > 0
         ORDER BY vk.sort_order ASC, vk.name ASC`,
        looseParams
      );
      looseRows = looseResult.rows.map((r) => ({
        id: null,
        kategorie_id: r.kategorie_id,
        name: null,
        archived: false,
        created_at: null,
        kategorie_name: r.kategorie_name,
        kategorie_icon: r.kategorie_icon,
        doc_count: r.doc_count,
        urkunden_count: r.urkunden_count,
        type: 'loose',
      }));
    }

    // Ablagen in active / archived aufteilen; loose Einträge zwischen active und archived einreihen
    const rows = ablageResult.rows.map((r) => ({ ...r, type: 'ablage' }));
    const activeAblage = rows.filter((r) => !r.archived);
    const archivedAblage = rows.filter((r) => r.archived);

    res.json({ data: [...activeAblage, ...looseRows, ...archivedAblage] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /ablagen — neue Ablage anlegen
router.post('/ablagen', requireWrite, async (req, res) => {
  try {
    const { kategorie_id, name } = req.body || {};
    const kid = parseInt(kategorie_id, 10);
    if (!Number.isInteger(kid) || kid < 1) {
      return res.status(400).json({ error: 'kategorie_id fehlt oder ungültig' });
    }
    if (kid === 1) {
      return res.status(400).json({ error: 'Für die Kategorie "Unbekannt" können keine Ablagen angelegt werden' });
    }
    if (typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ error: 'name fehlt oder ist leer' });
    }
    const katCheck = await query(
      `SELECT id FROM postbuch.verbleib_kategorie WHERE id = $1`,
      [kid]
    );
    if (katCheck.rows.length === 0) {
      return res.status(400).json({ error: 'Kategorie nicht gefunden' });
    }
    const result = await query(
      `INSERT INTO postbuch.verbleib_ablage (kategorie_id, name)
       VALUES ($1, $2)
       RETURNING id, kategorie_id, name, archived, created_at`,
      [kid, name.trim()]
    );
    appLog('INFO', 'verbleib', `Ablage angelegt: "${name.trim()}" in Kategorie ${kid}`);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Eine aktive Ablage mit diesem Namen existiert bereits in dieser Kategorie' });
    }
    res.status(500).json({ error: err.message });
  }
});

// PUT /ablagen/:id — Ablage umbenennen oder Kategorie ändern
router.put('/ablagen/:id', requireWrite, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({ error: 'Ungültige ID' });
    }
    const { name, kategorie_id } = req.body || {};
    const updates = [];
    const params = [];
    let idx = 1;

    if (name !== undefined) {
      if (typeof name !== 'string' || name.trim().length === 0) {
        return res.status(400).json({ error: 'name darf nicht leer sein' });
      }
      updates.push(`name = $${idx++}`);
      params.push(name.trim());
    }
    if (kategorie_id !== undefined) {
      const kid = parseInt(kategorie_id, 10);
      if (!Number.isInteger(kid) || kid < 1) {
        return res.status(400).json({ error: 'Ungültige kategorie_id' });
      }
      if (kid === 1) {
        return res.status(400).json({ error: 'Kategorie "Unbekannt" ist für Ablagen nicht zulässig' });
      }
      updates.push(`kategorie_id = $${idx++}`);
      params.push(kid);
    }
    if (updates.length === 0) {
      return res.status(400).json({ error: 'Keine Felder angegeben' });
    }
    params.push(id);
    const result = await query(
      `UPDATE postbuch.verbleib_ablage SET ${updates.join(', ')}
       WHERE id = $${idx}
       RETURNING id, kategorie_id, name, archived`,
      params
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Ablage nicht gefunden' });
    }
    // Wenn die Kategorie geändert wurde, verbleib_id aller zugeordneten Dokumente mitziehen
    if (kategorie_id !== undefined) {
      const kid = parseInt(kategorie_id, 10);
      await query(
        `UPDATE postbuch.postbuch SET verbleib_id = $1 WHERE verbleib_ablage_id = $2`,
        [kid, id]
      );
    }
    appLog('INFO', 'verbleib', `Ablage ${id} aktualisiert`);
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Eine aktive Ablage mit diesem Namen existiert bereits in dieser Kategorie' });
    }
    res.status(500).json({ error: err.message });
  }
});

// DELETE /ablagen/:id — Ablage wirklich löschen (nur wenn keine Dokumente zugeordnet sind)
router.delete('/ablagen/:id', requireWrite, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({ error: 'Ungültige ID' });
    }
    const countRes = await query(
      `SELECT COUNT(*)::int AS cnt FROM postbuch.postbuch WHERE verbleib_ablage_id = $1`,
      [id]
    );
    if (countRes.rows[0].cnt > 0) {
      return res.status(409).json({ error: 'Ablage kann nicht gelöscht werden — noch Dokumente zugeordnet. Bitte zuerst auflösen.' });
    }
    const result = await query(
      `DELETE FROM postbuch.verbleib_ablage WHERE id = $1 RETURNING id, name`,
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Ablage nicht gefunden' });
    }
    appLog('INFO', 'verbleib', `Ablage ${id} ("${result.rows[0].name}") gelöscht`);
    res.json({ ok: true, id, name: result.rows[0].name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /ablagen/:id/archive — Archivieren / Reaktivieren toggle
router.patch('/ablagen/:id/archive', requireWrite, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({ error: 'Ungültige ID' });
    }
    const result = await query(
      `UPDATE postbuch.verbleib_ablage
       SET archived = NOT archived
       WHERE id = $1
       RETURNING id, name, archived`,
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Ablage nicht gefunden' });
    }
    const row = result.rows[0];
    appLog('INFO', 'verbleib', `Ablage ${id} ${row.archived ? 'archiviert' : 'reaktiviert'}`);
    res.json(row);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Eine aktive Ablage mit diesem Namen existiert bereits in dieser Kategorie' });
    }
    res.status(500).json({ error: err.message });
  }
});

// POST /ablagen/loese-kategorie-auf — lose Docs einer Kategorie (ohne konkrete Ablage) migrieren
// Body: { kategorie_id, action: 'redirect'|'unknown', redirectToId?: number }
router.post('/ablagen/loese-kategorie-auf', requireWrite, async (req, res) => {
  try {
    const { kategorie_id, action, redirectToId } = req.body || {};
    const kid = parseInt(kategorie_id, 10);
    if (!Number.isInteger(kid) || kid < 1 || kid === 1) {
      return res.status(400).json({ error: 'kategorie_id fehlt, ungültig oder darf nicht "Unbekannt" sein' });
    }
    if (!['redirect', 'unknown'].includes(action)) {
      return res.status(400).json({ error: 'action muss "redirect" oder "unknown" sein' });
    }

    if (action === 'redirect') {
      const rid = parseInt(redirectToId, 10);
      if (!Number.isInteger(rid) || rid < 1) {
        return res.status(400).json({ error: 'redirectToId fehlt oder ungültig' });
      }
      const targetRes = await query(
        `SELECT id, kategorie_id FROM postbuch.verbleib_ablage WHERE id = $1 AND archived = false`,
        [rid]
      );
      if (targetRes.rows.length === 0) {
        return res.status(400).json({ error: 'Ziel-Ablage nicht gefunden oder archiviert' });
      }
      const target = targetRes.rows[0];
      await query(
        `UPDATE postbuch.postbuch SET verbleib_ablage_id = $1, verbleib_id = $2
         WHERE verbleib_id = $3 AND verbleib_ablage_id IS NULL`,
        [rid, target.kategorie_id, kid]
      );
    } else {
      await query(
        `UPDATE postbuch.postbuch SET verbleib_id = 1, verbleib_ablage_id = NULL
         WHERE verbleib_id = $1 AND verbleib_ablage_id IS NULL`,
        [kid]
      );
    }

    appLog('INFO', 'verbleib', `Lose Docs in Kategorie ${kid} aufgelöst, action=${action}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /ablagen/:id/aufloesen — Dokument-Migration + Hard-Delete der Ablage
// Body: { action: 'redirect'|'kategorie'|'unknown', redirectToId?: number }
router.post('/ablagen/:id/aufloesen', requireWrite, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({ error: 'Ungültige ID' });
    }
    const { action, redirectToId } = req.body || {};
    if (!['redirect', 'kategorie', 'unknown'].includes(action)) {
      return res.status(400).json({ error: 'action muss "redirect", "kategorie" oder "unknown" sein' });
    }

    // Ablage laden
    const ablageRes = await query(
      `SELECT va.id, va.name, va.kategorie_id
       FROM postbuch.verbleib_ablage va WHERE va.id = $1`,
      [id]
    );
    if (ablageRes.rows.length === 0) {
      return res.status(404).json({ error: 'Ablage nicht gefunden' });
    }
    const ablage = ablageRes.rows[0];

    if (action === 'redirect') {
      const rid = parseInt(redirectToId, 10);
      if (!Number.isInteger(rid) || rid < 1) {
        return res.status(400).json({ error: 'redirectToId fehlt oder ungültig' });
      }
      if (rid === id) {
        return res.status(400).json({ error: 'Ziel-Ablage darf nicht die aufzulösende Ablage selbst sein' });
      }
      const targetRes = await query(
        `SELECT id, kategorie_id FROM postbuch.verbleib_ablage WHERE id = $1 AND archived = false`,
        [rid]
      );
      if (targetRes.rows.length === 0) {
        return res.status(400).json({ error: 'Ziel-Ablage nicht gefunden oder archiviert' });
      }
      const target = targetRes.rows[0];
      // Dokumente umziehen: Ablage + Kategorie der Zielablage setzen
      await query(
        `UPDATE postbuch.postbuch
         SET verbleib_ablage_id = $1, verbleib_id = $2
         WHERE verbleib_ablage_id = $3`,
        [rid, target.kategorie_id, id]
      );
    } else if (action === 'kategorie') {
      // Ablage-Referenz entfernen, Kategorie beibehalten
      await query(
        `UPDATE postbuch.postbuch SET verbleib_ablage_id = NULL WHERE verbleib_ablage_id = $1`,
        [id]
      );
    } else {
      // action === 'unknown': alles auf Unbekannt (id=1) setzen
      await query(
        `UPDATE postbuch.postbuch
         SET verbleib_id = 1, verbleib_ablage_id = NULL
         WHERE verbleib_ablage_id = $1`,
        [id]
      );
    }

    // Ablage dauerhaft löschen (Docs wurden bereits migriert, FK-Constraint erfüllt)
    await query(`DELETE FROM postbuch.verbleib_ablage WHERE id = $1`, [id]);

    appLog('INFO', 'verbleib', `Ablage ${id} ("${ablage.name}") aufgelöst und gelöscht, action=${action}`);
    res.json({ ok: true, id, name: ablage.name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
