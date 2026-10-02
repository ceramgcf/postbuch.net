#!/bin/sh
set -e

# ══════════════════════════════════════════════════════
# 1. Build DATABASE_URL from POSTGRES_* variables
# ══════════════════════════════════════════════════════
POSTGRES_HOST=${POSTGRES_HOST:-postgres}
POSTGRES_PORT=${POSTGRES_PORT:-5432}
POSTGRES_USER=${POSTGRES_USER:-postbuch}
POSTGRES_DB=${POSTGRES_DB:-postbuch}

if [ -z "${DATABASE_URL}" ]; then
  if [ -n "${POSTGRES_PASSWORD}" ]; then
    # postbuch.net ist ausschließlich für den Einsatz in Deutschland gedacht.
    # TimeZone hier statt per Folge-Query setzen (Startup-Parameter, race-frei;
    # siehe app/src/db.js) – unabhängig vom initdb-Zeitpunkt-Default der DB, der
    # bei bestehenden Installationen weiterhin UTC sein kann und CURRENT_DATE/
    # now() rund um Mitternacht CEST/UTC einen Tag danebenliegen ließe.
    export DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}?options=-c%20search_path%3Dpostbuch,public%20-c%20TimeZone%3DEurope/Berlin"
  fi
fi

# Normalize OpenAI env var name if necessary
if [ -z "${OPENAI_API_KEY}" ] && [ -n "${OPEN_AI_API_KEY}" ]; then
  export OPENAI_API_KEY="${OPEN_AI_API_KEY}"
fi

# ══════════════════════════════════════════════════════
# 2. Schema-Auslieferung: Legacy-Kette + idempotentes Vollschema
# ══════════════════════════════════════════════════════
#
# Zwei Sorten Skript, klar getrennt:
#
#   /app/schema/legacy-bis-<version>.sql   Eingefrorene Historie. Bringt eine
#       Datenbank, die vor <version> stehen geblieben ist, auf genau diesen
#       Stand. Wird je Datenbank höchstens EINMAL ausgeführt und danach nie
#       wieder angefasst — auch die Datei selbst nicht mehr.
#
#   /app/base_schema.sql                   Das Vollschema von heute. Reine
#       Zustandsbeschreibung, additiv-idempotent, läuft bei jedem Start.
#
# Reihenfolge: Verwaltungstabelle → offene Legacy-Skripte in Versionsreihenfolge
# → Vollschema. Eine Datenbank ohne postbuch.postbuch ist eine Erstinstallation;
# dort erzeugt das Vollschema den Zielzustand direkt, und die Legacy-Kette wird
# als 'uebersprungen' verbucht statt ausgeführt (Rails-Modell: `db:schema:load`
# für neu, `db:migrate` für bestehend).
#
# Es gibt bewusst KEIN Support-Fenster: alte Legacy-Skripte bleiben für immer
# ausgeliefert. Sie sind eingefroren, laufen je Instanz höchstens einmal und
# kosten sonst nichts.
SCHEMA_DIR=/app/schema
APP_VERSION=$(tr -d '[:space:]' < /app/VERSION 2>/dev/null || echo '')

pb_psql() {
  PGPASSWORD="${POSTGRES_PASSWORD}" psql \
    -h "${POSTGRES_HOST}" -p "${POSTGRES_PORT}" \
    -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" \
    -v ON_ERROR_STOP=1 -q "$@"
}

# Einzelwert abfragen. -q ist Pflicht, nicht Kosmetik: ohne das haengt psql an
# ein INSERT ... RETURNING zusaetzlich den Kommando-Tag ("INSERT 0 1") an, der
# sonst mit in der Variablen landet.
pb_wert() {
  PGPASSWORD="${POSTGRES_PASSWORD}" psql \
    -h "${POSTGRES_HOST}" -p "${POSTGRES_PORT}" \
    -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" \
    -v ON_ERROR_STOP=1 -q -At -c "$1"
}

# --- 2a. Verwaltungstabelle ---------------------------------------------------
pb_psql -f "${SCHEMA_DIR}/bootstrap-historie.sql"

