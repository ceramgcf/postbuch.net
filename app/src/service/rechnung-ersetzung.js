/**
 * service/rechnung-ersetzung.js – Korrekturrechnung ersetzt Ursprungsrechnung
 *
 * Ein Beleg ist nicht die Forderung: Eine Korrekturrechnung ist ein neuer
 * Beleg für dieselbe Forderung. Abgebildet als Kante in
 * postbuch.dokument_beziehung (art 'ersetzt', von = Korrekturrechnung,
 * zu = ersetzte Rechnung).
 *
 * - Die ersetzte Rechnung gilt ab der Kante als erledigt
 *   (lib/rechnungs-filter.js). Ihre Felder – Bezahlt am, Streitbetrag – bleiben
 *   unverändert stehen; dass ihr Streitfall endet, folgt allein aus der Kante.
 * - Die Zahlungen ziehen auf die Korrekturrechnung um. Die Kante hält sie als
 *   Momentaufnahme fest; Rückgängig gibt genau diese Zahlungen zurück und geht
 *   nur, solange die Korrekturrechnung sie noch trägt.
 * - Eine Kette ist erlaubt (C ersetzt B ersetzt A), aufgehoben wird sie von
 *   vorn: zuerst die neueste Ersetzung.
 */

import { query } from '../db.js';
import {
  ZahlungFehler, ladeRechnung, ladeZahlungen, aktualisiereZahlstatus, zuCent,
} from './rechnung-zahlung.js';
import { offenerBetragSql, istErsetztSql } from '../lib/rechnungs-filter.js';

const POSTID_RE = /^P\d{6}$/;
const MAX_VORSCHLAEGE = 4;

/** Kanten einer Rechnung in beide Richtungen, nur PostIDs. */
export async function ladeErsetzung(db, postid) {
  const { rows } = await db.query(
    `SELECT von_postid, zu_postid, created_at
       FROM postbuch.dokument_beziehung
      WHERE art = 'ersetzt' AND (von_postid = $1 OR zu_postid = $1)`,
    [postid],
  );
  const ersetzt = rows.find((r) => r.von_postid === postid);
  const durch = rows.find((r) => r.zu_postid === postid);
  return {
    ersetzt: ersetzt ? { postid: ersetzt.zu_postid, am: ersetzt.created_at } : null,
    ersetzt_durch: durch ? { postid: durch.von_postid, am: durch.created_at } : null,
  };
}

export const ARTWECHSEL_GESPERRT =
  'Wiederverarbeitung gesperrt: Die Rechnung ist mit einer Korrekturrechnung verknüpft und muss eine Rechnung derselben Art bleiben. Bitte zuerst die Ersetzung aufheben.';

/**
 * Vorabprüfung für einen Typwechsel mit bekannter Zielgruppe (Spezialpipeline).
 * Dieselbe Regel prüft der document-processor erst nach der KI-Analyse; wer
 * die Zielart ausdrücklich wählt, soll die Sperre sofort erfahren statt erst
 * als gescheiterten Job. Liefert die Sperrmeldung oder null.
 */
export async function artwechselSperre(db, postid, neueGruppe) {
  const kante = await ladeErsetzung(db, postid);
  if (!kante.ersetzt && !kante.ersetzt_durch) return null;
  const rechnung = await ladeRechnung(db, postid);
  const zielTabelle = neueGruppe === 'arztrechnung'
    ? 'arztrechnung'
    : neueGruppe === 'handwerker' ? 'handwerkerrechnung' : null;
  return zielTabelle && rechnung?.tabelle === zielTabelle ? null : ARTWECHSEL_GESPERRT;
}

