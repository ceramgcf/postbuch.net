/**
 * service/embedding-neuberechnung.js — Dokument- und Akten-Embeddings auf die
 * aktive Signatur bringen
 *
 * Ein Wechsel des Embedding-Modells entwertet den Bestand: Zeilen mit
 * abweichender Signatur gelten für Suche und Duplikatprüfung als „kein
 * Embedding" (lib/embedding.js). PUT /settings/ai/embedding startet den Lauf
 * deshalb selbst, nachdem der Nutzer Wechsel und Neuberechnung gemeinsam
 * bestätigt hat; POST /actions/rebuild-embeddings bleibt der Weg für einzelne
 * Nachzügler.
 *
 * Es läuft höchstens ein Lauf. Kommt währenddessen ein weiterer Wechsel, wird
 * nach dem Ende ein Nachlauf gestartet: Der laufende hat Zeilen womöglich noch
 * mit der vorigen Signatur geschrieben.
 *
 * Die Hilfe gehört nur auf ausdrücklichen Wunsch dazu (`mitHilfe`). Beim
 * Modellwechsel gleicht sie der eigene Hilfe-Job ab, der mitgelieferte Vektoren
 * übernimmt (service/help-corpus.js).
 */

import { query } from '../db.js';
import { appLog } from '../app-log.js';
import { regenerateEmbedding, activeSignature, embeddingConfig, embeddingSlot, signatureOf } from '../lib/embedding.js';
import { EINGEBAUTES_EMBEDDING, eingebautesModell } from '../lib/embedding-eingebaut.js';
import { schwellenUebernehmen } from '../lib/embedding-schwellen.js';
import { loadDynamicSettings } from '../config.js';
import { computeAndSaveAkteEmbedding } from './akten-service.js';
import { loadHelpSource, getHelpEmbeddingStatus, reconcileHelpCorpus } from './help-corpus.js';
import * as tracker from '../jobs/tracker.js';

let laufenderJob = null;
let nachlauf = null; // { mitHilfe } für den Lauf nach dem laufenden

/** Läuft gerade eine Neuberechnung? Für die Statusanzeige. */
export function neuberechnungStatus() {
  return { laeuft: !!laufenderJob, jobId: laufenderJob };
}

/**
 * Startet die Neuberechnung im Hintergrund und kehrt sofort zurück.
 *
 * @param {object} [opt]
 * @param {boolean} [opt.alle=false]     Auch Zeilen mit passender Signatur.
 * @param {boolean} [opt.mitHilfe=false] Die Hilfe im selben Lauf abgleichen.
 * @param {string}  [opt.grund]          Für das Protokoll.
 * @returns {Promise<{started:number, jobId?:string, signatur:string, laeuftBereits?:boolean}>}
 */
export async function starteNeuberechnung({ alle = false, mitHilfe = false, grund = 'manuell' } = {}) {
  // Jeder Modellwechsel (Einstellungen, Empfehlung, Zurücksetzen, Release)
  // läuft hier durch: Die Schwellen gehören zum Modell und wechseln mit.
  if (grund === 'modellwechsel' || grund === 'modellempfehlung') {
    try {
      const model = embeddingConfig(await loadDynamicSettings()).model;
      if (model) {
        const s = await schwellenUebernehmen(model);
        appLog('INFO', 'embedding', `${s.generisch ? 'Generische Startwerte' : 'Schwellen'} für ${model} übernommen: `
          + `Unsinn ${s.unsinnMax}, 100 % ab ${s.voll}, Duplikate ${s.duplikat}`);
      }
    } catch (err) {
      appLog('ERROR', 'embedding', `Schwellen nicht übernommen: ${err.message}`);
    }
  }
  const signatur = await activeSignature();
  if (laufenderJob) {
    nachlauf = { mitHilfe: mitHilfe || !!nachlauf?.mitHilfe };
    return { started: 0, jobId: laufenderJob, signatur, laeuftBereits: true };
  }

  const filter = alle ? '' : 'WHERE embedding_signature IS DISTINCT FROM $1';
  const params = alle ? [] : [signatur];
  const { rows: docs } = await query(`SELECT postid FROM postbuch.postbuch ${filter} ORDER BY postid`, params);
  const { rows: akten } = await query(`SELECT akteid FROM postbuch.akte ${filter} ORDER BY akteid`, params);
  let hilfeGesamt = 0;
  if (mitHilfe) {
    const status = await getHelpEmbeddingStatus();
    hilfeGesamt = status.aktuell ? 0 : (await loadHelpSource()).chunks.length;
  }

  const gesamt = docs.length + akten.length + hilfeGesamt;
  if (gesamt === 0) return { started: 0, signatur };

  const jobId = tracker.create('embedding-rebuild', `Embeddings neu berechnen (${gesamt})`, gesamt);
  laufenderJob = jobId;
  appLog('INFO', 'embedding', `Embedding-Neuberechnung gestartet: ${gesamt} (${signatur}, ${grund})`);

  (async () => {
    let ok = 0, fehler = 0, i = 0;
    const abgebrochen = () => tracker.isCancelled(jobId);
    for (const { postid } of docs) {
      if (abgebrochen()) break;
      tracker.setStep(jobId, ++i, `Dokument ${postid}`);
      try { await regenerateEmbedding(postid); ok++; }
      catch (err) {
        fehler++;
        await query(
          `UPDATE postbuch.postbuch SET embedding_failed_at = NOW(), embedding_error = $1 WHERE postid = $2`,
          [err.message.slice(0, 500), postid],
        ).catch(() => {});
        appLog('WARN', 'embedding', `Neuberechnung fehlgeschlagen für ${postid}: ${err.message}`,
          { entity: 'postbuch', entityId: postid });
      }
    }
    for (const { akteid } of akten) {
      if (abgebrochen()) break;
      tracker.setStep(jobId, ++i, `Akte ${akteid}`);
      // wirft nie an den Aufrufer (fire-and-forget-Semantik des Services)
      await computeAndSaveAkteEmbedding(akteid);
      ok++;
    }
    if (hilfeGesamt > 0 && !abgebrochen()) {
      const hilfe = await reconcileHelpCorpus({
        reason: 'embedding-rebuild',
        onItem: (_index, _gesamt, chunk) => tracker.setStep(jobId, ++i, `Hilfe: ${chunk.kapitelTitel}`),
      });
      ok += (hilfe.embedded || 0) + (hilfe.mitgeliefert || 0);
    }
    if (abgebrochen()) {
      tracker.completeAsCancelled(jobId, { ok, fehler, signatur });
      appLog('INFO', 'embedding', `Embedding-Neuberechnung abgebrochen: ${ok} ok, ${fehler} Fehler (${signatur})`);
      return;
    }
    tracker.complete(jobId, { ok, fehler, signatur });
    appLog('INFO', 'embedding', `Embedding-Neuberechnung abgeschlossen: ${ok} ok, ${fehler} Fehler (${signatur})`);
  })().catch((err) => {
    tracker.fail(jobId, err.message);
    appLog('ERROR', 'embedding', `Embedding-Neuberechnung abgebrochen: ${err.message}`);
  }).finally(() => {
    laufenderJob = null;
    const naechster = nachlauf;
    nachlauf = null;
    if (naechster) {
      starteNeuberechnung({ mitHilfe: naechster.mitHilfe, grund: 'nachlauf' }).catch((err) => {
        appLog('ERROR', 'embedding', `Embedding-Nachlauf nicht gestartet: ${err.message}`);
      });
    }
  });

  return { started: gesamt, jobId, signatur };
}

