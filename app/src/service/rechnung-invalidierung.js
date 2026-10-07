/**
 * service/rechnung-invalidierung.js — „Diese Rechnung ist keine Rechnung mehr."
 *
 * Wird eine Rechnung durch eine Korrekturrechnung ersetzt, ist sie fachlich
 * keine Forderung mehr. Archivieren allein genügt nicht: der Rechnungsblock
 * bliebe bestehen, und das Dokument stünde weiter im Fälligkeitskalender und —
 * nach dem Zurückholen aus dem Archiv — wieder unter „Unbezahlt".
 *
 * Die Invalidierung räumt deshalb den Block ab. Bei Arzt- und
 * Handwerkerrechnungen geht das nur über die Pipeline (ihre Detailtabellen
 * hängen per CASCADE am Dokument und werden bei der Ersetzung neu aufgebaut),
 * also über eine LxD-Umschaltung auf Korrespondenz mit Wiederverarbeitung.
 *
 * Was die KI danach liefert, wird hier nicht abgewartet, sondern erzwungen:
 * Der Nutzerhinweis im Prompt sagt dasselbe, aber ob das Modell folgt, darf
 * über das Ergebnis nicht entscheiden.
 */

import pool from '../db.js';
import { ermittleReprocessSchutz } from './reprocess-protection.js';

/** Ziel-Dokumentart jeder Invalidierung. Bewusst fest — ein invalidiertes
 *  Rechnungsschreiben ist Korrespondenz, sonst nichts. */
export const INVALIDIERUNG_ZIEL_D = 'korrespondenz';

/** Vermerk am Betreff. Exakt diese Schreibweise erwartet auch der Prompt. */
export const INVALIDIERUNG_BETREFF_PRAEFIX = '[Invalidierte Rechnung]';

export const INVALIDIERUNG_GESPERRT_CODE = 'INVALIDIERUNG_GESPERRT';

/**
 * Prüft, ob ein Dokument invalidiert werden kann.
 *
 * Die harten Sperren decken sich absichtlich mit den Abbrüchen mitten in der
 * Pipeline (document-processor: erhaltener Zahlungs-/Streitstatus, Arzt-
 * Workflow). Hier scheitert es sofort und ohne KI-Kosten statt spät.
 *
 * @returns {Promise<{gefunden:boolean, hatBlock:boolean, spielart:string|null,
 *                    lebensbereich:string|null, dokumentart:string|null,
 *                    storageId:string|null, storageBackend:string|null,
 *                    gruende:string[]}>}
 */
