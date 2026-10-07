/**
 * lib/llm.js — Unified LLM-Client mit Fallback-Kette (Facade)
 *
 * Der Dateiname und ALLE Exporte bleiben stabil — die ~10 Aufrufstellen im
 * System wurden beim Provider-Umbau nicht angefasst. Die eigentlichen
 * HTTP-Adapter liegen seit 1.7.0 in:
 *
 *   lib/llm/registry.js            providerId → { typ, baseUrl, apiKey, caps }
 *   lib/llm/providers/anthropic.js Anthropic Messages API + Content-Builder
 *   lib/llm/providers/bedrock.js   AWS Bedrock (teilt die Builder mit anthropic)
 *   lib/llm/providers/openai.js    OpenAI-kompatibel, parametrisiert mit baseUrl
 *                                  (OpenAI, Ollama, LM Studio, vLLM, OpenRouter …)
 *
 * Konfiguration: _settings.llm_providers + _settings.llm_provider_key_<id>.
 * Kein direkter process.env-Zugriff (Ausnahme: Bedrock-ENV-Fallback im Bestand).
 */

import { loadDynamicSettings } from '../config.js';
import { appLog } from '../app-log.js';
import * as tracker from '../jobs/tracker.js';
import pool from '../db.js';
import {
  PRE_ANALYSIS_SYSTEM_PROMPT,
  PRE_ANALYSIS_USER_MESSAGE,
} from '../prompts/pre-analysis.js';
import { countPdfPages, stripTextLayer, extractTextLayer, renderPdfToImages, RASTER_MAX_SEITEN } from './pdf.js';
import { activeCacheTier, touchCacheMode } from './cache-mode.js';
import { subscriptionFeatureUnlocked, callClaudeSubscription, isInsideAgentSubprocess } from './claude-subscription.js';
import { getProvider, listProviders, BUILTIN_PROVIDER_IDS, kannPdfEmpfangen, permanentError, KEINE_CAPS, clampMaxTokens, MAX_TOKENS_NOTFALL } from './llm/registry.js';
import { callAnthropic, buildAnthropicUserContent } from './llm/providers/anthropic.js';
import { callBedrock, getBedrockClient } from './llm/providers/bedrock.js';
import { callOpenAI } from './llm/providers/openai.js';
import { werkseinstellung } from './llm/empfehlungs-standard.js';
import { MODEL_CLASSES } from './llm/model-classes.js';
import { gleichesModell } from './llm/modell-id.js';

export { getBedrockClient };
export { listProviders, getProvider, kannPdfEmpfangen, kannDokumentSehen } from './llm/registry.js';

// Prompt-Cache-Preise stehen je Modell in llm_cost_<model-id> (siehe unten),
// nicht als pauschaler Multiplikator: Das Verhältnis zum Input-Preis ist je
// Anbieter und Modell verschieden. Anthropic, Bedrock und OpenAI melden die
// Cache-Klassen getrennt; lokale Provider haben typischerweise gar keinen
// llm_cost_*-Eintrag ⇒ calculateCost gibt null zurück.

// Mindestmenge an verwertbarem Text, damit ein Text-only-Provider überhaupt
// aufgerufen wird. Darunter: harter Fehler statt Aufruf mit leerem Prompt —
// die Fallback-Kette steigt dann ab, statt eine Halluzination zu liefern.
const MIN_TEXT_CHARS = 100;

// ── Preisberechnung aus Settings ──────────────────────────────────────────
// Preise werden aus den Settings gelesen: Schlüssel llm_cost_<model-id>,
// Wert { input_usd_per_1m, output_usd_per_1m, cache_write_usd_per_1m?,
// cache_read_usd_per_1m? } (Zahlen). Fehlende Input-/Output-Preise = kein
// Kosten-Tracking für dieses Modell. Fehlt ein Cache-Preis, werden diese Token
// wie normale Input-Token berechnet – ohne erfundenen Rabatt oder Aufschlag.

// API-Keys/Region aus den Settings (mit ENV-Fallback für Bedrock).
// Bleibt exportiert: service/chat-agent.js baut seine Requests weiter selbst.
export function buildKeys(s) {
  return {
    anthropicKey:  s.llm_anthropic_key,
    openaiKey:     s.llm_openai_key,
    bedrockKey:    s.llm_bedrock_key    || process.env.BEDROCK_API_KEY || process.env.AWS_BEARER_TOKEN_BEDROCK,
    bedrockRegion: s.llm_bedrock_region || process.env.BEDROCK_REGION  || process.env.AWS_REGION || 'eu-central-1',
    // Claude-Subscription (Agent SDK statt API-Key). Nur aktiv, wenn der globale
    // Toggle gesetzt UND das dev-Key-Feature freigeschaltet ist.
    claudeOauthToken:    s.llm_claude_oauth_token,
    subscriptionEnabled: s.llm_claude_subscription_enabled === true && subscriptionFeatureUnlocked(),
  };
}

export function buildCostMap(settings) {
  const s = settings || {};
  const map = {};
  for (const [key, val] of Object.entries(s)) {
    if (!key.startsWith('llm_cost_') || !val) continue;
    const model = key.slice('llm_cost_'.length);
    if (!model) continue;
    const inputUsd  = val.input_usd_per_1m  != null ? Number(val.input_usd_per_1m)  : null;
    const outputUsd = val.output_usd_per_1m != null ? Number(val.output_usd_per_1m) : null;
    if (inputUsd == null && outputUsd == null) continue;
    const cacheWriteUsd = val.cache_write_usd_per_1m != null ? Number(val.cache_write_usd_per_1m) : null;
    const cacheReadUsd  = val.cache_read_usd_per_1m  != null ? Number(val.cache_read_usd_per_1m)  : null;
    map[model] = {
      input: inputUsd ?? 0,
      output: outputUsd ?? 0,
      cacheWrite: Number.isFinite(cacheWriteUsd) ? cacheWriteUsd : null,
      cacheRead:  Number.isFinite(cacheReadUsd)  ? cacheReadUsd  : null,
    };
  }
  return map;
}

/**
 * Berechnet die Kosten eines LLM-Aufrufs in USD anhand der Preiskarte.
 * Gibt null zurück, wenn das Modell keine konfigurierten Preise hat.
 *
 * Zwei Aufruf-Formen (rückwärtskompatibel):
 *   calculateCost(model, inputTokens, outputTokens, costMap)                       — positional (Bestand)
 *   calculateCost(model, { tokensIn, tokensOut, cacheCreationTokens, cacheReadTokens }, costMap) — mit Cache
 */
