/**
 * lib/pg-restore.js — Gemeinsamer atomarer pg_restore-Ablauf.
 *
 * pg_restore gibt SQL aus, psql spielt es in einer einzigen Transaktion ein.
 * DROP SCHEMA CASCADE vor dem eigentlichen Dump verhindert Fehler durch
 * abhängige Objekte. Bei jedem Fehler rollt PostgreSQL automatisch zurück —
 * die DB bleibt im Ausgangszustand. `cleanupSql` läuft NACH dem Dump, aber
 * noch INNERHALB derselben Transaktion (z. B. Sessions/Setup-Marker löschen);
 * die drei Aufrufstellen (routes/backup.js, routes/setup-restore.js)
 * unterscheiden sich nur darin, was hier hineingegeben wird.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { writeFile, unlink } from 'fs/promises';

const execFileAsync = promisify(execFile);

export async function atomicPgRestore(tempDumpPath, dbHost, dbPort, dbUser, dbName, pgEnv, cleanupSql = []) {
  const { stdout: dumpSql } = await execFileAsync('pg_restore', [
    '-f', '-',
    '--no-owner',
    '--no-privileges',
    '-F', 'c',
    tempDumpPath,
  ], { env: pgEnv, maxBuffer: 500 * 1024 * 1024 });

  const cleanupBlock = cleanupSql.length ? `${cleanupSql.join('\n')}\n` : '';
  const passendSql = await anServerversionAnpassen(dumpSql, dbHost, dbPort, dbUser, dbName, pgEnv);
  const sql = restoreSkript(passendSql, cleanupBlock);

  const sqlPath = `${tempDumpPath}.sql`;
  await writeFile(sqlPath, sql, { mode: 0o600 });
  try {
    await execFileAsync('psql', [
      '-h', dbHost,
      '-p', dbPort,
      '-U', dbUser,
      '-d', dbName,
      '--no-psqlrc',
      '-v', 'ON_ERROR_STOP=1',
      '-f', sqlPath,
    ], { env: pgEnv, maxBuffer: 10 * 1024 * 1024 });
  } catch (err) {
    if (String(err?.stderr ?? '').includes(KEIN_BESTAND_MARKE)) {
      const fehler = new Error('Diese Sicherung enthält keinen postbuch.net-Datenbestand. Es wurde nichts verändert.');
      fehler.code = 'KEIN_BESTAND';
      throw fehler;
    }
    throw err;
  } finally {
    await unlink(sqlPath).catch(() => {});
  }
}

/**
 * Bricht die Transaktion ab, wenn nach dem Einspielen kein postbuch.net-Bestand
 * da ist. Ein gültiger Dump ohne das Schema `postbuch` (leer oder aus einer
 * fremden Datenbank) liefe sonst fehlerfrei durch: Das DROP SCHEMA davor würde
 * mit festgeschrieben, und der bisherige Bestand wäre ersetzt durch nichts.
 * Alle Nachbearbeitungsschritte prüfen selbst nur „Tabelle vorhanden?“ und
 * überspringen sich still, sie halten das nicht auf.
 */
const KEIN_BESTAND_MARKE = 'POSTBUCH_RESTORE_KEIN_BESTAND';
export const BESTAND_PRUEFEN_SQL = `DO $postbuch$ BEGIN
  IF to_regclass('postbuch._settings') IS NULL OR to_regclass('postbuch.postbuch') IS NULL THEN
    RAISE EXCEPTION '${KEIN_BESTAND_MARKE}';
  END IF;
END $postbuch$;`;

/** Das vollständige psql-Skript: eine Transaktion, Bestandsprüfung direkt nach dem Dump. */
export function restoreSkript(dumpSql, cleanupBlock = '') {
  return `BEGIN;\nDROP SCHEMA IF EXISTS postbuch CASCADE;\n${dumpSql}\n${BESTAND_PRUEFEN_SQL}\n${cleanupBlock}COMMIT;\n`;
}

/**
 * pg_restore 18 setzt `transaction_timeout`, das PostgreSQL erst ab 17 kennt.
 * Läuft der Server noch auf 16 (Umzug auf 18 steht aus), bräche psql an dieser
 * Zeile ab. Sie wird dann entfernt; der Wert 0 ist ohnehin der Standard.
 */
