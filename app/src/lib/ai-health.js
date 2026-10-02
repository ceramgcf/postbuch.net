/**
 * lib/ai-health.js — Zustand der KI-Provider (Keys, erreichbare Modelle)
 *
 * Zwei Router brauchen den Bericht:
 *   - /api/settings/ai/health        (Admin, mit Fehlerdetails der Provider)
 *   - /api/settings-public/ai/health (jeder eingeloggte Nutzer, ohne Details)
 *
 * Seit 1.7.0 läuft der Bericht über die Provider-Registry statt über drei fest
 * verdrahtete Anbieter — und die Provider werden **nicht bei jedem Aufruf
 * angepingt**: das UI pollt diese Route, und ein Ollama im LAN mit 10 s Timeout
 * würde die Seite sonst blockieren. Ergebnis pro Provider 60 s gecacht,
 * frischer Test nur auf ausdrückliche Anforderung (`fresh`).
 */

import { loadDynamicSettings } from '../config.js';
import { subscriptionFeatureUnlocked } from './claude-subscription.js';
import { listProviders, getProvider, modelsUrl, kannDokumentSehen } from './llm/registry.js';
import { MODEL_CLASSES } from './llm/model-classes.js';
import { gleichesModell } from './llm/modell-id.js';
import { guardedFetchJson, clientSafeError, TIMEOUT_PROBE_MS } from './net-guard.js';
import { resolveModelConfig } from './llm.js';

const HEALTH_TTL_MS = 60_000;
/** providerId → { at, models: [{id,name}], embeddingModels: [{id,name}], error } */
const cache = new Map();

// Positiv-Filter für Embedding-Modelle: gilt providerübergreifend (OpenAI
// "text-embedding-3-large", Bedrock "amazon.titan-embed-*"/"cohere.embed-*",
// lokale "nomic-embed-text"/"mxbai-embed-large"/"Qwen3-Embedding"). Exoten wie
// "bge-m3" treffen das nicht — dafür hat EmbeddingCard.jsx ein Freitextfeld.
const EMBED_RE = /embed/i;

export function invalidateAiHealthCache(providerId = null) {
  if (providerId) cache.delete(providerId);
  else cache.clear();
}

/**
 * Bedrock-Modell-Listing: kombiniert Inference Profiles (Cross-Region, z.B.
 * "eu.anthropic.claude-sonnet-4-6") mit On-Demand-Foundation-Models. In der EU sind
 * neue Anthropic-Modelle ausschließlich als Inference Profile erreichbar. Auth: Bearer.
 */
export async function fetchBedrockModels({ apiKey, region }) {
  const base = `https://bedrock.${region}.amazonaws.com`;
  const headers = { Authorization: `Bearer ${apiKey}` };
  async function getJson(url) {
    const r = await fetch(url, { headers });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      throw new Error(`Bedrock API ${r.status}: ${t.slice(0, 300)}`);
    }
    return r.json();
  }
  const results = new Map();
  try {
    const data = await getJson(`${base}/inference-profiles?type=SYSTEM_DEFINED`);
    for (const p of data.inferenceProfileSummaries || []) {
      if ((p.status || 'ACTIVE') !== 'ACTIVE') continue;
      if (!/anthropic/i.test(p.inferenceProfileId || '')) continue;
      results.set(p.inferenceProfileId, { id: p.inferenceProfileId, name: p.inferenceProfileName || p.inferenceProfileId });
    }
  } catch (e) {
    console.warn('[bedrock] inference-profiles failed:', e.message);
  }
  try {
    const data = await getJson(`${base}/foundation-models?byProvider=Anthropic&byOutputModality=TEXT&byInferenceType=ON_DEMAND`);
    for (const m of data.modelSummaries || []) {
      if ((m.modelLifecycle?.status || 'ACTIVE') !== 'ACTIVE') continue;
      if (!results.has(m.modelId)) results.set(m.modelId, { id: m.modelId, name: m.modelName || m.modelId });
    }
  } catch (e) {
    console.warn('[bedrock] foundation-models failed:', e.message);
    if (results.size === 0) throw e;
  }
  return Array.from(results.values()).sort((a, b) => b.id.localeCompare(a.id));
}

