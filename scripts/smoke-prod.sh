#!/usr/bin/env sh
# Production smoke test (Stage 09a; docs/TESTING.md §8, docs/DEPLOYMENT.md). Starts docker-compose.yml as the
# project blinq-smoke with TLS_MODE=internal and DOMAIN=blinq.localhost, runs tests/smoke-prod/*.spec.ts in the
# pinned Playwright image on the host network, and checks what the specs cannot see: container hardening, the host's
# listening sockets, a restart, and every container log for secrets.
#
#   sh scripts/smoke-prod.sh [--keep] [--no-build]
#
#   --keep      leave the stack, its volumes and .env.smoke in place afterwards (docker compose -p blinq-smoke ...)
#   --no-build  use the existing blinq-app:local and blinq-caddy:local images (CI builds them with its layer cache)
#
# Linux (CI) and macOS with Docker Desktop both work: there the "host" network is the Docker VM, so every host-level
# step (listeners, node IP, the browsers) runs in a container on the host network, never on the Mac itself. Ports that
# are already taken (for example the dev stack's LiveKit on 127.0.0.1:7880) are moved; 80 and 443 must be free.
# Output: logs/smoke-prod/ (summary, compose.log, listeners, Playwright report and traces). The whole run holds the
# machine-wide heavy lock (scripts/with-lock.sh).
set -eu

cd "$(dirname "$0")/.."
ROOT=$(pwd -P)

keep=0
build=1
for arg in "$@"; do
  case "$arg" in
    --keep) keep=1 ;;
    --no-build) build=0 ;;
    -h | --help)
      sed -n '2,18s/^# \{0,1\}//p' "$0"
      exit 0
      ;;
    *)
      echo "smoke-prod: unknown option '$arg' (see --help)" >&2
      exit 2
      ;;
  esac
done

# Re-run under the lock unless this process already holds it (with-lock.sh exports its pid as BLINQ_LOCK_HELD).
if [ -z "${BLINQ_LOCK_HELD:-}" ] ||
  [ "$(cat "${BLINQ_LOCK_DIR:-/tmp/blinq-heavy.lock}/pid" 2> /dev/null || true)" != "$BLINQ_LOCK_HELD" ]; then
  exec sh scripts/with-lock.sh sh scripts/smoke-prod.sh "$@"
fi

# Only .env.smoke may decide: Compose lets the shell's variables override the env file.
# shellcheck disable=SC2013 # variable names, one word each; a while loop in a pipe could not unset them here
for name in $(sed -n 's/^#\{0,1\} \{0,1\}\([A-Z][A-Z0-9_]*\)=.*/\1/p' .env.example | sort -u); do
  unset "$name"
done
unset COMPOSE_PROJECT_NAME COMPOSE_FILE COMPOSE_PROFILES COMPOSE_ENV_FILES

PROJECT=blinq-smoke
ENV_FILE=$ROOT/.env.smoke
OUT=$ROOT/logs/smoke-prod
SUMMARY=$OUT/summary.txt
PLAYWRIGHT_IMAGE=mcr.microsoft.com/playwright:v1.63.0-noble
# Any image with busybox netstat and ip; this one is part of the stack anyway.
HELPER_IMAGE=postgres:18-alpine
SMOKE_DOMAIN=blinq.localhost
SMOKE_TURN_DOMAIN=turn.blinq.localhost
RTC_START=50000
RTC_END=60000

mkdir -p "$OUT"
rm -rf "$OUT/results" "$OUT/report"
: > "$SUMMARY"
run_start=$(date +%s)

failures=0
log() { printf 'smoke-prod: %s\n' "$*" >&2; }
pass() { printf '  ok    %s\n' "$*" | tee -a "$SUMMARY"; }
failed() {
  printf '  FAIL  %s\n' "$*" | tee -a "$SUMMARY"
  failures=$((failures + 1))
}
note() { printf '  note  %s\n' "$*" | tee -a "$SUMMARY"; }
section() { printf '\n%s\n' "$*" | tee -a "$SUMMARY"; }
die() {
  failed "$*"
  exit 1
}

compose() { docker compose -p "$PROJECT" --env-file "$ENV_FILE" -f "$ROOT/docker-compose.yml" "$@"; }
container() { compose ps -a -q "$1"; }
env_value() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1; }