/**
 * Ein Release kann das eingebaute Embedding-Modell wechseln (neues Image unter
 * embedding/, neue Werte in lib/embedding-eingebaut.js). Die gespeicherte Wahl
 * in `llm_embedding` stünde dann noch auf dem alten Modell, das der Dienst
 * nicht mehr anbietet. Ist der eingebaute Dienst gewählt und weicht die Wahl
 * von der mitgelieferten ab, wird sie nachgezogen und die Neuberechnung
 * gestartet – derselbe Ablauf wie bei einem Modellwechsel in den
 * Einstellungen. Eine andere Wahl (Cloud-Anbieter) bleibt unberührt.
 *
 * Läuft beim App-Start vor dem Hilfe-Job, damit dieser schon die neue
 * Signatur sieht.
 * @returns {Promise<string|null>}  neue Signatur oder null (nichts zu tun)
 */
export async function eingebautesEmbeddingAbgleichen() {
  const settings = await loadDynamicSettings();
  const aktuell = embeddingConfig(settings);
  if (aktuell.providerId !== EINGEBAUTES_EMBEDDING.providerId) return null;
  // Ein anderes Modell, das der Dienst anbietet (Voyage, Gemma), bleibt
  // gewählt, solange Dimension und Vorsilben zu ihm passen.
  const gewaehlt = eingebautesModell(aktuell.model);
  if (gewaehlt && signatureOf(aktuell) === signatureOf(embeddingSlot(gewaehlt))) return null;
  const soll = embeddingSlot(EINGEBAUTES_EMBEDDING);
  if (signatureOf(aktuell) === signatureOf(soll)) return null;
  await query(
    `INSERT INTO postbuch._settings (key, value, updated_at)
     VALUES ('llm_embedding', $1::jsonb, NOW()), ('llm_embedding_signature', $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [JSON.stringify(soll), JSON.stringify(signatureOf(soll))],
  );
  appLog('INFO', 'embedding',
    `Eingebautes Embedding-Modell mit dem Release gewechselt: ${signatureOf(aktuell)} → ${signatureOf(soll)}`);
  await starteNeuberechnung({ grund: 'modellwechsel' });
  return signatureOf(soll);
}

/**
 * Bestandsinstanzen kennen die modellabhängigen Schwellen noch nicht. Fehlt
 * die 100-%-Marke, werden die Schwellen einmal übernommen (kuratiert oder
 * generisch). Läuft beim App-Start nach dem Abgleich oben.
 */
export async function embeddingSchwellenErgaenzen() {
  const settings = await loadDynamicSettings();
  if (settings.embedding_aehnlichkeit_voll != null) return null;
  const model = embeddingConfig(settings).model;
  if (!model) return null;
  // Eine selbst eingestellte Duplikatschwelle bleibt bei unbekanntem Modell stehen.
  const s = await schwellenUebernehmen(model, undefined, { duplikatGenerisch: false });
  appLog('INFO', 'embedding', `${s.generisch ? 'Generische Startwerte' : 'Schwellen'} für ${model} ergänzt: `
    + `Unsinn ${s.unsinnMax}, 100 % ab ${s.voll}${s.generisch ? '' : `, Duplikate ${s.duplikat}`}`);
  return s;
}
