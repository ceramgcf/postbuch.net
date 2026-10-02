/**
 * lib/update-agent-datei.js — die Übergabe App ↔ Host-Agent
 *
 * **Der app-Container bleibt unprivilegiert.** Kein Docker-Socket, kein Mount
 * des Quellbaums, kein `docker`-Aufruf. Die App darf ein Update *anfordern*,
 * niemals ausführen. Ausgeführt wird es von `scripts/postbuch-update-agent.sh`
 * auf dem Host (systemd-Timer als root, cron als Fallback).
 *
 * Einzige Berührungsfläche ist ein Verzeichnis, das beide sehen:
 *
 *   /data/update/
 *     agent.json        ← Agent → App: Heartbeat, auch ohne Arbeit
 *     anforderung.kv    ← App → Agent: key=value, Agent löscht sie nach Abholung
 *     status.json       ← Agent → App: Zustand des laufenden/letzten Laufs
 *     update.log        ← Agent → App: Klartext, App liest nur den Schwanz
 *     verlauf/<nonce>/  ← Agent: abgeschlossene Läufe (zugleich Nonce-Sperre)
 *
 * **`anforderung.kv` ist bewusst `key=value`, kein JSON.** Der Agent ist ein
 * Bash-Skript; ein JSON-Parser in Bash wäre entweder eine Abhängigkeit (`jq`)
 * oder gebastelt. Umgekehrt sind `agent.json`/`status.json` JSON, weil sie der
 * Agent aus einem *festen Vokabular* schreibt und nur die App sie liest.
 *
 * **Zustände:** angefordert → laeuft → erfolgreich | fehlgeschlagen | abgelehnt
 *
 * **Replay-Schutz zweifach:** der Agent führt eine Nonce nur einmal aus
 * (`verlauf/<nonce>/` ist die Sperre) *und* lehnt Anforderungen ab, deren
 * `angefordertAm` älter als 10 Minuten ist. Eine zurückkopierte alte
 * `anforderung.kv` löst damit kein zweites Update aus.
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const UPDATE_DIR = process.env.POSTBUCH_UPDATE_DIR || '/data/update';

/** Protokollversion der Übergabe. Agent und App müssen übereinstimmen. */
export const AGENT_PROTOKOLL = 2;
export const UPDATE_ANFORDERUNG_PROTOKOLL = 1;

/** Ab wann gilt ein Heartbeat als veraltet ⇒ „kein Agent vorhanden"? */
const HEARTBEAT_MAX_ALTER_MS = 10 * 60 * 1000;

/** Ab wann darf der Agent eine Anforderung nicht mehr ausführen? */
export const ANFORDERUNG_MAX_ALTER_MIN = 10;

/** So viele Log-Zeilen gehen ans UI. */
const LOG_TAIL_ZEILEN = 200;
const LOG_TAIL_MAX_BYTES = 256 * 1024;

const P = {
  agent:       () => path.join(UPDATE_DIR, 'agent.json'),
  anforderung: () => path.join(UPDATE_DIR, 'anforderung.kv'),
  status:      () => path.join(UPDATE_DIR, 'status.json'),
  log:         () => path.join(UPDATE_DIR, 'update.log'),
};

/** Entfernt den sichtbaren Log-Tail des vorigen Laufs vor einer neuen Anfrage. */
async function altesLogEntfernen() {
  try {
    await fs.unlink(P.log());
  } catch (err) {
    // Kein Log ist beim ersten Lauf normal. Ein nicht löschbares altes Log darf
    // die eigentliche, atomare Update-Anforderung aber nicht verhindern.
    if (err?.code !== 'ENOENT') return;
  }
}

const STATUS_WERTE = ['laeuft', 'erfolgreich', 'fehlgeschlagen', 'abgelehnt'];
/** Läuft-Typen: eine echte Software-Version oder ein reiner Host-Konfigurationsauftrag. */
const LAUF_TYP_WERTE = ['update', 'netzwerk', 'module', 'port', 'duckdns'];
const MODI = ['normal', 'dry-run'];
const DOCKER_ARTEN = ['direkt', 'sudo'];

async function leseJson(pfad) {
  try {
    const roh = await fs.readFile(pfad, 'utf8');
    if (roh.length > 64 * 1024) return null;
    const o = JSON.parse(roh);
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
  } catch {
    return null;
  }
}

// ── Agent-Heartbeat ──────────────────────────────────────────────────────────

/**
 * Ist ein Host-Agent vorhanden und aktuell?
 *
 * „Vorhanden" heißt: `agent.json` existiert, die Protokollversion passt und der
 * Heartbeat ist jünger als 10 Minuten. Ein einmal installierter, aber
 * gestoppter Timer soll die GUI nicht dazu bringen, einen Installieren-Button
 * anzubieten, der nie abgeholt wird.
 *
 * @returns {Promise<{vorhanden:boolean, modus:string|null, docker:string|null,
 *                    schreibbar:boolean, letzterLaufAm:string|null, version:number|null}>}
 */
