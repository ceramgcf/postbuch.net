import { Router } from 'express';
import { query } from '../db.js';
import { embedText } from '../lib/embedding.js';
import { parseIdQuery, exactCandidates, prefixCandidates } from '../lib/id-query.js';
import { eigeneDokumenteBedingung } from '../middleware/lesebereich.js';

const router = Router();

const DOC_SELECT = `p.postid, p.briefdatum, p.kontakt, p.dokumentart AS art, p.lebensbereich, p.dokumentart, p.betreff,
             p.zusammenfassung, p.status, p.schlagwoerter, p.historisch,
             COALESCE(a.gesamtbetrag, h.gesamtbetrag, g.gesamtbetrag, e.erstattungsbetrag) AS betrag`;
const DOC_JOINS = `FROM postbuch p
      LEFT JOIN arztrechnung a ON a.postid = p.postid
      LEFT JOIN handwerkerrechnung h ON h.postid = p.postid
      LEFT JOIN generische_rechnung g ON g.postid = p.postid
      LEFT JOIN erstattungsbescheid e ON e.postid = p.postid`;

// ID-Treffer für Dokumente. historisch-Filter bewusst ignoriert:
// Wer eine Nummer eintippt, will das Objekt finden — auch archiviert.
async function idLookupDokumente(idq, req) {
  const exacts = exactCandidates(idq, 'P');
  const prefixes = prefixCandidates(idq, 'P').map((p) => p + '%');
  if (exacts.length === 0 && prefixes.length === 0) return [];
  const params = [exacts, prefixes];
  const eigene = eigeneDokumenteBedingung(req, 'p.familienmitglied', params);
  const result = await query(`
    SELECT ${DOC_SELECT}, (p.postid = ANY($1)) AS exact
    ${DOC_JOINS}
    WHERE (p.postid = ANY($1) OR p.postid LIKE ANY($2)) ${eigene ? `AND ${eigene}` : ''}
    ORDER BY (p.postid = ANY($1)) DESC, p.postid
    LIMIT 50
  `, params);
  return result.rows;
}

async function idLookupAkten(idq) {
  const exacts = exactCandidates(idq, 'A');
  const prefixes = prefixCandidates(idq, 'A').map((p) => p + '%');
  if (exacts.length === 0 && prefixes.length === 0) return [];
  const result = await query(`
    SELECT a.akteid, a.betreff, a.beschreibung, a.schlagwoerter,
           a.created_at, a.updated_at,
           COUNT(ad.postid)::int AS dok_count,
           (a.akteid = ANY($1)) AS exact
    FROM akte a
    LEFT JOIN akte_dokument ad ON ad.akteid = a.akteid
    WHERE a.akteid = ANY($1) OR a.akteid LIKE ANY($2)
    GROUP BY a.akteid
    ORDER BY (a.akteid = ANY($1)) DESC, a.akteid
    LIMIT 50
  `, [exacts, prefixes]);
  return result.rows;
}

// Embedding für Suchanfragen — der EINZIGE Pfad ist lib/embedding.js embedText().
// Vor 1.7.0 stand hier eine eigene Kopie mit hartcodierter OpenAI-URL; jeder
// Provider-Wechsel hätte die Suche still gebrochen.
// Gibt { literal, signature } zurück oder null, wenn kein Provider konfiguriert ist.
async function sucheEmbedding(text, username) {
  const erg = await embedText(text, null, { username, kategorie: 'search' });
  return erg ? { literal: erg.literal, signature: erg.signature } : null;
}

