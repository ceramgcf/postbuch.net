/**
 * lib/llm/thinking-policy.js — Thinking/Effort-Steuerung für den Büroassistenten
 *
 * Deklarativ, kein Probing (wie CAP_KEYS in registry.js): Adaptive Thinking +
 * `effort` sind laut Anthropic-Doku (Stand 2026-08) nur auf einer kleinen,
 * versionierten Modellliste verfügbar (claude-sonnet-5, claude-opus-5,
 * claude-fable-5, claude-mythos-5 + deren Nachfolger). Auf diesen Modellen
 * läuft Thinking serverseitig PER DEFAULT (nur unsichtbar, display:"omitted")
 * — die Policy hier entscheidet nur noch: sichtbar machen + Tiefe drosseln
 * (In-App) oder explizit ausschalten (MCP). Auf allen anderen Modellen
 * (Haiku, OpenAI-kompatibel, ältere Claude-Generationen) bleibt Thinking
 * unangetastet — dort gibt es serverseitig ohnehin nichts anzuschalten, ein
 * Wire-Feld dorthin zu schicken würde nur unnötig Fehlerfläche schaffen.
 *
 * Policy-Regel (Nutzer-Entscheidung): interaktive Pfade (In-App-Chat, MCP)
 * bleiben bei 'low'/'medium' bzw. aus — einmalige, nutzerausgelöste
 * Batch-Läufe (z. B. die Kostenträger-Profilierung, `zweck: 'profilierung'`)
 * dürfen höher gehen. Die Begründung für die Deckelung ist die interaktive
 * Antwortzeit; die trägt bei einem einmaligen Hintergrundlauf über wenige
 * PDFs nicht, siehe internaldocs/FEATURE_KOSTENTRAEGER_PROFILE.md Abschnitt 6.
 * Der Sonderfall wird als benannter `zweck`-Parameter durchgereicht, nie als
 * freier `effort`-Wert, den jede Aufrufstelle beliebig hochdrehen könnte.
 */

import pool from '../../db.js';

// Anthropic-Modellfamilien mit Adaptive-Thinking/effort-Unterstützung.
// Deckt Basisname + optionales Datums-/Versions-Suffix ab (z.B. "-20251001").
const ADAPTIVE_THINKING_RE = /^claude-(sonnet-5|opus-5|fable-5|mythos-5|mythos-preview)(-\d+)?$/;

export function supportsAdaptiveThinking(model) {
  return ADAPTIVE_THINKING_RE.test(String(model || ''));
}

// Effort-Default für den In-App-Pfad. Bewusst 'low': der bisherige Default
// (kein effort-Feld gesetzt = 'high') war die Hauptursache der 50-270s-
// Antwortzeiten. 'medium' bleibt als manuelle Eskalationsstufe verfügbar,
// aber nie 'high'/'xhigh'/'max' — das ist eine bewusste Produktentscheidung.
export const IN_APP_EFFORT = 'low';

// Fester Effort-Wert für benannte, einmalige Batch-Läufe (aktuell nur die
// Kostenträger-Profilierung). Anthropic empfiehlt mindestens 'high', wenn aus
// wenigen Beispielen eine Struktur abstrahiert werden soll. Keine freie
// Einstellung — nur über zweck:'profilierung' erreichbar.
export const PROFILIERUNG_EFFORT = 'high';

/**
 * @param {object} params
 * @param {string}  params.model
 * @param {boolean} [params.viaMcp] - true = Anfrage kam über den MCP-Connector
 * @param {'interaktiv'|'profilierung'} [params.zweck]
 * @returns {{ mode: 'none'|'explicit-off'|'adaptive', effort: ?string }}
 *   mode 'none':         Modell kennt Thinking nicht (oder nicht adaptiv) — Wire-Felder weglassen.
 *   mode 'explicit-off': Modell denkt per Default — explizit thinking:{type:'disabled'} senden.
 *   mode 'adaptive':     thinking:{type:'adaptive'} + effort setzen, sichtbar (display:'summarized').
 */
export function resolveThinkingPolicy({ model, viaMcp = false, zweck = 'interaktiv' }) {
  if (!supportsAdaptiveThinking(model)) return { mode: 'none', effort: null };
  if (viaMcp) return { mode: 'explicit-off', effort: null };
  return { mode: 'adaptive', effort: zweck === 'profilierung' ? PROFILIERUNG_EFFORT : IN_APP_EFFORT };
}

