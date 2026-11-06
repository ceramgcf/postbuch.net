/**
 * lib/totp.js — zeitbasierte Einmalcodes nach RFC 6238 (TOTP)
 *
 * Bewusst ohne Bibliothek: HMAC-SHA1, 6 Ziffern, 30-Sekunden-Schritte. Das
 * sind die Parameter, die jede Authenticator-App ohne weitere Angaben
 * erwartet. Speicherung, Verschlüsselung und Replay-Schutz liegen in
 * service/zweiter-faktor.js; hier steht nur die reine Rechnung.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const SCHRITT_SEKUNDEN = 30;
const STELLEN = 6;
// Ein Schritt Toleranz in beide Richtungen fängt Uhrabweichung und das
// Abtippen kurz vor dem Wechsel ab.
const TOLERANZ = 1;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Kodieren(buffer) {
  let bits = 0;
  let wert = 0;
  let out = '';
  for (const byte of buffer) {
    wert = (wert << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(wert >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(wert << (5 - bits)) & 31];
  return out;
}

export function base32Dekodieren(text) {
  const sauber = String(text).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let wert = 0;
  const out = [];
  for (const zeichen of sauber) {
    const i = BASE32.indexOf(zeichen);
    if (i < 0) throw new Error('Ungültiges Base32-Zeichen');
    wert = (wert << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((wert >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Neues Geheimnis: 160 bit, wie von RFC 4226 empfohlen. */
export function neuesGeheimnis() {
  return base32Kodieren(randomBytes(20));
}

export function aktuellerSchritt(jetztMs = Date.now()) {
  return Math.floor(jetztMs / 1000 / SCHRITT_SEKUNDEN);
}

/** Code für einen bestimmten Zeitschritt (RFC 4226, dynamische Kürzung). */
export function codeFuerSchritt(geheimnisBase32, schritt) {
  const zaehler = Buffer.alloc(8);
  zaehler.writeBigUInt64BE(BigInt(schritt));
  const hmac = createHmac('sha1', base32Dekodieren(geheimnisBase32)).update(zaehler).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const zahl = ((hmac[offset] & 0x7f) << 24)
    | (hmac[offset + 1] << 16)
    | (hmac[offset + 2] << 8)
    | hmac[offset + 3];
  return String(zahl % 10 ** STELLEN).padStart(STELLEN, '0');
}

/**
 * Prüft einen Code im Toleranzfenster. Liefert den getroffenen Zeitschritt
 * oder null. Ein Schritt, der nicht größer als `letzterSchritt` ist, zählt
 * nicht: Jeder Code gilt nur einmal.
 */
export function pruefeCode(geheimnisBase32, code, letzterSchritt = null, jetztMs = Date.now()) {
  const eingabe = String(code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(eingabe)) return null;
  const jetzt = aktuellerSchritt(jetztMs);
  let treffer = null;
  // Alle Kandidaten durchrechnen, damit die Laufzeit nicht verrät, welcher traf.
  for (let d = -TOLERANZ; d <= TOLERANZ; d++) {
    const schritt = jetzt + d;
    const passt = timingSafeEqual(Buffer.from(codeFuerSchritt(geheimnisBase32, schritt)), Buffer.from(eingabe));
    if (passt && treffer === null && (letzterSchritt == null || schritt > Number(letzterSchritt))) {
      treffer = schritt;
    }
  }
  return treffer;
}

/** otpauth-URI für den QR-Code der Authenticator-App. */
export function otpauthUri({ geheimnis, konto, aussteller }) {
  const label = encodeURIComponent(`${aussteller}:${konto}`);
  const params = new URLSearchParams({
    secret: geheimnis,
    issuer: aussteller,
    algorithm: 'SHA1',
    digits: String(STELLEN),
    period: String(SCHRITT_SEKUNDEN),
  });
  return `otpauth://totp/${label}?${params}`;
}
