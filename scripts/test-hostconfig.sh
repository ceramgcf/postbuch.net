#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
printf 'WEB_PORT=3420\nDUCKDNS_DOMAIN=alt.duckdns.org\nDUCKDNS_API_TOKEN=altes_token_123\n' > "$TMP/.env"
mkdir -p "$TMP/caddy"
printf '# vorherige Caddy-Konfiguration\n' > "$TMP/caddy/Caddyfile"
# shellcheck source=postbuch-hostconfig.sh
source "$ROOT/scripts/postbuch-hostconfig.sh"
LOG="$TMP/calls.log"
hostconfig_compose() {
  printf 'compose %s\n' "$*" >> "$LOG"
  if [[ "$1" == ps && "$2" == -q ]]; then
    [[ "${LEERER_SERVICE:-}" == "$3" ]] || printf 'id-%s\n' "$3"
    return 0
  fi
  [[ -z "${COMPOSE_FEHLER_MUSTER:-}" || "$*" != *"$COMPOSE_FEHLER_MUSTER"* ]]
}
hostconfig_docker() {
  printf 'docker %s\n' "$*" >> "$LOG"
  [[ "${UNHEALTHY_SERVICE:-}" != "${*: -1}" ]] && printf 'true healthy\n' || printf 'true unhealthy\n'
}

: > "$LOG"
hostconfig_anwenden "$TMP" port 3456
grep -q '^WEB_PORT=3456$' "$TMP/.env"
[[ ! -e "$TMP/.env.hostconfig.bak" ]]
grep -q 'compose ps -q web' "$LOG"

# Netzwerkänderung wird nach erfolgreichem Recreate auch in der bestehenden
# DB wirksam; ein DB-Fehler tauscht ENV und Containerkonfiguration zurück.
: > "$LOG"; COMPOSE_FEHLER_MUSTER=''
hostconfig_anwenden "$TMP" netzwerk https://postbuch.lan:3420
grep -q '^APP_BASE_URL=https://postbuch.lan:3420$' "$TMP/.env"
grep -q "compose exec -T postgres psql .*app_host.*https://postbuch.lan:3420" "$LOG"
cp "$TMP/.env" "$TMP/netz-vorher"
: > "$LOG"; COMPOSE_FEHLER_MUSTER='exec -T postgres'
if hostconfig_anwenden "$TMP" netzwerk https://neu.lan:3420; then exit 1; fi
cmp -s "$TMP/.env" "$TMP/netz-vorher"
grep -q 'compose up -d --force-recreate --no-deps app web' "$LOG"

cp "$TMP/.env" "$TMP/vorher"
cp "$TMP/caddy/Caddyfile" "$TMP/caddy-vorher"
COMPOSE_FEHLER_MUSTER='up -d --build'; LEERER_SERVICE=caddy; export COMPOSE_FEHLER_MUSTER
: > "$LOG"
if hostconfig_anwenden "$TMP" duckdns neu.duckdns.org neues_token_123; then exit 1; fi
cmp -s "$TMP/.env" "$TMP/vorher"
cmp -s "$TMP/caddy/Caddyfile" "$TMP/caddy-vorher"
! grep -Rqs 'neues_token_123' "$TMP" --exclude='.env'
grep -q 'compose stop caddy' "$LOG"
LEERER_SERVICE=''

# Caddy war aktiv: eine fehlgeschlagene Deaktivierung startet exakt diesen
# vorherigen Zustand wieder; eine erfolgreiche Deaktivierung leert die Werte.
: > "$LOG"; COMPOSE_FEHLER_MUSTER='stop caddy'
if hostconfig_anwenden "$TMP" duckdns aus; then exit 1; fi
cmp -s "$TMP/.env" "$TMP/vorher"
cmp -s "$TMP/caddy/Caddyfile" "$TMP/caddy-vorher"
grep -q 'compose --profile caddy up -d --force-recreate --no-deps caddy' "$LOG"
: > "$LOG"; COMPOSE_FEHLER_MUSTER=''
hostconfig_anwenden "$TMP" duckdns aus
grep -q '^DUCKDNS_DOMAIN=$' "$TMP/.env"
grep -q '^DUCKDNS_API_TOKEN=$' "$TMP/.env"
grep -q 'compose stop caddy' "$LOG"
grep -q 'Kein DuckDNS konfiguriert' "$TMP/caddy/Caddyfile"

# Aktivierung aus vorher inaktivem Zustand: jeder Fehler stoppt die Profildienste.
printf 'COMPOSE_PROFILES=\n' > "$TMP/.env"
: > "$LOG"; COMPOSE_FEHLER_MUSTER='build scanner cleaner'
if hostconfig_anwenden "$TMP" module scanner:an; then exit 1; fi
grep -q '^COMPOSE_PROFILES=$' "$TMP/.env"
grep -q 'compose stop scanner cleaner' "$LOG"

# Deaktivierung aus aktivem Zustand: bei Fehler werden beide Dienste reaktiviert.
printf 'COMPOSE_PROFILES=scanner\n' > "$TMP/.env"
: > "$LOG"; COMPOSE_FEHLER_MUSTER='stop scanner cleaner'
if hostconfig_anwenden "$TMP" module scanner:aus; then exit 1; fi
grep -q '^COMPOSE_PROFILES=scanner$' "$TMP/.env"
grep -q 'compose --profile scanner up -d --force-recreate --no-deps scanner cleaner' "$LOG"

# Exit 0 von compose reicht nicht: fehlender oder unhealthy Sollservice ist Fehler.
printf 'WEB_PORT=3420\n' > "$TMP/.env"
: > "$LOG"; COMPOSE_FEHLER_MUSTER=''; LEERER_SERVICE=web
if hostconfig_anwenden "$TMP" port 3457; then exit 1; fi
grep -q '^WEB_PORT=3420$' "$TMP/.env"
LEERER_SERVICE=''; UNHEALTHY_SERVICE='id-web'
if hostconfig_anwenden "$TMP" port 3458; then exit 1; fi
grep -q '^WEB_PORT=3420$' "$TMP/.env"

printf 'Hostconfig-Harness: OK\n'
