/**
 * service/abrechnung-session.js — Abrechnungssession-Lifecycle (gehärtet, schlank)
 *
 * Ersetzt die frühere reine JSONB-Verwaltung (`_abrechnung_sessions.groups`)
 * durch genau EINE zusätzliche relationale Tabelle als Wahrheit für den
 * Konfliktschutz:
 *   _abrechnung_session_ziel  — reservierte Zielperioden (Unique-Index
 *                                verhindert zwei aktive Sessions auf demselben
 *                                Zieltripel Person/Kostenträger/Periode)
 * Erzeugte Artefakte (Merge-PDF, Chunks) stehen in der JSONB-Spalte
 * `_abrechnung_sessions.artefakte` — sie brauchen keine eigene Tabelle, weil
 * pro Session nur wenige, kleine Einträge entstehen und nie relational
 * gejoint werden. PKV-Prüfvormerkungen/Anpinnungen werden für den Blockinhalt
 * weiter live aus den fachlichen Tabellen gelesen (abrechnung-paket.js::
 * buildPruefblockBuffers/buildPinBlockBuffers) — die Trigger
 * fn_block_bkpp_write_during_session/fn_block_kuerzung_write_during_session
 * sperren nur UPDATE/DELETE bestehender Zeilen, solange die Session (über
 * _abrechnung_session_ziel) läuft, nicht aber neue INSERTs (frisch verarbeiteter
 * Erstattungsbescheid, manuelles Anpinnen). Deshalb wird zusätzlich, für jedes
 * Zieltripel einzeln, ein Primärschlüssel-Snapshot dessen persistiert, was
 * tatsächlich eingesammelt wurde: `_abrechnung_session_ziel.snapshot_postids`
 * (reguläre Rechnungen, schon beim Öffnen der Session in Phase 1-4, weil genau
 * dieser Satz auch für den PDF-Bau verwendet wird) sowie
 * `snapshot_pruefung_keys`/`snapshot_pin_postids` (beim Bau in Phase 5, weil
 * deren Blockinhalt erst dort live abgefragt wird). confirmAbrechnungsperiode()
 * reicht in Phase 7 nur ein, was im jeweiligen Snapshot steht, und verschiebt
 * alles andere (verspätet Hinzugekommenes, dazu weiterhin bestrittene
 * Rechnungen) automatisch in die neu angelegte Folgeperiode, statt es lautlos
 * mit auf SUBMITTED/EINGEREICHT zu setzen, obwohl es nie im PDF stand.
 *
 * `groups` bleibt als Spalte bestehen, wird aber nur noch EINMAL beim Übergang
 * building→pending geschrieben (write-once-Projektion fürs Frontend) und danach
 * nie wieder als Entscheidungsquelle gelesen — das verhindert De-Sync.
 *
 * Ablauf (siehe internaldocs/FEATURE_KUERZUNGEN_GESEHEN_PKV_PRUEFUNG_PLAN.md, 9):
 *   1-4. beginAbrechnungsSession()            — Ziel sperren, Session 'building',
 *        Ziel-Reservierung — alles in EINER Transaktion.
 *   5-6. buildAbrechnungsSessionArtefakte()    — außerhalb der Transaktion: PDFs
 *        (inkl. live gebautem PKV-Prüfblock) bauen, je Artefakt sofort
 *        hochladen + registrieren (Heartbeat), danach Session auf 'pending'.
 *   7.   confirmAbrechnungsperiode()           — eine Transaktion: re-validieren,
 *        Zielperioden SUBMITTED, nur gesnapshottete Vormerkungen/Anpinnungen
 *        EINGEREICHT, Folgeperioden anlegen, bestrittene UND verspätet
 *        hinzugekommene Rechnungen/Vormerkungen/Anpinnungen (Snapshot-Diff) in
 *        die neue Periode umbuchen.
 *   8.   rejectAbrechnungsperiode() / Cron      — Artefakte backendbezogen
 *        entfernen, Reservierungen lösen, Vormerkungen bleiben VORGEMERKT.
 *
 * Beitragsrückerstattung (service/bre.js): Für BRE-relevante Personen
 * (Überwachung an oder eine ZURÜCKGEHALTEN-Periode vorhanden) entscheidet
 * beginAbrechnungsSession() unter der Periodensperre, welche Jahre aufgegeben
 * werden. Deren WITHHELD-Perioden werden zusätzliche Ziele; zurückgehaltene
 * Rechnungen fehlen im Snapshot und stehen je Ziel in `bre_halten`
 * ({ postid: zieljahr }), die Entscheidung je Person in
 * `_abrechnung_sessions.bre_entscheidung`. confirmAbrechnungsperiode() legt
 * fehlende BRE-Perioden VOR der Folgeperiode an und zieht die
 * zurückgehaltenen Rechnungen samt Prüfvormerkungen dorthin um. Für alle
 * anderen Personen läuft nichts davon.
 *
 * Legacy-Fallback: Sessions, die vor der Härtung im alten Nur-JSONB-Format
 * angelegt wurden (keine Zeilen in _abrechnung_session_ziel), laufen weiter
 * über die alten legacy*()-Funktionen. Sobald keine solche Session mehr
 * existiert, können sie entfernt werden (Rückbau-Notiz, kein Support-Fenster
 * im Sinne von base_schema.sql — das hier ist Anwendungscode, nicht Schema).
 */

import { randomUUID } from 'crypto';
import pool from '../db.js';
import { loadDynamicSettings, getFolders, getActiveBackendName } from '../config.js';
import { getActiveAdapter, getActiveAdapterFor, getAdapter } from '../lib/storage/index.js';
import { convertDocuments, mergeGroupPdf, buildChunkPdfs, buildPruefblockBuffers, buildPinBlockBuffers } from './abrechnung-paket.js';
import { appLog } from '../app-log.js';
import { sperrePerioden } from './perioden-sperre.js';
import {
  ladeBreLage, bewerteKombinationen, normalisiereAufgeben, findeKombination, verschiebePruefvormerkungen,
} from './bre.js';
import cron from 'node-cron';

// ── Legacy-Erkennung ─────────────────────────────────────────────────────────

/** true, wenn die Session nie Zeilen in _abrechnung_session_ziel bekommen hat (Alt-Session vor diesem Deploy). */
async function isLegacySession(sessionId) {
  const r = await pool.query(`SELECT 1 FROM _abrechnung_session_ziel WHERE session_id = $1 LIMIT 1`, [sessionId]);
  return r.rows.length === 0;
}

// ── Phase 1-4: Session eröffnen (eine Transaktion) ───────────────────────────

/**
 * Sperrt die Ziel-Perioden in stabiler Reihenfolge und validiert COLLECTING.
 * @returns {Promise<Array<{person,kostentraeger,periode}>>}
 */
async function resolveAndLockTargets(client, { persons, kostentraeger, selections }) {
  const targets = [];
  const targetKeys = new Set();
  const addTarget = (t) => {
    const key = `${t.person}\0${t.kostentraeger}\0${t.periode}`;
    if (!targetKeys.has(key)) {
      targetKeys.add(key);
      targets.push(t);
    }
  };

  if (Array.isArray(selections) && selections.length > 0) {
    for (const sel of selections) {
      if (!sel.person || !['PKV', 'Beihilfe'].includes(sel.kostentraeger) || !Number.isInteger(sel.periode)) {
        throw new Error('Ungültige Selection');
      }
      addTarget({ person: sel.person, kostentraeger: sel.kostentraeger, periode: sel.periode });
    }
  } else {
    for (const person of (persons || [])) {
      for (const kt of (kostentraeger || [])) {
        const r = await client.query(
          `SELECT periode FROM abrechnungsperiode_buch
           WHERE person = $1 AND kostentraeger = $2 AND status = 'COLLECTING'
           ORDER BY periode DESC LIMIT 1`,
          [person, kt]
        );
        if (r.rows.length > 0) addTarget({ person, kostentraeger: kt, periode: r.rows[0].periode });
      }
    }
  }

  if (targets.length === 0) throw new Error('Für die gewählte Auswahl gibt es keine offene Sammelperiode.');

  // Stabile Sperr-Reihenfolge — verhindert Deadlocks bei parallelen Session-Starts.
  targets.sort((a, b) =>
    a.person.localeCompare(b.person) ||
    a.kostentraeger.localeCompare(b.kostentraeger) ||
    a.periode - b.periode
  );

  for (const t of targets) {
    const cur = await client.query(
      `SELECT status FROM abrechnungsperiode_buch
       WHERE person = $1 AND kostentraeger = $2 AND periode = $3 FOR UPDATE`,
      [t.person, t.kostentraeger, t.periode]
    );
    if (cur.rows.length === 0 || cur.rows[0].status !== 'COLLECTING') {
      throw new Error(`Periode ${t.person}/${t.kostentraeger}/${t.periode} ist nicht (mehr) COLLECTING`);
    }
  }

  return targets;
}

