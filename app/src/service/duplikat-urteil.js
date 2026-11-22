/**
 * service/duplikat-urteil.js – KI-Urteil der Duplikatprüfung in Zweifelsfällen
 *
 * Wird nur gerufen, wenn die Option „KI-Duplikatprüfung in Zweifelsfällen“
 * (`duplicate_ki_pruefung`) an ist und duplicate-checker.js einen Zweifelsfall
 * meldet. Ein Aufruf vergleicht das neue Dokument mit bis zu drei Kandidaten:
 * Von jedem Dokument gehen die ersten zwei Seiten in eine gemeinsame PDF, der
 * Prompt nennt die Seitenbereiche.
 *
 * Modell: Klasse „Voranalyse“ (gestaffelt) bzw. „Einfach & Routine“ (einfache
 * Modellwahl; resolveKlassenModell lenkt um). Kann das Modell das Dokument nicht
 * sehen (weder PDF noch Bilder), wird nicht aufgerufen: Ohne Blick auf die
 * Seiten taugt das Urteil nicht, und Original-PDFs bekommen keine Textebene.
 *
 * Jeder Fehler wird geworfen; duplicate-checker.js wertet ihn als „kein Duplikat“.
 */

import * as llm from '../lib/llm.js';
import { selectPages, mergePdfs, countPdfPages } from '../lib/pdf.js';
import { getAdapter } from '../lib/storage/index.js';
import { appLog } from '../app-log.js';
import { duplikatUrteilPrompt } from '../prompts/duplikat-urteil.js';

const SEITEN_JE_DOKUMENT = 2;
const KENNUNGEN = 'ABC';

/** Ein Dokument auf die ersten Seiten kürzen. */
async function ersteSeiten(buf) {
  const n = Math.min(SEITEN_JE_DOKUMENT, await countPdfPages(buf));
  if (n < 1) throw new Error('PDF ohne Seiten');
  return { buf: await selectPages(buf, 1, n), seiten: n };
}

/**
 * Lädt die PDF eines Kandidaten aus seiner Ablage. Fehlt sie, wird ohne ihn geurteilt.
 * @returns {Promise<Buffer|null>}
 */
async function ladeKandidat(row) {
  if (!row.storage_id) return null;
  try {
    return await getAdapter(row.storage_backend || 'onedrive').download(row.storage_id);
  } catch (err) {
    console.warn(`[duplikat-urteil] Kandidat ${row.postid} nicht ladbar: ${err.message}`);
    return null;
  }
}

/**
 * Baut die KI-Prüfung für duplicate-checker.check().
 *
 * @param {object} p
 * @param {Buffer} p.neuPdf     - PDF des neuen Dokuments (unverändert)
 * @param {object} p.settings
 * @param {string} [p.jobId]
 * @param {Function} [p.lade]   - Testnaht: async (row) → Buffer|null
 * @param {object} [p.llmApi]   - Testnaht: { resolveKlassenModell, capsForRef, kannDokumentSehen, leseDokument, parseJsonFromText }
 * @returns {(kandidaten: object[]) => Promise<Array<{ postid, urteil, sicherheit, grund }>>}
 */
export function erstelleKiPruefung({ neuPdf, settings, jobId = null, lade = ladeKandidat, llmApi = llm }) {
  return async (kandidaten) => {
    const ref = llmApi.resolveKlassenModell('preanalysis', settings);
    if (!ref?.model) throw new Error('kein Modell für die Duplikatprüfung konfiguriert');
    if (!llmApi.kannDokumentSehen(llmApi.capsForRef(settings, ref))) {
      throw new Error(`Modell ${ref.model} kann weder PDFs noch Bilder lesen`);
    }
    if (!neuPdf) throw new Error('PDF des neuen Dokuments fehlt');

    const teile = [];
    const bereiche = [];
    const zuordnung = {};
    let seite = 1;
    const dazu = (name, stueck) => {
      teile.push(stueck.buf);
      bereiche.push({ name, von: seite, bis: seite + stueck.seiten - 1 });
      seite += stueck.seiten;
    };

    dazu('Neues Dokument', await ersteSeiten(neuPdf));
    for (const row of kandidaten.slice(0, KENNUNGEN.length)) {
      const buf = await lade(row);
      if (!buf) continue;
      let stueck;
      try {
        stueck = await ersteSeiten(buf);
      } catch (err) {
        console.warn(`[duplikat-urteil] Kandidat ${row.postid} unlesbar: ${err.message}`);
        continue;
      }
      const kennung = KENNUNGEN[bereiche.length - 1];
      zuordnung[kennung] = row.postid;
      dazu(`Kandidat ${kennung}`, stueck);
    }
    if (bereiche.length < 2) throw new Error('kein Kandidat aus der Ablage ladbar');

    const pdf = await mergePdfs(teile);
    const r = await llmApi.leseDokument(
      [ref], pdf, duplikatUrteilPrompt(bereiche),
      // Textebene nicht entfernen: Bei digital erzeugten PDFs ist sie der ganze
      // Inhalt, ohne sie sähe die KI leere Seiten und hielte alles für gleich.
      // Die zusammengesetzte PDF ist eine Kopie nur für diesen Aufruf.
      { stripTextLayerGewuenscht: false, zweck: 'duplikat-urteil' },
      settings,
      { entity: 'postbuch', correlationId: jobId, kategorie: 'duplikat' },
    );
    const json = llmApi.parseJsonFromText(r.text);
    const urteile = (Array.isArray(json?.kandidaten) ? json.kandidaten : [])
      .map((u) => ({
        postid: zuordnung[String(u?.kennung || '').trim().toUpperCase()] || null,
        urteil: u?.urteil === 'duplikat' ? 'duplikat' : 'kein_duplikat',
        sicherheit: Number(u?.sicherheit),
        grund: String(u?.grund || '').slice(0, 300),
      }))
      .filter((u) => u.postid);

    const kurz = urteile.map((u) => `${u.postid}: ${u.urteil} (${u.sicherheit})`).join(', ') || 'keine verwertbare Antwort';
    appLog('INFO', 'duplikat-urteil', `KI-Duplikatprüfung mit ${Object.keys(zuordnung).length} Kandidaten: ${kurz}`,
      { entity: 'postbuch', details: jobId ? `Job ${jobId}` : undefined });
    return urteile;
  };
}
