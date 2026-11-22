/**
 * service/suche.js – hybride Suche über Dokumente und Akten
 *
 * Eine Anfrage sammelt Kandidaten über zwei Wege:
 *
 *   - wörtlich: deutsche Volltextsuche (Wortstämme) plus Teilwortabgleich
 *     über die Metadaten, gelesen aus gespeicherten, indizierten Suchspalten
 *     (suchtext, suchvektor). Jedes Suchwort zählt einzeln (ODER) mit seiner
 *     Trennschärfe; die ganze Eingabe als Zeichenfolge (z. B. ein
 *     Aktenzeichen) zählt vollständig.
 *   - inhaltlich: pgvector-Nachbarn des Anfrage-Embeddings.
 *
 * Für jeden Kandidaten entstehen Wortwert W (gewichteter Anteil der Suchwörter)
 * und Inhaltswert I (Ähnlichkeit auf der Skala des Modells); sortiert wird nach
 * der daraus gebildeten Übereinstimmung (siehe uebereinstimmung()).
 *
 * Eine erkannte Post-/Aktennummer steht als „id“-Treffer immer vorn.
 * Ohne Embedding (kein Dienst gewählt oder nicht erreichbar) liefert die
 * Suche nur die wörtlichen Treffer und meldet das über `inhaltlichVerfuegbar`.
 *
 * Genutzt von routes/search.js (Web-Suche) und service/chat-agent.js
 * (Assistent und MCP). Filter wirken in jedem Teilweg vor dem LIMIT.
 */
import pool from '../db.js';
import { embedText } from '../lib/embedding.js';
import { loadDynamicSettings } from '../config.js';
import { parseIdQuery, exactCandidates, prefixCandidates } from '../lib/id-query.js';
import { GENERISCHE_SCHWELLEN } from '../lib/embedding-schwellen.js';

/**
 * Übereinstimmung G (0–1) eines Treffers aus Wortwert W und Inhaltswert I,
 * „gestütztes ODER“: G = 1 − (1 − W·s)(1 − I) mit s = α + (1 − α)·I.
 * Ein Wort zählt so nur zur Hälfte, solange der Inhalt nicht passt; ein
 * exakter Wortlaut-Treffer, der inhaltlich nichts mit der Anfrage zu tun hat,
 * erreicht deshalb nicht 100 %. Die ganze Eingabe als Zeichenfolge (Phrase,
 * etwa ein Aktenzeichen) stützt sich selbst (s = 1). Ohne Inhaltswert (kein
 * Embedding) ist G = W. Messung und Begründung: internaldocs/ENTSCHEIDUNGEN.md.
 */
export const STUETZE_ALPHA = 0.5;
export function uebereinstimmung(W, I, { phrase = false } = {}) {
  const w = Math.max(0, Math.min(1, Number(W) || 0));
  if (I == null) return w;
  const i = Math.max(0, Math.min(1, Number(I) || 0));
  const s = phrase ? 1 : STUETZE_ALPHA + (1 - STUETZE_ALPHA) * i;
  return 1 - (1 - w * s) * (1 - i);
}

/**
 * Inhaltswert I (0–1) aus der Kosinus-Ähnlichkeit: 0 an der Unsinnsschwelle
 * des Modells, 1 ab der 100-%-Marke. Beide kommen aus der kuratierten Liste
 * oder, für unbekannte Modelle, aus den generischen Startwerten.
 */
export function inhaltswert(aehnlichkeit, { unsinn, voll }) {
  if (aehnlichkeit == null) return null;
  return Math.max(0, Math.min(1, (Number(aehnlichkeit) - unsinn) / (voll - unsinn)));
}

/** Höchstzahl der Treffer der ersten Stufe und je Seite. */
export const MAX_TREFFER = 50;
/** Kandidaten je Weg (wörtlich, inhaltlich), aus denen die Übereinstimmung sortiert. */
export const MAX_KANDIDATEN = 500;
/**
 * Stufe 1 (eigentliche Ergebnisliste): G ≥ max(STUFE1_MIN, STUFE1_RELATIV × bestes G).
 * Stufe 2 (Nachladen, „Weniger passende Treffer“): G ≥ STUFE2_MIN.
 * Gemessen 2026-11-20 über vier Modelle mit kuratierten Schwellen (beste
 * F1 der ersten Stufe; Unsinnsanfragen bleiben in beiden Stufen leer).
 */
