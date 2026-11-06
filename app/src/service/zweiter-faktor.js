/**
 * service/zweiter-faktor.js — Zwei-Faktor-Anmeldung per TOTP
 *
 * Einzige Stelle, die postbuch.totp_faktor liest und schreibt. Ein Konto ist
 * entweder der Admin ({ istAdmin: true }) oder ein Mensch ({ menschId }).
 *
 * Das Geheimnis liegt AES-256-GCM-verschlüsselt in der Tabelle. Der Schlüssel
 * ist das eigene Geheimnis-Setting `zweiter_faktor_secret`: Er reist nur in
 * verschlüsselten Backups mit. Fehlt er nach einem Restore aus einer
 * unverschlüsselten Sicherung, ist das Geheimnis unlesbar („defekt“); dann
 * helfen die Wiederherstellungscodes (nur Hashes, unabhängig vom Schlüssel),
 * der Admin-Reset bzw. der Notschalter.
 */
import {
  createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual,
} from 'node:crypto';
import { query, getClient } from '../db.js';
import { appLog } from '../app-log.js';
import { base32Kodieren, neuesGeheimnis, otpauthUri, pruefeCode } from '../lib/totp.js';

const SCHLUESSEL_SETTING = 'zweiter_faktor_secret';
const PFLICHT_SETTING = 'zweiter_faktor_pflicht';
const ANZAHL_CODES = 10;
const FORMAT = 'v1';

// ── Konten ───────────────────────────────────────────────────────────────────

/** Konto aus einer Sitzung bzw. einer ausstehenden Anmeldung. */
export function kontoAus({ role, menschId = null, username = null }) {
  if (role === 'admin') return { istAdmin: true, menschId: null, username: 'admin' };
  if (!menschId) throw new Error('Konto ohne Menschen-ID');
  return { istAdmin: false, menschId: String(menschId), username };
}

function kontoBedingung(konto) {
  return konto.istAdmin
    ? { sql: 'ist_admin', params: [] }
    : { sql: 'mensch_id = $1::uuid', params: [konto.menschId] };
}

// ── Schlüssel und Verschlüsselung ────────────────────────────────────────────

// Ein Restore beendet den Prozess (routes/backup.js), der Cache kann also
// keinen Schlüssel aus der Zeit davor halten.
let schluesselCache = null;

async function schluessel() {
  if (schluesselCache) return schluesselCache;
  // Erster Aufruf legt den Schlüssel an; parallele Erstaufrufe einigen sich
  // über ON CONFLICT auf denselben Wert.
  await query(
    `INSERT INTO postbuch._settings (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO NOTHING`,
    [SCHLUESSEL_SETTING, JSON.stringify(randomBytes(32).toString('base64'))],
  );
  const r = await query('SELECT value FROM postbuch._settings WHERE key = $1', [SCHLUESSEL_SETTING]);
  const key = Buffer.from(String(r.rows[0]?.value ?? ''), 'base64');
  if (key.length !== 32) throw new Error('Schlüssel der Zwei-Faktor-Anmeldung ist ungültig');
  schluesselCache = key;
  return key;
}

async function verschluesseln(klartext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', await schluessel(), iv);
  const ct = Buffer.concat([cipher.update(klartext, 'utf8'), cipher.final()]);
  return `${FORMAT}:${Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64')}`;
}

