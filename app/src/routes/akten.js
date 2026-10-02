import { Router } from 'express';
import { query } from '../db.js';
import { uiLog } from '../log.js';
import { loadDynamicSettings } from '../config.js';
import { callLLM, resolveKlassenModell, parseJsonFromText, providerForRef } from '../lib/llm.js';
import { runAkteOp, getAkteEmbeddingQueue, AkteServiceError } from '../service/akten-service.js';

const router = Router();

const AKTEID_RE = /^A\d{6}$/;
const POSTID_RE = /^P\d{6}$/;

// Mappt AkteServiceError → HTTP-Response; andere Fehler → 500.
function sendServiceError(res, err, context) {
  if (err instanceof AkteServiceError) {
    return res.status(err.status).json({ error: err.message });
  }
  console.error(`${context} error:`, err);
  return res.status(500).json({ error: 'Interner Serverfehler' });
}

// GET /api/akten — Liste mit Filter, Sortierung, Paginierung
router.get('/', async (req, res) => {
  try {
    const {
      q, sort = 'updated_at', order = 'desc',
      limit = '50', offset = '0', historisch,
    } = req.query;

    const allowedSorts = ['updated_at', 'created_at', 'betreff', 'akteid'];
    const sortCol = allowedSorts.includes(sort) ? sort : 'updated_at';
    const sortOrder = order === 'asc' ? 'ASC' : 'DESC';
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const offsetNum = Math.max(parseInt(offset, 10) || 0, 0);

    const conditions = [];
    const params = [];
    let paramIdx = 1;

    // historisch filter: default exclude historical akten unless explicitly requested
    if (historisch === 'only') {
      conditions.push(`a.historisch = true`);
    } else if (historisch !== 'true' && historisch !== 'all') {
      conditions.push(`a.historisch = false`);
    }

    if (q) {
      conditions.push(`(
        a.betreff ILIKE $${paramIdx} OR
        a.beschreibung ILIKE $${paramIdx} OR
        EXISTS (SELECT 1 FROM unnest(a.schlagwoerter) AS sw WHERE sw ILIKE $${paramIdx})
      )`);
      params.push(`%${q}%`);
      paramIdx++;
    }

    // Column filters (cf_betreff, cf_akteid, etc.)
    for (const [key, val] of Object.entries(req.query)) {
      if (key.startsWith('cf_') && val) {
        const col = key.slice(3);
        const allowed = ['akteid', 'betreff'];
        if (allowed.includes(col)) {
          conditions.push(`a.${col}::text ILIKE $${paramIdx}`);
          params.push(`%${val}%`);
          paramIdx++;
        }
      }
    }

    const whereClause = conditions.length > 0
      ? 'WHERE ' + conditions.join(' AND ')
      : '';

    const countResult = await query(`
      SELECT COUNT(*) AS total FROM akte a ${whereClause}
    `, params);

    const total = parseInt(countResult.rows[0].total, 10);

    const dataParams = [...params, limitNum, offsetNum];
    const result = await query(`
      SELECT a.akteid, a.betreff, a.beschreibung, a.schlagwoerter,
             a.created_at, a.updated_at, a.historisch,
             COUNT(DISTINCT ad.postid)::int AS dok_count,
             COUNT(DISTINCT w.wv_id) FILTER (WHERE w.erledigt = false)::int AS wv_active_count
      FROM akte a
      LEFT JOIN akte_dokument ad ON ad.akteid = a.akteid
      LEFT JOIN wiedervorlage w ON w.akteid = a.akteid
      ${whereClause}
      GROUP BY a.akteid
      ORDER BY a.${sortCol} ${sortOrder} NULLS LAST, a.akteid DESC
      LIMIT $${paramIdx} OFFSET $${paramIdx + 1}
    `, dataParams);

    res.json({
      data: result.rows,
      total,
      limit: limitNum,
      offset: offsetNum,
    });
  } catch (err) {
    console.error('GET /api/akten error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// GET /api/akten/recent — Letzte 5 geänderte + 2 zuletzt angelegte Akten (für Dropdown)
router.get('/recent', async (req, res) => {
  try {
    const result = await query(`
      WITH recent_updated AS (
        SELECT akteid, betreff, updated_at, created_at, 'updated' AS source
        FROM akte WHERE historisch = false ORDER BY updated_at DESC LIMIT 2
      ),
      recent_created AS (
        SELECT akteid, betreff, updated_at, created_at, 'created' AS source
        FROM akte
        WHERE akteid NOT IN (SELECT akteid FROM recent_updated)
          AND historisch = false
        ORDER BY created_at DESC LIMIT 2
      )
      SELECT * FROM recent_updated
      UNION ALL
      SELECT * FROM recent_created
      ORDER BY updated_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('GET /api/akten/recent error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// GET /api/akten/embedding-queue — wartende Embedding-Berechnungen (Debounce-Timer)
// MUSS vor /:akteid stehen, da /:akteid als Wildcard sonst matcht!
router.get('/embedding-queue', (req, res) => {
  res.json(getAkteEmbeddingQueue());
});

// GET /api/akten/:akteid — Einzelne Akte mit allen Dokumenten
router.get('/:akteid', async (req, res) => {
  try {
    const { akteid } = req.params;
    if (!AKTEID_RE.test(akteid)) {
      return res.status(400).json({ error: 'Ungültige AkteID' });
    }

    const akteResult = await query(`SELECT * FROM akte WHERE akteid = $1`, [akteid]);
    if (akteResult.rows.length === 0) {
      return res.status(404).json({ error: 'Akte nicht gefunden' });
    }

    const akte = akteResult.rows[0];
    // Capture has_embedding before stripping the vector (too large to send)
    const hasEmbedding = akte.embedding != null;
    delete akte.embedding;
    akte.has_embedding = hasEmbedding;

    // Dokumente mit Basisdaten und sort_order
    const dokResult = await query(`
      SELECT ad.sort_order, ad.added_at,
             p.postid, p.briefdatum, p.kontakt, p.familienmitglied, p.richtung, p.dokumentart AS art, p.lebensbereich, p.dokumentart, p.betreff,
             p.zusammenfassung, p.status, p.schlagwoerter,
             pers.farbe AS familienmitglied_farbe,
             COALESCE(arz.gesamtbetrag, hw.gesamtbetrag, gr.gesamtbetrag, eb.erstattungsbetrag) AS betrag,
             (p.storage_id IS NOT NULL) AS hat_pdf
      FROM akte_dokument ad
      JOIN postbuch p ON p.postid = ad.postid
      LEFT JOIN arztrechnung arz ON arz.postid = p.postid
      LEFT JOIN handwerkerrechnung hw ON hw.postid = p.postid
      LEFT JOIN generische_rechnung gr ON gr.postid = p.postid
      LEFT JOIN erstattungsbescheid eb ON eb.postid = p.postid
      LEFT JOIN postbuch.mensch pers ON pers.kurzname = p.familienmitglied
      WHERE ad.akteid = $1
      ORDER BY ad.sort_order ASC, ad.added_at ASC
    `, [akteid]);

    res.json({
      akte,
      dokumente: dokResult.rows,
    });
  } catch (err) {
    console.error('GET /api/akten/:akteid error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// GET /api/akten/:akteid/snapshot — Full akte snapshot for undo (akte metadata + document links)
router.get('/:akteid/snapshot', async (req, res) => {
  try {
    const { akteid } = req.params;
    if (!AKTEID_RE.test(akteid)) {
      return res.status(400).json({ error: 'Ungültige AkteID' });
    }

    const akteResult = await query(`SELECT * FROM akte WHERE akteid = $1`, [akteid]);
    if (akteResult.rows.length === 0) {
      return res.status(404).json({ error: 'Akte nicht gefunden' });
    }

    const dokResult = await query(
      `SELECT postid, sort_order FROM akte_dokument WHERE akteid = $1 ORDER BY sort_order ASC`,
      [akteid]
    );

    res.json({
      akte: akteResult.rows[0],
      dokumente: dokResult.rows,
    });
  } catch (err) {
    console.error('GET /api/akten/:akteid/snapshot error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// POST /api/akten/restore — Restore a deleted akte from snapshot (for undo)
router.post('/restore', async (req, res) => {
  try {
    const { akte, dokumente } = req.body;
    if (!akte || !akte.akteid) {
      return res.status(400).json({ error: 'Ungültige Snapshot-Daten' });
    }
    const { result } = await runAkteOp({ type: 'restore_akte', snapshot: { akte, dokumente } });
    res.json({ success: true, akteid: result.akteid });
  } catch (err) {
    sendServiceError(res, err, 'POST /api/akten/restore');
  }
});

// POST /api/akten — Neue Akte anlegen
router.post('/', async (req, res) => {
  try {
    const { betreff, beschreibung, schlagwoerter } = req.body;
    const { result } = await runAkteOp({ type: 'create_akte', betreff, beschreibung, schlagwoerter });
    res.status(201).json(result);
  } catch (err) {
    sendServiceError(res, err, 'POST /api/akten');
  }
});

// PATCH /api/akten/:akteid — Metadaten aktualisieren
router.patch('/:akteid', async (req, res) => {
  try {
    const { akteid } = req.params;
    const allowedFields = ['betreff', 'beschreibung', 'schlagwoerter', 'notiz', 'historisch', 'dok_sort_mode'];
    const patch = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) patch[field] = req.body[field];
    }
    const { result } = await runAkteOp({ type: 'update_akte_metadata', akteid, patch });
    res.json(result);
  } catch (err) {
    sendServiceError(res, err, 'PATCH /api/akten/:akteid');
  }
});

// PATCH /api/akten/:akteid/historisch — Archivstatus setzen und optional Dokumente mitziehen
router.patch('/:akteid/historisch', async (req, res) => {
  try {
    const { akteid } = req.params;
    const { historisch, auch_dokumente } = req.body;
    const { result } = await runAkteOp({ type: 'set_historisch', akteid, historisch, auch_dokumente });
    res.json({ success: true, ...result });
  } catch (err) {
    sendServiceError(res, err, 'PATCH /api/akten/:akteid/historisch');
  }
});

// GET /api/akten/:akteid/historisch-check — Anzahl Dokumente, die sich ändern würden
router.get('/:akteid/historisch-check', async (req, res) => {
  try {
    const { akteid } = req.params;
    const { historisch } = req.query;
    if (!AKTEID_RE.test(akteid)) {
      return res.status(400).json({ error: 'Ungültige AkteID' });
    }
    const targetHistorisch = historisch === 'true';
    const result = await query(
      `SELECT COUNT(*)::int AS count
       FROM akte_dokument ad
       JOIN postbuch p ON p.postid = ad.postid
       WHERE ad.akteid = $1 AND p.historisch != $2`,
      [akteid, targetHistorisch]
    );
    res.json({ count: result.rows[0].count });
  } catch (err) {
    console.error('GET /api/akten/:akteid/historisch-check error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// DELETE /api/akten/:akteid — Akte löschen
router.delete('/:akteid', async (req, res) => {
  try {
    const { akteid } = req.params;
    const { result } = await runAkteOp({ type: 'delete_akte', akteid });
    res.json({ success: true, akteid: result.akteid });
  } catch (err) {
    sendServiceError(res, err, 'DELETE /api/akten/:akteid');
  }
});

// POST /api/akten/:akteid/dokumente — Dokument zur Akte hinzufügen
router.post('/:akteid/dokumente', async (req, res) => {
  try {
    const { akteid } = req.params;
    const { postid } = req.body;
    const { result } = await runAkteOp({ type: 'add_document', akteid, postid });
    if (result.alreadyLinked) {
      return res.json({ success: true, alreadyLinked: true });
    }
    res.status(201).json({ success: true, akteid: result.akteid, postid: result.postid, sort_order: result.sort_order, added_at: result.added_at });
  } catch (err) {
    sendServiceError(res, err, 'POST /api/akten/:akteid/dokumente');
  }
});

// DELETE /api/akten/:akteid/dokumente/:postid — Dokument von Akte lösen
router.delete('/:akteid/dokumente/:postid', async (req, res) => {
  try {
    const { akteid, postid } = req.params;
    await runAkteOp({ type: 'remove_document', akteid, postid });
    res.json({ success: true });
  } catch (err) {
    sendServiceError(res, err, 'DELETE /api/akten/:akteid/dokumente/:postid');
  }
});

// PUT /api/akten/:akteid/dokumente/order — Reihenfolge der Dokumente aktualisieren
router.put('/:akteid/dokumente/order', async (req, res) => {
  try {
    const { akteid } = req.params;
    const { order } = req.body; // Array of postids in desired order
    await runAkteOp({ type: 'reorder_documents', akteid, order });
    res.json({ success: true });
  } catch (err) {
    sendServiceError(res, err, 'PUT /api/akten/:akteid/dokumente/order');
  }
});

// POST /api/akten/:akteid/ki-vorschlag — KI generiert Betreff, Beschreibung, Schlagwörter
router.post('/:akteid/ki-vorschlag', async (req, res) => {
  try {
    const { akteid } = req.params;
    if (!AKTEID_RE.test(akteid)) {
      return res.status(400).json({ error: 'Ungültige AkteID' });
    }

    const settings = await loadDynamicSettings();

    // Modell aus den Einstellungen; Key-Prüfung gegen den daraus folgenden Provider,
    // nicht mehr fest gegen OpenAI.
    const kiCfg   = resolveKlassenModell('akte_vorschlag', settings);
    const kiModel = kiCfg.model;
    const kiProv  = providerForRef(settings, kiCfg);
    if (!kiProv) {
      return res.status(503).json({ error: `Provider "${kiCfg.providerId}" ist nicht konfiguriert` });
    }
    // Lokale Provider (Ollama/LM Studio) laufen ohne Auth — nur Cloud-Ziele
    // brauchen zwingend einen Key.
    const brauchtKey = ['anthropic', 'bedrock', 'subscription'].includes(kiProv.typ) || kiProv.id === 'openai';
    if (brauchtKey && !kiProv.apiKey
        && !(kiProv.typ === 'anthropic' && settings.llm_claude_subscription_enabled === true && settings.llm_claude_oauth_token)) {
      return res.status(503).json({ error: `Kein API-Key für Provider "${kiProv.label}" konfiguriert` });
    }

    // Akte + Dokumente laden
    const akteResult = await query(`SELECT betreff, beschreibung, schlagwoerter FROM akte WHERE akteid = $1`, [akteid]);
    if (akteResult.rows.length === 0) {
      return res.status(404).json({ error: 'Akte nicht gefunden' });
    }
    const akte = akteResult.rows[0];

    const dokResult = await query(`
      SELECT p.betreff, p.zusammenfassung
      FROM akte_dokument ad
      JOIN postbuch p ON p.postid = ad.postid
      WHERE ad.akteid = $1
      ORDER BY ad.sort_order ASC, ad.added_at ASC
    `, [akteid]);

    if (dokResult.rows.length < 2) {
      return res.status(400).json({ error: 'Mindestens 2 Dokumente erforderlich' });
    }

    const docsText = dokResult.rows.map((d, i) => {
      const lines = [`Dokument ${i + 1}:`];
      if (d.betreff) lines.push(`  Betreff: ${d.betreff}`);
      if (d.zusammenfassung) lines.push(`  Zusammenfassung: ${d.zusammenfassung}`);
      return lines.join('\n');
    }).join('\n\n');

    const bestehend = [
      akte.betreff ? `Betreff: ${akte.betreff}` : null,
      akte.beschreibung ? `Beschreibung: ${akte.beschreibung}` : null,
      akte.schlagwoerter?.length ? `Schlagwörter: ${akte.schlagwoerter.join(', ')}` : null,
    ].filter(Boolean).join('\n');

    const systemPrompt = `Du bist ein Assistent für ein Dokumentenmanagementsystem.
` +
      `Analysiere die gegebenen Dokumente und schlage verbesserte Metadaten für die Akte vor.
` +
      `Antworte ausschließlich mit einem JSON-Objekt mit genau diesen drei Feldern:
` +
      `{ "betreff": "...", "beschreibung": "...", "schlagwoerter": ["...", "..."] }
` +
      `Regeln:
` +
      `- "betreff": Ein prägnanter Titel der Akte (max. 80 Zeichen), deutsch.
` +
      `- "beschreibung": Ein bis 4 kurze erläuternde Sätz zur Akte (max. 400 Zeichen), abstrahiert von Details, deutsch.
` +
      `- "schlagwoerter": 3–10 relevante Schlüsselbegriffe als Array. Bestehende Schlagwörter MÜSSEN enthalten bleiben.
` +
      `Antworte NUR mit dem JSON, ohne Markdown-Umrandung.`;

    const userPrompt = `Bestehende Metadaten der Akte:\n${bestehend}\n\nEnthaltene Dokumente:\n${docsText}`;

    // Über callLLM statt direktem OpenAI-fetch: Modellwahl kommt aus den
    // Einstellungen (akte_model_vorschlag), Kostenerfassung und Fehler-Logging
    // laufen zentral. Der frühere Aufruf war der einzige harte OpenAI-Call im Repo
    // und hätte mit jedem anderen Provider gebrochen (response_format json_object).
    let raw;
    try {
      const kiResult = await callLLM(
        kiCfg,
        userPrompt,
        { maxTokens: 512, system: systemPrompt },
        settings,
        { username: req.session?.username || null, kategorie: 'akte_vorschlag', entity: 'akte', entityId: akteid }
      );
      raw = kiResult.text || '';
    } catch (kiErr) {
      console.error('[akten] ki-vorschlag LLM-Aufruf fehlgeschlagen:', kiErr.message);
      return res.status(502).json({ error: 'KI-Aufruf fehlgeschlagen', detail: kiErr.message });
    }

    // parseJsonFromText statt JSON.parse: entfernt Markdown-Fences und repariert
    // Single-Quotes — ohne response_format liefern manche Modelle genau das.
    let vorschlag;
    try {
      vorschlag = parseJsonFromText(raw);
    } catch {
      return res.status(502).json({ error: 'KI-Antwort konnte nicht geparst werden', raw });
    }

    // Bestehende Schlagwörter niemals verlieren
    const existingTags = akte.schlagwoerter || [];
    const newTags = Array.isArray(vorschlag.schlagwoerter) ? vorschlag.schlagwoerter : [];
    const mergedTags = [...new Set([...existingTags, ...newTags])];

    res.json({
      betreff: typeof vorschlag.betreff === 'string' ? vorschlag.betreff.trim() : null,
      beschreibung: typeof vorschlag.beschreibung === 'string' ? vorschlag.beschreibung.trim() : null,
      schlagwoerter: mergedTags,
    });
    uiLog('AI_CALL', 'akte_ki_vorschlag', akteid, `${kiModel} Vorschlag (${dokResult.rows.length} docs)`);
  } catch (err) {
    console.error('POST /api/akten/:akteid/ki-vorschlag error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// GET /api/akten/by-postid/:postid — Alle Akten, die ein Dokument enthalten
router.get('/by-postid/:postid', async (req, res) => {
  try {
    const { postid } = req.params;
    if (!POSTID_RE.test(postid)) {
      return res.status(400).json({ error: 'Ungültige PostID' });
    }

    const result = await query(`
      SELECT a.akteid, a.betreff, a.updated_at, a.created_at,
             COUNT(ad2.postid)::int AS dok_count
      FROM akte_dokument ad
      JOIN akte a ON a.akteid = ad.akteid
      LEFT JOIN akte_dokument ad2 ON ad2.akteid = a.akteid
      WHERE ad.postid = $1
      GROUP BY a.akteid
      ORDER BY a.updated_at DESC
    `, [postid]);

    res.json(result.rows);
  } catch (err) {
    console.error('GET /api/akten/by-postid/:postid error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// GET /api/akten/semantic-for-doc/:postid — Top-3 Akten by semantic similarity to a document
router.get('/semantic-for-doc/:postid', async (req, res) => {
  try {
    const { postid } = req.params;
    if (!POSTID_RE.test(postid)) {
      return res.status(400).json({ error: 'Ungültige PostID' });
    }

    const result = await query(`
      SELECT a.akteid, a.betreff, a.beschreibung, a.schlagwoerter,
             ROUND((1 - (a.embedding <=> p.embedding))::numeric, 3) AS similarity
      FROM akte a
      CROSS JOIN (
        SELECT embedding FROM postbuch WHERE postid = $1 AND embedding IS NOT NULL
      ) p
      WHERE a.embedding IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM akte_dokument ad
          WHERE ad.akteid = a.akteid AND ad.postid = $1
        )
      ORDER BY a.embedding <=> p.embedding
      LIMIT 3
    `, [postid]);

    res.json(result.rows);
  } catch (err) {
    console.error('GET /api/akten/semantic-for-doc error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

export default router;
