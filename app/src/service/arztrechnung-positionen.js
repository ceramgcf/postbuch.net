/**
 * service/arztrechnung-positionen.js — Einzelpositionen einer Arztrechnung lesen
 *
 * Läuft in der Pipeline direkt nach der Klassifikation, wenn das Dokument zur
 * Gruppe "arztrechnung" gehört. Das ganze Dokument geht in einem Aufruf an das
 * Modell der Klasse "Schwierig" (in der einfachen Modellwahl: das Analyse-
 * modell). Scheitert eine Plausibilitätsprüfung, liest das Modell der Klasse
 * "Nachlese" mit den Befunden erneut; übernommen wird die bessere Lesung.
 * Scheitern beide Prüfungen, bleiben die Positionen der besseren Lesung
 * stehen und die Befunde werden als Warnung am Dokument sichtbar.
 */

import { leseDokument, parseJsonFromText, resolveKlassenModell, summeKosten } from '../lib/llm.js';
import { ZWECK_EXTRAKTION_NACHDENKEN } from '../lib/llm/thinking-policy.js';
import { toNumeric } from '../lib/coerce.js';
import { appLog } from '../app-log.js';
import { buildPositionenPrompt, buildNachlesePrompt } from '../prompts/arztrechnung-positionen.js';
import { POSITIONEN_SCHEMA } from '../prompts/antwort-schemas.js';

// Rundungstoleranz für Summenvergleiche in Euro.
const TOLERANZ = 0.05;
// Ab diesem Faktor verlangen GOÄ und GOZ eine Begründung.
const FAKTOR_BEGRUENDUNGSPFLICHT = 2.3;

// Befunde zu Belegzeilen betreffen nur die Aufschlüsselung, nicht die
// Positionen selbst; beim Vergleich zweier Lesungen zählen sie nachrangig.
const BELEG_PRAEFIX = 'Belegzeilen zu ';

const euro = (n) => `${Number(n).toFixed(2).replace('.', ',')} €`;
const runde = (n) => Math.round(n * 100) / 100;

/**
 * Erkennt eine Begründung, die nur auf eine Legende verweist, statt sie
 * auszuschreiben: "3", "B2", "*1", "(4)", "s. Begr. 3", "siehe Anm. 2".
 */
