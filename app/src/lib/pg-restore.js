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
  const sql = `BEGIN;\nDROP SCHEMA IF EXISTS postbuch CASCADE;\n${passendSql}\n${cleanupBlock}COMMIT;\n`;

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
  } finally {
    await unlink(sqlPath).catch(() => {});
  }
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
 * Cleanup-SQL für die admin-only Restore-Routen (routes/backup.js).
 * `verschluesselung` = verschluesselungFuerRestore(settings) der laufenden Instanz.
 */
export function adminRestoreCleanupSql(verschluesselung = null, geheimnisse = []) {
  return [
    zugangsdatenErhaltenSql(geheimnisse),
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
         DELETE FROM postbuch._settings WHERE key IN ('dev_features_unlocked', 'einrichtung');
       END IF;
     END $postbuch$;`,
    verschluesselungErhaltenSql(verschluesselung),
  ].filter(Boolean);
}

/**
 * Cleanup-SQL für den Neuinstallations-Restore (routes/setup-restore.js):
 * zusätzlich Sessions und Zugangsdaten der alten Instanz kappen, fehlende
 * Zugangsdaten aus der frischen Instanz übernehmen sowie das
 * frische SESSION_SECRET dieser Installation eintragen. `zusatzDeks` (Base64)
 * stammen aus einer auf der Setup-Seite mitgegebenen Schlüsseldatei.
 */
export function setupRestoreCleanupSql({ zusatzDeks = [], geheimnisse = [] } = {}) {
  const cleanupSql = [
    // Vor dem Löschen unten: app_password und OAuth-Zwischenstand der frischen
    // Instanz werden danach wie bisher entfernt.
    zugangsdatenErhaltenSql(geheimnisse),
    `DO $postbuch$ BEGIN
       IF to_regclass('postbuch.session') IS NOT NULL THEN
         DELETE FROM postbuch.session;
       END IF;
     END $postbuch$;`,
    `DO $postbuch$ BEGIN
       IF to_regclass('postbuch._settings') IS NOT NULL THEN
         DELETE FROM postbuch._settings
           WHERE key IN ('app_password', 'onedrive_auth_state', 'dev_features_unlocked', 'einrichtung');
       END IF;
     END $postbuch$;`,
  ];
  // Eine frische Installation hat noch keinen eigenen Schlüsselbund; übernommen
  // werden der des Backups und die Schlüssel einer mitgegebenen Schlüsseldatei.
  cleanupSql.push(verschluesselungErhaltenSql(null, zusatzDeks));
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