export const STUFE1_MIN = 0.3;
export const STUFE1_RELATIV = 0.5;
export const STUFE2_MIN = 0.1;

const MAX_EINGABE = 500;
const MAX_TOKENS = 12;

const DOK_FELDER = `p.postid, p.briefdatum, p.kontakt, p.dokumentart AS art, p.lebensbereich, p.dokumentart,
       p.betreff, p.zusammenfassung, p.status::text AS status, p.schlagwoerter, p.historisch,
       p.familienmitglied, p.richtung::text AS richtung,
       COALESCE(a.gesamtbetrag, h.gesamtbetrag, g.gesamtbetrag, e.erstattungsbetrag) AS betrag`;
const DOK_JOINS = `LEFT JOIN postbuch.arztrechnung a ON a.postid = p.postid
       LEFT JOIN postbuch.handwerkerrechnung h ON h.postid = p.postid
       LEFT JOIN postbuch.generische_rechnung g ON g.postid = p.postid
       LEFT JOIN postbuch.erstattungsbescheid e ON e.postid = p.postid`;
// Gespeicherte Suchspalten mit Index (base_schema.sql, Abschnitt „Wortsuche“):
// kleingeschriebener Suchtext für Wortteile, tsvector für Wortstämme.
const DOK_SUCHE = { text: 'p.suchtext', vektor: 'p.suchvektor' };

const AKTE_FELDER = `a.akteid, a.betreff, a.beschreibung, a.schlagwoerter, a.historisch,
       a.created_at, a.updated_at,
       (SELECT COUNT(*)::int FROM postbuch.akte_dokument ad WHERE ad.akteid = a.akteid) AS dok_count`;
const AKTE_SUCHE = { text: 'a.suchtext', vektor: 'a.suchvektor' };

// ── Eingabe aufbereiten ──────────────────────────────────────────────────────

function escapeLike(s) {
  return s.replace(/[\\%_]/g, '\\$&');
}

/**
 * Zerlegt die Eingabe in Suchwörter. Nur Buchstaben und Ziffern gelangen in
 * die Volltextsuche; Syntax der tsquery-Sprache kann so nicht entstehen.
 */
export function zerlegeAnfrage(q) {
  const text = String(q ?? '').trim().slice(0, MAX_EINGABE);
  const gesehen = new Set();
  const tokens = [];
  for (const m of text.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    const t = m[0];
    if (t.length < 2 || t.length > 40 || gesehen.has(t)) continue;
    gesehen.add(t);
    tokens.push(t);
    if (tokens.length >= MAX_TOKENS) break;
  }
  // Ganze Eingabe als Zeichenfolge, z. B. „AZ 12/345-b“ – nur bei mehr als einem
  // Wort sinnvoll, ein Einzelwort deckt der Tokenabgleich schon ab.
  const phrase = text.length >= 4 && text.length <= 100 && /[\s\p{P}]/u.test(text)
    ? `%${escapeLike(text.toLowerCase())}%` : null;
  return { text, tokens, phrase };
}

/**
 * Trefferbedingung für ein (kleingeschriebenes) Suchwort: Wortstamm oder (ab
 * drei Zeichen) Wortteil. Beide Teile nutzen einen Index.
 */
function wortBedingung({ text, vektor }, t, params) {
  params.push(t);
  let bedingung = `${vektor} @@ plainto_tsquery('german', $${params.length})`;
  // Deutsche Komposita wie „Hausratversicherung“ findet die Volltextsuche allein nicht.
  if (t.length >= 3) {
    params.push(`%${escapeLike(t)}%`);
    bedingung += ` OR ${text} LIKE $${params.length}`;
  }
  return `(${bedingung})`;
}

/**
 * Trennschärfe der Suchwörter: Gewicht = ln(1 + N/df)², df = Zahl der Einträge,
 * in denen das Wort (nach derselben Regel wie die Suche) vorkommt. Gezählt wird
 * über Dokumente und Akten gemeinsam (N = beide zusammen): So bewerten beide
 * Suchen ein Wort gleich, und ein kleiner Aktenbestand allein wäre eine zu
 * schmale Grundlage. Ein seltenes
 * Wort wie „Zahnarzt“ zählt so ein Vielfaches eines Allerweltsworts wie
 * „Rechnung“. Stoppwörter wiegen 0. Wörter, die nirgends vorkommen (etwa
 * Tippfehler oder Unsinn), haben kein Gewicht, drücken den Anteil aber
 * anteilig: Von n zählbaren Suchwörtern kommen m nirgends vor → höchstens
 * (n − m)/n (siehe moeglichesGewicht). Die Häufigkeiten bleiben
 * ZWISCHENSPEICHER_MS lang gemerkt.
 */
