import pg from 'pg';
import webpush from 'web-push';
import { randomBytes } from 'crypto';
import { access, unlink } from 'fs/promises';
import { constants } from 'fs';
import { werkseinstellungFuerProvider } from './lib/llm/empfehlungs-standard.js';
import { MODEL_CLASSES } from './lib/llm/model-classes.js';

// Create a standalone client (don't use shared pool from db.js which has search_path issues)
// Siehe db.js: Session-Zeitzone hart auf Europe/Berlin, unabhängig vom
// Server-Default aus initdb-Zeiten. Als Startup-Parameter statt nachgelagerter
// Query, um keine zweite Query auf derselben frischen Verbindung zu riskieren.
const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  options: '-c TimeZone=Europe/Berlin',
});
await client.connect();
await client.query('SET search_path = postbuch, public');

const force = process.env.ENV_FORCE_OVERRIDE === '1';
if (force) console.log('[seed] ENV_FORCE_OVERRIDE=1: DB values will be overridden');

const seeds = [
  { key: 'instance_name',         env: process.env.INSTANCE_NAME },
  { key: 'session_secret',        env: process.env.SESSION_SECRET },
  { key: 'web_port',              env: process.env.WEB_PORT ? Number(process.env.WEB_PORT) : undefined },
  { key: 'llm_anthropic_key',     env: process.env.ANTHROPIC_API_KEY },
  { key: 'llm_openai_key',        env: process.env.OPENAI_API_KEY },
  // Der Installer setzt beide Werte nur bei ausdrücklicher Zustimmung. Die
  // Stringwerte aus .env werden hier in echte JSON-Booleans umgewandelt.
  { key: 'llm_empfehlungen_abo',  env: process.env.LLM_EMPFEHLUNGEN_ABO === 'true' ? true : undefined },
  { key: 'llm_empfehlungen_auto', env: process.env.LLM_EMPFEHLUNGEN_AUTO === 'true' ? true : undefined },
  { key: 'llm_bedrock_key',       env: process.env.BEDROCK_API_KEY || process.env.AWS_BEARER_TOKEN_BEDROCK },
  { key: 'llm_bedrock_region',    env: process.env.BEDROCK_REGION || process.env.AWS_REGION },
  { key: 'onedrive_client_id',    env: process.env.ONEDRIVE_CLIENT_ID },
  { key: 'onedrive_client_secret', env: process.env.ONEDRIVE_CLIENT_SECRET },
  { key: 'onedrive_tenant_id',    env: process.env.ONEDRIVE_TENANT_ID },
  { key: 'discord_bot_token',     env: process.env.DISCORD_BOT_TOKEN },
  { key: 'discord_channel_id',    env: process.env.DISCORD_CHANNEL_ID },
  { key: 'app_host',              env: process.env.APP_BASE_URL },
  { key: 'scanner_device_url',    env: process.env.SCANNER_DEVICE_URL },
];

// Scanner/Cleaner-Defaults — werden nur geschrieben wenn noch nicht vorhanden (kein force).
const scannerDefaults = [
  // scanner_device_url bewusst nicht hier: leer/unkonfiguriert ist der
  // gewünschte Default, die Netzwerksuche (ScannerDiscoveryCard) findet das
  // Gerät. Wird trotzdem über die generische ENV_KEYS-Schleife oben seedbar,
  // wenn SCANNER_DEVICE_URL explizit in .env gesetzt ist.
  { key: 'scanner_default_dpi',           value: 300 },
  { key: 'scanner_default_mode',          value: 'gray' },
  { key: 'scanner_has_adf',               value: false },
  { key: 'scanner_supports_a3',           value: false },
  { key: 'scanner_adf_duplex',            value: false },
  { key: 'cleaner_ocr_enabled',           value: true },
  { key: 'cleaner_ocr_langs',             value: 'deu' },
  { key: 'cleaner_ocr_jobs',              value: 2 },
  { key: 'cleaner_blank_mean_min',        value: 240 },
  { key: 'cleaner_blank_stddev_max',      value: 12 },
  { key: 'cleaner_blank_mean_min_single', value: 253 },
  { key: 'cleaner_blank_stddev_max_single', value: 4 },
  { key: 'cleaner_blank_content_threshold', value: 200 },
  { key: 'cleaner_blank_mask_max_content_px', value: 200 },
  { key: 'cleaner_crop_enabled',          value: true },
  { key: 'cleaner_detect_dpi',            value: 75 },
  { key: 'cleaner_content_threshold',     value: 200 },
  { key: 'cleaner_content_denoise_min_px', value: 10 },
  { key: 'pipeline_max_parallel',         value: 3 },
  { key: 'duplicate_embedding_threshold', value: 0.80 },
  { key: 'duplicate_decision_timeout_min', value: 60 },
  { key: 'llm_cache_mode_enabled',        value: false },
  { key: 'llm_cache_mode_auto',           value: false },
  { key: 'llm_cache_mode_auto_tier',      value: 'mittel' },
];

