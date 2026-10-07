/**
 * service/steuer-auswertungen.js – steuerlich relevante Jahresauswertungen
 *
 * Analyse → Handwerker (§ 35a EStG) und Analyse → Gesundheitskosten
 * (außergewöhnliche Belastungen). Beide gruppieren nach dem Zahljahr: Für die
 * Steuer zählt das Jahr, in dem das Geld abgeflossen ist, nicht das Leistungs-
 * oder Rechnungsjahr (lib/rechnungs-filter.js, zahldatumSql).
 *
 * Dieselben Lade- und Gruppierfunktionen speisen die JSON-Route und den
 * Excel-Export, damit die Datei genau das enthält, was die Seite zeigt.
 *
 * Jahresschlüssel: 'YYYY' als String, 'offen' für noch nicht bezahlte
 * Rechnungen. Personenschlüssel: Kurzname, 'ohne' für Rechnungen ohne
 * behandelte Person, 'ohne_tier' für Tierarztrechnungen ohne zugeordnetes Tier.
 */

import { query } from '../db.js';
import { neueMappe, neuesBlatt, summenZeile, fmtDatum, zahl } from '../lib/excel.js';
import { zahldatumSql } from '../lib/rechnungs-filter.js';
import { zuCent } from './rechnung-zahlung.js';

export const JAHR_OFFEN = 'offen';
export const PERSON_OHNE = 'ohne';
export const TIER_OHNE = 'ohne_tier';
/** Gruppenfilter der Gesundheitskosten: Menschen (Standard), Tiere oder beides. */
export const GRUPPEN = ['personen', 'tiere', 'alle'];
/** § 35a-Filter der Handwerkerrechnungen: relevante (Standard), ausgeschlossene oder alle. */
export const RELEVANZ = ['relevant', 'irrelevant', 'alle'];

const ausCent = (cent) => (cent / 100).toFixed(2);
const jahrSchluessel = (jahr) => (jahr == null ? JAHR_OFFEN : String(jahr));
const personSchluessel = (person, istTier) => person || (istTier ? TIER_OHNE : PERSON_OHNE);
const passtZurGruppe = (istTier, gruppe) =>
  gruppe === 'alle' || (gruppe === 'tiere' ? istTier : !istTier);

// Sortierung der Personen: Menschen vor Tieren, darin alphabetisch, „ohne" ans Ende.
function vergleichePersonen(a, b) {
  return (a.ist_tier - b.ist_tier)
    || ([PERSON_OHNE, TIER_OHNE].includes(a.person) - [PERSON_OHNE, TIER_OHNE].includes(b.person))
    || a.person.localeCompare(b.person, 'de');
}

// Absteigend nach Jahr, „noch nicht bezahlt" ans Ende.
function vergleicheJahre(a, b) {
  if (a === b) return 0;
  if (a === JAHR_OFFEN) return 1;
  if (b === JAHR_OFFEN) return -1;
  return Number(b) - Number(a);
}

/**
 * Liest eine kommagetrennte Filterliste aus dem Query-String.
 * Fehlt der Parameter, gilt kein Filter (null).
 */
export function parseFilterListe(wert) {
  if (typeof wert !== 'string' || wert.trim() === '') return null;
  return new Set(wert.split(',').map((s) => s.trim()).filter(Boolean));
}

// ── Handwerker ───────────────────────────────────────────────────────────────

// Archivierte Dokumente zählen bewusst mit: „historisch" heißt weggeräumt,
// nicht ungültig. Der Lohnanteil nach § 35a EStG bleibt absetzbar, auch wenn
// der Vorgang abgeschlossen und archiviert ist. Eine durch eine Korrektur-
// rechnung ersetzte Rechnung gilt dagegen nicht mehr: Sie bleibt als Zeile
// sichtbar (`ersetzt_durch`), zählt aber in keiner Summe. Rechnungen, die der
// Nutzer für § 35a ausgeschlossen hat (`estg35a_irrelevant`), blendet der
// Relevanzfilter standardmäßig aus.
async function ladeHandwerkerZeilen() {
  const { rows } = await query(`
    SELECT h.postid, h.name_unternehmen, h.leistung, h.leistungsjahr, h.leistungsdatum,
           h.rechnungsdatum, h.re_nr, h.gesamtbetrag, h.lohnkosten, h.bezahlt_am,
           h.estg35a_irrelevant, ${zahldatumSql('h')} AS zahldatum,
           EXTRACT(YEAR FROM ${zahldatumSql('h')})::integer AS jahr,
           p.historisch, ers.von_postid AS ersetzt_durch
      FROM postbuch.handwerkerrechnung h
      JOIN postbuch.postbuch p ON p.postid = h.postid
      LEFT JOIN postbuch.dokument_beziehung ers ON ers.zu_postid = h.postid AND ers.art = 'ersetzt'
     ORDER BY zahldatum ASC NULLS LAST, h.rechnungsdatum ASC NULLS LAST, h.postid
  `);
  return rows;
}