/** Gründe, aus denen eine Rechnung nicht ersetzt werden darf. */
async function sperrgruendeAlt(db, rechnung) {
  const gruende = [];
  if (rechnung.tabelle === 'arztrechnung') {
    const { rows } = await db.query(
      `SELECT abrechnungsperiode_pkv, abrechnungsperiode_beihilfe,
              pkv_satz_override, beihilfe_satz_override,
              EXISTS (SELECT 1 FROM postbuch.erstattungsbescheid_einzelposition ep WHERE ep.arz_postid = a.postid)
              OR EXISTS (SELECT 1 FROM postbuch.erstattungsbescheid_kuerzung k WHERE k.arz_postid = a.postid)
                AS hat_bescheid
         FROM postbuch.arztrechnung a WHERE a.postid = $1`,
      [rechnung.postid],
    );
    const r = rows[0];
    if (r.abrechnungsperiode_pkv || r.abrechnungsperiode_beihilfe
        || r.pkv_satz_override != null || r.beihilfe_satz_override != null) {
      gruende.push('Sie hängt an einer Abrechnungsperiode oder trägt einen Satz-Override.');
    }
    if (r.hat_bescheid) gruende.push('Ein Erstattungsbescheid ist ihr zugeordnet.');
  }
  const pins = await db.query('SELECT 1 FROM postbuch.dokument_pin WHERE postid = $1 LIMIT 1', [rechnung.postid]);
  if (pins.rowCount) gruende.push('Sie ist an eine Abrechnungsperiode angepinnt.');
  return gruende;
}

/** Sperrt beide Dokumente in fester Reihenfolge und lädt ihre Rechnungsblöcke. */
async function sperreBeide(db, neuId, altId) {
  for (const id of [neuId, altId].sort()) {
    await db.query('SELECT postid FROM postbuch.postbuch WHERE postid = $1 FOR UPDATE', [id]);
  }
  const rechnungen = {};
  for (const id of [neuId, altId].sort()) {
    rechnungen[id] = await ladeRechnung(db, id, { sperren: true });
  }
  return { neu: rechnungen[neuId], alt: rechnungen[altId] };
}

/**
 * neu ersetzt alt. Läuft in der Transaktion des Aufrufers (inTransaktion).
 * @returns {Promise<{neu:string, alt:string, umgezogen:number}>}
 */