async function anServerversionAnpassen(dumpSql, dbHost, dbPort, dbUser, dbName, pgEnv) {
  const { stdout } = await execFileAsync('psql', [
    '-h', dbHost, '-p', dbPort, '-U', dbUser, '-d', dbName,
    '--no-psqlrc', '-At', '-c', 'SHOW server_version_num',
  ], { env: pgEnv });
  if (Number(stdout.trim()) >= 170000) return dumpSql;
  return dumpSql.replace(/^SET transaction_timeout = 0;\n/gm, '');
}

function jsonAlsSqlAusdruck(wert) {
  // Base64 statt SQL-Literal: Passwörter dürfen beliebige Zeichen enthalten
  // (auch Quotes oder Dollar-Tags), Base64 kann weder das Literal noch den
  // DO-Block beenden und enthält keine psql-Variablen (`:name`).
  const b64 = Buffer.from(JSON.stringify(wert ?? null), 'utf8').toString('base64');
  return `convert_from(decode('${b64}', 'base64'), 'UTF8')::jsonb`;
}

/**
 * Cleanup-SQL, das den Schlüsselbund der Backup-Verschlüsselung über eine
 * Wiederherstellung rettet (siehe lib/backup-encryption.js):
 *
 * - `aktuell` ({ status, secret, passwort } der laufenden Instanz, oder null):
 *   Hat die Instanz bereits einen DEK, bleiben Schalter, Passwort und DEK der
 *   Instanz stehen — sie passen zur Schlüsseldatei in der Ablage. Der Stand aus
 *   dem eingespielten Backup würde sonst ein älteres Passwort zurückholen.
 * - Der DEK des eingespielten Stands und seine früheren DEKs wandern in
 *   `fruehereDeks`, ebenso `zusatzDeks` (z. B. aus einer mitgegebenen
 *   Schlüsseldatei). So verliert ein Restore nie einen Schlüssel.
 */
function verschluesselungErhaltenSql(aktuell, zusatzDeks = []) {
  return `DO $postbuch$
     DECLARE
       aktuell jsonb := ${jsonAlsSqlAusdruck(aktuell)};
       zusatz jsonb := ${jsonAlsSqlAusdruck(zusatzDeks)};
       eingespielt jsonb;
       basis jsonb;
       deks jsonb;
       instanz_behalten boolean := false;
     BEGIN
       IF to_regclass('postbuch._settings') IS NULL THEN RETURN; END IF;
       SELECT value INTO eingespielt FROM postbuch._settings WHERE key = 'backup_encryption_secret';
       IF jsonb_typeof(aktuell->'secret') = 'object' AND (aktuell->'secret') ? 'dek' THEN
         basis := aktuell->'secret';
         instanz_behalten := true;
       ELSIF jsonb_typeof(eingespielt) = 'object' AND eingespielt ? 'dek' THEN
         basis := eingespielt;
       ELSE
         RETURN;
       END IF;

       SELECT COALESCE(jsonb_agg(DISTINCT d), '[]'::jsonb) INTO deks FROM (
         SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(basis->'fruehereDeks') = 'array'
                                               THEN basis->'fruehereDeks' ELSE '[]'::jsonb END) AS d
         UNION ALL SELECT eingespielt->>'dek'
         UNION ALL SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(eingespielt->'fruehereDeks') = 'array'
                                                         THEN eingespielt->'fruehereDeks' ELSE '[]'::jsonb END)
         UNION ALL SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(zusatz) = 'array'
                                                         THEN zusatz ELSE '[]'::jsonb END)
       ) s
       WHERE d IS NOT NULL AND d <> '' AND d <> basis->>'dek';

       INSERT INTO postbuch._settings (key, value, updated_at)
       VALUES ('backup_encryption_secret', basis || jsonb_build_object('fruehereDeks', deks), NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();

       IF instanz_behalten THEN
         IF jsonb_typeof(aktuell->'status') = 'object' THEN
           INSERT INTO postbuch._settings (key, value, updated_at)
           VALUES ('backup_encryption', aktuell->'status', NOW())
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();
         END IF;
         IF jsonb_typeof(aktuell->'passwort') = 'string' THEN
           INSERT INTO postbuch._settings (key, value, updated_at)
           VALUES ('backup_encryption_passwort', aktuell->'passwort', NOW())
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();
         END IF;
       END IF;
     END $postbuch$;`;
}