const zielKey = (t) => `${t.person} ${t.kostentraeger} ${t.periode}`;

/**
 * Ermittelt vorab (ohne Sperre) die Personen der Auswahl, für die die
 * Beitragsrückerstattung eine Rolle spielt: PKV-Auswahl und entweder
 * eingeschaltete Überwachung oder eine ZURÜCKGEHALTEN-Periode. Nur für diese
 * Personen wird die Periodensperre genommen und neu gerechnet; alle anderen
 * laufen exakt wie bisher. Ein Fehler hier darf deren Abrechnung nicht
 * brechen und wird nur protokolliert.
 */
async function ermittleBrePersonen(client, { persons, kostentraeger, selections }) {
  const kandidaten = new Set();
  if (Array.isArray(selections) && selections.length > 0) {
    for (const sel of selections) if (sel?.kostentraeger === 'PKV' && sel.person) kandidaten.add(sel.person);
  } else if ((kostentraeger || []).includes('PKV')) {
    for (const p of (persons || [])) kandidaten.add(p);
  }
  if (kandidaten.size === 0) return [];
  try {
    const r = await client.query(
      `SELECT m.kurzname FROM postbuch.mensch m
        WHERE m.kurzname = ANY($1::text[])
          AND ((m.bre_ueberwachen AND m.pkv AND NOT m.ist_tier)
               OR EXISTS (SELECT 1 FROM abrechnungsperiode_buch w
                           WHERE w.person = m.kurzname AND w.kostentraeger = 'PKV' AND w.status = 'WITHHELD'))`,
      [[...kandidaten]]
    );
    return r.rows.map((x) => x.kurzname).sort();
  } catch (err) {
    appLog('ERROR', 'abrechnungsperiode', `BRE-Vorprüfung fehlgeschlagen, Abrechnung läuft ohne BRE: ${err.message}`);
    return [];
  }
}

/**
 * Plant die Beitragsrückerstattung für die BRE-Personen einer Session. Läuft
 * unter der (bereits genommenen) Periodensperre der Personen und nach
 * resolveAndLockTargets(). Ergänzt `targets` um die WITHHELD-Perioden der
 * aufgegebenen Jahre (gesperrt und geprüft) und liefert, was je Ziel
 * zurückgehalten wird.
 *
 * @param {Object<string, number[]>|undefined} breAufgeben  Wahl des Nutzers
 *   je Person; fehlt sie, gilt der Vorschlag.
 * @returns {Promise<{haltenJeZiel: Map<string, Object<string, number>>,
 *   entscheidung: Object<string, object>}>}
 */
async function planeBre(client, brePersonen, targets, breAufgeben) {
  const haltenJeZiel = new Map();
  const entscheidung = {};

  for (const person of brePersonen) {
    const pkvZiele = targets.filter((t) => t.person === person && t.kostentraeger === 'PKV');
    if (pkvZiele.length === 0) continue;
    if (pkvZiele.length > 1) {
      const err = new Error(`Für ${person} ist mehr als eine PKV-Sammelperiode gewählt. Mit Beitragsrückerstattung bitte nur eine PKV-Periode je Person einreichen.`);
      err.code = 'BRE_MEHRERE_SAMMELPERIODEN';
      err.status = 400;
      throw err;
    }
    const sammel = pkvZiele[0];

    // Eine zweite Session derselben Person könnte Rechnungen in dieselben
    // zurückhaltenden Perioden ziehen oder sie einreichen.
    const fremd = await client.query(
      `SELECT 1 FROM _abrechnung_session_ziel WHERE person = $1 AND kostentraeger = 'PKV' AND aktiv LIMIT 1`,
      [person]
    );
    if (fremd.rows.length > 0) {
      const err = new Error('Für diese Person läuft bereits eine andere PKV-Abrechnung.');
      err.code = 'ABRECHNUNG_SESSION_KONFLIKT';
      throw err;
    }

    const lage = await ladeBreLage(client, person, { sammelPeriode: sammel.periode });
    if (!lage) continue;
    const bewertung = bewerteKombinationen(lage);
    if (bewertung.entscheidungsjahre.length === 0) continue;

    const aufgeben = normalisiereAufgeben(bewertung, breAufgeben ? breAufgeben[person] : undefined);
    const kombi = findeKombination(bewertung, aufgeben);

    const zusatz = [];
    for (const w of lage.withheld) {
      if (!aufgeben.includes(w.jahr)) continue;
      const cur = await client.query(
        `SELECT status FROM abrechnungsperiode_buch
          WHERE person = $1 AND kostentraeger = 'PKV' AND periode = $2 FOR UPDATE`,
        [person, w.periode]
      );
      if (cur.rows[0]?.status !== 'WITHHELD') {
        throw new Error(`Periode ${person}/PKV/${w.periode} ist nicht (mehr) ZURÜCKGEHALTEN`);
      }
      const t = { person, kostentraeger: 'PKV', periode: w.periode, breJahr: w.jahr };
      targets.push(t);
      zusatz.push(t);
    }

    // Nur Rechnungen, die in einem Ziel liegen und wirklich umziehen.
    const zielPerioden = new Map([[sammel.periode, null], ...zusatz.map((t) => [t.periode, t.breJahr])]);
    const kandidatNach = new Map(lage.kandidaten.map((k) => [k.postid, k]));
    let anzahlGehalten = 0;
    for (const [postid, jahr] of Object.entries(kombi.halten)) {
      const k = kandidatNach.get(postid);
      if (!k || !zielPerioden.has(k.periode)) continue;
      if (k.istWithheld && k.periodeJahr === jahr) continue;
      const key = zielKey({ person, kostentraeger: 'PKV', periode: k.periode });
      if (!haltenJeZiel.has(key)) haltenJeZiel.set(key, {});
      haltenJeZiel.get(key)[postid] = jahr;
      anzahlGehalten++;
    }

    entscheidung[person] = {
      aufgeben,
      vorschlag: bewertung.vorschlag,
      wert: kombi.wert,
      schwelle: lage.schwelleAktuell,
      sammelPeriode: sammel.periode,
      breZiele: zusatz.map((t) => ({ periode: t.periode, jahr: t.breJahr })),
      haltejahre: kombi.haltejahre,
      anzahlGehalten,
    };
  }

  return { haltenJeZiel, entscheidung };
}

/**
 * Entfernt die PKV-Sammelperiode einer BRE-Person aus den Zielen, wenn sie
 * nur deshalb leer wäre, weil alles zurückgehalten wird, und auch sonst
 * nichts mitginge (keine BRE-Periode, keine offene Prüfvormerkung oder
 * Anpinnung). Die Rechnungen bleiben dann in der Sammelperiode, bis wieder
 * etwas Einreichbares dazukommt – keine leere Einreichung.
 */
async function entferneLeereBreSammelziele(client, targets, docsByTarget, haltenJeZiel, entscheidung) {
  for (const [person, e] of Object.entries(entscheidung)) {
    if (e.breZiele.length > 0) continue;
    const key = zielKey({ person, kostentraeger: 'PKV', periode: e.sammelPeriode });
    const gehalten = Object.keys(haltenJeZiel.get(key) || {});
    if (gehalten.length === 0) continue;
    if ((docsByTarget.get(key) || []).length > 0) continue;
    const offen = await client.query(
      `SELECT 1 FROM dokument_pin
        WHERE person = $1 AND kostentraeger = 'PKV' AND periode = $2 AND status = 'VORGEMERKT'
       UNION ALL
       SELECT 1 FROM beihilfe_kuerzung_pkv_pruefung b
         JOIN erstattungsbescheid_kuerzung k
           ON k.postid = b.eb_postid AND k.eb_subid = b.eb_subid AND k.kuerzung_id = b.kuerzung_id
        WHERE b.person = $1 AND b.kostentraeger = 'PKV' AND b.periode = $2 AND b.status = 'VORGEMERKT'
          AND (k.arz_postid IS NULL OR NOT (k.arz_postid = ANY($3::text[])))
       LIMIT 1`,
      [person, e.sammelPeriode, gehalten]
    );
    if (offen.rows.length > 0) continue;
    const idx = targets.findIndex((t) => zielKey(t) === key);
    if (idx >= 0) targets.splice(idx, 1);
    haltenJeZiel.delete(key);
    delete entscheidung[person];
    appLog('INFO', 'abrechnungsperiode',
      `BRE: PKV-Sammelperiode ${person}/${e.sammelPeriode} nicht eingereicht – ${gehalten.length} Rechnung(en) bleiben für die Beitragsrückerstattung zurück`);
  }
}

