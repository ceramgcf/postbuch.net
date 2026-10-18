#!/usr/bin/env bash
# Notausgang: Öffnet die Weboberfläche wieder für das Heimnetz.
#
# Für den Fall, dass „Oberfläche nur über HTTPS“ eingeschaltet ist und HTTPS
# nicht mehr funktioniert (DuckDNS, Router, Zertifikat, Caddy). Auf dem Host im
# Installationsordner ausführen, per SSH oder direkt am Gerät:
#
#   cd ~/postbuch && ./scripts/zugang-heimnetz-oeffnen.sh
#
# Danach ist postbuch.net wieder unter http://<IP-des-Geräts>:<WEB_PORT>
# erreichbar. Setzt nur WEB_BIND in der .env zurück und erstellt den
# web-Container neu; Daten und andere Dienste bleiben unberührt.

set -euo pipefail

INSTALL_DIR=$(cd "$(dirname "$0")/.." && pwd)
ENV_DATEI="$INSTALL_DIR/.env"

if [[ ! -f "$ENV_DATEI" || ! -f "$INSTALL_DIR/docker-compose.yml" ]]; then
    echo "Kein postbuch.net-Installationsordner: $INSTALL_DIR" >&2
    exit 1
fi

if docker info >/dev/null 2>&1; then
    DOCKER_ART=direkt
elif command -v sudo >/dev/null 2>&1 && sudo docker info >/dev/null 2>&1; then
    DOCKER_ART=sudo
else
    echo "Docker ist nicht erreichbar (auch nicht mit sudo)." >&2
    exit 1
fi
export DOCKER_ART

# shellcheck source=postbuch-hostconfig.sh
source "$INSTALL_DIR/scripts/postbuch-hostconfig.sh"
# Der Notausgang darf nachfragen (sudo-Passwort), anders als der Agent.
hostconfig_docker()  { if [[ "$DOCKER_ART" == sudo ]]; then sudo docker "$@"; else docker "$@"; fi; }
hostconfig_compose() { if [[ "$DOCKER_ART" == sudo ]]; then sudo docker compose "$@"; else docker compose "$@"; fi; }

cd "$INSTALL_DIR"
hostconfig_env_setzen "$ENV_DATEI" WEB_BIND ''
rm -f -- "$ENV_DATEI.hostconfig.bak"
# Auch mit sudo aufgerufen bleibt die .env Eigentum des Installationsbenutzers.
if [[ $(id -u) -eq 0 ]]; then
    chown "$(stat -c '%u:%g' "$INSTALL_DIR")" "$ENV_DATEI"
fi
hostconfig_compose up -d --force-recreate --no-deps web

port=$(grep '^WEB_PORT=' "$ENV_DATEI" | tail -n1 | cut -d= -f2-)
ip=$(hostname -I 2>/dev/null | awk '{print $1}')
echo "Die Oberfläche ist wieder im Heimnetz erreichbar: http://${ip:-<IP-des-Geräts>}:${port:-3420}"
