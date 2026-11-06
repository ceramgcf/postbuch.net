/**
 * lib/llm/providers/bedrock.js — Anthropic-Modelle über AWS Bedrock
 *
 * Nutzt als einziger Pfad das offizielle SDK (Bearer-Token-Auth gegen den
 * Bedrock-Runtime-Endpunkt) und teilt sich die Content-Builder mit anthropic.js.
 * Der Endpunkt ist AWS-fest, deshalb kein net-guard: es gibt hier keine frei
 * konfigurierbare baseUrl.
 */

import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';
import { permanentError, MAX_TOKENS_OHNE_GRENZE } from '../registry.js';
import { TIMEOUT_COMPLETION_MS } from '../../net-guard.js';
import {
  buildAnthropicUserContent,
  buildSystemParam,
  extractAnthropicUsageObj,
  extractAnthropicText,
} from './anthropic.js';

let cachedBedrock = null; // { client, apiKey, region }

export function getBedrockClient(apiKey, region) {
  if (!apiKey) throw permanentError('Bedrock API-Key nicht konfiguriert (llm_bedrock_key / BEDROCK_API_KEY)');
  const reg = region || 'eu-central-1';
  if (!cachedBedrock || cachedBedrock.apiKey !== apiKey || cachedBedrock.region !== reg) {
    cachedBedrock = { client: new AnthropicBedrock({ apiKey, awsRegion: reg }), apiKey, region: reg };
  }
  return cachedBedrock.client;
}

export async function callBedrock(model, prompt, { pdf, pdfs, system, maxTokens, cacheSystem, timeoutMs }, provider) {
  const client = getBedrockClient(provider?.apiKey, provider?.region);

  const body = {
    model,
    max_tokens: maxTokens ?? MAX_TOKENS_OHNE_GRENZE,
    messages: [{ role: 'user', content: buildAnthropicUserContent(pdfs ?? pdf, prompt) }],
  };
  const sys = buildSystemParam(system, cacheSystem);
  if (sys) body.system = sys;

  // Ein ausdrücklicher Timeout ersetzt die Schätzung des SDK, die ohne
  // Streaming jede große max_tokens-Angabe als „dauert länger als 10 Minuten“
  // ablehnt.
  const resp = await client.messages.create(body, { timeout: timeoutMs ?? TIMEOUT_COMPLETION_MS });
  return {
    text: extractAnthropicText(resp.content, 'Bedrock'),
    usage: extractAnthropicUsageObj(resp.usage),
    abgeschnitten: resp.stop_reason === 'max_tokens',
  };
}
