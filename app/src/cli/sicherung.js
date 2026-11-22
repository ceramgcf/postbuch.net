#!/usr/bin/env node
/**
 * cli/sicherung.js — legt sofort eine selbst ausgelöste Sicherung an, wie
 * „Jetzt sichern“ in den Einstellungen (Ablage in `_backup/user`, nie von der
 * Retention gelöscht). Der Installer ruft sie vor einer Deinstallation auf:
 *
 *   docker compose exec -T app node src/cli/sicherung.js
 *
 * Exit 0 nur, wenn beide Dumps in der Dateiablage liegen (Ausgabe auf stdout:
 * der Dateiname der Sicherung). Exit 3: nichts zu sichern – die Ablage ist noch
 * nicht eingerichtet und es gibt kein Dokument (Deinstallation direkt nach der
 * Installation). Sonst 1 mit Grund auf stderr.
 */

// `docker compose exec` erbt nicht die vom Entrypoint gebaute DATABASE_URL.
// Dieselbe URL wie dort, bevor db.js (beim Import) den Pool anlegt.
if (!process.env.DATABASE_URL && process.env.POSTGRES_PASSWORD) {
  const e = process.env;
  process.env.DATABASE_URL = `postgresql://${encodeURIComponent(e.POSTGRES_USER || 'postbuch')}:`
    + `${encodeURIComponent(e.POSTGRES_PASSWORD)}@${e.POSTGRES_HOST || 'postgres'}:${e.POSTGRES_PORT || '5432'}/`
    + `${e.POSTGRES_DB || 'postbuch'}?options=-c%20search_path%3Dpostbuch,public%20-c%20TimeZone%3DEurope/Berlin`;
}

// stdout gehört allein dem Dateinamen; die Protokollzeilen der Sicherung
// (console.log in backup.js) gehen nach stderr.
const ausgabe = (text) => process.stdout.write(`${text}\n`);
console.log = (...args) => console.error(...args);

const { runBackup } = await import('../jobs/backup.js');
const { default: pool } = await import('../db.js');

let code = 1;
try {
  const ergebnis = await runBackup({ manuell: true });
  if (ergebnis?.binaryFileName) {
    ausgabe(ergebnis.binaryFileName);
    code = 0;
  } else {
    const { rows } = await pool.query('SELECT EXISTS (SELECT 1 FROM postbuch.postbuch) AS da');
    if (rows[0]?.da) {
      console.error('Keine Sicherung angelegt: In der Dateiablage ist kein Sicherungsordner eingerichtet.');
    } else {
      console.error('Nichts zu sichern: Die Ablage ist noch nicht eingerichtet und es gibt keine Dokumente.');
      code = 3;
    }
  }
} catch (err) {
  console.error(`Sicherung fehlgeschlagen: ${err.message}`);
} finally {
  // runBackup protokolliert ohne await; die Einträge vor dem Schließen abwarten.
  await new Promise((r) => setTimeout(r, 500));
  await pool.end().catch(() => {});
}
process.exit(code);
