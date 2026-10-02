#!/usr/bin/env bash
set -euo pipefail

# ── Bezugsquelle ─────────────────────────────────────────────────────────────
# Die Quelle ist Instanzkonfiguration: Sie steht in der .env der Installation
# und wird von keinem späteren Release überschrieben. Reihenfolge: --quelle,
# Prozessumgebung, .env der vorhandenen Installation, sonst die öffentlichen
# GitHub Releases des Projekts. Interaktiv gefragt wird nicht; wer eine andere
# Quelle braucht, setzt --quelle=<https-url>.
QUELLE_STANDARD="https://github.com/ceramgcf/postbuch.net/releases"
# Der fruehere Testkanal endet mit 2.9.0. Instanzen, deren .env noch auf ihn
# zeigt, gehen still auf den Standard ueber; nur --quelle erreicht ihn noch.
QUELLE_TESTKANAL_ALT="https://test.postbuch.net"
POSTBUCH_FEED_BASE_URL="${POSTBUCH_FEED_BASE_URL:-}"
BASE_URL=""
MANIFEST_URL=""
# GitHub-Quelle (https://github.com/<owner>/<repo>/releases): Assets liegen je
# Release unter download/v<version>/, das neueste stabile Manifest unter
# latest/download/. Downloads werden auf einen Asset-Host weitergeleitet.
QUELLE_GITHUB=false
# Der Tarball heisst pro Release anders (postbuch-<version>.tar.gz). Dadurch ist
# jede Release-URL neu und darf beliebig lange gecacht werden — ein Edge-Cache
# kann nie eine alte Datei zu einem neuen Manifest ausliefern. RELEASE_URL wird
# deshalb erst zur Laufzeit aus der Manifest-Version gebildet, siehe
# release_url_aktualisieren().
RELEASE_URL=""
INSTALLER_URL=""

# systemd startet den Update-Agenten mit einer bewusst kleinen Umgebung; HOME
# kann dort fehlen. Der Installer darf deshalb unter `set -u` nicht schon vor
# dem Auswerten von --install-dir abbrechen. Für interaktive Läufe bleibt das
# echte HOME maßgeblich, für root-Dienste ist /root der sichere Standard.
LAUFZEIT_HOME="${HOME:-/root}"
DEFAULT_INSTALL_DIR="$LAUFZEIT_HOME/postbuch"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOCAL_TARBALL="$SCRIPT_DIR/postbuch-latest.tar.gz"

# ── Betriebsart (wird von parse_args gesetzt) ────────────────────────────────
OPT_UPDATE=false            # --update            nicht-interaktiver Update-Modus
OPT_YES=false               # --yes               keine Rueckfragen
OPT_NON_INTERACTIVE=false   # --non-interactive   kein einziger /dev/tty-Zugriff
OPT_DRY_RUN=false           # --dry-run           bis inkl. Backup, dann sauber raus
OPT_ROLLBACK=false          # --rollback          auf ein Backup zurueck
OPT_SHA256=""               # --erwarte-sha256=   Pruefsumme des Tarballs
OPT_INSTALL_DIR=""          # --install-dir=      abweichendes Zielverzeichnis
OPT_FEED_BASE_URL=""        # --quelle=           Bezugsquelle dieser Instanz
OPT_ZIELVERSION=""          # --zielversion=      genau diese Version installieren
# Die beiden folgenden Notausgaenge setzt der Update-Agent NIE. Sie sind fuer
# den Admin an der Konsole gedacht, der weiss, warum er sie braucht — etwa nach
# einem Schluesselverlust auf Herausgeberseite.
OPT_OHNE_SIGNATUR=false     # --ohne-signatur-fortfahren   trotz Vertrauensanker weiter
OPT_ERLAUBE_RUECKSCHRITT=false  # --erlaube-rueckschritt   aeltere Version zulassen

# ── Installationsprotokoll ───────────────────────────────────────────────────
# Das Protokoll ist bewusst ausserhalb der Installation abgelegt: Updates und
# eine Deinstallation duerfen einen fuer die Diagnose benoetigten Lauf nicht
# selbst loeschen. Es enthält normales stdout/stderr (einschliesslich
# Docker-/npm-Buildausgaben), aber bewusst KEIN Shell-Xtrace, keine Umgebungs-
# oder Compose-Dumps und keine Container-Runtime-Logs — diese koennen Secrets
# bzw. personenbezogene Daten enthalten.
INSTALL_LOG_FILE=""

installer_log_abschluss() {
    local status=$?
    trap - EXIT
    if [[ -n "$INSTALL_LOG_FILE" ]]; then
        printf '\n## Installer beendet: %s (Exit-Code %s)\n' \
            "$(date '+%Y-%m-%d %H:%M:%S %Z')" "$status"
        printf '## Vollstaendiges Protokoll: %s\n' "$INSTALL_LOG_FILE"
    fi
    exit "$status"
}

installer_log_starten() {
    local state_dir log_dir
    state_dir="${XDG_STATE_HOME:-$LAUFZEIT_HOME/.local/state}"
    log_dir="${POSTBUCH_INSTALL_LOG_DIR:-$state_dir/postbuch/logs}"

    # Das Protokoll enthält unter Umständen Diagnoseausgaben zu einer Instanz
    # und bleibt daher privat. Die restriktive umask gilt ABSICHTLICH nur in
    # dieser Subshell: Eine globale umask 077 würde später Release-Dateien als
    # 0600/0700 entpacken und damit den nginx-Worker aussperren.
    if ! INSTALL_LOG_FILE=$( (
        umask 077
        mkdir -p "$log_dir" && chmod 700 "$log_dir" \
            && mktemp "$log_dir/install-$(date '+%Y%m%d-%H%M%S')-XXXXXX.log"
    ) ); then
        echo "FEHLER: Protokollverzeichnis konnte nicht sicher angelegt werden: $log_dir" >&2
        exit 1
    fi
    chmod 600 "$INSTALL_LOG_FILE"

    # tee sichert die vollstaendige Ausgabe und laesst sie gleichzeitig an der
    # Konsole sichtbar. Kein `set -x`: Passwoerter und Tokens duerfen nie in
    # einem Support-Log landen.
    exec > >(tee -a "$INSTALL_LOG_FILE") 2>&1
    trap installer_log_abschluss EXIT
    # Docker BuildKit gibt im plain-Modus jede Paketwarnung zeilenweise aus;
    # genau diese Information wird fuer die Diagnose einer Fremdinstallation
    # gebraucht. Das ist kein Shell-Debugging und gibt keine ENV-Werte aus.
    export BUILDKIT_PROGRESS=plain

    printf '\n## postbuch.net-Installer-Protokoll\n'
    printf '## Start: %s\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')"
    printf '## System: %s\n' "$(uname -srm)"
    printf '## Protokoll: %s\n' "$INSTALL_LOG_FILE"
    command -v docker >/dev/null 2>&1 && docker --version || true
    docker compose version 2>/dev/null || true
}

# Maschinenlesbare Phasenmarker fuer den Update-Agenten. Er spiegelt sie nach
# status.json, damit das GUI echte Phasen zeigt statt eines Balkens, der nichts
# weiss. Auf stdout, damit sie im Log stehen.
phase() { printf '##PHASE:%s\n' "$1"; }

if [[ -t 1 ]]; then
    C_RESET=$'\033[0m'
    C_DIM=$'\033[2m'
    C_BOLD=$'\033[1m'
    C_CYAN=$'\033[38;5;45m'
    C_BLUE=$'\033[38;5;39m'
    C_GREEN=$'\033[38;5;42m'
    C_AMBER=$'\033[38;5;214m'
    C_RED=$'\033[38;5;203m'
    C_PINK=$'\033[38;5;205m'
else
    C_RESET=""
    C_DIM=""
    C_BOLD=""
    C_CYAN=""
    C_BLUE=""
    C_GREEN=""
    C_AMBER=""
    C_RED=""
    C_PINK=""
fi

# ── Hilfsfunktionen ────────────────────────────────────────────────────────────
info()    { echo "" >&2; printf "  ${C_CYAN}%s${C_RESET}\n" "$*" >&2; }
success() { echo "" >&2; printf "  ${C_GREEN}✓ %s${C_RESET}\n" "$*" >&2; }
warn()    { echo "" >&2; printf "  ${C_AMBER}⚠ %s${C_RESET}\n" "$*" >&2; }
error()   { echo "" >&2; printf "  ${C_RED}✗ %s${C_RESET}\n\n" "$*" >&2; exit 1; }
hr()      { echo "" >&2; printf "  ${C_DIM}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C_RESET}\n" >&2; }

panel() {
    local title="$1"
    local body="$2"
    echo ""
    printf "  ${C_BOLD}${C_BLUE}╭─ %s ${C_DIM}%s${C_RESET}\n" "$title" "────────────────────────────────────────────────────"
    while IFS= read -r line; do
        printf "  ${C_BLUE}│${C_RESET} %s\n" "$line"
    done <<< "$body"
    printf "  ${C_BLUE}╰${C_DIM}──────────────────────────────────────────────────────────────────${C_RESET}\n"
}

highlight() {
    printf "${C_BOLD}%s${C_RESET}" "$1"
}

safe_rm_rf() {
    local target="$1"
    [[ ! -e "$target" ]] && return 0
    if rm -rf "$target" 2>/dev/null; then
        return 0
    fi
    if command -v sudo &>/dev/null; then
        # Ein UI-/Agentenupdate darf unter keinen Umständen an einem verdeckten
        # Passwortprompt hängen. Interaktiv bleibt der bisherige Fallback
        # erlaubt; headless ausschließlich mit bereits autorisiertem sudo.
        if $OPT_NON_INTERACTIVE; then
            sudo -n rm -rf "$target"
        else
            sudo rm -rf "$target"
        fi
    else
        return 1
    fi
}

# Alle Docker-Einzelbefehle müssen dieselbe Rechteart benutzen wie Compose.
# Sonst wird z. B. ein vorhandenes Caddy-Image bei fehlendem Docker-Gruppenrecht
# als „nicht vorhanden" missverstanden und der teure xcaddy-Build wiederholt.
docker_runtime() {
    if [[ "${DOCKER_COMPOSE:-docker compose}" == sudo\ * ]]; then
        if $OPT_NON_INTERACTIVE; then
            sudo -n docker "$@"
        else
            sudo docker "$@"
        fi
    else
        docker "$@"
    fi
}

