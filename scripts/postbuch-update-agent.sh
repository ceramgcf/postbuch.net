#!/usr/bin/env bash
#
# postbuch-update-agent.sh — der Host-Agent für In-GUI-Updates
#
# ── Warum es diesen Agenten gibt ──────────────────────────────────────────────
# Der `app`-Container bleibt unprivilegiert: kein Docker-Socket, kein Mount des
# Quellbaums, kein `docker`-Aufruf. Die App darf ein Update *anfordern*, niemals
# ausführen. Ausgeführt wird es hier — auf dem Host, mit den Rechten, die
# `docker compose` braucht.
#
# ── Ablauf pro Tick ───────────────────────────────────────────────────────────
#   1. Heartbeat nach agent.json schreiben (AUCH ohne Arbeit — nur daran
#      erkennt die App, dass es einen Agenten gibt).
#   2. anforderung.kv lesen, Felder gegen Regex prüfen.
#   3. Replay-Schutz: Nonce schon in verlauf/? → abgelehnt. angefordertAm älter
#      als 10 Minuten? → abgelehnt.
#   4. status.json auf "laeuft", dann install.sh --update ausführen.
#   5. Endstatus schreiben, Lauf nach verlauf/<nonce>/ verschieben.
#
# ── Selbstüberschreibung ──────────────────────────────────────────────────────
# Das Update entpackt einen neuen Quellbaum. Läge dieses Skript darin, zöge das
# Entpacken es unter den eigenen Füßen weg — bash liest ein Skript während der
# Ausführung nach. Deshalb liegt der Agent unter /usr/local/lib/postbuch/ und
# kopiert sich vor dem eigentlichen Lauf zusätzlich nach /tmp, wo er die Kopie
# per exec ausführt.
#
# ── Konfiguration ─────────────────────────────────────────────────────────────
# /etc/postbuch-update-agent.conf (key=value), geschrieben von install.sh:
#   POSTBUCH_INSTALL_DIR=/home/pi/postbuch
#   AGENT_MODE=normal|dry-run
#
# Aufruf ohne Argument = ein Tick (für systemd-Timer/cron).

set -uo pipefail

PROTOKOLL=2
CONF="${POSTBUCH_AGENT_CONF:-/etc/postbuch-update-agent.conf}"
AGENT_LIB="${POSTBUCH_AGENT_LIB:-/usr/local/lib/postbuch}"
MAX_ALTER_MIN=10
VERLAUF_BEHALTEN=5

# ── Konfiguration laden ──────────────────────────────────────────────────────
INSTALL_DIR=""
AGENT_MODE="normal"
if [[ -f "$CONF" ]]; then
    while IFS='=' read -r k v; do
        case "$k" in
            POSTBUCH_INSTALL_DIR) INSTALL_DIR="$v" ;;
            AGENT_MODE)           AGENT_MODE="$v" ;;
        esac
    done < "$CONF"
fi
INSTALL_DIR="${POSTBUCH_INSTALL_DIR:-$INSTALL_DIR}"
AGENT_MODE="${POSTBUCH_AGENT_MODE:-$AGENT_MODE}"

[[ "$AGENT_MODE" == "dry-run" ]] || AGENT_MODE="normal"

if [[ -z "$INSTALL_DIR" || ! -d "$INSTALL_DIR" ]]; then
    echo "postbuch-update-agent: POSTBUCH_INSTALL_DIR fehlt oder existiert nicht ($CONF)" >&2
    exit 1
fi

UPDATE_DIR="$INSTALL_DIR/data/update"
ANFORDERUNG="$UPDATE_DIR/anforderung.kv"
AGENT_JSON="$UPDATE_DIR/agent.json"
STATUS_JSON="$UPDATE_DIR/status.json"
PUBLIC_LOGFILE="$UPDATE_DIR/update.log"
STATE_DIR="${POSTBUCH_AGENT_STATE_DIR:-$AGENT_LIB/state}"
LOGFILE="$STATE_DIR/update.log"
VERLAUF="$STATE_DIR/verlauf"
INSTALL_OWNER=$(stat -c '%u:%g' "$INSTALL_DIR") || {
    echo "postbuch-update-agent: Besitzer von $INSTALL_DIR nicht bestimmbar" >&2
    exit 1
}

# Der Agent braucht root für Docker, darf aber im benutzereigenen
# Installationsbaum keine root-eigenen Karteileichen hinterlassen.
installationsbesitz_setzen() {
    [[ $(id -u) -eq 0 ]] || return 0
    chown -h "$INSTALL_OWNER" "$@"
}

hostdateien_besitz_reparieren() {
    local pfad
    for pfad in "$INSTALL_DIR/.env" "$INSTALL_DIR/restart.sh" \
        "$INSTALL_DIR/.postbuch-vertrauen" "$INSTALL_DIR/caddy/Caddyfile"; do
        [[ -e "$pfad" || -L "$pfad" ]] || continue
        installationsbesitz_setzen "$pfad" || return 1
    done
}

mkdir -p "$STATE_DIR" "$VERLAUF" 2>/dev/null || {
    echo "postbuch-update-agent: privates Statusverzeichnis nicht beschreibbar: $STATE_DIR" >&2
    exit 1
}
chmod 700 "$STATE_DIR" "$VERLAUF" 2>/dev/null || true
if command -v flock >/dev/null 2>&1; then
    exec 9>"$STATE_DIR/agent.lock"
    flock -n 9 || exit 0
fi
# Installer, die dieser Agent startet, nehmen die Sperre nicht noch einmal
# (sie wäre belegt, der Installer würde auf seinen eigenen Aufrufer warten).
export POSTBUCH_AGENT_SPERRE=1

# Läuft gerade ein Installer, den nicht dieser Agent gestartet hat? Installer
# ab dem nächsten Release nehmen die Sperre oben selbst; ältere nicht. Deren
# einzige verlässliche Spur seit 2.10 ist der tee-Prozess ihres Protokolls
# (…/postbuch/logs/install-*.log), auch bei `curl … | bash`, wo „install.sh“
# in keiner Befehlszeile steht. Nur der Abgleich ohne Auftrag fragt das ab:
# Er würde sonst mitten in ein Update von Hand hinein Container ersetzen.
fremder_installer_laeuft() {
    local f arg
    for f in /proc/[0-9]*/cmdline; do
        while IFS= read -r -d '' arg; do
            [[ "$arg" == */postbuch/logs/install-*.log ]] && return 0
        done < "$f" 2>/dev/null
    done
    return 1
}

# ── docker-Aufrufart ermitteln ───────────────────────────────────────────────
# Nur zur Anzeige im GUI: ohne docker-Rechte wird der Installieren-Button VORAB
# deaktiviert, statt dass erst der Lauf scheitert.
if docker info >/dev/null 2>&1; then
    DOCKER_ART="direkt"
elif command -v sudo >/dev/null 2>&1 && sudo -n docker info >/dev/null 2>&1; then
    DOCKER_ART="sudo"
else
    DOCKER_ART=""
fi

# ── Heartbeat ────────────────────────────────────────────────────────────────
schreibbar_pruefen() {
    # Fehlt data/, etwa während einer Neuinstallation in dieses Verzeichnis,
    # legt der Agent nichts an: Ein root-eigenes data/ ließe den Installer scheitern.
    [[ -d "$INSTALL_DIR/data" ]] || { echo "false"; return; }
    if [[ ! -d "$UPDATE_DIR" ]] && mkdir "$UPDATE_DIR" 2>/dev/null; then
        installationsbesitz_setzen "$UPDATE_DIR" || true
    fi
    local probe
    probe=$(mktemp "$UPDATE_DIR/.schreibprobe.XXXXXX" 2>/dev/null) || { echo "false"; return; }
    rm -f -- "$probe"
    echo "true"
}

atomar_schreiben() {   # $1 = Zieldatei, stdin = Inhalt
    local ziel="$1" tmp
    tmp=$(mktemp "${ziel}.tmp.XXXXXX") || return 1
    cat > "$tmp" 2>/dev/null || return 1
    chmod 644 "$tmp" 2>/dev/null || true
    mv -fT -- "$tmp" "$ziel" || return 1
    installationsbesitz_setzen "$ziel"
}

log_veroeffentlichen() {
    [[ -f "$LOGFILE" && ! -L "$LOGFILE" ]] || return 0
    local tmp
    tmp=$(mktemp "$UPDATE_DIR/.update.log.XXXXXX") || return 0
    tail -c 1048576 "$LOGFILE" > "$tmp" 2>/dev/null || true
    chmod 644 "$tmp" 2>/dev/null || true
    if mv -fT -- "$tmp" "$PUBLIC_LOGFILE" 2>/dev/null; then
        installationsbesitz_setzen "$PUBLIC_LOGFILE" 2>/dev/null || true
    else
        rm -f -- "$tmp"
    fi
}