/**
 * Handwerkerrechnungen je Zahljahr mit Rechnungs- und Lohnsummen.
 * @param {{jahre?: Set<string>|null, relevanz?: string}} [filter]
 *   relevanz: 'relevant' (Standard) | 'irrelevant' | 'alle' – bezogen auf § 35a EStG
 */
export async function handwerkerNachZahljahr({ jahre = null, relevanz = 'relevant' } = {}) {
  const gruppen = new Map();
  for (const r of await ladeHandwerkerZeilen()) {
    if (relevanz !== 'alle' && r.estg35a_irrelevant !== (relevanz === 'irrelevant')) continue;
    const schluessel = jahrSchluessel(r.jahr);
    if (jahre && !jahre.has(schluessel)) continue;
    let g = gruppen.get(schluessel);
    if (!g) {
      g = { jahr: schluessel, anzahl: 0, anzahl_archiviert: 0, gesamtCent: 0, lohnCent: 0,
        gesamtArchCent: 0, lohnArchCent: 0, rechnungen: [] };
      gruppen.set(schluessel, g);
    }
    g.rechnungen.push(r);
    if (r.ersetzt_durch) continue;
    const gesamt = zuCent(r.gesamtbetrag) ?? 0;
    const lohn = zuCent(r.lohnkosten) ?? 0;
    g.anzahl++;
    g.gesamtCent += gesamt;
    g.lohnCent += lohn;
    if (r.historisch) {
      g.anzahl_archiviert++;
      g.gesamtArchCent += gesamt;
      g.lohnArchCent += lohn;
    }
  }
  return [...gruppen.values()]
    .sort((a, b) => vergleicheJahre(a.jahr, b.jahr))
    .map(({ gesamtCent, lohnCent, gesamtArchCent, lohnArchCent, ...g }) => ({
      ...g,
      summe_gesamt: ausCent(gesamtCent),
      summe_lohnkosten: ausCent(lohnCent),
      summe_gesamt_archiviert: ausCent(gesamtArchCent),
      summe_lohnkosten_archiviert: ausCent(lohnArchCent),
    }));
}

// ── Gesundheitskosten ────────────────────────────────────────────────────────

