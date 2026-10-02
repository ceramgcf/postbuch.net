import { Router } from 'express';
import { query } from '../db.js';

const router = Router();

// GET /api/analyse/unbezahlt — Alle unbezahlten Rechnungen
router.get('/unbezahlt', async (req, res) => {
  try {
    const result = await query(`
      SELECT p.postid, p.briefdatum, p.kontakt, p.dokumentart AS art, p.lebensbereich, p.dokumentart,
             a.name_arzt, a.behandelte_person, a.gesamtbetrag, a.bestritten_betrag,
             a.gesamtbetrag - COALESCE(a.bestritten_betrag, 0) AS offener_betrag, a.faelligkeit,
             a.re_nr, a.rechnungsdatum, a.bezahlt_am,
             'arztrechnung' AS typ
      FROM postbuch p
      JOIN arztrechnung a ON a.postid = p.postid
      WHERE a.bezahlt_am IS NULL AND a.gesamtbetrag > COALESCE(a.bestritten_betrag, 0) AND p.historisch = false
      UNION ALL
      SELECT p.postid, p.briefdatum, p.kontakt, p.dokumentart AS art, p.lebensbereich, p.dokumentart,
             h.name_unternehmen, NULL, h.gesamtbetrag, h.bestritten_betrag,
             h.gesamtbetrag - COALESCE(h.bestritten_betrag, 0) AS offener_betrag, h.faelligkeit,
             h.re_nr, h.rechnungsdatum, h.bezahlt_am,
             'handwerkerrechnung' AS typ
      FROM postbuch p
      JOIN handwerkerrechnung h ON h.postid = p.postid
      WHERE h.bezahlt_am IS NULL AND h.gesamtbetrag > COALESCE(h.bestritten_betrag, 0) AND p.historisch = false
      UNION ALL
      SELECT p.postid, p.briefdatum, p.kontakt, p.dokumentart AS art, p.lebensbereich, p.dokumentart,
             g.absender, NULL, g.gesamtbetrag, g.bestritten_betrag,
             g.gesamtbetrag - COALESCE(g.bestritten_betrag, 0) AS offener_betrag, g.faelligkeit,
             g.re_nr, g.rechnungsdatum, g.bezahlt_am,
             'generische_rechnung' AS typ
      FROM postbuch p
      JOIN generische_rechnung g ON g.postid = p.postid
      WHERE g.bezahlt_am IS NULL AND g.gesamtbetrag > COALESCE(g.bestritten_betrag, 0) AND p.historisch = false
      ORDER BY faelligkeit ASC NULLS LAST
    `);

    res.json({ data: result.rows });
  } catch (err) {
    console.error('GET /api/analyse/unbezahlt error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// GET /api/analyse/kuerzungen?gesehen=offen|alle|gesehen — Alle Kürzungen mit Verknüpfungen
router.get('/kuerzungen', async (req, res) => {
  try {
    const gesehenFilter = ['offen', 'alle', 'gesehen'].includes(req.query.gesehen)
      ? req.query.gesehen
      : 'offen';
    const gesehenWhere = gesehenFilter === 'offen'
      ? 'AND k.gesehen_am IS NULL'
      : gesehenFilter === 'gesehen'
        ? 'AND k.gesehen_am IS NOT NULL'
        : '';

    const result = await query(`
      SELECT
        k.postid AS eb_postid,
        e.kostentraeger,
        e.bescheiddatum,
        ep.subid AS eb_subid,
        ep.arz_postid,
        ep.behandelte_person,
        ep.rechnungsbetrag,
        ep.erstattungsbetrag,
        ep.ohne_rechnungsbezug_bestaetigt_am,
        (ep.arz_postid IS NULL AND ep.ohne_rechnungsbezug_bestaetigt_am IS NULL) AS zuordnung_offen,
        k.kuerzung_id,
        k.kuerzungsbetrag,
        k.gesehen_am,
        k.gesehen_von,
        bkpp.status AS pkv_pruefung_status,
        bkpp.periode AS pkv_pruefung_periode,
        bkpp.erlaeuterung AS pkv_pruefung_erlaeuterung,
        CASE
          WHEN COALESCE(
            CASE WHEN e.kostentraeger = 'PKV' THEN arz_ep.pkv_satz_override ELSE arz_ep.beihilfe_satz_override END,
            ab.satz,
            CASE WHEN e.kostentraeger = 'PKV' THEN per.pkv_satz ELSE per.beihilfe_satz END
          ) IS NOT NULL
            THEN ROUND(k.kuerzungsbetrag * COALESCE(
              CASE WHEN e.kostentraeger = 'PKV' THEN arz_ep.pkv_satz_override ELSE arz_ep.beihilfe_satz_override END,
              ab.satz,
              CASE WHEN e.kostentraeger = 'PKV' THEN per.pkv_satz ELSE per.beihilfe_satz END
            ) / 100, 2)
          ELSE k.kuerzungsbetrag
        END AS kuerzungsbetrag_effektiv,
        k.begruendung,
        k.arz_subid,
        a.name_arzt,
        a.re_nr AS arz_re_nr,
        ae.leistung AS arz_leistung,
        ae.goa_goz_gebueh_pzn AS arz_ziffer,
        ae.betrag AS arz_betrag
      FROM erstattungsbescheid_kuerzung k
      JOIN erstattungsbescheid_einzelposition ep ON ep.postid = k.postid AND ep.subid = k.eb_subid
      JOIN erstattungsbescheid e ON e.postid = k.postid
      JOIN postbuch p ON p.postid = k.postid
      LEFT JOIN arztrechnung a ON a.postid = k.arz_postid
      LEFT JOIN arztrechnung_einzelposition ae ON ae.postid = k.arz_postid AND ae.subid = k.arz_subid
      LEFT JOIN postbuch.mensch per ON per.kurzname = ep.behandelte_person
      LEFT JOIN arztrechnung arz_ep ON arz_ep.postid = ep.arz_postid
      LEFT JOIN abrechnungsperiode_buch ab ON ab.person = ep.behandelte_person
        AND ab.kostentraeger = e.kostentraeger
        AND ab.periode = CASE
          WHEN e.kostentraeger = 'PKV' THEN arz_ep.abrechnungsperiode_pkv
          ELSE arz_ep.abrechnungsperiode_beihilfe
        END
      LEFT JOIN beihilfe_kuerzung_pkv_pruefung bkpp
        ON bkpp.eb_postid = k.postid AND bkpp.eb_subid = k.eb_subid AND bkpp.kuerzung_id = k.kuerzung_id
      WHERE p.historisch = false ${gesehenWhere}
      ORDER BY e.bescheiddatum DESC, k.postid, k.eb_subid, k.kuerzung_id
    `);

    res.json({ data: result.rows });
  } catch (err) {
    console.error('GET /api/analyse/kuerzungen error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// GET /api/analyse/handwerker — Handwerkerrechnungen gruppiert nach Leistungsjahr
// (Fallback für Altfälle ohne gesetztes leistungsjahr: Jahreszahl per Regex aus
// dem freien Leistungsdatum-Text)
// Archivierte Dokumente zählen hier bewusst mit: „historisch" heißt weggeräumt,
// nicht ungültig. Der Lohnanteil nach § 35a EStG bleibt für das Leistungsjahr
// absetzbar, auch wenn der Vorgang abgeschlossen und archiviert ist. Damit die
// Summen nachvollziehbar bleiben, wird der archivierte Anteil getrennt
// ausgewiesen und jede Zeile trägt ihr `historisch`-Flag.
router.get('/handwerker', async (req, res) => {
  try {
    const result = await query(`
      SELECT
        COALESCE(
          h.leistungsjahr,
          (regexp_match(h.leistungsdatum, '((?:19|20)[0-9]{2})'))[1]::integer
        ) AS jahr,
        COUNT(*)::integer AS anzahl,
        COUNT(*) FILTER (WHERE p.historisch)::integer AS anzahl_archiviert,
        COALESCE(SUM(h.gesamtbetrag), 0) AS summe_gesamt,
        COALESCE(SUM(h.lohnkosten), 0) AS summe_lohnkosten,
        COALESCE(SUM(h.gesamtbetrag) FILTER (WHERE p.historisch), 0) AS summe_gesamt_archiviert,
        COALESCE(SUM(h.lohnkosten) FILTER (WHERE p.historisch), 0) AS summe_lohnkosten_archiviert,
        json_agg(
          json_build_object(
            'postid',          h.postid,
            'name_unternehmen', h.name_unternehmen,
            'leistung',        h.leistung,
            'leistungsjahr',   h.leistungsjahr,
            'leistungsdatum',  h.leistungsdatum,
            'rechnungsdatum',  h.rechnungsdatum,
            're_nr',           h.re_nr,
            'gesamtbetrag',    h.gesamtbetrag,
            'lohnkosten',      h.lohnkosten,
            'bezahlt_am',      h.bezahlt_am,
            'historisch',      p.historisch
          ) ORDER BY h.rechnungsdatum ASC NULLS LAST
        ) AS rechnungen
      FROM postbuch.handwerkerrechnung h
      JOIN postbuch p ON p.postid = h.postid
      GROUP BY jahr
      ORDER BY jahr DESC NULLS LAST
    `);

    res.json({ data: result.rows });
  } catch (err) {
    console.error('GET /api/analyse/handwerker error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// GET /api/analyse/perioden — Abrechnungsperioden-Übersicht
router.get('/perioden', async (req, res) => {
  try {
    const [result, patientGroups] = await Promise.all([query(`
      SELECT
        ab.person, per.ist_tier, ab.kostentraeger, ab.periode, ab.status, ab.eb_postid,
        ab.satz AS periode_satz, ab.ursprungsperiode,
        COUNT(a.postid) AS anzahl_rechnungen,
        COALESCE(SUM(a.gesamtbetrag), 0) AS summe_rechnungen,
        COALESCE(SUM(
          CASE
            WHEN a.gesamtbetrag IS NULL THEN NULL
            WHEN ab.kostentraeger = 'PKV'
              AND COALESCE(a.pkv_satz_override, ab.satz, per.pkv_satz) IS NOT NULL
              THEN a.gesamtbetrag * COALESCE(a.pkv_satz_override, ab.satz, per.pkv_satz) / 100.0
            WHEN ab.kostentraeger = 'Beihilfe'
              AND COALESCE(a.beihilfe_satz_override, ab.satz, per.beihilfe_satz) IS NOT NULL
              THEN a.gesamtbetrag * COALESCE(a.beihilfe_satz_override, ab.satz, per.beihilfe_satz) / 100.0
            ELSE NULL
          END
        ), 0) AS summe_erwartet,
        BOOL_OR(
          CASE ab.kostentraeger
            WHEN 'PKV'      THEN COALESCE(a.pkv_satz_override, ab.satz, per.pkv_satz)      IS NOT NULL
            WHEN 'Beihilfe' THEN COALESCE(a.beihilfe_satz_override, ab.satz, per.beihilfe_satz) IS NOT NULL
            ELSE false
          END
        ) AS hat_satz,
        CASE ab.status
          WHEN 'COMPLETED' THEN (
            SELECT eb_p.briefdatum FROM postbuch eb_p WHERE eb_p.postid = ab.eb_postid
          )
          WHEN 'SUBMITTED' THEN (
            SELECT MAX(rp.briefdatum)
            FROM arztrechnung ra
            JOIN postbuch rp ON rp.postid = ra.postid
            WHERE ra.behandelte_person = ab.person
              AND (
                (ab.kostentraeger = 'PKV' AND ra.abrechnungsperiode_pkv = ab.periode)
                OR (ab.kostentraeger = 'Beihilfe' AND ra.abrechnungsperiode_beihilfe = ab.periode)
              )
          )
          WHEN 'COLLECTING' THEN (
            SELECT MAX(rp.briefdatum)
            FROM arztrechnung ra
            JOIN postbuch rp ON rp.postid = ra.postid
            WHERE ra.behandelte_person = ab.person
              AND (
                (ab.kostentraeger = 'PKV' AND ra.abrechnungsperiode_pkv IS NOT NULL AND ra.abrechnungsperiode_pkv < ab.periode)
                OR (ab.kostentraeger = 'Beihilfe' AND ra.abrechnungsperiode_beihilfe IS NOT NULL AND ra.abrechnungsperiode_beihilfe < ab.periode)
              )
          )
        END AS referenz_datum
      FROM abrechnungsperiode_buch ab
      LEFT JOIN postbuch.mensch per ON per.kurzname = ab.person
      LEFT JOIN arztrechnung a ON
        a.behandelte_person = ab.person
        AND (
          (ab.kostentraeger = 'PKV' AND a.abrechnungsperiode_pkv = ab.periode)
          OR (ab.kostentraeger = 'Beihilfe' AND a.abrechnungsperiode_beihilfe = ab.periode)
        )
      GROUP BY ab.person, per.ist_tier, ab.kostentraeger, ab.periode, ab.status, ab.satz, ab.eb_postid, ab.ursprungsperiode
      ORDER BY per.ist_tier, ab.person, ab.kostentraeger, ab.periode DESC
    `), query(`
      SELECT ist_tier
      FROM postbuch.mensch
      WHERE archiviert = false AND pkv = true
      GROUP BY ist_tier
      ORDER BY ist_tier
    `)]);

    res.json({ data: result.rows, patientGroups: patientGroups.rows });
  } catch (err) {
    console.error('GET /api/analyse/perioden error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// GET /api/analyse/perioden/collecting — Alle COLLECTING-Perioden (für AP-Verwaltung in Arztrechnung)
router.get('/perioden/collecting', async (req, res) => {
  try {
    const result = await query(
      `SELECT ab.person, m.ist_tier, ab.kostentraeger, ab.periode,
              COUNT(a.postid) FILTER (WHERE a.bestritten_betrag > 0)::int AS bestritten_count
       FROM abrechnungsperiode_buch ab
       JOIN postbuch.mensch m ON m.kurzname = ab.person
       LEFT JOIN arztrechnung a ON a.behandelte_person = ab.person
         AND a.bestritten_betrag > 0
         AND ((ab.kostentraeger = 'PKV' AND a.abrechnungsperiode_pkv = ab.periode)
           OR (ab.kostentraeger = 'Beihilfe' AND a.abrechnungsperiode_beihilfe = ab.periode))
       WHERE ab.status = 'COLLECTING'
       GROUP BY ab.person, m.ist_tier, ab.kostentraeger, ab.periode
       ORDER BY m.ist_tier, ab.person, ab.kostentraeger, ab.periode`,
      []
    );
    res.json({ data: result.rows });
  } catch (err) {
    console.error('GET /api/analyse/perioden/collecting error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// GET /api/analyse/perioden/:person/:kostentraeger/:periode/rechnungen
// Ohne `historisch`-Filter, und das mit Absicht: Eine Rechnung verlässt ihre
// Abrechnungsperiode nur, wenn die Periode ausdrücklich zurückgesetzt wird —
// Archivieren allein reicht dafür nicht. Sonst würden archivierte Rechnungen
// still aus der Einreichung fallen, obwohl sie noch nicht abgerechnet sind.
router.get('/perioden/:person/:kostentraeger/:periode/rechnungen', async (req, res) => {
  try {
    const { person, kostentraeger, periode } = req.params;
    const periodeNum = parseInt(periode, 10);
    if (!Number.isFinite(periodeNum)) {
      return res.status(400).json({ error: 'Ungültige Periodenummer' });
    }
    if (!['PKV', 'Beihilfe'].includes(kostentraeger)) {
      return res.status(400).json({ error: 'Ungültiger Kostenträger' });
    }

    const col = kostentraeger === 'PKV' ? 'a.abrechnungsperiode_pkv' : 'a.abrechnungsperiode_beihilfe';
    const satzOverrideCol = kostentraeger === 'PKV' ? 'a.pkv_satz_override' : 'a.beihilfe_satz_override';
    const satzPersonCol   = kostentraeger === 'PKV' ? 'per.pkv_satz'        : 'per.beihilfe_satz';
    const result = await query(`
      SELECT
        p.postid, p.briefdatum, p.dokumentart AS art, p.betreff, p.historisch,
        a.name_arzt, a.behandelte_person, a.gesamtbetrag,
        a.re_nr, a.rechnungsdatum, a.bezahlt_am,
        a.pkv_satz_override, a.beihilfe_satz_override,
        per.pkv_satz AS personen_pkv_satz,
        per.beihilfe_satz AS personen_beihilfe_satz,
        ab.satz AS periode_satz,
        ${satzOverrideCol} AS satz_override,
        COALESCE(${satzOverrideCol}, ab.satz, ${satzPersonCol}) AS effektiver_satz,
        CASE
          WHEN a.gesamtbetrag IS NOT NULL
            AND COALESCE(${satzOverrideCol}, ab.satz, ${satzPersonCol}) IS NOT NULL
          THEN a.gesamtbetrag * COALESCE(${satzOverrideCol}, ab.satz, ${satzPersonCol}) / 100.0
          ELSE NULL
        END AS erwartete_erstattung,
        COALESCE((
          SELECT SUM(ep.erstattungsbetrag)
          FROM erstattungsbescheid_einzelposition ep
          JOIN erstattungsbescheid e ON e.postid = ep.postid
          WHERE ep.arz_postid = a.postid
            AND e.kostentraeger = $3
        ), 0) AS erstattungsbetrag_gesamt
      FROM arztrechnung a
      JOIN postbuch p ON p.postid = a.postid
      LEFT JOIN postbuch.mensch per ON per.kurzname = a.behandelte_person
      LEFT JOIN abrechnungsperiode_buch ab
        ON ab.person = a.behandelte_person AND ab.kostentraeger = $3 AND ab.periode = $2
      WHERE a.behandelte_person = $1
        AND ${col} = $2
      ORDER BY p.briefdatum DESC NULLS LAST
    `, [person, periodeNum, kostentraeger]);

    res.json({ data: result.rows });
  } catch (err) {
    console.error('GET /api/analyse/perioden/.../rechnungen error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

export default router;
