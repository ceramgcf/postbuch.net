/**
 * routes/einrichtung.js — serverseitige Hülle des Einrichtungsassistenten.
 *
 * Der Router wird in index.js hinter requireAdmin montiert. `_settings.einrichtung`
 * enthält ausschließlich Ablaufzustand und Prüfnachweise, niemals eine zweite
 * Kopie fachlicher Konfiguration oder Geheimnisse.
 */

import { Router } from 'express';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import db from '../db.js';
import { loadDynamicSettings, getFolders, getActiveBackendName } from '../config.js';
import { buildAiHealth } from '../lib/ai-health.js';
import { embeddingConfig } from '../lib/embedding.js';
import { leseAgentStatus, leseLaufStatus, leseAnforderung } from '../lib/update-agent-datei.js';
import { DUCKDNS_DOMAIN_RE, pruefeDuckdnsAufloesung } from '../lib/duckdns-pruefung.js';
import { runAdapterConformance, SELFTEST_TOTAL_STEPS } from '../service/storage-selftest.js';
import * as tracker from '../jobs/tracker.js';
import { SYSTEM_FOLDERS } from '../service/storage-setup.js';
import { getAktiveTaxonomie } from '../lib/taxonomie.js';
import { appLog } from '../app-log.js';
import { MODEL_CLASSES, aktiveModellklassen, modellwahl } from '../lib/llm/model-classes.js';
import { resolveModelConfig } from '../lib/llm.js';
import { listProviders, LOKAL_ID } from '../lib/llm/registry.js';
import { backupEntscheidungGespeichert, backupVerschluesselungEntschieden } from '../lib/backup-config.js';
import { verschluesselungsStatus } from '../lib/backup-encryption.js';
import * as lokal from '../lib/storage/lokal.js';
import { nachRestoreBild, nachRestoreMarkieren, nachRestoreErledigt } from '../service/stack-profil.js';
import { lokalProviderSoll, lokalenProviderBeiAntwortAktivieren } from '../service/lokalki-provider.js';
import { modellZustaende } from '../lib/embedding-dienst.js';
import { guardedFetchJson } from '../lib/net-guard.js';

const router = Router();

const BACKEND_LABEL = { onedrive: 'OneDrive', nextcloud: 'Nextcloud', lokal: 'Der Ordner auf diesem Rechner' };

const STATUS = new Set(['nicht_aktiv', 'offen', 'abgeschlossen', 'uebersprungen']);
const QUELLEN = new Set(['installation', 'manuell']);
export const EINRICHTUNG_SCHRITTE = Object.freeze([
  'willkommen', 'betrieb', 'menschen', 'ablage', 'ordner',
  'ki', 'scanner', 'benachrichtigungen', 'backup', 'abschluss',
]);
const SCHRITTE = new Set(EINRICHTUNG_SCHRITTE);

function leererZustand() {
  return { status: 'nicht_aktiv', quelle: 'manuell', schritte: {}, nachweise: {}, eingeladenAm: null, abgeschlossenAm: null };
}

/**
 * Woher stammt eine offene Ersteinrichtung?
 *
 * Nur `installation` darf die Oberfläche sperren: Diesen Zustand schreibt
 * ausschließlich der Seed, wenn der Installer die Instanz per
 * `.einrichtung_pending` als echte Erstinstallation markiert hat. Ein von Hand
 * geöffneter Assistent ist `manuell` und bleibt für den Rest der Instanz
 * folgenlos — eine laufende Instanz darf sich nicht selbst aussperren.
 *
 * Zustände aus Versionen vor diesem Feld tragen keine Quelle. Sie gelten nur
 * dann als Erstinstallation, wenn sie exakt wie ein unberührter Seed aussehen
 * (offen, nie eingeladen, kein Schritt, kein Nachweis). Jede Instanz, die den
 * Assistenten je geöffnet oder geprüft hat, wird dadurch zu `manuell` und
 * verliert die Sperre beim nächsten Start.
 */
function leseQuelle(wert, schritte, nachweise) {
  if (QUELLEN.has(wert?.quelle)) return wert.quelle;
  const unberührterSeed = wert?.status === 'offen'
    && !wert?.eingeladenAm
    && Object.keys(schritte).length === 0
    && Object.keys(nachweise).length === 0;
  return unberührterSeed ? 'installation' : 'manuell';
}

function normalisiereZustand(wert) {
  if (!wert || typeof wert !== 'object' || Array.isArray(wert) || !STATUS.has(wert.status)) {
    return leererZustand();
  }
  const schritte = {};
  for (const [id, eintrag] of Object.entries(wert.schritte || {})) {
    if (SCHRITTE.has(id) && eintrag && typeof eintrag === 'object') {
      schritte[id] = { abgeschlossenAm: String(eintrag.abgeschlossenAm || '').slice(0, 40) || null };
    }
  }
  const nachweise = {
    ...(wert.nachweise?.storage
      && typeof wert.nachweise.storage === 'object'
      && ['onedrive', 'nextcloud', 'lokal'].includes(wert.nachweise.storage.backend)
      ? { storage: {
        backend: wert.nachweise.storage.backend,
        bestandenAm: String(wert.nachweise.storage.bestandenAm || '').slice(0, 40),
        signatur: /^[0-9a-f]{64}$/.test(String(wert.nachweise.storage.signatur || ''))
          ? wert.nachweise.storage.signatur : null,
      } }
      : {}),
    ...(wert.nachweise?.ki
      && typeof wert.nachweise.ki === 'object'
      && Array.isArray(wert.nachweise.ki.workingProviders)
      ? { ki: {
        workingProviders: wert.nachweise.ki.workingProviders
          .filter((id) => typeof id === 'string').slice(0, 20),
        bestandenAm: String(wert.nachweise.ki.bestandenAm || '').slice(0, 40),
        modellSignatur: /^[0-9a-f]{64}$/.test(String(wert.nachweise.ki.modellSignatur || ''))
          ? wert.nachweise.ki.modellSignatur : null,
      } }
      : {}),
  };
  return {
    status: wert.status,
    quelle: leseQuelle(wert, schritte, nachweise),
    schritte,
    nachweise,
    eingeladenAm: typeof wert.eingeladenAm === 'string' ? wert.eingeladenAm.slice(0, 40) : null,
    abgeschlossenAm: typeof wert.abgeschlossenAm === 'string' ? wert.abgeschlossenAm.slice(0, 40) : null,
  };
}

