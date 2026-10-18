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

// Modelle, auf denen sich Thinking nicht abschalten lässt: thinking:{type:'disabled'}
// beantwortet die API dort mit 400 (Fable 5/5.1, Mythos, Opus ab 5.5). Einzige
// Stellschraube ist `effort`. Bei Opus 5 gilt das noch nicht ('claude-opus-5' und
// datierte Suffixe wie '-20260401' bleiben abschaltbar).
const THINKING_PFLICHT_RE = /^claude-(fable-5|mythos-5|mythos-preview)(-\d+)?$|^claude-opus-5-([5-9]|\d{2})$/;

export function thinkingAbschaltbar(model) {
  return !THINKING_PFLICHT_RE.test(String(model || ''));
}

/** Effort, mit dem ein nicht abschaltbares Thinking so knapp wie möglich läuft. */
export const MINIMAL_EFFORT = 'low';

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
 * @returns {{ mode: 'none'|'explicit-off'|'minimal'|'adaptive', effort: ?string }}
 *   mode 'none':         Modell kennt Thinking nicht (oder nicht adaptiv) — Wire-Felder weglassen.
 *   mode 'explicit-off': Modell denkt per Default — explizit thinking:{type:'disabled'} senden.
 *   mode 'minimal':      Ausschalten gewünscht, aber vom Modell nicht erlaubt — adaptiv mit
 *                        MINIMAL_EFFORT, unsichtbar (kein display-Feld).
 *   mode 'adaptive':     thinking:{type:'adaptive'} + effort setzen, sichtbar (display:'summarized').
 */
export function resolveThinkingPolicy({ model, viaMcp = false, zweck = 'interaktiv' }) {
  if (!supportsAdaptiveThinking(model)) return { mode: 'none', effort: null };
  if (viaMcp) return thinkingAus(model);
  return { mode: 'adaptive', effort: zweck === 'profilierung' ? PROFILIERUNG_EFFORT : IN_APP_EFFORT };
}

/**
 * Policy für „Thinking aus": explizit abschalten, wo das Modell es erlaubt,
 * sonst auf minimalen Effort drosseln (mode 'minimal').
 */