/**
 * Entfernt Ziele, für die nichts eingereicht würde: keine Rechnung im
 * Snapshot, keine offene Prüfvormerkung (nur PKV), keine offene Anpinnung.
 * Ohne das würde eine leere Periode beim Bestätigen als eingereicht gelten
 * und eine Folgeperiode bekommen, obwohl sie in keinem PDF stand. Ziele mit
 * Beitragsrückerstattungs-Entscheidung regelt die BRE-Logik selbst.
 */
async function entferneLeereZiele(client, targets, docsByTarget, haltenJeZiel, entscheidung) {
  for (let i = targets.length - 1; i >= 0; i--) {
    const t = targets[i];
    const key = zielKey(t);
    if ((docsByTarget.get(key) || []).length > 0) continue;
    if (haltenJeZiel.has(key)) continue;
    if (t.kostentraeger === 'PKV' && entscheidung[t.person]) continue;
    const offen = await client.query(
      `SELECT 1 FROM dokument_pin
        WHERE person = $1 AND kostentraeger = $2 AND periode = $3 AND status = 'VORGEMERKT'
       UNION ALL
       SELECT 1 FROM beihilfe_kuerzung_pkv_pruefung
        WHERE $2 = 'PKV' AND person = $1 AND kostentraeger = 'PKV' AND periode = $3 AND status = 'VORGEMERKT'
       LIMIT 1`,
      [t.person, t.kostentraeger, t.periode]
    );
    if (offen.rows.length > 0) continue;
    targets.splice(i, 1);
    appLog('INFO', 'abrechnungsperiode',
      `Periode ${t.person}/${t.kostentraeger}/${t.periode} nicht eingereicht – nichts darin`);
  }
}

/**
 * Legt Session ('building') + Ziel-Reservierungen an. 409-Konflikt bei
 * Doppelstart auf dasselbe Ziel. `docsByTarget` (Map "person kostentraeger
 * periode" → postid[]) wird als snapshot_postids mitgeschrieben — genau der
 * Satz, der auch für den PDF-Bau verwendet wird (siehe Dateikopf).
 */
async function createSessionAndZiel(client, targets, docsByTarget, haltenJeZiel = new Map(), breEntscheidung = null) {
  const sessionId = randomUUID();
  await client.query(
    `INSERT INTO _abrechnung_sessions (id, status, groups, created_at, updated_at, bre_entscheidung)
     VALUES ($1, 'building', '[]'::jsonb, NOW(), NOW(), $2::jsonb)`,
    [sessionId, breEntscheidung ? JSON.stringify(breEntscheidung) : null]
  );
  try {
    for (const t of targets) {
      const postids = docsByTarget.get(zielKey(t)) ?? [];
      const halten = haltenJeZiel.get(zielKey(t));
      await client.query(
        `INSERT INTO _abrechnung_session_ziel (session_id, person, kostentraeger, periode, aktiv, snapshot_postids, bre_halten)
         VALUES ($1, $2, $3, $4, true, $5::text[], $6::jsonb)`,
        [sessionId, t.person, t.kostentraeger, t.periode, postids, halten ? JSON.stringify(halten) : null]
      );
    }
  } catch (err) {
    if (err.code === '23505') {
      const conflictErr = new Error('Für mindestens eine der gewählten Perioden läuft bereits eine andere Abrechnungssession.');
      conflictErr.code = 'ABRECHNUNG_SESSION_KONFLIKT';
      throw conflictErr;
    }
    throw err;
  }
  return sessionId;
}

/**
 * Sammelt die regulären Rechnungen der Zielperioden. PKV-Prüfvormerkungen/
 * Anpinnungen werden bewusst NICHT hier gesnapshottet, sondern erst in Phase 5
 * beim Bau (siehe Dateikopf).
 *
 * Bestrittene Rechnungen (aktiver bestrittener Betrag) werden nie mit
 * eingereicht — der Endbetrag steht erst nach Klärung des Streitfalls fest.
 * Sie bleiben zunächst in ihrer Periode und werden beim Bestätigen
 * (confirmAbrechnungsperiode) automatisch in die neue COLLECTING-Periode
 * verschoben.
 * @returns {Promise<{allDocs: Array}>} allDocs — reguläre Rechnungen für Phase 5
 */
async function snapshotSession(client, targets, haltenJeZiel = new Map()) {
  const allDocs = [];
  for (const t of targets) {
    const gehalten = Object.keys(haltenJeZiel.get(zielKey(t)) || {});
    const periodeCol = t.kostentraeger === 'PKV' ? 'abrechnungsperiode_pkv' : 'abrechnungsperiode_beihilfe';
    const r = await client.query(
      `SELECT a.postid, a.behandelte_person AS person, $2 AS kostentraeger, $3::int AS periode,
              COALESCE(p.dokumentart, '') AS art
       FROM arztrechnung a
       LEFT JOIN postbuch p ON p.postid = a.postid
       WHERE a.behandelte_person = $1 AND a.${periodeCol} = $3
         AND COALESCE(a.bestritten_betrag, 0) <= 0
         AND NOT (a.postid = ANY($4::text[]))`,
      [t.person, t.kostentraeger, t.periode, gehalten]
    );
    allDocs.push(...r.rows);
  }
  return { allDocs };
}

/**
 * Phase 1-4: eröffnet eine gehärtete Session in einer einzigen Transaktion.
 * Gibt {sessionId, allDocs, targets} zurück — allDocs sind reine DB-Zeilen
 * (leichtgewichtig), die Route kann damit sofort {jobId, sessionId} an den
 * Client zurückgeben. targets wird an Phase 5 durchgereicht, damit PKV-Ziele
 * ohne reguläre Rechnungen (nur offene Prüfvormerkungen) dort trotzdem einen
 * Prüfblock bekommen.
 */