export async function ermittleInvalidierungsLage(postid, db = pool) {
  const { rows } = await db.query(
    `SELECT p.lebensbereich, p.dokumentart, p.storage_id, p.storage_backend,
            (a.postid IS NOT NULL) AS hat_arzt,
            (h.postid IS NOT NULL) AS hat_handwerker,
            (g.postid IS NOT NULL) AS hat_generisch,
            COALESCE(a.bezahlt_am_manuell, h.bezahlt_am_manuell, g.bezahlt_am_manuell, false) AS bezahlt_manuell,
            COALESCE(a.bestritten_betrag, h.bestritten_betrag, g.bestritten_betrag) AS bestritten_betrag,
            EXISTS (SELECT 1 FROM postbuch.dokument_beziehung db
                     WHERE db.art = 'ersetzt' AND (db.von_postid = p.postid OR db.zu_postid = p.postid)) AS hat_ersetzung,
            a.abrechnungsperiode_pkv, a.abrechnungsperiode_beihilfe,
            a.pkv_satz_override, a.beihilfe_satz_override
       FROM postbuch.postbuch p
       LEFT JOIN postbuch.arztrechnung        a ON a.postid = p.postid
       LEFT JOIN postbuch.handwerkerrechnung  h ON h.postid = p.postid
       LEFT JOIN postbuch.generische_rechnung g ON g.postid = p.postid
      WHERE p.postid = $1`,
    [postid],
  );
  if (rows.length === 0) return { gefunden: false, hatBlock: false, spielart: null, gruende: [] };

  const row = rows[0];
  const spielart = row.hat_arzt ? 'arztrechnung'
    : row.hat_handwerker ? 'handwerkerrechnung'
      : row.hat_generisch ? 'generische_rechnung' : null;

  const gruende = [];
  if (row.bezahlt_manuell) {
    gruende.push('Die Rechnung trägt ein manuell gesetztes Bezahldatum oder erfasste Zahlungen. Bitte zuerst im Feld „Bezahlt am" bzw. in der Zahlungstabelle entfernen — eine bezahlte Rechnung sollte ihren Block behalten.');
  }
  if (row.hat_ersetzung) {
    gruende.push('Die Rechnung ist mit einer Korrekturrechnung verknüpft. Bitte zuerst die Ersetzung aufheben.');
  }
  if (row.bestritten_betrag != null) {
    gruende.push('Die Rechnung hat einen offenen Streitfall. Bitte zuerst den bestrittenen Betrag auflösen.');
  }
  if (row.abrechnungsperiode_pkv || row.abrechnungsperiode_beihilfe
      || row.pkv_satz_override != null || row.beihilfe_satz_override != null) {
    gruende.push('Die Rechnung hängt an einer Abrechnungsperiode oder trägt einen Satz-Override. Bitte zuerst die Abrechnungsperiode leeren.');
  }

  const schutz = await ermittleReprocessSchutz(postid, db);
  for (const grund of schutz.gruende) {
    gruende.push(`Wiederverarbeitung gesperrt: ${grund}.`);
  }

  return {
    gefunden: true,
    hatBlock: spielart !== null,
    spielart,
    lebensbereich: row.lebensbereich,
    dokumentart: row.dokumentart,
    storageId: row.storage_id,
    storageBackend: row.storage_backend,
    gruende,
  };
}

/** Nutzerhinweis an die KI. Erzwingt Ziel-LxD, Blockverzicht und Betreffvermerk. */
export function buildInvalidierungsAnweisung(lebensbereich, dokumentart) {
  return [
    'Diese Rechnung wurde durch eine Korrekturrechnung ersetzt und ist damit fachlich KEINE Rechnung mehr.',
    `Klassifiziere das Dokument deshalb zwingend als lebensbereich="${lebensbereich}" und dokumentart="${INVALIDIERUNG_ZIEL_D}" (vorher ${lebensbereich}/${dokumentart}).`,
    'Setze istRechnung=false und gib keinen Rechnungs-Fachblock aus (weder arztrechnung noch handwerkerrechnung noch generischeRechnung).',
    `Stelle dem Betreff exakt „${INVALIDIERUNG_BETREFF_PRAEFIX} " voran, damit die Invalidierung in jeder Liste sichtbar ist.`,
  ].join(' ');
}

/**
 * Erzwingt das Ergebnis der Invalidierung auf den KI-Daten, bevor sie in
 * Embedding, Ablage-Sortierung und DB-Insert gehen.
 *
 * @param {object} extractedData geprüfte KI-Ausgabe (wird verändert)
 * @param {{lebensbereich:string}} ziel
 */
export function wendeInvalidierungAn(extractedData, ziel) {
  if (ziel?.lebensbereich) extractedData.lebensbereich = ziel.lebensbereich;
  extractedData.dokumentart = INVALIDIERUNG_ZIEL_D;
  extractedData.istRechnung = false;
  delete extractedData.arztrechnung;
  delete extractedData.handwerkerrechnung;
  delete extractedData.generischeRechnung;

  if (!extractedData.postbuch || typeof extractedData.postbuch !== 'object') {
    extractedData.postbuch = {};
  }
  // Ohne Rechnungsblock gibt es keinen Zahlstatus mehr, den irgendwer führen könnte.
  extractedData.postbuch.bezahlStatus = null;

  const betreff = String(extractedData.postbuch.betreff || '').trim();
  extractedData.postbuch.betreff = betreff.startsWith(INVALIDIERUNG_BETREFF_PRAEFIX)
    ? betreff
    : `${INVALIDIERUNG_BETREFF_PRAEFIX} ${betreff}`.trim();

  return extractedData;
}