async function mutiereZustand(mutator) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO postbuch._settings (key, value)
       VALUES ('einrichtung', $1::jsonb) ON CONFLICT (key) DO NOTHING`,
      [JSON.stringify(leererZustand())],
    );
    const r = await client.query("SELECT value FROM postbuch._settings WHERE key = 'einrichtung' FOR UPDATE");
    const zustand = normalisiereZustand(r.rows[0]?.value);
    await mutator(zustand);
    await client.query(
      `INSERT INTO postbuch._settings (key, value, updated_at)
       VALUES ('einrichtung', $1::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [JSON.stringify(zustand)],
    );
    await client.query('COMMIT');
    return zustand;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function pruefung(ok, pflicht, text, extra = {}) {
  return { ok: !!ok, pflicht: !!pflicht, text, ...extra };
}

function storageSignatur(settings, backend, folders, stabileKeys) {
  // Die lokale Ablage hat kein Geheimnis; ihr Nachweis hängt am eingebundenen
  // Ordner (wurzelAnzeige) und verfällt, wenn ein anderer Ordner eingebunden wird.
  const geheim = backend === 'onedrive'
    ? settings.onedrive_tokens
    : backend === 'lokal' ? lokal.wurzelAnzeige() : settings.nextcloud_app_password;
  return createHash('sha256').update(JSON.stringify({
    backend,
    baseUrl: backend === 'nextcloud' ? settings.nextcloud_base_url || null : null,
    username: backend === 'nextcloud' ? settings.nextcloud_username || null : null,
    // Der Nachweis muss auch bei einem Credential-Wechsel verfallen. Der
    // Klartext verlässt diese Funktion nicht; gespeichert wird nur der Hash.
    credential: geheim || null,
    // Leaf-Zellen L/D wachsen bewusst lazy. Sie sind kein Teil des
    // Einrichtungsnachweises, sonst verfiele dieser bei jedem neuen Dokument.
    folders: Object.entries(folders)
      .filter(([key]) => stabileKeys.has(key))
      .sort(([a], [b]) => a.localeCompare(b)),
  })).digest('hex');
}

async function getStabileFolderKeys() {
  const taxonomie = await getAktiveTaxonomie();
  return new Set([
    ...SYSTEM_FOLDERS.flatMap((def) => def.keys),
    ...taxonomie.lebensbereiche.map((x) => x.code),
  ]);
}

function kiModellSignatur(settings) {
  return createHash('sha256').update(JSON.stringify({
    modellwahl: modellwahl(settings),
    modelle: MODEL_CLASSES.map((cls) => [
      cls.key,
      resolveModelConfig(settings[cls.settingKey], cls.provider, cls.model),
    ]),
    embedding: embeddingConfig(settings),
  })).digest('hex');
}

export function pruefeModellklassen(settings, workingProviders, healthModels = null) {
  // Nur Klassen der aktuellen Modellwahl sind Pflicht; die ausgeblendeten
  // Stufen der anderen Wahl werden nie aufgerufen.
  return aktiveModellklassen(settings).map((cls) => {
    const cfg = resolveModelConfig(settings[cls.settingKey], cls.provider, cls.model);
    const providerOk = workingProviders.includes(cfg.providerId);
    const modellVerfuegbar = healthModels === null
      ? true
      : healthModels?.[cls.key]?.available === true;
    return {
      key: cls.key,
      settingKey: cls.settingKey,
      label: cls.label,
      gruppe: cls.group || 'pipeline',
      // Jede Aufgabe muss vor dem Abschluss ein nutzbares Modell haben — auch
      // Büroassistent und Akte. Ein „optionales" Chat-Modell, das ins Leere
      // zeigt, fällt sonst erst im Betrieb auf.
      pflicht: true,
      providerId: cfg.providerId,
      model: cfg.model,
      ok: providerOk && !!cfg.model && modellVerfuegbar,
      grund: !cfg.model
        ? 'Kein Modell gewählt.'
        : (!providerOk
          ? `Provider „${cfg.providerId}“ antwortet nicht oder ist nicht konfiguriert.`
          : (!modellVerfuegbar ? `Modell „${cfg.model}“ wurde beim Provider nicht gefunden.` : null)),
    };
  });
}

/**
 * Ist-Zustand der Host-Einstellungen für den Assistenten.
 *
 * Der Host-Agent meldet weder Port noch DuckDNS-Domain zurück; die App weiß
 * davon nur, was sie beim Erteilen des Auftrags selbst notiert hat
 * (`hostconfig_*`, siehe routes/updates.js). Für Instanzen, die vor dieser
 * Notiz eingerichtet wurden, wird allein die DuckDNS-Domain aus der
 * Basisadresse ABGELEITET und als solche gekennzeichnet — geraten wird nichts,
 * ein abgeleiteter Wert erscheint im UI ausdrücklich als Vorschlag.
 *
 * Den Tokenwert bekommt die App nie zu sehen — er steht in der .env und geht
 * von dort ausschließlich an caddy. Hier steht nur, ob einer hinterlegt ist;
 * das UI zeigt dafür Punkte statt eines Klartextfelds.
 */
// Ein WSL-Kernel nennt sich „…microsoft…“; der Container sieht den Kernel des
// Hosts. Unter Windows gibt erst install.ps1 neue Ports im Heimnetz frei.
let laeuftUnterWindows = null;
function unterWindows() {
  if (laeuftUnterWindows === null) {
    try { laeuftUnterWindows = /microsoft/i.test(readFileSync('/proc/sys/kernel/osrelease', 'utf8')); } catch { laeuftUnterWindows = false; }
  }
  return laeuftUnterWindows;
}

function envPortOder(name, standard) {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : standard;
}

