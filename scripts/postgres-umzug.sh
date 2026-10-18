#!/usr/bin/env bash
# postgres-umzug.sh – zieht den Datenbestand von PostgreSQL 16 auf die
# Hauptversion um, die docker-compose.yml vorgibt (derzeit 18).
#
#   scripts/postgres-umzug.sh status                  gibt den Zustand aus (siehe unten)
#   scripts/postgres-umzug.sh ausfuehren [--ohne-start]
#   scripts/postgres-umzug.sh aufraeumen              löscht den Altbestand nach dem Umzug
#   scripts/postgres-umzug.sh altbestand              startet PostgreSQL 16 mit dem Altbestand,
#                                                     falls er nicht läuft (vor einem Backup)
#   Option überall: --install-dir=<Pfad> (Standard: Verzeichnis über scripts/)
#
# Weg: Dump und Restore, kein pg_upgrade. Der Altbestand liegt direkt in
# data/postgres, PostgreSQL 18 legt seinen unter data/postgres/18/docker an.
# Beide passen also nebeneinander. Ablauf von `ausfuehren`:
#   1. Code-Container stoppen, PostgreSQL 16 läuft weiter (oder wird gestartet)
#   2. PostgreSQL 18 als Nebencontainer starten, Rollen, Datenbank und
#      datenbankbezogene Einstellungen mit pg_dump 18 übernehmen
#   3. Alt und neu vergleichen: exakte Zeilenzahl jeder Tabelle, Sequenzen,
#      Objekte, Rollen, Erweiterungen, Kodierung; Vektorabfrage; ANALYZE
#   4. Marker data/postgres/umzug/fertig schreiben – erst ab hier gilt der Umzug
#   5. Altbestand nach data/postgres/umzug/pg16 schieben, PostgreSQL 18 starten
# `aufraeumen` löscht data/postgres/umzug, wenn PostgreSQL 18 läuft. Der Aufrufer
# entscheidet, wann (install.sh: nach erfolgreichem App-Healthcheck).
#
# Zustände (`status`):
#   keiner       kein Altbestand – nichts zu tun (Neuinstallation oder erledigt)
#   ausstehend   Altbestand vorhanden, Umzug nicht begonnen
#   abgebrochen  ein früherer Versuch kam nicht bis zum Marker; wird verworfen
#   umgestellt   Marker steht, Altbestand ist noch nicht beiseitegelegt
#   aufraeumen   PostgreSQL 18 ist der Bestand, data/postgres/umzug kann weg
#   unklar       Verzeichnis passt zu keinem Zustand – nichts wird angefasst
#
# Fehler vor dem Marker lassen PostgreSQL 16 unverändert und starten die
# gestoppten Code-Container wieder. Gibt keine Passwörter aus.
set -euo pipefail

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BEFEHL=""
OHNE_START=false
for arg in "$@"; do
    case "$arg" in
        status|ausfuehren|aufraeumen|altbestand) BEFEHL="$arg" ;;
        --ohne-start) OHNE_START=true ;;
        --install-dir=*) INSTALL_DIR="${arg#*=}" ;;
        *) echo "Unbekannte Angabe: $arg" >&2; exit 2 ;;
    esac
done
[[ -n "$BEFEHL" ]] || { sed -n '2,8p' "$0" >&2; exit 2; }
[[ -f "$INSTALL_DIR/docker-compose.yml" ]] || { echo "Keine Installation unter $INSTALL_DIR" >&2; exit 2; }
cd "$INSTALL_DIR"

# Bild, mit dem ein PostgreSQL-16-Bestand gestartet wird, wenn sein alter
# Container fehlt (z. B. nach `docker compose down` vor dem Umzug) oder schon
# auf das neue Image umgestellt wurde, das neben dem Altbestand nicht startet.
ALT_IMAGE="pgvector/pgvector:pg16@sha256:a36250871de0833b8757561c72f2477ef1ddd1101afa4e617fb552e0de514c6b"
DB_CONTAINER=postbuch-postgres
NEU_CONTAINER=postbuch-postgres-umzug

