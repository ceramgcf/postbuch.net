/**
 * lib/text-extractor.js — PDF-Textextraktion für den Büroassistenten
 *
 * Stufenmodell:
 *   1. Ghostscript txtwrite (kostenlos) — wenn die PDF eine Textebene hat
 *   2. LLM-Vision über das konfigurierte Recherche-Modell des Assistenten
 *      (chat_model_research, kostenpflichtig) — für Scans ohne Textebene
 *      oder wenn der Aufrufer eine gezielte Frage stellt
 *
 * Ergebnis wird in postbuch.document_text_cache gecacht (Volltext) bzw.
 * postbuch.document_vision_cache (Vision-Antwort je Dokument+Frage).
 */

import { createHash } from 'crypto';
import { erkenneScanMitTextebene, countPdfPages, extractTextLayer, renderPdfToImages } from './pdf.js';
import { callLLM, buildCostMap, calculateCost, resolveKlassenModell, capsForRef, providerForRef, kannPdfEmpfangen } from './llm.js';
import { loadDynamicSettings } from '../config.js';
import pool from '../db.js';

// Was im Cache landet (großzügig — verhindert nur absurden DB-Bloat bei
// Riesendokumenten) vs. was tatsächlich an ein Modell geht (Kontext-Budget,
// siehe extractRelevantExcerpt). Getrennte Grenzen, weil vorher blind auf
// MODEL_MAX_CHARS truncateter Text auch im Cache landete — ein späteres
// Anheben der Modell-Grenze hätte alte Cache-Einträge nie erreicht.
const CACHE_MAX_CHARS = 100_000;
const MODEL_MAX_CHARS = 16_000;
// Eigene Grenze des Büroassistenten — bewusst NICHT das Rasterlimit eines
// Providers, auch wenn die Zahl heute dieselbe ist. Hier löst ein beliebiger
// Nutzer per Chat/MCP die Extraktion aus, bei focused_question ungecacht und
// ohne Pipeline-Queue; die Zahl deckelt Kosten und Umfang genau dieses Pfades.
// Sie darf nicht mitwachsen, wenn ein Admin `rasterMaxSeiten` eines lokalen
// Providers anhebt.
const VISION_MAX_PAGES = 8;

/**
 * Löst das Recherche-Modell auf und klärt, wie das Dokument dort ankommt.
 *
 * `seitenLimit` ist das Minimum aus der Assistenten-Grenze und — nur im
 * Rasterfall — dem Provider-Limit. So laufen Vorprüfung und Render garantiert
 * gegen dieselbe Zahl: sonst käme bei einem Provider mit `rasterMaxSeiten: 4`
 * ein 6-seitiges PDF durch die Prüfung und landete still auf 4 Seiten gekürzt
 * beim Modell.
 */
async function visionKontext(settings) {
  const s = settings || await loadDynamicSettings();
  // Gleiches Modell wie der Research-Agent, der dieses Tool aufruft — die
  // Nutzer-Konfiguration (Settings → Büroassistent: Recherche) gilt auch für
  // das visuelle Lesen.
  const cfg = resolveKlassenModell('chat_research', s);
  // Ein Provider ohne pdf-Cap kann kein PDF direkt lesen — bekommt aber, wenn
  // er vision beherrscht (und über den OpenAI-kompatiblen Adapter läuft),
  // die Seiten gerastert. Ohne beides käme der Aufruf entweder mit einem
  // Fehler oder, schlimmer, mit einer Halluzination zurück.
  const caps = capsForRef(s, cfg);
  const pdfFaehig = kannPdfEmpfangen(caps);
  const prov = providerForRef(s, cfg);
  const bilderFaehig = !pdfFaehig && caps?.vision === true && prov?.typ === 'openai-compatible';
  const rasterLimit = bilderFaehig ? (prov.rasterMaxSeiten ?? VISION_MAX_PAGES) : VISION_MAX_PAGES;
  return { s, cfg, pdfFaehig, bilderFaehig, seitenLimit: Math.min(VISION_MAX_PAGES, rasterLimit) };
}

function questionHash(question) {
  return createHash('sha256').update(String(question || '').trim().toLowerCase()).digest('hex');
}

async function getCachedVisionAnswer(postid, question) {
  const r = await pool.query(
    `SELECT answer FROM postbuch.document_vision_cache WHERE postid = $1 AND question_hash = $2`,
    [postid, questionHash(question)]
  );
  return r.rows.length > 0 ? r.rows[0].answer : null;
}

async function setCachedVisionAnswer(postid, question, answer) {
  await pool.query(
    `INSERT INTO postbuch.document_vision_cache (postid, question_hash, question, answer)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (postid, question_hash) DO UPDATE SET answer = $4, created_at = now()`,
    [postid, questionHash(question), String(question || '').slice(0, 2000), answer]
  );
}

/**
 * Liest ein PDF via LLM-Vision und extrahiert den Inhalt als Plaintext.
 * Bei focusedQuestion wird direkt die Antwort auf die Frage zurückgegeben
 * statt einer generischen Textextraktion — und je postid+Frage gecacht
 * (identische Nachfrage zu einem Dokument kostet so nur beim ersten Mal).
 */