// Der Installer setzt diesen Marker ausschließlich bei einer echten frischen
// Nicht-Restore-Installation. Ein fehlendes DB-Setting ist ausdrücklich kein
// Frische-Signal. Nach erfolgreichem Seed wird der Marker verbraucht.
const EINRICHTUNG_MARKER = '/data/scan_buffer/.einrichtung_pending';
try {
  await access(EINRICHTUNG_MARKER, constants.F_OK);
  await client.query(
    `INSERT INTO _settings (key, value)
     VALUES ('einrichtung', $1::jsonb)
     ON CONFLICT (key) DO NOTHING`,
    // `quelle: 'installation'` ist das EINZIGE Signal, das die Oberfläche bis
    // zum Abschluss der Ersteinrichtung sperrt (routes/einrichtung.js).
    [JSON.stringify({ status: 'offen', quelle: 'installation', schritte: {}, eingeladenAm: null, abgeschlossenAm: null })],
  );
  await unlink(EINRICHTUNG_MARKER);
  console.log('[seed] Einrichtungsmarker übernommen.');
} catch (err) {
  if (err?.code !== 'ENOENT') {
    console.error('[seed] Einrichtungsmarker konnte nicht verarbeitet werden:', err.message);
    await client.end();
    process.exit(1);
  }
}

const scannerUrlVorSeed = await client.query("SELECT value FROM _settings WHERE key = 'scanner_device_url'")
  .then((r) => r.rows[0]?.value ?? null);

try {
  for (const { key, env } of seeds) {
    if (env === undefined || env === '' || env === null) continue;
    const existing = await client.query('SELECT 1 FROM _settings WHERE key = $1', [key]);
    if (existing.rows.length === 0 || force) {
      await client.query(
        'INSERT INTO _settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = NOW()',
        [key, JSON.stringify(env)]
      );
      console.log(force ? '[seed] Force-overrode:' : '[seed] Seeded:', key);
    } else {
      console.log('[seed] Skipped (already in DB):', key);
    }
  }
} catch (err) {
  console.error('[seed] FAILED:', err.message);
  await client.end();
  process.exit(1);
}

// Host-Werte, die der Installer vor dem ersten App-Start bereits wirksam
// gemacht hat. In der DB steht bewusst nur der beobachtbare Zustand, niemals
// der DuckDNS-Token selbst. So zeigt der Einrichtungsassistent keine falschen
// Warnungen und der Host-Agent kann spätere Änderungen weiterhin übernehmen.
try {
  // Den Tokenwert bekommt der App-Container bewusst nicht — nur die Tatsache,
  // dass in der .env einer steht (DUCKDNS_TOKEN_VORHANDEN, siehe compose).
  if (process.env.DUCKDNS_DOMAIN || process.env.DUCKDNS_TOKEN_VORHANDEN) {
    const domain = String(process.env.DUCKDNS_DOMAIN || '').trim();
    const tokenVorhanden = !!String(process.env.DUCKDNS_TOKEN_VORHANDEN || '').trim();
    const hostconfig = {
      ...(domain ? { domain: domain.endsWith('.duckdns.org') ? domain : `${domain}.duckdns.org` } : {}),
      ...(tokenVorhanden ? { tokenGesetztAm: new Date().toISOString() } : {}),
      quelle: 'installer',
    };
    await client.query(
      `INSERT INTO _settings (key, value) VALUES ('hostconfig_duckdns', $1::jsonb)
       ON CONFLICT (key) DO NOTHING`,
      [JSON.stringify(hostconfig)],
    );
    console.log('[seed] DuckDNS-Hostzustand aus Installer übernommen (ohne Tokenwert).');
  }
  if (process.env.WEB_PORT) {
    const port = Number(process.env.WEB_PORT);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) {
      await client.query(
        `INSERT INTO _settings (key, value) VALUES ('hostconfig_port', $1::jsonb)
         ON CONFLICT (key) DO NOTHING`,
        [JSON.stringify({ port, quelle: 'installer' })],
      );
      console.log('[seed] Web-Port-Zustand aus Installer übernommen.');
    }
  }

  // Neue, noch nie verbundene Instanzen starten mit dem secret-freien
  // Gerätecode. Ein bestehender Token-Cache ohne explizites Modusfeld gehört
  // dagegen zum bisherigen Confidential-Client und bleibt auf legacy.
  await client.query(`
    INSERT INTO _settings (key, value)
    SELECT 'onedrive_auth_mode',
           CASE WHEN EXISTS (SELECT 1 FROM _settings WHERE key = 'onedrive_tokens')
                THEN '"legacy"'::jsonb ELSE '"device"'::jsonb END
    WHERE NOT EXISTS (SELECT 1 FROM _settings WHERE key = 'onedrive_auth_mode')
  `);
} catch (err) {
  console.error('[seed] FAILED host/auth defaults:', err.message);
  await client.end();
  process.exit(1);
}

