import { Router } from 'express';
import { query } from '../db.js';
import { parseIdQuery, exactCandidates, prefixCandidates } from '../lib/id-query.js';
import { sucheDokumente, sucheAkten } from '../service/suche.js';

const router = Router();

// Web-Suche über den gemeinsamen Dienst (service/suche.js): Nummern-Treffer,
// wörtliche und inhaltliche Treffer in einer Liste. Für Nutzer mit
// eingeschränktem Lesebereich setzt lesebereichGate req.lesebereich; der Dienst
// filtert damit in jedem Teilweg.
function suchOptionen(req) {
  const { historisch } = req.query;
  return {
    historisch: historisch === 'true' || historisch === 'all',
    // Nachladen: nach den Treffern der ersten Stufe folgen weniger passende bis
    // zur Irrelevanzschwelle, seitenweise ab offset.
    weitere: true,
    offset: Math.max(0, parseInt(req.query.offset, 10) || 0),
    lesebereich: req.lesebereich ?? null,
    username: req.session?.username || null,
    logKategorie: 'search',
  };
}

function suchbegriff(req, res) {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (!q) {
    res.status(400).json({ error: 'Suchbegriff erforderlich' });
    return null;
  }
  return q;
}

function antwort(q, erg, offset) {
  const naechster = offset + erg.treffer.length;
  return {
    data: erg.treffer,
    query: q,
    gesamt: erg.gesamt,
    inhaltlichVerfuegbar: erg.inhaltlichVerfuegbar,
    // Ähnlichkeit, bis zu der das aktive Modell auch für Unsinn liefert (oder null)
    unsinnsschwelle: erg.unsinnsschwelle ?? null,
    aehnlichkeitVoll: erg.aehnlichkeitVoll ?? null,
    offset,
    hasMore: erg.treffer.length > 0 && naechster < erg.gesamt,
    naechsterOffset: naechster,
  };
}

// GET /api/search?q=… – hybride Dokumentsuche
// GET /api/search/semantic?q=… – befristeter Alias für App-Stände vor der
//   hybriden Suche (Rückbau mit dem übernächsten Release, siehe
//   internaldocs/ENTSCHEIDUNGEN.md). similarity bleibt dort die echte
//   Kosinus-Ähnlichkeit, weil alte Oberflächen damit ihre Zähler bilden.
router.get(['/', '/semantic'], async (req, res) => {
  try {
    const q = suchbegriff(req, res);
    if (!q) return;
    const opts = suchOptionen(req);
    res.json(antwort(q, await sucheDokumente(q, opts), opts.offset));
  } catch (err) {
    console.error('GET /api/search error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// GET /api/search/akten?q=… – hybride Aktensuche (Alias /akten/semantic wie oben)
router.get(['/akten', '/akten/semantic'], async (req, res) => {
  try {
    const q = suchbegriff(req, res);
    if (!q) return;
    const opts = suchOptionen(req);
    res.json(antwort(q, await sucheAkten(q, opts), opts.offset));
  } catch (err) {
    console.error('GET /api/search/akten error:', err);
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
    // rechnung=1: nur Dokumente mit Rechnungsblock (Auswahl einer Bezugsrechnung)
    const nurRechnungen = req.query.rechnung === '1';

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
           AND (NOT $6::boolean OR EXISTS (SELECT 1 FROM arztrechnung r WHERE r.postid = p.postid)
                OR EXISTS (SELECT 1 FROM handwerkerrechnung r WHERE r.postid = p.postid)
                OR EXISTS (SELECT 1 FROM generische_rechnung r WHERE r.postid = p.postid))
        ORDER BY prio DESC, p.briefdatum DESC NULLS LAST
        LIMIT $4
      `, [docExacts, docPrefixes, textPattern, limit, artenFilter, nurRechnungen]);
      suggestions.push(...r.rows);
    }
    if (!artenFilter && !nurRechnungen && (akteExacts.length || aktePrefixes.length || textPattern)) {
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
