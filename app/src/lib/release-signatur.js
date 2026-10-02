/**
 * lib/release-signatur.js — Ed25519-Signatur über das Release-Manifest
 *
 * Bis 2.2.0 war `latest.json` nur über TLS + sha256 abgesichert. Beides kommt
 * aus derselben Quelle: wer ins Deploy-Repo pushen kann, tauscht Manifest UND
 * Tarball im selben Zug — die Prüfsumme passt dann anstandslos zum
 * manipulierten Archiv. Die sha256-Prüfung schützt gegen Transportfehler, nicht
 * gegen einen kompromittierten Publisher-Zugang.
 *
 * Die Signatur trennt genau diese beiden Rechte: „darf veröffentlichen" und
 * „darf ein Release autorisieren". Der private Schlüssel liegt offline, nicht
 * auf dem Publisher-Server.
 *
 * ── Warum eine selbstgebaute Bytefolge und kein kanonisches JSON ─────────────
 * Signiert wird NICHT die Datei und NICHT ein kanonisiertes JSON, sondern eine
 * kompakte, zeilenweise Bytefolge über die sicherheitskritischen Felder (siehe
 * `kanonischeBytes`). Gründe:
 *
 *  • `deploy-pages/install.sh` muss dieselbe Bytefolge bauen — in reinem bash,
 *    ohne `jq` als neue Abhängigkeit. Ein RFC-8785-Kanonisierer in bash wäre
 *    absurd; schon die Zahlen-Serialisierung ginge auseinander.
 *  • Die Datei selbst zu signieren hieße: jede Umformatierung (ein Leerzeichen,
 *    ein Zeilenende) bricht die Signatur.
 *  • TUF, minisign/signify und Sparkle umgehen JSON-Kanonisierung aus genau
 *    diesem Grund.
 *
 * Jedes Feld der Bytefolge ist vorher durch `validiereManifest()` gegen eine
 * Regex gelaufen (Semver, ISO-Datum, Hex, Ganzzahl). Es kann deshalb kein
 * Trennzeichen enthalten — Escaping ist nicht nötig und gäbe es nur als
 * zusätzliche Fehlerquelle.
 *
 * **Nicht abgedeckt: `changelog`.** Das ist reiner Anzeigetext, in bash nicht
 * verlässlich aus dem Manifest zu lösen, und er steuert nichts. Er läuft
 * ohnehin durch `textFeld()` (kein Markup, keine URLs, keine Steuerzeichen).
 * Wer ihn ändern kann, kann damit bestenfalls eine Update-Beschreibung
 * fälschen — nicht, was installiert wird. Bewusstes Restrisiko.
 *
 * ── Ein Vertrauensanker, drei Implementierungen ─────────────────────────────
 * `AKZEPTIERTE_SCHLUESSEL` steht zweimal: hier und als `RELEASE_SCHLUESSEL` in
 * `deploy-pages/install.sh`. Das ist kein Versehen. Beide können keine
 * Schlüsseldatei aus dem Repo nachladen, denn eine nachladbare Schlüsselquelle
 * wäre die Lücke, die die Signatur gerade schließen soll. Gegen das Auseinander-
 * laufen der beiden Kopien gibt es einen Gleichstand-Test:
 *
 *     node scripts/postbuch-signatur.mjs schluessel-pruefen
 *
 * `scripts/make-release-pages.sh` ruft ihn vor jedem Release auf.
 */

import { createPublicKey, verify as cryptoVerify } from 'node:crypto';

