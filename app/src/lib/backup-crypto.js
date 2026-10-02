/**
 * lib/backup-crypto.js — Envelope-Verschlüsselung für Datenbank-Backups.
 *
 * Ein zufälliger Data Encryption Key (DEK) verschlüsselt den (bereits
 * gzip-komprimierten) Dump mit AES-256-GCM. Der DEK selbst wird mit einem aus
 * einem separaten Backup-Passwort abgeleiteten Schlüssel "gewrappt" (ebenfalls
 * AES-256-GCM, Passwort-Ableitung über scrypt — Node-nativ, kein npm-Paket
 * nötig). Reine Krypto-Primitive: kein Zugriff auf _settings oder die Ablage,
 * das bleibt Sache der Aufrufer (jobs/backup.js, routes/backup.js,
 * routes/setup-restore.js).
 *
 * Dateiformat einer verschlüsselten Backup-Datei (Extension bleibt .pgdump.gz
 * / .sql.gz, obwohl der Inhalt kein reines Gzip mehr ist — Unterscheidung
 * läuft über die Magic-Bytes am Anfang, nicht über den Dateinamen, damit
 * Retention-Regex und Restore-Dateiliste unverändert bleiben):
 *
 *   MAGIC (4 Byte "PBE1") | headerLen (4 Byte, uint32BE) | headerJson (utf8) | iv (12) | authTag (16) | ciphertext
 *
 * headerJson enthält den DEK, gewrappt mit dem zum Erstellungszeitpunkt
 * gültigen Passwort — dieser Header wird nie nachträglich aktualisiert, auch
 * nicht bei einer späteren Passwortänderung (siehe docs/backup-wiederherstellung.md).
 *
 * Schlüsseldatei (Sidecar `_backup/schluessel.json`), Format 2:
 *
 *   { version: 2, wrappedDek, weitereWrappedDeks: [...], updatedAt }
 *
 * `wrappedDek` ist der aktuelle DEK (Format 1 kannte nur dieses Feld und
 * bleibt damit lesbar), `weitereWrappedDeks` alle früheren DEKs der Instanz —
 * gewrappt mit dem aktuellen Passwort. Einträge, die sich mit dem aktuellen
 * Passwort nicht öffnen ließen, als die Datei zuletzt geschrieben wurde,
 * bleiben unverändert erhalten: Sie gehen nie verloren, brauchen aber ihr
 * eigenes Passwort.
 */

import { randomBytes, createCipheriv, createDecipheriv, scrypt as scryptCallback } from 'crypto';
import { promisify } from 'util';

const scryptAsync = promisify(scryptCallback);

export const MAGIC = Buffer.from('PBE1', 'ascii');
export const DEK_LEN = 32;
const SCRYPT_PARAMS = { N: 32768, r: 8, p: 1 };
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

export class BackupPasswortFalschError extends Error {
  constructor(message = 'Backup-Passwort ist falsch.') {
    super(message);
    this.code = 'BACKUP_PASSWORT_FALSCH';
  }
}

export class BackupDekFalschError extends Error {
  constructor(message = 'Backup-Datei ist beschädigt oder der Schlüssel passt nicht.') {
    super(message);
    this.code = 'BACKUP_DEK_FALSCH';
  }
}

export function generateDek() {
  return randomBytes(DEK_LEN);
}

async function deriveKey(passwort, salt, params) {
  return scryptAsync(String(passwort), salt, DEK_LEN, {
    N: params.N, r: params.r, p: params.p, maxmem: SCRYPT_MAXMEM,
  });
}

/**
 * Verschlüsselt den DEK mit einem aus `passwort` abgeleiteten Schlüssel.
 * Ergebnis ist JSON-serialisierbar (Base64-Felder) — landet unverändert sowohl
 * im eingebetteten Datei-Header als auch im gemeinsamen Sidecar
 * `_backup/schluessel.json` und in `_settings.backup_encryption_secret`.
 */
export async function wrapDek(dek, passwort) {
  const salt = randomBytes(16);
  const key = await deriveKey(passwort, salt, SCRYPT_PARAMS);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const wrapped = Buffer.concat([cipher.update(dek), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    wrapped: wrapped.toString('base64'),
    scryptParams: SCRYPT_PARAMS,
  };
}

/**
 * Entschlüsselt einen gewrappten DEK mit `passwort`. Ein falsches Passwort
 * schlägt am GCM-Auth-Tag fehl — das ist die einzige "Verifikation", die es
 * braucht (authenticated encryption liefert sie gratis mit).
 */
export async function unwrapDek(wrappedDek, passwort) {
  const params = wrappedDek?.scryptParams || SCRYPT_PARAMS;
  const salt = Buffer.from(wrappedDek.salt, 'base64');
  const iv = Buffer.from(wrappedDek.iv, 'base64');
  const authTag = Buffer.from(wrappedDek.authTag, 'base64');
  const wrapped = Buffer.from(wrappedDek.wrapped, 'base64');
  const key = await deriveKey(passwort, salt, params);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  try {
    return Buffer.concat([decipher.update(wrapped), decipher.final()]);
  } catch {
    throw new BackupPasswortFalschError();
  }
}

/**
 * Öffnet `passwort` die Umhüllung `wrappedDek` und kommt dabei genau `dek`
 * heraus? Grundlage des Konsistenzabgleichs zwischen gespeichertem Passwort
 * und gespeicherter Umhüllung (lib/backup-encryption.js).
 */
export async function wrappingPasstZumDek(wrappedDek, passwort, dek) {
  if (!wrappedDek || !passwort || !dek) return false;
  try {
    return (await unwrapDek(wrappedDek, passwort)).equals(dek);
  } catch (err) {
    if (err instanceof BackupPasswortFalschError) return false;
    throw err;
  }
}

/** Verschlüsselt beliebige Bytes (den bereits gzip-komprimierten Dump) mit dem rohen DEK. */
export function encryptPayload(payload, dek) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', dek, iv);
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]);
}

