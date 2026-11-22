#!/usr/bin/env bash
# Gemeinsame, strikt whitelistete Host-Konfiguration für Installer und P2-Agent.
# Kein eval/source, keine freie Shell und keine Ausgabe von Werten.

hostconfig_docker() {
    if [[ "${DOCKER_ART:-direkt}" == "sudo" ]]; then sudo -n docker "$@"; else docker "$@"; fi
}
hostconfig_compose() {
    if [[ "${DOCKER_ART:-direkt}" == "sudo" ]]; then sudo -n docker compose "$@"; else docker compose "$@"; fi
}

# Wie hostconfig_compose, aber mit Zeitlimit: Ein hängender Download beim
# Build darf den Agenten nicht dauerhaft blockieren.
hostconfig_compose_befristet() { # $1 Sekunden, Rest wie hostconfig_compose
    local sekunden="$1"; shift
    if [[ "${DOCKER_ART:-direkt}" == "sudo" ]]; then
        timeout "$sekunden" sudo -n docker compose "$@"
    else
        timeout "$sekunden" docker compose "$@"
    fi
}

hostconfig_env_setzen() { # $1 Datei, $2 Key, $3 Wert
    local datei="$1" key="$2" wert="$3" tmp backup gefunden=false
    case "$key" in
        COMPOSE_PROFILES|COMPOSE_FILE|WEB_PORT|APP_BASE_URL|DUCKDNS_DOMAIN|DUCKDNS_API_TOKEN|SCANNER_BIND|WEB_BIND) ;;
        POSTBUCH_ABLAGE_DIR|POSTBUCH_ABLAGE_ANZEIGE) ;;
        *) return 2 ;;
    esac
    [[ -f "$datei" && ! -L "$datei" ]] || return 2
    backup="${datei}.hostconfig.bak"
    if [[ ! -f "$backup" ]]; then
        cp -p -- "$datei" "$backup" || return 1
        chmod 600 "$backup" 2>/dev/null || true
    fi
    tmp=$(mktemp "${datei}.tmp.XXXXXX") || return 1
    chmod 600 "$tmp" || { rm -f -- "$tmp"; return 1; }
    while IFS= read -r zeile || [[ -n "$zeile" ]]; do
        if [[ "$zeile" == "$key="* ]]; then
            printf '%s=%s\n' "$key" "$wert" >> "$tmp" || return 1
            gefunden=true
        else
            printf '%s\n' "$zeile" >> "$tmp" || return 1
        fi
    done < "$datei"
    $gefunden || printf '%s=%s\n' "$key" "$wert" >> "$tmp"
    mv -fT -- "$tmp" "$datei"
}

hostconfig_rollback() { # $1 env
    local datei="$1" backup="${1}.hostconfig.bak"
    [[ -f "$backup" ]] || return 1
    cp -p -- "$backup" "$datei"
}

hostconfig_caddy_sichern() { # $1 Caddyfile
    local datei="$1" backup="${1}.hostconfig.bak"
    [[ -f "$datei" && ! -L "$datei" ]] || return 2
    cp -p -- "$datei" "$backup" || return 1
    chmod 600 "$backup" 2>/dev/null || true
}

hostconfig_caddy_schreiben() { # $1 Caddyfile, $2 an|aus
    local datei="$1" modus="$2" tmp
    [[ -f "$datei" && ! -L "$datei" ]] || return 2
    tmp=$(mktemp "${datei}.tmp.XXXXXX") || return 1
    chmod 600 "$tmp" || { rm -f -- "$tmp"; return 1; }
    if [[ "$modus" == an ]]; then
        printf '%s\n' \
          '{' \
          '    http_port {$CADDY_HTTP_PORT:80}' \
          '    https_port {$CADDY_HTTPS_PORT:443}' \
          '}' \
          '{env.DUCKDNS_DOMAIN} {' \
          '    tls {' \
          '        dns duckdns {env.DUCKDNS_API_TOKEN}' \
          '        resolvers 8.8.8.8 1.1.1.1' \
          '    }' \
          '    reverse_proxy web:80' \
          '}' \
          'http://{env.DUCKDNS_DOMAIN} {' \
          '    redir https://{host}:{$CADDY_HTTPS_PORT:443}{uri} 308' \
          '}' > "$tmp" || { rm -f -- "$tmp"; return 1; }
    else
        printf '%s\n' \
          '# Kein DuckDNS konfiguriert – kein TLS-Endpunkt aktiv.' \
          '# Postbuch ist über den lokalen WEB_PORT erreichbar.' > "$tmp" \
          || { rm -f -- "$tmp"; return 1; }
    fi
    mv -fT -- "$tmp" "$datei"
}

hostconfig_caddy_rollback() { # $1 Caddyfile
    local datei="$1" backup="${1}.hostconfig.bak"
    [[ -f "$backup" ]] || return 1
    cp -p -- "$backup" "$datei"
}

hostconfig_app_host_db_setzen() { # $1 env $2 validierte URL
    local env="$1" wert="$2" db_user db_name
    db_user=$(grep '^POSTGRES_USER=' "$env" 2>/dev/null | tail -n1 | cut -d= -f2- || true)
    db_name=$(grep '^POSTGRES_DB=' "$env" 2>/dev/null | tail -n1 | cut -d= -f2- || true)
    db_user="${db_user:-postbuch}"; db_name="${db_name:-postbuch}"
    [[ "$db_user" =~ ^[A-Za-z0-9_]{1,63}$ && "$db_name" =~ ^[A-Za-z0-9_]{1,63}$ ]] || return 2
    # `wert` wurde vorher eng als HTTP(S)-URL ohne Quotes/Whitespace validiert.
    hostconfig_compose exec -T postgres psql -U "$db_user" -d "$db_name" -v ON_ERROR_STOP=1 \
      -c "INSERT INTO postbuch._settings (key,value) VALUES ('app_host',to_jsonb('$wert'::text)) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()" >/dev/null
}

# Lauscht schon ein Prozess auf dem TCP-Port? Ports, die postbuch.net selbst
# veröffentlicht, gelten als frei, damit ein Rücktausch immer möglich bleibt.
hostconfig_port_belegt() { # $1 port
    local p="$1" hex
    hostconfig_docker ps --format '{{.Names}} {{.Ports}}' 2>/dev/null \
        | grep -E '^postbuch[-_](web|caddy)' | grep -qE "[:.]${p}->" && return 1
    if command -v ss >/dev/null 2>&1; then
        [[ -n "$(ss -Hltn "sport = :$p" 2>/dev/null)" ]]
        return
    fi
    hex=$(printf '%04X' "$p")
    grep -qE "^ *[0-9]+: [0-9A-F]+:${hex} [0-9A-F]+:0000 0A" /proc/net/tcp /proc/net/tcp6 2>/dev/null
}

hostconfig_service_bereit() { # $1 service
    local service="$1" id zustand
    id=$(hostconfig_compose ps -q "$service" 2>/dev/null) || return 1
    [[ -n "$id" ]] || return 1
    zustand=$(hostconfig_docker inspect --format '{{.State.Running}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$id" 2>/dev/null) || return 1
    [[ "$zustand" == 'true none' || "$zustand" == 'true healthy' ]]
}

hostconfig_services_bereit() {
    local service
    for service in "$@"; do hostconfig_service_bereit "$service" || return 1; done
}

hostconfig_service_laeuft() { # $1 service; Vorzustand unabhängig von Health
    local id zustand
    id=$(hostconfig_compose ps -q "$1" 2>/dev/null) || return 1
    [[ -n "$id" ]] || return 1
    zustand=$(hostconfig_docker inspect --format '{{.State.Running}}' "$id" 2>/dev/null) || return 1
    [[ "$zustand" == true* ]]
}

# COMPOSE_PROFILES ist eine Liste (`scanner,embedding`). Jeder Auftrag ändert
# nur sein eigenes Profil; unbekannte oder unsaubere Einträge fallen beim
# Schreiben weg, statt in die .env zurückzuwandern.
hostconfig_profile_lesen() { # $1 env; gibt die gültigen Profile kommagetrennt aus
    local roh teil liste=()
    roh=$(grep '^COMPOSE_PROFILES=' "$1" 2>/dev/null | tail -n1 | cut -d= -f2- || true)
    IFS=',' read -ra teile <<< "$roh"
    for teil in "${teile[@]}"; do
        case "$teil" in scanner|embedding|caddy|lokalki) liste+=("$teil") ;; esac
    done
    (IFS=','; printf '%s' "${liste[*]}")
}

hostconfig_profil_aktiv() { # $1 env $2 profil
    [[ ",$(hostconfig_profile_lesen "$1")," == *,"$2",* ]]
}