function leseHostconfig(settings) {
  let hostAusBasis = null;
  try {
    hostAusBasis = new URL(String(settings.app_host || '').trim()).hostname || null;
  } catch { /* keine gültige Basisadresse — dann gibt es nichts abzuleiten */ }

  const duck = settings.hostconfig_duckdns;
  // Nach einem Abschalt-Auftrag gilt DuckDNS als aus: weder die (evtl. noch
  // nicht umgestellte) Basisadresse noch das Installer-Token dürfen dann
  // wieder einen aktiven Zustand vortäuschen.
  const abgeschaltet = !!duck?.abgeschaltetAm && !duck?.domain;
  const domain = duck?.domain
    || (!abgeschaltet && hostAusBasis && /\.duckdns\.org$/i.test(hostAusBasis) ? hostAusBasis : null);
  const port = settings.hostconfig_port;
  // Maßgeblich ist der Port, mit dem der Stack gerade läuft: Stellt der
  // Installer ihn um, bleibt der gespeicherte Wert sonst auf dem alten Stand.
  const envPort = Number(process.env.WEB_PORT);
  const laufenderPort = Number.isInteger(envPort) && envPort >= 1 && envPort <= 65535 ? envPort : null;

  return {
    windows: unterWindows(),
    // HTTPS-Port des caddy-Dienstes: Ist er nicht 443, gehört er in die Basisadresse.
    httpsPort: envPortOder('CADDY_HTTPS_PORT', 443),
    // Der Port wird NICHT aus app_host abgeleitet: hinter Caddy steht dort 443,
    // während der Host-Port des web-Containers etwas ganz anderes ist. Lieber
    // leer als falsch.
    port: {
      wert: laufenderPort || port?.port || null,
      quelle: laufenderPort || port?.port ? 'gespeichert' : null,
      angefordertAm: port?.angefordertAm || null,
    },
    duckdns: {
      domain,
      // 'installer' = beim Aufsetzen in die .env geschrieben (seed-settings.js),
      // 'gespeichert' = über diese Oberfläche an den Host-Agenten übergeben,
      // 'abgeleitet' = nur aus der Basisadresse erschlossen, also ein Vorschlag.
      quelle: duck?.domain ? (duck.quelle === 'installer' ? 'installer' : 'gespeichert') : (domain ? 'abgeleitet' : null),
      tokenGesetztAm: duck?.tokenGesetztAm || null,
      angefordertAm: duck?.angefordertAm || null,
      // Der Regelfall ist, dass install.sh das Token längst in die .env
      // geschrieben hat — von dort bekommt es ausschließlich der caddy-Dienst.
      // Die App erfährt über eine Compose-Variable NUR die Tatsache, nie den
      // Wert; das UI zeigt dafür Passwortpunkte statt eines leeren Feldes.
      tokenVorhanden: !abgeschaltet && (!!duck?.tokenGesetztAm || process.env.DUCKDNS_TOKEN_VORHANDEN === '1'),
      abgeschaltetAm: abgeschaltet ? duck.abgeschaltetAm : null,
    },
  };
}

/** Der Dienst selbst weiß es am besten: 503 = lädt sein Modell, Verbindung
 *  verweigert = Container startet, unbekannter Name = läuft hier gar nicht. */
function sondeLokaleKi() {
  return guardedFetchJson('http://llm:8080/health', {}, { allowPrivate: true, timeoutMs: 4000 })
    .then(() => 'antwortet', (e) => {
      const m = e?.message || '';
      if (/^HTTP 503\b/.test(m)) return 'laedt';
      if (/DNS-Auflösung|ENOTFOUND|EAI_AGAIN/.test(m)) return 'fehlt';
      return 'startet';
    });
}

/** Nach so langer Zeit ohne jede Änderung gilt die Einrichtung der lokalen KI
 *  als hängend: Der Assistent zeigt die Einstellungen dann wieder an. */
const LOKALKI_STILLSTAND_MS = 60 * 60 * 1000;
// Letzter beobachteter Stand (Text + Prozent) und seit wann er unverändert ist.
// Bewusst nur im Prozess: Ein App-Neustart beginnt die Stunde von vorn.
let lokalkiStand = { schluessel: null, seit: 0 };

function stillstandMarkieren(eintrag, jetzt = Date.now()) {
  if (!eintrag?.dauer) { lokalkiStand = { schluessel: null, seit: 0 }; return eintrag; }
  if (eintrag.ohneStillstand) {
    lokalkiStand = { schluessel: null, seit: 0 };
    const { ohneStillstand, ...rest } = eintrag;
    return { ...rest, haengt: false, unveraendertSeitMin: 0 };
  }
  const schluessel = `${eintrag.text}|${eintrag.prozent ?? ''}`;
  if (schluessel !== lokalkiStand.schluessel) lokalkiStand = { schluessel, seit: jetzt };
  const haengt = jetzt - lokalkiStand.seit >= LOKALKI_STILLSTAND_MS;
  return { ...eintrag, haengt, unveraendertSeitMin: Math.floor((jetzt - lokalkiStand.seit) / 60000) };
}

/**
 * Welche eingebauten Dienste starten noch? Lokale KI: der Host-Agent meldet
 * Download-Stand und Ladezustand. Embedding: der Dienst selbst (/v1/modelle).
 * Liefert je Dienst `null` (nichts zu warten) oder `{ prozent, text }`.
 */