# Primäre LAN-Schnittstelle als {"ip","prefix"} oder "null". Der app-Container
# hängt in einer Docker-Bridge und sieht die echte Subnetzmaske des Hosts nicht
# — nur der Agent auf dem Host kann sie liefern. Zwei Wege, in dieser Reihenfolge:
#   1. Interface der Default-Route — der zuverlässigste Anker, ignoriert die
#      Docker-Bridges (br-*/docker0) von selbst.
#   2. Fallback: die erste IPv4 aus `hostname -I` (dieselbe Quelle, die install.sh
#      als LAN-IP nutzt); der Prefix wird aus `ip addr` derselben Adresse geholt.
# Ausgabe ist rein numerisch und streng geprüft; die App validiert zusätzlich.
lan_json() {
    command -v ip >/dev/null 2>&1 || { printf 'null'; return; }
    local dev='' cidr='' addr='' prefix='' ip1=''
    dev=$(ip -o -4 route show default 2>/dev/null \
        | awk '{for(i=1;i<=NF;i++) if($i=="dev"){print $(i+1); exit}}')
    [[ -n "$dev" ]] && cidr=$(ip -o -4 addr show dev "$dev" scope global 2>/dev/null | awk '{print $4; exit}')
    if [[ -z "$cidr" ]]; then
        ip1=$(hostname -I 2>/dev/null | awk '{print $1}')
        [[ -n "$ip1" ]] && cidr=$(ip -o -4 addr show scope global 2>/dev/null \
            | awk -v a="$ip1" '$4 ~ ("^" a "/"){print $4; exit}')
    fi
    [[ "$cidr" =~ ^([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})/([0-9]{1,2})$ ]] \
        || { printf 'null'; return; }
    addr="${BASH_REMATCH[1]}"; prefix="${BASH_REMATCH[2]}"
    (( prefix >= 1 && prefix <= 32 )) || { printf 'null'; return; }
    printf '{ "ip": "%s", "prefix": %s }' "$addr" "$prefix"
}

# Freigabe eines Ports aus der .env im festen Vokabular lan|lokal|anders.
bind_lesen() { # $1 Key (SCANNER_BIND|WEB_BIND)
    local wert
    wert=$(grep "^$1=" "$INSTALL_DIR/.env" 2>/dev/null | tail -n1 | cut -d= -f2- || true)
    case "$wert" in
        ''|0.0.0.0|'::') echo lan ;;
        127.0.0.1|localhost|'::1') echo lokal ;;
        *) echo anders ;;
    esac
}

# Offene Bestätigung nach „Oberfläche nur über HTTPS“: Epoch-Sekunden oder leer.
WEB_BESTAETIGUNG="$STATE_DIR/web-bestaetigung"
web_bestaetigung_bis() {
    [[ -f "$WEB_BESTAETIGUNG" ]] || return 0
    local k v
    while IFS='=' read -r k v; do
        [[ "$k" == bis && "$v" =~ ^[0-9]{1,12}$ ]] && { echo "$v"; return 0; }
    done < "$WEB_BESTAETIGUNG"
}

# ── Stack-Zustand für den Reiter „Stack“ ────────────────────────────────────
# Alles aus festem Vokabular oder streng gefiltert; Namen, Zustände und Zahlen
# werden vor der JSON-Ausgabe geprüft. Die GPU-Abfrage ist teuer (nvidia-smi
# kann hängen) und wird zehn Minuten zwischengespeichert.
GPU_CACHE="$STATE_DIR/gpu.kv"
STACK_DIENSTE='postbuch-postgres postbuch-app postbuch-web postbuch-embedding postbuch-llm postbuch-scanner postbuch-cleaner postbuch-caddy'

stack_bibliothek() {
    declare -F hostconfig_gpu_erkennen >/dev/null && return 0
    [[ -r "$AGENT_LIB/postbuch-hostconfig.sh" ]] || return 1
    # shellcheck source=postbuch-hostconfig.sh
    source "$AGENT_LIB/postbuch-hostconfig.sh"
}

gpu_lesen() { # gibt "vramMiB|name|dockerBereit" aus oder nichts
    local alter=999999 zeile
    [[ -f "$GPU_CACHE" ]] && alter=$(( $(date +%s) - $(stat -c %Y -- "$GPU_CACHE" 2>/dev/null || echo 0) ))
    if (( alter > 600 )); then
        zeile=$(hostconfig_gpu_erkennen 2>/dev/null) || zeile=''
        printf '%s\n' "$zeile" > "$GPU_CACHE" 2>/dev/null || true
    else
        zeile=$(head -n1 -- "$GPU_CACHE" 2>/dev/null)
    fi
    [[ "$zeile" =~ ^[0-9]{1,7}\|[A-Za-z0-9\ ._()-]{0,128}\|(true|false)$ ]] && printf '%s' "$zeile"
}

dienste_json() {
    local zeile name zustand status image health groesse erster=true
    printf '['
    while IFS='|' read -r name zustand status image; do
        [[ " $STACK_DIENSTE " == *" $name "* ]] || continue
        [[ "$zustand" =~ ^[a-z]{1,20}$ ]] || continue
        case "$status" in
            *'(healthy)'*) health=healthy ;;
            *'(unhealthy)'*) health=unhealthy ;;
            *'health: starting'*) health=starting ;;
            *) health=none ;;
        esac
        groesse=null
        if [[ "$image" =~ ^[A-Za-z0-9._/:@-]{1,300}$ ]]; then
            groesse=$(hostconfig_docker image inspect --format '{{.Size}}' -- "$image" 2>/dev/null | head -n1)
            [[ "$groesse" =~ ^[0-9]{1,15}$ ]] || groesse=null
        fi
        $erster || printf ', '
        erster=false
        printf '{ "name": "%s", "zustand": "%s", "health": "%s", "imageBytes": %s }' \
            "$name" "$zustand" "$health" "$groesse"
    done < <(hostconfig_docker ps -a --filter 'name=^postbuch-' \
                --format '{{.Names}}|{{.State}}|{{.Status}}|{{.Image}}' 2>/dev/null)
    printf ']'
}

# Modelle der lokalen KI: Bedarf der passenden Stufe und was davon vorliegt.
lokalki_json() {
    local gpu="$1" vram='' dir zeile rolle datei sha bytes url vorhanden=0 voll=true groesse
    local profil=false stufe_aktiv modell_aktiv
    hostconfig_profil_aktiv "$INSTALL_DIR/.env" lokalki && profil=true
    stufe_aktiv=$(hostconfig_env_lesen "$INSTALL_DIR/data/lokalki.env" POSTBUCH_LOKALKI_STUFE)
    modell_aktiv=$(hostconfig_env_lesen "$INSTALL_DIR/data/lokalki.env" POSTBUCH_LOKALKI_MODELL)
    [[ "$stufe_aktiv" =~ ^[a-z0-9-]{1,32}$ ]] || stufe_aktiv=''
    [[ "$modell_aktiv" =~ ^[a-z0-9][a-z0-9.-]{0,63}$ ]] || modell_aktiv=''
    if ! hostconfig_lokalki_manifest "$INSTALL_DIR"; then
        printf '{ "profilAktiv": %s, "stufe": "%s", "modell": "%s", "bedarf": null }' "$profil" "$stufe_aktiv" "$modell_aktiv"
        return
    fi
    [[ -n "$gpu" && "${gpu##*|}" == true ]] && vram="${gpu%%|*}"
    hostconfig_lokalki_stufe "$vram" || { printf 'null'; return; }
    dir=$(hostconfig_modelle_dir "$INSTALL_DIR" lesen) || dir=''
    local gesamt=0
    while IFS='|' read -r rolle datei sha bytes url; do
        [[ -n "$datei" ]] || continue
        gesamt=$(( gesamt + bytes ))
        if [[ -n "$dir" ]] && hostconfig_datei_fertig "$dir" "$datei" "$sha" "$bytes"; then
            vorhanden=$(( vorhanden + bytes ))
        else
            voll=false
            groesse=0
            [[ -n "$dir" ]] && groesse=$(stat -c %s -- "$dir/$datei.part" 2>/dev/null || echo 0)
            [[ "$groesse" =~ ^[0-9]{1,15}$ ]] && vorhanden=$(( vorhanden + groesse ))
        fi
    done < <(hostconfig_lokalki_stufe_dateien)
    printf '{ "profilAktiv": %s, "stufe": "%s", "modell": "%s", "bedarf": { "modell": "%s", "stufe": "%s", "gpu": %s, "kontext": %s, "ramMiB": %s, "bytes": %s }, "vorhandenBytes": %s, "vollstaendig": %s }' \
        "$profil" "$stufe_aktiv" "$modell_aktiv" "$LK_MODELL" "$LK_STUFE" \
        "$([[ "$LK_GPU" == ja ]] && echo true || echo false)" "$LK_KONTEXT" "$LK_RAM" "$gesamt" "$vorhanden" "$voll"
}