started=0
# shellcheck disable=SC2329 # invoked by the EXIT trap
finish() {
  status=$?
  trap - EXIT INT TERM
  if [ "$started" -eq 1 ]; then
    compose logs --no-color --timestamps > "$OUT/compose.log" 2>&1 || true
    compose ps -a > "$OUT/compose-ps.txt" 2>&1 || true
    if [ "$keep" -eq 1 ]; then
      log "--keep: the stack is still running (docker compose -p $PROJECT --env-file .env.smoke ps)"
    else
      compose down -v --remove-orphans --timeout 20 > /dev/null 2>&1 || true
    fi
  fi
  [ "$keep" -eq 1 ] || rm -f "$ENV_FILE" "$ENV_FILE.missing"
  if [ "$status" -eq 0 ] && [ "$failures" -gt 0 ]; then status=1; fi
  printf '\n' >&2
  elapsed="$(($(date +%s) - run_start)) s"
  if [ "$status" -eq 0 ]; then
    log "passed in $elapsed (summary: $SUMMARY)"
  else
    log "FAILED with $failures failed check(s) after $elapsed (summary: $SUMMARY; logs: $OUT/compose.log; report: $OUT/report)"
  fi
  exit "$status"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# --- Host: helper image, listeners before the start, node IP, free ports -------------------------------------------

docker image inspect "$HELPER_IMAGE" > /dev/null 2>&1 || docker pull -q "$HELPER_IMAGE" > /dev/null

# Listening sockets of the host network namespace (the Docker VM on macOS): "proto scope port address program".
listeners() {
  docker run --rm --network host --pid host --cap-add SYS_PTRACE --entrypoint netstat "$HELPER_IMAGE" -tulnp 2> /dev/null |
    awk '$1 ~ /^(tcp|udp)/ {
      proto = substr($1, 1, 3)
      n = split($4, parts, ":")
      port = parts[n]
      address = substr($4, 1, length($4) - length(port) - 1)
      if (address == "0.0.0.0" || address == "::" || address == "") scope = "any"
      else if (address ~ /^127\./ || address == "::1") scope = "loopback"
      else scope = "address"
      program = $NF
      sub(/^[0-9]+\//, "", program)
      print proto, scope, port, address, program
    }' | sort -u
}

section "Host"
listeners > "$OUT/listeners-before.txt"
pass "baseline: $(wc -l < "$OUT/listeners-before.txt" | tr -d ' ') listening sockets before the start"

NODE_IP=$(docker run --rm --network host --entrypoint ip "$HELPER_IMAGE" -4 route get 1.1.1.1 2> /dev/null |
  awk '{ for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit } }')
case "$NODE_IP" in
  '' | *[!0-9.]*) die "could not determine the host's IPv4 address for LIVEKIT_NODE_IP" ;;
esac
pass "LIVEKIT_NODE_IP=$NODE_IP (the host network's primary address)"

in_use() { awk -v proto="$1" -v port="$2" '$1 == proto && $3 == port { found = 1 } END { exit !found }' "$OUT/listeners-before.txt"; }
for public in tcp:80 tcp:443 udp:443; do
  if in_use "${public%%:*}" "${public#*:}"; then
    die "${public#*:}/${public%%:*} is already in use on the host network; the smoke test needs it"
  fi
done
# pick_port VAR proto default: the default, or the first of default+10000, +20000, ... that is free.
pick_port() {
  port=$3
  while in_use "$2" "$port"; do port=$((port + 10000)); done
  if [ "$port" -ne "$3" ]; then note "$1=$port ($3/$2 is taken on the host network)"; fi
  eval "$1=\$port"
}
pick_port APP_PORT tcp 3000
pick_port LIVEKIT_HTTP_PORT tcp 7880
pick_port LIVEKIT_RTC_TCP_PORT tcp 7881
pick_port LIVEKIT_TURN_TLS_PORT tcp 5349
pick_port LIVEKIT_TURN_UDP_PORT udp 3478
pick_port CADDY_HEALTH_PORT tcp 2020

# --- Configuration -------------------------------------------------------------------------------------------------

section "Configuration"
sh scripts/init-env.sh --yes --force --quiet --output .env.smoke \
  --domain "$SMOKE_DOMAIN" --turn-domain "$SMOKE_TURN_DOMAIN" --admin-email "admin@$SMOKE_DOMAIN" \
  --tls-mode internal --node-ip "$NODE_IP" \
  --set "APP_PORT=$APP_PORT" --set "LIVEKIT_HTTP_PORT=$LIVEKIT_HTTP_PORT" \
  --set "LIVEKIT_RTC_TCP_PORT=$LIVEKIT_RTC_TCP_PORT" --set "LIVEKIT_TURN_TLS_PORT=$LIVEKIT_TURN_TLS_PORT" \
  --set "LIVEKIT_TURN_UDP_PORT=$LIVEKIT_TURN_UDP_PORT" --set "CADDY_HEALTH_PORT=$CADDY_HEALTH_PORT" \
  --set "LIVEKIT_RTC_PORT_RANGE_START=$RTC_START" --set "LIVEKIT_RTC_PORT_RANGE_END=$RTC_END" \
  --set LOG_LEVEL=debug --set LOG_FORMAT=json > "$OUT/init-env.txt"