async function extractViaVision(postid, pdfBuffer, focusedQuestion, ctx, meta) {
  if (focusedQuestion) {
    const cached = await getCachedVisionAnswer(postid, focusedQuestion).catch(() => null);
    if (cached != null) return { text: cached, costUsd: null };
  }

  const prompt = focusedQuestion
    ? `Beantworte folgende Frage anhand des Dokuments präzise und kompakt (max. 500 Wörter):\n\n${focusedQuestion}`
    : `Extrahiere den gesamten Text dieses Dokuments als strukturierten Plaintext. Behalte die logische Struktur (Absätze, Listen, Tabellen als Text-Tabellen). Maximal ${CACHE_MAX_CHARS} Zeichen.`;

  const { s, cfg, pdfFaehig, bilderFaehig, seitenLimit } = ctx;
  const model = cfg.model;
  const costMap = buildCostMap(s);

  if (!pdfFaehig && !bilderFaehig) {
    console.warn(`[text-extractor] Recherche-Modell (${model}) kann weder PDF noch Bilder verarbeiten — Vision-Extraktion übersprungen`);
    return { text: null, costUsd: null };
  }

  try {
    let callOpts;
    if (pdfFaehig) {
      callOpts = { pdf: pdfBuffer, maxTokens: 2048 };
    } else {
      const { bilder } = await renderPdfToImages(pdfBuffer, { maxSeiten: seitenLimit, strikt: false });
      // Ohne Bild-Block ginge der Prompt raus und das Modell antwortete aus dem
      // Nichts — lieber gar keine Extraktion als eine erfundene.
      if (!bilder.length) throw new Error('Rastern lieferte keine Bilder');
      callOpts = { bilder, maxTokens: 2048 };
    }
    const result = await callLLM(cfg, prompt, callOpts, s, {
      ...(meta || {}),
      kategorie: 'chat',
      costMap,
    });
    if (focusedQuestion && result.text) {
      await setCachedVisionAnswer(postid, focusedQuestion, result.text).catch(() => {});
    }
    return { text: result.text, costUsd: calculateCost(model, result.usage?.inputTokens ?? 0, result.usage?.outputTokens ?? 0, costMap) };
  } catch (err) {
    console.warn('[text-extractor] Vision-Extraktion fehlgeschlagen:', err.message);
    return { text: null, costUsd: null };
  }
}

/**
 * Gibt gecachten Text aus document_text_cache zurück (oder null).
 */
async function getCached(postid) {
  const r = await pool.query(
    `SELECT extracted_text, extraction_method FROM postbuch.document_text_cache WHERE postid = $1`,
    [postid]
  );
  if (r.rows.length === 0) return null;
  return r.rows[0];
}

async function setCached(postid, extractedText, extractionMethod) {
  const capped = extractedText ? extractedText.slice(0, CACHE_MAX_CHARS) : extractedText;
  await pool.query(
    `INSERT INTO postbuch.document_text_cache (postid, extracted_text, extraction_method, char_count)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (postid) DO UPDATE
       SET extracted_text = $2, extraction_method = $3, char_count = $4, extracted_at = now()`,
    [postid, capped, extractionMethod, capped?.length ?? 0]
  );
}

/**
 * Bedient get_document_text komplett aus dem Cache — OHNE PDF-Download/-Parse
 * (retrieveDocument, countPdfPages). null = Cache-Miss, Aufrufer muss das PDF
 * holen und extractDocumentText frisch laufen lassen. pageCount ist im
 * Cache-Fast-Path bewusst null (würde das PDF erfordern, dessen Vermeidung ja
 * der Zweck dieses Pfades ist) — der Tool-Description verspricht keine
 * garantierte Seitenzahl.
 */
export async function serveCachedText(postid, textQuestion = null) {
  const cached = await getCached(postid);
  if (!cached) return null;
  if (cached.extraction_method === 'not_extractable') {
    return { text: null, method: 'not_extractable', pageCount: null, costUsd: null };
  }
  return {
    text: applyModelBudget(cached.extracted_text, textQuestion),
    method: cached.extraction_method,
    pageCount: null,
    costUsd: null,
  };
}

function applyModelBudget(text, textQuestion) {
  if (!text) return null;
  return textQuestion ? extractRelevantExcerpt(text, textQuestion, MODEL_MAX_CHARS) : text.slice(0, MODEL_MAX_CHARS);
}

/**
 * Wählt bei zu langem Text lokal (ohne LLM-Aufruf) die relevantesten Absätze
 * zu einer Frage aus, statt blind die ersten maxChars Zeichen zu liefern.
 * Simple Keyword-Overlap-Bewertung pro Absatz (Bag-of-Words, Stichwörter ≥3
 * Zeichen aus der Frage) — kein Ersatz für echtes Ranking, aber kostenlos und
 * für "wo im 40-seitigen Vertrag steht X" deutlich besser als Kopf-Truncation.
 */
