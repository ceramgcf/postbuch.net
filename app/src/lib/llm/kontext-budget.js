/**
 * Kontextbudget je KI-Aufruf.
 *
 * Jeder Provider hat ein Kontextfenster (`kontextTokens`, hart gedeckelt auf
 * KONTEXT_TOKENS_GRENZE – auch bei Cloud-Modellen, deren Fenster größer ist:
 * mehr Eingabe macht die Antworten dort nicht besser). Davon gehen die
 * Antwort und eine Reserve ab; der Rest steht für Prompt, Systemtext und
 * Dokument bereit. Gerechnet wird ohne Tokenizer mit vorsichtigen
 * Schätzwerten, damit ein Aufruf nie am Fenster des Servers scheitert.
 */

import { kontextTokensVon } from './registry.js';

/** Vorsichtig: deutscher Text liegt eher bei 3,5–4 Zeichen je Token. */
export const ZEICHEN_PRO_TOKEN = 3;
/** Schätzwert je gerasterter Seite (Bild-Block) beim Bildpfad. */
export const TOKENS_PRO_RASTERSEITE = 1200;
/** Puffer für Chat-Vorlagen, Werkzeugbeschreibungen und Schätzfehler. */
export const RESERVE_TOKENS = 1024;
/** Antwortreserve, wenn beim Provider kein Antwortlimit hinterlegt ist. */
export const AUSGABE_RESERVE_STANDARD = 8192;
/** Ab diesem Anteil am Eingabebudget verdichtet der Chat ältere Runden. */
export const CHAT_VERDICHTUNG_AB = 0.7;

/** Tokens, die für die Antwort freigehalten werden (höchstens ein Viertel des Fensters). */
export function ausgabeReserve(provider) {
  const kontext = kontextTokensVon(provider);
  const grenze = provider?.maxOutputTokens;
  const wunsch = Number.isFinite(grenze) && grenze > 0 ? grenze : AUSGABE_RESERVE_STANDARD;
  return Math.min(wunsch, Math.floor(kontext / 4));
}

/** Tokens für die gesamte Eingabe (Systemtext, Prompt, Dokument, Verlauf). */
export function eingabeBudgetTokens(provider) {
  return Math.max(0, kontextTokensVon(provider) - ausgabeReserve(provider) - RESERVE_TOKENS);
}

/** Geschätzte Tokens eines Textes. */
export function schaetzeTokens(text) {
  return Math.ceil(String(text ?? '').length / ZEICHEN_PRO_TOKEN);
}

/**
 * Kürzt einen Dokumenttext auf `maxZeichen`. Behalten werden Anfang (zwei
 * Drittel) und Ende (ein Drittel), denn dort stehen bei Schreiben meist
 * Absender, Betreff, Summen und Fristen; die Lücke wird markiert.
 */
export function kuerzeAufBudget(text, maxZeichen) {
  const t = String(text ?? '');
  if (t.length <= maxZeichen) return { text: t, ausgelassen: 0 };
  const platz = Math.max(0, maxZeichen - 60);
  const kopf = Math.floor(platz * 2 / 3);
  const fuss = platz - kopf;
  const ausgelassen = t.length - kopf - fuss;
  return {
    text: `${t.slice(0, kopf)}\n[… ${ausgelassen} Zeichen ausgelassen …]\n${fuss > 0 ? t.slice(-fuss) : ''}`,
    ausgelassen,
  };
}

/**
 * Dokumenttext so kürzen, dass er neben Prompt und Systemtext ins
 * Eingabebudget passt.
 */
export function dokumentTextImBudget(text, provider, { prompt = '', system = '', belegtTokens = 0 } = {}) {
  // belegtTokens: was neben Prompt und Systemtext schon im Aufruf steckt,
  // etwa gerasterte Seiten, wenn der Text nur die übrigen Seiten ergänzt.
  const fest = String(prompt ?? '').length + String(system ?? '').length + 64
    + belegtTokens * ZEICHEN_PRO_TOKEN;
  const maxZeichen = Math.max(0, eingabeBudgetTokens(provider) * ZEICHEN_PRO_TOKEN - fest);
  return kuerzeAufBudget(text, maxZeichen);
}

