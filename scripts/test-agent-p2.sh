#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
INSTALL="$TMP/install"; LIB="$TMP/lib"; BIN="$TMP/bin"; mkdir -p "$INSTALL/data/update" "$LIB/state" "$BIN"
mkdir -p "$INSTALL/caddy"
printf 'POSTBUCH_INSTALL_DIR=%s\nAGENT_MODE=dry-run\n' "$INSTALL" > "$TMP/agent.conf"
printf 'COMPOSE_PROFILES=\nDUCKDNS_DOMAIN=alt.duckdns.org\nDUCKDNS_API_TOKEN=altes_token_123\n' > "$INSTALL/.env"
printf '# ohne TLS\n' > "$INSTALL/caddy/Caddyfile"
printf '#!/usr/bin/env bash\nprintf "##PHASE:test\\n"\n' > "$LIB/install.sh"; chmod +x "$LIB/install.sh"
cp "$ROOT/scripts/postbuch-hostconfig.sh" "$LIB/postbuch-hostconfig.sh"
cat > "$BIN/docker" <<'EOF'
#!/usr/bin/env bash
printf 'docker %s\n' "$*" >> "$FAKE_DOCKER_LOG"
if [[ "$1" == compose && "$2" == ps && "$3" == -q ]]; then printf 'id-%s\n' "$4"; fi
if [[ "$1" == inspect ]]; then printf 'true healthy\n'; fi
exit 0
EOF
chmod +x "$BIN/docker"
export PATH="$BIN:$PATH" FAKE_DOCKER_LOG="$TMP/docker.log"

run_agent() {
  POSTBUCH_AGENT_CONF="$TMP/agent.conf" POSTBUCH_AGENT_LIB="$LIB" \
  POSTBUCH_AGENT_STATE_DIR="$LIB/state" "$ROOT/scripts/postbuch-update-agent.sh"
}

run_agent
grep -q '"version": 2' "$INSTALL/data/update/agent.json"
grep -q '"capabilities": \["update", "zielversion", "netzwerk", "module", "port", "freigabe"\]' "$INSTALL/data/update/agent.json"
grep -q '"freigaben": { "scanner": "lan", "web": "lan" }' "$INSTALL/data/update/agent.json"
grep -q '"webBestaetigungBis": null' "$INSTALL/data/update/agent.json"
grep -q '"scannerProfilAktiv": false' "$INSTALL/data/update/agent.json"

NOW=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
printf 'protokoll=1\nnonce=11111111111111111111111111111111\nzielVersion=9.9.9\nangefordertAm=%s\nangefordertVon=test\nerwarteterSha256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n' \
  "$NOW" > "$INSTALL/data/update/anforderung.kv"
run_agent
grep -q '"status": "erfolgreich"' "$INSTALL/data/update/status.json"

SECRET='NurImAuftrag_123456'
printf 'protokoll=2\ntyp=module\nnonce=22222222222222222222222222222222\nangefordertAm=%s\nangefordertVon=test\nwert=scanner:an\nsecret=%s\n' \
  "$NOW" "$SECRET" > "$INSTALL/data/update/anforderung.kv"
run_agent
grep -q '"status": "erfolgreich"' "$INSTALL/data/update/status.json"
! grep -Rqs "$SECRET" "$INSTALL/data/update/status.json" "$INSTALL/data/update/update.log" "$INSTALL/data/update/agent.json"
grep -q '^COMPOSE_PROFILES=scanner$' "$INSTALL/.env"
grep -q 'docker compose --profile scanner up -d --force-recreate --no-deps scanner cleaner' "$TMP/docker.log"
grep -q '"scannerProfilAktiv": true' "$INSTALL/data/update/agent.json"

# Auch der echte typisierte Caddy-Deaktivierungspfad läuft durch Agent +
# Hostconfig-Library; geheime Werte erscheinen in keinem Status/Log.
NOW=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
printf 'protokoll=2\ntyp=duckdns\nnonce=33333333333333333333333333333333\nangefordertAm=%s\nangefordertVon=test\nwert=aus\n' \
  "$NOW" > "$INSTALL/data/update/anforderung.kv"