/** Liefert das Geheimnis oder null, wenn es mit dem aktuellen Schlüssel nicht lesbar ist. */
async function entschluesseln(gespeichert) {
  try {
    const [format, daten] = String(gespeichert).split(':');
    if (format !== FORMAT) return null;
    const buf = Buffer.from(daten, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', await schluessel(), buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

// ── Wiederherstellungscodes ──────────────────────────────────────────────────

function normalisiereCode(eingabe) {
  return String(eingabe ?? '').toUpperCase().replace(/[^A-Z2-7]/g, '');
}

function hashCode(normalisiert) {
  return createHash('sha256').update(`postbuch.zweiter-faktor:${normalisiert}`).digest('hex');
}

/** 10 Codes à 80 bit, angezeigt als XXXX-XXXX-XXXX-XXXX. */
function neueCodes() {
  const codes = Array.from({ length: ANZAHL_CODES }, () => base32Kodieren(randomBytes(10)));
  return {
    anzeige: codes.map((c) => c.match(/.{4}/g).join('-')),
    hashes: codes.map(hashCode),
  };
}

// ── Lesen ────────────────────────────────────────────────────────────────────

async function ladeZeile(konto, executor = query) {
  const b = kontoBedingung(konto);
  const r = await executor(`SELECT * FROM postbuch.totp_faktor WHERE ${b.sql}`, b.params);
  return r.rows[0] ?? null;
}

export async function hatFaktor(konto) {
  return !!(await ladeZeile(konto));
}

export async function pflichtAktiv() {
  const r = await query('SELECT value FROM postbuch._settings WHERE key = $1', [PFLICHT_SETTING]);
  return r.rows[0]?.value === true;
}

export async function setzePflicht(an) {
  await query(
    `INSERT INTO postbuch._settings (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [PFLICHT_SETTING, JSON.stringify(!!an)],
  );
}

export async function status(konto) {
  const zeile = await ladeZeile(konto);
  return {
    aktiv: !!zeile,
    defekt: zeile ? (await entschluesseln(zeile.geheimnis)) === null : false,
    verbleibendeCodes: zeile ? (zeile.wiederherstellung || []).length : 0,
    eingerichtetAm: zeile?.created_at ?? null,
    pflicht: await pflichtAktiv(),
  };
}

/** Menschen-IDs mit eingerichtetem zweitem Faktor (für die Personenverwaltung). */
export async function menschenMitFaktor() {
  const r = await query('SELECT mensch_id FROM postbuch.totp_faktor WHERE mensch_id IS NOT NULL');
  return new Set(r.rows.map((x) => String(x.mensch_id)));
}

// ── Prüfen ───────────────────────────────────────────────────────────────────

/**
 * Prüft einen TOTP-Code oder einen Wiederherstellungscode und verbraucht ihn.
 * Beide Verbrauchsschritte sind Compare-and-Swap-Updates: Zwei parallele
 * Anfragen mit demselben Code können nicht beide gelingen.
 *
 * @returns {Promise<{ok: boolean, art?: 'code'|'wiederherstellung', verbleibendeCodes?: number}>}
 */
async function pruefe(konto, eingabe) {
  const zeile = await ladeZeile(konto);
  if (!zeile) return { ok: false };

  const ziffern = String(eingabe ?? '').replace(/\s/g, '');
  if (/^\d{6}$/.test(ziffern)) {
    const geheimnis = await entschluesseln(zeile.geheimnis);
    if (!geheimnis) return { ok: false };
    const schritt = pruefeCode(geheimnis, ziffern, zeile.letzter_schritt);
    if (schritt === null) return { ok: false };
    const r = await query(
      `UPDATE postbuch.totp_faktor SET letzter_schritt = $2
        WHERE id = $1 AND (letzter_schritt IS NULL OR letzter_schritt < $2)`,
      [zeile.id, schritt],
    );
    return r.rowCount === 1 ? { ok: true, art: 'code' } : { ok: false };
  }

  const normalisiert = normalisiereCode(eingabe);
  if (normalisiert.length !== 16) return { ok: false };
  const gesucht = Buffer.from(hashCode(normalisiert));
  const treffer = (zeile.wiederherstellung || []).find((h) => {
    const b = Buffer.from(String(h));
    return b.length === gesucht.length && timingSafeEqual(b, gesucht);
  });
  if (!treffer) return { ok: false };
  const r = await query(
    `UPDATE postbuch.totp_faktor SET wiederherstellung = wiederherstellung - $2::text
      WHERE id = $1 AND wiederherstellung ? $2::text
      RETURNING jsonb_array_length(wiederherstellung) AS rest`,
    [zeile.id, treffer],
  );
  if (r.rowCount !== 1) return { ok: false };
  appLog('WARN', 'auth', `Anmeldung mit Wiederherstellungscode (${konto.username}), ${r.rows[0].rest} übrig`);
  return { ok: true, art: 'wiederherstellung', verbleibendeCodes: r.rows[0].rest };
}

// ── Einrichtung ──────────────────────────────────────────────────────────────
//
// Das neue Geheimnis lebt bis zur Bestätigung nur in der Sitzung. Erst ein
// richtiger Code legt die Zeile an bzw. ersetzt die alte; ein abgebrochener
// Gerätewechsel lässt den bisherigen Faktor unberührt.

const EINRICHTUNG_MS = 10 * 60 * 1000;

export async function beginneEinrichtung(session, konto) {
  const r = await query("SELECT value FROM postbuch._settings WHERE key = 'instance_name'");
  // Der Produktname steht vorn, damit der Eintrag in der Authenticator-App
  // auch neben gleichnamigen Diensten eindeutig ist; der Instanzname
  // unterscheidet mehrere postbuch.net-Instanzen.
  const instanz = String(r.rows[0]?.value || '').trim();
  const aussteller = instanz && instanz.toLowerCase() !== 'postbuch.net'
    ? `postbuch.net \u2013 ${instanz}` : 'postbuch.net';
  const geheimnis = neuesGeheimnis();
  session.zweiterFaktorEinrichtung = { geheimnis, seit: Date.now() };
  return { geheimnis, uri: otpauthUri({ geheimnis, konto: konto.username, aussteller }) };
}

/**
 * Prüft den Code gegen das Geheimnis aus beginneEinrichtung() und speichert
 * es. Liefert die Wiederherstellungscodes oder null bei falschem Code.
 */
export async function schliesseEinrichtungAb(session, konto, code, behalteSid = null) {
  const e = session.zweiterFaktorEinrichtung;
  if (!e || Date.now() - e.seit > EINRICHTUNG_MS) return { abgelaufen: true };
  const schritt = pruefeCode(e.geheimnis, code);
  if (schritt === null) return { ok: false };
  const codes = await speichere(konto, e.geheimnis, schritt, behalteSid);
  delete session.zweiterFaktorEinrichtung;
  return { ok: true, codes };
}

// ── Schreiben ────────────────────────────────────────────────────────────────

/**
 * Speichert ein bestätigtes Geheimnis (ersetzt ein vorhandenes) und liefert
 * neue Wiederherstellungscodes. Andere Web-Sitzungen des Kontos werden in
 * derselben Transaktion beendet; `behalteSid` ist die aktuelle Sitzung.
 */
export async function speichere(konto, geheimnis, bestaetigterSchritt, behalteSid = null) {
  const codes = neueCodes();
  const verschluesselt = await verschluesseln(geheimnis);
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const b = kontoBedingung(konto);
    await client.query(`DELETE FROM postbuch.totp_faktor WHERE ${b.sql}`, b.params);
    await client.query(
      `INSERT INTO postbuch.totp_faktor (mensch_id, ist_admin, geheimnis, letzter_schritt, wiederherstellung)
       VALUES ($1::uuid, $2, $3, $4, $5::jsonb)`,
      [konto.menschId, konto.istAdmin, verschluesselt, bestaetigterSchritt, JSON.stringify(codes.hashes)],
    );
    await beendeAndereSitzungen(konto, behalteSid, client.query.bind(client));
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  appLog('INFO', 'auth', `Zwei-Faktor-Anmeldung eingerichtet (${konto.username})`);
  return codes.anzeige;
}

export async function neueWiederherstellungscodes(konto) {
  const codes = neueCodes();
  const b = kontoBedingung(konto);
  const r = await query(
    `UPDATE postbuch.totp_faktor SET wiederherstellung = $${b.params.length + 1}::jsonb WHERE ${b.sql}`,
    [...b.params, JSON.stringify(codes.hashes)],
  );
  if (r.rowCount !== 1) throw new Error('Keine Zwei-Faktor-Anmeldung eingerichtet');
  appLog('INFO', 'auth', `Neue Wiederherstellungscodes erzeugt (${konto.username})`);
  return codes.anzeige;
}

export async function entferne(konto, grund) {
  const b = kontoBedingung(konto);
  const r = await query(`DELETE FROM postbuch.totp_faktor WHERE ${b.sql}`, b.params);
  if (r.rowCount) appLog('WARN', 'auth', `Zwei-Faktor-Anmeldung entfernt (${konto.username ?? konto.menschId}): ${grund}`);
  return r.rowCount > 0;
}

async function beendeAndereSitzungen(konto, behalteSid, executor = query) {
  const r = konto.istAdmin
    ? await executor(
      `DELETE FROM postbuch.session WHERE sess ->> 'role' = 'admin' AND ($1::text IS NULL OR sid <> $1)`,
      [behalteSid],
    )
    : await executor(
      `DELETE FROM postbuch.session WHERE sess ->> 'menschId' = $1 AND ($2::text IS NULL OR sid <> $2)`,
      [konto.menschId, behalteSid],
    );
  return r.rowCount || 0;
}

// ── Notschalter ──────────────────────────────────────────────────────────────

/**
 * POSTBUCH_TOTP_ADMIN_ZURUECKSETZEN=1 entfernt beim Start den zweiten Faktor
 * des Admins. Wer die .env ändern kann, kennt ohnehin APP_PASSWORD.
 */
export async function notschalterBeimStart() {
  if (process.env.POSTBUCH_TOTP_ADMIN_ZURUECKSETZEN !== '1') return;
  const entfernt = await entferne({ istAdmin: true, username: 'admin' }, 'Notschalter POSTBUCH_TOTP_ADMIN_ZURUECKSETZEN');
  const text = entfernt
    ? 'Notschalter aktiv: Zwei-Faktor-Anmeldung des Admins wurde entfernt.'
    : 'Notschalter aktiv: Der Admin hat keine Zwei-Faktor-Anmeldung.';
  console.warn(`[zweiter-faktor] ${text} POSTBUCH_TOTP_ADMIN_ZURUECKSETZEN wieder aus der .env entfernen und die App neu erstellen.`);
  appLog('WARN', 'auth', `${text} Variable wieder aus der .env entfernen.`);
}

// ── Sperre je Konto ──────────────────────────────────────────────────────────
//
// Zusätzlich zur Bremse je IP und Name (middleware/login-rate-limit.js): höchstens
// 5 falsche Codes je Konto in 15 Minuten, egal von wo. In-Memory wie dort; es
// gibt genau einen App-Container.

const SPERR_FENSTER_MS = 15 * 60 * 1000;
const SPERR_MAX = 5;
const fehlversuche = new Map();

function sperrSchluessel(konto) {
  return konto.istAdmin ? 'admin' : `m:${konto.menschId}`;
}

/** Sekunden bis zur nächsten erlaubten Prüfung, 0 = frei. */
export function codeSperre(konto, jetzt = Date.now()) {
  const e = fehlversuche.get(sperrSchluessel(konto));
  if (!e || jetzt - e.seit >= SPERR_FENSTER_MS) return 0;
  return e.anzahl >= SPERR_MAX ? Math.ceil((e.seit + SPERR_FENSTER_MS - jetzt) / 1000) : 0;
}

export function codeFehlversuch(konto, jetzt = Date.now()) {
  const k = sperrSchluessel(konto);
  const e = fehlversuche.get(k);
  if (!e || jetzt - e.seit >= SPERR_FENSTER_MS) fehlversuche.set(k, { anzahl: 1, seit: jetzt });
  else e.anzahl += 1;
  if (fehlversuche.get(k).anzahl === SPERR_MAX) {
    appLog('WARN', 'auth', `Zwei-Faktor-Anmeldung für ${konto.username ?? k} nach ${SPERR_MAX} falschen Codes für 15 Minuten gesperrt`);
  }
}

export function codeErfolg(konto) {
  fehlversuche.delete(sperrSchluessel(konto));
}

/**
 * pruefe() mit Kontosperre. `gesperrt` > 0: keine Prüfung, Sekunden bis frei.
 * @returns {Promise<{ok: boolean, gesperrt?: number, art?: string, verbleibendeCodes?: number}>}
 */
export async function pruefeMitSperre(konto, eingabe) {
  const gesperrt = codeSperre(konto);
  if (gesperrt) return { ok: false, gesperrt };
  const ergebnis = await pruefe(konto, eingabe);
  if (ergebnis.ok) codeErfolg(konto);
  else codeFehlversuch(konto);
  return ergebnis;
}