stack_json() {
    local gpu gpu_json=null dir frei ram
    stack_bibliothek || { printf 'null'; return; }
    gpu=$(gpu_lesen)
    if [[ -n "$gpu" ]]; then
        IFS='|' read -r vram name bereit <<< "$gpu"
        # Im Heartbeat zählt VRAM nur, wenn der Host-Agent CUDA starten darf.
        hostconfig_cuda_akzeptiert "$INSTALL_DIR" || { bereit=false; gpu="${gpu%|*}|false"; }
        gpu_json=$(printf '{ "name": "%s", "vramMiB": %s, "dockerBereit": %s }' "$name" "$vram" "$bereit")
    fi
    dir=$(hostconfig_modelle_dir "$INSTALL_DIR" lesen) || dir="$INSTALL_DIR"
    frei=$(df -B1 --output=avail -- "$dir" 2>/dev/null | tail -n1 | tr -d ' ')
    [[ "$frei" =~ ^[0-9]{1,15}$ ]] || frei=null
    ram=$(hostconfig_ram_mib 2>/dev/null) || ram=null
    printf '{ "gpu": %s, "dienste": %s, "lokalki": %s, "platteFreiBytes": %s, "ramMiB": %s }' \
        "$gpu_json" "$(dienste_json)" "$(lokalki_json "$gpu")" "$frei" "$ram"
}

heartbeat() {
    local schreibbar lan scanner_profil=false embedding_profil=false bis bestaetigung=null
    schreibbar=$(schreibbar_pruefen)
    [[ "$schreibbar" == "true" ]] || return 0
    lan=$(lan_json)
    if [[ -f "$INSTALL_DIR/.env" ]] \
      && grep -Eq '^COMPOSE_PROFILES=([^,]*,)*scanner(,|$)' "$INSTALL_DIR/.env" 2>/dev/null; then
        scanner_profil=true
    fi
    if [[ -f "$INSTALL_DIR/.env" ]] \
      && grep -Eq '^COMPOSE_PROFILES=([^,]*,)*embedding(,|$)' "$INSTALL_DIR/.env" 2>/dev/null; then
        embedding_profil=true
    fi
    bis=$(web_bestaetigung_bis)
    [[ -n "$bis" ]] && bestaetigung="\"$(date -u -d "@$bis" '+%Y-%m-%dT%H:%M:%SZ')\""
    atomar_schreiben "$AGENT_JSON" <<EOF
{
  "version": $PROTOKOLL,
  "agentVersion": "2.11",
  "capabilities": ["update", "zielversion", "netzwerk", "module", "embedding", "port", "freigabe", "postgres-umzug", "lokalki", "entfernen", "stack", "ablage", "duckdns-schalter"],
  "modus": "$AGENT_MODE",
  "docker": "${DOCKER_ART:-null}",
  "letzterLaufAm": "$(date -u '+%Y-%m-%dT%H:%M:%SZ')",
  "schreibbar": $schreibbar,
  "scannerProfilAktiv": $scanner_profil,
  "embeddingProfilAktiv": $embedding_profil,
  "lan": $lan,
  "freigaben": { "scanner": "$(bind_lesen SCANNER_BIND)", "web": "$(bind_lesen WEB_BIND)" },
  "webBestaetigungBis": $bestaetigung,
  "duckdnsIp": $(duckdns_json),
  "stack": $(stack_json)
}
EOF
}

# JSON-Ausgabe aus FESTEM Vokabular — keine Fremddaten, kein Escaping nötig.
# Genau deshalb ist die Richtung Agent → App JSON und die Richtung App → Agent
# key=value: hier schreibt der Bash-Teil, dort liest er.
status_schreiben() {   # $1 nonce  $2 status  $3 phase  $4 exitCode|""  $5 meldung  $6 typ  $7 Bytes  $8 gesamt
    local beendet="" bytes="${7:-}" gesamt="${8:-}"
    [[ "$bytes" =~ ^[0-9]{1,15}$ ]] || bytes=null
    [[ "$gesamt" =~ ^[0-9]{1,15}$ ]] || gesamt=null
    [[ -n "${4:-}" ]] && beendet="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    local exitcode="${4:-}"
    [[ -z "$exitcode" ]] && exitcode="null"
    local typ="${6:-update}"
    atomar_schreiben "$STATUS_JSON" <<EOF
{
  "nonce": "$1",
  "status": "$2",
  "phase": "$3",
  "typ": "$typ",
  "begonnenAm": "${BEGONNEN_AM:-}",
  "beendetAm": "$beendet",
  "exitCode": $exitcode,
  "meldung": "$5",
  "fortschrittBytes": $bytes,
  "gesamtBytes": $gesamt
}
EOF
}

log() {
    printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOGFILE"
    log_veroeffentlichen
}

# ── Anforderung lesen und prüfen ─────────────────────────────────────────────
# Bewusst key=value statt JSON: ein JSON-Parser in Bash wäre entweder eine
# Abhängigkeit (jq) oder gebastelt. Jedes Feld wird gegen eine Regex geprüft;
# nichts davon wird je als Shell-Code ausgewertet.
lies_anforderung() {   # $1 = sichere private Kopie
    A_PROTOKOLL=""; A_TYP="update"; A_NONCE=""; A_ZIEL=""; A_AM=""; A_VON=""; A_SHA=""; A_WERT=""; A_SECRET=""; A_PFAD=""
    local k v
    while IFS='=' read -r k v; do
        case "$k" in
            protokoll)        [[ "$v" =~ ^[0-9]{1,3}$ ]]                  && A_PROTOKOLL="$v" ;;
            typ)              [[ "$v" =~ ^(update|netzwerk|module|port|duckdns|freigabe|ablage)$ ]] && A_TYP="$v" ;;
            nonce)            [[ "$v" =~ ^[0-9a-f]{32}$ ]]                && A_NONCE="$v" ;;
            zielVersion)      [[ "$v" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){2}$ ]] && A_ZIEL="$v" ;;
            angefordertAm)    [[ "$v" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] && A_AM="$v" ;;
            angefordertVon)   [[ "$v" =~ ^[A-Za-z0-9._-]{1,40}$ ]]        && A_VON="$v" ;;
            erwarteterSha256) [[ "$v" =~ ^[0-9a-f]{64}$ ]]                && A_SHA="$v" ;;
            wert)             [[ "$v" =~ ^[A-Za-z0-9.:/_-]{1,300}$ ]]     && A_WERT="$v" ;;
            secret)           [[ "$v" =~ ^[A-Za-z0-9._-]{1,512}$ ]]       && A_SECRET="$v" ;;
            # Ordnerpfad der lokalen Ablage, Base64; geprüft wird er in der Bibliothek.
            pfad)             [[ "$v" =~ ^[A-Za-z0-9+/]{4,1100}={0,2}$ ]] && A_PFAD="$v" ;;
        esac
    done < "$1"
    [[ -n "$A_PROTOKOLL" && -n "$A_NONCE" && -n "$A_AM" ]] || return 1
    if [[ "$A_TYP" == "update" ]]; then
        [[ "$A_PROTOKOLL" == "1" && -n "$A_ZIEL" && -n "$A_SHA" ]]
    elif [[ "$A_TYP" == "ablage" ]]; then
        [[ "$A_PROTOKOLL" == "2" && "$A_WERT" == setzen && -n "$A_PFAD" ]]
    else
        [[ "$A_PROTOKOLL" == "2" && -n "$A_WERT" ]]
    fi
}

