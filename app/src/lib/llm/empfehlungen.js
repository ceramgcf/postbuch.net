/**
 * lib/llm/empfehlungen.js — Rangauflösung und Übernahme der Modellempfehlungen
 *
 * Die releasegebundene JSON-Datei liefert je Klasse eine rangsortierte
 * Kandidatenliste. Diese Datei
 * beantwortet die eigentliche Frage: **welcher davon funktioniert auf DIESER
 * Instanz?** Grundlage ist `buildAiHealth()` — also die Provider, die hier
 * konfiguriert und erreichbar sind, samt ihrer echten Modell-Listings.
 *
 * ── Zugriffsregel ──────────────────────────────────────────────────────────
 * Bewusst strenger als `modelAvailable()` in `ai-health.js`: dort liefert eine
 * leere Listung `true` („kann nichts widerlegen" — richtig für eine Warnung im
 * UI). Hier würde dieselbe Annahme bedeuten, dass eine Empfehlung auf ein
 * Modell umschaltet, das die Instanz gar nicht hat — und die Pipeline liefe
 * anschließend nur noch in die Fallback-Kette.
 *
 *   1. Provider `configured && working`?      sonst → 'nicht_konfiguriert'
 *   2. Modell in `providers[id].models`?      sonst → 'kein_zugriff'
 *   3. Provider listet grundsätzlich nicht (Abo, leere Listung)
 *                                             →      'nicht_verifizierbar'
 *   4. Erster Kandidat mit 'ok' gewinnt.
 *
 * Übersprungene Kandidaten werden **mit Grund** zurückgegeben. Der Nutzer will
 * sehen, *warum* #1 nicht ging — „verschluckt" ist die schlechteste Variante.
 * `nicht_verifizierbar` ist manuell übernehmbar (mit sichtbarer Warnung). Der
 * erhaltene, derzeit deaktivierte Auto-Apply-Pfad überspringt ihn immer.
 */

import { readFile } from 'node:fs/promises';
import db from '../../db.js';
import { appLog } from '../../app-log.js';
import { holeFeed, feedQuelleFingerprint } from '../postbuch-feed.js';
import { validiereEmpfehlungen, EMPFEHLUNGEN_PFAD, EMBEDDING_KLASSE } from './empfehlungen-feed.js';
import { MODEL_CLASSES } from './model-classes.js';
import {
  EMBEDDING_DEFAULT, embeddingConfig, probeEmbeddingDimension, signatureOf,
} from '../embedding.js';
import { startHelpEmbeddingJob } from '../../service/help-corpus.js';
import { clientSafeError } from '../net-guard.js';
import { buildAiHealth, invalidateAiHealthCache } from '../ai-health.js';
import { loadDynamicSettings } from '../../config.js';
import { resolveModelConfig } from '../llm.js';
import {
  ONLINE_EMPFEHLUNGEN_ABO_GENERATION, ONLINE_EMPFEHLUNGEN_AKTIV,
} from './empfehlungen-modus.js';

export { ONLINE_EMPFEHLUNGEN_AKTIV } from './empfehlungen-modus.js';

const CACHE_KEY    = 'llm_empfehlungen_cache';
const SNAPSHOT_KEY = 'llm_empfehlungen_snapshot';
const ABO_KEY      = 'llm_empfehlungen_abo';
const AUTO_KEY     = 'llm_empfehlungen_auto';
const ABO_GENERATION_KEY = 'llm_empfehlungen_abo_generation';

/** Mindestabstand zwischen zwei manuellen Feed-Abrufen. */
export const PRUEF_ABSTAND_MS = 60_000;

/** Provider-Typen, die grundsätzlich keine Modell-Liste liefern können. */
const OHNE_LISTUNG = new Set(['subscription']);

/** Die beiden Keys, die zusammen das aktive Embedding-Modell beschreiben. */
const EMBEDDING_KEYS = ['llm_embedding', 'llm_embedding_signature'];