pass "init-env.sh --yes wrote .env.smoke"
# shellcheck disable=SC2012 # the mode string of one known file, portable across GNU and BSD
perms=$(ls -ln "$ENV_FILE" | cut -c1-10)
if [ "$perms" = '-rw-------' ]; then pass ".env.smoke has mode 600"; else failed ".env.smoke has mode $perms, not 600"; fi

if [ "$(uname -s)" = Linux ]; then
  preflight_status=0
  sh scripts/preflight.sh --env-file .env.smoke > "$OUT/preflight.txt" 2>&1 || preflight_status=$?
  case "$preflight_status" in
    0) pass "preflight.sh passes for .env.smoke" ;;
    2) pass "preflight.sh passes for .env.smoke with warnings (see $OUT/preflight.txt)" ;;
    *)
      cat "$OUT/preflight.txt" >&2
      failed "preflight.sh fails for .env.smoke"
      ;;
  esac
else
  note "preflight.sh skipped: it checks a Linux host, and this is $(uname -s)"
fi

if compose config -q; then pass "docker compose config (TURN on)"; else failed "docker compose config (TURN on)"; fi
turn_off=$(TURN_DOMAIN='' compose config --format json | node -e \
  'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => process.stdout.write(JSON.parse(s).services.livekit.environment.LIVEKIT_CONFIG))')
case "$turn_off" in
  *"domain: turn"* | *"tls_port: 5"*) failed "with TURN_DOMAIN empty, LIVEKIT_CONFIG still enables TURN/TLS" ;;
  *"tls_port:"*) pass "docker compose config (TURN off): LiveKit gets no TURN/TLS port or domain" ;;
  *) failed "docker compose config (TURN off) did not render LIVEKIT_CONFIG" ;;
esac
grep -v '^APP_SECRET=' "$ENV_FILE" > "$ENV_FILE.missing"
if missing=$(docker compose -p "$PROJECT" --env-file "$ENV_FILE.missing" -f "$ROOT/docker-compose.yml" config -q 2>&1); then
  failed "docker compose config succeeds without APP_SECRET"
else
  case "$missing" in
    *APP_SECRET*) pass "a missing APP_SECRET stops docker compose with a message naming it" ;;
    *) failed "without APP_SECRET docker compose fails, but the message does not name it: $missing" ;;
  esac
fi
rm -f "$ENV_FILE.missing"

# --- Build and start -------------------------------------------------------------------------------------------------

section "Start"
compose down -v --remove-orphans --timeout 10 > /dev/null 2>&1 || true
started=1
if [ "$build" -eq 1 ]; then
  version=$(node -p 'require("./package.json").version' 2> /dev/null || echo unknown)
  revision=$(git rev-parse --short HEAD 2> /dev/null || echo unknown)
  log "building blinq-app:local and blinq-caddy:local"
  compose build --build-arg "BLINQ_VERSION=$version" --build-arg "BLINQ_REVISION=$revision" > "$OUT/build.log" 2>&1 ||
    die "docker compose build failed (see $OUT/build.log)"
  pass "images built"
else
  for image in blinq-app:local blinq-caddy:local; do
    docker image inspect "$image" > /dev/null 2>&1 || die "--no-build, but $image does not exist"
  done
  note "--no-build: using the existing blinq-app:local and blinq-caddy:local"
fi
start_time=$(date +%s)
if compose up -d --wait --wait-timeout 300 > "$OUT/up.log" 2>&1; then
  pass "docker compose up -d --wait: every service healthy after $(($(date +%s) - start_time)) s"
else
  cat "$OUT/up.log" >&2
  compose ps -a >&2 || true
  compose logs --no-color --tail 60 >&2 || true
  die "docker compose up -d --wait failed"
fi

