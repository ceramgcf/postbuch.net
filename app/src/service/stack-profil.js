/**
 * service/stack-profil.js — welcher Stack lief, als ein Backup entstand?
 *
 * Die Datenbank kennt Ablage und KI-Einstellungen, aber nicht, welche Dienste
 * auf dem Host liefen (lokale KI, eingebautes Embedding, Scanner, Caddy) und
 * ob ein lokaler Ablageordner eingerichtet war. Vor jedem Backup landet dieses
 * Profil als `_settings.stack_profil` in der Datenbank und reist so im Dump
 * mit. Beim Einspielen übernimmt die Restore-Nachbearbeitung es nach
 * `_settings.nach_restore` (lib/pg-restore.js); nachRestoreBild() vergleicht
 * es mit dem Stack, auf dem die Sicherung jetzt läuft.
 */

import db from '../db.js';
import { loadDynamicSettings, getActiveBackendName } from '../config.js';
import { leseAgentStatus } from '../lib/update-agent-datei.js';
import { appVersion } from '../lib/app-version.js';
import * as lokal from '../lib/storage/lokal.js';
import { isProviderKeySetting } from '../lib/llm/registry.js';
import { istBestaetigterDateiFehlt, wirktFalschEingebunden } from './storage-missing.js';
import { scannerProfilAutoSchalten } from './host-agent.js';

const MODULE = ['lokalki', 'embedding', 'scanner', 'caddy'];

// Zugangsdaten, deren Fehlen nach einem Restore auffallen muss. Im Profil
// stehen nur die NAMEN der gesetzten Schlüssel, nie Werte. Unverschlüsselte
// Backups lassen die Werte weg (jobs/backup.js); was danach hier fehlt, muss
// neu eingetragen werden.
const ZUGAENGE = {
  onedrive_tokens:        { name: 'OneDrive-Anmeldung', link: '/einrichtung/ablage' },
  onedrive_client_secret: { name: 'OneDrive-App-Geheimnis', link: '/einrichtung/ablage' },
  nextcloud_app_password: { name: 'Nextcloud-App-Passwort', link: '/einrichtung/ablage' },
  llm_openai_key:         { name: 'OpenAI-API-Schlüssel', link: '/einrichtung/ki' },
  llm_anthropic_key:      { name: 'Anthropic-API-Schlüssel', link: '/einrichtung/ki' },
  llm_bedrock_key:        { name: 'AWS-Bedrock-Schlüssel', link: '/einrichtung/ki' },
  llm_claude_oauth_token: { name: 'Claude-Abo-Anmeldung', link: '/einrichtung/ki' },
  discord_webhook_url:    { name: 'Discord-Webhook', link: '/einstellungen?tab=benachrichtigungen' },
  discord_bot_token:      { name: 'Discord-Bot', link: '/einstellungen?tab=benachrichtigungen' },
};

function zugangInfo(key) {
  if (ZUGAENGE[key]) return ZUGAENGE[key];
  if (isProviderKeySetting(key)) return { name: 'API-Schlüssel eines KI-Providers', link: '/einrichtung/ki' };
  return null;
}

/** Namen der Zugangsdaten, die gerade einen Wert haben. */
async function gesetzteZugaenge() {
  const { rows } = await db.query(
    `SELECT key FROM postbuch._settings
      WHERE value IS NOT NULL AND value NOT IN ('null'::jsonb, '""'::jsonb, '{}'::jsonb, '[]'::jsonb)`,
  );
  return rows.map((r) => r.key).filter((k) => zugangInfo(k)).sort();
}

function moduleAusAgent(agent) {
  if (!agent?.vorhanden) return null;
  const caddy = agent.stack?.dienste?.find((d) => d.name === 'postbuch-caddy');
  return {
    lokalki: typeof agent.stack?.lokalki?.profilAktiv === 'boolean' ? agent.stack.lokalki.profilAktiv : null,
    embedding: agent.embeddingProfilAktiv,
    scanner: agent.scannerProfilAktiv,
    caddy: agent.stack ? caddy?.zustand === 'running' : null,
  };
}