export function wortGewicht({ zaehlbar, df, n }) {
  return zaehlbar && df > 0 && n > 0 ? Math.log(1 + n / df) ** 2 : 0;
}

const ZWISCHENSPEICHER_MS = 10 * 60 * 1000;
const dfCache = new Map();

async function wortGewichte(tokens) {
  const jetzt = Date.now();
  const fehlend = tokens.filter((t) => !(dfCache.get(t)?.bis > jetzt));
  if (fehlend.length) {
    const params = [];
    const spalten = fehlend.map((t, i) => {
      params.push(t);
      const zaehlbar = `numnode(plainto_tsquery('german', $${params.length})) > 0`;
      const bedDok = wortBedingung(DOK_SUCHE, t, params);
      const bedAkte = wortBedingung(AKTE_SUCHE, t, params);
      // Stoppwörter nicht zählen: Ihr Wortteilabgleich träfe fast jede Zeile.
      return `${zaehlbar} AS z${i},
              (CASE WHEN ${zaehlbar}
                 THEN (SELECT count(*) FROM postbuch.postbuch p WHERE ${bedDok})
                    + (SELECT count(*) FROM postbuch.akte a WHERE ${bedAkte})
                 ELSE 0 END)::int AS df${i}`;
    });
    const r = (await pool.query(`SELECT ((SELECT count(*) FROM postbuch.postbuch)
      + (SELECT count(*) FROM postbuch.akte))::int AS n, ${spalten.join(', ')}`, params)).rows[0];
    if (dfCache.size > 2000) dfCache.clear();
    fehlend.forEach((t, i) => dfCache.set(t, {
      wert: { zaehlbar: r[`z${i}`], df: r[`df${i}`], n: r.n }, bis: jetzt + ZWISCHENSPEICHER_MS,
    }));
  }
  const werte = tokens.map((t) => dfCache.get(t).wert);
  const gewichte = werte.map(wortGewicht);
  gewichte.zaehlbar = werte.filter((w) => w.zaehlbar).length;
  gewichte.bekannt = werte.filter((w) => w.zaehlbar && w.df > 0).length;
  return gewichte;
}

/**
 * Nenner des gewichteten Anteils: Summe der Gewichte der vorkommenden Wörter,
 * hochgerechnet um die Wörter, die im Bestand nirgends vorkommen. Bei drei
 * Suchwörtern, von denen zwei unbekannt sind, erreicht ein Treffer so höchstens
 * ein Drittel.
 */
export function moeglichesGewicht(gewichte) {
  const summe = (gewichte || []).reduce((s, w) => s + (w > 0 ? w : 0), 0);
  const { zaehlbar, bekannt } = gewichte || {};
  return summe > 0 && bekannt > 0 && zaehlbar > bekannt ? summe * (zaehlbar / bekannt) : summe;
}

/**
 * Baut den wörtlichen Bewertungsausdruck: gewicht = Summe der Gewichte der
 * gefundenen Suchwörter (SQL), moeglich = Summe aller Gewichte (Zahl),
 * trefferSql = Bedingung „Phrase oder ein gewichtetes Suchwort kommt vor“
 * (null, wenn nichts davon zählt). trefferSql verwendet dieselben Parameter
 * wie gewicht und phraseSql und kann so über die Indizes filtern.
 */