hostconfig_profil_setzen() { # $1 env $2 profil (scanner|embedding|lokalki) $3 an|aus
    local env="$1" profil="$2" modus="$3" teil neu=()
    case "$profil" in scanner|embedding|lokalki) ;; *) return 2 ;; esac
    IFS=',' read -ra teile <<< "$(hostconfig_profile_lesen "$env")"
    for teil in "${teile[@]}"; do
        [[ -n "$teil" && "$teil" != "$profil" ]] && neu+=("$teil")
    done
    [[ "$modus" == an ]] && neu+=("$profil")
    hostconfig_env_setzen "$env" COMPOSE_PROFILES "$(IFS=','; printf '%s' "${neu[*]}")"
}

hostconfig_scanner_aktiv() { # $1 env
    hostconfig_profil_aktiv "$1" scanner
}

hostconfig_embedding_aktiv() { # $1 env
    hostconfig_profil_aktiv "$1" embedding
}

# Der Embedding-Dienst meldet sich erst nach dem Healthcheck-Startfenster
# gesund. Ein einmaliger Blick direkt nach `up` wäre ein falscher Fehlschlag.
hostconfig_service_bereit_warten() { # $1 service $2 Sekunden
    local ende=$(( $(date +%s) + $2 ))
    until hostconfig_service_bereit "$1"; do
        (( $(date +%s) < ende )) || return 1
        sleep 3
    done
}

# Freigabe eines Ports: "lan" (alle Schnittstellen), "lokal" (nur der Host
# selbst) oder "anders" (von Hand gesetzte Adresse). Liest nur, gibt nur das
# feste Vokabular aus.
hostconfig_bind_lesen() { # $1 env $2 Key (SCANNER_BIND|WEB_BIND)
    local wert
    wert=$(grep "^$2=" "$1" 2>/dev/null | tail -n1 | cut -d= -f2- || true)
    case "$wert" in
        ''|0.0.0.0|'::') echo lan ;;
        127.0.0.1|localhost|'::1') echo lokal ;;
        *) echo anders ;;
    esac
}

hostconfig_scanner_neu_erstellen() { # $1 env; nur wenn das Scannerprofil aktiv ist
    hostconfig_scanner_aktiv "$1" || return 0
    hostconfig_compose --profile scanner up -d --force-recreate --no-deps scanner || return 1
    hostconfig_services_bereit scanner
}

hostconfig_web_neu_erstellen() {
    hostconfig_compose up -d --force-recreate --no-deps web || return 1
    hostconfig_services_bereit web
}

hostconfig_ruecktausch() { # $1 env $2 typ $3 scanner-war-aktiv $4 caddy-war-aktiv $5 Caddyfile
    local env="$1" typ="$2" scanner_war_aktiv="$3" caddy_war_aktiv="${4:-false}" caddyfile="${5:-}"
    hostconfig_rollback "$env" || return 1
    case "$typ" in
        module)
            if [[ "$scanner_war_aktiv" == true ]]; then
                hostconfig_compose --profile scanner up -d --force-recreate --no-deps scanner cleaner || true
            else
                hostconfig_compose stop scanner cleaner || true
            fi
            ;;
        port) hostconfig_compose up -d --force-recreate --no-deps app web || true ;;
        netzwerk) hostconfig_compose up -d --force-recreate --no-deps app web || true ;;
        freigabe)
            hostconfig_web_neu_erstellen || true
            hostconfig_scanner_neu_erstellen "$env" || true
            ;;
        duckdns)
            [[ -n "$caddyfile" ]] && hostconfig_caddy_rollback "$caddyfile" || true
            # WEB_BIND kann beim Abschalten geändert worden sein.
            hostconfig_web_neu_erstellen || true
            if [[ "$caddy_war_aktiv" == true ]]; then
                hostconfig_compose --profile caddy up -d --force-recreate --no-deps caddy || true
            else
                hostconfig_compose stop caddy || true
            fi
            ;;
    esac
    return 1
}

# Rücktausch für embedding:an/aus: .env zurück und den Dienst in den
# Vorzustand bringen. Der Scanner bleibt davon unberührt.
hostconfig_embedding_ruecktausch() { # $1 env $2 embedding-war-aktiv
    hostconfig_rollback "$1" || return 1
    if [[ "$2" == true ]]; then
        hostconfig_compose --profile embedding up -d --no-deps embedding || true
    else
        hostconfig_compose stop embedding || true
    fi
    return 1
}

# ── Lokale KI (Compose-Profil lokalki, Dienst llm) ───────────────────────────
# Das Modell ist kuratiert: genau ein Manifest im Release
# (app/src/lib/llm/lokal-modelle.kv). Gelesen wird nur aus dem Installations-
# verzeichnis, jede Zeile wird hier noch einmal gegen feste Muster geprüft –
# dieselben Regeln wie parseManifest() in der App. Alle Löschpfade sind mit
# ${var:?} gesichert: ein leerer Wert bricht ab, statt am Wurzelverzeichnis
# anzusetzen.

hostconfig_env_lesen() { # $1 env $2 key; gibt den Rohwert aus (leer, wenn nicht gesetzt)
    grep "^$2=" "$1" 2>/dev/null | tail -n1 | cut -d= -f2- || true
}

