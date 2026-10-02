#!/usr/bin/env bash
# Isolierter Phase-0-Harness. Er führt niemals den Installer und niemals echtes
# Docker/sudo aus; getestet werden die Build-/Profilfunktionen mit Fakes.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
FUNCS="$TMP/functions.sh"
LOG="$TMP/calls.log"

awk '/^scanner_profil_aktiv\(\)/,/^# ── restart.sh generieren/' "$ROOT/deploy-pages/install.sh" \
  | sed '$d' > "$FUNCS"

# Docker-Rechteart: Einzelbefehle müssen denselben promptfreien sudo-Pfad wie
# Compose nehmen. Das echte docker/sudo wird dabei nie aufgerufen.
awk '/^docker_runtime\(\)/,/^}/' "$ROOT/deploy-pages/install.sh" > "$TMP/docker-runtime.sh"
source "$TMP/docker-runtime.sh"
docker() { printf 'direct %s\n' "$*" >> "$LOG"; }
sudo() { printf 'sudo %s\n' "$*" >> "$LOG"; }
OPT_NON_INTERACTIVE=true; DOCKER_COMPOSE='docker compose'; : > "$LOG"
docker_runtime image inspect testbild
grep -q '^direct image inspect testbild$' "$LOG"
DOCKER_COMPOSE='sudo docker compose'; : > "$LOG"
docker_runtime image inspect testbild
grep -q '^sudo -n docker image inspect testbild$' "$LOG"

# Debian 13 liefert Compose als Paket docker-compose. Die ersten beiden
# Paketnamen fehlen dort; der dritte Versuch muss Docker mit installieren.
# Danach darf ein neu angelegter Docker-Gruppeneintrag den Installationslauf
# nicht beenden: die bereits erfragten Werte liegen noch im selben Prozess.
awk '/^if ! command -v docker &>\/dev\/null; then/,/^# docker compose \(Plugin oder standalone\)/' \
  "$ROOT/deploy-pages/install.sh" | sed '$d' > "$TMP/docker-install.sh"
(
  MODE=install USER=tester
  command() {
    if [[ "$1" == -v && "$2" == docker ]]; then return 1; fi
    builtin command "$@"
  }
  sudo() {
    printf '%s\n' "$*" >> "$LOG"
    if [[ "$1 $2 ${3:-}" == 'apt-get install -y' ]]; then
      [[ "$*" == 'apt-get install -y docker.io docker-compose' ]]
    fi
  }
  getent() { return 0; }
  info() { :; }
  warn() { :; }
  error() { return 1; }
  source "$TMP/docker-install.sh"
  printf 'weiter\n' > "$TMP/docker-install-weiter"
)
grep -q '^weiter$' "$TMP/docker-install-weiter"
grep -q '^apt-get install -y docker.io docker-compose-plugin$' "$LOG"
grep -q '^apt-get install -y docker.io docker-compose-v2$' "$LOG"
grep -q '^apt-get install -y docker.io docker-compose$' "$LOG"

# Die noch nicht wirksame Gruppenzugehörigkeit braucht im selben Prozess nur
# einen geprüften sudo-Daemonzugriff. Der Installer verwendet danach Compose
# mit sudo und behält seine Eingaben.
awk '/^# Docker-Daemon erreichbar\?/,/^success "Alle Voraussetzungen erfüllt\."/' \
  "$ROOT/deploy-pages/install.sh" > "$TMP/docker-zugriff.sh"
(
  docker() { [[ "$1" != info ]]; }
  sudo() { printf '%s\n' "$*" >> "$LOG"; }
  getent() { return 0; }
  warn() { :; }
  success() { :; }
  error() { return 1; }
  DOCKER_COMPOSE=''
  source "$TMP/docker-zugriff.sh"
  [[ "$DOCKER_COMPOSE" == 'sudo docker compose' ]]
)
grep -q '^docker info$' "$LOG"
grep -q '^usermod -aG docker ' "$LOG"

fake_compose() {
  printf 'compose %s\n' "$*" >> "$LOG"
  [[ "$1" == images && "$2" == -q ]] && printf 'image-%s\n' "$3"
  return 0
}
info() { :; }
warn() { :; }
error() { :; }
docker_runtime() {
  printf 'docker %s\n' "$*" >> "$LOG"
  [[ "$1 $2 $3" == "inspect postbuch-scanner --format" ]] && return 1
  [[ "$1 $2 $3" == "image inspect postbuch-caddy:local2" ]] && return "${CADDY_FEHLT:-1}"
  return 0
}
upsert_env_value() {
  local file="$1" key="$2" value="$3"
  if grep -q "^${key}=" "$file" 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}
