/**
 * lib/llm/registry.js — providerId → { typ, baseUrl, apiKey, caps }
 *
 * Kein neues Konfigsystem: `_settings` bleibt Single Point of Truth.
 * Identität und Geheimnis sind aber getrennt:
 *
 *   _settings.llm_providers            → Liste, NICHT geheim (das UI muss listen können)
 *   _settings.llm_provider_key_<id>    → geheim, ein Eintrag pro Provider
 *
 * Rückwärtskompatibilität ohne Datenmigration: die vier Bestands-Provider sind
 * als reguläre Einträge mit reservierten IDs vorgeseedet, deren IDs identisch
 * zu ihren früheren Typnamen sind (anthropic, openai, bedrock, subscription).
 * Damit gilt: llm_model_leicht = 'claude-haiku-4-5' → providerFromModel →
 * 'anthropic' → ist eine gültige providerId. Ihre Keys liegen weiterhin unter
 * llm_anthropic_key / llm_openai_key / llm_bedrock_key / llm_claude_oauth_token.
 */

// ── Capabilities ─────────────────────────────────────────────────────────────
// Deklarativ pro Provider-Eintrag, KEIN Probing: ein Modell nimmt einen
// PDF-Block entgegen und ignoriert ihn still — das ist der schlimmste denkbare
// Ausgang, weil die Klassifikation dann halluziniert statt zu scheitern.
export const CAP_KEYS = ['pdf', 'vision', 'tools', 'streaming', 'promptCache', 'embeddings'];

export const PROVIDER_TYPES = ['anthropic', 'bedrock', 'subscription', 'openai-compatible'];

const CAPS_BY_TYPE = {
  anthropic:           { pdf: true,  vision: true,  tools: true, streaming: true, promptCache: true,  embeddings: false },
  bedrock:             { pdf: true,  vision: true,  tools: true, streaming: true, promptCache: true,  embeddings: false },
  // Das Agent-SDK reicht kein cache_control durch → kein Prompt-Cache.
  subscription:        { pdf: true,  vision: true,  tools: true, streaming: true, promptCache: false, embeddings: false },
  // Ein ChatGPT-Abo-Gegenstück gibt es bewusst NICHT (2026-07-31 wieder
  // ausgebaut): das Codex-Protokoll kennt nur `text` und `local_image`, einen
  // PDF-Datei-Block gibt es dort nicht (openai/codex#1797, seit 08/2025 offen).
  // Wer OpenAI-Modelle auf Dokumente ansetzen will, nimmt den API-Key-Provider
  // `openai` — der hat pdf: true und ist die einzige Strecke, die ein PDF
  // wirklich entgegennimmt.
  // Generisch (Ollama, LM Studio, vLLM, …): konservativ text-only annehmen.
  // Der Nutzer schaltet pdf/vision im UI frei, wenn sein Modell es kann.
  'openai-compatible': { pdf: false, vision: false, tools: true, streaming: true, promptCache: false, embeddings: true },
};

export function defaultCapsForType(typ) {
  return { ...(CAPS_BY_TYPE[typ] || CAPS_BY_TYPE['openai-compatible']) };
}

/** Konservativer Rückfall, wenn zu einem Modell kein Provider auflösbar ist:
 *  alles aus. Eingefroren, damit ein Aufrufer nicht versehentlich das Objekt
 *  aller Rückfälle mutiert. */
export const KEINE_CAPS = Object.freeze(
  Object.fromEntries(CAP_KEYS.map((k) => [k, false])),
);

// Harte Obergrenze für das providerspezifische Rasterlimit (rasterMaxSeiten).
// Nicht ästhetisch, sondern rechnerisch: renderPdfToImages() hält ein
// Byte-Budget von 12 MB, und eine Graustufenseite wiegt 200-600 KB — jenseits
// von ~32 Seiten scheitert der Lauf ohnehin am Budget, nachdem Ghostscript
// zweimal 90 s gerendert hat. Der DEFAULT (8) steht bewusst nicht hier,
// sondern bleibt in lib/pdf.js beim Rasterizer selbst.
export const RASTER_MAX_SEITEN_GRENZE = 32;

/**
 * Normalisiert das providerspezifische Rasterlimit.
 *
 * `undefined` heißt „kein eigener Wert" — der Rasterizer-Default aus
 * lib/pdf.js greift. Ein persistierter Default würde die 8 in alten Einträgen
 * einfrieren, sobald die Konstante dort einmal angefasst wird.
 *
 * Der gefährlichste Wert ist nicht der zu große, sondern die 0: Ghostscript
 * mit `-dLastPage=0` schreibt keine Datei, der Bilder-Block entfällt still und
 * das Modell klassifiziert echte Post blind. Deshalb Untergrenze 1.
 */