export function istBloesserVerweis(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (/^[([]?\s*[*#]*\s*[A-Za-z]{0,3}\s*\.?\s*\d{1,3}[a-z]?\s*[*)\]]*\s*\.?$/.test(t)) return true;
  if (/^[*]+$/.test(t)) return true;
  return t.length < 40
    && /^(s\.|siehe|vgl\.)\s*(begr|anm|fn|fußnote|legende|ziffer|nr)/i.test(t);
}

/**
 * Vergleichsform eines Abschnittsnamens: Modelle übernehmen die Bezeichnung
 * nicht immer zeichengenau ("Honorar" / "Honorar:" / "HONORAR").
 */
export function abschnittsName(text) {
  return String(text ?? '').toLowerCase().replace(/\s+/g, ' ').trim().replace(/[\s:.,;\-–]+$/u, '');
}

/**
 * Prüft die Belegzeilen einer Position: Zusammen müssen sie den Positions-
 * betrag ergeben, sonst sind sie einer falschen Position zugeordnet oder
 * unvollständig gelesen (häufig fehlt die Mehrwertsteuerzeile).
 *
 * @returns {string|null} Befundtext oder null, wenn stimmig bzw. ohne Belegzeilen
 */
export function pruefeBelegzeilen(position) {
  const zeilen = Array.isArray(position?.belegzeilen) ? position.belegzeilen.filter((z) => z && typeof z === 'object') : [];
  if (!zeilen.length) return null;
  if (zeilen.some((z) => toNumeric(z.betrag) == null)) return 'Belegzeile(n) ohne lesbaren Betrag.';
  const soll = toNumeric(position?.betrag);
  if (soll == null) return null;
  const ist = runde(zeilen.reduce((s, z) => s + toNumeric(z.betrag), 0));
  if (Math.abs(ist - soll) > TOLERANZ) {
    return `Die Belegzeilen ergeben ${euro(ist)}, die Position weist ${euro(soll)} aus.`;
  }
  return null;
}

/**
 * Plausibilitätsprüfung einer Lesung.
 *
 * @param {object} lesung      - geparstes Modell-JSON
 * @param {object} kontext     - { gesamtbetrag, istTier }
 * @returns {string[]} Befunde, leer = plausibel
 */
export function pruefePositionen(lesung, { gesamtbetrag = null, istTier = false } = {}) {
  const befunde = [];
  const positionen = Array.isArray(lesung?.einzelpositionen) ? lesung.einzelpositionen : null;
  if (!positionen) return ['Die Antwort enthält keine Liste "einzelpositionen".'];
  if (!positionen.length) return ['Es wurde keine einzige Position gelesen.'];

  const ohneBetrag = positionen.filter((p) => toNumeric(p?.betrag) == null).length;
  if (ohneBetrag) befunde.push(`${ohneBetrag} Position(en) ohne lesbaren Betrag.`);

  const summe = runde(positionen.reduce((s, p) => s + (toNumeric(p?.betrag) ?? 0), 0));
  const soll = toNumeric(gesamtbetrag) ?? toNumeric(lesung?.kontrollsummen?.rechnungsbetrag);
  if (soll != null && Math.abs(summe - soll) > TOLERANZ) {
    befunde.push(`Die Summe der Positionen (${euro(summe)}) weicht vom Rechnungsbetrag (${euro(soll)}) um ${euro(runde(summe - soll))} ab.`);
  }

  // Abschnitte werden nicht gespeichert, sie dienen nur der Plausibilität.
  // Stimmt die Gesamtsumme, ändert eine abweichende Zuordnung nichts am
  // Ergebnis; geprüft wird nur ohne bekannten Rechnungsbetrag oder bei
  // abweichender Gesamtsumme, wo die Zwischensummen den Fehler eingrenzen.
  const gesamtStimmt = soll != null && Math.abs(summe - soll) <= TOLERANZ;
  const zwischensummen = !gesamtStimmt && Array.isArray(lesung?.kontrollsummen?.zwischensummen)
    ? lesung.kontrollsummen.zwischensummen : [];
  for (const z of zwischensummen) {
    const zsoll = toNumeric(z?.betrag);
    const name = abschnittsName(z?.abschnitt);
    if (zsoll == null || !name) continue;
    const zugeordnet = positionen.filter((p) => abschnittsName(p?.abschnitt) === name);
    // Ohne jede zugeordnete Position fehlt die Zuordnung, nicht ein Betrag.
    if (!zugeordnet.length) continue;
    const zist = runde(zugeordnet.reduce((s, p) => s + (toNumeric(p?.betrag) ?? 0), 0));
    if (Math.abs(zist - zsoll) > TOLERANZ) {
      befunde.push(`Abschnitt "${z.abschnitt}": Positionen ergeben ${euro(zist)}, die Rechnung weist ${euro(zsoll)} aus.`);
    }
  }

  if (!istTier) {
    const ohneBegr = positionen.filter((p) => {
      const f = toNumeric(p?.faktor);
      return f != null && f > FAKTOR_BEGRUENDUNGSPFLICHT && p?.ziffer && !String(p?.begruendung || '').trim();
    });
    if (ohneBegr.length) {
      befunde.push(`${ohneBegr.length} Position(en) mit Faktor über 2,3 ohne Begründung (Ziffer ${ohneBegr.slice(0, 8).map((p) => p.ziffer).join(', ')}${ohneBegr.length > 8 ? ', …' : ''}).`);
    }
  }

  for (const [i, p] of positionen.entries()) {
    const fehler = pruefeBelegzeilen(p);
    if (fehler) befunde.push(`${BELEG_PRAEFIX}Position ${i + 1} (${p?.ziffer || p?.leistung || 'ohne Bezeichnung'}): ${fehler}`);
  }

  const verweise = positionen.filter((p) => istBloesserVerweis(p?.begruendung));
  if (verweise.length) {
    befunde.push(`${verweise.length} Begründung(en) bestehen nur aus einem Verweis (z. B. "${String(verweise[0].begruendung).trim()}") statt aus dem Volltext der Legende.`);
  }
  return befunde;
}

/**
 * Vergleicht zwei Lesungen. Eine Lesung ohne Positionen gewinnt nie; sonst
 * entscheiden zuerst die Befunde zu den Positionen, dann die zu den
 * Belegzeilen. Die Nachlese (neu) gewinnt bei Gleichstand: Sie hat das
 * Dokument mit den Befunden vor Augen gelesen.
 */
export function istBessereLesung(neu, alt) {
  const anzahl = (x) => (Array.isArray(x?.lesung?.einzelpositionen) ? x.lesung.einzelpositionen.length : 0);
  if (!anzahl(neu)) return false;
  if (!anzahl(alt)) return true;
  const kern = (x) => x.befunde.filter((b) => !b.startsWith(BELEG_PRAEFIX)).length;
  const beleg = (x) => x.befunde.length - kern(x);
  if (kern(neu) !== kern(alt)) return kern(neu) < kern(alt);
  return beleg(neu) <= beleg(alt);
}

async function lese(refs, pdfBuffer, prompt, opts, settings, meta, kategorie) {
  const r = await leseDokument(refs, pdfBuffer, prompt, {
    stripTextLayerGewuenscht: opts.stripTextLayerGewuenscht,
    zweck: ZWECK_EXTRAKTION_NACHDENKEN,
    // Lange Positionslisten mit Volltext-Begründungen: Der JSON-Modus des
    // Providers verhindert, dass ein einzelnes Anführungszeichen die ganze
    // Lesung unbrauchbar macht.
    jsonMode: true,
    jsonSchema: POSITIONEN_SCHEMA,
  }, settings, { ...(meta || {}), kategorie });
  // Ohne hinterlegten Preis bleiben die Kosten unbekannt (null), nicht 0.
  const kosten = { tokensIn: r.tokensIn ?? 0, tokensOut: r.tokensOut ?? 0, costUsd: r.costUsd ?? null };
  const modell = r.ref?.model || null;
  if (r.abgeschnitten) {
    return { lesung: null, befunde: ['Die Antwort wurde am Ausgabelimit des Modells abgeschnitten.'], kosten, modell };
  }
  let lesung;
  try {
    lesung = parseJsonFromText(r.text);
  } catch (err) {
    return { lesung: null, befunde: [`Die Antwort war kein gültiges JSON (${err.message}).`], kosten, modell };
  }
  return { lesung, befunde: pruefePositionen(lesung, opts.kontext), kosten, modell };
}

export function normalisiere(lesung) {
  return (lesung?.einzelpositionen || [])
    .filter((p) => p && typeof p === 'object')
    .map((p) => ({
      behandlungsDatum: p.behandlungsDatum ?? null,
      ziffer: p.ziffer ?? null,
      leistung: p.leistung ?? null,
      begruendung: p.begruendung ?? p.begründung ?? null,
      faktor: p.faktor ?? null,
      betrag: p.betrag ?? null,
      zusatzangaben: p.zusatzangaben ?? null,
      // Nur Belegzeilen, die den Positionsbetrag ergeben, werden übernommen.
      belegzeilen: pruefeBelegzeilen(p) ? [] : (Array.isArray(p.belegzeilen) ? p.belegzeilen : [])
        .filter((z) => z && typeof z === 'object')
        .map((z) => ({
          beleg: z.beleg ?? null,
          nummer: z.nummer ?? null,
          leistung: z.leistung ?? null,
          menge: z.menge ?? null,
          einzelpreis: z.einzelpreis ?? null,
          betrag: z.betrag ?? null,
        })),
    }));
}

/**
 * Liest die Einzelpositionen und hängt sie an extractedData.arztrechnung.
 * Wirft nie: Ein Ausfall hinterlässt eine leere Positionsliste und eine
 * Warnung, damit das Dokument trotzdem abgelegt wird.
 *
 * @param {Buffer} pdfBuffer
 * @param {object} extractedData - Klassifikationsergebnis (wird ergänzt)
 * @param {object} opts          - { personen, stripTextLayerGewuenscht }
 * @returns {Promise<{ tokensIn, tokensOut, costUsd, modell, letztesModell, befunde }>}
 *   modell: alle beteiligten Modelle ("a → b"), letztesModell: das zuletzt lesende
 */
export async function leseArztrechnungPositionen(pdfBuffer, extractedData, opts = {}, settings, meta = null) {
  const ar = extractedData.arztrechnung || (extractedData.arztrechnung = {});
  const person = (opts.personen || []).find((p) => p.kurzname === ar.behandeltePerson);
  const kontext = {
    nameArzt: ar.nameArzt ?? null,
    rechnungsdatum: ar.rechnungsdatum ?? null,
    gesamtbetrag: toNumeric(ar.gesamtbetrag),
    istTier: person?.ist_tier === true,
    dokumentart: extractedData.dokumentart ?? null,
  };
  const leseOpts = { stripTextLayerGewuenscht: opts.stripTextLayerGewuenscht, kontext };
  const summe = { tokensIn: 0, tokensOut: 0, costUsd: 0 };
  const addiere = (k) => { summe.tokensIn += k.tokensIn; summe.tokensOut += k.tokensOut; summe.costUsd = summeKosten(summe.costUsd, k.costUsd); };

  const primaer = resolveKlassenModell('schwierig', settings);
  const nachlese = resolveKlassenModell('nachlese', settings);
  const fallback = resolveKlassenModell('fallback', settings);

  let beste = null;
  let modelle = [];
  try {
    const erst = await lese([primaer, nachlese, fallback], pdfBuffer, buildPositionenPrompt(kontext), leseOpts, settings, meta, 'positionen');
    addiere(erst.kosten);
    modelle.push(erst.modell);
    beste = erst;
    if (erst.befunde.length) {
      console.warn(`[arz-positionen] Erstlesung (${erst.modell}) unplausibel: ${erst.befunde.join(' ')}`);
      appLog('WARN', 'arz-positionen', `Erstlesung unplausibel, Nachlese mit ${nachlese?.model}`, {
        details: erst.befunde.join(' '), entity: meta?.entity, entityId: meta?.entityId,
      });
      try {
        const zweit = await lese([nachlese, primaer], pdfBuffer,
          buildNachlesePrompt(kontext, erst.befunde, erst.lesung), leseOpts, settings, meta, 'positionen_nachlese');
        addiere(zweit.kosten);
        modelle.push(zweit.modell);
        if (istBessereLesung(zweit, erst)) beste = zweit;
      } catch (err) {
        appLog('WARN', 'arz-positionen', `Nachlese fehlgeschlagen: ${err.message}`, { entity: meta?.entity, entityId: meta?.entityId });
      }
    }
  } catch (err) {
    console.warn(`[arz-positionen] Positionen nicht lesbar: ${err.message}`);
    appLog('ERROR', 'arz-positionen', `Einzelpositionen nicht lesbar: ${err.message}`, { entity: meta?.entity, entityId: meta?.entityId });
    beste = { lesung: null, befunde: [`Die Einzelpositionen konnten nicht gelesen werden (${err.message}).`] };
  }

  ar.einzelpositionen = normalisiere(beste?.lesung);
  const befunde = beste?.befunde || [];
  if (befunde.length) {
    if (!extractedData.qualityFlags) extractedData.qualityFlags = {};
    if (!Array.isArray(extractedData.qualityFlags.warnungen)) extractedData.qualityFlags.warnungen = [];
    for (const b of befunde) extractedData.qualityFlags.warnungen.push(`Einzelpositionen: ${b}`);
  }
  console.log(`[arz-positionen] ${ar.einzelpositionen.length} Positionen (${modelle.filter(Boolean).join(' → ')}), ${befunde.length} Befund(e)`);
  const gelesen = modelle.filter(Boolean);
  return { ...summe, modell: gelesen.join(' → ') || null, letztesModell: gelesen.at(-1) || null, befunde };
}
