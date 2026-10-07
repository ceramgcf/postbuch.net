import { Router } from 'express';
import { query, getClient } from '../db.js';
import { uiLog } from '../log.js';
import { regenerateEmbedding } from '../lib/embedding.js';
import { decodeBase64Pdf, mergePdfs } from '../lib/pdf.js';
import { scanQrCodes } from '../lib/qr.js';
import { replacePdf, restorePdf } from '../service/document-replace.js';
import { retrieveDocument } from '../service/document-retriever.js';
import { appLog } from '../app-log.js';
import { loadDynamicSettings, getAblageEbenen } from '../config.js';
import { verschiebeAnSollort, zieheNachBehandelterPerson } from '../service/ablage-sollort.js';
import * as suspensionStore from '../service/suspension-store.js';
import { verify as verifyToken } from '../lib/decision-token.js';
import {
  setEbpZuordnung, addKuerzung, updateKuerzung, deleteKuerzung,
} from '../service/erstattungsbescheid.js';
import {
  setGesehen, vormerkenFuerAktuellePkvPeriode, entferneVormerkung, setOhneRechnungsbezug, setErlaeuterung,
} from '../service/kuerzung-workflow.js';
import { pinDokument, unpinDokument, listePins } from '../service/dokument-pin.js';
import { verschiebeInPapierkorb } from '../service/document-delete.js';
import { setzeBescheidwirkungZurueck } from '../service/periodenabschluss.js';
import { sperrePerioden } from '../service/perioden-sperre.js';
import { istGueltigerStatus } from '../lib/post-status.js';
import { effektiveGruppe } from '../lib/taxonomie.js';
import { UNBEZAHLT_SQL_CONDITION } from '../lib/rechnungs-filter.js';
import {
  ZahlungFehler, inTransaktion, setzeBezahltAm, ersetzeZahlungen,
  aktualisiereZahlstatus, ermittleZahlungslage, berechneLage, ladeZahlungen,
  gleicheZahlungenAn, pruefeNichtErsetzt,
} from '../service/rechnung-zahlung.js';
import {
  ersetzeRechnung, hebeErsetzungAuf, ermittleKandidaten, ladeErsetzung, ladeRechnungKurz,
} from '../service/rechnung-ersetzung.js';
import { eigeneDokumenteBedingung, istEingeschraenkt } from '../middleware/lesebereich.js';
import { parsePersonenAuswahl } from '../lib/personen-auswahl.js';
import {
  oeffneSichereDokumentloeschung,
  istLoeschschutzFehler,
  loeschschutzAntwort,
} from '../service/document-delete-protection.js';

/** Bearbeitbare Felder, die eine Ablageebene bestimmen. */
const ABLAGE_FELD_EBENE = { familienmitglied: 'person', briefdatum: 'jahr', richtung: 'richtung' };

const router = Router();

const POSTID_RE = /^P\d{6}$/;

// --- Debounced embedding update for document metadata changes ---
const EMBEDDING_DEBOUNCE_MS = 30 * 1000; // 30 seconds
const embeddingTimers = new Map();

function schedulePostbuchEmbedding(postid) {
  if (embeddingTimers.has(postid)) clearTimeout(embeddingTimers.get(postid));
  const timer = setTimeout(() => {
    embeddingTimers.delete(postid);
    regenerateEmbedding(postid)
      .then(() => uiLog('AI_EMBEDDING', 'postbuch', postid, 'Embedding aktualisiert'))
      .catch(err => console.error('Scheduled postbuch embedding failed:', err));
  }, EMBEDDING_DEBOUNCE_MS);
  embeddingTimers.set(postid, timer);
}