/**
 * Cleanup-SQL, das Zugangsdaten der laufenden Instanz übernimmt, wo das
 * eingespielte Backup keine enthält. Unverschlüsselte Backups lassen
 * Geheimnisse weg (jobs/backup.js); ohne diesen Schritt löschte ein solcher
 * Restore OneDrive-Anmeldung, KI-Schlüssel, Webhook-Tokens usw. der Instanz.
 * Was das Backup mitbringt, bleibt unverändert. Der VAPID-Schlüssel ist ein
 * Paar: Fehlt der private Schlüssel im Backup, kommt auch der öffentliche aus
 * der Instanz.
 *
 * `geheimnisse` = geheimeSettingsDerInstanz() aus lib/geheime-settings.js.
 */
function zugangsdatenErhaltenSql(geheimnisse = []) {
  if (!geheimnisse.length) return null;
  return `DO $postbuch$
     DECLARE
       instanz jsonb := ${jsonAlsSqlAusdruck(geheimnisse)};
       eintrag jsonb;
       vapid_fehlt boolean;
     BEGIN
       IF to_regclass('postbuch._settings') IS NULL THEN RETURN; END IF;
       vapid_fehlt := NOT EXISTS (SELECT 1 FROM postbuch._settings WHERE key = 'vapid_private_key');
       FOR eintrag IN SELECT * FROM jsonb_array_elements(instanz) LOOP
         IF eintrag->>'key' = 'vapid_public_key' THEN
           IF vapid_fehlt AND EXISTS (SELECT 1 FROM jsonb_array_elements(instanz) e
                                      WHERE e->>'key' = 'vapid_private_key') THEN
             INSERT INTO postbuch._settings (key, value, updated_at)
             VALUES ('vapid_public_key', eintrag->'value', NOW())
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();
           END IF;
         ELSE
           INSERT INTO postbuch._settings (key, value, updated_at)
           VALUES (eintrag->>'key', eintrag->'value', NOW())
           ON CONFLICT (key) DO NOTHING;
         END IF;
       END LOOP;
     END $postbuch$;`;
}

/**
 * Unter welcher DuckDNS-Domain lief das gesicherte System? Wird festgehalten,
 * BEVOR hostWerteErhaltenSql die Hostwerte der Instanz einsetzt, und landet in
 * `nach_restore.herkunftDomain`: Der Hinweis nach der Wiederherstellung bietet
 * an, die Adresse zu übernehmen (service/stack-profil.js). Übernommen wird
 * nichts automatisch – das DuckDNS-Token steht ohnehin nicht in der Sicherung.
 * Quelle wie leseHostconfig() in routes/einrichtung.js: die gespeicherte
 * Domain, sonst eine Basisadresse https://<name>.duckdns.org, außer DuckDNS
 * war ausdrücklich abgeschaltet.
 */
export const HERKUNFT_MERKEN_SQL = `DO $postbuch$
  DECLARE
    dd jsonb;
    d text;
    aus boolean := false;
  BEGIN
    IF to_regclass('postbuch._settings') IS NULL THEN RETURN; END IF;
    DELETE FROM postbuch._settings WHERE key = 'restore_herkunft';
    SELECT value INTO dd FROM postbuch._settings WHERE key = 'hostconfig_duckdns';
    IF jsonb_typeof(dd) = 'object' THEN
      d := NULLIF(lower(btrim(COALESCE(dd->>'domain', ''))), '');
      aus := d IS NULL AND dd->>'abgeschaltetAm' IS NOT NULL;
    END IF;
    IF d IS NULL AND NOT aus THEN
      SELECT substring(lower(btrim(value #>> '{}')) FROM '^https://([a-z0-9-]{1,63}\\.duckdns\\.org)(:[0-9]{2,5})?/?$')
        INTO d
        FROM postbuch._settings WHERE key = 'app_host' AND jsonb_typeof(value) = 'string';
    END IF;
    IF d IS NOT NULL AND d !~ '\\.duckdns\\.org$' THEN d := d || '.duckdns.org'; END IF;
    IF d ~ '^[a-z0-9-]{1,63}\\.duckdns\\.org$' THEN
      INSERT INTO postbuch._settings (key, value, updated_at)
      VALUES ('restore_herkunft', jsonb_build_object('domain', d), NOW())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();
    END IF;
  END $postbuch$;`;