async function ermittleLadevorgang({ agent, workingProviders, embeddingGewaehlt, embeddingBereit }) {
  const r = { lokaleKi: null, embedding: null };
  const lk = agent?.vorhanden ? agent.stack?.lokalki : null;
  if (!workingProviders.includes(LOKAL_ID)) {
    // Der Dienst selbst weiß es am besten: 503 = lädt sein Modell, Verbindung
    // verweigert = Container startet, unbekannter Name = läuft auf diesem
    // System gar nicht. Der Heartbeat des Agenten kommt nur einmal pro Minute.
    const sonde = await sondeLokaleKi();
    // Der Host-Auftrag lädt das Modell, bevor der Container überhaupt existiert:
    // dann gibt es weder Heartbeat-Hinweis noch Dienst – nur Anforderung und
    // status.json des Agenten.
    const [lauf, anforderung] = await Promise.all([
      leseLaufStatus().catch(() => null),
      leseAnforderung().catch(() => null),
    ]);
    const hostLaeuft = lauf?.status === 'laeuft' && lauf.typ === 'module'
      && (['download', 'pruefung', 'image', 'start'].includes(lauf.phase || '')
        || /lokale(n)? KI/i.test(lauf.meldung || ''));
    const angefordert = anforderung?.typ === 'module' && anforderung.wert === 'lokalki:an';
    const herunterladen = lk?.profilAktiv === true && lk.vollstaendig === false;
    // Antwortet der Dienst, ist nichts mehr abzuwarten – egal was Heartbeat
    // oder status.json (noch) sagen. Sonst bliebe „wird gestartet“ stehen
    // und der Assistent löste den abschließenden Test nie aus.
    if (sonde === 'antwortet') {
      r.lokaleKi = { prozent: null, dauer: false, text: 'Die lokale KI ist bereit und wird jetzt geprüft.' };
    } else if (hostLaeuft) {
      const gb = (b) => (b / 1e9).toFixed(1).replace('.', ',');
      const hatZahlen = lauf.phase === 'download' && lauf.gesamtBytes > 0 && lauf.fortschrittBytes !== null;
      const prozent = hatZahlen ? Math.min(99, Math.floor((lauf.fortschrittBytes * 100) / lauf.gesamtBytes)) : null;
      const text = lauf.phase === 'download'
        ? `Das Modell der lokalen KI wird heruntergeladen${hatZahlen ? `: ${gb(lauf.fortschrittBytes)} von ${gb(lauf.gesamtBytes)} GB (${prozent} %)` : ''}.`
        : lauf.phase === 'pruefung' ? 'Die heruntergeladene Modelldatei wird geprüft.'
        : lauf.phase === 'image' ? 'Das Programm der lokalen KI wird heruntergeladen (je nach Rechner 1 bis 4,5 GB, ohne Fortschrittsanzeige).'
        : lauf.phase === 'start'
          ? (sonde === 'laedt' ? 'Die lokale KI lädt ihr Modell in den Arbeitsspeicher.' : 'Die lokale KI wird gestartet.')
        : 'Die Einrichtung der lokalen KI wird vorbereitet (Speicherplatz und Arbeitsspeicher werden geprüft).';
      // Beim Laden des Programms (docker pull) gibt es keinen Zwischenstand –
      // der Text bleibt auch bei gesundem Download gleich. Dort begrenzt die
      // Frist des Host-Agenten; ein Stillstand lässt sich nicht erkennen.
      r.lokaleKi = { prozent, dauer: true, text, ohneStillstand: lauf.phase === 'image' };
    } else if (angefordert) {
      r.lokaleKi = { prozent: null, dauer: true, text: 'Die Einrichtung der lokalen KI ist angefordert und beginnt gleich.' };
    } else if (herunterladen) {
      const soll = Number(lk.bedarf?.bytes) || 0;
      const prozent = soll > 0 ? Math.min(99, Math.floor(((Number(lk.vorhandenBytes) || 0) * 100) / soll)) : null;
      r.lokaleKi = { prozent, dauer: true, text: `Das Modell der lokalen KI wird heruntergeladen${prozent !== null ? ` (${prozent} %)` : ''}.` };
    } else if (sonde === 'laedt' || sonde === 'startet' || (lk?.profilAktiv === true && sonde !== 'fehlt')) {
      r.lokaleKi = { prozent: null, dauer: true, text: sonde === 'laedt' ? 'Die lokale KI lädt ihr Modell in den Arbeitsspeicher.' : 'Die lokale KI wird gestartet.' };
    }
  }
  r.lokaleKi = stillstandMarkieren(r.lokaleKi);
  if (embeddingGewaehlt && !embeddingBereit) {
    const dienst = await modellZustaende().catch(() => null);
    const laedt = (dienst?.modelle || []).find((m) => m.zustand === 'laedt');
    const fehler = (dienst?.modelle || []).some((m) => m.zustand === 'fehler');
    if (dienst && !dienst.laeuft) {
      r.embedding = { prozent: null, dauer: true, text: 'Der Embedding-Dienst startet noch.' };
    } else if (laedt) {
      r.embedding = { prozent: laedt.prozent, dauer: true, text: `Der Embedding-Dienst lädt sein Modell herunter${Number.isFinite(laedt.prozent) ? ` (${laedt.prozent} %)` : ''}.` };
    } else if (dienst?.laeuft && !fehler) {
      r.embedding = { prozent: null, dauer: false, text: 'Der Embedding-Dienst ist bereit.' };
    }
  }
  return r;
}

