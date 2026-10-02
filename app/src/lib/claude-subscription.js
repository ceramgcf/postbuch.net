/**
 * lib/claude-subscription.js — Claude-Modelle über eine Claude-Subscription
 * (Pro/Max/Team) statt über einen Anthropic-API-Key abrechnen.
 *
 * Nutzt das Claude Agent SDK (@anthropic-ai/claude-agent-sdk), das den
 * gebündelten Claude-Code-Client als Subprozess fährt und sich via
 * CLAUDE_CODE_OAUTH_TOKEN gegen die Subscription authentifiziert. Wir fahren
 * das SDK bewusst „nicht-agentisch": eine einzige User-Message (PDF + Text),
 * keine Tools, maxTurns=1 — also faktisch ein einzelner Messages-API-Call,
 * nur über die Subscription-Schiene.
 *
 * Feature-Gate: Der gesamte Pfad ist hinter einem dev-Key (ENV
 * POSTBUCH_SDK_DEV_KEY) verriegelt. Ohne gültigen Key existiert die Option
 * weder im Backend-Routing noch im UI. Wer den Code editiert, umgeht das
 * bewusst — dann wird es aber nicht mehr „angeboten".
 */

import os from 'node:os';
import { permanentError } from './llm/registry.js';
import { devFeatureUnlocked } from './dev-gate.js';
import { resolveThinkingPolicy } from './llm/thinking-policy.js';

// ── Subprozess-Concurrency-Guard ──────────────────────────────────────────
//
// Das SDK spawnt für jeden query()-Aufruf einen eigenen Claude-Code-Subprozess
// (natives ARM-Binary, ~260 MB) — auf dem Raspberry Pi, auf dem diese App
// produktiv läuft, ist mehr als ein gleichzeitiger Subprozess ein reales
// OOM-Risiko. Zwei getrennte Mechanismen für zwei getrennte Probleme:
//
// 1. Cross-Session-Mutex (genau 1 gleichzeitiger Subprozess systemweit, auch
//    über verschiedene Chat-Nutzer/-Tabs UND die Dokument-Pipeline hinweg —
//    alle Aufrufer laufen über callClaudeSubscription/streamClaudeSubscriptionAgent).
// 2. Reentrancy-Flag: der Haupt-Agent-Lauf (streamClaudeSubscriptionAgent)
//    IST bereits der eine erlaubte Subprozess. Ruft er intern sein eigenes
//    Vision-Tool auf (get_document_pdf_vision → callClaudeSubscription), darf
//    das NICHT auf den Mutex warten (der Hauptlauf hält ihn ja gerade selbst
//    → Deadlock), sondern muss seitwärts auf die reguläre Anthropic-API
//    ausweichen. Das übernimmt lib/llm.js callModel() anhand von
//    isInsideAgentSubprocess() — kein Sonderfall-Code im Tool-Handler nötig.
let mutexTail = Promise.resolve();
function withSubprocessSlot(fn) {
  const run = mutexTail.then(fn, fn);
  mutexTail = run.then(() => {}, () => {});
  return run;
}

let insideAgentSubprocess = false;
export function isInsideAgentSubprocess() {
  return insideAgentSubprocess;
}

// SHA-256 des gültigen dev-Keys. Nur der Hash liegt im Repo; der Klartext-Key
// wird an „friendly user" herausgegeben und von diesen als ENV gesetzt.
/**
 * Ist das Subscription-/SDK-Feature freigeschaltet? Vergleicht den sha256 des
 * ENV-Werts POSTBUCH_SDK_DEV_KEY mit dem im Code hinterlegten Hash.
 */
export function subscriptionFeatureUnlocked() {
  return devFeatureUnlocked();
}

// Eingebaute Claude-Code-Tools, die in KEINEM Subscription-Pfad verfügbar sein
// dürfen (weder Single-Turn-Analyse noch Agentic-Chat) — nur die App-eigenen
// Tools sollen laufen. Bare Namen für disallowedTools; die Availability-Ebene
// (tools: []) und ggf. eine allowedTools-Whitelist kommen zusätzlich pro Aufrufer.
const DISALLOWED_BUILTIN_TOOLS = [
  'Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch',
  'Agent', 'Task', 'Monitor', 'NotebookEdit', 'TodoWrite',
];