# Caddy issues the internal certificates in the background right after it starts.
deadline=$(($(date +%s) + 60))
until compose exec -T caddy test -f "/data/caddy/certificates/local/$SMOKE_DOMAIN/$SMOKE_DOMAIN.crt" &&
  compose exec -T caddy test -f "/data/caddy/certificates/local/$SMOKE_TURN_DOMAIN/$SMOKE_TURN_DOMAIN.crt"; do
  [ "$(date +%s)" -lt "$deadline" ] || die "Caddy did not issue the internal certificates within 60 s"
  sleep 1
done
compose cp caddy:/data/caddy/pki/authorities/local/root.crt "$OUT/caddy-root.crt" > /dev/null 2>&1 ||
  die "could not copy Caddy's root certificate"
pass "Caddy issued certificates for $SMOKE_DOMAIN and $SMOKE_TURN_DOMAIN (internal CA)"

# --- Containers --------------------------------------------------------------------------------------------------------

section "Containers"
inspect() { docker inspect -f "$2" "$(container "$1")"; }
expect_eq() { # expect_eq description actual expected
  if [ "$2" = "$3" ]; then pass "$1"; else failed "$1: expected '$3', got '$2'"; fi
}
for service in postgres livekit app caddy; do
  expect_eq "$service: all capabilities dropped" "$(inspect "$service" '{{json .HostConfig.CapDrop}}')" '["ALL"]'
  expect_eq "$service: no-new-privileges" "$(inspect "$service" '{{json .HostConfig.SecurityOpt}}')" '["no-new-privileges:true"]'
  expect_eq "$service: read-only root filesystem" "$(inspect "$service" '{{.HostConfig.ReadonlyRootfs}}')" true
  expect_eq "$service: no published ports" "$(inspect "$service" '{{len .HostConfig.PortBindings}}')" 0
  expect_eq "$service: restart unless-stopped" "$(inspect "$service" '{{.HostConfig.RestartPolicy.Name}}')" unless-stopped
  expect_eq "$service: rotated json-file logs" \
    "$(inspect "$service" '{{.HostConfig.LogConfig.Type}} {{index .HostConfig.LogConfig.Config "max-size"}} {{index .HostConfig.LogConfig.Config "max-file"}}')" \
    'json-file 10m 5'
done
expect_eq "postgres: no network at all" "$(inspect postgres '{{.HostConfig.NetworkMode}}')" none
for service in livekit app caddy; do
  expect_eq "$service: host network" "$(inspect "$service" '{{.HostConfig.NetworkMode}}')" host
done
expect_eq "app: runs as 10001:10001" "$(inspect app '{{.Config.User}}')" 10001:10001
expect_eq "app: init process" "$(inspect app '{{.HostConfig.Init}}')" true
expect_eq "livekit: runs as nobody" "$(inspect livekit '{{.Config.User}}')" 65534:65534
expect_eq "caddy: only NET_BIND_SERVICE added" "$(inspect caddy '{{json .HostConfig.CapAdd}}' | sed 's/CAP_//g')" '["NET_BIND_SERVICE"]'
expect_eq "postgres: only the entrypoint's capabilities added" \
  "$(inspect postgres '{{json .HostConfig.CapAdd}}' | sed 's/CAP_//g')" '["CHOWN","DAC_OVERRIDE","FOWNER","SETGID","SETUID"]'
expect_eq "app and livekit: no capabilities added" "$(inspect app '{{len .HostConfig.CapAdd}}') $(inspect livekit '{{len .HostConfig.CapAdd}}')" '0 0'

# The app user writes only its tmpfs areas and the recordings volume; the image stays read-only.
# shellcheck disable=SC2016 # JavaScript, not shell
if compose exec -T app node -e '
  const fs = require("node:fs")
  for (const dir of ["/work", "/tmp", "/data/recordings"]) { fs.writeFileSync(`${dir}/.smoke`, "x"); fs.rmSync(`${dir}/.smoke`) }
  try { fs.writeFileSync("/app/.smoke", "x"); process.exit(1) } catch { process.exit(0) }'; then
  pass "app: writes /work, /tmp and /data/recordings, cannot write /app"
else
  failed "app: file system permissions are not as expected"
fi
if compose exec -T app sh -c 'grep -q " /work tmpfs " /proc/mounts'; then pass "app: /work is a tmpfs"; else failed "app: /work is not a tmpfs"; fi
if compose exec -T app sh -c 'ls -d /app/.output/server/node_modules/@node-rs/argon2*' > /dev/null 2>&1; then
  pass "app: the native @node-rs/argon2 binding is in the image"
else
  failed "app: .output/server/node_modules/@node-rs/argon2* is missing (Nitro did not trace it)"
