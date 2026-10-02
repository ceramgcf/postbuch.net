/**
 * routes/updates.js — In-GUI-Updates (ADMIN-ONLY)
 *
 * Montiert in index.js als `/api/updates` hinter `requireAdmin`. Admin-only,
 * weil ein Update den gesamten Stack neu baut; ein `vollzugriff`-Nutzer bekommt
 * hier 403 und sieht die Karte im UI gar nicht erst.
 *
 *   GET  /api/updates            → Gesamtbild (installiert, verfügbar, Agent, Lauf)
 *   POST /api/updates/pruefen    → Manifest jetzt holen (60-s-Rate-Limit)
 *   POST /api/updates/starten    → Anforderung an den Host-Agenten schreiben
 *   PUT  /api/updates/kanal      → Vorabversionen ein/aus (nur GitHub-Quellen)
 *   POST /api/updates/abbrechen  → noch nicht abgeholte Anforderung zurücknehmen
 *   GET  /api/updates/log        → Log-Schwanz des Agenten als text/plain
 *
 * **Die App führt nichts aus.** Sie schreibt eine Anforderungsdatei; ausgeführt
 * wird ausschließlich vom Host-Agenten. Ohne Agenten gibt es hier keinen
 * Ausführungspfad, sondern einen Kopierbefehl — genau der Zustand des
 * Master-Systems, auf dem `install.sh` bewusst nie läuft.
 */

import { Router } from 'express';
import { appLog } from '../app-log.js';
import { appVersion } from '../lib/app-version.js';
import {
  leseUpdateStatus, pruefeUpdate, checkAktiv, lesePin, PRUEF_ABSTAND_MS,
  vorabGewuenscht, setzeVorabversionen,
} from '../service/update-check.js';
import { signaturKonfiguriert, signaturText, SIGNATUR_STATUS } from '../lib/release-signatur.js';
import {
  leseAgentStatus, leseAnforderung, schreibeAnforderung, entferneAnforderung,
  leseLaufStatus, leseLogTail, laufAktiv, schreibeHostAnforderung,
} from '../lib/update-agent-datei.js';
import {
  istNeuer, semver, hatFeedQuelle, feedQuelleFingerprint, githubQuelle,
} from '../lib/postbuch-feed.js';
import db from '../db.js';

const router = Router();

/**
 * Der Fallback für Instanzen ohne Agenten. Konstanter String — NIE aus dem
 * Manifest zusammengesetzt: ein Befehl, den ein Admin per Copy-Paste in seine
 * root-Shell wirft, darf nicht aus einer Datei stammen, die von außen kommt.
 */
const KOPIERBEFEHL = 'cd ~/postbuch && ./deploy-pages/install.sh --update';

/**
 * Im Vorabkanal muss der Installer gezielt die geprüfte Version holen, sonst
 * läse er das neueste stabile Manifest. Angehängt wird nur eine strikt
 * validierte Versionsnummer, nie freier Text aus dem Manifest.
 */
function kopierbefehl(vorab, verfuegbar, updateVerfuegbar) {
  const v = vorab && updateVerfuegbar ? semver(verfuegbar) : null;
  return v ? `${KOPIERBEFEHL} --zielversion=${v}` : KOPIERBEFEHL;
}

/**
 * Hält fest, WAS zuletzt an den Host-Agenten übergeben wurde — damit der
 * Einrichtungsassistent den Ist-Zustand anzeigen kann, statt Felder leer zu
 * lassen oder Werte zu raten. Der Agent meldet diese Einstellungen nicht
 * zurück; ohne diese Notiz weiß die App nichts von ihnen.
 *
 * **Der DuckDNS-Token wird bewusst NICHT gespeichert.** Er geht ausschließlich
 * an den Agenten. Vermerkt wird nur, dass und wann einer übergeben wurde; das
 * UI zeigt dafür Punkte und bietet „Ändern" an.
 */