export function calculateCost(model, a, b, c) {
  let tokensIn, tokensOut, cacheCreationTokens = 0, cacheReadTokens = 0, costMap;
  if (a !== null && typeof a === 'object') {
    ({ tokensIn = 0, tokensOut = 0, cacheCreationTokens = 0, cacheReadTokens = 0 } = a);
    costMap = b;
  } else {
    tokensIn = a; tokensOut = b; costMap = c;
  }
  if (tokensIn == null || tokensOut == null) return null;

  // Exakter Treffer, sonst Alias ↔ Snapshot (Datums-/Versions-Suffix, siehe
  // llm/modell-id.js). Kein bloßer Präfix: "claude-opus-5-5" darf nicht den
  // Preis von "claude-opus-5" bekommen.
  let pricing = costMap?.[model];
  if (!pricing && costMap) {
    const key = Object.keys(costMap).find((k) => gleichesModell(k, model));
    pricing = key ? costMap[key] : null;
  }
  if (!pricing) return null;

  const inputPrice      = pricing.input  ?? 0;
  const outputPrice     = pricing.output ?? 0;
  const cacheWritePrice = pricing.cacheWrite ?? inputPrice;
  const cacheReadPrice  = pricing.cacheRead  ?? inputPrice;
  const inputCost =
    Number(tokensIn || 0)              * inputPrice
    + Number(cacheCreationTokens || 0) * cacheWritePrice
    + Number(cacheReadTokens || 0)     * cacheReadPrice;
  const outputCost = Number(tokensOut || 0) * outputPrice;
  return (inputCost + outputCost) / 1_000_000;
}