if [[ -n "${POSTBUCH_DOCKER:-}" ]]; then
    read -r -a DOCKER <<<"$POSTBUCH_DOCKER"
elif docker info >/dev/null 2>&1; then
    DOCKER=(docker)
else
    DOCKER=(sudo docker)
fi
DC=("${DOCKER[@]}" compose)
PROJEKT="${COMPOSE_PROJECT_NAME:-$(basename "$INSTALL_DIR")}"
export COMPOSE_PROJECT_NAME="$PROJEKT"

env_wert() { grep "^$1=" .env 2>/dev/null | tail -n1 | cut -d'=' -f2- | tr -d "'\"" || true; }
DB_USER="$(env_wert POSTGRES_USER)"; DB_USER="${DB_USER:-postbuch}"
DB_NAME="$(env_wert POSTGRES_DB)";   DB_NAME="${DB_NAME:-postbuch}"
[[ "$DB_USER" =~ ^[A-Za-z_][A-Za-z0-9_]{0,62}$ && "$DB_NAME" =~ ^[A-Za-z_][A-Za-z0-9_]{0,62}$ ]] \
    || { echo "POSTGRES_USER/POSTGRES_DB in .env sind keine einfachen Namen." >&2; exit 2; }

say() { printf '  %s\n' "$*"; }

# Einmal-Container mit dem Datenverzeichnis unter /var/lib/postgresql.
hilfs() {
    "${DC[@]}" run --rm --no-deps -T --entrypoint sh postgres -c "$1" </dev/null 2> >(grep -v '^ *Container .*-run-.* \(Creating\|Created\) *$' >&2)
}

zustand() {
    hilfs 'cd /var/lib/postgresql
        if [ -f PG_VERSION ]; then
            if [ -f umzug/fertig ]; then echo umgestellt
            elif [ -e "$PGDATA" ] || [ -e umzug ]; then echo abgebrochen
            else echo ausstehend; fi
        elif [ -f umzug/fertig ]; then echo aufraeumen
        elif [ -e umzug ]; then echo unklar
        else echo keiner; fi'
}

netz() {
    "${DOCKER[@]}" network ls -q --filter "label=com.docker.compose.project=$PROJEKT" \
        --filter "label=com.docker.compose.network=postbuch" | head -n1
}
laeuft() { [[ "$("${DOCKER[@]}" inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" == true ]]; }
server_version() { "${DOCKER[@]}" exec "$1" psql -U "$DB_USER" -d "$DB_NAME" -At -c 'SHOW server_version_num' 2>/dev/null; }
warte_bereit() {   # $1 Container – wartet auf TCP, erst dann ist ein initdb-Lauf durch
    local i
    for i in $(seq 1 150); do
        "${DOCKER[@]}" exec "$1" pg_isready -q -h 127.0.0.1 -U "$DB_USER" 2>/dev/null && return 0
        laeuft "$1" || return 1
        sleep 2
    done
    return 1
}
postgres_container_stoppen() {
    "${DOCKER[@]}" rm -f "$NEU_CONTAINER" >/dev/null 2>&1 || true
    if "${DOCKER[@]}" inspect "$DB_CONTAINER" >/dev/null 2>&1; then
        "${DOCKER[@]}" stop -t 120 "$DB_CONTAINER" >/dev/null
        "${DOCKER[@]}" rm "$DB_CONTAINER" >/dev/null
    fi
}

# ── status ────────────────────────────────────────────────────────────────────
if [[ "$BEFEHL" == status ]]; then
    zustand
    exit 0
fi

