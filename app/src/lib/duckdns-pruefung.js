/**
 * Prüft vor dem TLS-Auftrag, ob eine DuckDNS-Domain auf diesen Host zeigt.
 *
 * Zwei Blickwinkel, dieselbe Logik wie im Installer (deploy-pages/install.sh,
 * duckdns_aufloesung_pruefen):
 *  - öffentlich: direkt bei festen öffentlichen Resolvern gefragt. Der lokale
 *    Resolver taugt als Referenz nicht, weil ein Router mit DNS-Rebind-Schutz
 *    genau die gewollte Antwort (öffentlicher Name → private Adresse) verwirft.
 *  - lokal: über den Resolver des Containers. Dockers eingebettetes DNS reicht
 *    an den Resolver des Hosts und damit meist an den Router weiter – so sieht
 *    auch jedes andere Gerät im Heimnetz die Domain.
 *
 * Die Resolver-Adressen sind fest und die Domain ist vorab auf
 * `<name>.duckdns.org` geprüft; es gibt keine konfigurierbare Zieladresse,
 * deshalb läuft das nicht über lib/net-guard.js.
 */
import dns from 'node:dns/promises';

export const DUCKDNS_DOMAIN_RE = /^[a-z0-9-]{1,63}\.duckdns\.org$/;

const OEFFENTLICHE_RESOLVER = ['1.1.1.1', '8.8.8.8', '9.9.9.9'];
const KEIN_EINTRAG = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN', 'ENONAME']);

function istPrivat(ip) {
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(ip);
}

async function aufloesenOeffentlich(domain) {
  const resolver = new dns.Resolver({ timeout: 3000, tries: 2 });
  resolver.setServers(OEFFENTLICHE_RESOLVER);
  try {
    return [...new Set(await resolver.resolve4(domain))].sort();
  } catch (err) {
    if (KEIN_EINTRAG.has(err.code)) return [];
    return null;
  }
}

async function aufloesenLokal(domain) {
  try {
    const treffer = await dns.lookup(domain, { all: true, family: 4 });
    return [...new Set(treffer.map((t) => t.address))].sort();
  } catch {
    return [];
  }
}

/**
 * @param {string} domain  bereits normalisiert, passt auf DUCKDNS_DOMAIN_RE
 * @param {string|null} lanIp  LAN-Adresse des Hosts laut Agent-Heartbeat
 * @returns {Promise<{ergebnis: 'passt'|'kein_eintrag'|'andere_adresse'|'rebind'|'nicht_pruefbar'|'lan_unbekannt',
 *   domain: string, lanIp: string|null, oeffentlich: string[], lokal: string[], oeffentlicheAdresse: boolean}>}
 */
export async function pruefeDuckdnsAufloesung(domain, lanIp) {
  const [oeffentlich, lokal] = await Promise.all([aufloesenOeffentlich(domain), aufloesenLokal(domain)]);
  const basis = { domain, lanIp: lanIp || null, oeffentlich: oeffentlich || [], lokal, oeffentlicheAdresse: false };
  if (oeffentlich === null) return { ...basis, ergebnis: 'nicht_pruefbar' };
  if (oeffentlich.length === 0) return { ...basis, ergebnis: 'kein_eintrag' };
  if (!lanIp) return { ...basis, ergebnis: 'lan_unbekannt' };
  if (!oeffentlich.includes(lanIp)) {
    return { ...basis, ergebnis: 'andere_adresse', oeffentlicheAdresse: !istPrivat(oeffentlich[0]) };
  }
  if (!lokal.includes(lanIp)) return { ...basis, ergebnis: 'rebind' };
  return { ...basis, ergebnis: 'passt' };
}
