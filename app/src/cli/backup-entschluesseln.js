#!/usr/bin/env node
/**
 * cli/backup-entschluesseln.js — entschlüsselt eine verschlüsselte
 * Backup-Datei (.pgdump.gz oder .sql.gz) ohne laufende postbuch.net-Instanz.
 *
 * Liest die Datei von stdin und schreibt den entschlüsselten Gzip-Inhalt nach
 * stdout. Geheimnisse kommen ausschließlich aus Umgebungsvariablen, damit sie
 * weder in der Prozessliste noch in der Shell-Historie stehen:
 *
 *   BACKUP_PASSWORT         Backup-Passwort (Pflicht)
 *   BACKUP_SCHLUESSELDATEI  Inhalt von _backup/schluessel.json (optional);
 *                           damit genügt das zuletzt gesetzte Passwort
 *
 * Aufruf im App-Container (siehe docs/backup-wiederherstellung.md):
 *
 *   read -rs BACKUP_PASSWORT && export BACKUP_PASSWORT
 *   docker compose exec -T -e BACKUP_PASSWORT app \
 *     node src/cli/backup-entschluesseln.js < backup.sql.gz > klartext.sql.gz
 *
 * Exit-Codes: 0 = entschlüsselt (oder war gar nicht verschlüsselt),
 * 2 = Passwort passt nicht, 1 = sonstiger Fehler.
 */

import {
  isEncryptedBackup, mitPasswortEntschluesseln, sidecarEintraege, BackupPasswortFalschError,
} from '../lib/backup-crypto.js';

async function stdinLesen() {
  const teile = [];
  for await (const teil of process.stdin) teile.push(teil);
  return Buffer.concat(teile);
}

function abbruch(meldung, code = 1) {
  process.stderr.write(`${meldung}\n`);
  process.exit(code);
}

async function main() {
  if (process.stdin.isTTY) {
    abbruch('Backup-Datei bitte per stdin übergeben (… < backup.sql.gz > klartext.sql.gz).');
  }
  if (process.stdout.isTTY) {
    abbruch('Ausgabe bitte in eine Datei umleiten (… > klartext.sql.gz).');
  }

  const datei = await stdinLesen();
  if (!isEncryptedBackup(datei)) {
    if (datei[0] === 0x1f && datei[1] === 0x8b) {
      process.stderr.write('Datei ist nicht verschlüsselt – Inhalt wird unverändert ausgegeben.\n');
      process.stdout.write(datei);
      return;
    }
    abbruch('Keine postbuch.net-Backup-Datei (weder verschlüsselt noch Gzip).');
  }

  const passwort = process.env.BACKUP_PASSWORT;
  if (!passwort) abbruch('Umgebungsvariable BACKUP_PASSWORT fehlt.');

  let sidecar = null;
  if (process.env.BACKUP_SCHLUESSELDATEI) {
    try {
      sidecar = JSON.parse(process.env.BACKUP_SCHLUESSELDATEI);
    } catch {
      abbruch('BACKUP_SCHLUESSELDATEI enthält kein gültiges JSON.');
    }
    if (!sidecarEintraege(sidecar).length) abbruch('BACKUP_SCHLUESSELDATEI enthält keine Backup-Schlüssel.');
  }

  try {
    const { daten } = await mitPasswortEntschluesseln(datei, { passwort, sidecar });
    process.stdout.write(daten);
    process.stderr.write('Entschlüsselt.\n');
  } catch (err) {
    if (err instanceof BackupPasswortFalschError) {
      abbruch(sidecar
        ? 'Passwort passt weder zu dieser Datei noch zur Schlüsseldatei.'
        : 'Passwort passt nicht. Mit dem zuletzt gesetzten Passwort zusätzlich BACKUP_SCHLUESSELDATEI setzen.', 2);
    }
    abbruch(`Entschlüsselung fehlgeschlagen: ${err.message}`);
  }
}

main();
