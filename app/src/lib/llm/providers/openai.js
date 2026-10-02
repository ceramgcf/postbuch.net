/**
 * lib/llm/providers/openai.js — OpenAI-kompatible Chat-Completions
 *
 * Deckt OpenAI, Ollama, LM Studio, vLLM, LiteLLM, OpenRouter, Groq, Together
 * und DeepSeek ab. Der einzige echte Unterschied zwischen ihnen ist die
 * `baseUrl` — plus zwei Dialekt-Abweichungen bei Ollama.
 *
 * Bewusst KEIN `openai`-npm-Paket: das vorhandene fetch ist schlanker und
 * baseURL-fähig, und der net-guard muss ohnehin dazwischen liegen.
 */

import { createHash, createHmac } from 'node:crypto';
import { guardedFetch, readLimitedText, TIMEOUT_COMPLETION_MS, NetGuardError } from '../../net-guard.js';
import { chatCompletionsUrl, embeddingsUrl, kannPdfEmpfangen, permanentError } from '../registry.js';
import { resolveReasoningEffort, learnReasoningCapability } from '../thinking-policy.js';

const OPENAI_PROMPT_CACHE_TTL = '30m';
const CACHE_CAPABILITY_TTL_MS = 60 * 60 * 1000;
const unsupportedPromptCacheModels = new Map();

/**
 * Der Cache-Control-Dialekt gehört zu OpenAI, nicht zu "OpenAI-kompatibel".
 * Eine Modellliste wäre beim nächsten Release sofort veraltet; die konkrete
 * Unterstützung handeln wir deshalb bei der ersten Anfrage dynamisch aus.
 */
export function supportsOpenAIPromptCacheControl(provider) {
  if (provider?.id !== 'openai' || provider?.dialekt !== 'openai') return false;
  try {
    const url = new URL(provider.baseUrl);
    return url.protocol === 'https:' && url.hostname === 'api.openai.com';
  } catch {
    return false;
  }
}

function cacheCapabilityKey(provider, model) {
  return `${String(provider?.baseUrl || '').replace(/\/+$/, '')}\u0000${String(model || '')}`;
}

function isPromptCacheKnownUnsupported(provider, model) {
  const until = unsupportedPromptCacheModels.get(cacheCapabilityKey(provider, model)) || 0;
  if (until > Date.now()) return true;
  if (until) unsupportedPromptCacheModels.delete(cacheCapabilityKey(provider, model));
  return false;
}

export function markOpenAIPromptCacheUnsupported(provider, model) {
  unsupportedPromptCacheModels.set(cacheCapabilityKey(provider, model), Date.now() + CACHE_CAPABILITY_TTL_MS);
}

/** Nur der erwartete Parameterfehler darf ohne Cache-Policy wiederholt werden. */
export function isOpenAIPromptCacheUnsupportedError(status, text) {
  return status === 400
    && /prompt_cache_(?:options|key|breakpoint)/i.test(String(text || ''))
    && /(?:unknown|unrecognized|unsupported|not supported|invalid (?:request )?parameter)/i.test(String(text || ''));
}

/**
 * Reasoning-Modelle (gpt-5.x) nehmen serverseitig ein Default-`reasoning_effort`
 * an und verweigern dann Function-Tools auf /v1/chat/completions mit HTTP 400.
 * Die API nennt die Lösung selbst: `reasoning_effort` auf 'none' setzen (oder
 * /v1/responses benutzen — hier bewusst nicht, das wäre ein anderer Endpunkt).
 * Nicht-Reasoning-Modelle lösen diesen Fehler nie aus, deshalb ist das rein
 * reaktive Nachrüsten unschädlich.
 *
 * Das eigentliche Lernen/Merken dieser Modell-Fähigkeit lebt bewusst NICHT
 * hier (reine Wire-Format-Schicht ohne DB-Zugriff), sondern persistent in
 * service/chat-agent.js (Tabelle postbuch.llm_reasoning_capability) — diese
 * Funktion liefert nur die Fehler-ERKENNUNG.
 */
export function isOpenAIReasoningEffortToolError(status, text) {
  return status === 400
    && /reasoning_effort/i.test(String(text || ''))
    && /function tools?/i.test(String(text || ''))
    && /not supported/i.test(String(text || ''));
}

