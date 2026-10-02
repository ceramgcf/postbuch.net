/**
 * lib/llm/providers/anthropic.js — Anthropic Messages API
 *
 * Herausgezogen aus lib/llm.js, Verhalten unverändert. Die Content-Builder
 * werden von bedrock.js und vom Abo-Pfad (claude-subscription.js) mitgenutzt.
 */

import { guardedFetch, readLimitedText, TIMEOUT_COMPLETION_MS, NetGuardError } from '../../net-guard.js';
import { joinUrl, permanentError } from '../registry.js';
import { resolveThinkingPolicy } from '../thinking-policy.js';

export const ANTHROPIC_VERSION = '2023-06-01';

/**
 * User-Content-Blöcke (optional PDF-Dokument(e) + Text). `pdfOrPdfs` nimmt
 * einen einzelnen Buffer (Regelfall) oder ein Array von Buffern entgegen —
 * Mehrfach-PDFs braucht z. B. die Kostenträger-Profilierung, die mehrere
 * Bescheide desselben Absenders in einem Lauf vergleicht.
 */
export function buildAnthropicUserContent(pdfOrPdfs, prompt) {
  const userContent = [];
  const pdfs = Array.isArray(pdfOrPdfs) ? pdfOrPdfs : (pdfOrPdfs ? [pdfOrPdfs] : []);
  for (const pdf of pdfs) {
    userContent.push({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: pdf.toString('base64') },
    });
  }
  userContent.push({ type: 'text', text: prompt });
  return userContent;
}

/**
 * system-Parameter. Mit cacheSystem wird ein Text-Block mit
 * cache_control:ephemeral gesendet (Prompt-Caching für die Batch-Verarbeitung).
 */
export function buildSystemParam(system, cacheSystem) {
  if (!system) return undefined;
  return cacheSystem
    ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
    : system;
}

export function extractAnthropicUsageObj(usage) {
  return {
    inputTokens:         usage?.input_tokens                ?? null,
    outputTokens:        usage?.output_tokens               ?? null,
    cacheCreationTokens: usage?.cache_creation_input_tokens ?? null,
    cacheReadTokens:     usage?.cache_read_input_tokens     ?? null,
  };
}

/**
 * Greift den Text-Block robust heraus (nicht blind content[0]): Neuere Modelle
 * stellen der Antwort teils einen — auch leeren — thinking-Block voran, selbst
 * ohne angefordertes Extended Thinking. Ein starres content[0].text würde eine
 * völlig gültige Antwort verwerfen.
 */
export function extractAnthropicText(content, quelle) {
  const text = content?.find((b) => b.type === 'text')?.text ?? content?.[0]?.text;
  if (typeof text !== 'string') {
    throw new Error(`Unerwartetes ${quelle}-Antwortformat: ${JSON.stringify(content).slice(0, 200)}`);
  }
  return text;
}

export function messagesUrl(provider) {
  return joinUrl(provider?.baseUrl || 'https://api.anthropic.com', 'v1/messages');
}

/**
 * Übersetzt eine Thinking-Policy (siehe lib/llm/thinking-policy.js) in die
 * Body-Felder der Messages API. `mode:'none'` liefert ein leeres Objekt
 * (Modell kennt Thinking nicht — keine Felder senden). `display:'summarized'`
 * macht Thinking im In-App-Fall sichtbar/streambar statt nur unsichtbar
 * mitzulaufen (Anthropic-Default für Sonnet-5/Opus-5 ist display:'omitted').
 */
export function buildThinkingBodyFields(policy) {
  if (!policy || policy.mode === 'none') return {};
  if (policy.mode === 'explicit-off') return { thinking: { type: 'disabled' } };
  return {
    thinking: { type: 'adaptive', display: 'summarized' },
    output_config: { effort: policy.effort },
  };
}

export async function callAnthropic(model, prompt, { pdf, pdfs, system, maxTokens, cacheSystem, zweck }, provider) {
  const apiKey = provider?.apiKey;
  if (!apiKey) throw permanentError('Anthropic API-Key nicht konfiguriert');

  const body = {
    model,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: buildAnthropicUserContent(pdfs ?? pdf, prompt) }],
  };
  const sys = buildSystemParam(system, cacheSystem);
  if (sys) body.system = sys;
  // Thinking-Felder werden NUR für den benannten Sonderfall (Kostenträger-
  // Profilierung) überhaupt gesetzt — alle anderen Aufrufer dieser Funktion
  // bleiben unverändert ohne Wire-Feld, siehe lib/llm/thinking-policy.js.
  if (zweck === 'profilierung') {
    Object.assign(body, buildThinkingBodyFields(resolveThinkingPolicy({ model, zweck })));
  }

  const { response } = await guardedFetch(messagesUrl(provider), {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-beta': 'pdfs-2024-09-25',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  }, { allowPrivate: provider?.allowPrivate === true, timeoutMs: TIMEOUT_COMPLETION_MS });

  const text = await readLimitedText(response);
  if (!response.ok) {
    throw new NetGuardError(`Anthropic API ${response.status}: ${text.slice(0, 300)}`, {
      zielIstPrivat: provider?.allowPrivate === true,
    });
  }

  const data = JSON.parse(text);
  return { text: extractAnthropicText(data.content, 'Anthropic'), usage: extractAnthropicUsageObj(data.usage) };
}
