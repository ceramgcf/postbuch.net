/**
 * service/erstattungsbescheid.js — Erstattungsbescheid-Verarbeitung
 *
 * Ersetzt: n8n-Workflow "Handling Erstattungsbescheide" (26 Nodes → 1 Funktion).
 *
 * Ablauf:
 *   1. PDF laden (via document-retriever)
 *   2. LLM-Analyse mit buildEbParsePrompt(patients, aktiveProfile) (Modellklasse 'mittel')
 *   3. Rechnungszuordnung (Matching auf arztrechnung-Tabelle)
 *   4. DB-Insert (erstattungsbescheid + erstattungsbescheid_einzelposition)
 *   5. Kürzungen erkennen, bei Bedarf KI-Matching (Modellklasse 'schwierig')
 *   6. Abrechnungsperioden-Vervollständigung prüfen
 *   7. Discord-Nachricht
 */

import pool from '../db.js';
import { loadDynamicSettings } from '../config.js';
import { callLLM, resolveKlassenModell, buildCostMap, calculateCost } from '../lib/llm.js';
import * as discord from '../lib/discord.js';
import { retrieveDocument } from './document-retriever.js';
import { buildEbParsePrompt, buildMatchKuerzungenPrompt } from '../prompts/erstattungsbescheid.js';
import { uiLog } from '../log.js';
import { appLog } from '../app-log.js';
import { sendPushToAllUsers } from '../lib/webpush.js';
import { toDate, toNumeric } from '../lib/coerce.js';
import { gleichePersonAb } from '../lib/personen-abgleich.js';
import { bewertePeriodenNachBescheid, setzeBescheidwirkungZurueck } from './periodenabschluss.js';

// ── Hilfsfunktionen ──────────────────────────────────────────────────────────
// toDate/toNumeric lagen hier als byte-identische Kopie aus document-inserter.js.
// Beide sind jetzt in lib/coerce.js zusammengeführt und dabei gehärtet worden
// (deutsche Zahlnotation, Infinity, echte Kalenderprüfung).

/**
 * Parst die LLM-Antwort als JSON. Entfernt ggf. Markdown-Codeblöcke.
 */
function parseJsonResponse(text) {
  let cleaned = text.trim();
  // Markdown-Codeblock entfernen
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  return JSON.parse(cleaned);
}

/**
 * Prüft die minimale Struktur, die der EB-Fachschritt vor seiner atomaren
 * Rücknahme braucht. Eine JSON-Antwort kann syntaktisch korrekt und trotzdem
 * so falsch geformt sein, dass der spätere Kürzungs-/Discord-Schritt erst nach
 * dem Verlust der alten Periodenwirkung scheitert.
 */
export function validateEbData(ebData) {
  if (!ebData || typeof ebData !== 'object' || Array.isArray(ebData)) {
    throw new Error('Erstattungsbescheid-Antwort ist kein JSON-Objekt. Bitte Dokument erneut prüfen.');
  }
  if (!Array.isArray(ebData.einzelpositionen)) {
    throw new Error('Erstattungsbescheid enthält keine gültige Einzelpositionsliste. Bitte Dokument erneut prüfen.');
  }
  if (ebData.hinweise != null && typeof ebData.hinweise !== 'string') {
    throw new Error('Erstattungsbescheid enthält ungültige Hinweise. Bitte Dokument erneut prüfen.');
  }
  if (ebData.erkanntesProfil != null && typeof ebData.erkanntesProfil !== 'string') {
    throw new Error('Erstattungsbescheid enthält ein ungültiges erkanntes Profil. Bitte Dokument erneut prüfen.');
  }
  for (const [index, ep] of ebData.einzelpositionen.entries()) {
    if (!ep || typeof ep !== 'object' || Array.isArray(ep)) {
      throw new Error(`Erstattungsbescheid-Position ${index + 1} ist ungültig. Bitte Dokument erneut prüfen.`);
    }
    if (ep.kuerzungen != null && !Array.isArray(ep.kuerzungen)) {
      throw new Error(`Kürzungen der Bescheidposition ${index + 1} sind ungültig. Bitte Dokument erneut prüfen.`);
    }
    for (const [kuerzungIndex, kuerzung] of (ep.kuerzungen || []).entries()) {
      if (!kuerzung || typeof kuerzung !== 'object' || Array.isArray(kuerzung)) {
        throw new Error(`Kürzung ${index + 1}/${kuerzungIndex + 1} ist ungültig. Bitte Dokument erneut prüfen.`);
      }
      if (kuerzung.begruendung != null && typeof kuerzung.begruendung !== 'string') {
        throw new Error(`Begründung der Kürzung ${index + 1}/${kuerzungIndex + 1} ist ungültig. Bitte Dokument erneut prüfen.`);
      }
    }
  }
}

/**
 * Matched EB-Einzelpositionen gegen eingereichte Arztrechnungen.
 * Repliziert die n8n-Code-Node "MatchToInvoices".
 *
 * Liefert nur die Zuordnung Position → Rechnung. Welche Abrechnungsperioden
 * daraus abgeschlossen werden, entscheidet allein `service/periodenabschluss.js`
 * anhand der gespeicherten Zuordnungen.
 */