/**
 * Modelle mit dieser OpenAI-Cache-API kennen kostenpflichtige implizite
 * Cache-Writes. `explicit` ohne Breakpoint deaktiviert diese sicher; im
 * Cache-Mode kommt nur der stabile System-Prefix mit Key und Breakpoint hinzu.
 */
export function openAIPromptCachePolicy({ provider, model, system, cacheSystem = false } = {}) {
  if (!supportsOpenAIPromptCacheControl(provider) || isPromptCacheKnownUnsupported(provider, model)) return null;
  const policy = { prompt_cache_options: { mode: 'explicit', ttl: OPENAI_PROMPT_CACHE_TTL } };
  if (!cacheSystem || !system) return policy;

  // Routing-Key ohne Dokumentinhalt oder Personen-/Mandantendaten. Das HMAC
  // trennt API-Credentials, ohne den geheimen Schlüssel preiszugeben.
  const material = `classification\u0000${model}\u0000${system}`;
  const digest = provider.apiKey
    ? createHmac('sha256', provider.apiKey).update(material).digest('hex')
    : createHash('sha256').update(material).digest('hex');
  return { ...policy, prompt_cache_key: `postbuch:classification:${digest.slice(0, 24)}` };
}

/** Normalisiert OpenAI-Usage auf disjunkte Kostenbestandteile. */
export function extractOpenAIUsage(usage) {
  const details = usage?.prompt_tokens_details;
  const promptTokens = usage?.prompt_tokens;
  const cachedTokens = details?.cached_tokens;
  const cacheWriteTokens = details?.cache_write_tokens;
  const asNonNegativeNumber = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };
  return {
    // prompt_tokens enthält Read-/Write-Tokens. calculateCost rechnet sie
    // separat ab, darum werden sie hier einmalig herausgerechnet.
    inputTokens: promptTokens == null
      ? null
      : Math.max(0, asNonNegativeNumber(promptTokens) - asNonNegativeNumber(cachedTokens) - asNonNegativeNumber(cacheWriteTokens)),
    outputTokens: usage?.completion_tokens ?? null,
    cacheCreationTokens: cacheWriteTokens ?? null,
    cacheReadTokens: cachedTokens ?? null,
  };
}

/**
 * Dialekt-Unterschiede, fallweise behandelt:
 *   • Ollama will `format` (String "json" oder JSON-Schema) statt
 *     `response_format` und `max_tokens` statt `max_completion_tokens`.
 *   • OpenRouter folgt der OpenAI-Konvention und braucht nichts Eigenes.
 *     HTTP-Referer/X-Title sind optional (nur einzelne Modelle verlangen
 *     HTTP-Referer zur Attribution).
 *   • LM Studio braucht bei Bild-Blöcken eine andere Kodierung, siehe bildBlock().
 */
function applyDialect(body, dialekt, { maxTokens, jsonMode }) {
  if (dialekt === 'ollama') {
    body.max_tokens = maxTokens;
    if (jsonMode) body.format = 'json';
    return body;
  }
  body.max_completion_tokens = maxTokens;
  if (jsonMode) body.response_format = { type: 'json_object' };
  return body;
}

/**
 * Baut einen image_url-Content-Block. Das Wire-Format unterscheidet sich
 * ausgerechnet bei LM Studio: laut offenem Issue lmstudio-ai/lmstudio-bug-
 * tracker#1752 (Stand 0.4.9, Fehlermeldung "'url' field must be a base64
 * encoded image") lehnt der Server die data-URL ab und will rohes base64 im
 * `url`-Feld. Alle anderen OpenAI-kompatiblen Server (Ollama, vLLM, llama.cpp,
 * OpenAI selbst) wollen die data-URL. NICHT am echten LM Studio verifiziert —
 * betrifft im Zweifel ausschließlich Provider mit explizit gewähltem Dialekt
 * 'lmstudio', siehe internaldocs/FEATURE_PDF_RASTERIZER.md §9.1.
 */
function bildBlock(buffer, mime, dialekt) {
  const b64 = buffer.toString('base64');
  const url = dialekt === 'lmstudio' ? b64 : `data:${mime};base64,${b64}`;
  return { type: 'image_url', image_url: { url } };
}

