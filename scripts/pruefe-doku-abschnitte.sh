#!/usr/bin/env bash
# Prüft die Obergrenze für Hilfekorpus-Stücke der Nutzerdoku (docs/*.md).
#
# Der Hilfekorpus zerlegt jedes Kapitel an den Überschriften (# bis ####) und
# lange Abschnitte zusätzlich an Absätzen in Stücke bis 3600 Zeichen; jedes
# Stück wird samt Kapitelkopf eingebettet. Lokale Embedding-Server verarbeiten
# einen Text nur am Stück bis zu ihrer Batchgröße, oft 1024 Token. Dichter
# Text (Tabellen) braucht im Deutschen nur etwa 3,3 Zeichen je Token. Deshalb
# darf kein Stück mehr als MAX_ZEICHEN Zeichen haben (≈ 1000 Token, Puffer für
# die Modell-Vorsilbe). Abhilfe ist eine Zwischenüberschrift im betroffenen
# Abschnitt. Regel: internaldocs/agentic-core/FRONTEND-BUILD-DOKU.md,
# „Obergrenze für Doku-Abschnitte“.
#
# Gemessen wird mit dem echten Zerleger (app/src/service/help-corpus.js) im
# App-Image; es wird nichts gebaut und nichts eingebettet.
#
# Aufruf: pruefe-doku-abschnitte.sh [docs-verzeichnis]
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
ZIEL="$(cd "${1:-$REPO/docs}" && pwd)"
MAX_ZEICHEN=3300
IMAGE="${POSTBUCH_APP_IMAGE:-postbuch-unified-app}"

docker image inspect "$IMAGE" >/dev/null 2>&1 \
  || { echo "FEHLER: App-Image $IMAGE fehlt (erst docker compose build app)" >&2; exit 2; }

docker run --rm --network none \
  -v "$REPO/app/src:/app/src:ro" -v "$ZIEL:/docs:ro" \
  -e MAX_ZEICHEN="$MAX_ZEICHEN" --entrypoint node "$IMAGE" --input-type=module -e '
    const { loadHelpSource } = await import("/app/src/service/help-corpus.js");
    const grenze = Number(process.env.MAX_ZEICHEN);
    const { chunks } = await loadHelpSource({ docsDir: "/docs", fresh: true });
    const zuLang = chunks.filter((c) => c.embeddingText.length > grenze);
    if (zuLang.length) {
      console.log(`Hilfe-Stücke über ${grenze} Zeichen (Zwischenüberschrift einziehen):`);
      for (const c of zuLang) console.log(`  docs/${c.kapitel}.md – ${c.ueberschrift}: ${c.embeddingText.length} Zeichen`);
      process.exit(1);
    }
    console.log(`Hilfe-Stücke: alle ${chunks.length} höchstens ${grenze} Zeichen.`);
    process.exit(0);
  '