/** Kehrt encryptPayload() um. Wirft BackupDekFalschError bei falschem DEK/Manipulation. */
export function decryptPayload(buffer, dek) {
  const iv = buffer.subarray(0, 12);
  const authTag = buffer.subarray(12, 28);
  const ciphertext = buffer.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', dek, iv);
  decipher.setAuthTag(authTag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new BackupDekFalschError();
  }
}

/**
 * Baut die vollständige verschlüsselte Backup-Datei aus dem gzip-komprimierten
 * Dump. `wrappedDekForFile` ist der zum Erstellungszeitpunkt aktuelle,
 * gewrappte DEK (aus _settings.backup_encryption_secret.wrappedDekCurrent) —
 * er wird 1:1 als Klartext-Header eingebettet und danach nie mehr verändert.
 */
export function buildEncryptedFile(gzipBuffer, dek, wrappedDekForFile) {
  const headerJson = Buffer.from(JSON.stringify(wrappedDekForFile), 'utf8');
  const headerLen = Buffer.alloc(4);
  headerLen.writeUInt32BE(headerJson.length, 0);
  const payload = encryptPayload(gzipBuffer, dek);
  return Buffer.concat([MAGIC, headerLen, headerJson, payload]);
}

export function isEncryptedBackup(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 8 && buffer.subarray(0, 4).equals(MAGIC);
}

/**
 * Zerlegt eine verschlüsselte Backup-Datei in ihren eingebetteten
 * Wrapped-DEK-Header und die verschlüsselte Nutzlast (Rückgabe von
 * encryptPayload, noch nicht entschlüsselt). Liefert null, wenn `buffer` keine
 * PBE1-Datei ist (also ein Alt-Backup / reines Gzip).
 */
export function parseEncryptedFile(buffer) {
  if (!isEncryptedBackup(buffer)) return null;
  const headerLen = buffer.readUInt32BE(4);
  const headerStart = 8;
  const headerEnd = headerStart + headerLen;
  if (headerEnd > buffer.length) {
    throw new Error('Backup-Datei ist beschädigt (Header-Länge unplausibel).');
  }
  const wrappedDek = JSON.parse(buffer.subarray(headerStart, headerEnd).toString('utf8'));
  const payload = buffer.subarray(headerEnd);
  return { wrappedDek, payload };
}

/** Alle gewrappten DEKs einer Schlüsseldatei (Format 1 und 2). */
export function sidecarEintraege(sidecar) {
  if (!sidecar || typeof sidecar !== 'object') return [];
  const weitere = Array.isArray(sidecar.weitereWrappedDeks) ? sidecar.weitereWrappedDeks : [];
  return [sidecar.wrappedDek, ...weitere]
    .filter(e => e && typeof e === 'object' && typeof e.wrapped === 'string');
}

/**
 * Öffnet alle Einträge einer Schlüsseldatei, die zu `passwort` passen.
 * `deks` sind die entpackten Schlüssel, `fremde` die Einträge, die ein anderes
 * Passwort brauchen (oder unlesbar sind) — Aufrufer, die die Datei neu
 * schreiben, übernehmen sie unverändert.
 */
export async function sidecarOeffnen(sidecar, passwort) {
  const deks = [];
  const fremde = [];
  for (const eintrag of sidecarEintraege(sidecar)) {
    try {
      deks.push(await unwrapDek(eintrag, passwort));
    } catch {
      fremde.push(eintrag);
    }
  }
  return { deks, fremde };
}

/** Entschlüsselt die Nutzlast mit dem ersten passenden DEK, sonst null. */
export function mitDeksEntschluesseln(payload, deks) {
  for (const dek of deks) {
    try {
      return decryptPayload(payload, dek);
    } catch {
      // nächster Schlüssel
    }
  }
  return null;
}

/**
 * Passwortbasierte Entschlüsselung ohne Zugriff auf eine laufende Instanz
 * (Neuinstallation, Kommandozeile). Probiert `passwort` zuerst gegen den in
 * der Datei eingebetteten Header (Passwort zum Erstellungszeitpunkt), dann —
 * falls eine Schlüsseldatei vorliegt — gegen alle ihre Einträge (aktuelles
 * Passwort). Liefert `{ daten, sidecarDeks }`; `sidecarDeks` sind alle mit
 * diesem Passwort geöffneten Schlüssel der Schlüsseldatei, damit der Aufrufer
 * sie in den Schlüsselbund der Instanz übernehmen kann.
 * Wirft BackupPasswortFalschError, wenn nichts passt.
 */
export async function mitPasswortEntschluesseln(buffer, { passwort, sidecar = null }) {
  const { wrappedDek, payload } = parseEncryptedFile(buffer);
  const { deks: sidecarDeks } = sidecar ? await sidecarOeffnen(sidecar, passwort) : { deks: [] };

  let daten = null;
  try {
    daten = decryptPayload(payload, await unwrapDek(wrappedDek, passwort));
  } catch (err) {
    if (!(err instanceof BackupPasswortFalschError)) throw err;
  }
  if (!daten) daten = mitDeksEntschluesseln(payload, sidecarDeks);
  if (!daten) throw new BackupPasswortFalschError();
  return { daten, sidecarDeks };
}