export -f fake_compose docker_runtime upsert_env_value info warn error
export DOCKER_COMPOSE=fake_compose SAFE_MODE=false WEB_BUILD_NODE_OPTIONS=''

cd "$TMP"
printf 'COMPOSE_PROFILES=scanner\n' > .env
# shellcheck disable=SC1090
source "$FUNCS"

# Auch ein vollstaendig stiller Build muss regelmaessig Ausgabe erzeugen.
# Sein Exit-Code darf durch das Lebenszeichen nicht verdeckt werden.
lebenszeichen=$(build_mit_lebenszeichen "Testbuild" 1 bash -c 'sleep 2')
grep -q 'Testbuild: Build läuft noch' <<< "$lebenszeichen"
if build_mit_lebenszeichen "Fehltest" 1 false >/dev/null; then
  echo 'Fehlgeschlagener Build wurde als Erfolg gemeldet.' >&2
  exit 1
else
  [[ "$?" -eq 1 ]]
fi

# Nur eindeutig transiente Docker-/Registry-Fehler werden wiederholt. Der
# Harness ersetzt sleep, damit die Backoff-Pruefung ohne Wartezeit laeuft.
RETRY_COUNT_FILE="$TMP/retry-count"
printf '0\n' > "$RETRY_COUNT_FILE"
retry_pausen=""
sleep() { retry_pausen="${retry_pausen}${retry_pausen:+ }$1"; }
fake_transient() {
  retry_aufrufe=$(cat "$RETRY_COUNT_FILE")
  retry_aufrufe=$((retry_aufrufe + 1))
  printf '%s\n' "$retry_aufrufe" > "$RETRY_COUNT_FILE"
  if [[ "$retry_aufrufe" -lt 3 ]]; then
    echo 'failed to authorize: dial tcp: lookup auth.docker.io on 192.168.192.1:53: i/o timeout' >&2
    return 1
  fi
  return 0
}
docker_mit_netzwerk_retry Test fake_transient >/dev/null 2>&1
[[ "$(cat "$RETRY_COUNT_FILE")" -eq 3 ]]
[[ "$retry_pausen" == '5 10' ]]

printf '0\n' > "$RETRY_COUNT_FILE"
retry_pausen=""
fake_permanent() {
  retry_aufrufe=$(cat "$RETRY_COUNT_FILE")
  retry_aufrufe=$((retry_aufrufe + 1))
  printf '%s\n' "$retry_aufrufe" > "$RETRY_COUNT_FILE"
  echo 'failed to solve: Dockerfile parse error on line 7' >&2
  return 17
}
retry_status=0
docker_mit_netzwerk_retry Test fake_permanent >/dev/null 2>&1 || retry_status=$?
[[ "$retry_status" -eq 17 ]]
[[ "$(cat "$RETRY_COUNT_FILE")" -eq 1 ]]
[[ -z "$retry_pausen" ]]

printf '0\n' > "$RETRY_COUNT_FILE"
retry_pausen=""
fake_immer_transient() {
  retry_aufrufe=$(cat "$RETRY_COUNT_FILE")
  printf '%s\n' "$((retry_aufrufe + 1))" > "$RETRY_COUNT_FILE"
  echo 'Get "https://registry-1.docker.io/v2/": TLS handshake timeout' >&2
  return 23
}
retry_status=0
docker_mit_netzwerk_retry Test fake_immer_transient >/dev/null 2>&1 || retry_status=$?
[[ "$retry_status" -eq 23 ]]
[[ "$(cat "$RETRY_COUNT_FILE")" -eq 5 ]]
[[ "$retry_pausen" == '5 10 20 40' ]]

printf 'failed permanently near digest sha256:a503b\n' > "$TMP/permanent-output"
! docker_fehler_ist_transient "$TMP/permanent-output"

: > "$LOG"; compose_build
grep -q 'compose build app web scanner cleaner' "$LOG"

# Frisch installierter Docker-Daemon: aktuelle Shell noch ohne Gruppenrecht.
# Der echte Build-Pfad muss die geprüfte sudo-Variante übernehmen.
DOCKER_COMPOSE='sudo docker compose'
: > "$LOG"; compose_build
grep -q '^sudo docker compose build app web scanner cleaner$' "$LOG"
DOCKER_COMPOSE=fake_compose