function woertlichAusdruck(suche, tokens, gewichte, phrase, params, { mitRang = true } = {}) {
  const teile = [];
  const bedingungen = [];
  let summe = 0;
  tokens.forEach((t, i) => {
    const w = gewichte?.[i] ?? 0;
    if (!(w > 0)) return;
    summe += w;
    const bed = wortBedingung(suche, t, params);
    bedingungen.push(bed);
    teile.push(`${w.toFixed(6)} * ${bed}::int`);
  });
  const gewicht = teile.length ? teile.join(' + ') : '0';
  const moeglich = (summe > 0 ? moeglichesGewicht(gewichte) : 0).toFixed(6);
  let phraseSql = 'false';
  if (phrase) {
    params.push(phrase);
    phraseSql = `${suche.text} LIKE $${params.length}`;
    bedingungen.unshift(`(${phraseSql})`);
  }
  const trefferSql = bedingungen.length ? bedingungen.join(' OR ') : null;
  let rangSql = '0';
  if (tokens.length && mitRang) {
    params.push(tokens.join(' '));
    rangSql = `ts_rank(${suche.vektor},
      (SELECT COALESCE(string_agg(plainto_tsquery('german', w)::text, ' | '), '')::tsquery
         FROM unnest(string_to_array($${params.length}, ' ')) w
        WHERE numnode(plainto_tsquery('german', w)) > 0))`;
  }
  return { gewicht, moeglich, phraseSql, rangSql, trefferSql };
}

/** Sortierschlüssel der wörtlichen Kandidaten; Konstanten erlaubt ORDER BY nicht. */
function rangfolge(...ausdruecke) {
  return ausdruecke.filter((s) => !['false', '0'].includes(s)).map((s) => `${s} DESC, `).join('');
}

/**
 * Gewichteter Anteil der gefundenen Suchwörter (0–1) für die Anzeige; die ganze
 * Eingabe als Zeichenfolge zählt als vollständig. null, wenn die Anfrage kein
 * zählbares Suchwort hat (etwa nur Stoppwörter, unbekannte Wörter oder eine Nummer).
 */
export function anteilWoertlich({ phrase, gewicht, moeglich }) {
  if (phrase) return 1;
  const m = Number(moeglich);
  return m > 0 ? Math.min(Number(gewicht) / m, 1) : null;
}

/**
 * Wort- und Inhaltswert aller Kandidaten, unabhängig davon, über welchen Weg
 * sie kamen: Anteil der gefundenen Suchwörter, Phrasentreffer und
 * Kosinus-Ähnlichkeit zur Anfrage (nur bei passender Signatur).
 */
async function trefferWerte({ tabelle, alias, schluessel, suche, ids, anfrage, emb }) {
  const params = [ids];
  const { gewicht, moeglich, phraseSql } = woertlichAusdruck(
    suche, anfrage.tokens, anfrage.gewichte, anfrage.phrase, params, { mitRang: false });
  let aehnlichSql = 'NULL::float8';
  if (emb) {
    params.push(emb.literal, emb.signature);
    aehnlichSql = `CASE WHEN ${alias}.embedding_signature = $${params.length}
      THEN 1 - (${alias}.embedding <=> $${params.length - 1}::postbuch.halfvec) END`;
  }
  const r = await pool.query(`
    SELECT ${alias}.${schluessel} AS id, ${phraseSql} AS phrase, ${gewicht} AS gewicht,
           ${moeglich} AS moeglich, ${aehnlichSql} AS aehnlichkeit
      FROM ${tabelle} ${alias}
     WHERE ${alias}.${schluessel} = ANY($1)`, params);
  return new Map(r.rows.map((row) => [row.id, {
    phrase: !!row.phrase,
    anteilWoertlich: anteilWoertlich(row),
    aehnlichkeit: row.aehnlichkeit == null ? null : Number(row.aehnlichkeit),
  }]));
}

// Kurzzeit-Zwischenspeicher für Anfrage-Embeddings: Nachladen und die parallele
// Dokument- und Aktensuche stellen dieselbe Anfrage mehrfach. Schlüssel ist der
// Text samt Modellwahl; ein Modellwechsel trifft damit nie einen alten Vektor.
const EMB_CACHE_MAX = 100;
const embCache = new Map();