/**
 * Wie viele Seiten der Bildpfad rastern darf: nie mehr als `obergrenze`
 * (Provider-Einstellung bzw. Rasterizer-Default), aber auch nicht mehr, als
 * neben Prompt und Systemtext (pauschal 4000 Tokens) ins Budget passen.
 */
export function rasterSeitenImBudget(provider, obergrenze) {
  const frei = eingabeBudgetTokens(provider) - 4000;
  const passend = Math.floor(frei / TOKENS_PRO_RASTERSEITE);
  return Math.max(1, Math.min(obergrenze, passend));
}

/**
 * Erkennt die Ablehnung einer zu langen Eingabe. Ein erneuter Versuch mit
 * derselben Eingabe scheitert genauso – der Fehler ist dauerhaft.
 */
const UEBERLAUF_MUSTER = [
  /context[_ ]length[_ ]exceeded/i,                 // OpenAI
  /maximum context length/i,                         // OpenAI, vLLM
  /exceeds? the (available )?context (size|window|length)/i, // llama.cpp
  /prompt is too long/i,                             // Anthropic
  /input is too long/i,                              // Bedrock
  /(exceed\w*|larger than|longer than).{0,40}context window/i,
];

export function istKontextUeberlauf(err) {
  const msg = typeof err === 'string' ? err : err?.message;
  return !!msg && UEBERLAUF_MUSTER.some((re) => re.test(msg));
}

/** Auf so viele Zeichen schrumpft ein verdichteter Eintrag im Chatverlauf. */
export const VERDICHTET_ZEICHEN = 1200;

/**
 * Verdichtet den Verlauf einer Recherche-Schleife, sobald er
 * CHAT_VERDICHTUNG_AB des Eingabebudgets überschreitet: ältere
 * Werkzeugergebnisse und lange frühere Nachrichten werden auf Anfang und Ende
 * gekürzt, bis der Verlauf wieder deutlich darunter liegt. Die jüngste Runde
 * (ab der letzten Antwort des Modells) und die aktuelle Frage bleiben
 * unangetastet, ebenso Denk- und Werkzeugaufruf-Blöcke des Modells.
 *
 * Versteht beide Formate: Anthropic (`tool_result`-Blöcke in einer
 * user-Nachricht) und OpenAI (`role: 'tool'`). Ändert `messages` an Ort und
 * Stelle und liefert die Zahl der gekürzten Einträge (0 = nichts zu tun).
 */
export function verdichteVerlauf(messages, provider, { festZeichen = 0 } = {}) {
  const budgetZeichen = eingabeBudgetTokens(provider) * ZEICHEN_PRO_TOKEN;
  const groesse = () => JSON.stringify(messages).length + festZeichen;
  if (groesse() <= budgetZeichen * CHAT_VERDICHTUNG_AB) return 0;
  const ziel = budgetZeichen * (CHAT_VERDICHTUNG_AB - 0.2);

  let geschuetztAb = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'assistant') { geschuetztAb = i; break; }
  }
  // Die Frage selbst: letzte user-Nachricht mit reinem Text vor der jüngsten Runde.
  let frage = -1;
  for (let i = geschuetztAb - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user' && typeof messages[i].content === 'string') { frage = i; break; }
  }

  // Kandidaten: erst Werkzeugergebnisse, dann sonstiger Text – jeweils älteste zuerst.
  const werkzeug = [];
  const text = [];
  for (let i = 0; i < geschuetztAb; i++) {
    const m = messages[i];
    if (!m || m.role === 'system' || i === frage) continue;
    if (m.role === 'tool' && typeof m.content === 'string') {
      werkzeug.push({ get: () => m.content, set: (v) => { m.content = v; } });
    } else if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b?.type === 'tool_result' && typeof b.content === 'string') {
          werkzeug.push({ get: () => b.content, set: (v) => { b.content = v; } });
        }
      }
    } else if (typeof m.content === 'string') {
      text.push({ get: () => m.content, set: (v) => { m.content = v; } });
    }
  }

  let gekuerzt = 0;
  for (const k of [...werkzeug, ...text]) {
    if (groesse() <= ziel) break;
    const { text: kurz, ausgelassen } = kuerzeAufBudget(k.get(), VERDICHTET_ZEICHEN);
    if (ausgelassen > 0) { k.set(kurz); gekuerzt++; }
  }
  return gekuerzt;
}