// Alle Rechnungen aus dem Arztrechnungs-Block (Arzt-, Labor-, Hilfsmittel-
// rechnung, Rezept) mit Betrag. Vollständig erstattete tragen `vollerstattet`
// (Eigenbehalt 0) und werden nur auf Wunsch mitgeliefert.
// `rechnungssumme` ist der unbestrittene Teil (Rechnungsbetrag − bestrittener
// Betrag); erstattet = Summe aller zugeordneten Positionen aus
// Erstattungsbescheiden (PKV und Beihilfe). Tiere sind enthalten und
// gekennzeichnet (`ist_tier`: Tier-Datensatz oder Lebensbereich Tier). Ausgenommen: ersetzte Rechnungen und Rechnungen
// ohne Betrag. Archivierte zählen mit.
// `erstattung_ausstehend` nennt die Kostenträger, bei denen die Rechnung in
// einer noch laufenden Abrechnungsperiode steckt – der Eigenbehalt ist dann
// vorläufig.
async function ladeGesundheitsZeilen() {
  const { rows } = await query(`
    SELECT a.postid, a.behandelte_person AS person,
           COALESCE(NULLIF(a.name_arzt, ''), p.kontakt) AS gegenstelle,
           p.betreff, p.dokumentart, p.historisch,
           (COALESCE(m.ist_tier, false) OR p.lebensbereich = 'tier') AS ist_tier,
           a.rechnungsdatum, a.gesamtbetrag, a.bestritten_betrag, a.bezahlt_am,
           ${zahldatumSql('a')} AS zahldatum,
           EXTRACT(YEAR FROM ${zahldatumSql('a')})::integer AS jahr,
           COALESCE((
             SELECT sum(ep.erstattungsbetrag)
               FROM postbuch.erstattungsbescheid_einzelposition ep
              WHERE ep.arz_postid = a.postid
           ), 0) AS erstattet,
           array_remove(ARRAY[
             CASE WHEN abp.status IN ('COLLECTING', 'SUBMITTED') THEN 'PKV' END,
             CASE WHEN abb.status IN ('COLLECTING', 'SUBMITTED') THEN 'Beihilfe' END
           ], NULL) AS erstattung_ausstehend
      FROM postbuch.arztrechnung a
      JOIN postbuch.postbuch p ON p.postid = a.postid
      LEFT JOIN postbuch.mensch m ON m.kurzname = a.behandelte_person
      LEFT JOIN postbuch.abrechnungsperiode_buch abp
        ON abp.person = a.behandelte_person AND abp.kostentraeger = 'PKV'
       AND abp.periode = a.abrechnungsperiode_pkv
      LEFT JOIN postbuch.abrechnungsperiode_buch abb
        ON abb.person = a.behandelte_person AND abb.kostentraeger = 'Beihilfe'
       AND abb.periode = a.abrechnungsperiode_beihilfe
     WHERE a.gesamtbetrag IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM postbuch.dokument_beziehung db
                        WHERE db.zu_postid = a.postid AND db.art = 'ersetzt')
     ORDER BY zahldatum ASC NULLS LAST, a.rechnungsdatum ASC NULLS LAST, a.postid
  `);
  const ergebnis = [];
  for (const r of rows) {
    const rechnungCent = zuCent(r.gesamtbetrag) - (zuCent(r.bestritten_betrag) ?? 0);
    const erstattetCent = zuCent(r.erstattet) ?? 0;
    // Vollständig bestrittene Rechnungen bleiben außen vor
    if (rechnungCent <= 0) continue;
    const eigenCent = Math.max(rechnungCent - erstattetCent, 0);
    ergebnis.push({ ...r, vollerstattet: eigenCent === 0, rechnungssumme: ausCent(rechnungCent),
      erstattet: ausCent(erstattetCent), eigenbehalt: ausCent(eigenCent),
      _rechnungCent: rechnungCent, _erstattetCent: erstattetCent, _eigenCent: eigenCent });
  }
  return ergebnis;
}

/**
 * Gesundheitskosten je Zahljahr und behandelter Person.
 * @param {{jahre?: Set<string>|null, personen?: Set<string>|null, gruppe?: string}} [filter]
 *   gruppe: 'personen' | 'tiere' | 'alle' (Standard: alle)
 * @param {boolean} [filter.nurEndabgerechnet] blendet Rechnungen aus, deren
 *   Abrechnungsperiode noch sammelt oder eingereicht ist (Standard: nein)
 * @param {boolean} [filter.mitVollerstatteten] nimmt vollständig erstattete
 *   Rechnungen auf (Standard: nein)
 */
export async function gesundheitskostenNachZahljahr({
  jahre = null, personen = null, gruppe = 'alle', nurEndabgerechnet = false,
  mitVollerstatteten = false,
} = {}) {
  const neueSumme = () => ({ anzahl: 0, rechnungCent: 0, erstattetCent: 0, eigenCent: 0 });
  const addiere = (s, r) => {
    s.anzahl++;
    s.rechnungCent += r._rechnungCent;
    s.erstattetCent += r._erstattetCent;
    s.eigenCent += r._eigenCent;
  };
  const summenFelder = ({ anzahl, rechnungCent, erstattetCent, eigenCent }) => ({
    anzahl,
    summe_rechnung: ausCent(rechnungCent),
    summe_erstattet: ausCent(erstattetCent),
    summe_eigenbehalt: ausCent(eigenCent),
  });

  const jahresGruppen = new Map();
  for (const { _rechnungCent, _erstattetCent, _eigenCent, ...zeile } of await ladeGesundheitsZeilen()) {
    const r = { _rechnungCent, _erstattetCent, _eigenCent };
    const jKey = jahrSchluessel(zeile.jahr);
    const pKey = personSchluessel(zeile.person, zeile.ist_tier);
    if (!passtZurGruppe(zeile.ist_tier, gruppe)) continue;
    if (nurEndabgerechnet && zeile.erstattung_ausstehend.length > 0) continue;
    if (!mitVollerstatteten && zeile.vollerstattet) continue;
    if (jahre && !jahre.has(jKey)) continue;
    if (personen && !personen.has(pKey)) continue;
    let j = jahresGruppen.get(jKey);
    if (!j) {
      j = { jahr: jKey, summe: neueSumme(), personen: new Map() };
      jahresGruppen.set(jKey, j);
    }
    let p = j.personen.get(pKey);
    if (!p) {
      p = { person: pKey, ist_tier: zeile.ist_tier, summe: neueSumme(), rechnungen: [] };
      j.personen.set(pKey, p);
    }
    p.rechnungen.push(zeile);
    addiere(p.summe, r);
    addiere(j.summe, r);
  }

  return [...jahresGruppen.values()]
    .sort((a, b) => vergleicheJahre(a.jahr, b.jahr))
    .map((j) => ({
      jahr: j.jahr,
      ...summenFelder(j.summe),
      personen: [...j.personen.values()]
        .sort(vergleichePersonen)
        .map((p) => ({ person: p.person, ist_tier: p.ist_tier, ...summenFelder(p.summe), rechnungen: p.rechnungen })),
    }));
}