async function anfrageEmbedding(text, opts) {
  const schluessel = `${JSON.stringify(opts.settings?.llm_embedding ?? null)}\u0000${text}`;
  const jetzt = Date.now();
  const vorhanden = embCache.get(schluessel);
  if (vorhanden && vorhanden.bis > jetzt) return vorhanden.wert;
  const wert = (async () => {
    try {
      return await embedText(text, opts.settings ?? null, {
        username: opts.username ?? null,
        kategorie: opts.logKategorie ?? 'search',
        rolle: 'anfrage',
      });
    } catch (err) {
      console.warn('[suche] Embedding nicht verfügbar:', err.message);
      return null;
    }
  })();
  embCache.set(schluessel, { wert, bis: jetzt + ZWISCHENSPEICHER_MS });
  if (embCache.size > EMB_CACHE_MAX) embCache.delete(embCache.keys().next().value);
  const emb = await wert;
  // Fehlschläge nicht merken, sonst bleibt die Suche nach einer Störung wörtlich.
  if (!emb) embCache.delete(schluessel);
  return emb;
}

// ── Dokumente ────────────────────────────────────────────────────────────────

/**
 * Filter für Dokumente; hängt Werte an params an.
 * lesebereich: { kurzname } beschränkt auf eigene Dokumente (Web-Suche eines
 * eingeschränkten Lesezugriffs), null = ganzer Bestand.
 */
function dokFilter(opts, params) {
  const teile = [];
  if (!opts.historisch) teile.push('p.historisch = false');
  if (opts.art) { params.push(`%${escapeLike(String(opts.art))}%`); teile.push(`p.dokumentart ILIKE $${params.length}`); }
  if (opts.datumVon) { params.push(opts.datumVon); teile.push(`p.briefdatum >= $${params.length}`); }
  if (opts.datumBis) { params.push(opts.datumBis); teile.push(`p.briefdatum <= $${params.length}`); }
  if (opts.lesebereich) { params.push(opts.lesebereich.kurzname); teile.push(`p.familienmitglied = $${params.length}`); }
  return teile.length ? `AND ${teile.join(' AND ')}` : '';
}

async function dokIdTreffer(idq, opts) {
  const exacts = exactCandidates(idq, 'P');
  const prefixes = prefixCandidates(idq, 'P').map((p) => p + '%');
  if (!exacts.length && !prefixes.length) return [];
  const params = [exacts, prefixes];
  // historisch bewusst ignoriert: Wer eine Nummer eintippt, will genau dieses Objekt.
  const filter = dokFilter({ ...opts, historisch: true }, params);
  const r = await pool.query(`
    SELECT p.postid, (p.postid = ANY($1)) AS exact
      FROM postbuch.postbuch p
     WHERE (p.postid = ANY($1) OR p.postid LIKE ANY($2)) ${filter}
     ORDER BY (p.postid = ANY($1)) DESC, p.postid
     LIMIT ${MAX_TREFFER}`, params);
  return r.rows;
}

async function dokWoertlich(anfrage, opts, max = MAX_KANDIDATEN) {
  if (!anfrage.tokens.length && !anfrage.phrase) return [];
  const params = [];
  const { gewicht, phraseSql, rangSql, trefferSql } = woertlichAusdruck(
    DOK_SUCHE, anfrage.tokens, anfrage.gewichte, anfrage.phrase, params);
  if (!trefferSql) return [];
  const filter = dokFilter(opts, params);
  const r = await pool.query(`
    SELECT p.postid
      FROM postbuch.postbuch p
     WHERE (${trefferSql}) ${filter}
     ORDER BY ${rangfolge(phraseSql, gewicht, rangSql)} p.briefdatum DESC NULLS LAST
     LIMIT ${max}`, params);
  return r.rows.map((row) => row.postid);
}

async function dokInhaltlich(emb, opts, max = MAX_KANDIDATEN) {
  const params = [emb.literal, emb.signature];
  const filter = dokFilter(opts, params);
  const r = await pool.query(`
    SELECT p.postid, 1 - (p.embedding <=> $1::postbuch.halfvec) AS similarity
      FROM postbuch.postbuch p
     WHERE p.embedding IS NOT NULL AND p.embedding_signature = $2 ${filter}
     ORDER BY p.embedding <=> $1::postbuch.halfvec
     LIMIT ${max}`, params);
  return r.rows;
}

