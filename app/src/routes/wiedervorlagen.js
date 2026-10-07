import { Router } from 'express';
import { query } from '../db.js';
import { uiLog } from '../log.js';
import { offeneRechnungSql } from '../lib/rechnungs-filter.js';
import { parsePersonenAuswahl, personenBedingung, aktenPersonenBedingung } from '../lib/personen-auswahl.js';

const router = Router();

// ── GET /api/wiedervorlagen — all WV (optionally filter by postid or akteid) ──
router.get('/', async (req, res) => {
  try {
    const { postid, akteid } = req.query;
    let sql = `
      SELECT w.*,
             p.betreff  AS post_betreff,
             p.dokumentart AS post_dokumentart,
             a.betreff  AS akte_betreff
      FROM wiedervorlage w
      LEFT JOIN postbuch p ON p.postid = w.postid
      LEFT JOIN akte a ON a.akteid = w.akteid
    `;
    const params = [];
    if (postid) {
      params.push(postid);
      sql += ` WHERE w.postid = $${params.length}`;
    } else if (akteid) {
      params.push(akteid);
      sql += ` WHERE w.akteid = $${params.length}`;
    }
    sql += ` ORDER BY w.erledigt ASC, w.faellig_am ASC, w.created_at ASC`;

    const result = await query(sql, params);
    res.json(result.rows);
  } catch (err) {
    console.error('GET /api/wiedervorlagen error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// ── GET /api/wiedervorlagen/dashboard — überfällige + fällige + nächste 7 Tage (nicht erledigt) ──
// ?personen=kurzname,…,_ohne: Dokument-WV über familienmitglied, Akten-WV über die Dokumente der Akte.
router.get('/dashboard', async (req, res) => {
  try {
    const auswahl = parsePersonenAuswahl(req.query.personen);
    const params = [];
    const dokBedingung = personenBedingung('p.familienmitglied', auswahl, params);
    const akteBedingung = aktenPersonenBedingung('w.akteid', auswahl, params);
    const personenFilter = auswahl
      ? `AND (CASE WHEN w.postid IS NOT NULL THEN ${dokBedingung} ELSE ${akteBedingung} END)`
      : '';
    const result = await query(`
      SELECT w.*,
             p.betreff  AS post_betreff,
             p.dokumentart AS post_dokumentart,
             a.betreff  AS akte_betreff
      FROM wiedervorlage w
      LEFT JOIN postbuch p ON p.postid = w.postid
      LEFT JOIN akte a ON a.akteid = w.akteid
      WHERE w.erledigt = false
        AND w.faellig_am <= CURRENT_DATE + INTERVAL '7 days'
        ${personenFilter}
      ORDER BY w.faellig_am ASC, w.created_at ASC
    `, params);
    res.json(result.rows);
  } catch (err) {
    console.error('GET /api/wiedervorlagen/dashboard error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// ── GET /api/wiedervorlagen/kalender?von=YYYY-MM-DD&bis=YYYY-MM-DD — for calendar view ──
router.get('/kalender', async (req, res) => {
  try {
    const { von, bis } = req.query;
    if (!von || !bis) {
      return res.status(400).json({ error: 'von and bis required' });
    }

    // WV entries (including completed ones)
    const wvResult = await query(`
      SELECT w.*,
             p.betreff  AS post_betreff,
             p.dokumentart AS post_dokumentart,
             a.betreff  AS akte_betreff
      FROM wiedervorlage w
      LEFT JOIN postbuch p ON p.postid = w.postid
      LEFT JOIN akte a ON a.akteid = w.akteid
      WHERE w.faellig_am BETWEEN $1 AND $2
         OR (w.erledigt = false AND w.faellig_am < $1)
      ORDER BY w.faellig_am ASC, w.created_at ASC
    `, [von, bis]);

    // Open invoice due dates for calendar display
    const faelligkeitenResult = await query(`
      SELECT sub.postid, sub.faelligkeit, sub.betreff, sub.typ
      FROM (
        SELECT ar.postid, ar.faelligkeit, p.betreff, 'Arztrechnung' AS typ
        FROM arztrechnung ar
        JOIN postbuch p ON p.postid = ar.postid
        WHERE ${offeneRechnungSql('ar')} AND ar.faelligkeit IS NOT NULL
          AND ar.faelligkeit BETWEEN $1 AND $2
        UNION ALL
        SELECT hr.postid, hr.faelligkeit, p.betreff, 'Handwerkerrechnung' AS typ
        FROM handwerkerrechnung hr
        JOIN postbuch p ON p.postid = hr.postid
        WHERE ${offeneRechnungSql('hr')} AND hr.faelligkeit IS NOT NULL
          AND hr.faelligkeit BETWEEN $1 AND $2
        UNION ALL
        SELECT gr.postid, gr.faelligkeit, p.betreff, 'Rechnung' AS typ
        FROM generische_rechnung gr
        JOIN postbuch p ON p.postid = gr.postid
        WHERE ${offeneRechnungSql('gr')} AND gr.faelligkeit IS NOT NULL
          AND gr.faelligkeit BETWEEN $1 AND $2
      ) sub
      ORDER BY sub.faelligkeit ASC
    `, [von, bis]);

    res.json({
      wiedervorlagen: wvResult.rows,
      faelligkeiten: faelligkeitenResult.rows,
    });
  } catch (err) {
    console.error('GET /api/wiedervorlagen/kalender error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// ── POST /api/wiedervorlagen — create new WV ──
router.post('/', async (req, res) => {
  try {
    const { postid, akteid, faellig_am, aktion } = req.body;
    if (!faellig_am || !aktion) {
      return res.status(400).json({ error: 'faellig_am und aktion sind Pflicht' });
    }
    if ((!postid && !akteid) || (postid && akteid)) {
      return res.status(400).json({ error: 'Genau ein postid oder akteid muss angegeben werden' });
    }

    const result = await query(
      `INSERT INTO wiedervorlage (postid, akteid, faellig_am, aktion)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [postid || null, akteid || null, faellig_am, aktion]
    );
    res.status(201).json(result.rows[0]);
    uiLog('CREATE', 'wiedervorlage', String(result.rows[0].wv_id), `${aktion.slice(0, 80)} fällig ${faellig_am}`);
  } catch (err) {
    console.error('POST /api/wiedervorlagen error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// ── PATCH /api/wiedervorlagen/:id — update WV (erledigt toggle, edit fields) ──
router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { faellig_am, aktion, erledigt } = req.body;

    const sets = [];
    const params = [];
    if (faellig_am !== undefined) {
      params.push(faellig_am);
      sets.push(`faellig_am = $${params.length}`);
    }
    if (aktion !== undefined) {
      params.push(aktion);
      sets.push(`aktion = $${params.length}`);
    }
    if (erledigt !== undefined) {
      params.push(erledigt);
      sets.push(`erledigt = $${params.length}`);
    }

    if (sets.length === 0) {
      return res.status(400).json({ error: 'Keine Änderungen' });
    }

    params.push(id);
    const result = await query(
      `UPDATE wiedervorlage SET ${sets.join(', ')} WHERE wv_id = $${params.length} RETURNING *`,
      params
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Wiedervorlage nicht gefunden' });
    }
    res.json(result.rows[0]);
    const changes = [faellig_am !== undefined && 'faellig_am', aktion !== undefined && 'aktion', erledigt !== undefined && `erledigt=${erledigt}`].filter(Boolean).join(', ');
    uiLog('UPDATE', 'wiedervorlage', String(id), changes);
  } catch (err) {
    console.error('PATCH /api/wiedervorlagen/:id error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// ── DELETE /api/wiedervorlagen/:id — delete WV ──
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await query(
      `DELETE FROM wiedervorlage WHERE wv_id = $1 RETURNING wv_id`,
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Wiedervorlage nicht gefunden' });
    }
    res.json({ deleted: true });
    uiLog('DELETE', 'wiedervorlage', String(id), 'gelöscht');
  } catch (err) {
    console.error('DELETE /api/wiedervorlagen/:id error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

export default router;