# ── Bestätigung „Oberfläche nur über HTTPS“ ─────────────────────────────────
# Nach web:lokal muss die Person binnen zwei Minuten über HTTPS bestätigen,
# dass sie noch hineinkommt. Die App legt dazu bestaetigung.kv mit der Nonce
# des Auftrags ab. Ohne Bestätigung öffnet der Agent die Oberfläche wieder für
# das Heimnetz. Die Merkdatei liegt im privaten STATE_DIR, die App kann sie
# weder anlegen noch verlängern.
web_bestaetigung_pruefen() {
    [[ -f "$WEB_BESTAETIGUNG" ]] || return 0
    local k v nonce='' bis='' quittung="$UPDATE_DIR/bestaetigung.kv"
    while IFS='=' read -r k v; do
        case "$k" in
            nonce) [[ "$v" =~ ^[0-9a-f]{32}$ ]] && nonce="$v" ;;
            bis)   [[ "$v" =~ ^[0-9]{1,12}$ ]] && bis="$v" ;;
        esac
    done < "$WEB_BESTAETIGUNG"
    if [[ -z "$nonce" || -z "$bis" ]]; then
        rm -f -- "$WEB_BESTAETIGUNG"
        return 0
    fi
    if [[ -f "$quittung" && ! -L "$quittung" ]] && grep -qxF "nonce=$nonce" "$quittung" 2>/dev/null; then
        rm -f -- "$WEB_BESTAETIGUNG" "$quittung"
        log "Oberfläche nur über HTTPS bestätigt (nonce=$nonce)."
        heartbeat
        return 0
    fi
    (( $(date -u '+%s') > bis )) || return 0
    rm -f -- "$WEB_BESTAETIGUNG" "$quittung"
    log "Keine Bestätigung binnen zwei Minuten (nonce=$nonce) — Oberfläche wird wieder für das Heimnetz geöffnet."
    local hostconfig="$AGENT_LIB/postbuch-hostconfig.sh"
    if [[ -r "$hostconfig" ]]; then
        # shellcheck source=postbuch-hostconfig.sh
        source "$hostconfig"
        if ( cd "$INSTALL_DIR" && hostconfig_env_setzen "$INSTALL_DIR/.env" WEB_BIND '' && hostconfig_web_neu_erstellen ); then
            rm -f -- "$INSTALL_DIR/.env.hostconfig.bak"
            hostdateien_besitz_reparieren || true
            status_schreiben "$nonce" "fehlgeschlagen" "zurueckgenommen" 1 \
                "Nicht bestätigt – die Oberfläche ist wieder im Heimnetz erreichbar." "freigabe"
            heartbeat
            return 0
        fi
    fi
    hostdateien_besitz_reparieren || true
    log "Wiederöffnen fehlgeschlagen — bitte scripts/zugang-heimnetz-oeffnen.sh auf dem Host ausführen."
    status_schreiben "$nonce" "fehlgeschlagen" "zurueckgenommen" 1 \
        "Nicht bestätigt, Wiederöffnen fehlgeschlagen. Notausgang: scripts/zugang-heimnetz-oeffnen.sh auf dem Host." "freigabe"
    heartbeat
}

# ── PostgreSQL-Umzug ohne Auftrag ────────────────────────────────────────────
# Installer bis 2.11 bringen 2.12 hoch, lassen aber PostgreSQL 16 weiterlaufen
# und tauschen danach diesen Agenten aus. Der neue Agent holt den Umzug beim
# nächsten Tick einmalig je installierter Version nach. Schlägt er fehl, bleibt
# PostgreSQL 16 in Betrieb; die App zeigt dann den Befehl für einen neuen Versuch.
postgres_umzug_automatisch() {
    [[ "$AGENT_MODE" == "normal" ]] || return 0
    local pgdir="$INSTALL_DIR/data/postgres" skript="$INSTALL_DIR/scripts/postgres-umzug.sh"
    [[ -x "$skript" && -x "$AGENT_LIB/install.sh" ]] || return 0
    [[ -f "$pgdir/PG_VERSION" || -d "$pgdir/umzug" ]] || return 0
    local version marker nonce exitcode
    version=$(tr -d '[:space:]' < "$INSTALL_DIR/VERSION" 2>/dev/null || true)
    [[ "$version" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){2}(-[A-Za-z0-9.]+)?$ ]] || return 0
    marker="$STATE_DIR/postgres-umzug-$version"
    [[ -e "$marker" ]] && return 0
    fremder_installer_laeuft && return 0   # nächster Takt, wenn er fertig ist
    date -u '+%Y-%m-%dT%H:%M:%SZ' > "$marker"
    # Folgt der Umzug direkt auf ein erfolgreiches Update, läuft er unter dessen
    # Nonce weiter. Der Update-Dialog im Browser (noch aus der alten Version)
    # wartet auf genau diese Nonce und verwirft jeden Status mit einer anderen.
    local erfolg="Datenbank auf PostgreSQL 18 umgezogen."
    nonce=$(vorige_update_nonce)
    if [[ -n "$nonce" ]]; then
        erfolg="Update abgeschlossen, Datenbank auf PostgreSQL 18 umgezogen."
    else
        nonce=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
    fi
    BEGONNEN_AM="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    : > "$LOGFILE"
    chmod 600 "$LOGFILE" 2>/dev/null || true
    log "Datenbank von PostgreSQL $(tr -d '[:space:]' < "$pgdir/PG_VERSION" 2>/dev/null || echo '?') umziehen (Version $version, nonce=$nonce)"
    status_schreiben "$nonce" "laeuft" "datenbank" "" "Datenbank wird umgezogen." "update"
    "$AGENT_LIB/install.sh" --postgres-umzug --yes --non-interactive "--install-dir=$INSTALL_DIR" 2>&1 \
        | while IFS= read -r zeile; do
            printf '%s\n' "$zeile" >> "$LOGFILE"
            log_veroeffentlichen
            if [[ "$zeile" == *"##PHASE:"* ]]; then
                phase="${zeile##*##PHASE:}"
                phase="${phase%%[^a-z]*}"
                [[ -n "$phase" ]] && status_schreiben "$nonce" "laeuft" "$phase" "" "Datenbank wird umgezogen." "update"
            fi
        done
    exitcode=${PIPESTATUS[0]}
    if [[ "$exitcode" -eq 0 ]]; then
        log "Datenbank-Umzug abgeschlossen."
        status_schreiben "$nonce" "erfolgreich" "fertig" 0 "$erfolg" "update"
    else
        log "Datenbank-Umzug fehlgeschlagen (Exit $exitcode)."
        status_schreiben "$nonce" "fehlgeschlagen" "fehler" "$exitcode" \
            "Der Datenbank-Umzug ist fehlgeschlagen (Exit $exitcode). Details stehen im Protokoll." "update"
    fi
    # Eigene Dateinamen: Bei übernommener Nonce liegen dort schon Status und
    # Protokoll des Updates.
    mkdir -p "$VERLAUF/$nonce" 2>/dev/null || true
    cp -f "$STATUS_JSON" "$VERLAUF/$nonce/datenbank-status.json" 2>/dev/null || true
    cp -f "$LOGFILE"     "$VERLAUF/$nonce/datenbank.log"         2>/dev/null || true
    heartbeat
    exit "$exitcode"
}

# ── PostgreSQL-Image ohne Auftrag ────────────────────────────────────────────
# Ein Release kann den Digest des PostgreSQL-Images anheben. Beim Update läuft
# noch der Installer der Vorversion, der den Datenbankcontainer nie ersetzt.
# Der neue Agent holt den Tausch deshalb beim nächsten Tick einmalig je
# installierter Version nach (mit Backup, nur gleiche Hauptversion). Ist
# nichts zu tun, endet der Installer ohne Phase, und der Status bleibt stehen.
postgres_image_automatisch() {
    [[ "$AGENT_MODE" == "normal" ]] || return 0
    [[ -x "$AGENT_LIB/install.sh" ]] || return 0
    grep -q -- '--postgres-image)' "$AGENT_LIB/install.sh" 2>/dev/null || return 0
    [[ -d "$INSTALL_DIR/data/postgres" ]] || return 0
    local version marker nonce erfolg exitcode protokoll begonnen=0 zeile phase
    version=$(tr -d '[:space:]' < "$INSTALL_DIR/VERSION" 2>/dev/null || true)
    [[ "$version" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){2}(-[A-Za-z0-9.]+)?$ ]] || return 0
    marker="$STATE_DIR/postgres-image-$version"
    [[ -e "$marker" ]] && return 0
    fremder_installer_laeuft && return 0   # nächster Takt, wenn er fertig ist
    date -u '+%Y-%m-%dT%H:%M:%SZ' > "$marker"
    erfolg="Datenbank-Image aktualisiert."
    nonce=$(vorige_update_nonce)
    if [[ -n "$nonce" ]]; then
        erfolg="Update abgeschlossen, Datenbank-Image aktualisiert."
    else
        nonce=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
    fi
    protokoll=$(mktemp) || return 0
    chmod 600 "$protokoll" 2>/dev/null || true
    BEGONNEN_AM="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    while IFS= read -r zeile; do
        printf '%s\n' "$zeile" >> "$protokoll"
        [[ "$zeile" == "##EXIT:"* ]] && continue
        [[ "$zeile" == *"##PHASE:"* ]] || { [[ "$begonnen" -eq 1 ]] && printf '%s\n' "$zeile" >> "$LOGFILE" && log_veroeffentlichen; continue; }
        phase="${zeile##*##PHASE:}"
        phase="${phase%%[^a-z]*}"
        if [[ "$begonnen" -eq 0 ]]; then
            begonnen=1
            cp -f "$protokoll" "$LOGFILE" 2>/dev/null || true
            chmod 600 "$LOGFILE" 2>/dev/null || true
            log "PostgreSQL-Image aktualisieren (Version $version, nonce=$nonce)"
        else
            printf '%s\n' "$zeile" >> "$LOGFILE"
        fi
        log_veroeffentlichen
        [[ -n "$phase" ]] && status_schreiben "$nonce" "laeuft" "$phase" "" "Datenbank-Image wird aktualisiert." "update"
    done < <("$AGENT_LIB/install.sh" --postgres-image --yes --non-interactive "--install-dir=$INSTALL_DIR" 2>&1; echo "##EXIT:$?")
    exitcode=$(grep -o '##EXIT:[0-9]*' "$protokoll" | tail -n 1 | cut -d: -f2 || true)
    rm -f "$protokoll"
    [[ "$begonnen" -eq 1 ]] || return 0
    if [[ "${exitcode:-1}" -eq 0 ]]; then
        log "Datenbank-Image aktualisiert."
        status_schreiben "$nonce" "erfolgreich" "fertig" 0 "$erfolg" "update"
    else
        log "Datenbank-Image nicht aktualisiert (Exit ${exitcode:-?})."
        status_schreiben "$nonce" "fehlgeschlagen" "fehler" "${exitcode:-1}" \
            "Das Datenbank-Image wurde nicht aktualisiert (Exit ${exitcode:-?}). Details stehen im Protokoll." "update"
    fi
    mkdir -p "$VERLAUF/$nonce" 2>/dev/null || true
    cp -f "$STATUS_JSON" "$VERLAUF/$nonce/datenbank-image-status.json" 2>/dev/null || true
    cp -f "$LOGFILE"     "$VERLAUF/$nonce/datenbank-image.log"         2>/dev/null || true
    heartbeat
    exit "${exitcode:-1}"
}