export async function aktuellesStackProfil(settings = null) {
  const s = settings || await loadDynamicSettings();
  const agent = await leseAgentStatus().catch(() => null);
  const festgelegt = lokal.istFestgelegt();
  return {
    erfasstAm: new Date().toISOString(),
    version: appVersion() || null,
    ablage: getActiveBackendName(s),
    lokaleAblage: festgelegt ? { anzeige: lokal.wurzelAnzeige() } : null,
    module: moduleAusAgent(agent),
    lokalkiModell: agent?.stack?.lokalki?.modell || null,
    verschluesselt: s.backup_encryption?.enabled === true,
    zugaenge: await gesetzteZugaenge().catch(() => null),
  };
}

/** Vor dem pg_dump: Profil in die Datenbank, damit es im Backup steht. */
export async function stackProfilSichern() {
  const profil = await aktuellesStackProfil();
  await db.query(
    `INSERT INTO postbuch._settings (key, value, updated_at) VALUES ('stack_profil', $1::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [JSON.stringify(profil)],
  );
  return profil;
}

const MODUL_HILFE = {
  lokalki: {
    name: 'Die lokale KI',
    anleitung: 'Ist dieser Rechner dafür geeignet, schalte die lokale KI unter Einstellungen → Stack ein. Andernfalls wähle unter Einstellungen → KI einen erreichbaren Anbieter und ordne dessen Modelle den Aufgaben zu.',
    link: '/einstellungen?tab=stack',
    linkText: 'Zum Stack',
  },
  embedding: {
    name: 'Der eingebaute Embedding-Dienst',
    anleitung: 'Unter Einstellungen → Stack den eingebauten Dienst einschalten oder unter Einstellungen → KI → Embeddings einen anderen Dienst wählen. Bis dahin findet die Suche nach Bedeutung nichts Neues.',
    link: '/einstellungen?tab=stack',
    linkText: 'Zum Stack',
  },
  scanner: {
    name: 'Der Scanner-Dienst',
    anleitung: 'postbuch.net schaltet den Dienst nach dem Einspielen selbst wieder ein; die Einstellungen des Scanners stammen aus der Sicherung. Der Stack zeigt, ob der Auftrag noch läuft oder gescheitert ist.',
    link: '/einstellungen?tab=stack',
    linkText: 'Zum Stack',
  },
  caddy: {
    name: 'HTTPS über DuckDNS',
    anleitung: 'Im Assistenten unter „Instanz“ TLS über DuckDNS einrichten. Ohne HTTPS laufen eine installierte App (PWA), Push-Nachrichten und die OneDrive-Anmeldung nicht über die bisherige Adresse.',
    link: '/einrichtung/betrieb',
    linkText: 'Zum Instanz-Schritt',
  },
};

/**
 * Abweichungen zwischen dem Stack der Sicherung und diesem. Jede Abweichung
 * trägt eine Anleitung und, wo es einen Ort dafür gibt, einen Link.
 * `lokalStichprobe` ({geprueft, fehlend}) stammt aus lokaleOriginaleStichprobe(),
 * `herkunftDomain` aus nach_restore (lib/pg-restore.js), `aktuelleDomain` aus
 * duckdnsDomainAusSettings().
 */
export function vergleicheProfile(alt, neu, { lokalStichprobe = null, herkunftDomain = null, aktuelleDomain = null } = {}) {
  const abweichungen = [];
  // Ordner festgelegt, aber die Originale liegen nicht darin – etwa weil die
  // Sicherung in einen neuen, leeren Ordner eingespielt wurde.
  if (neu.ablage === 'lokal' && neu.lokaleAblage && lokalStichprobe
      && wirktFalschEingebunden(lokalStichprobe.fehlend, lokalStichprobe.geprueft)) {
    const altAnzeige = alt?.lokaleAblage?.anzeige;
    abweichungen.push({
      id: 'ablage-lokal-leer',
      schwer: true,
      titel: 'Im Ablageordner fehlen die Dateien der Dokumente',
      text: `Von ${lokalStichprobe.geprueft} geprüften Dokumenten liegen ${lokalStichprobe.fehlend} nicht im Ablageordner ${neu.lokaleAblage.anzeige}.`
        + (altAnzeige && altAnzeige !== neu.lokaleAblage.anzeige ? ` Im gesicherten System lagen sie in ${altAnzeige}.` : ''),
      anleitung: 'Den Ordner mit den Originalen in diesen Ordner kopieren oder ihn unter „Ablage“ als Ablageordner festlegen. Bis dahin lassen sich die Dokumente nicht öffnen.',
      link: '/einrichtung/ablage',
    });
  }
  if (alt?.ablage === 'lokal' && neu.ablage === 'lokal' && !neu.lokaleAblage) {
    abweichungen.push({
      id: 'ablage-lokal-fehlt',
      schwer: true,
      titel: 'Der Ablageordner der Sicherung ist hier nicht eingerichtet',
      text: `Die Sicherung stammt aus einem System, dessen Dokumente in einem Ordner auf dem Rechner lagen${alt.lokaleAblage?.anzeige ? ` (${alt.lokaleAblage.anzeige})` : ''}. Auf diesem System ist kein solcher Ordner festgelegt.`,
      anleitung: 'Den Ordner mit den Originalen auf diesen Rechner kopieren und ihn unter „Ablage“ als Ablageordner festlegen. Ohne Host-Agent geht das mit dem Installer (Betriebsart „Komplett lokal“) und demselben Ordner.',
      link: '/einrichtung/ablage',
    });
  }
  // Nur ein Unterschied zum gesicherten System ist eine Abweichung: Hatte es
  // selbst schon einen Ordner neben der Cloud-Ablage, hat sich nichts geändert.
  // Ohne Profil (ältere Sicherung) gibt es nichts zu vergleichen.
  if (alt && neu.ablage !== 'lokal' && neu.lokaleAblage && !alt.lokaleAblage) {
    abweichungen.push({
      id: 'umzug-nach-lokal',
      schwer: false,
      titel: 'Dokumente in den Ordner auf diesem Rechner umziehen?',
      text: `Dieses System ist für eine Ablage auf dem Rechner eingerichtet (${neu.lokaleAblage.anzeige}), die Sicherung nutzt aber ${neu.ablage === 'onedrive' ? 'OneDrive' : 'Nextcloud'}. Das funktioniert weiter, solange die Verbindung dorthin steht.`,
      anleitung: 'Mit dem Ablage-Umzug lassen sich alle Dokumente in den Ordner auf diesem Rechner kopieren. Die Originale in der Cloud bleiben dabei erhalten, bis du das Aufräumen ausdrücklich bestätigst.',
      link: '/ablage-umzug/ueberblick?ziel=lokal',
      linkText: 'Umzug vorbereiten',
    });
  }
  if (alt?.module && neu.module) {
    for (const m of MODULE) {
      if (alt.module[m] === true && neu.module[m] === false) {
        const h = MODUL_HILFE[m];
        // HTTPS führt der DuckDNS-Hinweis unten mit, wenn es um dieselbe Adresse geht.
        if (m === 'caddy' && herkunftDomain && herkunftDomain !== aktuelleDomain) continue;
        abweichungen.push({
          id: `modul-${m}`,
          schwer: m === 'lokalki',
          titel: `${h.name} lief im gesicherten System, hier nicht`,
          text: m === 'lokalki' && alt.lokalkiModell ? `Dort lief das Modell ${alt.lokalkiModell}.` : '',
          anleitung: h.anleitung,
          link: h.link,
          linkText: h.linkText,
        });
      }
    }
  } else if (alt?.module && !neu.module) {
    abweichungen.push({
      id: 'agent-fehlt',
      schwer: false,
      titel: 'Die Dienste dieses Systems lassen sich nicht vergleichen',
      text: 'Der Host-Agent meldet sich nicht. Ohne ihn ist unklar, ob lokale KI, Embedding-Dienst, Scanner und HTTPS hier laufen wie im gesicherten System.',
      anleitung: 'Den Installer erneut ausführen („Update“) richtet den Host-Agenten wieder ein.',
      link: null,
    });
  }
  // Zugangsdaten, die das gesicherte System hatte und die hier fehlen –
  // typischerweise nach einem unverschlüsselten Backup auf einer neuen Instanz.
  if (Array.isArray(alt?.zugaenge) && Array.isArray(neu.zugaenge)) {
    const fehlen = alt.zugaenge.filter((k) => !neu.zugaenge.includes(k));
    const gruppen = new Map();
    for (const k of fehlen) {
      const info = zugangInfo(k);
      if (!info) continue;
      const namen = gruppen.get(info.link) || new Set();
      namen.add(info.name);
      gruppen.set(info.link, namen);
    }
    for (const [link, namen] of gruppen) {
      abweichungen.push({
        id: `zugang-${link.split('/').pop()}`,
        schwer: true,
        titel: `Zugangsdaten fehlen: ${[...namen].join(', ')}`,
        text: alt.verschluesselt === false
          ? 'Die Sicherung war unverschlüsselt und enthält deshalb keine Zugangsdaten.'
          : 'Im gesicherten System waren sie eingetragen, hier sind sie leer.',
        anleitung: 'Im Assistenten neu eintragen und testen.',
        link,
        linkText: 'Neu eintragen',
      });
    }
  }
  // Lief das gesicherte System unter einer DuckDNS-Adresse, die dieses nicht
  // hat: anbieten, sie zu übernehmen. Das Token steht nicht in der Sicherung,
  // deshalb führt der Link ins TLS-Formular mit vorausgefüllter Domain.
  if (herkunftDomain && herkunftDomain !== aktuelleDomain) {
    abweichungen.push({
      id: 'duckdns-domain',
      schwer: false,
      titel: `HTTPS-Adresse ${herkunftDomain} übernehmen?`,
      text: `Das gesicherte System war unter https://${herkunftDomain} erreichbar.`
        + (aktuelleDomain ? ` Dieses System nutzt ${aktuelleDomain}.`
          : (alt?.module?.caddy === true && neu.module?.caddy !== true)
            ? ' Hier läuft HTTPS noch nicht.'
            : ' Dieses System hat noch keine Adresse mit HTTPS.')
        + ' Lesezeichen, eine installierte App und die OneDrive-Anmeldung zeigen auf die bisherige Adresse.',
      anleitung: 'Vorher den alten Rechner abschalten oder dort HTTPS abschalten, sonst beanspruchen beide dieselbe Adresse. Das DuckDNS-Token steht nicht in der Sicherung: Es steht auf duckdns.org nach der Anmeldung oben auf der Seite. Danach trägt postbuch.net die Heimnetz-Adresse dieses Rechners selbst bei DuckDNS ein.',
      link: `/einrichtung/betrieb?duckdns=${encodeURIComponent(herkunftDomain)}`,
      linkText: 'Adresse übernehmen',
    });
  }
  return abweichungen;
}