// Schreibt einen LLM-Call in postbuch.llm_call_log. Fehler werden nur geloggt
// (Logging darf den eigentlichen Call nie failen lassen). `provider` ist die
// providerId und bewusst Freitext — ein Schema-Update pro neuem Provider wäre
// genau die Kopplung, die dieser Umbau beseitigt.
export async function logLlmCall({
  username = null,
  kategorie,
  provider,
  model,
  tokensIn = null,
  tokensOut = null,
  cacheCreationTokens = null,
  cacheReadTokens = null,
  costUsd = null,
  costUsdNotional = null,
  durationMs = null,
  success = true,
  errorMessage = null,
  entity = null,
  entityId = null,
  correlationId = null,
}) {
  try {
    await pool.query(
      `INSERT INTO llm_call_log
         (username, kategorie, provider, model,
          tokens_in, tokens_out, cache_creation_tokens, cache_read_tokens,
          cost_usd, cost_usd_notional, duration_ms,
          success, error_message, entity, entity_id, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [username, kategorie, provider, model,
       tokensIn, tokensOut, cacheCreationTokens, cacheReadTokens,
       costUsd, costUsdNotional, durationMs,
       success, errorMessage ? String(errorMessage).slice(0, 1000) : null,
       entity, entityId, correlationId],
    );
  } catch (err) {
    console.warn('[llm.logLlmCall] Persist-Fehler:', err.message);
  }
}

/**
 * LEGACY-FALLBACK. Leitet die providerId aus dem Modellnamen ab.
 *
 * Wird ausschließlich noch gebraucht, um Alt-Settings in String-Form
 * (llm_model_leicht = 'claude-haiku-4-5') auf eine providerId abzubilden. Die
 * vier Built-in-Provider tragen genau deshalb reservierte IDs, die identisch zu
 * ihren früheren Typnamen sind.
 *
 * NICHT für die Provider-Auswahl im Aufrufpfad verwenden: zwei Ollama-Hosts mit
 * demselben `llama3.3` sind über den Modellnamen prinzipiell nicht
 * unterscheidbar. Dafür trägt jede Modellkonfiguration eine explizite providerId.
 */
export function providerFromModel(model) {
  if (!model) return 'unknown';
  if (model.startsWith('claude-')) return 'anthropic';
  // Bedrock-Anthropic-IDs: eu.anthropic.claude-…, us.anthropic.…, global.anthropic.…, anthropic.…
  if (/anthropic\./i.test(model)) return 'bedrock';
  if (model.startsWith('gpt-') || model.startsWith('o')) return 'openai';
  return 'unknown';
}

// Hilfsfunktion für Wartezeiten
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Wie sleep(), aber in kurzen Schritten, damit ein zwischenzeitlicher
// Job-Abbruch (Nutzer klickt "Abbrechen") nicht erst nach der vollen
// Retry-Wartezeit (bis zu 10 Minuten) wirkt. jobId ist optional — ohne
// jobId (z. B. Aufrufe außerhalb der Job-Pipeline) verhält sich das wie
// ein normales sleep().
const CANCEL_POLL_MS = 5000;
async function cancellableSleep(ms, jobId) {
  let waited = 0;
  while (waited < ms) {
    if (jobId && tracker.isCancelled(jobId)) throw new tracker.CancellationError();
    const step = Math.min(CANCEL_POLL_MS, ms - waited);
    await sleep(step);
    waited += step;
  }
}

// Retry-Konfiguration
const PRE_ANALYSIS_RETRY_COUNT    = 3;               // Voranalyse: 3 Retries (4 Versuche gesamt)
const PRE_ANALYSIS_RETRY_DELAY_MS = 5 * 60 * 1000;  // 5 Minuten Wartezeit zwischen Voranalyse-Versuchen
const ANALYSIS_RETRY_DELAY_MS     = 10 * 60 * 1000; // 10 Minuten Wartezeit vor Ketten-Retry

/**
 * Normalisiert alle drei Wertformen einer Modellkonfiguration auf
 * `{ providerId, model }`:
 *   'claude-haiku-4-5'                      (String, Altbestand)
 *   { provider: 'openai', model: 'gpt-…' }  (Objekt, Altbestand)
 *   { providerId: 'ollama-keller', model }  (Objekt, neu)
 *
 * `provider` bleibt als Alias im Ergebnis, damit bestehende Leser
 * (chat-agent, ai-health, UI) unverändert funktionieren.
 */
export function resolveModelConfig(val, defaultProvider, defaultModel) {
  const mit = (providerId, model) => ({ providerId, model, provider: providerId });
  if (!val) return mit(defaultProvider, defaultModel);
  if (typeof val === 'object') {
    const id = val.providerId || val.provider || defaultProvider;
    return mit(id, val.model || defaultModel);
  }
  const id = String(val);
  const p = providerFromModel(id);
  return mit(p === 'unknown' ? (defaultProvider || 'openai') : p, id);
}

/**
 * Modellklasse (`key` aus MODEL_CLASSES) → konfiguriertes `{ providerId, model }`.
 *
 * Der Standard kommt aus der Klassendefinition und damit aus der ersten
 * Empfehlung der ausgelieferten llm-empfehlungen.json. Aufrufstellen sollen
 * **nie** eigene Modellnamen als Default mitgeben — genau so sind über die
 * Releases hinweg verstreute Altmodelle entstanden.
 */
export function resolveKlassenModell(klasseKey, settings) {
  const cls = MODEL_CLASSES.find((c) => c.key === klasseKey);
  if (!cls) return resolveModelConfig(null, undefined, undefined);
  return resolveModelConfig(settings?.[cls.settingKey], cls.provider, cls.model);
}

/** Anzeigename eines Kettenglieds: Built-ins nur als Modellname, sonst mit Provider. */
export function refLabel(ref) {
  if (!ref) return '—';
  const kanonisch = providerFromModel(ref.model);
  if (ref.providerId === kanonisch && BUILTIN_PROVIDER_IDS.includes(ref.providerId)) return ref.model;
  return `${ref.model} @ ${ref.providerId}`;
}

const refKey = (ref) => `${ref?.providerId}::${ref?.model}`;

/** Kette aus Refs bauen, Duplikate (gleicher Provider UND gleiches Modell) entfernen. */
function chainOf(...refs) {
  const seen = new Set();
  return refs.filter((r) => {
    if (!r || !r.model) return false;
    const k = refKey(r);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// Default-Provider/Modell je Stufe (identisch zu selectModelChain). Zentral, damit
// UI-Auswahllisten (Wiederverarbeitung) und die forcierte Analyse dieselben Werte
// auflösen.
const TIER_DEFAULTS = {
  leicht:    { setting: 'llm_model_leicht',    ...werkseinstellung() },
  mittel:    { setting: 'llm_model_mittel',    ...werkseinstellung() },
  schwierig: { setting: 'llm_model_schwierig', ...werkseinstellung() },
  large:     { setting: 'llm_model_large',     ...werkseinstellung() },
};

/**
 * Löst eine Modellstufe (leicht|mittel|schwierig|large) zum konfigurierten
 * { providerId, model } auf. Gibt null zurück für eine unbekannte Stufe.
 */
export function resolveTierModelConfig(tier, settings) {
  const def = TIER_DEFAULTS[tier];
  if (!def) return null;
  return resolveModelConfig(settings?.[def.setting], def.providerId, def.model);
}

function selectModelChain(difficulty, pages, settings) {
  const s = settings || {};
  // Werkseinstellung ist für JEDE Stufe dieselbe (siehe empfehlungs-standard.js).
  const stufe = (klasse, setting) => {
    const std = werkseinstellung();
    return resolveModelConfig(s[setting], std?.providerId, std?.model);
  };
  const leicht       = stufe('leicht',      'llm_model_leicht');
  const mittel       = stufe('mittel',      'llm_model_mittel');
  const schwierig    = stufe('schwierig',   'llm_model_schwierig');
  const fallback     = stufe('fallback',    'llm_model_fallback');
  const large        = stufe('large',       'llm_model_large');
  const preAnalysis  = stufe('preanalysis', 'llm_model_preanalysis');

  if (pages > 10)
    return { models: chainOf(large, leicht, fallback), reason: `Langes Dokument (${pages} Seiten)`, preAnalysisModel: preAnalysis };
  if (difficulty <= 0.25)
    return { models: chainOf(leicht, fallback), reason: `Einfach (difficulty=${difficulty})`, preAnalysisModel: preAnalysis };
  if (difficulty < 0.5)
    return { models: chainOf(mittel, leicht, fallback), reason: `Mittel (difficulty=${difficulty})`, preAnalysisModel: preAnalysis };
  return { models: chainOf(schwierig, mittel, fallback), reason: `Schwierig (difficulty=${difficulty})`, preAnalysisModel: preAnalysis };
}

// ──────────────────────────────────────────────────────────────
// Provider-Auflösung im Aufrufpfad
// ──────────────────────────────────────────────────────────────

/**
 * Provider-Eintrag zu einem Ref, inkl. Bedrock-Region und Legacy-Fallback über
 * den Modellnamen (falls eine providerId auf einen gelöschten Eintrag zeigt).
 */
export function providerForRef(settings, ref) {
  const s = settings || {};
  let eintrag = getProvider(s, ref?.providerId);
  if (!eintrag) {
    const legacy = providerFromModel(ref?.model);
    if (legacy !== 'unknown') eintrag = getProvider(s, legacy);
  }
  if (!eintrag) return null;
  if (eintrag.typ === 'bedrock') {
    return {
      ...eintrag,
      apiKey: eintrag.apiKey || process.env.BEDROCK_API_KEY || process.env.AWS_BEARER_TOKEN_BEDROCK || null,
      region: s.llm_bedrock_region || process.env.BEDROCK_REGION || process.env.AWS_REGION || 'eu-central-1',
    };
  }
  return eintrag;
}

/** Capabilities eines Refs — mit konservativem Default, wenn nichts auflösbar ist. */
export function capsForRef(settings, ref) {
  return providerForRef(settings, ref)?.caps || KEINE_CAPS;
}

// ──────────────────────────────────────────────────────────────
// Interner API-Aufruf
// ──────────────────────────────────────────────────────────────

/**
 * Sendet einen LLM-Aufruf an den aufgelösten Provider.
 *
 * @param {object|string} ref  - { providerId, model } oder Modell-ID (Legacy)
 * @param {string}  prompt     - User-seitiger Text-Prompt
 * @param {object}  opts       - { pdf, bilder, system, maxTokens, cacheSystem, jsonMode, zweck }
 *   `zweck: 'profilierung'` schaltet für Anthropic/OpenAI-kompatible Provider
 *   Thinking/reasoning_effort auf 'high' (Kostenträger-Profilierung, siehe
 *   lib/llm/thinking-policy.js). Ohne Angabe unverändertes Verhalten.
 * @param {object}  ctx        - { settings, keys }
 * @returns {Promise<{ text: string, usage: object }>}
 */
/**
 * Lehnt der Provider den Aufruf ab, WEIL max_tokens über der Ausgabegrenze des
 * Modells liegt? Bewusst zweistufig (Feldname UND ein Grenzwort), damit ein
 * beliebiger Fehlertext, der zufällig „max_tokens" enthält, keinen zweiten
 * bezahlten Aufruf auslöst. Anthropic nennt die Grenze im Klartext
 * („… > 8192, which is the maximum allowed number of output tokens"), OpenAI
 * meldet „max_tokens is too large"; lokale Server variieren.
 */
function istMaxTokensAblehnung(err) {
  const msg = String(err?.message || '');
  if (!/max_?tokens|max_completion_tokens/i.test(msg)) return false;
  return /maximum|too large|too many|exceed|greater than|out of range|zu groß|größer/i.test(msg);
}

async function callModel(ref, prompt, opts, ctx, meta = null) {
  const { pdf, pdfs, bilder, system, maxTokens: maxTokensWunsch = 8192, cacheSystem = false, jsonMode = false, zweck } = opts || {};
  const settings = ctx?.settings || {};
  const keys = ctx?.keys || buildKeys(settings);
  const m = meta || {};

  const modelRef = typeof ref === 'string' ? resolveModelConfig(ref, null, ref) : ref;
  const model = modelRef?.model;
  const provider = providerForRef(settings, modelRef);
  if (!provider) {
    throw permanentError(`Unbekannter LLM-Provider "${modelRef?.providerId}" für Modell "${model}"`);
  }
  // Aufrufer-Wunsch gegen die beim Provider deklarierte Ausgabegrenze deckeln.
  // Ohne hinterlegte Grenze bleibt der Wunsch unverändert – dann greift bei
  // einer Ablehnung durch die API der Rückfallversuch weiter unten.
  const maxTokens = clampMaxTokens(maxTokensWunsch, provider);
  const callOpts = { pdf, pdfs, bilder, system, maxTokens, cacheSystem, jsonMode, zweck };
  // Jeder Versuch nimmt optional einen abweichenden max_tokens-Wert entgegen,
  // damit der Rückfallversuch denselben Provider erneut fahren kann.
  const optsMit = (mt) => (mt ? { ...callOpts, maxTokens: mt } : callOpts);

  // Pro Modell eine kleine Versuchsliste („Rails"): Bei Anthropic-Modellen zuerst
  // übers Abo (gratis/pauschal), bei Fehler SEITWÄRTS dasselbe Modell über die
  // Anthropic-API (kostenpflichtig) — erst danach steigt die aufrufende
  // Fallback-Kette auf ein schwächeres Modell ab. So bleibt die gewählte Qualität
  // erhalten; es wird nur die Abrechnungsschiene gewechselt.
  const attempts = [];
  if (provider.typ === 'anthropic') {
    // Reentrancy-Guard: läuft dieser Aufruf bereits INNERHALB eines aktiven
    // Claude-Code-Subprozesses (z.B. ein get_document_pdf_vision-Tool-Aufruf
    // während eines laufenden Chat-Agent-Laufs, siehe claude-subscription.js),
    // NICHT nochmal über die Subscription gehen — der Cross-Session-Mutex dort
    // lässt genau 1 Subprozess zu, den der äußere Lauf bereits hält; ein
    // zweiter Versuch würde auf sich selbst warten (Deadlock). Stattdessen
    // direkt seitwärts auf die reguläre Anthropic-API (kostet für diesen
    // einen verschachtelten Call echtes API-Geld statt Abo-Pauschale).
    if (keys?.subscriptionEnabled && keys?.claudeOauthToken && !isInsideAgentSubprocess()) {
      attempts.push({
        provider: 'subscription', viaSubscription: true,
        run: (mt) => callClaudeSubscription(model, prompt, { pdf, pdfs, system, maxTokens: mt || maxTokens }, buildAnthropicUserContent, keys.claudeOauthToken),
      });
    }
    // Seitwärtsschritt / Primärpfad: dasselbe Modell über die Anthropic-API.
    // Bedrock taugt NICHT als Seitwärts-Ziel, da es andere Modell-IDs nutzt.
    attempts.push({
      provider: provider.id, viaSubscription: false,
      run: (mt) => callAnthropic(model, prompt, optsMit(mt), provider),
    });
  } else if (provider.typ === 'bedrock') {
    attempts.push({
      provider: provider.id, viaSubscription: false,
      run: (mt) => callBedrock(model, prompt, optsMit(mt), provider),
    });
  } else if (provider.typ === 'subscription') {
    attempts.push({
      provider: provider.id, viaSubscription: true,
      run: (mt) => callClaudeSubscription(model, prompt, { pdf, pdfs, system, maxTokens: mt || maxTokens }, buildAnthropicUserContent, provider.apiKey),
    });
  } else {
    attempts.push({
      provider: provider.id, viaSubscription: false,
      run: (mt) => callOpenAI(model, prompt, optsMit(mt), provider),
    });
  }

  const logAttempt = (att, result, error, t0) => {
    const tokensIn             = result?.usage?.inputTokens         ?? null;
    const tokensOut            = result?.usage?.outputTokens        ?? null;
    const cacheCreationTokens  = result?.usage?.cacheCreationTokens ?? null;
    const cacheReadTokens      = result?.usage?.cacheReadTokens     ?? null;
    logLlmCall({
      username:      m.username      ?? null,
      kategorie:     m.kategorie     ?? 'other',
      provider:      att.provider,
      model,
      tokensIn,
      tokensOut,
      cacheCreationTokens,
      cacheReadTokens,
      // Abo = Pauschaltarif: kein Pro-Token-Preis (costUsd=0). API/Bedrock werden
      // anhand der Token berechnet.
      costUsd:       att.viaSubscription
                       ? 0
                       : (result && m.costMap
                           ? calculateCost(model, { tokensIn, tokensOut, cacheCreationTokens, cacheReadTokens }, m.costMap)
                           : null),
      // Abo: fiktive API-Kosten (was der Call ohne Abo gekostet hätte) getrennt
      // festhalten, damit das Token-Log sie durchgestrichen/separat ausweisen kann.
      costUsdNotional: att.viaSubscription && result && m.costMap
                         ? calculateCost(model, { tokensIn, tokensOut, cacheCreationTokens, cacheReadTokens }, m.costMap)
                         : null,
      durationMs:    Date.now() - t0,
      success:       !error,
      errorMessage:  error?.message ?? null,
      entity:        m.entity        ?? null,
      entityId:      m.entityId      ?? null,
      correlationId: m.correlationId ?? null,
    });
  };

  let lastErr = null;
  for (let i = 0; i < attempts.length; i++) {
    const att = attempts[i];
    let t0 = Date.now();
    try {
      let result;
      try {
        result = await att.run();
      } catch (err) {
        // Ein zu großer max_tokens-Wunsch ist kein Modellversagen, sondern eine
        // Konfigurationslücke: der Provider hat keine deklarierte Ausgabegrenze
        // (maxOutputTokens) und lehnt den Wert ab. Statt die Kette auf ein
        // schwächeres Modell absteigen zu lassen, denselben Provider EINMAL mit
        // dem kleinsten gängigen Wert wiederholen.
        if (!istMaxTokensAblehnung(err) || maxTokens <= MAX_TOKENS_NOTFALL) throw err;
        logAttempt(att, null, err, t0);
        console.warn(`[llm] ${model} via ${att.provider}: max_tokens ${maxTokens} abgelehnt → Wiederholung mit ${MAX_TOKENS_NOTFALL}`);
        appLog('WARN', 'llm', `${model} via ${att.provider} lehnt max_tokens ${maxTokens} ab → einmalige Wiederholung mit ${MAX_TOKENS_NOTFALL}. Dauerhafte Abhilfe: beim Provider unter Einstellungen → KI-Anbieter ein „Limit für Antwort-Tokens" hinterlegen.`);
        t0 = Date.now();
        result = await att.run(MAX_TOKENS_NOTFALL);
      }
      logAttempt(att, result, null, t0);
      // Welche Schiene tatsächlich bedient hat → für die Kostenberechnung der
      // aufrufenden Schicht (analyzeDocument speichert ai_cost_usd entsprechend).
      result.viaSubscription = att.viaSubscription;
      result.provider = att.provider;
      return result;
    } catch (err) {
      logAttempt(att, null, err, t0);
      lastErr = err;
      const next = attempts[i + 1];
      if (next) {
        console.warn(`[llm] ${model} via ${att.provider} fehlgeschlagen (${err.message}) → Seitwärts via ${next.provider}`);
        // Observability: Ein übersprungener Rail-Fehler (klassisch: Abo-Session-Limit
        // VOR dem API-Seitwärtsschritt) landet sonst nur im Token-Log und wird im
        // App-Log vom nachfolgenden Fehler desselben Modells verdeckt.
        appLog('WARN', 'llm', `${model} via ${att.provider} fehlgeschlagen → Seitwärts via ${next.provider}: ${err.message}`);
      }
    }
  }
  throw lastErr;
}

