/**
 * service/manuelle-erfassung.js – Basisablage eines Eingangs ohne KI
 *
 * Aus den Formularwerten (Lebensbereich, Dokumentart, Name/Betreff, optional
 * Datum und Rechnungsmerkmal) entsteht dieselbe Struktur, die sonst die
 * KI-Analyse liefert – nur mit dem Nötigsten: Der Name/Betreff ist voll der
 * Betreff und, bereinigt und bei Bedarf gekürzt, der Dateiname. Zusammenfassung
 * und Fachfelder bleiben leer. Die Pipeline setzt sie anstelle der KI-Analyse ein.
 */

import { getAktiveTaxonomie } from '../lib/taxonomie.js';
import { sanitizeSegment } from '../lib/storage/paths.js';
import { ergaenzeFachblock, validiere } from './extract-validator.js';

const DATUM_RE = /^\d{4}-\d{2}-\d{2}$/;
const NAME_MAX_ZEICHEN = 300;

// Spezialpipelines, deren Dokumente Rechnungen sind.
const RECHNUNGS_PIPELINES = new Set(['arztrechnung', 'handwerker']);

function istEchtesDatum(text) {
  if (!DATUM_RE.test(text)) return false;
  const d = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === text;
}

/**
 * Prüft die Formularwerte gegen die aktive Taxonomie.
 *
 * @param {object} roh  { lebensbereich, dokumentart, name, briefdatum?, istRechnung? }
 * @returns {Promise<{ fehler: string|null, wert: object|null }>}
 */
export async function pruefeManuelleErfassung(roh) {
  const fehler = (text) => ({ fehler: text, wert: null });
  if (!roh || typeof roh !== 'object' || Array.isArray(roh)) return fehler('Angaben zur Ablage fehlen.');

  const taxonomie = await getAktiveTaxonomie();
  const lebensbereich = typeof roh.lebensbereich === 'string' ? roh.lebensbereich.trim() : '';
  const dokumentart = typeof roh.dokumentart === 'string' ? roh.dokumentart.trim() : '';
  if (!taxonomie.lebensbereiche.some((l) => l.code === lebensbereich)) {
    return fehler('Bitte einen Lebensbereich wählen.');
  }
  const dokumentartZeile = taxonomie.dokumentarten.find((d) => d.code === dokumentart);
  if (!dokumentartZeile) return fehler('Bitte eine Dokumentart wählen.');

  let briefdatum = null;
  if (roh.briefdatum !== undefined && roh.briefdatum !== null && roh.briefdatum !== '') {
    if (typeof roh.briefdatum !== 'string' || !istEchtesDatum(roh.briefdatum)) {
      return fehler('Das Dokumentdatum ist kein gültiges Datum.');
    }
    briefdatum = roh.briefdatum;
  }

  // Name/Betreff ist Pflicht: Ohne ihn stünde das Dokument in jeder Liste nur
  // mit Lebensbereich und Dokumentart da.
  if (typeof roh.name !== 'string' || !roh.name.trim()) {
    return fehler('Bitte einen Namen bzw. Betreff angeben.');
  }
  if (roh.name.length > NAME_MAX_ZEICHEN) return fehler('Der Name ist zu lang.');
  const betreff = roh.name.trim().replace(/\s+/g, ' ').replace(/\.pdf$/i, '');
  const name = sanitizeSegment(betreff);
  if (!name) return fehler('Der Name enthält keine zulässigen Zeichen.');

  const aktiviert = taxonomie.aktivierungen.some((a) =>
    a.lebensbereich_code === lebensbereich && a.dokumentart_code === dokumentart);
  const pipeline = aktiviert ? dokumentartZeile.spezial_pipeline : null;
  const istRechnung = pipeline ? RECHNUNGS_PIPELINES.has(pipeline) : roh.istRechnung === true;

  return { fehler: null, wert: { lebensbereich, dokumentart, briefdatum, betreff, name, istRechnung } };
}

/**
 * Baut die Minimalstruktur für die Pipeline.
 *
 * @param {object} wert           geprüfte Formularwerte (pruefeManuelleErfassung)
 * @param {string} [eingangsname] erhaltener Name des Eingangs
 * @returns {Promise<object>}     Struktur wie aus der KI-Analyse, nur mit Betreff
 * @throws {Error} wenn die Einordnung inzwischen nicht mehr zulässig ist
 */
export async function baueManuelleStruktur(wert, eingangsname) {
  const taxonomie = await getAktiveTaxonomie();
  const data = {
    lebensbereich: wert.lebensbereich,
    dokumentart: wert.dokumentart,
    istRechnung: wert.istRechnung === true,
    postbuch: {
      richtung: 'eingang',
      betreff: wert.betreff || null,
      zusammenfassung: null,
      briefdatum: wert.briefdatum || null,
      dateiname: wert.name || String(eingangsname || '').replace(/\.pdf$/i, '') || 'Dokument',
    },
    qualityFlags: { warnungen: [] },
  };
  ergaenzeFachblock(data, taxonomie);

  const verstoesse = validiere(data, {
    lebensbereiche: taxonomie.lebensbereiche.map(({ code }) => code),
    dokumentarten: taxonomie.dokumentarten.map(({ code }) => code),
    sdDokumentarten: new Set(taxonomie.dokumentarten
      .filter(({ spezial_pipeline }) => spezial_pipeline != null)
      .map(({ code }) => code)),
  });
  if (verstoesse.length) {
    throw new Error(`Manuelle Ablage: Angaben nicht zulässig (${verstoesse.map((v) => v.pfad).join(', ')}).`);
  }
  return data;
}
