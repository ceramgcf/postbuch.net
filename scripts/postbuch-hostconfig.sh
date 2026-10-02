#!/usr/bin/env bash
# Gemeinsame, strikt whitelistete Host-Konfiguration für Installer und P2-Agent.
# Kein eval/source, keine freie Shell und keine Ausgabe von Werten.

hostconfig_docker() {
    if [[ "${DOCKER_ART:-direkt}" == "sudo" ]]; then sudo -n docker "$@"; else docker "$@"; fi
}
hostconfig_compose() {
    if [[ "${DOCKER_ART:-direkt}" == "sudo" ]]; then sudo -n docker compose "$@"; else docker compose "$@"; fi
}

hostconfig_env_setzen() { # $1 Datei, $2 Key, $3 Wert
    local datei="$1" key="$2" wert="$3" tmp backup gefunden=false
    case "$key" in
        COMPOSE_PROFILES|WEB_PORT|APP_BASE_URL|DUCKDNS_DOMAIN|DUCKDNS_API_TOKEN) ;;
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
          '{env.DUCKDNS_DOMAIN} {' \
          '    tls {' \
          '        dns duckdns {env.DUCKDNS_API_TOKEN}' \
          '        resolvers 8.8.8.8 1.1.1.1' \
          '    }' \
          '    reverse_proxy web:80' \
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

hostconfig_scanner_aktiv() { # $1 env
    local profile
    profile=$(grep '^COMPOSE_PROFILES=' "$1" 2>/dev/null | tail -n1 | cut -d= -f2- || true)
    [[ ",$profile," == *,scanner,* ]]
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
        port) hostconfig_compose up -d --force-recreate --no-deps web || true ;;
        netzwerk) hostconfig_compose up -d --force-recreate --no-deps app web || true ;;
        duckdns)
            [[ -n "$caddyfile" ]] && hostconfig_caddy_rollback "$caddyfile" || true
            if [[ "$caddy_war_aktiv" == true ]]; then
                hostconfig_compose --profile caddy up -d --force-recreate --no-deps caddy || true
            else
                hostconfig_compose stop caddy || true
            fi
            ;;
    esac
    return 1
}

hostconfig_anwenden() { # $1 install-dir $2 typ $3 wert $4 secret(optional)
    local install="$1" typ="$2" wert="$3" secret="${4:-}" env="$1/.env" caddyfile="$1/caddy/Caddyfile"
    local scanner_war_aktiv=false caddy_war_aktiv=false
    cd "$install" || return 1
    hostconfig_scanner_aktiv "$env" && scanner_war_aktiv=true
    hostconfig_service_laeuft caddy && caddy_war_aktiv=true
    rm -f -- "${env}.hostconfig.bak"
    rm -f -- "${caddyfile}.hostconfig.bak"
    case "$typ" in
        module)
            case "$wert" in
                scanner:an)
                    hostconfig_env_setzen "$env" COMPOSE_PROFILES scanner || return 1
                    hostconfig_compose --profile scanner build scanner cleaner \
                        || { hostconfig_ruecktausch "$env" "$typ" "$scanner_war_aktiv"; return 1; }
                    hostconfig_compose --profile scanner up -d --force-recreate --no-deps scanner cleaner \
                        || { hostconfig_ruecktausch "$env" "$typ" "$scanner_war_aktiv"; return 1; }
                    hostconfig_services_bereit scanner cleaner \
                        || { hostconfig_ruecktausch "$env" "$typ" "$scanner_war_aktiv"; return 1; }
                    ;;
                scanner:aus)
                    hostconfig_env_setzen "$env" COMPOSE_PROFILES '' || return 1
                    hostconfig_compose stop scanner cleaner \
                        || { hostconfig_ruecktausch "$env" "$typ" "$scanner_war_aktiv"; return 1; }
                    ;;
                *) return 2 ;;
            esac
            ;;
        port)
            [[ "$wert" =~ ^[0-9]{2,5}$ ]] && (( wert >= 1024 && wert <= 65535 )) || return 2
            hostconfig_env_setzen "$env" WEB_PORT "$wert" || return 1
            hostconfig_compose up -d --force-recreate --no-deps web \
                || { hostconfig_ruecktausch "$env" "$typ" "$scanner_war_aktiv"; return 1; }
            hostconfig_services_bereit web \
                || { hostconfig_ruecktausch "$env" "$typ" "$scanner_war_aktiv"; return 1; }
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
        duckdns)
            hostconfig_caddy_sichern "$caddyfile" || return 1
            if [[ "$wert" == aus ]]; then
                [[ -z "$secret" ]] || return 2
                hostconfig_env_setzen "$env" DUCKDNS_DOMAIN '' || return 1
                hostconfig_env_setzen "$env" DUCKDNS_API_TOKEN '' \
                    || { hostconfig_ruecktausch "$env" "$typ" "$scanner_war_aktiv" "$caddy_war_aktiv" "$caddyfile"; return 1; }
                hostconfig_caddy_schreiben "$caddyfile" aus \
                    || { hostconfig_ruecktausch "$env" "$typ" "$scanner_war_aktiv" "$caddy_war_aktiv" "$caddyfile"; return 1; }
                hostconfig_compose stop caddy \
                    || { hostconfig_ruecktausch "$env" "$typ" "$scanner_war_aktiv" "$caddy_war_aktiv" "$caddyfile"; return 1; }
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
            fi
            ;;
        *) return 2 ;;
    esac
    rm -f -- "${env}.hostconfig.bak"
    rm -f -- "${caddyfile}.hostconfig.bak"
}