export function thinkingAus(model) {
  return thinkingAbschaltbar(model)
    ? { mode: 'explicit-off', effort: null }
    : { mode: 'minimal', effort: MINIMAL_EFFORT };
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

// ── Extraktion: wenig Nachdenken ─────────────────────────────────────────────
//
// Alles, was über callModel() in lib/llm.js läuft (Voranalyse, Dokumentanalyse,
// Parsing, Titel), ist Extraktion: Das Ergebnis steht im Dokument. Reasoning-
// Modelle denken serverseitig per Default und bezahlen das aus demselben
// max_tokens-Budget wie die Antwort; ist es aufgebraucht, kommt die Antwort
// abgeschnitten oder leer zurück. Ganz ohne Nachdenken halten manche Modelle das
// Schema aber nicht ein oder lesen schlechter. Deshalb gilt für die Extraktion
// niedriger Effort ('low') als Standard und „aus“ nur für Modelle, bei denen
// eine Messung das als besser belegt (EXTRAKTION_OHNE_NACHDENKEN). Ausnahme
// bleibt der benannte Batch-Zweck 'profilierung'; der Chat läuft über
// service/chat-agent.js und ist davon nicht betroffen.
//
// Welche Felder ein Modell annimmt, unterscheidet sich je Modell und ändert sich
// mit jeder Generation. Statt einer Feldliste je Modell probiert die Extraktion
// eine feste Stufenleiter und merkt sich je (Provider, Modell, Modus), was
// angenommen wurde. Eine abgelehnte Stufe kostet einen HTTP-400 ohne Token-
// Verbrauch; gemerkt wird nur im Prozess, nach einem Neustart wird einmal neu
// ausgehandelt. Getrennt von llm_reasoning_capability, weil der Chat dort für
// denselben Kontext andere Zielwerte lernt.

/** Zwecke, die bewusst nachdenken dürfen. Alles andere ist Extraktion. */
export function istExtraktion(zweck) {
  return zweck !== 'profilierung';
}

/**
 * Modelle, die bei der Extraktion ohne Nachdenken nachweislich besser sind.
 * Nur mit Messung eintragen (Quelle und Datum im Kommentar), nie auf Verdacht:
 * Ein schlechter gelesener Wert ist so gültig wie ein guter, die App kann das
 * nicht selbst lernen.
 */
const EXTRAKTION_OHNE_NACHDENKEN = [
  // Rezept-Extraktion 24 Scans, 2026-10 (internaldocs/testablaeufe/TESTPLAN-2.12.0.md, B13):
  // aus 67 % / Ø 23 s, Standard 64 % mit Abbrüchen, weil das Nachdenken das
  // max_tokens-Budget aufbraucht.
  /^mistral-large-4(-|$)/,
];

export function ohneNachdenkenBesser(model) {
  return EXTRAKTION_OHNE_NACHDENKEN.some((re) => re.test(String(model || '')));
}

/**
 * Liefert ein Modell aus der Liste ohne Nachdenken keine schemagültige Antwort,
 * wiederholt analyzeDocument mit diesem Zweck ('low') und merkt sich das Modell.
 */
export const ZWECK_EXTRAKTION_NACHDENKEN = 'extraktion-nachdenken';
const nachdenkenNoetigGemerkt = new Set(); // 'providerId model'

function schluessel(providerId, model) {
  return `${providerId ?? ''} ${model}`;
}

export function nachdenkenNoetig(providerId, model) {
  return nachdenkenNoetigGemerkt.has(schluessel(providerId, model));
}

export function merkeNachdenkenNoetig(providerId, model) {
  nachdenkenNoetigGemerkt.add(schluessel(providerId, model));
}

/** Modus eines Extraktionsaufrufs: 'aus' oder 'low'. */
export function extraktionsModus(providerId, model, zweck) {
  if (zweck === ZWECK_EXTRAKTION_NACHDENKEN) return 'low';
  return ohneNachdenkenBesser(model) && !nachdenkenNoetig(providerId, model) ? 'aus' : 'low';
}

/**
 * Anthropic-Stufenleiter (Messages API, gemessen 2026-10 an Haiku/Sonnet/Opus 5.5):
 *   disabled       – ältere Modelle und Haiku 5.5
 *   between_tools  – Modelle, die `disabled` mit Verweis darauf ablehnen (Sonnet 5.5);
 *                    ohne Werkzeuge denkt das Modell dann gar nicht
 *   minimal        – adaptiv mit niedrigem Effort; Start im Modus 'low' und für
 *                    nicht abschaltbare Modelle (Opus 5.5, Fable)
 *   ohne           – Modell kennt keine Thinking-Felder
 */
const ANTHROPIC_STUFEN = ['disabled', 'between_tools', 'minimal', 'ohne'];
const anthropicStufeGemerkt = new Map(); // 'modus providerId model' -> Stufenindex

/** Body-Felder einer Stufe. */
export function anthropicExtraktionsFelder(stufe) {
  switch (ANTHROPIC_STUFEN[stufe]) {
    case 'disabled':      return { thinking: { type: 'disabled' } };
    case 'between_tools': return { thinking: { type: 'between_tools' } };
    case 'minimal':       return { thinking: { type: 'adaptive' }, output_config: { effort: MINIMAL_EFFORT } };
    default:              return {};
  }
}

/** Beginnt die Aushandlung: Stufe, mit der der erste Versuch läuft. */
export function anthropicExtraktionsStufe(providerId, model, modus = 'low') {
  const gemerkt = anthropicStufeGemerkt.get(`${modus} ${schluessel(providerId, model)}`);
  if (gemerkt != null) return gemerkt;
  return modus === 'aus' && thinkingAbschaltbar(model) ? 0 : ANTHROPIC_STUFEN.indexOf('minimal');
}

/**
 * Nach einem HTTP-400: Lag es an den Thinking-Feldern, liefert die Funktion die
 * nächste Stufe (und merkt sie), sonst null. Nennt die Fehlermeldung
 * `between_tools` ausdrücklich, springt sie direkt dorthin.
 */
export function anthropicNaechsteStufe(providerId, model, modus, stufe, status, text) {
  const t = String(text || '');
  if (status !== 400 || !/thinking|effort/i.test(t)) return null;
  if (stufe >= ANTHROPIC_STUFEN.length - 1) return null;
  const bt = ANTHROPIC_STUFEN.indexOf('between_tools');
  const naechste = /between_tools/i.test(t) && stufe < bt && !/between_tools.{0,40}not supported/i.test(t)
    ? bt
    : stufe + 1;
  anthropicStufeGemerkt.set(`${modus} ${schluessel(providerId, model)}`, naechste);
  return naechste;
}

/** Erfolgreiche Stufe festhalten (spart beim nächsten Aufruf die Aushandlung). */
export function anthropicStufeBestaetigt(providerId, model, modus, stufe) {
  anthropicStufeGemerkt.set(`${modus} ${schluessel(providerId, model)}`, stufe);
}

// OpenAI-kompatibel: Modus 'low' sendet `reasoning_effort: "low"`, Modus 'aus'
// `"none"`. Lehnt das Modell den Wert ab, nennen OpenAI und Mistral in der
// 400-Antwort die erlaubten Werte. 'aus' nimmt den niedrigsten davon bis
// höchstens 'low', 'low' den höchsten darunter (z. B. Mistral: nur none/high
// → none). Passt nichts oder fehlt eine verwertbare Liste, wird der Parameter
// weggelassen (Modellstandard).
const EFFORT_REIHENFOLGE = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];
const openaiEffortGemerkt = new Map(); // 'modus providerId model' -> Wert | null (= weglassen)