/**
 * Öffentliche Release-Schlüssel, Ed25519, 32 Byte roh, Base64.
 *
 * Format je Eintrag: `<id>:<base64>`; `id` ist `[a-z0-9-]{1,16}` und steht als
 * `signaturKeyId` im Manifest. Mehrere Einträge sind erlaubt und ausdrücklich
 * erwünscht: ein unbenutzter Ersatzschlüssel, der von Tag 1 an mit ausgeliefert
 * wird, ist der einzige schmerzfreie Weg aus einem Schlüsselverlust — sonst
 * müsste jede bereits vertrauende Instanz von Hand angefasst werden.
 *
 * Solange die Liste LEER ist, verhält sich alles wie in 2.2.0: es wird nicht
 * verifiziert, und es wird nie ein Vertrauensanker gesetzt.
 * Eintragen mit:  node scripts/postbuch-signatur.mjs pubkey-eintragen <id> <base64>
 */
export const AKZEPTIERTE_SCHLUESSEL = [
  // BEGIN-RELEASE-SCHLUESSEL
  'k1:2T0Jp573KEVZQ+lFetYJELFIjphKYvD8tZ7wOqjknqI=',
  'k2:rP7nktrzQf0gLLCAzwmzg1d9kN9GthpYaNcBi73sBP8=',
  // END-RELEASE-SCHLUESSEL
];

/** Präfix der Bytefolge. Ändert sich das Format, ändert sich dieser String. */
export const SIGNATUR_KONTEXT = 'postbuch-manifest-v1';

/**
 * Mögliche Ergebnisse von `pruefeSignatur`.
 *
 * `unkonfiguriert` ist KEIN Fehler: es heißt, diese Postbuch-Version kennt noch
 * gar keinen Release-Schlüssel. Nur `gueltig` darf einen Vertrauensanker setzen.
 */
export const SIGNATUR_STATUS = Object.freeze({
  GUELTIG: 'gueltig',
  UNGUELTIG: 'ungueltig',
  FEHLT: 'fehlt',
  UNBEKANNTER_SCHLUESSEL: 'unbekannter-schluessel',
  UNKONFIGURIERT: 'unkonfiguriert',
});

/** Ist überhaupt ein Release-Schlüssel bekannt? */
export function signaturKonfiguriert() {
  return AKZEPTIERTE_SCHLUESSEL.length > 0;
}

/** @returns {Map<string, string>} keyId → Base64-Pubkey */
export function schluesselTabelle() {
  const t = new Map();
  for (const eintrag of AKZEPTIERTE_SCHLUESSEL) {
    const m = /^([a-z0-9-]{1,16}):([A-Za-z0-9+/=]{43,44})$/.exec(String(eintrag).trim());
    if (!m) throw new Error(`Unbrauchbarer Eintrag in AKZEPTIERTE_SCHLUESSEL: ${eintrag}`);
    t.set(m[1], m[2]);
  }
  return t;
}

/**
 * Die signierten Bytes eines Manifests.
 *
 * Muss zeichengleich zu `signatur_kanonische_bytes()` in
 * `deploy-pages/install.sh` sein. Wer hier etwas ändert, ändert es dort mit —
 * sonst verifiziert genau eine der beiden Seiten nicht mehr.
 *
 * @param {object} m ein von `validiereManifest()` geprüftes Manifest
 * @returns {Buffer}
 */
export function kanonischeBytes(m) {
  const zeilen = [
    SIGNATUR_KONTEXT,
    String(m.schemaVersion),
    m.version,
    m.veroeffentlichtAm,
    m.sicherheitsrelevant === true ? 'ja' : 'nein',
    m.mindestVersion || '-',
    m.tarball.sha256,
    String(m.tarball.groesse),
    m.installer?.sha256 || '-',
  ];
  // Abschließendes \n gehört dazu — `printf '%s\n'` in bash erzeugt es ebenso.
  return Buffer.from(`${zeilen.join('\n')}\n`, 'utf8');
}

/** Base64-Pubkey (32 Byte roh) → KeyObject. Der JWK-Weg läuft ab Node 12. */
export function pubkeyAusBase64(b64) {
  const roh = Buffer.from(b64, 'base64');
  if (roh.length !== 32) throw new Error(`Ed25519-Pubkey muss 32 Byte haben, hat ${roh.length}.`);
  return createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: roh.toString('base64url') },
    format: 'jwk',
  });
}