// ENV_FORCE_OVERRIDE darf beim Gerätewechsel keine Fähigkeiten des alten
// Scanners stehen lassen. Der normale Settings-Pfad hat dieselbe Invalidation.
if (scannerUrlVorSeed !== null && process.env.SCANNER_DEVICE_URL) {
  const scannerUrlNachSeed = await client.query("SELECT value FROM _settings WHERE key = 'scanner_device_url'")
    .then((r) => r.rows[0]?.value ?? null);
  if (scannerUrlNachSeed !== scannerUrlVorSeed) {
    await client.query("DELETE FROM _settings WHERE key = 'scanner_capabilities'");
    console.log('[seed] Veraltete Scanner-Fähigkeiten nach ENV-URL-Wechsel entfernt.');
  }
}

// Admin-Credentials: Single Source of Truth ist .env. Das Passwort darf nie in
// _settings gespiegelt werden: diese Tabelle ist Konfiguration, kein
// Credential-Store. Ein Altwert aus früheren Versionen wird entfernt.
try {
  await client.query(
    'INSERT INTO _settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = NOW()',
    ['app_admin_username', JSON.stringify('admin')],
  );
  console.log('[seed] Forced admin username: app_admin_username=admin');

  await client.query("DELETE FROM _settings WHERE key = 'app_password'");
  console.log('[seed] Removed legacy app_password setting');
} catch (err) {
  console.error('[seed] FAILED admin credential sync:', err.message);
  await client.end();
  process.exit(1);
}

for (const { key, value } of scannerDefaults) {
  const existing = await client.query('SELECT 1 FROM _settings WHERE key = $1', [key]);
  if (existing.rows.length === 0) {
    await client.query(
      'INSERT INTO _settings (key, value) VALUES ($1, $2::jsonb)',
      [key, JSON.stringify(value)]
    );
    console.log('[seed] Seeded scanner default:', key);
  }
}

// Modell-Werkseinstellung passend zum Schlüssel, den der Installer mitgegeben hat.
//
// Jede Sprachmodell-Aufgabe bekommt dasselbe Modell: die erste Empfehlung der
// Klasse `leicht` für den Provider, für den wirklich ein Schlüssel vorliegt.
// Das ist bewusst nicht das, was „Modellempfehlungen übernehmen" einrichten
// würde — sonst hätte der Knopf im Neuzustand nichts zu tun, und die
// Empfehlungen blieben unsichtbar. Das günstige Modell arbeitet überall, bis
// der Betreiber übernimmt oder von Hand wählt.
//
// Für das Embedding wird nichts geschrieben: dessen Modell bestimmt die
// Signatur des gesamten Vektorbestands und wird einmal ausdrücklich gewählt.
//
// Wer im Installer „lokale KI" wählt, hat WEDER Anthropic- NOCH OpenAI-Key —
// dann wird bewusst nichts geschrieben: die App meldet ehrlich „kein Provider
// erreichbar", statt garantiert unbrauchbare Modelle in die DB zu legen.
const seedProvider = process.env.ANTHROPIC_API_KEY ? 'anthropic'
  : process.env.OPENAI_API_KEY ? 'openai'
  : null;
const seedModell = seedProvider ? werkseinstellungFuerProvider(seedProvider) : null;
if (seedModell) {
  for (const { settingKey } of MODEL_CLASSES) {
    const existing = await client.query('SELECT 1 FROM _settings WHERE key = $1', [settingKey]);
    if (existing.rows.length) continue;
    await client.query(
      'INSERT INTO _settings (key, value) VALUES ($1, $2::jsonb)',
      [settingKey, JSON.stringify({ providerId: seedModell.providerId, model: seedModell.model })]
    );
    console.log(`[seed] Modell-Werkseinstellung gesetzt (${seedProvider}):`, settingKey, seedModell.model);
  }
}

