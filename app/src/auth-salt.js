import {
  pbkdf2Sync,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'crypto';

// Nur zur Verifikation alter, deterministischer PBKDF2-Hashes. Neue Hashes
// verwenden pro Passwort einen kryptographisch zufälligen Salt.
export const APP_PEPPER = 'f7a3b2c1-d5e4-4b8a-9f0c-3e1d2c4b5a6f';

const SCRYPT_N = 32_768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_LENGTH = 64;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const SCRYPT_PREFIX = `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$`;

function scryptDigest(password, salt) {
  return scryptSync(String(password), salt, SCRYPT_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
}

/**
 * Selbstbeschreibender Scrypt-Hash mit zufälligem 128-Bit-Salt.
 * `username` bleibt aus Kompatibilitätsgründen Teil der Signatur der Funktion.
 */
export function hashPassword(_username, password) {
  const salt = randomBytes(16);
  const digest = scryptDigest(password, salt);
  return `${SCRYPT_PREFIX}${salt.toString('base64')}$${digest.toString('base64')}`;
}

function verifyScrypt(password, storedHash) {
  const parts = storedHash.split('$');
  if (
    parts.length !== 6
    || parts[0] !== 'scrypt'
    || parts[1] !== String(SCRYPT_N)
    || parts[2] !== String(SCRYPT_R)
    || parts[3] !== String(SCRYPT_P)
  ) return false;

  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  if (salt.length !== 16 || expected.length !== SCRYPT_LENGTH) return false;
  return timingSafeEqual(scryptDigest(password, salt), expected);
}

function verifyLegacyPbkdf2(username, password, storedHash) {
  if (!/^[0-9a-f]{128}$/i.test(storedHash)) return false;
  const salt = `${APP_PEPPER}:${username}`;
  const candidate = pbkdf2Sync(String(password), salt, 100_000, 64, 'sha512');
  return timingSafeEqual(candidate, Buffer.from(storedHash, 'hex'));
}

/** Verifiziert aktuelle Scrypt- und bestehende PBKDF2-Hashes in konstanter Zeit. */
export function verifyPassword(username, password, storedHash) {
  if (typeof storedHash !== 'string') return false;
  try {
    if (storedHash.startsWith('scrypt$')) return verifyScrypt(password, storedHash);
    return verifyLegacyPbkdf2(username, password, storedHash);
  } catch {
    return false;
  }
}

/** Alte oder künftig veraltete Formate werden nach erfolgreichem Login erneuert. */
export function needsPasswordRehash(storedHash) {
  return typeof storedHash !== 'string' || !storedHash.startsWith(SCRYPT_PREFIX);
}