upsert_env_value() {
    local file="$1"
    local key="$2"
    local value="$3"
    local escaped
    escaped=${value//\\/\\\\}
    escaped=${escaped//&/\\&}
    escaped=${escaped//|/\\|}
    if grep -q "^${key}=" "$file"; then
        sed -i "s|^${key}=.*|${key}=${escaped}|" "$file"
    else
        echo "${key}=${value}" >> "$file"
    fi
}

prompt() {
    local msg="$1"
    local default="${2:-}"
    if [[ -n "$default" ]]; then
        read -rp "  $msg [$default]: " val </dev/tty
        echo "${val:-$default}"
    else
        read -rp "  $msg: " val </dev/tty
        echo "$val"
    fi
}

prompt_secret() {
    local msg="$1"
    read -rsp "  $msg: " val </dev/tty
    echo "" >/dev/tty
    echo "$val"
}

# ── DuckDNS-Domain vorab pruefen ──────────────────────────────────────────────
# Eingabe tolerant annehmen: Schema, Pfad und Schlusspunkt weg, klein, und ein
# nackter Subdomain-Name ("musterpostbuch") wird zu "musterpostbuch.duckdns.org".
duckdns_domain_normalisieren() {
    local d="${1,,}"
    d="${d//[[:space:]]/}"
    d="${d#http://}"
    d="${d#https://}"
    d="${d%%/*}"
    d="${d%.}"
    [[ -n "$d" && "$d" != *.* ]] && d="$d.duckdns.org"
    printf '%s' "$d"
}

domain_gueltig() {
    [[ "$1" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]]
}

# IPv4-Adressen dieses Hosts ohne Docker-Bridges, eine je Zeile.
host_ipv4_adressen() {
    {
        if command -v ip &>/dev/null; then
            ip -4 -o addr show scope global 2>/dev/null \
                | awk '$2 !~ /^(docker|br-|veth|virbr)/ {print $4}' | cut -d/ -f1
        else
            hostname -I 2>/dev/null | tr ' ' '\n'
        fi
    } | { grep -E '^[0-9]+(\.[0-9]+){3}$' || true; } | sort -u
}

ipv4_privat() {
    [[ "$1" =~ ^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.) ]]
}

# A-Records ueber oeffentliches DNS-over-HTTPS. Der lokale Resolver taugt als
# Referenz nicht: Ein Router mit DNS-Rebind-Schutz verwirft genau die gewollte
# Antwort (oeffentlicher Name → private Adresse). Rueckgabe 1 = nicht abfragbar.
dns_a_oeffentlich() {
    local name="$1" antwort
    antwort=$(curl -fsS --max-time 8 -H 'accept: application/dns-json' \
        "https://cloudflare-dns.com/dns-query?name=${name}&type=A" 2>/dev/null) \
        || antwort=$(curl -fsS --max-time 8 \
            "https://dns.google/resolve?name=${name}&type=A" 2>/dev/null) \
        || return 1
    printf '%s' "$antwort" \
        | grep -oE '"data": ?"[0-9]{1,3}(\.[0-9]{1,3}){3}"' \
        | grep -oE '[0-9]{1,3}(\.[0-9]{1,3}){3}' | sort -u
    return 0
}

dns_a_lokal() {
    { timeout 6 getent ahostsv4 "$1" 2>/dev/null || true; } | awk '{print $1}' | sort -u
}

# Prueft, ob die Domain auf diesen Host zeigt und ob der Router sie hier auch
# aufloest. Rueckgabe: 0 = passt · 1 = korrigierbarer Fehler (IP falsch, kein
# Eintrag, Rebind-Schutz) · 2 = Pruefung nicht moeglich.
duckdns_aufloesung_pruefen() {
    local domain="$1" oeffentlich lokal host_ips ip treffer=""
    host_ips=$(host_ipv4_adressen)
    if ! oeffentlich=$(dns_a_oeffentlich "$domain"); then
        warn "DNS-Pruefung nicht moeglich (kein Zugriff auf oeffentliches DNS). Bitte bei DuckDNS selbst kontrollieren."
        return 2
    fi
    if [[ -z "$oeffentlich" ]]; then
        panel "Domain nicht gefunden" "Zu $domain gibt es keinen DNS-Eintrag.
• Tippfehler im Namen?
• Oder die Subdomain wurde auf duckdns.org noch nicht mit 'add domain' angelegt.
Danach hier erneut pruefen oder die Domain neu eingeben."
        return 1
    fi
    for ip in $oeffentlich; do
        grep -qxF "$ip" <<< "$host_ips" && treffer="$ip"
    done
    if [[ -z "$treffer" ]]; then
        local hinweis=""
        ipv4_privat "$(head -n1 <<< "$oeffentlich")" \
            || hinweis="
Das ist vermutlich deine oeffentliche Internet-Adresse, die DuckDNS beim Anlegen
automatisch eintraegt. postbuch.net braucht aber die Adresse im Heimnetz."
        panel "Domain zeigt auf eine andere Adresse" "$domain zeigt auf:      $(tr '\n' ' ' <<< "$oeffentlich")
Dieser Server hat:     $(tr '\n' ' ' <<< "$host_ips")$hinweis

So korrigierst du es: auf duckdns.org bei $domain die IP $_LAN_IP
eintragen und 'update ip' klicken. Die Aenderung ist meist nach
spaetestens einer Minute sichtbar, dann hier erneut pruefen."
        return 1
    fi
    lokal=$(dns_a_lokal "$domain")
    if ! grep -qxF "$treffer" <<< "$lokal"; then
        panel "DNS-Rebind-Schutz blockiert die Domain" "$domain zeigt korrekt auf $treffer – dein Router gibt diese Antwort
aber nicht weiter (DNS-Rebind-Schutz). Dann klappt der Zugriff ueber die
Domain im Heimnetz nicht, auch HTTPS und Push nicht.

Trage $domain im Router als Ausnahme ein (den Schutz nicht komplett abschalten).
Fritz!Box: http://fritz.box → Heimnetz → Netzwerk → Netzwerkeinstellungen →
DNS-Rebind-Schutz. Andere Router nennen es aehnlich ('DNS Rebind Protection').
Danach hier erneut pruefen."
        return 1
    fi
    success "$domain zeigt auf $treffer (dieser Server), auch der Router loest sie auf."
    return 0
}

# ── .env-Werte gegen Compose-Interpolation schuetzen ──────────────────────────
# docker compose interpoliert UNGEQUOTETE Werte aus der .env. Ein Passwort
# "Sommer$urlaub!" wird damit still zu "Sommer!", weil $urlaub nicht gesetzt ist
# — der Nutzer sperrt sich aus und merkt nicht, warum. Einfache
# Anfuehrungszeichen schalten die Interpolation ab.
# Ein einfaches Anfuehrungszeichen IM Wert laesst sich dabei nicht escapen:
# weder \' noch die POSIX-Form '\'' werden vom Compose-Parser korrekt gelesen
# (docker/compose#11276). Es wird deshalb schon bei der Eingabe abgelehnt,
# statt hier still den Wert zu zerstoeren.
env_single_quote() {
    printf "'%s'" "$1"
}

# Passwortabfrage mit genau dieser Pruefung. Wiederholt, bis der Wert nicht leer
# und ohne einfaches Anfuehrungszeichen ist.
prompt_password() {
    local msg="$1"
    local val=""
    while true; do
        val=$(prompt_secret "$msg")
        if [[ -z "$val" ]]; then
            warn "Passwort darf nicht leer sein."
        elif [[ "$val" == *"'"* ]]; then
            warn "Das Passwort darf kein einfaches Anfuehrungszeichen ( ' ) enthalten – Docker kann es in der Konfigurationsdatei nicht zuverlaessig lesen. Bitte ein anderes Sonderzeichen waehlen."
        else
            break
        fi
    done
    echo "$val"
}

# ── Bezugsquelle der Instanz ─────────────────────────────────────────────────
# Die URL ist nicht geheim, wird aber mit derselben Sorgfalt wie andere
# Konfigurationswerte behandelt: eine Zeile in .env darf weder curl-Optionen
# noch weitere Compose-Variablen einschleusen. Ein Pfad ist erlaubt, damit
# künftige Provider ihre Assets unter einer festen Unterroute bereitstellen
# können. HTTP ist verboten, weil an dieser Adresse ggf. Basic Auth gesendet
# wird.
quelle_setzen() {
    local roh="${1:-}"
    roh="${roh%/}"
    if [[ ! "$roh" =~ ^https://[^/?#@[:space:]]+(/[^?#@[:space:]]*)?$ ]] \
        || [[ "$roh" == *$'\n'* || "$roh" == *$'\r'* || "$roh" == *$'\t'* ]]; then
        return 1
    fi
    BASE_URL="$roh"
    if [[ "$BASE_URL" =~ ^https://github\.com/[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}/releases$ ]]; then
        QUELLE_GITHUB=true
        # Mit --zielversion das Manifest genau dieses Releases (auch einer
        # Vorabversion), sonst GitHubs Verweis auf das neueste stabile.
        if [[ -n "$OPT_ZIELVERSION" ]]; then
            MANIFEST_URL="$BASE_URL/download/v$OPT_ZIELVERSION/latest.json"
        else
            MANIFEST_URL="$BASE_URL/latest/download/latest.json"
        fi
        INSTALLER_URL="$BASE_URL/latest/download/install.sh"
    else
        QUELLE_GITHUB=false
        MANIFEST_URL="$BASE_URL/latest.json"
        INSTALLER_URL="$BASE_URL/install.sh"
    fi
    RELEASE_URL=""
    return 0
}

# Liest die Quelle aus einer vorhandenen Compose-.env. Die Variable ist bewusst
# nicht per `source` eingelesen: eine .env ist Konfigurationsdatei, kein Shell-
# Programm. Einfache Anführungszeichen stammen von env_single_quote().
quelle_aus_env() {
    local envdatei="${1:-}" zeile=""
    [[ -f "$envdatei" ]] || return 1
    zeile=$(grep -m1 '^POSTBUCH_FEED_BASE_URL=' "$envdatei" 2>/dev/null || true)
    [[ -n "$zeile" ]] || return 1
    zeile="${zeile#POSTBUCH_FEED_BASE_URL=}"
    zeile="${zeile#\'}"; zeile="${zeile%\'}"
    quelle_setzen "$zeile"
}

# Steht in der .env eine bewusst geleerte Quelle? Dann hat ein Admin Updates
# abgeschaltet, und der Installer setzt nicht still den Standard ein.
quelle_in_env_geleert() {
    local envdatei="${1:-}"
    [[ -f "$envdatei" ]] || return 1
    grep -Eq "^POSTBUCH_FEED_BASE_URL=('')?[[:space:]]*$" "$envdatei" 2>/dev/null
}

# Eine aus ENV oder .env stammende Quelle auf den alten Testkanal wird durch
# den Standard ersetzt. Die Aufrufer persistieren das Ergebnis in die .env.
testkanal_abloesen() {
    [[ "$BASE_URL" == "$QUELLE_TESTKANAL_ALT" ]] || return 0
    quelle_setzen "$QUELLE_STANDARD"
    POSTBUCH_FEED_AUTH=""; FEED_AUTH_B64=""
}

bezugsquelle_sicherstellen() {
    local envdatei="${1:-}"

    if [[ -n "$OPT_FEED_BASE_URL" ]] && quelle_setzen "$OPT_FEED_BASE_URL"; then
        POSTBUCH_FEED_BASE_URL="$BASE_URL"
        return 0
    fi
    if [[ -n "$POSTBUCH_FEED_BASE_URL" ]] && quelle_setzen "$POSTBUCH_FEED_BASE_URL"; then
        testkanal_abloesen
        POSTBUCH_FEED_BASE_URL="$BASE_URL"
        return 0
    fi
    if quelle_aus_env "$envdatei"; then
        testkanal_abloesen
        POSTBUCH_FEED_BASE_URL="$BASE_URL"
        return 0
    fi

    if quelle_in_env_geleert "$envdatei"; then
        echo "FEHLER: POSTBUCH_FEED_BASE_URL ist in $envdatei leer gesetzt; Updates sind abgeschaltet." >&2
        echo "  Wieder einschalten: Quelle in der .env eintragen oder einmalig mit" >&2
        echo "  --quelle=$QUELLE_STANDARD aufrufen." >&2
        return 1
    fi
    if [[ -f "$envdatei" ]] && grep -q '^POSTBUCH_FEED_BASE_URL=' "$envdatei" 2>/dev/null; then
        echo "FEHLER: POSTBUCH_FEED_BASE_URL in $envdatei ist keine gueltige HTTPS-URL." >&2
        return 1
    fi

    # Neue Installation (oder .env ganz ohne Eintrag): öffentlicher Standard.
    quelle_setzen "$QUELLE_STANDARD"
    POSTBUCH_FEED_BASE_URL="$BASE_URL"
    return 0
}

# ── Zugangsdaten der Bezugsquelle (HTTP Basic Auth) ──────────────────────────
# Eine geschützte Bezugsquelle liefert ohne Zugangsdaten 401 — Manifest,
# Tarball und dieses Skript selbst sind dann nicht lesbar.
#
# Der Wert hat die Form "benutzer:passwort" und lebt an genau zwei Orten:
# in der .env der Instanz und in der Pages-Umgebung des Herausgebers. Er steht
# NIE in diesem Skript — waere er einkompiliert, stuende das gemeinsame
# Geheimnis in jedem Release-Tarball und liesse sich nie wieder wechseln.
#
# ACHTUNG beim Uebergeben an curl: `-u benutzer:passwort` und
# `-H "Authorization: ..."` landen beide in der Kommandozeile und sind damit
# fuer jeden anderen Nutzer des Rechners in `ps` sichtbar. Deshalb geht der
# Header ueber eine curl-Konfigurationsdatei, die als Prozess-Substitution
# gereicht wird: sie existiert nur als Dateideskriptor, nie auf der Platte und
# nie in argv.
POSTBUCH_FEED_AUTH="${POSTBUCH_FEED_AUTH:-}"
FEED_AUTH_B64=""

feed_auth_uebernehmen() {
    if [[ -n "$POSTBUCH_FEED_AUTH" && "$POSTBUCH_FEED_AUTH" == *:* ]]; then
        FEED_AUTH_B64=$(printf '%s' "$POSTBUCH_FEED_AUTH" | base64 | tr -d '\n')
    else
        FEED_AUTH_B64=""
    fi
}

# Liest die Zugangsdaten aus der .env einer bestehenden Installation.
feed_auth_aus_env() {
    local envdatei="${1:-}"
    [[ -n "$POSTBUCH_FEED_AUTH" ]] && return 0
    [[ -f "$envdatei" ]] || return 1
    local zeile
    zeile=$(grep -m1 '^POSTBUCH_FEED_AUTH=' "$envdatei" 2>/dev/null || true)
    [[ -n "$zeile" ]] || return 1
    zeile="${zeile#POSTBUCH_FEED_AUTH=}"
    # Fuehrende/abschliessende einfache Anfuehrungszeichen entfernen (die .env
    # wird gequotet geschrieben, siehe env_single_quote).
    zeile="${zeile#\'}"; zeile="${zeile%\'}"
    [[ "$zeile" == *:* ]] || return 1
    POSTBUCH_FEED_AUTH="$zeile"
    feed_auth_uebernehmen
    return 0
}

# curl mit Zugangsdaten. Ersetzt jeden direkten curl-Aufruf gegen $BASE_URL.
# Ohne bekannte Zugangsdaten laeuft der Aufruf unauthentifiziert durch — der
# Server antwortet dann mit 401 und der Aufrufer meldet den Fehler regulaer.
feed_curl() {
    if $QUELLE_GITHUB; then
        # GitHub leitet jeden Asset-Download auf einen eigenen Host weiter.
        # Folgen nur über HTTPS und höchstens fünfmal; Zugangsdaten gehen an
        # GitHub nie mit, die Integrität sichern Signatur und SHA-256.
        curl -L --max-redirs 5 --proto =https --proto-redir =https "$@"
    elif [[ -n "$FEED_AUTH_B64" ]]; then
        # Nie einem Redirect mit manuell gesetztem Authorization-Header folgen:
        # curl würde ihn sonst an dessen Ziel weiterreichen. Der Feed muss
        # direkt erreichbar sein; ein separater Release-Template-Host bekommt
        # weiter unten bewusst einen auth-freien Curl-Pfad.
        curl --max-redirs 0 -K <(printf 'header = "Authorization: Basic %s"\n' "$FEED_AUTH_B64") "$@"
    else
        curl --max-redirs 0 "$@"
    fi
}

# Antwortet die Bezugsquelle auf die aktuellen Zugangsdaten? 0 = ja.
feed_auth_probe() {
    local code
    code=$(feed_curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$MANIFEST_URL" 2>/dev/null || echo "000")
    [[ "$code" == "200" ]]
}

# Stellt sicher, dass Zugangsdaten vorliegen und funktionieren.
#
# Reihenfolge: bereits gesetzte ENV → .env der Installation → interaktive
# Abfrage. Die Abfrage MUSS vor dem Versionsvergleich stehen, denn schon das
# Manifest ist ohne Zugangsdaten nicht lesbar.
feed_auth_sicherstellen() {
    local envdatei="${1:-}"
    # GitHub ist öffentlich; Zugangsdaten gehören nur zu einer flachen Quelle.
    if $QUELLE_GITHUB; then
        FEED_AUTH_B64=""
        feed_auth_probe && return 0
        echo "FEHLER: Das Release-Manifest ist nicht erreichbar: $MANIFEST_URL" >&2
        return 1
    fi
    feed_auth_aus_env "$envdatei" || true
    feed_auth_uebernehmen

    # Auch öffentliche Quellen sind gültig. Erst ein nicht erfolgreicher
    # Probe verlangt Zugangsdaten; so bleibt die Auth optional und ein späterer
    # direkter Feed-Host funktioniert ohne Sonderpfad.
    if feed_auth_probe; then
        return 0
    fi

    if $OPT_NON_INTERACTIVE; then
        if [[ -z "$FEED_AUTH_B64" ]]; then
            echo "FEHLER: Die Bezugsquelle verlangt eine Anmeldung, es sind aber keine" >&2
            echo "  Zugangsdaten hinterlegt. POSTBUCH_FEED_AUTH in $envdatei eintragen" >&2
            echo "  (Form: benutzer:passwort) und den Lauf wiederholen." >&2
        else
            echo "FEHLER: Die hinterlegten Zugangsdaten wurden abgelehnt (HTTP 401)." >&2
            echo "  POSTBUCH_FEED_AUTH in $envdatei pruefen." >&2
        fi
        return 1
    fi

    if [[ -n "$FEED_AUTH_B64" ]]; then
        warn "Die hinterlegten Zugangsdaten wurden abgelehnt — bitte neu eingeben."
    fi

    panel "Zugang zur Bezugsquelle" "Diese Bezugsquelle antwortet nicht ohne
Anmeldung. Benutzername und Passwort bekommst du vom Betreiber.

Bei einer oeffentlichen Bezugsquelle ist dieser Schritt nicht noetig. Die
Angaben werden in der .env deiner Installation abgelegt, damit kuenftige
Updates nicht erneut danach fragen."

    local benutzer passwort
    while true; do
        benutzer=$(prompt "Benutzername" "x")
        passwort=$(prompt_password "Passwort")
        POSTBUCH_FEED_AUTH="${benutzer}:${passwort}"
        feed_auth_uebernehmen
        if feed_auth_probe; then
            info "Zugang bestaetigt."
            return 0
        fi
        warn "Benutzername oder Passwort falsch (oder die Quelle ist nicht erreichbar)."
        local nochmal
        read -rp "  Erneut versuchen? [J/n]: " nochmal </dev/tty
        if [[ "$nochmal" =~ ^[nN] ]]; then
            POSTBUCH_FEED_AUTH=""; FEED_AUTH_B64=""
            return 1
        fi
    done
}

# ── Safe-Mode bei wenig RAM ──────────────────────────────────────────────────
# Auf Geraeten mit < 2 GB RAM bricht der vite-Frontend-Build oft mit OOM ab,
# weil Docker alle Images parallel baut. Safe-Mode baut die Images seriell und
# begrenzt den Node-Heap des Frontend-Builds. Setzt die Globals SAFE_MODE und
# WEB_BUILD_NODE_OPTIONS.
SAFE_MODE=false
WEB_BUILD_NODE_OPTIONS=""

detect_and_offer_safe_mode() {
    local mem_kb mem_mb
    mem_kb=$(grep -m1 '^MemTotal:' /proc/meminfo 2>/dev/null | awk '{print $2}' || echo 0)
    mem_mb=$(( mem_kb / 1024 ))
    # Erkennung fehlgeschlagen oder genug RAM → normaler (paralleler) Build
    [[ "$mem_mb" -le 0 ]] && return 0
    [[ "$mem_mb" -ge 2048 ]] && return 0

    # Heap-Deckel aus RAM ableiten: ~70 %, geklammert auf [512, 1536] MB.
    local cap=$(( mem_mb * 70 / 100 ))
    [[ "$cap" -lt 512  ]] && cap=512
    [[ "$cap" -gt 1536 ]] && cap=1536

    local swap_kb swap_mb
    swap_kb=$(grep -m1 '^SwapTotal:' /proc/meminfo 2>/dev/null | awk '{print $2}' || echo 0)
    swap_mb=$(( swap_kb / 1024 ))

    panel "Wenig Arbeitsspeicher erkannt (${mem_mb} MB)" "Der Frontend-Build (vite) ist speicherhungrig. Auf Geraeten mit weniger als
2 GB RAM bricht er oft mit 'Out of memory' ab, weil Docker normalerweise alle
Images gleichzeitig baut.

Safe-Mode dagegen:
• baut die Images nacheinander statt parallel (geringerer Spitzenbedarf)
• begrenzt den Node-Heap des Frontend-Builds auf ${cap} MB
Der Build dauert dadurch laenger, ist aber deutlich stabiler."

    if [[ "$swap_mb" -lt 1024 ]]; then
        warn "Aktueller Swap: ${swap_mb} MB. Bei wenig RAM ist Swap der zuverlaessigste Schutz gegen Build-Abbrueche."
        info "Empfehlung: vorher 1-2 GB Swap einrichten, z.B.:"
        printf "      sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile\n" >&2
        printf "      sudo mkswap /swapfile && sudo swapon /swapfile\n" >&2
        printf "      (dauerhaft: '/swapfile none swap sw 0 0' in /etc/fstab eintragen)\n" >&2
    fi

    echo ""
    local ans=""
    while [[ "$ans" != "j" && "$ans" != "J" && "$ans" != "n" && "$ans" != "N" ]]; do
        read -rp "  Safe-Mode aktivieren? [J/n]: " ans </dev/tty
        [[ -z "$ans" ]] && ans="j"
    done
    if [[ "$ans" == "j" || "$ans" == "J" ]]; then
        SAFE_MODE=true
        WEB_BUILD_NODE_OPTIONS="--max-old-space-size=${cap}"
        success "Safe-Mode aktiv: serieller Build, Node-Heap-Limit ${cap} MB."
    else
        info "Safe-Mode uebersprungen – normaler paralleler Build."
    fi
}

# ── Stack bauen & starten ────────────────────────────────────────────────────
# Build und Containerwechsel sind getrennt: Bis `compose_recreate` bleibt der
# bisherige Stack unangetastet. Das erlaubt einen sicheren Fallback, falls ein
# Build etwa wegen einer temporaer nicht erreichbaren Paketquelle scheitert.
# $1 == "caddy" aktiviert das caddy-Profil, sonst leer.
scanner_profil_aktiv() {
    local profile="${COMPOSE_PROFILES:-}"
    if [[ -f .env ]]; then
        profile=$(grep '^COMPOSE_PROFILES=' .env 2>/dev/null | tail -n1 | cut -d= -f2- || true)
    fi
    [[ ",${profile}," == *,scanner,* ]] && return 0
    docker_runtime inspect postbuch-scanner --format '{{.State.Running}}' 2>/dev/null | grep -q '^true$'
}

profil_zustand_sichern() {
    # Altinstallationen kannten COMPOSE_PROFILES noch nicht. Ein laufender
    # Scanner wird vor der ersten Profil-Compose-Aktion explizit konserviert.
    if scanner_profil_aktiv && [[ -f .env ]]; then
        local profile
        profile=$(grep '^COMPOSE_PROFILES=' .env 2>/dev/null | tail -n1 | cut -d= -f2- || true)
        if [[ ",${profile}," != *,scanner,* ]]; then
            profile="${profile:+$profile,}scanner"
            upsert_env_value .env COMPOSE_PROFILES "$profile"
        fi
    fi
    return 0
}

aktive_code_services() {
    AKTIVE_CODE_SERVICES=(app web)
    scanner_profil_aktiv && AKTIVE_CODE_SERVICES+=(scanner cleaner)
    return 0
}

# Docker/Registry-Aufrufe koennen trotz intakter Konfiguration kurzzeitig an
# DNS, CDN oder Docker Hub scheitern. Solche Fehler duerfen eine lange
# Erstinstallation nicht sofort abbrechen. Echte Fehler (ungueltiges Compose,
# unbekanntes Image, Buildfehler usw.) werden dagegen unveraendert sofort
# weitergereicht. Die Ausgabe bleibt live sichtbar und landet weiterhin im
# normalen Installer-Protokoll; die temporaere Kopie dient nur der Erkennung.
docker_fehler_ist_transient() { # $1 = Datei mit stderr/stdout des Docker-Aufrufs
    grep -Eiq \
        'i/o timeout|TLS handshake timeout|temporary failure in name resolution|server misbehaving|no such host|connection reset by peer|connection timed out|network is unreachable|no route to host|context deadline exceeded|unexpected EOF|http2: server sent GOAWAY|too many requests|toomanyrequests|(unexpected HTTP status|unexpected status|status code).*(502|503|504)|502 Bad Gateway|503 Service Unavailable|504 Gateway Timeout' \
        "$1"
}

docker_mit_netzwerk_retry() { # $1 = Beschreibung; Rest = auszufuehrender Befehl
    local beschreibung="$1"
    shift
    local max_versuche=5 versuch=1 pause status ausgabe
    ausgabe=$(mktemp "${TMPDIR:-/tmp}/postbuch-docker-retry.XXXXXX") || return 1

    while true; do
        : > "$ausgabe"
        if "$@" 2>&1 | tee "$ausgabe"; then
            rm -f "$ausgabe"
            return 0
        else
            # pipefail ist global aktiv; fuer die Rueckgabe brauchen wir den
            # Status des Docker-Befehls, nicht den des protokollierenden tee.
            status=${PIPESTATUS[0]}
        fi

        if ! docker_fehler_ist_transient "$ausgabe"; then
            rm -f "$ausgabe"
            return "$status"
        fi
        if [[ "$versuch" -ge "$max_versuche" ]]; then
            warn "${beschreibung}: temporaerer Netzwerkfehler auch nach ${max_versuche} Versuchen."
            rm -f "$ausgabe"
            return "$status"
        fi

        pause=$((5 * (1 << (versuch - 1))))
        [[ "$pause" -gt 40 ]] && pause=40
        warn "${beschreibung}: temporaerer Docker-/Netzwerkfehler (Versuch ${versuch}/${max_versuche}) – neuer Versuch in ${pause} Sekunden."
        sleep "$pause"
        versuch=$((versuch + 1))
    done
}

# Lange Docker-Builds (besonders xcaddy/go build) koennen minutenlang keine
# Ausgabe erzeugen. Ein Lebenszeichen haelt die SSH-Verbindung waehrenddessen
# aktiv, ohne den Build in den Hintergrund oder von seinem Terminal zu loesen.
build_mit_lebenszeichen() { # $1 = Bezeichnung, $2 = Sekunden, Rest = Build-Befehl
    local bezeichnung="$1" intervall="$2" status=0 lebenszeichen_pid
    shift 2
    (
        local start=$SECONDS schlaf_pid=""
        trap '[[ -z "$schlaf_pid" ]] || kill "$schlaf_pid" 2>/dev/null || true; exit 0' TERM
        while true; do
            sleep "$intervall" &
            schlaf_pid=$!
            wait "$schlaf_pid" || exit 0
            printf '  %s: Build läuft noch (%s Sekunden).\n' "$bezeichnung" "$((SECONDS - start))"
        done
    ) &
    lebenszeichen_pid=$!
    "$@" || status=$?
    kill "$lebenszeichen_pid" 2>/dev/null || true
    wait "$lebenszeichen_pid" 2>/dev/null || true
    return "$status"
}

compose_build() {
    profil_zustand_sichern
    aktive_code_services
    local with_caddy=false
    if [[ "${1:-}" == "caddy" ]]; then
        with_caddy=true
        shift
    fi
    local profile_args=()
    $with_caddy && profile_args=(--profile caddy)

    # Ohne explizite Liste (Erstinstallation, Clean-Reinstall, Rollback) bleibt
    # der bewährte Full-Build bestehen. Nur Updates reichen eine impact-geprüfte
    # Teilmenge ein.
    local code_services=("$@")
    if [[ ${#code_services[@]} -eq 0 ]]; then
        code_services=("${AKTIVE_CODE_SERVICES[@]}")
    fi

    # caddy ist release-unabhaengig (Image haengt nur am caddy/Dockerfile, nicht
    # am App-Code) und der xcaddy-Build dauert auf schwacher Hardware ~20 Min.
    # Daher nur bauen, wenn das Image noch fehlt – sonst wiederverwenden.
    if $with_caddy; then
        if docker_runtime image inspect postbuch-caddy:local2 >/dev/null 2>&1; then
            info "caddy-Image vorhanden – Build uebersprungen."
        else
            # Eigener Retry (statt im Code-Service-Loop unten): xcaddy laedt sehr
            # viele Go-Module aus dem oeffentlichen Modul-Proxy, das ist der mit
            # Abstand laengste Build-Schritt und damit auch der anfaelligste fuer
            # einen transienten Netzwerk-Haenger. Ohne Cache-Mount im Dockerfile
            # startet ein Retry zwar komplett neu, das ist aber immer noch
            # guenstiger als der gesamte Update-Lauf (Download+Verifikation+
            # Backup) von vorn.
            local caddy_versuch caddy_pause
            local caddy_gebaut=false
            for caddy_versuch in 1 2 3; do
                info "Baue caddy (gepinntes Image local2, kann auf schwacher Hardware lange dauern)..."
                if build_mit_lebenszeichen "Caddy" 30 \
                    $DOCKER_COMPOSE "${profile_args[@]}" build caddy; then
                    caddy_gebaut=true
                    break
                fi
                if [[ "$caddy_versuch" -lt 3 ]]; then
                    caddy_pause=$((caddy_versuch * 5))
                    warn "caddy-Build fehlgeschlagen – neuer Versuch in ${caddy_pause} Sekunden."
                    sleep "$caddy_pause"
                fi
            done
            $caddy_gebaut || return 1
        fi
    fi

    # Code-Services bauen: app, web, scanner, cleaner. Ein Wiederholungsversuch
    # ist vor dem Containerwechsel gefahrlos und faengt transiente DNS-Fehler ab.
    # Eine leere explizite Update-Liste wird als Sentinel "kein-code-build"
    # übergeben. Caddy wurde oben ggf. trotzdem geprüft/gebaut.
    if [[ ${#code_services[@]} -eq 1 && "${code_services[0]}" == "kein-code-build" ]]; then
        info "Keine geänderten Code-Services – Image-Build übersprungen."
        return 0
    fi

    local versuch svc gebaut pause
    for versuch in 1 2 3; do
        if [[ "$SAFE_MODE" == "true" ]]; then
            gebaut=true
            for svc in "${code_services[@]}"; do
                info "Baue $svc..."
                if [[ "$svc" == "web" ]]; then
                    build_mit_lebenszeichen "Web" 30 env COMPOSE_BAKE=false \
                        $DOCKER_COMPOSE build \
                        --build-arg "WEB_BUILD_NODE_OPTIONS=$WEB_BUILD_NODE_OPTIONS" web || gebaut=false
                else
                    build_mit_lebenszeichen "$svc" 30 env COMPOSE_BAKE=false \
                        $DOCKER_COMPOSE build "$svc" || gebaut=false
                fi
                $gebaut || break
            done
            $gebaut && return 0
        else
            info "Baue: ${code_services[*]}"
            if build_mit_lebenszeichen "Container" 30 \
                $DOCKER_COMPOSE build "${code_services[@]}"; then
                return 0
            fi
        fi
        if [[ "$versuch" -lt 3 ]]; then
            pause=$((versuch * 5))
            warn "Container-Build fehlgeschlagen – neuer Versuch in ${pause} Sekunden."
            sleep "$pause"
        fi
    done
    return 1
}

pfad_geaendert() { # $1=alter Baum $2=neuer Stage $3=relativer Pfad
    local alt="$1/$3" neu="$2/$3"
    [[ -e "$alt" || -e "$neu" ]] || return 1
    [[ -e "$alt" && -e "$neu" ]] || return 0
    if [[ -d "$alt" && -d "$neu" ]]; then
        ! diff -qr -- "$alt" "$neu" >/dev/null 2>&1
    elif [[ -f "$alt" && -f "$neu" ]]; then
        ! cmp -s -- "$alt" "$neu"
    else
        return 0
    fi
}

compose_service_image_vorhanden() { # $1=Service; im Stage + COMPOSE_PROJECT_NAME aufrufen
    local image_id
    image_id=$($DOCKER_COMPOSE images -q "$1" 2>/dev/null | head -n1 || true)
    [[ -n "$image_id" ]] && docker_runtime image inspect "$image_id" >/dev/null 2>&1
}

# Ermittelt ausschließlich für reguläre Updates, welche lokalen Images wirklich
# neu gebaut werden müssen. Bei unklarer/änderter Compose-Builddefinition wird
# fail-safe alles gebaut. Container-Recreate bleibt davon bewusst unberührt.
update_build_services_bestimmen() { # $1=installierter Baum $2=verifizierter Stage
    local alt="$1" neu="$2" svc
    UPDATE_BUILD_SERVICES=()

    if pfad_geaendert "$alt" "$neu" docker-compose.yml; then
        aktive_code_services
        UPDATE_BUILD_SERVICES=("${AKTIVE_CODE_SERVICES[@]}")
        info "Compose-Definition geändert – baue alle Code-Services fail-safe."
        return 0
    fi

    # VERSION wird in BEIDE Images kopiert. Nur web neu zu bauen erzeugt sonst
    # ein 2.6.3-Frontend vor einem Backend, das sich weiterhin als 2.6.2 meldet
    # und dadurch ein Update auf sich selbst anbietet.
    if pfad_geaendert "$alt" "$neu" app \
        || pfad_geaendert "$alt" "$neu" VERSION \
        || pfad_geaendert "$alt" "$neu" .dockerignore; then
        UPDATE_BUILD_SERVICES+=(app)
    fi
    if pfad_geaendert "$alt" "$neu" web \
        || pfad_geaendert "$alt" "$neu" VERSION \
        || pfad_geaendert "$alt" "$neu" .dockerignore; then
        UPDATE_BUILD_SERVICES+=(web)
    fi
    pfad_geaendert "$alt" "$neu" scanner && UPDATE_BUILD_SERVICES+=(scanner)
    pfad_geaendert "$alt" "$neu" cleaner && UPDATE_BUILD_SERVICES+=(cleaner)

    if ! scanner_profil_aktiv; then
        local gefiltert=()
        for svc in "${UPDATE_BUILD_SERVICES[@]}"; do
            [[ "$svc" == scanner || "$svc" == cleaner ]] || gefiltert+=("$svc")
        done
        UPDATE_BUILD_SERVICES=("${gefiltert[@]}")
    fi

    # Ein fehlendes Zielimage erzwingt den Build auch bei identischem Quellpfad.
    aktive_code_services
    for svc in "${AKTIVE_CODE_SERVICES[@]}"; do
        if ! compose_service_image_vorhanden "$svc"; then
            if [[ " ${UPDATE_BUILD_SERVICES[*]} " != *" $svc "* ]]; then
                UPDATE_BUILD_SERVICES+=("$svc")
            fi
        fi
    done

    if [[ ${#UPDATE_BUILD_SERVICES[@]} -eq 0 ]]; then
        UPDATE_BUILD_SERVICES=(kein-code-build)
    else
        info "Update-Buildauswahl: ${UPDATE_BUILD_SERVICES[*]}"
    fi
}

compose_recreate() {
    profil_zustand_sichern
    aktive_code_services
    local with_caddy=false
    [[ "${1:-}" == "caddy" ]] && with_caddy=true
    local profile_args=()
    $with_caddy && profile_args=(--profile caddy)

    # Recreate nur fuer die Code-Services (+caddy). postgres laeuft als
    # Dependency unveraendert weiter (gepinntes Image, Daten im Volume) – kein
    # unnoetiger DB-Neustart.
    local recreate=("${AKTIVE_CODE_SERVICES[@]}")
    $with_caddy && recreate+=(caddy)
    # Ein normal gestoppter DB-Container wird wieder gestartet, aber niemals
    # wegen eines neuen Compose-Digests ersetzt. Neue Codecontainer gehen erst
    # online, wenn PostgreSQL tatsächlich Verbindungen annimmt.
    docker_mit_netzwerk_retry "PostgreSQL-Start" \
        $DOCKER_COMPOSE up -d --no-deps --no-recreate postgres || return 1
    local waited=0
    until $DOCKER_COMPOSE exec -T postgres pg_isready -q 2>/dev/null; do
        if [[ "$waited" -ge 60 ]]; then
            error "PostgreSQL ist nicht bereit; Code-Container werden nicht ersetzt."
            return 1
        fi
        sleep 2
        waited=$((waited + 2))
    done
    info "Starte Container neu..."
    docker_mit_netzwerk_retry "Containerstart" \
        $DOCKER_COMPOSE "${profile_args[@]}" up -d --force-recreate --no-deps "${recreate[@]}"
}

# ── Warten, bis die App nach einem Containerwechsel wirklich antwortet ────────
# `docker compose up -d` meldet schon Erfolg, sobald der Container GESTARTET
# ist – nicht wenn der App-Prozess laeuft. Schlaegt die Schema-Migration in
# app/docker-entrypoint.sh fehl (`set -e` + `ON_ERROR_STOP=1`, lang VOR
# `exec node`), stirbt der Container, ohne dass `up -d` das je gemeldet haette.
# Ohne diesen Check wuerde ein Migrationsfehler still als "Update erfolgreich"
# durchgehen.
warte_auf_app_gesund() {   # $1 = Timeout Sekunden (Default 90)
    local timeout="${1:-90}"
    local web_port
    web_port=$(grep '^WEB_PORT=' "$INSTALL_DIR/.env" 2>/dev/null | cut -d'=' -f2-)
    [[ -z "$web_port" ]] && web_port=3420
    local waited=0
    until curl -sf "http://localhost:${web_port}/api/health" >/dev/null 2>&1; do
        if [[ "$waited" -ge "$timeout" ]]; then
            return 1
        fi
        sleep 2
        waited=$((waited + 2))
    done
    return 0
}

compose_up_build() {
    if [[ "${1:-}" == "caddy" ]]; then
        compose_build caddy && compose_recreate caddy
    else
        compose_build && compose_recreate
    fi
}

# Nur fuer Erstinstallation, Clean-Neuinstallation oder Rollback nach einem
# vorherigen `compose down`: Hier muss PostgreSQL absichtlich mit gestartet
# werden. Reguläre Updates und restart.sh verwenden dagegen --no-deps.
compose_up_build_all() {
    profil_zustand_sichern
    aktive_code_services
    local with_caddy=false
    [[ "${1:-}" == "caddy" ]] && with_caddy=true
    local profile_args=()
    $with_caddy && profile_args=(--profile caddy)
    local services=(postgres "${AKTIVE_CODE_SERVICES[@]}")
    $with_caddy && services+=(caddy)

    if $with_caddy; then
        compose_build caddy || return 1
    else
        compose_build || return 1
    fi
    info "Starte vollständigen Stack..."
    docker_mit_netzwerk_retry "Vollstaendiger Stack-Start" \
        $DOCKER_COMPOSE "${profile_args[@]}" up -d --force-recreate "${services[@]}"
}

# ── restart.sh generieren ────────────────────────────────────────────────────
# Im Safe-Mode wird der serielle Build samt Heap-Limit fest eingebacken, damit
# auch ein spaeterer Neustart auf dem schwachen Geraet nicht in OOM laeuft.
write_restart_script() {
    local RESTART_SCRIPT="$INSTALL_DIR/restart.sh"
    if [[ "$SAFE_MODE" == "true" ]]; then
        cat > "$RESTART_SCRIPT" <<RESTARTEOF
#!/usr/bin/env bash
# Postbuch neu starten und neu bauen (Safe-Mode: serieller Build, Heap-Limit).
# Auf diesem Geraet wurde wenig RAM erkannt – Builds laufen daher nacheinander.
# Ausfuehren nach .env-Aenderungen oder wenn die App haengt.
set -euo pipefail
cd "\$(dirname "\$0")"
DUCKDNS_TOKEN=\$(grep '^DUCKDNS_API_TOKEN=' .env 2>/dev/null | cut -d'=' -f2- || true)
COMPOSE_PROFILES_WERT=\$(grep '^COMPOSE_PROFILES=' .env 2>/dev/null | cut -d'=' -f2- || true)
PROFILE_ARGS=()
[[ -n "\$DUCKDNS_TOKEN" ]] && PROFILE_ARGS=(--profile caddy)
CODE_SERVICES=(app web)
if [[ ",\$COMPOSE_PROFILES_WERT," == *,scanner,* ]]; then
    PROFILE_ARGS+=(--profile scanner)
    CODE_SERVICES+=(scanner cleaner)
fi
# caddy nur einmalig bauen (release-unabhaengig, teurer xcaddy-Build);
# vorhandenes Image umtaggen statt neu zu bauen
if [[ -n "\$DUCKDNS_TOKEN" ]] && ! docker image inspect postbuch-caddy:local2 >/dev/null 2>&1; then
    for caddy_versuch in 1 2 3; do
        echo "Baue caddy (gepinntes Image local2)..."
        docker compose "\${PROFILE_ARGS[@]}" build caddy && break
        if [[ "\$caddy_versuch" -lt 3 ]]; then
            caddy_pause=\$((caddy_versuch * 5))
            echo "caddy-Build fehlgeschlagen – neuer Versuch in \${caddy_pause} Sekunden."
            sleep "\$caddy_pause"
        else
            echo "FEHLER: caddy-Build nach 3 Versuchen fehlgeschlagen." >&2
            exit 1
        fi
    done
fi
echo "Baue \${CODE_SERVICES[*]} (Safe-Mode, seriell)..."
for svc in "\${CODE_SERVICES[@]}"; do
    echo "  Baue \$svc..."
    if [[ "\$svc" == "web" ]]; then
        COMPOSE_BAKE=false docker compose build --build-arg "WEB_BUILD_NODE_OPTIONS=$WEB_BUILD_NODE_OPTIONS" web
    else
        COMPOSE_BAKE=false docker compose build "\$svc"
    fi
done
RECREATE=("\${CODE_SERVICES[@]}")
[[ -n "\$DUCKDNS_TOKEN" ]] && RECREATE+=(caddy)
# Nur die Code-Services ersetzen; PostgreSQL bleibt ohne Grund online.
docker compose up -d --no-deps --no-recreate postgres
waited=0
until docker compose exec -T postgres pg_isready -q 2>/dev/null; do
    if [[ "\$waited" -ge 60 ]]; then
        echo "FEHLER: PostgreSQL ist nicht bereit; Code-Container werden nicht ersetzt." >&2
        exit 1
    fi
    sleep 2; waited=\$((waited + 2))
done
docker compose "\${PROFILE_ARGS[@]}" up -d --force-recreate --no-deps "\${RECREATE[@]}"
echo ""
echo "Fertig! postbuch.net laeuft wieder."
RESTARTEOF
    else
        cat > "$RESTART_SCRIPT" <<'RESTARTEOF'
#!/usr/bin/env bash
# Postbuch neu starten und ggf. neu bauen.
# Ausführen nach .env-Änderungen oder wenn die App hängt.
set -euo pipefail
cd "$(dirname "$0")"
DUCKDNS_TOKEN=$(grep '^DUCKDNS_API_TOKEN=' .env 2>/dev/null | cut -d'=' -f2- || true)
COMPOSE_PROFILES_WERT=$(grep '^COMPOSE_PROFILES=' .env 2>/dev/null | cut -d'=' -f2- || true)
PROFILE_ARGS=()
[[ -n "$DUCKDNS_TOKEN" ]] && PROFILE_ARGS=(--profile caddy)
CODE_SERVICES=(app web)
if [[ ",$COMPOSE_PROFILES_WERT," == *,scanner,* ]]; then
    PROFILE_ARGS+=(--profile scanner)
    CODE_SERVICES+=(scanner cleaner)
fi
# caddy nur einmalig bauen (release-unabhaengig, teurer xcaddy-Build);
# vorhandenes Image umtaggen statt neu zu bauen
if [[ -n "$DUCKDNS_TOKEN" ]] && ! docker image inspect postbuch-caddy:local2 >/dev/null 2>&1; then
    for caddy_versuch in 1 2 3; do
        echo "Baue caddy (gepinntes Image local2)..."
        docker compose "${PROFILE_ARGS[@]}" build caddy && break
        if [[ "$caddy_versuch" -lt 3 ]]; then
            caddy_pause=$((caddy_versuch * 5))
            echo "caddy-Build fehlgeschlagen – neuer Versuch in ${caddy_pause} Sekunden."
            sleep "$caddy_pause"
        else
            echo "FEHLER: caddy-Build nach 3 Versuchen fehlgeschlagen." >&2
            exit 1
        fi
    done
fi
echo "Baue ${CODE_SERVICES[*]}..."
docker compose build "${CODE_SERVICES[@]}"
RECREATE=("${CODE_SERVICES[@]}")
[[ -n "$DUCKDNS_TOKEN" ]] && RECREATE+=(caddy)
# Nur die Code-Services ersetzen; PostgreSQL bleibt ohne Grund online.
docker compose up -d --no-deps --no-recreate postgres
waited=0
until docker compose exec -T postgres pg_isready -q 2>/dev/null; do
    if [[ "$waited" -ge 60 ]]; then
        echo "FEHLER: PostgreSQL ist nicht bereit; Code-Container werden nicht ersetzt." >&2
        exit 1
    fi
    sleep 2; waited=$((waited + 2))
done
docker compose "${PROFILE_ARGS[@]}" up -d --force-recreate --no-deps "${RECREATE[@]}"
echo ""
echo "Fertig! postbuch.net läuft wieder."
RESTARTEOF
    fi
    chmod +x "$RESTART_SCRIPT"
    if [[ $(id -u) -eq 0 ]]; then
        chown "$(installations_besitzer_bestimmen "$INSTALL_DIR")" "$RESTART_SCRIPT" || return 1
    fi
}

# ── Lokale Installer-Kopie ────────────────────────────────────────────────────
# Deinstallation, Rollback, Adminpasswort und Stack-Steuerung brauchen kein
# Netz: SCHRITT 2 ueberspringt die Bezugsquelle fuer sie. Ohne lokale Kopie
# muesste der Nutzer den Installer trotzdem erst herunterladen. Der Release-
# Baum bringt ihn unter deploy-pages/ ohnehin mit — hier landet er zusaetzlich
# sichtbar im Wurzelverzeichnis der Installation, also genau unter dem Pfad,
# den die Hinweistexte nennen ("./install.sh --rollback").
#
# Geschrieben wird ueber mktemp + mv, nie mit "cp -f" direkt aufs Ziel: Laeuft
# dieses Skript gerade aus genau dieser Datei, wuerde ein Ueberschreiben sie
# unter dem noch lesenden bash-Prozess abschneiden. Ein mv ersetzt statt-
# dessen nur den Verzeichniseintrag; der alte Inode bleibt bis zum Ende des
# Laufs geoeffnet und gueltig.
#
# Die Kopie wird nach jeder Promotion neu gezogen — rsync --delete raeumt sie
# beim Update ab, und sie soll immer die des installierten Releases sein.
write_lokale_installerkopie() {
    local quelle="$INSTALL_DIR/deploy-pages/install.sh"
    local ziel="$INSTALL_DIR/install.sh" tmp
    # Eine fehlende Kopie ist ein Komfortverlust, kein Installationsfehler:
    # niemals den laufenden Vorgang daran scheitern lassen.
    if [[ ! -f "$quelle" ]]; then
        warn "Installer-Kopie nicht gefunden ($quelle) – $ziel wurde nicht angelegt."
        return 0
    fi
    tmp=$(mktemp "$INSTALL_DIR/.install.sh.XXXXXX") || { warn "Installer-Kopie fehlgeschlagen."; return 0; }
    if ! cp -f "$quelle" "$tmp"; then
        rm -f "$tmp"
        warn "Installer-Kopie nach $ziel fehlgeschlagen."
        return 0
    fi
    chmod 755 "$tmp" || true
    if [[ $(id -u) -eq 0 ]]; then
        chown "$(installations_besitzer_bestimmen "$INSTALL_DIR")" "$tmp" || true
    fi
    if ! mv -f "$tmp" "$ziel"; then
        rm -f "$tmp"
        warn "Installer-Kopie nach $ziel fehlgeschlagen."
    fi
    return 0
}

# ── Vor-Update-Backup ──────────────────────────────────────────────────────────
# Sichert den laufenden Quellcode + DB (ohne post_files-Tabelleninhalt) in
# $INSTALL_DIR/backups/backup_YYYYMMDD_HHMMSS/. Gibt den Backup-Pfad aus.
# Hält maximal 3 Backups vor.
backup_altbestand_besitz_sicherstellen() {
    local basis="$INSTALL_DIR/backups" erwartet pfad ist
    [[ -d "$basis" ]] || return 0
    erwartet=$(installations_besitzer_bestimmen "$INSTALL_DIR") || return 1
    if [[ $(id -u) -eq 0 ]]; then
        # Selbstheilung für Sicherungen alter Agent-Versionen. Modi bleiben
        # 700/600; nur uid/gid werden auf den Installationsbesitzer korrigiert.
        chown -R "$erwartet" "$basis" || return 1
        return 0
    fi
    for pfad in "$basis" "$basis"/backup_*; do
        [[ -e "$pfad" ]] || continue
        ist=$(stat -c '%u:%g' "$pfad" 2>/dev/null || true)
        if [[ "$ist" != "$erwartet" ]]; then
            warn "Alte Sicherungen gehören nicht dem Installationsnutzer und können weder geprüft noch rotiert werden."
            printf "  Einmalig reparieren: sudo chown -R %q:%q %q\n" \
                "$(id -un)" "$(id -gn)" "$basis"
            return 1
        fi
    done
}

backup_current_installation() {
    local BACKUP_TS BACKUP_BESITZER
    backup_altbestand_besitz_sicherstellen || return 1
    BACKUP_TS=$(date '+%Y%m%d_%H%M%S')
    local BACKUP_DIR="$INSTALL_DIR/backups/backup_$BACKUP_TS"
    BACKUP_BESITZER=$(installations_besitzer_bestimmen "$INSTALL_DIR") || return 1
    mkdir -p "$BACKUP_DIR"

    local VER
    VER=$(cat "$INSTALL_DIR/VERSION" 2>/dev/null | tr -d '[:space:]' || echo "unbekannt")
    printf "version=%s\ntimestamp=%s\n" "$VER" "$(date '+%Y-%m-%d %H:%M:%S')" \
        > "$BACKUP_DIR/metadata.txt"

    # Backup-Verzeichnis abschotten: db.sql.gz enthaelt _settings im Klartext,
    # also OneDrive-Refresh-Token, Nextcloud-App-Passwort, alle KI-Schluessel
    # und session_secret; Altstaende ggf. auch app_password. Ein 644-Archiv
    # daneben entwertet das
    # chmod 600 auf der .env vollstaendig.
    chmod 700 "$INSTALL_DIR/backups" 2>/dev/null || true
    chmod 700 "$BACKUP_DIR"

    info "  Sichere Quellcode..."
    # .env ausgeschlossen: sie wird unten separat mit 600 abgelegt und von
    # do_rollback auch von dort wiederhergestellt (nach dem Entpacken). Im
    # Tarball lag sie bisher zusaetzlich, aber ungeschuetzt.
    tar -czf "$BACKUP_DIR/source.tar.gz" \
        -C "$INSTALL_DIR" \
        --exclude="./data" \
        --exclude="./backups" \
        --exclude="./.git" \
        --exclude="./.env" \
        . 2>/dev/null
    chmod 600 "$BACKUP_DIR/source.tar.gz"
    success "  Quellcode gesichert."

    cp "$INSTALL_DIR/.env" "$BACKUP_DIR/.env"
    chmod 600 "$BACKUP_DIR/.env"

    local DB_USER DB_PW DB_NAME
    DB_USER=$(grep '^POSTGRES_USER='     "$INSTALL_DIR/.env" | cut -d'=' -f2- || echo "postbuch")
    DB_PW=$(grep  '^POSTGRES_PASSWORD=' "$INSTALL_DIR/.env" | cut -d'=' -f2-)
    DB_NAME=$(grep '^POSTGRES_DB='      "$INSTALL_DIR/.env" | cut -d'=' -f2- || echo "postbuch")

    if docker_runtime inspect postbuch-postgres \
            --format '{{.State.Running}}' 2>/dev/null | grep -q "true"; then
        info "  Sichere Datenbank (ohne regenerierbare Cache-Inhalte)..."
        if docker_runtime exec postbuch-postgres \
                env PGPASSWORD="$DB_PW" \
                pg_dump \
                    -U "$DB_USER" -d "$DB_NAME" \
                    --format=plain \
                    --clean --if-exists \
                    --exclude-table-data='postbuch.post_files' \
                    --exclude-table-data='postbuch._hilfe_abschnitt' \
                    --exclude-table-data='postbuch._hilfe_korpus' \
            2>/dev/null \
            | gzip > "$BACKUP_DIR/db.sql.gz"; then
            chmod 600 "$BACKUP_DIR/db.sql.gz"
            success "  Datenbank gesichert."
        else
            warn "  pg_dump fehlgeschlagen – Datenbank nicht im Backup enthalten."
            rm -f "$BACKUP_DIR/db.sql.gz"
        fi
    else
        warn "  PostgreSQL-Container läuft nicht – Datenbank nicht gesichert."
    fi

    local old_backups
    mapfile -t old_backups < <(
        ls -dt "$INSTALL_DIR/backups"/backup_* 2>/dev/null | tail -n +4
    )
    for old in "${old_backups[@]}"; do
        rm -rf "$old"
    done

    # Der systemd-Update-Agent läuft für Docker bewusst als root. Alles im
    # benutzereigenen Installationsbaum muss trotzdem dem Installationsnutzer
    # gehören, sonst kann dieser seine Sicherungen weder prüfen noch ohne sudo
    # zurückrollen. Die restriktiven Modi bleiben dabei unverändert.
    if [[ $(id -u) -eq 0 ]]; then
        chown -R "$BACKUP_BESITZER" "$BACKUP_DIR" || return 1
        chown "$BACKUP_BESITZER" "$INSTALL_DIR/backups" || return 1
    fi

    echo "$BACKUP_DIR"
}

# ── Sicherer Vor-Containerwechsel-Fallback ───────────────────────────────────
# Ausschliesslich fuer den nicht-interaktiven Agenten. Nach einem fehlgeschlagenen
# Build wurden noch keine Container ersetzt und keine DB-Migration ausgefuehrt.
# Deshalb wird nur Quellbaum und .env zurueckgesetzt; data/ und backups/ bleiben
# unangetastet. Ein DB-Restore waere hier Datenverlust ohne Nutzen.
source_aus_backup_wiederherstellen() {   # $1 = Backup-Verzeichnis
    local backup="$1" quelle="$1/source.tar.gz" env="$1/.env" tmp
    if [[ ! -f "$quelle" || ! -f "$env" ]]; then
        error "Automatischer Fallback nicht moeglich: Quellcode- oder .env-Sicherung fehlt."
        return 1
    fi
    tmp=$(mktemp -d) || { error "Automatischer Fallback nicht moeglich: temporaeres Verzeichnis fehlt."; return 1; }
    if ! tar -xzf "$quelle" -C "$tmp"; then
        rm -rf "$tmp"
        error "Automatischer Fallback nicht moeglich: Quellcode-Sicherung ist nicht lesbar."
        return 1
    fi
    if command -v rsync >/dev/null 2>&1; then
        if ! rsync -a --delete \
                --exclude='/data/' --exclude='/backups/' --exclude='/.env' \
                "$tmp/" "$INSTALL_DIR/"; then
            rm -rf "$tmp"
            error "Automatischer Fallback nicht moeglich: Quellcode konnte nicht zurueckgeschrieben werden."
            return 1
        fi
    else
        # rsync gehoert nicht zu den harten Installer-Voraussetzungen. Der
        # Overlay-Fallback stellt alle Dateien des alten Stands wieder her;
        # lediglich neue, harmlose Dateien des fehlgeschlagenen Releases koennen
        # liegen bleiben. Datenverzeichnisse werden auch hier nicht beruehrt.
        warn "rsync fehlt – stelle den gesicherten Quellcode als sicheren Overlay-Fallback wieder her."
        if ! tar -xzf "$quelle" -C "$INSTALL_DIR"; then
            rm -rf "$tmp"
            error "Automatischer Fallback nicht moeglich: Quellcode konnte nicht zurueckgeschrieben werden."
            return 1
        fi
    fi
    rm -rf "$tmp"
    cp "$env" "$INSTALL_DIR/.env" && chmod 600 "$INSTALL_DIR/.env"
}

# ── Rollback auf Backup ────────────────────────────────────────────────────────
# Ein Service Worker lebt im Browser unabhängig vom Server-Quellbaum weiter.
# Alte Releases enthielten einen fetch-Handler, der Netzwerkfehler als
# synthetischen HTTP 503 maskierte. Auch ein alter Rollback-Quellbaum erhält
# deshalb vor dem Build einen kompatiblen Push-Worker ohne Fetch-Interception.
rollback_service_worker_absichern() {
    local ziel="$INSTALL_DIR/web/public/service-worker.js"
    [[ -d "$INSTALL_DIR/web/public" ]] || return 0
    cat > "$ziel" <<'SWEOF'
/* Postbuch rollback-safe service worker: Push ja, Fetch-Interception nein. */
const ICON = '/Postbuch-Logo192.png';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('push', (event) => {
  if (!event.data) return;
  let data = {};
  try { data = event.data.json(); } catch { data = { title: 'postbuch.net', body: event.data.text() }; }
  const tag = data.tag || '';
  const duplicate = tag.startsWith('dup-') && !tag.startsWith('dup-resolved');
  event.waitUntil(self.registration.showNotification(data.title || 'postbuch.net', {
    body: data.body || '', icon: ICON, badge: ICON, tag,
    requireInteraction: !!data.requireInteraction || duplicate,
    vibrate: duplicate ? [200, 100, 200, 100, 400] : [200],
    data: { url: data.url || '/' },
  }));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
    if (!windows.length) return self.clients.openWindow(target);
    const windowClient = windows[0];
    if ('navigate' in windowClient) return windowClient.navigate(target).then((client) => (client || windowClient).focus());
    windowClient.postMessage({ type: 'SW_NAVIGATE', url: target });
    return windowClient.focus();
  }));
});
SWEOF
    chmod 644 "$ziel"
    if [[ $(id -u) -eq 0 ]]; then
        chown "$(installations_besitzer_bestimmen "$INSTALL_DIR")" "$ziel" || return 1
    fi
}

do_rollback() {
    local BACKUP_BASE="$INSTALL_DIR/backups"

    local backup_dirs=()
    mapfile -t backup_dirs < <(
        ls -dt "$BACKUP_BASE"/backup_* 2>/dev/null
    )
    if [[ ${#backup_dirs[@]} -eq 0 ]]; then
        warn "Keine Backups vorhanden."
        return 0
    fi

    # Nicht lesbar ist nicht dasselbe wie "ohne DB-Dump". Der alte Dialog
    # konnte root-eigene Agent-Backups dadurch gefährlich falsch darstellen.
    if [[ $(id -u) -ne 0 ]]; then
        local unlesbar=false backup_pruef
        for backup_pruef in "${backup_dirs[@]}"; do
            if [[ ! -x "$backup_pruef" || ! -r "$backup_pruef/metadata.txt" ]]; then
                unlesbar=true
                break
            fi
        done
        if $unlesbar; then
            warn "Mindestens eine Sicherung ist wegen falscher Eigentümerschaft nicht lesbar."
            printf "  Einmalig reparieren: sudo chown -R %q:%q %q\n" \
                "$(id -un)" "$(id -gn)" "$BACKUP_BASE"
            warn "Rollback wurde vor der Backup-Auswahl abgebrochen."
            return 1
        fi
    fi

    hr
    echo ""
    echo "  Verfügbare Backups:"
    echo ""
    local i
    for i in "${!backup_dirs[@]}"; do
        local meta="${backup_dirs[$i]}/metadata.txt"
        local ver ts db_ok
        ver=$(grep '^version='   "$meta" 2>/dev/null | cut -d'=' -f2- || echo "?")
        ts=$(grep  '^timestamp=' "$meta" 2>/dev/null | cut -d'=' -f2- || echo "?")
        if [[ -f "${backup_dirs[$i]}/db.sql.gz" ]]; then
            db_ok="(inkl. DB)"
        else
            db_ok="(OHNE DB-Dump!)"
        fi
        printf "    [%d]  %s  Version %s  %s\n" "$((i+1))" "$ts" "$ver" "$db_ok"
    done
    echo ""

    local SEL=""
    while true; do
        read -rp "  Welches Backup? [1-${#backup_dirs[@]}] (Abbruch: Enter): " SEL </dev/tty
        if [[ -z "$SEL" ]]; then
            echo "  Abgebrochen."
            return 0
        fi
        if [[ "$SEL" =~ ^[0-9]+$ ]] && \
           [[ "$SEL" -ge 1 ]] && \
           [[ "$SEL" -le "${#backup_dirs[@]}" ]]; then
            break
        fi
        warn "Ungültige Auswahl."
    done

    local SELECTED="${backup_dirs[$((SEL-1))]}"
    local SEL_VER SEL_TS
    SEL_VER=$(grep '^version='   "$SELECTED/metadata.txt" 2>/dev/null | cut -d'=' -f2- || echo "?")
    SEL_TS=$(grep  '^timestamp=' "$SELECTED/metadata.txt" 2>/dev/null | cut -d'=' -f2- || echo "?")

    local HAT_DB_DUMP=false
    [[ -f "$SELECTED/db.sql.gz" ]] && HAT_DB_DUMP=true

    local AKTUELLE_VERSION="?"
    [[ -f "$INSTALL_DIR/VERSION" ]] && AKTUELLE_VERSION=$(tr -d '[:space:]' < "$INSTALL_DIR/VERSION")

    # DB-Restore ist eine eigene Entscheidung, getrennt von der finalen
    # 'ROLLBACK'-Tippbestätigung weiter unten: die Frage sammelt den Intent
    # (Code+DB oder nur Code), die Tippbestätigung bleibt die einzige harte
    # Ausführungssperre.
    local DB_ROLLBACK="n"
    if $HAT_DB_DUMP; then
        hr
        echo ""
        echo "  Dieses Backup enthält auch einen Datenbank-Dump vom Backup-Zeitpunkt."
        echo "  Standardmäßig wird die Datenbank MIT zurückgerollt, damit Code und Datenbank"
        echo "  zueinander passen – siehe die ausführliche Warnung weiter unten dazu, warum"
        echo "  Code ohne passende DB dauerhaft inkonsistente Daten erzeugen kann."
        echo "    • Ja (Standard): Alle Daten, die seit dem Backup (${SEL_TS}) angelegt wurden, gehen verloren."
        printf "    • Nein:          Datenbank bleibt auf dem aktuellen (neueren) Stand – Risiko für Code Version %s.\n" "$SEL_VER"
        echo ""
        local DB_CHOICE=""
        while [[ "$DB_CHOICE" != "j" && "$DB_CHOICE" != "J" && "$DB_CHOICE" != "n" && "$DB_CHOICE" != "N" ]]; do
            DB_CHOICE=$(prompt "Datenbank ebenfalls zurückrollen? [J/n]" "J")
        done
        if [[ "$DB_CHOICE" == "j" || "$DB_CHOICE" == "J" ]]; then
            DB_ROLLBACK="j"
        else
            # Abweichung vom sicheren Standard braucht eine zweite, bewusste
            # Bestätigung. Ohne sie faellt die Entscheidung auf den DB-Rollback
            # zurueck statt stillschweigend beim riskanteren Pfad zu bleiben.
            warn "Ohne DB-Rollback kann die Datenbank dauerhaft inkonsistent werden (Backfill-Lücken,"
            warn "künftige Updates können daran scheitern – Details in der Warnung weiter unten)."
            echo ""
            local DB_CHOICE2=""
            while [[ "$DB_CHOICE2" != "j" && "$DB_CHOICE2" != "J" && "$DB_CHOICE2" != "n" && "$DB_CHOICE2" != "N" ]]; do
                DB_CHOICE2=$(prompt "Wirklich OHNE Datenbank-Rollback fortfahren? [j/N]" "N")
            done
            if [[ "$DB_CHOICE2" == "j" || "$DB_CHOICE2" == "J" ]]; then
                DB_ROLLBACK="n"
            else
                DB_ROLLBACK="j"
                info "Datenbank wird doch mitgerollt."
            fi
        fi
    fi

    hr
    echo ""
    printf "  ${C_RED}${C_BOLD}WARNUNG: DATENVERLUST${C_RESET}\n"
    echo ""
    echo "  Folgendes wird unwiderruflich gelöscht / überschrieben:"
    echo "    • Der gesamte Quellcode der aktuell installierten Version"
    if [[ "$DB_ROLLBACK" == "j" ]]; then
        echo "    • Die gesamte aktuelle Datenbank (alle Einträge seit dem Backup!)"
        echo "    • Alle Dokumente, Einstellungen und Nutzerhistorie, die nach dem"
        printf "      Backup-Zeitpunkt (%s) angelegt wurden\n" "$SEL_TS"
    fi
    echo ""
    echo "  Wiederhergestellt wird:"
    printf "    • Quellcode und Konfiguration aus dem Backup (Version %s)\n" "$SEL_VER"
    if [[ "$DB_ROLLBACK" == "j" ]]; then
        echo "    • Datenbank wie zum Backup-Zeitpunkt"
    elif $HAT_DB_DUMP; then
        echo ""
        warn "    Datenbank bleibt UNVERÄNDERT auf dem aktuellen (neueren) Stand."
        local SCHEMA_HINWEIS=""
        if [[ "$AKTUELLE_VERSION" =~ ^[0-9]+\.[0-9]+\. && "$SEL_VER" =~ ^[0-9]+\.[0-9]+\. ]]; then
            local akt_mm="${AKTUELLE_VERSION%.*}" sel_mm="${SEL_VER%.*}"
            if [[ "$akt_mm" != "$sel_mm" ]]; then
                SCHEMA_HINWEIS=" (${AKTUELLE_VERSION} → ${SEL_VER}, unterschiedliche Minor-Version – Schema-Änderung wahrscheinlich)"
            fi
        fi
        warn "    GEFAHR FÜR DIE DATENINTEGRITÄT, nicht nur Kompatibilität: Neue Spalten werden bei ihrer"
        warn "    Einführung oft aus bestehenden Daten befüllt (Backfill). Der wiederhergestellte, ältere"
        warn "    Code (${SEL_VER}) kennt diese Spalten nicht und befüllt sie bei NEU angelegten Datensätzen"
        warn "    nicht mit – diese bleiben leer/inkonsistent und werden bei einem späteren erneuten Update"
        warn "    NICHT automatisch nachgeholt, wenn das Backfill nur einmalig lief. Schlimmstenfalls"
        warn "    verhindert das künftige Updates dauerhaft (z. B. wenn eine spätere Migration eine"
        warn "    NOT-NULL-Regel auf genau diese Spalte setzen will und an den Lücken scheitert)."
        warn "    DB-Stand: Version ${AKTUELLE_VERSION}${SCHEMA_HINWEIS}. Im Zweifel lieber 'Ja' bei der DB-Frage wählen."
    else
        warn "    Dieses Backup enthält KEINEN DB-Dump – Datenbank wird NICHT wiederhergestellt!"
    fi
    echo ""
    warn "Diese Aktion kann nicht rückgängig gemacht werden!"
    echo ""
    local CONFIRM=""
    read -rp "  Zur Bestätigung 'ROLLBACK' eingeben (Abbruch: Enter): " CONFIRM </dev/tty
    if [[ "$CONFIRM" != "ROLLBACK" ]]; then
        echo ""
        echo "  Abgebrochen."
        return 0
    fi

    # Docker Compose ermitteln (do_rollback läuft vor SCHRITT 3)
    local DC="docker compose"
    if ! docker info &>/dev/null 2>&1; then
        DC="sudo docker compose"
    fi
    # compose_up_build nutzt die globale Variable DOCKER_COMPOSE.
    DOCKER_COMPOSE="$DC"

    hr
    echo ""
    info "Stoppe Docker-Stack..."
    cd "$INSTALL_DIR"
    $DC down 2>/dev/null || true

    info "Stelle Quellcode wieder her..."
    tar -xzf "$SELECTED/source.tar.gz" -C "$INSTALL_DIR"
    rollback_service_worker_absichern \
        || error "Rollback-sicherer Service Worker konnte nicht geschrieben werden."

    info "Stelle .env wieder her..."
    cp "$SELECTED/.env" "$INSTALL_DIR/.env"
    chmod 600 "$INSTALL_DIR/.env"

    if [[ "$DB_ROLLBACK" == "j" ]]; then
        local DB_USER DB_PW DB_NAME
        DB_USER=$(grep '^POSTGRES_USER='     "$INSTALL_DIR/.env" | cut -d'=' -f2- || echo "postbuch")
        DB_PW=$(grep  '^POSTGRES_PASSWORD=' "$INSTALL_DIR/.env" | cut -d'=' -f2-)
        DB_NAME=$(grep '^POSTGRES_DB='      "$INSTALL_DIR/.env" | cut -d'=' -f2- || echo "postbuch")
        [[ "$DB_USER" =~ ^[A-Za-z_][A-Za-z0-9_]{0,62}$ ]] \
            || error "Ungültiger PostgreSQL-Nutzer in .env – DB-Rollback abgebrochen."
        [[ "$DB_NAME" =~ ^[A-Za-z_][A-Za-z0-9_]{0,62}$ \
           && "$DB_NAME" != "postgres" && "$DB_NAME" != "template0" && "$DB_NAME" != "template1" ]] \
            || error "Ungültiger/geschützter PostgreSQL-Datenbankname in .env – DB-Rollback abgebrochen."

        info "Starte PostgreSQL..."
        $DC up -d postgres

        info "Warte auf PostgreSQL..."
        local waited=0
        until docker_runtime exec postbuch-postgres \
                pg_isready -U "$DB_USER" -q 2>/dev/null \
              || [[ $waited -ge 60 ]]; do
            sleep 2; waited=$((waited+2))
        done
        if [[ $waited -ge 60 ]]; then
            error "PostgreSQL nicht bereit – Rollback abgebrochen. Bitte $INSTALL_DIR manuell prüfen."
        fi

        info "Prüfe Datenbank-Dump..."
        gzip -t "$SELECTED/db.sql.gz" \
            || error "Datenbank-Dump ist beschädigt – bestehende Datenbank bleibt unverändert."

        # Ein Plain-SQL-Dump mit --clean kennt nur Objekte seines eigenen
        # Zeitpunkts. Neuere Tabellen/FKs können alte DROPs blockieren; psql
        # lief früher trotzdem bis zum Ende und meldete Exit 0. Für einen
        # echten Versionsrollback deshalb die Zieldatenbank vollständig neu
        # anlegen und den Dump atomar mit ON_ERROR_STOP importieren.
        info "Lege Zieldatenbank für den alten Stand frisch an..."
        docker_runtime exec postbuch-postgres env PGPASSWORD="$DB_PW" \
            dropdb -U "$DB_USER" --if-exists --force "$DB_NAME" \
            || error "Aktuelle Datenbank konnte nicht entfernt werden – Rollback gestoppt."
        docker_runtime exec postbuch-postgres env PGPASSWORD="$DB_PW" \
            createdb -U "$DB_USER" -O "$DB_USER" "$DB_NAME" \
            || error "Leere Zieldatenbank konnte nicht angelegt werden – Rollback gestoppt."

        info "Stelle Datenbank atomar wieder her..."
        if ! gunzip -c "$SELECTED/db.sql.gz" | \
            docker_runtime exec -i postbuch-postgres \
            env PGPASSWORD="$DB_PW" \
            psql -v ON_ERROR_STOP=1 --single-transaction \
                -U "$DB_USER" -d "$DB_NAME" -q; then
            error "Datenbank-Restore fehlgeschlagen; der Stack wird nicht mit gemischtem Schema gestartet."
        fi
        success "Datenbank wiederhergestellt."
    elif $HAT_DB_DUMP; then
        info "Datenbank bleibt auf Wunsch unverändert (DB-Dump im Backup vorhanden, aber nicht eingespielt)."
    else
        warn "Kein DB-Dump im Backup – Datenbank wird nicht verändert."
    fi

    # Safe-Mode auch beim Rollback anbieten (baut den wiederhergestellten
    # Quellcode neu – auf schwacher Hardware sonst OOM-gefaehrdet).
    detect_and_offer_safe_mode

    info "Starte Stack..."
    local ROLLBACK_DUCKDNS
    ROLLBACK_DUCKDNS=$(grep '^DUCKDNS_API_TOKEN=' "$INSTALL_DIR/.env" | cut -d'=' -f2- || true)
    if [[ -n "$ROLLBACK_DUCKDNS" ]]; then
        compose_up_build_all caddy
    else
        compose_up_build_all
    fi

    info "Warte, bis die App wieder antwortet..."
    if warte_auf_app_gesund; then
        success "App antwortet wieder."
    else
        warn "App antwortet nach dem Rollback nicht auf /api/health. Bitte 'docker compose logs app' pruefen –"
        warn "moeglicherweise passt der wiederhergestellte Code nicht zur aktuellen Datenbank (siehe Warnung oben)."
    fi

    hr
    echo ""
    printf "  ${C_GREEN}✓ Rollback abgeschlossen – Version %s wiederhergestellt.${C_RESET}\n" "$SEL_VER"
    echo ""
    hr
    echo ""
    exit 0
}

# ── Stack steuern: Start / Restart / Stop / Autostart (ohne Update) ──────────
# Laeuft, wie do_rollback und change_admin_password, bewusst vor SCHRITT 3:
# braucht kein Release, keinen Versionscheck — nur eine eigene
# Docker-Compose-Ermittlung (siehe do_rollback).
#
# "Autostart beim Boot" ist bewusst kein eigenes Config-Flag, sondern die
# native Docker-Restart-Policy (docker-compose.yml setzt ueberall
# "restart: unless-stopped"). "AUS" heisst technisch "no" und wird per
# "docker update --restart" live umgeschaltet, ohne docker-compose.yml
# anzufassen. Jedes Update ruft compose_recreate/compose_up_build_all auf,
# was Container aus docker-compose.yml neu erzeugt und die Policy dabei auf
# den Default "unless-stopped" (Autostart AN) zuruecksetzt — genau das ist
# der gewuenschte sichere Default.
stack_profile_args_ermitteln() {
    STACK_PROFILE_ARGS=()
    local duckdns_token=""
    if [[ -f "$INSTALL_DIR/.env" ]]; then
        duckdns_token=$(grep '^DUCKDNS_API_TOKEN=' "$INSTALL_DIR/.env" 2>/dev/null | cut -d'=' -f2- || true)
    fi
    [[ -n "$duckdns_token" ]] && STACK_PROFILE_ARGS=(--profile caddy)
    return 0
}

stack_autostart_status() {
    docker_runtime inspect postbuch-app --format '{{.HostConfig.RestartPolicy.Name}}' 2>/dev/null || true
}

stack_autostart_umschalten() {
    local aktuell neu ids
    aktuell=$(stack_autostart_status)
    if [[ -z "$aktuell" ]]; then
        warn "Stack laeuft nicht – Autostart kann erst nach dem naechsten Start umgeschaltet werden."
        return 1
    fi
    if [[ "$aktuell" == "unless-stopped" ]]; then
        neu="no"
    else
        neu="unless-stopped"
    fi
    ids=$($DOCKER_COMPOSE "${STACK_PROFILE_ARGS[@]}" ps -q 2>/dev/null)
    if [[ -z "$ids" ]]; then
        warn "Kein laufender Container gefunden."
        return 1
    fi
    docker_runtime update --restart="$neu" $ids >/dev/null
    if [[ "$neu" == "unless-stopped" ]]; then
        success "Autostart beim Boot ist jetzt AN."
    else
        success "Autostart beim Boot ist jetzt AUS (gilt bis zum naechsten Update/Neu-Erstellen der Container)."
    fi
}

stack_steuerung_menu() {
    local DC="docker compose"
    if ! docker info &>/dev/null 2>&1; then
        DC="sudo docker compose"
    fi
    # compose_up_build_all/docker_runtime nutzen die globale Variable DOCKER_COMPOSE.
    DOCKER_COMPOSE="$DC"
    cd "$INSTALL_DIR"
    stack_profile_args_ermitteln

    while true; do
        local status_autostart
        case "$(stack_autostart_status)" in
            unless-stopped) status_autostart="AN" ;;
            no)              status_autostart="AUS" ;;
            *)               status_autostart="unbekannt (Stack laeuft nicht)" ;;
        esac

        hr
        echo ""
        echo "  Docker-Stack steuern – $INSTALL_DIR"
        echo ""
        echo "    [1]  Start    – gesamten Stack starten"
        echo "    [2]  Restart  – gesamten Stack neu starten"
        echo "    [3]  Stop     – gesamten Stack anhalten"
        echo "    [4]  Autostart beim Boot umschalten (aktuell: $status_autostart)"
        echo "    [0]  Zurück"
        echo ""
        local WAHL=""
        read -rp "  Auswahl [0-4]: " WAHL </dev/tty
        echo ""
        case "$WAHL" in
            1)
                info "Starte den gesamten Docker-Stack..."
                $DC "${STACK_PROFILE_ARGS[@]}" up -d
                ;;
            2)
                info "Starte den gesamten Docker-Stack neu..."
                $DC "${STACK_PROFILE_ARGS[@]}" restart
                ;;
            3)
                warn "Der Stack wird angehalten – die Web-Oberfläche ist danach nicht erreichbar."
                local BESTAETIGUNG=""
                read -rp "  Zur Bestätigung 'STOP' eingeben (Abbruch: Enter): " BESTAETIGUNG </dev/tty
                if [[ "$BESTAETIGUNG" == "STOP" ]]; then
                    info "Halte den gesamten Docker-Stack an..."
                    $DC "${STACK_PROFILE_ARGS[@]}" stop
                else
                    echo "  Abgebrochen."
                fi
                ;;
            4)
                stack_autostart_umschalten || true
                ;;
            0)
                return 0
                ;;
            *)
                warn "Ungültige Auswahl."
                ;;
        esac
        echo ""
    done
}

# ── Adminpasswort ändern (ohne Update) ────────────────────────────────────────
# Laeuft bewusst vor SCHRITT 3 (Docker-Compose-Ermittlung, Manifest/Download):
# braucht weder Release noch Versionscheck, nur den .env-Wert und einen
# Neustart des app-Containers, der APP_PASSWORD beim Start aus der .env liest.
change_admin_password() {
    hr
    echo ""
    echo "  ADMINPASSWORT ÄNDERN"
    echo ""
    echo "  Gilt für den Account 'admin'. Alle bestehenden Admin-Sitzungen werden"
    echo "  beim Neustart des app-Containers ungültig."
    echo ""
    local NEW_PW
    NEW_PW=$(prompt_password "Neues Admin-Passwort")

    upsert_env_value "$INSTALL_DIR/.env" "APP_PASSWORD" "$(env_single_quote "$NEW_PW")"

    local DC="docker compose"
    if ! docker info &>/dev/null 2>&1; then
        DC="sudo docker compose"
    fi

    hr
    echo ""
    info "Starte app-Container neu, damit das neue Passwort greift..."
    cd "$INSTALL_DIR"
    $DC up -d --no-deps --force-recreate app

    hr
    echo ""
    success "Adminpasswort geändert."
    echo ""
    hr
    echo ""
}

# ── Backup-Rückfrage ───────────────────────────────────────────────────────────
ask_restore_backup() {
    echo "" >&2
    echo "  ┌─ Backup einspielen (optional) ─────────────────────────────────────┐" >&2
    echo "  │ Falls du Daten aus einer bestehenden Instanz übernehmen möchtest,  │" >&2
    echo "  │ kannst du ein Backup (.pgdump.gz) über die Web-UI einspielen.      │" >&2
    echo "  └────────────────────────────────────────────────────────────────────┘" >&2
    local answer=""
    while [[ "$answer" != "j" && "$answer" != "J" && "$answer" != "n" && "$answer" != "N" ]]; do
        read -rp "  Backup einspielen? [j/n]: " answer </dev/tty
    done
    [[ "$answer" == "j" || "$answer" == "J" ]] && echo "true" || echo "false"
}

# ── Warten bis App bereit, dann Restore-URL anzeigen ──────────────────────────
wait_and_show_restore_url() {
    local lan_ip="$1"
    local basis_url="${2:-}"
    info "Warte auf App-Start..."
    local i=0
    while [[ $i -lt 120 ]]; do
        if curl -sf "http://localhost:3420/api/health" > /dev/null 2>&1; then
            break
        fi
        sleep 2
        i=$((i + 2))
    done
    echo ""
    if [[ -n "$lan_ip" ]]; then
        printf "  ${C_BOLD}${C_CYAN}➜  Backup einspielen:${C_RESET}  http://$lan_ip:3420/setup/restore\n"
    else
        printf "  ${C_BOLD}${C_CYAN}➜  Backup einspielen:${C_RESET}  http://localhost:3420/setup/restore\n"
    fi
    # Die Domain kommt zusaetzlich, nicht anstelle der lokalen Adresse: Das
    # Zertifikat ueber DuckDNS steht direkt nach dem Start evtl. noch nicht.
    if [[ "$basis_url" == https://* ]]; then
        printf "  ${C_BOLD}${C_CYAN}➜  Ueber deine Domain:${C_RESET}   $basis_url/setup/restore\n"
    fi
    echo ""
    echo "  Öffne den Link im Browser. Das Script beendet sich jetzt."
    echo "  Die Seite führt dich durch den Backup-Upload."
}

# ── Geführter Setup-Dialog (Prompts + Dateien schreiben) ──────────────────────
# Fragt ausschließlich Werte ab, die vor dem ersten Containerstart auf dem
# Host feststehen müssen. Ablage, OneDrive, KI und Scanner richtet anschließend
# der Web-Assistent ein; die zugehörigen ENV-Variablen bleiben für --headless,
# Restore und Bestandsinstallationen als leere Kompatibilitätswerte erhalten.
# Voraussetzung: INSTALL_DIR und INSTANCE_NAME müssen gesetzt sein
# (INSTANCE_NAME="" → wird hier abgefragt).
run_setup_dialog() {
    # ── Instanzname (falls noch nicht gesetzt) ────────────────────────────────
    if [[ -z "${INSTANCE_NAME:-}" ]]; then
        hr
        echo ""
        echo "  Instanzname"
        echo ""
        echo "  Dieser Name wird in der Web-Oberflaeche angezeigt (z.B. in Login, Sidebar, Exporten)."
        while [[ -z "$INSTANCE_NAME" ]]; do
            INSTANCE_NAME=$(prompt "Gewuenschter Instanzname" "Postbuch")
            INSTANCE_NAME=$(echo "$INSTANCE_NAME" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
            if [[ -z "$INSTANCE_NAME" ]]; then
                warn "Instanzname darf nicht leer sein."
            fi
        done
    fi

    # ── Automatisch generierte Werte ──────────────────────────────────────────
    POSTGRES_PASSWORD=$(openssl rand -hex 16)
    SESSION_SECRET=$(openssl rand -hex 32)

    # ── Backup einspielen? ────────────────────────────────────────────────────
    RESTORE_BACKUP=$(ask_restore_backup)

    # ── Admin-Passwort ────────────────────────────────────────────────────────
    APP_PASSWORD=""
    if [[ "$RESTORE_BACKUP" == "true" ]]; then
        echo ""
        echo "  ┌─ Admin-Passwort festlegen ────────────────────────────────────────┐"
        echo "  │ Lege dein Admin-Passwort fest. Du kannst dein altes Passwort      │"
        echo "  │ wiederverwenden oder ein neues wählen – beides funktioniert.      │"
        echo "  │ Dieser Wert gilt nach dem Restore zum Einloggen.                  │"
        echo "  └───────────────────────────────────────────────────────────────────┘"
        APP_PASSWORD=$(prompt_password "Admin-Passwort wählen")
    else
        echo ""
        echo "  ┌─ Admin-Passwort ─────────────────────────────────────────┐"
        echo "  │ Das ist dein Login-Passwort für die postbuch.net-Web-UI. │"
        echo "  └──────────────────────────────────────────────────────────┘"
        APP_PASSWORD=$(prompt_password "Admin-Passwort wählen")
    fi

    # Ablage, KI, OneDrive und Scanner werden nach dem ersten Login im
    # Web-Assistenten eingerichtet. Die leeren Werte bleiben ausschließlich als
    # Kompatibilität für Headless-/Restore- und Bestandsinstallationen bestehen.
    STORAGE_BACKEND=""
    OPENAI_API_KEY=""
    ANTHROPIC_API_KEY=""
    LLM_EMPFEHLUNGEN_ABO=""
    LLM_EMPFEHLUNGEN_AUTO=""

    # ── DuckDNS + HTTPS ───────────────────────────────────────────────────────
    echo ""
    hr
    echo ""
    printf "  ${C_BOLD}${C_CYAN}SCHRITT: DuckDNS + automatisches HTTPS (fuer PWA und Push erforderlich)${C_RESET}\n"
    echo ""
    local _LAN_IP
    _LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
    if [[ -z "$_LAN_IP" ]]; then
        _LAN_IP="$(ip -4 addr show scope global 2>/dev/null | awk '/inet /{print $2}' | cut -d/ -f1 | head -n1 || true)"
    fi
    local _HTTPS_GRUND="• Ohne HTTPS gehen dein Admin-Passwort und deine Sitzung unverschluesselt
  durchs Netz. Jeder, der im selben WLAN mitliest, kann sie uebernehmen.
• Push-Benachrichtigungen auf dem Handy brauchen HTTPS."
    panel "DuckDNS und HTTPS" "Warum sich dieser Schritt lohnt:
• postbuch.net ist danach unter einer gleichbleibenden Adresse mit HTTPS erreichbar,
  z. B. https://musterpostbuch.duckdns.org — auch wenn sich die IP-Adresse dieses
  Servers in deinem Heimnetzwerk mal aendert.
$_HTTPS_GRUND
• Eine dauerhaft installierte PWA auf anderen Geraeten und Push brauchen diese HTTPS-Adresse.

Die IP-Adresse dieses Raspberry Pi in deinem Heimnetzwerk lautet: $_LAN_IP
Diese Adresse brauchst du gleich bei DuckDNS — merke sie dir kurz oder lass dieses
Fenster offen.

So gehst du vor:
1. Öffne https://www.duckdns.org in einem Browser und melde dich an (z. B. mit
   deinem Google- oder GitHub-Konto).
2. Trage oben auf der Seite unter 'sub domain' einen frei waehlbaren Namen ein und
   klicke auf 'add domain', z. B. musterpostbuch (daraus wird musterpostbuch.duckdns.org).
3. In der Zeile deiner neuen Subdomain steht ein Eingabefeld 'ip' bzw. 'current ip'.
   Dort steht meist automatisch die falsche Adresse (deine oeffentliche Internet-Adresse).
   Loesche sie und trage stattdessen die IP-Adresse dieses Raspberry Pi ein: $_LAN_IP
   Klicke danach auf 'update ip'.
4. Kopiere oben auf der Seite dein persoenliches DuckDNS-Token (langer Zeichencode).
   Das wird gleich hier im Installer abgefragt.
5. Falls dein Router einen sogenannten DNS-Rebind-Schutz hat, muss die DuckDNS-Domain
   dort als Ausnahme eingetragen werden — sonst blockiert der Router den Zugriff, weil
   die oeffentliche Domain auf eine private Adresse zeigt.
   Fritz!Box: http://fritz.box → Netzwerk → Netzwerkeinstellungen → DNS-Rebind-Schutz.
6. Trage danach hier unten Token und Domain ein. postbuch.net erzeugt dann automatisch
   ein gueltiges TLS-Zertifikat fuer diese Domain."

    DUCKDNS_API_TOKEN=""
    DUCKDNS_DOMAIN=""
    local DUCKDNS_INPUT
    DUCKDNS_INPUT=$(prompt_secret "DuckDNS API-Token (optional, Enter zum Überspringen)")
    if [[ -n "$DUCKDNS_INPUT" ]]; then
        DUCKDNS_API_TOKEN="$DUCKDNS_INPUT"
        local _dns_wahl _dns_status
        while true; do
            DUCKDNS_DOMAIN=$(duckdns_domain_normalisieren "$(prompt "DuckDNS-Domain (z.B. musterpostbuch.duckdns.org)")")
            if [[ -z "$DUCKDNS_DOMAIN" ]]; then
                warn "Domain darf nicht leer sein wenn DuckDNS Token gesetzt."
                continue
            fi
            if ! domain_gueltig "$DUCKDNS_DOMAIN"; then
                warn "'$DUCKDNS_DOMAIN' ist kein gueltiger Domainname."
                continue
            fi
            info "Verwende Domain: $DUCKDNS_DOMAIN"
            while true; do
                _dns_status=0
                duckdns_aufloesung_pruefen "$DUCKDNS_DOMAIN" || _dns_status=$?
                [[ $_dns_status -eq 1 ]] || break
                echo ""
                read -rp "  [w] erneut pruefen · [n] Domain neu eingeben · [f] trotzdem fortfahren – Auswahl [w]: " _dns_wahl </dev/tty
                case "${_dns_wahl,,}" in
                    n) DUCKDNS_DOMAIN=""; break ;;
                    f) _dns_status=3; break ;;
                    *) ;;
                esac
            done
            [[ -n "$DUCKDNS_DOMAIN" ]] && break
        done
        # Nur was nicht automatisch bestaetigt wurde, bleibt als Merkliste stehen.
        local _dns_merkliste=""
        if [[ $_dns_status -ne 0 ]]; then
            _dns_merkliste="• Bei DuckDNS steht bei $DUCKDNS_DOMAIN als IP-Adresse: $_LAN_IP
  (falls nicht: auf duckdns.org korrigieren und 'update ip' klicken).
• Falls dein Router DNS-Rebind-Schutz hat, ist $DUCKDNS_DOMAIN dort als Ausnahme eingetragen.
"
        fi
        panel "DuckDNS-Pruefung" "${_dns_merkliste}• Caddy nutzt das DuckDNS-Token automatisch fuer die DNS-01-Challenge und holt das TLS-Zertifikat."
        APP_BASE_URL="https://$DUCKDNS_DOMAIN"
        ONEDRIVE_REDIRECT_URI="https://$DUCKDNS_DOMAIN/api/onedrive-auth/callback"
    else
        APP_BASE_URL="http://localhost:3420"
        ONEDRIVE_REDIRECT_URI="http://localhost:3420/api/onedrive-auth/callback"
    fi

    ONEDRIVE_CLIENT_ID=""
    ONEDRIVE_CLIENT_SECRET=""
    ONEDRIVE_TENANT_ID="consumers"
    SCANNER_DEVICE_URL=""

    # ── .env schreiben ────────────────────────────────────────────────────────
    hr
    echo ""
    info "Schreibe Konfigurationsdatei..."

    local ENV_FILE="$INSTALL_DIR/.env"
    # Rechte VOR dem ersten Schreiben setzen. Vorher stand das chmod 600 erst am
    # Ende des Blocks — dazwischen lag die Datei mit allen Secrets unter der
    # umask-Vorgabe (meist 644) offen herum.
    : > "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    cat > "$ENV_FILE" <<EOF
# ╔═══════════════════════════════════════════════════════════════════╗
# ║                    POSTBUCH UNIFIED CONFIG                       ║
# ║  Generiert von install.sh am $(date '+%Y-%m-%d %H:%M')                     ║
# ╚═══════════════════════════════════════════════════════════════════╝

# ── PostgreSQL ─────────────────────────────────────────────────────
POSTGRES_USER=postbuch
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
POSTGRES_DB=postbuch

# ── App: Authentifizierung ─────────────────────────────────────────
SESSION_SECRET=$SESSION_SECRET
APP_PASSWORD='$APP_PASSWORD'
APP_ADMIN_USERNAME=admin
INSTANCE_NAME=$INSTANCE_NAME
COMPOSE_PROFILES=

# ── LLM: Dokumentenanalyse ────────────────────────────────────────
# Leer = keine Cloud-KI. Weitere Provider (Ollama, LM Studio, OpenRouter,
# beliebige OpenAI-kompatible Dienste) werden im Web-UI angelegt, nicht hier.
OPENAI_API_KEY=$OPENAI_API_KEY

# ── Kuratierte Modellempfehlungen (Online-Rueckweg, derzeit inaktiv) ────────
# Der aktuelle Release liest seine mitgelieferte Empfehlung lokal. Diese beiden
# Werte bleiben nur fuer eine spaetere Reaktivierung des Online-Feeds erhalten.
LLM_EMPFEHLUNGEN_ABO=$LLM_EMPFEHLUNGEN_ABO
LLM_EMPFEHLUNGEN_AUTO=$LLM_EMPFEHLUNGEN_AUTO

# ── App-Adresse ────────────────────────────────────────────────────
APP_BASE_URL=$APP_BASE_URL

# ── Zugang zur Bezugsquelle ────────────────────────────────────────
# "benutzer:passwort" für die konfigurierten Bezugsquelle. Ohne diese Zeile
# findet die App keine Updates mehr, und install.sh kann kein geschütztes
# Release laden. Aendert der Betreiber das Passwort, wird
# hier die neue Zeile eingetragen und der Stack neu gestartet.
POSTBUCH_FEED_AUTH=$(env_single_quote "$POSTBUCH_FEED_AUTH")

# ── Bezugsquelle ─────────────────────────────────────────────────
# Nicht geheim, aber bewusst instanzlokal. Ein Wechsel ist nach dem
# ersten Setup nur durch eine explizite .env-Aenderung möglich.
POSTBUCH_FEED_BASE_URL=$(env_single_quote "$POSTBUCH_FEED_BASE_URL")
EOF

    # Beim Restore kommt das Ablage-Backend aus dem eingespielten Dump. Die Zeile
    # wird dann gar nicht erst geschrieben — so ist die ganze Restore-Klasse aus
    # der Frage heraus, statt nur serverseitig abgefangen zu werden.
    if [[ -n "$STORAGE_BACKEND" ]]; then
        cat >> "$ENV_FILE" <<EOF

# ── Ablage ─────────────────────────────────────────────────────────
# Wirkt AUSSCHLIESSLICH bei der Erstinstallation gegen eine leere Datenbank
# (keine Dokumente, keine Ordnerstruktur). Auf einer benutzten Instanz wird die
# aktive Ablage nur ueber Einstellungen -> Ablage umgeschaltet; ein Aendern
# dieser Zeile bleibt dort wirkungslos.
STORAGE_BACKEND=$STORAGE_BACKEND
EOF
    fi

    if [[ "$STORAGE_BACKEND" == "nextcloud" ]]; then
        # Bewusst keine NEXTCLOUD_*-Zeilen: Server-Adresse und Zugangsdaten
        # gehoeren in die Weboberflaeche, wo sie geprueft werden (unverschluesselt
        # nur im Heimnetz und nur mit ausdruecklicher Bestaetigung) und wo der
        # Login-Flow ein App-Passwort erzeugt, statt eines im Klartext abzulegen.
        cat >> "$ENV_FILE" <<'EOF'

# ── Nextcloud ──────────────────────────────────────────────────────
# Server-Adresse und Anmeldung: Web-UI → Einstellungen → Ablage.
# Hier ist bewusst nichts einzutragen.
#
# OneDrive spaeter zusaetzlich nutzen? Dann hier ergaenzen und neu starten:
#   ONEDRIVE_CLIENT_ID=
#   ONEDRIVE_CLIENT_SECRET=
#   ONEDRIVE_TENANT_ID=consumers
EOF
    else
        cat >> "$ENV_FILE" <<EOF

# ── OneDrive / Azure ───────────────────────────────────────────────
ONEDRIVE_CLIENT_ID=$ONEDRIVE_CLIENT_ID
ONEDRIVE_CLIENT_SECRET=$ONEDRIVE_CLIENT_SECRET
ONEDRIVE_TENANT_ID=$ONEDRIVE_TENANT_ID
EOF
    fi

    if [[ -n "$DUCKDNS_API_TOKEN" ]]; then
        cat >> "$ENV_FILE" <<EOF

# ── Caddy: Reverse Proxy mit TLS (DuckDNS) ────────────────────────
DUCKDNS_API_TOKEN=$DUCKDNS_API_TOKEN
DUCKDNS_DOMAIN=$DUCKDNS_DOMAIN
EOF
    fi

    if [[ -n "$ANTHROPIC_API_KEY" ]]; then
        cat >> "$ENV_FILE" <<EOF

# ── Anthropic (optional, für Claude-Modelle) ───────────────────────
ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY
EOF
    fi

    if [[ -n "$SCANNER_DEVICE_URL" ]]; then
        cat >> "$ENV_FILE" <<EOF

# ── Scanner ────────────────────────────────────────────────────────
SCANNER_DEVICE_URL=$SCANNER_DEVICE_URL
EOF
    fi

    cat >> "$ENV_FILE" <<EOF

# ── Ports ──────────────────────────────────────────────────────────
WEB_PORT=3420
POSTGRES_HOST_PORT=5433
EOF

    chmod 600 "$ENV_FILE"
    success ".env geschrieben."

    # ── Caddyfile generieren ──────────────────────────────────────────────────
    mkdir -p "$INSTALL_DIR/caddy"
    # Docker kann Caddyfile als Verzeichnis anlegen (bind-mount ohne vorhandene Datei) – bereinigen
    [[ -d "$INSTALL_DIR/caddy/Caddyfile" ]] && safe_rm_rf "$INSTALL_DIR/caddy/Caddyfile"
    if [[ -n "$DUCKDNS_API_TOKEN" ]]; then
        cat > "$INSTALL_DIR/caddy/Caddyfile" <<'CADDYEOF'
{env.DUCKDNS_DOMAIN} {
    tls {
        dns duckdns {env.DUCKDNS_API_TOKEN}
        resolvers 8.8.8.8 1.1.1.1
    }
    reverse_proxy web:80
}
CADDYEOF
        success "Caddyfile mit DuckDNS-TLS geschrieben."
    else
        cat > "$INSTALL_DIR/caddy/Caddyfile" <<'CADDYEOF'
# Kein DuckDNS konfiguriert – kein TLS-Endpunkt aktiv.
# postbuch.net ist über http://localhost:3420 erreichbar.
# Trage DUCKDNS_API_TOKEN und DUCKDNS_DOMAIN in die .env ein und starte neu,
# um automatisches HTTPS zu aktivieren.
CADDYEOF
        success "Caddyfile (ohne TLS) geschrieben."
    fi
    chmod 600 "$INSTALL_DIR/caddy/Caddyfile"

    # ── restart.sh anlegen ────────────────────────────────────────────────────
    write_restart_script
}

# ══════════════════════════════════════════════════════════════════════════════
# ARGUMENT-PARSING UND NICHT-INTERAKTIVE PFADE
# ══════════════════════════════════════════════════════════════════════════════
# Bis 2.1.x hatte dieses Skript ueberhaupt kein Argument-Parsing: es war rein
# interaktiv und las an 17 Stellen von /dev/tty. Fuer den Update-Agenten braucht
# es einen Pfad, der KEIN einziges Mal /dev/tty anfasst — sonst haengt ein
# systemd-Timer fuer immer an einer unsichtbaren Rueckfrage.

usage() {
    cat <<'USAGEEOF'
postbuch.net Installer

  install.sh                          Gefuehrte Installation / Update (interaktiv)
  install.sh --update                 Update (interaktiv, mit Rueckfragen)
  install.sh --update --yes --non-interactive
                                      Update ohne jede Rueckfrage (fuer den Agenten)
  install.sh --rollback               Auf ein vorhandenes Backup zurueckrollen

Nach jeder Installation liegt dieses Skript passend zum installierten Release
unter <Installationsverzeichnis>/install.sh. Deinstallation, Rollback,
Adminpasswort und Stack-Steuerung laufen von dort ohne Internetzugang.

Optionen:
  --update                  Update-Modus erzwingen
  --yes                     Alle Rueckfragen mit "ja" beantworten
  --non-interactive         Niemals von /dev/tty lesen (impliziert --yes)
  --dry-run                 Bis inkl. Backup laufen, dann ohne Aenderung beenden
  --rollback                Rollback-Dialog starten
  --erwarte-sha256=<hex>    Tarball muss diese sha256-Summe haben, sonst Abbruch
  --install-dir=<pfad>      Abweichendes Installationsverzeichnis. Ohne diese
                            Angabe wird die Installation gesucht: Skript-
                            verzeichnis, aktuelles Verzeichnis, Merkdatei
                            ~/.postbuch-installdir, zuletzt ~/postbuch
  --quelle=<https-url>      Andere Bezugsquelle für Release-Manifest und
                            -Archiv. Standard bei neuen Installationen:
                            https://github.com/ceramgcf/postbuch.net/releases
                            Bestehende Installationen behalten die Quelle
                            aus ihrer .env.
  --zielversion=<x.y.z>     Genau diese Version installieren (auch eine
                            Vorabversion); ohne Angabe die neueste stabile
  -h, --help                Diese Hilfe

Notausgaenge (nur bewusst benutzen, der Update-Agent setzt sie nie):
  --ohne-signatur-fortfahren  Nur interaktiv mit lokalem Tarball und einer
                              unabhaengig bekannten --erwarte-sha256-Pruefsumme
  --erlaube-rueckschritt      Auch eine aeltere Version als die zuletzt
                              gesehene installieren
USAGEEOF
}

parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --update)            OPT_UPDATE=true ;;
            --yes|-y)            OPT_YES=true ;;
            --non-interactive)   OPT_NON_INTERACTIVE=true; OPT_YES=true ;;
            --dry-run)           OPT_DRY_RUN=true ;;
            --rollback)          OPT_ROLLBACK=true ;;
            --erwarte-sha256=*)  OPT_SHA256="${1#*=}" ;;
            --install-dir=*)     OPT_INSTALL_DIR="${1#*=}" ;;
            --quelle=*)          OPT_FEED_BASE_URL="${1#*=}" ;;
            --zielversion=*)     OPT_ZIELVERSION="${1#*=}" ;;
            --ohne-signatur-fortfahren) OPT_OHNE_SIGNATUR=true ;;
            --erlaube-rueckschritt)     OPT_ERLAUBE_RUECKSCHRITT=true ;;
            -h|--help)           usage; exit 0 ;;
            *) echo "Unbekannte Option: $1" >&2; usage >&2; exit 2 ;;
        esac
        shift
    done

    if [[ -n "$OPT_ZIELVERSION" && ! "$OPT_ZIELVERSION" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]]; then
        echo "FEHLER: --zielversion muss die Form x.y.z haben." >&2
        exit 2
    fi
    if [[ -n "$OPT_SHA256" && ! "$OPT_SHA256" =~ ^[0-9a-f]{64}$ ]]; then
        echo "FEHLER: --erwarte-sha256 ist keine 64-stellige Hex-Pruefsumme." >&2
        exit 2
    fi
    if $OPT_OHNE_SIGNATUR; then
        if $OPT_NON_INTERACTIVE || [[ ! -f "$LOCAL_TARBALL" || -z "$OPT_SHA256" ]]; then
            echo "FEHLER: --ohne-signatur-fortfahren ist nur interaktiv mit lokalem" >&2
            echo "  postbuch-latest.tar.gz und --erwarte-sha256=<unabhaengig bekannter Hash> erlaubt." >&2
            exit 2
        fi
    fi
    # `parse_args` darf bei der normalen Aufrufvariante ohne
    # --install-dir nicht mit Status 1 enden: unter `set -e` würde der
    # Installer sonst noch vor Banner und Auswahlmenü geräuschlos abbrechen.
    if [[ -n "$OPT_INSTALL_DIR" ]]; then
        [[ "$OPT_INSTALL_DIR" == /* ]] || OPT_INSTALL_DIR="$PWD/$OPT_INSTALL_DIR"
        OPT_INSTALL_DIR="${OPT_INSTALL_DIR%/}"
        DEFAULT_INSTALL_DIR="$OPT_INSTALL_DIR"
        INSTALL_DIR_QUELLE="--install-dir"
    else
        installationsverzeichnis_ermitteln
    fi
}

# ── Installationsverzeichnis finden ─────────────────────────────────────────
# Pro Rechner ist genau eine postbuch.net-Instanz zulaessig. Sie muss aber
# nicht unter ~/postbuch liegen. Ohne --install-dir wird sie in dieser
# Reihenfolge gesucht:
#   1. Verzeichnis dieses Skripts (Aufruf von <Installation>/install.sh bzw.
#      <Installation>/deploy-pages/install.sh)
#   2. aktuelles Arbeitsverzeichnis (cd <Installation> && curl … | bash)
#   3. Merkdatei ~/.postbuch-installdir, geschrieben bei Installation/Update
#   4. Standard ~/postbuch
# Ein Git-Arbeitsstand ist nie eine Installation: Releases enthalten kein .git.
MERKDATEI_NAME=".postbuch-installdir"
INSTALL_DIR_QUELLE="Standard"

ist_installation() {   # $1 = Verzeichnis
    [[ -n "$1" && -f "$1/docker-compose.yml" && -f "$1/.env" \
       && -f "$1/VERSION" && ! -e "$1/.git" ]]
}

# Alle Merkdateien, die fuer diesen Lauf in Frage kommen. Unter sudo zaehlt
# zusaetzlich das Home des aufrufenden Nutzers, damit ein spaeterer Aufruf
# mit oder ohne sudo dieselbe Instanz findet.
merkdateien() {
    printf '%s\n' "$LAUFZEIT_HOME/$MERKDATEI_NAME"
    if [[ $(id -u) -eq 0 && -n "${SUDO_USER:-}" && "$SUDO_USER" != "root" ]]; then
        local h
        h=$(getent passwd "$SUDO_USER" 2>/dev/null | cut -d: -f6)
        [[ -n "$h" && "$h" != "$LAUFZEIT_HOME" ]] && printf '%s\n' "$h/$MERKDATEI_NAME"
    fi
    return 0
}

merkdatei_lesen() {   # gibt einen gueltigen Installationspfad aus oder nichts
    local f pfad
    while IFS= read -r f; do
        [[ -f "$f" ]] || continue
        pfad=$(head -n1 "$f" 2>/dev/null | tr -d '\r')
        if [[ "$pfad" == /* ]] && ist_installation "$pfad"; then
            printf '%s' "$pfad"
            return 0
        fi
    done < <(merkdateien)
    return 0
}

installationsverzeichnis_ermitteln() {
    local kandidat gefunden=""
    for kandidat in "$SCRIPT_DIR" "$(dirname "$SCRIPT_DIR")" "$PWD"; do
        # Die Elternstufe gilt nur fuer <Installation>/deploy-pages/install.sh.
        if [[ "$kandidat" == "$(dirname "$SCRIPT_DIR")" \
              && "$(basename "$SCRIPT_DIR")" != "deploy-pages" ]]; then
            continue
        fi
        if ist_installation "$kandidat"; then
            gefunden="$kandidat"
            # Bei `curl … | bash` gibt es kein Skript auf der Platte; dann
            # ist SCRIPT_DIR ohnehin das aktuelle Verzeichnis.
            if [[ "$kandidat" == "$PWD" && ( "$kandidat" != "$SCRIPT_DIR" || ! -f "$0" ) ]]; then
                INSTALL_DIR_QUELLE="aktuelles Verzeichnis"
            else
                INSTALL_DIR_QUELLE="Skriptverzeichnis"
            fi
            break
        fi
    done
    if [[ -z "$gefunden" ]]; then
        gefunden=$(merkdatei_lesen)
        [[ -n "$gefunden" ]] && INSTALL_DIR_QUELLE="Merkdatei ~/$MERKDATEI_NAME"
    fi
    if [[ -n "$gefunden" ]]; then
        DEFAULT_INSTALL_DIR="$gefunden"
    fi
    return 0
}

# Merkt sich die Installation fuer spaetere Aufrufe von ausserhalb. Fehler
# sind nicht fatal: --install-dir bleibt immer als Rueckweg.
merkdatei_schreiben() {   # $1 = Installationsverzeichnis
    local abs f besitzer
    abs=$(cd "$1" 2>/dev/null && pwd) || return 0
    while IFS= read -r f; do
        if printf '%s\n' "$abs" > "$f" 2>/dev/null; then
            chmod 644 "$f" 2>/dev/null || true
            if [[ $(id -u) -eq 0 ]]; then
                besitzer=$(stat -c '%u:%g' "$(dirname "$f")" 2>/dev/null) \
                    && chown "$besitzer" "$f" 2>/dev/null || true
            fi
        fi
    done < <(merkdateien)
    return 0
}

merkdatei_entfernen() {   # $1 = entferntes Installationsverzeichnis
    local f
    while IFS= read -r f; do
        [[ -f "$f" ]] || continue
        if [[ "$(head -n1 "$f" 2>/dev/null)" == "$1" ]]; then
            rm -f "$f" 2>/dev/null || sudo rm -f "$f" 2>/dev/null || true
        fi
    done < <(merkdateien)
    return 0
}

# ── sha256-Pruefung ──────────────────────────────────────────────────────────
# Wird VOR dem Entpacken ausgefuehrt und bricht ab, ohne $INSTALL_DIR anzufassen.
# Das ist der Unterschied zwischen "Update fehlgeschlagen" und "halber Quellbaum".
pruefe_sha256() {   # $1 = Datei, $2 = erwartete Summe
    local datei="$1" erwartet="$2" ist=""
    [[ -z "$erwartet" ]] && return 0
    if command -v sha256sum &>/dev/null; then
        ist=$(sha256sum "$datei" | awk '{print $1}')
    elif command -v shasum &>/dev/null; then
        ist=$(shasum -a 256 "$datei" | awk '{print $1}')
    else
        echo "WARNUNG: Weder sha256sum noch shasum vorhanden – Pruefsumme nicht verifizierbar." >&2
        return 1
    fi
    if [[ "$ist" != "$erwartet" ]]; then
        echo "FEHLER: Pruefsumme stimmt nicht." >&2
        echo "  erwartet: $erwartet" >&2
        echo "  gelesen:  $ist" >&2
        return 1
    fi
    echo "  Pruefsumme bestaetigt."
    return 0
}

# Erwartete Pruefsumme aus dem Release-Manifest holen — ohne JSON-Parser: alle
# Leerzeichen weg, dann das sha256-Feld INNERHALB von "tarball" greifen. Ein
# `jq` als neue Abhaengigkeit waere fuer dieses eine Feld nicht angemessen.
MANIFEST_ROH=""

# Manifest genau einmal holen und im Speicher halten. Version und Pruefsumme
# muessen aus DERSELBEN Abfrage stammen — zwei getrennte Abrufe koennten ein
# Release auseinanderreissen, wenn dazwischen veroeffentlicht wird.
manifest_holen() {
    [[ -n "$MANIFEST_ROH" ]] && return 0
    local roh v
    roh=$(feed_curl -fsS --max-time 20 "$MANIFEST_URL" 2>/dev/null | tr -d ' \t\n\r') || return 1
    [[ -n "$roh" ]] || return 1
    # --zielversion: das Manifest muss genau diese Version nennen. Bei einer
    # flachen Quelle gibt es nur das neueste Manifest; ist dort inzwischen
    # etwas anderes veröffentlicht, wird nicht stillschweigend gewechselt.
    if [[ -n "$OPT_ZIELVERSION" ]]; then
        v=$(printf '%s' "$roh" | grep -o '"version":"[0-9]\+\.[0-9]\+\.[0-9]\+"' \
            | grep -o '[0-9]\+\.[0-9]\+\.[0-9]\+' | head -n1)
        if [[ "$v" != "$OPT_ZIELVERSION" ]]; then
            echo "FEHLER: Angefordert war Version $OPT_ZIELVERSION, das Manifest nennt ${v:-keine Version}." >&2
            return 1
        fi
    fi
    MANIFEST_ROH="$roh"
}

hole_erwartete_sha256() {
    manifest_holen || return 1
    printf '%s' "$MANIFEST_ROH" \
        | grep -o '"tarball":{"sha256":"[0-9a-f]\{64\}"' \
        | grep -o '[0-9a-f]\{64\}' \
        | head -n1
}

hole_manifest_version() {
    manifest_holen || return 1
    printf '%s' "$MANIFEST_ROH" \
        | grep -o '"version":"[0-9]\+\.[0-9]\+\.[0-9]\+"' \
        | grep -o '[0-9]\+\.[0-9]\+\.[0-9]\+' \
        | head -n1
}

# Setzt RELEASE_URL auf den versionierten Dateinamen.
#
# Die Version wird streng als x.y.z geprueft, BEVOR sie in eine URL wandert —
# ein manipuliertes Manifest darf hier weder einen Pfad noch einen fremden Host
# einschleusen. Aus demselben Grund steht im Manifest bewusst KEIN URL-Feld
# (siehe VERBOTENE_FELDER in app/src/lib/update-manifest.js): der Feed sagt,
# WELCHE Version es gibt — von WO geladen wird, bestimmt allein $BASE_URL.
release_url_aktualisieren() {
    [[ -n "$RELEASE_URL" ]] && return 0
    local v
    v=$(hole_manifest_version || true)
    if [[ ! "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        echo "FEHLER: Konnte die Release-Version nicht aus $MANIFEST_URL lesen." >&2
        echo "  Ohne Version ist der Dateiname des Tarballs unbekannt." >&2
        echo "  Pruefe die Netzverbindung oder lege das Archiv lokal daneben." >&2
        return 1
    fi
    if $QUELLE_GITHUB; then
        RELEASE_URL="$BASE_URL/download/v$v/postbuch-$v.tar.gz"
    else
        RELEASE_URL="$BASE_URL/postbuch-$v.tar.gz"
    fi
    return 0
}

release_download() {   # $1=Zieldatei; flacher Standard mit Legacy-Fallback
    local ziel="$1" legacy_url
    release_url_aktualisieren || return 1
    if feed_curl -fsS -o "$ziel" "$RELEASE_URL"; then
        return 0
    fi
    $QUELLE_GITHUB && return 1
    legacy_url="$BASE_URL/releases/$(basename "$RELEASE_URL")"
    warn "Flaches Release-Asset nicht erreichbar; versuche den Legacy-Pfad."
    feed_curl -fsS -o "$ziel" "$legacy_url"
}

# ══════════════════════════════════════════════════════════════════════════════
# RELEASE-SIGNATUR (Ed25519)
# ══════════════════════════════════════════════════════════════════════════════
#
# Warum ueberhaupt: sha256 und Manifest kommen aus derselben Quelle. Wer dort
# schreiben kann, tauscht beides im selben Zug — die Pruefsumme passt dann
# anstandslos zum manipulierten Tarball. Die Signatur trennt "darf
# veroeffentlichen" von "darf ein Release autorisieren"; der private Schluessel
# liegt offline, nicht auf dem Publisher-Server.
#
# Die unten eingebetteten Schluessel sind der Vertrauensanker. Sobald mindestens
# ein Schluessel vorhanden ist, sind fehlende, unpruefbare und falsche
# Signaturen vom ersten Kontakt an ein harter Abbruch. Die lokale Vertrauensdatei
# protokolliert nur die hoechste akzeptierte Version (Anti-Downgrade); sie
# schaltet die Signaturpflicht nicht erst ein.

# Oeffentliche Release-Schluessel: "<id>:<base64>" je Zeile, Ed25519, 32 Byte roh.
#
# Der Block zwischen den Markern ist eine woertliche Kopie von
# AKZEPTIERTE_SCHLUESSEL in app/src/lib/release-signatur.js. Das ist Absicht:
# dieses Skript muss self-contained bleiben. Eine nachladbare Schluesseldatei
# waere genau die Luecke, die die Signatur schliessen soll — wer den Tarball
# liefert, duerfte dann auch den Schluessel liefern. Gegen Auseinanderlaufen
# der beiden Schluesselkopien:
#   node scripts/postbuch-signatur.mjs schluessel-pruefen
#
# Leere Liste = nur TLS + SHA-256; produktive Releases duerfen so nicht gebaut
# werden.
RELEASE_SCHLUESSEL=$(cat <<'SCHLUESSELEOF'
# BEGIN-RELEASE-SCHLUESSEL
k1:2T0Jp573KEVZQ+lFetYJELFIjphKYvD8tZ7wOqjknqI=
k2:rP7nktrzQf0gLLCAzwmzg1d9kN9GthpYaNcBi73sBP8=
# END-RELEASE-SCHLUESSEL
SCHLUESSELEOF
)

SIGNATUR_KONTEXT="postbuch-manifest-v1"
VERTRAUEN_DATEINAME=".postbuch-vertrauen"

# Testvektor 2 aus RFC 8032 (Ed25519). Er dient NICHT der Sicherheit, sondern
# der Faehigkeitspruefung: statt `openssl version` zu zerlegen, laesst sich
# jeder Kandidat einmal an einem bekannten Ergebnis messen. Er muss die gueltige
# Signatur annehmen UND die verfaelschte ablehnen — ein Werkzeug, das immer 0
# liefert, faellt damit auf.
TESTVEKTOR_MSG_HEX="72"
TESTVEKTOR_PUB="PUAXw+hDiVqStwqnTRt+vJyYLM8uxJaMwM1V8Sr0Zgw="
TESTVEKTOR_SIG="kqAJqfDUyrhyDoILX2QlQKKye1QWUD+Ps3YiI+vbadoIWsHkPhWZbkWPNhPQ8R2MOHsurrQwKu6wDSkWErsMAA=="
TESTVEKTOR_SIG_KAPUTT="k6AJqfDUyrhyDoILX2QlQKKye1QWUD+Ps3YiI+vbadoIWsHkPhWZbkWPNhPQ8R2MOHsurrQwKu6wDSkWErsMAA=="

SIG_VERIFIER=""              # "openssl" | "docker" | "" (keiner gefunden)
SIG_VERIFIER_GEPRUEFT=false
SIG_ERGEBNIS="ungeprueft"    # gueltig|ungueltig|fehlt|unbekannter-schluessel|
                             # kein-verifier|kein-manifest|unkonfiguriert
# Ergebnis einer gültigen Prüfung für den Erstinstallationspfad. Dort wird das
# Zielverzeichnis bewusst erst NACH dem Gate angelegt; die lokalen Variablen
# aus pruefe_release_signatur() wären dann nicht mehr erreichbar.
SIG_PIN_SCHLUESSEL=""
SIG_PIN_HOECHSTE_VERSION=""

# ── Manifest-Felder lesen ────────────────────────────────────────────────────
# $MANIFEST_ROH ist das Manifest ohne jedes Leerzeichen (siehe manifest_holen).
# Jeder gelesene Wert wird gegen eine Regex geprueft, bevor er irgendwo landet —
# er kommt von aussen, auch wenn er gleich signaturgeprueft wird.

manifest_feld() {   # $1 = Feldname -> Rohwert ohne Anfuehrungszeichen
    printf '%s' "$MANIFEST_ROH" \
        | grep -o "\"$1\":\(\"[^\"]*\"\|[0-9]\{1,15\}\|true\|false\|null\)" \
        | head -n1 | cut -d: -f2- | tr -d '"'
}

manifest_unterfeld() {   # $1 = Objektname, $2 = Feldname
    printf '%s' "$MANIFEST_ROH" \
        | grep -o "\"$1\":{[^}]*}" | head -n1 \
        | grep -o "\"$2\":\(\"[^\"]*\"\|[0-9]\{1,15\}\|null\)" \
        | head -n1 | cut -d: -f2- | tr -d '"'
}

# ── Die signierten Bytes ─────────────────────────────────────────────────────
# Signiert wird NICHT die Datei und NICHT ein kanonisiertes JSON, sondern diese
# kompakte Bytefolge. Grund: dieses Skript muesste sonst in reinem bash
# kanonisieren (RFC 8785) — schon die Zahlen-Serialisierung liefe gegenueber
# Node auseinander. TUF, minisign und Sparkle umgehen JSON-Kanonisierung aus
# demselben Grund.
#
# Muss zeichengleich zu kanonischeBytes() in app/src/lib/release-signatur.js
# sein. Wer hier etwas aendert, aendert es dort mit.
#
# `changelog` ist bewusst NICHT abgedeckt: reiner Anzeigetext, in bash nicht
# verlaesslich zu loesen, steuert nichts. Er laeuft ohnehin durch textFeld()
# (kein Markup, keine URLs).
signatur_kanonische_bytes() {   # $1 = Zieldatei
    local schema version datum sicher mindest tsha tgroesse isha

    schema=$(manifest_feld schemaVersion)
    version=$(manifest_feld version)
    datum=$(manifest_feld veroeffentlichtAm)
    sicher=$(manifest_feld sicherheitsrelevant)
    mindest=$(manifest_feld mindestVersion)
    tsha=$(manifest_unterfeld tarball sha256)
    tgroesse=$(manifest_unterfeld tarball groesse)
    isha=$(manifest_unterfeld installer sha256)

    [[ "$schema"   =~ ^[0-9]{1,3}$ ]]                     || return 1
    [[ "$version"  =~ ^[0-9]{1,3}(\.[0-9]{1,3}){2}$ ]]    || return 1
    [[ "$datum"    =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]     || return 1
    [[ "$tsha"     =~ ^[0-9a-f]{64}$ ]]                   || return 1
    [[ "$tgroesse" =~ ^[0-9]{1,12}$ ]]                    || return 1

    case "$sicher" in
        true)  sicher="ja" ;;
        false|null|"") sicher="nein" ;;
        *) return 1 ;;
    esac
    if [[ -z "$mindest" || "$mindest" == "null" ]]; then
        mindest="-"
    elif [[ ! "$mindest" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){2}$ ]]; then
        return 1
    fi
    if [[ -z "$isha" || "$isha" == "null" ]]; then
        isha="-"
    elif [[ ! "$isha" =~ ^[0-9a-f]{64}$ ]]; then
        return 1
    fi

    printf '%s\n%s\n%s\n%s\n%s\n%s\n%s\n%s\n%s\n' \
        "$SIGNATUR_KONTEXT" "$schema" "$version" "$datum" "$sicher" \
        "$mindest" "$tsha" "$tgroesse" "$isha" > "$1"
}

# ── Verifier 1: openssl ──────────────────────────────────────────────────────
# `openssl pkeyutl -verify -rawin` ist der einzige CLI-Weg zu Ed25519 und
# existiert erst ab OpenSSL 3.0. Debian 11 und Ubuntu 20.04 liefern 1.1.1 und
# koennen es nicht — deshalb die Kaskade und der Selbsttest, statt hier eine
# Versionsnummer zu zerlegen.
verifier_openssl() {   # $1 = Datendatei, $2 = Signatur (Base64), $3 = Pubkey (Base64)
    command -v openssl >/dev/null 2>&1 || return 2
    local tmp rc
    tmp=$(mktemp -d) || return 2
    if ! printf '%s' "$2" | base64 -d > "$tmp/sig" 2>/dev/null; then
        rm -rf "$tmp"; return 2
    fi
    # 32 Rohbytes in ein SPKI-PEM verpacken. Der DER-Kopf fuer Ed25519 (RFC 8410)
    # ist konstant und 12 Byte lang — glatt durch 3 teilbar, seine Base64-Form
    # "MCowBQYDK2VwAyEA" endet also exakt auf einer Blockgrenze. Der Rohschluessel
    # laesst sich deshalb direkt anhaengen, ohne Bytes zu rechnen.
    {
        printf -- '-----BEGIN PUBLIC KEY-----\n'
        printf 'MCowBQYDK2VwAyEA%s\n' "$3"
        printf -- '-----END PUBLIC KEY-----\n'
    } > "$tmp/pub.pem"
    openssl pkeyutl -verify -rawin -pubin -inkey "$tmp/pub.pem" \
        -sigfile "$tmp/sig" -in "$1" >/dev/null 2>&1
    rc=$?
    rm -rf "$tmp"
    return $rc
}

# ── Verifier 2: Node in einem lokal vorhandenen Container ────────────────────
# Node bringt sein eigenes OpenSSL 3.x mit und kann Ed25519 seit v12 — die
# 1.1.1-Huerde des Hosts ist damit umgangen. Docker ist ohnehin harte
# Voraussetzung fuer Postbuch.
#
# Bewusst KEIN Pull: bei einer Erstinstallation gibt es noch kein Image, und
# dann soll dieser Weg sauber ausfallen statt aus dem Netz nachzuladen. Ohne
# Anker ist das folgenlos (nur eine Warnung); mit Anker bricht der Lauf ab.
verifier_docker() {   # $1 = Datendatei, $2 = Signatur (Base64), $3 = Pubkey (Base64)
    local dk="" bild="" kandidat basis
    if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
        dk="docker"
    elif command -v sudo >/dev/null 2>&1 && sudo -n docker info >/dev/null 2>&1; then
        dk="sudo docker"
    else
        return 2
    fi

    # Der Image-Name folgt dem Compose-Projekt, also dem Verzeichnisnamen.
    basis=$(basename "${INSTALL_DIR:-$DEFAULT_INSTALL_DIR}" 2>/dev/null || echo postbuch)
    for kandidat in "${basis}-app:latest" "postbuch-app:latest" \
                    "postbuch-unified-app:latest" "node:22-alpine" "node:22"; do
        if $dk image inspect "$kandidat" >/dev/null 2>&1; then bild="$kandidat"; break; fi
    done
    [[ -n "$bild" ]] || return 2

    # --entrypoint node ist Pflicht: das App-Image startet sonst seinen eigenen
    # Entrypoint (DB abwarten, Schema anwenden, App hochfahren).
    # --network none, weil dieser Schritt nichts aus dem Netz braucht.
    # Skript ueber stdin statt `node -e`, Daten ueber die Umgebung — so gibt es
    # keine Quoting-Grenze zwischen Manifest und Shell. Signatur, Pubkey und
    # Manifest sind oeffentliche Daten; dass sie kurz in `ps` sichtbar sind,
    # ist folgenlos.
    MANIFEST_B64=$(base64 -w0 < "$1" 2>/dev/null || base64 < "$1" | tr -d '\n') \
    SIG_B64="$2" PUB_B64="$3" \
    $dk run --rm -i --network none \
        -e MANIFEST_B64 -e SIG_B64 -e PUB_B64 \
        --entrypoint node "$bild" - <<'NODEEOF'
const c = require('crypto');
try {
  const roh = Buffer.from(process.env.PUB_B64, 'base64');
  if (roh.length !== 32) process.exit(3);
  const pub = c.createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: roh.toString('base64url') },
    format: 'jwk',
  });
  const sig = Buffer.from(process.env.SIG_B64, 'base64');
  const msg = Buffer.from(process.env.MANIFEST_B64, 'base64');
  // Bei Ed25519 ist der Algorithmus-Parameter zwingend null: EdDSA hasht selbst.
  process.exit(c.verify(null, msg, pub, sig) ? 0 : 1);
} catch (e) { process.exit(3); }
NODEEOF
}

# ── Kaskade + Selbsttest ─────────────────────────────────────────────────────
# Ein Kandidat gilt nur dann als brauchbar, wenn er den bekannten Testvektor
# annimmt UND die um ein Bit verfaelschte Signatur ablehnt.
verifier_ermitteln() {
    $SIG_VERIFIER_GEPRUEFT && { [[ -n "$SIG_VERIFIER" ]]; return; }
    SIG_VERIFIER_GEPRUEFT=true

    local probe kandidat
    probe=$(mktemp) || return 1
    printf '%s' "$TESTVEKTOR_MSG_HEX" | { command -v xxd >/dev/null 2>&1 \
        && xxd -r -p > "$probe" || printf 'r' > "$probe"; }

    for kandidat in openssl docker; do
        if "verifier_$kandidat" "$probe" "$TESTVEKTOR_SIG" "$TESTVEKTOR_PUB" \
           && ! "verifier_$kandidat" "$probe" "$TESTVEKTOR_SIG_KAPUTT" "$TESTVEKTOR_PUB"; then
            SIG_VERIFIER="$kandidat"
            break
        fi
    done
    rm -f "$probe"
    [[ -n "$SIG_VERIFIER" ]]
}

# ── Versionsanker ────────────────────────────────────────────────────────────
# Liegt als Punktdatei direkt im Installationsverzeichnis. Bewusst NICHT unter
# data/update/: das ist schreibbar in den app-Container gemountet, ein
# kompromittierter Container koennte sonst den Anti-Downgrade-Stand
# manipulieren. Die Signaturpflicht selbst folgt immer aus den eingebetteten
# Schluesseln und laesst sich durch Loeschen dieser Datei nicht abschalten.
# Das Installationsverzeichnis selbst ist in
# keinen Container gemountet, und `tar -xzf --strip-components=1` fasst nur an,
# was im Archiv steht — die Datei ueberlebt jedes Update.
V_SCHLUESSEL=""; V_SEIT=""; V_HOECHSTE=""

vertrauen_datei() {
    printf '%s/%s' "${INSTALL_DIR:-$DEFAULT_INSTALL_DIR}" "$VERTRAUEN_DATEINAME"
}

vertrauen_lesen() {
    V_SCHLUESSEL=""; V_SEIT=""; V_HOECHSTE=""
    local d k v; d=$(vertrauen_datei)
    [[ -f "$d" ]] || return 1
    while IFS='=' read -r k v; do
        case "$k" in
            schluessel)      [[ "$v" =~ ^[a-z0-9-]{1,16}$ ]]                  && V_SCHLUESSEL="$v" ;;
            seit)            [[ "$v" =~ ^[0-9TZ:-]{1,32}$ ]]                  && V_SEIT="$v" ;;
            hoechsteVersion) [[ "$v" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){2}$ ]]      && V_HOECHSTE="$v" ;;
        esac
    done < "$d"
    [[ -n "$V_SCHLUESSEL" ]]
}

vertrauen_schreiben() {   # $1 = keyId, $2 = hoechste gesehene Version
    local d tmp; d=$(vertrauen_datei)
    tmp="$d.tmp.$$"
    {
        echo "# postbuch.net-Versionsanker — nicht von Hand loeschen."
        echo "# Speichert die hoechste gueltig signierte Version fuer Anti-Downgrade."
        echo "# Die eingebetteten Schluessel verlangen unabhaengig von dieser Datei"
        echo "# vom ersten Kontakt an eine gueltige Signatur."
        echo "version=1"
        echo "schluessel=$1"
        echo "seit=${V_SEIT:-$(date -u '+%Y-%m-%dT%H:%M:%SZ')}"
        echo "hoechsteVersion=$2"
    } > "$tmp" 2>/dev/null || { rm -f "$tmp" 2>/dev/null; return 1; }
    chmod 644 "$tmp" 2>/dev/null || true
    mv -f "$tmp" "$d" 2>/dev/null || { rm -f "$tmp" 2>/dev/null; return 1; }
    if [[ $(id -u) -eq 0 ]]; then
        chown "$(installations_besitzer_bestimmen "$INSTALL_DIR")" "$d" || return 1
    fi
}

# ── Die eigentliche Pruefung ─────────────────────────────────────────────────
# Rueckgabe 0 = weitermachen, 1 = abbrechen (der Aufrufer hat dann noch NICHTS
# am Installationsverzeichnis geaendert).
pruefe_release_signatur() {
    local geimpft=false
    vertrauen_lesen && geimpft=true

    # Eine Fassung ohne eingebetteten Release-Schluessel kann nicht pruefen.
    # Produktive Releases werden vom Release-Gate in diesem Zustand abgelehnt.
    # Bewusst mit bash-Bordmitteln statt `grep -qv '\s'`: \s ist eine
    # GNU-Erweiterung und faellt auf BSD/macOS still auf die Nase — hier hiesse
    # "still" allerdings: die Pruefung waere ploetzlich aktiv oder plotzlich
    # nicht, je nach grep.
    local _zeile _hat_schluessel=false
    while IFS= read -r _zeile; do
        [[ "$_zeile" =~ ^[[:space:]]*(#.*)?$ ]] || { _hat_schluessel=true; break; }
    done <<< "$RELEASE_SCHLUESSEL"
    if ! $_hat_schluessel; then
        SIG_ERGEBNIS="unkonfiguriert"
        return 0
    fi

    if ! manifest_holen; then
        SIG_ERGEBNIS="kein-manifest"
        signatur_abbruch_oder_warnung "$geimpft" \
            "Das Release-Manifest ist nicht erreichbar oder passt nicht zur Anforderung." || return 1
        return 0
    fi

    local sig keyid
    sig=$(manifest_feld signatur)
    keyid=$(manifest_feld signaturKeyId)
    [[ "$keyid" =~ ^[a-z0-9-]{1,16}$ ]] || keyid=""

    # "fehlt" wird ab hier genauso behandelt wie "falsch". Sonst genuegte es,
    # das Feld zu entfernen.
    if [[ -z "$sig" || "$sig" == "null" || ! "$sig" =~ ^[A-Za-z0-9+/=]{1,512}$ ]]; then
        SIG_ERGEBNIS="fehlt"
        signatur_abbruch_oder_warnung "$geimpft" "Das Release-Manifest traegt keine Signatur." || return 1
        return 0
    fi

    if ! verifier_ermitteln; then
        SIG_ERGEBNIS="kein-verifier"
        if ! $OPT_OHNE_SIGNATUR; then
            echo "FEHLER: Auf diesem System laesst sich keine Ed25519-Signatur pruefen." >&2
            echo "  Weder 'openssl pkeyutl -rawin' (braucht OpenSSL 3.0) noch ein lokal" >&2
            echo "  vorhandenes Node-Image stehen zur Verfuegung." >&2
            echo "  Diese Installer-Version kennt fest eingebettete Release-Schluessel und" >&2
            echo "  verlangt deshalb eine Signatur. Abbruch — es wurde nichts veraendert." >&2
            echo "" >&2
            echo "  Wenn du sicher bist, dass das an einer fehlenden Pruefmoeglichkeit liegt" >&2
            echo "  und nicht an einem manipulierten Release: --ohne-signatur-fortfahren" >&2
            return 1
        fi
        echo "  WARNUNG: Keine Ed25519-Pruefmoeglichkeit auf diesem System – wegen"
        echo "           --ohne-signatur-fortfahren wird mit lokalem, gepinntem Archiv fortgefahren."
        return 0
    fi

    local bytes; bytes=$(mktemp) || return 1
    if ! signatur_kanonische_bytes "$bytes"; then
        rm -f "$bytes"
        SIG_ERGEBNIS="ungueltig"
        signatur_abbruch_oder_warnung "$geimpft" \
            "Das Release-Manifest ist unvollstaendig — die signierten Felder fehlen." || return 1
        return 0
    fi

    # Gegen alle bekannten Schluessel pruefen. `signaturKeyId` ist nur ein
    # Hinweis: es kommt aus derselben Quelle wie die Signatur und darf deshalb
    # nicht darueber entscheiden, OB geprueft wird.
    local zeile id pub treffer=""
    while IFS= read -r zeile; do
        [[ "$zeile" =~ ^[[:space:]]*(#.*)?$ ]] && continue
        id="${zeile%%:*}"; pub="${zeile#*:}"
        [[ "$id" =~ ^[a-z0-9-]{1,16}$ ]] || continue
        [[ "$pub" =~ ^[A-Za-z0-9+/=]{43,44}$ ]] || continue
        if "verifier_$SIG_VERIFIER" "$bytes" "$sig" "$pub"; then treffer="$id"; break; fi
    done <<< "$RELEASE_SCHLUESSEL"
    rm -f "$bytes"

    if [[ -z "$treffer" ]]; then
        SIG_ERGEBNIS="ungueltig"
        signatur_abbruch_oder_warnung "$geimpft" \
            "Die Signatur des Release-Manifests ist ungueltig." || return 1
        return 0
    fi

    SIG_ERGEBNIS="gueltig"
    echo "  Signatur bestaetigt (Schluessel $treffer, geprueft per $SIG_VERIFIER)."

    # ── Rueckschritt-Schutz ──────────────────────────────────────────────────
    # Ein altes Release bleibt fuer immer gueltig signiert. Wer den Kanal
    # kontrolliert, koennte also eine aeltere Fassung mit bekannter Luecke
    # erneut ausspielen — die Signatur allein merkt das nicht. Deshalb wird die
    # hoechste je gesehene signierte Version mitgefuehrt.
    local mversion aelter
    mversion=$(manifest_feld version)
    if [[ -n "$V_HOECHSTE" && "$mversion" != "$V_HOECHSTE" ]]; then
        aelter=$(printf '%s\n%s' "$mversion" "$V_HOECHSTE" | sort -V | head -n1)
        if [[ "$aelter" == "$mversion" ]]; then
            if ! $OPT_ERLAUBE_RUECKSCHRITT; then
                echo "FEHLER: Das Manifest nennt Version $mversion, hier war schon $V_HOECHSTE" >&2
                echo "  signiert verfuegbar. Ein Rueckschritt wird nicht ausgefuehrt." >&2
                echo "  Absichtlich zurueck? --erlaube-rueckschritt" >&2
                return 1
            fi
            echo "  WARNUNG: Rueckschritt auf $mversion ausdruecklich erlaubt."
        fi
    fi

    # ── Versionsanker ────────────────────────────────────────────────────────
    # Nur eine tatsaechlich verifizierte Signatur aktualisiert den Anker.
    local hoechste="$mversion"
    if [[ -n "$V_HOECHSTE" ]]; then
        hoechste=$(printf '%s\n%s' "$mversion" "$V_HOECHSTE" | sort -V | tail -n1)
    fi
    SIG_PIN_SCHLUESSEL="$treffer"
    SIG_PIN_HOECHSTE_VERSION="$hoechste"
    if [[ -d "${INSTALL_DIR:-}" ]] || [[ -d "$DEFAULT_INSTALL_DIR" ]]; then
        if vertrauen_schreiben "$treffer" "$hoechste"; then
            $geimpft || echo "  Versionsanker fuer Anti-Downgrade gesetzt."
        else
            echo "  WARNUNG: Vertrauensanker konnte nicht geschrieben werden ($(vertrauen_datei))."
        fi
    fi
    return 0
}

# Gemeinsamer Ausgang fuer "Signatur nicht in Ordnung": eingebettete
# Release-Schluessel sind bereits der Vertrauensanker. TOFU gibt es nicht.
signatur_abbruch_oder_warnung() {   # $1 = geimpft (true/false), $2 = Meldung
    if ! $OPT_OHNE_SIGNATUR; then
        echo "FEHLER: $2" >&2
        echo "  Dieser Installer kennt fest eingebettete Release-Schluessel und verlangt" >&2
        echo "  deshalb von Anfang an eine gueltige Signatur." >&2
        echo "  Abbruch — es wurde nichts veraendert." >&2
        return 1
    fi
    echo "  WARNUNG: $2 Wegen --ohne-signatur-fortfahren wird mit lokalem, gepinntem Archiv fortgefahren."
    return 0
}

# ── Das Tor vor jedem Entpacken ──────────────────────────────────────────────
# Setzt ERWARTETE_SHA und prueft vorher die Signatur. Rueckgabe 1 = abbrechen.
#
# Wichtig: das Manifest wird AUCH dann geholt, wenn --erwarte-sha256 uebergeben
# wurde. Der Agent bekommt seine Pruefsumme von der App; wuerde dieses Skript
# sich darauf verlassen, bliebe genau der Weg ungeprueft, den fast jeder Admin
# benutzt (Klick im GUI). Stimmen beide Angaben nicht ueberein, ist das ein
# Abbruchgrund und keine Kleinigkeit.
manifest_gate() {
    ERWARTETE_SHA=""
    pruefe_release_signatur || return 1

    # Der lokale Stand ist auch ohne vorhandene Vertrauensdatei eine
    # Anti-Downgrade-Grenze. Ein altes, weiterhin korrekt signiertes Manifest
    # darf eine neuere Installation nicht zurücksetzen.
    local mversion installiert lower install_basis
    mversion=$(manifest_feld version)
    install_basis="${INSTALL_DIR:-$DEFAULT_INSTALL_DIR}"
    installiert=""
    [[ -f "$install_basis/VERSION" ]] && installiert=$(tr -d '[:space:]' < "$install_basis/VERSION")
    if [[ "$mversion" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){2}$ \
          && "$installiert" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){2}$ \
          && "$mversion" != "$installiert" ]]; then
        lower=$(printf '%s\n%s\n' "$mversion" "$installiert" | sort -V | head -n1)
        if [[ "$lower" == "$mversion" && "$OPT_ERLAUBE_RUECKSCHRITT" != "true" ]]; then
            echo "FEHLER: Das signierte Manifest nennt Version $mversion, installiert ist $installiert." >&2
            echo "  Ein Rueckschritt wird nicht ausgefuehrt." >&2
            return 1
        fi
    fi

    local aus_manifest=""
    aus_manifest=$(hole_erwartete_sha256 || true)

    if [[ -n "$OPT_SHA256" ]]; then
        if [[ -n "$aus_manifest" && "$aus_manifest" != "$OPT_SHA256" ]]; then
            echo "FEHLER: Die angeforderte Pruefsumme passt nicht zum aktuellen Manifest." >&2
            echo "  angefordert: $OPT_SHA256" >&2
            echo "  im Manifest: $aus_manifest" >&2
            echo "  Entweder wurde zwischenzeitlich veroeffentlicht — dann im GUI erneut auf" >&2
            echo "  Updates pruefen — oder eine der beiden Angaben stimmt nicht. Abbruch." >&2
            return 1
        fi
        ERWARTETE_SHA="$OPT_SHA256"
    else
        ERWARTETE_SHA="$aus_manifest"
    fi
    return 0
}

# Der Prueflauf der interaktiven Pfade. Setzt voraus, dass manifest_gate schon
# gelaufen ist. Bricht bei Abweichung ab, ohne $INSTALL_DIR angefasst zu haben.
tarball_pruefen_oder_abbrechen() {   # $1 = Tarball
    if [[ -z "$ERWARTETE_SHA" ]]; then
        error "Keine vertrauenswürdige Prüfsumme verfügbar. Abbruch – es wurde nichts verändert."
    fi
    info "Prüfe Prüfsumme des Downloads..."
    if ! pruefe_sha256 "$1" "$ERWARTETE_SHA"; then
        [[ "$1" != "$LOCAL_TARBALL" ]] && rm -f "$1"
        error "Der Download passt nicht zum Release-Manifest. Abbruch – es wurde nichts verändert."
    fi
}

# Entpackt ein bereits kryptographisch geprüftes Release zuerst in ein isoliertes
# Stage-Verzeichnis. GNU tar wird keine Gelegenheit gegeben, Pfade außerhalb des
# Stages oder Sonderdateien anzulegen.
release_stage_erstellen() {   # $1 = Tarball, setzt RELEASE_STAGE
    local archiv="$1" liste typen prefix manifest_version interne_version
    RELEASE_STAGE=""
    liste=$(mktemp) || return 1
    typen=$(mktemp) || { rm -f "$liste"; return 1; }
    if ! tar -tzf "$archiv" > "$liste" || ! tar -tvzf "$archiv" > "$typen"; then
        rm -f "$liste" "$typen"
        echo "FEHLER: Release-Archiv ist nicht lesbar." >&2
        return 1
    fi
    if ! awk '
      BEGIN { ok=1; prefix="" }
      {
        p=$0
        if (p=="" || p ~ /^\// || p ~ /(^|\/)\.\.?(\/|$)/ || p ~ /\\/) ok=0
        split(p, a, "/")
        if (prefix=="") prefix=a[1]
        if (a[1] != prefix || prefix != "postbuch-unified") ok=0
      }
      END { exit ok ? 0 : 1 }
    ' "$liste"; then
        rm -f "$liste" "$typen"
        echo "FEHLER: Release-Archiv enthält unerlaubte Pfade oder ein falsches Präfix." >&2
        return 1
    fi
    if ! awk '{ t=substr($0,1,1); if (t!="-" && t!="d") exit 1 }' "$typen"; then
        rm -f "$liste" "$typen"
        echo "FEHLER: Release-Archiv enthält Links oder Sonderdateien." >&2
        return 1
    fi
    rm -f "$liste" "$typen"

    RELEASE_STAGE=$(mktemp -d "${INSTALL_DIR}.stage.XXXXXX") || return 1
    # Release-Code muss auch für den nicht-root nginx-Worker lesbar sein.
    # Secrets (.env, Caddyfile) werden erst später mit explizitem Modus 0600
    # ergänzt. Die umask darf deshalb nicht aus dem aufrufenden Prozess erben.
    if ! ( umask 022
        tar -xzf "$archiv" -C "$RELEASE_STAGE" --strip-components=1 \
            --no-same-owner --no-same-permissions
    ); then
        safe_rm_rf "$RELEASE_STAGE"
        RELEASE_STAGE=""
        echo "FEHLER: Release konnte nicht ins Stage-Verzeichnis entpackt werden." >&2
        return 1
    fi
    interne_version=""
    [[ -f "$RELEASE_STAGE/VERSION" ]] && interne_version=$(tr -d '[:space:]' < "$RELEASE_STAGE/VERSION")
    manifest_version=$(manifest_feld version)
    if [[ ! "$interne_version" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){2}$ \
          || ( -n "$manifest_version" && "$interne_version" != "$manifest_version" ) ]]; then
        safe_rm_rf "$RELEASE_STAGE"
        RELEASE_STAGE=""
        echo "FEHLER: VERSION im Release passt nicht zum signierten Manifest." >&2
        return 1
    fi
}

installations_besitzer_bestimmen() { # $1=Ziel → uid:gid
    local ziel="$1" eltern
    if [[ -e "$ziel" ]]; then
        stat -c '%u:%g' "$ziel"
        return
    fi
    # Eine Erstinstallation über sudo gehört weiterhin dem aufrufenden Nutzer,
    # nicht root. Fehlt die sudo-Herkunft, ist der Besitzer des Ziel-Elternpfads
    # die sicherste lokale Vorgabe (z. B. /home/pi für /home/pi/postbuch).
    if [[ $(id -u) -eq 0 && "${SUDO_UID:-}" =~ ^[0-9]+$ \
          && "${SUDO_GID:-}" =~ ^[0-9]+$ ]]; then
        printf '%s:%s' "$SUDO_UID" "$SUDO_GID"
        return
    fi
    eltern=$(dirname "$ziel")
    if [[ -d "$eltern" ]]; then
        stat -c '%u:%g' "$eltern"
    else
        printf '%s:%s' "$(id -u)" "$(id -g)"
    fi
}

# Übernimmt ausschließlich die im kryptografisch geprüften Stage enthaltenen
# Pfade. data/ und backups liegen nie im Stage und bleiben damit garantiert
# unangetastet. Das ist nötig, wenn der systemd-Agent als root aktualisiert:
# rsync -a/cp -a würden sonst root-Eigentum des Stages übernehmen.
release_stage_besitzer_wiederherstellen() { # $1=Stage $2=Ziel $3=uid:gid $4=Modus
    local stage="$1" ziel="$2" besitzer="$3" zielmodus="$4" quelle relativ zielpfad
    if [[ $(id -u) -eq 0 ]]; then
        while IFS= read -r -d '' quelle; do
            if [[ "$quelle" == "$stage" ]]; then
                zielpfad="$ziel"
            else
                relativ="${quelle#"$stage"/}"
                zielpfad="$ziel/$relativ"
            fi
            case "${relativ:-}" in
                data|data/*|backups|backups/*) continue ;;
            esac
            [[ -e "$zielpfad" || -L "$zielpfad" ]] || continue
            chown -h "$besitzer" "$zielpfad" || return 1
        done < <(find "$stage" -xdev -print0)
    fi
    chmod "$zielmodus" "$ziel" || return 1
}

release_persistente_besitzer_wiederherstellen() { # $1=Ziel $2=uid:gid
    local ziel="$1" besitzer="$2" relativ
    [[ $(id -u) -eq 0 ]] || return 0
    # Diese Dateien werden nicht aus dem Stage übernommen. Der root-Agent kann
    # sie trotzdem ersetzen; data/ und backups bleiben ausdrücklich außen vor.
    for relativ in .env .postbuch-vertrauen .postbuch-update-agent.log restart.sh caddy/Caddyfile; do
        [[ -e "$ziel/$relativ" || -L "$ziel/$relativ" ]] || continue
        chown -h "$besitzer" "$ziel/$relativ" || return 1
    done
}

release_stage_promoten() {   # $1 = Stage, $2 = Installationsverzeichnis
    local stage="$1" ziel="$2" env_tmp caddy_tmp="" besitzer zielmodus
    besitzer=$(installations_besitzer_bestimmen "$ziel") || return 1
    zielmodus=$(stat -c '%a' "$ziel") || return 1
    env_tmp=$(mktemp) || return 1
    cp "$ziel/.env" "$env_tmp" || { rm -f "$env_tmp"; return 1; }
    chmod 600 "$env_tmp"
    if [[ -f "$ziel/caddy/Caddyfile" ]]; then
        caddy_tmp=$(mktemp) || { rm -f "$env_tmp"; return 1; }
        cp "$ziel/caddy/Caddyfile" "$caddy_tmp" || { rm -f "$env_tmp" "$caddy_tmp"; return 1; }
        chmod 600 "$caddy_tmp"
    fi

    if command -v rsync >/dev/null 2>&1; then
        if ! rsync -a --delete \
          --exclude='/.env' --exclude='/data/' --exclude='/backups/' \
          --exclude='/.postbuch-vertrauen' --exclude='/.postbuch-update-agent.log' \
          --exclude='/caddy/Caddyfile' "$stage/" "$ziel/"; then
            rm -f "$env_tmp" "$caddy_tmp"
            return 1
        fi
    else
        # Erst alle vom Release verwalteten Wurzeln entfernen, dann exakt den
        # Stage-Inhalt kopieren. Nur dokumentierte Laufzeitpfade bleiben stehen.
        local pfad basis
        for pfad in "$ziel"/* "$ziel"/.[!.]*; do
            [[ -e "$pfad" ]] || continue
            basis=$(basename "$pfad")
            case "$basis" in .env|data|backups|.postbuch-vertrauen|.postbuch-update-agent.log) continue ;; esac
            safe_rm_rf "$pfad" || { rm -f "$env_tmp" "$caddy_tmp"; return 1; }
        done
        cp -a "$stage/." "$ziel/" || { rm -f "$env_tmp" "$caddy_tmp"; return 1; }
    fi
    cp "$env_tmp" "$ziel/.env" && chmod 600 "$ziel/.env" \
        || { rm -f "$env_tmp" "$caddy_tmp"; return 1; }
    if [[ -n "$caddy_tmp" ]]; then
        mkdir -p "$ziel/caddy"
        cp "$caddy_tmp" "$ziel/caddy/Caddyfile" && chmod 600 "$ziel/caddy/Caddyfile" \
            || { rm -f "$env_tmp" "$caddy_tmp"; return 1; }
    fi
    if ! release_stage_besitzer_wiederherstellen "$stage" "$ziel" "$besitzer" "$zielmodus"; then
        rm -f "$env_tmp" "$caddy_tmp"
        return 1
    fi
    release_persistente_besitzer_wiederherstellen "$ziel" "$besitzer" \
        || { rm -f "$env_tmp" "$caddy_tmp"; return 1; }
    rm -f "$env_tmp" "$caddy_tmp"
    return 0
}

# ── Safe-Mode ohne Rueckfrage ────────────────────────────────────────────────
# Gleiche Erkennung wie detect_and_offer_safe_mode(), aber ohne /dev/tty: im
# nicht-interaktiven Lauf wird Safe-Mode bei wenig RAM einfach aktiviert. Ein
# langsamer Build ist besser als ein OOM-Abbruch mitten im Update.
safe_mode_headless() {
    local mem_kb mem_mb cap
    mem_kb=$(grep -m1 '^MemTotal:' /proc/meminfo 2>/dev/null | awk '{print $2}' || echo 0)
    mem_mb=$(( mem_kb / 1024 ))
    [[ "$mem_mb" -le 0 || "$mem_mb" -ge 2048 ]] && return 0
    cap=$(( mem_mb * 70 / 100 ))
    [[ "$cap" -lt 512  ]] && cap=512
    [[ "$cap" -gt 1536 ]] && cap=1536
    SAFE_MODE=true
    WEB_BUILD_NODE_OPTIONS="--max-old-space-size=${cap}"
    echo "  Wenig RAM (${mem_mb} MB) – Safe-Mode aktiv (serieller Build, Heap ${cap} MB)."
}

# ── Docker-Voraussetzungen ohne Rueckfrage ───────────────────────────────────
docker_headless_pruefen() {
    command -v docker &>/dev/null || { echo "FEHLER: Docker ist nicht installiert." >&2; return 1; }
    docker compose version &>/dev/null 2>&1 || { echo "FEHLER: docker compose fehlt." >&2; return 1; }
    if docker info &>/dev/null 2>&1; then
        DOCKER_COMPOSE="docker compose"
    elif sudo -n docker info &>/dev/null 2>&1; then
        DOCKER_COMPOSE="sudo docker compose"
    else
        echo "FEHLER: Kein Zugriff auf den Docker-Daemon (weder direkt noch per sudo -n)." >&2
        return 1
    fi
    return 0
}

# ══════════════════════════════════════════════════════════════════════════════
# UPDATE-AGENT EINRICHTEN
# ══════════════════════════════════════════════════════════════════════════════
# Der Agent ist das, was ein Update im GUI ueberhaupt erst ausloesbar macht. Er
# laeuft auf dem HOST, nicht im Container: die App bleibt unprivilegiert und
# darf ein Update nur anfordern.
#
# Der Agent läuft ausschließlich als root-systemd-Timer. Der frühere cron-
# Fallback mischte nutzereigene Ausführung mit root-eigenen Dateien unter
# /usr/local/lib und konnte sich nach einem Update nicht zuverlässig erneuern.
#
# WICHTIG: Wird NUR bei interaktiven Laeufen angeboten. Im nicht-interaktiven
# Pfad wird ein Agent nie neu aktiviert — ein Update darf sich nicht selbst
# neue Rechte verschaffen.
AGENT_LIB="/usr/local/lib/postbuch"
AGENT_CONF="/etc/postbuch-update-agent.conf"

agent_systemd_bereit() {
    command -v systemctl &>/dev/null \
        && systemctl is-enabled --quiet postbuch-update-agent.timer 2>/dev/null \
        && systemctl is-active --quiet postbuch-update-agent.timer 2>/dev/null
}

install_update_agent() {
    local modus="${1:-normal}"
    local quelle="$INSTALL_DIR/scripts/postbuch-update-agent.sh"
    local hostconfig_quelle="$INSTALL_DIR/scripts/postbuch-hostconfig.sh"

    if [[ ! -f "$quelle" || ! -f "$hostconfig_quelle" ]]; then
        warn "Update-Agent nicht im Quellbaum gefunden ($quelle) – uebersprungen."
        return 1
    fi
    if ! command -v sudo &>/dev/null && [[ $(id -u) -ne 0 ]]; then
        warn "Ohne root/sudo kann der Update-Agent nicht eingerichtet werden."
        return 1
    fi
    if ! command -v systemctl &>/dev/null || [[ ! -d /etc/systemd/system ]]; then
        warn "Der Update-Agent benötigt systemd; Updates bleiben auf diesem System Handarbeit."
        return 1
    fi

    local SUDO="" agent_besitzer
    [[ $(id -u) -ne 0 ]] && SUDO="sudo"
    agent_besitzer=$(installations_besitzer_bestimmen "$INSTALL_DIR") || return 1

    $SUDO mkdir -p "$AGENT_LIB/state" || return 1
    $SUDO cp -f "$quelle" "$AGENT_LIB/postbuch-update-agent.sh" || return 1
    $SUDO cp -f "$hostconfig_quelle" "$AGENT_LIB/postbuch-hostconfig.sh" || return 1
    if ! $SUDO cp -f "$INSTALL_DIR/deploy-pages/install.sh" "$AGENT_LIB/install.sh" 2>/dev/null; then
        $SUDO cp -f "$0" "$AGENT_LIB/install.sh" || return 1
    fi
    $SUDO chmod 755 "$AGENT_LIB/postbuch-update-agent.sh" "$AGENT_LIB/postbuch-hostconfig.sh" "$AGENT_LIB/install.sh" || return 1
    $SUDO chown root:root "$AGENT_LIB/state" 2>/dev/null || true
    $SUDO chmod 700 "$AGENT_LIB/state" || return 1

    $SUDO tee "$AGENT_CONF" >/dev/null <<CONFEOF || return 1
POSTBUCH_INSTALL_DIR=$INSTALL_DIR
AGENT_MODE=$modus
CONFEOF
    $SUDO chmod 644 "$AGENT_CONF" || return 1

    # Übergabeverzeichnis anlegen und dem tatsächlichen Installationsbesitzer
    # geben. Das ist auch bei einem via sudo gestarteten Installer nicht root.
    mkdir -p "$INSTALL_DIR/data/update" 2>/dev/null \
        || $SUDO mkdir -p "$INSTALL_DIR/data/update"
    $SUDO chown -R "$agent_besitzer" "$INSTALL_DIR/data/update" 2>/dev/null || true
    chmod 755 "$INSTALL_DIR/data/update" 2>/dev/null || true

    $SUDO tee /etc/systemd/system/postbuch-update-agent.service >/dev/null <<'UNITEOF' || return 1
[Unit]
Description=postbuch.net Update-Agent (holt Update-Anforderungen der App ab)
After=docker.service
Wants=docker.service

[Service]
Type=oneshot
ExecStart=/usr/local/lib/postbuch/postbuch-update-agent.sh
# Ein Update darf lange dauern (vite-Build auf schwacher Hardware).
TimeoutStartSec=7200
UNITEOF
    $SUDO tee /etc/systemd/system/postbuch-update-agent.timer >/dev/null <<'TIMEREOF' || return 1
[Unit]
Description=postbuch.net Update-Agent minuetlich ausfuehren

[Timer]
OnBootSec=2min
OnUnitActiveSec=1min
AccuracySec=10s

[Install]
WantedBy=timers.target
TIMEREOF
    $SUDO systemctl daemon-reload || return 1
    $SUDO systemctl enable --now postbuch-update-agent.timer >/dev/null 2>&1 || return 1
    $SUDO systemctl is-enabled --quiet postbuch-update-agent.timer || return 1
    $SUDO systemctl is-active --quiet postbuch-update-agent.timer || return 1
    # Einen alten Nutzer-cron nach erfolgreicher systemd-Migration entfernen.
    # Die systemd-Instanz ist ab jetzt die einzige Agent-Quelle.
    if command -v crontab &>/dev/null; then
        local bestehende_cron
        bestehende_cron=$(crontab -l 2>/dev/null || true)
        if [[ "$bestehende_cron" == *postbuch-update-agent.sh* ]]; then
            { printf '%s\n' "$bestehende_cron" \
                | grep -v 'postbuch-update-agent.sh' || true; } \
                | crontab - || return 1
        fi
    fi
    success "Update-Agent als systemd-Timer eingerichtet (Modus: $modus)."
    return 0
}

aktualisiere_vorhandenen_update_agent() {
    # Ein bereits eingerichteter Agent ist Teil der Installation und muss nach
    # JEDEM erfolgreichen Update aus dem neuen Quellbaum aktualisiert werden.
    # Sonst kann gerade ein Fehler im Agenten den Weg zum eigenen Fix versperren.
    [[ -f "$AGENT_CONF" ]] || return 0

    local quelle="$INSTALL_DIR/scripts/postbuch-update-agent.sh"
    local hostconfig_quelle="$INSTALL_DIR/scripts/postbuch-hostconfig.sh"
    if [[ ! -f "$quelle" || ! -f "$hostconfig_quelle" || ! -f "$INSTALL_DIR/deploy-pages/install.sh" ]]; then
        warn "Update-Agent konnte nicht aktualisiert werden: Dateien fehlen im neuen Quellbaum."
        return 1
    fi

    local SUDO=""
    # Der Agent-Refresh ist absichtlich immer promptfrei. Benötigte Privilegien
    # werden beim Einrichten des Dienstes früh und sichtbar abgefragt; nach dem
    # langen Build darf niemals überraschend ein Passwortdialog erscheinen.
    [[ $(id -u) -ne 0 ]] && SUDO="sudo -n"

    if ! $SUDO cp -f "$quelle" "$AGENT_LIB/postbuch-update-agent.sh" \
        || ! $SUDO cp -f "$hostconfig_quelle" "$AGENT_LIB/postbuch-hostconfig.sh" \
        || ! $SUDO cp -f "$INSTALL_DIR/deploy-pages/install.sh" "$AGENT_LIB/install.sh" \
        || ! $SUDO chmod 755 "$AGENT_LIB/postbuch-update-agent.sh" "$AGENT_LIB/postbuch-hostconfig.sh" "$AGENT_LIB/install.sh"; then
        warn "Update-Agent wurde NICHT aktualisiert. Bitte die sudo-Meldung beheben; GUI-Updates bleiben bis dahin unsicher."
        return 1
    fi

    success "Vorhandener Update-Agent wurde aktualisiert."
}

SUDO_KEEPALIVE_PID=""

# Fragt EINMALIG früh und sichtbar nach dem Sudo-Passwort (statt es dem
# späteren "sudo -n" in aktualisiere_vorhandenen_update_agent zu überlassen)
# und hält den Sudo-Timestamp per Hintergrundschleife für die Laufzeit des
# Skripts wach. Ohne das würde ein evtl. sehr langer Build (schwache
# Hardware, siehe TimeoutStartSec=7200 der Agent-Unit) den Timestamp
# ablaufen lassen, bevor der Refresh danach drankommt — auf Systemen ohne
# passwortlosen Sudo scheitert der Refresh dann bei jedem Update lautlos.
sudo_keepalive_starten() {
    [[ $(id -u) -ne 0 ]] || return 0
    command -v sudo &>/dev/null || return 0
    sudo -v || {
        warn "Sudo-Authentifizierung fehlgeschlagen – der Update-Agent kann nach dem Build evtl. nicht aktualisiert werden."
        return 1
    }
    (
        while kill -0 "$$" 2>/dev/null; do
            sudo -n true 2>/dev/null
            sleep 50
        done
    ) &
    SUDO_KEEPALIVE_PID=$!
    # installer_log_starten() haengt bereits "installer_log_abschluss" als
    # EXIT-Trap ein (Protokollabschluss). Den hier NICHT ueberschreiben,
    # sondern verketten -- sonst faellt das Installationsprotokoll weg.
    trap 'kill "$SUDO_KEEPALIVE_PID" 2>/dev/null; installer_log_abschluss' EXIT
}

# Fragt nach dem Update-Agenten — AUSSCHLIESSLICH im interaktiven Lauf.
# Im nicht-interaktiven Pfad wird ein Agent nie neu aktiviert: ein Update darf
# sich nicht selbst neue Rechte verschaffen.
frage_agent_an() {
    $OPT_NON_INTERACTIVE && return 0
    # Der gefuehrte Installer liest seine Antworten bewusst aus /dev/tty.
    # Daher nicht nur stdin pruefen, sondern den tatsaechlich verwendeten
    # Eingabekanal oeffnen. Pipe-Ausfuehrung ist kein unterstuetzter
    # Installationsweg.
    if ! { : </dev/tty; } 2>/dev/null; then
        return 0
    fi

    if [[ -f "$AGENT_CONF" ]] && agent_systemd_bereit; then
        info "Update-Agent ist bereits eingerichtet."
        return 0
    fi
    if [[ -f "$AGENT_CONF" ]]; then
        warn "Vorhandener Update-Agent ist nicht als aktiver systemd-Timer eingerichtet und wird jetzt repariert."
    fi

    panel "Updates aus der Web-Oberfläche" "postbuch.net kann anzeigen, wenn eine neue Version vorliegt. Wenn du möchtest,
richtet der Installer zusätzlich einen kleinen Dienst auf diesem Server ein,
der ein Update auf Knopfdruck aus der Oberfläche ausführt.

Was er tut:
• prüft einmal pro Minute, ob in der Oberfläche ein Update angefordert wurde
• legt vorher automatisch ein Backup inkl. Datenbank an
• prüft die Prüfsumme des Downloads, bevor irgendetwas ersetzt wird

Zum Einrichten des Systemdienstes wird jetzt einmalig sudo benötigt. Die
Abfrage erfolgt bewusst vor einem möglicherweise langen Container-Build.

Ohne diesen Dienst funktioniert alles wie bisher — du siehst dann nur den
Hinweis auf eine neue Version und führst das Update selbst auf dem Server aus."

    echo ""
    local ans=""
    while [[ "$ans" != "j" && "$ans" != "J" && "$ans" != "n" && "$ans" != "N" ]]; do
        read -rp "  Update-Dienst einrichten? [J/n]: " ans </dev/tty
        [[ -z "$ans" ]] && ans="j"
    done
    if [[ "$ans" == "j" || "$ans" == "J" ]]; then
        install_update_agent normal || warn "Update-Dienst konnte nicht eingerichtet werden – kein Problem, Updates gehen weiter von Hand."
    else
        info "Kein Update-Dienst – Updates bleiben Handarbeit auf dem Server."
    fi
}

# Prueft das App-interne Backup-Feature (_settings.backup.enabled, DB/Ablage-
# Cron in der Web-Oberflaeche) — NICHT den Vor-Update-Schnappschuss weiter
# unten, der ohnehin bei jedem Update automatisch laeuft. Rein informativ:
# aktiviert wird ausschliesslich in der Web-Oberflaeche, dieser Installer
# schreibt der laufenden App nie eigenmaechtig in die Einstellungen.
backup_feature_status_pruefen() {
    local DB_USER DB_PW DB_NAME wert
    DB_USER=$(grep '^POSTGRES_USER='     "$INSTALL_DIR/.env" | cut -d'=' -f2- || echo "postbuch")
    DB_PW=$(grep  '^POSTGRES_PASSWORD=' "$INSTALL_DIR/.env" | cut -d'=' -f2-)
    DB_NAME=$(grep '^POSTGRES_DB='      "$INSTALL_DIR/.env" | cut -d'=' -f2- || echo "postbuch")

    if ! docker_runtime inspect postbuch-postgres \
            --format '{{.State.Running}}' 2>/dev/null | grep -q "true"; then
        return 0
    fi

    wert=$(docker_runtime exec postbuch-postgres \
        env PGPASSWORD="$DB_PW" \
        psql -U "$DB_USER" -d "$DB_NAME" -tAc \
            "SELECT value->>'enabled' FROM postbuch._settings WHERE key='backup';" \
        2>/dev/null | tr -d '[:space:]')

    [[ "$wert" == "true" ]] && return 0

    panel "Backup ist nicht aktiv" "Auf dieser Instanz laeuft aktuell kein automatisches Backup
(Datenbank-Sicherung + Ablage). Ohne aktives Backup gehen Dokumente
und Daten bei einem Ausfall unwiederbringlich verloren."

    # Ohne TTY (z.B. versehentlich per Pipe/CI) nur der Hinweis oben, kein
    # Aktivierungsangebot — dieselbe Absicherung wie in frage_agent_an().
    $OPT_NON_INTERACTIVE && return 0
    if ! { : </dev/tty; } 2>/dev/null; then
        return 0
    fi

    echo ""
    local ans=""
    while [[ "$ans" != "j" && "$ans" != "J" && "$ans" != "n" && "$ans" != "N" ]]; do
        read -rp "  Backup jetzt aktivieren (taeglich 04:00 Uhr, Ablage wie bisher konfiguriert)? [J/n]: " ans </dev/tty
        [[ -z "$ans" ]] && ans="j"
    done
    if [[ "$ans" == "n" || "$ans" == "N" ]]; then
        info "Backup bleibt aus. Aktivierbar jederzeit in der Web-Oberflaeche unter Einstellungen -> Backup."
        return 0
    fi

    # Bestehenden Cron nie mit einem Default ueberschreiben — nur das
    # enabled-Bit setzen. Fehlt der Datensatz ganz, greift der Default aus
    # der INSERT-Zeile.
    if docker_runtime exec postbuch-postgres \
        env PGPASSWORD="$DB_PW" \
        psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 -q -c \
            "INSERT INTO postbuch._settings (key, value, updated_at)
             VALUES ('backup', '{\"enabled\": true, \"cron\": \"0 4 * * *\"}'::jsonb, NOW())
             ON CONFLICT (key) DO UPDATE
                 SET value = jsonb_set(postbuch._settings.value, '{enabled}', 'true'::jsonb),
                     updated_at = NOW();" \
        >/dev/null 2>&1; then
        success "Backup aktiviert. Wirksam, sobald die App als Teil dieses Updates neu startet."
    else
        warn "Backup konnte nicht automatisch aktiviert werden. Bitte manuell in der Web-Oberflaeche unter Einstellungen -> Backup einschalten."
    fi
}

remove_update_agent() {
    local SUDO=""
    [[ $(id -u) -ne 0 ]] && SUDO="sudo"
    if command -v systemctl &>/dev/null; then
        $SUDO systemctl disable --now postbuch-update-agent.timer >/dev/null 2>&1 || true
        $SUDO rm -f /etc/systemd/system/postbuch-update-agent.{service,timer}
        $SUDO systemctl daemon-reload >/dev/null 2>&1 || true
    fi
    if command -v crontab &>/dev/null; then
        crontab -l 2>/dev/null | grep -v 'postbuch-update-agent.sh' | crontab - 2>/dev/null || true
    fi
    $SUDO rm -rf "$AGENT_LIB" "$AGENT_CONF" 2>/dev/null || true
}

# ══════════════════════════════════════════════════════════════════════════════
# NICHT-INTERAKTIVES UPDATE (der Pfad des Agenten)
# ══════════════════════════════════════════════════════════════════════════════
# Kein einziger /dev/tty-Zugriff. Reihenfolge ist bewusst:
#   download → verify → backup → [dry-run: Ende] → extract → build → up
# Die Pruefsumme wird VOR dem Backup geprueft, damit ein kaputter Download nicht
# einmal ein Backup ausloest; das Backup wiederum liegt VOR dem Entpacken, damit
# es immer einen Rueckweg gibt.
headless_update() {
    INSTALL_DIR="${OPT_INSTALL_DIR:-$DEFAULT_INSTALL_DIR}"

    if [[ ! -f "$INSTALL_DIR/docker-compose.yml" ]]; then
        echo "FEHLER: Keine Installation unter $INSTALL_DIR gefunden." >&2
        return 1
    fi
    docker_headless_pruefen || return 1
    safe_mode_headless

    # Der Host-Agent hat keinen Terminalzugriff. Die Quelle muss daher schon
    # vor dem ersten Netz- oder Backup-Schritt in der lokalen .env stehen.
    bezugsquelle_sicherstellen "$INSTALL_DIR/.env" || return 1
    # Zugangsdaten der Bezugsquelle aus der .env. Dieser Pfad gehoert dem
    # Update-Agenten: es gibt hier keine Konsole, also auch keine Rueckfrage —
    # fehlt die Zeile, bricht der Lauf mit einer eindeutigen Meldung ab, statt
    # spaeter an einem nackten HTTP 401 zu scheitern.
    if ! $QUELLE_GITHUB; then
        feed_auth_aus_env "$INSTALL_DIR/.env" || true
        feed_auth_uebernehmen
    fi
    if ! feed_auth_probe; then
        if $QUELLE_GITHUB; then
            echo "FEHLER: Das Release-Manifest ist nicht erreichbar: $MANIFEST_URL" >&2
        elif [[ -z "$FEED_AUTH_B64" ]]; then
            echo "FEHLER: Die Bezugsquelle antwortet nicht ohne Anmeldung." >&2
            echo "  POSTBUCH_FEED_AUTH in $INSTALL_DIR/.env eintragen (Form: benutzer:passwort)" >&2
            echo "  oder die Bezugsquelle und POSTBUCH_FEED_BASE_URL pruefen." >&2
        else
            echo "FEHLER: Die hinterlegten Zugangsdaten wurden abgelehnt oder die Bezugsquelle ist nicht erreichbar." >&2
        fi
        return 1
    fi

    echo "postbuch.net-Update (nicht-interaktiv)"
    echo "  Verzeichnis: $INSTALL_DIR"
    $OPT_DRY_RUN && echo "  PROBELAUF: es wird nichts ersetzt."

    # ── Manifest + Signatur, VOR dem Download ─────────────────────────────
    # Ein manipuliertes Release soll gar nicht erst auf die Platte kommen, und
    # ein Abbruch hier kostet niemanden einen Download.
    phase verify
    manifest_gate || return 1

    # ── download ──────────────────────────────────────────────────────────
    phase download
    local TARBALL
    if [[ -f "$LOCAL_TARBALL" ]]; then
        TARBALL="$LOCAL_TARBALL"
        echo "  Lokales Archiv gefunden – Download uebersprungen."
    else
        release_url_aktualisieren || return 1
        TARBALL="$(mktemp /tmp/postbuch-latest.XXXXXX.tar.gz)"
        echo "  Lade $RELEASE_URL ..."
        if ! release_download "$TARBALL"; then
            echo "FEHLER: Download fehlgeschlagen." >&2
            rm -f "$TARBALL"
            return 1
        fi
    fi

    # ── verify ────────────────────────────────────────────────────────────
    # $ERWARTETE_SHA kommt aus manifest_gate: entweder aus dem (signatur-
    # geprueften) Manifest oder aus --erwarte-sha256, wobei beide Angaben dort
    # bereits gegeneinander gehalten wurden.
    phase verify
    if [[ -z "$ERWARTETE_SHA" ]]; then
        echo "FEHLER: Keine vertrauenswuerdige Tarball-Pruefsumme verfuegbar." >&2
        [[ "$TARBALL" != "$LOCAL_TARBALL" ]] && rm -f "$TARBALL"
        return 1
    elif ! pruefe_sha256 "$TARBALL" "$ERWARTETE_SHA"; then
        # Abbruch OHNE $INSTALL_DIR anzufassen. Genau dafuer steht verify hier.
        [[ "$TARBALL" != "$LOCAL_TARBALL" ]] && rm -f "$TARBALL"
        return 1
    fi

    local NEW_VERSION="(unbekannt)" CURRENT_VERSION="(unbekannt)"
    [[ -f "$INSTALL_DIR/VERSION" ]] && CURRENT_VERSION=$(tr -d '[:space:]' < "$INSTALL_DIR/VERSION")
    phase extract
    if ! release_stage_erstellen "$TARBALL"; then
        [[ "$TARBALL" != "$LOCAL_TARBALL" ]] && rm -f "$TARBALL"
        return 1
    fi
    NEW_VERSION=$(tr -d '[:space:]' < "$RELEASE_STAGE/VERSION")
    echo "  Installiert: $CURRENT_VERSION  →  Neu: $NEW_VERSION"

    # ── backup ────────────────────────────────────────────────────────────
    phase backup
    echo "  Erstelle Sicherung (Quellcode + Datenbank)..."
    backup_altbestand_besitz_sicherstellen || return 1
    local BACKUP_RESULT
    BACKUP_RESULT=$(backup_current_installation) || true
    if [[ -n "$BACKUP_RESULT" && -d "$BACKUP_RESULT" \
          && -s "$BACKUP_RESULT/db.sql.gz" ]]; then
        echo "  Backup: $BACKUP_RESULT"
    else
        echo "FEHLER: Vollständiges Backup einschließlich Datenbank konnte nicht erstellt werden – Abbruch." >&2
        safe_rm_rf "$RELEASE_STAGE"
        [[ "$TARBALL" != "$LOCAL_TARBALL" ]] && rm -f "$TARBALL"
        return 1
    fi

    if $OPT_DRY_RUN; then
        phase fertig
        echo "  Probelauf beendet. Das Installationsverzeichnis wurde NICHT veraendert."
        safe_rm_rf "$RELEASE_STAGE"
        [[ "$TARBALL" != "$LOCAL_TARBALL" ]] && rm -f "$TARBALL"
        return 0
    fi

    # Stage erhält nur für den Build eine geschützte Kopie der Laufzeitdateien.
    cp "$INSTALL_DIR/.env" "$RELEASE_STAGE/.env" && chmod 600 "$RELEASE_STAGE/.env"
    if [[ -f "$INSTALL_DIR/caddy/Caddyfile" ]]; then
        mkdir -p "$RELEASE_STAGE/caddy"
        cp "$INSTALL_DIR/caddy/Caddyfile" "$RELEASE_STAGE/caddy/Caddyfile"
        chmod 600 "$RELEASE_STAGE/caddy/Caddyfile"
    fi

    local UPD_DUCK
    UPD_DUCK=$(grep '^DUCKDNS_API_TOKEN=' "$INSTALL_DIR/.env" | cut -d'=' -f2- || true)

    # ── build im Stage; alter Quellbaum und laufender Stack bleiben intakt ─
    phase build
    cd "$RELEASE_STAGE"
    export COMPOSE_PROJECT_NAME="$(basename "$INSTALL_DIR")"
    update_build_services_bestimmen "$INSTALL_DIR" "$RELEASE_STAGE"
    echo "  Baue Container – das kann auf schwacher Hardware lange dauern..."
    if [[ -n "$UPD_DUCK" ]]; then
        if ! compose_build caddy "${UPDATE_BUILD_SERVICES[@]}"; then
            safe_rm_rf "$RELEASE_STAGE"
            error "Build fehlgeschlagen. Alter Quellbaum und laufender Stack bleiben unveraendert."
            return 1
        fi
    else
        if ! compose_build "${UPDATE_BUILD_SERVICES[@]}"; then
            safe_rm_rf "$RELEASE_STAGE"
            error "Build fehlgeschlagen. Alter Quellbaum und laufender Stack bleiben unveraendert."
            return 1
        fi
    fi

    # Erst nach erfolgreichem Build den verwalteten Quellbaum exakt ersetzen.
    phase extract
    cd "$INSTALL_DIR"
    if ! release_stage_promoten "$RELEASE_STAGE" "$INSTALL_DIR"; then
        warn "Promotion fehlgeschlagen – stelle den Quellcode aus der Sicherung wieder her."
        source_aus_backup_wiederherstellen "$BACKUP_RESULT" || true
        safe_rm_rf "$RELEASE_STAGE"
        [[ "$TARBALL" != "$LOCAL_TARBALL" ]] && rm -f "$TARBALL"
        return 1
    fi
    # Persistiere exakt die für diesen erfolgreich verifizierten Download
    # verwendete instanzlokale Quelle. Ältere Agent-Installationen konnten sie
    # nur im Installer-Prozess kennen; dann sah die neue App nach dem Recreate
    # weder ihre Updatequelle noch weitere Releases. Kein Produktdefault.
    upsert_env_value "$INSTALL_DIR/.env" "POSTBUCH_FEED_BASE_URL" \
        "$(env_single_quote "${POSTBUCH_FEED_BASE_URL:-}")"
    if ! $QUELLE_GITHUB && [[ -n "${POSTBUCH_FEED_AUTH:-}" ]]; then
        upsert_env_value "$INSTALL_DIR/.env" "POSTBUCH_FEED_AUTH" \
            "$(env_single_quote "$POSTBUCH_FEED_AUTH")"
    fi
    release_persistente_besitzer_wiederherstellen "$INSTALL_DIR" \
        "$(installations_besitzer_bestimmen "$INSTALL_DIR")" || return 1
    safe_rm_rf "$RELEASE_STAGE"
    [[ "$TARBALL" != "$LOCAL_TARBALL" ]] && rm -f "$TARBALL"
    write_restart_script
    write_lokale_installerkopie

    # Ab hier beginnt der Containerwechsel. Kein automatischer Rollback mehr:
    # Ein neuer App-Container kann bereits eine additive Schema-Migration
    # ausgefuehrt haben; ein DB-Restore koennte frische Nutzdaten verlieren.
    phase up
    if [[ -n "$UPD_DUCK" ]]; then
        compose_recreate caddy || return 1
    else
        compose_recreate || return 1
    fi

    # `compose_recreate` meldet nur, dass Container gestartet wurden – nicht,
    # dass die Schema-Migration im Entrypoint durchgelaufen ist. Erst dieser
    # Check erkennt einen Migrations-/Startfehler zuverlässig.
    echo "  Warte, bis die App wieder antwortet..."
    if ! warte_auf_app_gesund; then
        echo "FEHLER: Die App antwortet nach dem Update nicht auf /api/health." >&2
        echo "  Vermutlich ist die Schema-Migration oder der App-Start fehlgeschlagen." >&2
        echo "  Bitte 'docker compose logs app' pruefen. Es erfolgt kein automatischer" >&2
        echo "  Rollback – auf dem Server interaktiv: 'install.sh --rollback'" >&2
        echo "  (fragt vor einem DB-Restore gesondert nach)." >&2
        return 1
    fi

    # Erst nach dem erfolgreichen Containerwechsel den persistenten Agenten
    # aktualisieren. Bei Build-Abbruch bleibt er passend zum Fallback-Quellbaum.
    if ! aktualisiere_vorhandenen_update_agent; then
        echo "FEHLER: Anwendung aktualisiert, aber der Host-Agent nicht. Bitte Update-Dienst reparieren." >&2
        return 1
    fi

    phase fertig
    echo "  Update auf $NEW_VERSION abgeschlossen."
    return 0
}

# ── Argumente auswerten, nicht-interaktive Pfade zuerst ──────────────────────
parse_args "$@"
installer_log_starten

if $OPT_ROLLBACK; then
    INSTALL_DIR="${OPT_INSTALL_DIR:-$DEFAULT_INSTALL_DIR}"
    if $OPT_NON_INTERACTIVE; then
        # do_rollback fragt zweimal ueber /dev/tty nach. Ein automatischer
        # Rollback ohne Rueckfrage waere ein Datenverlust-Automat — es gibt ihn
        # bewusst nicht.
        echo "FEHLER: --rollback ist nur interaktiv moeglich." >&2
        exit 2
    fi
    do_rollback
    exit 0
fi

if $OPT_UPDATE && $OPT_NON_INTERACTIVE; then
    headless_update
    exit $?
fi

# ── Banner ─────────────────────────────────────────────────────────────────────
clear
hr
echo ""
printf "  ${C_BOLD}${C_CYAN}POSTBUCH.NET${C_RESET}\n"
printf "  ${C_DIM}  Gefuehrte Installation fuer deine lokale postbuch.net-Instanz${C_RESET}\n"
hr

# ── SCHRITT 1: Bestehende Installation erkennen + Modus wählen ────────────────
INSTALL_DIR="$DEFAULT_INSTALL_DIR"
MODE="install"

if [[ -f "$INSTALL_DIR/docker-compose.yml" ]]; then
    echo ""
    echo "  Bestehende Installation gefunden: $INSTALL_DIR"
    echo "  (ermittelt über: $INSTALL_DIR_QUELLE)"
    echo ""
    echo "  Was möchtest du tun?"
    echo ""
    echo "    [1]  Update              – neue Version installieren, Konfiguration behalten"
    echo "    [2]  Clean-Neuinstallation – Datenbank löschen und frisch starten"
    echo "    [3]  Deinstallation      – Stack stoppen, alle Daten und Builds entfernen"
    echo "    [4]  Adminpasswort ändern – nur das Admin-Passwort aktualisieren"
    echo "    [5]  Stack steuern       – Start / Restart / Stop, Autostart beim Boot"

    HAS_BACKUPS=false
    VALID_ACTIONS="12345"
    if ls "$INSTALL_DIR/backups"/backup_* &>/dev/null 2>&1; then
        HAS_BACKUPS=true
        echo "    [6]  Update rückgängig machen – auf ein gesichertes Backup zurückrollen"
        VALID_ACTIONS="123456"
    fi

    echo ""
    ACTION=""
    while ! [[ "$ACTION" =~ ^[$VALID_ACTIONS]$ ]]; do
        read -rp "  Auswahl [$VALID_ACTIONS]: " ACTION </dev/tty
    done
    if [[ "$ACTION" == "6" ]]; then
        do_rollback
        exit 0
    elif [[ "$ACTION" == "5" ]]; then
        stack_steuerung_menu
        exit 0
    elif [[ "$ACTION" == "4" ]]; then
        change_admin_password
        exit 0
    elif [[ "$ACTION" == "3" ]]; then
        MODE="uninstall"
    elif [[ "$ACTION" == "2" ]]; then
        MODE="reinstall"
    else
        MODE="update"
    fi
    # Jeder Aufruf gegen eine bestehende Installation aktualisiert die
    # Merkdatei. So finden auch Instanzen ausserhalb von ~/postbuch, die vor
    # Einfuehrung der Merkdatei installiert wurden, ab jetzt von ueberall her.
    [[ "$MODE" != "uninstall" ]] && merkdatei_schreiben "$INSTALL_DIR"
else
    # Pro Rechner ist genau eine Instanz zulaessig. Zeigt --install-dir auf ein
    # leeres Ziel, waehrend anderswo schon eine Installation existiert, wird
    # keine zweite angelegt.
    VORHANDEN=$(merkdatei_lesen)
    if [[ -z "$VORHANDEN" ]] && ist_installation "$LAUFZEIT_HOME/postbuch"; then
        VORHANDEN="$LAUFZEIT_HOME/postbuch"
    fi
    if [[ -n "$VORHANDEN" && "$VORHANDEN" != "$INSTALL_DIR" ]]; then
        error "Auf diesem Rechner ist postbuch.net bereits unter $VORHANDEN installiert. Mehrere Instanzen pro Rechner sind nicht zulässig. Zum Verwalten: $VORHANDEN/install.sh"
    fi
fi

# ── SCHRITT 1b: Instanzname erfassen (nur Erstinstallation) ─────────────────
INSTANCE_NAME=""
if [[ "$MODE" == "install" ]]; then
    INSTANCE_DEFAULT="Postbuch"
    if [[ -f "$INSTALL_DIR/.env" ]]; then
        EXISTING_INSTANCE=$(grep '^INSTANCE_NAME=' "$INSTALL_DIR/.env" | head -n1 | cut -d'=' -f2- || true)
        if [[ -n "$EXISTING_INSTANCE" ]]; then
            INSTANCE_DEFAULT="$EXISTING_INSTANCE"
        fi
    fi

    hr
    echo ""
    echo "  Instanzname"
    echo ""
    echo "  Dieser Name wird in der Web-Oberflaeche angezeigt (z.B. in Login, Sidebar, Exporten)."

    while [[ -z "$INSTANCE_NAME" ]]; do
        INSTANCE_NAME=$(prompt "Gewuenschter Instanzname" "$INSTANCE_DEFAULT")
        INSTANCE_NAME=$(echo "$INSTANCE_NAME" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
        if [[ -z "$INSTANCE_NAME" ]]; then
            warn "Instanzname darf nicht leer sein."
        fi
    done
elif [[ "$MODE" == "update" ]]; then
    # Beim Update den bestehenden Namen unverändert beibehalten.
    INSTANCE_NAME=$(grep '^INSTANCE_NAME=' "$INSTALL_DIR/.env" | head -n1 | cut -d'=' -f2- || true)
fi
# MODE=="reinstall": INSTANCE_NAME bleibt leer; wird in run_setup_dialog gesetzt (env=fresh)
# oder aus der beibehaltenen .env übernommen (env=keep).

# ── SCHRITT 2: Zugang und Erreichbarkeit der Bezugsquelle ────────────────────
# Standard sind die öffentlichen GitHub Releases, ohne Anmeldung. Eine flache
# Quelle kann dagegen hinter HTTP Basic Auth liegen; dann muessen die
# Zugangsdaten VOR allem anderen stehen — schon das Release-Manifest ist ohne
# sie nicht lesbar, und damit weder der Versionsvergleich noch die
# Signaturpruefung.
#
# Die Integritaet des Downloads sichert davon unabhaengig weiterhin die
# sha256-Pruefsumme aus dem signierten Release-Manifest. Basic Auth regelt nur,
# WER laden darf, nicht WAS geladen wird.
if [[ "$MODE" != "uninstall" ]]; then
    hr
    echo ""
    if ! bezugsquelle_sicherstellen "$INSTALL_DIR/.env"; then
        error "Ohne gueltige Bezugsquelle kann kein Release geladen werden."
    fi
    # Bestehende Installationen ziehen die bisher fehlende Variable beim ersten
    # interaktiven Lauf einmalig nach. Danach kennt auch der Headless-Agent sie.
    if [[ -f "$INSTALL_DIR/.env" ]]; then
        upsert_env_value "$INSTALL_DIR/.env" "POSTBUCH_FEED_BASE_URL" \
            "$(env_single_quote "$POSTBUCH_FEED_BASE_URL")"
    fi
    echo "  Prüfe Zugang zu $BASE_URL ..."
    if feed_auth_sicherstellen "$INSTALL_DIR/.env"; then
        # Auf einer bestehenden Installation die .env gleich nachziehen: so
        # fragt der naechste Lauf — und der Update-Agent, der nie eine Konsole
        # hat — nicht erneut.
        if [[ -f "$INSTALL_DIR/.env" ]] && ! $QUELLE_GITHUB; then
            upsert_env_value "$INSTALL_DIR/.env" "POSTBUCH_FEED_AUTH" \
                "$(env_single_quote "$POSTBUCH_FEED_AUTH")"
        fi
    elif [[ -f "$LOCAL_TARBALL" ]]; then
        warn "Kein Zugang zur Bezugsquelle — es wird ausschliesslich das lokale Archiv verwendet."
    elif $QUELLE_GITHUB; then
        error "Die Bezugsquelle ist nicht erreichbar; ohne Manifest kann kein Release geladen werden."
    else
        error "Ohne gueltige Zugangsdaten kann kein Release geladen werden."
    fi

    if [[ ! -f "$LOCAL_TARBALL" ]]; then
        echo "  Prüfe Erreichbarkeit ..."
        release_url_aktualisieren || true
        HTTP_STATUS=$(feed_curl "$RELEASE_URL" -s -o /dev/null -w "%{http_code}" --head 2>/dev/null || echo "000")
        if [[ "$HTTP_STATUS" == "200" ]]; then
            info "Bezugsquelle erreichbar."
        else
            warn "Bezugsquelle antwortet mit HTTP $HTTP_STATUS – der Download wird trotzdem versucht."
        fi
    fi
fi

# ── SCHRITT 3: Voraussetzungen prüfen + ggf. installieren ─────────────────────
hr
echo ""
echo "  Prüfe Voraussetzungen..."
echo ""

# curl
if ! command -v curl &>/dev/null; then
    error "curl ist nicht installiert. Bitte installieren und erneut ausführen."
fi

# Docker
if ! command -v docker &>/dev/null; then
    if [[ "$MODE" == "uninstall" ]]; then
        error "Docker ist nicht installiert – nichts zu deinstallieren."
    fi
    info "Docker nicht gefunden – wird aus dem signierten Paket-Repository des Systems installiert..."
    echo ""
    if command -v apt-get &>/dev/null; then
        sudo apt-get update
        if ! sudo apt-get install -y docker.io docker-compose-plugin; then
            if ! sudo apt-get install -y docker.io docker-compose-v2; then
                sudo apt-get install -y docker.io docker-compose \
                    || error "Docker konnte nicht aus dem System-Repository installiert werden."
            fi
        fi
    elif command -v dnf &>/dev/null; then
        sudo dnf install -y docker docker-compose-plugin \
            || error "Docker konnte nicht aus dem System-Repository installiert werden."
    else
        error "Keine unterstützte Paketverwaltung gefunden. Docker bitte nach der offiziellen Anleitung installieren."
    fi
    sudo systemctl enable --now docker 2>/dev/null || true
fi

# docker compose (Plugin oder standalone)
if ! docker compose version &>/dev/null 2>&1; then
    info "docker compose Plugin nicht gefunden – versuche Installation..."
    if command -v apt-get &>/dev/null; then
        sudo apt-get install -y docker-compose-plugin 2>/dev/null \
            || sudo apt-get install -y docker-compose-v2 2>/dev/null \
            || sudo apt-get install -y docker-compose 2>/dev/null \
            || true
    fi
    if ! docker compose version &>/dev/null 2>&1; then
        error "docker compose konnte nicht installiert werden.\nBitte manuell installieren: https://docs.docker.com/compose/install/"
    fi
fi

# Docker-Daemon erreichbar?
DOCKER_COMPOSE="docker compose"
if ! docker info &>/dev/null 2>&1; then
    if ! sudo docker info &>/dev/null 2>&1; then
        error "Kein Zugriff auf den Docker-Daemon (auch nicht mit sudo).\nBitte stelle sicher, dass Docker läuft."
    fi
    DOCKER_COMPOSE="sudo docker compose"
    if getent group docker &>/dev/null; then
        sudo usermod -aG docker "$USER" 2>/dev/null || true
    fi
fi

success "Alle Voraussetzungen erfüllt."

# ── Safe-Mode bei wenig RAM anbieten (alle Build-Pfade, nicht bei Uninstall) ──
if [[ "$MODE" != "uninstall" ]]; then
    detect_and_offer_safe_mode
fi

# ══════════════════════════════════════════════════════════════════════════════
# DEINSTALLATION
# ══════════════════════════════════════════════════════════════════════════════
if [[ "$MODE" == "uninstall" ]]; then
    hr
    echo ""
    echo "  DEINSTALLATION"
    echo ""
    echo "  Folgendes wird unwiderruflich gelöscht:"
    echo "    • Alle laufenden Container (postgres, app, web, scanner, cleaner, caddy)"
    echo "    • Alle Docker-Images der Builds"
    echo "    • Alle Volumes (inkl. Datenbank)"
    echo "    • Das gesamte Verzeichnis: $INSTALL_DIR"
    echo ""
    warn "Diese Aktion kann nicht rückgängig gemacht werden!"
    echo ""
    read -rp "  Zur Bestätigung 'LOESCHEN' eingeben: " CONFIRM </dev/tty
    if [[ "$CONFIRM" != "LOESCHEN" ]]; then
        echo ""
        echo "  Abgebrochen."
        echo ""
        exit 0
    fi
    echo ""
    INSTALL_DIR_ABS=$(cd "$INSTALL_DIR" && pwd)
    info "Stoppe und entferne Docker-Stack..."
    cd "$INSTALL_DIR"
    $DOCKER_COMPOSE down --rmi all --volumes --remove-orphans 2>/dev/null || true
    cd "$LAUFZEIT_HOME"
    info "Entferne Update-Dienst (falls eingerichtet)..."
    remove_update_agent
    info "Entferne Installationsverzeichnis..."

    # Versuch: normales Entfernen
    if rm -rf "$INSTALL_DIR" 2>/dev/null; then
        success "Installationsverzeichnis entfernt."
    else
        warn "Keine ausreichenden Rechte, um $INSTALL_DIR direkt zu entfernen."
        if [[ $(id -u) -eq 0 ]]; then
            error "Konnte $INSTALL_DIR nicht löschen (auch als root). Bitte manuell prüfen und entfernen: rm -rf \"$INSTALL_DIR\""
        fi
        if command -v sudo &>/dev/null; then
            warn "Versuche Entfernung mit sudo..."
            if sudo rm -rf "$INSTALL_DIR"; then
                success "Installationsverzeichnis mit sudo entfernt."
            else
                error "Konnte $INSTALL_DIR nicht entfernen, auch nicht mit sudo. Bitte manuell löschen: sudo rm -rf \"$INSTALL_DIR\""
            fi
        else
            error "Kein Schreibzugriff auf $INSTALL_DIR und 'sudo' ist nicht installiert. Lösche manuell: rm -rf \"$INSTALL_DIR\""
        fi
    fi
    merkdatei_entfernen "$INSTALL_DIR_ABS"
    hr
    echo ""
    echo "  ✓ postbuch.net wurde vollständig entfernt."
    echo ""
    hr
    echo ""
    exit 0
fi

# ══════════════════════════════════════════════════════════════════════════════
# UPDATE
# ══════════════════════════════════════════════════════════════════════════════
if [[ "$MODE" == "update" ]]; then
    # Ganz am Anfang und unbedingt: der Hinweis gilt jedem interaktiven
    # Update-Lauf, auch wenn Download/Signatur scheitern, die Version bereits
    # installiert ist oder der Nutzer die Neuinstallation gleich verneint.
    backup_feature_status_pruefen

    hr
    echo ""
    info "Lade neue Version herunter..."

    # Manifest + Signatur zuerst. Ein Release, dem nicht zu trauen ist, soll
    # gar nicht erst auf der Platte landen.
    manifest_gate || exit 1

    if [[ -f "$LOCAL_TARBALL" ]]; then
        TARBALL="$LOCAL_TARBALL"
        info "Lokales Archiv gefunden – Download übersprungen."
    else
        release_url_aktualisieren || return 1
        TARBALL="/tmp/postbuch-latest.tar.gz"
        release_download "$TARBALL"
    fi

    # ── Pruefsumme gegen das Release-Manifest ──────────────────────────────────
    # VOR jeder Aenderung am Installationsverzeichnis. Schlaegt sie fehl, bricht
    # der Lauf ab, ohne dass irgendetwas angefasst wurde.
    tarball_pruefen_oder_abbrechen "$TARBALL"

    # ── Versionsvergleich ──────────────────────────────────────────────────────
    CURRENT_VERSION="(unbekannt)"
    if [[ -f "$INSTALL_DIR/VERSION" ]]; then
        CURRENT_VERSION=$(cat "$INSTALL_DIR/VERSION" | tr -d '[:space:]')
    fi

    release_stage_erstellen "$TARBALL" || exit 1
    NEW_VERSION=$(tr -d '[:space:]' < "$RELEASE_STAGE/VERSION")

    hr
    echo ""
    printf "  ${C_BOLD}Update-Vorschau${C_RESET}\n"
    echo ""

    if [[ "$CURRENT_VERSION" == "(unbekannt)" || "$NEW_VERSION" == "(unbekannt)" ]]; then
        printf "  Installiert:  ${C_DIM}%s${C_RESET}\n" "$CURRENT_VERSION"
        printf "  Neu:          ${C_DIM}%s${C_RESET}\n" "$NEW_VERSION"
        echo ""
        warn "Versionsinfo nicht vollständig lesbar – bitte Tarball prüfen."
    else
        LOWER=$(printf '%s\n%s' "$CURRENT_VERSION" "$NEW_VERSION" | sort -V | head -n1)
        if [[ "$CURRENT_VERSION" == "$NEW_VERSION" ]]; then
            printf "  Installiert:  ${C_AMBER}%s${C_RESET}\n" "$CURRENT_VERSION"
            printf "  Neu:          ${C_AMBER}%s${C_RESET}\n" "$NEW_VERSION"
            echo ""
            warn "Gleiche Version! Du installierst ${C_BOLD}$NEW_VERSION${C_RESET} über die bereits laufende ${C_BOLD}$CURRENT_VERSION${C_RESET}."
        elif [[ "$LOWER" == "$NEW_VERSION" ]]; then
            printf "  Installiert:  ${C_GREEN}%s${C_RESET}\n" "$CURRENT_VERSION"
            printf "  Neu:          ${C_RED}%s${C_RESET}  ${C_DIM}(Downgrade!)${C_RESET}\n" "$NEW_VERSION"
            echo ""
            warn "Downgrade! Du gehst von ${C_BOLD}$CURRENT_VERSION${C_RESET} auf ${C_BOLD}$NEW_VERSION${C_RESET} zurück."
        else
            printf "  Installiert:  ${C_DIM}%s${C_RESET}\n" "$CURRENT_VERSION"
            printf "  Neu:          ${C_GREEN}${C_BOLD}%s${C_RESET}\n" "$NEW_VERSION"
        fi
    fi

    echo ""
    UPDATE_CONFIRM=""
    while [[ "$UPDATE_CONFIRM" != "j" && "$UPDATE_CONFIRM" != "J" && "$UPDATE_CONFIRM" != "n" && "$UPDATE_CONFIRM" != "N" ]]; do
        read -rp "  Fortfahren mit Update? [j/n]: " UPDATE_CONFIRM </dev/tty
    done
    if [[ "$UPDATE_CONFIRM" == "n" || "$UPDATE_CONFIRM" == "N" ]]; then
        echo ""
        echo "  Abgebrochen."
        [[ "$TARBALL" != "$LOCAL_TARBALL" ]] && rm -f "$TARBALL"
        echo ""
        exit 0
    fi

    # Neue Host-Rechte ausschließlich früh und sichtbar einrichten. So kann
    # nach einem langen Build kein überraschender sudo-Prompt mehr erscheinen.
    frage_agent_an

    # Ist ein Update-Agent eingerichtet, braucht dessen Refresh nach dem Build
    # promptfreien Sudo (sudo -n). Jetzt, vor dem Build, einmalig auf Vorrat
    # authentifizieren und den Timestamp waehrend des Builds wach halten.
    [[ -f "$AGENT_CONF" ]] && sudo_keepalive_starten

    # ── Vor-Update-Backup ─────────────────────────────────────────────────────
    hr
    echo ""
    info "Erstelle Sicherung der aktuell laufenden Installation..."
    backup_altbestand_besitz_sicherstellen || {
        warn "Update abgebrochen, bis die angezeigte Eigentümer-Reparatur ausgeführt wurde."
        return 1
    }
    BACKUP_RESULT=$(backup_current_installation) || true
    if [[ -n "$BACKUP_RESULT" && -d "$BACKUP_RESULT" ]]; then
        success "Backup erstellt: $BACKUP_RESULT"
    else
        warn "Backup konnte nicht vollständig erstellt werden."
        echo ""
        CONTINUE_WITHOUT_BACKUP=""
        while [[ "$CONTINUE_WITHOUT_BACKUP" != "j" && \
                 "$CONTINUE_WITHOUT_BACKUP" != "J" && \
                 "$CONTINUE_WITHOUT_BACKUP" != "n" && \
                 "$CONTINUE_WITHOUT_BACKUP" != "N" ]]; do
            read -rp "  Trotzdem fortfahren? [j/n]: " CONTINUE_WITHOUT_BACKUP </dev/tty
        done
        if [[ "$CONTINUE_WITHOUT_BACKUP" == "n" || \
              "$CONTINUE_WITHOUT_BACKUP" == "N" ]]; then
            echo ""
            echo "  Abgebrochen."
            [[ "$TARBALL" != "$LOCAL_TARBALL" ]] && rm -f "$TARBALL"
            echo ""
            exit 0
        fi
    fi

    # Wie beim Agentenupdate zuerst vollständig aus dem isolierten Stage bauen.
    # Ein Paketquellen-/Compilerfehler lässt so Quellbaum und laufende Container
    # der alten Version unangetastet.
    UPDATE_DUCKDNS_TOKEN=$(grep '^DUCKDNS_API_TOKEN=' "$INSTALL_DIR/.env" | cut -d'=' -f2- || true)
    cp "$INSTALL_DIR/.env" "$RELEASE_STAGE/.env" || error "Konnte Konfiguration nicht in den Build-Stage kopieren."
    chmod 600 "$RELEASE_STAGE/.env"
    cd "$RELEASE_STAGE"
    export COMPOSE_PROJECT_NAME="$(basename "$INSTALL_DIR")"
    update_build_services_bestimmen "$INSTALL_DIR" "$RELEASE_STAGE"
    if [[ -n "$UPDATE_DUCKDNS_TOKEN" ]]; then
        if ! compose_build caddy "${UPDATE_BUILD_SERVICES[@]}"; then
            safe_rm_rf "$RELEASE_STAGE"
            [[ "$TARBALL" != "$LOCAL_TARBALL" ]] && rm -f "$TARBALL"
            error "Build fehlgeschlagen. Alter Quellbaum und laufender Stack bleiben unverändert."
        fi
    elif ! compose_build "${UPDATE_BUILD_SERVICES[@]}"; then
        safe_rm_rf "$RELEASE_STAGE"
        [[ "$TARBALL" != "$LOCAL_TARBALL" ]] && rm -f "$TARBALL"
        error "Build fehlgeschlagen. Alter Quellbaum und laufender Stack bleiben unverändert."
    fi
    cd "$INSTALL_DIR"

    if ! release_stage_promoten "$RELEASE_STAGE" "$INSTALL_DIR"; then
        warn "Promotion fehlgeschlagen – stelle den Quellcode aus der Sicherung wieder her."
        source_aus_backup_wiederherstellen "$BACKUP_RESULT" || true
        safe_rm_rf "$RELEASE_STAGE"
        [[ "$TARBALL" != "$LOCAL_TARBALL" ]] && rm -f "$TARBALL"
        error "Gestagte Promotion des Updates fehlgeschlagen."
    fi
    safe_rm_rf "$RELEASE_STAGE"
    [[ "$TARBALL" != "$LOCAL_TARBALL" ]] && rm -f "$TARBALL"
    success "Update validiert und gestagt eingespielt; Laufzeitdaten wurden erhalten."

    # ── Caddyfile regenerieren (aus wiederhergestellter .env) ─────────────────
    mkdir -p "$INSTALL_DIR/caddy"
    if [[ -n "$UPDATE_DUCKDNS_TOKEN" ]]; then
        cat > "$INSTALL_DIR/caddy/Caddyfile" <<'CADDYEOF'
{env.DUCKDNS_DOMAIN} {
    tls {
        dns duckdns {env.DUCKDNS_API_TOKEN}
        resolvers 8.8.8.8 1.1.1.1
    }
    reverse_proxy web:80
}
CADDYEOF
        success "Caddyfile mit DuckDNS-TLS geschrieben."
    else
        cat > "$INSTALL_DIR/caddy/Caddyfile" <<'CADDYEOF'
# Kein DuckDNS konfiguriert – kein TLS-Endpunkt aktiv.
CADDYEOF
        success "Caddyfile (ohne TLS) geschrieben."
    fi
    chmod 600 "$INSTALL_DIR/caddy/Caddyfile"
    release_persistente_besitzer_wiederherstellen "$INSTALL_DIR" \
        "$(installations_besitzer_bestimmen "$INSTALL_DIR")" \
        || error "Besitzrechte der Konfiguration konnten nicht gesetzt werden."

    # restart.sh und lokale Installer-Kopie aktualisieren
    write_restart_script
    write_lokale_installerkopie

    hr
    echo ""
    info "Starte aktualisierten Stack..."
    echo ""
    cd "$INSTALL_DIR"
    if [[ -n "$UPDATE_DUCKDNS_TOKEN" ]]; then
        compose_recreate caddy
    else
        compose_recreate
    fi

    info "Warte, bis die App wieder antwortet..."
    if ! warte_auf_app_gesund; then
        echo "  Pruefe: docker compose logs app" >&2
        echo "  Bei Bedarf: ./install.sh --rollback (fragt vor einem DB-Restore gesondert nach)" >&2
        error "Die App antwortet nach dem Update nicht auf /api/health – vermutlich ist die Schema-Migration oder der App-Start fehlgeschlagen."
    fi

    # Ein vorhandener Agent wird mit jeder erfolgreichen interaktiven
    # Aktualisierung mitgezogen. Der Dialog darunter richtet nur neue Agenten
    # ein; er darf einen bestehenden nicht mehr als unveränderlich behandeln.
    aktualisiere_vorhandenen_update_agent \
        || warn "Anwendung aktualisiert, Host-Agent aber nicht. Bitte den Update-Dienst reparieren."

    LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "")
    hr
    echo ""
    echo "  ✓ postbuch.net wurde erfolgreich aktualisiert!"
    echo ""
    echo "  Zugriff von diesem Gerät:   http://localhost:3420"
    if [[ -n "$LAN_IP" ]]; then
        echo "  Zugriff im Heimnetz:        http://$LAN_IP:3420"
    fi
    CONFIGURED_URL=$(grep '^APP_BASE_URL=' "$INSTALL_DIR/.env" | cut -d'=' -f2- || true)
    if [[ "$CONFIGURED_URL" == https://* ]]; then
        echo "  Deine Domain:               $CONFIGURED_URL"
    fi
    echo ""
    echo "  Verwaltung:  $INSTALL_DIR/install.sh"
    echo "  Update, Rollback, Deinstallation, Adminpasswort, Stack-Steuerung."
    echo "  Alles ausser dem Update laeuft ohne Internetzugang."
    echo ""
    hr
    echo ""
    exit 0
fi

# ══════════════════════════════════════════════════════════════════════════════
# CLEAN-NEUINSTALLATION
# ══════════════════════════════════════════════════════════════════════════════
if [[ "$MODE" == "reinstall" ]]; then
    hr
    echo ""
    echo "  CLEAN-NEUINSTALLATION"
    echo ""
    echo "  Folgendes wird unwiderruflich gelöscht:"
    echo "    • Datenbank (data/postgres) – alle postbuch.net-Einträge und Einstellungen"
    echo "    • Scan-Puffer (data/scan_buffer) – offene Scan-Aufträge"
    echo "    • Alle laufenden Docker-Container des Stacks"
    echo ""
    warn "Diese Aktion kann nicht rückgängig gemacht werden!"
    echo ""
    read -rp "  Zur Bestätigung 'NEUSTART' eingeben: " CONFIRM </dev/tty
    if [[ "$CONFIRM" != "NEUSTART" ]]; then
        echo ""
        echo "  Abgebrochen."
        echo ""
        exit 0
    fi

    # ── Aktuellen Quellcode laden + entpacken ─────────────────────────────────
    # Ohne diesen Schritt würde Docker aus dem alten Code auf der Platte bauen.
    hr
    echo ""
    info "Lade aktuellen postbuch.net-Stand herunter..."
    manifest_gate || exit 1
    if [[ -f "$LOCAL_TARBALL" ]]; then
        TARBALL="$LOCAL_TARBALL"
        info "Lokales Archiv gefunden – Download übersprungen."
    else
        release_url_aktualisieren || return 1
        TARBALL="/tmp/postbuch-latest.tar.gz"
        release_download "$TARBALL"
    fi

    # ── Pruefsumme gegen das Release-Manifest ──────────────────────────────────
    # VOR jeder Aenderung am Installationsverzeichnis. Schlaegt sie fehl, bricht
    # der Lauf ab, ohne dass irgendetwas angefasst wurde.
    tarball_pruefen_oder_abbrechen "$TARBALL"
    info "Validiere und stage aktuellen Quellcode (.env und data/ bleiben erhalten)..."
    release_stage_erstellen "$TARBALL" || exit 1
    release_stage_promoten "$RELEASE_STAGE" "$INSTALL_DIR" \
        || error "Gestagte Promotion des Quellcodes fehlgeschlagen."
    write_lokale_installerkopie
    safe_rm_rf "$RELEASE_STAGE"
    [[ "$TARBALL" != "$LOCAL_TARBALL" ]] && rm -f "$TARBALL"
    success "Quellcode aktualisiert."

    hr
    echo ""
    echo "  Was soll mit der bestehenden Konfiguration (.env) passieren?"
    echo ""
    echo "    [1]  Behalten          – API-Keys und Zugangsdaten aus .env übernehmen"
    echo "    [2]  Neu konfigurieren – .env verwerfen und alle Werte neu eingeben"
    echo ""
    ENV_CHOICE=""
    while [[ "$ENV_CHOICE" != "1" && "$ENV_CHOICE" != "2" ]]; do
        read -rp "  Auswahl [1/2]: " ENV_CHOICE </dev/tty
    done

    RESTORE_BACKUP="false"

    if [[ "$ENV_CHOICE" == "1" ]]; then
        # ── .env behalten ──────────────────────────────────────────────────────
        RESTORE_BACKUP=$(ask_restore_backup)

        # Gequotet schreiben wie im Erstinstallations-Pfad, sonst haette dieselbe
        # .env zwei verschiedene Konventionen fuer denselben Schluessel.
        if [[ "$RESTORE_BACKUP" == "true" ]]; then
            info "Das bestehende Admin-Passwort bleibt aktiv und autorisiert den Setup-Restore."
        else
            echo ""
            info "Admin-Passwort: Enter zum Behalten des bestehenden."
            NEW_PW=$(prompt_secret "Neues Admin-Passwort (optional)")
            while [[ -n "$NEW_PW" && "$NEW_PW" == *"'"* ]]; do
                warn "Das Passwort darf kein einfaches Anfuehrungszeichen ( ' ) enthalten – Docker kann es in der Konfigurationsdatei nicht zuverlaessig lesen."
                NEW_PW=$(prompt_secret "Neues Admin-Passwort (optional)")
            done
            if [[ -n "$NEW_PW" ]]; then
                upsert_env_value "$INSTALL_DIR/.env" "APP_PASSWORD" "$(env_single_quote "$NEW_PW")"
                success "Admin-Passwort aktualisiert."
            fi
        fi

        info "Stoppe Docker-Stack..."
        cd "$INSTALL_DIR"
        $DOCKER_COMPOSE down

        info "Lösche Datenbank und Scan-Puffer..."
        safe_rm_rf "$INSTALL_DIR/data/postgres"  || error "Konnte data/postgres nicht löschen. Bitte manuell: sudo rm -rf \"$INSTALL_DIR/data/postgres\""
        safe_rm_rf "$INSTALL_DIR/data/scan_buffer" || error "Konnte data/scan_buffer nicht löschen. Bitte manuell: sudo rm -rf \"$INSTALL_DIR/data/scan_buffer\""

        if [[ "$RESTORE_BACKUP" == "true" ]]; then
            mkdir -p "$INSTALL_DIR/data/scan_buffer"
            touch "$INSTALL_DIR/data/scan_buffer/.setup_restore_pending"
            success "Setup-Restore-Modus aktiviert."
        else
            mkdir -p "$INSTALL_DIR/data/scan_buffer"
            touch "$INSTALL_DIR/data/scan_buffer/.einrichtung_pending"
            success "Web-Einrichtungsassistent vorgemerkt."
        fi

        REINSTALL_DUCKDNS=$(grep '^DUCKDNS_API_TOKEN=' "$INSTALL_DIR/.env" | cut -d'=' -f2- || true)
        info "Starte Stack neu..."
        if [[ -n "$REINSTALL_DUCKDNS" ]]; then
            compose_up_build_all caddy
        else
            compose_up_build_all
        fi

    else
        # ── .env verwerfen + neu konfigurieren ────────────────────────────────
        info "Stoppe Docker-Stack..."
        cd "$INSTALL_DIR"
        $DOCKER_COMPOSE down

        info "Lösche Daten und Konfiguration..."
        safe_rm_rf "$INSTALL_DIR/data/postgres"  || error "Konnte data/postgres nicht löschen. Bitte manuell: sudo rm -rf \"$INSTALL_DIR/data/postgres\""
        safe_rm_rf "$INSTALL_DIR/data/scan_buffer" || error "Konnte data/scan_buffer nicht löschen. Bitte manuell: sudo rm -rf \"$INSTALL_DIR/data/scan_buffer\""
        rm -f "$INSTALL_DIR/.env"

        hr
        echo ""
        echo "  SETUP – Neue Konfiguration"
        echo ""
        info "Alle Werte werden neu eingegeben."

        INSTANCE_NAME=""
        run_setup_dialog

        if [[ "$RESTORE_BACKUP" == "true" ]]; then
            mkdir -p "$INSTALL_DIR/data/scan_buffer"
            touch "$INSTALL_DIR/data/scan_buffer/.setup_restore_pending"
            success "Setup-Restore-Modus aktiviert."
        else
            mkdir -p "$INSTALL_DIR/data/scan_buffer"
            touch "$INSTALL_DIR/data/scan_buffer/.einrichtung_pending"
            success "Web-Einrichtungsassistent vorgemerkt."
        fi

        info "Starte Stack..."
        if [[ -n "${DUCKDNS_API_TOKEN:-}" ]]; then
            compose_up_build_all caddy
        else
            compose_up_build_all
        fi
    fi

    LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "")
    hr
    echo ""
    echo "  ✓ Clean-Neuinstallation abgeschlossen!"
    echo ""
    # Die konfigurierte Domain kommt aus der .env, damit beide Zweige oben
    # abgedeckt sind: die behaltene .env genauso wie die neu geschriebene.
    CONFIGURED_URL=$(grep '^APP_BASE_URL=' "$INSTALL_DIR/.env" | cut -d'=' -f2- || true)
    if [[ "$CONFIGURED_URL" == https://* ]]; then
        echo "  Deine Domain:               $CONFIGURED_URL"
    fi
    echo "  Zugriff von diesem Gerät:   http://localhost:3420"
    if [[ -n "$LAN_IP" ]]; then
        echo "  Zugriff im Heimnetz:        http://$LAN_IP:3420"
    fi

    echo ""
    echo "  Verwaltung:  $INSTALL_DIR/install.sh"
    echo "  Update, Rollback, Deinstallation, Adminpasswort, Stack-Steuerung."
    echo "  Alles ausser dem Update laeuft ohne Internetzugang."

    if [[ "$RESTORE_BACKUP" == "true" ]]; then
        wait_and_show_restore_url "$LAN_IP" "$CONFIGURED_URL"
    fi

    hr
    echo ""
    exit 0
fi

# ══════════════════════════════════════════════════════════════════════════════
# ERSTINSTALLATION
# ══════════════════════════════════════════════════════════════════════════════
hr
echo ""
INSTALL_DIR=$(prompt "Installationsverzeichnis" "$DEFAULT_INSTALL_DIR")
if [[ "$INSTALL_DIR" != /* ]]; then
    INSTALL_DIR="$PWD/$INSTALL_DIR"
fi

echo ""
info "Lade postbuch.net herunter..."

# Die eingebetteten Schluessel sind bereits der Vertrauensanker; der lokale Pin
# protokolliert danach nur die hoechste akzeptierte Version.
manifest_gate || exit 1

if [[ -f "$LOCAL_TARBALL" ]]; then
    TARBALL="$LOCAL_TARBALL"
    info "Lokales Archiv gefunden – Download übersprungen."
else
    release_url_aktualisieren || exit 1
    TARBALL="/tmp/postbuch-latest.tar.gz"
    release_download "$TARBALL"
fi

# Pruefsumme gegen das Release-Manifest, bevor entpackt wird.
tarball_pruefen_oder_abbrechen "$TARBALL"
release_stage_erstellen "$TARBALL" || exit 1

INSTALL_BESITZER=$(installations_besitzer_bestimmen "$INSTALL_DIR") || exit 1
mkdir -p "$INSTALL_DIR"
INSTALL_MODUS=$(stat -c '%a' "$INSTALL_DIR") || exit 1

# `manifest_gate` laeuft absichtlich vor `mkdir -p`: bei einem ungueltigen
# Manifest soll eine Erstinstallation noch kein Verzeichnis hinterlassen. Fuer
# ein gueltig signiertes Manifest war der Vertrauensanker bis hierher deshalb
# noch nicht schreibbar. Jetzt wird er nachgeholt, noch bevor irgendwelche
# Release-Dateien entpackt werden.
if [[ "$SIG_ERGEBNIS" == "gueltig" ]] && ! vertrauen_lesen; then
    if vertrauen_schreiben "$SIG_PIN_SCHLUESSEL" "$SIG_PIN_HOECHSTE_VERSION"; then
        echo "  Vertrauensanker gesetzt: ab jetzt werden nur noch gueltig signierte Releases installiert."
    else
        echo "  WARNUNG: Vertrauensanker konnte nicht geschrieben werden ($(vertrauen_datei))."
    fi
fi

cp -a "$RELEASE_STAGE/." "$INSTALL_DIR/" \
    || error "Gestagte Erstinstallation konnte nicht promotet werden."
release_stage_besitzer_wiederherstellen "$RELEASE_STAGE" "$INSTALL_DIR" \
    "$INSTALL_BESITZER" "$INSTALL_MODUS" \
    || error "Besitzrechte der Erstinstallation konnten nicht gesetzt werden."
write_lokale_installerkopie
safe_rm_rf "$RELEASE_STAGE"
[[ "$TARBALL" != "$LOCAL_TARBALL" ]] && rm -f "$TARBALL"

# ── Geführtes Setup ───────────────────────────────────────────────────────────
hr
echo ""
echo "  SETUP – Konfiguration"
echo ""
info "Einige Werte werden automatisch generiert, andere musst du eingeben."

RESTORE_BACKUP="false"
run_setup_dialog
release_persistente_besitzer_wiederherstellen "$INSTALL_DIR" "$INSTALL_BESITZER" \
    || error "Besitzrechte der Konfiguration konnten nicht gesetzt werden."

# ── Flag-Datei für Setup-Restore (vor Stack-Start) ───────────────────────────
if [[ "$RESTORE_BACKUP" == "true" ]]; then
    mkdir -p "$INSTALL_DIR/data/scan_buffer"
    touch "$INSTALL_DIR/data/scan_buffer/.setup_restore_pending"
    success "Setup-Restore-Modus aktiviert."
else
    mkdir -p "$INSTALL_DIR/data/scan_buffer"
    touch "$INSTALL_DIR/data/scan_buffer/.einrichtung_pending"
    success "Web-Einrichtungsassistent für den ersten Admin-Login vorgemerkt."
fi

# ── Stack starten ─────────────────────────────────────────────────────────────
hr
echo ""
info "Starte postbuch.net..."
echo ""

# Der Systemdienst wird vor dem teuren Build eingerichtet. Dadurch kommt eine
# nötige sudo-Abfrage früh und mit Erklärung – niemals überraschend am Ende.
frage_agent_an

cd "$INSTALL_DIR"
if [[ -n "${DUCKDNS_API_TOKEN:-}" ]]; then
    compose_up_build_all caddy
else
    compose_up_build_all
fi

# ── Erfolg + nächste Schritte ─────────────────────────────────────────────────
LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "")

hr
echo ""
echo "  ✓ postbuch.net wurde erfolgreich installiert!"
merkdatei_schreiben "$INSTALL_DIR"
echo ""
echo "  Verwaltung:  $INSTALL_DIR/install.sh"
echo "  Update, Rollback, Deinstallation, Adminpasswort, Stack-Steuerung."
echo "  Alles ausser dem Update laeuft ohne Internetzugang."

CONFIGURED_URL=$(grep '^APP_BASE_URL=' "$INSTALL_DIR/.env" | cut -d'=' -f2- || true)

# Die Zugriffsadressen stehen bewusst als letzter Block direkt über den
# nächsten Schritten, damit sie ohne Hochscrollen im Terminal sichtbar sind.
zeige_zugriffsadressen() {
    echo ""
    if [[ "$CONFIGURED_URL" == https://* ]]; then
        echo "  Deine Domain:               $CONFIGURED_URL"
    fi
    echo "  Zugriff von diesem Gerät:   http://localhost:3420"
    if [[ -n "$LAN_IP" ]]; then
        echo "  Zugriff im Heimnetz:        http://$LAN_IP:3420"
    fi
    if [[ -n "${DUCKDNS_API_TOKEN:-}" ]]; then
        echo ""
        echo "  ⚠ Falls $CONFIGURED_URL im Heimnetz nicht erreichbar ist, obwohl die"
        echo "    IP-Adresse oben funktioniert: Das ist meist DNS-Rebind-Schutz im Router."
        echo "    Domain dort als Ausnahme eintragen (Fritz!Box: http://fritz.box →"
        echo "    Netzwerk → Netzwerkeinstellungen → DNS-Rebind-Schutz). Push-Benachrichtigungen"
        echo "    brauchen zwingend die Domain mit https:// – ueber die reine IP funktionieren sie nicht."
    fi
}

if [[ "$RESTORE_BACKUP" == "true" ]]; then
    zeige_zugriffsadressen
    echo ""
    wait_and_show_restore_url "$LAN_IP" "$CONFIGURED_URL"
else
    echo ""
    echo "  Benutzername / Passwort: admin / [dein oben vergebenes Admin-Passwort]"
    echo ""
    echo "  Alles Weitere richtet der Assistent beim ersten Aufruf ein:"
    echo "  Ablage, OneDrive/Nextcloud, KI und Embedding, Scanner, Push und Backup."
    echo ""
    echo "  Login:  admin / [dein Admin-Passwort]"
    zeige_zugriffsadressen
    echo ""
    echo "  Nächste Schritte:"
    echo "  1. Web-UI öffnen und als admin anmelden."
    echo "  2. Der Einrichtungsassistent führt ohne Medienbruch durch alle Fachschritte."
    echo "  3. Bei Problemen oder nach .env-Änderungen:"
    echo "     $INSTALL_DIR/restart.sh"
fi

hr
echo ""