/** DuckDNS-Domain dieses Systems, wie routes/einrichtung.js sie ableitet. */
export function duckdnsDomainAusSettings(s) {
  const duck = s?.hostconfig_duckdns;
  if (duck?.domain) return String(duck.domain).toLowerCase();
  if (duck?.abgeschaltetAm) return null;
  try {
    const host = new URL(String(s?.app_host || '').trim()).hostname.toLowerCase();
    return /\.duckdns\.org$/.test(host) ? host : null;
  } catch { return null; }
}

const DUCKDNS_DOMAIN_RE = /^[a-z0-9-]{1,63}\.duckdns\.org$/;

/** Zustand nach einem Restore oder null, wenn keiner aussteht. */
export async function nachRestoreBild(settings = null) {
  const s = settings || await loadDynamicSettings();
  const nr = s.nach_restore;
  if (!nr || typeof nr !== 'object') return null;
  const aktuell = await aktuellesStackProfil(s);
  const lokalStichprobe = aktuell.ablage === 'lokal' && aktuell.lokaleAblage
    ? await lokaleOriginaleStichprobe().catch(() => null)
    : null;
  return {
    am: typeof nr.am === 'string' ? nr.am : null,
    eingeladenAm: typeof nr.eingeladenAm === 'string' ? nr.eingeladenAm : null,
    profil: nr.profil && typeof nr.profil === 'object' ? nr.profil : null,
    aktuell,
    abweichungen: vergleicheProfile(nr.profil, aktuell, {
      lokalStichprobe,
      herkunftDomain: DUCKDNS_DOMAIN_RE.test(String(nr.herkunftDomain || '')) ? nr.herkunftDomain : null,
      aktuelleDomain: duckdnsDomainAusSettings(s),
    }),
  };
}

