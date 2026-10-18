#!/usr/bin/env bash
# Auth-Matrix gegen die laufende App: kopiert app/test/auth-matrix.test.js in
# den app-Container und prüft dort ohne Sitzung gegen http://localhost:3421.
# Ohne laufende App läuft nur der statische Teil:
#   docker run --rm --entrypoint node -v "$PWD/app:/t:ro" -w /t <app-image> --test test/auth-matrix.test.js
#
# Aufruf aus dem Repo-Wurzelverzeichnis: scripts/pruefe-auth-matrix.sh
set -euo pipefail

cd "$(dirname "$0")/.."
docker compose exec -T app mkdir -p /app/test
docker compose cp app/test/auth-matrix.test.js app:/app/test/auth-matrix.test.js
docker compose exec -T -e AUTH_MATRIX_BASE_URL=http://localhost:3421 app \
  node --test /app/test/auth-matrix.test.js