// KRITISCH: ANTHROPIC_API_KEY/AUTH_TOKEN würden laut Auth-Präzedenz den
// OAuth-Token überstimmen → man würde API-Credits statt der Subscription
// verbrauchen. Daher explizit aus der Subprozess-Env entfernen. Zentral hier,
// damit kein Aufrufer diese Sicherheitslogik separat (und ggf. abweichend)
// nachbaut.
function buildSanitizedEnv(oauthToken) {
  return {
    ...process.env,
    ANTHROPIC_API_KEY: undefined,
    ANTHROPIC_AUTH_TOKEN: undefined,
    CLAUDE_CODE_USE_BEDROCK: undefined,
    CLAUDE_CODE_USE_VERTEX: undefined,
    CLAUDE_CODE_USE_FOUNDRY: undefined,
    CLAUDE_CODE_OAUTH_TOKEN: oauthToken,
    CLAUDE_CONFIG_DIR: '/tmp/.claude-pb',
  };
}

/**
 * Sendet einen Klassifikations-Call über die Claude-Subscription.
 * Signatur/Rückgabe sind kompatibel zu callAnthropic() in llm.js.
 *
 * @param {string} model        - Modell-ID (claude-*) oder Alias (sonnet/haiku/opus)
 * @param {string} prompt       - User-Text-Prompt
 * @param {object} opts
 * @param {Buffer} [opts.pdf]    - Optionales PDF als Buffer
 * @param {Buffer[]} [opts.pdfs] - Optionale mehrere PDFs (z. B. Kostenträger-Profilierung)
 * @param {string} [opts.system] - Optionaler System-Prompt (String = Vollersatz)
 * @param {number} [opts.maxTokens] - Output-Token-Limit (via CLAUDE_CODE_MAX_OUTPUT_TOKENS)
 * @param {Buffer[]|null} [buildUserContent] - Reused Content-Builder aus llm.js
 * @param {string} oauthToken    - CLAUDE_CODE_OAUTH_TOKEN
 * @returns {Promise<{ text: string, usage: object }>}
 */