/**
 * Die Embedding-Sonderklasse — bewusst nicht in `MODEL_CLASSES`.
 *
 * Sie hat keine Werkseinstellung: ohne ausdrückliche Wahl ist kein
 * Embedding-Modell gesetzt. „Alle übernehmen" richtet deshalb auch das
 * Embedding ein, solange noch keins konfiguriert ist. Ein bereits gesetztes,
 * abweichendes Modell rührt der Sammelknopf nicht an — das Modell bestimmt die
 * `embedding_signature`, und ein Wechsel entwertet den gesamten Vektorbestand,
 * bis er neu aufgebaut ist. Geschrieben wird sie außerdem nicht wie ein
 * Modellkey, sondern wie in `PUT /api/settings/ai/embedding` — mit an der
 * Instanz **geprobter** Dimension.
 */
const EMBEDDING_CLASS = {
  key: EMBEDDING_KLASSE,
  settingKey: 'llm_embedding',
  group: 'embedding',
  label: 'Semantische Suche · Embeddings',
  provider: EMBEDDING_DEFAULT.providerId,
  model: EMBEDDING_DEFAULT.model,
};

/** Alle anzeigbaren Klassen in Reihenfolge — Modellkette zuerst. */
const ALLE_KLASSEN = [...MODEL_CLASSES, EMBEDDING_CLASS];

// ── _settings-Zugriff ────────────────────────────────────────────────────────

async function leseSetting(key, fallback) {
  const r = await db.query('SELECT value FROM postbuch._settings WHERE key = $1', [key]);
  return r.rows.length ? r.rows[0].value : fallback;
}

async function schreibeSetting(key, wert) {
  await db.query(
    `INSERT INTO postbuch._settings (key, value, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = NOW()`,
    [key, JSON.stringify(wert)],
  );
}

export async function aboAktiv()  {
  if (!ONLINE_EMPFEHLUNGEN_AKTIV) return false;
  const [aktiv, generation] = await Promise.all([
    leseSetting(ABO_KEY, false),
    leseSetting(ABO_GENERATION_KEY, 0),
  ]);
  return aktiv === true && generation === ONLINE_EMPFEHLUNGEN_ABO_GENERATION;
}
export async function autoAktiv() {
  return ONLINE_EMPFEHLUNGEN_AKTIV && (await leseSetting(AUTO_KEY, false)) === true;
}

/** Aktiviert das Abo und holt den ersten Stand sofort, nicht erst nachts. */
export async function abonnierenUndHolen() {
  await schreibeSetting(ABO_KEY, true);
  await schreibeSetting(ABO_GENERATION_KEY, ONLINE_EMPFEHLUNGEN_ABO_GENERATION);
  return holeEmpfehlungen();
}

