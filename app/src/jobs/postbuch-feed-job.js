/**
 * jobs/postbuch-feed-job.js — täglicher Abruf der instanzkonfigurierten Feeds
 *
 * EIN Job für beide Feeds (Update-Manifest und Modellempfehlungen). Zwei
 * getrennte Cron-Jobs hätten dieselbe Jitter-, Fehler- und Abschaltlogik
 * doppelt — und wären zweimal zu pflegen.
 *
 * **Instanz-Jitter statt fester Uhrzeit.** Stünde hier `0 4 * * *`, schlügen
 * alle Instanzen zur selben Minute auf demselben (kleinen) Server auf. Minute
 * und Stunde werden deshalb einmalig pro Prozessstart zufällig gezogen; der
 * Nachtbereich 2–5 Uhr ist die einzige Vorgabe.
 *
 * **Jeder Feed, dessen Schalter aus ist, wird übersprungen** — Rückbau in einem
 * Schritt: `update_check_enabled` + beide Abo-Schalter aus ⇒ null ausgehender
 * Verkehr Richtung postbuch.net. Für die cloudfreie Zielgruppe zwingend.
 */

import { appLog } from '../app-log.js';
import { hatFeedQuelle } from '../lib/postbuch-feed.js';
import { checkAktiv, pruefeUpdate } from '../service/update-check.js';
import {
  ONLINE_EMPFEHLUNGEN_AKTIV, aboAktiv, autoAktiv, holeEmpfehlungen, anwenden,
} from '../lib/llm/empfehlungen.js';
import { devFeatureUnlocked } from '../lib/dev-gate.js';

let _cronJob = null;
let _laeuft = false;

function jitterCron() {
  const minute = Math.floor(Math.random() * 60);
  const stunde = 2 + Math.floor(Math.random() * 4);   // 2..5 Uhr
  return `${minute} ${stunde} * * *`;
}

/** Holt ausschließlich den Empfehlungs-Feed; auch beim Start nach dem Installer. */
export async function aktualisiereEmpfehlungen() {
  if (!ONLINE_EMPFEHLUNGEN_AKTIV) return;
  if (!hatFeedQuelle()) return;
  try {
    if (await aboAktiv()) {
      await holeEmpfehlungen();
      if (devFeatureUnlocked() && await autoAktiv()) {
        // 'nicht_verifizierbar' wird hier immer übersprungen (auto: true).
        await anwenden('alle', { auto: true, von: 'feed-job' });
      }
    }
  } catch (err) {
    console.warn('[postbuch-feed] Empfehlungs-Feed fehlgeschlagen:', err.message);
  }
}

/** Ein Tick: beide Feeds, jeder unabhängig vom Ergebnis des anderen. */
export async function tick() {
  if (_laeuft) return;
  // Eine Instanz ohne Bezugsquelle ist bewusst vollständig cloudfrei. Das ist
  // kein Fehlerzustand und darf weder einen Request noch tägliches Log-Rauschen
  // erzeugen.
  if (!hatFeedQuelle()) return;
  _laeuft = true;
  try {
    // ── Feed A: Update-Manifest ───────────────────────────────────────────
    try {
      if (await checkAktiv()) await pruefeUpdate();
    } catch (err) {
      // Ein nicht erreichbarer Feed ist Alltag (Instanz offline, DNS weg) und
      // darf nicht als ERROR im Log stehen — sonst ist das Log Rauschen.
      console.warn('[postbuch-feed] Update-Check fehlgeschlagen:', err.message);
    }

    // ── Feed B: Modellempfehlungen (Rueckweg derzeit deaktiviert) ─────────
    if (ONLINE_EMPFEHLUNGEN_AKTIV) await aktualisiereEmpfehlungen();
  } finally {
    _laeuft = false;
  }
}

export async function startPostbuchFeedJob() {
  if (_cronJob) return;
  if (!hatFeedQuelle()) {
    console.log('[postbuch-feed] Keine Bezugsquelle konfiguriert — Feed-Job deaktiviert.');
    return;
  }
  let cron;
  try {
    cron = await import('node-cron');
  } catch {
    console.warn('[postbuch-feed] node-cron nicht installiert — Feed-Job deaktiviert');
    appLog('WARN', 'postbuch-feed', 'node-cron nicht installiert — Feed-Job deaktiviert');
    return;
  }
  const ausdruck = jitterCron();
  _cronJob = cron.schedule(ausdruck, () => { tick().catch(() => {}); }, { timezone: 'Europe/Berlin' });
  console.log(`[postbuch-feed] Täglicher Feed-Abruf geplant: ${ausdruck} (Europe/Berlin)`);
  // Eine im Installer aktivierte Empfehlung muss nicht bis zum ersten
  // Nachtlauf warten. Der gezielte Abruf prüft dabei kein Update-Manifest.
  if (ONLINE_EMPFEHLUNGEN_AKTIV) aktualisiereEmpfehlungen();
}

export function stopPostbuchFeedJob() {
  _cronJob?.stop();
  _cronJob = null;
}