export function normalizeRasterMaxSeiten(wert) {
  const n = Math.floor(Number(wert));
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(n, RASTER_MAX_SEITEN_GRENZE);
}

// ── Antwort-Tokens ───────────────────────────────────────────────────────────
// `max_tokens` wird von jedem Adapter unverändert an die API durchgereicht.
// Liegt der Wert über dem, was das Modell als Ausgabe zulässt, antwortet die
// API mit einem harten 400 – nicht mit einer stillen Kürzung. Deshalb dieselbe
// Bauweise wie bei rasterMaxSeiten: eine deklarative, pro Provider pflegbare
// Obergrenze (kein Probing, keine Modelltabelle). `undefined` heißt „kein
// eigener Wert" und lässt den Aufrufer-Wunsch unangetastet.
export const MAX_OUTPUT_TOKENS_MIN = 256;
export const MAX_OUTPUT_TOKENS_GRENZE = 200000;

/**
 * Rückfallwert, wenn ein Provider den gewünschten `max_tokens` ablehnt: die
 * kleinste Ausgabegrenze, die unter den gängigen Modellen noch anzutreffen ist
 * (gpt-4-turbo, claude-3-opus). Eine womöglich abgeschnittene Antwort ist
 * besser als gar keine – siehe den einmaligen Wiederholversuch in
 * lib/llm.js (callModel).
 */
export const MAX_TOKENS_NOTFALL = 4096;

export function normalizeMaxOutputTokens(wert) {
  const n = Math.floor(Number(wert));
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(Math.max(n, MAX_OUTPUT_TOKENS_MIN), MAX_OUTPUT_TOKENS_GRENZE);
}

/** Deckelt den Wunschwert auf die beim Provider hinterlegte Obergrenze. */
export function clampMaxTokens(maxTokens, provider) {
  const grenze = provider?.maxOutputTokens;
  if (!Number.isFinite(grenze) || grenze <= 0) return maxTokens;
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) return maxTokens;
  return Math.min(maxTokens, grenze);
}

/** Markiert einen Fehler als dauerhaft (Konfigurationsfehler): ein Retry nach
 *  Wartezeit kann daran nichts ändern, im Unterschied zu transienten Fehlern
 *  (Netzwerk, Rate-Limit, Server down). Die Retry-Schleifen in lib/llm.js
 *  brechen früh ab, wenn ALLE Modelle einer Kette dauerhaft fehlschlagen.
 *  Zentral hier (statt in llm.js), damit auch die Provider-Adapter und
 *  claude-subscription.js sie ohne Zirkelimport nutzen können. */
export function permanentError(msg) {
  const err = new Error(msg);
  err.permanent = true;
  return err;
}

/**
 * Darf diesem Provider ein PDF als Datei-Block geschickt werden?
 *
 * `vision` heißt „versteht Bild-Blöcke (image_url)", NICHT „kann ein PDF lesen".
 * Solange es keinen PDF→PNG-Rasterizer gibt (lib/pdf.js), ist ein vision-only-
 * Provider für Dokumente text-only: der OpenAI-Datei-Block
 * (`{type:'file', file_data:…}`) existiert praktisch nur beim echten OpenAI —
 * LM Studio/llama.cpp, Ollama & Co. quittieren ihn mit HTTP 400.
 *
 * Sobald der Rasterizer existiert, wird daraus ein ZWEITER Zweig (rastern und
 * als image_url schicken), niemals wieder ein `|| caps.vision`.
 */
export function kannPdfEmpfangen(caps) {
  return caps?.pdf === true;
}

/**
 * Sieht das Modell die Dokumentseite überhaupt — als PDF-Datei ODER als
 * gerastertes Bild? Anders als kannPdfEmpfangen() ist das keine Aussage über
 * die Leitung (PDF-Datei-Block vs. image_url-Block), sondern über die
 * Fähigkeit des Modells, für UI-Zwecke (textOnly-Anzeigen, „Textebene
 * verwerfen"-Schalter). Die eigentliche Aufbereitungs-Entscheidung
 * (inputMode 'pdf'/'bilder'/'text') fällt weiterhin in makeDocPreparer()
 * (lib/llm.js), nicht hier.
 */
export function kannDokumentSehen(caps) {
  return caps?.pdf === true || caps?.vision === true;
}

function normalizeCaps(typ, caps) {
  const base = defaultCapsForType(typ);
  if (!caps || typeof caps !== 'object') return base;
  const out = { ...base };
  for (const k of CAP_KEYS) {
    if (typeof caps[k] === 'boolean') out[k] = caps[k];
  }
  return out;
}

// ── Built-ins ────────────────────────────────────────────────────────────────
// Reservierte IDs. Sie können im UI bearbeitet (Label, Caps, baseUrl), aber
// nicht gelöscht oder umbenannt werden — sonst zeigen bestehende
// llm_model_*-Werte ins Leere.
export const BUILTIN_PROVIDER_IDS = ['anthropic', 'openai', 'bedrock', 'subscription'];

