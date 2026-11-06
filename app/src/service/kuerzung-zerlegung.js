/**
 * service/kuerzung-zerlegung.js — Kürzungen eines Bescheids auf Positionen zerlegen
 *
 * Eine Kürzung des Bescheids kann eine Position betreffen, die ganze Rechnung
 * oder als Sammelkürzung (ein Betrag, viele Gründe) viele Positionen. Die KI
 * zerlegt jede Kürzung in Anteile je Position; dieser Code rechnet nichts
 * selbst aus, er prüft nur:
 *   - Summe der Anteile = Kürzungsbetrag,
 *   - jede genannte Position existiert,
 *   - kein Anteil und keine Anteilssumme je Position übersteigt den Positionsbetrag,
 *   - jeder genannte Satz existiert, und jeder Satz der Begründung gehört zu
 *     mindestens einem Anteil.
 * Die KI zitiert die Begründung nicht, sondern nennt die Nummern der Sätze
 * (S1 … Sn), die der Server vorher vergeben hat; den Text jedes Anteils setzt
 * der Server daraus wieder zusammen. So kann kein Auszug verfälscht werden.
 * Scheitert eine Prüfung, zerlegt das Modell der Klasse "Nachlese" erneut.
 * Ein auffällig großer Restanteil ohne Position ist kein Fehler, löst aber
 * ebenfalls die Nachlese aus (Hinweis); übernommen wird die bessere Zerlegung.
 * Besteht auch das nicht, bleibt die Kürzung eine einzige Zeile ohne Position
 * mit dem vollen Text — wie vor der Zerlegung.
 */

import { callLLM, parseJsonFromText, resolveKlassenModell, buildCostMap, calculateCost, summeKosten } from '../lib/llm.js';
import { ZWECK_ZERLEGUNG } from '../lib/llm/thinking-policy.js';
import { toNumeric } from '../lib/coerce.js';
import { appLog } from '../app-log.js';
import { buildZerlegungPrompt, buildZerlegungNachlesePrompt } from '../prompts/erstattungsbescheid.js';
import { ZERLEGUNG_SCHEMA } from '../prompts/antwort-schemas.js';

const TOLERANZ = 0.05;
// Ab hier gilt ein Restanteil ohne Position als auffällig: Er muss beide
// Grenzen überschreiten, damit kleine Kürzungen mit unklarem Bezug nicht
// jedes Mal eine Nachlese auslösen.
const REST_AUFFAELLIG_EURO = 100;
const REST_AUFFAELLIG_QUOTE = 0.1;
const runde = (n) => Math.round(n * 100) / 100;
const euro = (n) => `${Number(n).toFixed(2).replace('.', ',')} €`;

