import net from 'node:net';
import { holeScannerCapabilities, SCANNER_PORTS } from '../lib/scanner-capabilities.js';

let scanLaeuft = false;
let letzterScanAm = 0;
const MIN_ABSTAND_MS = 10_000;

export function ipv4ZuInt(ip) {
  const teile = String(ip).split('.').map(Number);
  if (teile.length !== 4 || teile.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return (((teile[0] << 24) >>> 0) + (teile[1] << 16) + (teile[2] << 8) + teile[3]) >>> 0;
}
function intZuIpv4(n) { return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'); }
export function istPrivat(n) {
  return (n >= ipv4ZuInt('10.0.0.0') && n <= ipv4ZuInt('10.255.255.255'))
    || (n >= ipv4ZuInt('172.16.0.0') && n <= ipv4ZuInt('172.31.255.255'))
    || (n >= ipv4ZuInt('192.168.0.0') && n <= ipv4ZuInt('192.168.255.255'));
}

// Erlaubter Prefix-Bereich: /16 (255.255.0.0) bis /30 (255.255.255.252).
// Die Untergrenze /16 deckt auch flach geschnittene Heimnetze wie ein
// 192.168.192.0/21 ab; nach unten begrenzt /16, damit der Scan nicht über ein
// ganzes 10/8 laufen kann.
export const MIN_PREFIX = 16;
export const MAX_PREFIX = 30;

/** Zusammenhängende Subnetzmaske zu einem Prefix, z. B. 21 → 255.255.248.0. */
export function prefixZuMaske(prefix) {
  const m = prefix <= 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return intZuIpv4(m);
}

// Subnetzmaske → Prefix, ausschließlich für den erlaubten, zusammenhängenden
// Bereich. Bewusst aus prefixZuMaske abgeleitet statt Bit-Popcount: eine
// nicht-zusammenhängende Maske wie 255.255.0.255 ist schlicht kein Schlüssel
// und fliegt raus — es gibt keinen Toleranz-/Rundungspfad, der einen anderen
// Netzblock als den eingegebenen ergäbe.
export const MASKE_ZU_PREFIX = Object.freeze(Object.fromEntries(
  Array.from({ length: MAX_PREFIX - MIN_PREFIX + 1 }, (_, i) => MIN_PREFIX + i)
    .map((p) => [prefixZuMaske(p), p]),
));

// IP + Subnetzmaske → CIDR-String für findeScannerImCidr. Wirft bei
// ungültiger IPv4 oder unerlaubter Maske; die eigentliche Private-Range- und
// Prefix-Prüfung bleibt allein in findeScannerImCidr.
export function bauCidr(ip, maske) {
  if (ipv4ZuInt(ip) === null) throw new Error('Bitte eine gültige IPv4-Adresse eingeben.');
  const prefix = MASKE_ZU_PREFIX[String(maske || '').trim()];
  if (!prefix) throw new Error('Erlaubt sind ausschließlich Subnetzmasken von 255.255.0.0 bis 255.255.255.252.');
  return `${String(ip).trim()}/${prefix}`;
}

// Schlägt aus einer (Client-)IP das umgebende Netz als Startwert vor. Der
// Prefix ist optional: liegt die echte Subnetzmaske vor (Host-Agent), wird sie
// benutzt; sonst /24 als sichere Annahme. Nur für private IPv4; sonst null —
// ein ungültiger Prefill hilft niemandem.
export function netzVorschlagAusIp(ip, prefix = 24) {
  const n = ipv4ZuInt(String(ip || '').replace(/^::ffff:/i, '').trim());
  if (n === null || !istPrivat(n)) return null;
  const p = Number.isInteger(prefix) && prefix >= MIN_PREFIX && prefix <= MAX_PREFIX ? prefix : 24;
  const maske = (0xffffffff << (32 - p)) >>> 0;
  const netz = (n & maske) >>> 0;
  return { ip: intZuIpv4(netz), maske: intZuIpv4(maske) };
}

const PROTOKOLLE = Object.freeze(['http', 'https']);

// Wie viele TCP-Vorprüfungen bzw. eSCL-Abfragen gleichzeitig laufen dürfen.
const TCP_PARALLEL = 128;
const ESCL_PARALLEL = 16;

/**
 * TCP-Verbindungstest gegen ip:port. Es wird kein Byte gesendet und die
 * Verbindung sofort geschlossen — reine Erreichbarkeitsprüfung. Der eigentliche
 * eSCL-GET (durch net-guard, mit TLS) läuft erst danach nur auf offene Ports;
 * so kostet eine leere Adresse eines großen Netzes einen kurzen Connect-Timeout
 * statt einer vollständigen HTTP(S)-Abfrage je Protokoll.
 *
 * Aufrufer garantiert private IPv4 + freigegebenen Scanner-Port.
 */
function tcpOffen(ip, port, timeoutMs) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let fertig = false;
    const schliessen = (offen) => {
      if (fertig) return;
      fertig = true;
      sock.destroy();
      resolve(offen);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => schliessen(true));
    sock.once('timeout', () => schliessen(false));
    sock.once('error', () => schliessen(false));
    sock.connect(port, ip);
  });
}

