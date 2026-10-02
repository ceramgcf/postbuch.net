/**
 * lib/backup-encryption.js — Orchestrierung der Backup-Verschlüsselung.
 *
 * Verbindet die reinen Krypto-Primitive aus backup-crypto.js mit _settings und
 * der Ablage.
 *
 * Schlüsselbund: Eine Instanz erzeugt ihren Data Encryption Key (DEK) genau
 * einmal — beim ersten Aktivieren — und behält ihn danach für immer, auch über
 * Passwortwechsel und Ab-/Wiedereinschalten hinweg. Kommen trotzdem weitere
 * DEKs ins Spiel (Instanzen, die vor dieser Regel neu erzeugt haben, oder ein
 * eingespieltes Backup mit anderem DEK), wandern sie nach
 * `_settings.backup_encryption_secret.fruehereDeks` und bleiben dort. Damit
 * entschlüsselt die laufende App jedes Backup, dessen DEK sie je kannte, ganz
 * ohne Passworteingabe.
 *
 * Die Schlüsseldatei `_backup/schluessel.json` (Format siehe backup-crypto.js)
 * enthält denselben Schlüsselbund, gewrappt mit dem AKTUELLEN Passwort. Wer
 * Zugriff auf die Ablage und das aktuelle Passwort hat, kommt damit an jeden
 * DEK — auch ganz ohne laufende postbuch.net-Instanz (Neuinstallation,
 * Kommandozeile). Sie liegt im Backup-Ordner jedes Backends, in das gesichert
 * wird, und wird abgeglichen, sobald sich Schlüsselbund oder Passwort ändern
 * (sidecarAbgleichen: bei Passwortänderung, vor jedem Backup, beim App-Start).
 * Einträge, die sich mit dem bekannten Passwort nicht öffnen lassen, werden
 * dabei nie verworfen, sondern unverändert mitgeschrieben.
 */

import { createHash } from 'crypto';
import db from '../db.js';
import { getActiveBackendName } from '../config.js';
import { appLog } from '../app-log.js';
import {
  generateDek, wrapDek, unwrapDek, decryptPayload,
  isEncryptedBackup, parseEncryptedFile, BackupPasswortFalschError,
  sidecarEintraege, sidecarOeffnen, mitDeksEntschluesseln, wrappingPasstZumDek,
} from './backup-crypto.js';

export const SIDECAR_NAME = 'schluessel.json';

async function upsertSetting(key, value) {
  await db.query(
    `INSERT INTO postbuch._settings (key, value, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = NOW()`,
    [key, JSON.stringify(value)],
  );
}

/**
 * Alle Schreiber von Schlüsselbund und Passwort laufen nacheinander. Zwei
 * gleichzeitige Passwortänderungen (oder eine Änderung neben einem
 * Schlüsseldatei-Abgleich) könnten sonst Umhüllung und Passwort aus
 * verschiedenen Aufrufen kombinieren. Es gibt genau einen App-Prozess, daher
 * genügt eine prozessweite Kette.
 */
let schluesselKette = Promise.resolve();
function exklusiv(fn) {
  const lauf = schluesselKette.then(fn, fn);
  schluesselKette = lauf.catch(() => {});
  return lauf;
}

/**
 * Liest Schlüsselbund und Passwort innerhalb der Kette frisch aus der DB —
 * die vom Aufrufer mitgegebenen Settings können zu diesem Zeitpunkt schon
 * veraltet sein.
 */
async function mitFrischemSchluessel(settings) {
  const { rows } = await db.query(
    `SELECT key, value FROM postbuch._settings
      WHERE key IN ('backup_encryption_secret', 'backup_encryption_passwort')`,
  );
  const frisch = { ...settings, backup_encryption_secret: undefined, backup_encryption_passwort: undefined };
  for (const { key, value } of rows) frisch[key] = value;
  return frisch;
}