// Ein Abschnitt zählt als Satz, wenn er genug Buchstaben trägt; kürzere
// (Datumszeilen, Überschriften wie "Kurz.") hängen am nächsten Satz.
const istSatz = (t) => t.replace(/[^A-Za-zÄÖÜäöüß]/g, '').length >= 12;
const TRENNER = /((?<=[.!?])[ \t]+|\n+)/;
// Ein Punkt nach einer Abkürzung oder Zahl beendet keinen Satz: "z. B.",
// "Nr. 5", "Abs. 2", "1. Quartal", "22.01. bis …". Bis zu drei Buchstaben vor
// dem Punkt gelten als Abkürzung, längere nur aus der Liste.
const ABKUERZUNG = /(?:^|[\s(])(?:[A-Za-zÄÖÜäöüß]{1,3}|\d+|ggf|bzw|vgl|inkl|zzgl|bspw|Ziff|gem|Anl|Pkt)\.$/;

// Trennt einen Absatz in [Stück, Trenner, Stück, …] und fügt Stücke wieder
// zusammen, die nur an einer Abkürzung getrennt wurden.
function teileAbsatz(block) {
  const roh = block.split(TRENNER);
  const teile = [roh[0]];
  for (let i = 1; i < roh.length; i += 2) {
    if (!roh[i].includes('\n') && ABKUERZUNG.test(teile.at(-1))) teile[teile.length - 1] += roh[i] + roh[i + 1];
    else teile.push(roh[i], roh[i + 1]);
  }
  return teile;
}

/**
 * Zerlegt eine Begründung in nummerierte Sätze. Absätze trennt eine Leerzeile.
 * Kurze Abschnitte am Anfang eines Absatzes (die Datumszeile) bilden dessen
 * Kopf, der jedem daraus übernommenen Satz vorangestellt wird; kurze Abschnitte
 * mitten im Absatz hängen am folgenden, am Absatzende am vorigen Satz. Ein
 * Absatz ganz ohne Satz wird als Ganzes ein Satz, damit nichts verloren geht.
 *
 * @returns {{ absaetze: { kopf: string, saetze: number[] }[], saetze: { nr, absatz, text, vorTrenner }[] }}
 */
export function nummeriereBegruendung(text) {
  const absaetze = [];
  const saetze = [];
  const bloecke = String(text || '').split(/\n[ \t]*\n/).map((a) => a.trim()).filter(Boolean);
  for (const [ai, block] of bloecke.entries()) {
    const teile = teileAbsatz(block);
    const absatz = { kopf: '', saetze: [] };
    let offen = '';
    let offenVor = '';
    const neu = (t, vorTrenner) => {
      saetze.push({ nr: saetze.length + 1, absatz: ai, text: t, vorTrenner });
      absatz.saetze.push(saetze.length);
    };
    for (let i = 0; i < teile.length; i += 2) {
      const stueck = teile[i];
      const vor = i > 0 ? teile[i - 1] : '';
      if (!stueck.trim()) continue;
      if (!istSatz(stueck)) {
        if (offen) offen += vor + stueck;
        else { offen = stueck; offenVor = vor; }
        continue;
      }
      if (!offen) neu(stueck, vor);
      else if (!absatz.saetze.length) { absatz.kopf = offen + vor; neu(stueck, ''); }
      else neu(offen + vor + stueck, offenVor);
      offen = '';
    }
    if (offen) {
      if (absatz.saetze.length) saetze[absatz.saetze.at(-1) - 1].text += offenVor + offen;
      else neu(offen, '');
    }
    absaetze.push(absatz);
  }
  return { absaetze, saetze };
}

/** Sätze in der Form, in der die KI sie sieht: der erste eines Absatzes mit dessen Kopf. */
export function saetzeFuerKi(nummerierung) {
  return nummerierung.saetze.map((satz) => {
    const absatz = nummerierung.absaetze[satz.absatz];
    const kopf = absatz.saetze[0] === satz.nr ? absatz.kopf : '';
    return { nr: satz.nr, absatz: satz.absatz + 1, text: (kopf + satz.text).trim() };
  });
}

/**
 * Setzt den Text aus den gewählten Satznummern wieder zusammen: Absätze in
 * Originalreihenfolge, je Absatz mit seinem Kopf (Datumszeile). null ohne Sätze.
 */
export function setzeText(nummerierung, nummern) {
  const gewaehlt = new Set(nummern);
  const ergebnis = [];
  for (const absatz of nummerierung.absaetze) {
    const drin = absatz.saetze.filter((n) => gewaehlt.has(n));
    if (!drin.length) continue;
    let t = absatz.kopf;
    drin.forEach((n, i) => {
      const satz = nummerierung.saetze[n - 1];
      // Unmittelbar folgende Sätze behalten ihren Originaltrenner (auch einen
      // Zeilenumbruch), nach einer Lücke trennt ein Leerzeichen.
      const direkt = i > 0 && drin[i - 1] === n - 1;
      t += i === 0 ? satz.text : (direkt ? satz.vorTrenner || ' ' : ' ') + satz.text;
    });
    ergebnis.push(t.trim());
  }
  return ergebnis.length ? ergebnis.join('\n\n') : null;
}

// Satznummern eines Anteils: nur ganze Zahlen, ohne Doppelte, sortiert.
function nummernAus(a) {
  const roh = Array.isArray(a?.saetze) ? a.saetze : [];
  return [...new Set(roh.map((n) => Number(String(n).replace(/^S/i, ''))))].sort((x, y) => x - y);
}

/**
 * @param {object}   antwort    - geparstes Modell-JSON
 * @param {object[]} kuerzungen - Eingabe [{ eb_subid, kuerzung_index, kuerzungsbetrag, begruendung }]
 * @param {Map}      positionen - subid → { betrag }
 * @returns {{ befunde: string[], hinweise: string[], rest: number, zerlegt: Map<string, object[]> }}
 *   befunde: Fehler, die eine Übernahme verhindern; hinweise: Auffälligkeiten,
 *   die nur eine Nachlese auslösen; rest: Summe aller Restanteile ohne Position
 */
export function pruefeZerlegung(antwort, kuerzungen, positionen) {
  const befunde = [];
  const hinweise = [];
  let restGesamt = 0;
  const zerlegt = new Map();
  const liste = Array.isArray(antwort?.kuerzungen) ? antwort.kuerzungen : null;
  if (!liste) return { befunde: ['Die Antwort enthält keine Liste "kuerzungen".'], hinweise, rest: 0, zerlegt };

  const jePosition = new Map();
  for (const k of kuerzungen) {
    const key = `${k.eb_subid}/${k.kuerzung_index}`;
    const eintrag = liste.find((e) => Number(e?.eb_subid) === k.eb_subid && Number(e?.kuerzung_index) === k.kuerzung_index);
    if (!eintrag || !Array.isArray(eintrag.anteile) || !eintrag.anteile.length) {
      befunde.push(`Kürzung ${key}: keine Anteile geliefert.`);
      continue;
    }
    const nummerierung = nummeriereBegruendung(k.begruendung);
    const anzahl = nummerierung.saetze.length;
    const ungueltig = new Set();
    const anteile = [];
    for (const a of eintrag.anteile) {
      const betrag = toNumeric(a?.betrag);
      const subid = a?.arz_subid == null ? null : Number(a.arz_subid);
      if (betrag == null) { befunde.push(`Kürzung ${key}: ein Anteil hat keinen lesbaren Betrag.`); continue; }
      if (subid != null && !positionen.has(subid)) {
        befunde.push(`Kürzung ${key}: Position ${a.arz_subid} gibt es in der Rechnung nicht.`);
        continue;
      }
      if (subid != null) {
        const pos = positionen.get(subid);
        if (betrag > pos.betrag + TOLERANZ) {
          befunde.push(`Kürzung ${key}: Anteil ${euro(betrag)} an Position ${subid} übersteigt deren Betrag ${euro(pos.betrag)}.`);
        }
        jePosition.set(subid, runde((jePosition.get(subid) || 0) + betrag));
      }
      const nummern = nummernAus(a).filter((n) => {
        const ok = Number.isInteger(n) && n >= 1 && n <= anzahl;
        if (!ok) ungueltig.add(String(n));
        return ok;
      });
      anteile.push({ arz_subid: subid, betrag: runde(betrag), saetze: nummern, begruendung: setzeText(nummerierung, nummern), rechenweg: a?.rechenweg || null });
    }
    const summe = runde(anteile.reduce((s, a) => s + a.betrag, 0));
    if (Math.abs(summe - k.kuerzungsbetrag) > TOLERANZ) {
      befunde.push(`Kürzung ${key}: Die Anteile ergeben ${euro(summe)}, der Kürzungsbetrag ist ${euro(k.kuerzungsbetrag)} (Differenz ${euro(runde(summe - k.kuerzungsbetrag))}).`);
    }
    if (ungueltig.size) {
      befunde.push(`Kürzung ${key}: Die Satznummer(n) ${[...ungueltig].join(', ')} gibt es nicht; die Begründung hat die Sätze 1 bis ${anzahl}.`);
    }
    const genannt = new Set(anteile.flatMap((a) => a.saetze));
    const fehlend = nummerierung.saetze.map((x) => x.nr).filter((n) => !genannt.has(n));
    if (fehlend.length) {
      befunde.push(`Kürzung ${key}: Satz/Sätze ${fehlend.map((n) => `S${n}`).join(', ')} der Begründung gehören zu keinem Anteil (z. B. "${nummerierung.saetze[fehlend[0] - 1].text.slice(0, 80)}").`);
    }
    // Der Restanteil zeigt nur, was kein Anteil mit Position trägt, nicht den
    // ganzen Begründungsblock.
    const getragen = new Set(anteile.filter((a) => a.arz_subid != null).flatMap((a) => a.saetze));
    for (const a of anteile) {
      if (a.arz_subid == null) a.begruendung = setzeText(nummerierung, a.saetze.filter((n) => !getragen.has(n)));
    }
    const rest = runde(anteile.filter((a) => a.arz_subid == null).reduce((s, a) => s + a.betrag, 0));
    restGesamt = runde(restGesamt + rest);
    // Eine pauschale Kürzung ohne jede Position (Regel Z9) ist kein Rest.
    const mitPosition = anteile.some((a) => a.arz_subid != null);
    if (mitPosition && rest > REST_AUFFAELLIG_EURO && rest > REST_AUFFAELLIG_QUOTE * k.kuerzungsbetrag) {
      hinweise.push(`Kürzung ${key}: Der Restanteil ohne Position ist mit ${euro(rest)} auffällig groß (${Math.round(rest / k.kuerzungsbetrag * 100)} % der Kürzung). Prüfe jeden Absatz der Begründung erneut, besonders prozentuale Kürzungen: Sie treffen jede betroffene Position, auch Summenposten von Labor- und Praxislaborbelegen.`);
    }
    zerlegt.set(key, anteile);
  }
  for (const [subid, summe] of jePosition) {
    const pos = positionen.get(subid);
    if (summe > pos.betrag + TOLERANZ) {
      befunde.push(`Position ${subid}: Alle Anteile zusammen (${euro(summe)}) übersteigen ihren Betrag ${euro(pos.betrag)}.`);
    }
  }
  return { befunde, hinweise, rest: restGesamt, zerlegt };
}

async function zerlege(ref, prompt, kuerzungen, positionen, settings, meta) {
  // jsonMode: Ohne JSON-Modus brach ein einzelnes unmaskiertes Zeichen die
  // ganze Antwort.
  const r = await callLLM(ref, prompt, { zweck: ZWECK_ZERLEGUNG, jsonMode: true, jsonSchema: ZERLEGUNG_SCHEMA }, settings, meta);
  const tokensIn = r.usage?.inputTokens ?? 0;
  const tokensOut = r.usage?.outputTokens ?? 0;
  const kosten = {
    tokensIn, tokensOut,
    // Ohne hinterlegten Preis bleiben die Kosten unbekannt (null), nicht 0.
    costUsd: r.viaSubscription ? 0 : calculateCost(ref.model, tokensIn, tokensOut, buildCostMap(settings)),
  };
  if (r.abgeschnitten) return { antwort: null, befunde: ['Die Antwort wurde am Ausgabelimit abgeschnitten.'], hinweise: [], rest: 0, zerlegt: new Map(), kosten };
  let antwort;
  try {
    antwort = parseJsonFromText(r.text);
  } catch (err) {
    return { antwort: null, befunde: [`Die Antwort war kein gültiges JSON (${err.message}).`], hinweise: [], rest: 0, zerlegt: new Map(), kosten };
  }
  return { antwort, ...pruefeZerlegung(antwort, kuerzungen, positionen), kosten };
}

/**
 * Zerlegt die Kürzungen EINER Rechnung.
 *
 * @param {object[]} kuerzungen - [{ eb_subid, kuerzung_index, kuerzungsbetrag, begruendung }]
 * @param {object[]} positionen - Zeilen aus arztrechnung_einzelposition, je mit belegzeilen[]
 * @param {object}   rechnung   - { arz_postid, rechnungsbetrag }
 * @returns {Promise<{ zeilen: Map<string, object[]>, modelle: string[], tokensIn, tokensOut, costUsd, befunde }>}
 *   zeilen: je "eb_subid/kuerzung_index" die zu speichernden Zeilen { arz_subid, betrag, begruendung }
 */
export async function zerlegeKuerzungen(kuerzungen, positionen, rechnung, settings, meta = null, korrekturAnweisung = '') {
  const posMap = new Map(positionen.map((p) => [Number(p.subid), { betrag: toNumeric(p.betrag) ?? 0 }]));
  const positionenFuerKi = positionen.map((p) => ({
    subid: p.subid,
    behandlungs_datum: p.behandlungs_datum,
    ziffer: p.goa_goz_gebueh_pzn,
    leistung: p.leistung,
    begruendung: p.begruendung,
    faktor: toNumeric(p.faktor),
    betrag: toNumeric(p.betrag),
    zusatzangaben: p.zusatzangaben,
    // Zeilen eines beigefügten Belegs, dessen Summe diese Position ist; sie
    // zeigen der KI, welche Labor- oder Materialleistungen darin stecken.
    ...(p.belegzeilen?.length ? {
      belegzeilen: p.belegzeilen.map((z) => ({
        beleg: z.beleg, nummer: z.nummer, leistung: z.leistung,
        menge: toNumeric(z.menge), einzelpreis: toNumeric(z.einzelpreis), betrag: toNumeric(z.betrag),
      })),
    } : {}),
  }));
  const eingabe = kuerzungen.map((k) => ({
    eb_subid: k.eb_subid, kuerzung_index: k.kuerzung_index,
    kuerzungsbetrag: toNumeric(k.kuerzungsbetrag) ?? 0, begruendung: k.begruendung,
  }));
  // Die KI sieht die Begründung nur als nummerierte Sätze.
  const eingabeFuerKi = eingabe.map(({ begruendung, ...k }) => ({
    ...k, saetze: saetzeFuerKi(nummeriereBegruendung(begruendung)),
  }));
  const praefix = korrekturAnweisung ? `### KORREKTUR-ANWEISUNGEN VOM BENUTZER ###\n${korrekturAnweisung}\n\n` : '';
  const summe = { tokensIn: 0, tokensOut: 0, costUsd: 0 };
  const addiere = (k) => { summe.tokensIn += k.tokensIn; summe.tokensOut += k.tokensOut; summe.costUsd = summeKosten(summe.costUsd, k.costUsd); };
  const modelle = [];

  const primaer = resolveKlassenModell('schwierig', settings);
  const nachlese = resolveKlassenModell('nachlese', settings);
  let beste = null;
  try {
    const erst = await zerlege(primaer, praefix + buildZerlegungPrompt(eingabeFuerKi, positionenFuerKi, rechnung), eingabe, posMap, settings, meta);
    addiere(erst.kosten); modelle.push(primaer.model); beste = erst;
  } catch (err) {
    appLog('WARN', 'erstattungsbescheid', `Kürzungszerlegung (${primaer.model}) fehlgeschlagen: ${err.message}`, { entity: meta?.entity, entityId: meta?.entityId });
  }
  if (!beste || beste.befunde.length || beste.hinweise.length) {
    const befunde = beste ? [...beste.befunde, ...beste.hinweise] : ['Der erste Versuch ist mit einem Fehler abgebrochen.'];
    appLog('WARN', 'erstattungsbescheid', `Kürzungszerlegung unplausibel, Nachlese mit ${nachlese.model}`, {
      details: befunde.join(' '), entity: meta?.entity, entityId: meta?.entityId,
    });
    try {
      const zweit = await zerlege(nachlese,
        praefix + buildZerlegungNachlesePrompt(eingabeFuerKi, positionenFuerKi, rechnung, befunde, beste?.antwort ?? null),
        eingabe, posMap, settings, { ...(meta || {}), kategorie: 'kuerzung_nachlese' });
      addiere(zweit.kosten); modelle.push(nachlese.model);
      // Weniger Fehler gewinnen; bei gleich vielen der kleinere Rest. Die
      // Nachlese gewinnt bei Gleichstand, sie kannte die Befunde.
      if (!beste || zweit.befunde.length < beste.befunde.length
        || (zweit.befunde.length === beste.befunde.length && zweit.rest <= beste.rest + TOLERANZ)) beste = zweit;
    } catch (err) {
      appLog('WARN', 'erstattungsbescheid', `Kürzungs-Nachlese (${nachlese.model}) fehlgeschlagen: ${err.message}`, { entity: meta?.entity, entityId: meta?.entityId });
    }
  }

  const zeilen = new Map();
  // Nur eine fehlerfreie Zerlegung wird übernommen. Sonst bleibt jede Kürzung
  // eine Zeile ohne Position mit vollem Text: lieber unzerlegt als falsch.
  if (beste && !beste.befunde.length) {
    for (const k of eingabe) {
      const key = `${k.eb_subid}/${k.kuerzung_index}`;
      const anteile = beste.zerlegt.get(key);
      // Cent-Rest aus der Toleranz landet im Restanteil, damit die Summe der
      // Zeilen exakt dem Kürzungsbetrag des Bescheids entspricht.
      const diff = runde(k.kuerzungsbetrag - anteile.reduce((s, a) => s + a.betrag, 0));
      if (diff !== 0) {
        const rest = anteile.find((a) => a.arz_subid == null);
        if (rest) rest.betrag = runde(rest.betrag + diff);
        else anteile.push({ arz_subid: null, betrag: diff, begruendung: null, rechenweg: 'Rundungsrest' });
      }
      zeilen.set(key, anteile);
    }
    const details = [...zeilen.entries()].map(([key, a]) =>
      `${key}: ${a.map((x) => `${x.arz_subid ?? 'Rest'}=${x.betrag} (${x.rechenweg || '–'})`).join('; ')}`).join(' | ');
    appLog('INFO', 'erstattungsbescheid', `Kürzungen zerlegt (${rechnung.arz_postid})`, { details, entity: meta?.entity, entityId: meta?.entityId });
    if (beste.hinweise.length) {
      appLog('WARN', 'erstattungsbescheid', `Kürzungszerlegung mit Auffälligkeiten übernommen (${rechnung.arz_postid})`, {
        details: beste.hinweise.join(' '), entity: meta?.entity, entityId: meta?.entityId,
      });
    }
  }
  return { zeilen, modelle, ...summe, befunde: beste?.befunde ?? ['Keine Zerlegung erhalten.'] };
}