function extractRelevantExcerpt(text, question, maxChars) {
  if (!text || text.length <= maxChars) return text;

  const keywords = String(question || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3);

  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim().length > 0);
  if (keywords.length === 0 || paragraphs.length <= 1) return text.slice(0, maxChars);

  const scored = paragraphs.map((p, i) => {
    const lower = p.toLowerCase();
    let score = 0;
    for (const kw of keywords) score += lower.split(kw).length - 1;
    return { i, p, score };
  });

  const budget = maxChars - 200; // Platz für den Hinweis-Header lassen
  const picked = [];
  let used = 0;
  for (const item of [...scored].sort((a, b) => b.score - a.score)) {
    if (item.score === 0 && picked.length > 0) break;
    if (used + item.p.length > budget && picked.length > 0) continue;
    picked.push(item);
    used += item.p.length;
    if (used >= budget) break;
  }
  if (picked.length === 0) return text.slice(0, maxChars);

  picked.sort((a, b) => a.i - b.i);
  const header = `[Dokument ist länger als ${maxChars} Zeichen — relevanteste Abschnitte zu "${question}" ausgewählt, nicht der komplette Text. Bei Bedarf gezielter nachfragen.]\n\n`;
  return (header + picked.map((x) => x.p).join('\n\n')).slice(0, maxChars);
}

/**
 * Extrahiert Text eines Dokuments aus dem Cache oder frisch.
 *
 * @param {string}  postid
 * @param {Buffer}  pdfBuffer          - PDF als Buffer
 * @param {object}  [opts]
 * @param {string}  [opts.focusedQuestion] - Löst IMMER Vision aus (nicht gecacht als Volltext, siehe document_vision_cache)
 * @param {string}  [opts.textQuestion]    - Optional bei get_document_text: steuert nur, WELCHER Ausschnitt eines
 *   zu langen (Ghostscript-)Textes zurückgegeben wird (lokale Relevanz-Auswahl statt Kopf-Truncation). Löst KEIN
 *   LLM/Vision aus — reiner Textzuschnitt.
 * @param {object}  [opts.settings]
 * @param {object}  [opts.meta]
 * @returns {{ text: string|null, method: string, pageCount: number, costUsd: number|null }}
 */
export async function extractDocumentText(postid, pdfBuffer, opts = {}) {
  const { focusedQuestion = null, textQuestion = null, settings = null, meta = null } = opts;
  const pageCount = await countPdfPages(pdfBuffer).catch(() => 1);

  // Bei focused_question niemals Ghostscript-Cache nutzen — Vision antwortet direkt
  if (focusedQuestion) {
    const ctx = await visionKontext(settings);
    if (pageCount > ctx.seitenLimit) {
      return {
        text: `[PDF hat ${pageCount} Seiten — zu lang für Vision-Analyse (Limit: ${ctx.seitenLimit}). Nur Metadaten verfügbar.]`,
        method: 'too_long',
        pageCount,
        costUsd: null,
      };
    }
    const { text, costUsd } = await extractViaVision(postid, pdfBuffer, focusedQuestion, ctx, meta);
    return { text: text ?? null, method: 'llm_vision', pageCount, costUsd };
  }

  // Ohne focusedQuestion: Cache prüfen
  const cached = await getCached(postid);
  if (cached) {
    if (cached.extraction_method === 'not_extractable') {
      return { text: null, method: 'not_extractable', pageCount, costUsd: null };
    }
    return {
      text: cached.extracted_text ? applyModelBudget(cached.extracted_text, textQuestion) : null,
      method: cached.extraction_method,
      pageCount,
      costUsd: null,
    };
  }

  // Kein Cache: Ghostscript-Versuch
  const { hatTextebene } = await erkenneScanMitTextebene(pdfBuffer).catch(() => ({ hatTextebene: false }));

  if (hatTextebene) {
    const rawText = await extractTextLayer(pdfBuffer);
    if (rawText && rawText.replace(/\s+/g, '').length >= 20) {
      await setCached(postid, rawText, 'ghostscript');
      return { text: applyModelBudget(rawText, textQuestion), method: 'ghostscript', pageCount, costUsd: null };
    }
  }

  // Kein Ghostscript-Text: Vision-Fallback (nur innerhalb des Seitenlimits)
  const ctx = await visionKontext(settings);
  if (pageCount > ctx.seitenLimit) {
    await setCached(postid, null, 'not_extractable');
    return {
      text: `[PDF hat ${pageCount} Seiten — zu lang für automatische Textextraktion. Nur Metadaten verfügbar.]`,
      method: 'not_extractable',
      pageCount,
      costUsd: null,
    };
  }

  const { text: visionText, costUsd } = await extractViaVision(postid, pdfBuffer, null, ctx, meta);
  if (visionText && visionText.trim().length > 20) {
    await setCached(postid, visionText, 'llm_vision');
    return { text: applyModelBudget(visionText, textQuestion), method: 'llm_vision', pageCount, costUsd };
  }

  await setCached(postid, null, 'not_extractable');
  return { text: null, method: 'not_extractable', pageCount, costUsd: null };
}