/**
 * Hybride Dokumentsuche.
 * @param {string} q
 * @param {object} opts
 * @param {boolean} [opts.historisch=false]  archivierte Dokumente einschließen
 * @param {string}  [opts.art]               Dokumentart (Teilwort)
 * @param {string}  [opts.datumVon]          Briefdatum ab (YYYY-MM-DD)
 * @param {string}  [opts.datumBis]          Briefdatum bis (YYYY-MM-DD)
 * @param {{kurzname:string}|null} [opts.lesebereich]  nur eigene Dokumente
 * @param {number}  [opts.limit=50]
 * @param {object}  [opts.settings]  geladene Settings (spart einen DB-Zugriff)
 * @param {string}  [opts.username]  für llm_call_log
 * @param {string}  [opts.logKategorie='search']
 * @returns {Promise<{treffer: object[], gesamt: number, inhaltlichVerfuegbar: boolean}>}
 *   treffer: Dokumentzeilen plus quelle ('id'|'woertlich'|'inhaltlich'|'beide'),
 *   score und uebereinstimmung (0–1; bei Nummern 1 oder null), stufe (1|2),
 *   similarity (Kosinus bei inhaltlichem Treffer, sonst null), exact (nur bei id),
 *   anteilWoertlich (Anteil der gefundenen Suchwörter, 0–1, oder null) und
 *   aehnlichkeit (Kosinus zur Anfrage oder null) – beide für jeden Treffer.
 */
export async function sucheDokumente(q, opts = {}) {
  if (!opts.settings) opts = { ...opts, settings: await loadDynamicSettings() };
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || MAX_TREFFER, 1), MAX_TREFFER);
  const anfrage = zerlegeAnfrage(q);
  const idq = parseIdQuery(anfrage.text);
  anfrage.gewichte = await wortGewichte(anfrage.tokens);

  // Eine Nummer hat keine inhaltliche Bedeutung – kein Embedding-Aufruf.
  const [idRows, woertlich, emb] = await Promise.all([
    idq ? dokIdTreffer(idq, opts) : [],
    dokWoertlich(anfrage, opts),
    idq || !anfrage.text ? null : anfrageEmbedding(anfrage.text, opts),
  ]);
  const inhaltlich = emb ? await dokInhaltlich(emb, opts) : [];

  return fuehreZusammen({
    idRows: idRows.map((r) => ({ id: r.postid, exact: r.exact })),
    woertlich,
    inhaltlich: inhaltlich.map((r) => r.postid),
    limit,
    offset: opts.weitere ? opts.offset : 0,
    weitere: !!opts.weitere,
    inhaltlichVerfuegbar: !!emb || !!idq,
    skala: emb ? inhaltSkala(opts.settings) : null,
    lade: async (ids) => (await pool.query(`
      SELECT ${DOK_FELDER} FROM postbuch.postbuch p ${DOK_JOINS}
       WHERE p.postid = ANY($1)`, [ids])).rows,
    werte: (ids) => trefferWerte({
      tabelle: 'postbuch.postbuch', alias: 'p', schluessel: 'postid', suche: DOK_SUCHE, ids, anfrage, emb,
    }),
    schluessel: 'postid',
  });
}

// ── Akten ────────────────────────────────────────────────────────────────────

function akteFilter(opts) {
  return opts.historisch ? '' : 'AND a.historisch = false';
}

async function akteIdTreffer(idq) {
  const exacts = exactCandidates(idq, 'A');
  const prefixes = prefixCandidates(idq, 'A').map((p) => p + '%');
  if (!exacts.length && !prefixes.length) return [];
  const r = await pool.query(`
    SELECT a.akteid, (a.akteid = ANY($1)) AS exact
      FROM postbuch.akte a
     WHERE a.akteid = ANY($1) OR a.akteid LIKE ANY($2)
     ORDER BY (a.akteid = ANY($1)) DESC, a.akteid
     LIMIT ${MAX_TREFFER}`, [exacts, prefixes]);
  return r.rows;
}

async function akteWoertlich(anfrage, opts, max = MAX_KANDIDATEN) {
  if (!anfrage.tokens.length && !anfrage.phrase) return [];
  const params = [];
  const { gewicht, phraseSql, rangSql, trefferSql } = woertlichAusdruck(
    AKTE_SUCHE, anfrage.tokens, anfrage.gewichte, anfrage.phrase, params);
  if (!trefferSql) return [];
  const r = await pool.query(`
    SELECT a.akteid
      FROM postbuch.akte a
     WHERE (${trefferSql}) ${akteFilter(opts)}
     ORDER BY ${rangfolge(phraseSql, gewicht, rangSql)} a.updated_at DESC NULLS LAST
     LIMIT ${max}`, params);
  return r.rows.map((row) => row.akteid);
}