async function baueIstpruefung(settings, { aiPruefen = false, storageSelbsttest = false } = {}) {
  const wizardZustand = normalisiereZustand(settings.einrichtung);
  const backend = getActiveBackendName(settings);
  const folders = getFolders(settings, backend);
  const stabileKeys = await getStabileFolderKeys();
  const erwarteteFolderKeys = [...stabileKeys];
  const fehlendeFolderKeys = erwarteteFolderKeys.filter((key) => !folders[key]);
  const folderCount = erwarteteFolderKeys.length - fehlendeFolderKeys.length;
  const storageVerbunden = backend === 'lokal'
    ? await lokal.testeVerbindung().then(() => true, () => false)
    : backend === 'onedrive'
    ? !!settings.onedrive_tokens
    : !!(settings.nextcloud_base_url && settings.nextcloud_username && settings.nextcloud_app_password);
  const storageNachweis = wizardZustand.nachweise.storage?.backend === backend
    && wizardZustand.nachweise.storage?.signatur === storageSignatur(settings, backend, folders, stabileKeys)
    ? wizardZustand.nachweise.storage
    : null;

  // Hat sich diese Instanz schon auf ein Backend festgelegt? Dieselben Signale
  // wie im Assistenten, damit UI und Server nicht auseinanderlaufen: bereits
  // eingetragene Zugangsdaten zählen als Festlegung, auch ohne Verbindung.
  const backendGewaehlt = settings.storage_backend_selected === true
    || Object.keys(folders).length > 0
    || storageVerbunden
    || !!settings.onedrive_client_id
    || !!settings.nextcloud_base_url;

  // Antwortet die lokale KI schon, gilt sie sofort als an – der Heartbeat des
  // Agenten käme erst bis zu eine Minute später.
  if (aiPruefen && await sondeLokaleKi() === 'antwortet') {
    await lokalenProviderBeiAntwortAktivieren().catch(() => {});
  }

  const [{ rows: menschenRows }, { rows: docRows }, agent, ai] = await Promise.all([
    db.query('SELECT count(*)::int AS anzahl FROM postbuch.mensch WHERE aktiv = true'),
    db.query('SELECT EXISTS (SELECT 1 FROM postbuch.postbuch) AS vorhanden'),
    leseAgentStatus().catch(() => ({ vorhanden: false, capabilities: [] })),
    aiPruefen
      ? buildAiHealth({ fresh: true }).catch(() => ({ providers: {}, models: {}, subscription: {} }))
      : Promise.resolve(null),
  ]);

  const dokumenteVorhanden = docRows[0]?.vorhanden === true;

  const aktuelleKiModellSignatur = kiModellSignatur(settings);
  const kiNachweisAktuell = wizardZustand.nachweise.ki?.modellSignatur === aktuelleKiModellSignatur;
  const nachweisProvider = kiNachweisAktuell ? (wizardZustand.nachweise.ki?.workingProviders || []) : [];
  // Der Nachweis aus einer Sicherung sagt nichts über den Dienst auf diesem Host.
  const lokalerNachweisGueltig = !settings.nach_restore || lokalProviderSoll(agent)?.aktiv === true;
  const workingProviders = aiPruefen
    ? Object.values(ai?.providers || {}).filter((p) => p.working).map((p) => p.id)
    : nachweisProvider.filter((id) => id !== LOKAL_ID || lokalerNachweisGueltig);
  // Der Assistent stellt zwei verschiedene Fragen: „antwortet ein
  // Sprachmodell-Provider?" und „antwortet ein Provider, der Embeddings kann?".
  // Ein 2-in-1-Provider (OpenAI) beantwortet beide auf einmal. Die Fähigkeit
  // kommt aus der deklarativen Registry, nicht aus dem Health-Bericht — sonst
  // stünde ohne frischen Test überall „kein Provider".
  //
  // Das Embedding hat keine Werkseinstellung: ohne gespeicherten Slot ist gar
  // kein Modell gewählt, und Suche, Duplikatprüfung und Hilfekorpus bleiben
  // ohne Vektoren. Gewählt allein reicht aber nicht — der Provider des Modells
  // muss auch antworten.
  const alleProvider = listProviders(settings);
  const providerCaps = new Map(alleProvider.map((p) => [p.id, p.caps]));
  // Der eingebaute Embedding-Dienst antwortet immer, ist aber kein Sprachmodell.
  const nurEmbedding = new Set(alleProvider.filter((p) => p.nurEmbedding).map((p) => p.id));
  const llmProviders = workingProviders.filter((id) => !nurEmbedding.has(id));
  const embeddingProviders = workingProviders.filter((id) => providerCaps.get(id)?.embeddings === true);
  const embedding = embeddingConfig(settings);
  const embeddingKonfiguriert = !!embedding.model && workingProviders.includes(embedding.providerId);
  const modellklassen = pruefeModellklassen(settings, workingProviders, aiPruefen ? ai?.models : null);
  // Dienste, die noch hochfahren oder ihr Modell laden. Ohne diese Auskunft
  // sähe der Assistent aus, als sei etwas kaputt, obwohl nur gewartet wird.
  const ladevorgang = await ermittleLadevorgang({
    agent, workingProviders,
    embeddingGewaehlt: nurEmbedding.has(embedding.providerId),
    embeddingBereit: embeddingKonfiguriert,
  });
  const pflichtmodelleOk = modellklassen.filter((x) => x.pflicht).every((x) => x.ok);
  // Eine eingetragene Adresse ist noch keine Konfiguration: erst der Abruf der
  // Fähigkeiten beweist, dass unter der URL wirklich ein eSCL-Scanner steht.
  // Beides zu vermengen hat dem Assistenten „nicht konfiguriert" sagen lassen,
  // während er die gültige Scanner-URL daneben anzeigte.
  const scannerUrlGesetzt = !!String(settings.scanner_device_url || '').trim();
  const scannerKonfiguriert = !!settings.scanner_capabilities;
  const backupEntschieden = backupEntscheidungGespeichert(settings, wizardZustand);
  const backupAktivWert = settings.backup?.enabled === true;
  // Ohne aktives Backup gibt es nichts zu verschlüsseln — die Frage ist dann
  // gegenstandslos und darf den Assistenten nicht blockieren.
  const backupVerschluesselungEntschiedenWert = !backupAktivWert
    || backupVerschluesselungEntschieden(settings, wizardZustand);
  const verschluesselung = verschluesselungsStatus(settings);
  const discordKonfiguriert = !!(settings.discord_webhook_url
    || (settings.discord_bot_token && settings.discord_channel_id));

  let selbsttest = null;
  if (storageSelbsttest && storageVerbunden) {
    selbsttest = await runAdapterConformance(backend).catch((err) => ({ ok: false, fehler: err.message }));
  }

  const pruefungen = {
    betrieb: pruefung(
      !!String(settings.instance_name || '').trim() && !!String(settings.app_host || '').trim(),
      true,
      'Instanzname und Basisadresse sind gesetzt.',
      { instanznameGesetzt: !!String(settings.instance_name || '').trim(), basisadresseGesetzt: !!String(settings.app_host || '').trim() },
    ),
    hostAgent: pruefung(
      agent.vorhanden,
      false,
      agent.vorhanden ? 'Host-Agent ist erreichbar.' : 'Kein aktueller Host-Agent-Heartbeat.',
      { vorhanden: !!agent.vorhanden, version: agent.version || null, capabilities: agent.capabilities || [], letzterLaufAm: agent.letzterLaufAm || null, scannerProfilAktiv: agent.scannerProfilAktiv, duckdnsIp: agent.duckdnsIp || null, lanIp: agent.lan?.ip || null },
    ),
    menschen: pruefung(
      Number(menschenRows[0]?.anzahl || 0) > 0,
      false,
      Number(menschenRows[0]?.anzahl || 0) > 0
        ? 'Mindestens eine aktive Person ist angelegt.'
        : 'Es ist noch keine aktive Person angelegt.',
      { anzahl: Number(menschenRows[0]?.anzahl || 0) },
    ),
    // Verbindung und Selbsttest sind BEWUSST zwei Prüfungen. Der Selbsttest
    // lässt sich erst im Ordner-Schritt auslösen; als Teil der Ablage-Prüfung
    // stand seine Mahnung einen Schritt zu früh — dort, wo es keinen Knopf
    // dafür gibt.
    ablage: pruefung(
      storageVerbunden,
      true,
      storageVerbunden
        ? `${BACKEND_LABEL[backend] || backend} ist verbunden.`
        : 'Ablage (OneDrive/Nextcloud) ist noch nicht verbunden.',
      {
        backend,
        verbunden: storageVerbunden,
        gewaehlt: backendGewaehlt,
        // Solange nichts verbunden ist, keine Ordner angelegt wurden und noch
        // kein Dokument existiert, ist die Wahl des Backends folgenlos — und
        // damit umkehrbar. Ein Fehlklick im Assistenten darf keine Sackgasse
        // sein (Gegenstück: DELETE /api/settings/storage/initial-backend).
        wechselMoeglich: !storageVerbunden
          && Object.keys(folders).length === 0
          && dokumenteVorhanden === false,
      },
    ),
    // Empfohlen, nicht Pflicht: der Test arbeitet in einem eigenen Ordner und
    // beweist nichts, was die Ordnerstruktur voraussetzt. Als Pflicht hätte
    // ihn jedes spätere Anlegen der Ordner (neue IDs → neue Signatur) erneut
    // erzwungen.
    ablageSelbsttest: pruefung(
      storageVerbunden && (!!storageNachweis || selbsttest?.ok === true),
      false,
      !storageVerbunden
        ? 'Der Selbsttest wartet auf die verbundene Ablage.'
        : (storageNachweis || selbsttest?.ok
          ? 'Der Ablage-Selbsttest ist bestanden.'
          : 'Der Ablage-Selbsttest wurde noch nicht ausgeführt (empfohlen).'),
      { backend, selbsttestBestandenAm: storageNachweis?.bestandenAm || null, selbsttest },
    ),
    ordner: pruefung(
      fehlendeFolderKeys.length === 0,
      true,
      // Vor dem ersten Anlegen ist „0 von 21 Ablage-Zuordnungen" eine
      // Buchhaltungsauskunft, die niemand braucht: es fehlt schlicht alles.
      // Erst der Teilbestand rechtfertigt die Zahlen — dann sagen sie, wie weit
      // es ist.
      fehlendeFolderKeys.length === 0
        ? `Alle ${erwarteteFolderKeys.length} Ablage-Zuordnungen sind konfiguriert.`
        : (folderCount === 0
          ? 'Die Ordnerstruktur ist noch nicht angelegt.'
          : `${folderCount} von ${erwarteteFolderKeys.length} Ablage-Zuordnungen sind konfiguriert.`),
      { anzahl: folderCount, erwartet: erwarteteFolderKeys.length, fehlend: fehlendeFolderKeys },
    ),
    kiLlm: pruefung(
      llmProviders.length > 0 && pflichtmodelleOk,
      true,
      llmProviders.length === 0
        ? (ladevorgang.lokaleKi
          ? `${ladevorgang.lokaleKi.text}${ladevorgang.lokaleKi.dauer ? ' Das kann einige Minuten dauern.' : ''}`
          : 'Noch kein Sprachmodell-Provider erfolgreich getestet.')
        : (!pflichtmodelleOk
          ? `${modellklassen.filter((x) => x.pflicht && !x.ok).length} von ${modellklassen.length} Aufgaben haben noch kein nutzbares Modell.`
          : `Alle ${modellklassen.length} Aufgaben sind einem nutzbaren Modell zugeordnet.`),
      {
        workingProviders,
        llmProviders,
        embeddingProviders,
        modellklassen,
        pflichtmodelleOk,
        modellSignatur: aktuelleKiModellSignatur,
        laedt: ladevorgang.lokaleKi,
      },
    ),
    kiEmbedding: pruefung(
      embeddingKonfiguriert,
      true,
      nurEmbedding.has(embedding.providerId)
        ? (embeddingKonfiguriert
          ? 'Der eingebaute Embedding-Dienst ist einsatzbereit.'
          : (ladevorgang.embedding
            ? `${ladevorgang.embedding.text}${ladevorgang.embedding.dauer ? ' Das kann einige Minuten dauern.' : ''}`
            : 'Der eingebaute Embedding-Dienst antwortet noch nicht.'))
        : embeddingProviders.length === 0
        ? 'Noch kein Embedding-Provider erfolgreich getestet.'
        : (!embedding.model
          ? 'Es ist noch kein Embedding-Modell gewählt.'
          : (!embeddingKonfiguriert
            ? `Das Embedding-Modell (${embedding.providerId || '—'}/${embedding.model}) ist noch nicht nutzbar.`
            : `Embedding-Modell ${embedding.providerId}/${embedding.model} ist einsatzbereit.`)),
      {
        workingProviders,
        llmProviders,
        embeddingProviders,
        embeddingKonfiguriert,
        embeddingEingebaut: nurEmbedding.has(embedding.providerId),
        embedding: { providerId: embedding.providerId, model: embedding.model, dim: embedding.dim },
        embeddingExplizit: !!settings.llm_embedding?.model,
        modellSignatur: aktuelleKiModellSignatur,
        laedt: ladevorgang.embedding,
      },
    ),
    scanner: pruefung(
      scannerKonfiguriert && agent.scannerProfilAktiv !== false,
      false,
      scannerKonfiguriert && agent.scannerProfilAktiv === false
        ? 'Scanner antwortet, aber der Scan-Dienst läuft auf diesem System nicht.'
        : scannerKonfiguriert
        ? 'Scanner ist eingerichtet und hat auf den Test geantwortet.'
        : (scannerUrlGesetzt
          ? 'Scanner-Adresse ist eingetragen, aber noch nicht erfolgreich getestet.'
          : 'Scanner ist optional und noch nicht eingerichtet.'),
      {
        konfiguriert: scannerKonfiguriert,
        adresseGesetzt: scannerUrlGesetzt,
        geraet: settings.scanner_capabilities?.geraet || null,
        profilSteuerbar: !!agent.capabilities?.includes('module'),
        profilAktiv: agent.scannerProfilAktiv,
      },
    ),
    backup: pruefung(
      backupEntschieden && backupVerschluesselungEntschiedenWert,
      true,
      !backupEntschieden
        ? 'Backup oder NOBACKUP wurde noch nicht bestätigt.'
        : (!backupVerschluesselungEntschiedenWert
          ? 'Backup-Verschlüsselung wurde noch nicht bestätigt (aktivieren oder ausdrücklich ablehnen).'
          : 'Die Backup-Entscheidung wurde bewusst gespeichert.'),
      {
        backupEntschieden,
        backupAktiv: backupAktivWert,
        discordKonfiguriert,
        updateAgentVorhanden: !!agent.vorhanden,
        verschluesselungEntschieden: backupVerschluesselungEntschiedenWert,
        // Ausdrücklich abgelehnt? Nur dann zeigt der Assistent „bewusst
        // unverschlüsselt“. Eine Bestandsinstanz ohne diese Entscheidung ist für
        // den Abschluss zwar nicht offen, bekommt aber trotzdem das Formular.
        verschluesselungAbgelehnt: settings.backup_encryption?.bewusst === true && !verschluesselung.enabled,
        verschluesselungAktiv: verschluesselung.enabled,
      },
    ),
  };
  const pflichtOffen = Object.entries(pruefungen)
    .filter(([, p]) => p.pflicht && !p.ok)
    .map(([id]) => id);
  return { pruefungen, pflichtOffen, bereit: pflichtOffen.length === 0 };
}