// Führt `arbeit` mit begrenzter Parallelität über `elemente` aus, bricht aber
// ab, sobald das Gesamtbudget überschritten ist (Date.now() >= bis). Ein sehr
// großes Netz liefert dann Teilergebnisse, statt den Server minutenlang zu
// blockieren.
async function parallelBisBudget(elemente, parallel, bis, arbeit) {
  let cursor = 0;
  async function worker() {
    while (cursor < elemente.length && Date.now() < bis) {
      await arbeit(elemente[cursor++]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(parallel, elemente.length) }, worker));
}

export async function findeScannerImCidr(cidr, {
  port = 'alle', protokoll = 'alle', timeoutMs = 900, tcpTimeoutMs = 700, gesamtBudgetMs = 120_000,
} = {}) {
  const match = /^([^/]+)\/(\d{1,2})$/.exec(String(cidr || '').trim());
  const basis = match ? ipv4ZuInt(match[1]) : null;
  const prefix = match ? Number(match[2]) : -1;
  if (basis === null || prefix < MIN_PREFIX || prefix > MAX_PREFIX || !istPrivat(basis)) {
    throw new Error('Erlaubt sind ausschließlich private IPv4-Netze mit /16 bis /30.');
  }
  const ports = port === 'alle' ? [...SCANNER_PORTS] : [Number(port)];
  if (ports.some((wert) => !SCANNER_PORTS.includes(wert))) throw new Error('Scanner-Port ist nicht freigegeben.');
  const protokolle = protokoll === 'alle' ? [...PROTOKOLLE] : [String(protokoll)];
  if (protokolle.some((wert) => !PROTOKOLLE.includes(wert))) throw new Error('Scanner-Protokoll ist nicht freigegeben.');
  if (scanLaeuft) {
    const err = new Error('Es läuft bereits eine Scanner-Suche.');
    err.code = 'SCAN_LAEUFT';
    throw err;
  }
  if (Date.now() - letzterScanAm < MIN_ABSTAND_MS) {
    const err = new Error('Bitte kurz warten, bevor das Netzwerk erneut durchsucht wird.');
    err.code = 'SCAN_RATE_LIMIT';
    throw err;
  }
  const groesse = 2 ** (32 - prefix);
  const maske = (0xffffffff << (32 - prefix)) >>> 0;
  const netz = (basis & maske) >>> 0;

  scanLaeuft = true;
  letzterScanAm = Date.now();
  const bis = Date.now() + gesamtBudgetMs;
  try {
    // Phase A — leere Adressen billig aussieben: welche (ip, port) antworten
    // überhaupt auf einen TCP-Connect? Protokoll spielt hier noch keine Rolle.
    const paare = [];
    for (let i = 1; i < groesse - 1; i += 1) {
      const ip = intZuIpv4((netz + i) >>> 0);
      for (const p of ports) paare.push({ ip, port: p });
    }
    const offen = [];
    await parallelBisBudget(paare, TCP_PARALLEL, bis, async ({ ip, port: p }) => {
      if (await tcpOffen(ip, p, tcpTimeoutMs)) offen.push({ ip, port: p });
    });

    // Phase B — nur offene Ports als eSCL-Scanner verifizieren, je Protokoll.
    // Pro IP wird höchstens ein Treffer gemeldet: das erste antwortende Gerät.
    const kandidaten = [];
    for (const { ip, port: p } of offen) {
      for (const schema of protokolle) kandidaten.push({ ip, port: p, schema });
    }
    const treffer = [];
    const gesehen = new Set();
    await parallelBisBudget(kandidaten, ESCL_PARALLEL, bis, async (kandidat) => {
      if (gesehen.has(kandidat.ip)) return;
      const url = `${kandidat.schema}://${kandidat.ip}:${kandidat.port}/eSCL`;
      try {
        const capabilities = await holeScannerCapabilities(url, { timeoutMs });
        if (!gesehen.has(kandidat.ip)) {
          gesehen.add(kandidat.ip);
          treffer.push({ url, geraet: capabilities.geraet, capabilities });
        }
      } catch { /* Nicht jedes Gerät im privaten Netz ist ein Scanner. */ }
    });
    return treffer.slice(0, 16);
  } finally {
    scanLaeuft = false;
  }
}