# --- 2b. Frische-Erkennung ----------------------------------------------------
# MUSS vor jeder Strukturänderung ausgewertet werden, sonst hält sich jede
# Datenbank nach dem ersten Vollschema-Lauf für alt.
FRISCH=$(pb_wert "SELECT to_regclass('postbuch.postbuch') IS NULL")

# --- 2c. Legacy-Kette ---------------------------------------------------------
for SKRIPT in $(ls "${SCHEMA_DIR}"/legacy-bis-*.sql 2>/dev/null | sort -V); do
  NAME=$(basename "${SKRIPT}")
  ERLEDIGT=$(pb_wert "SELECT EXISTS (SELECT 1 FROM postbuch._schema_historie
                       WHERE skript = '${NAME}' AND ergebnis IN ('erfolg','uebersprungen'))")
  [ "${ERLEDIGT}" = "t" ] && continue

  SUMME=$(sha256sum "${SKRIPT}" | cut -d' ' -f1)

  if [ "${FRISCH}" = "t" ]; then
    pb_psql -c "INSERT INTO postbuch._schema_historie
                  (skript, art, checksumme, ergebnis, app_version, dauer_ms)
                VALUES ('${NAME}', 'legacy', '${SUMME}', 'uebersprungen', '${APP_VERSION}', 0)"
    echo "[schema] ${NAME}: übersprungen (Erstinstallation)"
    continue
  fi

  echo "[schema] ${NAME}: wird angewendet — das kann dauern und passiert genau einmal ..."
  RANG=$(pb_wert "INSERT INTO postbuch._schema_historie
                    (skript, art, checksumme, ergebnis, app_version)
                  VALUES ('${NAME}', 'legacy', '${SUMME}', 'laeuft', '${APP_VERSION}')
                  RETURNING rang")

  if pb_psql -f "${SKRIPT}"; then
    pb_psql -c "UPDATE postbuch._schema_historie
                   SET ergebnis = 'erfolg',
                       dauer_ms = round(extract(epoch FROM (clock_timestamp() - angewendet_am)) * 1000)
                 WHERE rang = ${RANG}"
    echo "[schema] ${NAME}: erfolgreich."
  else
    pb_psql -c "UPDATE postbuch._schema_historie
                   SET ergebnis = 'fehler',
                       dauer_ms = round(extract(epoch FROM (clock_timestamp() - angewendet_am)) * 1000)
                 WHERE rang = ${RANG}" || true
    echo "[schema] ${NAME}: FEHLGESCHLAGEN. Start abgebrochen." >&2
    exit 1
  fi
done

# --- 2d. Vollschema (wiederholbar) -------------------------------------------
echo "[entrypoint] Applying schema..."
pb_psql -f /app/base_schema.sql
echo "[entrypoint] Schema applied."

# Neue Zeile nur bei geänderter Checksumme — sonst wüchse die Tabelle bei jedem
# Neustart. Ergibt die Historie der Schemastände, die diese Datenbank gesehen hat.
VOLL_SUMME=$(sha256sum /app/base_schema.sql | cut -d' ' -f1)
pb_psql -c "INSERT INTO postbuch._schema_historie
              (skript, art, checksumme, ergebnis, app_version)
            SELECT 'base_schema.sql', 'vollschema', '${VOLL_SUMME}', 'erfolg', '${APP_VERSION}'
            WHERE NOT EXISTS (
              SELECT 1 FROM postbuch._schema_historie
               WHERE art = 'vollschema'
                 AND checksumme = '${VOLL_SUMME}'
                 AND rang = (SELECT max(rang) FROM postbuch._schema_historie WHERE art = 'vollschema'))"

# ══════════════════════════════════════════════════════
# 3. ENV → DB Seeding (DB is Single Point of Truth)
# ══════════════════════════════════════════════════════
echo "[entrypoint] Seeding settings from ENV..."
node src/seed-settings.js

# ══════════════════════════════════════════════════════
# 4. Start the application
# ══════════════════════════════════════════════════════
exec "$@"
