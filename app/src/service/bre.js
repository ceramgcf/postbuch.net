/**
 * service/bre.js — Beitragsrückerstattung (BRE) überwachen.
 *
 * Für Menschen mit PKV und eingeschalteter Überwachung hält der
 * Abrechnungsassistent Arztrechnungen je Behandlungsjahr zurück, solange sich
 * das Einreichen nicht lohnt. Zurückgehaltene Rechnungen liegen in einer
 * eigenen PKV-Periode im Status WITHHELD (ZURÜCKGEHALTEN) mit `bre_jahr` und
 * der beim Anlegen gespeicherten Schwelle `bre_schwelle`.
 *
 * Begriffe:
 *   - BRE-relevant: Rechnung in einer PKV-Periode, nicht `bre_unbeachtlich`.
 *   - Behandlungsjahre: SQL-Funktion postbuch.arz_behandlungsjahre(); ohne
 *     Positionsdaten das Jahr des Rechnungsdatums („geschätzt“).
 *   - Verwirkt: mindestens eine BRE-relevante Rechnung dieses Jahres liegt in
 *     einer eingereichten oder abgeschlossenen PKV-Periode. Wird nie
 *     gespeichert, sondern immer abgeleitet.
 *   - E: erwartete PKV-Erstattung, gleiche Formel wie die Periodenübersicht
 *     (lib/erstattung-sql.js), mit dem Satz der Periode, in der die Rechnung
 *     gerade liegt.
 *
 * `bewerteKombinationen()` ist eine reine Funktion ohne Datenbank. Alles, was
 * liest, bekommt einen Client bzw. nutzt den Pool und schreibt nichts – außer
 * `verschiebeUnbeachtlichAusWithheld()`, das in der Transaktion des Aufrufers
 * läuft.
 */

import pool from '../db.js';
import { erwarteteErstattungSql } from '../lib/erstattung-sql.js';
import { sperrePerioden } from './perioden-sperre.js';
import { throwIfSessionLocked } from './abrechnungsperiode.js';
import { appLog } from '../app-log.js';

/** Obergrenze der Entscheidungsjahre; 2^10 Kombinationen sind noch harmlos. */
export const MAX_ENTSCHEIDUNGSJAHRE = 10;

const ERSTATTUNG_PKV = erwarteteErstattungSql('PKV', { rechnung: 'a', periode: 'ab', person: 'm' });

function runde2(x) {
  return Math.round((Number(x) || 0) * 100) / 100;
}

/** Schwelle aus den Einstellungen der Person: BRE × (1 − Abschlag/100). */
export function berechneSchwelle(breBetrag, breAbschlag) {
  if (breBetrag == null || breBetrag === '') return null;
  const betrag = Number(breBetrag);
  if (!Number.isFinite(betrag)) return null;
  const abschlag = breAbschlag == null || breAbschlag === '' ? 0 : Number(breAbschlag);
  return runde2(betrag * (1 - (Number.isFinite(abschlag) ? abschlag : 0) / 100));
}

// ── Lage laden ───────────────────────────────────────────────────────────────

/**
 * Lädt alles, was die Entscheidung für eine Person braucht.
 *
 * @param {import('pg').PoolClient|import('pg').Pool} db
 * @param {string} person  Kurzname
 * @param {{sammelPeriode?: number|null}} [optionen]  PKV-Sammelperiode, deren
 *   Rechnungen Kandidaten sind; `undefined` = höchste COLLECTING-Periode,
 *   `null` = keine.
 * @returns {Promise<object|null>} null, wenn die Person nicht BRE-relevant ist
 *   (nicht überwacht und keine zurückhaltende Periode).
 */