# Fortschritt langer Hostaufträge (Modell-Download der lokalen KI). Die
# Meldungen stammen aus festem Vokabular, Zahlen prüft status_schreiben.
# Liest A_NONCE/A_TYP des laufenden Auftrags.
hostconfig_fortschritt_hook() { # $1 Bytes $2 gesamt $3 phase
    local meldung jetzt
    case "$3" in
        download) meldung="Modell wird heruntergeladen." ;;
        pruefung) meldung="Modelldatei wird geprüft." ;;
        image)    meldung="Programm der lokalen KI wird heruntergeladen." ;;
        start)    meldung="Lokale KI startet." ;;
        kopie)    meldung="Ablage wird kopiert." ;;
        start_app) meldung="Anwendung startet mit dem neuen Ablageordner." ;;
        *) return 0 ;;
    esac
    status_schreiben "$A_NONCE" "laeuft" "$3" "" "$meldung" "$A_TYP" "$1" "$2"
    jetzt=$(date +%s)
    if (( jetzt - ${FORTSCHRITT_HEARTBEAT:-0} >= 30 )); then
        FORTSCHRITT_HEARTBEAT=$jetzt
        heartbeat
    fi
}

# ── Modell der lokalen KI ohne Auftrag ───────────────────────────────────────
# Ein Release kann das kuratierte Modell wechseln (lokal-modelle.kv). Läuft die
# lokale KI noch mit dem alten, richtet der Agent das neue genauso ein wie beim
# Einschalten: laden, prüfen, umschalten, Gesundheit abwarten, erst dann die
# alten Dateien löschen. Scheitert etwas, läuft das alte Modell weiter
# (Rücktausch in hostconfig_lokalki_an). Ein nur nicht rechtzeitig fertiger
# Download (rc 3) wird beim nächsten Tick fortgesetzt; jeder andere Fehlschlag
# sperrt weitere Versuche für sechs Stunden.
lokalki_modell_automatisch() {
    [[ "$AGENT_MODE" == "normal" ]] || return 0
    stack_bibliothek || return 0
    hostconfig_profil_aktiv "$INSTALL_DIR/.env" lokalki || return 0
    local aktiv marker rc=0
    aktiv=$(hostconfig_env_lesen "$INSTALL_DIR/data/lokalki.env" POSTBUCH_LOKALKI_MODELL)
    [[ -n "$aktiv" ]] || return 0
    hostconfig_lokalki_manifest "$INSTALL_DIR" || return 0
    [[ "$LK_MODELL" =~ ^[a-z0-9][a-z0-9.-]{0,63}$ && "$LK_MODELL" != "$aktiv" ]] || return 0
    marker="$STATE_DIR/lokalki-modell-$LK_MODELL"
    if [[ -f "$marker" ]] && (( $(date +%s) - $(stat -c %Y -- "$marker" 2>/dev/null || echo 0) < 21600 )); then
        return 0
    fi
    A_NONCE=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
    A_TYP=module
    mkdir -p "$VERLAUF/$A_NONCE" 2>/dev/null || true
    : > "$LOGFILE"; chmod 600 "$LOGFILE" 2>/dev/null || true
    BEGONNEN_AM="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    log "Neues Modell der lokalen KI wird eingerichtet ($aktiv -> $LK_MODELL, nonce=$A_NONCE)."
    status_schreiben "$A_NONCE" "laeuft" "hostconfig" "" "Neues Modell der lokalen KI wird eingerichtet." "$A_TYP"
    hostconfig_anwenden "$INSTALL_DIR" module lokalki:an "" || rc=$?
    hostdateien_besitz_reparieren || true
    case "$rc" in
        0) rm -f -- "$marker"
           log "Lokale KI läuft mit dem neuen Modell."
           status_schreiben "$A_NONCE" "erfolgreich" "fertig" 0 "Lokale KI auf das neue Modell umgestellt." "$A_TYP" ;;
        3) rm -f -- "$marker"
           log "Download des neuen Modells nicht rechtzeitig fertig; wird fortgesetzt."
           status_schreiben "$A_NONCE" "fehlgeschlagen" "hostconfig" 3 \
               "Download des neuen Modells nicht rechtzeitig fertig. Er wird automatisch fortgesetzt." "$A_TYP" ;;
        *) date -u '+%Y-%m-%dT%H:%M:%SZ' > "$marker"
           log "Neues Modell nicht eingerichtet (Exit $rc); das bisherige läuft weiter."
           status_schreiben "$A_NONCE" "fehlgeschlagen" "hostconfig" "$rc" \
               "$( case "$rc" in 4) echo 'Zu wenig freier Speicherplatz für das neue Modell.' ;; 5) echo 'Zu wenig Arbeitsspeicher für das neue Modell.' ;; *) echo 'Das neue Modell wurde nicht eingerichtet.' ;; esac ) Das bisherige läuft weiter." "$A_TYP" ;;
    esac
    cp -f "$STATUS_JSON" "$VERLAUF/$A_NONCE/status.json" 2>/dev/null || true
    heartbeat
    exit 0
}

# ── DuckDNS: Heimnetz-Adresse nachführen ─────────────────────────────────────
# Die DuckDNS-Domain zeigt auf die Heimnetz-Adresse dieses Rechners (TLS kommt
# per DNS-01, der Router leitet nichts weiter). Vergibt der Router eine neue
# Adresse – bei Windows-PCs und Laptops nichts Ungewöhnliches –, zeigte die
# Domain sonst ins Leere. Alle fünf Minuten wird deshalb verglichen und bei
# Bedarf über die DuckDNS-API nachgetragen, aber nur ein Eintrag, den dieser
# Rechner selbst hält: DNS muss noch genau die private Adresse liefern, die
# hier zuletzt bestätigt oder eingetragen wurde. Alles andere bleibt unberührt
# und wird nur gemeldet – ein zweiter Rechner mit derselben Domain (Umzug,
# alter Rechner läuft noch) oder eine bewusst eingetragene öffentliche Adresse
# mit Portweiterleitung. Den ersten Besitz begründet ein Treffer: DNS liefert
# die eigene Adresse (so verlangt es der Installer). Oder ein Anspruch: Wer
# die Domain in der Oberfläche mit Token einrichtet – etwa nach dem Umzug auf
# einen neuen Rechner –, übernimmt sie ausdrücklich für diesen Rechner
# ($STATE_DIR/duckdns-anspruch). Dann wird eine private oder fehlende Adresse
# einmal ersetzt; eine öffentliche bleibt auch dann stehen.
DUCKDNS_INTERVALL=300

duckdns_ip_privat() {
    [[ "$1" =~ ^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)[0-9.]+$ ]]
}