NEU_MAJOR="$(hilfs 'echo "$PG_MAJOR"')"
[[ "$NEU_MAJOR" =~ ^[0-9]+$ ]] || { echo "Hauptversion der Compose nicht lesbar." >&2; exit 1; }
NEU_IMAGE="$(awk '/^  postgres:/ {p=1} p && $1 == "image:" {print $2; exit}' docker-compose.yml)"
[[ -n "$NEU_IMAGE" ]] || { echo "Image des postgres-Dienstes nicht lesbar." >&2; exit 1; }

# Sorgt dafür, dass $DB_CONTAINER PostgreSQL 16 mit dem Altbestand ausführt.
# Fehlt der Container oder läuft er schon mit dem neuen Image, entsteht ein
# Ersatz unter demselben Namen, Netzalias und denselben Compose-Labels: Die App
# erreicht ihn wie gewohnt, Backups finden ihn, und ein späteres
# `docker compose up --no-recreate` übernimmt ihn, statt einen Namenskonflikt zu melden.
altbestand_sicherstellen() {
    local v
    if laeuft "$DB_CONTAINER"; then
        v="$(server_version "$DB_CONTAINER" || true)"
        (( ${v:-0} > 0 && v < NEU_MAJOR * 10000 )) && return 0
    elif "${DOCKER[@]}" inspect -f '{{.Config.Image}}' "$DB_CONTAINER" 2>/dev/null | grep -q ':pg16'; then
        "${DOCKER[@]}" start "$DB_CONTAINER" >/dev/null && warte_bereit "$DB_CONTAINER" && return 0
    fi
    say "Kein laufender PostgreSQL-16-Container – starte den Bestand mit dem bisherigen Image."
    "${DOCKER[@]}" rm -f "$DB_CONTAINER" >/dev/null 2>&1 || true
    [[ -n "$(netz)" ]] || "${DOCKER[@]}" network create --label "com.docker.compose.project=$PROJEKT" \
        --label com.docker.compose.network=postbuch "${PROJEKT}_postbuch" >/dev/null
    "${DOCKER[@]}" run -d --name "$DB_CONTAINER" --network "$(netz)" --network-alias postgres \
        --restart unless-stopped -e TZ=Europe/Berlin \
        --label "com.docker.compose.project=$PROJEKT" --label com.docker.compose.service=postgres \
        --label com.docker.compose.container-number=1 --label com.docker.compose.oneoff=False \
        -v "$INSTALL_DIR/data/postgres:/var/lib/postgresql/data" "$ALT_IMAGE" >/dev/null
    warte_bereit "$DB_CONTAINER"
}

neu_starten() {
    "${DC[@]}" up -d --no-deps postgres
    warte_bereit "$DB_CONTAINER" || { echo "PostgreSQL $NEU_MAJOR startet nicht – bitte: docker compose logs postgres" >&2; return 1; }
    local v; v="$(server_version "$DB_CONTAINER")"
    (( ${v:-0} >= NEU_MAJOR * 10000 )) || { echo "Laufender Server ist nicht PostgreSQL $NEU_MAJOR ($v)." >&2; return 1; }
    say "PostgreSQL $NEU_MAJOR läuft."
}

# ── altbestand ────────────────────────────────────────────────────────────────
if [[ "$BEFEHL" == altbestand ]]; then
    st="$(zustand)"
    case "$st" in ausstehend|abgebrochen) ;; *) exit 0 ;; esac
    altbestand_sicherstellen || { echo "PostgreSQL 16 startet nicht mit dem vorhandenen Bestand – bitte: docker logs $DB_CONTAINER" >&2; exit 1; }
    exit 0
fi

# ── aufraeumen ────────────────────────────────────────────────────────────────
if [[ "$BEFEHL" == aufraeumen ]]; then
    st="$(zustand)"
    if [[ "$st" != aufraeumen ]]; then say "Nichts aufzuräumen (Zustand: $st)."; exit 0; fi
    v="$(server_version "$DB_CONTAINER" || true)"
    (( ${v:-0} >= NEU_MAJOR * 10000 )) || { echo "PostgreSQL $NEU_MAJOR läuft nicht – Altbestand bleibt liegen." >&2; exit 1; }
    hilfs 'rm -rf /var/lib/postgresql/umzug'
    say "Altbestand von PostgreSQL 16 und Umzugs-Dump gelöscht."
    exit 0