export async function callOpenAI(model, prompt, opts, provider) {
  const { pdf, pdfs, bilder, system, maxTokens = 8192, cacheSystem = false, jsonMode = false, zweck } = opts || {};
  // Lokale Provider (Ollama/LM Studio) laufen typischerweise ohne Auth; nur bei
  // gesetztem Key wird ein Bearer geschickt. Der Built-in OpenAI braucht ihn.
  const apiKey = provider?.apiKey;
  if (!apiKey && provider?.id === 'openai') throw permanentError('OpenAI API-Key nicht konfiguriert');

  // Der Bestandsweg bleibt für nicht unterstützende Modelle unverändert. Für
  // OpenAI handeln wir die konkrete Modellunterstützung dynamisch aus.
  const fullText = system ? `${system}\n\n${prompt}` : prompt;
  let cachePolicy = openAIPromptCachePolicy({ provider, model, system, cacheSystem });

  const userContent = [];
  const pdfList = pdfs?.length ? pdfs : (pdf ? [pdf] : []);
  if (pdfList.length) {
    // Zweite Verteidigungslinie: der `file`-Block ist eine OpenAI-Eigenheit.
    // Jeder andere OpenAI-kompatible Server (LM Studio/llama.cpp, Ollama, vLLM)
    // antwortet darauf mit HTTP 400. Wer hier ein PDF durchreicht, ohne dass
    // der Provider es deklariert hat, soll das sofort und benannt erfahren —
    // nicht als undurchsichtigen 400 nach vier Retries.
    if (!kannPdfEmpfangen(provider?.caps)) {
      throw permanentError(
        `Provider "${provider?.label || provider?.id}" ist nicht als PDF-fähig deklariert — `
        + 'ein PDF-Datei-Block wird nicht gesendet.',
      );
    }
    pdfList.forEach((p, i) => {
      userContent.push({
        type: 'file',
        file: {
          filename: pdfList.length > 1 ? `document-${i + 1}.pdf` : 'document.pdf',
          file_data: `data:application/pdf;base64,${p.toString('base64')}`,
        },
      });
    });
  }
  if (bilder?.length) {
    // Zweite Verteidigungslinie, spiegelt den PDF-Guard oben: wer Bilder
    // durchreicht, ohne dass der Provider vision deklariert hat, soll das
    // sofort und benannt erfahren statt als undurchsichtigen 400.
    if (provider?.caps?.vision !== true) {
      throw permanentError(
        `Provider "${provider?.label || provider?.id}" ist nicht als vision-fähig deklariert — `
        + 'Bild-Blöcke werden nicht gesendet.',
      );
    }
    for (const b of bilder) userContent.push(bildBlock(b.buffer, b.mime, provider?.dialekt));
  }
  const makeBody = (policy, reasoningEffort) => {
    const explicitSystemCache = policy?.prompt_cache_key != null;
    // Auch beim Legacy-Fallback bleibt der stabile Teil ganz vorn als
    // System-Message. So kann dessen automatische Cachelogik den Prefix noch
    // erkennen; nur die neuen OpenAI-Marker werden entfernt.
    const separateSystem = cacheSystem && !!system;
    const content = [...userContent, { type: 'text', text: separateSystem ? prompt : fullText }];
    const messages = separateSystem
      ? [
          {
            role: 'system',
            content: explicitSystemCache
              ? [{
                  type: 'text', text: system,
                  // Nur dieser konstante Prefix ist cachebar; PDF/Bilder/Hinweise
                  // bleiben danach in der dynamischen User-Message.
                  prompt_cache_breakpoint: { mode: 'explicit' },
                }]
              : system,
          },
          { role: 'user', content },
        ]
      : [{ role: 'user', content }];
    const body = applyDialect(
      { model, messages, ...(policy || {}) },
      provider?.dialekt || 'openai',
      { maxTokens, jsonMode },
    );
    if (reasoningEffort != null) body.reasoning_effort = reasoningEffort;
    return body;
  };

  const headers = { 'content-type': 'application/json' };
  // Credentials nie in die URL, immer in den Header.
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const post = (body) => guardedFetch(chatCompletionsUrl(provider), {
    method: 'POST', headers, body: JSON.stringify(body),
  }, { allowPrivate: provider?.allowPrivate === true, timeoutMs: TIMEOUT_COMPLETION_MS });

  // reasoning_effort wird NUR für den benannten Sonderfall (Kostenträger-
  // Profilierung) überhaupt versucht — alle anderen Aufrufer dieser Funktion
  // (Klassifikation, Dokument-Parsing, …) bleiben unverändert ohne dieses
  // Feld, siehe lib/llm/thinking-policy.js.
  let reasoningEffort;
  let reasoningProbe = false;
  if (zweck === 'profilierung') {
    ({ effort: reasoningEffort, probe: reasoningProbe } =
      await resolveReasoningEffort(provider, model, 'plain', false, zweck));
  }

  let { response } = await post(makeBody(cachePolicy, reasoningEffort));
  let text = await readLimitedText(response);
  // Ältere oder neu konfigurierte Modelle verwerfen die neuen Felder mit 400.
  // Die Anfrage wurde noch nicht verarbeitet; einmal ohne Cache wiederholen und
  // die Capability nur temporär als nicht unterstützt merken.
  if (!response.ok && cachePolicy && isOpenAIPromptCacheUnsupportedError(response.status, text)) {
    markOpenAIPromptCacheUnsupported(provider, model);
    cachePolicy = null;
    ({ response } = await post(makeBody(cachePolicy, reasoningEffort)));
    text = await readLimitedText(response);
  }
  // reasoning_effort selbst verursacht den Fehler — lernen und sofort ohne
  // erneut versuchen, damit dieser Profilierungslauf trotzdem fertig wird.
  if (!response.ok && reasoningEffort != null && /reasoning_effort/i.test(text)) {
    await learnReasoningCapability(provider, model, 'plain', 'unsupported');
    reasoningEffort = undefined;
    ({ response } = await post(makeBody(cachePolicy, reasoningEffort)));
    text = await readLimitedText(response);
  } else if (response.ok && reasoningProbe && reasoningEffort != null) {
    await learnReasoningCapability(provider, model, 'plain', 'full');
  }
  if (!response.ok) {
    throw new NetGuardError(`${provider?.label || 'OpenAI'} API ${response.status}: ${text.slice(0, 300)}`, {
      zielIstPrivat: provider?.allowPrivate === true,
    });
  }

  const data = JSON.parse(text);
  let antwort = data.choices?.[0]?.message?.content;
  if (typeof antwort !== 'string') {
    throw new Error(`Unerwartetes Antwortformat von ${provider?.label || 'OpenAI'}: ${JSON.stringify(data).slice(0, 200)}`);
  }
  // Manche lokalen "Reasoning"-Setups (LM Studio, vLLM/llama.cpp-Templates mit
  // Thinking-Modus) schreiben den Gedankengang direkt mit in `content`, statt
  // ihn ins separate `reasoning_content`-Feld auszulagern. Ohne diesen Schnitt
  // würde ein abgeschlossener Denkblock als Nutztext durchgereicht — z. B. als
  // Chat-Titel. Ein NICHT geschlossener Block (Budget mitten im Denken
  // ausgegangen) bleibt bewusst unangetastet: dann ist `antwort` insgesamt
  // Denktext, und der Aufrufer soll das als "keine brauchbare Antwort" werten.
  antwort = antwort.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  return {
    text: antwort,
    usage: extractOpenAIUsage(data.usage),
  };
}