/**
 * Liegen die Originale im lokalen Ablageordner? Fragt die zuletzt angelegten
 * Dokumente ab; nur ein bestätigtes „nicht vorhanden“ zählt als fehlend.
 */
async function lokaleOriginaleStichprobe(anzahl = 5) {
  const { rows } = await db.query(
    `SELECT storage_id FROM postbuch.postbuch
      WHERE storage_backend = 'lokal' AND storage_id IS NOT NULL
      ORDER BY postid DESC LIMIT $1`,
    [anzahl],
  );
  let fehlend = 0;
  let geprueft = 0;
  for (const r of rows) {
    try {
      await lokal.getMeta(r.storage_id);
      geprueft++;
    } catch (err) {
      if (istBestaetigterDateiFehlt(err)) { fehlend++; geprueft++; }
    }
  }
  return { geprueft, fehlend };
}

/**
 * Lief im gesicherten System der Scanner-Dienst, schaltet ein Restore ihn hier
 * selbst wieder ein: Geräteadresse und Einstellungen stehen in der Sicherung,
 * nur das Compose-Profil gehört zum Host. Ein laufender Hostauftrag (etwa das
 * Laden der lokalen KI direkt nach der Installation) wird abgewartet; nach
 * einer halben Stunde gilt der Versuch als beendet und der Hinweis bleibt.
 */