export async function leseCache() {
  const v = await leseSetting(CACHE_KEY, {});
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

/**
 * Liest den mit genau diesem Release ausgelieferten, unveraenderlichen Stand.
 * Die Datei liegt neben dem Validator und gelangt dadurch automatisch in
 * App-Image und Release-Tarball. Es gibt in diesem Pfad keinen Netzwerkzugriff
 * und keinen DB-Cache, der einen alten Online-Stand ueberleben koennte.
 */
export async function leseReleaseEmpfehlungen() {
  const datei = new URL('./llm-empfehlungen.json', import.meta.url);
  const roh = JSON.parse(await readFile(datei, 'utf8'));
  return validiereEmpfehlungen(roh);
}

// ── Feed holen ───────────────────────────────────────────────────────────────

/**
 * Holt den Feed, validiert ihn und legt ihn im Cache ab. Wirft bei Fehlern.
 * Auch der Fehlerfall landet im Cache, damit „zuletzt geholt" ehrlich bleibt.
 */
export async function holeEmpfehlungen() {
  const jetzt = new Date().toISOString();
  const vorher = await leseCache();
  const quelleFingerprint = feedQuelleFingerprint();
  try {
    const roh = await holeFeed(EMPFEHLUNGEN_PFAD);
    const geprueft = validiereEmpfehlungen(roh);
    const neu = { geholtAm: jetzt, fehler: null, quelleFingerprint, ...geprueft };
    await schreibeSetting(CACHE_KEY, neu);
    return neu;
  } catch (err) {
    await schreibeSetting(CACHE_KEY, { ...vorher, geholtAm: jetzt, fehler: err.message, quelleFingerprint });
    await appLog('WARN', 'llm-empfehlungen', 'Empfehlungs-Feed nicht verwertbar', { details: err.message });
    throw err;
  }
}

// ── Rangauflösung ────────────────────────────────────────────────────────────

/**
 * Ordnet einem Kandidaten den Provider dieser Instanz zu.
 *
 * Zuerst exakt über `providerId`. Findet die Instanz die ID nicht, greift der
 * Fallback über `providerTyp`: der erste konfigurierte Provider dieses Typs,
 * der das Modell listet. Damit funktionieren Empfehlungen auch bei eigenen
 * Provider-IDs wie `mein-openrouter`.
 */
function findeProvider(kandidat, berichte, feld) {
  if (kandidat.providerId && berichte[kandidat.providerId]) {
    return berichte[kandidat.providerId];
  }
  if (!kandidat.providerTyp) return null;
  const gleicherTyp = Object.values(berichte).filter((b) => b.typ === kandidat.providerTyp);
  const mitModell = gleicherTyp.find((b) => b.configured && b.working && listetModell(b, kandidat.model, feld));
  if (mitModell) return mitModell;
  return gleicherTyp.find((b) => b.configured) || gleicherTyp[0] || null;
}

/** Exakter Treffer oder Präfix (z. B. "claude-haiku-4-5" ↔ "…-20251001"). */
function listetModell(bericht, model, feld = 'models') {
  return (bericht[feld] || []).some((m) => m.id === model || m.id.startsWith(`${model}-`));
}

/**
 * @param {object} kandidat
 * @param {object} berichte
 * @param {object} [opts]
 * @param {boolean} [opts.embedding] — gegen die Embedding-Listung prüfen
 */
function bewerte(kandidat, berichte, { embedding = false } = {}) {
  const feld = embedding ? 'embeddingModels' : 'models';
  const b = findeProvider(kandidat, berichte, feld);
  if (!b) {
    return { status: 'nicht_konfiguriert', grund: `Provider „${kandidat.providerId || kandidat.providerTyp}" ist auf dieser Instanz nicht eingerichtet.`, providerId: null };
  }
  if (!b.configured || !b.working) {
    const warum = !b.configured ? 'nicht konfiguriert' : 'nicht erreichbar';
    return { status: 'nicht_konfiguriert', grund: `Provider „${b.label}" ist ${warum}.`, providerId: b.id };
  }
  if (embedding && !b.caps?.embeddings) {
    return {
      status: 'kein_zugriff',
      grund: `Provider „${b.label}" ist nicht als embedding-fähig konfiguriert.`,
      providerId: b.id,
    };
  }
  if (OHNE_LISTUNG.has(b.typ) || !(b[feld] || []).length) {
    return {
      status: 'nicht_verifizierbar',
      grund: `Provider „${b.label}" liefert keine ${embedding ? 'Liste der Embedding-Modelle' : 'Modell-Liste'} — `
        + `ob „${kandidat.model}" verfügbar ist, lässt sich nicht prüfen.`,
      providerId: b.id,
    };
  }
  if (!listetModell(b, kandidat.model, feld)) {
    return { status: 'kein_zugriff', grund: `„${kandidat.model}" steht bei „${b.label}" nicht zur Verfügung.`, providerId: b.id };
  }
  return { status: 'ok', grund: null, providerId: b.id };
}

/**
 * Baut die vollständige Auflösung für alle Klassen.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.fresh] — Provider-Listings frisch abfragen
 * @returns {Promise<{stand, geholtAm, hinweis, fehler, klassen:Array}>}
 */
export async function aufloesen({ fresh = false } = {}) {
  const [rohCache, health, settings] = await Promise.all([
    ONLINE_EMPFEHLUNGEN_AKTIV ? leseCache() : leseReleaseEmpfehlungen(),
    buildAiHealth({ fresh }),
    loadDynamicSettings(),
  ]);
  let cache;
  if (!ONLINE_EMPFEHLUNGEN_AKTIV) {
    cache = rohCache;
  } else try {
    const quelleFingerprint = feedQuelleFingerprint();
    cache = rohCache.quelleFingerprint === quelleFingerprint
      ? rohCache
      : { fehler: 'Die Bezugsquelle wurde geändert. Bitte Empfehlungen erneut abrufen.' };
  } catch (err) {
    // Die Karte bleibt bei einer noch nicht migrierten Instanz bedienbar und
    // erklärt den Zustand, statt dass ein fehlender Feed die gesamte KI-Seite
    // mit einem 500er unbrauchbar macht.
    cache = { fehler: err.message };
  }
  const berichte = health.providers || {};
  const feedKlassen = cache.klassen || {};

  const klassen = ALLE_KLASSEN.map((cls) => {
    const istEmbedding = cls.key === EMBEDDING_KLASSE;
    // Das Embedding-Modell steht nicht in einem Modellkey, sondern in
    // `llm_embedding` samt geprobter Dimension — die hier bewusst nicht mit
    // ausgegeben wird: verglichen und angezeigt wird nur Provider + Modell.
    const aktuellRoh = istEmbedding
      ? embeddingConfig(settings)
      : resolveModelConfig(settings[cls.settingKey], cls.provider, cls.model);
    const aktuell = { providerId: aktuellRoh.providerId, model: aktuellRoh.model };
    const kandidaten = (feedKlassen[cls.key] || []).map((k) => {
      const { status, grund, providerId } = bewerte(k, berichte, { embedding: istEmbedding });
      return {
        rang: k.rang,
        providerId: providerId || k.providerId || null,
        providerTyp: k.providerTyp,
        model: k.model,
        label: k.label,
        notiz: k.notiz,
        preisIn: k.preisIn,
        preisOut: k.preisOut,
        preisCacheWrite: k.preisCacheWrite ?? null,
        preisCacheRead: k.preisCacheRead ?? null,
        status,
        grund,
      };
    });
    const gewaehlt = kandidaten.find((k) => k.status === 'ok') || null;
    return {
      key: cls.key,
      label: cls.label,
      settingKey: cls.settingKey,
      group: cls.group || null,
      // 'embedding' ist für das UI die Aufforderung, anders zu rendern: eigene
      // Warnung, eigene Bestätigung, kein Teil von „Alle übernehmen".
      art: istEmbedding ? 'embedding' : 'modell',
      aktuell,
      // Ist überhaupt ein Modell gesetzt? Nur beim Embedding kann das `false`
      // sein — die Modellklassen haben eine Werkseinstellung.
      gesetzt: !!aktuell.model,
      gewaehlt,
      // Schon gesetzt? Dann ist „Übernehmen" ein No-Op und das UI sagt es.
      bereitsAktiv: !!(gewaehlt && gewaehlt.providerId === aktuell.providerId && gewaehlt.model === aktuell.model),
      kandidaten,
    };
  });

  return {
    quelle: ONLINE_EMPFEHLUNGEN_AKTIV ? 'online' : 'release',
    onlineVerfuegbar: ONLINE_EMPFEHLUNGEN_AKTIV,
    stand: cache.stand ?? null,
    geholtAm: cache.geholtAm ?? null,
    hinweis: cache.hinweis ?? '',
    fehler: cache.fehler ?? null,
    klassen,
  };
}

// ── Snapshot ─────────────────────────────────────────────────────────────────

export async function snapshotVorhanden() {
  const s = await leseSetting(SNAPSHOT_KEY, {});
  return !!(s && typeof s === 'object' && Object.keys(s.modelle || {}).length);
}

/**
 * Sichert den Vorzustand aller zehn Modellkeys — genau einmal, vor der ERSTEN
 * Übernahme. Das ist der Rückweg, ohne den Auto-Apply nicht vertretbar wäre.
 * Ein zweiter Aufruf überschreibt nichts: sonst wäre nach der zweiten Übernahme
 * der ursprüngliche Zustand verloren.
 *
 * Bewusst nur die Modellkeys, nicht die Preise: `llm_cost_<modelId>` hängt an
 * der Modell-ID. Wird das alte Modell wiederhergestellt, gilt automatisch
 * wieder sein alter Preiseintrag; der Eintrag des Feed-Modells bleibt als
 * verwaister Wert stehen und stört nicht.
 */
async function sichereSnapshotEinmalig() {
  if (await snapshotVorhanden()) return;
  const settings = await loadDynamicSettings();
  const modelle = {};
  for (const cls of MODEL_CLASSES) {
    modelle[cls.settingKey] = settings[cls.settingKey] ?? null;
  }
  // Das Embedding-Modell wird mitgesichert — beide Keys, denn die Signatur
  // ohne die Konfiguration (oder umgekehrt) wäre ein widersprüchlicher Zustand.
  for (const key of EMBEDDING_KEYS) {
    modelle[key] = await leseSetting(key, null);
  }
  await schreibeSetting(SNAPSHOT_KEY, { erstelltAm: new Date().toISOString(), modelle });
}

/** Stellt den gesicherten Vorzustand exakt wieder her. */
export async function zuruecksetzen() {
  const snap = await leseSetting(SNAPSHOT_KEY, {});
  const modelle = snap?.modelle;
  if (!modelle || !Object.keys(modelle).length) {
    const err = new Error('Es liegt kein Snapshot vor — es wurde noch nie eine Empfehlung übernommen.');
    err.status = 409;
    throw err;
  }
  // Allowlist statt Object.keys(modelle): ein Snapshot aus einer anderen
  // Version darf nicht bestimmen, welche _settings-Keys hier geschrieben werden.
  const rueckwegKeys = [...MODEL_CLASSES.map((c) => c.settingKey), ...EMBEDDING_KEYS];
  const zurueck = [];
  let embeddingBeruehrt = false;
  for (const key of rueckwegKeys) {
    if (!(key in modelle)) continue;
    const wert = modelle[key];
    const jetzt = await leseSetting(key, null);
    if (JSON.stringify(jetzt ?? null) === JSON.stringify(wert ?? null)) continue;
    if (wert === null) {
      // Vorher gab es den Key gar nicht ⇒ wieder entfernen, damit erneut der
      // Code-Default greift (MODEL_CLASSES bzw. EMBEDDING_DEFAULT).
      await db.query('DELETE FROM postbuch._settings WHERE key = $1', [key]);
    } else {
      await schreibeSetting(key, wert);
    }
    if (EMBEDDING_KEYS.includes(key)) embeddingBeruehrt = true;
    zurueck.push(key);
  }
  await schreibeSetting(SNAPSHOT_KEY, {});
  invalidateAiHealthCache();
  await appLog('INFO', 'llm-empfehlungen', 'Modellwahl auf den Stand vor der ersten Empfehlung zurückgesetzt', {
    details: `${zurueck.length} Schlüssel`,
  });
  // Zurück heißt: wieder die alte Signatur. Der Hilfekorpus muss dazu passen,
  // sonst findet die Anwenderhilfe nichts mehr.
  if (embeddingBeruehrt) startHelpEmbeddingJob({ reason: 'provider-konfiguriert' });
  return { zurueckgesetzt: zurueck };
}

// ── Übernahme ────────────────────────────────────────────────────────────────

/**
 * Schreibt den Preis eines Modells — aber **nie über einen manuell gesetzten
 * Wert**. `quelle` ist additiv: `buildCostMap`/`calculateCost` lesen nur die
 * Preisfelder, und ein fehlendes `quelle` gilt als 'manuell'.
 *
 * @returns {'gesetzt'|'unveraendert'|'preis_manuell_gesetzt'|'kein_preis'}
 */
async function setzePreis({ model, preisIn, preisOut, preisCacheWrite = null, preisCacheRead = null }) {
  if (preisIn == null || preisOut == null) return 'kein_preis';
  const key = `llm_cost_${model}`;
  const vorhanden = await leseSetting(key, null);
  const gleich = (a, b) => (a == null && b == null) || (a != null && b != null && Number(a) === Number(b));
  if (vorhanden && typeof vorhanden === 'object') {
    const quelle = vorhanden.quelle ?? 'manuell';
    const hatWert = vorhanden.input_usd_per_1m != null || vorhanden.output_usd_per_1m != null;
    if (quelle !== 'feed' && hatWert) return 'preis_manuell_gesetzt';
    if (quelle === 'feed'
        && gleich(vorhanden.input_usd_per_1m, preisIn)
        && gleich(vorhanden.output_usd_per_1m, preisOut)
        && gleich(vorhanden.cache_write_usd_per_1m, preisCacheWrite)
        && gleich(vorhanden.cache_read_usd_per_1m, preisCacheRead)) {
      return 'unveraendert';
    }
  }
  await schreibeSetting(key, {
    input_usd_per_1m: preisIn,
    output_usd_per_1m: preisOut,
    cache_write_usd_per_1m: preisCacheWrite,
    cache_read_usd_per_1m: preisCacheRead,
    quelle: 'feed',
  });
  return 'gesetzt';
}

/**
 * Übernimmt Empfehlungen für die genannten Klassen.
 *
 * Idempotent: eine unveränderte Wahl schreibt nicht, loggt nicht und meldet
 * nichts an Discord — sonst produzierte der tägliche Auto-Apply-Tick jeden Tag
 * dieselbe Meldung.
 *
 * Die Embedding-Klasse ist hier die Ausnahme: `'alle'` richtet sie ein, solange
 * noch keine gesetzt ist, wechselt aber nie ein bereits gewähltes Modell. Dafür
 * gibt es den Einzelknopf mit eigener Bestätigung. Geschrieben wird sie mit
 * geprobter Dimension.
 *
 * @param {string[]|'alle'} klassenKeys
 * @param {object} [opts]
 * @param {boolean} [opts.auto] — aus dem Feed-Job: 'nicht_verifizierbar' wird übersprungen
 * @param {string}  [opts.von]  — für app_log
 */
export async function anwenden(klassenKeys, { auto = false, von = 'admin' } = {}) {
  const aufloesung = await aufloesen();
  const gewuenscht = klassenKeys === 'alle'
    // Embedding: einrichten ja, umstellen nein. Ohne gesetztes Modell ist die
    // Übernahme die Erstwahl und kostet nichts; ein bereits gewähltes,
    // abweichendes Modell bleibt dem Einzelknopf vorbehalten. Steht die
    // Empfehlung ohnehin schon, darf der Lauf ihren Preis hinterlegen.
    ? aufloesung.klassen.filter((k) => k.art !== 'embedding' || !k.gesetzt || k.bereitsAktiv).map((k) => k.key)
    : (Array.isArray(klassenKeys) ? klassenKeys : []);

  const angewendet = [];
  const uebersprungen = [];
  let etwasGeschrieben = false;
  let embeddingGesetzt = false;

  for (const kl of aufloesung.klassen) {
    if (!gewuenscht.includes(kl.key)) continue;
    if (auto && kl.art === 'embedding' && kl.gesetzt && !kl.bereitsAktiv) {
      uebersprungen.push({ key: kl.key, grund: 'Ein gesetztes Embedding-Modell wird nie automatisch gewechselt.' });
      continue;
    }

    let ziel = kl.gewaehlt;
    if (!ziel && !auto) {
      // Manuell darf ein 'nicht_verifizierbar'-Kandidat übernommen werden —
      // das UI warnt sichtbar. Automatisch niemals.
      ziel = kl.kandidaten.find((k) => k.status === 'nicht_verifizierbar') || null;
    }
    if (!ziel) {
      const grund = kl.kandidaten.length
        ? (kl.kandidaten[0].grund || 'Kein Kandidat mit Zugriff.')
        : 'Für diese Klasse gibt es keine Empfehlung.';
      uebersprungen.push({ key: kl.key, grund });
      continue;
    }

    if (kl.bereitsAktiv) {
      // Preis trotzdem nachziehen — die Wahl kann von Hand identisch gesetzt
      // worden sein, ohne dass je ein Preis hinterlegt wurde.
      const preisErgebnis = await setzePreis(ziel);
      if (preisErgebnis === 'gesetzt') etwasGeschrieben = true;
      uebersprungen.push({ key: kl.key, grund: 'Bereits eingestellt.' });
      continue;
    }

    // Erst proben, dann schreiben: schlägt der Probe-Aufruf fehl, bleibt die
    // bisherige Konfiguration unangetastet — und es entsteht kein Snapshot,
    // der einen nie erfolgten Wechsel dokumentiert.
    let dim = null;
    if (kl.art === 'embedding') {
      try {
        dim = await probeEmbeddingDimension(ziel.providerId, ziel.model);
      } catch (err) {
        // Der Grund geht an den Client — ein Provider im privaten Netz darf
        // hier keine Details über sich preisgeben.
        console.warn('[llm-empfehlungen] Embedding-Probe fehlgeschlagen:', err.message);
        uebersprungen.push({
          key: kl.key,
          grund: `„${ziel.model}" hat auf die Testanfrage nicht verwertbar geantwortet: ${clientSafeError(err)}`,
        });
        continue;
      }
    }

    await sichereSnapshotEinmalig();
    if (kl.art === 'embedding') {
      const cfg = { providerId: ziel.providerId, model: ziel.model, dim };
      await schreibeSetting('llm_embedding', cfg);
      await schreibeSetting('llm_embedding_signature', signatureOf(cfg));
      embeddingGesetzt = true;
    } else {
      await schreibeSetting(kl.settingKey, { providerId: ziel.providerId, model: ziel.model });
    }
    const preisErgebnis = await setzePreis(ziel);
    etwasGeschrieben = true;

    angewendet.push({
      key: kl.key,
      label: kl.label,
      vorher: kl.aktuell,
      nachher: { providerId: ziel.providerId, model: ziel.model },
      status: ziel.status,
      preis: preisErgebnis,
    });
    if (preisErgebnis === 'preis_manuell_gesetzt') {
      uebersprungen.push({ key: kl.key, grund: 'preis_manuell_gesetzt' });
    }
  }

  if (etwasGeschrieben) invalidateAiHealthCache();
  // Neue Signatur ⇒ der Hilfekorpus passt nicht mehr. Der Job ist idempotent
  // und läuft im Hintergrund, sichtbar in der Aufgabenanzeige.
  if (embeddingGesetzt) startHelpEmbeddingJob({ reason: 'provider-konfiguriert' });

  if (angewendet.length) {
    const zeilen = angewendet.map((a) => `${a.label}: ${a.vorher.model} → ${a.nachher.model} (${a.nachher.providerId})`);
    await appLog('INFO', 'llm-empfehlungen',
      `${angewendet.length} Modellempfehlung(en) übernommen${auto ? ' (automatisch)' : ''}`,
      { details: `${zeilen.join('\n')}\nAusgelöst von: ${von}` });
    if (auto) await meldeAnDiscord(angewendet);
  }

  return { angewendet, uebersprungen };
}

/**
 * Schaltet die Vollautomatik erst nach der ersten unmittelbaren Übernahme ein.
 * So bedeutet „einschalten“ auch tatsächlich: den aktuellen Feed jetzt
 * anwenden, nicht erst auf den nächsten nächtlichen Lauf warten.
 */
export async function automatikAktivierenUndAnwenden({ von = 'admin' } = {}) {
  if (!ONLINE_EMPFEHLUNGEN_AKTIV) {
    const err = new Error('Online-Modellempfehlungen sind in dieser Version deaktiviert.');
    err.status = 410;
    throw err;
  }
  if (!(await aboAktiv())) {
    const err = new Error('Die Empfehlungen sind nicht abonniert.');
    err.status = 409;
    throw err;
  }
  const ergebnis = await anwenden('alle', { auto: true, von });
  await schreibeSetting(AUTO_KEY, true);
  return ergebnis;
}

/**
 * Auto-Apply meldet über die bestehende Discord-Anbindung, wenn konfiguriert.
 * Bewusst kein dritter Schalter: wer Discord eingerichtet hat, will von einer
 * automatischen Änderung seiner laufenden Kosten erfahren.
 */
async function meldeAnDiscord(angewendet) {
  try {
    const settings = await loadDynamicSettings();
    const konfiguriert = !!((settings.discord_bot_token && settings.discord_channel_id) || settings.discord_webhook_url);
    if (!konfiguriert) return;
    const { sendMessage } = await import('../discord.js');
    const zeilen = angewendet.map((a) => `• **${a.label}**: \`${a.vorher.model}\` → \`${a.nachher.model}\``);
    await sendMessage(
      `🤖 **Modellempfehlungen automatisch übernommen**\n${zeilen.join('\n')}\n`
      + '_Kuratierte Empfehlung des Postbuch-Entwicklerteams. Nutzung auf eigenes Risiko; rückgängig unter Einstellungen → KI._',
      settings,
    );
  } catch (err) {
    console.warn('[llm-empfehlungen] Discord-Meldung fehlgeschlagen:', err.message);
  }
}
