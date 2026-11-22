#!/bin/bash
# pruefe-installer-vertrag.sh – prüft statisch, ob der Installer im Arbeitsbaum
# alles versteht, was ein älteres Release beim Update an ihn heranträgt.
#
# Aufruf: scripts/pruefe-installer-vertrag.sh [<vorgaenger-tag>]
#   Ohne Tag: der höchste Tag v<x.y.z>, der kleiner als VERSION ist.
#
# Geprüft wird gegen die Regeln „Feste Schnittstellen zwischen Releases“ in
# internaldocs/agentic-core/AUSLIEFERUNG-RELEASE.md:
#   1. Jede Option, die Agent, Übergabe oder install.ps1 des Vorgängers an
#      install.sh übergibt, steht in parse_args des neuen Installers.
#   2. deploy-pages/install.sh und scripts/postbuch-update-agent.sh landen im
#      Tarball (kein export-ignore).
#   3. Agent und Installer benutzen dieselbe Sperrdatei state/agent.lock.
#   4. Jede Umgebungsvariable, die die Übergabe des Vorgängers setzt, liest der
#      neue Installer.
#   5. Phasen (##PHASE:) des neuen Installers kennt die Oberfläche des
#      Vorgängers (nur Warnung: Unbekannte zeigt sie als „Update läuft …“).
# Exit 0 = eingehalten, 1 = Vertragsbruch, 2 = Aufruffehler.
set -euo pipefail
cd "$(dirname "$0")/.."

INST=${PRUEFE_INSTALLER:-deploy-pages/install.sh}   # überschreibbar nur für die Negativprobe
AGENT=scripts/postbuch-update-agent.sh
version=$(tr -d '[:space:]' < VERSION)

vor="${1:-}"
if [[ -z "$vor" ]]; then
    vor=$(git tag -l 'v[0-9]*.[0-9]*.[0-9]*' | sed 's/^v//' \
        | { cat; echo "$version"; } | sort -V -u \
        | awk -v v="$version" '$0 == v { print vorher; exit } { vorher = $0 }')
    [[ -n "$vor" ]] || { echo "Kein Vorgänger-Tag unter $version gefunden." >&2; exit 2; }
    vor="v$vor"
fi
git rev-parse -q --verify "refs/tags/$vor" >/dev/null || { echo "Tag $vor fehlt." >&2; exit 2; }

fehler=0
bruch() { echo "  VERTRAGSBRUCH: $*"; fehler=1; }
hinweis() { echo "  Hinweis: $*"; }
alt() { git show "$vor:$1" 2>/dev/null || true; }

echo "Installer-Vertrag: $vor → Arbeitsbaum ($version)"

# 1. Optionen. Geprüft werden nur Installer-Optionen: was in parse_args des
#    Vorgängers stand, plus die Pflichtliste, die jeder Agent seit 2.10 aufruft.
parse_opts() { sed -n '/^parse_args() {/,/^}/p' | grep -oE '^\s*--[a-z0-9-]+' | tr -d ' ' | sort -u; }
optionen=$(parse_opts < "$INST")
installer_opts=$( { alt "$INST" | parse_opts; printf '%s\n' --update --yes --non-interactive \
    --erwarte-sha256 --zielversion --install-dir --dry-run --postgres-image --postgres-umzug; } | sort -u)
aufrufe=$(
    alt "$AGENT" | grep -E 'install\.sh"? --|INSTALLER"? |ARGS\+?=\(' || true
    alt "$INST" | sed -n '/^an_neuen_installer_uebergeben() {/,/^}/p'
    alt deploy-pages/install.ps1 | grep -E 'install\.sh' || true
)
genutzt=$( { grep -oE -- '--[a-z][a-z0-9-]+' <<< "$aufrufe" || true; printf '%s\n' --update --yes \
    --non-interactive --erwarte-sha256 --zielversion --install-dir --dry-run --postgres-image \
    --postgres-umzug; } | sort -u | grep -Fx -f <(printf '%s\n' "$installer_opts") || true)
while IFS= read -r opt; do
    [[ -z "$opt" ]] && continue
    grep -qx -- "$opt" <<< "$optionen" || bruch "Option $opt (vom Vorgänger benutzt) fehlt in parse_args."
done <<< "$genutzt"
echo "  Optionen geprüft: $(tr '\n' ' ' <<< "$genutzt")"

# 2. Tarball-Inhalt
for f in "$INST" "$AGENT"; do
    [[ -f "$f" ]] || bruch "$f fehlt."
    if git check-attr export-ignore -- "$f" | grep -q ': set$'; then
        bruch "$f ist export-ignore und fehlt damit im Tarball."
    fi
done

# 3. Sperrdatei
grep -q 'agent\.lock' "$AGENT" || bruch "Agent benutzt state/agent.lock nicht mehr."
grep -q 'state/agent\.lock' "$INST" || bruch "Installer nimmt die Sperre state/agent.lock nicht."
alt "$AGENT" | grep -q 'agent\.lock' && ! grep -q 'flock' "$AGENT" && bruch "Agent sperrt nicht mehr mit flock."

# 4. Umgebung der Übergabe
for var in $(alt "$INST" | sed -n '/^an_neuen_installer_uebergeben() {/,/^}/p' \
        | grep -oE 'export [A-Z_ =]+' | grep -oE 'POSTBUCH_[A-Z_]+' | sort -u); do
    grep -q "\${$var\|\$$var" "$INST" || bruch "Übergabe des Vorgängers setzt $var, der neue Installer liest es nicht."
done

# 5. Phasen
bekannt=$(alt web/src/hooks/useUpdateStatus.js | sed -n '/^const PHASEN = {/,/^};/p' | grep -oE '^\s*[a-z]+:' | tr -d ' :')
for p in $(grep -oE '(^|[;&|{(]|\s)phase [a-z]+' "$INST" | awk '{print $NF}' | sort -u); do
    grep -qx "$p" <<< "$bekannt" || hinweis "Phase „$p“ kennt die Oberfläche von $vor nicht (zeigt „Update läuft …“)."
done

if [[ "$fehler" -eq 0 ]]; then
    echo "  eingehalten"
fi
exit "$fehler"
