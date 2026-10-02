import { Router } from 'express';
import { query } from '../db.js';

const router = Router();

// GET /api/stats/dashboard — Aggregierte Statistiken
router.get('/dashboard', async (req, res) => {
  try {
    const [totalResult, artResult, lebensbereichResult, lxdResult, statusResult, unbezahltResult, kuerzungenResult, letzteResult, faelligkeitResult, aktenResult] = await Promise.all([
      query(`SELECT COUNT(*) AS total FROM postbuch WHERE historisch = false`),

      query(`SELECT dokumentart AS art, COUNT(*) AS count FROM postbuch WHERE historisch = false GROUP BY dokumentart ORDER BY count DESC`),

      query(`SELECT lebensbereich, COUNT(*) AS count FROM postbuch WHERE historisch = false GROUP BY lebensbereich ORDER BY count DESC`),

      query(`
        SELECT lebensbereich, dokumentart, COUNT(*) AS count
        FROM postbuch
        WHERE historisch = false
        GROUP BY lebensbereich, dokumentart
        ORDER BY count DESC, lebensbereich, dokumentart
      `),

      query(`SELECT status, COUNT(*) AS count FROM postbuch WHERE historisch = false GROUP BY status ORDER BY count DESC`),

      query(`
        SELECT COUNT(*) AS anzahl, COALESCE(SUM(betrag), 0) AS summe
        FROM (
          SELECT a.gesamtbetrag - COALESCE(a.bestritten_betrag, 0) AS betrag FROM arztrechnung a JOIN postbuch p ON p.postid = a.postid WHERE a.bezahlt_am IS NULL AND a.gesamtbetrag > COALESCE(a.bestritten_betrag, 0) AND p.historisch = false
          UNION ALL
          SELECT h.gesamtbetrag - COALESCE(h.bestritten_betrag, 0) AS betrag FROM handwerkerrechnung h JOIN postbuch p ON p.postid = h.postid WHERE h.bezahlt_am IS NULL AND h.gesamtbetrag > COALESCE(h.bestritten_betrag, 0) AND p.historisch = false
          UNION ALL
          SELECT g.gesamtbetrag - COALESCE(g.bestritten_betrag, 0) AS betrag FROM generische_rechnung g JOIN postbuch p ON p.postid = g.postid WHERE g.bezahlt_am IS NULL AND g.gesamtbetrag > COALESCE(g.bestritten_betrag, 0) AND p.historisch = false
        ) sub
      `),

      query(`
        SELECT COUNT(*) AS anzahl, COALESCE(SUM(
          CASE
            WHEN COALESCE(
              CASE WHEN e.kostentraeger = 'PKV' THEN arz_ep.pkv_satz_override ELSE arz_ep.beihilfe_satz_override END,
              ab.satz,
              CASE WHEN e.kostentraeger = 'PKV' THEN per.pkv_satz ELSE per.beihilfe_satz END
            ) IS NOT NULL
              THEN k.kuerzungsbetrag * COALESCE(
                CASE WHEN e.kostentraeger = 'PKV' THEN arz_ep.pkv_satz_override ELSE arz_ep.beihilfe_satz_override END,
                ab.satz,
                CASE WHEN e.kostentraeger = 'PKV' THEN per.pkv_satz ELSE per.beihilfe_satz END
              ) / 100
            ELSE k.kuerzungsbetrag
          END
        ), 0) AS total
        FROM erstattungsbescheid_kuerzung k
        JOIN erstattungsbescheid_einzelposition ep ON ep.postid = k.postid AND ep.subid = k.eb_subid
        JOIN erstattungsbescheid e ON e.postid = k.postid
        JOIN postbuch p ON p.postid = k.postid
        LEFT JOIN postbuch.mensch per ON per.kurzname = ep.behandelte_person
        LEFT JOIN arztrechnung arz_ep ON arz_ep.postid = ep.arz_postid
        LEFT JOIN abrechnungsperiode_buch ab ON ab.person = ep.behandelte_person
          AND ab.kostentraeger = e.kostentraeger
          AND ab.periode = CASE
            WHEN e.kostentraeger = 'PKV' THEN arz_ep.abrechnungsperiode_pkv
            ELSE arz_ep.abrechnungsperiode_beihilfe
          END
        WHERE p.historisch = false AND k.gesehen_am IS NULL
      `),

      query(`
        SELECT p.postid, p.briefdatum, p.kontakt, p.dokumentart AS art, p.lebensbereich, p.dokumentart, p.betreff, p.status
        FROM postbuch p
        WHERE p.historisch = false
        ORDER BY p.postid DESC
        LIMIT 200
      `),

      query(`
        SELECT MIN(faelligkeit) AS naechste_faelligkeit
        FROM (
          SELECT faelligkeit FROM arztrechnung a JOIN postbuch p ON p.postid = a.postid WHERE a.bezahlt_am IS NULL AND a.gesamtbetrag > COALESCE(a.bestritten_betrag, 0) AND a.faelligkeit IS NOT NULL AND p.historisch = false
          UNION ALL
          SELECT faelligkeit FROM handwerkerrechnung h JOIN postbuch p ON p.postid = h.postid WHERE h.bezahlt_am IS NULL AND h.gesamtbetrag > COALESCE(h.bestritten_betrag, 0) AND h.faelligkeit IS NOT NULL AND p.historisch = false
          UNION ALL
          SELECT faelligkeit FROM generische_rechnung g JOIN postbuch p ON p.postid = g.postid WHERE g.bezahlt_am IS NULL AND g.gesamtbetrag > COALESCE(g.bestritten_betrag, 0) AND g.faelligkeit IS NOT NULL AND p.historisch = false
        ) sub
      `),

      query(`
        SELECT a.akteid, a.betreff, a.updated_at, a.created_at,
               COUNT(ad.postid)::int AS dok_count
        FROM akte a
        LEFT JOIN akte_dokument ad ON ad.akteid = a.akteid
        GROUP BY a.akteid
        ORDER BY a.updated_at DESC
        LIMIT 6
      `),
    ]);

    const nachArt = {};
    for (const row of artResult.rows) {
      nachArt[row.art] = parseInt(row.count, 10);
    }

    const nachLebensbereich = {};
    for (const row of lebensbereichResult.rows) {
      nachLebensbereich[row.lebensbereich] = parseInt(row.count, 10);
    }

    const nachLxd = lxdResult.rows.map((row) => ({
      lebensbereich: row.lebensbereich,
      dokumentart: row.dokumentart,
      count: parseInt(row.count, 10),
    }));

    const nachStatus = {};
    for (const row of statusResult.rows) {
      nachStatus[row.status] = parseInt(row.count, 10);
    }

    res.json({
      totalDokumente: parseInt(totalResult.rows[0].total, 10),
      nachArt,
      nachLebensbereich,
      nachLxd,
      nachStatus,
      unbezahlteRechnungen: parseInt(unbezahltResult.rows[0].anzahl, 10),
      summeUnbezahlt: parseFloat(unbezahltResult.rows[0].summe),
      kuerzungenGesamt: parseFloat(kuerzungenResult.rows[0].total),
      kuerzungenOffenAnzahl: parseInt(kuerzungenResult.rows[0].anzahl, 10),
      letzteEintraege: letzteResult.rows,
      naechsteFaelligkeit: faelligkeitResult.rows[0].naechste_faelligkeit || null,
      letzteAkten: aktenResult.rows,
    });
  } catch (err) {
    console.error('GET /api/stats/dashboard error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// GET /api/stats/scan-retry-queue — Status der Scan-Buffer-Retry-Queue
router.get('/scan-retry-queue', async (req, res) => {
  try {
    const result = await query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'pending')      AS pending,
         COUNT(*) FILTER (WHERE status = 'manual_only')  AS manual_only,
         json_agg(
           json_build_object(
             'job_id',           job_id,
             'original_filename',original_filename,
             'created_at',       created_at,
             'next_retry_at',    next_retry_at,
             'retry_count',      retry_count,
             'max_retries',      max_retries,
             'last_error',       last_error,
             'status',           status
           )
           ORDER BY created_at DESC
         ) FILTER (WHERE TRUE) AS entries
       FROM postbuch._scan_retry_queue`
    );
    const row = result.rows[0];
    res.json({
      pending:     parseInt(row.pending, 10),
      manual_only: parseInt(row.manual_only, 10),
      entries:     row.entries || [],
    });
  } catch (err) {
    console.error('GET /api/stats/scan-retry-queue error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

export default router;
