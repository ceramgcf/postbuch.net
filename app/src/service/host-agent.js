/**
 * service/host-agent.js — geteilte Host-Auftrags-Logik für die Compose-Profile
 *
 * `routes/updates.js` (POST /hostconfig) bleibt der Weg für den manuellen
 * Schalter in den Settings. Diese Datei bündelt denselben "module"-Auftrag
 * (`scanner:an|aus`, `embedding:an|aus`) für serverseitige Auto-Trigger (siehe
 * routes/settings.js: PUT /:key bei scanner_device_url, PUT /ai/embedding
 * beim Wechsel weg vom eingebauten Dienst), damit die
 * Vorbedingungen (Agent vorhanden, kein Auftrag in Arbeit) nicht doppelt
 * gepflegt werden. Best-effort: kein Agent oder ein laufender Auftrag ist
 * hier kein Fehler, der einen Settings-Save zum Scheitern bringen dürfte —
 * nur ein `ok: false` im Rückgabewert.
 */

import {
  leseAgentStatus, leseAnforderung, leseLaufStatus, laufAktiv, schreibeHostAnforderung,
} from '../lib/update-agent-datei.js';

/** Compose-Profil → Capability, die der Agent dafür melden muss. */
const PROFIL_CAPABILITY = { scanner: 'module', embedding: 'embedding' };
const PROFIL_ZUSTAND = { scanner: 'scannerProfilAktiv', embedding: 'embeddingProfilAktiv' };

async function profilAutoSchalten(profil, an, angefordertVon) {
  const agent = await leseAgentStatus();
  if (!agent.vorhanden || !agent.capabilities?.includes(PROFIL_CAPABILITY[profil])) {
    return { ok: false, grund: 'kein-agent' };
  }
  if (agent[PROFIL_ZUSTAND[profil]] === an) {
    return { ok: true, grund: 'bereits-erreicht' };
  }
  if (await leseAnforderung() || laufAktiv(await leseLaufStatus())) {
    return { ok: false, grund: 'auftrag-laeuft' };
  }
  const nonce = await schreibeHostAnforderung({
    typ: 'module',
    wert: `${profil}:${an ? 'an' : 'aus'}`,
    angefordertVon,
  });
  return { ok: true, nonce };
}

export function scannerProfilAutoSchalten(an, angefordertVon) {
  return profilAutoSchalten('scanner', an, angefordertVon);
}

export function embeddingProfilAutoSchalten(an, angefordertVon) {
  return profilAutoSchalten('embedding', an, angefordertVon);
}
