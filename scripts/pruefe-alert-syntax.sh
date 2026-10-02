#!/usr/bin/env bash
# Prüft GitHub-Alerts in Markdown-Dateien auf die formatterfeste Schreibweise:
#
#   > [!WARNING]
#   >
#   > Text …
#
# Zwei Fehlerbilder werden gemeldet:
#   1. Text steht auf der Markerzeile — GitHub rendert dann keinen Alert,
#      sondern ein gewöhnliches Zitat.
#   2. Auf die Markerzeile folgt direkt Text statt einer leeren Zitatzeile —
#      diese Form ist gültig, aber Markdown-Formatter (Prettier) ziehen den
#      Folgetext beim nächsten Speichern auf die Markerzeile hoch und
#      erzeugen damit Fehlerbild 1.
#
# Aufruf: pruefe-alert-syntax.sh <verzeichnis> [anzeige-praefix]
set -euo pipefail

ZIEL="${1:-}"
PRAEFIX="${2:-$ZIEL/}"
[[ -d "$ZIEL" ]] || { echo "FEHLER: Verzeichnis für Alert-Prüfung fehlt: $ZIEL" >&2; exit 2; }

befunde=$(find "$ZIEL" -type f -name '*.md' -print0 | xargs -0 -r awk '
  FNR == 1 {
    if (marker) printf "%s:%d: leere Zitatzeile \">\" unter dem Alert-Marker fehlt\n", vordatei, vorzeile
    marker = 0
  }
  {
    if (marker && $0 !~ /^[ \t]*>[ \t]*$/)
      printf "%s:%d: leere Zitatzeile \">\" unter dem Alert-Marker fehlt\n", vordatei, vorzeile
    marker = 0
    if (match($0, /^[ \t]*> \[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/)) {
      rest = substr($0, RSTART + RLENGTH)
      if (rest ~ /[^ \t]/)
        printf "%s:%d: Text steht auf der Marker-Zeile — GitHub erkennt den Alert nicht\n", FILENAME, FNR
      else {
        marker = 1; vordatei = FILENAME; vorzeile = FNR
      }
    }
  }
  END {
    if (marker) printf "%s:%d: leere Zitatzeile \">\" unter dem Alert-Marker fehlt\n", vordatei, vorzeile
  }
')

if [[ -n "$befunde" ]]; then
  echo "FEHLER: Ungültige GitHub-Alert-Syntax:" >&2
  printf '%s\n' "$befunde" | sed "s|^$PRAEFIX||" >&2
  exit 1
fi