// ──────────────────────────────────────────────────────────────
// JSON-Parsing
// ──────────────────────────────────────────────────────────────

/**
 * Extrahiert und parst das erste vollständige JSON-Objekt aus dem LLM-Response-Text.
 * Toleriert:
 *   - Markdown-Codeblöcke (```json ... ```)
 *   - Vor- oder nachgestellten Fließtext (z. B. eine Rechenerläuterung vor dem JSON)
 *   - Single-Quote statt Double-Quote (z.B. Claude Haiku bei fehlgeleitetem Prompt)
 *
 * @param {string} text
 * @param {{ erwartet?: 'objekt'|'array' }} [opts] - 'array' sucht `[ … ]` statt `{ … }`
 */
export function parseJsonFromText(text, { erwartet = 'objekt' } = {}) {
  // Markdown-Codeblöcke entfernen
  const cleaned = text
    .replace(/^```json\s*/m, '')
    .replace(/^```\s*/m, '')
    .replace(/```\s*$/m, '')
    .trim();

  const [auf, zu] = erwartet === 'array' ? ['[', ']'] : ['{', '}'];
  const start = cleaned.indexOf(auf);
  const end   = cleaned.lastIndexOf(zu);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`Kein JSON-${erwartet === 'array' ? 'Array' : 'Objekt'} in LLM-Antwort gefunden. Antwort: ${text.slice(0, 300)}`);
  }

  const candidate = cleaned.slice(start, end + 1);

  // Erster Versuch: Standard JSON.parse
  try {
    return JSON.parse(candidate);
  } catch (firstErr) {
    // Zweiter Versuch: Single-Quote → Double-Quote ersetzen
    // (passiert wenn Modell Prompt-Regel "keine Anführungszeichen in Werten"
    //  fälschlicherweise auf die gesamte JSON-Syntax anwendet)
    try {
      const withDoubleQuotes = candidate.replace(/'/g, '"');
      return JSON.parse(withDoubleQuotes);
    } catch {
      throw new Error(`JSON-Parse-Fehler in LLM-Antwort: ${firstErr.message}. Antwort: ${text.slice(0, 300)}`);
    }
  }
}

// ──────────────────────────────────────────────────────────────
// Dokument-Aufbereitung je nach Provider-Capabilities
// ──────────────────────────────────────────────────────────────

/**
 * Bereitet das Dokument für EIN Kettenglied auf.
 *
 * Der kritische Punkt: `stripTextLayer` erzeugt ein PDF, das nur noch das Bild
 * enthält. Schickt man das an ein Text-only-Modell und extrahiert vorher Text,
 * kommt NICHTS heraus. Deshalb drei Zweige:
 *
 *   caps.pdf                          → wie bisher: strippen, wenn gewünscht
 *   sonst, caps.vision (openai-kompat.) → NEU: PDF→PNG rastern, wenn keine
 *                                        brauchbare Textebene da ist ODER der
 *                                        Nutzer sie ausdrücklich verwirft
 *   sonst (Text-only)                 → NIEMALS strippen; die OCR-Ebene ist
 *                                        das einzige verwertbare Signal
 *
 * `caps.vision` zählt für die LEITUNG ausdrücklich NICHT als PDF-Fähigkeit —
 * siehe kannPdfEmpfangen() in llm/registry.js. Der Bildpfad ist ein eigener
 * Zweig, niemals ein `caps.pdf || caps.vision`.
 *
 * Der Bildpfad ist zusätzlich auf `typ === 'openai-compatible'` beschränkt:
 * nur providers/openai.js hat einen image_url-Block. Ein Anthropic/Bedrock-
 * Provider mit pdf:false, vision:true (Rand-/Fehlkonfigurationsfall) würde
 * sonst opts.bilder erhalten, das sein Adapter stillschweigend ignoriert —
 * das Dokument bliebe dann UNGESEHEN im Prompt. Fällt stattdessen in den
 * Text-Zweig, konsistent mit „PDF-Häkchen abgewählt → Textpfad".
 *
 * Die Entscheidung fällt pro Kettenglied, nicht einmal vorab — die Kette kann
 * von einem PDF-fähigen auf einen Text-only/Bild-Provider absteigen.
 *
 * Übergeben wird der ganze Provider-Eintrag (providerForRef), nicht nur seine
 * Caps: der Bildpfad braucht zusätzlich `typ` und das providerspezifische
 * `rasterMaxSeiten`. Beides aus einer Quelle, damit strikt-Prüfung, Render und
 * Warn-Log nie gegen verschiedene Zahlen laufen.
 */
function makeDocPreparer(pdfOriginal, stripGewuenscht) {
  const cache = {}; // 'pdf-stripped' | 'text' | 'seitenGesamt'
  // Bilder je effektivem Seitenlimit: steigt die Kette von einem Provider mit
  // 30 Seiten auf einen mit 4 ab, darf der zweite nicht den 30-Seiten-Satz aus
  // dem Cache bekommen — der läge über seinem Limit und seinem Kontextfenster.
  const bilderCache = new Map();

  async function holeText() {
    if (cache.text === undefined) {
      cache.text = await extractTextLayer(pdfOriginal).catch(() => '');
    }
    return cache.text;
  }

  return async function prepare(provider, { strikt = false } = {}) {
    const caps = provider?.caps || KEINE_CAPS;
    if (kannPdfEmpfangen(caps)) {
      if (!stripGewuenscht) return { inputMode: 'pdf', pdf: pdfOriginal, text: null, bilder: null };
      if (cache['pdf-stripped'] === undefined) {
        try {
          cache['pdf-stripped'] = await stripTextLayer(pdfOriginal);
        } catch (err) {
          console.warn(`[llm] stripTextLayer fehlgeschlagen, Original-PDF wird verwendet: ${err.message}`);
          appLog('WARN', 'llm', `stripTextLayer fehlgeschlagen: ${err.message}`);
          cache['pdf-stripped'] = pdfOriginal;
        }
      }
      return { inputMode: 'pdf', pdf: cache['pdf-stripped'], text: null, bilder: null };
    }

    const bilderMoeglich = caps?.vision === true && provider?.typ === 'openai-compatible';
    if (bilderMoeglich) {
      // Ein Provider ohne eigenen Wert erbt den Rasterizer-Default (lib/pdf.js).
      // Ab hier gilt genau diese eine Zahl — für die strikt-Prüfung, den
      // Render-Aufruf und den Warn-Text.
      const maxSeiten = provider.rasterMaxSeiten ?? RASTER_MAX_SEITEN;
      const text = await holeText();
      const textReichtNichtAus = (text || '').replace(/\s+/g, '').length < MIN_TEXT_CHARS;
      if (stripGewuenscht || textReichtNichtAus) {
        if (cache.seitenGesamt === undefined) {
          cache.seitenGesamt = await countPdfPages(pdfOriginal).catch(() => 1);
        }
        // Seitenlimit unabhängig vom Cache prüfen: ein während der Voranalyse
        // (strikt=false) bereits gerendertes/gecachtes Bild darf die
        // Klassifikation (strikt=true) nicht am harten Fehler vorbeischleusen.
        if (strikt && cache.seitenGesamt > maxSeiten) {
          throw permanentError(
            `PDF hat ${cache.seitenGesamt} Seiten (Limit ${maxSeiten}) für den `
            + 'Bildpfad bei der Klassifikation — eine halbe Sicht auf das Dokument ist '
            + 'riskanter als ein Modellwechsel.',
          );
        }
        let bilder = bilderCache.get(maxSeiten);
        if (bilder === undefined) {
          const result = await renderPdfToImages(pdfOriginal, { maxSeiten, strikt: false });
          // Leeres Ergebnis heißt: der Prompt ginge ohne jeden Bild-Block raus
          // und das Modell klassifiziert blind. Lieber hart absteigen.
          if (!result.bilder.length) {
            throw permanentError('Rastern lieferte keine Bilder — der Bildpfad ist für dieses PDF nicht nutzbar.');
          }
          if (result.abgeschnitten) {
            appLog('WARN', 'llm', `renderPdfToImages: PDF hat mehr als ${maxSeiten} Seiten, nur die ersten ${maxSeiten} wurden gerastert`);
          }
          bilder = result.bilder;
          bilderCache.set(maxSeiten, bilder);
        }
        return { inputMode: 'bilder', pdf: null, text: null, bilder };
      }
      return { inputMode: 'text', pdf: null, text, bilder: null };
    }

    // Text-only: Textebene NIE entfernen — sie ist die einzige Informationsquelle.
    const text = await holeText();
    const verwertbar = (text || '').replace(/\s+/g, '').length;
    if (verwertbar < MIN_TEXT_CHARS) {
      // Permanent statt transient: das PDF gewinnt zwischen zwei Retries keine
      // Textebene dazu. Die Fallback-Kette steigt auf das nächste Modell ab;
      // sind ALLE Kettenglieder text-only, bricht die Retry-Schleife früh ab
      // statt sinnlos 15+ Minuten auf denselben Fehler zu warten.
      throw permanentError(
        `Text-only-Provider, aber das PDF enthält keine verwertbare Textebene `
        + `(${verwertbar} Zeichen, mindestens ${MIN_TEXT_CHARS} nötig). `
        + 'Ein reiner Scan ohne OCR braucht einen Provider mit PDF-Fähigkeit.',
      );
    }
    return { inputMode: 'text', pdf: null, text, bilder: null };
  };
}

/** Text-Eingabe in den Prompt einbetten (nur Text-only-Pfad). */
function withDocumentText(prompt, text) {
  return `<dokument_text>\n${text}\n</dokument_text>\n\n${prompt}`;
}

// ──────────────────────────────────────────────────────────────
// Öffentliche API
// ──────────────────────────────────────────────────────────────

/**
 * Schätzt die Schwierigkeit eines Dokuments ein.
 * Bei Fehler: bis zu 3 Retries mit je 5 Minuten Wartezeit.
 *
 * @param {Buffer}  pdfBuffer
 * @param {object}  [settings] - Optional: bereits geladene Settings
 */
export async function assessDifficulty(pdfBuffer, settings = null, meta = null, options = {}) {
  const s    = settings || await loadDynamicSettings();
  const keys = buildKeys(s);
  const ctx  = { settings: s, keys };
  const costMap = buildCostMap(s);
  const baseMeta = { ...(meta || {}), costMap, kategorie: 'preanalysis' };
  const prepare = options.prepare || makeDocPreparer(pdfBuffer, false);

  const t0 = Date.now();

  // Voranalyse-Kette: konfiguriertes Voranalyse-Modell → Leicht → Letzter Fallback
  const preChain = chainOf(
    resolveKlassenModell('preanalysis', s),
    resolveKlassenModell('leicht',      s),
    resolveKlassenModell('fallback',    s),
  );

  for (let attempt = 0; attempt <= PRE_ANALYSIS_RETRY_COUNT; attempt++) {
    if (attempt > 0) {
      const waitMin = PRE_ANALYSIS_RETRY_DELAY_MS / 60000;
      console.warn(`[llm] assessDifficulty: Versuch ${attempt + 1}/${PRE_ANALYSIS_RETRY_COUNT + 1}, warte ${waitMin} Minuten…`);
      appLog('WARN', 'llm', `assessDifficulty: Retry ${attempt}/${PRE_ANALYSIS_RETRY_COUNT} nach Wartezeit`);
      await cancellableSleep(PRE_ANALYSIS_RETRY_DELAY_MS, meta?.correlationId);
    }
    // Bleiben ALLE Kettenglieder an einem dauerhaften Konfigurationsfehler
    // hängen (z. B. Text-only-Provider ohne Textebene, unbekannter Provider),
    // ändert eine Wartezeit daran nichts — sofort abbrechen statt bis zu
    // 15 Minuten auf denselben Fehler zu warten.
    let alleDauerhaft = true;
    for (const preRef of preChain) {
      try {
        const doc = await prepare(providerForRef(s, preRef));
        const resp = await callModel(
          preRef,
          doc.inputMode === 'text'
            ? withDocumentText(PRE_ANALYSIS_USER_MESSAGE, doc.text)
            : PRE_ANALYSIS_USER_MESSAGE,
          { pdf: doc.pdf, bilder: doc.bilder, system: PRE_ANALYSIS_SYSTEM_PROMPT },
          ctx,
          baseMeta,
        );
        const data = parseJsonFromText(resp.text);
        const preTokensIn  = resp.usage?.inputTokens  ?? null;
        const preTokensOut = resp.usage?.outputTokens ?? null;
        return {
          difficulty:             Number(data.difficulty) || 0,
          pages:                  Number(data.seiten_im_dokument) || 1,
          preAnalysisMs:          Date.now() - t0,
          preAnalysisNote:        null,
          rawPreAnalysisResponse: resp.text,
          preAnalysisModel:       preRef.model,
          preAnalysisProviderId:  preRef.providerId,
          preAnalysisInputMode:   doc.inputMode,
          preAnalysisTokensIn:    preTokensIn,
          preAnalysisTokensOut:   preTokensOut,
          // Abo-Pfad → Pauschaltarif (Kosten 0); sonst regulär berechnen.
          preAnalysisCostUsd:     resp.viaSubscription === true ? 0 : calculateCost(preRef.model, preTokensIn, preTokensOut, costMap),
        };
      } catch (err) {
        console.warn(`[llm] assessDifficulty ${refLabel(preRef)} (Versuch ${attempt + 1}/${PRE_ANALYSIS_RETRY_COUNT + 1}) fehlgeschlagen: ${err.message}`);
        appLog('WARN', 'llm', `assessDifficulty ${refLabel(preRef)} Versuch ${attempt + 1} fehlgeschlagen: ${err.message}`);
        if (!err.permanent) alleDauerhaft = false;
      }
    }
    if (alleDauerhaft) {
      const msg = 'assessDifficulty: alle Modelle der Voranalyse-Kette melden einen dauerhaften '
        + 'Konfigurationsfehler (z. B. Text-only-Provider ohne Textebene) — Abbruch ohne weitere Retries.';
      console.error(`[llm] ${msg}`);
      appLog('ERROR', 'llm', msg);
      throw new Error(`[llm] ${msg}`);
    }
  }

  // Alle Versuche erschöpft → Fehler werfen (keine Standardwerte — falsches Routing wäre zu kostspielig)
  const msg = `assessDifficulty: alle ${PRE_ANALYSIS_RETRY_COUNT + 1} Versuche fehlgeschlagen`;
  console.error(`[llm] ${msg}`);
  appLog('ERROR', 'llm', msg);
  throw new Error(`[llm] ${msg}`);
}

/**
 * Analysiert ein Dokument mit KI und extrahiert strukturierte Metadaten.
 * Nutzt difficulty-basiertes Modell-Routing mit automatischer Fallback-Kette.
 *
 * @param {Buffer}      pdfBuffer            - Das zu analysierende PDF (mit Textebene!)
 * @param {string}      classificationPrompt - Klassifikationsprompt (mit Patientenliste befüllt)
 * @param {string|null} [korrekturKontext]   - Korrektur-Anweisungen für Reprocessing-Modus
 * @param {object}      [settings]           - Optional: bereits geladene Settings
 * @param {object}      [options]            - { forceTier, stripTextLayerGewuenscht, validateResult }
 */
export async function analyzeDocument(
  pdfBuffer,
  classificationPrompt,
  korrekturKontext = '',
  settings = null,
  meta = null,
  options = {},
) {
  if (!classificationPrompt) {
    throw new Error('[llm] analyzeDocument: classificationPrompt fehlt — LxD-Prompt muss der Aufrufer bauen (kein Legacy-Fallback mehr).');
  }
  // Nur ein explizit getrennter statischer Prefix darf in einen Provider-Cache.
  // String-Aufrufer bleiben vollständig dynamisch; das ist sicherer als PII
  // versehentlich zu cachen.
  const promptParts = typeof classificationPrompt === 'string'
    ? { staticPrompt: '', dynamicPrompt: classificationPrompt }
    : {
        staticPrompt: String(classificationPrompt?.staticPrompt || ''),
        dynamicPrompt: String(classificationPrompt?.dynamicPrompt || ''),
      };
  const vollständigerPrompt = `${promptParts.staticPrompt}${promptParts.dynamicPrompt}`;
  const s    = settings || await loadDynamicSettings();
  const keys = buildKeys(s);
  const ctx  = { settings: s, keys };
  const costMap = buildCostMap(s);
  const analysisMeta = { ...(meta || {}), costMap, kategorie: 'analysis' };

  // Die OCR-Textebene wird für PDF-fähige Provider entfernt, wenn der Scanner-Pfad
  // oder die ausdrückliche Nutzerwahl es verlangt — bei Text-only-Providern
  // niemals. Entschieden wird pro Kettenglied, siehe makeDocPreparer().
  const prepare = makeDocPreparer(pdfBuffer, options?.stripTextLayerGewuenscht === true);

  // Forcierte Modellstufe (Wiederverarbeitung mit manueller Modellwahl):
  // überspringt die Voranalyse (Preclassifier) und nutzt fix das Stufen-Modell.
  const forceTier = options?.forceTier && TIER_DEFAULTS[options.forceTier] ? options.forceTier : null;

  // Cache-Mode? Dann fixes Modell + Prompt-Caching für die Batch-Verarbeitung.
  // Bei forcierter Modellstufe ignorieren — die explizite User-Wahl hat Vorrang.
  const cacheTier = forceTier ? null : await activeCacheTier();

  let difficulty = null, pages = 1;
  let preAnalysisNote = null, preAnalysisMs = 0, rawPreAnalysisResponse = null;
  let preAnalysisModel = null, preAnalysisTokensIn = null, preAnalysisTokensOut = null, preAnalysisCostUsd = null;
  let models, chainReason;
  let cacheSystem = false;
  let systemForCall;                     // gecachter System-Prompt (nur Cache-Mode, kurze Docs)
  let userPromptForCall;                 // User-Turn-Text

  if (forceTier) {
    // Manuelle Modellwahl: Voranalyse überspringen, fix mit dem Stufen-Modell starten.
    // Seitenzahl nur lokal für das Log bestimmen (kein Routing-Einfluss).
    try { pages = await countPdfPages(pdfBuffer); } catch { pages = 1; }
    const fallback = resolveKlassenModell('fallback', s);
    const leicht    = resolveTierModelConfig('leicht',    s);
    const mittel    = resolveTierModelConfig('mittel',    s);
    const schwierig = resolveTierModelConfig('schwierig', s);
    const large     = resolveTierModelConfig('large',     s);
    // Die gewählte Stufe fällt über die jeweils niedrigeren Stufen zurück, BEVOR der
    // letzte (günstige) Fallback greift — z. B. Schwer → Mittel → Leicht → gpt-nano.
    const tierChains = {
      schwierig: [schwierig, mittel, leicht, fallback],
      mittel:    [mittel, leicht, fallback],
      leicht:    [leicht, fallback],
      large:     [large, leicht, fallback],
    };
    const chainForTier = tierChains[forceTier];
    if (!chainForTier || !chainForTier[0]?.model) throw new Error(`Unbekannte Modellstufe: ${forceTier}`);
    models = chainOf(...chainForTier);
    chainReason = `Manuelle Modellwahl (${forceTier}: ${refLabel(chainForTier[0])}) — Voranalyse übersprungen`;
    userPromptForCall = vollständigerPrompt + (korrekturKontext || '');
  } else if (cacheTier) {
    // Seitenzahl LOKAL bestimmen (keine LLM-Voranalyse im Cache-Mode).
    try { pages = await countPdfPages(pdfBuffer); } catch { pages = 1; }
    const fallback = resolveKlassenModell('fallback', s);
    if (pages > 10) {
      // Lange Dokumente laufen weiterhin über die normale Large-Kette (kein fixes Modell, kein Caching).
      const sel = selectModelChain(0, pages, s);
      models = sel.models;
      chainReason = `Cache-Mode: langes Dokument (${pages} Seiten) → Large-Kette`;
      userPromptForCall = vollständigerPrompt + (korrekturKontext || '');
    } else {
      // Kurze Dokumente: nur das fixe Tier-Modell (+ letzter Fallback).
      const fixed = resolveKlassenModell(cacheTier, s);
      models = chainOf(fixed, fallback);
      chainReason = `Cache-Mode aktiv (${cacheTier}: ${refLabel(fixed)}, ${pages} Seiten)`;
      // Cache-Mode ist der globale Opt-in. Der OpenAI-Adapter handelt die
      // Modellunterstützung selbst dynamisch mit einem sicheren Fallback aus.
      cacheSystem = !!promptParts.staticPrompt && capsForRef(s, fixed).promptCache === true;
      if (cacheSystem) {
        // Nur der explizit als stabil markierte Prefix wird gecacht. Familien,
        // PKV/Beihilfe, Betreiberregeln und Korrekturen bleiben im User-Turn.
        systemForCall = promptParts.staticPrompt;
        userPromptForCall = `${promptParts.dynamicPrompt}${korrekturKontext || ''}`.trim()
          || 'Analysiere das beigefügte Dokument gemäß den Anweisungen im System-Prompt.';
      } else {
        userPromptForCall = vollständigerPrompt + (korrekturKontext || '');
      }
    }
  } else {
    // Normalbetrieb: Schwierigkeitseinschätzung bestimmt die Modell-Kette.
    ({
      difficulty, pages, preAnalysisNote, preAnalysisMs, rawPreAnalysisResponse,
      preAnalysisModel, preAnalysisTokensIn, preAnalysisTokensOut, preAnalysisCostUsd,
    } = await assessDifficulty(pdfBuffer, s, meta, { prepare }));
    console.log(`[llm] Dokument: ${pages} Seiten, difficulty=${difficulty}`);
    ({ models, reason: chainReason } = selectModelChain(difficulty, pages, s));
    userPromptForCall = vollständigerPrompt + (korrekturKontext || '');
  }
  console.log(`[llm] ${chainReason}; Kette: ${models.map(refLabel).join(' → ')}`);

  // Für Debug-/Pipeline-Log: der effektiv gesendete Prompt.
  const fullPrompt = systemForCall
    ? `[SYSTEM (cache_control)]\n${systemForCall}\n\n[USER]\n${userPromptForCall}`
    : userPromptForCall;

  // Schritt 4: Analyse mit Fallback-Kette; bei Totalausfall 1x Retry nach 10 Minuten
  for (let chainAttempt = 0; chainAttempt <= 1; chainAttempt++) {
    if (chainAttempt > 0) {
      const waitMin = ANALYSIS_RETRY_DELAY_MS / 60000;
      console.warn(`[llm] analyzeDocument: Kette vollständig fehlgeschlagen, Retry nach ${waitMin} Minuten…`);
      appLog('WARN', 'llm', `analyzeDocument: Kette fehlgeschlagen, Retry nach ${waitMin}min`);
      await cancellableSleep(ANALYSIS_RETRY_DELAY_MS, meta?.correlationId);
    }

    const failedModels = [];
    // Wie bei assessDifficulty: scheitern ALLE Kettenglieder an einem
    // dauerhaften Konfigurationsfehler, bringt der 10-Minuten-Retry nichts.
    let alleDauerhaft = true;
    for (const ref of models) {
      const tAnalysis = Date.now();
      const label = refLabel(ref);
      try {
        console.log(`[llm] analyzeDocument: versuche ${label}…`);
        // Dokument-Aufbereitung fällt HIER, nach der Provider-Auflösung.
        // strikt:true — bei der Klassifikation (anders als der Voranalyse) ist
        // eine halbe Sicht auf ein zu langes Dokument riskanter als ein Absteigen
        // der Kette auf einen PDF-fähigen Provider (siehe makeDocPreparer()).
        const doc = await prepare(providerForRef(s, ref), { strikt: true });
        // System/cacheSystem nur für das fixe Cache-Mode-Modell (erstes der Kette).
        const useCache = cacheSystem && refKey(ref) === refKey(models[0]);
        const basisPrompt = useCache ? userPromptForCall : fullPrompt;
        const resp = await callModel(
          ref,
          doc.inputMode === 'text' ? withDocumentText(basisPrompt, doc.text) : basisPrompt,
          { pdf: doc.pdf, bilder: doc.bilder, maxTokens: 8192, system: useCache ? systemForCall : undefined, cacheSystem: useCache },
          ctx,
          analysisMeta,
        );
        const analysisMs = Date.now() - tAnalysis;
        const data = parseJsonFromText(resp.text);

        // Inhaltliche Mindeststruktur gehört zur Gültigkeit einer
        // Modellantwort. Ein fehlender Fachblock ist deshalb ein Modellfehler
        // und muss das nächste Kettenglied mit erneutem Dokumentzugriff
        // auslösen, nicht erst einen leeren DB-Insert.
        const strukturFehler = options?.validateResult
          ? await options.validateResult(data)
          : null;
        if (strukturFehler) {
          throw new Error(`Unvollständige Extraktion: ${strukturFehler}`);
        }

        // Mindest-Validierung
        const lxdLabel = typeof data.lebensbereich === 'string' && typeof data.dokumentart === 'string'
          ? `${data.lebensbereich}/${data.dokumentart}`
          : 'unvollständig – Validator übernimmt';
        console.log(`[llm] analyzeDocument: Erfolg mit ${label} (L×D: ${lxdLabel}, ${analysisMs}ms, inputMode=${doc.inputMode})`);

        const analysisTokensIn         = resp.usage?.inputTokens         ?? null;
        const analysisTokensOut        = resp.usage?.outputTokens        ?? null;
        const analysisCacheWriteTokens = resp.usage?.cacheCreationTokens ?? null;
        const analysisCacheReadTokens  = resp.usage?.cacheReadTokens     ?? null;
        const analysisCostUsd = resp.viaSubscription === true
          ? 0
          : calculateCost(ref.model, {
              tokensIn: analysisTokensIn, tokensOut: analysisTokensOut,
              cacheCreationTokens: analysisCacheWriteTokens, cacheReadTokens: analysisCacheReadTokens,
            }, costMap);

        // Cache-Mode-Aktivität auffrischen (Inaktivitäts-Timer; deckt auch externe Eingänge ab).
        if (cacheTier) { try { await touchCacheMode(); } catch { /* nicht fatal */ } }

        const isFallback = refKey(ref) !== refKey(models[0]);
        data._pipelineLog = {
          pages,
          difficulty,
          preAnalysis: preAnalysisNote
            ? `${preAnalysisNote} (${pages}S, d=${difficulty})`
            : `${pages}S, d=${difficulty}`,
          preAnalysisMs,
          preAnalysisModel,
          preAnalysisTokensIn,
          preAnalysisTokensOut,
          preAnalysisCostUsd,
          chainReason,
          chainModels: models.map(refLabel).join(' → '),
          analysisModel: ref.model,
          analysisProviderId: ref.providerId,
          // Macht im Detail sichtbar, WARUM eine Klassifikation schlechter ausfiel:
          // 'text' heißt, dass der Provider kein PDF entgegennimmt und nur die
          // lokal extrahierte Textebene gesehen hat.
          inputMode: doc.inputMode,
          analysisMs,
          analysisNote: isFallback
            ? `Fallback auf ${label} (${failedModels.join(', ')} fehlgeschlagen)`
            : label,
          failedModels,
          analysisTokensIn,
          analysisTokensOut,
          analysisCacheWriteTokens,
          analysisCacheReadTokens,
          analysisCostUsd,
          cacheMode: cacheTier || null,
          rawPreAnalysisResponse,
          rawAnalysisResponse: resp.text,
          // Der effektive Prompt enthält Familien-/Betreiber-Kontext und darf
          // weder in postbuch.metadata noch in dauerhaften Logs landen.
        };

        return data;
      } catch (err) {
        console.warn(`[llm] ${label} fehlgeschlagen: ${err.message}`);
        appLog('WARN', 'llm', `analyzeDocument ${label} fehlgeschlagen: ${err.message}`);
        failedModels.push(label);
        if (!err.permanent) alleDauerhaft = false;
      }
    }
    console.warn(`[llm] analyzeDocument: alle Modelle fehlgeschlagen (Versuch ${chainAttempt + 1}/2)`);
    if (alleDauerhaft) {
      const msg = 'analyzeDocument: alle Modelle der Kette melden einen dauerhaften '
        + 'Konfigurationsfehler (z. B. Text-only-Provider ohne Textebene) — Abbruch ohne Retry.';
      console.error(`[llm] ${msg}`);
      appLog('ERROR', 'llm', msg);
      throw new Error(`[llm] ${msg}`);
    }
  }

  appLog('ERROR', 'llm', 'analyzeDocument: alle Modelle fehlgeschlagen (inkl. Retry)');
  throw new Error('[llm] analyzeDocument: alle Modelle der Fallback-Kette fehlgeschlagen');
}

/**
 * Einzelner LLM-Aufruf ohne Fallback — für beliebige Aufgaben.
 * Liest Provider-Konfiguration aus den Settings.
 *
 * @param {string|object} model - Modell-ID oder { providerId, model }
 * @param {object} [opts]       - { pdf, system, maxTokens, jsonMode }
 */
export async function callLLM(model, prompt, opts = {}, settings = null, meta = null) {
  const s    = settings || await loadDynamicSettings();
  const keys = buildKeys(s);
  const costMap = buildCostMap(s);
  const fullMeta = { ...(meta || {}), costMap, kategorie: meta?.kategorie || 'other' };
  return callModel(model, prompt, opts, { settings: s, keys }, fullMeta);
}