export async function gesamtbild({ aiPruefen = false, storageSelbsttest = false } = {}) {
  const settings = await loadDynamicSettings();
  const zustand = normalisiereZustand(settings.einrichtung);
  const ist = await baueIstpruefung(settings, { aiPruefen, storageSelbsttest });
  const nachRestore = await nachRestoreBild(settings).catch(() => null);
  return {
    status: zustand.status,
    quelle: zustand.quelle,
    // Nur eine vom Installer markierte Erstinstallation darf die Oberfläche
    // sperren; das Gate in routes/settings-public.js liest genau dieses Feld.
    sperrt: zustand.status === 'offen' && zustand.quelle === 'installation',
    schritte: zustand.schritte,
    eingeladenAm: zustand.eingeladenAm,
    abgeschlossenAm: zustand.abgeschlossenAm,
    automatischEinladen: zustand.status === 'offen' && !zustand.eingeladenAm,
    hostconfig: leseHostconfig(settings),
    // Nach einem Restore: Vergleich mit dem Stack der Sicherung. Bleibt
    // stehen, bis der Assistent abgeschlossen oder der Hinweis erledigt ist.
    nachRestore,
    ...ist,
  };
}

router.get('/', async (req, res) => {
  try {
    // GET bleibt read-only. Aktive Netzwerk-/Storage-Prüfungen laufen nur über
    // den ausdrücklichen POST /pruefen.
    res.json(await gesamtbild());
  } catch (err) {
    console.error('[einrichtung] Status fehlgeschlagen:', err);
    res.status(500).json({ error: 'Einrichtungsstatus konnte nicht geprüft werden.' });
  }
});

