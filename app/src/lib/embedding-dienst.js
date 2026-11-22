/**
 * lib/embedding-dienst.js – Zustand der Modelle im eingebauten Embedding-Dienst
 *
 * Der Dienst (embedding/server.py) meldet unter /v1/modelle, welche Modelle
 * bereit sind, welche er noch herunterladen muss und wie viel Arbeitsspeicher
 * das Gerät hat; /v1/modelle/holen stößt einen Download an. Die Adresse ist
 * fest (Provider `eingebaut`, lib/llm/registry.js), nicht einstellbar.
 */
import os from 'node:os';
import { guardedFetchJson } from './net-guard.js';
import { EINGEBAUTE_MODELLE, eingebautesModell } from './embedding-eingebaut.js';

const BASIS = 'http://embedding:8080/v1';
const OPTS = { allowPrivate: true, timeoutMs: 5000 };

/** Arbeitsspeicher des Geräts in MB (Container sehen den des Hosts). */
export function geraeteRamMb() {
  return Math.floor(os.totalmem() / 1048576);
}

/** Reicht der Arbeitsspeicher für dieses Modell des eingebauten Dienstes? */
export function ramReicht(model, ramMb = geraeteRamMb()) {
  const m = eingebautesModell(model);
  return !!m && ramMb >= m.ramMinMb;
}

/**
 * Zustand aller Modelle. Läuft der Dienst nicht oder ist er zu alt für
 * /v1/modelle, kommt `laeuft: false` und als Zustand nur die RAM-Prüfung.
 * @returns {Promise<{laeuft:boolean, ramMb:number, modelle:Array}>}
 */
export async function modellZustaende() {
  let dienst = null;
  try {
    dienst = await guardedFetchJson(`${BASIS}/modelle`, {}, OPTS);
  } catch (err) {
    console.warn('[embedding-dienst] Modellzustand nicht abrufbar:', err.message);
  }
  const ramMb = Number(dienst?.ramMb) || geraeteRamMb();
  const modelle = EINGEBAUTE_MODELLE.map((m) => {
    const d = (dienst?.modelle || []).find((x) => x?.id === m.model) || {};
    const zustand = ramMb < m.ramMinMb ? 'zu_wenig_ram'
      : typeof d.zustand === 'string' ? d.zustand : 'unbekannt';
    return {
      model: m.model, label: m.label, dim: m.dim, ramMinMb: m.ramMinMb, zustand,
      prozent: Number.isFinite(d.prozent) ? d.prozent : null,
      groesseMb: Number.isFinite(d.groesseMb) ? d.groesseMb : null,
      // Nur der feste Fehlertext des Dienstes (Download, Prüfsumme), gekürzt.
      fehler: typeof d.fehler === 'string' ? d.fehler.slice(0, 200) : null,
    };
  });
  return { laeuft: !!dienst, ramMb, modelle };
}

/** Stößt den Download eines Modells an und gibt seinen Zustand zurück. */
export async function modellHolen(model) {
  return guardedFetchJson(`${BASIS}/modelle/holen`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model }),
  }, OPTS);
}