export async function nachRestoreDiensteAnfordern() {
  const { rows } = await db.query("SELECT value FROM postbuch._settings WHERE key = 'nach_restore'");
  const nr = rows[0]?.value;
  if (!nr || typeof nr !== 'object' || nr.diensteAngefordertAm) return 'fertig';
  if (nr.profil?.module?.scanner !== true) return 'fertig';
  const r = await scannerProfilAutoSchalten(true, 'restore');
  if (r.ok && r.grund === 'bereits-erreicht') {
    await nachRestoreMarkieren('diensteAngefordertAm');
    return 'fertig';
  }
  if (!r.ok && r.grund === 'kein-agent') return 'fertig';
  // Höchstens drei eigene Aufträge: Scheitert das Einschalten wiederholt,
  // bleibt der Hinweis im Restore-Bericht stehen.
  if (r.ok && r.nonce && ++nachRestoreAuftraege >= 3) return 'fertig';
  return 'weiter'; // Auftrag gestellt oder ein anderer läuft noch
}
let nachRestoreAuftraege = 0;

export function startNachRestoreDienste() {
  const ende = Date.now() + 30 * 60 * 1000;
  const runde = () => nachRestoreDiensteAnfordern()
    .catch((err) => { console.warn('[nach-restore] Dienste nicht anforderbar:', err.message); return 'weiter'; })
    .then((stand) => {
      if (stand === 'weiter' && Date.now() < ende) setTimeout(runde, 60 * 1000).unref();
    });
  setTimeout(runde, 15 * 1000).unref();
}

export async function nachRestoreMarkieren(feld) {
  await db.query(
    `UPDATE postbuch._settings SET value = value || jsonb_build_object($1::text, to_jsonb(now())), updated_at = NOW()
     WHERE key = 'nach_restore'`,
    [feld],
  );
}

export async function nachRestoreErledigt() {
  await db.query("DELETE FROM postbuch._settings WHERE key = 'nach_restore'");
}