async function akteInhaltlich(emb, opts, max = MAX_KANDIDATEN) {
  const r = await pool.query(`
    SELECT a.akteid, 1 - (a.embedding <=> $1::postbuch.halfvec) AS similarity
      FROM postbuch.akte a
     WHERE a.embedding IS NOT NULL AND a.embedding_signature = $2 ${akteFilter(opts)}
     ORDER BY a.embedding <=> $1::postbuch.halfvec
     LIMIT ${max}`, [emb.literal, emb.signature]);
  return r.rows;
}

/**
 * Hybride Aktensuche. Akten kennen keinen eingeschränkten Lesebereich: Wer nur
 * eigene Dokumente sieht, erreicht die Aktensuche nicht (lesebereichGate).
 * Optionen wie sucheDokumente, ohne art/datum/lesebereich.
 */
export async function sucheAkten(q, opts = {}) {
  if (!opts.settings) opts = { ...opts, settings: await loadDynamicSettings() };
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || MAX_TREFFER, 1), MAX_TREFFER);
  const anfrage = zerlegeAnfrage(q);
  const idq = parseIdQuery(anfrage.text);
  anfrage.gewichte = await wortGewichte(anfrage.tokens);

  const [idRows, woertlich, emb] = await Promise.all([
    idq ? akteIdTreffer(idq) : [],
    akteWoertlich(anfrage, opts),
    idq || !anfrage.text ? null : anfrageEmbedding(anfrage.text, opts),
  ]);
  const inhaltlich = emb ? await akteInhaltlich(emb, opts) : [];

  return fuehreZusammen({
    idRows: idRows.map((r) => ({ id: r.akteid, exact: r.exact })),
    woertlich,
    inhaltlich: inhaltlich.map((r) => r.akteid),
    limit,
    offset: opts.weitere ? opts.offset : 0,
    weitere: !!opts.weitere,
    inhaltlichVerfuegbar: !!emb || !!idq,
    skala: emb ? inhaltSkala(opts.settings) : null,
    lade: async (ids) => (await pool.query(`
      SELECT ${AKTE_FELDER} FROM postbuch.akte a WHERE a.akteid = ANY($1)`, [ids])).rows,
    werte: (ids) => trefferWerte({
      tabelle: 'postbuch.akte', alias: 'a', schluessel: 'akteid', suche: AKTE_SUCHE, ids, anfrage, emb,
    }),
    schluessel: 'akteid',
  });
}

/**
 * Skala des Inhaltswerts: Unsinnsschwelle (0 %) und 100-%-Marke als Kosinus.
 * Beide setzt ein Modellwechsel aus der kuratierten Liste oder als generische
 * Startwerte (lib/embedding-schwellen.js). Fehlen sie oder passen sie nicht
 * zueinander, gelten die generischen Startwerte.
 */
export function inhaltSkala(settings) {
  const u = Number(settings?.embedding_unsinnsschwelle);
  const v = Number(settings?.embedding_aehnlichkeit_voll);
  const gesetzt = settings?.embedding_unsinnsschwelle != null && settings?.embedding_aehnlichkeit_voll != null;
  if (gesetzt && Number.isFinite(u) && Number.isFinite(v) && u >= 0 && v > u && v <= 1) return { unsinn: u, voll: v };
  return { unsinn: GENERISCHE_SCHWELLEN.unsinnMax, voll: GENERISCHE_SCHWELLEN.voll };
}

// ── Zusammenführung ──────────────────────────────────────────────────────────

/**
 * Reihenfolge aller Treffer nach Übereinstimmung. Nummern-Treffer stehen vorn.
 * Stufe 1 ist die eigentliche Ergebnisliste (höchstens MAX_TREFFER), mit
 * weitere=true folgen in Stufe 2 die übrigen Kandidaten bis STUFE2_MIN; Stufe 1
 * ändert sich dadurch nicht. Gleichstand: Rang der wörtlichen Suche
 * (Gewicht, Volltextrang, Datum), dann Ähnlichkeit.
 *
 * @param {object}   p
 * @param {object[]} p.idRows      [{ id, exact }]
 * @param {string[]} p.woertlich   IDs der wörtlichen Kandidaten in Rangfolge
 * @param {string[]} p.inhaltlich  IDs der inhaltlichen Kandidaten
 * @param {Map}      p.werte       id → { anteilWoertlich, phrase, aehnlichkeit }
 * @param {object|null} p.skala    { unsinn, voll } oder null ohne Embedding
 */