# Adresse dieses Rechners im Heimnetz (Interface der Default-Route) oder nichts.
# Unter WSL nur im gespiegelten Netz: Sonst wäre es die interne Adresse der VM.
duckdns_eigene_ip() {
    if hostconfig_ist_wsl 2>/dev/null && [[ "$(wslinfo --networking-mode 2>/dev/null)" != mirrored ]]; then
        return 0
    fi
    [[ "$(lan_json)" =~ \"ip\":\ \"([0-9.]+)\" ]] || return 0
    local ip="${BASH_REMATCH[1]}"
    duckdns_ip_privat "$ip" && printf '%s' "$ip"
}

# A-Einträge über öffentliches DNS-over-HTTPS (wie install.sh: Der Router
# verwirft mit DNS-Rebind-Schutz genau die private Antwort). 1 = nicht abfragbar.
duckdns_dns_a() {
    local antwort
    antwort=$(curl -fsS --max-time 8 -H 'accept: application/dns-json' \
        "https://cloudflare-dns.com/dns-query?name=$1&type=A" 2>/dev/null) \
        || antwort=$(curl -fsS --max-time 8 "https://dns.google/resolve?name=$1&type=A" 2>/dev/null) \
        || return 1
    # Kein A-Eintrag ist eine gültige Antwort (leer), kein Fehler.
    printf '%s' "$antwort" | { grep -oE '"data": ?"[0-9]{1,3}(\.[0-9]{1,3}){3}"' || true; } \
        | { grep -oE '[0-9]{1,3}(\.[0-9]{1,3}){3}' || true; } | sort -u
}

duckdns_ip_nachfuehren() {
    [[ "$AGENT_MODE" == "normal" ]] || return 0
    stack_bibliothek || return 0
    local env="$INSTALL_DIR/.env" merk="$STATE_DIR/duckdns-ip" standdatei="$STATE_DIR/duckdns-stand"
    local takt="$STATE_DIR/duckdns-takt" anspruchdatei="$STATE_DIR/duckdns-anspruch" domain token eigene dns erster stand
    local merk_domain='' merk_ip='' alt_stand='' alt_dns='' alt_eigene='' alt_geprueft='' aktualisiert=- jetzt anspruch='' vorher
    domain=$(hostconfig_env_lesen "$env" DUCKDNS_DOMAIN 2>/dev/null)
    token=$(hostconfig_env_lesen "$env" DUCKDNS_API_TOKEN 2>/dev/null)
    if [[ ! "$domain" =~ ^[a-z0-9-]{1,63}\.duckdns\.org$ || ! "$token" =~ ^[A-Za-z0-9._-]{8,256}$ ]]; then
        rm -f -- "$standdatei" "$takt" "$anspruchdatei"
        return 0
    fi
    [[ -f "$anspruchdatei" ]] && read -r anspruch < "$anspruchdatei"
    [[ "$anspruch" == "$domain" ]] || { anspruch=''; rm -f -- "$anspruchdatei"; }
    # Schalter aus Einstellungen → Allgemein: Die App legt die Merkdatei an, wenn
    # die Adresse nicht nachgeführt werden soll (feste IP im Heimnetz). Geprüft
    # und gemeldet wird weiter, geändert wird nichts.
    local aus=0 schalter_neu=0
    [[ -e "$UPDATE_DIR/duckdns-ip-aus" || -L "$UPDATE_DIR/duckdns-ip-aus" ]] && aus=1
    [[ -f "$standdatei" ]] && read -r alt_stand _ < "$standdatei"
    { (( aus )) && [[ "$alt_stand" != aus ]]; } || { (( ! aus )) && [[ "$alt_stand" == aus ]]; } && schalter_neu=1
    jetzt=$(date +%s)
    # Ein umgelegter Schalter wartet nicht auf den nächsten Takt.
    if (( ! schalter_neu )) && [[ -f "$takt" ]] && (( jetzt - $(stat -c %Y -- "$takt" 2>/dev/null || echo 0) < DUCKDNS_INTERVALL )); then
        return 0
    fi
    touch -- "$takt"
    # Ohne Antwort (Netz nach dem Start noch nicht da) im nächsten Takt erneut.
    dns=$(duckdns_dns_a "$domain") || return 0
    eigene=$(duckdns_eigene_ip)
    erster=$(head -n1 <<< "$dns")
    [[ -f "$merk" ]] && read -r merk_domain merk_ip < "$merk"
    if [[ -f "$standdatei" ]]; then
        read -r alt_stand alt_dns alt_eigene alt_geprueft aktualisiert _ < "$standdatei"
        [[ "$aktualisiert" =~ ^[0-9]{1,12}$ ]] || aktualisiert=-
    fi
    if (( aus )); then
        stand=aus
        # Zeigt der Eintrag auf diesen Rechner, gilt er nach dem Wiedereinschalten als eigener.
        if [[ -n "$eigene" && -n "$dns" ]] && grep -qxF "$eigene" <<< "$dns"; then
            [[ "$merk_domain $merk_ip" == "$domain $eigene" ]] || printf '%s %s\n' "$domain" "$eigene" > "$merk"
        fi
    elif [[ -z "$eigene" ]]; then
        stand=unbekannt
    elif [[ -n "$dns" ]] && grep -qxF "$eigene" <<< "$dns"; then
        stand=ok
        [[ "$merk_domain $merk_ip" == "$domain $eigene" ]] || printf '%s %s\n' "$domain" "$eigene" > "$merk"
        rm -f -- "$anspruchdatei"
    elif { [[ "$merk_domain" == "$domain" && "$dns" == "$merk_ip" ]] && duckdns_ip_privat "$merk_ip"; } \
         || { [[ -n "$anspruch" ]] && { [[ -z "$dns" ]] || { [[ "$dns" != *$'\n'* ]] && duckdns_ip_privat "$dns"; }; }; }; then
        vorher=${erster:-keine Adresse}
        # Token nur über stdin an curl, nie in der Prozessliste.
        local antwort
        antwort=$(printf 'url = "https://www.duckdns.org/update?domains=%s&token=%s&ip=%s"\n' \
            "${domain%.duckdns.org}" "$token" "$eigene" | curl -fsS --max-time 15 -K - 2>/dev/null) || antwort=''
        if [[ "$antwort" == OK* ]]; then
            stand=aktualisiert; aktualisiert=$jetzt; erster=$eigene
            printf '%s %s\n' "$domain" "$eigene" > "$merk"
            rm -f -- "$anspruchdatei"
            echo "postbuch-update-agent: DuckDNS $domain von $vorher auf $eigene nachgetragen."
        else
            # Ein Anspruch bleibt bestehen und wird im nächsten Takt erneut versucht.
            stand=fehler
            echo "postbuch-update-agent: DuckDNS hat $eigene für $domain nicht angenommen." >&2
        fi
    else
        stand=fremd
        # Öffentliche oder mehrere Adressen: bewusst gesetzt, auch ein Anspruch ändert das nicht.
        rm -f -- "$anspruchdatei"
    fi
    # Ein Nachtrag bleibt als solcher sichtbar, bis die Adresse sich wieder ändert.
    [[ "$stand" == ok && "$aktualisiert" != - && "$alt_eigene" == "$eigene" ]] && stand=aktualisiert
    printf '%s %s %s %s %s %s\n' "$stand" "${erster:--}" "${eigene:--}" "$jetzt" "$aktualisiert" "$domain" > "$standdatei"
}

# Zustand für den Heartbeat: festes Vokabular, Adressen und Zeitpunkte geprüft.
duckdns_json() {
    local f="$STATE_DIR/duckdns-stand" stand dns eigene geprueft aktualisiert domain
    [[ -f "$f" ]] || { printf 'null'; return; }
    read -r stand dns eigene geprueft aktualisiert domain < "$f"
    [[ "$stand" =~ ^(ok|aktualisiert|fremd|fehler|unbekannt|aus)$ && "$geprueft" =~ ^[0-9]{1,12}$ \
       && "$domain" =~ ^[a-z0-9-]{1,63}\.duckdns\.org$ ]] || { printf 'null'; return; }
    local ipre='^[0-9]{1,3}(\.[0-9]{1,3}){3}$' d=null e=null a=null
    [[ "$dns" =~ $ipre ]] && d="\"$dns\""
    [[ "$eigene" =~ $ipre ]] && e="\"$eigene\""
    [[ "$aktualisiert" =~ ^[0-9]{1,12}$ ]] && a="\"$(date -u -d "@$aktualisiert" '+%Y-%m-%dT%H:%M:%SZ')\""
    printf '{ "stand": "%s", "domain": "%s", "dns": %s, "eigene": %s, "geprueftAm": "%s", "aktualisiertAm": %s }' \
        "$stand" "$domain" "$d" "$e" "$(date -u -d "@$geprueft" '+%Y-%m-%dT%H:%M:%SZ')" "$a"
}

# Nonce des letzten Laufs, wenn das ein erfolgreiches Software-Update war.
vorige_update_nonce() {
    [[ -f "$STATUS_JSON" && ! -L "$STATUS_JSON" ]] || return 0
    local inhalt nonce
    inhalt=$(head -c 4096 -- "$STATUS_JSON" 2>/dev/null) || return 0
    [[ "$inhalt" =~ \"status\":\ *\"erfolgreich\" ]] || return 0
    # Ohne `typ` (ältere Agenten) war es ein Update, wie in der App.
    if [[ "$inhalt" =~ \"typ\":\ *\"([a-z]+)\" ]]; then
        [[ "${BASH_REMATCH[1]}" == "update" ]] || return 0
    fi
    [[ "$inhalt" =~ \"nonce\":\ *\"([0-9a-f]{32})\" ]] || return 0
    nonce="${BASH_REMATCH[1]}"
    [[ "$nonce" != "00000000000000000000000000000000" ]] && printf '%s' "$nonce"
}

# ── Hauptlauf ────────────────────────────────────────────────────────────────

heartbeat
[[ "${POSTBUCH_AGENT_EXEC_KOPIE:-0}" == "1" ]] || web_bestaetigung_pruefen

if [[ "${POSTBUCH_AGENT_EXEC_KOPIE:-0}" != "1" ]]; then
postgres_umzug_automatisch
postgres_image_automatisch
lokalki_modell_automatisch
duckdns_stand_vorher=$(cat -- "$STATE_DIR/duckdns-stand" 2>/dev/null || true)
duckdns_ip_nachfuehren
# Der Heartbeat oben kennt das Ergebnis dieses Laufs noch nicht; sonst zeigt die
# Oberfläche bis zum nächsten Takt den alten Stand.
[[ "$(cat -- "$STATE_DIR/duckdns-stand" 2>/dev/null || true)" == "$duckdns_stand_vorher" ]] || heartbeat
[[ -f "$ANFORDERUNG" ]] || exit 0

INFLIGHT="$UPDATE_DIR/.anforderung.inflight.$$"
if ! mv -T -- "$ANFORDERUNG" "$INFLIGHT" 2>/dev/null; then
    exit 0
fi
ANFORDERUNG_KOPIE=$(mktemp "$STATE_DIR/anforderung.XXXXXX") || { rm -f -- "$INFLIGHT"; exit 1; }
if ! dd if="$INFLIGHT" of="$ANFORDERUNG_KOPIE" iflag=nofollow status=none 2>/dev/null; then
    rm -f -- "$ANFORDERUNG_KOPIE" "$INFLIGHT"
    log "Unsichere oder nicht lesbare Anforderungsdatei verworfen."
    exit 0
fi
chmod 600 "$ANFORDERUNG_KOPIE" 2>/dev/null || true

BEGONNEN_AM="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

if ! lies_anforderung "$ANFORDERUNG_KOPIE"; then
    log "Anforderung unvollstaendig oder ungueltig — verworfen."
    status_schreiben "00000000000000000000000000000000" "abgelehnt" "pruefung" 1 \
        "Die Anforderung war unvollstaendig oder fehlerhaft." "$A_TYP"
    rm -f "$INFLIGHT"
    rm -f "$ANFORDERUNG_KOPIE"
    exit 0
fi

if [[ "$A_TYP" == "update" && "$A_PROTOKOLL" != "1" ]] \
   || [[ "$A_TYP" != "update" && "$A_PROTOKOLL" != "2" ]]; then
    log "Protokollversion $A_PROTOKOLL ist für Updateaufträge nicht freigegeben — abgelehnt."
    status_schreiben "$A_NONCE" "abgelehnt" "pruefung" 1 \
        "Protokollversion passt nicht. Bitte den Update-Agenten erneuern." "$A_TYP"
    rm -f "$INFLIGHT"
    rm -f "$ANFORDERUNG_KOPIE"
    exit 0
fi

# Replay-Schutz 1: Nonce bereits gelaufen? verlauf/<nonce>/ ist die Sperre.
if [[ -d "$VERLAUF/$A_NONCE" ]]; then
    log "Nonce $A_NONCE wurde bereits ausgefuehrt — abgelehnt."
    status_schreiben "$A_NONCE" "abgelehnt" "pruefung" 1 \
        "Diese Anforderung wurde bereits ausgefuehrt." "$A_TYP"
    rm -f "$INFLIGHT"
    rm -f "$ANFORDERUNG_KOPIE"
    exit 0
fi

# Replay-Schutz 2: zu alt? Eine zurueckkopierte alte Datei laeuft damit nie.
JETZT_S=$(date -u '+%s')
AM_S=$(date -u -d "$A_AM" '+%s' 2>/dev/null || echo 0)
if [[ "$AM_S" -eq 0 ]] || (( JETZT_S - AM_S > MAX_ALTER_MIN * 60 )) || (( AM_S - JETZT_S > 300 )); then
    log "Anforderung $A_NONCE ist zu alt oder liegt in der Zukunft ($A_AM) — abgelehnt."
    status_schreiben "$A_NONCE" "abgelehnt" "pruefung" 1 \
        "Die Anforderung ist aelter als $MAX_ALTER_MIN Minuten. Bitte im GUI erneut ausloesen." "$A_TYP"
    rm -f "$INFLIGHT"
    rm -f "$ANFORDERUNG_KOPIE"
    exit 0
fi

# Was ein Hostauftrag gerade tut, in Worten für den Reiter Stack. Die Werte
# sind oben bereits gegen ein festes Zeichenmuster geprüft.
auftrag_bezeichnung() {
    case "$1:$2" in
        module:lokalki:an)      echo "Lokale KI wird eingerichtet: Modell laden und Dienst starten …" ;;
        module:lokalki:aus)     echo "Lokale KI wird abgeschaltet …" ;;
        module:lokalki:entfernen) echo "Lokale KI wird entfernt …" ;;
        module:scanner:an)      echo "Scanner-Dienst wird eingeschaltet …" ;;
        module:scanner:aus)     echo "Scanner-Dienst wird abgeschaltet …" ;;
        module:embedding:an)    echo "Embedding-Dienst wird eingeschaltet …" ;;
        module:embedding:aus)   echo "Embedding-Dienst wird abgeschaltet …" ;;
        module:*)               echo "Dienst wird umgeschaltet …" ;;
        port:*)                 echo "Port der Weboberfläche wird umgestellt …" ;;
        duckdns:aus)            echo "HTTPS über DuckDNS wird abgeschaltet …" ;;
        duckdns:*)              echo "HTTPS über DuckDNS wird eingerichtet …" ;;
        freigabe:*)             echo "Erreichbarkeit im Heimnetz wird umgestellt …" ;;
        ablage:*)               echo "Ablageordner wird umgestellt …" ;;
        netzwerk:*)             echo "Netzwerk der Container wird umgestellt …" ;;
        *)                      echo "Host-Konfiguration wird angewendet." ;;
    esac
}

