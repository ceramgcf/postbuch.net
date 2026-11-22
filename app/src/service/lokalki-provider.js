/**
 * Abgleich der eingebauten lokalen KI (Provider `lokal`, lib/llm/registry.js)
 * mit dem Heartbeat des Host-Agenten.
 *
 * Aktiv ist der Provider, sobald der Dienst eingeschaltet und das Modell
 * vollständig geladen ist; sein Kontextfenster ist das, mit dem der Agent den
 * Dienst startet. Beides landet in `_settings.lokalki_provider`. So muss
 * niemand nach dem Einschalten im Stack-Reiter einen Provider anlegen, und
 * ein Stufenwechsel (andere Grafikkarte, neues Modell) zieht das
 * Kontextbudget von selbst nach.
 */

import pool from '../db.js';
import { loadDynamicSettings } from '../config.js';
import { leseAgentStatus } from '../lib/update-agent-datei.js';
import { normalizeKontextTokens } from '../lib/llm/registry.js';
import { invalidateAiHealthCache } from '../lib/ai-health.js';
import { ladeManifest } from '../lib/llm/lokal-modelle.js';

const SETTING = 'lokalki_provider';
const INTERVALL_MS = 60 * 1000;

/** Sollzustand aus dem (bereits validierten) Agentenstatus; null = nichts bekannt. */
export function lokalProviderSoll(agent) {
  if (!agent?.vorhanden || !agent.stack) return null;
  const lk = agent.stack.lokalki;
  if (!lk) return { aktiv: false, kontextTokens: null, modellAnzeige: null };
  return {
    aktiv: lk.profilAktiv === true && lk.vollstaendig === true,
    kontextTokens: normalizeKontextTokens(lk.bedarf?.kontext) ?? null,
    modellAnzeige: anzeigeFuer(lk.modell),
  };
}

/**
 * Anzeigename des laufenden Modells. Bekannt ist nur der des Katalogs dieses
 * Release; läuft (kurz nach einem Update) noch das alte, gibt es keinen.
 */
function anzeigeFuer(schluessel) {
  if (!schluessel) return null;
  try {
    const m = ladeManifest().modell;
    return m.schluessel === schluessel ? m.anzeige : null;
  } catch {
    return null;
  }
}

/**
 * Schreibt den Sollzustand, wenn er vom gespeicherten abweicht. Ohne Agent
 * oder Heartbeat bleibt alles, wie es ist. Ein fehlender Kontextwert lässt den
 * zuletzt bekannten stehen.
 *
 * @returns {Promise<boolean>} true, wenn sich etwas geändert hat
 */
export async function lokalenProviderAbgleichen(agent = null) {
  const soll = lokalProviderSoll(agent ?? await leseAgentStatus());
  if (!soll) return false;
  const settings = await loadDynamicSettings();
  const ist = settings[SETTING] && typeof settings[SETTING] === 'object' ? settings[SETTING] : {};
  const neu = {
    aktiv: soll.aktiv,
    kontextTokens: soll.kontextTokens ?? ist.kontextTokens ?? null,
    modellAnzeige: soll.modellAnzeige,
  };
  if (ist.aktiv === neu.aktiv && (ist.kontextTokens ?? null) === neu.kontextTokens
    && (ist.modellAnzeige ?? null) === neu.modellAnzeige) return false;
  await pool.query(
    `INSERT INTO postbuch._settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = NOW()`,
    [SETTING, JSON.stringify(neu)],
  );
  invalidateAiHealthCache('lokal');
  console.log(`[lokalki] Provider „Lokale KI“: aktiv=${neu.aktiv}, Kontext=${neu.kontextTokens ?? 'Standard'}, Modell=${neu.modellAnzeige ?? 'unbekannt'}`);
  return true;
}

/**
 * Antwortet der Dienst nachweislich, ist die lokale KI an – ohne auf den
 * Heartbeat des Agenten (einmal pro Minute) zu warten. Der nächste Abgleich
 * stellt den Wert bei Bedarf wieder auf die Meldung des Agenten.
 */
export async function lokalenProviderBeiAntwortAktivieren() {
  const settings = await loadDynamicSettings();
  const ist = settings[SETTING] && typeof settings[SETTING] === 'object' ? settings[SETTING] : {};
  if (ist.aktiv === true) return false;
  await pool.query(
    `INSERT INTO postbuch._settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = NOW()`,
    [SETTING, JSON.stringify({ ...ist, aktiv: true })],
  );
  invalidateAiHealthCache('lokal');
  return true;
}

export function startLokalKiProviderJob() {
  const lauf = () => lokalenProviderAbgleichen()
    .catch((err) => console.warn('[lokalki] Provider-Abgleich fehlgeschlagen:', err.message));
  lauf();
  setInterval(lauf, INTERVALL_MS).unref();
}