// GET /api/postbuch — Liste mit Filter, Sortierung, Paginierung
router.get('/', async (req, res) => {
  try {
    const {
      art, lebensbereich, dokumentart, status, q, von, bis, person, familienmitglied, unbezahlt,
      richtung,
      person_as_adressat, person_as_patient,
      mit_notiz, in_akte, offene_wiedervorlage,
      sort = 'briefdatum', order = 'desc',
      limit = '50', offset = '0',
    } = req.query;

    // Semantic similarity: optional akteId to sort docs by cosine similarity to the Akte's embedding
    const { akteId } = req.query;
    const hasAkteId = !istEingeschraenkt(req) && !!(akteId && /^A\d{6}$/.test(akteId));

    // Semantic similarity: optional similarToPostId to sort docs by cosine similarity to another doc's embedding
    const { similarToPostId } = req.query;
    const hasSimilarToPostId = !!(similarToPostId && /^P\d{6}$/.test(similarToPostId));

    const hasSimilarity = hasAkteId || hasSimilarToPostId;

    const allowedSorts = ['briefdatum', 'erfassungsdatum', 'kontakt', 'art', 'postid', 'betrag'];
    if (hasSimilarity) allowedSorts.push('similarity');
    const sortCol = allowedSorts.includes(sort) ? sort : 'briefdatum';
    const sortOrder = order === 'asc' ? 'ASC' : 'DESC';
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const offsetNum = Math.max(parseInt(offset, 10) || 0, 0);

    // historisch filter: default exclude historical documents unless explicitly requested
    const { historisch } = req.query;

    const conditions = [];
    const params = [];
    const eigene = eigeneDokumenteBedingung(req, 'p.familienmitglied', params);
    if (eigene) conditions.push(eigene);
    let paramIdx = params.length + 1;

    if (historisch === 'only') {
      conditions.push(`p.historisch = true`);
    } else if (historisch !== 'true' && historisch !== 'all') {
      conditions.push(`p.historisch = false`);
    }

    if (art) {
      const artValues = art.split(',').map(a => a.trim()).filter(Boolean);
      conditions.push(`p.dokumentart = ANY($${paramIdx}::text[])`);
      params.push(artValues);
      paramIdx++;
    }
    for (const [wert, spalte] of [[lebensbereich, 'lebensbereich'], [dokumentart, 'dokumentart']]) {
      if (!wert) continue;
      const werte = wert.split(',').map((x) => x.trim()).filter(Boolean);
      if (werte.length) { conditions.push(`p.${spalte} = ANY($${paramIdx}::text[])`); params.push(werte); paramIdx++; }
    }
    if (status) {
      conditions.push(`p.status = $${paramIdx}::postbuch.post_status`);
      params.push(status);
      paramIdx++;
    }

    if (q) {
      conditions.push(`(
        p.betreff ILIKE $${paramIdx} OR
        p.zusammenfassung ILIKE $${paramIdx} OR
        p.kontakt ILIKE $${paramIdx} OR
        p.fremdes_zeichen ILIKE $${paramIdx} OR
        p.notiz ILIKE $${paramIdx} OR
        array_to_string(p.schlagwoerter, ' ') ILIKE $${paramIdx}
      )`);
      params.push(`%${q}%`);
      paramIdx++;
    }

    if (richtung) {
      const richtungValues = richtung.split(',').map(r => r.trim()).filter(r => r === 'eingang' || r === 'ausgang');
      if (richtungValues.length > 0 && richtungValues.length < 2) {
        conditions.push(`p.richtung = ANY($${paramIdx}::postbuch.post_richtung[])`);
        params.push(richtungValues);
        paramIdx++;
      }
      // length === 0 → ungültig, ignorieren; === 2 → beide → kein Filter
    }

    if (von) {
      conditions.push(`p.briefdatum >= $${paramIdx}::date`);
      params.push(von);
      paramIdx++;
    }

    if (bis) {
      conditions.push(`p.briefdatum <= $${paramIdx}::date`);
      params.push(bis);
      paramIdx++;
    }

    // person: ein Kurzname oder mehrere kommagetrennt, `_ohne` = ohne Personenzuordnung.
    const personAuswahl = parsePersonenAuswahl(person);
    if (personAuswahl) {
      const personConditions = [];
      // „ohne“ prüft nur die Zuordnung am Dokument; die Rollen-Häkchen spielen dafür keine Rolle.
      if (personAuswahl.ohne) personConditions.push(`NULLIF(p.familienmitglied, '') IS NULL`);
      if (personAuswahl.namen.length) {
        // person_as_adressat → matcht p.familienmitglied (egal ob Eingang oder Ausgang —
        // das Familienmitglied kann jetzt Empfänger ODER Sender sein)
        const personAsAdressat = person_as_adressat !== 'false';
        const personAsPatient = person_as_patient === 'true';
        const personRoleConditions = [];

        // Exakter Kurzname-Vergleich statt Teilstring: sonst träfe „Jona“ auch
        // „Jonas“. Der Filterwert stammt ohnehin aus der Kurznamen-Auswahl.
        const namen = `ANY($${paramIdx}::text[])`;
        if (personAsAdressat) {
          personRoleConditions.push(`LOWER(p.familienmitglied) = ${namen}`);
        }
        if (personAsPatient) {
          personRoleConditions.push(`LOWER(a.behandelte_person) = ${namen}`);
          personRoleConditions.push(`EXISTS (SELECT 1 FROM arztbericht abr WHERE abr.postid = p.postid AND LOWER(abr.behandelte_person) = ${namen})`);
          personRoleConditions.push(`EXISTS (SELECT 1 FROM erstattungsbescheid_einzelposition ep WHERE ep.postid = p.postid AND LOWER(ep.behandelte_person) = ${namen})`);
        }
        if (personRoleConditions.length) {
          personConditions.push(...personRoleConditions);
          params.push(personAuswahl.namen);
          paramIdx++;
        }
      }
      conditions.push(personConditions.length ? `(${personConditions.join(' OR ')})` : '1 = 0');
    }

    if (familienmitglied) {
      conditions.push(`p.familienmitglied = $${paramIdx}`);
      params.push(familienmitglied);
      paramIdx++;
    }

    if (unbezahlt === 'true') {
      conditions.push(UNBEZAHLT_SQL_CONDITION);
    }

    if (mit_notiz === 'true') {
      conditions.push(`p.notiz IS NOT NULL AND BTRIM(p.notiz) <> ''`);
    }

    if (in_akte === 'true') {
      conditions.push(`EXISTS (SELECT 1 FROM akte_dokument ad WHERE ad.postid = p.postid)`);
    }

    if (offene_wiedervorlage === 'true') {
      conditions.push(`EXISTS (SELECT 1 FROM wiedervorlage w WHERE w.postid = p.postid AND w.erledigt = false)`);
    }

    const { verbleib_kategorie_id, verbleib_ablage_id, original_urkunde } = req.query;
    if (verbleib_kategorie_id) {
      const kid = parseInt(verbleib_kategorie_id, 10);
      if (Number.isInteger(kid) && kid > 0) {
        conditions.push(`p.verbleib_id = $${paramIdx}`);
        params.push(kid);
        paramIdx++;
      }
    }
    if (verbleib_ablage_id) {
      const aid = parseInt(verbleib_ablage_id, 10);
      if (Number.isInteger(aid) && aid > 0) {
        conditions.push(`p.verbleib_ablage_id = $${paramIdx}`);
        params.push(aid);
        paramIdx++;
      }
    }
    if (original_urkunde === 'true') {
      conditions.push(`p.original_urkunde = true`);
    }
    if (req.query.verbleib_ohne_ablage === 'true') {
      conditions.push(`p.verbleib_ablage_id IS NULL`);
    }
    if (req.query.fehlt_in_ablage === 'true') {
      conditions.push(`p.storage_id IS NULL`);
    }

    const { excludeAkteId } = req.query;
    if (excludeAkteId && /^A\d{6}$/.test(excludeAkteId)) {
      conditions.push(`NOT EXISTS (SELECT 1 FROM akte_dokument ad WHERE ad.postid = p.postid AND ad.akteid = $${paramIdx})`);
      params.push(excludeAkteId);
      paramIdx++;
    }

    // Exclude the source document in similar-docs mode
    if (hasSimilarToPostId) {
      conditions.push(`p.postid != $${paramIdx}`);
      params.push(similarToPostId);
      paramIdx++;
    }

    // Column filters (cf_<column>=<value>) — sent by the inline filter inputs in PostbuchTable
    // Whitelist maps column key → SQL expression to ILIKE against
    const CF_MAP = {
      postid:        'p.postid',
      briefdatum:    "TO_CHAR(p.briefdatum, 'DD.MM.YYYY')",
      kontakt:       'p.kontakt',
      betreff:       'p.betreff',
      betrag:        "COALESCE(a.gesamtbetrag, h.gesamtbetrag, g.gesamtbetrag, e.erstattungsbetrag)::text",
    };
    for (const [colKey, sqlExpr] of Object.entries(CF_MAP)) {
      const val = req.query[`cf_${colKey}`];
      if (val && val.trim()) {
        conditions.push(`${sqlExpr} ILIKE $${paramIdx}`);
        params.push(`%${val.trim()}%`);
        paramIdx++;
      }
    }

    const whereClause = conditions.length > 0
      ? 'WHERE ' + conditions.join(' AND ')
      : '';

    // betrag and similarity are computed aliases — wrap sort if needed
    const sortExpression = sortCol === 'betrag'
      ? 'COALESCE(a.gesamtbetrag, h.gesamtbetrag, g.gesamtbetrag, e.erstattungsbetrag)'
      : sortCol === 'similarity'
        ? 'similarity'
        : sortCol === 'art'
          ? 'p.dokumentart'
          : `p.${sortCol}`;

    const countResult = await query(`
      SELECT COUNT(*) AS total
      FROM postbuch p
      LEFT JOIN arztrechnung a ON a.postid = p.postid
      LEFT JOIN handwerkerrechnung h ON h.postid = p.postid
      LEFT JOIN generische_rechnung g ON g.postid = p.postid
      LEFT JOIN erstattungsbescheid e ON e.postid = p.postid
      ${whereClause}
    `, params);

    const total = parseInt(countResult.rows[0].total, 10);

    // For similarity sort: add lateral join to get the reference embedding at query time.
    // The reference id is appended after LIMIT/OFFSET so it sits at $${paramIdx + 2}.
    let similaritySelect = '';
    let similarityJoin = '';
    let dataParams = [...params, limitNum, offsetNum];

    if (hasAkteId) {
      similaritySelect = `, CASE WHEN p.embedding IS NOT NULL AND ae.embedding IS NOT NULL
                    THEN 1 - (p.embedding <=> ae.embedding)
                    ELSE NULL END AS similarity`;
      similarityJoin = `LEFT JOIN LATERAL (SELECT embedding FROM akte WHERE akteid = $${paramIdx + 2}) ae ON TRUE`;
      dataParams = [...params, limitNum, offsetNum, akteId];
    } else if (hasSimilarToPostId) {
      similaritySelect = `, CASE WHEN p.embedding IS NOT NULL AND src.embedding IS NOT NULL
                    THEN 1 - (p.embedding <=> src.embedding)
                    ELSE NULL END AS similarity`;
      similarityJoin = `LEFT JOIN LATERAL (SELECT embedding FROM postbuch WHERE postid = $${paramIdx + 2}) src ON TRUE`;
      dataParams = [...params, limitNum, offsetNum, similarToPostId];
    }

    const result = await query(`
      SELECT p.postid, p.briefdatum, p.kontakt, p.dokumentart AS art, p.lebensbereich, p.dokumentart, p.betreff,
             p.zusammenfassung, p.status, p.confidence, p.schlagwoerter,
             p.erfassungsdatum, p.link, p.notiz, p.historisch,
             p.familienmitglied, p.richtung, p.original_urkunde,
             pers.farbe AS familienmitglied_farbe,
             COALESCE(a.gesamtbetrag - COALESCE(a.bestritten_betrag, 0), h.gesamtbetrag - COALESCE(h.bestritten_betrag, 0), g.gesamtbetrag - COALESCE(g.bestritten_betrag, 0), e.erstattungsbetrag) AS betrag,
             a.name_arzt, a.behandelte_person, a.bezahlt_am,
             h.name_unternehmen,
             (p.storage_id IS NOT NULL) AS hat_pdf,
             EXISTS (SELECT 1 FROM wiedervorlage w WHERE w.postid = p.postid) AS hat_wiedervorlage,
             p.verbleib_id, vk.icon AS verbleib_kategorie_icon, vk.name AS verbleib_kategorie_name
             ${similaritySelect}
      FROM postbuch p
      LEFT JOIN arztrechnung a ON a.postid = p.postid
      LEFT JOIN handwerkerrechnung h ON h.postid = p.postid
      LEFT JOIN generische_rechnung g ON g.postid = p.postid
      LEFT JOIN erstattungsbescheid e ON e.postid = p.postid
      LEFT JOIN postbuch.mensch pers ON pers.kurzname = p.familienmitglied
      LEFT JOIN verbleib_kategorie vk ON vk.id = p.verbleib_id
      ${similarityJoin}
      ${whereClause}
      ORDER BY ${sortExpression} ${sortOrder} NULLS LAST, p.postid DESC
      LIMIT $${paramIdx} OFFSET $${paramIdx + 1}
    `, dataParams);

    res.json({
      data: result.rows,
      total,
      limit: limitNum,
      offset: offsetNum,
    });
  } catch (err) {
    console.error('GET /api/postbuch error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// GET /api/postbuch/embedding-queue — wartende Embedding-Berechnungen (Debounce-Timer)
// MUSS vor /:postid stehen, da /:postid als Wildcard sonst matcht!
router.get('/embedding-queue', (req, res) => {
  try {
    const postids = Array.from(embeddingTimers.keys());
    res.json({ count: postids.length, postids });
  } catch (err) {
    console.error('GET /api/postbuch/embedding-queue error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// GET /api/postbuch/missing-embeddings — Dokumente ohne Embedding (Soft-Fail-Tracking)
// MUSS vor /:postid stehen, da /:postid als Wildcard sonst matcht!
router.get('/missing-embeddings', async (req, res) => {
  try {
    const result = await query(`
      SELECT postid, betreff, dokumentart AS art, erfassungsdatum,
             embedding_failed_at, embedding_error
      FROM postbuch
      WHERE embedding IS NULL
      ORDER BY embedding_failed_at DESC NULLS LAST, erfassungsdatum DESC
    `);
    res.json({ count: result.rows.length, docs: result.rows });
  } catch (err) {
    console.error('GET /api/postbuch/missing-embeddings error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// ─── Pending Decisions ─────────────────────────────────────────────────────────────────
// MUSS vor /:postid stehen, da /:postid als Wildcard sonst matcht!

// GET /api/postbuch/pending-decisions — Alle suspendierten Jobs auflisten (Session-Auth)
router.get('/pending-decisions', async (req, res) => {
  try {
    const rows = await suspensionStore.listAll();
    res.json(rows.map(r => ({
      jobId: r.job_id,
      reason: r.reason,
      onedriveId: r.storage_id,
      onedriveWeburl: r.onedrive_weburl,
      reservedPostid: r.reserved_postid,
      matchPostid: r.match_postid,
      matchWeburl: r.match_weburl,
      matchConfidence: Number(r.match_confidence),
      similarity: Number(r.similarity),
      newConfidence: Number(r.new_confidence),
      stepOffset: r.step_offset,
      discordMessageId: r.discord_message_id,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      // Payload-Auszug für UI
      betreff: r.payload?.extractedData?.postbuch?.betreff || null,
      briefdatum: r.payload?.extractedData?.postbuch?.briefdatum || null,
      dokumentTyp: r.payload?.extractedData?.dokumentart || r.payload?.extractedData?.dokumentTyp || null,
    })));
  } catch (err) {
    console.error('GET /api/postbuch/pending-decisions error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// GET /api/postbuch/pending-decisions/:jobId — Einzelne Suspension (Session ODER Token)
router.get('/pending-decisions/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const { token } = req.query;

    // Authentifizierung: Session oder Magic-Link-Token
    const isAuthenticated = req.session?.authenticated === true;
    let tokenValid = false;
    if (token) {
      try {
        const payload = await verifyToken(token);
        tokenValid = payload?.jobId === jobId && payload?.exp > Math.floor(Date.now() / 1000);
      } catch { /* invalid */ }
    }

    if (!isAuthenticated && !tokenValid) {
      return res.status(401).json({ error: 'Nicht autorisiert' });
    }

    const suspension = await suspensionStore.get(jobId);
    if (!suspension) {
      return res.status(404).json({ error: 'Suspension nicht gefunden (evtl. bereits entschieden)' });
    }

    res.json({
      jobId: suspension.job_id,
      reason: suspension.reason,
      onedriveId: suspension.storage_id,
      onedriveWeburl: suspension.onedrive_weburl,
      reservedPostid: suspension.reserved_postid,
      matchPostid: suspension.match_postid,
      matchWeburl: suspension.match_weburl,
      matchConfidence: Number(suspension.match_confidence),
      similarity: Number(suspension.similarity),
      newConfidence: Number(suspension.new_confidence),
      createdAt: suspension.created_at,
      expiresAt: suspension.expires_at,
      betreff: suspension.payload?.postbuch?.betreff || null,
      briefdatum: suspension.payload?.postbuch?.briefdatum || null,
      dokumentTyp: suspension.payload?.dokumentart || suspension.payload?.dokumentTyp || null,
    });
  } catch (err) {
    console.error('GET /api/postbuch/pending-decisions/:jobId error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// ─── Failed Documents ────────────────────────────────────────────────────────────────
// MUSS vor /:postid stehen!

// GET /api/postbuch/failed — Alle fehlgeschlagenen Dokumente
router.get('/failed', async (req, res) => {
  try {
    const result = await query(
      'SELECT * FROM postbuch._failed_documents ORDER BY failed_at DESC'
    );
    res.json(result.rows);
  } catch (err) {
    console.error('GET /api/postbuch/failed error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// DELETE /api/postbuch/failed/:onedriveId — Fehlgeschlagenes Dokument löschen (aus DB)
router.delete('/failed/:onedriveId', async (req, res) => {
  try {
    const { onedriveId } = req.params;
    const result = await query(
      'DELETE FROM postbuch._failed_documents WHERE onedrive_id = $1 RETURNING *',
      [onedriveId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Eintrag nicht gefunden' });
    }
    appLog('INFO', 'postbuch', `Fehlgeschlagenes Dokument gelöscht: ${onedriveId}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /api/postbuch/failed/:onedriveId error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// GET /api/postbuch/:postid — Einzelnes Dokument mit allen verknüpften Daten
router.get('/:postid', async (req, res) => {
  try {
    const { postid } = req.params;
    if (!POSTID_RE.test(postid)) {
      return res.status(400).json({ error: 'Ungültige PostID' });
    }

    // Basis-Postbuch-Eintrag
    const pbResult = await query(`
      SELECT p.*,
             (p.storage_id IS NOT NULL) AS hat_pdf,
             pers.farbe AS familienmitglied_farbe,
             CASE WHEN vk.id IS NOT NULL
               THEN json_build_object('id', vk.id, 'name', vk.name, 'icon', vk.icon, 'archived', vk.archived)
               ELSE NULL
             END AS verbleib,
             CASE WHEN va.id IS NOT NULL
               THEN json_build_object('id', va.id, 'name', va.name, 'archived', va.archived)
               ELSE NULL
             END AS verbleib_ablage
      FROM postbuch p
      LEFT JOIN postbuch.mensch pers ON pers.kurzname = p.familienmitglied
      LEFT JOIN verbleib_kategorie vk ON vk.id = p.verbleib_id
      LEFT JOIN verbleib_ablage va ON va.id = p.verbleib_ablage_id
      WHERE p.postid = $1
    `, [postid]);

    if (pbResult.rows.length === 0) {
      return res.status(404).json({ error: 'Dokument nicht gefunden' });
    }

    const postbuch = pbResult.rows[0];
    // Capture has_embedding before stripping the vector (too large to send)
    const hasEmbedding = postbuch.embedding != null;
    delete postbuch.embedding;

    const response = {
      postbuch: {
        ...postbuch,
        art: postbuch.dokumentart,
        hatPdf: postbuch.hat_pdf,
        hasEmbedding,
      },
      arztrechnung: null,
      erstattungsbescheid: null,
      handwerkerrechnung: null,
      generischeRechnung: null,
      arztbericht: null,
    };

    // Spezialtabellen sind die Quelle der Wahrheit. Nicht zusätzlich nach
    // Dokumentart filtern: Taxonomie-Codes dürfen bestehende Detaildaten nicht
    // unsichtbar machen.
    const arzResult = await query(`
      SELECT a.*, per.ist_tier AS behandelte_person_ist_tier,
             per.pkv_satz AS personen_pkv_satz, per.beihilfe_satz AS personen_beihilfe_satz,
             per.pkv AS personen_pkv, per.beihilfe AS personen_beihilfe,
             ap_pkv.status AS abrechnungsperiode_pkv_status,
             ap_bh.status AS abrechnungsperiode_beihilfe_status
      FROM arztrechnung a
      LEFT JOIN postbuch.mensch per ON per.kurzname = a.behandelte_person
      LEFT JOIN abrechnungsperiode_buch ap_pkv
        ON ap_pkv.person = a.behandelte_person AND ap_pkv.kostentraeger = 'PKV'
       AND ap_pkv.periode = a.abrechnungsperiode_pkv
      LEFT JOIN abrechnungsperiode_buch ap_bh
        ON ap_bh.person = a.behandelte_person AND ap_bh.kostentraeger = 'Beihilfe'
       AND ap_bh.periode = a.abrechnungsperiode_beihilfe
      WHERE a.postid = $1
    `, [postid]);
    if (arzResult.rows.length > 0) {
      const arztrechnung = arzResult.rows[0];

      // Einzelpositionen
      const posResult = await query(
        `SELECT * FROM arztrechnung_einzelposition WHERE postid = $1 ORDER BY subid`,
        [postid]
      );
      arztrechnung.einzelpositionen = posResult.rows;

      // Verknüpfte Erstattungen über erstattungsbescheid_einzelposition
      const ebResult = await query(`
        SELECT ep.postid AS eb_postid, ep.subid AS eb_subid,
               e.kostentraeger, e.bescheiddatum,
               ep.erstattungsbetrag, ep.kuerzungsbetrag,
               COALESCE(
                 json_agg(
                   json_build_object(
                     'kuerzung_id', k.kuerzung_id,
                     'betrag', k.kuerzungsbetrag,
                     'begruendung', k.begruendung,
                     'arz_subid', k.arz_subid,
                     'gesehen_am', k.gesehen_am,
                     'gesehen_von', k.gesehen_von,
                     'pkv_pruefung_status', bkpp.status,
                     'pkv_pruefung_periode', bkpp.periode,
                     'pkv_pruefung_erlaeuterung', bkpp.erlaeuterung
                   )
                 ) FILTER (WHERE k.kuerzung_id IS NOT NULL),
                 '[]'::json
               ) AS kuerzungen
        FROM erstattungsbescheid_einzelposition ep
        JOIN erstattungsbescheid e ON e.postid = ep.postid
        LEFT JOIN erstattungsbescheid_kuerzung k
          ON k.postid = ep.postid AND k.eb_subid = ep.subid
        LEFT JOIN beihilfe_kuerzung_pkv_pruefung bkpp
          ON bkpp.eb_postid = k.postid AND bkpp.eb_subid = k.eb_subid AND bkpp.kuerzung_id = k.kuerzung_id
        WHERE ep.arz_postid = $1
        GROUP BY ep.postid, ep.subid, e.kostentraeger, e.bescheiddatum,
                 ep.erstattungsbetrag, ep.kuerzungsbetrag
        ORDER BY e.bescheiddatum
      `, [postid]);

      arztrechnung.erstattungen = ebResult.rows;
      response.arztrechnung = arztrechnung;
    }

    // Erstattungsbescheid
    // Läuft asynchron im Hintergrund weiter, nachdem die Upload-Pipeline schon
    // "fertig" gemeldet hat (service/erstattungsbescheid.js) — daher hier
    // markieren, ob der Fachblock erwartet wird, aber noch fehlt. Das Frontend
    // zeigt dafür einen Ladehinweis statt einer leeren Sektion.
    response.erstattungsbescheidAusstehend = false;
    const ebResult = await query(`SELECT * FROM erstattungsbescheid WHERE postid = $1`, [postid]);
    if (ebResult.rows.length > 0) {
      const eb = ebResult.rows[0];

      // Einzelpositionen mit verknüpfter Arztrechnung + periodenspezifischem Leistungssatz
      const epResult = await query(`
          SELECT ep.*,
                 p_arz.betreff AS arz_betreff,
                 a.name_arzt,
                 per.beihilfe_satz AS personen_beihilfe_satz,
                 per.pkv_satz AS personen_pkv_satz,
                 COALESCE(
                   CASE WHEN $2 = 'PKV' THEN arz_ep.pkv_satz_override ELSE arz_ep.beihilfe_satz_override END,
                   ab.satz,
                   CASE WHEN $2 = 'PKV' THEN per.pkv_satz ELSE per.beihilfe_satz END
                 ) AS leistungssatz
          FROM erstattungsbescheid_einzelposition ep
          LEFT JOIN postbuch p_arz ON p_arz.postid = ep.arz_postid
          LEFT JOIN arztrechnung a ON a.postid = ep.arz_postid
          LEFT JOIN postbuch.mensch per ON per.kurzname = ep.behandelte_person
          LEFT JOIN arztrechnung arz_ep ON arz_ep.postid = ep.arz_postid
          LEFT JOIN abrechnungsperiode_buch ab ON ab.person = ep.behandelte_person
            AND ab.kostentraeger = $2
            AND ab.periode = CASE
              WHEN $2 = 'PKV' THEN arz_ep.abrechnungsperiode_pkv
              ELSE arz_ep.abrechnungsperiode_beihilfe
            END
          WHERE ep.postid = $1
          ORDER BY ep.subid
      `, [postid, eb.kostentraeger]);

      // Für jede Einzelposition Kürzungen laden
      for (const ep of epResult.rows) {
        const kResult = await query(`
            SELECT k.*,
                   ae.leistung AS arz_leistung,
                   ae.goa_goz_gebueh_pzn AS arz_ziffer,
                   ae.betrag AS arz_betrag,
                   bkpp.status AS pkv_pruefung_status,
                   bkpp.periode AS pkv_pruefung_periode,
                   bkpp.erlaeuterung AS pkv_pruefung_erlaeuterung
            FROM erstattungsbescheid_kuerzung k
            LEFT JOIN arztrechnung_einzelposition ae
              ON ae.postid = k.arz_postid AND ae.subid = k.arz_subid
            LEFT JOIN beihilfe_kuerzung_pkv_pruefung bkpp
              ON bkpp.eb_postid = k.postid AND bkpp.eb_subid = k.eb_subid AND bkpp.kuerzung_id = k.kuerzung_id
            WHERE k.postid = $1 AND k.eb_subid = $2
            ORDER BY k.kuerzung_id
        `, [postid, ep.subid]);
        ep.kuerzungen = kResult.rows;
      }

      eb.einzelpositionen = epResult.rows;
      response.erstattungsbescheid = eb;
    } else if (await effektiveGruppe(postbuch.lebensbereich, postbuch.dokumentart) === 'erstattungsbescheid') {
      response.erstattungsbescheidAusstehend = true;
    }

    // Handwerkerrechnung
    const hResult = await query(`SELECT * FROM handwerkerrechnung WHERE postid = $1`, [postid]);
    if (hResult.rows.length > 0) {
      response.handwerkerrechnung = hResult.rows[0];
    }

    // Generische Rechnung – immer laden, unabhängig von art (ein Eintrag kann für jede art existieren)
    const gResult = await query(`SELECT * FROM generische_rechnung WHERE postid = $1`, [postid]);
    if (gResult.rows.length > 0) {
      response.generischeRechnung = gResult.rows[0];
    }

    // Zahlungslage am jeweiligen Rechnungsblock (Teilzahlungstabelle, Rest)
    const rechnungsblock = response.arztrechnung || response.handwerkerrechnung || response.generischeRechnung;
    if (rechnungsblock) {
      rechnungsblock.zahlung = berechneLage(rechnungsblock, await ladeZahlungen({ query }, postid));
      rechnungsblock.ersetzung = await ladeErsetzung({ query }, postid);
    }

    // Arztbericht
    const abResult = await query(`
      SELECT ab.*, m.ist_tier AS behandelte_person_ist_tier
      FROM arztbericht ab
      LEFT JOIN postbuch.mensch m ON m.kurzname = ab.behandelte_person
      WHERE ab.postid = $1
    `, [postid]);
    if (abResult.rows.length > 0) {
      response.arztbericht = abResult.rows[0];
    }

    // Eingeschränkter Lesebereich: keine Angaben aus verknüpften Dokumenten
    // (Erstattungsbescheide, Arztrechnungen), die anderen Personen gehören können.
    if (istEingeschraenkt(req)) {
      if (response.arztrechnung) response.arztrechnung.erstattungen = [];
      for (const ep of response.erstattungsbescheid?.einzelpositionen ?? []) {
        delete ep.arz_betreff;
        delete ep.name_arzt;
      }
    }

    res.json(response);
  } catch (err) {
    console.error('GET /api/postbuch/:postid error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// PATCH /api/postbuch/:postid — Metadaten aktualisieren
router.patch('/:postid', async (req, res) => {
  try {
    const { postid } = req.params;
    if (!POSTID_RE.test(postid)) {
      return res.status(400).json({ error: 'Ungültige PostID' });
    }

    const allowedFields = ['betreff', 'zusammenfassung', 'kontakt', 'status', 'schlagwoerter', 'notiz', 'briefdatum', 'fremdes_zeichen', 'historisch', 'familienmitglied', 'richtung', 'verbleib_id', 'original_urkunde', 'verbleib_ort', 'verbleib_ablage_id'];
    const updates = [];
    const params = [];
    let paramIdx = 1;

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        if (field === 'status') {
          updates.push(`${field} = $${paramIdx}::postbuch.post_status`);
        } else if (field === 'richtung') {
          const v = req.body[field];
          if (v !== 'eingang' && v !== 'ausgang') {
            return res.status(400).json({ error: 'richtung muss "eingang" oder "ausgang" sein' });
          }
          updates.push(`${field} = $${paramIdx}::postbuch.post_richtung`);
        } else if (field === 'schlagwoerter') {
          updates.push(`${field} = $${paramIdx}::text[]`);
        } else if (field === 'briefdatum') {
          updates.push(`${field} = $${paramIdx}::date`);
        } else if (field === 'verbleib_id') {
          const v = req.body[field];
          if (v !== null && (typeof v !== 'number' || !Number.isInteger(v))) {
            return res.status(400).json({ error: 'verbleib_id muss eine Ganzzahl oder null sein' });
          }
          updates.push(`${field} = $${paramIdx}::int`);
        } else if (field === 'original_urkunde') {
          if (typeof req.body[field] !== 'boolean') {
            return res.status(400).json({ error: 'original_urkunde muss boolean sein' });
          }
          updates.push(`${field} = $${paramIdx}::boolean`);
        } else if (field === 'verbleib_ablage_id') {
          const v = req.body[field];
          if (v !== null && (typeof v !== 'number' || !Number.isInteger(v))) {
            return res.status(400).json({ error: 'verbleib_ablage_id muss eine Ganzzahl oder null sein' });
          }
          updates.push(`${field} = $${paramIdx}::int`);
        } else if (field === 'familienmitglied') {
          // Nur ein erfasster Kurzname oder leer: der Wert bestimmt Sichtbarkeit
          // (eingeschränkter Lesebereich) und bei Personenablage den Ordner.
          const v = req.body[field];
          if (v !== null && v !== '') {
            const m = await query('SELECT 1 FROM postbuch.mensch WHERE kurzname = $1', [v]);
            if (!m.rowCount) return res.status(400).json({ error: 'familienmitglied ist kein erfasster Kurzname' });
          }
          req.body[field] = v || null;
          updates.push(`${field} = $${paramIdx}`);
        } else {
          updates.push(`${field} = $${paramIdx}`);
        }
        params.push(req.body[field]);
        paramIdx++;
      }
    }

    // Ein Aufbewahrungsort (verbleib_ablage) hängt an einer Verbleib-Kategorie
    // (verbleib_id). Ändert sich die Kategorie, ohne dass der Aufruf gleichzeitig
    // einen neuen Ort mitschickt, würde sonst ein Ort der alten Kategorie stehen
    // bleiben und ein ungültiges Ziel ergeben.
    if (req.body.verbleib_id !== undefined && req.body.verbleib_ablage_id === undefined) {
      updates.push('verbleib_ablage_id = NULL');
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'Keine aktualisierbaren Felder angegeben' });
    }

    params.push(postid);
    const result = await query(
      `UPDATE postbuch SET ${updates.join(', ')} WHERE postid = $${paramIdx} RETURNING *`,
      params
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Dokument nicht gefunden' });
    }

    res.json(result.rows[0]);
    uiLog('UPDATE', 'postbuch', postid, `fields: ${Object.keys(req.body).join(', ')}`);

    // Familienmitglied, Briefdatum und Richtung können Ablageebenen sein und
    // bestimmen dann den Ordner mit.
    const ablageFelder = Object.entries(ABLAGE_FELD_EBENE).filter(([feld]) => feld in req.body);
    if (ablageFelder.length) {
      loadDynamicSettings()
        .then((settings) => {
          const ebenen = getAblageEbenen(settings);
          return ablageFelder.some(([, ebene]) => ebenen.includes(ebene)) && verschiebeAnSollort(postid, settings);
        })
        .catch((err) => appLog('ERROR', 'ablage', `${postid}: Umzug an neuen Ablageort fehlgeschlagen: ${err.message}`,
          { entity: 'postbuch', entityId: postid }));
    }

    // Schedule debounced re-embedding for relevant field changes
    const embeddingFields = ['betreff', 'zusammenfassung', 'kontakt', 'schlagwoerter', 'briefdatum', 'fremdes_zeichen'];
    if (embeddingFields.some(f => f in req.body)) {
      schedulePostbuchEmbedding(postid);
    }
  } catch (err) {
    console.error('PATCH /api/postbuch/:postid error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// PATCH /api/postbuch/:postid/status — Status manuell ändern
router.patch('/:postid/status', async (req, res) => {
  try {
    const { postid } = req.params;
    if (!POSTID_RE.test(postid)) {
      return res.status(400).json({ error: 'Ungültige PostID' });
    }

    const { status } = req.body;
    if (!istGueltigerStatus(status)) {
      return res.status(400).json({ error: 'Ungültiger Status' });
    }

    const result = await query(
      `UPDATE postbuch SET status = $1::postbuch.post_status WHERE postid = $2 RETURNING postid, status`,
      [status, postid]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Dokument nicht gefunden' });
    }

    res.json(result.rows[0]);
    uiLog('UPDATE', 'postbuch_status', postid, `status → ${status}`);
  } catch (err) {
    console.error('PATCH /api/postbuch/:postid/status error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// POST /api/postbuch/:postid/bezahlt — Rechnung als bezahlt markieren
router.post('/:postid/bezahlt', async (req, res) => {
  try {
    const { postid } = req.params;
    if (!POSTID_RE.test(postid)) {
      return res.status(400).json({ error: 'Ungültige PostID' });
    }

    const { bezahlt_am } = req.body;
    // Allow explicit null to clear the date; only default to today if not provided at all
    const date = 'bezahlt_am' in req.body ? (bezahlt_am ?? null) : new Date().toISOString().split('T')[0];

    if (date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
      return res.status(400).json({ error: 'Ungültiges Datum' });
    }

    // Jede Zahlung wird mit Betrag geführt (service/rechnung-zahlung.js);
    // bezahlt_am_manuell = true schützt sie vor der Wiederverarbeitung.
    const lage = await inTransaktion((client) => setzeBezahltAm(client, postid, date));
    if (!lage) {
      return res.status(404).json({ error: 'Keine Rechnung für diese PostID gefunden' });
    }
    res.json({ postid, bezahlt_am: lage.bezahlt_am, zahlung: lage });
    uiLog('UPDATE', 'bezahlt', postid, `bezahlt_am → ${date ?? 'null'}`);
  } catch (err) {
    if (err instanceof ZahlungFehler) return res.status(err.status).json({ error: err.message });
    console.error('POST /api/postbuch/:postid/bezahlt error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// GET /api/postbuch/:postid/zahlungen — Zahlungen und offener Rest einer Rechnung
router.get('/:postid/zahlungen', async (req, res) => {
  try {
    const { postid } = req.params;
    if (!POSTID_RE.test(postid)) return res.status(400).json({ error: 'Ungültige PostID' });
    const lage = await ermittleZahlungslage({ query }, postid);
    if (!lage) return res.status(404).json({ error: 'Keine Rechnung für diese PostID gefunden' });
    res.json(lage);
  } catch (err) {
    console.error('GET /api/postbuch/:postid/zahlungen error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// PUT /api/postbuch/:postid/zahlungen — Teilzahlungstabelle als Ganzes ersetzen.
// Body: { zahlungen: [{ datum: 'YYYY-MM-DD', betrag: '12.34' }] }
router.put('/:postid/zahlungen', async (req, res) => {
  try {
    const { postid } = req.params;
    if (!POSTID_RE.test(postid)) return res.status(400).json({ error: 'Ungültige PostID' });
    const lage = await inTransaktion((client) => ersetzeZahlungen(client, postid, req.body?.zahlungen));
    uiLog('UPDATE', 'rechnung_zahlung', postid,
      `${lage.zahlungen.length} Zahlung(en), gezahlt ${lage.gezahlt}, offen ${lage.offen ?? '–'}`);
    res.json(lage);
  } catch (err) {
    if (err instanceof ZahlungFehler) return res.status(err.status).json({ error: err.message });
    console.error('PUT /api/postbuch/:postid/zahlungen error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// ── Ersetzung durch Korrekturrechnung (service/rechnung-ersetzung.js) ─────────
// Lesend wie schreibend nicht für eingeschränkte Leser freigegeben
// (middleware/lesebereich.js): Die Vorschläge zeigen fremde Rechnungen.

// GET /api/postbuch/:postid/ersetzung — Kanten und Kurzdaten der Rechnung
router.get('/:postid/ersetzung', async (req, res) => {
  try {
    const { postid } = req.params;
    if (!POSTID_RE.test(postid)) return res.status(400).json({ error: 'Ungültige PostID' });
    const rechnung = await ladeRechnungKurz(postid);
    if (!rechnung) return res.status(404).json({ error: 'Keine Rechnung für diese PostID gefunden' });
    res.json({ rechnung, ...(await ladeErsetzung({ query }, postid)) });
  } catch (err) {
    if (err instanceof ZahlungFehler) return res.status(err.status).json({ error: err.message });
    console.error('GET /api/postbuch/:postid/ersetzung error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// GET /api/postbuch/:postid/ersetzung/kandidaten?richtung=vorgaenger|nachfolger
router.get('/:postid/ersetzung/kandidaten', async (req, res) => {
  try {
    const { postid } = req.params;
    if (!POSTID_RE.test(postid)) return res.status(400).json({ error: 'Ungültige PostID' });
    res.json(await ermittleKandidaten(postid, String(req.query.richtung || '')));
  } catch (err) {
    if (err instanceof ZahlungFehler) return res.status(err.status).json({ error: err.message });
    console.error('GET /api/postbuch/:postid/ersetzung/kandidaten error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// POST /api/postbuch/:postid/ersetzung — Body { vorgaenger: 'P…' } (diese
// Rechnung ersetzt jene) oder { nachfolger: 'P…' } (jene ersetzt diese).
router.post('/:postid/ersetzung', async (req, res) => {
  try {
    const { postid } = req.params;
    if (!POSTID_RE.test(postid)) return res.status(400).json({ error: 'Ungültige PostID' });
    const { vorgaenger, nachfolger } = req.body || {};
    if (!!vorgaenger === !!nachfolger) {
      return res.status(400).json({ error: 'Genau eines von vorgaenger oder nachfolger angeben.' });
    }
    const paar = vorgaenger ? { neu: postid, alt: String(vorgaenger) } : { neu: String(nachfolger), alt: postid };
    const ergebnis = await inTransaktion((client) =>
      ersetzeRechnung(client, { ...paar, akteur: req.session?.username || null }));
    uiLog('UPDATE', 'rechnung_ersetzung', ergebnis.alt,
      `ersetzt durch ${ergebnis.neu}, ${ergebnis.umgezogen} Zahlung(en) umgezogen`);
    res.json(ergebnis);
  } catch (err) {
    if (err instanceof ZahlungFehler) return res.status(err.status).json({ error: err.message });
    console.error('POST /api/postbuch/:postid/ersetzung error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// DELETE /api/postbuch/:postid/ersetzung — Ersetzung der Rechnung :postid
// aufheben; die umgezogenen Zahlungen kehren zu ihr zurück.
router.delete('/:postid/ersetzung', async (req, res) => {
  try {
    const { postid } = req.params;
    if (!POSTID_RE.test(postid)) return res.status(400).json({ error: 'Ungültige PostID' });
    const ergebnis = await inTransaktion((client) => hebeErsetzungAuf(client, postid));
    uiLog('UPDATE', 'rechnung_ersetzung', postid,
      `Ersetzung durch ${ergebnis.neu} aufgehoben, ${ergebnis.zurueck} Zahlung(en) zurück`);
    res.json(ergebnis);
  } catch (err) {
    if (err instanceof ZahlungFehler) return res.status(err.status).json({ error: err.message });
    console.error('DELETE /api/postbuch/:postid/ersetzung error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// PUT /api/postbuch/:postid/bestritten — bestrittenen Anteil setzen oder anpassen.
// NULL hebt den Streitfall auf. Der Status wird bewusst aus dem Betrag abgeleitet:
// 0 = unbestritten, voller Rechnungsbetrag = vollständig bestritten.
router.put('/:postid/bestritten', async (req, res) => {
  try {
    const { postid } = req.params;
    if (!POSTID_RE.test(postid)) return res.status(400).json({ error: 'Ungültige PostID' });

    const raw = req.body?.bestritten_betrag;
    let amount = null;
    if (raw !== null && raw !== undefined && raw !== '') {
      amount = typeof raw === 'number' ? raw : Number(String(raw).replace(',', '.'));
      if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({ error: 'Der bestrittene Betrag muss größer als 0 sein.' });
      }
    }

    const invoice = await query(
      `SELECT 'arztrechnung' AS table_name, gesamtbetrag FROM arztrechnung WHERE postid = $1
       UNION ALL SELECT 'handwerkerrechnung', gesamtbetrag FROM handwerkerrechnung WHERE postid = $1
       UNION ALL SELECT 'generische_rechnung', gesamtbetrag FROM generische_rechnung WHERE postid = $1
       LIMIT 1`,
      [postid],
    );
    if (invoice.rows.length === 0) return res.status(404).json({ error: 'Keine Rechnung für diese PostID gefunden' });
    const { table_name: tableName, gesamtbetrag: totalRaw } = invoice.rows[0];
    const total = Number(totalRaw);
    if (amount !== null && (!Number.isFinite(total) || amount > total)) {
      return res.status(400).json({ error: 'Der bestrittene Betrag darf den Rechnungsbetrag nicht überschreiten.' });
    }

    // Der Zahlstatus hängt am zu zahlenden Betrag: Fällt der Bestritt weg,
    // wird eine bisherige Vollzahlung zur Teilzahlung mit offenem Rest.
    const row = await inTransaktion(async (client) => {
      await pruefeNichtErsetzt(client, postid);
      const r = await client.query(
        `UPDATE ${tableName} SET bestritten_betrag = $1 WHERE postid = $2
         RETURNING postid, gesamtbetrag, bestritten_betrag`,
        [amount, postid],
      );
      await aktualisiereZahlstatus(client, postid);
      const zahlung = await ermittleZahlungslage(client, postid);
      return { ...r.rows[0], offener_betrag: zahlung?.offen ?? null, bezahlt_am: zahlung?.bezahlt_am ?? null, zahlung };
    });
    uiLog('UPDATE', 'rechnung_bestritten', postid,
      `bestritten_betrag → ${amount === null ? 'aufgehoben' : amount}`);
    res.json({ ...row, ist_bestritten: amount !== null });
  } catch (err) {
    if (err instanceof ZahlungFehler) return res.status(err.status).json({ error: err.message });
    console.error('PUT /api/postbuch/:postid/bestritten error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// DELETE /api/postbuch/:postid — Dokument komplett löschen
router.delete('/:postid', async (req, res) => {
  let deleteClient = null;
  try {
    const { postid } = req.params;
    if (!POSTID_RE.test(postid)) {
      return res.status(400).json({ error: 'Ungültige PostID' });
    }

    const locked = await oeffneSichereDokumentloeschung(postid);
    deleteClient = locked.client;
    const doc = locked.document;

    const verschoben = await verschiebeInPapierkorb({
      postid,
      storageId: doc.storage_id,
      storageBackend: doc.storage_backend,
      betreff: doc.betreff,
    });
    if (!verschoben) {
      await deleteClient.query('ROLLBACK');
      deleteClient.release();
      deleteClient = null;
      return res.status(502).json({
        error: 'Datei konnte nicht in den Papierkorb verschoben werden. Dokument wurde nicht gelöscht.',
      });
    }
    // Ist das Dokument ein Erstattungsbescheid, zuerst seine Periodenwirkung
    // zurücknehmen: Restperioden auflösen, abgeschlossene Perioden wieder auf
    // SUBMITTED. Sonst bliebe eine Restperiode ohne ihre Ursprungsperiode stehen.
    await setzeBescheidwirkungZurueck(postid, { grund: 'bescheid-geloescht', db: deleteClient });
    await deleteClient.query('DELETE FROM postbuch.postbuch WHERE postid=$1', [postid]);
    await deleteClient.query('COMMIT');
    deleteClient.release();
    deleteClient = null;

    res.json({ success: true, postid });
    uiLog('DELETE', 'postbuch', postid, 'dokument gelöscht');
  } catch (err) {
    if (deleteClient) {
      await deleteClient.query('ROLLBACK').catch(() => {});
      deleteClient.release();
    }
    if (istLoeschschutzFehler(err)) return res.status(409).json(loeschschutzAntwort(err));
    if (err.status === 404) return res.status(404).json({ error: err.message });
    console.error('DELETE /api/postbuch/:postid error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// POST /api/postbuch/:postid/replace-pdf — PDF des Eintrags austauschen (ohne Pipeline)
//
// Body: entweder { dataB64: '<base64-PDF>' } für eine einzelne Datei
//       oder { files: [{ name, dataB64 }, ...] } für mehrere PDFs (werden gemergt).
//
// Verhalten: Verschiebt die aktuelle Ablage-Datei nach _trash, lädt das neue
// PDF mit identischem Namen in den gleichen Ordner und schreibt storage_id /
// sha256 / storage_modified / link in der DB um. Detail-Tabellen, Notizen,
// Akten-Zuordnungen und KI-Felder bleiben unverändert.
router.post('/:postid/replace-pdf', async (req, res) => {
  try {
    const { postid } = req.params;
    if (!POSTID_RE.test(postid)) {
      return res.status(400).json({ error: 'Ungültige PostID' });
    }

    let pdfBuffer;
    try {
      const body = req.body || {};
      if (Array.isArray(body.files) && body.files.length > 0) {
        if (body.files.length > 50) {
          return res.status(400).json({ error: 'Maximal 50 Dateien pro Ersetzung erlaubt' });
        }
        const buffers = body.files.map((f, i) => {
          try {
            return decodeBase64Pdf(f?.dataB64);
          } catch (e) {
            const wrapped = new Error(`Datei ${i + 1} (${f?.name || '?'}): ${e.message}`);
            wrapped.statusCode = 400;
            throw wrapped;
          }
        });
        pdfBuffer = await mergePdfs(buffers);
      } else if (body.dataB64) {
        pdfBuffer = decodeBase64Pdf(body.dataB64);
      } else {
        return res.status(400).json({ error: 'dataB64 oder files (Array) erforderlich' });
      }
    } catch (decodeErr) {
      return res.status(decodeErr.statusCode || 400).json({ error: decodeErr.message });
    }

    const result = await replacePdf(postid, pdfBuffer);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('POST /api/postbuch/:postid/replace-pdf error:', err);
    appLog('ERROR', 'postbuch',
      `Replace-PDF fehlgeschlagen für ${req.params.postid}: ${err.message}`,
      { entity: 'postbuch', entityId: req.params.postid }
    );
    res.status(err.statusCode || 500).json({ error: err.message || 'Interner Serverfehler' });
  }
});

// POST /api/postbuch/:postid/replace-pdf/restore — Undo / Redo eines Austauschs.
//
// Tauscht zwei OneDrive-Dateien wieder zurück (symmetrisch, also auch für Redo
// nutzbar). Body siehe restorePdf().
router.post('/:postid/replace-pdf/restore', async (req, res) => {
  try {
    const { postid } = req.params;
    if (!POSTID_RE.test(postid)) {
      return res.status(400).json({ error: 'Ungültige PostID' });
    }

    const {
      activeOnedriveId, restoreOnedriveId, parentId, filename,
      restoreSha256, restoreOnedriveModified,
    } = req.body || {};

    await restorePdf(postid, {
      activeOnedriveId, restoreOnedriveId, parentId, filename,
      restoreSha256, restoreOnedriveModified,
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/postbuch/:postid/replace-pdf/restore error:', err);
    appLog('ERROR', 'postbuch',
      `Replace-PDF-Restore fehlgeschlagen für ${req.params.postid}: ${err.message}`,
      { entity: 'postbuch', entityId: req.params.postid }
    );
    res.status(err.statusCode || 500).json({ error: err.message || 'Interner Serverfehler' });
  }
});

// POST /api/postbuch/:postid/qr-scan — QR-Codes für ein Bestandsdokument nachrüsten.
//
// Kein Massen-Backfill (Plan: internaldocs/FEATURE_RECHNUNGSTEILE_UND_QRCODES.md
// Abschnitt 4.5) — fährt die Scan-Kette einmalig für genau ein Dokument und
// setzt qr_codes. Schreibend, also automatisch für lesezugriff gesperrt.
router.post('/:postid/qr-scan', async (req, res) => {
  try {
    const { postid } = req.params;
    if (!POSTID_RE.test(postid)) {
      return res.status(400).json({ error: 'Ungültige PostID' });
    }

    const { pdf } = await retrieveDocument(postid);
    const qrCodes = await scanQrCodes(pdf);

    const result = await query(
      `UPDATE postbuch SET qr_codes = $1::jsonb WHERE postid = $2 RETURNING qr_codes`,
      [JSON.stringify(qrCodes), postid]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Dokument nicht gefunden' });
    }

    res.json({ ok: true, qr_codes: result.rows[0].qr_codes });
    uiLog('UPDATE', 'postbuch', postid, `qr-scan: ${qrCodes.length} Code(s) gefunden`);
  } catch (err) {
    console.error('POST /api/postbuch/:postid/qr-scan error:', err);
    appLog('ERROR', 'postbuch',
      `QR-Scan fehlgeschlagen für ${req.params.postid}: ${err.message}`,
      { entity: 'postbuch', entityId: req.params.postid }
    );
    res.status(err.statusCode || 500).json({ error: err.message || 'Interner Serverfehler' });
  }
});

// PATCH /api/postbuch/:postid/arztrechnung/satz
// Setzt oder löscht rechnungsspezifische Erstattungssätze (Override der Personenconfig).
// Body: { pkv_satz_override: number|null, beihilfe_satz_override: number|null }
router.patch('/:postid/arztrechnung/satz', async (req, res) => {
  try {
    const { postid } = req.params;
    if (!POSTID_RE.test(postid)) {
      return res.status(400).json({ error: 'Ungültige PostID' });
    }

    const body = req.body || {};
    const fields = {};

    if ('pkv_satz_override' in body) {
      const v = body.pkv_satz_override;
      if (v !== null) {
        const n = parseFloat(v);
        if (isNaN(n) || n < 0 || n > 100) {
          return res.status(400).json({ error: 'pkv_satz_override muss zwischen 0 und 100 liegen' });
        }
        fields.pkv_satz_override = n;
      } else {
        fields.pkv_satz_override = null;
      }
    }

    if ('beihilfe_satz_override' in body) {
      const v = body.beihilfe_satz_override;
      if (v !== null) {
        const n = parseFloat(v);
        if (isNaN(n) || n < 0 || n > 100) {
          return res.status(400).json({ error: 'beihilfe_satz_override muss zwischen 0 und 100 liegen' });
        }
        fields.beihilfe_satz_override = n;
      } else {
        fields.beihilfe_satz_override = null;
      }
    }

    if (Object.keys(fields).length === 0) {
      return res.status(400).json({ error: 'Keine Felder zum Aktualisieren angegeben' });
    }

    const setClauses = Object.keys(fields).map((k, i) => `${k} = $${i + 2}`).join(', ');
    const values = [postid, ...Object.values(fields)];

    const result = await query(
      `UPDATE postbuch.arztrechnung SET ${setClauses} WHERE postid = $1 RETURNING postid`,
      values
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Arztrechnung nicht gefunden' });
    }

    uiLog('UPDATE', 'arztrechnung_satz', postid,
      Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(', '));
    res.json({ ok: true });
  } catch (err) {
    console.error('PATCH /api/postbuch/:postid/arztrechnung/satz error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// PATCH /api/postbuch/:postid/arztrechnung/abrechnungsperiode
// Ordnet die Arztrechnung einer COLLECTING-Periode zu oder löst die Zuordnung.
// Body: { kostentraeger: 'PKV'|'Beihilfe', periode: number|null }
router.patch('/:postid/arztrechnung/abrechnungsperiode', async (req, res) => {
  try {
    const { postid } = req.params;
    if (!POSTID_RE.test(postid)) {
      return res.status(400).json({ error: 'Ungültige PostID' });
    }

    const { kostentraeger, periode } = req.body;
    if (!['PKV', 'Beihilfe'].includes(kostentraeger)) {
      return res.status(400).json({ error: 'Ungültiger Kostenträger (PKV oder Beihilfe erwartet)' });
    }
    if (periode !== null && (typeof periode !== 'number' || !Number.isFinite(periode) || !Number.isInteger(periode))) {
      return res.status(400).json({ error: 'Ungültige Periodenummer' });
    }

    const col = kostentraeger === 'PKV' ? 'abrechnungsperiode_pkv' : 'abrechnungsperiode_beihilfe';
    const antwort = (status, body) => ({ status, body });

    // Prüfen und Schreiben in einer Transaktion unter der Periodensperre der
    // Person: Sonst könnte zwischen Statusprüfung und UPDATE eine Einreichung
    // oder ein Bescheidabschluss die Periode verlassen (siehe
    // service/perioden-sperre.js) und die Rechnung in einer bereits
    // eingereichten Periode landen.
    const ergebnis = await (async () => {
      const client = await getClient();
      try {
        await client.query('BEGIN');
        const vorab = await client.query(
          `SELECT behandelte_person FROM arztrechnung WHERE postid = $1`, [postid]
        );
        if (vorab.rows.length === 0) {
          await client.query('ROLLBACK');
          return antwort(404, { error: 'Arztrechnung nicht gefunden' });
        }
        await sperrePerioden(client, [{ person: vorab.rows[0].behandelte_person, kostentraeger }]);

        // Aktuelle Arztrechnung nach der Sperre gesperrt laden
        const arzResult = await client.query(
          `SELECT a.behandelte_person, m.ist_tier, m.pkv, m.beihilfe, ${col} AS current_periode
           FROM arztrechnung a
           LEFT JOIN postbuch.mensch m ON m.kurzname = a.behandelte_person
           WHERE a.postid = $1
           FOR UPDATE OF a`,
          [postid]
        );
        if (arzResult.rows.length === 0) {
          await client.query('ROLLBACK');
          return antwort(404, { error: 'Arztrechnung nicht gefunden' });
        }
        const { behandelte_person: person, current_periode: currentPeriode } = arzResult.rows[0];
        if (person !== vorab.rows[0].behandelte_person) {
          await client.query('ROLLBACK');
          return antwort(409, { error: 'Die behandelte Person der Rechnung wurde gerade geändert. Bitte erneut versuchen.' });
        }
        if (arzResult.rows[0].ist_tier && kostentraeger === 'Beihilfe') {
          await client.query('ROLLBACK');
          return antwort(400, { error: 'Für Tiere ist keine Beihilfe-Abrechnungsperiode zulässig.' });
        }
        // Behandelt werden kann jeder erfasste Mensch und jedes Tier; eine
        // Abrechnungsperiode gibt es nur beim passenden Versicherungsschutz.
        // Lösen bleibt immer möglich (etwa nach Wechsel der behandelten Person).
        const versichert = kostentraeger === 'PKV' ? arzResult.rows[0].pkv : arzResult.rows[0].beihilfe;
        if (periode !== null && !versichert) {
          await client.query('ROLLBACK');
          return antwort(400, {
            error: person
              ? `${person} ist nicht ${kostentraeger === 'PKV' ? 'PKV-versichert' : 'beihilfeberechtigt'} – keine Abrechnungsperiode möglich.`
              : 'Ohne behandelte Person ist keine Abrechnungsperiode möglich.',
          });
        }

        if (periode === null) {
          // Zuordnung lösen — nur wenn aktuelle Periode noch COLLECTING ist
          if (currentPeriode === null) {
            await client.query('ROLLBACK');
            return antwort(400, { error: 'Keine Abrechnungsperiode zugeordnet' });
          }
          const apResult = await client.query(
            `SELECT status FROM abrechnungsperiode_buch WHERE person = $1 AND kostentraeger = $2 AND periode = $3 FOR SHARE`,
            [person, kostentraeger, currentPeriode]
          );
          if (apResult.rows.length === 0 || apResult.rows[0].status !== 'COLLECTING') {
            await client.query('ROLLBACK');
            return antwort(409, { error: 'Abrechnungsperiode ist nicht mehr im Status SAMMELT' });
          }
          await client.query(`UPDATE arztrechnung SET ${col} = NULL WHERE postid = $1`, [postid]);
          await client.query('COMMIT');
          uiLog('UPDATE', 'arztrechnung_ap', postid, `${col} gelöst (war ${currentPeriode})`);
        } else {
          // Eine ersetzte Rechnung fordert nichts mehr und gehört in keine Periode.
          const ersetzt = await client.query(
            `SELECT von_postid FROM postbuch.dokument_beziehung WHERE zu_postid = $1 AND art = 'ersetzt'`,
            [postid]
          );
          if (ersetzt.rows[0]) {
            await client.query('ROLLBACK');
            return antwort(409, { error: `Diese Rechnung ist durch ${ersetzt.rows[0].von_postid} ersetzt und kann keiner Abrechnungsperiode zugeordnet werden.` });
          }
          // Zuordnen — nur wenn Zielperiode COLLECTING ist
          const apResult = await client.query(
            `SELECT status FROM abrechnungsperiode_buch WHERE person = $1 AND kostentraeger = $2 AND periode = $3 FOR SHARE`,
            [person, kostentraeger, periode]
          );
          if (apResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return antwort(404, { error: 'Abrechnungsperiode nicht gefunden' });
          }
          if (apResult.rows[0].status !== 'COLLECTING') {
            await client.query('ROLLBACK');
            return antwort(409, { error: 'Abrechnungsperiode ist nicht im Status SAMMELT' });
          }
          await client.query(`UPDATE arztrechnung SET ${col} = $1 WHERE postid = $2`, [periode, postid]);
          await client.query('COMMIT');
          uiLog('UPDATE', 'arztrechnung_ap', postid, `${col} → ${periode}`);
        }
        return antwort(200, { ok: true });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    })();

    res.status(ergebnis.status).json(ergebnis.body);
  } catch (err) {
    console.error('PATCH /api/postbuch/:postid/arztrechnung/abrechnungsperiode error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// PATCH /api/postbuch/:postid/handwerkerrechnung
// Aktualisiert die Felder einer Handwerkerrechnung (alle außer postid und bezahlt_am)
// sowie den vom Nutzer gesetzten § 35a-Ausschluss (estg35a_irrelevant).
// Leere Strings werden als NULL gespeichert.
router.patch('/:postid/handwerkerrechnung', async (req, res) => {
  try {
    const { postid } = req.params;
    if (!POSTID_RE.test(postid)) {
      return res.status(400).json({ error: 'Ungültige PostID' });
    }

    const textFields    = ['re_nr', 'leistungsdatum', 'name_unternehmen', 'leistung', 'iban', 'verwendungszweck'];
    const dateFields    = ['rechnungsdatum', 'faelligkeit'];
    const numericFields = ['gesamtbetrag', 'lohnkosten'];
    const integerFields = ['leistungsjahr'];
    const booleanFields = ['estg35a_irrelevant'];

    const updates = [];
    const params  = [];
    let paramIdx  = 1;

    const normalizeText = (v) => {
      if (v === null || v === undefined) return null;
      const s = String(v).trim();
      return s === '' ? null : s;
    };

    for (const f of textFields) {
      if (f in req.body) {
        updates.push(`${f} = $${paramIdx}`);
        params.push(normalizeText(req.body[f]));
        paramIdx++;
      }
    }
    for (const f of dateFields) {
      if (f in req.body) {
        const v = normalizeText(req.body[f]);
        updates.push(`${f} = $${paramIdx}::date`);
        params.push(v);
        paramIdx++;
      }
    }
    for (const f of numericFields) {
      if (f in req.body) {
        const raw = req.body[f];
        let val = null;
        if (raw !== null && raw !== undefined && raw !== '') {
          const n = typeof raw === 'number' ? raw : parseFloat(String(raw).replace(',', '.'));
          if (!Number.isFinite(n)) {
            return res.status(400).json({ error: `Ungültiger Wert für ${f}` });
          }
          val = n;
        }
        updates.push(`${f} = $${paramIdx}`);
        params.push(val);
        paramIdx++;
      }
    }
    for (const f of integerFields) {
      if (f in req.body) {
        const raw = req.body[f];
        let val = null;
        if (raw !== null && raw !== undefined && raw !== '') {
          const n = typeof raw === 'number' ? raw : parseFloat(String(raw).replace(',', '.'));
          if (!Number.isInteger(n) || n < 1900 || n > 2100) {
            return res.status(400).json({ error: `Ungültiger Wert für ${f}` });
          }
          val = n;
        }
        updates.push(`${f} = $${paramIdx}`);
        params.push(val);
        paramIdx++;
      }
    }

    // Nur der Nutzer setzt den § 35a-Ausschluss; null (Rückgängig) heißt false.
    for (const f of booleanFields) {
      if (f in req.body) {
        const raw = req.body[f];
        if (raw !== null && typeof raw !== 'boolean') {
          return res.status(400).json({ error: `Ungültiger Wert für ${f}` });
        }
        updates.push(`${f} = $${paramIdx}`);
        params.push(raw === true);
        paramIdx++;
      }
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'Keine aktualisierbaren Felder angegeben' });
    }

    params.push(postid);
    // Ein geänderter Rechnungsbetrag verschiebt den offenen Rest; der
    // Zahlstatus wird in derselben Transaktion neu abgeleitet.
    const result = await inTransaktion(async (client) => {
      const r = await client.query(
        `UPDATE postbuch.handwerkerrechnung SET ${updates.join(', ')} WHERE postid = $${paramIdx} RETURNING *`,
        params
      );
      if (r.rows.length === 0 || !('gesamtbetrag' in req.body)) return r;
      await gleicheZahlungenAn(client, postid);
      return client.query(`SELECT * FROM postbuch.handwerkerrechnung WHERE postid = $1`, [postid]);
    });

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Handwerkerrechnung nicht gefunden' });
    }

    res.json(result.rows[0]);
    uiLog('UPDATE', 'handwerkerrechnung', postid,
      `fields: ${Object.keys(req.body).filter(k => [...textFields, ...dateFields, ...numericFields, ...integerFields, ...booleanFields].includes(k)).join(', ')}`);
  } catch (err) {
    if (err instanceof ZahlungFehler) return res.status(err.status).json({ error: err.message });
    console.error('PATCH /api/postbuch/:postid/handwerkerrechnung error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// ── PATCH /:postid/arztrechnung ──────────────────────────────────────────────
router.patch('/:postid/arztrechnung', async (req, res) => {
  try {
    const { postid } = req.params;
    if (!POSTID_RE.test(postid)) {
      return res.status(400).json({ error: 'Ungültige PostID' });
    }

    // typ ist bewusst NICHT freitext-editierbar: es ist Spiegelfeld von
    // postbuch.dokumentart und wird ausschließlich über den L×D-Wechsel
    // (routes/actions.js change-type → type-change.js) synchron gehalten.
    const textFields    = ['re_nr', 'name_arzt', 'behandelte_person', 'iban', 'verwendungszweck', 'leistung', 'kontoinhaber'];
    const dateFields    = ['rechnungsdatum', 'faelligkeit'];
    const numericFields = ['gesamtbetrag'];

    const updates = [];
    const params  = [];
    let paramIdx  = 1;

    const normalizeText = (v) => {
      if (v === null || v === undefined) return null;
      const s = String(v).trim();
      return s === '' ? null : s;
    };

    // Behandelte Person: jeder erfasste Mensch oder jedes Tier, unabhängig
    // von einer Versicherung – oder leer.
    if ('behandelte_person' in req.body) {
      const v = normalizeText(req.body.behandelte_person);
      if (v !== null) {
        const m = await query('SELECT 1 FROM postbuch.mensch WHERE kurzname = $1', [v]);
        if (!m.rowCount) return res.status(400).json({ error: 'behandelte_person ist kein erfasster Kurzname' });
      }
    }

    for (const f of textFields) {
      if (f in req.body) {
        updates.push(`${f} = $${paramIdx}`);
        params.push(normalizeText(req.body[f]));
        paramIdx++;
      }
    }
    for (const f of dateFields) {
      if (f in req.body) {
        const v = normalizeText(req.body[f]);
        updates.push(`${f} = $${paramIdx}::date`);
        params.push(v);
        paramIdx++;
      }
    }
    for (const f of numericFields) {
      if (f in req.body) {
        const raw = req.body[f];
        let val = null;
        if (raw !== null && raw !== undefined && raw !== '') {
          const n = typeof raw === 'number' ? raw : parseFloat(String(raw).replace(',', '.'));
          if (!Number.isFinite(n)) {
            return res.status(400).json({ error: `Ungültiger Wert für ${f}` });
          }
          val = n;
        }
        updates.push(`${f} = $${paramIdx}`);
        params.push(val);
        paramIdx++;
      }
    }

    // Einreichungsseiten: zwei Ganzzahlfelder statt eines "von-bis"-Strings
    // (Parserproblemen aus dem Weg gegangen). Werden nur gemeinsam gesendet
    // (siehe ArztrechnungDetail.jsx) — beide oder keines im Body.
    if ('einreichung_seite_von' in req.body || 'einreichung_seite_bis' in req.body) {
      if (!('einreichung_seite_von' in req.body) || !('einreichung_seite_bis' in req.body)) {
        return res.status(400).json({ error: 'einreichung_seite_von und einreichung_seite_bis müssen gemeinsam gesendet werden' });
      }
      const parseSeite = (raw) => {
        if (raw === null || raw === undefined || raw === '') return null;
        const n = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
        return Number.isInteger(n) ? n : NaN;
      };
      const von = parseSeite(req.body.einreichung_seite_von);
      const bis = parseSeite(req.body.einreichung_seite_bis);
      const beideNull = von === null && bis === null;
      const beideGueltig = Number.isInteger(von) && Number.isInteger(bis) && von >= 1 && bis >= von;
      if (!beideNull && !beideGueltig) {
        return res.status(400).json({ error: 'Ungültiger Einreichungsseiten-Bereich' });
      }
      updates.push(`einreichung_seite_von = $${paramIdx}`);
      params.push(von);
      paramIdx++;
      updates.push(`einreichung_seite_bis = $${paramIdx}`);
      params.push(bis);
      paramIdx++;
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'Keine aktualisierbaren Felder angegeben' });
    }

    params.push(postid);
    // Ein geänderter Rechnungsbetrag verschiebt den offenen Rest; der
    // Zahlstatus wird in derselben Transaktion neu abgeleitet.
    const result = await inTransaktion(async (client) => {
      const r = await client.query(
        `UPDATE postbuch.arztrechnung SET ${updates.join(', ')} WHERE postid = $${paramIdx} RETURNING *`,
        params
      );
      if (r.rows.length === 0 || !('gesamtbetrag' in req.body)) return r;
      await gleicheZahlungenAn(client, postid);
      return client.query(`SELECT * FROM postbuch.arztrechnung WHERE postid = $1`, [postid]);
    });

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Arztrechnung nicht gefunden' });
    }

    res.json(result.rows[0]);
    if ('behandelte_person' in req.body) zieheNachBehandelterPerson(postid);
    uiLog('UPDATE', 'arztrechnung', postid,
      `fields: ${Object.keys(req.body).filter(k => [...textFields, ...dateFields, ...numericFields, 'einreichung_seite_von', 'einreichung_seite_bis'].includes(k)).join(', ')}`);
  } catch (err) {
    if (err instanceof ZahlungFehler) return res.status(err.status).json({ error: err.message });
    console.error('PATCH /api/postbuch/:postid/arztrechnung error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// ── Einzelpositionen einer Arztrechnung manuell pflegen ──────────────────────
// Die Differenzposition (ist_differenz) pflegt ausschließlich der DB-Trigger
// fn_arz_differenz_abgleichen beim Commit; sie ist hier weder bearbeit- noch
// löschbar. Neue Positionen erhalten die nächste freie subid, bestehende
// subids werden nie umnummeriert (Kürzungen und SymLinks verweisen darauf).

const POSITION_TEXT_FELDER = ['goa_goz_gebueh_pzn', 'leistung', 'begruendung'];

// Liefert { felder } oder { error }. Nur im Body vorhandene Felder werden übernommen.
function parsePositionFelder(body) {
  const felder = {};
  for (const f of POSITION_TEXT_FELDER) {
    if (!(f in body)) continue;
    const v = body[f];
    const s = v === null || v === undefined ? '' : String(v).trim();
    if (s.length > 2000) return { error: `${f} ist zu lang` };
    felder[f] = s === '' ? null : s;
  }
  if ('behandlungs_datum' in body) {
    const v = body.behandlungs_datum;
    if (v === null || v === undefined || v === '') felder.behandlungs_datum = null;
    else if (/^\d{4}-\d{2}-\d{2}$/.test(String(v)) && !isNaN(Date.parse(String(v)))) felder.behandlungs_datum = String(v);
    else return { error: 'Ungültiges Behandlungsdatum' };
  }
  const zahl = (raw) => {
    if (raw === null || raw === undefined || raw === '') return null;
    const n = typeof raw === 'number' ? raw : parseFloat(String(raw).replace(',', '.'));
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
  };
  if ('faktor' in body) {
    const n = zahl(body.faktor);
    if (Number.isNaN(n) || (n !== null && (n <= 0 || n >= 1000))) return { error: 'Ungültiger Faktor' };
    felder.faktor = n;
  }
  if ('betrag' in body) {
    const n = zahl(body.betrag);
    if (n === null || Number.isNaN(n) || Math.abs(n) >= 1e10) return { error: 'Ungültiger Betrag' };
    felder.betrag = n;
  }
  return { felder };
}

async function ladePositionen(postid) {
  const r = await query(
    `SELECT * FROM arztrechnung_einzelposition WHERE postid = $1 ORDER BY subid`,
    [postid]
  );
  return r.rows;
}

// Sperrt den Rechnungskopf; liefert false, wenn es keine Arztrechnung gibt.
async function sperreArztrechnung(client, postid) {
  const r = await client.query(`SELECT 1 FROM arztrechnung WHERE postid = $1 FOR UPDATE`, [postid]);
  return r.rows.length > 0;
}

// POST /:postid/arztrechnung/positionen — neue Position anhängen
router.post('/:postid/arztrechnung/positionen', async (req, res) => {
  const { postid } = req.params;
  if (!POSTID_RE.test(postid)) return res.status(400).json({ error: 'Ungültige PostID' });
  const { felder, error } = parsePositionFelder(req.body || {});
  if (error) return res.status(400).json({ error });
  if (felder.betrag === undefined) return res.status(400).json({ error: 'Betrag fehlt' });

  const client = await getClient();
  try {
    await client.query('BEGIN');
    if (!(await sperreArztrechnung(client, postid))) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Arztrechnung nicht gefunden' });
    }
    const spalten = Object.keys(felder);
    const naechste = await client.query(
      `SELECT COALESCE(MAX(subid), 0) + 1 AS subid FROM arztrechnung_einzelposition WHERE postid = $1`,
      [postid]
    );
    const subid = naechste.rows[0].subid;
    await client.query(
      `INSERT INTO arztrechnung_einzelposition (postid, subid, ${spalten.join(', ')})
       VALUES ($1, $2, ${spalten.map((_, i) => `$${i + 3}`).join(', ')})`,
      [postid, subid, ...spalten.map(k => felder[k])]
    );
    await client.query('COMMIT');
    uiLog('CREATE', 'arztrechnung_position', postid, `subid=${subid}, betrag=${felder.betrag}`);
    res.status(201).json({ subid, einzelpositionen: await ladePositionen(postid) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /api/postbuch/:postid/arztrechnung/positionen error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  } finally {
    client.release();
  }
});

// PATCH /:postid/arztrechnung/positionen/:subid — Position ändern
router.patch('/:postid/arztrechnung/positionen/:subid', async (req, res) => {
  const { postid, subid } = req.params;
  if (!POSTID_RE.test(postid) || !SUBID_RE.test(subid)) return res.status(400).json({ error: 'Ungültige Position' });
  const { felder, error } = parsePositionFelder(req.body || {});
  if (error) return res.status(400).json({ error });
  const spalten = Object.keys(felder);
  if (spalten.length === 0) return res.status(400).json({ error: 'Keine aktualisierbaren Felder angegeben' });

  const client = await getClient();
  try {
    await client.query('BEGIN');
    await sperreArztrechnung(client, postid);
    const pos = await client.query(
      `SELECT ist_differenz FROM arztrechnung_einzelposition WHERE postid = $1 AND subid = $2 FOR UPDATE`,
      [postid, Number(subid)]
    );
    if (pos.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Position nicht gefunden' });
    }
    if (pos.rows[0].ist_differenz) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Der automatisch ermittelte Differenzbetrag wird selbst berechnet und kann nicht bearbeitet werden.' });
    }
    await client.query(
      `UPDATE arztrechnung_einzelposition SET ${spalten.map((k, i) => `${k} = $${i + 3}`).join(', ')}
        WHERE postid = $1 AND subid = $2`,
      [postid, Number(subid), ...spalten.map(k => felder[k])]
    );
    await client.query('COMMIT');
    uiLog('UPDATE', 'arztrechnung_position', postid, `subid=${subid}, fields: ${spalten.join(', ')}`);
    res.json({ einzelpositionen: await ladePositionen(postid) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('PATCH /api/postbuch/:postid/arztrechnung/positionen/:subid error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  } finally {
    client.release();
  }
});

// DELETE /:postid/arztrechnung/positionen/:subid — nur ohne verknüpfte Kürzung
router.delete('/:postid/arztrechnung/positionen/:subid', async (req, res) => {
  const { postid, subid } = req.params;
  if (!POSTID_RE.test(postid) || !SUBID_RE.test(subid)) return res.status(400).json({ error: 'Ungültige Position' });

  const client = await getClient();
  try {
    await client.query('BEGIN');
    await sperreArztrechnung(client, postid);
    const pos = await client.query(
      `SELECT ist_differenz FROM arztrechnung_einzelposition WHERE postid = $1 AND subid = $2 FOR UPDATE`,
      [postid, Number(subid)]
    );
    if (pos.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Position nicht gefunden' });
    }
    if (pos.rows[0].ist_differenz) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Der automatisch ermittelte Differenzbetrag verschwindet von selbst, sobald die Positionen den Rechnungsbetrag ergeben.' });
    }
    const kuerzungen = await client.query(
      `SELECT DISTINCT postid FROM erstattungsbescheid_kuerzung
        WHERE arz_postid = $1 AND arz_subid = $2 ORDER BY postid`,
      [postid, Number(subid)]
    );
    if (kuerzungen.rows.length > 0) {
      await client.query('ROLLBACK');
      const ebs = kuerzungen.rows.map(r => r.postid).join(', ');
      return res.status(409).json({ error: `Position ${subid} ist mit einer Kürzung aus ${ebs} verknüpft und kann nicht gelöscht werden. Bitte zuerst die Kürzungszuordnung im Erstattungsbescheid lösen.` });
    }
    await client.query(`DELETE FROM arztrechnung_einzelposition WHERE postid = $1 AND subid = $2`, [postid, Number(subid)]);
    await client.query('COMMIT');
    uiLog('DELETE', 'arztrechnung_position', postid, `subid=${subid}`);
    res.json({ einzelpositionen: await ladePositionen(postid) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err?.code === '23503') {
      return res.status(409).json({ error: 'Position ist mit einem Erstattungsbescheid verknüpft und kann nicht gelöscht werden.' });
    }
    console.error('DELETE /api/postbuch/:postid/arztrechnung/positionen/:subid error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  } finally {
    client.release();
  }
});

// ── Manuelle Erstattungs-Zuordnungen (EBP↔Arztrechnung, Kürzung↔Einzelposition) ──
// :postid = Erstattungsbescheid, :subid = Position auf dem Bescheid (EBP).

// Hilfsfunktion: Service-Fehler mit .status sauber als HTTP-Antwort ausgeben.
function sendServiceError(res, err, context) {
  if (err && err.status) {
    return res.status(err.status).json({ error: err.message });
  }
  console.error(`${context} error:`, err);
  return res.status(500).json({ error: 'Interner Serverfehler' });
}

const SUBID_RE = /^\d+$/;

// Extrahiert aus einem SymLink-Token die Postnummer (akzeptiert 'P######' und 'P######-N').
function parsePostidToken(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (s === '') return null;
  const m = s.match(/^(P\d{6})(?:-\d+)?$/);
  return m ? m[1] : undefined; // undefined = ungültiges Format
}

// Normalisiert eine Positions-Zuordnung (arz_subid). Akzeptiert eine Ganzzahl, 'N'
// oder ein Positions-Token 'P######-N'. Rückgabe:
//   null       → Positions-Link lösen (kein Wert)
//   undefined  → ungültiges Format
//   { subid, postid } → subid (Zahl) + optionale Rechnungs-Postnummer aus dem Token
function parseArzSubid(raw) {
  if (raw == null || String(raw).trim() === '') return null;
  const s = String(raw).trim();
  const tok = s.match(/^(P\d{6})-(\d+)$/);
  if (tok) return { subid: Number(tok[2]), postid: tok[1] };
  if (/^\d+$/.test(s)) return { subid: Number(s), postid: null };
  return undefined;
}

// PATCH /:postid/erstattung/:subid/zuordnung — EBP einer (ganzen) Arztrechnung zuordnen/lösen
router.patch('/:postid/erstattung/:subid/zuordnung', async (req, res) => {
  try {
    const { postid, subid } = req.params;
    if (!POSTID_RE.test(postid)) return res.status(400).json({ error: 'Ungültige PostID' });
    if (!SUBID_RE.test(subid)) return res.status(400).json({ error: 'Ungültige Positionsnummer' });

    let arzPostid = null;
    if (req.body.arz_postid != null && String(req.body.arz_postid).trim() !== '') {
      arzPostid = parsePostidToken(req.body.arz_postid);
      if (arzPostid === undefined) return res.status(400).json({ error: 'Ungültiges Rechnungs-Token' });
    }

    let restoreKuerzungenArzSubid = null;
    if (Array.isArray(req.body.restore_kuerzungen_arz_subid)) {
      restoreKuerzungenArzSubid = req.body.restore_kuerzungen_arz_subid
        .filter(r => r && Number.isInteger(r.kuerzung_id))
        .map(r => ({ kuerzung_id: r.kuerzung_id, arz_subid: r.arz_subid != null ? Number(r.arz_subid) : null }));
    }

    const result = await setEbpZuordnung(postid, Number(subid), arzPostid, restoreKuerzungenArzSubid);
    res.json(result);
  } catch (err) {
    sendServiceError(res, err, 'PATCH /api/postbuch/:postid/erstattung/:subid/zuordnung');
  }
});

// POST /:postid/erstattung/:subid/kuerzung — neue Kürzung unter einer EBP anlegen
router.post('/:postid/erstattung/:subid/kuerzung', async (req, res) => {
  try {
    const { postid, subid } = req.params;
    if (!POSTID_RE.test(postid)) return res.status(400).json({ error: 'Ungültige PostID' });
    if (!SUBID_RE.test(subid)) return res.status(400).json({ error: 'Ungültige Positionsnummer' });

    const parsedSub = parseArzSubid(req.body.arz_subid);
    if (parsedSub === undefined) return res.status(400).json({ error: 'Ungültige Positions-Zuordnung' });

    const result = await addKuerzung(postid, Number(subid), {
      kuerzungsbetrag: req.body.kuerzungsbetrag,
      begruendung: req.body.begruendung,
      arzSubid: parsedSub ? parsedSub.subid : null,
      arzPostidHint: parsedSub ? parsedSub.postid : null,
    });
    res.status(201).json(result);
  } catch (err) {
    sendServiceError(res, err, 'POST /api/postbuch/:postid/erstattung/:subid/kuerzung');
  }
});

// PATCH /:postid/kuerzung/:kuerzungId — Kürzung ändern (Betrag/Begründung/Positions-Link)
router.patch('/:postid/kuerzung/:kuerzungId', async (req, res) => {
  try {
    const { postid, kuerzungId } = req.params;
    if (!POSTID_RE.test(postid)) return res.status(400).json({ error: 'Ungültige PostID' });
    if (!SUBID_RE.test(kuerzungId)) return res.status(400).json({ error: 'Ungültige Kürzungs-ID' });

    const fields = {};
    if ('kuerzungsbetrag' in req.body) fields.kuerzungsbetrag = req.body.kuerzungsbetrag;
    if ('begruendung' in req.body) fields.begruendung = req.body.begruendung;
    if ('arz_subid' in req.body) {
      const parsedSub = parseArzSubid(req.body.arz_subid);
      if (parsedSub === undefined) return res.status(400).json({ error: 'Ungültige Positions-Zuordnung' });
      fields.arzSubid = parsedSub ? parsedSub.subid : null;
      fields.arzPostidHint = parsedSub ? parsedSub.postid : null;
    }
    if (Object.keys(fields).length === 0) {
      return res.status(400).json({ error: 'Keine aktualisierbaren Felder angegeben' });
    }

    const result = await updateKuerzung(postid, Number(kuerzungId), fields);
    res.json(result);
  } catch (err) {
    sendServiceError(res, err, 'PATCH /api/postbuch/:postid/kuerzung/:kuerzungId');
  }
});

// DELETE /:postid/kuerzung/:kuerzungId — Kürzung löschen (z. B. fälschlich erkannt)
router.delete('/:postid/kuerzung/:kuerzungId', async (req, res) => {
  try {
    const { postid, kuerzungId } = req.params;
    if (!POSTID_RE.test(postid)) return res.status(400).json({ error: 'Ungültige PostID' });
    if (!SUBID_RE.test(kuerzungId)) return res.status(400).json({ error: 'Ungültige Kürzungs-ID' });

    const result = await deleteKuerzung(postid, Number(kuerzungId));
    res.json(result);
  } catch (err) {
    sendServiceError(res, err, 'DELETE /api/postbuch/:postid/kuerzung/:kuerzungId');
  }
});

// PATCH /:postid/kuerzung/:kuerzungId/gesehen — Kürzung gesehen setzen/zurücknehmen (instanzweit)
router.patch('/:postid/kuerzung/:kuerzungId/gesehen', async (req, res) => {
  try {
    const { postid, kuerzungId } = req.params;
    if (!POSTID_RE.test(postid)) return res.status(400).json({ error: 'Ungültige PostID' });
    if (!SUBID_RE.test(kuerzungId)) return res.status(400).json({ error: 'Ungültige Kürzungs-ID' });
    const ebSubid = Number(req.body.eb_subid);
    if (!Number.isInteger(ebSubid)) return res.status(400).json({ error: 'eb_subid fehlt oder ungültig' });

    const result = await setGesehen(
      postid, ebSubid, Number(kuerzungId), !!req.body.gesehen, req.session?.username || null
    );
    res.json(result);
  } catch (err) {
    sendServiceError(res, err, 'PATCH /api/postbuch/:postid/kuerzung/:kuerzungId/gesehen');
  }
});

// PUT /:postid/kuerzung/:kuerzungId/pkv-pruefung — für aktuelle PKV-Periode vormerken
router.put('/:postid/kuerzung/:kuerzungId/pkv-pruefung', async (req, res) => {
  try {
    const { postid, kuerzungId } = req.params;
    if (!POSTID_RE.test(postid)) return res.status(400).json({ error: 'Ungültige PostID' });
    if (!SUBID_RE.test(kuerzungId)) return res.status(400).json({ error: 'Ungültige Kürzungs-ID' });
    const ebSubid = Number(req.body.eb_subid);
    if (!Number.isInteger(ebSubid)) return res.status(400).json({ error: 'eb_subid fehlt oder ungültig' });

    const result = await vormerkenFuerAktuellePkvPeriode(
      postid, ebSubid, Number(kuerzungId), req.session?.username || null,
      typeof req.body.erlaeuterung === 'string' ? req.body.erlaeuterung.trim() || null : null
    );
    res.json(result);
  } catch (err) {
    sendServiceError(res, err, 'PUT /api/postbuch/:postid/kuerzung/:kuerzungId/pkv-pruefung');
  }
});

// PATCH /:postid/kuerzung/:kuerzungId/pkv-pruefung/erlaeuterung — Erläuterung setzen/ändern/entfernen
router.patch('/:postid/kuerzung/:kuerzungId/pkv-pruefung/erlaeuterung', async (req, res) => {
  try {
    const { postid, kuerzungId } = req.params;
    if (!POSTID_RE.test(postid)) return res.status(400).json({ error: 'Ungültige PostID' });
    if (!SUBID_RE.test(kuerzungId)) return res.status(400).json({ error: 'Ungültige Kürzungs-ID' });
    const ebSubid = Number(req.body.eb_subid);
    if (!Number.isInteger(ebSubid)) return res.status(400).json({ error: 'eb_subid fehlt oder ungültig' });
    const erlaeuterung = typeof req.body.erlaeuterung === 'string' ? req.body.erlaeuterung.trim() || null : null;

    const result = await setErlaeuterung(postid, ebSubid, Number(kuerzungId), erlaeuterung);
    res.json(result);
  } catch (err) {
    sendServiceError(res, err, 'PATCH /api/postbuch/:postid/kuerzung/:kuerzungId/pkv-pruefung/erlaeuterung');
  }
});

// DELETE /:postid/kuerzung/:kuerzungId/pkv-pruefung — Vormerkung zurückziehen
router.delete('/:postid/kuerzung/:kuerzungId/pkv-pruefung', async (req, res) => {
  try {
    const { postid, kuerzungId } = req.params;
    if (!POSTID_RE.test(postid)) return res.status(400).json({ error: 'Ungültige PostID' });
    if (!SUBID_RE.test(kuerzungId)) return res.status(400).json({ error: 'Ungültige Kürzungs-ID' });
    const ebSubidRaw = req.query.eb_subid;
    const ebSubid = Number(ebSubidRaw);
    if (!Number.isInteger(ebSubid)) return res.status(400).json({ error: 'eb_subid fehlt oder ungültig' });

    const result = await entferneVormerkung(postid, ebSubid, Number(kuerzungId));
    res.json(result);
  } catch (err) {
    sendServiceError(res, err, 'DELETE /api/postbuch/:postid/kuerzung/:kuerzungId/pkv-pruefung');
  }
});

// GET /:postid/pins — Anpinnungen dieses Dokuments an PKV-/Beihilfe-Perioden
router.get('/:postid/pins', async (req, res) => {
  try {
    const { postid } = req.params;
    if (!POSTID_RE.test(postid)) return res.status(400).json({ error: 'Ungültige PostID' });
    res.json({ data: await listePins(postid) });
  } catch (err) {
    sendServiceError(res, err, 'GET /api/postbuch/:postid/pins');
  }
});

// POST /:postid/pins — Dokument an die aktuelle Periode einer Person/eines Kostenträgers anpinnen
router.post('/:postid/pins', async (req, res) => {
  try {
    const { postid } = req.params;
    if (!POSTID_RE.test(postid)) return res.status(400).json({ error: 'Ungültige PostID' });
    const { person, kostentraeger, grund } = req.body || {};
    const result = await pinDokument(postid, { person, kostentraeger, grund, akteur: req.session?.username || null });
    res.json(result);
  } catch (err) {
    sendServiceError(res, err, 'POST /api/postbuch/:postid/pins');
  }
});

// DELETE /:postid/pins/:person/:kostentraeger — noch nicht eingereichte Anpinnung lösen
router.delete('/:postid/pins/:person/:kostentraeger', async (req, res) => {
  try {
    const { postid, person, kostentraeger } = req.params;
    if (!POSTID_RE.test(postid)) return res.status(400).json({ error: 'Ungültige PostID' });
    const result = await unpinDokument(postid, person, kostentraeger);
    res.json(result);
  } catch (err) {
    sendServiceError(res, err, 'DELETE /api/postbuch/:postid/pins/:person/:kostentraeger');
  }
});

// PATCH /:postid/erstattung/:subid/ohne-rechnungsbezug — bestätigt/widerruft "kein Rechnungsbezug erforderlich"
router.patch('/:postid/erstattung/:subid/ohne-rechnungsbezug', async (req, res) => {
  try {
    const { postid, subid } = req.params;
    if (!POSTID_RE.test(postid)) return res.status(400).json({ error: 'Ungültige PostID' });
    if (!SUBID_RE.test(subid)) return res.status(400).json({ error: 'Ungültige Positionsnummer' });

    const result = await setOhneRechnungsbezug(
      postid, Number(subid), !!req.body.bestaetigt, req.session?.username || null
    );
    res.json(result);
  } catch (err) {
    sendServiceError(res, err, 'PATCH /api/postbuch/:postid/erstattung/:subid/ohne-rechnungsbezug');
  }
});

// ── PATCH /:postid/generischerechnung ────────────────────────────────────────
router.patch('/:postid/generischerechnung', async (req, res) => {
  try {
    const { postid } = req.params;
    if (!POSTID_RE.test(postid)) {
      return res.status(400).json({ error: 'Ungültige PostID' });
    }

    const textFields    = ['absender', 're_nr', 'iban', 'verwendungszweck', 'kontoinhaber'];
    const dateFields    = ['rechnungsdatum', 'faelligkeit'];
    const numericFields = ['gesamtbetrag'];

    const updates = [];
    const params  = [];
    let paramIdx  = 1;

    const normalizeText = (v) => {
      if (v === null || v === undefined) return null;
      const s = String(v).trim();
      return s === '' ? null : s;
    };

    for (const f of textFields) {
      if (f in req.body) {
        updates.push(`${f} = $${paramIdx}`);
        params.push(normalizeText(req.body[f]));
        paramIdx++;
      }
    }
    for (const f of dateFields) {
      if (f in req.body) {
        const v = normalizeText(req.body[f]);
        updates.push(`${f} = $${paramIdx}::date`);
        params.push(v);
        paramIdx++;
      }
    }
    for (const f of numericFields) {
      if (f in req.body) {
        const raw = req.body[f];
        let val = null;
        if (raw !== null && raw !== undefined && raw !== '') {
          const n = typeof raw === 'number' ? raw : parseFloat(String(raw).replace(',', '.'));
          if (!Number.isFinite(n)) {
            return res.status(400).json({ error: `Ungültiger Wert für ${f}` });
          }
          val = n;
        }
        updates.push(`${f} = $${paramIdx}`);
        params.push(val);
        paramIdx++;
      }
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'Keine aktualisierbaren Felder angegeben' });
    }

    params.push(postid);
    // Ein geänderter Rechnungsbetrag verschiebt den offenen Rest; der
    // Zahlstatus wird in derselben Transaktion neu abgeleitet.
    const result = await inTransaktion(async (client) => {
      const r = await client.query(
        `UPDATE postbuch.generische_rechnung SET ${updates.join(', ')} WHERE postid = $${paramIdx} RETURNING *`,
        params
      );
      if (r.rows.length === 0 || !('gesamtbetrag' in req.body)) return r;
      await gleicheZahlungenAn(client, postid);
      return client.query(`SELECT * FROM postbuch.generische_rechnung WHERE postid = $1`, [postid]);
    });

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Generische Rechnung nicht gefunden' });
    }

    res.json(result.rows[0]);
    uiLog('UPDATE', 'generische_rechnung', postid,
      `fields: ${Object.keys(req.body).filter(k => [...textFields, ...dateFields, ...numericFields].includes(k)).join(', ')}`);
  } catch (err) {
    if (err instanceof ZahlungFehler) return res.status(err.status).json({ error: err.message });
    console.error('PATCH /api/postbuch/:postid/generischerechnung error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

// DELETE /api/postbuch/:postid/generischerechnung
// Entfernt den Rechnungsblock (generische_rechnung) eines Dokuments.
// Nur erlaubt, wenn der Dokumenttyp keinen Rechnungsblock zwingend erfordert.
// Zwingend erforderlich bei: Rechnung, Kaufbeleg.
const GENERISCHE_RECHNUNG_PFLICHTTYPEN = ['rechnung', 'kaufbeleg'];

router.delete('/:postid/generischerechnung', async (req, res) => {
  try {
    const { postid } = req.params;
    if (!POSTID_RE.test(postid)) {
      return res.status(400).json({ error: 'Ungültige PostID' });
    }

    // Dokumenttyp prüfen
    const postResult = await query(
      `SELECT dokumentart AS art FROM postbuch WHERE postid = $1`,
      [postid]
    );
    if (postResult.rows.length === 0) {
      return res.status(404).json({ error: 'Dokument nicht gefunden' });
    }
    const { art } = postResult.rows[0];

    if (GENERISCHE_RECHNUNG_PFLICHTTYPEN.includes(art)) {
      return res.status(409).json({
        error: `Für Dokumente des Typs „${art}" ist der Rechnungsblock zwingend erforderlich und kann nicht entfernt werden.`,
      });
    }

    const kante = await query(
      `SELECT 1 FROM postbuch.dokument_beziehung WHERE art = 'ersetzt' AND (von_postid = $1 OR zu_postid = $1)`,
      [postid],
    );
    if (kante.rowCount > 0) {
      return res.status(409).json({
        error: 'Die Rechnung ist mit einer Korrekturrechnung verknüpft – bitte zuerst die Ersetzung aufheben.',
      });
    }

    // Zahlungen hängen am Dokument, nicht am Block — mit dem Block entfernen.
    const delResult = await inTransaktion(async (client) => {
      const r = await client.query(
        `DELETE FROM generische_rechnung WHERE postid = $1 RETURNING postid`,
        [postid]
      );
      if (r.rows.length > 0) {
        await client.query('DELETE FROM postbuch.rechnung_zahlung WHERE postid = $1', [postid]);
      }
      return r;
    });
    if (delResult.rows.length === 0) {
      return res.status(404).json({ error: 'Kein Rechnungsblock für dieses Dokument vorhanden' });
    }

    uiLog('DELETE', 'generische_rechnung', postid, `Rechnungsblock entfernt (art: ${art})`);
    res.json({ ok: true, postid });
  } catch (err) {
    console.error('DELETE /api/postbuch/:postid/generischerechnung error:', err);
    res.status(500).json({ error: 'Interner Serverfehler' });
  }
});

export default router;