export async function callClaudeSubscription(model, prompt, { pdf, pdfs, system, maxTokens } = {}, buildUserContent, oauthToken) {
  if (!oauthToken) throw permanentError('Claude-Subscription-Token nicht konfiguriert (llm_claude_oauth_token)');

  // Lazy-Import: das SDK lädt einen plattformspezifischen Binary nach. Nur laden,
  // wenn der Pfad wirklich genutzt wird (verhindert Startfehler bei deaktiviertem Feature).
  const { query } = await import('@anthropic-ai/claude-agent-sdk');

  // KRITISCH (stdin-Zeilenlimit): Das Claude Agent SDK reicht jede User-Message als
  // EINE Zeile stream-json über stdin an den Claude-Code-Subprozess. Stecken ein
  // großer Prompt UND ein base64-PDF gemeinsam in dieser User-Message, sprengt die
  // Zeile den Zeilen-Parser des CLI → "Error parsing streaming input line" → Exit 1.
  // Deshalb bei vorhandenem PDF den gesamten Anweisungstext in den systemPrompt
  // verlagern und im User-Turn nur das PDF + einen kurzen Hinweis lassen. Das hält
  // die stdin-Zeile klein und entspricht der bewährten Cache-Mode-Struktur
  // (System = Anweisungen, User = Dokument).
  const pdfPayload = pdfs?.length ? pdfs : pdf;
  let effectiveSystem;
  let content;
  if (pdfPayload) {
    effectiveSystem = [system, prompt].filter(Boolean).join('\n\n');
    content = buildUserContent(
      pdfPayload,
      'Analysiere die beigefügten Dokumente gemäß den Anweisungen im System-Prompt und gib ausschließlich das geforderte Ergebnis zurück.',
    );
  } else {
    effectiveSystem = system || '';
    content = buildUserContent(null, prompt);
  }

  // Genau eine User-Message; nach dem yield ist der Input geschlossen → das SDK
  // produziert eine einzelne Assistant-Antwort und ein result-Event.
  async function* singleMessage() {
    yield {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
    };
  }

  const sanitizedEnv = buildSanitizedEnv(oauthToken);
  // Output-Token-Limit des Aufrufers durchsetzen. Ohne dieses Cap kennt der
  // Claude-Code-Subprozess kein Limit — Vision-Calls produzierten dann 12–15k
  // Output-Tokens (2+ Minuten Laufzeit) statt einer kompakten Antwort.
  if (maxTokens) sanitizedEnv.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(maxTokens);

  // stderr des Claude-Code-Subprozesses einsammeln. Ohne das meldet das SDK bei
  // einem Absturz nur „Claude Code process exited with code 1" — die eigentliche
  // Ursache (z. B. Opus-Nutzungslimit der Subscription, Auth-/Modellfehler) steckt
  // im stderr und wäre sonst verloren.
  let stderrBuf = '';
  // Ergänzt eine Fehlermeldung um das gesammelte stderr (gekürzt), damit die
  // tatsächliche Ursache im llm_call_log/Pipeline-Log sichtbar wird.
  const withStderr = (msg) => {
    const tail = stderrBuf.trim().slice(-600);
    return tail ? `${msg} — stderr: ${tail}` : msg;
  };

  // Subprozess-Spawn + Konsum unter dem Cross-Session-Mutex (siehe Kommentar
  // oben): genau ein Claude-Code-Subprozess gleichzeitig auf dem Pi.
  let resultMsg = await withSubprocessSlot(async () => {
    const q = query({
      prompt: singleMessage(),
      options: {
        model,
        // String = vollständiger Ersatz des Claude-Code-Default-Prompts (verhindert,
        // dass dessen umfangreicher Default reinblutet). Enthält bei PDF-Calls die
        // komplette Anweisung (siehe effectiveSystem oben).
        systemPrompt: effectiveSystem,
        maxTurns: 1,
        // Kein Extended Thinking im Single-Turn-Analyse-Pfad — konsistent mit dem
        // API-Pfad (callAnthropic sendet keinen thinking-Parameter). Claude Code
        // aktiviert Thinking sonst per Default; bei Vision-/Klassifikations-Calls
        // trieb das Output-Tokens und Laufzeit massiv hoch, ohne dass der Aufrufer
        // es angefordert hätte. Gilt unabhängig von viaMcp/In-App — dieser Pfad ist
        // die enge Dokumenten-Extraktion, nicht das sichtbare Chat-Thinking.
        thinking: { type: 'disabled' },
        // Availability-Ebene wie in streamClaudeSubscriptionAgent(): OHNE tools:[]
        // schickt Claude Code die vollständigen Schemata seiner eingebauten Tools
        // mit — gemessen ~11.700 Input-Tokens pro Call, obwohl dieser Single-Turn-
        // Pfad gar keine Tools nutzen darf. allowedTools/disallowedTools verbieten
        // nur die Ausführung, sie halten die Definitionen nicht aus dem Kontext.
        tools: [],
        allowedTools: [],
        disallowedTools: DISALLOWED_BUILTIN_TOOLS,
        settingSources: [],
        cwd: os.tmpdir(),
        env: sanitizedEnv,
        stderr: (data) => { if (stderrBuf.length < 4000) stderrBuf += data; },
      },
    });

    let result = null;
    try {
      for await (const msg of q) {
        if (msg.type === 'result') result = msg;
      }
    } catch (err) {
      throw new Error(withStderr(err.message || 'Claude-Subscription: Subprozess-Fehler'));
    }
    return result;
  });

  if (!resultMsg) {
    throw new Error(withStderr('Claude-Subscription: kein result-Event erhalten'));
  }
  if (resultMsg.is_error || resultMsg.subtype !== 'success') {
    const detail = Array.isArray(resultMsg.errors) ? resultMsg.errors.join('; ') : (resultMsg.subtype || 'unknown');
    throw new Error(withStderr(`Claude-Subscription-Fehler: ${detail}`));
  }
  if (typeof resultMsg.result !== 'string') {
    throw new Error('Claude-Subscription: unerwartetes result-Format');
  }

  const u = resultMsg.usage || {};
  return {
    text: resultMsg.result,
    // Vollständige Usage-Info des SDK durchreichen (Input/Output + Cache). Beim Abo
    // wird zwar nichts pro Token abgerechnet (Kosten = 0, siehe callModel), aber die
    // Token-Werte sind echte Nutzungsdaten des Claude-Code-Clients (der intern sehr
    // wohl Prompt-Caching macht). Sie nur teilweise zu loggen wäre inkonsistent und
    // lässt die Input-Zahlen unsinnig klein wirken; daher vollständig loggen und im
    // UI lediglich abgeschwächt (opacity) darstellen.
    usage: {
      inputTokens:         u.input_tokens                ?? null,
      outputTokens:        u.output_tokens               ?? null,
      cacheCreationTokens: u.cache_creation_input_tokens ?? null,
      cacheReadTokens:     u.cache_read_input_tokens     ?? null,
    },
  };
}