/**
 * Verifiziert die Signatur eines Manifests gegen die akzeptierten Schlüssel.
 *
 * Wirft nie — ein kaputtes Manifest ist ein Prüfergebnis, keine Ausnahme.
 *
 * @param {object} manifest von `validiereManifest()` geprüft
 * @returns {{status:string, keyId:string|null}}
 */
export function pruefeSignatur(manifest) {
  if (!signaturKonfiguriert()) {
    return { status: SIGNATUR_STATUS.UNKONFIGURIERT, keyId: null };
  }
  if (!manifest?.signatur) {
    return { status: SIGNATUR_STATUS.FEHLT, keyId: null };
  }

  // Ein unbrauchbarer Eintrag in der Schlüsselliste ist ein Programmierfehler,
  // aber er darf den Update-Check nicht mit einer Ausnahme abreißen lassen —
  // sonst hinge die Instanz an einem Tippfehler im Release fest.
  let tabelle;
  try {
    tabelle = schluesselTabelle();
  } catch (err) {
    console.error('[release-signatur] Schlüsselliste unbrauchbar:', err.message);
    return { status: SIGNATUR_STATUS.UNGUELTIG, keyId: null };
  }
  const keyId = manifest.signaturKeyId || null;

  // Ohne keyId gegen alle bekannten Schlüssel prüfen. Das kostet bei zwei
  // Schlüsseln nichts und macht die Angabe im Manifest zu einer Bequemlichkeit
  // statt zu einer Bedingung — ein Feld, das der Angreifer ohnehin frei setzen
  // kann, darf nicht darüber entscheiden, ob geprüft wird.
  // Die Kennung ist nicht selbst signiert und damit nur ein Hinweis. Sie darf
  // eine korrekte Signatur nicht aussperren, wenn sie unterwegs falsch gesetzt
  // wurde. Genau wie der selbständige Installer prüfen wir daher immer alle
  // bekannten Schlüssel und geben bei Erfolg den tatsächlich passenden zurück.
  const kandidaten = [...tabelle.entries()];

  let sig;
  try {
    sig = Buffer.from(manifest.signatur, 'base64');
  } catch {
    return { status: SIGNATUR_STATUS.UNGUELTIG, keyId };
  }
  if (sig.length !== 64) return { status: SIGNATUR_STATUS.UNGUELTIG, keyId };

  const bytes = kanonischeBytes(manifest);
  for (const [id, b64] of kandidaten) {
    try {
      // Bei Ed25519 ist der Algorithmus-Parameter zwingend null: EdDSA hasht
      // die Nachricht selbst, ein separater Digest ist nicht vorgesehen.
      if (cryptoVerify(null, bytes, pubkeyAusBase64(b64), sig)) {
        return { status: SIGNATUR_STATUS.GUELTIG, keyId: id };
      }
    } catch {
      // Unbrauchbarer Schlüssel in der Liste — nächster Kandidat.
    }
  }
  return {
    status: keyId && !tabelle.has(keyId)
      ? SIGNATUR_STATUS.UNBEKANNTER_SCHLUESSEL
      : SIGNATUR_STATUS.UNGUELTIG,
    keyId,
  };
}

/** Kurzer, für Admins lesbarer Text zu einem Status. */
export function signaturText(status) {
  switch (status) {
    case SIGNATUR_STATUS.GUELTIG:                return 'Signatur gültig';
    case SIGNATUR_STATUS.UNGUELTIG:              return 'Signatur ungültig';
    case SIGNATUR_STATUS.FEHLT:                  return 'Keine Signatur im Manifest';
    case SIGNATUR_STATUS.UNBEKANNTER_SCHLUESSEL: return 'Mit einem unbekannten Schlüssel signiert';
    case SIGNATUR_STATUS.UNKONFIGURIERT:         return 'Signaturprüfung nicht eingerichtet';
    default:                                     return 'Signaturzustand unbekannt';
  }
}