const BUILTINS = {
  anthropic: {
    id: 'anthropic', typ: 'anthropic', label: 'Anthropic',
    baseUrl: 'https://api.anthropic.com', legacyKeySetting: 'llm_anthropic_key',
  },
  openai: {
    id: 'openai', typ: 'openai-compatible', label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1', legacyKeySetting: 'llm_openai_key',
    // Der Built-in OpenAI kann mehr als ein generisches openai-compatible Ziel.
    // Der Adapter prüft Modell, Dialekt und api.openai.com zusätzlich. Diese
    // Capability erlaubt nur den stabilen Cache-Mode-Prefix des Built-ins.
    capsOverride: { pdf: true, vision: true, tools: true, streaming: true, promptCache: true, embeddings: true },
  },
  bedrock: {
    id: 'bedrock', typ: 'bedrock', label: 'AWS Bedrock',
    baseUrl: null, legacyKeySetting: 'llm_bedrock_key',
  },
  subscription: {
    id: 'subscription', typ: 'subscription', label: 'Claude-Abo',
    baseUrl: null, legacyKeySetting: 'llm_claude_oauth_token',
  },
};

// ── Presets fürs UI ──────────────────────────────────────────────────────────
// LM Studio ist unter /v1 OpenAI-kompatibel (chat/completions, embeddings,
// models) und folgt der OpenAI-Konvention (response_format/json_schema) — also
// näher am Standard als Ollama, das `format` und `max_tokens` will. Deshalb
// kein eigener Adaptertyp, nur ein eigenes Preset + Dialekt-Flag.
export const PROVIDER_PRESETS = [
  // Kein "OpenAI"-Preset: der eingebaute Provider (fixe ID `openai`, siehe
  // BUILTINS oben) deckt genau diesen Endpunkt bereits vollständig ab,
  // inklusive der speziellen capsOverride. Ein zweiter, per "Hinzufügen"
  // angelegter Provider mit derselben Basis-URL bekäme nur die schwachen
  // Fallback-Caps von 'openai-compatible' (kein PDF/Vision/Cache) und würde
  // im UI wie ein funktionsgleiches Duplikat aussehen, ohne es zu sein.
  { key: 'anthropic',  label: 'Anthropic',     typ: 'anthropic',         baseUrl: 'https://api.anthropic.com',        dialekt: 'anthropic' },
  { key: 'bedrock',    label: 'AWS Bedrock',   typ: 'bedrock',           baseUrl: null,                               dialekt: 'anthropic' },
  { key: 'ollama',     label: 'Ollama',        typ: 'openai-compatible', baseUrl: 'http://host.docker.internal:11434/v1', dialekt: 'ollama',
    caps: { pdf: false, vision: false, tools: true, streaming: true, promptCache: false, embeddings: true }, kostenNull: true },
  // vision bewusst false trotz Rasterizer: das Wire-Format für Bild-Blöcke ist
  // bei LM Studio unklar (offenes Issue, siehe Dialekt 'lmstudio' unten) und am
  // Zielsystem nicht verifiziert. Der Nutzer schaltet vision frei, sobald er
  // geprüft hat, dass sein LM-Studio-Modell Bilder tatsächlich entgegennimmt.
  { key: 'lmstudio',   label: 'LM Studio',     typ: 'openai-compatible', baseUrl: 'http://host.docker.internal:1234/v1', dialekt: 'lmstudio',
    caps: { pdf: false, vision: false, tools: true, streaming: true, promptCache: false, embeddings: true }, kostenNull: true },
  { key: 'openrouter', label: 'OpenRouter',    typ: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1',     dialekt: 'openai' },
  { key: 'custom',     label: 'Benutzerdefiniert', typ: 'openai-compatible', baseUrl: '',                             dialekt: 'openai' },
];

// ── Auflösung ────────────────────────────────────────────────────────────────

export const PROVIDER_KEY_PREFIX = 'llm_provider_key_';
export const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9_-]{0,48}$/;

function keySettingFor(id) {
  return `${PROVIDER_KEY_PREFIX}${id}`;
}

/**
 * Liest die konfigurierten Provider-Einträge (ohne Secrets) aus den Settings.
 * Built-ins sind immer dabei, auch wenn llm_providers leer ist.
 *
 * @returns {Array<{id,typ,label,baseUrl,dialekt,aktiv,caps,builtin}>}
 */