run_agent
grep -q '"status": "erfolgreich"' "$INSTALL/data/update/status.json"
grep -q '^DUCKDNS_DOMAIN=$' "$INSTALL/.env"
grep -q '^DUCKDNS_API_TOKEN=$' "$INSTALL/.env"
grep -q 'docker compose stop caddy' "$TMP/docker.log"

DUCK_SECRET='DuckSecret_123456'
NOW=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
printf 'protokoll=2\ntyp=duckdns\nnonce=44444444444444444444444444444444\nangefordertAm=%s\nangefordertVon=test\nwert=neu.duckdns.org\nsecret=%s\n' \
  "$NOW" "$DUCK_SECRET" > "$INSTALL/data/update/anforderung.kv"
run_agent
grep -q '"status": "erfolgreich"' "$INSTALL/data/update/status.json"
grep -q '{env.DUCKDNS_DOMAIN}' "$INSTALL/caddy/Caddyfile"
grep -q 'dns duckdns {env.DUCKDNS_API_TOKEN}' "$INSTALL/caddy/Caddyfile"
! grep -Rqs "$DUCK_SECRET" "$INSTALL/data/update/status.json" "$INSTALL/data/update/update.log" "$INSTALL/data/update/agent.json" "$TMP/docker.log"

# Oberfläche nur über HTTPS: offene Bestätigung im Heartbeat, Quittung der App
# schließt sie; ohne Quittung öffnet der Agent nach Ablauf wieder.
freigabe_auftrag() { # $1 nonce $2 wert
  printf 'protokoll=2\ntyp=freigabe\nnonce=%s\nangefordertAm=%s\nangefordertVon=test\nwert=%s\n' \
    "$1" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$2" > "$INSTALL/data/update/anforderung.kv"
}
freigabe_auftrag 55555555555555555555555555555555 web:lokal
run_agent
grep -q '"status": "erfolgreich"' "$INSTALL/data/update/status.json"
grep -q '^WEB_BIND=127.0.0.1$' "$INSTALL/.env"
grep -q '"web": "lokal"' "$INSTALL/data/update/agent.json"
grep -q '"webBestaetigungBis": "20' "$INSTALL/data/update/agent.json"
printf 'nonce=55555555555555555555555555555555\n' > "$INSTALL/data/update/bestaetigung.kv"
run_agent
grep -q '"webBestaetigungBis": null' "$INSTALL/data/update/agent.json"
grep -q '^WEB_BIND=127.0.0.1$' "$INSTALL/.env"
[[ ! -e "$INSTALL/data/update/bestaetigung.kv" ]]

freigabe_auftrag 66666666666666666666666666666666 web:lokal
run_agent
# Falsche Nonce zählt nicht; Ablauf simulieren.
printf 'nonce=55555555555555555555555555555555\n' > "$INSTALL/data/update/bestaetigung.kv"
printf 'nonce=66666666666666666666666666666666\nbis=1\n' > "$LIB/state/web-bestaetigung"
run_agent
grep -q '^WEB_BIND=$' "$INSTALL/.env"
grep -q '"phase": "zurueckgenommen"' "$INSTALL/data/update/status.json"
grep -q '"webBestaetigungBis": null' "$INSTALL/data/update/agent.json"
grep -q '"web": "lan"' "$INSTALL/data/update/agent.json"

freigabe_auftrag 77777777777777777777777777777777 scanner:lokal
run_agent
grep -q '^SCANNER_BIND=127.0.0.1$' "$INSTALL/.env"
grep -q '"scanner": "lokal"' "$INSTALL/data/update/agent.json"
grep -q '"webBestaetigungBis": null' "$INSTALL/data/update/agent.json"

printf 'Agent-P2-Harness: OK\n'