/**
 * Fährt einen mehrstufigen Agentic-Loop (Recherche + Synthese in einem
 * durchgehenden Query) über die Claude-Subscription, mit App-eigenen Custom-
 * Tools statt der eingebauten Claude-Code-Tools. Für den Bürochat (siehe
 * service/chat-agent.js): ersetzt bei aktivem Abo den bisherigen Zwei-Phasen-
 * Ablauf (getrenntes Research-/Synthese-Modell über die reguläre API) — die
 * Kostenoptimierung durch getrennte Modelle ist beim Abo-Pauschaltarif
 * hinfällig, ein einziger Query mit Tool-Use ist die naheliegendere Lösung.
 *
 * Sicherheits-Riegel (dreifach, siehe Security-Review vor Einführung dieser
 * Funktion): `tools: []` entfernt alle eingebauten Claude-Code-Tools aus dem
 * Modell-Kontext (Availability-Ebene), `allowedTools` whitelisted zusätzlich
 * explizit nur die übergebenen MCP-Tool-Namen, und `canUseTool` lehnt
 * defensiv jeden Aufruf hart ab, der nicht auf dieser Whitelist steht — falls
 * eine SDK-Version die Availability-Ebene abweichend auslegt, greift diese
 * dritte Ebene trotzdem. Ein Wall-Clock-Timeout (AbortController) verhindert
 * einen hängenden/loopenden Subprozess.
 *
 * Echtes Token-Streaming: Text- UND Thinking-Deltas gehen sofort bei Eintreffen
 * an onToken/onThinking raus (kein Puffern bis Turn-Ende mehr). Das gibt vorab
 * ausdrücklich das früher gepflegte Verhalten "Recherche-Geplauder vor einem
 * Tool-Aufruf bleibt unsichtbar" auf — bei echtem Delta-Streaming lässt sich
 * NICHT vorhersehen, ob ein Textblock am Ende doch noch mit tool_use endet
 * (das steht erst fest, wenn es passiert). Der System-Prompt verbietet
 * Ankündigungs-Geplauder ohnehin explizit ("Handeln statt ankündigen"); das
 * Restrisiko eines vereinzelten Satzes vor einem Tool-Aufruf wiegt weniger
 * als ein Chat, der 50-270s lang nichts zeigt. Tool-Nutzung selbst bleibt ein
 * separates onProgress-Label ("Nutze Werkzeug: …").
 *
 * @param {object} params
 * @param {string}   params.model
 * @param {string}   params.systemPrompt   - Vollständiger, session-übergreifend STABILER System-Prompt
 *   (Verlauf/Referenzen gehören in userMessage, nicht hierher — sonst bricht der
 *   serverseitige Prompt-Cache bei jeder Folgefrage, siehe chat-agent.js).
 * @param {string}   params.userMessage    - Aktuelle Nutzerfrage inkl. ggf. vorangestelltem Verlauf/Referenzblock
 * @param {Array<{name: string, description: string, shape: object, handler: Function}>} params.tools
 * @param {number}   [params.maxTurns=16]
 * @param {number}   [params.timeoutMs=180000]
 * @param {Function} params.onToken        - (text) => void — Antwort-Text, live gestreamt
 * @param {Function} [params.onThinking]   - (text) => void — Thinking-Text, live gestreamt (nur wenn Policy 'adaptive')
 * @param {Function} [params.onProgress]   - (label) => void — Tool-Nutzung/Zwischenstand
 * @param {AbortSignal} [params.abortSignal] - Externes Signal (z.B. Client-Disconnect) — bricht den Subprozess sofort ab
 * @param {boolean}  [params.viaMcp=false] - Anfrage kam über den MCP-Connector → Thinking-Policy 'explicit-off'
 * @param {string}   oauthToken
 * @returns {Promise<{ usage: object, numTurns: number }>}
 */