/**
 * Host-gebundene Einstellungen (lib/host-settings.js) der laufenden Instanz
 * ersetzen die mitgebrachten; was die Instanz nicht hat, wird entfernt.
 * `hostwerte` = hostSettingsDerInstanz().
 */
export function hostWerteErhaltenSql(hostwerte = []) {
  if (!hostwerte.length) return null;
  return `DO $postbuch$
     DECLARE
       instanz jsonb := ${jsonAlsSqlAusdruck(hostwerte)};
       eintrag jsonb;
     BEGIN
       IF to_regclass('postbuch._settings') IS NULL THEN RETURN; END IF;
       FOR eintrag IN SELECT * FROM jsonb_array_elements(instanz) LOOP
         IF jsonb_typeof(eintrag->'value') = 'null' THEN
           DELETE FROM postbuch._settings WHERE key = eintrag->>'key';
         ELSE
           INSERT INTO postbuch._settings (key, value, updated_at)
           VALUES (eintrag->>'key', eintrag->'value', NOW())
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();
         END IF;
       END LOOP;
     END $postbuch$;`;
}

/**
 * Cleanup-SQL für die admin-only Restore-Routen (routes/backup.js).
 * `verschluesselung` = verschluesselungFuerRestore(settings) der laufenden Instanz.
 */
/**
 * SQL für die Restore-Nachbearbeitung: hält fest, dass gerade eingespielt
 * wurde, und übernimmt das mitgesicherte Stack-Profil. Läuft in derselben
 * Transaktion wie das Einspielen (adminRestoreCleanupSql, setupRestoreCleanupSql); das Profil schreibt service/stack-profil.js vor jedem Backup.
 */
/**
 * Einrichtungszustand nach dem Einspielen: Schritte und Nachweise (bestandener
 * KI- und Ablage-Test) bleiben erhalten, denn das gesicherte System hatte sie
 * schon. Beide Nachweise tragen eine Signatur der Einstellungen und verfallen
 * von selbst, wenn hier etwas anders ist. Zurückgesetzt wird nur, was die
 * Oberfläche sperren oder den Assistenten erneut öffnen würde.
 *
 * Die Backup-Entscheidung hat das gesicherte System nachweislich getroffen –
 * es gibt ja eine Sicherung. Ein mitgebrachter Backup-Eintrag gilt deshalb als
 * bewusst, damit ein später geöffneter Assistent nicht erneut danach fragt.
 */
const EINRICHTUNG_NACH_RESTORE_SQL = `DO $postbuch$ BEGIN
  IF to_regclass('postbuch._settings') IS NOT NULL THEN
    UPDATE postbuch._settings
       SET value = value || '{"bewusst": true}'::jsonb, updated_at = NOW()
     WHERE key = 'backup' AND jsonb_typeof(value) = 'object';
    UPDATE postbuch._settings
       SET value = CASE WHEN jsonb_typeof(value) = 'object' THEN value ELSE '{}'::jsonb END
                   || jsonb_build_object(
                        'status', CASE WHEN value->>'status' = 'abgeschlossen' THEN 'abgeschlossen' ELSE 'nicht_aktiv' END,
                        'quelle', 'manuell',
                        'eingeladenAm', NULL),
           updated_at = NOW()
     WHERE key = 'einrichtung';
  END IF;
END $postbuch$;`;