export async function leseAgentStatus() {
  const leer = { vorhanden: false, modus: null, docker: null, schreibbar: false, letzterLaufAm: null, version: null, capabilities: [], lan: null, scannerProfilAktiv: null };
  const o = await leseJson(P.agent());
  if (!o) return leer;

  const version = Number(o.version);
  if (version !== 1 && version !== AGENT_PROTOKOLL) {
    return { ...leer, version: Number.isFinite(version) ? version : null, capabilities: [] };
  }

  const letzterLaufAm = typeof o.letzterLaufAm === 'string' ? o.letzterLaufAm : null;
  const t = letzterLaufAm ? Date.parse(letzterLaufAm) : NaN;
  const frisch = Number.isFinite(t) && Date.now() - t < HEARTBEAT_MAX_ALTER_MS;

  return {
    vorhanden: frisch,
    modus:  MODI.includes(o.modus) ? o.modus : null,
    docker: DOCKER_ARTEN.includes(o.docker) ? o.docker : null,
    // Der Agent prüft selbst, ob er in /data/update schreiben kann. Ohne
    // Schreibrecht (Docker hat das Verzeichnis als root angelegt, der Agent
    // läuft als Nutzer) bleibt das Feature aus — und die GUI erklärt warum,
    // statt einen Button anzubieten, dessen Klick ins Leere geht.
    schreibbar: o.schreibbar === true,
    letzterLaufAm,
    version,
    capabilities: version === 1
      ? ['update']
      : (Array.isArray(o.capabilities)
        ? o.capabilities.filter((c) => ['update', 'zielversion', 'netzwerk', 'module', 'port'].includes(c))
        : []),
    // Primäre LAN-Schnittstelle des Hosts (Interface der Default-Route). Nur
    // der Host-Agent kennt die echte Subnetzmaske; die App liest sie hier
    // ausschließlich als Prefill-Vorschlag für die Scanner-Suche. Streng
    // validiert, weil sie zwar aus festem Agent-Vokabular stammt, aber dennoch
    // von außerhalb des app-Containers kommt.
    lan: leseLan(o.lan),
    scannerProfilAktiv: typeof o.scannerProfilAktiv === 'boolean' ? o.scannerProfilAktiv : null,
  };
}

/** Validiert das optionale `lan`-Feld des Heartbeats zu {ip, prefix} oder null. */
function leseLan(lan) {
  if (!lan || typeof lan !== 'object' || Array.isArray(lan)) return null;
  const ip = String(lan.ip || '');
  const prefix = Number(lan.prefix);
  const oktette = ip.split('.');
  const ipOk = oktette.length === 4
    && oktette.every((t) => /^\d{1,3}$/.test(t) && Number(t) >= 0 && Number(t) <= 255);
  if (!ipOk || !Number.isInteger(prefix) || prefix < 1 || prefix > 32) return null;
  return { ip, prefix };
}

// ── Anforderung (App → Agent) ────────────────────────────────────────────────