hostconfig_lokalki_manifest() { # $1 install; füllt LK_MODELL, LK_DATEIEN, LK_STUFEN
    local datei="$1/app/src/lib/llm/lokal-modelle.kv" zeile cpu=false
    local -a f
    LK_MODELL=''; LK_DATEIEN=(); LK_STUFEN=()
    [[ -f "$datei" && ! -L "$datei" ]] || return 1
    while IFS= read -r zeile || [[ -n "$zeile" ]]; do
        [[ -z "$zeile" || "$zeile" == '#'* ]] && continue
        IFS='|' read -r -a f <<< "$zeile"
        case "${f[0]}" in
            modell)
                (( ${#f[@]} == 4 )) && [[ -z "$LK_MODELL" && "${f[1]}" =~ ^[a-z0-9][a-z0-9.-]{0,63}$ ]] || return 1
                LK_MODELL="${f[1]}"
                ;;
            datei)
                (( ${#f[@]} == 6 )) || return 1
                [[ "${f[1]}" =~ ^(modell|mmproj|mtp)$ \
                   && "${f[2]}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.gguf$ \
                   && "${f[3]}" =~ ^[0-9a-f]{64}$ \
                   && "${f[4]}" =~ ^[1-9][0-9]{0,12}$ \
                   && "${f[5]}" == "https://huggingface.co/unsloth/"* \
                   && "${f[5]}" == */"${f[2]}" \
                   && "${f[5]}" =~ ^https://[A-Za-z0-9./_-]+$ ]] || return 1
                LK_DATEIEN+=("${f[1]}|${f[2]}|${f[3]}|${f[4]}|${f[5]}")
                ;;
            stufe)
                (( ${#f[@]} == 10 )) || return 1
                [[ "${f[1]}" =~ ^[a-z0-9-]{1,32}$ && "${f[2]}" =~ ^[0-9]{1,6}$ \
                   && "${f[3]}" =~ ^(ja|nein)$ && "${f[4]}" =~ ^[0-9]{4,7}$ \
                   && "${f[5]}" =~ ^(all|auto|[0-9]{1,3})$ && "${f[6]}" =~ ^(ja|nein)$ \
                   && "${f[8]}" =~ ^[0-9]{1,7}$ ]] || return 1
                [[ "${f[3]}" == nein && "${f[2]}" == 0 ]] && cpu=true
                LK_STUFEN+=("${f[1]}|${f[2]}|${f[3]}|${f[4]}|${f[5]}|${f[6]}|${f[8]}")
                ;;
            *) return 1 ;;
        esac
    done < "$datei"
    [[ -n "$LK_MODELL" ]] && $cpu || return 1
    hostconfig_lokalki_datei modell >/dev/null && hostconfig_lokalki_datei mmproj >/dev/null
}

hostconfig_lokalki_datei() { # $1 rolle; gibt "rolle|datei|sha|bytes|url" aus
    local d
    for d in "${LK_DATEIEN[@]}"; do [[ "$d" == "$1|"* ]] && { printf '%s' "$d"; return 0; }; done
    return 1
}

# NVIDIA-Karte erkennen. Ausgabe "vramMiB|name|dockerBereit" oder Rückgabe 1.
# Unter WSL liegt nvidia-smi nicht im PATH, sondern unter /usr/lib/wsl/lib.
# dockerBereit heißt: Docker kann Container mit GPU starten (NVIDIA Container
# Toolkit). Ohne das bringt die Karte dem Dienst nichts.
hostconfig_gpu_erkennen() {
    local smi='' zeile vram name bereit=false
    if command -v nvidia-smi >/dev/null 2>&1; then smi=$(command -v nvidia-smi)
    elif [[ -x /usr/lib/wsl/lib/nvidia-smi ]]; then smi=/usr/lib/wsl/lib/nvidia-smi
    else return 1; fi
    zeile=$(timeout -k 2 10 "$smi" --query-gpu=memory.total,name --format=csv,noheader,nounits 2>/dev/null | head -n1) || return 1
    vram="${zeile%%,*}"; vram="${vram//[[:space:]]/}"
    [[ "$vram" =~ ^[0-9]{1,7}$ ]] || return 1
    name=$(printf '%s' "${zeile#*,}" | tr -cd 'A-Za-z0-9 ._()-' | sed 's/^ *//' | cut -c1-128)
    if hostconfig_docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -q '"nvidia"' \
       || command -v nvidia-container-runtime-hook >/dev/null 2>&1; then
        bereit=true
    fi
    printf '%s|%s|%s\n' "$vram" "$name" "$bereit"
}

# Die Kennung bezeichnet die im Installer gezeigten NVIDIA-Bedingungen.
HOSTCONFIG_CUDA_LIZENZ=nvidia-cuda-12.8.1

hostconfig_cuda_akzeptiert() { # $1 install
    [[ "$(hostconfig_env_lesen "$1/.env" POSTBUCH_CUDA_ZUSTIMMUNG)" == "$HOSTCONFIG_CUDA_LIZENZ" ]]
}

hostconfig_cuda_konfiguriert() { # $1 install
    [[ ":$(hostconfig_env_lesen "$1/.env" COMPOSE_FILE):" == *:docker-compose.gpu.yml:* ]]
}

# Mindestausstattung der lokalen KI – dieselben Werte wie LOKALKI_GRENZEN in
# app/src/lib/llm/lokal-modelle.js. GB dezimal, damit ein Rechner mit 16 GB
# RAM und 8-GB-Karte trotz reservierten Speichers die Grenze erreicht.
HOSTCONFIG_LOKALKI_MIN_SPEICHER_MIB=22888   # 24 GB RAM + nutzbarer Grafikspeicher
HOSTCONFIG_LOKALKI_FLOTT_VRAM_MIB=7629      # ab 8 GB Grafikspeicher kein Schneckentempo
HOSTCONFIG_LOKALKI_RESERVE_BYTES=5368709120 # nach dem Modell müssen 5 GiB frei bleiben

# Arbeitsspeicher, den Docker sieht (unter WSL der Speicher der WSL-VM), in MiB.
hostconfig_ram_mib() {
    local kb
    kb=$(awk '/^MemTotal:/ { print $2; exit }' "${HOSTCONFIG_MEMINFO:-/proc/meminfo}" 2>/dev/null)
    [[ "$kb" =~ ^[0-9]{1,12}$ ]] || return 1
    printf '%s' $(( kb / 1024 ))
}

# Reicht der Speicher für die lokale KI? $1 nutzbarer Grafikspeicher in MiB
# oder leer. Rückgabe 0 = ja, 5 = zu wenig, 1 = nicht ermittelbar.
hostconfig_lokalki_speicher_pruefen() {
    local ram
    ram=$(hostconfig_ram_mib) || return 1
    (( ram + ${1:-0} >= HOSTCONFIG_LOKALKI_MIN_SPEICHER_MIB )) || return 5
}

# Erste Stufe in Manifest-Reihenfolge, deren Bedingung erfüllt ist – dieselbe
# Regel wie waehleStufe() in der App. $1 vramMiB oder leer (keine nutzbare GPU).
# Setzt LK_STUFE, LK_GPU, LK_KONTEXT, LK_SCHICHTEN, LK_MTP, LK_RAM.
hostconfig_lokalki_stufe() {
    local vram="$1" s name ab gpu kontext schichten mtp ram
    for s in "${LK_STUFEN[@]}"; do
        IFS='|' read -r name ab gpu kontext schichten mtp ram <<< "$s"
        if [[ "$gpu" == nein ]] || { [[ -n "$vram" ]] && (( vram >= ab )); }; then
            LK_STUFE="$name"; LK_GPU="$gpu"; LK_KONTEXT="$kontext"
            LK_SCHICHTEN="$schichten"; LK_MTP="$mtp"; LK_RAM="$ram"
            [[ "$gpu" == nein ]] && LK_SCHICHTEN=0
            return 0
        fi
    done
    return 1
}

hostconfig_lokalki_stufe_dateien() { # gibt die Dateizeilen der gewählten Stufe aus
    local d
    for d in "${LK_DATEIEN[@]}"; do
        [[ "$d" == mtp\|* && "$LK_MTP" != ja ]] && continue
        printf '%s\n' "$d"
    done
}

# Modellordner aus POSTBUCH_MODELLE_DIR (Standard ./data/modelle). Nie ein
# Systempfad, nie das Installationsverzeichnis selbst oder die Datenbank.
hostconfig_modelle_dir() { # $1 install $2 lesen(optional: nicht anlegen); gibt den absoluten Pfad aus
    local install roh dir
    install=$(realpath -e -- "$1") || return 1
    roh=$(hostconfig_env_lesen "$install/.env" POSTBUCH_MODELLE_DIR)
    [[ -z "$roh" ]] && roh=./data/modelle
    [[ "$roh" == ./* ]] && roh="$install/${roh#./}"
    [[ "$roh" =~ ^/[A-Za-z0-9._/-]+$ && "$roh" != *..* ]] || return 1
    [[ "${2:-}" == lesen ]] || mkdir -p -- "$roh" 2>/dev/null || return 1
    dir=$(realpath -e -- "$roh" 2>/dev/null) || return 1
    case "$dir" in
        /|/bin|/bin/*|/boot|/boot/*|/dev|/dev/*|/etc|/etc/*|/lib|/lib/*|/lib64|/lib64/*|/proc|/proc/*|/root|/run|/run/*|/sbin|/sbin/*|/sys|/sys/*|/usr|/usr/*|/var/lib/docker|/var/lib/docker/*)
            return 1 ;;
        "$install"|"$install/data"|"$install/data/postgres"|"$install/data/postgres/"*) return 1 ;;
    esac
    printf '%s' "$dir"
}

hostconfig_fortschritt() { # $1 Bytes $2 gesamt $3 phase; Hook definiert der Agent
    if declare -F hostconfig_fortschritt_hook >/dev/null; then
        hostconfig_fortschritt_hook "$1" "$2" "$3" || true
    fi
}

hostconfig_datei_fertig() { # $1 dir $2 datei $3 sha $4 bytes
    [[ -f "$1/$2" && ! -L "$1/$2" && -f "$1/.$2.geprueft" ]] || return 1
    [[ "$(stat -c %s -- "$1/$2" 2>/dev/null)" == "$4" ]] || return 1
    [[ "$(cat -- "$1/.$2.geprueft" 2>/dev/null)" == "$3" ]]
}

# Lädt alle Dateien der gewählten Stufe nach $1. Teilstände bleiben als .part
# liegen und werden beim nächsten Einschalten fortgesetzt. Rückgabe 3 = Frist
# (HOSTCONFIG_FRIST, Epoch-Sekunden) abgelaufen, 4 = zu wenig Platz.
hostconfig_lokalki_laden() { # $1 dir
    local dir="${1:?}" zeile rolle datei sha bytes url part groesse gesamt=0 fertig=0 bedarf=0 frei pid
    local -a liste
    mapfile -t liste < <(hostconfig_lokalki_stufe_dateien)
    for zeile in "${liste[@]}"; do
        IFS='|' read -r rolle datei sha bytes url <<< "$zeile"
        gesamt=$(( gesamt + bytes ))
        if hostconfig_datei_fertig "$dir" "$datei" "$sha" "$bytes"; then continue; fi
        groesse=$(stat -c %s -- "$dir/$datei.part" 2>/dev/null || echo 0)
        bedarf=$(( bedarf + bytes - groesse ))
    done
    # Platz: Nach dem Download müssen noch 5 GiB frei bleiben.
    frei=$(df -B1 --output=avail -- "$dir" 2>/dev/null | tail -n1 | tr -d ' ')
    [[ "$frei" =~ ^[0-9]+$ ]] && (( frei >= bedarf + HOSTCONFIG_LOKALKI_RESERVE_BYTES )) || return 4
    for zeile in "${liste[@]}"; do
        IFS='|' read -r rolle datei sha bytes url <<< "$zeile"
        : "${datei:?}"
        if hostconfig_datei_fertig "$dir" "$datei" "$sha" "$bytes"; then
            fertig=$(( fertig + bytes )); continue
        fi
        part="${dir:?}/${datei:?}.part"
        # Belegt eine andere Datei gleichen Namens den Platz (Modellwechsel,
        # z. B. mmproj-F16.gguf bei beiden Modellen), wird sie nicht
        # überschrieben, sondern als .vorher beiseitegelegt: Der laufende
        # Dienst liest weiter über den offenen Dateideskriptor, und ein
        # Rücktausch stellt sie wieder her.
        if [[ -f "$dir/$datei" && ! -L "$dir/$datei" && ! -e "$dir/$datei.vorher" ]]; then
            mv -fT -- "$dir/$datei" "$dir/$datei.vorher" || return 1
            [[ -f "$dir/.$datei.geprueft" ]] && mv -fT -- "$dir/.$datei.geprueft" "$dir/.$datei.geprueft.vorher"
        fi
        rm -f -- "${dir:?}/.${datei:?}.geprueft"
        [[ ! -L "$part" ]] || return 1
        groesse=$(stat -c %s -- "$part" 2>/dev/null || echo 0)
        (( groesse > bytes )) && { rm -f -- "${part:?}"; groesse=0; }
        if (( groesse < bytes )); then
            curl -fsL --proto '=https' --proto-redir '=https' -C - --retry 5 --retry-delay 10 \
                --connect-timeout 30 --speed-limit 10240 --speed-time 120 \
                -o "$part" -- "$url" &
            pid=$!
            while kill -0 "$pid" 2>/dev/null; do
                sleep 5
                groesse=$(stat -c %s -- "$part" 2>/dev/null || echo 0)
                hostconfig_fortschritt "$(( fertig + groesse ))" "$gesamt" download
                if (( $(date +%s) >= ${HOSTCONFIG_FRIST:-0} )); then
                    kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
                    return 3
                fi
            done
            wait "$pid" || return 1
        fi
        [[ "$(stat -c %s -- "$part" 2>/dev/null)" == "$bytes" ]] || { rm -f -- "${part:?}"; return 1; }
        hostconfig_fortschritt "$(( fertig + bytes ))" "$gesamt" pruefung
        if [[ "$(sha256sum -- "$part" | cut -c1-64)" != "$sha" ]]; then
            rm -f -- "${part:?}"
            return 1
        fi
        mv -fT -- "$part" "$dir/$datei" || return 1
        printf '%s' "$sha" > "$dir/.$datei.geprueft" || return 1
        fertig=$(( fertig + bytes ))
    done
    hostconfig_fortschritt "$gesamt" "$gesamt" start
}

# Beiseitegelegte Dateien (.vorher, siehe hostconfig_lokalki_laden) zurück an
# ihren Platz – nach einem gescheiterten oder abgebrochenen Modellwechsel.
hostconfig_lokalki_vorher_zurueck() { # $1 dir
    local dir="${1:?}" v datei
    for v in "$dir"/*.gguf.vorher; do
        [[ -f "$v" && ! -L "$v" ]] || continue
        datei=${v##*/}; datei=${datei%.vorher}
        [[ "$datei" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.gguf$ ]] || continue
        rm -f -- "${dir:?}/.${datei:?}.geprueft"
        mv -fT -- "$v" "$dir/$datei" || continue
        [[ -f "$dir/.$datei.geprueft.vorher" ]] && mv -fT -- "$dir/.$datei.geprueft.vorher" "$dir/.$datei.geprueft"
    done
    return 0
}

hostconfig_lokalki_vorher_loeschen() { # $1 dir
    rm -f -- "${1:?}"/*.gguf.vorher "${1:?}"/.*.gguf.geprueft.vorher
}

# data/lokalki.env – Startparameter des Dienstes (env_file im Compose). Nur
# feste Schlüssel aus geprüften Manifestwerten.
hostconfig_lokalki_env_schreiben() { # $1 install
    local ziel="$1/data/lokalki.env" tmp modell mmproj mtp dateien
    modell=$(hostconfig_lokalki_datei modell | cut -d'|' -f2)
    mmproj=$(hostconfig_lokalki_datei mmproj | cut -d'|' -f2)
    dateien="$modell:$mmproj"
    tmp=$(mktemp "$1/data/lokalki.env.tmp.XXXXXX") || return 1
    {
        printf 'POSTBUCH_LOKALKI_MODELL=%s\n' "$LK_MODELL"
        printf 'POSTBUCH_LOKALKI_STUFE=%s\n' "$LK_STUFE"
        printf 'LLAMA_ARG_MODEL=/m/%s\n' "$modell"
        printf 'LLAMA_ARG_MMPROJ=/m/%s\n' "$mmproj"
        printf 'LLAMA_ARG_CTX_SIZE=%s\n' "$LK_KONTEXT"
        printf 'LLAMA_ARG_N_GPU_LAYERS=%s\n' "$LK_SCHICHTEN"
        if [[ "$LK_MTP" == ja ]]; then
            mtp=$(hostconfig_lokalki_datei mtp | cut -d'|' -f2)
            dateien="$dateien:$mtp"
            printf 'LLAMA_ARG_SPEC_TYPE=draft-mtp\n'
            printf 'LLAMA_ARG_SPEC_DRAFT_MODEL=/m/%s\n' "$mtp"
            printf 'LLAMA_ARG_N_GPU_LAYERS_DRAFT=all\n'
        fi
        printf 'POSTBUCH_LOKALKI_DATEIEN=%s\n' "$dateien"
    } > "$tmp" || { rm -f -- "${tmp:?}"; return 1; }
    chmod 644 "$tmp" && mv -fT -- "$tmp" "$ziel"
}

# Geleert, nie gelöscht: Compose vor 2.24 bricht ohne die Datei schon beim
# Lesen der Compose-Datei ab (env_file des Dienstes llm).
hostconfig_lokalki_env_leeren() { # $1 install
    local ziel="${1:?}/data/lokalki.env"
    [[ -L "$ziel" ]] && rm -f -- "$ziel"
    : > "$ziel" && chmod 644 "$ziel"
}

# COMPOSE_FILE aus festem Vokabular. Ohne GPU und ohne bisherigen Eintrag
# bleibt die .env unverändert (Compose nimmt dann seinen Standard).
hostconfig_compose_file_setzen() { # $1 install $2 gpu ja|nein
    local cf=docker-compose.yml
    [[ "$2" == ja ]] && cf+=":docker-compose.gpu.yml"
    [[ -f "$1/docker-compose.override.yml" ]] && cf+=":docker-compose.override.yml"
    if [[ "$2" != ja && -z "$(hostconfig_env_lesen "$1/.env" COMPOSE_FILE)" ]]; then return 0; fi
    hostconfig_env_setzen "$1/.env" COMPOSE_FILE "$cf"
}

# Image-Referenzen eines Dienstes aus den eigenen Compose-Dateien, nie per
# Namensmuster über alle Images: fremde Container desselben Images bleiben
# unberührt, und `image rm` verweigert ohnehin Images in Benutzung.
hostconfig_dienst_images() { # $1 profil $2 Muster (grep -E) für die Referenz
    {
        hostconfig_compose -f docker-compose.yml --profile "$1" config --images 2>/dev/null
        hostconfig_compose -f docker-compose.yml -f docker-compose.gpu.yml --profile "$1" config --images 2>/dev/null
    } | grep -E "$2" | sort -u
}

# Benanntes Compose-Volume entfernen (nur Caches wie die Embedding-Modelle).
# Der echte Name samt Projektpräfix kommt aus der aufgelösten Compose-Datei.
hostconfig_volume_entfernen() { # $1 profil $2 Volume-Schlüssel
    local name
    name=$(hostconfig_compose --profile "$1" config 2>/dev/null | awk -v k="  $2:" '
        /^volumes:/ { v = 1; next }
        v && /^[^ ]/ { v = 0 }
        v && $0 == k { e = 1; next }
        e && /^  [^ ]/ { e = 0 }
        e && $1 == "name:" { print $2; exit }')
    [[ -n "$name" ]] && hostconfig_docker volume rm "$name" >/dev/null 2>&1
    return 0
}

# Dienste entfernen: Container weg, Images weg. Daten unter data/ bleiben.
hostconfig_dienste_entfernen() { # $1 profil $2 Muster $3.. services
    local profil="$1" muster="$2" s id ref
    shift 2
    local -a ids=()
    for s in "$@"; do
        id=$(hostconfig_compose --profile "$profil" ps -aq "$s" 2>/dev/null) || true
        [[ -n "$id" ]] && ids+=("$(hostconfig_docker inspect --format '{{.Image}}' "$id" 2>/dev/null)")
    done
    hostconfig_compose --profile "$profil" rm -sf "$@" >/dev/null 2>&1 || return 1
    for id in "${ids[@]}"; do [[ -n "$id" ]] && hostconfig_docker image rm "$id" >/dev/null 2>&1; done
    while IFS= read -r ref; do
        [[ -n "$ref" ]] && hostconfig_docker image rm "$ref" >/dev/null 2>&1
    done < <(hostconfig_dienst_images "$profil" "$muster")
    return 0
}

# $3=env: die lokalki.env wurde in diesem Auftrag geschrieben und muss zurück.
hostconfig_lokalki_ruecktausch() { # $1 install $2 war-aktiv $3 env|leer
    local env="$1/.env" dir
    if [[ "${3:-}" == env ]] && dir=$(hostconfig_modelle_dir "$1"); then
        hostconfig_lokalki_vorher_zurueck "$dir"
    fi
    if [[ "${3:-}" == env && -f "$1/data/lokalki.env.hostconfig.bak" ]]; then
        mv -fT -- "$1/data/lokalki.env.hostconfig.bak" "$1/data/lokalki.env"
    elif [[ "${3:-}" == env ]]; then
        hostconfig_lokalki_env_leeren "$1"
    fi
    [[ -f "${env}.hostconfig.bak" ]] && hostconfig_rollback "$env"
    if [[ "$2" == true ]] && { ! hostconfig_cuda_konfiguriert "$1" || hostconfig_cuda_akzeptiert "$1"; }; then
        hostconfig_compose --profile lokalki up -d --force-recreate --no-deps llm >/dev/null 2>&1 || true
    else
        hostconfig_compose --profile lokalki stop llm >/dev/null 2>&1 || true
    fi
    return 1
}

hostconfig_lokalki_an() { # $1 install $2 war-aktiv
    local install="$1" war="$2" gpu vram='' dir rc rest
    HOSTCONFIG_FRIST=$(( $(date +%s) + 6300 ))
    hostconfig_lokalki_manifest "$install" || return 1
    if hostconfig_cuda_akzeptiert "$install" && gpu=$(hostconfig_gpu_erkennen) && [[ "${gpu##*|}" == true ]]; then
        vram="${gpu%%|*}"
    fi
    hostconfig_lokalki_stufe "$vram" || return 1
    # Zu wenig Speicher: Das Modell lädt nicht oder legt den Rechner lahm.
    # Auch der Agent prüft hier, nicht nur App und Installer.
    # Nicht ermittelbarer Speicher sperrt nicht – wie in App und Installer.
    hostconfig_lokalki_speicher_pruefen "$vram"; rc=$?
    (( rc == 5 )) && return 5
    dir=$(hostconfig_modelle_dir "$install") || return 1
    # Bis hier ist nichts verändert; ein Abbruch beim Laden braucht keinen
    # Rücktausch, der Teilstand wird beim nächsten Versuch fortgesetzt.
    hostconfig_lokalki_laden "$dir"; rc=$?
    (( rc == 0 )) || { hostconfig_lokalki_vorher_zurueck "$dir"; return "$rc"; }
    [[ -f "$install/data/lokalki.env" ]] && cp -p -- "$install/data/lokalki.env" "$install/data/lokalki.env.hostconfig.bak"
    hostconfig_lokalki_env_schreiben "$install" || { hostconfig_lokalki_ruecktausch "$install" "$war" env; return 1; }
    hostconfig_compose_file_setzen "$install" "$LK_GPU" || { hostconfig_lokalki_ruecktausch "$install" "$war" env; return 1; }
    hostconfig_profil_setzen "$install/.env" lokalki an || { hostconfig_lokalki_ruecktausch "$install" "$war" env; return 1; }
    rest=$(( HOSTCONFIG_FRIST - $(date +%s) ))
    (( rest > 60 )) || { hostconfig_lokalki_ruecktausch "$install" "$war" env; return 3; }
    hostconfig_fortschritt 0 0 image
    hostconfig_compose_befristet "$rest" --profile lokalki pull llm >/dev/null 2>&1 \
        || { hostconfig_lokalki_ruecktausch "$install" "$war" env; return 1; }
    hostconfig_fortschritt 0 0 start
    hostconfig_compose --profile lokalki up -d --force-recreate --no-deps llm >/dev/null 2>&1 \
        || { hostconfig_lokalki_ruecktausch "$install" "$war" env; return 1; }
    # Das Laden in den Grafikspeicher bzw. RAM dauert auf CPU-Systemen Minuten.
    hostconfig_service_bereit_warten llm 900 \
        || { hostconfig_lokalki_ruecktausch "$install" "$war" env; return 1; }
    hostconfig_lokalki_alte_dateien_loeschen "$install" "$dir"
    hostconfig_lokalki_vorher_loeschen "$dir"
    rm -f -- "${install:?}/data/lokalki.env.hostconfig.bak"
}

# Nach einem Modellwechsel (neues Manifest im Release) die Dateien des
# Vorgängers löschen – erst wenn der Dienst mit dem neuen Modell gesund ist.
hostconfig_lokalki_alte_dateien_loeschen() { # $1 install $2 dir
    local alt neu datei
    local -a teile=()
    alt=$(hostconfig_env_lesen "$1/data/lokalki.env.hostconfig.bak" POSTBUCH_LOKALKI_DATEIEN)
    neu=$(hostconfig_env_lesen "$1/data/lokalki.env" POSTBUCH_LOKALKI_DATEIEN)
    [[ -n "$alt" && -n "$neu" ]] || return 0
    IFS=':' read -r -a teile <<< "$alt"
    for datei in "${teile[@]}"; do
        [[ "$datei" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.gguf$ ]] || continue
        [[ ":$neu:" == *":$datei:"* ]] && continue
        rm -f -- "${2:?}/${datei:?}" "${2:?}/${datei:?}.part" "${2:?}/.${datei:?}.geprueft"
    done
}

hostconfig_lokalki_aus() { # $1 install $2 war-aktiv
    hostconfig_profil_setzen "$1/.env" lokalki aus || return 1
    hostconfig_compose --profile lokalki stop llm >/dev/null 2>&1 \
        || { hostconfig_lokalki_ruecktausch "$1" "$2"; return 1; }
}

# Entfernen löscht nur Dateien mit Namen aus dem Manifest bzw. der zuletzt
# geschriebenen lokalki.env – nie den Ordner und nie per Muster.
hostconfig_lokalki_entfernen() { # $1 install $2 war-aktiv
    local install="${1:?}" dir datei roh rest=0
    local -a namen=() teile=()
    hostconfig_profil_setzen "$install/.env" lokalki aus || return 1
    hostconfig_dienste_entfernen lokalki '^ghcr\.io/ggml-org/llama\.cpp:' llm \
        || { hostconfig_lokalki_ruecktausch "$install" "$2"; return 1; }
    hostconfig_compose_file_setzen "$install" nein || true
    if hostconfig_lokalki_manifest "$install"; then
        for datei in "${LK_DATEIEN[@]}"; do namen+=("$(cut -d'|' -f2 <<< "$datei")"); done
    fi
    roh=$(hostconfig_env_lesen "$install/data/lokalki.env" POSTBUCH_LOKALKI_DATEIEN)
    IFS=':' read -r -a teile <<< "$roh"
    namen+=("${teile[@]}")
    if dir=$(hostconfig_modelle_dir "$install"); then
        hostconfig_lokalki_vorher_loeschen "$dir"
        for datei in "${namen[@]}"; do
            [[ "$datei" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.gguf$ ]] || continue
            rm -f -- "${dir:?}/${datei:?}" "${dir:?}/${datei:?}.part" "${dir:?}/.${datei:?}.geprueft" || rest=1
        done
    fi
    hostconfig_lokalki_env_leeren "$install"
    return "$rest"
}

# ── Ablageordner (Storage-Backend „lokal“) ───────────────────────────────────
# Auftrag `ablage` (wert=setzen, pfad=Base64). Der Pfad ist Freitext aus der
# Oberfläche und wird hier vollständig geprüft: Zeichen, keine Punkt-Komponente,
# jede Komponente ein echtes Verzeichnis ohne Verknüpfung, nur unter erlaubten
# Wurzeln. Die App steht während Prüfung und Kopie, weil sie /ablage als root
# eingehängt hat. Gelöscht wird nichts: Der bisherige Ordner bleibt, eine
# missglückte Kopie ebenso.
HOSTCONFIG_GRUND=''   # feste Meldung für die Oberfläche; nie Nutzereingaben

hostconfig_ist_wsl() { grep -qi microsoft /proc/sys/kernel/osrelease 2>/dev/null; }

hostconfig_ablage_syntax() { # $1 Linux-Pfad
    local p="$1" teil
    local -a teile=()
    [[ "$p" == /?* && "$p" != */ && ${#p} -le 400 ]] || return 1
    # $ und # deutet Compose in unquotierten .env-Werten, Anführungszeichen und
    # Backslash ebenfalls.
    [[ "$p" == *[[:cntrl:]\$\#\"\'\`\\]* || "$p" == *//* ]] && return 1
    IFS='/' read -r -a teile <<< "${p#/}"
    for teil in "${teile[@]}"; do
        [[ -n "$teil" && "$teil" != .* && "$teil" == "${teil# }" && "$teil" == "${teil% }" ]] || return 1
    done
}

# Base64 dekodieren, Windows-Form unter WSL umwandeln, prüfen; gibt den Pfad aus.
hostconfig_ablage_pfad_lesen() { # $1 base64
    local roh p
    [[ "$1" =~ ^[A-Za-z0-9+/]{4,1100}={0,2}$ ]] || return 2
    roh=$(printf '%s' "$1" | base64 -d 2>/dev/null | tr -d '\000') || return 2
    [[ ${#roh} -ge 2 && ${#roh} -le 400 && "$roh" != *[[:cntrl:]]* ]] || return 2
    if [[ "$roh" =~ ^[A-Za-z]:\\ ]]; then
        hostconfig_ist_wsl || return 2
        [[ "$roh" == *[\$\#\"\'\`/]* ]] && return 2
        p=$(wslpath -u "$roh" 2>/dev/null) || return 2
    else
        p="$roh"
    fi
    hostconfig_ablage_syntax "$p" || return 2
    printf '%s' "$p"
}

# Jede Komponente existiert als Verzeichnis und ist keine Verknüpfung.
hostconfig_ablage_kanonisch() { # $1 Pfad
    local stueck='' teil
    local -a teile=()
    IFS='/' read -r -a teile <<< "${1#/}"
    for teil in "${teile[@]}"; do
        stueck="$stueck/$teil"
        [[ -d "$stueck" && ! -L "$stueck" ]] || return 1
    done
    [[ "$(realpath -e -- "$1" 2>/dev/null)" == "$1" ]]
}

# Die Ablage liegt nie im Installationsverzeichnis: Eine Deinstallation löscht
# es ganz, der Ablageordner bleibt stehen. Unter WSL gilt dasselbe für das
# Linux-Dateisystem der Instanz (wsl --unregister) – dort nur Windows-Ordner.
hostconfig_ablage_erlaubt() { # $1 Pfad $2 install $3 Modellordner(optional)
    local p="$1" install="$2" besitzer home
    case "$p" in "$install"|"$install"/*) return 1 ;; esac
    case "$install" in "$p"/*) return 1 ;; esac
    if [[ -n "${3:-}" ]]; then case "$p" in "$3"|"$3"/*) return 1 ;; esac; fi
    if hostconfig_ist_wsl; then
        if [[ "$p" =~ ^/mnt/[a-z]/Users/([^/]+)/. ]]; then
            case "${BASH_REMATCH[1]}" in Public|Default|"Default User"|"All Users") return 1 ;; esac
            return 0
        fi
        # Weitere Laufwerke (D: …), nie C: außerhalb der Benutzerprofile.
        [[ "$p" =~ ^/mnt/[d-z]/[^/]+ ]]
        return
    fi
    besitzer=$(stat -c %U -- "$install" 2>/dev/null)
    home=$(getent passwd "$besitzer" 2>/dev/null | cut -d: -f6)
    if [[ "$home" == /?* && "$home" != /root && "$p" == "$home"/?* ]]; then return 0; fi
    [[ "$p" =~ ^/mnt/[^/]+/. || "$p" =~ ^/media/[^/]+/[^/]+/. || "$p" =~ ^/srv/[^/]+ ]]
}

hostconfig_ablage_dir_aktuell() { # $1 install
    local roh
    roh=$(hostconfig_env_lesen "$1/.env" POSTBUCH_ABLAGE_DIR)
    [[ -z "$roh" ]] && roh=./data/ablage
    [[ "$roh" == ./* ]] && roh="$1/${roh#./}"
    realpath -m -- "$roh" 2>/dev/null
}

hostconfig_ablage_zaehlen() { # $1 dir → "dateien|bytes"
    find "$1" -type f -printf '%s\n' 2>/dev/null | awk '{ n++; s += $1 } END { printf "%d|%d", n, s }'
}

hostconfig_ablage_app_zurueck() { # $1 env; .env zurück (falls geändert) und App starten
    [[ -f "$1.hostconfig.bak" ]] && hostconfig_rollback "$1"
    hostconfig_compose up -d --force-recreate --no-deps app >/dev/null 2>&1 || true
}

hostconfig_ablage_setzen() { # $1 install $2 pfad(base64)
    local install ziel alt modelle anzeige zahl_alt zahl_neu env
    HOSTCONFIG_GRUND=''
    install=$(realpath -e -- "$1") || return 1
    env="$install/.env"
    ziel=$(hostconfig_ablage_pfad_lesen "$2") || { HOSTCONFIG_GRUND='Der Pfad ist ungültig.'; return 5; }
    modelle=$(hostconfig_modelle_dir "$install" lesen 2>/dev/null || true)
    hostconfig_ablage_erlaubt "$ziel" "$install" "$modelle" \
        || { HOSTCONFIG_GRUND='Dieser Ordner ist als Ablage nicht erlaubt.'; return 5; }
    hostconfig_ablage_kanonisch "$(dirname -- "$ziel")" \
        || { HOSTCONFIG_GRUND='Der übergeordnete Ordner fehlt oder ist eine Verknüpfung.'; return 5; }
    alt=$(hostconfig_ablage_dir_aktuell "$install") || return 1
    [[ "$ziel" != "$alt" ]] || { HOSTCONFIG_GRUND='Das ist bereits der Ablageordner.'; return 5; }
    case "$ziel/" in "$alt/"*) HOSTCONFIG_GRUND='Der neue Ordner liegt im bisherigen.'; return 5 ;; esac
    case "$alt/" in "$ziel/"*) HOSTCONFIG_GRUND='Der bisherige Ordner liegt im neuen.'; return 5 ;; esac

    # Ab hier steht die App, damit niemand zwischen Prüfung und Kopie etwas umhängt.
    hostconfig_compose stop app >/dev/null 2>&1 || return 1
    if [[ -d "$alt" && -n "$(find "$alt" -type l -print -quit 2>/dev/null)" ]]; then
        HOSTCONFIG_GRUND='Die bisherige Ablage enthält Verknüpfungen und wird nicht kopiert.'
        hostconfig_ablage_app_zurueck "$env"; return 5
    fi
    if [[ -e "$ziel" || -L "$ziel" ]]; then
        if [[ -L "$ziel" ]]; then
            HOSTCONFIG_GRUND='Der Zielordner ist eine Verknüpfung.'
        elif [[ ! -d "$ziel" ]]; then
            HOSTCONFIG_GRUND='Der Zielpfad ist kein Ordner.'
        elif ! hostconfig_ablage_kanonisch "$ziel" || [[ -n "$(find "$ziel" -mindepth 1 -print -quit 2>/dev/null)" ]]; then
            HOSTCONFIG_GRUND='Der Zielordner ist nicht leer.'
        fi
        if [[ -n "$HOSTCONFIG_GRUND" ]]; then
            hostconfig_ablage_app_zurueck "$env"; return 5
        fi
    elif ! mkdir -m 0750 -- "$ziel" 2>/dev/null; then
        HOSTCONFIG_GRUND='Der Zielordner lässt sich nicht anlegen.'
        hostconfig_ablage_app_zurueck "$env"; return 5
    else
        # Neu angelegt: gehört wie der übergeordnete Ordner der Person, nicht root.
        chown -h -- "$(stat -c %u:%g -- "$(dirname -- "$ziel")")" "$ziel" 2>/dev/null || true
    fi
    hostconfig_ablage_kanonisch "$ziel" \
        || { HOSTCONFIG_GRUND='Der Zielordner ist eine Verknüpfung.'; hostconfig_ablage_app_zurueck "$env"; return 5; }

    if [[ -d "$alt" && -n "$(find "$alt" -mindepth 1 -print -quit 2>/dev/null)" ]]; then
        zahl_alt=$(hostconfig_ablage_zaehlen "$alt")
        hostconfig_fortschritt "" "${zahl_alt#*|}" kopie
        if ! cp -R --no-dereference --preserve=timestamps -- "$alt/." "$ziel/" 2>/dev/null; then
            HOSTCONFIG_GRUND='Kopieren fehlgeschlagen; die bisherige Ablage bleibt aktiv.'
            hostconfig_ablage_app_zurueck "$env"; return 1
        fi
        zahl_neu=$(hostconfig_ablage_zaehlen "$ziel")
        if [[ "$zahl_neu" != "$zahl_alt" || -n "$(find "$ziel" -type l -print -quit 2>/dev/null)" ]]; then
            HOSTCONFIG_GRUND='Die Kopie ist unvollständig; die bisherige Ablage bleibt aktiv.'
            hostconfig_ablage_app_zurueck "$env"; return 1
        fi
        chown -hR -- "$(stat -c %u:%g -- "$ziel")" "$ziel" 2>/dev/null || true
    fi
    # Unmittelbar vor dem Umhängen noch einmal: kein Teil des Pfads ist inzwischen eine Verknüpfung.
    hostconfig_ablage_kanonisch "$ziel" \
        || { HOSTCONFIG_GRUND='Der Zielordner wurde verändert.'; hostconfig_ablage_app_zurueck "$env"; return 5; }
    anzeige="$ziel"
    if hostconfig_ist_wsl && [[ "$ziel" == /mnt/[a-z]/* ]]; then
        anzeige=$(wslpath -w "$ziel" 2>/dev/null) || anzeige="$ziel"
    fi
    [[ "$anzeige" == *[[:cntrl:]\$\#\"\'\`]* ]] && anzeige="$ziel"
    hostconfig_env_setzen "$env" POSTBUCH_ABLAGE_DIR "$ziel" \
        && hostconfig_env_setzen "$env" POSTBUCH_ABLAGE_ANZEIGE "$anzeige" \
        || { hostconfig_ablage_app_zurueck "$env"; return 1; }
    hostconfig_fortschritt "" "" start_app
    if ! hostconfig_compose up -d --force-recreate --no-deps app >/dev/null 2>&1 \
        || ! hostconfig_service_bereit_warten app 300; then
        HOSTCONFIG_GRUND='Die Anwendung startete mit dem neuen Ordner nicht; die bisherige Ablage ist wieder aktiv.'
        hostconfig_ablage_app_zurueck "$env"; return 1
    fi
}

hostconfig_anwenden() { # $1 install-dir $2 typ $3 wert $4 secret(optional)
    local install="$1" typ="$2" wert="$3" secret="${4:-}" env="$1/.env" caddyfile="$1/caddy/Caddyfile"
    local scanner_war_aktiv=false caddy_war_aktiv=false embedding_war_aktiv=false lokalki_war_aktiv=false
    cd "$install" || return 1
    hostconfig_scanner_aktiv "$env" && scanner_war_aktiv=true
    hostconfig_embedding_aktiv "$env" && embedding_war_aktiv=true
    hostconfig_profil_aktiv "$env" lokalki && lokalki_war_aktiv=true
    hostconfig_service_laeuft caddy && caddy_war_aktiv=true
    rm -f -- "${env}.hostconfig.bak"
    rm -f -- "${caddyfile}.hostconfig.bak"
    case "$typ" in
        module)
            case "$wert" in
                scanner:an)
                    hostconfig_profil_setzen "$env" scanner an || return 1
                    hostconfig_compose --profile scanner build scanner cleaner \
                        || { hostconfig_ruecktausch "$env" "$typ" "$scanner_war_aktiv"; return 1; }
                    hostconfig_compose --profile scanner up -d --force-recreate --no-deps scanner cleaner \
                        || { hostconfig_ruecktausch "$env" "$typ" "$scanner_war_aktiv"; return 1; }
                    hostconfig_services_bereit scanner cleaner \
                        || { hostconfig_ruecktausch "$env" "$typ" "$scanner_war_aktiv"; return 1; }
                    ;;
                scanner:aus)
                    hostconfig_profil_setzen "$env" scanner aus || return 1
                    hostconfig_compose stop scanner cleaner \
                        || { hostconfig_ruecktausch "$env" "$typ" "$scanner_war_aktiv"; return 1; }
                    ;;
                embedding:an)
                    # Bauen nutzt den Cache: Ist das Image schon da, ist das
                    # ein kurzer Abgleich. Sonst lädt der Build das Modell.
                    hostconfig_profil_setzen "$env" embedding an || return 1
                    hostconfig_compose_befristet 3600 --profile embedding build embedding \
                        || { hostconfig_embedding_ruecktausch "$env" "$embedding_war_aktiv"; return 1; }
                    hostconfig_compose --profile embedding up -d --no-deps embedding \
                        || { hostconfig_embedding_ruecktausch "$env" "$embedding_war_aktiv"; return 1; }
                    hostconfig_service_bereit_warten embedding 120 \
                        || { hostconfig_embedding_ruecktausch "$env" "$embedding_war_aktiv"; return 1; }
                    ;;
                embedding:aus)
                    hostconfig_profil_setzen "$env" embedding aus || return 1
                    hostconfig_compose stop embedding \
                        || { hostconfig_embedding_ruecktausch "$env" "$embedding_war_aktiv"; return 1; }
                    ;;
                embedding:entfernen)
                    hostconfig_profil_setzen "$env" embedding aus || return 1
                    hostconfig_dienste_entfernen embedding '^postbuch-embedding:' embedding \
                        || { hostconfig_embedding_ruecktausch "$env" "$embedding_war_aktiv"; return 1; }
                    # Nachgeladene Modelle (Voyage, Gemma) sind nur Cache und
                    # lassen sich jederzeit neu holen; Fehlschlag ist kein Abbruch.
                    hostconfig_volume_entfernen embedding embedding-modelle
                    ;;
                scanner:entfernen)
                    hostconfig_profil_setzen "$env" scanner aus || return 1
                    hostconfig_dienste_entfernen scanner '(^|[-_/])(scanner|cleaner)(:latest)?$' scanner cleaner \
                        || { hostconfig_ruecktausch "$env" "$typ" "$scanner_war_aktiv"; return 1; }
                    ;;
                lokalki:an)       hostconfig_lokalki_an "$install" "$lokalki_war_aktiv" || return $? ;;
                lokalki:aus)      hostconfig_lokalki_aus "$install" "$lokalki_war_aktiv" || return 1 ;;
                lokalki:entfernen) hostconfig_lokalki_entfernen "$install" "$lokalki_war_aktiv" || return 1 ;;
                *) return 2 ;;
            esac
            ;;
        port)
            if ! { [[ "$wert" =~ ^[1-9][0-9]{1,4}$ ]] && (( wert >= 1024 && wert <= 65535 )); }; then
                HOSTCONFIG_GRUND='Erlaubt sind Ports von 1024 bis 65535. Es wurde nichts geändert.'
                return 2
            fi
            local alt_port basis neu_basis=''
            alt_port=$(grep '^WEB_PORT=' "$env" 2>/dev/null | tail -n1 | cut -d= -f2- || true)
            alt_port="${alt_port:-3420}"
            [[ "$wert" == "$alt_port" ]] && return 0
            # Weder ein Caddy-Port noch ein von einem fremden Dienst belegter
            # Port: Docker würde sonst erst beim Start scheitern.
            # `wert` ist an dieser Stelle eine geprüfte Zahl, keine freie Eingabe.
            if [[ "$wert" == "$(grep '^CADDY_HTTP_PORT=' "$env" | tail -n1 | cut -d= -f2-)" \
               || "$wert" == "$(grep '^CADDY_HTTPS_PORT=' "$env" | tail -n1 | cut -d= -f2-)" ]]; then
                HOSTCONFIG_GRUND="Port $wert ist hier schon für HTTP oder HTTPS vergeben. Es wurde nichts geändert."
                return 2
            fi
            if hostconfig_port_belegt "$wert"; then
                HOSTCONFIG_GRUND="Port $wert wird auf diesem System schon von einem anderen Dienst benutzt. Es wurde nichts geändert."
                return 2
            fi
            hostconfig_env_setzen "$env" WEB_PORT "$wert" || return 1
            # Eine Basisadresse mit dem bisherigen Port zieht mit; eine eigene
            # Adresse (Domain, Reverse-Proxy) bleibt unberührt.
            basis=$(grep '^APP_BASE_URL=' "$env" 2>/dev/null | tail -n1 | cut -d= -f2- || true)
            if [[ "$basis" =~ ^http://([A-Za-z0-9.-]+):${alt_port}/?$ ]]; then
                neu_basis="http://${BASH_REMATCH[1]}:$wert"
                hostconfig_env_setzen "$env" APP_BASE_URL "$neu_basis" || return 1
            fi
            if [[ -n "$neu_basis" ]]; then
                hostconfig_compose up -d --force-recreate --no-deps app web \
                    || { hostconfig_ruecktausch "$env" "$typ" "$scanner_war_aktiv"; return 1; }
                hostconfig_services_bereit app web \
                    || { hostconfig_ruecktausch "$env" "$typ" "$scanner_war_aktiv"; return 1; }
                hostconfig_app_host_db_setzen "$env" "$neu_basis" \
                    || { hostconfig_ruecktausch "$env" "$typ" "$scanner_war_aktiv"; return 1; }
            else
                hostconfig_compose up -d --force-recreate --no-deps web \
                    || { hostconfig_ruecktausch "$env" "$typ" "$scanner_war_aktiv"; return 1; }
                hostconfig_services_bereit web \
                    || { hostconfig_ruecktausch "$env" "$typ" "$scanner_war_aktiv"; return 1; }
            fi
            ;;
        netzwerk)
            [[ "$wert" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]{2,5})?/?$ ]] || return 2
            hostconfig_env_setzen "$env" APP_BASE_URL "$wert" || return 1
            hostconfig_compose up -d --force-recreate --no-deps app web \
                || { hostconfig_ruecktausch "$env" "$typ" "$scanner_war_aktiv"; return 1; }
            hostconfig_services_bereit app web \
                || { hostconfig_ruecktausch "$env" "$typ" "$scanner_war_aktiv"; return 1; }
            hostconfig_app_host_db_setzen "$env" "$wert" \
                || { hostconfig_ruecktausch "$env" "$typ" "$scanner_war_aktiv"; return 1; }
            ;;
        freigabe)
            # Scan-Webhook bzw. Oberfläche für das Heimnetz öffnen oder auf den
            # Host beschränken. Caddy und App erreichen die Dienste über das
            # Docker-Netz und sind von der Bindung nicht betroffen.
            case "$wert" in
                scanner:lan|scanner:lokal)
                    local scanner_bind=''
                    [[ "$wert" == scanner:lokal ]] && scanner_bind=127.0.0.1
                    hostconfig_env_setzen "$env" SCANNER_BIND "$scanner_bind" || return 1
                    hostconfig_scanner_neu_erstellen "$env" \
                        || { hostconfig_ruecktausch "$env" "$typ" "$scanner_war_aktiv"; return 1; }
                    ;;
                web:lan|web:lokal)
                    local web_bind=''
                    if [[ "$wert" == web:lokal ]]; then
                        # Ohne laufenden Caddy wäre die Oberfläche danach nur
                        # noch auf dem Host selbst erreichbar.
                        $caddy_war_aktiv || return 2
                        web_bind=127.0.0.1
                    fi
                    hostconfig_env_setzen "$env" WEB_BIND "$web_bind" || return 1
                    hostconfig_web_neu_erstellen \
                        || { hostconfig_ruecktausch "$env" "$typ" "$scanner_war_aktiv"; return 1; }
                    ;;
                *) return 2 ;;
            esac
            ;;
        duckdns)
            hostconfig_caddy_sichern "$caddyfile" || return 1
            local dd_basis dd_web dd_https dd_alt='' dd_neu='' dd_web_oeffnen=false
            dd_basis=$(hostconfig_env_lesen "$env" APP_BASE_URL)
            dd_web=$(hostconfig_env_lesen "$env" WEB_PORT); dd_web="${dd_web:-3420}"
            dd_https=$(hostconfig_env_lesen "$env" CADDY_HTTPS_PORT); dd_https="${dd_https:-443}"
            if [[ "$wert" == aus ]]; then
                [[ -z "$secret" ]] || return 2
                dd_alt=$(hostconfig_env_lesen "$env" DUCKDNS_DOMAIN)
                hostconfig_env_setzen "$env" DUCKDNS_DOMAIN '' || return 1
                hostconfig_env_setzen "$env" DUCKDNS_API_TOKEN '' \
                    || { hostconfig_ruecktausch "$env" "$typ" "$scanner_war_aktiv" "$caddy_war_aktiv" "$caddyfile"; return 1; }
                hostconfig_caddy_schreiben "$caddyfile" aus \
                    || { hostconfig_ruecktausch "$env" "$typ" "$scanner_war_aktiv" "$caddy_war_aktiv" "$caddyfile"; return 1; }
                hostconfig_compose stop caddy \
                    || { hostconfig_ruecktausch "$env" "$typ" "$scanner_war_aktiv" "$caddy_war_aktiv" "$caddyfile"; return 1; }
                # War die Oberfläche nur über HTTPS erreichbar, wäre sie ohne Caddy
                # von keinem anderen Gerät mehr zu erreichen: wieder fürs Heimnetz öffnen.
                if [[ "$(hostconfig_env_lesen "$env" WEB_BIND)" == 127.0.0.1 ]]; then
                    hostconfig_env_setzen "$env" WEB_BIND '' \
                        || { hostconfig_ruecktausch "$env" "$typ" "$scanner_war_aktiv" "$caddy_war_aktiv" "$caddyfile"; return 1; }
                    dd_web_oeffnen=true
                fi
                # Zeigte die Basisadresse auf die DuckDNS-Domain, gilt wieder die
                # Adresse über den Web-Port.
                if [[ -n "$dd_alt" && "$dd_basis" =~ ^https://${dd_alt//./\\.}(:[0-9]{2,5})?/?$ ]]; then
                    dd_neu="http://localhost:$dd_web"
                fi
            else
                [[ "$wert" =~ ^[a-z0-9-]{1,63}\.duckdns\.org$ ]] || return 2
                [[ "$secret" =~ ^[A-Za-z0-9._-]{8,256}$ ]] || return 2
                hostconfig_env_setzen "$env" DUCKDNS_DOMAIN "$wert" || return 1
                hostconfig_env_setzen "$env" DUCKDNS_API_TOKEN "$secret" \
                    || { hostconfig_ruecktausch "$env" "$typ" "$scanner_war_aktiv" "$caddy_war_aktiv" "$caddyfile"; return 1; }
                hostconfig_caddy_schreiben "$caddyfile" an \
                    || { hostconfig_ruecktausch "$env" "$typ" "$scanner_war_aktiv" "$caddy_war_aktiv" "$caddyfile"; return 1; }
                hostconfig_compose --profile caddy up -d --build --force-recreate --no-deps caddy \
                    || { hostconfig_ruecktausch "$env" "$typ" "$scanner_war_aktiv" "$caddy_war_aktiv" "$caddyfile"; return 1; }
                hostconfig_services_bereit caddy \
                    || { hostconfig_ruecktausch "$env" "$typ" "$scanner_war_aktiv" "$caddy_war_aktiv" "$caddyfile"; return 1; }
                # Eine Basisadresse, die noch auf den Web-Port oder eine frühere
                # DuckDNS-Domain zeigt, wechselt auf die neue HTTPS-Adresse samt
                # abweichendem Port. Eine eigene Adresse bleibt unberührt.
                if [[ -z "$dd_basis" || "$dd_basis" =~ ^http://[A-Za-z0-9.-]+:${dd_web}/?$ \
                   || "$dd_basis" =~ ^https://[a-z0-9-]+\.duckdns\.org(:[0-9]{2,5})?/?$ ]]; then
                    dd_neu="https://$wert"
                    [[ "$dd_https" == 443 ]] || dd_neu+=":$dd_https"
                fi
            fi
            if [[ -n "$dd_neu" && "$dd_neu" != "${dd_basis%/}" ]]; then
                hostconfig_env_setzen "$env" APP_BASE_URL "$dd_neu" \
                    || { hostconfig_ruecktausch "$env" "$typ" "$scanner_war_aktiv" "$caddy_war_aktiv" "$caddyfile"; return 1; }
                hostconfig_compose up -d --force-recreate --no-deps app web \
                    || { hostconfig_ruecktausch "$env" "$typ" "$scanner_war_aktiv" "$caddy_war_aktiv" "$caddyfile"; return 1; }
                hostconfig_services_bereit app web \
                    || { hostconfig_ruecktausch "$env" "$typ" "$scanner_war_aktiv" "$caddy_war_aktiv" "$caddyfile"; return 1; }
                hostconfig_app_host_db_setzen "$env" "$dd_neu" \
                    || { hostconfig_ruecktausch "$env" "$typ" "$scanner_war_aktiv" "$caddy_war_aktiv" "$caddyfile"; return 1; }
            elif [[ "$dd_web_oeffnen" == true ]]; then
                hostconfig_web_neu_erstellen \
                    || { hostconfig_ruecktausch "$env" "$typ" "$scanner_war_aktiv" "$caddy_war_aktiv" "$caddyfile"; return 1; }
            fi
            ;;
        ablage)
            [[ "$wert" == setzen ]] || return 2
            hostconfig_ablage_setzen "$install" "$secret" || return $?
            ;;
        *) return 2 ;;
    esac
    rm -f -- "${env}.hostconfig.bak"
    rm -f -- "${caddyfile}.hostconfig.bak"
}