const NACH_RESTORE_SQL = `DO $postbuch$ BEGIN
  IF to_regclass('postbuch._settings') IS NOT NULL THEN
    INSERT INTO postbuch._settings (key, value, updated_at)
    VALUES ('nach_restore', jsonb_build_object(
      'am', to_jsonb(now()),
      'profil', (SELECT value FROM postbuch._settings WHERE key = 'stack_profil'),
      'herkunftDomain', (SELECT value->'domain' FROM postbuch._settings WHERE key = 'restore_herkunft')), NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();
    DELETE FROM postbuch._settings WHERE key = 'restore_herkunft';
  END IF;
END $postbuch$;`;

export function adminRestoreCleanupSql(verschluesselung = null, geheimnisse = [], hostwerte = []) {
  return [
    zugangsdatenErhaltenSql(geheimnisse),
    HERKUNFT_MERKEN_SQL,
    hostWerteErhaltenSql(hostwerte),
    // Web-Sitzungen gehören nicht zum wiederhergestellten Stand: auch Backups
    // aus Versionen, die die Sitzungstabelle noch mitgesichert haben, dürfen
    // keine alten Anmeldungen zurückbringen. Alle melden sich neu an.
    `DO $postbuch$ BEGIN
       IF to_regclass('postbuch.session') IS NOT NULL THEN
         DELETE FROM postbuch.session;
       END IF;
     END $postbuch$;`,
    `DO $postbuch$ BEGIN
       IF to_regclass('postbuch._settings') IS NOT NULL THEN
         DELETE FROM postbuch._settings WHERE key = 'dev_features_unlocked';
       END IF;
     END $postbuch$;`,
    EINRICHTUNG_NACH_RESTORE_SQL,
    verschluesselungErhaltenSql(verschluesselung),
    NACH_RESTORE_SQL,
  ].filter(Boolean);
}

/**
 * Cleanup-SQL für den Neuinstallations-Restore (routes/setup-restore.js):
 * zusätzlich Sessions und Zugangsdaten der alten Instanz kappen, fehlende
 * Zugangsdaten aus der frischen Instanz übernehmen sowie das
 * frische SESSION_SECRET dieser Installation eintragen. `zusatzDeks` (Base64)
 * stammen aus einer auf der Setup-Seite mitgegebenen Schlüsseldatei.
 */
export function setupRestoreCleanupSql({ zusatzDeks = [], geheimnisse = [], hostwerte = [] } = {}) {
  const cleanupSql = [
    // Vor dem Löschen unten: app_password und OAuth-Zwischenstand der frischen
    // Instanz werden danach wie bisher entfernt.
    zugangsdatenErhaltenSql(geheimnisse),
    HERKUNFT_MERKEN_SQL,
    hostWerteErhaltenSql(hostwerte),
    `DO $postbuch$ BEGIN
       IF to_regclass('postbuch.session') IS NOT NULL THEN
         DELETE FROM postbuch.session;
       END IF;
     END $postbuch$;`,
    `DO $postbuch$ BEGIN
       IF to_regclass('postbuch._settings') IS NOT NULL THEN
         DELETE FROM postbuch._settings
           WHERE key IN ('app_password', 'onedrive_auth_state', 'dev_features_unlocked');
       END IF;
     END $postbuch$;`,
    EINRICHTUNG_NACH_RESTORE_SQL,
  ];
  // Eine frische Installation hat noch keinen eigenen Schlüsselbund; übernommen
  // werden der des Backups und die Schlüssel einer mitgegebenen Schlüsseldatei.
  cleanupSql.push(verschluesselungErhaltenSql(null, zusatzDeks));
  cleanupSql.push(NACH_RESTORE_SQL);
  if (process.env.SESSION_SECRET) {
    const sessionSecretJson = JSON.stringify(process.env.SESSION_SECRET).replaceAll("'", "''");
    cleanupSql.push(
      `DO $postbuch$ BEGIN
         IF to_regclass('postbuch._settings') IS NOT NULL THEN
           INSERT INTO postbuch._settings (key, value, updated_at)
           VALUES ('session_secret', '${sessionSecretJson}'::jsonb, NOW())
           ON CONFLICT (key) DO UPDATE
             SET value = EXCLUDED.value, updated_at = NOW();
         END IF;
       END $postbuch$;`,
    );
  }
  return cleanupSql.filter(Boolean);
}