export function matchToInvoices(ebData, submittedInvoices, postid) {
  const eps = ebData.einzelpositionen || [];
  const matchResults = [];
  const usedInvoices = new Set();

  for (let i = 0; i < eps.length; i++) {
    const ep = eps[i];
    const person = ep.behandeltePerson;
    const epBezugsdatum = toDate(ep.bezugsdatum);
    // Kein `|| 0`: ein unlesbarer Betrag ist NICHT null Euro. Vorher reichte
    // toNumeric den Rohstring durch und der Vergleich unten wurde zu NaN — es kam
    // schlicht kein Treffer zustande. Mit einer 0 würde stattdessen eine
    // Null-Euro-Rechnung als Treffer gelten.
    const epBetrag = toNumeric(ep.rechnungsbetrag);

    // Kandidaten: gleiche Person, ähnlicher Betrag, noch nicht zugeordnet
    const candidates = epBetrag == null ? [] : submittedInvoices.filter(inv =>
      !usedInvoices.has(inv.postid) &&
      inv.behandelte_person === person &&
      Math.abs(toNumeric(inv.gesamtbetrag) - epBetrag) < 0.01
    );
    if (epBetrag == null) {
      console.warn(`[eb] ${postid}: Rechnungsbetrag der Position ${i + 1} unlesbar (${JSON.stringify(ep.rechnungsbetrag)}) — keine Zuordnung möglich`);
      appLog('WARN', 'erstattungsbescheid',
        `${postid}: Rechnungsbetrag Position ${i + 1} unlesbar — Position bleibt unzugeordnet`,
        { entity: 'postbuch', entityId: postid });
    }

    let matched = null;

    if (candidates.length === 1) {
      matched = candidates[0];
    } else if (candidates.length > 1) {
      // Bei mehreren Kandidaten zuerst versuchen, über ein belastbares
      // Bezugsdatum genau eine Rechnung als nächste auszuweisen.
      const alleKandidatenMitDatum = candidates.every((candidate) => candidate.rechnungsdatum);
      // Postid-Fallback erst, wenn das Bezugsdatum keine eindeutige Wahl
      // liefert (fehlt komplett, fehlt bei einem Kandidaten, oder mehrere
      // Kandidaten sind gleich nah dran). Bewusst nachrangig zum Datum, und
      // nur vertretbar, weil identischer Betrag + identische Person i. d. R.
      // eine baugleiche Rechnung bedeutet: welche der beiden zuerst
      // "verbraucht" wird, ist fachlich beliebig — die andere greift beim
      // nächsten Bescheid. Fallback wählt deterministisch die niedrigste
      // Postid (= älteste Erfassung) unter den verbleibenden Kandidaten.
      let fallbackGrund = null;
      if (epBezugsdatum && alleKandidatenMitDatum) {
        const epDate = new Date(epBezugsdatum);
        const scored = candidates.map((candidate) => ({
          candidate,
          distance: candidate.rechnungsdatum
            ? Math.abs(new Date(candidate.rechnungsdatum) - epDate)
            : Infinity,
        })).sort((a, b) => a.distance - b.distance);
        const bestDistance = scored[0].distance;
        const naechste = scored.filter((entry) => entry.distance === bestDistance);
        if (naechste.length === 1 && Number.isFinite(bestDistance)) {
          matched = naechste[0].candidate;
        } else {
          fallbackGrund = naechste.length > 1 ? 'gleich nahes Bezugsdatum' : 'kein eindeutiges Rechnungsdatum';
          matched = naechste.map((entry) => entry.candidate)
            .sort((a, b) => a.postid.localeCompare(b.postid))[0];
        }
      } else {
        fallbackGrund = epBezugsdatum ? 'Kandidaten ohne vollständiges Rechnungsdatum' : 'kein Bezugsdatum';
        matched = candidates.slice().sort((a, b) => a.postid.localeCompare(b.postid))[0];
      }
      if (fallbackGrund) {
        appLog('WARN', 'erstattungsbescheid',
          `${postid}: Position ${i + 1} per Postid-Fallback zugeordnet (gleicher Betrag, ${fallbackGrund}) — bitte stichprobenhaft prüfen`,
          { entity: 'postbuch', entityId: postid });
      }
    }

    if (matched) {
      usedInvoices.add(matched.postid);
    }

    matchResults.push({
      subid: i + 1,
      belegNr: ep.belegNr,
      behandeltePerson: person,
      kostenart: ep.kostenart,
      bezugsdatum: epBezugsdatum,
      rechnungsbetrag: toNumeric(ep.rechnungsbetrag),
      erstattungsbetrag: toNumeric(ep.erstattungsbetrag),
      kuerzungsbetrag: toNumeric(ep.kuerzungsbetrag),
      kuerzungen: ep.kuerzungen || [],
      arz_postid: matched?.postid || null,
    });
  }

  return matchResults;
}

// ── Hauptfunktion ────────────────────────────────────────────────────────────

/**
 * Verarbeitet einen Erstattungsbescheid vollständig.
 *
 * @param {string} postid              - PostID des Erstattungsbescheids in postbuch
 * @param {string} [korrekturAnweisung] - Optionale Korrektur-/Hinweistexte bei Wiederverarbeitung
 */