/** Schreibt Schlüsselbund und Passwort in einer Transaktion. */
async function schluesselUndPasswortSpeichern(secret, passwort) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    for (const [key, value] of [['backup_encryption_secret', secret], ['backup_encryption_passwort', passwort]]) {
      await client.query(
        `INSERT INTO postbuch._settings (key, value, updated_at)
         VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = NOW()`,
        [key, JSON.stringify(value)],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Nicht-geheimer Status, sicher für generische Settings-Ausgaben/UI. */
export function verschluesselungsStatus(settings) {
  return {
    enabled: settings.backup_encryption?.enabled === true,
    entschieden: settings.backup_encryption?.bewusst === true,
    passwortGesetzt: !!settings.backup_encryption_passwort,
  };
}

/**
 * Schlüsselbund, wie er nach allen laufenden Änderungen gerade gilt. Der
 * Backup-Lauf liest ihn nach dem Abgleich, weil der Abgleich die Umhüllung
 * erneuert haben kann.
 */
export function aktuellerSchluesselbund() {
  return exklusiv(async () => (await mitFrischemSchluessel({})).backup_encryption_secret ?? null);
}

/** Aktueller DEK und alle früheren als Base64, dedupliziert, aktueller zuerst. */
function schluesselbundB64(secret) {
  if (!secret?.dek) return [];
  const fruehere = Array.isArray(secret.fruehereDeks) ? secret.fruehereDeks : [];
  return [...new Set([secret.dek, ...fruehere].filter(d => typeof d === 'string' && d))];
}

/** Alle DEKs, die diese Instanz kennt (für die Entschlüsselung ohne Passwort). */
export function lokaleDeks(settings) {
  return schluesselbundB64(settings.backup_encryption_secret).map(b64 => Buffer.from(b64, 'base64'));
}

/**
 * Fingerabdruck des Stands, den die Schlüsseldatei haben muss: Schlüsselbund
 * plus aktuelle Wrapping (deren Salt ändert sich bei jedem Passwortwechsel).
 */
function sidecarSollStand(deksB64, wrappedDekCurrent) {
  const hash = createHash('sha256');
  for (const d of [...deksB64].sort()) hash.update(`${d}\n`);
  hash.update(`salt:${wrappedDekCurrent?.salt ?? ''}`);
  return hash.digest('hex').slice(0, 32);
}

async function leseSidecar(storage, backupFolderId, bekannteId) {
  if (bekannteId) {
    try {
      return { id: bekannteId, inhalt: JSON.parse((await storage.download(bekannteId)).toString('utf8')) };
    } catch {
      // Datei evtl. von Hand gelöscht/ersetzt — unten per Name suchen.
    }
  }
  const kinder = await storage.listChildren(backupFolderId);
  const gefunden = kinder.find(k => !k.isFolder && k.name === SIDECAR_NAME);
  if (!gefunden) return null;
  try {
    return { id: gefunden.id, inhalt: JSON.parse((await storage.download(gefunden.id)).toString('utf8')) };
  } catch {
    return { id: gefunden.id, inhalt: null };
  }
}

async function schreibeSidecarDatei(storage, backupFolderId, id, inhaltObj) {
  const inhalt = Buffer.from(JSON.stringify(inhaltObj, null, 2), 'utf8');
  if (id) {
    try {
      await storage.uploadContent(id, inhalt);
      return id;
    } catch {
      // unten neu suchen bzw. anlegen
    }
  }
  const kinder = await storage.listChildren(backupFolderId);
  const vorhanden = kinder.find(k => !k.isFolder && k.name === SIDECAR_NAME);
  if (vorhanden) {
    await storage.uploadContent(vorhanden.id, inhalt);
    return vorhanden.id;
  }
  const { id: neueId } = await storage.uploadNew(inhalt, SIDECAR_NAME, backupFolderId);
  return neueId;
}

function eintragSchluessel(e) {
  return `${e.salt}|${e.wrapped}`;
}

/**
 * Schreibt die Schlüsseldatei im Backup-Ordner des aktiven Backends neu und
 * persistiert den dabei ggf. erweiterten Schlüsselbund.
 *
 * - `secret`: aktueller Stand von backup_encryption_secret (mit dek + wrappedDekCurrent,
 *   letzterer bereits mit `passwort` gewrappt)
 * - `passwort`: Passwort, mit dem die Datei geschrieben wird (das künftig aktuelle)
 * - `lesePasswoerter`: Passwörter, mit denen die vorhandene Datei gelesen wird,
 *   damit dort bekannte, hier aber fehlende DEKs übernommen werden
 */
async function sidecarSchreiben({ settings, secret, passwort, lesePasswoerter, storage, backupFolderId }) {
  const backend = getActiveBackendName(settings);
  const deks = schluesselbundB64(secret);
  const fremde = [];

  const vorhanden = await leseSidecar(storage, backupFolderId, secret.sidecarIds?.[backend] ?? null);
  if (vorhanden?.inhalt) {
    let rest = sidecarEintraege(vorhanden.inhalt);
    for (const pw of new Set(lesePasswoerter.filter(Boolean))) {
      if (!rest.length) break;
      const offen = await sidecarOeffnen({ weitereWrappedDeks: rest }, pw);
      for (const dek of offen.deks) {
        const b64 = dek.toString('base64');
        if (!deks.includes(b64)) deks.push(b64);
      }
      rest = offen.fremde;
    }
    const gesehen = new Set();
    for (const e of rest) {
      if (gesehen.has(eintragSchluessel(e))) continue;
      gesehen.add(eintragSchluessel(e));
      fremde.push(e);
    }
  }

  const fruehereDeks = deks.filter(d => d !== secret.dek);
  const weitereWrappedDeks = [];
  for (const b64 of fruehereDeks) {
    weitereWrappedDeks.push(await wrapDek(Buffer.from(b64, 'base64'), passwort));
  }
  weitereWrappedDeks.push(...fremde);

  const sidecarId = await schreibeSidecarDatei(storage, backupFolderId, vorhanden?.id ?? null, {
    version: 2,
    wrappedDek: secret.wrappedDekCurrent,
    weitereWrappedDeks,
    updatedAt: new Date().toISOString(),
  });

  const { sidecarId: _legacySidecarId, ...ohneLegacy } = secret;
  const neu = {
    ...ohneLegacy,
    fruehereDeks,
    sidecarIds: { ...(secret.sidecarIds ?? {}), [backend]: sidecarId },
    sidecarStand: {
      ...(secret.sidecarStand ?? {}),
      [backend]: sidecarSollStand([secret.dek, ...fruehereDeks], secret.wrappedDekCurrent),
    },
  };
  await upsertSetting('backup_encryption_secret', neu);
  return neu;
}

/**
 * Setzt das Passwort (erstmalig oder neu). Der DEK wird nur erzeugt, wenn die
 * Instanz noch nie einen hatte — sonst bleibt er, damit jedes bisherige
 * verschlüsselte Backup weiter mit dem Schlüsselbund lesbar ist.
 */
async function passwortSetzen({ passwort, settings: mitgegeben, storage, backupFolderId }) {
  return exklusiv(async () => {
    const settings = await mitFrischemSchluessel(mitgegeben);
    const bisher = settings.backup_encryption_secret ?? {};
    const dek = bisher.dek ? Buffer.from(bisher.dek, 'base64') : generateDek();
    const secret = {
      ...bisher,
      dek: dek.toString('base64'),
      fruehereDeks: schluesselbundB64(bisher).filter(d => d !== dek.toString('base64')),
      wrappedDekCurrent: await wrapDek(dek, passwort),
    };
    // Zuerst in _settings: Selbst wenn die Ablage gerade klemmt, gilt ab jetzt
    // das neue Passwort; die Schlüsseldatei holt der nächste Abgleich nach.
    await schluesselUndPasswortSpeichern(secret, passwort);
    await sidecarSchreiben({
      settings,
      secret,
      passwort,
      lesePasswoerter: [settings.backup_encryption_passwort, passwort],
      storage,
      backupFolderId,
    });
  });
}

/** Aktiviert die Verschlüsselung (erstmalig oder nach vorherigem Abschalten). */
export async function aktiviere({ passwort, settings, storage, backupFolderId }) {
  await passwortSetzen({ passwort, settings, storage, backupFolderId });
  await upsertSetting('backup_encryption', { enabled: true, bewusst: true });
}

/** Ändert nur das Passwort; DEK und Schlüsselbund bleiben unverändert. */
export async function setzePasswort({ neuesPasswort, settings, storage, backupFolderId }) {
  if (!settings.backup_encryption_secret?.dek) throw new Error('Backup-Verschlüsselung ist noch nicht aktiv.');
  await passwortSetzen({ passwort: neuesPasswort, settings, storage, backupFolderId });
}

/** Schaltet künftige Backups auf unverschlüsselt zurück (oder lehnt sie initial bewusst ab). DEK/Passwort bleiben erhalten (für alte Dateien). */
export async function deaktiviere() {
  await upsertSetting('backup_encryption', { enabled: false, bewusst: true });
}

/** Nur für den admin-only Reveal-Endpoint — niemals Teil einer normalen Settings-Antwort. */
export function gespeichertesPasswort(settings) {
  return settings.backup_encryption_passwort ?? null;
}

/**
 * Bringt die Schlüsseldatei im Backup-Ordner des aktiven Backends auf den
 * Stand von Schlüsselbund und Passwort — nur wenn sie abweicht (Fingerabdruck
 * in secret.sidecarStand je Backend). Deckt ab: erweiterter Schlüsselbund
 * nach einer Wiederherstellung, Backend-Wechsel, zuvor gescheiterter Upload.
 * Liefert true, wenn geschrieben wurde.
 */
export async function sidecarAbgleichen(mitgegeben, storage, backupFolderId) {
  return exklusiv(async () => {
    const settings = await mitFrischemSchluessel(mitgegeben);
    let secret = settings.backup_encryption_secret;
    const passwort = settings.backup_encryption_passwort;
    if (!secret?.dek || !secret.wrappedDekCurrent || !passwort || !backupFolderId) return false;
    // Maßgeblich ist das gespeicherte Passwort (das die Oberfläche auch
    // anzeigt). Öffnet es die gespeicherte Umhüllung nicht, wird der DEK neu
    // damit umhüllt — sonst schriebe der Abgleich eine Schlüsseldatei, die
    // sich mit dem bekannten Passwort nicht öffnen lässt.
    const dek = Buffer.from(secret.dek, 'base64');
    if (!await wrappingPasstZumDek(secret.wrappedDekCurrent, passwort, dek)) {
      secret = { ...secret, wrappedDekCurrent: await wrapDek(dek, passwort) };
      await upsertSetting('backup_encryption_secret', secret);
      appLog('WARN', 'backup', 'Umhüllung des Backup-Schlüssels passte nicht zum gespeicherten Passwort und wurde neu erzeugt');
    }
    const backend = getActiveBackendName(settings);
    const soll = sidecarSollStand(schluesselbundB64(secret), secret.wrappedDekCurrent);
    if (secret.sidecarStand?.[backend] === soll) return false;
    await sidecarSchreiben({ settings, secret, passwort, lesePasswoerter: [passwort], storage, backupFolderId });
    return true;
  });
}

/**
 * Entschlüsselt eine heruntergeladene/hochgeladene Backup-Datei, falls sie
 * verschlüsselt ist. Reihenfolge: (1) Schlüsselbund aus _settings —
 * transparent, der Normalfall bei einer laufenden Instanz; (2) `passwort`
 * gegen den in der Datei eingebetteten Header (das zur Erstellung gültige
 * Passwort); (3) `passwort` gegen alle Einträge der Schlüsseldatei in der
 * Ablage (das AKTUELLE Passwort der Instanz, die sie geschrieben hat). Liefert
 * den Gzip-Buffer unverändert zurück, wenn die Datei gar nicht verschlüsselt
 * ist (Alt-Backup).
 *
 * Wirft PASSWORT_ERFORDERLICH, wenn kein bekannter DEK passt und kein
 * Passwort mitgeschickt wurde — der Aufrufer soll dann beim Client danach
 * fragen und denselben Restore mit Passwort erneut versuchen.
 */
export async function restoreEntschluesseln(buffer, { settings, passwort, storage, backupFolderId }) {
  if (!isEncryptedBackup(buffer)) return buffer;

  const { wrappedDek: fileWrappedDek, payload } = parseEncryptedFile(buffer);

  const lokal = mitDeksEntschluesseln(payload, lokaleDeks(settings));
  if (lokal) return lokal;

  if (!passwort) {
    const err = new Error('Diese Backup-Datei ist verschlüsselt und stammt nicht aus dem Schlüsselbund dieser Instanz. Backup-Passwort erforderlich.');
    err.code = 'PASSWORT_ERFORDERLICH';
    throw err;
  }

  try {
    const dek = await unwrapDek(fileWrappedDek, passwort);
    return decryptPayload(payload, dek);
  } catch (err) {
    if (!(err instanceof BackupPasswortFalschError)) throw err;
  }

  if (storage && backupFolderId) {
    try {
      const backend = getActiveBackendName(settings);
      const sidecar = await leseSidecar(storage, backupFolderId, settings.backup_encryption_secret?.sidecarIds?.[backend] ?? null);
      if (sidecar?.inhalt) {
        const { deks } = await sidecarOeffnen(sidecar.inhalt, passwort);
        const daten = mitDeksEntschluesseln(payload, deks);
        if (daten) return daten;
      }
    } catch {
      // Schlüsseldatei nicht lesbar — unten Fehler werfen.
    }
  }

  throw new BackupPasswortFalschError(
    'Backup-Passwort passt weder zu dieser Datei noch zur Schlüsseldatei im Backup-Ordner.',
  );
}

/**
 * Stand der Verschlüsselung, den eine Wiederherstellung NICHT zurückdrehen
 * darf (siehe lib/pg-restore.js, verschluesselungErhaltenSql): Schalter,
 * Passwort und Schlüsselbund gehören zur Instanz und zur Schlüsseldatei in der
 * Ablage, nicht zum eingespielten Datenstand.
 */
export function verschluesselungFuerRestore(settings) {
  return {
    status: settings.backup_encryption ?? null,
    secret: settings.backup_encryption_secret ?? null,
    passwort: settings.backup_encryption_passwort ?? null,
  };
}
