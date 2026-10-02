/**
 * Kanonische Menschen-API — die einzige schreibende Identitätsschnittstelle.
 *
 * Fachliche Person und App-Zugang liegen gemeinsam in `postbuch.mensch`. Die
 * früheren Tabellen `person`/`users` sind abgelöst; `routes/personen.js` ist nur
 * noch ein lesender Alias.
 */
import { Router } from 'express';
import { getClient, query } from '../db.js';
import { hashPassword } from '../auth-salt.js';
import { revokeUserAccess } from '../service/session-revocation.js';
import { ensureMenschCollectingPeriods } from '../service/mensch-perioden.js';
import {
  erstelleVorschau, loescheMensch, startePapierkorbLauf, LoeschFehler,
} from '../service/mensch-loeschung.js';
import { appLog } from '../app-log.js';
import { istZugangsAenderung } from '../lib/zugang-aenderung.js';
import { getGesamteTaxonomie } from '../lib/taxonomie.js';
import { GEMEINSAM_ORDNER } from '../service/storage-setup.js';
import { raeumeAblageNachLoeschung, benennePersonenordnerUm } from '../service/ablage-sollort.js';

const router = Router();
const NAME_RE = /^[a-zA-Z0-9_.-]{1,64}$/;
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const ROLLEN = new Set(['vollzugriff', 'lesezugriff']);
const LESEBEREICHE = new Set(['alle', 'eigene']);

/**
 * Der Kurzname ist bei Personenablage zugleich Ordnername auf erster Ebene.
 * Er darf deshalb weder mit dem Sammelordner, den Systemordnern (`_…`),
 * versteckten Ordnern (`.…`) noch mit einem Lebensbereichsordner kollidieren.
 * Groß-/Kleinschreibungs-Dubletten sind ausgeschlossen, weil OneDrive und
 * viele Sync-Clients Ordnernamen ohne Beachtung der Schreibweise vergleichen.
 */
async function pruefeKurznameAlsOrdner(executor, kurzname, eigeneId = null) {
  const klein = kurzname.toLowerCase();
  if (/^[_.]/.test(kurzname)) return 'Kurzname darf nicht mit _ oder . beginnen.';
  if (klein === GEMEINSAM_ORDNER.toLowerCase()) return `„${GEMEINSAM_ORDNER}“ ist als Ordnername reserviert.`;
  const taxonomie = await getGesamteTaxonomie();
  if (taxonomie.lebensbereiche.some((l) => String(l.label).toLowerCase() === klein)) {
    return 'Kurzname entspricht einem Lebensbereich und ist als Ordnername reserviert.';
  }
  const r = await executor(
    'SELECT 1 FROM postbuch.mensch WHERE lower(kurzname) = $1 AND ($2::uuid IS NULL OR id <> $2)',
    [klein, eigeneId],
  );
  if (r.rowCount) return 'Kurzname ist bereits vergeben (Groß-/Kleinschreibung wird nicht unterschieden).';
  return null;
}

function fehler(res, status, text, details = {}) {
  return res.status(status).json({ error: text, ...details });
}

function loeschFehler(res, err) {
  return fehler(res, err.status, err.message, {
    ...(err.code ? { code: err.code } : {}),
    ...(err.postid ? { postid: err.postid } : {}),
    ...(err.erstattungsbescheide ? { erstattungsbescheide: err.erstattungsbescheide } : {}),
    ...(err.hinweis ? { hinweis: err.hinweis } : {}),
  });
}