export async function ersetzeRechnung(db, { neu: neuId, alt: altId, akteur = null }) {
  if (!POSTID_RE.test(neuId || '') || !POSTID_RE.test(altId || '')) {
    throw new ZahlungFehler(400, 'Ungültige PostID.');
  }
  if (neuId === altId) throw new ZahlungFehler(400, 'Eine Rechnung kann sich nicht selbst ersetzen.');

  const { neu, alt } = await sperreBeide(db, neuId, altId);
  if (!neu) throw new ZahlungFehler(404, `${neuId} hat keinen Rechnungsblock.`);
  if (!alt) throw new ZahlungFehler(404, `${altId} hat keinen Rechnungsblock.`);
  if ((neu.tabelle === 'arztrechnung') !== (alt.tabelle === 'arztrechnung')) {
    throw new ZahlungFehler(409, 'Eine Arztrechnung kann nur durch eine Arztrechnung ersetzt werden und umgekehrt.');
  }

  const { rows: kanten } = await db.query(
    `SELECT von_postid, zu_postid FROM postbuch.dokument_beziehung
      WHERE art = 'ersetzt' AND (von_postid = ANY($1::varchar[]) OR zu_postid = ANY($1::varchar[]))`,
    [[neuId, altId]],
  );
  const altErsetztDurch = kanten.find((k) => k.zu_postid === altId);
  if (altErsetztDurch) {
    throw new ZahlungFehler(409, `${altId} ist bereits durch ${altErsetztDurch.von_postid} ersetzt.`);
  }
  const neuErsetztDurch = kanten.find((k) => k.zu_postid === neuId);
  if (neuErsetztDurch) {
    throw new ZahlungFehler(409, `${neuId} ist selbst durch ${neuErsetztDurch.von_postid} ersetzt.`);
  }
  const neuErsetztBereits = kanten.find((k) => k.von_postid === neuId);
  if (neuErsetztBereits) {
    throw new ZahlungFehler(409, `${neuId} ersetzt bereits ${neuErsetztBereits.zu_postid}.`);
  }
  // Mit „neu ist nicht ersetzt“ kann keine Kette von alt zurück zu neu führen:
  // jede Kante endet bei einer ersetzten Rechnung. Ein Zyklus ist damit
  // ausgeschlossen, ohne den Graphen abzulaufen.

  const gruende = await sperrgruendeAlt(db, alt);
  if (gruende.length) {
    throw new ZahlungFehler(409, `${altId} kann nicht ersetzt werden: ${gruende.join(' ')}`);
  }

  const zahlungen = await ladeZahlungen(db, altId);
  if (zahlungen.length > 0 && zuCent(neu.gesamtbetrag) === null) {
    throw new ZahlungFehler(409,
      `Auf ${altId} sind Zahlungen erfasst – die Korrekturrechnung braucht dafür einen Rechnungsbetrag.`);
  }
  const momentaufnahme = zahlungen.map((z) => ({
    datum: z.datum,
    betrag: (zuCent(z.betrag) / 100).toFixed(2),
  }));

  await db.query(
    `INSERT INTO postbuch.dokument_beziehung
       (von_postid, zu_postid, art, umgezogene_zahlungen,
        alt_bezahlt_am_manuell, neu_bezahlt_am_manuell, created_by)
     VALUES ($1, $2, 'ersetzt', $3::jsonb, $4, $5, $6)`,
    [neuId, altId, JSON.stringify(momentaufnahme), !!alt.bezahlt_am_manuell, !!neu.bezahlt_am_manuell, akteur],
  );
  await db.query('UPDATE postbuch.rechnung_zahlung SET postid = $1 WHERE postid = $2', [neuId, altId]);
  // Den Stand der ersetzten Rechnung als Nutzerstand markieren: Sonst legt
  // eine Wiederverarbeitung aus einem erkannten „bezahlt am“ eine neue
  // Zahlung an, die beim Rückgängigmachen doppelt wäre.
  await db.query(
    `UPDATE postbuch.${alt.tabelle} SET bezahlt_am_manuell = true WHERE postid = $1`,
    [altId],
  );
  if (zahlungen.length > 0) await aktualisiereZahlstatus(db, neuId);
  return { neu: neuId, alt: altId, umgezogen: zahlungen.length };
}

/**
 * Hebt die Ersetzung der Rechnung altId auf und gibt ihr die umgezogenen
 * Zahlungen zurück. Läuft in der Transaktion des Aufrufers.
 */
