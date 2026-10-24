#!/usr/bin/env bash
# Prüft, dass Frontend-Tabellen die Mobilansicht mitdenken.
#
# Listen mit Datensätzen laufen über DataView (web/src/components/listen/DataView.jsx):
# Desktop als Tabelle, mobil als Karten aus denselben Spaltendefinitionen. Wer
# daneben eine eigene <Table>/<table> rendert, muss mobil einen Kartenzweig
# haben (KartenListe/DataView bzw. istMobil-Weiche) oder steht unten mit
# Begründung auf der Positivliste.
#
# Aufruf: pruefe-rohe-tabellen.sh [web/src-verzeichnis] [anzeige-praefix]
set -euo pipefail

ZIEL="${1:-$(dirname "$0")/../web/src}"
PRAEFIX="${2:-web/src/}"
[[ -d "$ZIEL" ]] || { echo "FEHLER: Verzeichnis für Tabellen-Prüfung fehlt: $ZIEL" >&2; exit 2; }

# Pfad relativ zu web/src → Begründung
declare -A ERLAUBT=(
  [components/ui/table.jsx]='Baustein der Desktop-Tabelle'
  [components/listen/DataView.jsx]='Baustein: Tabelle desktop, Karten mobil'
  [components/detail/NoteSection.jsx]='Markdown-Tabellen in Notizen, horizontal scrollbar'
  [pages/HilfePage.jsx]='Markdown-Tabellen der Hilfe, horizontal scrollbar'
  [pages/AssistantPage.jsx]='Markdown-Tabellen in Chat-Antworten, horizontal scrollbar'
  [components/detail/PostbuchSection.jsx]='kleine Detailtabellen (Warnungen, KI-Modelle), horizontal scrollbar'
  [components/logs/TokenLogView.jsx]='Admin-Protokoll, horizontal scrollbar'
  [pages/LogsPage.jsx]='Admin-Protokoll, horizontal scrollbar'
  [pages/OriginaleListPage.jsx]='vier schmale Spalten mit Inline-Bearbeitung, auf Handybreite geprüft'
)

fehler=0
while IFS= read -r -d '' datei; do
  rel="${datei#"$ZIEL"/}"
  grep -qE '<(Table|table)([[:space:]>]|$)' "$datei" || continue
  [[ -n "${ERLAUBT[$rel]+x}" ]] && continue
  grep -qE 'KartenListe|<DataView|istMobil' "$datei" && continue
  echo "${PRAEFIX}${rel}: Tabelle ohne Mobilzweig – DataView/KartenListe nutzen oder begründet in scripts/pruefe-rohe-tabellen.sh aufnehmen" >&2
  fehler=1
done < <(find "$ZIEL" -type f -name '*.jsx' -print0)

exit "$fehler"