function normalisiere(body, alt = null) {
  const kurzname = String(body.kurzname ?? alt?.kurzname ?? '').trim();
  const anzeigename = String(body.anzeigename ?? alt?.anzeigename ?? '').trim();
  if (!NAME_RE.test(kurzname)) throw new Error('Kurzname ist ungültig (1–64 Zeichen).');
  if (!anzeigename || anzeigename.length > 160) throw new Error('Anzeigename ist ungültig.');
  const farbe = body.farbe === undefined ? alt?.farbe ?? null : (body.farbe || null);
  if (farbe && !HEX_COLOR_RE.test(farbe)) throw new Error('Farbe muss #RRGGBB entsprechen.');
  const loginfaehig = body.loginfaehig ?? alt?.loginfaehig ?? false;
  const istTier = Boolean(body.ist_tier ?? alt?.ist_tier ?? false);
  const anmeldename = String(body.anmeldename ?? alt?.anmeldename ?? kurzname).trim();
  const rolle = body.rolle ?? alt?.rolle ?? 'lesezugriff';
  const prozentsatz = (wert, feld) => {
    if (wert == null || wert === '') return null;
    const zahl = Number(wert);
    if (!Number.isFinite(zahl) || zahl < 0 || zahl > 100) {
      throw new Error(`${feld} muss zwischen 0 und 100 liegen.`);
    }
    return zahl;
  };
  if (loginfaehig && (!NAME_RE.test(anmeldename) || anmeldename.toLowerCase() === 'admin')) {
    throw new Error('Anmeldename ist ungültig oder reserviert.');
  }
  if (loginfaehig && !ROLLEN.has(rolle)) throw new Error('Ungültige Rolle.');
  const lesebereichRoh = body.lesebereich ?? alt?.lesebereich ?? 'alle';
  if (!LESEBEREICHE.has(lesebereichRoh)) throw new Error('Ungültiger Lesebereich.');
  const gespeicherteRolle = loginfaehig ? rolle : (alt?.rolle ?? null);
  // „Nur eigene Dokumente“ gibt es ausschließlich für Lesezugriff; jeder
  // Rollenwechsel weg davon setzt den Bereich zurück (CHECK mensch_lesebereich_ck).
  const lesebereich = gespeicherteRolle === 'lesezugriff' ? lesebereichRoh : 'alle';
  const beihilfe = body.beihilfe ?? alt?.beihilfe ?? false;
  if (istTier && beihilfe) throw new Error('Für Tiere ist nur Tier-PKV möglich, keine Beihilfe.');
  if (istTier && loginfaehig) throw new Error('Ein Tier kann keinen App-Zugang erhalten.');
  return {
    kurzname,
    anzeigename,
    email: body.email === undefined ? alt?.email ?? null : (String(body.email || '').trim() || null),
    aktiv: body.aktiv ?? alt?.aktiv ?? true,
    archiviert: body.archiviert ?? alt?.archiviert ?? false,
    pkv: body.pkv ?? alt?.pkv ?? false,
    beihilfe,
    istTier,
    pkvSatz: prozentsatz(body.pkv_satz === undefined ? alt?.pkv_satz : body.pkv_satz, 'PKV-Satz'),
    beihilfeSatz: prozentsatz(body.beihilfe_satz === undefined ? alt?.beihilfe_satz : body.beihilfe_satz, 'Beihilfe-Satz'),
    farbe,
    loginfaehig: Boolean(loginfaehig),
    anmeldename: loginfaehig ? anmeldename : (alt?.anmeldename ?? null),
    rolle: gespeicherteRolle,
    lesebereich,
  };
}