// GET /api/search?q=... — Volltextsuche
router.get('/', async (req, res) => {
  try {
    const { q, historisch } = req.query;
    if (!q || q.trim().length === 0) {
      return res.status(400).json({ error: 'Suchbegriff erforderlich' });
    }

    const historischFilter = historisch === 'true' || historisch === 'all' ? '' : 'AND p.historisch = false';

    // Nummern-Eingabe (z.B. "P000123", "p123", "123"): ID-Treffer zuerst,
    // dahinter die normalen Volltext-Treffer (finden auch Notiz-Referenzen auf die Nummer).
    const idq = parseIdQuery(q);
    const idRows = idq ? await idLookupDokumente(idq, req) : [];
    const volltextParams = [q];
    const eigene = eigeneDokumenteBedingung(req, 'p.familienmitglied', volltextParams);

    const result = await query(`
      SELECT p.postid, p.briefdatum, p.kontakt, p.dokumentart AS art, p.lebensbereich, p.dokumentart, p.betreff,
             p.zusammenfassung, p.status, p.schlagwoerter, p.historisch,
             COALESCE(a.gesamtbetrag, h.gesamtbetrag, g.gesamtbetrag, e.erstattungsbetrag) AS betrag,
             ts_rank(
               to_tsvector('german',
                 COALESCE(p.betreff,'') || ' ' ||
                 COALESCE(p.zusammenfassung,'') || ' ' ||
                 COALESCE(p.kontakt,'') || ' ' ||
                 COALESCE(array_to_string(p.schlagwoerter, ' '),'') || ' ' ||
                 COALESCE(p.fremdes_zeichen,'') || ' ' ||
                 COALESCE(p.notiz,'')
               ),
               plainto_tsquery('german', $1)
             ) AS rank
      FROM postbuch p
      LEFT JOIN arztrechnung a ON a.postid = p.postid
      LEFT JOIN handwerkerrechnung h ON h.postid = p.postid
      LEFT JOIN generische_rechnung g ON g.postid = p.postid
      LEFT JOIN erstattungsbescheid e ON e.postid = p.postid
      WHERE to_tsvector('german',
        COALESCE(p.betreff,'') || ' ' ||
        COALESCE(p.zusammenfassung,'') || ' ' ||
        COALESCE(p.kontakt,'') || ' ' ||
        COALESCE(array_to_string(p.schlagwoerter, ' '),'') || ' ' ||
        COALESCE(p.fremdes_zeichen,'') || ' ' ||
        COALESCE(p.notiz,'')
      ) @@ plainto_tsquery('german', $1)
      ${historischFilter}
      ${eigene ? `AND ${eigene}` : ''}
      ORDER BY rank DESC
      LIMIT 50
    `, volltextParams);

    const seen = new Set(idRows.map((r) => r.postid));
    const merged = [...idRows, ...result.rows.filter((r) => !seen.has(r.postid))].slice(0, 50);
    res.json({ data: merged, query: q });
  } catch (err) {
    console.error('GET /api/search error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// GET /api/search/semantic?q=... — Semantische Suche via pgvector
router.get('/semantic', async (req, res) => {
  try {
    const { q, historisch: histParam, offset } = req.query;
    if (!q || q.trim().length === 0) {
      return res.status(400).json({ error: 'Suchbegriff erforderlich' });
    }

    // Nummern-Eingabe: direkter ID-Lookup statt (kostenpflichtigem) Embedding-Call —
    // eine Nummer hat keine semantische Bedeutung.
    const idq = parseIdQuery(q);
    if (idq) {
      const offsetIdq = Math.max(parseInt(offset, 10) || 0, 0);
      const rows = offsetIdq > 0 ? [] : await idLookupDokumente(idq, req);
      return res.json({
        data: rows.map((r) => ({ ...r, similarity: r.exact ? 1.0 : 0.5 })),
        query: q, offset: offsetIdq, hasMore: false,
      });
    }

    const semHistFilter = histParam === 'true' || histParam === 'all' ? '' : 'AND p.historisch = false';
    const offsetNum = Math.max(parseInt(offset, 10) || 0, 0);

    // Embedding über den einzigen Pfad (loggt in llm_call_log)
    let emb;
    try {
      emb = await sucheEmbedding(q, req.session?.username || null);
    } catch (err) {
      console.error('[search] Embedding-Fehler:', err.message);
      return res.status(502).json({ error: 'Fehler bei der Embedding-Anfrage' });
    }
    if (!emb) return res.status(503).json({ error: 'Kein Embedding-Provider konfiguriert' });
    const embeddingStr = emb.literal;
    const semParams = [embeddingStr, offsetNum, emb.signature];
    const eigene = eigeneDokumenteBedingung(req, 'p.familienmitglied', semParams);

    const result = await query(`
      SELECT p.postid, p.briefdatum, p.kontakt, p.dokumentart AS art, p.lebensbereich, p.dokumentart, p.betreff, p.zusammenfassung,
             p.status, p.schlagwoerter, p.historisch,
             COALESCE(a.gesamtbetrag, h.gesamtbetrag, g.gesamtbetrag, e.erstattungsbetrag) AS betrag,
             1 - (p.embedding <=> $1::halfvec) AS similarity
      FROM postbuch p
      LEFT JOIN arztrechnung a ON a.postid = p.postid
      LEFT JOIN handwerkerrechnung h ON h.postid = p.postid
      LEFT JOIN generische_rechnung g ON g.postid = p.postid
      LEFT JOIN erstattungsbescheid e ON e.postid = p.postid
      WHERE p.embedding IS NOT NULL AND p.embedding_signature = $3 ${semHistFilter}
        ${eigene ? `AND ${eigene}` : ''}
      ORDER BY p.embedding <=> $1::halfvec
      LIMIT 20 OFFSET $2
    `, semParams);

    res.json({ data: result.rows, query: q, offset: offsetNum, hasMore: result.rows.length === 20 });
  } catch (err) {
    console.error('GET /api/search/semantic error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// GET /api/search/akten?q=... — Volltext-Aktensuche
router.get('/akten', async (req, res) => {
  try {
    const { q, historisch } = req.query;
    if (!q || q.trim().length === 0) {
      return res.status(400).json({ error: 'Suchbegriff erforderlich' });
    }

    const aktenHistFilter = historisch === 'true' || historisch === 'all' ? '' : 'AND a.historisch = false';

    const idq = parseIdQuery(q);
    const idRows = idq ? await idLookupAkten(idq) : [];

    const result = await query(`
      SELECT a.akteid, a.betreff, a.beschreibung, a.schlagwoerter,
             a.created_at, a.updated_at,
             COUNT(ad.postid)::int AS dok_count,
             ts_rank(
               to_tsvector('german',
                 COALESCE(a.betreff,'') || ' ' ||
                 COALESCE(a.beschreibung,'') || ' ' ||
                 COALESCE(array_to_string(a.schlagwoerter, ' '),'')
               ),
               plainto_tsquery('german', $1)
             ) AS rank
      FROM akte a
      LEFT JOIN akte_dokument ad ON ad.akteid = a.akteid
      WHERE to_tsvector('german',
        COALESCE(a.betreff,'') || ' ' ||
        COALESCE(a.beschreibung,'') || ' ' ||
        COALESCE(array_to_string(a.schlagwoerter, ' '),'')
      ) @@ plainto_tsquery('german', $1) ${aktenHistFilter}
      GROUP BY a.akteid
      ORDER BY rank DESC
      LIMIT 50
    `, [q]);

    const seen = new Set(idRows.map((r) => r.akteid));
    const merged = [...idRows, ...result.rows.filter((r) => !seen.has(r.akteid))].slice(0, 50);
    res.json({ data: merged, query: q });
  } catch (err) {
    console.error('GET /api/search/akten error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// GET /api/search/akten/semantic?q=... — Semantische Aktensuche via pgvector
router.get('/akten/semantic', async (req, res) => {
  try {
    const { q, historisch: histParam, offset } = req.query;
    if (!q || q.trim().length === 0) {
      return res.status(400).json({ error: 'Suchbegriff erforderlich' });
    }

    // Nummern-Eingabe: direkter ID-Lookup statt Embedding-Call (siehe /semantic)
    const idq = parseIdQuery(q);
    if (idq) {
      const offsetIdq = Math.max(parseInt(offset, 10) || 0, 0);
      const rows = offsetIdq > 0 ? [] : await idLookupAkten(idq);
      return res.json({
        data: rows.map((r) => ({ ...r, similarity: r.exact ? 1.0 : 0.5 })),
        query: q, offset: offsetIdq, hasMore: false,
      });
    }

    const aktenSemHistFilter = histParam === 'true' || histParam === 'all' ? '' : 'AND a.historisch = false';
    const offsetNum = Math.max(parseInt(offset, 10) || 0, 0);

    let emb;
    try {
      emb = await sucheEmbedding(q, req.session?.username || null);
    } catch (err) {
      console.error('[search] Embedding-Fehler:', err.message);
      return res.status(502).json({ error: 'Fehler bei der Embedding-Anfrage' });
    }
    if (!emb) return res.status(503).json({ error: 'Kein Embedding-Provider konfiguriert' });
    const embeddingStr = emb.literal;

    const result = await query(`
      SELECT a.akteid, a.betreff, a.beschreibung, a.schlagwoerter,
             a.created_at, a.updated_at,
             COUNT(ad.postid)::int AS dok_count,
             1 - (a.embedding <=> $1::halfvec) AS similarity
      FROM akte a
      LEFT JOIN akte_dokument ad ON ad.akteid = a.akteid
      WHERE a.embedding IS NOT NULL AND a.embedding_signature = $3 ${aktenSemHistFilter}
      GROUP BY a.akteid, a.embedding
      ORDER BY a.embedding <=> $1::halfvec
      LIMIT 20 OFFSET $2
    `, [embeddingStr, offsetNum, emb.signature]);

    res.json({ data: result.rows, query: q, offset: offsetNum, hasMore: result.rows.length === 20 });
  } catch (err) {
    console.error('GET /api/search/akten/semantic error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// GET /api/search/suggest?q=…&limit=8 — leichtgewichtiges Autocomplete
// für #P/#A-Referenzen im Chat (kein Embedding/LLM, reine DB-Lookups).
router.get('/suggest', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (q.length === 0) {
      return res.status(400).json({ error: 'Suchbegriff erforderlich' });
    }
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 8, 1), 15);
    const idq = parseIdQuery(q);
    // Freitext-Suche (Betreff/Kontakt) erst ab 2 Zeichen und nur ohne ID-Pattern
    const textPattern = !idq && q.length >= 2 ? `%${q}%` : null;

    // Optionaler Dokumentart-Filter — schränkt nur
    // die Dokument-Vorschläge ('P') ein; wenn gesetzt, werden keine Akten ('A') geliefert.
    const arten = (req.query.arten || '').split(',').map((s) => s.trim()).filter(Boolean);
    const artenFilter = arten.length > 0 ? arten : null;

    const docExacts = exactCandidates(idq, 'P');
    const docPrefixes = prefixCandidates(idq, 'P').map((p) => p + '%');
    const akteExacts = exactCandidates(idq, 'A');
    const aktePrefixes = prefixCandidates(idq, 'A').map((p) => p + '%');

    const suggestions = [];
    if (docExacts.length || docPrefixes.length || textPattern) {
      const r = await query(`
        SELECT 'P' AS type, p.postid AS id, p.betreff, p.kontakt, p.briefdatum, p.dokumentart AS art, p.historisch,
               CASE WHEN p.postid = ANY($1::text[]) THEN 2
                    WHEN p.postid LIKE ANY($2::text[]) THEN 1 ELSE 0 END AS prio
        FROM postbuch p
        WHERE (p.postid = ANY($1::text[]) OR p.postid LIKE ANY($2::text[])
           OR ($3::text IS NOT NULL AND (p.betreff ILIKE $3 OR p.kontakt ILIKE $3)))
           AND ($5::text[] IS NULL OR p.dokumentart = ANY($5::text[]))
        ORDER BY prio DESC, p.briefdatum DESC NULLS LAST
        LIMIT $4
      `, [docExacts, docPrefixes, textPattern, limit, artenFilter]);
      suggestions.push(...r.rows);
    }
    if (!artenFilter && (akteExacts.length || aktePrefixes.length || textPattern)) {
      const r = await query(`
        SELECT 'A' AS type, a.akteid AS id, a.betreff, a.historisch,
               (SELECT COUNT(*)::int FROM akte_dokument ad WHERE ad.akteid = a.akteid) AS dok_count,
               CASE WHEN a.akteid = ANY($1::text[]) THEN 2
                    WHEN a.akteid LIKE ANY($2::text[]) THEN 1 ELSE 0 END AS prio
        FROM akte a
        WHERE a.akteid = ANY($1::text[]) OR a.akteid LIKE ANY($2::text[])
           OR ($3::text IS NOT NULL AND a.betreff ILIKE $3)
        ORDER BY prio DESC, a.updated_at DESC NULLS LAST
        LIMIT $4
      `, [akteExacts, aktePrefixes, textPattern, limit]);
      suggestions.push(...r.rows);
    }
    // Exakte ID > ID-Prefix > Freitext; innerhalb gleicher Prio bleibt die Query-Sortierung
    suggestions.sort((x, y) => y.prio - x.prio);
    res.json({ suggestions: suggestions.slice(0, limit) });
  } catch (err) {
    console.error('GET /api/search/suggest error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

export default router;