printf 'COMPOSE_PROFILES=\n' > .env
: > "$LOG"; compose_build
grep -q 'compose build app web$' "$LOG"
! grep -qE 'scanner|cleaner' "$LOG"

: > "$LOG"; compose_build kein-code-build
! grep -q 'compose build' "$LOG"

printf 'COMPOSE_PROFILES=scanner\n' > .env
CADDY_FEHLT=0; export CADDY_FEHLT
: > "$LOG"; compose_build caddy app
grep -q 'docker image inspect postbuch-caddy:local2' "$LOG"
! grep -q 'compose --profile caddy build caddy' "$LOG"
grep -q 'compose build app' "$LOG"

# Fehlendes Caddy-Image und leeres Wrapper-Argument sind getrennte Regressionen.
CADDY_FEHLT=1; export CADDY_FEHLT
: > "$LOG"; compose_build caddy app
grep -q 'compose --profile caddy build caddy' "$LOG"
grep -q 'compose build app' "$LOG"
: > "$LOG"; compose_up_build ''
! grep -q 'compose build $' "$LOG"

ALT="$TMP/alt"; NEU="$TMP/neu"; mkdir -p "$ALT/app" "$ALT/web" "$ALT/scanner" "$ALT/cleaner" "$NEU/app" "$NEU/web" "$NEU/scanner" "$NEU/cleaner"
printf x > "$ALT/app/a"; printf y > "$NEU/app/a"; printf z > "$ALT/web/a"; printf z > "$NEU/web/a"
printf same > "$ALT/docker-compose.yml"; cp "$ALT/docker-compose.yml" "$NEU/docker-compose.yml"
printf 'COMPOSE_PROFILES=\n' > .env
update_build_services_bestimmen "$ALT" "$NEU"
[[ " ${UPDATE_BUILD_SERVICES[*]} " == *' app '* ]]
[[ " ${UPDATE_BUILD_SERVICES[*]} " != *' scanner '* ]]

# VERSION steckt in app UND web. Ein Patch-Release darf niemals nur das
# Frontend neu bauen und dadurch ein Update auf sich selbst anzeigen.
printf x > "$NEU/app/a"
printf 2.6.2 > "$ALT/VERSION"; printf 2.6.3 > "$NEU/VERSION"
update_build_services_bestimmen "$ALT" "$NEU"
[[ " ${UPDATE_BUILD_SERVICES[*]} " == *' app '* ]]
[[ " ${UPDATE_BUILD_SERVICES[*]} " == *' web '* ]]
rm -f "$ALT/VERSION" "$NEU/VERSION"

# Nur Scanner geändert: aktiv => ausschließlich Scanner; inaktiv => kein Build.
printf x > "$ALT/scanner/a"; printf y > "$NEU/scanner/a"
printf x > "$ALT/app/a"; printf x > "$NEU/app/a"
printf 'COMPOSE_PROFILES=scanner\n' > .env
update_build_services_bestimmen "$ALT" "$NEU"
[[ " ${UPDATE_BUILD_SERVICES[*]} " == *' scanner '* ]]
[[ " ${UPDATE_BUILD_SERVICES[*]} " != *' app '* ]]
printf 'COMPOSE_PROFILES=\n' > .env
update_build_services_bestimmen "$ALT" "$NEU"
[[ "${UPDATE_BUILD_SERVICES[*]}" == kein-code-build ]]

# Compose-Diff baut fail-safe nur die aktiven Profile.
printf anders > "$NEU/docker-compose.yml"
update_build_services_bestimmen "$ALT" "$NEU"
[[ " ${UPDATE_BUILD_SERVICES[*]} " == *' app '* ]]
[[ " ${UPDATE_BUILD_SERVICES[*]} " == *' web '* ]]
[[ " ${UPDATE_BUILD_SERVICES[*]} " != *' scanner '* ]]

# Headless-Verträge: kein /dev/tty/plain sudo, nichtleerer Dump vor Promotion,
# Agent-Refresh muss Fehler weiterreichen. Diese Assertions prüfen den echten
# Kontrollfluss des Installers, ohne ihn auf diesem Host auszuführen.
HEADLESS=$(awk '/^headless_update\(\)/,/^}/' "$ROOT/deploy-pages/install.sh")
! grep -q '/dev/tty' <<< "$HEADLESS"
grep -q -- '-s "\$BACKUP_RESULT/db.sql.gz"' <<< "$HEADLESS"
grep -q 'if ! aktualisiere_vorhandenen_update_agent' <<< "$HEADLESS"
grep -q 'sudo -n docker info' "$ROOT/deploy-pages/install.sh"
! grep -q 'sudo docker info' <<< "$HEADLESS"