router.get('/', async (_req, res) => {
  try {
    const r = await query(`
      SELECT m.id, m.kurzname, m.anmeldename, m.anzeigename, m.email,
             m.loginfaehig, m.rolle, m.lesebereich, m.aktiv, m.archiviert, m.ist_tier, m.pkv, m.beihilfe,
             m.pkv_satz, m.beihilfe_satz, m.farbe, m.created_at, m.updated_at,
             (SELECT count(*)::int FROM postbuch.arztrechnung WHERE behandelte_person=m.kurzname) AS arz_count,
             (SELECT count(*)::int FROM postbuch.arztbericht WHERE behandelte_person=m.kurzname) AS ab_count,
             (SELECT count(*)::int FROM postbuch.erstattungsbescheid_einzelposition WHERE behandelte_person=m.kurzname) AS eb_count,
             (SELECT count(*)::int FROM postbuch.postbuch WHERE familienmitglied=m.kurzname) AS adr_count,
             -- Distinkte Dokumente, in denen die Person Patient ist (Einzelpositionen sonst mehrfach gezählt)
             (SELECT count(*)::int FROM (
                SELECT postid FROM postbuch.arztrechnung WHERE behandelte_person=m.kurzname
                UNION SELECT postid FROM postbuch.arztbericht WHERE behandelte_person=m.kurzname
                UNION SELECT postid FROM postbuch.erstattungsbescheid_einzelposition WHERE behandelte_person=m.kurzname
              ) AS pd) AS patient_doc_count
        FROM postbuch.mensch m ORDER BY m.archiviert, m.anzeigename, m.kurzname`);
    res.json(r.rows);
  } catch (err) {
    console.error('[menschen] Liste:', err);
    res.status(500).json({ error: 'Menschen konnten nicht geladen werden.' });
  }
});

/**
 * Anmeldenamen sind ohne Groß-/Kleinschreibung eindeutig: der Login und die
 * Sperre nach Fehlversuchen vergleichen genauso. Der Index
 * mensch_anmeldename_lower_uq sichert das zusätzlich in der DB ab.
 */
async function anmeldenameVergeben(q, anmeldename, eigeneId = null) {
  const r = await q(
    `SELECT 1 FROM postbuch.mensch
      WHERE lower(anmeldename) = lower($1) AND ($2::uuid IS NULL OR id <> $2::uuid)
      LIMIT 1`,
    [anmeldename, eigeneId],
  );
  return r.rowCount > 0;
}

router.post('/', async (req, res) => {
  let daten;
  try { daten = normalisiere(req.body || {}); } catch (err) { return fehler(res, 400, err.message); }
  const passwort = req.body?.password;
  if (daten.loginfaehig && (!passwort || String(passwort).length < 6)) {
    return fehler(res, 400, 'Für einen Login ist ein Passwort mit mindestens 6 Zeichen erforderlich.');
  }
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const kollision = await pruefeKurznameAlsOrdner(client.query.bind(client), daten.kurzname);
    if (kollision) { await client.query('ROLLBACK'); return fehler(res, 409, kollision); }
    if (daten.loginfaehig && await anmeldenameVergeben(client.query.bind(client), daten.anmeldename)) {
      await client.query('ROLLBACK'); return fehler(res, 409, 'Anmeldename ist bereits vergeben (Groß-/Kleinschreibung zählt nicht).');
    }
    const passwordHash = daten.loginfaehig ? hashPassword(daten.anmeldename, passwort) : null;
    const m = await client.query(
      `INSERT INTO postbuch.mensch
        (kurzname, anmeldename, anzeigename, email, loginfaehig, password_hash, rolle,
         aktiv, archiviert, ist_tier, pkv, beihilfe, pkv_satz, beihilfe_satz, farbe, lesebereich)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING id`,
      [daten.kurzname, daten.loginfaehig ? daten.anmeldename : null, daten.anzeigename,
        daten.email, daten.loginfaehig, passwordHash, daten.loginfaehig ? daten.rolle : null,
        daten.aktiv, daten.archiviert, daten.istTier, daten.pkv, daten.beihilfe,
        daten.pkvSatz, daten.beihilfeSatz, daten.farbe,
        daten.loginfaehig ? daten.lesebereich : 'alle'],
    );
    const id = m.rows[0].id;
    await ensureMenschCollectingPeriods(client.query.bind(client), {
      kurzname: daten.kurzname,
      pkv: daten.pkv,
      beihilfe: daten.beihilfe,
      pkvSatz: daten.pkvSatz,
      beihilfeSatz: daten.beihilfeSatz,
    });
    await client.query('COMMIT');
    appLog('INFO', 'mensch', 'Mensch angelegt', { entity: 'mensch', entityId: id });
    res.status(201).json({ id });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') return fehler(res, 409, 'Kurz- oder Anmeldename ist bereits vergeben.');
    console.error('[menschen] Anlegen:', err);
    res.status(500).json({ error: 'Mensch konnte nicht angelegt werden.' });
  } finally { client.release(); }
});