/** Wert für den nächsten Extraktionsaufruf; undefined = Parameter weglassen. */
export function openaiExtraktionsEffort(providerId, model, modus = 'low') {
  const k = `${modus} ${schluessel(providerId, model)}`;
  if (!openaiEffortGemerkt.has(k)) return modus === 'aus' ? 'none' : MINIMAL_EFFORT;
  return openaiEffortGemerkt.get(k) ?? undefined;
}

/**
 * Nach einem HTTP-400 wegen reasoning_effort: lernt den passenden erlaubten
 * Wert aus der Fehlermeldung (oder „weglassen“) und liefert ihn zurück.
 */
export function openaiEffortAbgelehnt(providerId, model, modus, abgelehnt, text) {
  const t = String(text || '');
  const genannt = new Set();
  for (const m of t.matchAll(/['"`]([a-z]+)['"`]/gi)) genannt.add(m[1].toLowerCase());
  const ab = EFFORT_REIHENFOLGE.indexOf(abgelehnt);
  const obergrenze = EFFORT_REIHENFOLGE.indexOf(MINIMAL_EFFORT);
  const kandidaten = EFFORT_REIHENFOLGE.filter((w, i) => i !== ab && i <= obergrenze && genannt.has(w));
  const wert = (modus === 'aus'
    ? kandidaten.find((w) => EFFORT_REIHENFOLGE.indexOf(w) > ab)
    : kandidaten.filter((w) => EFFORT_REIHENFOLGE.indexOf(w) < ab).pop()) ?? null;
  openaiEffortGemerkt.set(`${modus} ${schluessel(providerId, model)}`, wert);
  return wert ?? undefined;
}

/** Nur für Tests: gelernte Extraktionszustände verwerfen. */
export function _resetExtraktionsZustand() {
  anthropicStufeGemerkt.clear();
  openaiEffortGemerkt.clear();
  nachdenkenNoetigGemerkt.clear();
}