export async function ladeBreLage(db, person, { sammelPeriode } = {}) {
  const mRes = await db.query(
    `SELECT kurzname, pkv, ist_tier, pkv_satz, bre_ueberwachen, bre_betrag, bre_abschlag
       FROM postbuch.mensch WHERE kurzname = $1`,
    [person]
  );
  const mensch = mRes.rows[0];
  if (!mensch) return null;

  const wRes = await db.query(
    `SELECT periode, bre_jahr, bre_schwelle
       FROM abrechnungsperiode_buch
      WHERE person = $1 AND kostentraeger = 'PKV' AND status = 'WITHHELD'
      ORDER BY bre_jahr`,
    [person]
  );
  const ueberwachen = !!(mensch.bre_ueberwachen && mensch.pkv && !mensch.ist_tier);
  if (!ueberwachen && wRes.rows.length === 0) return null;

  let sammel = sammelPeriode;
  if (sammel === undefined) {
    const c = await db.query(
      `SELECT periode FROM abrechnungsperiode_buch
        WHERE person = $1 AND kostentraeger = 'PKV' AND status = 'COLLECTING'
        ORDER BY periode DESC LIMIT 1`,
      [person]
    );
    sammel = c.rows[0]?.periode ?? null;
  }

  const vRes = await db.query(
    `SELECT DISTINCT j.jahr
       FROM arztrechnung a
       JOIN abrechnungsperiode_buch ab
         ON ab.person = a.behandelte_person AND ab.kostentraeger = 'PKV'
        AND ab.periode = a.abrechnungsperiode_pkv
       CROSS JOIN LATERAL unnest(postbuch.arz_behandlungsjahre(a.postid)) AS j(jahr)
      WHERE a.behandelte_person = $1 AND NOT a.bre_unbeachtlich
        AND ab.status IN ('SUBMITTED', 'COMPLETED')`,
    [person]
  );

  const withheldPerioden = wRes.rows.map((r) => r.periode);
  const kRes = await db.query(
    `SELECT a.postid, a.abrechnungsperiode_pkv AS periode, ab.status, ab.bre_jahr,
            a.bre_unbeachtlich, a.gesamtbetrag,
            postbuch.arz_behandlungsjahre(a.postid) AS jahre,
            NOT EXISTS (SELECT 1 FROM arztrechnung_einzelposition e
                         WHERE e.postid = a.postid AND e.behandlungs_datum IS NOT NULL)
              AND a.rechnungsdatum IS NOT NULL AS jahr_geschaetzt,
            ${ERSTATTUNG_PKV} AS erstattung
       FROM arztrechnung a
       JOIN abrechnungsperiode_buch ab
         ON ab.person = a.behandelte_person AND ab.kostentraeger = 'PKV'
        AND ab.periode = a.abrechnungsperiode_pkv
       LEFT JOIN postbuch.mensch m ON m.kurzname = a.behandelte_person
      WHERE a.behandelte_person = $1
        AND COALESCE(a.bestritten_betrag, 0) <= 0
        AND (a.abrechnungsperiode_pkv = ANY($2::int[]) OR a.abrechnungsperiode_pkv = $3)
      ORDER BY a.postid`,
    [person, withheldPerioden, sammel]
  );

  return {
    person,
    ueberwachen,
    sammelPeriode: sammel,
    schwelleAktuell: berechneSchwelle(mensch.bre_betrag, mensch.bre_abschlag),
    pkvSatz: mensch.pkv_satz == null ? null : Number(mensch.pkv_satz),
    withheld: wRes.rows.map((r) => ({
      periode: r.periode, jahr: Number(r.bre_jahr), schwelle: Number(r.bre_schwelle),
    })),
    verwirkt: vRes.rows.map((r) => Number(r.jahr)).sort((a, b) => a - b),
    kandidaten: kRes.rows.map((r) => ({
      postid: r.postid,
      periode: r.periode,
      istWithheld: r.status === 'WITHHELD',
      periodeJahr: r.status === 'WITHHELD' ? Number(r.bre_jahr) : null,
      jahre: (r.jahre || []).map(Number),
      jahrGeschaetzt: !!r.jahr_geschaetzt,
      unbeachtlich: !!r.bre_unbeachtlich,
      erstattung: r.erstattung == null ? 0 : runde2(r.erstattung),
      ohneSatz: r.gesamtbetrag != null && r.erstattung == null,
    })),
  };
}

// ── Reine Bewertung ──────────────────────────────────────────────────────────