router.patch('/:id', async (req, res) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const found = await client.query('SELECT * FROM postbuch.mensch WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (!found.rowCount) { await client.query('ROLLBACK'); return fehler(res, 404, 'Mensch nicht gefunden.'); }
    const alt = found.rows[0];
    let daten;
    try { daten = normalisiere(req.body || {}, alt); } catch (err) {
      await client.query('ROLLBACK'); return fehler(res, 400, err.message);
    }
    const loginRename = daten.loginfaehig && alt.anmeldename && daten.anmeldename !== alt.anmeldename;
    if (loginRename && !String(alt.password_hash || '').startsWith('scrypt$') && !req.body?.password) {
      await client.query('ROLLBACK');
      return fehler(res, 409, 'Vor dem Umbenennen muss das alte Passwortformat durch Login oder Passwort-Neusetzen aktualisiert werden.');
    }
    if (daten.loginfaehig && daten.anmeldename !== alt.anmeldename
      && await anmeldenameVergeben(client.query.bind(client), daten.anmeldename, alt.id)) {
      await client.query('ROLLBACK'); return fehler(res, 409, 'Anmeldename ist bereits vergeben (Groß-/Kleinschreibung zählt nicht).');
    }
    let passwordHash = alt.password_hash;
    if (req.body?.password !== undefined) {
      if (String(req.body.password).length < 6) { await client.query('ROLLBACK'); return fehler(res, 400, 'Passwort zu kurz.'); }
      passwordHash = hashPassword(daten.anmeldename, req.body.password);
    }
    if (daten.loginfaehig && !passwordHash) {
      await client.query('ROLLBACK'); return fehler(res, 400, 'Zum Aktivieren ist ein Passwort erforderlich.');
    }

    if (daten.kurzname !== alt.kurzname) {
      const kollision = await pruefeKurznameAlsOrdner(client.query.bind(client), daten.kurzname, alt.id);
      if (kollision) { await client.query('ROLLBACK'); return fehler(res, 409, kollision); }
      await client.query('UPDATE postbuch.abrechnungsperiode_buch SET person=$2 WHERE person=$1', [alt.kurzname, daten.kurzname]);
      await client.query('UPDATE postbuch.arztrechnung SET behandelte_person=$2 WHERE behandelte_person=$1', [alt.kurzname, daten.kurzname]);
      await client.query('UPDATE postbuch.arztbericht SET behandelte_person=$2 WHERE behandelte_person=$1', [alt.kurzname, daten.kurzname]);
      await client.query('UPDATE postbuch.erstattungsbescheid_einzelposition SET behandelte_person=$2 WHERE behandelte_person=$1', [alt.kurzname, daten.kurzname]);
      await client.query('UPDATE postbuch.postbuch SET familienmitglied=$2 WHERE familienmitglied=$1', [alt.kurzname, daten.kurzname]);
    }
    const zugangGeaendert = istZugangsAenderung({
      alt,
      neu: daten,
      loginRename,
      passwordHash,
    });
    if (zugangGeaendert) await revokeUserAccess({ menschId: alt.id, username: alt.anmeldename }, client.query.bind(client));

    await ensureMenschCollectingPeriods(client.query.bind(client), {
      kurzname: daten.kurzname,
      pkv: daten.pkv,
      beihilfe: daten.beihilfe,
      pkvSatz: daten.pkvSatz,
      beihilfeSatz: daten.beihilfeSatz,
    });

    await client.query(
      `UPDATE postbuch.mensch SET kurzname=$2,anzeigename=$3,email=$4,aktiv=$5,
       archiviert=$6,ist_tier=$7,pkv=$8,beihilfe=$9,pkv_satz=$10,beihilfe_satz=$11,farbe=$12,
       loginfaehig=$13,anmeldename=$14,password_hash=$15,rolle=$16,lesebereich=$17,
       -- Eingeschränkte Nutzer erhalten keine Pushes; alte Abos verfallen.
       webpush_subscriptions = CASE WHEN $17 = 'eigene' THEN '[]'::jsonb ELSE webpush_subscriptions END,
       updated_at=now() WHERE id=$1`,
      [alt.id, daten.kurzname, daten.anzeigename, daten.email, daten.aktiv,
        daten.archiviert, daten.istTier, daten.pkv, daten.beihilfe, daten.pkvSatz,
        daten.beihilfeSatz, daten.farbe, daten.loginfaehig, daten.anmeldename,
        passwordHash, daten.rolle, daten.lesebereich],
    );
    await client.query('COMMIT');
    appLog('INFO', 'mensch', 'Mensch aktualisiert', { entity: 'mensch', entityId: alt.id });
    res.json({ ok: true, reauthenticate: zugangGeaendert });
    if (daten.kurzname !== alt.kurzname) {
      benennePersonenordnerUm(alt.id, daten.kurzname)
        .catch((err) => appLog('WARN', 'ablage', `Personenordner nicht umbenannt: ${err.message}`));
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') return fehler(res, 409, 'Kurz- oder Anmeldename ist bereits vergeben.');
    console.error('[menschen] Update:', err);
    res.status(500).json({ error: 'Mensch konnte nicht aktualisiert werden.' });
  } finally { client.release(); }
});