# Regenerierbare Cache-Daten duerfen weder Update-Backups aufblaehen noch nach
# einem Restore einen scheinbar fertigen, tatsaechlich leeren Hilfekorpus bilden.
INSTALLER_BACKUP=$(awk '/^backup_current_installation\(\)/,/^}/' "$ROOT/deploy-pages/install.sh")
grep -q -- "--exclude-table-data='postbuch.post_files'" <<< "$INSTALLER_BACKUP"
grep -q -- "--exclude-table-data='postbuch._hilfe_abschnitt'" <<< "$INSTALLER_BACKUP"
grep -q -- "--exclude-table-data='postbuch._hilfe_korpus'" <<< "$INSTALLER_BACKUP"

# Ein DB-Rollback ersetzt die neuere Datenbank vollständig und importiert den
# alten Dump fail-closed. Plain `pg_dump --clean` allein reicht nicht, weil ihm
# neuere, den DROP blockierende Objekte unbekannt sind.
ROLLBACK=$(awk '/^do_rollback\(\)/,/^}/' "$ROOT/deploy-pages/install.sh")
grep -q 'gzip -t "\$SELECTED/db.sql.gz"' <<< "$ROLLBACK"
grep -q 'dropdb .*--if-exists --force' <<< "$ROLLBACK"
grep -q 'createdb ' <<< "$ROLLBACK"
grep -q 'psql -v ON_ERROR_STOP=1 --single-transaction' <<< "$ROLLBACK"
grep -q 'rollback_service_worker_absichern' <<< "$ROLLBACK"
! grep -q "addEventListener('fetch'" "$ROOT/web/public/service-worker.js"
ROLLBACK_SW=$(awk '/^rollback_service_worker_absichern\(\)/,/^}/' "$ROOT/deploy-pages/install.sh")
! grep -q "addEventListener('fetch'" <<< "$ROLLBACK_SW"

# Jeder kritische Agent-Installationsschritt ist fail-closed; Erfolg steht erst
# hinter daemon-reload, enable und beiden Statusprüfungen.
AGENT=$(awk '/^install_update_agent\(\)/,/^}/' "$ROOT/deploy-pages/install.sh")
for punkt in 'mkdir -p' 'cp -f' 'chmod 755' 'tee "$AGENT_CONF"' \
             'systemctl daemon-reload' 'systemctl enable --now' \
             'systemctl is-enabled' 'systemctl is-active'; do
  grep -q "$punkt" <<< "$AGENT"
done
[[ $(grep -n 'success "Update-Agent' <<< "$AGENT" | cut -d: -f1) -gt \
   $(grep -n 'systemctl is-active' <<< "$AGENT" | cut -d: -f1) ]]