export async function processErstattungsbescheid(postid, korrekturAnweisung = '') {
  const settings = await loadDynamicSettings();
  let client;

  try {
    appLog('INFO', 'erstattungsbescheid', `EB-Verarbeitung gestartet: ${postid}`, { entity: 'postbuch', entityId: postid });

    // ─── 1. PDF laden + Patientengruppe festlegen ───
    const { pdf } = await retrieveDocument(postid);
    const bescheidResult = await pool.query(
      `SELECT lebensbereich = 'tier' AS ist_tier FROM postbuch WHERE postid = $1`,
      [postid],
    );
    if (!bescheidResult.rowCount) throw new Error(`Erstattungsbescheid ${postid} nicht gefunden`);
    const istTier = bescheidResult.rows[0].ist_tier;

    // ─── 2. LLM-Analyse mit dynamisch befülltem EB-Parse-Prompt ───
    // EB kann auf historische Daten Bezug nehmen → ALLE Personen (auch archivierte)
    const allPersonsResult = await pool.query(
      `SELECT kurzname, anzeigename AS vollname, ist_tier, pkv, beihilfe, pkv_satz, beihilfe_satz
       FROM postbuch.mensch
       WHERE (pkv = true OR beihilfe = true) AND ist_tier = $1
       ORDER BY kurzname`
      , [istTier]
    );
    const aktiveProfileResult = await pool.query(
      `SELECT id, name, kostentraeger, profiltext
       FROM postbuch.kostentraeger_profil
       WHERE aktiv = true
       ORDER BY id`
    );
    const aktiveProfile = aktiveProfileResult.rows;
    const ebParsePromptBase = buildEbParsePrompt(allPersonsResult.rows, aktiveProfile);
    const ebParsePrompt = korrekturAnweisung
      ? `### KORREKTUR-ANWEISUNGEN VOM BENUTZER ###\n${korrekturAnweisung}\n\n` + ebParsePromptBase
      : ebParsePromptBase;
    // Modell aus Settings: "Mittel"-Modell (wie für mittelschwere Dokumente konfiguriert)
    const costMap = buildCostMap(settings);
    const ebParseModel = resolveKlassenModell('mittel', settings).model;
    const llmResult = await callLLM(ebParseModel, ebParsePrompt, { pdf, maxTokens: 16384 }, settings, {
      kategorie: 'erstattungsbescheid', entity: 'postbuch', entityId: postid, correlationId: postid,
    });
    const ebData = parseJsonResponse(llmResult.text);
    const ebTokensIn  = llmResult.usage?.inputTokens  ?? null;
    const ebTokensOut = llmResult.usage?.outputTokens ?? null;
    const ebCostUsd   = calculateCost(ebParseModel, ebTokensIn, ebTokensOut, costMap);

    validateEbData(ebData);

    // Das Matching vergleicht Personen exakt über den Kurznamen — eine Schreib-
    // variante der KI ließe die Position sonst ohne Rechnung stehen.
    const ebPatienten = allPersonsResult.rows.map((p) => ({ kurzname: p.kurzname, anzeigename: p.vollname }));
    for (const [index, ep] of ebData.einzelpositionen.entries()) {
      const ergebnis = gleichePersonAb(ep.behandeltePerson, ebPatienten);
      if (ergebnis.art === 'verworfen') {
        appLog('WARN', 'erstattungsbescheid',
          `${postid}: behandelte Person "${String(ep.behandeltePerson).slice(0, 80)}" der Position ${index + 1} ist keinem Patienten eindeutig zuzuordnen`,
          { entity: 'postbuch', entityId: postid });
      }
      ep.behandeltePerson = ergebnis.kurzname;
    }

    appLog('INFO', 'erstattungsbescheid', `EB geparst: ${ebData.kostentraeger}, Erstattung=${ebData.erstattungsbetrag}€, ${(ebData.einzelpositionen || []).length} Positionen`, {
      entity: 'postbuch', entityId: postid,
    });

    // Die alte Bescheidwirkung darf erst zurückgenommen werden, wenn die
    // fachlichen Minimaldaten der neuen Analyse belastbar sind. Andernfalls
    // würde eine formal parsebare, aber unbrauchbare LLM-Antwort (z. B. ohne
    // Kostenträger oder Positionsliste) eine zuvor korrekte Periodenwirkung
    // entfernen und den Nutzer unnötig in einen Recovery-Zustand bringen.
    const kostentraeger = ebData.kostentraeger;
    if (!['PKV', 'Beihilfe'].includes(kostentraeger)) {
      throw new Error(`Erstattungsbescheid enthält keinen gültigen Kostenträger: ${String(kostentraeger)}`);
    }
    if (istTier && kostentraeger !== 'PKV') {
      throw new Error('Ein Tier-PKV-Erstattungsbescheid darf nur den Kostenträger PKV enthalten.');
    }

    // Vom LLM gemeldetes Profil nur übernehmen, wenn es tatsächlich unter den
    // aktiven Profilen war, die im Prompt standen (kein Vertrauen auf freien Text).
    const erkanntesProfilName = typeof ebData.erkanntesProfil === 'string' ? ebData.erkanntesProfil : null;
    const erkanntesProfil = erkanntesProfilName
      ? aktiveProfile.find((p) => p.name === erkanntesProfilName) || null
      : null;

    // ─── 3. Eingereichte Rechnungen laden ───
    // Bei einer Wiederverarbeitung zuerst die Periodenwirkung des vorherigen
    // Laufs zurücknehmen: Restperioden auflösen, abgeschlossene Perioden wieder
    // auf SUBMITTED. Erst danach steht der ungeteilte Rechnungsbestand für das
    // Matching bereit, und die anschließende Bewertung startet ohne Altlast.
    await setzeBescheidwirkungZurueck(postid, {
      grund: korrekturAnweisung ? 'wiederverarbeitung-mit-korrektur' : 'wiederverarbeitung',
    });

    const invoicesResult = await pool.query(
      `SELECT a.postid, a.gesamtbetrag, a.behandelte_person, a.name_arzt, a.typ,
              a.rechnungsdatum, a.re_nr,
              CASE WHEN $1 = 'PKV'
                   THEN a.abrechnungsperiode_pkv
                   ELSE a.abrechnungsperiode_beihilfe END AS abrechnungsperiode
       FROM arztrechnung a
       JOIN postbuch.mensch m ON m.kurzname = a.behandelte_person AND m.ist_tier = $2
       JOIN abrechnungsperiode_buch ab
         ON ab.person = a.behandelte_person
         AND ab.kostentraeger = $1
         AND ab.periode = CASE WHEN $1 = 'PKV'
                               THEN a.abrechnungsperiode_pkv
                               ELSE a.abrechnungsperiode_beihilfe END
       WHERE (ab.status = 'SUBMITTED'
              OR (ab.status = 'COMPLETED' AND ab.eb_postid = $3))
       ORDER BY a.behandelte_person, a.gesamtbetrag`,
      [kostentraeger, istTier, postid]
    );

    const submittedInvoices = invoicesResult.rows;

    // ─── 4. Matching ───
    const matchResults = matchToInvoices(ebData, submittedInvoices, postid);

    const matchedCount = matchResults.filter(m => m.arz_postid).length;
    const unmatchedCount = matchResults.length - matchedCount;

    const matchingSummary = `${matchedCount}/${matchResults.length} Positionen zugeordnet` +
      (unmatchedCount > 0 ? ` (${unmatchedCount} ohne Rechnung)` : '');

    appLog('INFO', 'erstattungsbescheid', `Matching: ${matchingSummary}`, { entity: 'postbuch', entityId: postid });

    // ─── 5. DB-Inserts (in Transaktion) ───
    client = await pool.connect();
    await client.query('BEGIN');

    // 5a. Erstattungsbescheid-Kopf
    await client.query(
      `INSERT INTO erstattungsbescheid
         (postid, kostentraeger, bescheiddatum, erstattungsbetrag, matching_summary, hinweise, ist_tier,
          ai_eb_model, ai_eb_tokens_in, ai_eb_tokens_out, ai_eb_cost_usd,
          kostentraeger_profil_id, kostentraeger_profil_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (postid) DO UPDATE SET
         kostentraeger = EXCLUDED.kostentraeger,
         bescheiddatum = EXCLUDED.bescheiddatum,
         erstattungsbetrag = EXCLUDED.erstattungsbetrag,
         matching_summary = EXCLUDED.matching_summary,
         hinweise = EXCLUDED.hinweise,
         ist_tier = EXCLUDED.ist_tier,
         ai_eb_model = EXCLUDED.ai_eb_model,
         ai_eb_tokens_in = EXCLUDED.ai_eb_tokens_in,
         ai_eb_tokens_out = EXCLUDED.ai_eb_tokens_out,
         ai_eb_cost_usd = EXCLUDED.ai_eb_cost_usd,
         kostentraeger_profil_id = EXCLUDED.kostentraeger_profil_id,
         kostentraeger_profil_name = EXCLUDED.kostentraeger_profil_name`,
      [
        postid,
        kostentraeger,
        toDate(ebData.bescheiddatum),
        toNumeric(ebData.erstattungsbetrag),
        matchingSummary,
        ebData.hinweise || null,
        istTier,
        ebParseModel,
        ebTokensIn,
        ebTokensOut,
        ebCostUsd,
        erkanntesProfil?.id ?? null,
        erkanntesProfil?.name ?? null,
      ]
    );

    // 5b. Alte Einzelpositionen löschen (falls Reprocessing)
    await client.query(
      `DELETE FROM erstattungsbescheid_einzelposition WHERE postid = $1`,
      [postid]
    );

    // 5c. Einzelpositionen einfügen
    for (const ep of matchResults) {
      await client.query(
        `INSERT INTO erstattungsbescheid_einzelposition
           (postid, subid, arz_postid, erstattungsbetrag, rechnungsbetrag,
            kuerzungsbetrag, behandelte_person, kostenart, bezugsdatum, beleg_nr)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          postid,
          ep.subid,
          ep.arz_postid,
          toNumeric(ep.erstattungsbetrag),
          toNumeric(ep.rechnungsbetrag),
          toNumeric(ep.kuerzungsbetrag),
          ep.behandeltePerson,
          ep.kostenart,
          ep.bezugsdatum,
          ep.belegNr != null ? String(ep.belegNr) : null,
        ]
      );
    }

    await client.query('COMMIT');

    // ─── 6. Kürzungen verarbeiten ───
    const allKuerzungen = matchResults.filter(ep => ep.kuerzungen && ep.kuerzungen.length > 0);

    if (allKuerzungen.length > 0) {
      await processKuerzungen(postid, allKuerzungen, settings, korrekturAnweisung);
    }

    // ─── 7. Abrechnungsperioden bewerten ───
    // Letzten fachlichen DB-Schritt und persistenten Abschlussmarker atomar
    // setzen. Danach darf Recovery niemals erneut die nichtdeterministische
    // LLM-Analyse starten, selbst wenn nur das Journal-Cleanup scheitert.
    await client.query('BEGIN');
    const periodenBewertung = await bewertePeriodenNachBescheid(postid, {
      grund: 'eb-verarbeitung', db: client,
    });
    await client.query(
      `UPDATE postbuch._pipeline_file_journal
          SET state='eb_complete', updated_at=NOW()
        WHERE postid=$1 AND state='eb_pending'`,
      [postid],
    );
    await client.query('COMMIT');

    // ─── 8. Discord-Nachricht ───
    const discordMsg = buildDiscordMessage(postid, ebData, matchResults, periodenBewertung);
    await discord.sendMessage(discordMsg, settings).catch((err) => {
      appLog('WARN', 'erstattungsbescheid',
        `Discord-Nachricht für ${postid} fehlgeschlagen: ${err.message}`,
        { entity: 'postbuch', entityId: postid });
    });

    // Push-Benachrichtigung (fire-and-forget) — Kategorie: neues Dokument
    sendPushToAllUsers({
      title: '✅ Erstattungsbescheid verarbeitet',
      body: `${postid} · ${ebData.kostentraeger || ''}: ${ebData.erstattungsbetrag ? ebData.erstattungsbetrag + '€' : ''}`,
      tag: `eb-${postid}`,
      url: (settings?.app_host || '').replace(/\/$/, '') + `/postbuch/${postid}` || `/postbuch/${postid}`,
      requireInteraction: false,
    }, { category: 'new_doc' }).catch((e) => console.warn('[erstattungsbescheid] Push-Fehler:', e.message));

    appLog('INFO', 'erstattungsbescheid', `EB-Verarbeitung abgeschlossen: ${postid} (${kostentraeger}, ${ebData.erstattungsbetrag}€)`, {
      entity: 'postbuch', entityId: postid,
    });

    uiLog('UPDATE', 'erstattungsbescheid', postid, `${kostentraeger}: ${matchingSummary}, Erstattung=${ebData.erstattungsbetrag}€`);

    return { kostentraeger, matchingSummary, erstattungsbetrag: ebData.erstattungsbetrag };

  } catch (err) {
    if (client) {
      await client.query('ROLLBACK').catch(() => {});
    }
    appLog('ERROR', 'erstattungsbescheid', `EB-Verarbeitung fehlgeschlagen: ${postid}: ${err.message}`, {
      details: err.stack?.slice(0, 2000),
      entity: 'postbuch', entityId: postid,
    });
    throw err;
  } finally {
    if (client) client.release();
  }
}

// ── Kürzungen ────────────────────────────────────────────────────────────────

async function processKuerzungen(postid, epsWithKuerzungen, settings, korrekturAnweisung = '') {
  // Sammle Kürzungen mit arz_postid für KI-Matching
  const kuerzungenForAi = [];
  const kuerzungenDirect = [];

  for (const ep of epsWithKuerzungen) {
    for (let ki = 0; ki < ep.kuerzungen.length; ki++) {
      const k = ep.kuerzungen[ki];
      // erstattungsbescheid_kuerzung.kuerzungsbetrag ist NOT NULL, ein unlesbarer
      // Betrag kann hier also nicht als NULL abgelegt werden. Dann eben 0 — aber
      // LAUT: früher scheiterte der INSERT an einem durchgereichten Rohstring und
      // fiel dadurch auf. Ohne diesen Log wäre eine verschluckte Kürzung still.
      const kBetrag = toNumeric(k.betrag);
      if (kBetrag == null && k.betrag != null && k.betrag !== '') {
        console.error(`[eb] ${postid}: Kürzungsbetrag unlesbar (${JSON.stringify(k.betrag)}) — als 0,00 abgelegt, bitte prüfen`);
        appLog('ERROR', 'erstattungsbescheid',
          `${postid}: Kürzungsbetrag unlesbar (${JSON.stringify(k.betrag).slice(0, 80)}) — als 0,00 abgelegt`,
          { entity: 'postbuch', entityId: postid });
      }
      const entry = {
        postid,
        eb_subid: ep.subid,
        kuerzung_index: ki,
        arz_postid: ep.arz_postid,
        kuerzungsbetrag: kBetrag ?? 0,
        begruendung: k.begruendung || null,
        arz_subid: null,
      };

      if (ep.arz_postid) {
        kuerzungenForAi.push(entry);
      } else {
        kuerzungenDirect.push(entry);
      }
    }
  }

  // KI-Matching für Kürzungen mit zugeordneter Arztrechnung
  if (kuerzungenForAi.length > 0) {
    try {
      // Arztrechnung-Einzelpositionen laden
      const arzPostids = [...new Set(kuerzungenForAi.map(k => k.arz_postid))];
      const arzEpsResult = await pool.query(
        `SELECT postid, subid, behandlungs_datum, goa_goz_gebueh_pzn,
                leistung, begruendung, faktor, betrag
         FROM arztrechnung_einzelposition
         WHERE postid = ANY($1)
         ORDER BY postid, subid`,
        [arzPostids]
      );

      // Gruppierte Kürzungen für KI
      const groupedKuerzungen = {};
      for (const k of kuerzungenForAi) {
        const key = `${k.arz_postid}`;
        if (!groupedKuerzungen[key]) groupedKuerzungen[key] = [];
        groupedKuerzungen[key].push({
          postid: k.postid,
          eb_subid: k.eb_subid,
          kuerzung_index: k.kuerzung_index,
          kuerzungsbetrag: k.kuerzungsbetrag,
          begruendung: k.begruendung,
        });
      }

      // KI-Matching mit dem "Schwierig"-Modell aus Settings
      const kuerzungModel = resolveKlassenModell('schwierig', settings).model;
      const promptBase = buildMatchKuerzungenPrompt(groupedKuerzungen, arzEpsResult.rows);
      const prompt = korrekturAnweisung
        ? `### KORREKTUR-ANWEISUNGEN VOM BENUTZER ###\n${korrekturAnweisung}\n\n` + promptBase
        : promptBase;
      // Note: korrekturAnweisung is now a proper parameter (was previously a ReferenceError)
      const matchResult = await callLLM(kuerzungModel, prompt, {}, settings, {
        kategorie: 'kuerzung', entity: 'postbuch', entityId: postid, correlationId: postid,
      });
      const matchedKuerzungen = parseJsonResponse(matchResult.text);
      const kuerzungTokensIn  = matchResult.usage?.inputTokens  ?? null;
      const kuerzungTokensOut = matchResult.usage?.outputTokens ?? null;
      const kuerzungCostUsd   = calculateCost(kuerzungModel, kuerzungTokensIn, kuerzungTokensOut, buildCostMap(settings));

      // Token-Daten in erstattungsbescheid speichern
      await pool.query(
        `UPDATE erstattungsbescheid
         SET ai_kuerzung_model = $2, ai_kuerzung_tokens_in = $3,
             ai_kuerzung_tokens_out = $4, ai_kuerzung_cost_usd = $5
         WHERE postid = $1`,
        [postid, kuerzungModel, kuerzungTokensIn, kuerzungTokensOut, kuerzungCostUsd]
      );

      // Ergebnisse zuordnen
      for (const mk of matchedKuerzungen) {
        const orig = kuerzungenForAi.find(k =>
          k.eb_subid === mk.eb_subid && k.kuerzung_index === mk.kuerzung_index
        );
        if (orig) {
          orig.arz_subid = mk.arz_subid || null;
        }
      }

      appLog('INFO', 'erstattungsbescheid', `Kürzungen-Matching: ${matchedKuerzungen.length} Kürzungen KI-zugeordnet`, { entity: 'postbuch', entityId: postid });
    } catch (err) {
      // KI-Matching-Fehler ist nicht fatal — Kürzungen werden ohne arz_subid gespeichert
      appLog('WARN', 'erstattungsbescheid', `Kürzungen-KI-Matching fehlgeschlagen: ${err.message}`, { entity: 'postbuch', entityId: postid });
    }
  }

  // Alle Kürzungen in DB schreiben
  const allKuerzungen = [...kuerzungenForAi, ...kuerzungenDirect];
  for (const k of allKuerzungen) {
    await pool.query(
      `INSERT INTO erstattungsbescheid_kuerzung
         (postid, eb_subid, arz_postid, arz_subid, kuerzungsbetrag, begruendung)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [postid, k.eb_subid, k.arz_postid, k.arz_subid, k.kuerzungsbetrag, k.begruendung]
    );
  }

  if (allKuerzungen.length > 0) {
    appLog('INFO', 'erstattungsbescheid', `${allKuerzungen.length} Kürzungen gespeichert`, { entity: 'postbuch', entityId: postid });
  }
}

// ── Discord-Nachricht ────────────────────────────────────────────────────────

function buildDiscordMessage(postid, ebData, matchResults, periodenBewertung) {
  const matched = matchResults.filter(m => m.arz_postid).length;
  const total = matchResults.length;
  const kuerzungenCount = matchResults.reduce((sum, m) => sum + (m.kuerzungen?.length || 0), 0);

  let msg = `### 📋 Erstattungsbescheid verarbeitet\n`;
  msg += `**${ebData.kostentraeger}** vom ${ebData.bescheiddatum || '(kein Datum)'}\n`;
  msg += `Erstattungsbetrag: **${ebData.erstattungsbetrag}€**\n`;
  msg += `Zuordnung: ${matched}/${total} Positionen zugeordnet\n`;
  msg += `PostID: ${postid}\n`;

  if (kuerzungenCount > 0) {
    msg += `\n⚠️ **${kuerzungenCount} Kürzung(en)** erkannt!\n`;
    for (const ep of matchResults) {
      for (const k of (ep.kuerzungen || [])) {
        msg += `• ${k.betrag}€: ${(k.begruendung || '(ohne Begründung)').slice(0, 80)}\n`;
      }
    }
  }

  const abgeschlossen = periodenBewertung?.abgeschlossen || [];
  const restperioden = periodenBewertung?.restperioden || [];
  if (abgeschlossen.length > 0) {
    msg += `\n✅ **${abgeschlossen.length} Abrechnungsperiode(n)** abgeschlossen`;
  }
  if (restperioden.length > 0) {
    msg += `\n↪️ **${restperioden.length} Restperiode(n)** für nicht abgerechnete Rechnungen angelegt:\n`;
    for (const r of restperioden) {
      msg += `• ${r.person}/${r.kostentraeger}: Periode ${r.periode} aus ${r.ursprungsperiode} (${r.anzahl} Rg.)\n`;
    }
  }

  if (ebData.hinweise) {
    msg += `\n📝 Hinweise: ${ebData.hinweise.slice(0, 200)}`;
  }

  return msg;
}

// ── Manuelle Zuordnungs-Korrekturen ──────────────────────────────────────────
// Ermöglicht dem Nutzer, die (auto-gematchten) Verknüpfungen nachträglich zu
// korrigieren: EBP ↔ Arztrechnung (ganze Rechnung) und Kürzung ↔ Einzelposition (AEP).
// Alle Multi-Statement-Operationen laufen transaktional; Fehler tragen ein
// `.status`-Feld für saubere HTTP-Codes.

function httpError(message, status) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/**
 * Berechnet EBP.kuerzungsbetrag als Summe der zugehörigen Einzel-Kürzungen neu.
 * `db` ist ein Transaktions-Client (oder der Pool).
 */
async function recalcEbpKuerzung(db, ebPostid, ebSubid) {
  await db.query(
    `UPDATE postbuch.erstattungsbescheid_einzelposition ep
        SET kuerzungsbetrag = (
          SELECT COALESCE(SUM(k.kuerzungsbetrag), 0)
          FROM postbuch.erstattungsbescheid_kuerzung k
          WHERE k.postid = ep.postid AND k.eb_subid = ep.subid
        )
      WHERE ep.postid = $1 AND ep.subid = $2`,
    [ebPostid, ebSubid]
  );
}

/**
 * Prüft, ob (arzPostid, arzSubid) eine existierende Arztrechnung-Einzelposition ist.
 */
async function assertAepExists(db, arzPostid, arzSubid) {
  const r = await db.query(
    `SELECT 1 FROM postbuch.arztrechnung_einzelposition WHERE postid = $1 AND subid = $2`,
    [arzPostid, arzSubid]
  );
  if (r.rows.length === 0) {
    throw httpError(`Einzelposition ${arzPostid}-${arzSubid} existiert nicht`, 400);
  }
}

/**
 * Setzt oder löst die Zuordnung einer Erstattungsbescheid-Position (EBP) zu einer
 * (ganzen) Arztrechnung. `arzPostid = null` löst die Zuordnung.
 * Konsistenz: Die Kind-Kürzungen dieser EBP folgen der neuen Rechnung (arz_postid)
 * und verlieren ihren Positions-Link (arz_subid → NULL), da alte Positionen zu einer
 * anderen Rechnung gehören.
 */
export async function setEbpZuordnung(ebPostid, ebSubid, arzPostid, restoreKuerzungenArzSubid = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const epRes = await client.query(
      `SELECT arz_postid FROM postbuch.erstattungsbescheid_einzelposition
        WHERE postid = $1 AND subid = $2 FOR UPDATE`,
      [ebPostid, ebSubid]
    );
    if (epRes.rows.length === 0) throw httpError('Erstattungsbescheid-Position nicht gefunden', 404);
    const prevArzPostid = epRes.rows[0].arz_postid;

    if (arzPostid != null) {
      const arzRes = await client.query(
        `SELECT EXISTS (
                  SELECT 1 FROM postbuch.postbuch WHERE postid = $1
                ) AS dokument_existiert,
                EXISTS (
                  SELECT 1 FROM postbuch.arztrechnung WHERE postid = $1
                ) AS ist_arztrechnung`,
        [arzPostid]
      );
      if (!arzRes.rows[0].dokument_existiert) throw httpError(`Dokument ${arzPostid} nicht gefunden`, 404);
      if (!arzRes.rows[0].ist_arztrechnung) {
        throw httpError(`${arzPostid} ist keine Arztrechnung`, 400);
      }
    }

    await client.query(
      `UPDATE postbuch.erstattungsbescheid_einzelposition
          SET arz_postid = $3::text,
              ohne_rechnungsbezug_bestaetigt_am = CASE WHEN $3::text IS NOT NULL THEN NULL ELSE ohne_rechnungsbezug_bestaetigt_am END,
              ohne_rechnungsbezug_bestaetigt_von = CASE WHEN $3::text IS NOT NULL THEN NULL ELSE ohne_rechnungsbezug_bestaetigt_von END
        WHERE postid = $1 AND subid = $2`,
      [ebPostid, ebSubid, arzPostid]
    );

    // Bisherige Positionsbezüge der Kind-Kürzungen sichern, BEVOR sie zurückgesetzt werden –
    // wird dem Aufrufer zurückgegeben, damit ein Undo sie gezielt wiederherstellen kann.
    const kRes = await client.query(
      `SELECT kuerzung_id, arz_subid FROM postbuch.erstattungsbescheid_kuerzung
        WHERE postid = $1 AND eb_subid = $2`,
      [ebPostid, ebSubid]
    );
    const prevKuerzungenArzSubid = kRes.rows.map(r => ({ kuerzung_id: r.kuerzung_id, arz_subid: r.arz_subid }));

    if (Array.isArray(restoreKuerzungenArzSubid) && restoreKuerzungenArzSubid.length > 0) {
      // Undo-Pfad: arz_subid pro Kürzung gezielt wiederherstellen statt pauschal zu nullen
      for (const { kuerzung_id, arz_subid } of restoreKuerzungenArzSubid) {
        await client.query(
          `UPDATE postbuch.erstattungsbescheid_kuerzung
              SET arz_postid = $3::text, arz_subid = $4
            WHERE postid = $1 AND kuerzung_id = $2`,
          [ebPostid, kuerzung_id, arzPostid, arz_subid]
        );
      }
    } else {
      // Kind-Kürzungen konsistent halten (arz_postid folgt, Positions-Link zurücksetzen)
      await client.query(
        `UPDATE postbuch.erstattungsbescheid_kuerzung
            SET arz_postid = $3::text, arz_subid = NULL
          WHERE postid = $1 AND eb_subid = $2`,
        [ebPostid, ebSubid, arzPostid]
      );
    }

    // Zuordnung geändert → betroffene Abrechnungsperioden im selben Zug neu
    // bewerten. Rücknahme + Bewertung sind idempotent, ein Undo führt also
    // zurück auf genau den vorherigen Periodenstand.
    const periodenBewertung = await bewertePeriodenNachBescheid(ebPostid, {
      grund: 'manuelle-zuordnung', db: client,
    });

    await client.query('COMMIT');
    uiLog('UPDATE', 'erstattungsbescheid', ebPostid,
      `EBP ${ebSubid}: Rechnung ${prevArzPostid || '(keine)'} → ${arzPostid || '(gelöst)'}`);
    return {
      arz_postid: arzPostid,
      prev_arz_postid: prevArzPostid,
      prev_kuerzungen_arz_subid: prevKuerzungenArzSubid,
      perioden_bewertung: periodenBewertung,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Legt eine neue Kürzung unter einer EBP an. Der Rechnungsbezug (arz_postid) wird
 * aus der EBP abgeleitet (nicht vom Client). `arzSubid` verknüpft optional eine
 * konkrete Einzelposition dieser Rechnung. Danach wird EBP.kuerzungsbetrag neu berechnet.
 */
export async function addKuerzung(ebPostid, ebSubid, { kuerzungsbetrag, begruendung = null, arzSubid = null, arzPostidHint = null }) {
  const betrag = Number(kuerzungsbetrag);
  if (!Number.isFinite(betrag)) throw httpError('Ungültiger Kürzungsbetrag', 400);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const epRes = await client.query(
      `SELECT arz_postid FROM postbuch.erstattungsbescheid_einzelposition
        WHERE postid = $1 AND subid = $2 FOR UPDATE`,
      [ebPostid, ebSubid]
    );
    if (epRes.rows.length === 0) throw httpError('Erstattungsbescheid-Position nicht gefunden', 404);
    const arzPostid = epRes.rows[0].arz_postid;

    if (arzSubid != null) {
      if (!arzPostid) throw httpError('Positions-Zuordnung nicht möglich: EBP hat keine verknüpfte Rechnung', 400);
      if (arzPostidHint && arzPostidHint !== arzPostid) {
        throw httpError(`Positions-Token gehört zu ${arzPostidHint}, die EBP ist aber ${arzPostid} zugeordnet`, 400);
      }
      await assertAepExists(client, arzPostid, arzSubid);
    }

    const ins = await client.query(
      `INSERT INTO postbuch.erstattungsbescheid_kuerzung
         (postid, eb_subid, arz_postid, arz_subid, kuerzungsbetrag, begruendung)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING kuerzung_id`,
      [ebPostid, ebSubid, arzPostid, arzSubid, betrag, begruendung || null]
    );

    await recalcEbpKuerzung(client, ebPostid, ebSubid);
    await client.query('COMMIT');
    uiLog('CREATE', 'erstattungsbescheid', ebPostid, `Kürzung +${betrag}€ zu EBP ${ebSubid}`);
    return { kuerzung_id: ins.rows[0].kuerzung_id, eb_subid: ebSubid, arz_postid: arzPostid };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Ändert Betrag, Begründung und/oder Positions-Zuordnung (arzSubid) einer Kürzung.
 * `arzSubid` wird gegen die Rechnung der zugehörigen EBP validiert. Bei Betragsänderung
 * wird EBP.kuerzungsbetrag neu berechnet.
 */
export async function updateKuerzung(ebPostid, kuerzungId, fields) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const kRes = await client.query(
      `SELECT k.eb_subid, ep.arz_postid
         FROM postbuch.erstattungsbescheid_kuerzung k
         JOIN postbuch.erstattungsbescheid_einzelposition ep
           ON ep.postid = k.postid AND ep.subid = k.eb_subid
        WHERE k.postid = $1 AND k.kuerzung_id = $2
        FOR UPDATE OF k`,
      [ebPostid, kuerzungId]
    );
    if (kRes.rows.length === 0) throw httpError('Kürzung nicht gefunden', 404);
    const ebSubid = kRes.rows[0].eb_subid;
    const arzPostid = kRes.rows[0].arz_postid;

    const updates = [];
    const params = [];
    let idx = 1;

    if ('kuerzungsbetrag' in fields) {
      const betrag = Number(fields.kuerzungsbetrag);
      if (!Number.isFinite(betrag)) throw httpError('Ungültiger Kürzungsbetrag', 400);
      updates.push(`kuerzungsbetrag = $${idx++}`); params.push(betrag);
    }
    if ('begruendung' in fields) {
      updates.push(`begruendung = $${idx++}`); params.push(fields.begruendung || null);
    }
    if ('arzSubid' in fields) {
      const arzSubid = fields.arzSubid;
      if (arzSubid != null) {
        if (!arzPostid) throw httpError('Positions-Zuordnung nicht möglich: EBP hat keine verknüpfte Rechnung', 400);
        if (fields.arzPostidHint && fields.arzPostidHint !== arzPostid) {
          throw httpError(`Positions-Token gehört zu ${fields.arzPostidHint}, die EBP ist aber ${arzPostid} zugeordnet`, 400);
        }
        await assertAepExists(client, arzPostid, arzSubid);
        updates.push(`arz_postid = $${idx++}`); params.push(arzPostid);
      }
      updates.push(`arz_subid = $${idx++}`); params.push(arzSubid);
    }

    if (updates.length === 0) throw httpError('Keine aktualisierbaren Felder angegeben', 400);

    params.push(ebPostid, kuerzungId);
    await client.query(
      `UPDATE postbuch.erstattungsbescheid_kuerzung SET ${updates.join(', ')}
        WHERE postid = $${idx++} AND kuerzung_id = $${idx++}`,
      params
    );

    if ('kuerzungsbetrag' in fields) await recalcEbpKuerzung(client, ebPostid, ebSubid);
    await client.query('COMMIT');
    uiLog('UPDATE', 'erstattungsbescheid', ebPostid, `Kürzung ${kuerzungId} (EBP ${ebSubid}) geändert`);
    return { eb_subid: ebSubid, arz_postid: arzPostid };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Löscht eine Kürzung (z. B. fälschlich als solche erkannt) und berechnet
 * EBP.kuerzungsbetrag neu.
 */
export async function deleteKuerzung(ebPostid, kuerzungId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Eine VORGEMERKTE PKV-Prüfvormerkung blockiert per FK (bkpp_kuerzung_fkey,
    // ON DELETE RESTRICT) das Löschen der Kürzung. Hier gewollt löschbar (die
    // Vormerkung entfällt als Nebeneffekt, die UI warnt vorher per Bestätigungs-
    // dialog) — nur EINGEREICHT bleibt über den Trigger
    // fn_block_kuerzung_delete_with_pruefung gesperrt. Während einer aktiven
    // Abrechnungssession blockiert fn_block_bkpp_write_during_session dieses
    // DELETE zusätzlich.
    await client.query(
      `DELETE FROM postbuch.beihilfe_kuerzung_pkv_pruefung
        WHERE eb_postid = $1 AND kuerzung_id = $2 AND status = 'VORGEMERKT'`,
      [ebPostid, kuerzungId]
    );
    const kRes = await client.query(
      `DELETE FROM postbuch.erstattungsbescheid_kuerzung
        WHERE postid = $1 AND kuerzung_id = $2 RETURNING eb_subid, arz_postid`,
      [ebPostid, kuerzungId]
    );
    if (kRes.rows.length === 0) throw httpError('Kürzung nicht gefunden', 404);
    const ebSubid = kRes.rows[0].eb_subid;
    await recalcEbpKuerzung(client, ebPostid, ebSubid);
    await client.query('COMMIT');
    uiLog('DELETE', 'erstattungsbescheid', ebPostid, `Kürzung ${kuerzungId} (EBP ${ebSubid}) gelöscht`);
    return { eb_subid: ebSubid, arz_postid: kRes.rows[0].arz_postid };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.constraint === 'kuerzung_eingereicht_delete_guard') throw httpError(err.message, 409);
    throw err;
  } finally {
    client.release();
  }
}
