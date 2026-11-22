#!/usr/bin/env bash
# Sperrliste für Projektinterna in öffentlichen Texten: YouTube-Titel und
# -Beschreibungen, Community-Posts, Release-Notes, Doku und der öffentliche
# Quellbaum. Test- und Entwicklungsinfrastruktur (autarkes Testsystem, ATsys,
# PTsys, Testhosts, Echttestdaten-Sperre) wird nach außen nie erwähnt –
# auch nicht als Herkunftsangabe einer Aufnahme („auf dem … aufgenommen“).
#
# Aufruf:
#   pruefe-interna.sh <datei|verzeichnis> …   Dateien bzw. Bäume prüfen
#   pruefe-interna.sh -                         Text von stdin prüfen
# Exit 0 = sauber, 1 = Treffer (Datei:Zeile wird gemeldet), 2 = Aufruffehler.
#
# Die Sperrliste gilt auch für ~/.config/postbuch.net-youtube/yt.py, das vor
# jedem schreibenden API-Aufruf (Upload, Metadaten-Update) dieses Skript
# aufruft. Neue interne Bezeichnungen hier nachtragen, nicht dort.
set -euo pipefail

INTERNA_RE='autark|ATsys|PTsys|Test-?system|Test-?server|Power-Test|Echttestdaten|postbuchtest'

[[ $# -gt 0 ]] || { echo "Aufruf: $0 <datei|verzeichnis>… | -" >&2; exit 2; }

set +e
if [[ "$1" == "-" ]]; then
  treffer=$(grep -n -i -E -- "$INTERNA_RE")
else
  treffer=$(grep -R -n -i -I -E --exclude="$(basename "$0")" -- "$INTERNA_RE" "$@")
fi
status=$?
set -e

case $status in
  0) echo "FEHLER: Projektinterna in öffentlichem Text:" >&2
     printf '%s\n' "$treffer" >&2
     exit 1 ;;
  1) exit 0 ;;
  *) echo "FEHLER: Interna-Prüfung konnte nicht lesen." >&2; exit 2 ;;
esac