fi
if compose exec -T postgres psql -h /var/run/postgresql -U "$(env_value POSTGRES_USER)" -d "$(env_value POSTGRES_DB)" \
  -w -c 'select 1' > /dev/null 2>&1; then
  failed "postgres: the socket accepts a connection without a password"
else
  pass "postgres: the socket requires a password (scram-sha-256)"
fi

# --- Browsers ------------------------------------------------------------------------------------------------------------

section "Playwright (tests/smoke-prod)"
docker image inspect "$PLAYWRIGHT_IMAGE" > /dev/null 2>&1 || docker pull -q "$PLAYWRIGHT_IMAGE" > /dev/null
[ -d node_modules/@playwright/test ] || die "node_modules is missing: run pnpm install --frozen-lockfile first"
playwright_status=0
# call.spec.ts signs in as the bootstrap admin through the UI (and sets a new password on the first sign-in). Its
# credentials reach the container through the environment, never the command line.
ADMIN_EMAIL=$(env_value ADMIN_EMAIL) ADMIN_PASSWORD=$(env_value ADMIN_PASSWORD | sed "s/^'//; s/'$//") \
  docker run --rm --init --network host --ipc host --user "$(id -u):$(id -g)" \
  --add-host "$SMOKE_DOMAIN:127.0.0.1" --add-host "$SMOKE_TURN_DOMAIN:127.0.0.1" \
  -v "$ROOT:/repo:ro" -v "$OUT:/out" -w /repo \
  -e HOME=/tmp -e CI="${CI:-}" -e SMOKE_OUTPUT_DIR=/out \
  -e "SMOKE_BASE_URL=https://$SMOKE_DOMAIN" -e "SMOKE_TURN_DOMAIN=$SMOKE_TURN_DOMAIN" \
  -e SMOKE_CA_FILE=/out/caddy-root.crt -e NODE_EXTRA_CA_CERTS=/out/caddy-root.crt \
  -e ADMIN_EMAIL -e ADMIN_PASSWORD \
  -e "SMOKE_NODE_IP=$NODE_IP" -e "SMOKE_RTC_PORT_RANGE=$RTC_START-$RTC_END" \
  "$PLAYWRIGHT_IMAGE" node node_modules/@playwright/test/cli.js test -c tests/smoke-prod/playwright.config.ts ||
  playwright_status=$?
if [ "$playwright_status" -eq 0 ]; then pass "every smoke spec passed"; else failed "smoke specs failed (report: $OUT/report)"; fi

# --- Restart ---------------------------------------------------------------------------------------------------------------

section "Restart"
compose restart app > /dev/null 2>&1 || failed "docker compose restart app"
deadline=$(($(date +%s) + 180))
until [ "$(inspect app '{{.State.Health.Status}}')" = healthy ]; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    failed "app: not healthy again within 180 s after a restart"
    break
  fi
  sleep 2
