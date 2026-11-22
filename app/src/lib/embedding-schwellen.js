/**
 * lib/embedding-schwellen.js – modellabhängige Schwellen des Embedding-Modells
 *
 * Kosinuswerte hängen am Modell: Was bei Arctic ein guter Treffer ist (0,4),
 * liefert EmbeddingGemma schon für ein beliebiges unpassendes Dokument. Die
 * gemessenen Schwellen stehen deshalb je Modell in der kuratierten Liste
 * (llm-empfehlungen.json, Klasse embedding, Feld `schwellen`) und werden bei
 * jedem Modellwechsel in die Einstellungen übernommen:
 *
 * - embedding_unsinnsschwelle    untere Grenze der inhaltlichen Suche, 0 % der Anzeige
 * - embedding_aehnlichkeit_voll  100 % der Anzeige
 * - duplicate_embedding_threshold Vorfilter der Duplikaterkennung
 *
 * Kennt die Liste das Modell nicht, gelten generische Startwerte
 * (GENERISCHE_SCHWELLEN). Sie halten die Reihenfolge der Suche bei allen
 * gemessenen Modellen auf dem Stand kuratierter Werte; die Prozentanzeige ist
 * bei Modellen mit hohem Grundrauschen dann zu großzügig, bis jemand die Werte
 * anpasst (Einstellungen, Embeddings). Messung: internaldocs/ENTSCHEIDUNGEN.md.
 */
import { readFile } from 'node:fs/promises';
import { query } from '../db.js';
import { validiereEmpfehlungen } from './llm/empfehlungen-feed.js';

/** Startwerte für Modelle ohne Eintrag in der kuratierten Liste. */
export const GENERISCHE_SCHWELLEN = Object.freeze({ unsinnMax: 0.3, voll: 0.9, duplikat: 0.85 });

let liste = null;

async function embeddingEmpfehlungen() {
  if (!liste) {
    const roh = JSON.parse(await readFile(new URL('./llm/llm-empfehlungen.json', import.meta.url), 'utf8'));
    liste = validiereEmpfehlungen(roh).klassen.embedding || [];
  }
  return liste;
}

/** Schwellen der kuratierten Liste für ein Modell (Name ohne Groß/klein) oder null. */
export async function schwellenFuer(model) {
  const name = String(model || '').toLowerCase();
  const k = (await embeddingEmpfehlungen()).find((e) => e.model.toLowerCase() === name && e.schwellen);
  return k ? k.schwellen : null;
}

/**
 * Übernimmt die Schwellen des Modells in die Einstellungen – kuratiert oder,
 * wenn die Liste das Modell nicht kennt, die generischen Startwerte.
 * @param {string} model
 * @param {Function} [q] – Abfragefunktion (Transaktion oder Pool)
 * @param {object} [opt]
 * @param {boolean} [opt.duplikatGenerisch=true] – false: eine vorhandene
 *   Duplikatschwelle bleibt bei unbekanntem Modell stehen (Nachtrag beim Start)
 * @returns {Promise<object>} die übernommenen Schwellen, mit generisch: true|false
 */
export async function schwellenUebernehmen(model, q = query, { duplikatGenerisch = true } = {}) {
  const kuratiert = await schwellenFuer(model);
  const s = { ...GENERISCHE_SCHWELLEN, ...(kuratiert || {}), generisch: !kuratiert };
  const setze = (key, wert) => q(
    `INSERT INTO postbuch._settings (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, JSON.stringify(wert)],
  );
  await setze('embedding_unsinnsschwelle', s.unsinnMax);
  await setze('embedding_aehnlichkeit_voll', s.voll);
  if (kuratiert || duplikatGenerisch) await setze('duplicate_embedding_threshold', s.duplikat);
  return s;
}