// ── Embedding-Modell einer bestehenden Instanz festschreiben ────────────────
// Bis 2.8.11 hatte das Embedding-Modell eine Werkseinstellung. Instanzen, die
// sie nie überschrieben haben, tragen ihren gesamten Vektorbestand unter genau
// dieser Signatur — ohne Eintrag in `_settings.llm_embedding` würde er ab jetzt
// zu totem Bestand: alle Vektor-Queries filtern auf die aktive Signatur, und
// die gäbe es dann nicht mehr. Ähnlichkeitssuche, Duplikatprüfung und
// Anwenderhilfe fielen still aus.
//
// Deshalb einmalig: Ist kein Modell gewählt, liegen aber bereits Vektoren, wird
// deren Signatur zur ausdrücklichen Einstellung. Eine Erstinstallation hat
// keine Vektoren und bleibt damit bewusst ohne Embedding-Modell.
try {
  const gewaehlt = await client.query("SELECT 1 FROM _settings WHERE key = 'llm_embedding'");
  if (gewaehlt.rows.length === 0) {
    const { rows } = await client.query(`
      SELECT embedding_signature AS sig, COUNT(*) AS n
        FROM postbuch WHERE embedding IS NOT NULL AND embedding_signature IS NOT NULL
       GROUP BY 1 ORDER BY 2 DESC LIMIT 1`);
    const sig = rows[0]?.sig;
    // Form: "<providerId>/<model>/<dim>" — das Modell darf selbst Schrägstriche
    // enthalten (etwa "openai/gpt-oss"), deshalb nur vorn und hinten trennen.
    const teile = String(sig || '').split('/');
    if (teile.length >= 3) {
      const providerId = teile.shift();
      const dim = Number(teile.pop());
      const model = teile.join('/');
      if (providerId && model && Number.isInteger(dim)) {
        await client.query(
          'INSERT INTO _settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO NOTHING',
          ['llm_embedding', JSON.stringify({ providerId, model, dim })],
        );
        console.log(`[seed] Embedding-Modell aus vorhandenem Vektorbestand übernommen: ${sig} (${rows[0].n} Dokumente)`);
      }
    }
  }
} catch (err) {
  // Kein Abbruch: eine Instanz ohne Dokumententabelle ist eine Erstinstallation.
  console.error('[seed] Embedding-Signatur nicht ermittelbar:', err.message);
}

