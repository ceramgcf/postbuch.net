/**
 * service/host-agent.js — geteilte Host-Auftrags-Logik fürs Scanner-Profil
 *
 * `routes/updates.js` (POST /hostconfig) bleibt der Weg für den manuellen
 * Schalter in den Settings. Diese Datei bündelt denselben "module"-Auftrag
 * (`scanner:an`/`scanner:aus`) für serverseitige Auto-Trigger (siehe
 * routes/settings.js, PUT /:key bei scanner_device_url), damit die
 * Vorbedingungen (Agent vorhanden, kein Auftrag in Arbeit) nicht doppelt
 * gepflegt werden. Best-effort: kein Agent oder ein laufender Auftrag ist
 * hier kein Fehler, der einen Settings-Save zum Scheitern bringen dürfte —
 * nur ein `ok: false` im Rückgabewert.
 */

import {
  leseAgentStatus, leseAnforderung, leseLaufStatus, laufAktiv, schreibeHostAnforderung,
} from '../lib/update-agent-datei.js';

export async function scannerProfilAutoSchalten(an, angefordertVon) {
  const agent = await leseAgentStatus();
  if (!agent.vorhanden || !agent.capabilities?.includes('module')) {
    return { ok: false, grund: 'kein-agent' };
  }
  if (agent.scannerProfilAktiv === an) {
    return { ok: true, grund: 'bereits-erreicht' };
  }
  if (await leseAnforderung() || laufAktiv(await leseLaufStatus())) {
    return { ok: false, grund: 'auftrag-laeuft' };
  }
  const nonce = await schreibeHostAnforderung({
    typ: 'module',
    wert: an ? 'scanner:an' : 'scanner:aus',
    angefordertVon,
  });
  return { ok: true, nonce };
}