# Tatsächlicher Headless-Kontrollfluss mit Fakes: fehlender/leer gebliebener
# Dump stoppt vor Build/Promotion; ein Refresh-Fehler bleibt nach Recreate
# sichtbar nonzero. stdin ist dabei geschlossen und es existiert kein TTY.
awk '/^headless_update\(\)/,/^}/' "$ROOT/deploy-pages/install.sh" > "$TMP/headless.sh"
run_headless_case() (
  local modus="$1" lauflog="$TMP/headless-$1.log" inst="$TMP/install-$1" stage="$TMP/stage-$1" backup="$TMP/backup-$1"
  mkdir -p "$inst"; printf 'x\n' > "$inst/docker-compose.yml"; printf 'x\n' > "$inst/.env"; printf '1\n' > "$inst/VERSION"
  printf tar > "$TMP/release.tar.gz"
  source "$TMP/headless.sh"
  OPT_INSTALL_DIR="$inst" DEFAULT_INSTALL_DIR="$inst" OPT_DRY_RUN=false LOCAL_TARBALL="$TMP/release.tar.gz"
  RELEASE_STAGE="$stage" ERWARTETE_SHA=a FEED_AUTH_B64=''
  docker_headless_pruefen(){ :; }; safe_mode_headless(){ :; }; bezugsquelle_sicherstellen(){ :; }
  feed_auth_aus_env(){ :; }; feed_auth_uebernehmen(){ :; }; feed_auth_probe(){ :; }
  env_single_quote(){ printf "'%s'" "$1"; }; installations_besitzer_bestimmen(){ printf '1000:1000\n'; }
  release_persistente_besitzer_wiederherstellen(){ :; }; backup_altbestand_besitz_sicherstellen(){ :; }
  warte_auf_app_gesund(){ :; }
  manifest_gate(){ ERWARTETE_SHA=a; }; pruefe_sha256(){ :; }; phase(){ printf 'phase %s\n' "$*" >> "$lauflog"; }
  release_stage_erstellen(){ mkdir -p "$stage"; printf '2\n' > "$stage/VERSION"; RELEASE_STAGE="$stage"; }
  safe_rm_rf(){ :; }; update_build_services_bestimmen(){ UPDATE_BUILD_SERVICES=(app); }
  compose_build(){ printf 'build\n' >> "$lauflog"; }; release_stage_promoten(){ printf 'promote\n' >> "$lauflog"; }
  write_restart_script(){ :; }; compose_recreate(){ printf 'recreate\n' >> "$lauflog"; }
  aktualisiere_vorhandenen_update_agent(){ printf 'refresh\n' >> "$lauflog"; [[ "$modus" != refresh_fail ]]; }
  backup_current_installation(){
    [[ "$modus" != backup_fail ]] || return 1
    mkdir -p "$backup"
    [[ "$modus" != backup_empty ]] && printf dump > "$backup/db.sql.gz"
    printf '%s\n' "$backup"
  }
  headless_update </dev/null
)
for modus in backup_fail backup_empty; do
  if run_headless_case "$modus"; then exit 1; fi
  ! grep -qE 'build|promote|recreate' "$TMP/headless-$modus.log"
done
if run_headless_case refresh_fail; then exit 1; fi
grep -q recreate "$TMP/headless-refresh_fail.log"
grep -q refresh "$TMP/headless-refresh_fail.log"

# Tatsächliche Agent-Installationsfunktion mit vollständig gefakten
# Systembefehlen. Jeder kritische Fehlerpunkt liefert nonzero und niemals den
# Erfolgstext; weder /etc noch /usr/local werden berührt.
awk '/^install_update_agent\(\)/,/^}/' "$ROOT/deploy-pages/install.sh" > "$TMP/install-agent.sh"
run_agent_failure() (
  local fail="$1" inst="$TMP/agent-install"; mkdir -p "$inst/scripts" "$inst/deploy-pages"
  : > "$inst/scripts/postbuch-update-agent.sh"; : > "$inst/scripts/postbuch-hostconfig.sh"; : > "$inst/deploy-pages/install.sh"
  source "$TMP/install-agent.sh"
  INSTALL_DIR="$inst" AGENT_LIB="$TMP/agent-lib" AGENT_CONF="$TMP/agent.conf" AGENT_LOG="$TMP/agent-$fail.log"
  installations_besitzer_bestimmen(){ printf '1000:1000\n'; }
  warn(){ printf 'warn %s\n' "$*" >> "$AGENT_LOG"; }; success(){ printf 'success %s\n' "$*" >> "$AGENT_LOG"; }
  id(){ [[ "$1" == -u ]] && printf '0\n'; }
  fake_step(){ printf '%s %s\n' "$1" "${*:2}" >> "$AGENT_LOG"; [[ "$fail" != "$1" && "$fail" != "$1 ${*:2}" ]]; }
  mkdir(){ fake_step mkdir "$@"; }; cp(){ fake_step cp "$@"; }; chmod(){ fake_step chmod "$@"; }
  chown(){ fake_step chown "$@"; }; tee(){ while IFS= read -r _; do :; done; fake_step tee "$@"; }
  systemctl(){ fake_step systemctl "$@"; }
  install_update_agent normal
)
for fail in mkdir cp chmod tee 'systemctl daemon-reload' 'systemctl enable --now postbuch-update-agent.timer' \
            'systemctl is-enabled --quiet postbuch-update-agent.timer' 'systemctl is-active --quiet postbuch-update-agent.timer'; do
  if run_agent_failure "$fail"; then exit 1; fi
  ! grep -q '^success ' "$TMP/agent-$fail.log"
done

bash -n "$ROOT/deploy-pages/install.sh" "$ROOT/scripts/postbuch-update-agent.sh" "$ROOT/scripts/postbuch-hostconfig.sh"
printf 'Phase-0-Harness: OK\n'