/**
 * Modell-Listing eines Providers, 60 s gecacht — die EINE Implementierung.
 *
 * Bis 1.7.3 gab es diese Logik zweimal: hier (mit Cache, nur IDs) und in
 * `routes/settings.js` unter `GET /ai/models/:provider` (mit Anzeigenamen,
 * OpenAI-Filter und Sortierung, ohne Cache). Zwei Implementierungen desselben
 * Aufrufs driften garantiert; die Route ist jetzt ein Wrapper hierum.
 *
 * @returns {{at:number, models:Array<{id,name}>, embeddingModels:Array<{id,name}>, error:string|null}}
 */
async function modelleVon(settings, providerId, fresh) {
  const cached = cache.get(providerId);
  if (!fresh && cached && Date.now() - cached.at < HEALTH_TTL_MS) return cached;

  const prov = getProvider(settings, providerId);
  let models = [];
  let embeddingModels = [];
  let error = null;

  try {
    if (!prov) throw new Error('Unbekannter Provider.');
    if (prov.typ === 'subscription') {
      // Das Abo hat kein eigenes Listing; es nutzt die Modell-IDs des jeweiligen API-Providers.
      models = [];
    } else if (prov.typ === 'bedrock') {
      const apiKey = prov.apiKey || process.env.BEDROCK_API_KEY || process.env.AWS_BEARER_TOKEN_BEDROCK;
      const region = settings.llm_bedrock_region || process.env.BEDROCK_REGION || process.env.AWS_REGION || 'eu-central-1';
      if (apiKey) models = await fetchBedrockModels({ apiKey, region });
      embeddingModels = models.filter((m) => EMBED_RE.test(m.id));
    } else if (prov.typ === 'anthropic') {
      if (prov.apiKey) {
        const url = `${String(prov.baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '')}/v1/models`;
        const d = await guardedFetchJson(url, {
          headers: { 'x-api-key': prov.apiKey, 'anthropic-version': '2023-06-01' },
        }, { allowPrivate: prov.allowPrivate === true, timeoutMs: TIMEOUT_PROBE_MS });
        models = (d.data || [])
          .sort((a, b) => (b.created_at > a.created_at ? 1 : -1))
          .map((m) => ({ id: m.id, name: m.display_name || m.id }))
          .filter((m) => m.id);
        embeddingModels = models.filter((m) => EMBED_RE.test(m.id));
      }
    } else {
      // openai-compatible: lokale Ziele brauchen keinen Key, der echte OpenAI schon.
      if (prov.apiKey || prov.id !== 'openai') {
        const d = await guardedFetchJson(modelsUrl(prov), {
          headers: prov.apiKey ? { Authorization: `Bearer ${prov.apiKey}` } : {},
        }, { allowPrivate: prov.allowPrivate === true, timeoutMs: TIMEOUT_PROBE_MS });

        // HTTP 200 heißt hier nicht "verstanden": LM Studio antwortet auf einen
        // falschen Pfad mit 200 + {"error":"Unexpected endpoint or method…"}
        // statt mit 404. Ohne diese Prüfung bliebe die Modell-Liste still leer
        // und der Provider sähe im UI gesund aus. Häufigste Ursache ist eine
        // baseUrl ohne /v1. Die Antwort der Gegenstelle NICHT in den geworfenen
        // Text übernehmen — sie geht an den Client (siehe catch unten).
        if (!Array.isArray(d?.data) && !Array.isArray(d?.models)) {
          console.warn(`[ai-health] "${providerId}": Antwort ohne Modell-Liste:`,
                       JSON.stringify(d ?? null).slice(0, 300));
          throw new Error('Die Gegenstelle hat keine Modell-Liste geliefert. '
            + 'Häufigste Ursache: die Basis-URL endet nicht auf /v1.');
        }

        let liste = (d.data || d.models || [])
          .map((m) => ({ id: m.id || m.name, name: m.id || m.name, created: m.created || 0 }))
          .filter((m) => m.id);

        // Embedding-Liste IMMER aus der Rohliste, bevor der OpenAI-Chat-Filter
        // (der "embed" unten explizit ausschließt) sie sonst leerräumt.
        embeddingModels = liste
          .filter((m) => EMBED_RE.test(m.id))
          .sort((a, b) => (b.created || 0) - (a.created || 0))
          .map(({ id, name }) => ({ id, name }));

        // Nur beim echten OpenAI lohnt das Aussieben — dort stehen hunderte
        // Nicht-Chat-Modelle in der Liste. Lokale Endpunkte listen ohnehin wenige.
        if (prov.id === 'openai') {
          liste = liste.filter((m) => {
            if (/instruct|realtime|audio|whisper|tts|dall-e|embed|babbage|davinci|curie|ada|search|similarity|insert|edit/i.test(m.id)) return false;
            return /^(gpt-|o1|o3|o4|chatgpt-)/.test(m.id);
          });
        }
        models = liste
          .sort((a, b) => (b.created || 0) - (a.created || 0))
          .map(({ id, name }) => ({ id, name }));
      }
    }
  } catch (e) {
    // NICHT e.message: guardedFetchJson hängt bis zu 300 Zeichen des
    // Antwort-Bodys der Gegenstelle an. Diese Route pollt das UI von selbst —
    // mit einer frei eintragbaren baseUrl wäre der Fehlertext sonst ein
    // generisches HTTP-Lesegerät fürs LAN. Rohtext nur ins Server-Log.
    console.warn(`[ai-health] Modell-Listing "${providerId}" fehlgeschlagen:`, e.message);
    error = clientSafeError(e);
  }

  const ergebnis = { at: Date.now(), models, embeddingModels, error };
  cache.set(providerId, ergebnis);
  return ergebnis;
}