/**
 * Bewertet alle Teilmengen G der Entscheidungsjahre („BRE aufgeben“).
 *
 * Entscheidungsjahre sind die Jahre aller zurückhaltenden Perioden und – bei
 * eingeschalteter Überwachung – die offenen Jahre der BRE-relevanten
 * Kandidaten. Regeln je Kandidat:
 *   - Kandidat einer zurückhaltenden Periode: einreichbar nur, wenn das Jahr
 *     seiner Periode in G liegt (sonst bleibt er, wo er ist) und – bei
 *     Überwachung und BRE-Relevanz – alle seine offenen Entscheidungsjahre in
 *     G liegen.
 *   - Kandidat der Sammelperiode: nicht relevant oder ohne Überwachung immer
 *     einreichbar; sonst nur, wenn alle seine offenen Entscheidungsjahre in G
 *     liegen.
 *   - Nicht einreichbar → zurückhalten im spätesten offenen, nicht
 *     aufgegebenen Entscheidungsjahr (Kandidaten einer nicht aufgegebenen
 *     zurückhaltenden Periode bleiben in ihrer Periode).
 * Wert(G) = Σ E der Kandidaten, die mit G einreichbar sind, mit der leeren
 * Menge aber nicht, minus Σ Schwellen der Jahre in G. Schwelle eines Jahres
 * ist die gespeicherte Schwelle seiner zurückhaltenden Periode (0, wenn das
 * Jahr inzwischen verwirkt ist), sonst die aktuelle aus den Einstellungen.
 * Vorschlag: höchster Wert, bei Gleichstand weniger Jahre; ohne Überwachung
 * immer die leere Menge.
 *
 * @param {object} lage  Ergebnis von ladeBreLage() (oder gleich aufgebaut)
 * @returns {{entscheidungsjahre:number[], schwellen:Object<string,number>,
 *   kombinationen:Array, vorschlag:number[], ohneJahr:Array, verwirkt:number[]}}
 */