export async function hebeErsetzungAuf(db, altId) {
  if (!POSTID_RE.test(altId || '')) throw new ZahlungFehler(400, 'Ungültige PostID.');
  const { rows } = await db.query(
    `SELECT id, von_postid, umgezogene_zahlungen, alt_bezahlt_am_manuell, neu_bezahlt_am_manuell
       FROM postbuch.dokument_beziehung
      WHERE art = 'ersetzt' AND zu_postid = $1`,
    [altId],
  );
  const kante = rows[0];
  if (!kante) throw new ZahlungFehler(404, `${altId} ist nicht ersetzt.`);
  const neuId = kante.von_postid;

  const { neu, alt } = await sperreBeide(db, neuId, altId);
  const spaeter = await db.query(
    `SELECT von_postid FROM postbuch.dokument_beziehung WHERE art = 'ersetzt' AND zu_postid = $1`,
    [neuId],
  );
  if (spaeter.rows[0]) {
    throw new ZahlungFehler(409,
      `${neuId} ist inzwischen durch ${spaeter.rows[0].von_postid} ersetzt – bitte zuerst diese Ersetzung aufheben.`);
  }

  // Die umgezogenen Zahlungen müssen auf der Korrekturrechnung noch
  // vorhanden sein (als Multimenge aus Datum und Betrag).
  const vorhanden = await ladeZahlungen(db, neuId);
  const frei = vorhanden.map((z) => ({ id: z.zahlung_id, datum: z.datum, cent: zuCent(z.betrag) }));
  const zurueck = [];
  for (const z of kante.umgezogene_zahlungen || []) {
    const i = frei.findIndex((f) => f.datum === z.datum && f.cent === zuCent(z.betrag));
    if (i < 0) {
      throw new ZahlungFehler(409,
        `Die Zahlungen auf ${neuId} wurden seither geändert – die Ersetzung lässt sich nicht automatisch aufheben. Bitte die Zahlungen von Hand angleichen.`);
    }
    zurueck.push(frei[i].id);
    frei.splice(i, 1);
  }

  if (zurueck.length) {
    await db.query(
      'UPDATE postbuch.rechnung_zahlung SET postid = $1 WHERE zahlung_id = ANY($2::bigint[])',
      [altId, zurueck],
    );
  }
  await db.query('DELETE FROM postbuch.dokument_beziehung WHERE id = $1', [kante.id]);
  if (neu && zurueck.length) await aktualisiereZahlstatus(db, neuId);
  if (alt && zurueck.length) await aktualisiereZahlstatus(db, altId);
  // Herkunftsstand wiederherstellen: Von der KI erkannte Zahlungen bleiben so
  // bei einer späteren Invalidierung oder Wiederverarbeitung verwerfbar.
  for (const [r, id, wert] of [[alt, altId, kante.alt_bezahlt_am_manuell], [neu, neuId, kante.neu_bezahlt_am_manuell]]) {
    if (!r) continue;
    await db.query(`UPDATE postbuch.${r.tabelle} SET bezahlt_am_manuell = $2 WHERE postid = $1`, [id, !!wert]);
  }
  return { neu: neuId, alt: altId, zurueck: zurueck.length };
}

// ── Vorschläge ──────────────────────────────────────────────────────────────

function normalisiere(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\b(dr|med|dent|prof|dipl|ing|gmbh|ug|kg|ohg|ag|e\.?\s?k|mbh|und|co)\b\.?/g, ' ')
    .replace(/[^a-z0-9äöüß]+/g, ' ')
    .trim();
}

function bigramme(text) {
  const s = ` ${text} `;
  const out = [];
  for (let i = 0; i < s.length - 1; i += 1) out.push(s.slice(i, i + 2));
  return out;
}