async function merkeHostconfig(typ, wert, mitSecret) {
  const text = String(wert || '').trim();
  let key = null;
  let value = null;
  if (typ === 'duckdns' && text === 'aus') {
    // TLS wurde abgeschaltet — dann darf auch keine Domain mehr angezeigt
    // werden, sonst behauptet der Assistent einen Zustand, den es nicht gibt.
    key = 'hostconfig_duckdns';
    // abgeschaltetAm sperrt zusätzlich die Ableitung aus app_host bzw. dem
    // Installer-Token (einrichtung.js); ein späterer Auftrag mit Domain
    // schreibt die Notiz ohne dieses Feld neu.
    const jetzt = new Date().toISOString();
    value = { domain: null, angefordertAm: jetzt, tokenGesetztAm: null, abgeschaltetAm: jetzt };
  } else if (typ === 'duckdns' && text) {
    key = 'hostconfig_duckdns';
    // Ein Auftrag ohne neuen Token (z. B. nur Domainwechsel) darf den Nachweis
    // eines früher übergebenen Tokens nicht löschen.
    const { rows } = await db.query("SELECT value FROM postbuch._settings WHERE key = 'hostconfig_duckdns'");
    const bisher = rows[0]?.value?.tokenGesetztAm || null;
    value = {
      domain: text,
      angefordertAm: new Date().toISOString(),
      tokenGesetztAm: mitSecret ? new Date().toISOString() : bisher,
    };
  } else if (typ === 'port' && /^\d{2,5}$/.test(text)) {
    key = 'hostconfig_port';
    value = { port: Number(text), angefordertAm: new Date().toISOString() };
  }
  if (!key) return;
  await db.query(
    `INSERT INTO postbuch._settings (key, value, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, JSON.stringify(value)],
  ).catch((err) => console.error('[hostconfig] Notiz konnte nicht gespeichert werden:', err.message));
}

async function gesamtbild() {
  const [status, agent, lauf, anforderung, aktiv, pin, vorabWunsch] = await Promise.all([
    leseUpdateStatus(),
    leseAgentStatus(),
    leseLaufStatus(),
    leseAnforderung(),
    checkAktiv(),
    lesePin(),
    vorabGewuenscht(),
  ]);

  const installiert = appVersion();
  const bezugsquelleKonfiguriert = hatFeedQuelle();
  // Vorabversionen gibt es nur bei GitHub-Quellen (Pre-release-Haken).
  const kanalWaehlbar = bezugsquelleKonfiguriert && !!githubQuelle();
  const vorab = kanalWaehlbar && vorabWunsch;
  const quelleAktuell = bezugsquelleKonfiguriert
    && status.quelleFingerprint === feedQuelleFingerprint({ vorab });
  const verfuegbar = quelleAktuell ? (status.verfuegbar ?? null) : null;

  return {
    installiert,
    verfuegbar,
    // Beim Lesen erneut vergleichen statt dem Cache zu glauben: nach einem
    // erfolgreichen Update ist die installierte Version eine andere, der Cache
    // aber noch der alte.
    updateVerfuegbar: !!(installiert && verfuegbar && istNeuer(verfuegbar, installiert)),
    veroeffentlichtAm:   quelleAktuell ? (status.veroeffentlichtAm ?? null) : null,
    sicherheitsrelevant: quelleAktuell && status.sicherheitsrelevant === true,
    mindestVersion:      quelleAktuell ? (status.mindestVersion ?? null) : null,
    changelog:           quelleAktuell && Array.isArray(status.changelog) ? status.changelog : [],
    geprueftAm:          quelleAktuell ? (status.geprueftAm ?? null) : null,
    fehler:              quelleAktuell ? (status.fehler ?? null) : null,
    checkAktiv: aktiv,
    vorabversionen: vorab,
    kanalWaehlbar,
    bezugsquelleKonfiguriert,
    bezugsquelleGeaendert: bezugsquelleKonfiguriert && !quelleAktuell,
    // Der Signaturzustand gehört sichtbar ins GUI, nicht nur ins Log. Eine
    // Instanz, die Signaturen gar nicht prüfen kann, sieht sonst genauso aus
    // wie eine geschützte — der Admin läse „Signaturprüfung" im Changelog und
    // hielte sich für abgesichert, obwohl auf seinem System nie etwas geprüft
    // wird.
    signatur: {
      status:    status.signatur ?? null,
      text:      status.signatur ? signaturText(status.signatur) : null,
      keyId:     status.signaturKeyId ?? null,
      // Eingebettete Schlüssel sind der Vertrauensanker; TOFU ist nicht nötig.
      pflicht:   signaturKonfiguriert(),
      seit:      pin?.seit ?? null,
      // Kennt diese Postbuch-Version überhaupt einen Release-Schlüssel?
      moeglich:  signaturKonfiguriert(),
    },
    agent: {
      vorhanden:  agent.vorhanden,
      modus:      agent.modus,
      docker:     agent.docker,
      schreibbar: agent.schreibbar,
      version: agent.version,
      capabilities: agent.capabilities,
      letzterLaufAm: agent.letzterLaufAm,
      scannerProfilAktiv: agent.scannerProfilAktiv,
    },
    // Eine geschriebene, aber noch nicht abgeholte Anforderung ist ein eigener
    // Zustand: die GUI zeigt „warte auf den Agenten" statt eines Fortschritts,
    // und nach 3 Minuten „nicht abgeholt" mit der Möglichkeit zurückzunehmen.
    anforderung: anforderung ? {
      nonce: anforderung.nonce ?? null,
      // Anforderungen für Hostaufträge (Modul/Port/DuckDNS/Netzwerk) tragen
      // `typ`; eine echte Update-Anforderung schreibt das Feld nicht.
      typ: anforderung.typ || 'update',
      zielVersion: anforderung.zielVersion ?? null,
      angefordertAm: anforderung.angefordertAm ?? null,
    } : null,
    lauf: lauf ? {
      nonce: lauf.nonce,
      status: lauf.status,
      typ: lauf.typ,
      phase: lauf.phase,
      seit: lauf.begonnenAm,
      beendetAm: lauf.beendetAm,
      exitCode: lauf.exitCode,
      meldung: lauf.meldung,
    } : null,
    kopierbefehl: kopierbefehl(vorab, verfuegbar,
      !!(installiert && verfuegbar && istNeuer(verfuegbar, installiert))),
  };
}

// ── GET /api/updates ─────────────────────────────────────────────────────────

router.get('/', async (_req, res) => {
  try {
    res.json(await gesamtbild());
  } catch (err) {
    console.error('[updates] GET fehlgeschlagen:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/updates/pruefen ────────────────────────────────────────────────

router.post('/pruefen', async (_req, res) => {
  try {
    if (!(await checkAktiv())) {
      return res.status(409).json({ error: 'Der Update-Check ist deaktiviert.' });
    }
    const vorher = await leseUpdateStatus();
    const letzte = vorher.geprueftAm ? Date.parse(vorher.geprueftAm) : 0;
    const abstand = Date.now() - letzte;
    if (Number.isFinite(letzte) && letzte > 0 && abstand < PRUEF_ABSTAND_MS) {
      return res.status(429).json({
        error: 'Zu häufig geprüft. Bitte kurz warten.',
        retryAfterSec: Math.ceil((PRUEF_ABSTAND_MS - abstand) / 1000),
      });
    }
    await pruefeUpdate();
    res.json(await gesamtbild());
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ── POST /api/updates/starten ────────────────────────────────────────────────

router.post('/starten', async (req, res) => {
  try {
    const agent = await leseAgentStatus();
    const status = await leseUpdateStatus();
    if (!agent.vorhanden) {
      return res.status(412).json({
        error: 'Es ist kein Update-Agent auf diesem Host eingerichtet. '
          + 'Postbuch aktualisiert sich nicht selbst — das Update muss auf dem Server gestartet werden.',
        kopierbefehl: kopierbefehl(status.vorab === true, status.verfuegbar,
          !!(appVersion() && status.verfuegbar && istNeuer(status.verfuegbar, appVersion()))),
      });
    }
    if (!agent.schreibbar) {
      return res.status(412).json({
        error: 'Der Update-Agent hat keinen Schreibzugriff auf das Übergabeverzeichnis.',
      });
    }

    const lauf = await leseLaufStatus();
    if (laufAktiv(lauf)) {
      return res.status(429).json({ error: 'Es läuft bereits ein Update.' });
    }
    if (await leseAnforderung()) {
      return res.status(429).json({ error: 'Es liegt bereits eine Update-Anforderung vor.' });
    }

    const installiert = appVersion();
    if (!status.verfuegbar || !status.tarballSha256) {
      return res.status(409).json({ error: 'Es liegt kein geprüftes Release-Manifest vor. Bitte zuerst auf Updates prüfen.' });
    }
    if (!installiert || !istNeuer(status.verfuegbar, installiert)) {
      return res.status(409).json({ error: 'Es ist keine neuere Version verfügbar.' });
    }

    // Zweites Schloss an derselben Tür. `pruefeUpdate()` verwirft ein nicht
    // gültig signiertes Manifest bereits und schreibt gar keinen `tarballSha256`
    // in den Cache — dieser Riegel greift also nur, wenn ein alter Cache-Stand
    // aus der Zeit vor der Impfung überlebt hat. Genau dafür ist er da.
    if (signaturKonfiguriert() && status.signatur !== SIGNATUR_STATUS.GUELTIG) {
      return res.status(409).json({
        error: `Das zuletzt geprüfte Release-Manifest ist nicht gültig signiert `
          + `(${signaturText(status.signatur)}). Diese Instanz verlangt eine gültige Signatur. `
          + `Bitte erneut auf Updates prüfen.`,
      });
    }
    // Ein Agent ohne `--zielversion` holte das stabile Manifest und bräche
    // am abweichenden SHA-256 ab. Lieber gleich klar sagen, was fehlt.
    if (status.vorab === true && !agent.capabilities?.includes('zielversion')) {
      return res.status(412).json({
        error: 'Der Update-Agent auf diesem Host ist zu alt für Vorabversionen. '
          + 'Bitte einmal auf dem Server aktualisieren; danach geht es hier per Knopfdruck.',
        kopierbefehl: kopierbefehl(true, status.verfuegbar, true),
      });
    }
    if (status.mindestVersion && istNeuer(status.mindestVersion, installiert)) {
      return res.status(409).json({
        error: `Ein Direkt-Update ist erst ab Version ${status.mindestVersion} möglich `
          + `(installiert: ${installiert}). Bitte zuerst auf dem Server manuell aktualisieren.`,
      });
    }

    const nonce = await schreibeAnforderung({
      zielVersion: status.verfuegbar,
      erwarteterSha256: status.tarballSha256,
      angefordertVon: req.session?.username || 'admin',
    });
    await appLog('INFO', 'update', `Update auf ${status.verfuegbar} angefordert`, {
      details: `nonce=${nonce}, von=${req.session?.username || 'admin'}, Agent-Modus=${agent.modus}`,
    });
    res.json({ nonce, zielVersion: status.verfuegbar, modus: agent.modus });
  } catch (err) {
    console.error('[updates] starten fehlgeschlagen:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/hostconfig', async (req, res) => {
  try {
    const agent = await leseAgentStatus();
    const typ = String(req.body?.typ || '');
    const capability = typ === 'module' ? 'module' : (typ === 'port' ? 'port' : 'netzwerk');
    if (!agent.vorhanden || !agent.capabilities?.includes(capability)) {
      return res.status(412).json({
        error: 'Der installierte Host-Agent unterstützt diesen Auftrag noch nicht.',
        anleitung: 'sudo systemctl start postbuch-update-agent.service',
      });
    }
    if (await leseAnforderung() || laufAktiv(await leseLaufStatus())) {
      return res.status(429).json({ error: 'Der Host-Agent bearbeitet bereits einen Auftrag.' });
    }
    const nonce = await schreibeHostAnforderung({
      typ,
      wert: req.body?.wert,
      secret: req.body?.secret,
      angefordertVon: req.session?.username || 'admin',
    });
    await merkeHostconfig(typ, req.body?.wert, !!req.body?.secret);
    await appLog('INFO', 'hostconfig', `Hostauftrag ${typ} angefordert`, {
      details: `nonce=${nonce}`, entity: 'settings', entityId: req.session?.username || 'admin',
    });
    res.json({ nonce, typ });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── PUT /api/updates/kanal ───────────────────────────────────────────────────
// Wählt nur, ob Pre-releases derselben Quelle zählen. Die Quelle selbst bleibt
// `.env`-Sache und ist hierüber nicht änderbar.

router.put('/kanal', async (req, res) => {
  try {
    const an = req.body?.vorabversionen;
    if (typeof an !== 'boolean') {
      return res.status(400).json({ error: 'vorabversionen muss true oder false sein.' });
    }
    if (an && !githubQuelle()) {
      return res.status(409).json({
        error: 'Vorabversionen gibt es nur bei einer GitHub-Bezugsquelle.',
      });
    }
    const vorher = await vorabGewuenscht();
    await setzeVorabversionen(an);
    if (vorher !== an) {
      await appLog('INFO', 'update', an ? 'Vorabversionen eingeschaltet' : 'Vorabversionen ausgeschaltet', {
        details: `von=${req.session?.username || 'admin'}`,
      });
    }
    // Gleich im neuen Kanal nachsehen, damit die Karte nicht leer bleibt. Ein
    // Netzfehler ist hier kein Fehler der Umschaltung.
    if (vorher !== an && (await checkAktiv())) {
      await pruefeUpdate().catch((err) => console.warn('[updates] Prüfung nach Kanalwechsel:', err.message));
    }
    res.json(await gesamtbild());
  } catch (err) {
    console.error('[updates] Kanalwechsel fehlgeschlagen:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/updates/abbrechen ──────────────────────────────────────────────

router.post('/abbrechen', async (req, res) => {
  try {
    const lauf = await leseLaufStatus();
    if (laufAktiv(lauf)) {
      // Ein laufendes Update mitten im Entpacken abzubrechen hinterließe einen
      // halben Quellbaum — es gibt hier bewusst keinen Not-Aus.
      return res.status(409).json({ error: 'Das Update läuft bereits und kann nicht abgebrochen werden.' });
    }
    const entfernt = await entferneAnforderung();
    if (entfernt) {
      await appLog('INFO', 'update', 'Update-Anforderung zurückgenommen', {
        details: `von=${req.session?.username || 'admin'}`,
      });
    }
    res.json({ entfernt });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/updates/log ─────────────────────────────────────────────────────

router.get('/log', async (_req, res) => {
  try {
    const text = await leseLogTail();
    res.type('text/plain; charset=utf-8').send(text || '(noch kein Protokoll vorhanden)');
  } catch (err) {
    res.status(500).type('text/plain').send(`Fehler: ${err.message}`);
  }
});

export default router;