export function bewerteKombinationen(lage) {
  const verwirkt = new Set(lage.verwirkt || []);
  const withheldNachJahr = new Map((lage.withheld || []).map((w) => [w.jahr, w]));
  const ueberwachen = !!lage.ueberwachen;

  const kandidaten = (lage.kandidaten || []).map((k) => {
    const relevant = !k.unbeachtlich && k.jahre.length > 0;
    const offen = relevant ? k.jahre.filter((j) => !verwirkt.has(j)) : [];
    return { ...k, relevant, offen };
  });

  const jahre = new Set(withheldNachJahr.keys());
  if (ueberwachen) {
    for (const k of kandidaten) for (const j of k.offen) jahre.add(j);
  }
  const entscheidungsjahre = [...jahre].sort((a, b) => a - b);
  if (entscheidungsjahre.length > MAX_ENTSCHEIDUNGSJAHRE) {
    const err = new Error(
      `Zu viele offene Behandlungsjahre (${entscheidungsjahre.length}) für die Beitragsrückerstattung. `
      + 'Bitte Rechnungen ohne Bedeutung für die BRE als BRE-unbeachtlich markieren.'
    );
    err.code = 'BRE_ZU_VIELE_JAHRE';
    err.status = 422;
    throw err;
  }

  const schwellen = {};
  for (const j of entscheidungsjahre) {
    const w = withheldNachJahr.get(j);
    if (w) schwellen[j] = verwirkt.has(j) ? 0 : runde2(w.schwelle);
    else schwellen[j] = lage.schwelleAktuell == null ? 0 : runde2(lage.schwelleAktuell);
  }

  /** Entscheidungsjahre unter den offenen Jahren eines Kandidaten. */
  const offeneEntscheidung = (k) => k.offen.filter((j) => jahre.has(j));

  function verteile(G) {
    const einreichbar = [];
    const halten = {};
    for (const k of kandidaten) {
      let ok;
      if (k.istWithheld) {
        if (!G.has(k.periodeJahr)) {
          halten[k.postid] = k.periodeJahr;
          continue;
        }
        ok = !(ueberwachen && k.relevant) || offeneEntscheidung(k).every((j) => G.has(j));
      } else {
        ok = !(ueberwachen && k.relevant) || offeneEntscheidung(k).every((j) => G.has(j));
      }
      if (ok) {
        einreichbar.push(k.postid);
      } else {
        const rest = offeneEntscheidung(k).filter((j) => !G.has(j));
        halten[k.postid] = rest.length > 0 ? Math.max(...rest) : k.periodeJahr;
      }
    }
    return { einreichbar, halten };
  }

  const basis = new Set(verteile(new Set()).einreichbar);
  const nachPostid = new Map(kandidaten.map((k) => [k.postid, k]));

  const kombinationen = [];
  const n = entscheidungsjahre.length;
  for (let maske = 0; maske < (1 << n); maske++) {
    const aufgeben = entscheidungsjahre.filter((_, i) => maske & (1 << i));
    const G = new Set(aufgeben);
    const { einreichbar, halten } = verteile(G);

    let summeZusatz = 0;
    for (const postid of einreichbar) {
      if (!basis.has(postid)) summeZusatz += nachPostid.get(postid).erstattung;
    }
    const summeSchwellen = aufgeben.reduce((s, j) => s + schwellen[j], 0);

    // Folgen je Haltejahr: Inhalt der zurückhaltenden Periode nach dem
    // Bestätigen (Bestand plus neu Zurückgehaltenes).
    const proJahr = new Map();
    for (const [postid, jahr] of Object.entries(halten)) {
      const k = nachPostid.get(postid);
      if (!proJahr.has(jahr)) proJahr.set(jahr, { jahr, anzahl: 0, anzahlNeu: 0, summe: 0 });
      const e = proJahr.get(jahr);
      e.anzahl++;
      if (!(k.istWithheld && k.periodeJahr === jahr)) e.anzahlNeu++;
      e.summe += k.erstattung;
    }
    const haltejahre = [...proJahr.values()]
      .map((e) => ({ ...e, summe: runde2(e.summe), schwelle: schwellen[e.jahr] ?? 0 }))
      .sort((a, b) => a.jahr - b.jahr);

    // Je aufgegebenem Jahr: wie viele bisher zurückgehaltene Rechnungen mitgehen.
    const aufgegeben = aufgeben.map((jahr) => {
      const ids = einreichbar.filter((p) => {
        const k = nachPostid.get(p);
        return k.istWithheld && k.periodeJahr === jahr;
      });
      return {
        jahr,
        schwelle: schwellen[jahr],
        verwirkt: verwirkt.has(jahr),
        anzahlZurueckgehalten: ids.length,
        summeZurueckgehalten: runde2(ids.reduce((s, p) => s + nachPostid.get(p).erstattung, 0)),
      };
    });

    kombinationen.push({
      aufgeben,
      wert: runde2(summeZusatz - summeSchwellen),
      summe: runde2(summeZusatz),
      einreichbar,
      halten,
      neuAnzulegen: haltejahre.map((h) => h.jahr).filter((j) => !withheldNachJahr.has(j)),
      haltejahre,
      aufgegeben,
    });
  }

  let vorschlag = [];
  if (ueberwachen) {
    let best = kombinationen[0];
    for (const k of kombinationen) {
      if (k.wert > best.wert || (k.wert === best.wert && k.aufgeben.length < best.aufgeben.length)) best = k;
    }
    vorschlag = best.aufgeben;
  }

  const ohneJahr = kandidaten
    .filter((k) => !k.unbeachtlich && k.jahre.length === 0)
    .map((k) => ({ postid: k.postid, periode: k.periode, istWithheld: k.istWithheld }));

  return {
    entscheidungsjahre,
    schwellen,
    verwirkt: [...verwirkt].sort((a, b) => a - b),
    kombinationen,
    vorschlag,
    ohneJahr,
  };
}

/** Sucht die Kombination zu einer Jahresmenge (Reihenfolge egal). */
export function findeKombination(bewertung, aufgeben) {
  const soll = [...new Set(aufgeben)].sort((a, b) => a - b).join(',');
  return bewertung.kombinationen.find((k) => k.aufgeben.join(',') === soll) || null;
}

/**
 * Bereinigt eine vom Frontend gewählte Jahresmenge auf gültige
 * Entscheidungsjahre. `undefined`/kein Array → Vorschlag.
 */
export function normalisiereAufgeben(bewertung, gewaehlt) {
  if (!Array.isArray(gewaehlt)) return bewertung.vorschlag;
  const erlaubt = new Set(bewertung.entscheidungsjahre);
  return [...new Set(gewaehlt.map(Number).filter((j) => Number.isInteger(j) && erlaubt.has(j)))]
    .sort((a, b) => a - b);
}

