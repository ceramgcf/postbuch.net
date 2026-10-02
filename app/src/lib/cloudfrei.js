/**
 * lib/cloudfrei.js — „Verlässt hier gerade etwas das Haus?"
 *
 * Der eine Bildschirm, den die cloudfreie Zielgruppe sehen will. Bewusst
 * serverseitig und nicht als Liste im JSX:
 *
 *  • Die Einstufung braucht Daten, die der Client nicht bekommt.
 *    `discord_bot_token` und `discord_webhook_url` sind Secrets und werden von
 *    `GET /api/settings` herausgefiltert — ob Discord aktiv ist, ist im
 *    Frontend also gar nicht entscheidbar.
 *  • Eine hartkodierte Liste „anthropic/openai/bedrock = Cloud" im JSX würde
 *    einen frei angelegten `openrouter`-Provider als lokal ausweisen und beim
 *    nächsten Provider veralten. Genau das würde die Karte von einer
 *    Regressionssicherung zu Dekoration machen.
 *
 * Die Achse ist NICHT „lokal vs. Cloud", sondern **„verlässt aktuell etwas das
 * Haus?"**. Discord, Web-Push und dynamisches DNS können prinzipbedingt nie
 * lokal sein; unter einer strikten Lokal-Achse stünden sie immer auf Rot,
 * selbst wenn der Nutzer sie bewusst eingeschaltet hat. Grün heißt dort
 * schlicht „nicht aktiviert".
 *
 * ── Auflagen (Security) ────────────────────────────────────────────────────
 * Die Antwort enthält NUR Booleans und Anzeigenamen. Keine Basis-URLs, keine
 * Hostnamen, keine Origins, keine aufgelösten IPs, keine Key-Fragmente. Bei
 * Push kommen die Namen der Personen hinzu, die gerade Push bekommen, samt
 * Geräteanzahl und Anbietername des Push-Dienstes – nie die Endpunkte. Die
 * Zeilenliste ist eine vollständige Karte aller Datenabflüsse dieser Instanz —
 * sie ist deshalb admin-only und darf nichts enthalten, was zusätzlich zur
 * Aussage „fließt/fließt nicht" noch ein Ziel verrät.
 */

import { listProviders, getProvider } from './llm/registry.js';
import { MODEL_CLASSES } from './llm/model-classes.js';
import { resolveModelConfig } from './llm.js';
import { embeddingConfig } from './embedding.js';
import { istPrivateAdresse } from './net-guard.js';
import { ONLINE_EMPFEHLUNGEN_AKTIV } from './llm/empfehlungen-modus.js';

/**
 * Wirkt dieser Host wie ein Ziel im eigenen Netz?
 *
 * Bewusst reine Namensheuristik ohne DNS-Auflösung: ein `dns.lookup` je Zeile
 * bei jedem Aufruf wäre ein unnötiges Orakel und macht die Karte langsam. Für
 * die Anzeige genügt die Form — der tatsächliche Schutz sitzt ohnehin in
 * `net-guard.js`, das vor jedem Verbindungsaufbau real auflöst und prüft.
 */