// ── Ablage-Backend der Erstinstallation ─────────────────────────────────────
// STORAGE_BACKEND kommt aus dem Installer und beantwortet genau eine Frage:
// "Welche Ablage hat der Nutzer bei der Erstinstallation gewählt?" Ohne diesen
// Block bliebe eine frisch mit Nextcloud installierte Instanz auf dem Default
// 'onedrive' stehen — der Ablage-Tab führte mit OneDrive-Karten, und der
// Setup-Assistent legte Ordner in einem OneDrive an, für das es keine
// Credentials gibt.
//
// BEWUSST NICHT in der `seeds`-Liste oben: ENV_FORCE_OVERRIDE=1 darf das aktive
// Backend einer laufenden Instanz niemals kippen. Auf einer bestehenden Instanz
// wird ausschließlich über service/storage-migration.js:schalteBackendUm()
// umgeschaltet — das pausiert die Pipeline und prüft die Zielordner.
//
// Der Key SELBST taugt NICHT als Frische-Merkmal: base_schema.sql legt
// storage_backend='onedrive' bei jedem Start an (Entrypoint Schritt 2 läuft vor
// Schritt 3). Eine Prüfung auf "Key fehlt" wäre toter Code. Geschrieben wird
// deshalb gegen drei andere Merkmale — alle drei müssen zutreffen:
//   (a) ENV-Wert ist ein bekanntes Backend
//   (b) es existiert nirgends ein Dokument (postbuch + Suspensions + Failed)
//   (c) _settings.storage_folders fehlt — es wurde nie eine Ordnerstruktur
//       eingerichtet
//
// (c) ist das tragende Argument: schalteBackendUm() verlangt
// getFolders(settings, ziel).inbox, und getFolders liest ausschließlich
// storage_folders. Solange der Key fehlt, kann über den regulären Pfad für KEIN
// Ziel umgeschaltet werden — dieser Block wirkt also exakt im Komplement des
// regulären Wegs, nicht an ihm vorbei. Ab dem ersten eingerichteten Ordner ist
// er für immer stumm; nichts im Code löscht storage_folders je wieder.
//
// (b) und (c) sind nicht redundant: ein Dump aus einer Instanz vor 1.7.1, die
// nie ein Ordner-Setup gefahren hat, hat kein storage_folders — dort greift nur
// (b). Umgekehrt fängt (c) den frisch eingerichteten Bestand ohne Dokumente.
//
// Und selbst wenn (b)+(c) irrtümlich zuträfen, überschreibt das UPDATE
// nachweislich nur den unberührten Schema-Default '"onedrive"' — nie einen
// Wert, den ein Mensch oder die Migration gesetzt hat.
//
// Rückbaupfad: UPDATE postbuch._settings SET value = '"onedrive"'::jsonb
//              WHERE key = 'storage_backend';
const STORAGE_BACKENDS = ['onedrive', 'nextcloud'];  // muss zu BACKENDS in lib/storage/index.js passen
try {
  const gewuenscht = (process.env.STORAGE_BACKEND || '').trim();
  if (gewuenscht) {
    if (!STORAGE_BACKENDS.includes(gewuenscht)) {
      console.warn(`[seed] STORAGE_BACKEND="${gewuenscht}" ist unbekannt — ignoriert.`);
    } else {
      const ordner = await client.query("SELECT 1 FROM _settings WHERE key = 'storage_folders'");
      const { rows: [{ anzahl }] } = await client.query(`
        SELECT (SELECT count(*) FROM postbuch.postbuch)
             + (SELECT count(*) FROM postbuch._pipeline_suspensions)
             + (SELECT count(*) FROM postbuch._failed_documents) AS anzahl`);
      if (ordner.rows.length > 0 || Number(anzahl) > 0) {
        console.log('[seed] STORAGE_BACKEND ignoriert — Instanz ist nicht mehr frisch.');
      } else {
        const r = await client.query(
          `INSERT INTO _settings (key, value) VALUES ($1, $2::jsonb)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
             WHERE _settings.value = '"onedrive"'::jsonb`,
          ['storage_backend', JSON.stringify(gewuenscht)],
        );
        if (r.rowCount > 0) {
          await client.query(
            `INSERT INTO _settings (key, value) VALUES ('storage_backend_selected', 'true'::jsonb)
             ON CONFLICT (key) DO UPDATE SET value = 'true'::jsonb, updated_at = NOW()`,
          );
          console.log(`[seed] Ablage-Backend der Erstinstallation gesetzt: ${gewuenscht}`);
        } else {
          console.log('[seed] STORAGE_BACKEND ignoriert — aktives Backend wurde bereits bewusst gesetzt.');
        }
      }
    }
  }
} catch (err) {
  console.error('[seed] STORAGE_BACKEND-Seed fehlgeschlagen:', err.message);
}

// ── Webhook-Token (einmalig, falls noch nicht vorhanden) ────────────────────
// Gemeinsames Geheimnis zwischen app und cleaner für /api/webhooks/*. Der Cleaner
// holt es über /api/internal/config; niemand sonst im Docker-Netz braucht es.
// Wird nie aus ENV geseedet — die Maschine erzeugt es selbst.
try {
  const existing = await client.query("SELECT 1 FROM _settings WHERE key = 'webhook_token'");
  if (existing.rows.length === 0) {
    await client.query(
      'INSERT INTO _settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO NOTHING',
      ['webhook_token', JSON.stringify(randomBytes(32).toString('hex'))]
    );
    console.log('[seed] webhook_token erzeugt.');
  } else {
    console.log('[seed] webhook_token bereits vorhanden — übersprungen.');
  }
} catch (err) {
  console.error('[seed] webhook_token-Erzeugung fehlgeschlagen:', err.message);
}

await client.end();
console.log('[seed] Done.');

// ── VAPID-Keys generieren (einmalig, falls noch nicht vorhanden) ─────────────
// Muss nach client.end() stehen um einen eigenen Client zu nutzen.
{
  const vapidClient = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await vapidClient.connect();
  await vapidClient.query('SET search_path = postbuch, public');
  try {
    const existing = await vapidClient.query(
      "SELECT 1 FROM _settings WHERE key = 'vapid_public_key'",
    );
    if (existing.rows.length === 0) {
      const vapidKeys = webpush.generateVAPIDKeys();
      for (const [key, value] of Object.entries({
        vapid_public_key:  vapidKeys.publicKey,
        vapid_private_key: vapidKeys.privateKey,
      })) {
        await vapidClient.query(
          'INSERT INTO _settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO NOTHING',
          [key, JSON.stringify(value)],
        );
      }
      console.log('[seed] VAPID-Keys generiert und gespeichert.');
    } else {
      console.log('[seed] VAPID-Keys bereits vorhanden — übersprungen.');
    }
  } catch (err) {
    console.error('[seed] VAPID-Key-Generierung fehlgeschlagen:', err.message);
  } finally {
    await vapidClient.end();
  }
}