# Nonce vor jeder Mutation atomar reservieren. Ein Crash nach diesem Punkt darf
# denselben Hostauftrag nie ein zweites Mal ausführen.
if ! mkdir "$VERLAUF/$A_NONCE" 2>/dev/null; then
    status_schreiben "$A_NONCE" "abgelehnt" "pruefung" 1 \
        "Diese Anforderung wurde bereits übernommen." "$A_TYP"
    rm -f "$INFLIGHT" "$ANFORDERUNG_KOPIE"
    exit 0
fi

if [[ "$A_TYP" != "update" ]]; then
    rm -f "$INFLIGHT" "$ANFORDERUNG_KOPIE"
    : > "$LOGFILE"; chmod 600 "$LOGFILE" 2>/dev/null || true
    log "Hostauftrag Typ=$A_TYP übernommen (nonce=$A_NONCE)."
    status_schreiben "$A_NONCE" "laeuft" "hostconfig" "" "$(auftrag_bezeichnung "$A_TYP" "$A_WERT")" "$A_TYP"
    HOSTCONFIG="$AGENT_LIB/postbuch-hostconfig.sh"
    if [[ ! -r "$HOSTCONFIG" ]]; then
        status_schreiben "$A_NONCE" "fehlgeschlagen" "hostconfig" 1 "Host-Konfigurationsmodul fehlt." "$A_TYP"
        exit 1
    fi
    # Die Bibliothek enthält ausschließlich feste Funktionen; Fremdwerte
    # werden dort nochmals je Auftragstyp validiert und niemals geloggt.
    source "$HOSTCONFIG"
    # Jeder neue Auftrag zur Oberfläche ersetzt eine offene Bestätigung.
    [[ "$A_TYP" == freigabe && "$A_WERT" == web:* ]] && rm -f -- "$WEB_BESTAETIGUNG" "$UPDATE_DIR/bestaetigung.kv"
    HOSTCONFIG_RC=0
    HOSTCONFIG_ARG="$A_SECRET"
    [[ "$A_TYP" == ablage ]] && HOSTCONFIG_ARG="$A_PFAD"
    hostconfig_anwenden "$INSTALL_DIR" "$A_TYP" "$A_WERT" "$HOSTCONFIG_ARG" || HOSTCONFIG_RC=$?
    if (( HOSTCONFIG_RC == 0 )); then
        hostdateien_besitz_reparieren || true
        if [[ "$A_TYP" == freigabe && "$A_WERT" == web:lokal ]]; then
            printf 'nonce=%s\nbis=%s\n' "$A_NONCE" "$(( $(date -u '+%s') + 120 ))" > "$WEB_BESTAETIGUNG"
            chmod 600 "$WEB_BESTAETIGUNG" 2>/dev/null || true
            log "Oberfläche nur über HTTPS erreichbar; Bestätigung binnen zwei Minuten erwartet."
        fi
        if [[ "$A_TYP" == duckdns ]]; then
            # Neu eingerichtet oder abgeschaltet: Besitz und Stand beginnen neu.
            # Mit Domain und Token übernimmt dieser Rechner die Domain (siehe
            # duckdns_ip_nachfuehren); geprüft wird im nächsten Lauf.
            rm -f -- "$STATE_DIR/duckdns-ip" "$STATE_DIR/duckdns-stand" "$STATE_DIR/duckdns-takt" "$STATE_DIR/duckdns-anspruch"
            [[ "$A_WERT" =~ ^[a-z0-9-]{1,63}\.duckdns\.org$ ]] && printf '%s\n' "$A_WERT" > "$STATE_DIR/duckdns-anspruch"
        fi
        status_schreiben "$A_NONCE" "erfolgreich" "fertig" 0 "Host-Konfiguration abgeschlossen." "$A_TYP"
        cp -f "$STATUS_JSON" "$VERLAUF/$A_NONCE/status.json" 2>/dev/null || true
        heartbeat
        exit 0
    fi
    hostdateien_besitz_reparieren || true
    case "$HOSTCONFIG_RC" in
        3) HOSTCONFIG_MELDUNG="Download nicht rechtzeitig fertig. Erneutes Einschalten setzt ihn fort." ;;
        4) HOSTCONFIG_MELDUNG="Zu wenig freier Speicherplatz: Nach dem Laden des Modells müssen noch 5 GB frei bleiben." ;;
        5) HOSTCONFIG_MELDUNG="Zu wenig Speicher für die lokale KI: Arbeitsspeicher und Grafikspeicher zusammen müssen mindestens 24 GB ergeben." ;;
        *) HOSTCONFIG_MELDUNG="Host-Konfiguration fehlgeschlagen und wurde zurückgetauscht." ;;
    esac
    # Feste Begründung aus der Bibliothek (Ablage), nie Nutzereingaben.
    [[ -n "${HOSTCONFIG_GRUND:-}" ]] && HOSTCONFIG_MELDUNG="$HOSTCONFIG_GRUND"
    status_schreiben "$A_NONCE" "fehlgeschlagen" "hostconfig" "$HOSTCONFIG_RC" "$HOSTCONFIG_MELDUNG" "$A_TYP"
    cp -f "$STATUS_JSON" "$VERLAUF/$A_NONCE/status.json" 2>/dev/null || true
    heartbeat
    exit 1