/** Dice-Ähnlichkeit zweier Texte über Zeichen-Bigramme, 0 … 1. */
export function textAehnlichkeit(a, b) {
  const x = normalisiere(a);
  const y = normalisiere(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const bx = bigramme(x);
  const by = bigramme(y);
  const rest = [...by];
  let treffer = 0;
  for (const g of bx) {
    const i = rest.indexOf(g);
    if (i >= 0) { treffer += 1; rest.splice(i, 1); }
  }
  return (2 * treffer) / (bx.length + by.length);
}

const ohneLeer = (s) => String(s || '').replace(/\s+/g, '').toUpperCase();

/**
 * Bewertet einen Kandidaten gegenüber der Bezugsrechnung. Rein und testbar.
 * richtung 'vorgaenger': Kandidat ist die mögliche Ursprungsrechnung,
 * 'nachfolger': Kandidat ist die mögliche Korrekturrechnung.
 */
export function bewerteKandidat(bezug, kandidat, richtung) {
  let score = 0;
  score += 3 * textAehnlichkeit(bezug.aussteller, kandidat.aussteller);
  if (bezug.iban && kandidat.iban && ohneLeer(bezug.iban) === ohneLeer(kandidat.iban)) score += 3;
  if (bezug.re_nr && kandidat.re_nr) {
    score += ohneLeer(bezug.re_nr) === ohneLeer(kandidat.re_nr) ? 2 : 2 * textAehnlichkeit(bezug.re_nr, kandidat.re_nr);
  }
  if (bezug.person && kandidat.person && bezug.person === kandidat.person) score += 1;
  if (bezug.rechnungsdatum && kandidat.rechnungsdatum) {
    const passt = richtung === 'vorgaenger'
      ? kandidat.rechnungsdatum <= bezug.rechnungsdatum
      : kandidat.rechnungsdatum >= bezug.rechnungsdatum;
    if (passt) score += 1;
  }
  const a = zuCent(bezug.gesamtbetrag);
  const b = zuCent(kandidat.gesamtbetrag);
  if (a && b) score += Math.max(0, 1 - Math.abs(a - b) / Math.max(a, b)) * 1.5;
  if (richtung === 'vorgaenger' && (kandidat.offen || kandidat.bestritten || kandidat.teilgezahlt)) score += 1;
  if (kandidat.aehnlichkeit != null) score += 2 * Math.max(0, Number(kandidat.aehnlichkeit));
  return Math.round(score * 100) / 100;
}

// Einheitliche Sicht über die drei Rechnungsblöcke mit den Merkmalen fürs Ranking.
const RECHNUNGEN_SQL = `
  SELECT a.postid, 'arztrechnung' AS tabelle, a.name_arzt AS aussteller, a.iban, a.re_nr,
         a.rechnungsdatum, a.gesamtbetrag, a.bestritten_betrag, a.bezahlt_am,
         a.behandelte_person AS person, ${offenerBetragSql('a')} AS offen_betrag
    FROM postbuch.arztrechnung a
  UNION ALL
  SELECT h.postid, 'handwerkerrechnung', h.name_unternehmen, h.iban, h.re_nr,
         h.rechnungsdatum, h.gesamtbetrag, h.bestritten_betrag, h.bezahlt_am,
         NULL, ${offenerBetragSql('h')}
    FROM postbuch.handwerkerrechnung h
  UNION ALL
  SELECT g.postid, 'generische_rechnung', g.absender, g.iban, g.re_nr,
         g.rechnungsdatum, g.gesamtbetrag, g.bestritten_betrag, g.bezahlt_am,
         NULL, ${offenerBetragSql('g')}
    FROM postbuch.generische_rechnung g`;

/**
 * Gerankte Kandidaten für die Ersetzung, höchstens MAX_VORSCHLAEGE.
 * Vorauswahl in SQL (gleiche Rechnungsart, Kante noch frei, Merkmals- oder
 * Embedding-Nähe), Bewertung in bewerteKandidat().
 */
export async function ermittleKandidaten(postid, richtung) {
  if (!POSTID_RE.test(postid || '')) throw new ZahlungFehler(400, 'Ungültige PostID.');
  if (!['vorgaenger', 'nachfolger'].includes(richtung)) throw new ZahlungFehler(400, 'Unbekannte Richtung.');

  const bezugRes = await query(
    `SELECT r.*, p.embedding_signature, (p.embedding IS NOT NULL) AS hat_embedding
       FROM (${RECHNUNGEN_SQL}) r JOIN postbuch.postbuch p ON p.postid = r.postid
      WHERE r.postid = $1`,
    [postid],
  );
  const bezug = bezugRes.rows[0];
  if (!bezug) throw new ZahlungFehler(404, 'Keine Rechnung für diese PostID gefunden.');

  // Der Kandidat muss die freie Seite der neuen Kante haben: als Vorgänger
  // noch nicht ersetzt, als Nachfolger weder ersetzt noch selbst Ersetzer.
  const kantenFrei = richtung === 'vorgaenger'
    ? `NOT ${istErsetztSql('r')}`
    : `NOT ${istErsetztSql('r')}
       AND NOT EXISTS (SELECT 1 FROM postbuch.dokument_beziehung db2
                        WHERE db2.von_postid = r.postid AND db2.art = 'ersetzt')`;
  const nurArzt = bezug.tabelle === 'arztrechnung';
  const mitEmbedding = bezug.hat_embedding && bezug.embedding_signature;

  const { rows } = await query(
    `WITH bezug AS (SELECT embedding, embedding_signature FROM postbuch.postbuch WHERE postid = $1)
     SELECT r.*, p.betreff,
            ${mitEmbedding
              ? `CASE WHEN p.embedding IS NOT NULL AND p.embedding_signature = bezug.embedding_signature
                      THEN 1 - (p.embedding <=> bezug.embedding) END`
              : 'NULL'}::float AS aehnlichkeit
       FROM (${RECHNUNGEN_SQL}) r
       JOIN postbuch.postbuch p ON p.postid = r.postid
       CROSS JOIN bezug
      WHERE r.postid <> $1
        AND (r.tabelle = 'arztrechnung') = $2
        AND ${kantenFrei}
        AND (
             lower(btrim(r.aussteller)) = lower(btrim($3))
          OR (r.iban IS NOT NULL AND replace(upper(r.iban), ' ', '') = replace(upper($4), ' ', ''))
          OR (r.re_nr IS NOT NULL AND replace(upper(r.re_nr), ' ', '') = replace(upper($5), ' ', ''))
          ${mitEmbedding ? `OR (p.embedding_signature = bezug.embedding_signature
                             AND p.embedding IS NOT NULL
                             AND (p.embedding <=> bezug.embedding) < 0.3)` : ''}
        )
      LIMIT 200`,
    [postid, nurArzt, bezug.aussteller || '', bezug.iban || '', bezug.re_nr || ''],
  );

  return rows
    .map((r) => {
      const offenCent = zuCent(r.offen_betrag);
      const kandidat = {
        ...r,
        offen: !r.bezahlt_am && offenCent !== null && offenCent > 0,
        bestritten: zuCent(r.bestritten_betrag) > 0,
        teilgezahlt: !r.bezahlt_am && offenCent !== null
          && offenCent < (zuCent(r.gesamtbetrag) ?? 0) - (zuCent(r.bestritten_betrag) || 0),
      };
      return { kandidat, score: bewerteKandidat(bezug, kandidat, richtung) };
    })
    .filter((x) => x.score >= 3)
    .sort((x, y) => y.score - x.score || String(y.kandidat.rechnungsdatum || '').localeCompare(String(x.kandidat.rechnungsdatum || '')))
    .slice(0, MAX_VORSCHLAEGE)
    .map(({ kandidat: k, score }) => ({
      postid: k.postid,
      betreff: k.betreff,
      aussteller: k.aussteller,
      re_nr: k.re_nr,
      rechnungsdatum: k.rechnungsdatum,
      gesamtbetrag: k.gesamtbetrag,
      bestritten_betrag: k.bestritten_betrag,
      bezahlt_am: k.bezahlt_am,
      offen_betrag: k.offen_betrag,
      teilgezahlt: k.teilgezahlt,
      score,
    }));
}

/** Rechnungsdaten eines frei gewählten Dokuments für den Bestätigungsdialog. */
export async function ladeRechnungKurz(postid) {
  if (!POSTID_RE.test(postid || '')) throw new ZahlungFehler(400, 'Ungültige PostID.');
  const { rows } = await query(
    `SELECT r.postid, r.tabelle, r.aussteller, r.re_nr, r.rechnungsdatum, r.gesamtbetrag,
            r.bestritten_betrag, r.bezahlt_am, r.offen_betrag, p.betreff,
            (SELECT count(*)::int FROM postbuch.rechnung_zahlung z WHERE z.postid = r.postid) AS anzahl_zahlungen,
            (SELECT COALESCE(sum(z.betrag), 0) FROM postbuch.rechnung_zahlung z WHERE z.postid = r.postid) AS gezahlt
       FROM (${RECHNUNGEN_SQL}) r JOIN postbuch.postbuch p ON p.postid = r.postid
      WHERE r.postid = $1`,
    [postid],
  );
  return rows[0] || null;
}