// ── Reasoning-Effort-Capability-Learning (OpenAI-kompatibel) ─────────────────
//
// Anthropic hat oben eine deklarative Policy (Modell-Namensmuster →
// adaptiv/aus), weil Claude-Modellnamen stabil und bekannt sind. Bei
// OpenAI-kompatiblen Endpunkten (OpenAI, Ollama, LM Studio, vLLM, OpenRouter
// etc.) gibt es keine verlässliche Modellliste — reasoning_effort wird deshalb
// reaktiv gelernt: erster Versuch mit dem Policy-Zielwert, Fehlschlag wird
// sofort ohne/mit korrigiertem Wert wiederholt (der laufende Aufruf wird noch
// fertig), das Ergebnis landet dauerhaft in postbuch.llm_reasoning_capability
// — ein Neustart zahlt die Lernrunde nie wieder, anders als eine reine
// In-Memory-Variante.
//
// Gelernt wird nur der FÄHIGKEITS-ZUSTAND, nie ein fixer Wert: 'full' heißt
// "Modell akzeptiert freie reasoning_effort-Werte", die Policy (s.u.)
// bestimmt dann weiterhin den tatsächlich gesendeten Wert je Aufruf. Nur ein
// echter Hard-Constraint (none_only — Function-Tools + Reasoning-Modell
// verlangt zwingend 'none') schlägt die Policy, exakt wie ein Anthropic-Modell
// ohne Adaptive-Thinking-Support die Policy auf 'none' zwingt.
const reasoningCapabilityCache = new Map(); // 'providerId model context' -> 'full'|'none_only'|'unsupported'|null

function reasoningCapabilityKey(prov, model, context) {
  return `${prov?.id ?? ''} ${model} ${context}`;
}

export async function loadReasoningCapability(prov, model, context) {
  const key = reasoningCapabilityKey(prov, model, context);
  if (reasoningCapabilityCache.has(key)) return reasoningCapabilityCache.get(key);
  const r = await pool.query(
    `SELECT state FROM postbuch.llm_reasoning_capability WHERE provider_id = $1 AND model = $2 AND context = $3`,
    [prov?.id ?? '', model, context],
  ).catch(() => ({ rows: [] }));
  const state = r.rows[0]?.state ?? null;
  reasoningCapabilityCache.set(key, state);
  return state;
}

export async function learnReasoningCapability(prov, model, context, state) {
  reasoningCapabilityCache.set(reasoningCapabilityKey(prov, model, context), state);
  await pool.query(
    `INSERT INTO postbuch.llm_reasoning_capability (provider_id, model, context, state)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (provider_id, model, context) DO UPDATE SET state = $4, learned_at = now()`,
    [prov?.id ?? '', model, context, state],
  ).catch((err) => console.warn('[thinking-policy] reasoning_effort-Capability konnte nicht gespeichert werden:', err.message));
}

// Policy-Zielwert: In-App niedrig, MCP aus (das anfragende externe Modell denkt
// bereits selbst), Profilierung hoch — Pendant zu IN_APP_EFFORT/'explicit-off'/
// PROFILIERUNG_EFFORT oben.
export function policyReasoningEffort(viaMcp, zweck = 'interaktiv') {
  if (viaMcp) return 'none';
  return zweck === 'profilierung' ? PROFILIERUNG_EFFORT : 'low';
}

/**
 * Löst auf, welchen reasoning_effort-Wert dieser Aufruf versuchen soll.
 * `probe: true` heißt: Zustand für (Provider, Modell, Kontext) ist noch nicht
 * gelernt — der Aufrufer muss Erfolg/Fehlschlag auswerten und
 * learnReasoningCapability aufrufen, damit künftige Aufrufe direkt den
 * richtigen Wert/Zustand kennen.
 */
export async function resolveReasoningEffort(prov, model, context, viaMcp, zweck = 'interaktiv') {
  const state = await loadReasoningCapability(prov, model, context);
  if (state === 'unsupported') return { effort: undefined, probe: false };
  if (state === 'none_only')   return { effort: 'none', probe: false };
  if (state === 'full')        return { effort: policyReasoningEffort(viaMcp, zweck), probe: false };
  return { effort: policyReasoningEffort(viaMcp, zweck), probe: true };
}