fi

# ── Ab hier wird gearbeitet ──────────────────────────────────────────────────
# Anforderung SOFORT entfernen: sie ist abgeholt, und ein zweiter Tick waehrend
# des laufenden Updates darf sie nicht noch einmal finden.
rm -f "$INFLIGHT"
rm -f "$ANFORDERUNG_KOPIE"

# Selbstschutz: aus dem privaten Agenten-Zustandsverzeichnis weiterlaufen,
# damit das Entpacken des Tarballs dieses Skript nicht unter den Fuessen
# wegzieht. /tmp ist auf gehärteten Systemen oft mit noexec eingehängt; eine
# dort erzeugte Kopie würde genau hier ohne Status oder Log abbrechen.
if [[ "${POSTBUCH_AGENT_EXEC_KOPIE:-0}" != "1" ]]; then
    # Kopien früherer Läufe wegräumen. Bash liest ein laufendes Skript über
    # seinen offenen Deskriptor, das Löschen stört also auch keine laufende Kopie.
    rm -f -- "$STATE_DIR"/postbuch-update-agent.*.sh
    KOPIE="$(mktemp "$STATE_DIR/postbuch-update-agent.XXXXXX.sh")"
    cp -f "$0" "$KOPIE"
    chmod 700 "$KOPIE"
    export POSTBUCH_AGENT_EXEC_KOPIE=1
    export POSTBUCH_AGENT_NONCE="$A_NONCE"
    export POSTBUCH_AGENT_ZIEL="$A_ZIEL"
    export POSTBUCH_AGENT_SHA="$A_SHA"
    export POSTBUCH_AGENT_VON="${A_VON:-admin}"
    export POSTBUCH_AGENT_BEGONNEN="$BEGONNEN_AM"
    exec "$KOPIE"
fi
fi

# Ab hier: die Kopie. Die Anforderungsdaten kamen ueber die Umgebung mit. Die
# Datei selbst wird nicht mehr gebraucht (siehe oben) und sofort entfernt.
[[ "$0" == "$STATE_DIR"/postbuch-update-agent.*.sh ]] && rm -f -- "$0"
A_NONCE="${POSTBUCH_AGENT_NONCE:-$A_NONCE}"
A_ZIEL="${POSTBUCH_AGENT_ZIEL:-$A_ZIEL}"
A_SHA="${POSTBUCH_AGENT_SHA:-$A_SHA}"
A_VON="${POSTBUCH_AGENT_VON:-admin}"
BEGONNEN_AM="${POSTBUCH_AGENT_BEGONNEN:-$BEGONNEN_AM}"

: > "$LOGFILE"
chmod 600 "$LOGFILE" 2>/dev/null || true
log "Update auf $A_ZIEL angefordert von $A_VON (nonce=$A_NONCE, Modus=$AGENT_MODE)"
status_schreiben "$A_NONCE" "laeuft" "start" "" "Update wird vorbereitet." "update"

INSTALLER="$AGENT_LIB/install.sh"
if [[ ! -x "$INSTALLER" ]]; then
    log "Installer nicht gefunden: $INSTALLER"
    status_schreiben "$A_NONCE" "fehlgeschlagen" "start" 1 \
        "Der Installer wurde nicht gefunden. Bitte den Update-Agenten neu einrichten." "update"
    exit 1
fi

# --zielversion: der Installer holt genau das Manifest dieser Version. Ohne
# den Schalter läse er das neueste stabile Manifest und lehnte eine
# angeforderte Vorabversion am abweichenden SHA-256 ab.
ARGS=(--update --yes --non-interactive "--erwarte-sha256=$A_SHA" "--zielversion=$A_ZIEL" "--install-dir=$INSTALL_DIR")
[[ "$AGENT_MODE" == "dry-run" ]] && ARGS+=(--dry-run)

# Phasenmarker (##PHASE:…) aus der Installer-Ausgabe in status.json spiegeln —
# so zeigt das GUI echte Phasen statt eines Balkens, der nichts weiss.
set -o pipefail
"$INSTALLER" "${ARGS[@]}" 2>&1 | while IFS= read -r zeile; do
    printf '%s\n' "$zeile" >> "$LOGFILE"
    log_veroeffentlichen
    if [[ "$zeile" == *"##PHASE:"* ]]; then
        phase="${zeile##*##PHASE:}"
        phase="${phase%%[^a-z]*}"
        [[ -n "$phase" ]] && status_schreiben "$A_NONCE" "laeuft" "$phase" "" "Update laeuft." "update"
    fi
done
EXIT=${PIPESTATUS[0]}

if [[ "$EXIT" -eq 0 ]]; then
    if [[ "$AGENT_MODE" == "dry-run" ]]; then
        MELDUNG="Probelauf erfolgreich abgeschlossen — es wurde nichts veraendert."
    else
        MELDUNG="Update auf $A_ZIEL abgeschlossen."
    fi
    log "$MELDUNG"
    status_schreiben "$A_NONCE" "erfolgreich" "fertig" 0 "$MELDUNG" "update"
else
    log "Update fehlgeschlagen (Exit $EXIT)."
    # ##PHASE:up ist in allen Installer-Versionen der erste Schritt, der
    # Container anfasst. Das GUI sieht nur den Schwanz des Logs und kann das
    # nach einem langen Build nicht mehr selbst erkennen, daher steht es hier
    # in Phase und Meldung.
    if grep -q '##PHASE:up' "$LOGFILE" 2>/dev/null; then
        status_schreiben "$A_NONCE" "fehlgeschlagen" "fehler-nach-start" "$EXIT" \
            "Das Update ist fehlgeschlagen (Exit $EXIT), nachdem die neue Version eingespielt wurde. Details stehen im Protokoll." "update"
    else
        status_schreiben "$A_NONCE" "fehlgeschlagen" "fehler-vor-start" "$EXIT" \
            "Das Update ist fehlgeschlagen (Exit $EXIT). Die bisherige Version läuft unverändert weiter. Details stehen im Protokoll." "update"
    fi
fi

# ── Lauf archivieren ─────────────────────────────────────────────────────────
cp -f "$STATUS_JSON" "$VERLAUF/$A_NONCE/status.json" 2>/dev/null || true
cp -f "$LOGFILE"     "$VERLAUF/$A_NONCE/update.log"  2>/dev/null || true

# Nur die letzten Laeufe behalten.
mapfile -t alt < <(ls -dt "$VERLAUF"/*/ 2>/dev/null | tail -n +$((VERLAUF_BEHALTEN + 1)))
for d in "${alt[@]:-}"; do
    [[ -n "$d" && "$d" == "$VERLAUF/"* ]] && rm -rf "$d"
done

# Ein letzter Heartbeat, damit die App den Agenten direkt nach dem Lauf sieht.
heartbeat
exit "$EXIT"
