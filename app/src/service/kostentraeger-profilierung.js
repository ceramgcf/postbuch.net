/**
 * service/kostentraeger-profilierung.js — "Profil extrahieren" (Schritt IV)
 *
 * Leitet aus einer vom Admin zusammengestellten Akte automatisch ein neues
 * Kostenträger-Profil ab (internaldocs/FEATURE_KOSTENTRAEGER_PROFILE.md,
 * Abschnitt 6). Anders als der reguläre EB-Parser bekommt der Profilierer
 * NIE gespeicherte Parse-Ergebnisse, sondern ausschließlich die Original-PDFs
 * — sonst schreibt er Fehler des bisherigen Parsers fort.
 *
 * Die Akte-Auswahl ist auf Akten beschränkt, die AUSSCHLIESSLICH aus
 * Gesundheit×Erstattungsbescheid-Dokumenten bestehen (gemischte Akten werden
 * nie angeboten und serverseitig erneut geprüft, bevor der teure LLM-Call
 * ausgeführt wird).
 */

import pool from '../db.js';
import { loadDynamicSettings } from '../config.js';
import { callLLM, resolveKlassenModell, buildCostMap, calculateCost, parseJsonFromText } from '../lib/llm.js';
import { retrieveDocument } from './document-retriever.js';
import { buildProfilierungsPrompt } from '../prompts/erstattungsbescheid.js';
import { appLog } from '../app-log.js';
import { versucheAktivierung } from './kostentraeger-profil.js';

const MAX_DOKUMENTE_PRO_PROFILIERUNG = 5;

export class ProfilierungsFehler extends Error {
  constructor(message) {
    super(message);
    this.status = 422;
  }
}

/**
 * Akten, die ausschließlich aus Gesundheit×Erstattungsbescheid-Dokumenten
 * bestehen (nicht-historisch) — die einzigen, aus denen sich ein sauberes
 * Kostenträger-Profil ableiten lässt.
 */
export async function listProfilierbareAkten() {
  const { rows } = await pool.query(
    `SELECT a.akteid, a.betreff, count(ad.postid)::int AS dok_anzahl
     FROM postbuch.akte a
     JOIN postbuch.akte_dokument ad ON ad.akteid = a.akteid
     JOIN postbuch.postbuch p ON p.postid = ad.postid
     WHERE a.historisch = false
     GROUP BY a.akteid, a.betreff, a.updated_at
     HAVING count(ad.postid) = count(ad.postid) FILTER (
              WHERE p.lebensbereich = 'gesundheit' AND p.dokumentart = 'erstattungsbescheid'
            )
     ORDER BY a.updated_at DESC`
  );
  return rows;
}

async function ladePostidsFuerAkte(akteid) {
  const { rows } = await pool.query(
    `SELECT ad.postid, p.lebensbereich, p.dokumentart, p.briefdatum
     FROM postbuch.akte_dokument ad
     JOIN postbuch.postbuch p ON p.postid = ad.postid
     JOIN postbuch.akte a ON a.akteid = ad.akteid
     WHERE ad.akteid = $1 AND a.historisch = false
     ORDER BY p.briefdatum DESC NULLS LAST, ad.postid`,
    [akteid],
  );
  return rows;
}

/**
 * Profiliert eine Akte: lädt bis zu 5 PDFs, ruft den Profilierungs-Prompt auf
 * Modellklasse 'schwierig' mit voller Denkzeit (zweck: 'profilierung') auf,
 * speichert bei Erfolg ein neues Profil (quelle 'generiert') und aktiviert es
 * automatisch, sofern ein Slot frei ist.
 *
 * @param {string} akteid
 * @param {{ username?: string }} [ctx]
 * @returns {Promise<{ profil: object, aktiviert: boolean, hinweis?: string }>}
 */
export async function profiliereAkte(akteid, { username } = {}) {
  const zeilen = await ladePostidsFuerAkte(akteid);
  if (!zeilen.length) throw new Error('Akte nicht gefunden oder leer.');

  const gemischt = zeilen.some((z) => z.lebensbereich !== 'gesundheit' || z.dokumentart !== 'erstattungsbescheid');
  if (gemischt) {
    throw new ProfilierungsFehler(
      'Diese Akte enthält auch andere Dokumente als Erstattungsbescheide. Für die Profilierung ' +
      'ist ausschließlich eine reine Erstattungsbescheid-Akte desselben Kostenträgers geeignet.',
    );
  }

  const auswahl = zeilen.slice(0, MAX_DOKUMENTE_PRO_PROFILIERUNG);
  const pdfs = [];
  for (const z of auswahl) {
    const { pdf } = await retrieveDocument(z.postid);
    pdfs.push(pdf);
  }

  const settings = await loadDynamicSettings();
  const personsResult = await pool.query(
    `SELECT kurzname, anzeigename AS vollname, ist_tier, pkv, beihilfe, pkv_satz, beihilfe_satz
     FROM postbuch.mensch
     WHERE (pkv = true OR beihilfe = true) AND ist_tier = false
     ORDER BY kurzname`
  );

  const prompt = buildProfilierungsPrompt(personsResult.rows);
  const costMap = buildCostMap(settings);
  const model = resolveKlassenModell('schwierig', settings).model;

  const llmResult = await callLLM(model, prompt, { pdfs, zweck: 'profilierung' }, settings, {
    kategorie: 'kostentraeger-profilierung', entity: 'akte', entityId: akteid, username,
  });
  const tokensIn  = llmResult.usage?.inputTokens  ?? null;
  const tokensOut = llmResult.usage?.outputTokens ?? null;
  const costUsd   = calculateCost(model, tokensIn, tokensOut, costMap);

  appLog('INFO', 'kostentraeger-profilierung', `Profilierungslauf für ${akteid} abgeschlossen`, {
    entity: 'akte', entityId: akteid, meta: { model, tokensIn, tokensOut, costUsd, username },
  });

  const daten = parseJsonFromText(llmResult.text);

  if (daten.fehler) {
    throw new ProfilierungsFehler(daten.fehler);
  }

  if (!['PKV', 'Beihilfe'].includes(daten.kostentraeger)) {
    throw new Error(`Profilierer lieferte ungültigen Kostenträger: ${JSON.stringify(daten.kostentraeger)}`);
  }
  if (typeof daten.name !== 'string' || !daten.name.trim()) {
    throw new Error('Profilierer lieferte keinen Namen.');
  }
  if (typeof daten.profiltext !== 'string' || !daten.profiltext.trim()) {
    throw new Error('Profilierer lieferte keinen Profiltext.');
  }

  const insertResult = await pool.query(
    `INSERT INTO postbuch.kostentraeger_profil (name, kostentraeger, profiltext, quelle, erzeugt_von_modell)
     VALUES ($1, $2, $3, 'generiert', $4)
     RETURNING id, name, kostentraeger, profiltext, aktiv, quelle, erzeugt_von_modell, erzeugt_am, aktualisiert_am`,
    [daten.name.trim(), daten.kostentraeger, daten.profiltext.trim(), model],
  );
  return versucheAktivierung(insertResult.rows[0]);
}
