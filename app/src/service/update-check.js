/**
 * service/update-check.js — Manifest holen, prüfen, im Cache ablegen
 *
 * Die eine Stelle, die `latest.json` abruft. Sowohl die Admin-Route
 * (`POST /api/updates/pruefen`) als auch der tägliche Feed-Job rufen hier an —
 * zwei Implementierungen desselben Abrufs würden garantiert auseinanderlaufen.
 *
 * Das Ergebnis liegt in `_settings.update_status` (jsonb-Cache, NICHT in
 * `ALLOWED_SETTING_KEYS`: geschrieben wird ausschließlich hier, nie über den
 * generischen PUT). Kein Schema-Change, keine `update_history`-Tabelle — was
 * passiert ist, steht in `app_log` und im Log des Agenten.
 */

import db from '../db.js';
import { appLog } from '../app-log.js';
import { holeReleaseManifest, feedQuelleFingerprint, githubQuelle } from '../lib/postbuch-feed.js';
import { validiereManifest, istNeuer } from '../lib/update-manifest.js';
import { appVersion } from '../lib/app-version.js';
import {
  pruefeSignatur, signaturKonfiguriert, signaturText, SIGNATUR_STATUS,
} from '../lib/release-signatur.js';

const CACHE_KEY = 'update_status';
const PIN_KEY = 'update_signatur_pin';
const VORAB_KEY = 'update_vorabversionen';

/** Mindestabstand zwischen zwei manuellen Prüfungen. */
export const PRUEF_ABSTAND_MS = 60_000;