/**
 * Embeddings über denselben Provider-Eintrag. Der Aufrufer (lib/embedding.js)
 * ist der EINZIGE Pfad im System — hier steht nur der HTTP-Teil.
 */
export async function fetchOpenAIEmbedding(model, inputText, provider) {
  const apiKey = provider?.apiKey;
  if (!apiKey && provider?.id === 'openai') throw permanentError('OpenAI API-Key nicht konfiguriert');

  const headers = { 'content-type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const { response } = await guardedFetch(embeddingsUrl(provider), {
    method: 'POST', headers, body: JSON.stringify({ model, input: inputText }),
  }, { allowPrivate: provider?.allowPrivate === true, timeoutMs: TIMEOUT_COMPLETION_MS });

  const text = await readLimitedText(response);
  if (!response.ok) {
    throw new NetGuardError(`${provider?.label || 'OpenAI'} Embeddings ${response.status}: ${text.slice(0, 300)}`, {
      zielIstPrivat: provider?.allowPrivate === true,
    });
  }
  const data = JSON.parse(text);
  const vektor = data.data?.[0]?.embedding;
  if (!Array.isArray(vektor)) {
    throw new Error(`Unerwartetes Embedding-Format von ${provider?.label || 'OpenAI'}: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return { vektor, usage: data.usage || null };
}