export function listProviders(settings) {
  const s = settings || {};
  const konfiguriert = Array.isArray(s.llm_providers) ? s.llm_providers : [];
  const byId = new Map();

  for (const id of BUILTIN_PROVIDER_IDS) {
    const b = BUILTINS[id];
    byId.set(id, {
      id: b.id,
      typ: b.typ,
      label: b.label,
      baseUrl: b.baseUrl,
      dialekt: b.typ === 'openai-compatible' ? 'openai' : b.typ,
      aktiv: true,
      caps: b.capsOverride ? { ...b.capsOverride } : defaultCapsForType(b.typ),
      builtin: true,
    });
  }

  for (const raw of konfiguriert) {
    if (!raw || typeof raw !== 'object' || !raw.id) continue;
    const id = String(raw.id);
    if (!PROVIDER_ID_RE.test(id)) continue;
    const vorhanden = byId.get(id);
    // Built-ins: Typ und ID sind fix, alles andere darf überschrieben werden.
    const typ = vorhanden?.builtin
      ? vorhanden.typ
      : (PROVIDER_TYPES.includes(raw.typ) ? raw.typ : 'openai-compatible');
    byId.set(id, {
      id,
      typ,
      label: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : (vorhanden?.label || id),
      baseUrl: typeof raw.baseUrl === 'string' && raw.baseUrl.trim() ? raw.baseUrl.trim() : (vorhanden?.baseUrl ?? null),
      dialekt: ['openai', 'ollama', 'anthropic', 'lmstudio'].includes(raw.dialekt)
        ? raw.dialekt
        : (vorhanden?.dialekt || (typ === 'openai-compatible' ? 'openai' : typ)),
      aktiv: raw.aktiv !== false,
      caps: normalizeCaps(typ, raw.caps ?? vorhanden?.caps),
      // Auch im LESEpfad klemmen, nicht nur in der Schreibroute: llm_providers
      // kann aus einem Backup-Restore oder per Hand in die DB kommen — dieselbe
      // Logik wie bei isProviderKeySetting (GET **und** PUT).
      rasterMaxSeiten: normalizeRasterMaxSeiten(raw.rasterMaxSeiten),
      maxOutputTokens: normalizeMaxOutputTokens(raw.maxOutputTokens),
      builtin: !!vorhanden?.builtin,
      // Private Netzwerkziele nur mit ausdrücklichem Opt-in pro Provider.
      erlaubtPrivateZiele: raw.erlaubtPrivateZiele === true,
    });
  }

  return Array.from(byId.values());
}

/**
 * Vollständiger Provider-Eintrag INKLUSIVE apiKey. Niemals unverändert an einen
 * HTTP-Client geben — beim Loggen nur die id, nie den Wert.
 *
 * @returns {object|null}
 */
export function getProvider(settings, providerId) {
  if (!providerId) return null;
  const eintrag = listProviders(settings).find((p) => p.id === providerId);
  if (!eintrag) return null;
  const s = settings || {};
  const legacy = BUILTINS[providerId]?.legacyKeySetting;
  // Der providerspezifische Key gewinnt; für Built-ins bleibt der Altschlüssel
  // als Fallback gültig, damit ein Update ohne Neukonfiguration durchläuft.
  const apiKey = s[keySettingFor(providerId)] || (legacy ? s[legacy] : null) || null;
  // Private Ziele: Provider-Opt-in ODER globaler Schalter.
  const allowPrivate = eintrag.erlaubtPrivateZiele === true || s.llm_allow_private_targets === true;
  return { ...eintrag, apiKey, allowPrivate };
}

/** Alle Provider, die Embeddings anbieten (fürs UI-Dropdown). */
export function listEmbeddingProviders(settings) {
  return listProviders(settings).filter((p) => p.aktiv && p.caps.embeddings);
}

/** Setting-Schlüssel des Geheimnisses eines Providers. */
export function providerKeySetting(id) {
  return keySettingFor(id);
}

/**
 * Ist dieser Setting-Schlüssel ein Geheimnis? Präfixregel statt Blockliste —
 * einzusetzen bei GET **und** bei PUT. Nur bei GET eingebaut hieße: jeder
 * darf fremde Keys überschreiben.
 */
export function isProviderKeySetting(key) {
  return typeof key === 'string' && key.startsWith(PROVIDER_KEY_PREFIX);
}

// ── Endpunkt-Bau ─────────────────────────────────────────────────────────────

/** `baseUrl` + Pfad, ohne doppelte Slashes. */
export function joinUrl(baseUrl, pfad) {
  if (!baseUrl) throw permanentError('baseUrl ist nicht konfiguriert');
  return `${String(baseUrl).replace(/\/+$/, '')}/${String(pfad).replace(/^\/+/, '')}`;
}

export function chatCompletionsUrl(provider) {
  return joinUrl(provider.baseUrl, 'chat/completions');
}

export function embeddingsUrl(provider) {
  return joinUrl(provider.baseUrl, 'embeddings');
}

export function modelsUrl(provider) {
  return joinUrl(provider.baseUrl, 'models');
}