// ── Vorschau und Ring ────────────────────────────────────────────────────────

/**
 * Vorschau für den Abrechnungsassistenten (ohne Sperre, rein lesend).
 * @returns {Promise<object>} `{ relevant: false }` oder die Bewertung samt
 *   Kandidatenliste und Einstellungen.
 */
export async function breVorschau(person) {
  const lage = await ladeBreLage(pool, person);
  if (!lage) return { person, relevant: false };
  const bewertung = bewerteKombinationen(lage);
  return {
    person,
    relevant: true,
    ueberwachen: lage.ueberwachen,
    sammelPeriode: lage.sammelPeriode,
    schwelleAktuell: lage.schwelleAktuell,
    withheld: lage.withheld,
    kandidaten: lage.kandidaten.map((k) => ({
      postid: k.postid, periode: k.periode, istWithheld: k.istWithheld, periodeJahr: k.periodeJahr,
      jahre: k.jahre, jahrGeschaetzt: k.jahrGeschaetzt, unbeachtlich: k.unbeachtlich,
      erstattung: k.erstattung, ohneSatz: k.ohneSatz,
    })),
    ...bewertung,
  };
}

/**
 * Ringdaten je zurückhaltender Periode einer Person.
 *   voll       Σ E der Rechnungen der Periode, deren offene Jahre nur dieses
 *              Jahr sind
 *   schraffiert Σ E mehrjähriger Rechnungen (Sammel- oder zurückhaltende
 *              Periode) mit diesem Jahr unter ihren offenen Jahren
 * @returns {Promise<Array<{periode:number, jahr:number, schwelle:number, voll:number, schraffiert:number}>>}
 */
export async function breRingDaten(person, db = pool) {
  const lage = await ladeBreLage(db, person);
  if (!lage || lage.withheld.length === 0) return [];
  const verwirkt = new Set(lage.verwirkt);
  return lage.withheld.map((w) => {
    let voll = 0;
    let schraffiert = 0;
    for (const k of lage.kandidaten) {
      if (k.unbeachtlich || k.jahre.length === 0) continue;
      const offen = k.jahre.filter((j) => !verwirkt.has(j));
      if (offen.length > 1) {
        if (offen.includes(w.jahr)) schraffiert += k.erstattung;
      } else if (k.periode === w.periode && (offen.length === 0 || offen[0] === w.jahr)) {
        voll += k.erstattung;
      }
    }
    return {
      periode: w.periode, jahr: w.jahr, schwelle: w.schwelle,
      verwirkt: verwirkt.has(w.jahr), voll: runde2(voll), schraffiert: runde2(schraffiert),
    };
  });
}

// ── BRE-unbeachtlich ─────────────────────────────────────────────────────────

/**
 * Setzt `bre_unbeachtlich` einer Arztrechnung. Ohne Statusprüfung (Kulanz der
 * PKV an bereits eingereichten Rechnungen). Liegt die Rechnung in einer
 * zurückhaltenden Periode und wird unbeachtlich, zieht sie sofort samt ihren
 * offenen PKV-Prüfvormerkungen in die aktuelle PKV-Sammelperiode.
 *
 * @returns {Promise<{bre_unbeachtlich:boolean, verschobenNach:number|null}>}
 */