router.post('/pruefen', async (req, res) => {
  try {
    const mitStorage = req.body?.storageSelbsttest === true;
    const bild = await gesamtbild({ aiPruefen: true, storageSelbsttest: mitStorage });
    const storageBestanden = mitStorage && bild.pruefungen.ablageSelbsttest.selbsttest?.ok === true;
    // Der Nachweis hält fest, WELCHE Provider beim letzten echten Test
    // geantwortet haben — bewusst NICHT an kiLlm.ok/kiEmbedding.ok gekoppelt:
    // die verlangen zusätzlich pflichtmodelleOk, also dass jede Aufgabe schon
    // einem Modell zugeordnet ist. Genau diese Zuordnung passiert erst im
    // NÄCHSTEN Schritt "Modelle je Aufgabe", der ohne diesen Nachweis gar
    // nicht erst freigeschaltet wird — sonst bliebe die Stufe für jeden neu
    // hinzugefügten (nicht-eingebauten) Provider dauerhaft gesperrt, obwohl
    // "Wird frei, sobald ein Provider den Test bestanden hat" etwas anderes
    // verspricht. Ein antwortender Provider genügt als Nachweis.
    const kiBestanden = bild.pruefungen.kiLlm.llmProviders.length > 0;
    if (storageBestanden || kiBestanden) {
      const settings = await loadDynamicSettings();
      // Eine Prüfung ist eine Messung, kein Startsignal. Sie hält nur
      // Nachweise fest und aktiviert NIE die Ersteinrichtung — sonst sperrt
      // sich eine laufende Instanz aus, sobald jemand den Assistenten öffnet.
      await mutiereZustand(async (zustand) => {
        if (storageBestanden) {
          const backend = bild.pruefungen.ablageSelbsttest.backend;
          const stabileKeys = await getStabileFolderKeys();
          zustand.nachweise.storage = {
            backend,
            bestandenAm: new Date().toISOString(),
            signatur: storageSignatur(settings, backend, getFolders(settings, backend), stabileKeys),
          };
        }
        if (kiBestanden) {
          zustand.nachweise.ki = {
            workingProviders: bild.pruefungen.kiLlm.workingProviders,
            bestandenAm: new Date().toISOString(),
            // Exakt die Konfiguration signieren, die buildAiHealth oben
            // geprüft hat. Ein paralleles Settings-Speichern kann dadurch
            // keinen ungetesteten S2-Zustand mit dem S1-Ergebnis adeln.
            modellSignatur: bild.pruefungen.kiLlm.modellSignatur,
          };
        }
      });
      return res.json(await gesamtbild());
    }
    res.json(bild);
  } catch (err) {
    console.error('[einrichtung] Istprüfung fehlgeschlagen:', err);
    res.status(502).json({ error: 'Istprüfung konnte nicht vollständig ausgeführt werden.' });
  }
});

// Vor dem TLS-Auftrag: zeigt die DuckDNS-Domain auf diesen Host, und gibt der
// Router die Antwort weiter (DNS-Rebind-Schutz)? Reine Messung, schreibt nichts.
router.post('/duckdns-pruefen', async (req, res) => {
  const domain = String(req.body?.domain ?? '').trim().toLowerCase();
  if (!DUCKDNS_DOMAIN_RE.test(domain)) {
    return res.status(400).json({ error: 'Erwartet wird eine Domain der Form name.duckdns.org.' });
  }
  try {
    const agent = await leseAgentStatus().catch(() => null);
    res.json(await pruefeDuckdnsAufloesung(domain, agent?.lan?.ip ?? null));
  } catch (err) {
    console.error('[einrichtung] DuckDNS-Prüfung fehlgeschlagen:', err);
    res.status(502).json({ error: 'DuckDNS-Prüfung konnte nicht ausgeführt werden.' });
  }
});