done
if compose exec -T app node /app/docker/healthcheck.mjs; then pass "app: /api/ready is 200 after a restart"; else failed "app: /api/ready fails after a restart"; fi
# shellcheck disable=SC2016 # expanded by the container's shell
admins=$(compose exec -T postgres sh -c \
  'PGPASSWORD="$POSTGRES_PASSWORD" psql -h /var/run/postgresql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "select count(*) from users where role = '\''admin'\''"' 2>&1 || true)
expect_eq "exactly one admin after the second start (bootstrap is idempotent)" "$admins" 1
app_logs=$(compose logs --no-color app 2>&1)
migrated=$(printf '%s\n' "$app_logs" | grep -c 'migrations applied' || true)
if [ "$migrated" -ge 2 ]; then pass "migrate ran on both starts"; else failed "migrate ran $migrated time(s), expected 2"; fi
if printf '%s\n' "$app_logs" | grep -q 'bootstrap: nothing to do'; then
  pass "bootstrap ran again and had nothing to do"
else
  failed "the second start did not report 'bootstrap: nothing to do'"
fi

# --- Listeners ---------------------------------------------------------------------------------------------------------------

section "Listeners (host network namespace)"
listeners > "$OUT/listeners-after.txt"
# New sockets since the baseline, classified: every one must be an intended listener.
awk -v app="$APP_PORT" -v lkhttp="$LIVEKIT_HTTP_PORT" -v health="$CADDY_HEALTH_PORT" -v rtctcp="$LIVEKIT_RTC_TCP_PORT" \
  -v turntls="$LIVEKIT_TURN_TLS_PORT" -v turnudp="$LIVEKIT_TURN_UDP_PORT" -v rtcstart="$RTC_START" -v rtcend="$RTC_END" '
  FNR == NR { before[$1 " " $4 " " $3] = 1; next }
  (($1 " " $4 " " $3) in before) { next }
  {
    proto = $1; scope = $2; port = $3 + 0; where = $4 ":" $3 "/" proto " (" $5 ")"
    loopback_only = (proto == "tcp" && (port == app || port == lkhttp || port == health))
    if (loopback_only) { print (scope == "loopback" ? "ok" : "bad"), where, "loopback only"; next }
    if (proto == "tcp" && (port == 80 || port == 443 || port == rtctcp || port == turntls)) { print "ok", where; next }
    if (proto == "udp" && (port == 443 || port == turnudp)) { print "ok", where; next }
    if (proto == "udp" && port >= rtcstart && port <= rtcend) { print "ok", where, "WebRTC media"; next }
    if (proto == "udp" && port >= 30000 && port <= 40000) { print "ok", where, "TURN relay"; next }
    print "bad", where, "not an intended listener"
  }' "$OUT/listeners-before.txt" "$OUT/listeners-after.txt" > "$OUT/listeners-new.txt"
while read -r verdict detail; do
  if [ "$verdict" = ok ]; then pass "listener $detail"; else failed "listener $detail"; fi
done < "$OUT/listeners-new.txt"
has_listener() { awk -v p="$1" -v s="$2" -v port="$3" '$1 == p && (s == "" || $2 == s) && $3 == port { f = 1 } END { exit !f }' "$OUT/listeners-after.txt"; }
for wanted in "tcp any 80" "tcp any 443" "udp any 443" "udp any $LIVEKIT_TURN_UDP_PORT" "tcp any $LIVEKIT_RTC_TCP_PORT" \
  "tcp any $LIVEKIT_TURN_TLS_PORT" "tcp loopback $APP_PORT" "tcp loopback $LIVEKIT_HTTP_PORT" "tcp loopback $CADDY_HEALTH_PORT"; do
  # shellcheck disable=SC2086 # split into proto, scope and port
  set -- $wanted
  if has_listener "$1" "$2" "$3"; then pass "listening: $3/$1 ($2)"; else failed "not listening: $3/$1 ($2)"; fi
done
for forbidden in 2019 5432; do
  if has_listener tcp '' "$forbidden" && ! in_use tcp "$forbidden"; then
    failed "something listens on $forbidden/tcp (Caddy admin or Postgres must never listen)"
  else
    pass "nothing listens on $forbidden/tcp"
  fi
done

# --- Logs ------------------------------------------------------------------------------------------------------------------------

section "Logs"
compose logs --no-color --timestamps > "$OUT/compose.log" 2>&1
for name in APP_SECRET LIVEKIT_API_SECRET POSTGRES_PASSWORD ADMIN_PASSWORD RECORDING_ENCRYPTION_KEY; do
  value=$(env_value "$name" | sed "s/^'//; s/'$//")
  if [ "${#value}" -ge 8 ] && grep -qF -- "$value" "$OUT/compose.log"; then
    failed "the value of $name appears in the container logs"
  else
    pass "$name never appears in the container logs"
  fi
done
if grep -qE 'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}' "$OUT/compose.log"; then
  failed "a JWT (LiveKit token) appears in the container logs"
else
  pass "no JWT in the container logs"
fi
# call.spec.ts handles a room key, an invite link and session and guest cookies (the admin's new password contains
# ADMIN_PASSWORD, so the scan above covers it).
if grep -qE '([#&]|\\u0026)[kt]=[A-Za-z0-9_-]{16,}' "$OUT/compose.log"; then
  failed "a room key or invite token (k= or t=) appears in the container logs"
else
  pass "no room key or invite token in the container logs"
fi
if grep -oE 'blinq_(session|g_[A-Za-z0-9_-]+)=[^;", \\]*' "$OUT/compose.log" | grep -qv '=REDACTED$'; then
  failed "a session or guest cookie value appears in the container logs"
else
  pass "no session or guest cookie value in the container logs"
fi
if grep -oE 'access_token=[^&" \\]*' "$OUT/compose.log" | grep -qv '^access_token=REDACTED$'; then
  failed "an unredacted access_token query value appears in the container logs"
elif grep -q 'access_token=REDACTED' "$OUT/compose.log"; then
  pass "Caddy logged the signaling requests with access_token=REDACTED"
else
  failed "no signaling request with a redacted access_token in the Caddy log (did the call reach /rtc?)"
fi