/**
 * Alle vorkommenden Jahres- und Personenschlüssel, für die Filterleiste.
 * personen: [{ person, ist_tier }]
 */
export async function gesundheitskostenFilterwerte() {
  const zeilen = await ladeGesundheitsZeilen();
  const jahre = [...new Set(zeilen.map((z) => jahrSchluessel(z.jahr)))].sort(vergleicheJahre);
  const personen = new Map();
  for (const z of zeilen) {
    const person = personSchluessel(z.person, z.ist_tier);
    if (!personen.has(person)) personen.set(person, { person, ist_tier: z.ist_tier });
  }
  return { jahre, personen: [...personen.values()].sort(vergleichePersonen) };
}

// ── Excel ────────────────────────────────────────────────────────────────────

const jahrLabel = (jahr) => (jahr === JAHR_OFFEN ? 'Noch nicht bezahlt' : jahr);
const personLabel = (person) => (person === PERSON_OHNE ? 'Ohne Person'
  : person === TIER_OHNE ? 'Tier ohne Zuordnung' : person);

/** @param {Awaited<ReturnType<typeof gesundheitskostenNachZahljahr>>} gruppen */
export async function gesundheitskostenExcel(gruppen) {
  const wb = neueMappe();
  const detail = neuesBlatt(wb, 'Gesundheitskosten', [
    { header: 'Zahljahr', key: 'jahr', width: 18 },
    { header: 'Person', key: 'person', width: 20 },
    { header: 'Art', key: 'art', width: 8 },
    { header: 'PostID', key: 'postid', width: 10 },
    { header: 'Bezahlt am', key: 'zahldatum', width: 12 },
    { header: 'Gegenstelle', key: 'gegenstelle', width: 32 },
    { header: 'Betreff', key: 'betreff', width: 48 },
    { header: 'Rechnungssumme', key: 'rechnung', width: 16, euro: true },
    { header: 'Erstattet', key: 'erstattet', width: 14, euro: true },
    { header: 'Eigenbehalt', key: 'eigenbehalt', width: 14, euro: true },
    { header: 'Hinweis', key: 'hinweis', width: 36 },
  ]);
  for (const j of gruppen) {
    for (const p of j.personen) {
      for (const r of p.rechnungen) {
        const hinweise = [];
        if (r.erstattung_ausstehend?.length) {
          hinweise.push(`Erstattung ${r.erstattung_ausstehend.join('/')} ausstehend`);
        }
        if (r.bestritten_betrag != null) {
          const euro = (w) => Number(w).toFixed(2).replace('.', ',');
          hinweise.push(`${euro(r.bestritten_betrag)} € von ${euro(r.gesamtbetrag)} € bestritten`);
        }
        if (r.historisch) hinweise.push('archiviert');
        if (r.vollerstattet) hinweise.push('vollständig erstattet');
        detail.addRow({
          jahr: jahrLabel(j.jahr),
          person: personLabel(p.person),
          art: p.ist_tier ? 'Tier' : 'Mensch',
          postid: r.postid,
          zahldatum: fmtDatum(r.zahldatum),
          gegenstelle: r.gegenstelle || '',
          betreff: r.betreff || '',
          rechnung: zahl(r.rechnungssumme),
          erstattet: zahl(r.erstattet),
          eigenbehalt: zahl(r.eigenbehalt),
          hinweis: hinweise.join(', '),
        });
      }
    }
  }
  detail.autoFilter = { from: 'A1', to: { row: 1, column: detail.columns.length } };

  const summen = neuesBlatt(wb, 'Summen', [
    { header: 'Zahljahr', key: 'jahr', width: 18 },
    { header: 'Person', key: 'person', width: 20 },
    { header: 'Art', key: 'art', width: 8 },
    { header: 'Rechnungen', key: 'anzahl', width: 12 },
    { header: 'Rechnungssumme', key: 'rechnung', width: 16, euro: true },
    { header: 'Erstattet', key: 'erstattet', width: 14, euro: true },
    { header: 'Eigenbehalt', key: 'eigenbehalt', width: 14, euro: true },
  ]);
  for (const j of gruppen) {
    for (const p of j.personen) {
      summen.addRow({
        jahr: jahrLabel(j.jahr), person: personLabel(p.person), art: p.ist_tier ? 'Tier' : 'Mensch',
        anzahl: p.anzahl,
        rechnung: zahl(p.summe_rechnung), erstattet: zahl(p.summe_erstattet),
        eigenbehalt: zahl(p.summe_eigenbehalt),
      });
    }
    summenZeile(summen, {
      jahr: jahrLabel(j.jahr), person: 'Summe', anzahl: j.anzahl,
      rechnung: zahl(j.summe_rechnung), erstattet: zahl(j.summe_erstattet),
      eigenbehalt: zahl(j.summe_eigenbehalt),
    });
  }
  return wb.xlsx.writeBuffer();
}