export async function beginAbrechnungsSession({ persons, kostentraeger, selections, breAufgeben }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // BRE-Personen zuerst unter die Periodensperre (Reihenfolge: Advisory vor
    // Zeilensperren, service/perioden-sperre.js), damit Kandidaten und
    // Aufteilung auf einem stabilen Stand berechnet werden.
    const brePersonen = await ermittleBrePersonen(client, { persons, kostentraeger, selections });
    if (brePersonen.length > 0) {
      await sperrePerioden(client, brePersonen.map((person) => ({ person, kostentraeger: 'PKV' })));
    }
    const targets = await resolveAndLockTargets(client, { persons, kostentraeger, selections });
    const { haltenJeZiel, entscheidung } = brePersonen.length > 0
      ? await planeBre(client, brePersonen, targets, breAufgeben)
      : { haltenJeZiel: new Map(), entscheidung: {} };

    let { allDocs } = await snapshotSession(client, targets, haltenJeZiel);
    let docsByTarget = new Map();
    const gruppiere = () => {
      docsByTarget = new Map();
      for (const d of allDocs) {
        const key = `${d.person} ${d.kostentraeger} ${d.periode}`;
        if (!docsByTarget.has(key)) docsByTarget.set(key, []);
        docsByTarget.get(key).push(d.postid);
      }
    };
    gruppiere();
    if (Object.keys(entscheidung).length > 0) {
      await entferneLeereBreSammelziele(client, targets, docsByTarget, haltenJeZiel, entscheidung);
      if (targets.length === 0) {
        const err = new Error('Für die gewählte Auswahl gibt es nichts einzureichen – alle Rechnungen werden für die Beitragsrückerstattung zurückgehalten.');
        err.code = 'BRE_NICHTS_EINZUREICHEN';
        err.status = 422;
        throw err;
      }
      const behalten = new Set(targets.map(zielKey));
      allDocs = allDocs.filter((d) => behalten.has(`${d.person} ${d.kostentraeger} ${d.periode}`));
      gruppiere();
    }
    await entferneLeereZiele(client, targets, docsByTarget, haltenJeZiel, entscheidung);
    if (targets.length === 0) {
      const err = new Error('Für die gewählte Auswahl liegt nichts zum Einreichen vor – keine Rechnungen, offenen Prüfvormerkungen oder angepinnten Dokumente.');
      err.code = 'NICHTS_EINZUREICHEN';
      err.status = 422;
      throw err;
    }
    // Phase 5 lässt Prüfvormerkungen zurückgehaltener Rechnungen aus.
    for (const t of targets) {
      const halten = haltenJeZiel.get(zielKey(t));
      if (halten) t.breHalten = Object.keys(halten);
    }
    const breEntscheidung = Object.keys(entscheidung).length > 0 ? entscheidung : null;
    const sessionId = await createSessionAndZiel(client, targets, docsByTarget, haltenJeZiel, breEntscheidung);

    await client.query('COMMIT');
    appLog('INFO', 'abrechnungsperiode', `Session angelegt (building): ${sessionId} — ${allDocs.length} reguläre Dokument(e), ${targets.length} Zielperiode(n)`);
    if (breEntscheidung) {
      for (const [person, e] of Object.entries(breEntscheidung)) {
        appLog('INFO', 'abrechnungsperiode',
          `Session ${sessionId}: BRE ${person} – aufgeben [${e.aufgeben.join(', ')}] (Vorschlag [${e.vorschlag.join(', ')}], Wert ${e.wert}), `
          + `${e.anzahlGehalten} Rechnung(en) zurückgehalten`,
          { entity: 'abrechnungsperiode', entityId: `${person}/PKV/${e.sammelPeriode}` });
      }
    }
    return { sessionId, allDocs, targets, breEntscheidung };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ── Phase 5-6: Artefakte bauen (außerhalb der Transaktion) ───────────────────

async function registerArtefakt(sessionId, { typ, sortierung, storageBackend, storageId, dateiname }) {
  const eintrag = { typ, sortierung, storage_backend: storageBackend, storage_id: storageId, dateiname };
  // Ein UPDATE für Artefakt-Anhängen + Heartbeat: solange laufend Artefakte
  // reinkommen, darf der Cron eine 'building'-Session nicht für hängengeblieben halten.
  // Nur solange die Session noch 'building' ist: wurde sie inzwischen
  // verworfen, gehört die frisch hochgeladene Datei niemandem mehr und wird
  // sofort wieder entfernt; der Aufbau bricht ab.
  const upd = await pool.query(
    `UPDATE _abrechnung_sessions
     SET artefakte = artefakte || $2::jsonb, updated_at = NOW()
     WHERE id = $1 AND status = 'building'`,
    [sessionId, JSON.stringify([eintrag])]
  );
  if (upd.rowCount === 0) {
    await getAdapter(storageBackend).remove(storageId).catch(() => {});
    throw sessionAbgebrochenError(sessionId);
  }
}

/** Fehler für einen Aufbau, dessen Session während der PDF-Erstellung verworfen wurde. */
function sessionAbgebrochenError(sessionId) {
  const err = new Error(`Session ${sessionId} wurde während der PDF-Erstellung verworfen`);
  err.code = 'ABRECHNUNG_SESSION_ABGEBROCHEN';
  return err;
}

/**
 * Phase 5: baut je Kostenträger-Gruppe das gemergte PDF + ggf. Chunks (PKV
 * zusätzlich den live gebauten Prüfblock aus offenen Prüfvormerkungen), lädt
 * jedes Artefakt sofort hoch und registriert es (Heartbeat). Phase 6: setzt
 * die Session danach auf 'pending' und schreibt `groups` einmalig.
 * @param {Array} targets - alle Zielperioden der Session (aus beginAbrechnungsSession),
 *   nötig damit ein PKV-Ziel ohne reguläre Rechnungen trotzdem einen Prüfblock bekommt.
 */
export async function buildAbrechnungsSessionArtefakte(sessionId, allDocs, targets, onProgress = () => {}) {
  const settings = await loadDynamicSettings();
  const storage = getActiveAdapterFor(settings);
  const backendName = getActiveBackendName(settings);
  const abrechnungFolderId = getFolders(settings).abrechnungMerged;
  if (!abrechnungFolderId) {
    const err = new Error('Ablage-Ordner für Abrechnungen nicht konfiguriert (storage_folders.<backend>.abrechnungMerged)');
    await abortBuildingSession(sessionId, 'error');
    throw err;
  }

  try {
    const byKt = new Map();
    for (const doc of allDocs) {
      if (!byKt.has(doc.kostentraeger)) byKt.set(doc.kostentraeger, []);
      byKt.get(doc.kostentraeger).push(doc);
    }
    // Ziele ohne reguläre Rechnungen (nur offene Prüfvormerkungen/Anpinnungen)
    // brauchen trotzdem eine Gruppe, sonst würde ihr Prüf-/Pin-Block nie gebaut.
    for (const t of targets) {
      if (!byKt.has(t.kostentraeger)) byKt.set(t.kostentraeger, []);
    }

    let totalSteps = allDocs.length + byKt.size * 2;
    let doneSteps = 0;
    let convertedCount = 0;
    const sessionGroups = [];
    let groupIndex = 0;
    // Gemeinsam über alle Gruppen: ein Dokument für PKV und Beihilfe wird nur einmal konvertiert.
    const convertCache = new Map();

    for (const [kt, docs] of byKt.entries()) {
      const buffers = await convertDocuments(docs, (_i, _n, _postid, fromCache) => {
        onProgress(doneSteps, totalSteps, fromCache
          ? `Dokument ${convertedCount + 1} von ${allDocs.length} bereits konvertiert…`
          : `Konvertiere Dokument ${convertedCount + 1} von ${allDocs.length}…`);
        doneSteps++;
        convertedCount++;
      }, convertCache);

      let pruefblockBuffers = [];
      let pruefungCount = 0;
      let pruefungSnapshots = [];
      if (kt === 'PKV') {
        onProgress(doneSteps, totalSteps, 'PKV: Prüfvormerkungen werden zusammengestellt…');
        const pruefblock = await buildPruefblockBuffers(targets.filter((t) => t.kostentraeger === 'PKV'), {
          vorneEnthalten: docs.map((d) => d.postid),
        });
        pruefblockBuffers = pruefblock.buffers;
        pruefungCount = pruefblock.pruefungCount;
        pruefungSnapshots = pruefblock.snapshotByTarget;
      }

      onProgress(doneSteps, totalSteps, `${kt}: Angepinnte Dokumente werden zusammengestellt…`);
      const pinBlock = await buildPinBlockBuffers(targets.filter((t) => t.kostentraeger === kt));
      const { buffers: pinBlockBuffers, pinCount, snapshotByTarget: pinSnapshots } = pinBlock;

      // Snapshot dessen, was tatsächlich in Prüf-/Pin-Block gelandet ist, je
      // Zieltripel persistieren — Grundlage für den Nachlaufschutz in
      // confirmAbrechnungsperiode() (siehe Dateikopf).
      for (const t of targets.filter((tt) => tt.kostentraeger === kt)) {
        const pk = pruefungSnapshots.find((s) => s.person === t.person && s.periode === t.periode);
        const pn = pinSnapshots.find((s) => s.person === t.person && s.periode === t.periode);
        await pool.query(
          `UPDATE _abrechnung_session_ziel
           SET snapshot_pruefung_keys = $1::text[], snapshot_pin_postids = $2::text[]
           WHERE session_id = $3 AND person = $4 AND kostentraeger = $5 AND periode = $6`,
          [pk?.keys ?? [], pn?.postids ?? [], sessionId, t.person, t.kostentraeger, t.periode]
        );
      }

      // Pin-Block ganz hinten, nach dem PKV-Prüfblock.
      const gruppenBuffers = [...buffers, ...pruefblockBuffers, ...pinBlockBuffers];
      if (gruppenBuffers.length === 0) continue; // Ziel ohne Dokumente und ohne offene Prüfung/Anpinnung

      const targetsInGroup = targets.filter((t) => t.kostentraeger === kt);
      const personsInGroup = [...new Set([...docs.map((d) => d.person), ...targetsInGroup.map((t) => t.person)])].sort();
      const periodenInGroup = [...new Set([...docs.map((d) => d.periode), ...targetsInGroup.map((t) => t.periode)])].sort();
      const fileNamePart = `${kt}-${personsInGroup.join('-')}-P${periodenInGroup.join('-')}`;
      const today = new Date().toISOString().slice(0, 10);
      const fileName = `Abrechnung_${fileNamePart}_${today}.pdf`;

      onProgress(doneSteps, totalSteps, `${kt}: PDFs werden zusammengeführt…`);
      const mergedPdf = await mergeGroupPdf(gruppenBuffers);
      doneSteps++;
      const totalSizeBytes = mergedPdf.length;

      onProgress(doneSteps, totalSteps, `${kt}: Upload in die Ablage…`);
      const { id: pdfStorageId, webUrl: pdfWebUrl } = await storage.uploadNew(mergedPdf, fileName, abrechnungFolderId);
      doneSteps++;
      await registerArtefakt(sessionId, {
        typ: 'PDF_GRUPPE', sortierung: groupIndex, storageBackend: backendName, storageId: pdfStorageId, dateiname: fileName,
      });

      const chunkResults = await buildChunkPdfs(gruppenBuffers);
      let chunksSummary = null;
      if (chunkResults) {
        totalSteps += chunkResults.length * 2;
        chunksSummary = [];
        for (let ci = 0; ci < chunkResults.length; ci++) {
          const { pdf: chunkPdf, documentCount } = chunkResults[ci];
          onProgress(doneSteps, totalSteps, `${kt}: Teil ${ci + 1} von ${chunkResults.length} wird erstellt…`);
          doneSteps++;
          const chunkFileName = `Abrechnung_${fileNamePart}_${today}_Teil${ci + 1}.pdf`;
          onProgress(doneSteps, totalSteps, `${kt}: Teil ${ci + 1} wird hochgeladen…`);
          const { id: chunkStorageId } = await storage.uploadNew(chunkPdf, chunkFileName, abrechnungFolderId);
          doneSteps++;
          await registerArtefakt(sessionId, {
            typ: 'PDF_CHUNK', sortierung: groupIndex * 100 + ci, storageBackend: backendName, storageId: chunkStorageId, dateiname: chunkFileName,
          });
          chunksSummary.push({ sizeBytes: chunkPdf.length, documentCount, label: `Teil ${ci + 1} von ${chunkResults.length} (${documentCount} Dok.)` });
        }
      }

      sessionGroups.push({
        kostentraeger: kt, persons: personsInGroup, perioden: periodenInGroup,
        fileNamePart, fileName, pdfWebUrl, documentCount: docs.length, totalSizeBytes,
        chunks: chunksSummary, pruefungCount, pinCount,
      });
      groupIndex++;
    }

    const fertig = await pool.query(
      `UPDATE _abrechnung_sessions
       SET status = 'pending', groups = $2::jsonb, expires_at = NOW() + INTERVAL '2 hours', updated_at = NOW()
       WHERE id = $1 AND status = 'building'`,
      [sessionId, JSON.stringify(sessionGroups)]
    );
    if (fertig.rowCount === 0) throw sessionAbgebrochenError(sessionId);
    appLog('INFO', 'abrechnungsperiode',
      `Session bereit (pending): ${sessionId} | Gruppen: ${sessionGroups.map((g) => `${g.kostentraeger}(${g.documentCount} Dok.)`).join(', ')}`
    );

    return sessionGroups.map((g) => ({
      kostentraeger: g.kostentraeger, persons: g.persons, perioden: g.perioden,
      fileNamePart: g.fileNamePart, fileName: g.fileName, pdfWebUrl: g.pdfWebUrl,
      documentCount: g.documentCount, totalSizeBytes: g.totalSizeBytes,
      chunks: g.chunks ? g.chunks.map((c) => ({ sizeBytes: c.sizeBytes, documentCount: c.documentCount, label: c.label })) : null,
      pruefungCount: g.pruefungCount, pinCount: g.pinCount,
    }));
  } catch (err) {
    if (err.code === 'ABRECHNUNG_SESSION_ABGEBROCHEN') {
      // Verwerfen hat Reservierungen und bis dahin registrierte Artefakte
      // bereits freigegeben; nur noch Nachzügler entfernen.
      appLog('INFO', 'abrechnungsperiode', `Session-Aufbau abgebrochen (verworfen): ${sessionId}`);
      await removeArtefakte(sessionId).catch(() => {});
      throw err;
    }
    appLog('ERROR', 'abrechnungsperiode', `Session-Aufbau fehlgeschlagen, räume auf: ${sessionId} — ${err.message}`);
    await abortBuildingSession(sessionId, 'error').catch(() => {});
    throw err;
  }
}

// ── Abbruch/Cleanup (Phase 8) ─────────────────────────────────────────────────

async function removeArtefakte(sessionId) {
  const r = await pool.query(`SELECT artefakte FROM _abrechnung_sessions WHERE id = $1`, [sessionId]);
  const artefakte = r.rows[0]?.artefakte ?? [];
  await Promise.allSettled(artefakte.map((a) => getAdapter(a.storage_backend).remove(a.storage_id)));
}

/** Setzt Ziel-Reservierungen frei + Session-Status, entfernt zuvor hochgeladene Artefakte. */
async function abortBuildingSession(sessionId, targetStatus) {
  await removeArtefakte(sessionId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE _abrechnung_session_ziel SET aktiv = false WHERE session_id = $1`, [sessionId]);
    const upd = await client.query(
      `UPDATE _abrechnung_sessions SET status = $2, completed_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND status IN ('building', 'pending')
       RETURNING id`,
      [sessionId, targetStatus]
    );
    await client.query('COMMIT');
    return upd.rowCount > 0;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ── Phase 7: Bestätigen ───────────────────────────────────────────────────────

export async function confirmAbrechnungsperiode(sessionId) {
  if (await isLegacySession(sessionId)) return legacyConfirm(sessionId);

  let summary;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const sess = await client.query(`SELECT status, bre_entscheidung FROM _abrechnung_sessions WHERE id = $1 FOR UPDATE`, [sessionId]);
    if (sess.rows.length === 0) throw new Error(`Session ${sessionId} nicht gefunden`);
    if (sess.rows[0].status !== 'pending') {
      throw new Error(`Session ${sessionId} ist nicht mehr offen (Status: ${sess.rows[0].status})`);
    }

    const ziel = await client.query(
      `SELECT person, kostentraeger, periode, snapshot_postids, snapshot_pruefung_keys, snapshot_pin_postids, bre_halten
       FROM _abrechnung_session_ziel
       WHERE session_id = $1 AND aktiv ORDER BY person, kostentraeger, periode`,
      [sessionId]
    );
    if (ziel.rows.length === 0) throw new Error(`Session ${sessionId} hat keine aktiven Zielperioden mehr`);

    // Periodensperre je Person und Kostenträger vor jeder Zeilensperre: hält
    // gleichzeitige Bescheidabschlüsse (Restperiode MAX+1) und neue
    // Arztrechnungen (Trigger) heraus, bis die Folgeperiode steht und die
    // nachgekommenen Rechnungen umgebucht sind.
    await sperrePerioden(client, ziel.rows);

    // Zielperioden erneut sperren + re-validieren — der Snapshot kann veraltet sein.
    for (const z of ziel.rows) {
      const cur = await client.query(
        `SELECT status FROM abrechnungsperiode_buch WHERE person = $1 AND kostentraeger = $2 AND periode = $3 FOR UPDATE`,
        [z.person, z.kostentraeger, z.periode]
      );
      // WITHHELD: BRE-Periode eines aufgegebenen Jahres (zusätzliches Ziel).
      if (cur.rows.length === 0 || !['COLLECTING', 'WITHHELD'].includes(cur.rows[0].status)) {
        const err = new Error(`Periode ${z.person}/${z.kostentraeger}/${z.periode} ist nicht mehr offen — Session ist veraltet`);
        err.code = 'ABRECHNUNG_SESSION_VERALTET';
        throw err;
      }
    }

    await client.query(`UPDATE _abrechnung_sessions SET status = 'confirming', updated_at = NOW() WHERE id = $1`, [sessionId]);

    const persons = ziel.rows.map((z) => z.person);
    const kts = ziel.rows.map((z) => z.kostentraeger);
    const perioden = ziel.rows.map((z) => z.periode);

    await client.query(
      `UPDATE abrechnungsperiode_buch ab
       SET status = 'SUBMITTED'
       FROM (SELECT unnest($1::text[]) AS person, unnest($2::text[]) AS kostentraeger, unnest($3::int[]) AS periode) t
       WHERE ab.person = t.person AND ab.kostentraeger = t.kostentraeger AND ab.periode = t.periode
         AND ab.status IN ('COLLECTING', 'WITHHELD')`,
      [persons, kts, perioden]
    );

    // Nur die beim PDF-Bau tatsächlich eingesammelten Vormerkungen/Anpinnungen
    // VORGEMERKT → EINGEREICHT (Abgleich gegen den Snapshot aus Phase 5, siehe
    // Dateikopf). Was seither dazugekommen ist, bleibt VORGEMERKT und wird
    // weiter unten (nach Anlage der Folgeperiode) dorthin verschoben, statt
    // lautlos in einer bereits eingereichten Periode als "eingereicht" zu
    // gelten, obwohl es nie im PDF stand.
    for (const z of ziel.rows) {
      if (z.kostentraeger === 'PKV') {
        await client.query(
          `UPDATE beihilfe_kuerzung_pkv_pruefung
           SET status = 'EINGEREICHT', eingereicht_am = NOW(), eingereicht_session_id = $4
           WHERE person = $1 AND kostentraeger = 'PKV' AND periode = $2 AND status = 'VORGEMERKT'
             AND (eb_postid || '|' || eb_subid || '|' || kuerzung_id) = ANY($3::text[])`,
          [z.person, z.periode, z.snapshot_pruefung_keys, sessionId]
        );
      }
      await client.query(
        `UPDATE dokument_pin
         SET status = 'EINGEREICHT', eingereicht_am = NOW(), eingereicht_session_id = $4
         WHERE person = $1 AND kostentraeger = $2 AND periode = $3 AND status = 'VORGEMERKT'
           AND postid = ANY($5::text[])`,
        [z.person, z.kostentraeger, z.periode, sessionId, z.snapshot_pin_postids]
      );
    }

    // Beitragsrückerstattung: BRE-Perioden VOR der Folgeperiode anlegen, damit
    // die Folgeperiode wie bisher MAX+1 und die höchste Nummer bekommt, und
    // zurückgehaltene Rechnungen samt Prüfvormerkungen dorthin umziehen.
    const breErgebnis = await bestaetigeBre(client, sess.rows[0].bre_entscheidung, ziel.rows);

    // Folgeperioden (MAX+1) je (person, kostentraeger), sofern nicht bereits vorhanden.
    const distinctPairs = [...new Set(ziel.rows.map((z) => `${z.person}\0${z.kostentraeger}`))]
      .map((k) => k.split('\0'));
    const dPersons = distinctPairs.map((p) => p[0]);
    const dKts = distinctPairs.map((p) => p[1]);

    await client.query(
      `INSERT INTO abrechnungsperiode_buch (person, kostentraeger, periode, status, satz)
       SELECT ab.person, ab.kostentraeger, MAX(ab.periode) + 1, 'COLLECTING',
              CASE ab.kostentraeger WHEN 'PKV' THEN p.pkv_satz ELSE p.beihilfe_satz END
       FROM abrechnungsperiode_buch ab
       JOIN postbuch.mensch p ON p.kurzname = ab.person
       JOIN (SELECT unnest($1::text[]) AS person, unnest($2::text[]) AS kostentraeger) t
         ON t.person = ab.person AND t.kostentraeger = ab.kostentraeger
       GROUP BY ab.person, ab.kostentraeger, p.pkv_satz, p.beihilfe_satz
       HAVING NOT EXISTS (
         SELECT 1 FROM abrechnungsperiode_buch x
         WHERE x.person = ab.person AND x.kostentraeger = ab.kostentraeger AND x.status = 'COLLECTING'
       )
       ON CONFLICT (person, kostentraeger, periode) DO NOTHING`,
      [dPersons, dKts]
    );

    // Aus der eben eingereichten (jetzt SUBMITTED) Periode wandert automatisch
    // in die neue COLLECTING-Periode, was nicht im PDF stand: bestrittene
    // Rechnungen (Endbetrag steht erst nach Klärung fest, siehe snapshotSession)
    // UND Rechnungen/Vormerkungen/Anpinnungen, die erst NACH dem PDF-Bau
    // dazugekommen sind (Snapshot-Diff, siehe Dateikopf). So bleibt nichts
    // lautlos in einer bereits eingereichten Periode hängen.
    let verschobeneRechnungen = 0;
    let verschobenePruefungen = 0;
    let verschobenePins = 0;
    for (const z of ziel.rows) {
      const periodeCol = z.kostentraeger === 'PKV' ? 'abrechnungsperiode_pkv' : 'abrechnungsperiode_beihilfe';
      const coll = await client.query(
        `SELECT periode FROM abrechnungsperiode_buch WHERE person = $1 AND kostentraeger = $2 AND status = 'COLLECTING'`,
        [z.person, z.kostentraeger]
      );
      if (coll.rows.length === 0) continue;
      const neuePeriode = coll.rows[0].periode;

      const movedRg = await client.query(
        `UPDATE arztrechnung SET ${periodeCol} = $1
         WHERE behandelte_person = $2 AND ${periodeCol} = $3
           AND (bestritten_betrag > 0 OR NOT (postid = ANY($4::text[])))
         RETURNING postid`,
        [neuePeriode, z.person, z.periode, z.snapshot_postids]
      );
      verschobeneRechnungen += movedRg.rows.length;

      if (z.kostentraeger === 'PKV') {
        const movedPruef = await client.query(
          `UPDATE beihilfe_kuerzung_pkv_pruefung
           SET periode = $1, vorherige_periode = $3
           WHERE person = $2 AND kostentraeger = 'PKV' AND periode = $3 AND status = 'VORGEMERKT'
           RETURNING eb_postid`,
          [neuePeriode, z.person, z.periode]
        );
        verschobenePruefungen += movedPruef.rows.length;
      }

      const movedPins = await client.query(
        `UPDATE dokument_pin SET periode = $1
         WHERE person = $2 AND kostentraeger = $3 AND periode = $4 AND status = 'VORGEMERKT'
         RETURNING postid`,
        [neuePeriode, z.person, z.kostentraeger, z.periode]
      );
      verschobenePins += movedPins.rows.length;
    }

    await client.query(`UPDATE _abrechnung_session_ziel SET aktiv = false WHERE session_id = $1`, [sessionId]);
    await client.query(
      `UPDATE _abrechnung_sessions SET status = 'confirmed', completed_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [sessionId]
    );

    await client.query('COMMIT');
    summary = { verschobeneRechnungen, verschobenePruefungen, verschobenePins, bre: breErgebnis };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  await removeArtefakte(sessionId);
  if (summary.verschobeneRechnungen + summary.verschobenePruefungen + summary.verschobenePins > 0) {
    appLog('INFO', 'abrechnungsperiode',
      `Session ${sessionId}: nachträglich hinzugekommen und in Folgeperiode verschoben — ` +
      `${summary.verschobeneRechnungen} Rechnung(en), ${summary.verschobenePruefungen} Prüfvormerkung(en), ${summary.verschobenePins} Anpinnung(en)`);
  }
  for (const b of summary.bre) {
    appLog('INFO', 'abrechnungsperiode',
      `Session ${sessionId}: BRE ${b.person} – aufgegeben [${b.aufgeben.join(', ')}], `
      + `eingereichte BRE-Perioden [${b.eingereichtePerioden.join(', ')}], `
      + `zurückgehalten: ${b.zurueckgehalten.map((x) => `${x.postid}→${x.jahr} (Periode ${x.periode})`).join(', ') || 'keine'}`
      + (b.neuePerioden.length ? `, neu angelegt: ${b.neuePerioden.map((x) => `${x.jahr}=Periode ${x.periode}`).join(', ')}` : ''),
      { entity: 'abrechnungsperiode', entityId: `${b.person}/PKV` });
  }
  appLog('INFO', 'abrechnungsperiode', `Session bestätigt: ${sessionId}`);
  return summary;
}

/**
 * BRE-Teil des Bestätigens (Phase 7). Läuft in der Bestätigungstransaktion
 * nach dem SUBMITTED-Update und vor der Folgeperiode; die Periodensperre der
 * Personen ist bereits genommen. Verbindlich ist die beim Start gespeicherte
 * Entscheidung (`bre_entscheidung`, `bre_halten`).
 * @returns {Promise<Array>} je Person, was geschehen ist (für Log und Antwort)
 */
async function bestaetigeBre(client, breEntscheidung, zielRows) {
  const ergebnis = [];
  if (!breEntscheidung) return ergebnis;

  for (const [person, e] of Object.entries(breEntscheidung)) {
    const eigene = zielRows.filter((z) => z.person === person && z.kostentraeger === 'PKV');
    const info = {
      person,
      aufgeben: e.aufgeben || [],
      eingereichtePerioden: (e.breZiele || []).map((b) => b.periode),
      zurueckgehalten: [],
      neuePerioden: [],
    };

    const zielJahre = new Set();
    for (const z of eigene) for (const jahr of Object.values(z.bre_halten || {})) zielJahre.add(Number(jahr));

    const periodeJeJahr = new Map();
    for (const jahr of [...zielJahre].sort((a, b) => a - b)) {
      const vorhanden = await client.query(
        `SELECT periode FROM abrechnungsperiode_buch
          WHERE person = $1 AND kostentraeger = 'PKV' AND status = 'WITHHELD' AND bre_jahr = $2
          FOR UPDATE`,
        [person, jahr]
      );
      if (vorhanden.rows.length > 0) {
        periodeJeJahr.set(jahr, vorhanden.rows[0].periode);
        continue;
      }
      if (e.schwelle == null) {
        throw new Error(`BRE ${person}: keine Schwelle für das neue Jahr ${jahr} gespeichert`);
      }
      const neu = await client.query(
        `INSERT INTO abrechnungsperiode_buch (person, kostentraeger, periode, status, satz, bre_jahr, bre_schwelle)
         SELECT $1, 'PKV', COALESCE(MAX(ab.periode), 0) + 1, 'WITHHELD',
                (SELECT pkv_satz FROM postbuch.mensch WHERE kurzname = $1), $2, $3
           FROM abrechnungsperiode_buch ab
          WHERE ab.person = $1 AND ab.kostentraeger = 'PKV'
         RETURNING periode`,
        [person, jahr, e.schwelle]
      );
      periodeJeJahr.set(jahr, neu.rows[0].periode);
      info.neuePerioden.push({ jahr, periode: neu.rows[0].periode });
    }

    for (const z of eigene) {
      const nachJahr = new Map();
      for (const [postid, jahr] of Object.entries(z.bre_halten || {})) {
        if (!nachJahr.has(Number(jahr))) nachJahr.set(Number(jahr), []);
        nachJahr.get(Number(jahr)).push(postid);
      }
      for (const [jahr, postids] of nachJahr) {
        const nach = periodeJeJahr.get(jahr);
        if (nach == null || nach === z.periode) continue;
        // Inzwischen bestrittene Rechnungen gehen den üblichen Weg in die
        // Folgeperiode (Umzug weiter unten in confirmAbrechnungsperiode).
        const moved = await client.query(
          `UPDATE arztrechnung SET abrechnungsperiode_pkv = $1
            WHERE behandelte_person = $2 AND abrechnungsperiode_pkv = $3
              AND postid = ANY($4::text[]) AND COALESCE(bestritten_betrag, 0) <= 0
            RETURNING postid`,
          [nach, person, z.periode, postids]
        );
        const ids = moved.rows.map((r) => r.postid);
        await verschiebePruefvormerkungen(client, person, z.periode, nach, ids);
        for (const postid of ids) info.zurueckgehalten.push({ postid, jahr, periode: nach });
      }
    }
    ergebnis.push(info);
  }
  return ergebnis;
}

// ── Phase 3 (Ablehnen): Reject ────────────────────────────────────────────────

export async function rejectAbrechnungsperiode(sessionId) {
  if (await isLegacySession(sessionId)) return legacyReject(sessionId);

  const changed = await abortBuildingSession(sessionId, 'rejected');
  if (!changed) throw new Error(`Session ${sessionId} nicht gefunden oder nicht mehr offen`);
  appLog('INFO', 'abrechnungsperiode', `Session verworfen: ${sessionId}`);
}

// ── Offene Sessions / Stale-Cleanup ───────────────────────────────────────────

async function isSessionStaleHardened(sessionId) {
  const ziel = await pool.query(
    `SELECT ab.status
     FROM _abrechnung_session_ziel z
     LEFT JOIN abrechnungsperiode_buch ab
       ON ab.person = z.person AND ab.kostentraeger = z.kostentraeger AND ab.periode = z.periode
     WHERE z.session_id = $1 AND z.aktiv`,
    [sessionId]
  );
  if (ziel.rows.length === 0) return true;
  // WITHHELD: BRE-Periode eines aufgegebenen Jahres, ebenfalls ein gültiges Ziel.
  return ziel.rows.some((r) => r.status !== 'COLLECTING' && r.status !== 'WITHHELD');
}

async function cleanupStaleSession(row) {
  try {
    if (await isLegacySession(row.id)) {
      const upd = await pool.query(
        `UPDATE _abrechnung_sessions SET status = 'obsolete', completed_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND status = 'pending' RETURNING id`,
        [row.id]
      );
      if (upd.rowCount > 0) {
        await legacyCleanupFiles(row.groups);
        appLog('INFO', 'abrechnungsperiode', `Stale Session (Legacy) aufgeräumt: ${row.id}`);
      }
      return;
    }
    const changed = await abortBuildingSession(row.id, 'obsolete');
    if (changed) {
      appLog('INFO', 'abrechnungsperiode', `Stale Session aufgeräumt: ${row.id} (Ziel-Periode nicht mehr COLLECTING)`);
    }
  } catch (err) {
    appLog('ERROR', 'abrechnungsperiode', `Stale-Cleanup fehlgeschlagen für ${row.id}: ${err.message}`);
  }
}

/** Offene (pending) Sessions — für Wiederaufnahme. Räumt Stale-Sessions im Hintergrund auf. */
export async function getPendingSessions() {
  const result = await pool.query(
    `SELECT id, status, groups, created_at, expires_at, ausgeliefert_at FROM _abrechnung_sessions
     WHERE status = 'pending' ORDER BY created_at DESC`
  );

  const valid = [];
  const stale = [];
  for (const row of result.rows) {
    const isStale = (await isLegacySession(row.id))
      ? await legacyIsSessionStale(row.groups)
      : await isSessionStaleHardened(row.id);
    if (isStale) stale.push(row); else valid.push(row);
  }

  if (stale.length > 0) {
    Promise.all(stale.map((row) => cleanupStaleSession(row))).catch(() => {});
  }

  return valid;
}

export async function getSessionById(sessionId) {
  const result = await pool.query(
    `SELECT id, status, groups, created_at, expires_at, completed_at, ausgeliefert_at FROM _abrechnung_sessions WHERE id = $1`,
    [sessionId]
  );
  return result.rows[0] ?? null;
}

/**
 * Merkt den ersten Download bzw. das erste Teilen eines fertigen PDFs. Ab dann
 * läuft die Session nicht mehr ab (siehe autoAbortExpiredAbrechnungsSessions):
 * Die Abrechnung kann schon beim Kostenträger liegen, ein Timeout würde die
 * Perioden unbemerkt offen lassen.
 * @returns {Promise<boolean>} false, wenn die Session nicht (mehr) offen ist
 */
export async function markiereAbrechnungAusgeliefert(sessionId) {
  const result = await pool.query(
    `UPDATE _abrechnung_sessions
        SET ausgeliefert_at = COALESCE(ausgeliefert_at, NOW()), updated_at = NOW()
      WHERE id = $1 AND status = 'pending'
      RETURNING ausgeliefert_at`,
    [sessionId]
  );
  return result.rows.length > 0;
}

/** Backend-bewusster Artefakt-Lookup für die PDF-Proxy-Routen (siehe routes/abrechnungsperiode.js). */
export async function getArtefaktByTypSort(sessionId, typ, sortierung) {
  const r = await pool.query(`SELECT artefakte FROM _abrechnung_sessions WHERE id = $1`, [sessionId]);
  const artefakte = r.rows[0]?.artefakte ?? [];
  const a = artefakte.find((e) => e.typ === typ && e.sortierung === sortierung);
  return a ? { storage_backend: a.storage_backend, storage_id: a.storage_id, dateiname: a.dateiname } : null;
}

export { isLegacySession };

// ── Auto-Abort: abgelaufene/hängende Sessions aufräumen ──────────────────────

export async function autoAbortExpiredAbrechnungsSessions() {
  // 1) 'pending' älter als 2h (Timeout) – außer, ein PDF wurde schon
  //    heruntergeladen oder geteilt (siehe markiereAbrechnungAusgeliefert)
  const expiredPending = await pool.query(
    `SELECT id, groups FROM _abrechnung_sessions
     WHERE status = 'pending'
       AND ausgeliefert_at IS NULL
       AND ((expires_at IS NOT NULL AND expires_at <= NOW()) OR created_at <= NOW() - INTERVAL '2 hours')`
  );
  for (const row of expiredPending.rows) {
    try {
      if (await isLegacySession(row.id)) {
        await pool.query(
          `UPDATE _abrechnung_sessions SET status = 'timed_out', completed_at = NOW(), updated_at = NOW() WHERE id = $1`,
          [row.id]
        );
        await legacyCleanupFiles(row.groups);
      } else {
        await abortBuildingSession(row.id, 'timed_out');
      }
      appLog('INFO', 'abrechnungsperiode', `Session auto-abgebrochen (Timeout): ${row.id}`);
    } catch (err) {
      appLog('ERROR', 'abrechnungsperiode', `Auto-Abort fehlgeschlagen für ${row.id}: ${err.message}`);
    }
  }

  // 2) 'building' mit Heartbeat älter als 30 Minuten (z.B. Crash mitten in Phase 5)
  const staleBuilding = await pool.query(
    `SELECT id FROM _abrechnung_sessions WHERE status = 'building' AND updated_at <= NOW() - INTERVAL '30 minutes'`
  );
  for (const row of staleBuilding.rows) {
    try {
      await abortBuildingSession(row.id, 'error');
      appLog('INFO', 'abrechnungsperiode', `Hängende building-Session aufgeräumt: ${row.id}`);
    } catch (err) {
      appLog('ERROR', 'abrechnungsperiode', `Building-Cleanup fehlgeschlagen für ${row.id}: ${err.message}`);
    }
  }

  // 3) Stale-basiert: Ziel-Periode nicht mehr COLLECTING
  const stillPending = await pool.query(`SELECT id, groups FROM _abrechnung_sessions WHERE status = 'pending'`);
  for (const row of stillPending.rows) {
    const isStale = (await isLegacySession(row.id))
      ? await legacyIsSessionStale(row.groups)
      : await isSessionStaleHardened(row.id);
    if (isStale) await cleanupStaleSession(row);
  }
}

/** Cron alle 15 Minuten. Zusätzlich einmal beim App-Start aufrufen (siehe index.js) — deckt den Crash-/Restart-Fall ab. */
export function startAbrechnungSessionCleaner() {
  cron.schedule('*/15 * * * *', async () => {
    try {
      await autoAbortExpiredAbrechnungsSessions();
    } catch (err) {
      appLog('ERROR', 'abrechnungsperiode', `Cleaner-Cron-Fehler: ${err.message}`);
    }
  });
  appLog('INFO', 'abrechnungsperiode', 'Abrechnung-Session-Cleaner gestartet (alle 15 Minuten)');
}

// ── Legacy-Pfad (Alt-Sessions ohne _abrechnung_session_ziel-Zeilen) ───────────
// Rückbau-Notiz: kann entfernt werden, sobald keine vor diesem Deploy gestartete
// pending-Session mehr existiert (Cron/Timeout räumt sie spätestens nach 2h weg).

async function legacyGetSession(sessionId) {
  const result = await pool.query(`SELECT * FROM _abrechnung_sessions WHERE id = $1 AND status = 'pending'`, [sessionId]);
  if (result.rows.length === 0) throw new Error(`Session ${sessionId} nicht gefunden oder nicht mehr offen`);
  return result.rows[0];
}

async function legacyCleanupFiles(groups) {
  if (!Array.isArray(groups)) return;
  const ids = [];
  for (const g of groups) {
    if (g.pdfOneDriveId) ids.push(g.pdfOneDriveId);
    if (Array.isArray(g.chunks)) for (const c of g.chunks) if (c.oneDriveId) ids.push(c.oneDriveId);
  }
  const storage = await getActiveAdapter();
  await Promise.allSettled(ids.map((id) => storage.remove(id)));
}

async function legacyIsSessionStale(groups) {
  if (!Array.isArray(groups) || groups.length === 0) return true;
  for (const group of groups) {
    const persons = Array.isArray(group.persons) ? group.persons : [];
    const perioden = Array.isArray(group.perioden) ? group.perioden : [];
    const kt = group.kostentraeger;
    if (persons.length === 0 || perioden.length === 0 || !kt) return true;
    for (const periode of perioden) {
      const r = await pool.query(
        `SELECT 1 FROM abrechnungsperiode_buch
         WHERE person = ANY($1::text[]) AND kostentraeger = $2 AND periode = $3 AND status = 'COLLECTING' LIMIT 1`,
        [persons, kt, periode]
      );
      if (r.rows.length === 0) return true;
    }
  }
  return false;
}

async function legacyConfirm(sessionId) {
  const session = await legacyGetSession(sessionId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await sperrePerioden(client, session.groups.flatMap((group) => (
      (Array.isArray(group.persons) ? group.persons : [])
        .map((person) => ({ person, kostentraeger: group.kostentraeger }))
    )));
    await legacyConfirmGruppen(client, session.groups);
    await client.query(
      `UPDATE _abrechnung_sessions SET status = 'confirmed', completed_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [sessionId]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  await legacyCleanupFiles(session.groups);
  appLog('INFO', 'abrechnungsperiode', `Session bestätigt (Legacy): ${sessionId}`);
}

async function legacyConfirmGruppen(client, groups) {
  for (const group of groups) {
    const kt = group.kostentraeger;
    const perioden = Array.isArray(group.perioden) ? group.perioden : [];
    const persons = Array.isArray(group.persons) ? group.persons : [];
    await client.query(
      `UPDATE abrechnungsperiode_buch SET status = 'SUBMITTED'
       WHERE person = ANY($1::text[]) AND kostentraeger = $2 AND periode = ANY($3::int[]) AND status = 'COLLECTING'`,
      [persons, kt, perioden]
    );
    await client.query(
      `INSERT INTO abrechnungsperiode_buch (person, kostentraeger, periode, status, satz)
       SELECT ab.person, ab.kostentraeger, MAX(ab.periode) + 1, 'COLLECTING',
              CASE ab.kostentraeger WHEN 'PKV' THEN p.pkv_satz ELSE p.beihilfe_satz END
       FROM abrechnungsperiode_buch ab
       JOIN postbuch.mensch p ON p.kurzname = ab.person
       WHERE ab.person = ANY($1::text[]) AND ab.kostentraeger = $2
       GROUP BY ab.person, ab.kostentraeger, p.pkv_satz, p.beihilfe_satz
       HAVING NOT EXISTS (
         SELECT 1 FROM abrechnungsperiode_buch x
         WHERE x.person = ab.person AND x.kostentraeger = ab.kostentraeger AND x.status = 'COLLECTING'
       )
       ON CONFLICT (person, kostentraeger, periode) DO NOTHING`,
      [persons, kt]
    );
  }
}

async function legacyReject(sessionId) {
  const session = await legacyGetSession(sessionId);
  await pool.query(
    `UPDATE _abrechnung_sessions SET status = 'rejected', completed_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [sessionId]
  );
  await legacyCleanupFiles(session.groups);
  appLog('INFO', 'abrechnungsperiode', `Session verworfen (Legacy): ${sessionId}`);
}