/**
 * Modell-Liste eines Providers als `[{id, name}]`. Wirft bei Fehlern mit einem
 * bereits client-sicheren Text. `kind: 'embedding'` liefert die Embedding-
 * Teilliste statt der Chat-Liste (Default).
 */
export async function listProviderModels(settings, providerId, { fresh = false, kind = 'chat' } = {}) {
  const r = await modelleVon(settings, providerId, fresh);
  if (r.error) throw new Error(r.error);
  return kind === 'embedding' ? r.embeddingModels : r.models;
}

/**
 * Baut den vollständigen Health-Bericht: Key-Präsenz, Provider-Erreichbarkeit und
 * Verfügbarkeit der konfigurierten Modelle je Stufe.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.fresh] — Cache umgehen (nur für den ausdrücklichen „Testen"-Klick)
 */
export async function buildAiHealth({ fresh = false } = {}) {
  const settings = await loadDynamicSettings();
  const eintraege = listProviders(settings);

  // Providers, die tatsächlich von mindestens einer Modell-Klasse referenziert
  // werden. Nur für die ist eine Erreichbarkeits-Warnung sinnvoll — ein Key,
  // der nur "auf Vorrat" hinterlegt oder dessen Provider inaktiv geschaltet
  // ist, soll die Pipeline nicht fälschlich als kaputt melden.
  const benutzteProviderIds = new Set(
    MODEL_CLASSES.map((cls) => resolveModelConfig(settings[cls.settingKey], cls.provider, cls.model).providerId)
  );

  const berichte = {};
  await Promise.all(eintraege.map(async (e) => {
    const prov = getProvider(settings, e.id);
    // Nur konfigurierte (Key vorhanden ODER lokales Ziel ohne Auth) und aktive
    // Provider werden überhaupt angefasst.
    const konfiguriert = prov.typ === 'subscription'
      ? (subscriptionFeatureUnlocked() && !!prov.apiKey)
      : (!!prov.apiKey || (prov.typ === 'openai-compatible' && prov.id !== 'openai' && !!prov.baseUrl));
    const benutzt = benutzteProviderIds.has(e.id);
    if (!e.aktiv || !konfiguriert) {
      berichte[e.id] = { id: e.id, label: e.label, typ: e.typ, caps: e.caps,
                         configured: konfiguriert, working: false, error: null, models: [], embeddingModels: [], benutzt };
      return;
    }
    const r = await modelleVon(settings, e.id, fresh);
    berichte[e.id] = {
      id: e.id, label: e.label, typ: e.typ, caps: e.caps,
      configured: true, working: !r.error, error: r.error, models: r.models, embeddingModels: r.embeddingModels, benutzt,
    };
  }));

  // Alias trifft Snapshot ("claude-haiku-4-5" ↔ "…-20251001"), aber nicht ein
  // anderes Modell mit gleichem Anfang ("claude-opus-5" ↔ "claude-opus-5-5").
  function modelAvailable(providerId, modelId) {
    if (!modelId) return false;
    const b = berichte[providerId];
    // Abo und nicht erreichbare/leere Listings können nichts widerlegen — dann
    // gilt das Modell als verfügbar, statt eine falsche Warnung zu erzeugen.
    if (!b || b.typ === 'subscription' || !b.models.length) return true;
    return b.models.some((m) => gleichesModell(m.id, modelId));
  }

  // Alle ZEHN Klassen, aus der gemeinsamen Quelle. Vorher standen hier nur
  // sechs — die vier Chat-/Akten-Klassen fehlten still, obwohl sie genauso
  // konfigurierbar sind und genauso auf einen Text-only-Provider zeigen können.
  const models = {};
  for (const cls of MODEL_CLASSES) {
    const cfg = resolveModelConfig(settings[cls.settingKey], cls.provider, cls.model);
    const b = berichte[cfg.providerId];
    models[cls.key] = {
      ...cfg,
      providerLabel: b?.label || cfg.providerId,
      caps: b?.caps || null,
      available: modelAvailable(cfg.providerId, cfg.model),
      // Warnung, keine Blockade: bei falsch deklarierten Caps wäre ein harter
      // Block schlimmer als das Problem. kannDokumentSehen (nicht
      // kannPdfEmpfangen): ein vision-Provider sieht die Seite über den
      // Rasterizer, ist also nicht mehr "nur Text".
      textOnly: b?.caps ? !kannDokumentSehen(b.caps) : false,
    };
  }

  const subscriptionUnlocked = subscriptionFeatureUnlocked();
  return {
    // Bestandsform: das Frontend liest bis Phase 5 weiter openai/anthropic/bedrock.
    openai:    kompakt(berichte.openai),
    anthropic: kompakt(berichte.anthropic),
    bedrock:   { ...kompakt(berichte.bedrock),
                 region: settings.llm_bedrock_region || process.env.BEDROCK_REGION || process.env.AWS_REGION || 'eu-central-1' },
    subscription: {
      unlocked:   subscriptionUnlocked,
      configured: subscriptionUnlocked && !!settings.llm_claude_oauth_token,
      enabled:    subscriptionUnlocked && settings.llm_claude_subscription_enabled === true,
    },
    providers: berichte,
    models,
  };
}

function kompakt(b) {
  return { configured: !!b?.configured, working: !!b?.working, error: b?.error ?? null };
}

/**
 * Wie buildAiHealth(), aber ohne die Rohtexte der Provider-Fehler und ohne die
 * Bedrock-Region. Nicht-Admins sollen sehen DASS etwas klemmt, aber keine
 * Antworten fremder APIs (die z. B. maskierte Key-Fragmente oder interne
 * Hostnamen enthalten können).
 */
export async function buildAiHealthRedacted() {
  const full = await buildAiHealth();
  const strip = (p) => ({
    configured: p.configured,
    working: p.working,
    error: p.error ? 'Details nur für Administratoren sichtbar' : null,
  });
  const providers = {};
  for (const [id, b] of Object.entries(full.providers)) {
    providers[id] = {
      id, label: b.label, typ: b.typ, caps: b.caps,
      configured: b.configured, working: b.working, benutzt: b.benutzt,
      error: b.error ? 'Details nur für Administratoren sichtbar' : null,
    };
  }
  return {
    openai:       strip(full.openai),
    anthropic:    strip(full.anthropic),
    bedrock:      strip(full.bedrock),
    subscription: full.subscription,
    providers,
    models:       full.models,
  };
}