/** @param {Awaited<ReturnType<typeof handwerkerNachZahljahr>>} gruppen */
export async function handwerkerExcel(gruppen) {
  const wb = neueMappe();
  const detail = neuesBlatt(wb, 'Handwerkerrechnungen', [
    { header: 'Zahljahr', key: 'jahr', width: 18 },
    { header: 'PostID', key: 'postid', width: 10 },
    { header: 'Bezahlt am', key: 'zahldatum', width: 12 },
    { header: 'Unternehmen', key: 'unternehmen', width: 30 },
    { header: 'Leistung', key: 'leistung', width: 40 },
    { header: 'Leistungsjahr', key: 'leistungsjahr', width: 13 },
    { header: 'Rechnungsdatum', key: 'rechnungsdatum', width: 15 },
    { header: 'Re.-Nr.', key: 're_nr', width: 16 },
    { header: 'Rechnungssumme', key: 'gesamtbetrag', width: 16, euro: true },
    { header: 'Lohnkosten', key: 'lohnkosten', width: 14, euro: true },
    { header: 'Hinweis', key: 'hinweis', width: 36 },
  ]);
  for (const j of gruppen) {
    for (const r of j.rechnungen) {
      const hinweise = [];
      if (r.ersetzt_durch) hinweise.push(`ersetzt durch ${r.ersetzt_durch}, zählt nicht`);
      if (r.historisch) hinweise.push('archiviert');
      if (r.estg35a_irrelevant) hinweise.push('für § 35a ausgeschlossen');
      const row = detail.addRow({
        jahr: jahrLabel(j.jahr),
        postid: r.postid,
        zahldatum: fmtDatum(r.zahldatum),
        unternehmen: r.name_unternehmen || '',
        leistung: r.leistung || '',
        leistungsjahr: r.leistungsjahr ?? '',
        rechnungsdatum: fmtDatum(r.rechnungsdatum),
        re_nr: r.re_nr || '',
        gesamtbetrag: zahl(r.gesamtbetrag),
        lohnkosten: zahl(r.lohnkosten),
        hinweis: hinweise.join(', '),
      });
      if (r.ersetzt_durch) row.font = { strike: true, color: { argb: 'FF888888' } };
    }
  }
  detail.autoFilter = { from: 'A1', to: { row: 1, column: detail.columns.length } };

  const summen = neuesBlatt(wb, 'Summen', [
    { header: 'Zahljahr', key: 'jahr', width: 18 },
    { header: 'Rechnungen', key: 'anzahl', width: 12 },
    { header: 'Rechnungssumme', key: 'gesamt', width: 16, euro: true },
    { header: 'Lohnkosten', key: 'lohn', width: 14, euro: true },
  ]);
  for (const j of gruppen) {
    summen.addRow({ jahr: jahrLabel(j.jahr), anzahl: j.anzahl,
      gesamt: zahl(j.summe_gesamt), lohn: zahl(j.summe_lohnkosten) });
  }
  return wb.xlsx.writeBuffer();
}
