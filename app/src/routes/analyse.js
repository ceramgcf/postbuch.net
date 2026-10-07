import { Router } from 'express';
import { query } from '../db.js';
import { offenerBetragSql, offeneRechnungSql } from '../lib/rechnungs-filter.js';
import {
  handwerkerNachZahljahr, handwerkerExcel,
  gesundheitskostenNachZahljahr, gesundheitskostenFilterwerte, gesundheitskostenExcel,
  parseFilterListe, GRUPPEN, RELEVANZ,
} from '../service/steuer-auswertungen.js';
import { ladeKuerzungen, filtereKuerzungen, kuerzungenExcel, parseGesehen } from '../service/kuerzungen.js';
import { sendeExcel } from '../lib/excel.js';

const router = Router();

// GET /api/analyse/unbezahlt — Alle unbezahlten Rechnungen
router.get('/unbezahlt', async (req, res) => {
  try {
    const result = await query(`
      SELECT p.postid, p.briefdatum, p.kontakt, p.dokumentart AS art, p.lebensbereich, p.dokumentart,
             a.name_arzt, a.behandelte_person, a.gesamtbetrag, a.bestritten_betrag,
             ${offenerBetragSql('a')} AS offener_betrag, a.faelligkeit,
             a.re_nr, a.rechnungsdatum, a.bezahlt_am,
             'arztrechnung' AS typ
      FROM postbuch p
      JOIN arztrechnung a ON a.postid = p.postid
      WHERE ${offeneRechnungSql('a')} AND p.historisch = false
      UNION ALL
      SELECT p.postid, p.briefdatum, p.kontakt, p.dokumentart AS art, p.lebensbereich, p.dokumentart,
             h.name_unternehmen, NULL, h.gesamtbetrag, h.bestritten_betrag,
             ${offenerBetragSql('h')} AS offener_betrag, h.faelligkeit,
             h.re_nr, h.rechnungsdatum, h.bezahlt_am,
             'handwerkerrechnung' AS typ
      FROM postbuch p
      JOIN handwerkerrechnung h ON h.postid = p.postid
      WHERE ${offeneRechnungSql('h')} AND p.historisch = false
      UNION ALL
      SELECT p.postid, p.briefdatum, p.kontakt, p.dokumentart AS art, p.lebensbereich, p.dokumentart,
             g.absender, NULL, g.gesamtbetrag, g.bestritten_betrag,
             ${offenerBetragSql('g')} AS offener_betrag, g.faelligkeit,
             g.re_nr, g.rechnungsdatum, g.bezahlt_am,
             'generische_rechnung' AS typ
      FROM postbuch p
      JOIN generische_rechnung g ON g.postid = p.postid
      WHERE ${offeneRechnungSql('g')} AND p.historisch = false
      ORDER BY faelligkeit ASC NULLS LAST
    `);

    res.json({ data: result.rows });
  } catch (err) {
    console.error('GET /api/analyse/unbezahlt error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// GET /api/analyse/kuerzungen?gesehen=offen|alle|gesehen — Alle Kürzungen mit Verknüpfungen;
// die übrigen Filter wendet das Frontend selbst an (service/kuerzungen.js)
router.get('/kuerzungen', async (req, res) => {
  try {
    res.json({ data: await ladeKuerzungen(parseGesehen(req.query.gesehen)) });
  } catch (err) {
    console.error('GET /api/analyse/kuerzungen error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// GET /api/analyse/kuerzungen/export?gesehen=offen&person=Anna,_ohne&kostentraeger=PKV&jahre=2025&periode=3
// — Excel, wie auf der Seite gefiltert; fehlender Parameter = kein Filter
router.get('/kuerzungen/export', async (req, res) => {
  try {
    const zeilen = filtereKuerzungen(await ladeKuerzungen(parseGesehen(req.query.gesehen)), {
      personen: parseFilterListe(req.query.person),
      kostentraeger: parseFilterListe(req.query.kostentraeger),
      jahre: parseFilterListe(req.query.jahre),
      periode: req.query.periode,
    });
    sendeExcel(res, await kuerzungenExcel(zeilen), 'Kuerzungen');
  } catch (err) {
    console.error('GET /api/analyse/kuerzungen/export error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// GET /api/analyse/handwerker?relevanz=relevant — Handwerkerrechnungen gruppiert
// nach Zahljahr; relevanz: relevant (Standard) | irrelevant | alle bezogen auf
// den vom Nutzer gesetzten § 35a-Ausschluss
// (Logik und Begründung: service/steuer-auswertungen.js)
router.get('/handwerker', async (req, res) => {
  try {
    const relevanz = req.query.relevanz ?? 'relevant';
    if (!RELEVANZ.includes(relevanz)) return res.status(400).json({ error: 'Ungültige Relevanz' });
    res.json({ data: await handwerkerNachZahljahr({ relevanz }) });
  } catch (err) {
    console.error('GET /api/analyse/handwerker error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// GET /api/analyse/handwerker/export?jahre=2025,offen&relevanz=relevant — Excel, wie gefiltert
router.get('/handwerker/export', async (req, res) => {
  try {
    const relevanz = req.query.relevanz ?? 'relevant';
    if (!RELEVANZ.includes(relevanz)) return res.status(400).json({ error: 'Ungültige Relevanz' });
    const gruppen = await handwerkerNachZahljahr({ jahre: parseFilterListe(req.query.jahre), relevanz });
    sendeExcel(res, await handwerkerExcel(gruppen), 'Handwerkerrechnungen');
  } catch (err) {
    console.error('GET /api/analyse/handwerker/export error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// GET /api/analyse/gesundheitskosten — Gesundheitskosten je Zahljahr und
// behandelter Person, einschließlich vollständig erstatteter (`vollerstattet`);
// das Frontend filtert selbst
router.get('/gesundheitskosten', async (req, res) => {
  try {
    const [data, filter] = await Promise.all([
      gesundheitskostenNachZahljahr({ mitVollerstatteten: true }),
      gesundheitskostenFilterwerte(),
    ]);
    res.json({ data, filter });
  } catch (err) {
    console.error('GET /api/analyse/gesundheitskosten error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// GET /api/analyse/gesundheitskosten/export?gruppe=personen&endabgerechnet=1&jahre=2025&personen=Anna,ohne
// — Excel, wie gefiltert; gruppe: personen (Standard) | tiere | alle;
// endabgerechnet: 1 (Standard) blendet Rechnungen laufender Perioden aus, 0 zeigt sie;
// vollerstattet: 1 nimmt vollständig erstattete Rechnungen auf (Standard: 0)
router.get('/gesundheitskosten/export', async (req, res) => {
  try {
    const gruppe = req.query.gruppe ?? 'personen';
    if (!GRUPPEN.includes(gruppe)) return res.status(400).json({ error: 'Ungültige Gruppe' });
    const gruppen = await gesundheitskostenNachZahljahr({
      gruppe,
      nurEndabgerechnet: req.query.endabgerechnet !== '0',
      mitVollerstatteten: req.query.vollerstattet === '1',
      jahre: parseFilterListe(req.query.jahre),
      personen: parseFilterListe(req.query.personen),
    });
    sendeExcel(res, await gesundheitskostenExcel(gruppen), 'Gesundheitskosten');
  } catch (err) {
    console.error('GET /api/analyse/gesundheitskosten/export error:', err);
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
        END AS referenz_datum,
        (
          SELECT COUNT(*) FROM dokument_pin dp
          WHERE dp.person = ab.person AND dp.kostentraeger = ab.kostentraeger
            AND dp.periode = ab.periode AND dp.status IN ('VORGEMERKT', 'EINGEREICHT')
        )::int AS anzahl_angepinnt,
        -- Gleiche Auswahl wie die Prüffall-Liste der Periodenseite (Kürzungen
        -- archivierter Bescheide bleiben außen vor).
        (
          SELECT COUNT(*) FROM beihilfe_kuerzung_pkv_pruefung bkpp
          JOIN postbuch eb_p ON eb_p.postid = bkpp.eb_postid
          WHERE bkpp.person = ab.person AND bkpp.kostentraeger = ab.kostentraeger
            AND bkpp.periode = ab.periode AND bkpp.status IN ('VORGEMERKT', 'EINGEREICHT')
            AND eb_p.historisch = false
        )::int AS anzahl_pruefung
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

// GET /api/analyse/perioden/:person/:kostentraeger/:periode/pins — an die
// Periode angepinnte Dokumente (offen vorgemerkt oder bereits eingereicht)
router.get('/perioden/:person/:kostentraeger/:periode/pins', async (req, res) => {
  try {
    const { person, kostentraeger, periode } = req.params;
    const periodeNum = parseInt(periode, 10);
    if (!Number.isFinite(periodeNum)) {
      return res.status(400).json({ error: 'Ungültige Periodenummer' });
    }
    if (!['PKV', 'Beihilfe'].includes(kostentraeger)) {
      return res.status(400).json({ error: 'Ungültiger Kostenträger' });
    }
    const result = await query(`
      SELECT dp.postid, dp.grund, dp.status, dp.vorgemerkt_am, dp.eingereicht_am,
             p.betreff, p.briefdatum, p.dokumentart AS art
      FROM dokument_pin dp
      JOIN postbuch p ON p.postid = dp.postid
      WHERE dp.person = $1 AND dp.kostentraeger = $2 AND dp.periode = $3
        AND dp.status IN ('VORGEMERKT', 'EINGEREICHT')
      ORDER BY dp.id
    `, [person, kostentraeger, periodeNum]);
    res.json({ data: result.rows });
  } catch (err) {
    console.error('GET /api/analyse/perioden/.../pins error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

export default router;