export async function leseUpdateStatus() {
  const r = await db.query('SELECT value FROM postbuch._settings WHERE key = $1', [CACHE_KEY]);
  const v = r.rows[0]?.value;
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

async function schreibeUpdateStatus(wert) {
  await db.query(
    `INSERT INTO postbuch._settings (key, value, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = NOW()`,
    [CACHE_KEY, JSON.stringify(wert)],
  );
}

// ── Vertrauens- und Versionsanker ────────────────────────────────────────────
// Eingebettete öffentliche Schlüssel sind bereits der Vertrauensanker. Sobald
// sie konfiguriert sind, wird jedes nicht gültig signierte Manifest vom ersten
// Kontakt an abgelehnt. Der DB-Pin speichert nur Schlüssel-/Versionshistorie
// für Anti-Downgrade und Audit; er schaltet die Signaturpflicht nicht erst ein.
//
// Der Anker liegt in `_settings` (DB) und wird ausschließlich hier geschrieben
// — er steht bewusst NICHT in `ALLOWED_SETTING_KEYS`, ist also über den
// generischen Settings-PUT weder setz- noch löschbar.
//
// Der Installer führt einen zweiten, unabhängigen Anker auf der Platte
// (`$INSTALL_DIR/.postbuch-vertrauen`). Das ist keine Dopplung: es sind zwei
// getrennte Vertrauensgrenzen für zwei getrennte Abrufe. Die App entscheidet,
// ob ein Update überhaupt angeboten wird; der Installer entscheidet, ob er
// entpackt. Keiner der beiden verlässt sich auf den anderen.

export async function lesePin() {
  const r = await db.query('SELECT value FROM postbuch._settings WHERE key = $1', [PIN_KEY]);
  const v = r.rows[0]?.value;
  return v && typeof v === 'object' && !Array.isArray(v) && v.keyId ? v : null;
}

async function schreibePin(wert) {
  await db.query(
    `INSERT INTO postbuch._settings (key, value, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = NOW()`,
    [PIN_KEY, JSON.stringify(wert)],
  );
}

/**
 * Möchte diese Instanz Vorabversionen (GitHub-Pre-releases) angeboten
 * bekommen? Default aus. Die Einstellung wählt nur, WELCHE Releases derselben
 * Quelle zählen – nie die Quelle selbst, die bleibt `.env`-Sache.
 */
export async function vorabGewuenscht() {
  const r = await db.query('SELECT value FROM postbuch._settings WHERE key = $1', [VORAB_KEY]);
  return r.rows[0]?.value === true;
}

/** Ist der Vorabkanal gewünscht UND bei dieser Quelle überhaupt möglich? */
export async function vorabAktiv() {
  return !!githubQuelle() && (await vorabGewuenscht());
}

export async function setzeVorabversionen(an) {
  await db.query(
    `INSERT INTO postbuch._settings (key, value, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = NOW()`,
    [VORAB_KEY, JSON.stringify(an === true)],
  );
}

/** Ist der Update-Check eingeschaltet? Default an. */
export async function checkAktiv() {
  const r = await db.query('SELECT value FROM postbuch._settings WHERE key = $1', ['update_check_enabled']);
  return r.rows[0] ? r.rows[0].value !== false : true;
}

/**
 * Holt das Manifest, validiert es und legt das Ergebnis im Cache ab.
 * Wirft bei Netz-/Validierungsfehlern — der Aufrufer entscheidet, ob das eine
 * 502 (Route) oder eine Log-Zeile (Job) ist. Auch der Fehlerfall wird
 * zwischengespeichert, damit die GUI „zuletzt geprüft" ehrlich anzeigen kann.
 *
 * @returns {Promise<object>} der neue Cache-Inhalt
 */
/**
 * Letzter Cache-Inhalt, aber nur, wenn er von derselben Quelle und demselben
 * Kanal stammt. Sonst würde ein fehlgeschlagener Abruf das Ergebnis der alten
 * Quelle mit dem neuen Fingerprint stempeln und so als aktuell ausgeben.
 */
async function vorherigerStand(quelleFingerprint) {
  const vorher = await leseUpdateStatus();
  return vorher?.quelleFingerprint === quelleFingerprint ? vorher : {};
}

export async function pruefeUpdate() {
  const jetzt = new Date().toISOString();
  const installiert = appVersion();
  const vorab = await vorabAktiv();
  const quelleFingerprint = feedQuelleFingerprint({ vorab });

  let roh;
  let erwarteteVersion;
  try {
    ({ roh, erwarteteVersion } = await holeReleaseManifest({ vorab }));
  } catch (err) {
    await schreibeUpdateStatus({ ...await vorherigerStand(quelleFingerprint), geprueftAm: jetzt, fehler: err.message, quelleFingerprint });
    throw err;
  }

  let manifest;
  try {
    manifest = validiereManifest(roh);
    // Im Vorabkanal muss das Manifest zu dem Tag passen, unter dem es lag.
    // Die Signatur deckt das zusätzlich ab, aber ein falsch hochgeladenes
    // Asset soll eine klare Meldung bekommen statt eines Rätsels.
    if (erwarteteVersion && manifest.version !== erwarteteVersion) {
      throw new Error(`Das Manifest im Release v${erwarteteVersion} nennt Version ${manifest.version}.`);
    }
  } catch (err) {
    await schreibeUpdateStatus({ ...await vorherigerStand(quelleFingerprint), geprueftAm: jetzt, fehler: err.message, quelleFingerprint });
    await appLog('WARN', 'update-check', 'Release-Manifest abgelehnt', { details: err.message });
    throw err;
  }

  // ── Signatur + Vertrauensanker ────────────────────────────────────────────
  const pin = await lesePin();
  const sig = pruefeSignatur(manifest);

  // Sobald diese Version öffentliche Release-Schlüssel kennt, ist ein nicht
  // sauber signiertes Manifest gar kein Manifest: es wird verworfen,
  // BEVOR `tarballSha256` in den Cache und von dort in die Agenten-Anforderung
  // wandern kann. Der Installer prüft ein zweites Mal — aber die Kette darf
  // hier nicht schon mit einem fremden Hash beginnen.
  if (signaturKonfiguriert() && sig.status !== SIGNATUR_STATUS.GUELTIG) {
    const meldung = `Das Release-Manifest ist nicht gültig signiert (${signaturText(sig.status)}). `
      + 'Diese Postbuch-Version kennt fest eingebettete Release-Schlüssel und verlangt eine gültige Signatur. '
      + 'Das Update wird nicht angeboten.';
    await schreibeUpdateStatus({
      geprueftAm: jetzt, fehler: meldung, signatur: sig.status, signaturPflicht: true, quelleFingerprint,
    });
    await appLog('WARN', 'update-check', 'Release-Manifest ohne gültige Signatur abgelehnt',
      { details: `Status: ${sig.status}, bekannte Schlüssel konfiguriert` });
    throw new Error(meldung);
  }

  // Rollback-Schutz: eine alte Version bleibt für immer gültig signiert. Wer
  // den Auslieferungskanal kontrolliert, könnte also ein älteres Release mit
  // bekannter Lücke erneut ausspielen — die Signatur allein merkt das nicht.
  // Deshalb wird die höchste je gesehene signierte Version mitgeführt.
  //
  // Je Kanal getrennt: Die neueste stabile Version darf legitim älter sein
  // als eine zuvor gesehene Vorabversion. Wer vom Vorabkanal zurückschaltet,
  // bekommt deshalb keinen Fehler, sondern schlicht kein Update, bis eine
  // neuere stabile Version erscheint (`neuerAlsInstalliert` bleibt false).
  // Stabile Versionen erscheinen auch im Vorabkanal, also hebt eine stabile
  // Prüfung beide Anker, eine Vorabprüfung nur den eigenen.
  const ankerFeld = vorab ? 'hoechsteVorab' : 'hoechsteVersion';
  const anker = vorab
    ? hoehere(pin?.hoechsteVorab, pin?.hoechsteVersion)
    : pin?.hoechsteVersion;
  if (anker && istNeuer(anker, manifest.version)) {
    const meldung = `Das Release-Manifest nennt Version ${manifest.version}, `
      + `zuvor war hier bereits ${anker} signiert verfügbar. `
      + 'Ein Rückschritt wird nicht angeboten.';
    await schreibeUpdateStatus({
      geprueftAm: jetzt, fehler: meldung, signatur: sig.status, signaturPflicht: true, quelleFingerprint,
    });
    await appLog('WARN', 'update-check', 'Rückschritt im Release-Manifest abgelehnt',
      { details: `Manifest: ${manifest.version}, bisher höchste: ${anker} (${ankerFeld})` });
    throw new Error(meldung);
  }

  // Impfung: NUR eine tatsächlich verifizierte Signatur setzt den Anker.
  if (sig.status === SIGNATUR_STATUS.GUELTIG) {
    const neuerPin = {
      keyId: sig.keyId,
      seit: pin?.seit || jetzt,
      hoechsteVersion: vorab ? (pin?.hoechsteVersion ?? null) : hoehere(pin?.hoechsteVersion, manifest.version),
      hoechsteVorab: hoehere(pin?.hoechsteVorab, manifest.version),
    };
    if (!neuerPin.hoechsteVersion) delete neuerPin.hoechsteVersion;
    await schreibePin(neuerPin);
    if (!pin) {
      await appLog('INFO', 'update-check',
        'Release-Signatur erfolgreich geprüft und Versionsanker gesetzt',
        { details: `Schlüssel: ${sig.keyId}` });
    }
  }

  const neu = {
    geprueftAm: jetzt,
    fehler: null,
    installiert: installiert ?? null,
    verfuegbar: manifest.version,
    // Aus welchem Kanal stammt `verfuegbar`? Nur zur Anzeige; die Trennung
    // der Caches leistet der Fingerprint.
    vorab,
    // Was die GUI zeigen muss, damit ein Admin den Zustand einschätzen kann:
    // `unkonfiguriert` heißt „diese Postbuch-Version kennt keinen Schlüssel",
    // `fehlt` heißt „der Feed liefert keine Signatur" — zwei sehr verschiedene
    // Aussagen, die nicht zu einem „ungeprüft" verschmelzen dürfen.
    signatur: sig.status,
    signaturKeyId: sig.keyId,
    signaturPflicht: signaturKonfiguriert(),
    signaturMoeglich: signaturKonfiguriert(),
    veroeffentlichtAm: manifest.veroeffentlichtAm,
    sicherheitsrelevant: manifest.sicherheitsrelevant,
    mindestVersion: manifest.mindestVersion,
    changelog: manifest.changelog,
    tarballSha256: manifest.tarball.sha256,
    tarballGroesse: manifest.tarball.groesse,
    // Ein Cache einer früheren Quelle darf nie als Grundlage für ein Update
    // erscheinen. Der Signatur-/Anti-Downgrade-Pin bleibt davon getrennt und
    // damit bei einem legitimen Quellenwechsel weiter wirksam.
    quelleFingerprint,
    // Ist das ein echter Fortschritt gegenüber dem, was hier läuft? Ohne
    // bekannte eigene Version (alte docker-compose.yml ohne VERSION-Mount)
    // lässt sich das nicht entscheiden — dann bleibt es false und die GUI
    // zeigt nur die verfügbare Version an.
    neuerAlsInstalliert: !!(installiert && istNeuer(manifest.version, installiert)),
  };

  const vorher = await leseUpdateStatus();
  await schreibeUpdateStatus(neu);

  if (neu.neuerAlsInstalliert && vorher.verfuegbar !== neu.verfuegbar) {
    await appLog('INFO', 'update-check',
      `Neue Version verfügbar: ${neu.verfuegbar} (installiert: ${installiert})`,
      { details: neu.sicherheitsrelevant ? 'Als sicherheitsrelevant markiert.' : undefined });
  }

  return neu;
}

/** Die höhere zweier Versionen; fehlende Werte zählen nicht. */
function hoehere(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  return istNeuer(b, a) ? b : a;
}