fi

# ── ausfuehren ────────────────────────────────────────────────────────────────
st="$(zustand)"
case "$st" in
    keiner)     say "Kein PostgreSQL-16-Bestand vorhanden – nichts umzuziehen."; exit 0 ;;
    aufraeumen) say "Umzug bereits abgeschlossen."; laeuft "$DB_CONTAINER" || neu_starten; exit 0 ;;
    unklar)     echo "data/postgres passt zu keinem bekannten Zustand – Umzug abgebrochen, nichts verändert." >&2; exit 1 ;;
esac
echo "PostgreSQL-Umzug auf Version $NEU_MAJOR (Zustand: $st)"

# Code-Container dieses Projekts stoppen, damit während des Dumps niemand
# schreibt. Gemerkt werden die Namen, nicht Services: Profile spielen so keine Rolle.
mapfile -t CODE < <("${DOCKER[@]}" ps --filter "label=com.docker.compose.project=$PROJEKT" \
    --format '{{.Names}} {{.Label "com.docker.compose.service"}}' | awk '$2 != "postgres" {print $1}')
code_wieder_starten() {
    [[ ${#CODE[@]} -gt 0 ]] && "${DOCKER[@]}" start "${CODE[@]}" >/dev/null 2>&1 || true
}
if [[ ${#CODE[@]} -gt 0 ]]; then
    say "Stoppe ${CODE[*]}"
    "${DOCKER[@]}" stop -t 60 "${CODE[@]}" >/dev/null
fi

if [[ "$st" == ausstehend || "$st" == abgebrochen ]]; then
    VOR_MARKER=true
    abbruch() {
        echo "FEHLER: $*" >&2
        if $VOR_MARKER; then
            "${DOCKER[@]}" rm -f "$NEU_CONTAINER" >/dev/null 2>&1 || true
            echo "  PostgreSQL 16 bleibt der Bestand, nichts wurde gelöscht. Ein neuer Versuch verwirft den Teilstand." >&2
            code_wieder_starten
        fi
        exit 1
    }
    trap 'abbruch "unerwarteter Fehler in Zeile $LINENO"' ERR

    # Quelle: der laufende PostgreSQL-16-Container, sonst ein Ersatz mit demselben Bestand.
    altbestand_sicherstellen || abbruch "PostgreSQL 16 startet nicht mit dem vorhandenen Bestand."
    QUELLE="$DB_CONTAINER"
    say "Quelle: $QUELLE (PostgreSQL $(( $(server_version "$QUELLE") / 10000 )))"

    if [[ "$st" == abgebrochen ]]; then
        say "Verwerfe den Teilstand eines früheren Versuchs."
        "${DOCKER[@]}" rm -f "$NEU_CONTAINER" >/dev/null 2>&1 || true
        hilfs 'rm -rf /var/lib/postgresql/umzug "$(dirname "$PGDATA")"'
    fi

    # Platz: Dump und neuer Bestand liegen bis zum Aufräumen neben dem alten.
    ALT_KB="$(hilfs 'du -sk /var/lib/postgresql | cut -f1')"
    FREI_KB="$(df -Pk "$INSTALL_DIR/data" | awk 'NR==2 {print $4}')"
    if (( FREI_KB < 3 * ALT_KB )); then
        abbruch "Zu wenig Platz: frei $((FREI_KB / 1024)) MB, nötig etwa $((3 * ALT_KB / 1024)) MB (dreifache Größe von data/postgres)."
    fi

    # Der Nebencontainer sieht nur data/postgres/<neu>, also keinen Altbestand:
    # Sonst verweigert das Image die Initialisierung (siehe docker-compose.yml).
    # Er legt seine Daten genau dort an, wo der Compose-Dienst sie erwartet.
    say "Starte PostgreSQL $NEU_MAJOR für die Übernahme."
    "${DOCKER[@]}" rm -f "$NEU_CONTAINER" >/dev/null 2>&1 || true
    POSTGRES_PASSWORD="$(env_wert POSTGRES_PASSWORD)" POSTGRES_USER="$DB_USER" POSTGRES_DB="$DB_NAME" \
        "${DOCKER[@]}" run -d --name "$NEU_CONTAINER" --network "$(netz)" \
        -e POSTGRES_PASSWORD -e POSTGRES_USER -e POSTGRES_DB -e TZ=Europe/Berlin \
        -v "$INSTALL_DIR/data/postgres/$NEU_MAJOR:/var/lib/postgresql/$NEU_MAJOR" \
        -v "$INSTALL_DIR/data/postgres/umzug:/var/lib/postgresql/umzug" "$NEU_IMAGE" >/dev/null
    warte_bereit "$NEU_CONTAINER" || abbruch "PostgreSQL $NEU_MAJOR startet nicht."

    # Alle Werkzeuge laufen im neuen Container (Version $NEU_MAJOR), die Quelle
    # erreichen sie über das Compose-Netz. SQL kommt über stdin.
    in_neu()  { "${DOCKER[@]}" exec -i -e "Q=$QUELLE" "$NEU_CONTAINER" sh -ec "$1"; }
    sql_neu() { in_neu 'psql -U "$POSTGRES_USER" -d "${1:-$POSTGRES_DB}" -At -q -v ON_ERROR_STOP=1 -f -' ; }
    sql_neu_postgres() { in_neu 'psql -U "$POSTGRES_USER" -d postgres -At -q -v ON_ERROR_STOP=1 -f -' ; }
    sql_alt() { in_neu 'PGPASSWORD="$POSTGRES_PASSWORD" psql -h "$Q" -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -v ON_ERROR_STOP=1 -f -' ; }

    say "Übernehme Rollen und Datenbank (pg_dump $NEU_MAJOR)."
    in_neu '
        export PGPASSWORD="$POSTGRES_PASSWORD"
        mkdir -p /var/lib/postgresql/umzug && chmod 700 /var/lib/postgresql/umzug && cd /var/lib/postgresql/umzug
        pg_dumpall -h "$Q" -U "$POSTGRES_USER" --roles-only -f rollen.sql
        pg_dump -h "$Q" -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc -f postbuch.dump
    ' || abbruch "Dump aus PostgreSQL 16 fehlgeschlagen."
    in_neu '
        cd /var/lib/postgresql/umzug
        # Den Bootstrap-Nutzer hat initdb schon angelegt; Attribute und Passwort
        # setzt das ALTER ROLE aus dem Dump trotzdem.
        grep -vx "CREATE ROLE $POSTGRES_USER;" rollen.sql | psql -q -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 >/dev/null
        pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --exit-on-error --single-transaction postbuch.dump
    ' || abbruch "Einspielen in PostgreSQL $NEU_MAJOR fehlgeschlagen."

    # Datenbankbezogene Einstellungen (ALTER DATABASE/ROLE … IN DATABASE … SET)
    # gehören nicht zu pg_dump ohne --create; sie werden hier nachgebaut.
    sql_alt <<'SQL' | sql_neu_postgres >/dev/null || abbruch "Datenbankeinstellungen nicht übertragbar."
SELECT CASE WHEN s.setrole = 0
         THEN format('ALTER DATABASE %I SET %s TO %L;', d.datname, split_part(c, '=', 1), substr(c, strpos(c, '=') + 1))
         ELSE format('ALTER ROLE %I IN DATABASE %I SET %s TO %L;', r.rolname, d.datname, split_part(c, '=', 1), substr(c, strpos(c, '=') + 1)) END
  FROM pg_db_role_setting s JOIN pg_database d ON d.oid = s.setdatabase
  LEFT JOIN pg_roles r ON r.oid = s.setrole, unnest(s.setconfig) c
 WHERE d.datname = current_database();
SQL

    # ALTER SYSTEM-Einträge des Altbestands mitnehmen (die App setzt keine).
    in_neu '
        grep -v "^[[:space:]]*#" /var/lib/postgresql/postgresql.auto.conf 2>/dev/null | grep -v "^[[:space:]]*$" > /tmp/auto.conf || true
        if [ -s /tmp/auto.conf ]; then
            cat /tmp/auto.conf >> "$PGDATA/postgresql.auto.conf"
            echo "  ALTER SYSTEM übernommen: $(cut -d= -f1 /tmp/auto.conf | tr -d " " | paste -sd, -)"
        fi
    ' || abbruch "postgresql.auto.conf nicht übertragbar."

    say "Prüfe den neuen Bestand gegen den alten."
    PRUEF_SQL=$(cat <<'SQL'
SELECT 'tabelle ' || n.nspname || '.' || c.relname || ' ' ||
       (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname), false, true, '')))[1]::text
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'
 ORDER BY 1;
SELECT 'sequenz ' || schemaname || '.' || sequencename || ' ' || coalesce(last_value::text, '-') FROM pg_sequences ORDER BY 1;
SELECT 'objekte ' || n.nspname || ' ' || c.relkind::text || ' ' || count(*)
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'
 GROUP BY n.nspname, c.relkind ORDER BY 1;
SELECT 'index_ungueltig ' || count(*) FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE NOT (i.indisvalid AND i.indisready) AND n.nspname NOT IN ('pg_catalog', 'information_schema');
-- NOT NULL steht ab PostgreSQL 18 auch in pg_constraint (contype n) und zählt hier nicht.
SELECT 'constraint ' || n.nspname || ' ' || con.contype::text || ' ' || count(*)
  FROM pg_constraint con JOIN pg_namespace n ON n.oid = con.connamespace
 WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND con.contype <> 'n'
 GROUP BY n.nspname, con.contype ORDER BY 1;
SELECT 'trigger ' || count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE NOT t.tgisinternal AND n.nspname NOT IN ('pg_catalog', 'information_schema');
-- Funktionen der Erweiterungen zählen nicht: pgvector bringt je Version andere mit.
SELECT 'funktion ' || n.nspname || ' ' || count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
   AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
 GROUP BY n.nspname ORDER BY 1;
SELECT 'policy ' || count(*) FROM pg_policy;
SELECT 'rolle ' || rolname || ' ' || rolsuper || rolinherit || rolcreaterole || rolcreatedb || rolcanlogin || rolreplication || rolbypassrls
  FROM pg_roles WHERE rolname !~ '^pg_' ORDER BY 1;
SELECT 'extension ' || extname FROM pg_extension ORDER BY 1;
SELECT 'datenbank ' || pg_encoding_to_char(encoding) || ' ' || datcollate || ' ' || datctype FROM pg_database WHERE datname = current_database();
SELECT 'einstellung ' || coalesce(r.rolname, '-') || ' ' || array_to_string(s.setconfig, ',')
  FROM pg_db_role_setting s LEFT JOIN pg_roles r ON r.oid = s.setrole LEFT JOIN pg_database d ON d.oid = s.setdatabase
 WHERE s.setdatabase = 0 OR d.datname = current_database() ORDER BY 1;
SQL
)
    PRUEF_DIR="$(mktemp -d)"
    printf '%s\n' "$PRUEF_SQL" | sql_alt > "$PRUEF_DIR/alt.txt" || abbruch "Prüfabfrage gegen PostgreSQL 16 fehlgeschlagen."
    printf '%s\n' "$PRUEF_SQL" | sql_neu > "$PRUEF_DIR/neu.txt" || abbruch "Prüfabfrage gegen PostgreSQL $NEU_MAJOR fehlgeschlagen."
    if ! diff "$PRUEF_DIR/alt.txt" "$PRUEF_DIR/neu.txt" > "$PRUEF_DIR/diff.txt"; then
        echo "  Abweichungen (< alt, > neu):" >&2; head -n 20 "$PRUEF_DIR/diff.txt" | sed 's/^/    /' >&2
        rm -rf "$PRUEF_DIR"
        abbruch "Der neue Bestand weicht vom alten ab."
    fi
    say "$(grep -c '^tabelle ' "$PRUEF_DIR/neu.txt") Tabellen mit exakter Zeilenzahl und $(grep -c '^sequenz ' "$PRUEF_DIR/neu.txt") Sequenzen stimmen überein."
    rm -rf "$PRUEF_DIR"
    EXT_SQL="SELECT string_agg(extname || ' ' || extversion, ', ' ORDER BY extname) FROM pg_extension;"
    say "Erweiterungen: $(sql_alt <<<"$EXT_SQL") -> $(sql_neu <<<"$EXT_SQL")"

    # Jede Vektorspalte (vector, halfvec, sparsevec) einmal über den Distanzoperator abfragen.
    VEKTOR="$(sql_neu <<'SQL'
SELECT format('SELECT %L || '' '' || count(*) FROM (SELECT 1 FROM %s WHERE %I IS NOT NULL ORDER BY %I OPERATOR(%I.<->) (SELECT %I FROM %s WHERE %I IS NOT NULL LIMIT 1) LIMIT 3) x',
              a.attrelid::regclass::text || '.' || a.attname, a.attrelid::regclass, a.attname, a.attname, tn.nspname, a.attname, a.attrelid::regclass, a.attname)
  FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid JOIN pg_namespace tn ON tn.oid = t.typnamespace
  JOIN pg_class c ON c.oid = a.attrelid
 WHERE t.typname IN ('vector', 'halfvec', 'sparsevec') AND a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r', 'p')
\gexec
SQL
)" || abbruch "Vektorabfrage im neuen Bestand fehlgeschlagen."
    [[ -n "$VEKTOR" ]] && say "Vektorabfragen: $(paste -sd, <<<"$VEKTOR")"
    in_neu 'vacuumdb -q -U "$POSTGRES_USER" --all --analyze-only' || abbruch "ANALYZE im neuen Bestand fehlgeschlagen."

    in_neu '
        export PGPASSWORD="$POSTGRES_PASSWORD"; cd /var/lib/postgresql/umzug
        { echo "quelle_system_identifier=$(psql -h "$Q" -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -c "SELECT system_identifier FROM pg_control_system()")"
          echo "umgezogen_am=$(date -u +%Y-%m-%dT%H:%M:%SZ)"; echo "nach=$PG_MAJOR"; } > fertig.tmp
        mv fertig.tmp fertig
    ' || abbruch "Marker konnte nicht geschrieben werden."
    VOR_MARKER=false
    trap - ERR
    say "Übernahme geprüft, Marker gesetzt."
fi

# ── ab dem Marker: Altbestand beiseitelegen, PostgreSQL 18 als Bestand starten ─
postgres_container_stoppen
hilfs 'cd /var/lib/postgresql && mkdir -p umzug/pg16
    for f in * .[!.]*; do
        case "$f" in umzug|"$PG_MAJOR"|"*"|".[!.]*") continue ;; esac
        mv "$f" umzug/pg16/
    done'
say "Altbestand nach data/postgres/umzug/pg16 verschoben (wird nach erfolgreichem Start gelöscht)."
if ! neu_starten; then
    echo "  Der Altbestand liegt unverändert unter data/postgres/umzug/pg16, der Dump unter data/postgres/umzug." >&2
    exit 1
fi
if $OHNE_START; then
    say "Code-Container startet der Aufrufer."
else
    code_wieder_starten
    say "Code-Container wieder gestartet. Nach der Prüfung: scripts/postgres-umzug.sh aufraeumen"
fi