export function ordneTreffer({ idRows, woertlich, inhaltlich, werte, skala = null, weitere = false }) {
  const idSet = new Set(idRows.map((r) => r.id));
  const wortRang = new Map(woertlich.map((id, i) => [id, i]));
  const kandidaten = [];
  for (const id of new Set([...woertlich, ...inhaltlich])) {
    if (idSet.has(id)) continue;
    const w = werte.get(id) || {};
    const I = skala ? inhaltswert(w.aehnlichkeit, skala) ?? 0 : null;
    const G = uebereinstimmung(w.anteilWoertlich ?? 0, I, { phrase: w.phrase });
    kandidaten.push({ id, G, I, rang: wortRang.get(id) ?? Infinity, sim: w.aehnlichkeit ?? -1 });
  }
  kandidaten.sort((a, b) => b.G - a.G || a.rang - b.rang || b.sim - a.sim);
  const bester = kandidaten[0]?.G ?? 0;
  const grenze1 = Math.max(STUFE1_MIN, STUFE1_RELATIV * bester);
  const reihenfolge = idRows.map((r) => ({ id: r.id, score: r.exact ? 1 : null, stufe: 1, inhalt: null }));
  let inStufe1 = 0;
  for (const k of kandidaten) {
    const stufe = k.G >= grenze1 && inStufe1 < MAX_TREFFER ? 1 : 2;
    if (stufe === 1) inStufe1++;
    else if (!weitere || k.G < STUFE2_MIN) continue;
    reihenfolge.push({ id: k.id, score: k.G, stufe, inhalt: k.I });
  }
  // Stufe 2 hinter Stufe 1 (über MAX_TREFFER hinausfallende Treffer rutschen nach hinten).
  reihenfolge.sort((a, b) => a.stufe - b.stufe);
  return { reihenfolge };
}

async function fuehreZusammen({ idRows, woertlich, inhaltlich, limit, offset = 0, weitere = false, inhaltlichVerfuegbar, skala, lade, werte, schluessel }) {
  const alle = [...new Set([...woertlich, ...inhaltlich, ...idRows.map((r) => r.id)])];
  const wertJeId = alle.length ? await werte(alle) : new Map();
  const { reihenfolge } = ordneTreffer({ idRows, woertlich, inhaltlich, werte: wertJeId, skala, weitere });
  const idSet = new Set(idRows.map((r) => r.id));
  const exact = new Map(idRows.map((r) => [r.id, r.exact]));

  const gesamt = reihenfolge.length;
  const start = Math.max(0, parseInt(offset, 10) || 0);
  const auswahl = reihenfolge.slice(start, start + limit);
  const kopf = {
    gesamt, inhaltlichVerfuegbar,
    unsinnsschwelle: skala?.unsinn ?? null,
    aehnlichkeitVoll: skala?.voll ?? null,
  };
  if (!auswahl.length) return { treffer: [], ...kopf };

  const zeilen = new Map((await lade(auswahl.map((t) => t.id))).map((z) => [z[schluessel], z]));
  const treffer = auswahl
    .filter((t) => zeilen.has(t.id))
    .map(({ id, score, stufe, inhalt }) => {
      const w = wertJeId.get(id) || {};
      const woertlichTreffer = (w.anteilWoertlich ?? 0) > 0 || w.phrase;
      const inhaltlichTreffer = inhalt > 0;
      const quelle = idSet.has(id) ? 'id'
        : woertlichTreffer && inhaltlichTreffer ? 'beide'
          : woertlichTreffer ? 'woertlich' : 'inhaltlich';
      return {
        ...zeilen.get(id),
        quelle,
        score,
        uebereinstimmung: score,
        stufe,
        similarity: inhaltlichTreffer ? w.aehnlichkeit : (idSet.has(id) ? (exact.get(id) ? 1 : 0.5) : null),
        anteilWoertlich: w.anteilWoertlich ?? null,
        aehnlichkeit: w.aehnlichkeit ?? null,
        ...(idSet.has(id) ? { exact: exact.get(id) } : {}),
      };
    });
  return { treffer, ...kopf };
}