/** Liegt noch eine unabgeholte Anforderung? @returns {Promise<object|null>} */
export async function leseAnforderung() {
  let roh;
  try {
    roh = await fs.readFile(P.anforderung(), 'utf8');
  } catch {
    return null;
  }
  const out = {};
  for (const zeile of roh.split('\n')) {
    const i = zeile.indexOf('=');
    if (i <= 0) continue;
    out[zeile.slice(0, i).trim()] = zeile.slice(i + 1).trim();
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Schreibt eine Update-Anforderung — atomar (write + rename) und mit 0600.
 * Atomar, weil der Agent im Sekundentakt liest: ohne rename könnte er eine
 * halb geschriebene Datei abholen und mit fehlender Prüfsumme starten.
 *
 * @returns {Promise<string>} die Nonce
 */
export async function schreibeAnforderung({ zielVersion, erwarteterSha256, angefordertVon }) {
  const nonce = randomBytes(16).toString('hex');
  const inhalt = [
    `protokoll=${UPDATE_ANFORDERUNG_PROTOKOLL}`,
    `nonce=${nonce}`,
    `zielVersion=${zielVersion}`,
    `angefordertAm=${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}`,
    `angefordertVon=${String(angefordertVon || 'admin').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40) || 'admin'}`,
    `erwarteterSha256=${erwarteterSha256}`,
    '',
  ].join('\n');

  await fs.mkdir(UPDATE_DIR, { recursive: true });
  // Zwischen Anforderung und erstem Agenten-Log darf niemals der Text des
  // vorherigen Laufs im Dialog erscheinen.
  await altesLogEntfernen();
  const tmp = `${P.anforderung()}.tmp`;
  await fs.writeFile(tmp, inhalt, { mode: 0o600 });
  await fs.rename(tmp, P.anforderung());
  return nonce;
}

export async function schreibeHostAnforderung({ typ, wert, secret = '', angefordertVon }) {
  const erlaubte = new Set(['netzwerk', 'module', 'port', 'duckdns']);
  if (!erlaubte.has(typ)) throw new Error('Unbekannter Hostauftrag.');
  const sauber = String(wert || '');
  const geheim = String(secret || '');
  if (!/^[A-Za-z0-9.:/_-]{1,300}$/.test(sauber) || (geheim && !/^[A-Za-z0-9._-]{1,512}$/.test(geheim))) {
    throw new Error('Hostauftrag enthält ungültige Werte.');
  }
  const nonce = randomBytes(16).toString('hex');
  const inhalt = [
    `protokoll=${AGENT_PROTOKOLL}`,
    `typ=${typ}`,
    `nonce=${nonce}`,
    `angefordertAm=${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}`,
    `angefordertVon=${String(angefordertVon || 'admin').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40) || 'admin'}`,
    `wert=${sauber}`,
    ...(geheim ? [`secret=${geheim}`] : []),
    '',
  ].join('\n');
  await fs.mkdir(UPDATE_DIR, { recursive: true });
  const tmp = `${P.anforderung()}.tmp`;
  await fs.writeFile(tmp, inhalt, { mode: 0o600, flag: 'wx' });
  await fs.rename(tmp, P.anforderung());
  return nonce;
}

/**
 * Nimmt eine noch nicht abgeholte Anforderung zurück. Ein bereits LAUFENDER
 * Lauf wird nie abgebrochen — mitten im Entpacken abzubrechen hinterließe einen
 * halben Quellbaum.
 *
 * @returns {Promise<boolean>} true, wenn etwas entfernt wurde
 */
export async function entferneAnforderung() {
  try {
    await fs.unlink(P.anforderung());
    return true;
  } catch {
    return false;
  }
}

// ── Status + Log (Agent → App) ───────────────────────────────────────────────

/**
 * Zustand des laufenden bzw. zuletzt beendeten Laufs.
 *
 * Der Zustand liegt auf Platte, nicht im React-State: `app` und `web` werden
 * mitten im Lauf neu erstellt, und ein Browser-Reload danach muss die Anzeige
 * korrekt rekonstruieren können.
 */
export async function leseLaufStatus() {
  const o = await leseJson(P.status());
  if (!o) return null;
  const status = STATUS_WERTE.includes(o.status) ? o.status : null;
  if (!status) return null;
  const txt = (v, n = 200) => (typeof v === 'string' ? v.slice(0, n) : null);
  return {
    nonce:      /^[0-9a-f]{32}$/.test(String(o.nonce || '')) ? o.nonce : null,
    status,
    phase:      txt(o.phase, 40),
    // Ältere Agenten schreiben noch kein `typ` ins status.json — dann ist es
    // ein echtes Software-Update, das war vor Hostaufträgen der einzige Fall.
    typ:        LAUF_TYP_WERTE.includes(o.typ) ? o.typ : 'update',
    begonnenAm: txt(o.begonnenAm, 40),
    beendetAm:  txt(o.beendetAm, 40),
    exitCode:   Number.isInteger(o.exitCode) ? o.exitCode : null,
    meldung:    txt(o.meldung, 500),
  };
}

/**
 * Die letzten Zeilen des Agent-Logs. Gelesen wird nur der Dateischwanz — ein
 * Update-Log kann durch die Docker-Build-Ausgabe mehrere MB groß werden.
 *
 * @returns {Promise<string>}
 */
export async function leseLogTail(zeilen = LOG_TAIL_ZEILEN) {
  let fh;
  try {
    fh = await fs.open(P.log(), 'r');
    const { size } = await fh.stat();
    const start = Math.max(0, size - LOG_TAIL_MAX_BYTES);
    const buf = Buffer.alloc(Math.min(size, LOG_TAIL_MAX_BYTES));
    await fh.read(buf, 0, buf.length, start);
    const alle = buf.toString('utf8').split('\n');
    // Bei angeschnittenem Anfang die erste (halbe) Zeile verwerfen.
    if (start > 0) alle.shift();
    return alle.slice(-zeilen).join('\n');
  } catch {
    return '';
  } finally {
    await fh?.close().catch(() => {});
  }
}

/** Ist gerade ein Lauf aktiv? */
export function laufAktiv(lauf) {
  return lauf?.status === 'laeuft';
}