export async function setzeBreUnbeachtlich(postid, unbeachtlich) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const vorab = await client.query(
      `SELECT behandelte_person FROM arztrechnung WHERE postid = $1`, [postid]
    );
    if (vorab.rows.length === 0) throw httpFehler('Arztrechnung nicht gefunden', 404);
    const person = vorab.rows[0].behandelte_person;
    if (person) await sperrePerioden(client, [{ person, kostentraeger: 'PKV' }]);

    const cur = await client.query(
      `SELECT behandelte_person, abrechnungsperiode_pkv FROM arztrechnung WHERE postid = $1 FOR UPDATE`,
      [postid]
    );
    if (cur.rows[0].behandelte_person !== person) {
      throw httpFehler('Die behandelte Person hat sich gerade geändert. Bitte erneut versuchen.', 409);
    }

    let verschobenNach = null;
    if (unbeachtlich) {
      verschobenNach = await verschiebeUnbeachtlichAusWithheld(client, postid);
    }
    await client.query(
      `UPDATE arztrechnung SET bre_unbeachtlich = $2 WHERE postid = $1`,
      [postid, !!unbeachtlich]
    );
    await client.query('COMMIT');
    appLog('INFO', 'abrechnungsperiode',
      `Rechnung ${postid} BRE-${unbeachtlich ? 'unbeachtlich' : 'relevant'}`
      + (verschobenNach != null ? ` – aus ZURÜCKGEHALTEN in Sammelperiode ${verschobenNach} verschoben` : ''),
      { entity: 'postbuch', entityId: postid });
    return { bre_unbeachtlich: !!unbeachtlich, verschobenNach };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Zieht eine Rechnung aus einer zurückhaltenden PKV-Periode in die aktuelle
 * PKV-Sammelperiode ihrer Person, samt offener PKV-Prüfvormerkungen. Läuft in
 * der Transaktion des Aufrufers, der die Periodensperre (PKV) der Person
 * bereits hält. Steckt die zurückhaltende Periode in einer laufenden
 * Abrechnung, wird mit 409 abgelehnt.
 *
 * @returns {Promise<number|null>} Nummer der Sammelperiode oder null, wenn
 *   die Rechnung nicht in einer zurückhaltenden Periode lag.
 */
export async function verschiebeUnbeachtlichAusWithheld(client, postid) {
  const r = await client.query(
    `SELECT a.behandelte_person AS person, a.abrechnungsperiode_pkv AS periode
       FROM arztrechnung a
       JOIN abrechnungsperiode_buch ab
         ON ab.person = a.behandelte_person AND ab.kostentraeger = 'PKV'
        AND ab.periode = a.abrechnungsperiode_pkv
      WHERE a.postid = $1 AND ab.status = 'WITHHELD'`,
    [postid]
  );
  if (r.rows.length === 0) return null;
  const { person, periode } = r.rows[0];

  await client.query(
    `SELECT 1 FROM abrechnungsperiode_buch
      WHERE person = $1 AND kostentraeger = 'PKV' AND periode = $2 FOR UPDATE`,
    [person, periode]
  );
  try {
    await throwIfSessionLocked(client, person, 'PKV', periode);
  } catch (err) {
    err.status = 409;
    throw err;
  }

  const ziel = await client.query(
    `SELECT periode FROM abrechnungsperiode_buch
      WHERE person = $1 AND kostentraeger = 'PKV' AND status = 'COLLECTING'
      ORDER BY periode DESC LIMIT 1 FOR UPDATE`,
    [person]
  );
  if (ziel.rows.length === 0) {
    throw httpFehler('Keine offene PKV-Sammelperiode vorhanden, in die die Rechnung ziehen könnte', 409);
  }
  const neuePeriode = ziel.rows[0].periode;

  await client.query(
    `UPDATE arztrechnung SET abrechnungsperiode_pkv = $2 WHERE postid = $1`,
    [postid, neuePeriode]
  );
  await verschiebePruefvormerkungen(client, person, periode, neuePeriode, [postid]);
  return neuePeriode;
}

/**
 * Hängt offene (VORGEMERKT) PKV-Prüfvormerkungen der genannten Rechnungen von
 * einer Periode in eine andere um. Zuordnung über
 * erstattungsbescheid_kuerzung.arz_postid.
 * @returns {Promise<number>} Anzahl umgehängter Vormerkungen
 */
export async function verschiebePruefvormerkungen(client, person, vonPeriode, nachPeriode, postids) {
  if (!postids || postids.length === 0) return 0;
  const res = await client.query(
    `UPDATE beihilfe_kuerzung_pkv_pruefung b
        SET periode = $3, vorherige_periode = $2
       FROM erstattungsbescheid_kuerzung k
      WHERE k.postid = b.eb_postid AND k.eb_subid = b.eb_subid AND k.kuerzung_id = b.kuerzung_id
        AND b.person = $1 AND b.kostentraeger = 'PKV' AND b.periode = $2
        AND b.status = 'VORGEMERKT'
        AND k.arz_postid = ANY($4::text[])`,
    [person, vonPeriode, nachPeriode, postids]
  );
  return res.rowCount;
}

function httpFehler(message, status) {
  const e = new Error(message);
  e.status = status;
  return e;
}