router.post('/storage-selbsttest/start', async (_req, res) => {
  try {
    const settings = await loadDynamicSettings();
    const backend = getActiveBackendName(settings);
    const jobId = tracker.create('storage-selftest', `Ablage-Selbsttest (${backend})`, SELFTEST_TOTAL_STEPS, false);
    res.status(202).json({ ok: true, jobId });
    void (async () => {
      try {
        await tracker.awaitPersisted(jobId);
        const result = await runAdapterConformance(backend, ({ schritt, name }) => {
          tracker.setStep(jobId, schritt, name);
        });
        if (result.ok) {
          const aktuell = await loadDynamicSettings();
          const stabileKeys = await getStabileFolderKeys();
          await mutiereZustand(async (zustand) => {
            zustand.nachweise.storage = {
              backend,
              bestandenAm: new Date().toISOString(),
              signatur: storageSignatur(aktuell, backend, getFolders(aktuell, backend), stabileKeys),
            };
          });
        }
        if (result.ok) tracker.complete(jobId, result);
        else {
          const erster = result.schritte?.find((s) => !s.ok);
          tracker.fail(jobId, erster ? `Selbsttest fehlgeschlagen: ${erster.name}` : 'Ablage-Selbsttest fehlgeschlagen.');
        }
      } catch (err) {
        tracker.fail(jobId, err.message);
      }
    })();
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Nach einem Restore: Der erste Admin-Login landet einmal im Assistenten,
// wenn etwas nicht mehr passt. Öffnet ihn wie /oeffnen (manuell, sperrt nicht).
router.post('/nach-restore/eingeladen', async (_req, res) => {
  await nachRestoreMarkieren('eingeladenAm');
  await mutiereZustand(async (aktuell) => {
    aktuell.status = 'offen';
    aktuell.quelle = 'manuell';
    aktuell.eingeladenAm = new Date().toISOString();
    aktuell.abgeschlossenAm = null;
  });
  res.json({ ok: true });
});

router.post('/nach-restore/erledigt', async (req, res) => {
  await nachRestoreErledigt();
  await appLog('INFO', 'einrichtung', 'Hinweis nach der Wiederherstellung als erledigt markiert', { entity: 'settings', entityId: req.session?.username || 'admin' });
  res.json({ ok: true });
});

router.post('/einladung', async (req, res) => {
  let istOffen = true;
  await mutiereZustand(async (zustand) => {
    if (zustand.status !== 'offen') { istOffen = false; return; }
    if (!zustand.eingeladenAm) zustand.eingeladenAm = new Date().toISOString();
  });
  if (!istOffen) return res.status(409).json({ error: 'Keine offene Ersteinrichtung.' });
  res.json({ ok: true });
});

router.put('/schritte/:id', async (req, res) => {
  const id = String(req.params.id || '');
  if (!SCHRITTE.has(id)) return res.status(400).json({ error: 'Unbekannter Einrichtungsschritt.' });
  if (typeof req.body?.abgeschlossen !== 'boolean') {
    return res.status(400).json({ error: 'Feld "abgeschlossen" muss ein Boolean sein.' });
  }
  const zustand = await mutiereZustand(async (aktuell) => {
    // Abgehakte Schritte werden auch außerhalb einer Ersteinrichtung
    // gemerkt, ändern den Status aber nicht (siehe POST /pruefen).
    if (req.body.abgeschlossen) aktuell.schritte[id] = { abgeschlossenAm: new Date().toISOString() };
    else delete aktuell.schritte[id];
  });
  res.json({ ok: true, schritte: zustand.schritte });
});

router.post('/abschliessen', async (req, res) => {
  const bild = await gesamtbild({ aiPruefen: true });
  if (!bild.bereit) {
    return res.status(409).json({ error: 'Pflichtprüfungen sind noch offen.', pflichtOffen: bild.pflichtOffen });
  }
  const zustand = await mutiereZustand(async (aktuell) => {
    aktuell.status = 'abgeschlossen';
    aktuell.abgeschlossenAm = new Date().toISOString();
    aktuell.schritte.abschluss = { abgeschlossenAm: aktuell.abgeschlossenAm };
  });
  await nachRestoreErledigt();
  await appLog('INFO', 'einrichtung', 'Einrichtungsassistent abgeschlossen', { entity: 'settings', entityId: req.session?.username || 'admin' });
  res.json({ ok: true, status: zustand.status });
});

router.post('/ueberspringen', async (req, res) => {
  const zustand = await mutiereZustand(async (aktuell) => {
    aktuell.status = 'uebersprungen';
    aktuell.abgeschlossenAm = new Date().toISOString();
  });
  await appLog('INFO', 'einrichtung', 'Einrichtungsassistent übersprungen', { entity: 'settings', entityId: req.session?.username || 'admin' });
  res.json({ ok: true, status: zustand.status });
});

router.post('/trotzdem-ansehen', async (req, res) => {
  req.session.einrichtungBypass = true;
  await new Promise((resolve, reject) => req.session.save((err) => (err ? reject(err) : resolve())));
  await appLog('WARN', 'einrichtung', 'Offene Ersteinrichtung für diese Sitzung bewusst verlassen', {
    entity: 'settings', entityId: req.session?.username || 'admin',
  });
  res.json({ ok: true });
});

router.post('/oeffnen', async (_req, res) => {
  const zustand = await mutiereZustand(async (aktuell) => {
    aktuell.status = 'offen';
    // Von Hand geöffnet: Der Assistent begleitet, sperrt die Oberfläche
    // aber nicht. Nur der Seed einer echten Erstinstallation setzt
    // `installation` (siehe leseQuelle).
    aktuell.quelle = 'manuell';
    // Manueller Aufruf ist keine automatische Einladung und darf nach dem
    // Verlassen nicht erneut umleiten.
    aktuell.eingeladenAm = new Date().toISOString();
    aktuell.abgeschlossenAm = null;
  });
  res.json({ ok: true, status: zustand.status });
});

export default router;