export async function streamClaudeSubscriptionAgent(
  { model, systemPrompt, userMessage, tools, maxTurns = 16, timeoutMs = 180000, onToken, onThinking, onProgress, abortSignal = null, viaMcp = false },
  oauthToken,
) {
  if (!oauthToken) throw permanentError('Claude-Subscription-Token nicht konfiguriert (llm_claude_oauth_token)');

  const { query, tool, createSdkMcpServer } = await import('@anthropic-ai/claude-agent-sdk');

  const sdkTools = tools.map((t) => tool(t.name, t.description, t.shape, t.handler));
  const mcpServer = createSdkMcpServer({ name: 'postbuch', tools: sdkTools });
  const allowedToolNames = tools.map((t) => `mcp__postbuch__${t.name}`);

  async function* singleMessage() {
    yield {
      type: 'user',
      message: { role: 'user', content: userMessage },
      parent_tool_use_id: null,
    };
  }

  let stderrBuf = '';
  const abortController = new AbortController();
  // Timeout vs. externer Abbruch unterscheiden — das SDK wirft in beiden Fällen
  // dieselbe generische Meldung („aborted by user"), die für den Nutzer irreführend ist.
  let timedOut = false;
  const timeoutHandle = setTimeout(() => { timedOut = true; abortController.abort(); }, timeoutMs);
  // Externes Abbruch-Signal (Client-Disconnect/Stop-Button) auf den internen Controller
  // spiegeln, damit der SDK-Subprozess bei Reload/Verbindungsabbruch sofort endet.
  if (abortSignal) {
    if (abortSignal.aborted) abortController.abort();
    else abortSignal.addEventListener('abort', () => abortController.abort(), { once: true });
  }
  const timeoutError = () => new Error(
    `Die Analyse hat zu lange gedauert und wurde nach ${Math.round(timeoutMs / 60000)} Minuten beendet. ` +
    'Bitte stell die Frage noch einmal — bei mehreren Dokumenten am besten nacheinander fragen.'
  );

  // Thinking-Policy (siehe lib/llm/thinking-policy.js): In-App adaptiv mit
  // niedrigem effort, über MCP explizit aus. `effort` ist im SDK ein
  // Top-Level-Options-Feld (anders als die Messages API, die es unter
  // output_config schachtelt) — siehe sdk.d.ts EffortLevel/ThinkingConfig.
  const thinkingPolicy = resolveThinkingPolicy({ model, viaMcp });
  const thinkingOptions = thinkingPolicy.mode === 'none'
    ? {}
    : thinkingPolicy.mode === 'explicit-off'
      ? { thinking: { type: 'disabled' } }
      // display:'summarized' ist Pflicht — ohne dieses Feld bleibt Thinking auf dem
      // serverseitigen Default display:'omitted': das Modell denkt weiterhin (Kosten/
      // Latenz wie erwartet), aber es kommen nie thinking_delta-Events an, onThinking
      // bleibt für immer stumm. Pendant zu buildThinkingBodyFields() in
      // lib/llm/providers/anthropic.js, das dasselbe für die Messages API bereits setzt.
      : { thinking: { type: 'adaptive', display: 'summarized' }, effort: thinkingPolicy.effort };

  const q = query({
    prompt: singleMessage(),
    options: {
      model,
      systemPrompt,
      maxTurns,
      tools: [], // Availability-Ebene: keine eingebauten Tools im Modell-Kontext, nur mcpServers
      allowedTools: allowedToolNames,
      disallowedTools: DISALLOWED_BUILTIN_TOOLS,
      canUseTool: async (toolName) => (
        allowedToolNames.includes(toolName)
          ? { behavior: 'allow' }
          : { behavior: 'deny', message: `Werkzeug "${toolName}" ist in diesem Kontext nicht verfügbar.` }
      ),
      mcpServers: { postbuch: mcpServer },
      includePartialMessages: true,
      settingSources: [],
      cwd: os.tmpdir(),
      env: buildSanitizedEnv(oauthToken),
      abortController,
      stderr: (data) => { if (stderrBuf.length < 4000) stderrBuf += data; },
      ...thinkingOptions,
    },
  });

  const withStderr = (msg) => {
    const tail = stderrBuf.trim().slice(-600);
    return tail ? `${msg} — stderr: ${tail}` : msg;
  };

  let resultMsg = null;
  let lastAssistantText = '';
  let answered = false;

  // Subprozess-Konsum unter dem Cross-Session-Mutex + Reentrancy-Flag (siehe
  // Kommentar am Dateianfang). Das Flag steht für die GESAMTE Laufzeit dieses
  // Agent-Laufs, damit verschachtelte Vision-Tool-Aufrufe (get_document_pdf_vision
  // → callClaudeSubscription) in lib/llm.js callModel() seitwärts auf die
  // reguläre Anthropic-API ausweichen, statt auf den bereits von diesem Lauf
  // gehaltenen Mutex zu warten (Deadlock).
  try {
    await withSubprocessSlot(async () => {
      insideAgentSubprocess = true;
      try {
        for await (const msg of q) {
          if (msg.type === 'stream_event') {
            const evt = msg.event;
            if (evt.type === 'content_block_delta') {
              if (evt.delta?.type === 'text_delta' && evt.delta.text) {
                onToken(evt.delta.text);
                answered = true;
              } else if (evt.delta?.type === 'thinking_delta' && evt.delta.thinking) {
                onThinking?.(evt.delta.thinking);
              }
            }
          } else if (msg.type === 'assistant' && msg.parent_tool_use_id == null) {
            const blocks = msg.message?.content || [];
            const hasToolUse = blocks.some((b) => b.type === 'tool_use');
            if (hasToolUse) {
              const toolLabel = blocks
                .filter((b) => b.type === 'tool_use')
                .map((b) => b.name.replace(/^mcp__postbuch__/, ''))
                .join(', ');
              if (toolLabel) onProgress?.(`Nutze Werkzeug: ${toolLabel}`);
            }
            // Text wurde bereits live per stream_event oben gestreamt — hier nur
            // als Notlösung für den Rundenlimit-Fall zwischenspeichern (unten),
            // falls aus irgendeinem Grund keine Deltas angekommen sind.
            const turnText = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
            if (turnText) lastAssistantText = turnText;
          } else if (msg.type === 'result') {
            resultMsg = msg;
          }
        }
      } finally {
        insideAgentSubprocess = false;
      }
    });
  } catch (err) {
    if (timedOut) throw timeoutError();
    if (abortSignal?.aborted) throw err; // Client-Abbruch — Route behandelt das still
    throw new Error(withStderr(err.message || 'Claude-Subscription-Agent: Subprozess-Fehler'));
  } finally {
    clearTimeout(timeoutHandle);
  }

  if (!resultMsg) {
    if (timedOut) throw timeoutError();
    throw new Error(withStderr('Claude-Subscription-Agent: kein result-Event erhalten'));
  }

  if (resultMsg.subtype === 'success' && !resultMsg.is_error) {
    if (!answered && typeof resultMsg.result === 'string') {
      onToken(resultMsg.result);
      answered = true;
    }
  } else if (resultMsg.subtype === 'error_max_turns' && !answered && lastAssistantText) {
    // Rundenlimit erreicht, aber der letzte Assistant-Turn hatte noch Text (z.B.
    // ein Zwischenstand vor dem nächsten Tool-Aufruf) — als Notlösung ausgeben
    // statt hart zu scheitern (entspricht dem Force-Report-Verhalten des
    // manuellen Research-Loops in chat-agent.js).
    onToken(`${lastAssistantText}\n\n_(Rundenlimit erreicht — Antwort möglicherweise unvollständig.)_`);
    answered = true;
  } else {
    const detail = Array.isArray(resultMsg.errors) ? resultMsg.errors.join('; ') : (resultMsg.subtype || 'unknown');
    throw new Error(withStderr(`Claude-Subscription-Agent-Fehler: ${detail}`));
  }

  if (!answered) {
    throw new Error(withStderr('Claude-Subscription-Agent: keine verwertbare Antwort erhalten'));
  }

  const u = resultMsg.usage || {};
  return {
    usage: {
      inputTokens:         u.input_tokens                ?? null,
      outputTokens:        u.output_tokens               ?? null,
      cacheCreationTokens: u.cache_creation_input_tokens ?? null,
      cacheReadTokens:     u.cache_read_input_tokens     ?? null,
    },
    numTurns: resultMsg.num_turns,
  };
}

/**
 * Leichtgewichtiger Lebendigkeits-Test des Subscription-Tokens.
 * @returns {Promise<{ ok: boolean, model?: string, error?: string }>}
 */
export async function testClaudeSubscription(oauthToken, model = 'haiku') {
  try {
    const res = await callClaudeSubscription(
      model,
      'Antworte exakt mit dem Wort: pong',
      {},
      (_pdf, prompt) => [{ type: 'text', text: prompt }],
      oauthToken,
    );
    return { ok: true, model, sample: (res.text || '').slice(0, 40) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