// GET /:id/loesch-vorschau — was würde ein endgültiges Löschen anrichten?
// Rein lesend. Die Zahlen sind Entscheidungsgrundlage für das UI, aber keine
// Autorisierung: die Ausführung ermittelt alles noch einmal selbst.
router.get('/:id/loesch-vorschau', async (req, res) => {
  try {
    res.json(await erstelleVorschau(req.params.id));
  } catch (err) {
    if (err instanceof LoeschFehler) return loeschFehler(res, err);
    console.error('[menschen] Löschvorschau:', err);
    res.status(500).json({ error: 'Vorschau konnte nicht erstellt werden.' });
  }
});

// POST /:id/loeschen — endgültiges Löschen eines archivierten Menschen.
// Modus 'bezuege' entwertet nur die Zuordnungen, 'dokumente' löscht die
// Dokumente mit und verlangt zusätzlich den getippten Bestätigungssatz.
router.post('/:id/loeschen', async (req, res) => {
  try {
    const { zusammenfassung, papierkorb, ablage } = await loescheMensch({
      id: req.params.id,
      modus: req.body?.modus,
      bestaetigung: req.body?.bestaetigung,
      akteur: req.session?.username || 'admin',
    });
    const jobId = startePapierkorbLauf(papierkorb, zusammenfassung.kurzname,
      () => raeumeAblageNachLoeschung({ ...ablage, kurzname: zusammenfassung.kurzname }));
    res.json({ ok: true, ...zusammenfassung, jobId });
  } catch (err) {
    if (err instanceof LoeschFehler) return loeschFehler(res, err);
    console.error('[menschen] Löschen:', err);
    res.status(500).json({ error: 'Mensch konnte nicht gelöscht werden.' });
  }
});

// Der schlichte Weg: löscht nur, wenn nirgends mehr ein Bezug hängt. Hängt
// doch einer, verweist die Fehlermeldung auf die beiden Modi oben.
router.delete('/:id', async (req, res) => {
  try {
    const { zusammenfassung, ablage } = await loescheMensch({ id: req.params.id, modus: 'nur-frei', akteur: req.session?.username || 'admin' });
    raeumeAblageNachLoeschung({ ...ablage, kurzname: zusammenfassung.kurzname })
      .catch((err) => appLog('WARN', 'ablage', `Personenordner nicht aufgeräumt: ${err.message}`));
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof LoeschFehler) return loeschFehler(res, err);
    console.error('[menschen] Löschen:', err);
    res.status(500).json({ error: 'Mensch konnte nicht gelöscht werden.' });
  }
});

export default router;