export function wirktLokal(baseUrl) {
  if (!baseUrl) return false;
  let host;
  try { host = new URL(baseUrl).hostname; } catch { return false; }
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');

  if (h === 'localhost' || h === '::1' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  // Docker-Bridge zum Host — der Standardweg zu einem Ollama auf demselben Gerät.
  if (h === 'host.docker.internal' || h === 'gateway.docker.internal') return true;
  // Ein Name ohne Punkt ist ein Container-/LAN-Kurzname, kein öffentlicher Host.
  if (!h.includes('.') && !h.includes(':')) return true;
  if (istPrivateAdresse(h)) return true;
  return false;
}

/** Eine Zeile für die Karte. `personen` nur dort, wo Namen dazugehören. */
function zeile(id, label, lokal, detail, quelle, personen) {
  return personen ? { id, label, lokal, detail, quelle, personen } : { id, label, lokal, detail, quelle };
}

/**
 * Baut den Bericht. Nur Booleans und Namen — siehe Auflagen im Kopf.
 *
 * @param {object} settings  Ergebnis von loadDynamicSettings()
 * @param {object} [laufzeit]
 * @param {Array<{name:string, geraete:number, dienste:string[]}>} [laufzeit.pushEmpfaenger]
 *   Ergebnis von ermittlePushEmpfaenger() – wer gerade tatsächlich Push bekommt.
 *   Kommt von außen, damit diese Funktion ohne DB-Zugriff bleibt.
 * @returns {{lokal:number, gesamt:number, zeilen:Array}}
 */
export function cloudfreiBericht(settings, laufzeit = {}) {
  const s = settings || {};
  const zeilen = [];

  // ── Ablage ────────────────────────────────────────────────────────────────
  const backend = s.storage_backend || 'onedrive';
  if (backend === 'nextcloud') {
    zeilen.push(zeile('storage', 'Ablage', wirktLokal(s.nextcloud_base_url),
      wirktLokal(s.nextcloud_base_url) ? 'Nextcloud im eigenen Netz' : 'Nextcloud auf einem öffentlichen Server',
      'storage'));
  } else {
    zeilen.push(zeile('storage', 'Ablage', false, 'OneDrive (Microsoft)', 'storage'));
  }

  // ── Modellklassen ─────────────────────────────────────────────────────────
  // Dynamisch über MODEL_CLASSES: eine fest verdrahtete Liste wäre bei der
  // nächsten neuen Klasse sofort wieder unvollständig — also genau die
  // Regression, die diese Karte verhindern soll.
  const provCache = new Map();
  const provInfo = (providerId) => {
    if (!provCache.has(providerId)) {
      const p = listProviders(s).find((x) => x.id === providerId) || null;
      provCache.set(providerId, p);
    }
    return provCache.get(providerId);
  };

  for (const cls of MODEL_CLASSES) {
    const cfg = resolveModelConfig(s[cls.settingKey], cls.provider, cls.model);
    const p = provInfo(cfg.providerId);
    const lokal = p?.typ === 'openai-compatible' ? wirktLokal(p.baseUrl) : false;
    zeilen.push(zeile(`model_${cls.key}`, cls.label, lokal, p?.label || cfg.providerId, 'model'));
  }

  // ── Embeddings ────────────────────────────────────────────────────────────
  const emb = embeddingConfig(s);
  const embProv = provInfo(emb.providerId);
  zeilen.push(zeile('embedding', 'Embeddings',
    embProv?.typ === 'openai-compatible' ? wirktLokal(embProv.baseUrl) : false,
    embProv?.label || emb.providerId, 'embedding'));

  // ── Dienste, die nie lokal sein können ────────────────────────────────────
  const discordAn = !!((s.discord_bot_token && s.discord_channel_id) || s.discord_webhook_url);
  zeilen.push(zeile('discord', 'Discord-Benachrichtigungen', !discordAn,
    discordAn ? 'aktiv – sendet an Discord' : 'nicht aktiviert', 'notify'));

  // Maßgeblich ist, ob gerade jemand Push bekommt – nicht, ob VAPID-Schlüssel
  // existieren: die erzeugt jede Instanz beim ersten Start selbst.
  const pushErlaubt = s.webpush_erlaubt !== false;
  const empfaenger = pushErlaubt && Array.isArray(laufzeit.pushEmpfaenger) ? laufzeit.pushEmpfaenger : [];
  if (!pushErlaubt) {
    zeilen.push(zeile('webpush', 'Push-Benachrichtigungen', true, 'vom Admin abgeschaltet', 'push'));
  } else if (empfaenger.length === 0) {
    zeilen.push(zeile('webpush', 'Push-Benachrichtigungen', true, 'von niemandem genutzt – erlaubt', 'push'));
  } else {
    const dienste = [...new Set(empfaenger.flatMap((e) => e.dienste))].sort();
    zeilen.push(zeile('webpush', 'Push-Benachrichtigungen', false,
      `aktiv – läuft über ${dienste.join(', ')}`, 'push', empfaenger));
  }

  // DuckDNS läuft ausschließlich im caddy-Container; die App hat weder Token
  // noch Domain (und soll sie auch nicht bekommen — ein Secret in einen
  // Prozess zu holen, der es nur zum Anzeigen bräuchte, wäre reine
  // Angriffsflächenerweiterung). Ableitbar ist es am Suffix von app_host.
  const duck = /(^|\.)duckdns\.org$/i.test(String(s.app_host || '').replace(/^https?:\/\//, '').split('/')[0].split(':')[0]);
  zeilen.push(zeile('dyndns', 'Dynamisches DNS', !duck,
    duck ? 'DuckDNS – meldet die WAN-IP' : 'nicht erkannt', 'dns'));

  // ── Feeds von der Postbuch-Homepage ───────────────────────────────────────
  // Jeder neue ausgehende Kanal MUSS hier auftauchen, sonst lügt die Karte.
  // Beide sind einzeln abschaltbar; aus heißt: kein einziger Request.
  const updateCheck = s.update_check_enabled !== false;   // Default an
  zeilen.push(zeile('update_check', 'Update-Prüfung', !updateCheck,
    updateCheck ? 'fragt täglich nach neuen Versionen' : 'nicht aktiviert', 'feed'));

  const empfAbo = ONLINE_EMPFEHLUNGEN_AKTIV && s.llm_empfehlungen_abo === true;
  zeilen.push(zeile('llm_empfehlungen', 'KI-Modellempfehlungen', !empfAbo,
    empfAbo
      ? (s.llm_empfehlungen_auto === true
          ? 'holt Empfehlungen und übernimmt sie automatisch'
          : 'holt Empfehlungen täglich')
      : (ONLINE_EMPFEHLUNGEN_AKTIV ? 'nicht aktiviert' : 'lokal im installierten Release'),
    'feed'));

  return {
    lokal: zeilen.filter((z) => z.lokal).length,
    gesamt: zeilen.length,
    zeilen,
  };
}
