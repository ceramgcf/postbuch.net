#!/usr/bin/env bash
# Isolierter Harness für das Signatur-Tor des Installers (manifest_gate).
#
# Geprüft wird eine einzige Eigenschaft: Lässt das Tor ein Manifest durch, dann
# stammen Tarball-Prüfsumme und Version aus genau den Bytes, die die Signatur
# deckt. Ein Manifest, das zwei Lesarten anbietet (zweites "tarball"-Objekt,
# vorangestellte "version"), darf nie zu einer unsignierten Prüfsumme führen.
#
# Der Harness führt weder den Installer noch Docker, sudo oder Netzzugriffe
# aus. Er löst die Manifest- und Signaturfunktionen aus install.sh heraus,
# ersetzt den Abruf durch eine lokale Datei und signiert mit einem
# Wegwerfschlüssel. Er braucht OpenSSL ab 3.0; ohne endet er mit Code 77.
#
# Aufruf: scripts/test-install-manifest.sh [pfad/zu/install.sh]
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
INSTALLER="${1:-$ROOT/deploy-pages/install.sh}"
[[ -r "$INSTALLER" ]] || { echo "install.sh nicht lesbar: $INSTALLER" >&2; exit 2; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
FUNCS="$TMP/functions.sh"

awk '/^MANIFEST_ROH=""/,/^# Der Prueflauf der interaktiven Pfade/' "$INSTALLER" | sed '$d' > "$FUNCS"
grep -q '^manifest_gate() {' "$FUNCS" && grep -q '^pruefe_release_signatur() {' "$FUNCS" \
    || { echo "Funktionsblock in install.sh nicht gefunden." >&2; exit 2; }

# ── Wegwerfschlüssel ─────────────────────────────────────────────────────────
KEY="$TMP/key.pem"
if ! openssl genpkey -algorithm ed25519 -out "$KEY" 2>/dev/null \
   || ! printf 'x' > "$TMP/probe" \
   || ! openssl pkeyutl -sign -rawin -inkey "$KEY" -in "$TMP/probe" -out "$TMP/probe.sig" 2>/dev/null; then
    echo "OpenSSL kann hier kein Ed25519 (-rawin) – Test übersprungen." >&2
    exit 77
fi
PUB=$(openssl pkey -in "$KEY" -pubout -outform DER | tail -c 32 | base64 | tr -d '\n')

GUT=$(printf 'a%.0s' {1..64})
BOESE=$(printf 'e%.0s' {1..64})
INST=$(printf 'c%.0s' {1..64})
V=2.50.3
GROESSE=1234567

# Die signierten Bytes baut der Harness unabhängig vom Installer.
printf '%s\n' postbuch-manifest-v1 1 "$V" 2026-01-02 nein - "$GUT" "$GROESSE" "$INST" > "$TMP/bytes"
openssl pkeyutl -sign -rawin -inkey "$KEY" -in "$TMP/bytes" -out "$TMP/sig"
SIG=$(base64 < "$TMP/sig" | tr -d '\n')

KOPF='"schemaVersion": 1, "version": "'$V'", "veroeffentlichtAm": "2026-01-02", "sicherheitsrelevant": false, "mindestVersion": null'
RUMPF='"installer": { "sha256": "'$INST'" }, "changelog": ["Ein Punkt"], "verlauf": [{ "version": "'$V'", "datum": "2026-01-02", "changelog": [] }, { "version": "2.50.2", "datum": "2026-01-01", "changelog": [] }], "signatur": "'$SIG'", "signaturKeyId": "t1"'

manifest() { printf '{ %s }\n' "$1" > "$TMP/$2.json"; }
manifest "$KOPF, \"tarball\": { \"sha256\": \"$GUT\", \"groesse\": $GROESSE }, $RUMPF" echt
manifest "$KOPF, \"tarball\": { \"groesse\": $GROESSE, \"sha256\": \"$GUT\" }, $RUMPF" umgestellt
manifest "$KOPF, \"tarball\": { \"groesse\": $GROESSE, \"sha256\": \"$GUT\" }, $RUMPF, \"zusatz\": { \"tarball\": { \"sha256\": \"$BOESE\" } }" zweite-lesart
manifest "\"zusatz\": { \"tarball\": { \"sha256\": \"$BOESE\", \"groesse\": $GROESSE } }, $KOPF, \"tarball\": { \"sha256\": \"$GUT\", \"groesse\": $GROESSE }, $RUMPF" boese-zuerst
manifest "$KOPF, \"tarball\": { \"sha256\": \"$BOESE\", \"groesse\": $GROESSE }, $RUMPF" verfaelscht
manifest "\"verlauf0\": [{ \"version\": \"9.9.9\" }], $KOPF, \"tarball\": { \"sha256\": \"$GUT\", \"groesse\": $GROESSE }, $RUMPF" version-vorangestellt
manifest "$KOPF, \"tarball\": { \"sha256\": \"$GUT\", \"groesse\": $GROESSE }, \"installer\": { \"sha256\": \"$INST\" }" ohne-signatur

FEHLER=0
# $1 Name  $2 Manifest  $3 erwartet (durch|abbruch)  $4 installierte Version  $5… Zuweisungen (OPT_…=…)
fall() {
    local name="$1" datei="$TMP/$2.json" erwartet="$3" installiert="$4" ergebnis
    shift 4
    ergebnis=$(
        set -euo pipefail
        INSTALL_DIR="$TMP/inst-$name"; DEFAULT_INSTALL_DIR="$INSTALL_DIR"
        mkdir -p "$INSTALL_DIR"
        [[ -n "$installiert" ]] && printf '%s\n' "$installiert" > "$INSTALL_DIR/VERSION"
        OPT_ZIELVERSION=""; OPT_SHA256=""; OPT_OHNE_SIGNATUR=false; OPT_ERLAUBE_RUECKSCHRITT=false
        MANIFEST_URL="lokal"; RELEASE_URL=""; QUELLE_GITHUB=false; BASE_URL="lokal"
        # shellcheck disable=SC1090
        source "$FUNCS"
        RELEASE_SCHLUESSEL="t1:$PUB"
        feed_curl() { cat "$datei"; }
        verifier_docker() { return 2; }
        for zuweisung in "$@"; do declare "$zuweisung"; done
        if manifest_gate >/dev/null 2>&1; then
            printf 'durch %s %s\n' "$ERWARTETE_SHA" "$(hole_manifest_version || true)"
        else
            printf 'abbruch\n'
        fi
    )
    case "$erwartet:$ergebnis" in
        "durch:durch $GUT $V"|"abbruch:abbruch") printf 'ok      %s\n' "$name" ;;
        *) printf 'FEHLER  %s: erwartet %s, Ergebnis: %s\n' "$name" "$erwartet" "$ergebnis"; FEHLER=1 ;;
    esac
}

fall echt                    echt                  durch   ""
fall umgestellt              umgestellt            durch   ""
fall zweite-lesart           zweite-lesart         durch   ""
fall boese-zuerst            boese-zuerst          abbruch ""
fall verfaelscht             verfaelscht           abbruch ""
fall version-vorangestellt   version-vorangestellt abbruch ""
fall ohne-signatur           ohne-signatur         abbruch ""
fall agent-passend           echt                  durch   "2.50.2" "OPT_SHA256=$GUT" "OPT_ZIELVERSION=$V"
fall agent-fremde-summe      zweite-lesart         abbruch "2.50.2" "OPT_SHA256=$BOESE" "OPT_ZIELVERSION=$V"
fall agent-andere-version    echt                  abbruch "2.50.2" "OPT_SHA256=$GUT" "OPT_ZIELVERSION=2.50.4"
fall rueckschritt            echt                  abbruch "2.51.0"
fall rueckschritt-erlaubt    echt                  durch   "2.51.0" "OPT_ERLAUBE_RUECKSCHRITT=true"

if (( FEHLER )); then
    echo "Signatur-Tor: mindestens ein Fall rot." >&2
    exit 1
fi
echo "Signatur-Tor: alle Fälle grün."
