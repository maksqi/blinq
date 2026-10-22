#!/usr/bin/env sh
# Runs Playwright against a test build behind the e2e Caddy (docs/TESTING.md §6).
#
#   sh scripts/e2e.sh [playwright args...]
#   sh scripts/e2e.sh --project=chromium --project=firefox tests/e2e/smoke
#
# On macOS this hands over to scripts/e2e-docker.sh: browsers on the host would play the fake-media tone and remote
# audio through the speakers, so local Playwright runs happen inside Docker. E2E_HOST=1 keeps the host mode there.
#
# Host mode (Linux and CI, or E2E_HOST=1):
# 1. the shared dev stack is up (pnpm dev:deps; a running stack is left untouched)
# 2. pnpm build:test (skipped with E2E_SKIP_BUILD=1 when .output already is a test build)
# 3. a fresh e2e database (E2E_DB_NAME, default blinq_e2e) on the shared Postgres, migrated with the bundled CLI
# 4. node .output/server/index.mjs on 127.0.0.1:<port> with PUBLIC_URL=http://localhost:<http port> (production mode)
# 5. the e2e Caddy (docker/e2e/compose.yml) on http://localhost:<http port>: /rtc* to LiveKit, everything else to the app
# 6. pnpm exec playwright test "$@", then the server and Caddy are stopped again
# The app port is E2E_APP_PORT, else PORT from .env, else 3000. The dev LiveKit sends webhooks to 3000-3005 only.
# The public port of the e2e Caddy is E2E_HTTP_PORT, default 8080 (set it when another program holds 8080).
#
# Runner mode (E2E_IN_DOCKER=1, set only in the runner container of docker/e2e/runner.compose.yml): the same steps
# against the runner's own Caddy, LiveKit, Postgres and Mailpit, which scripts/e2e-docker.sh has started. Step 1
# installs node_modules into the runner's volume instead, the ports are the fixed 3000 (app) and 8080 (Caddy) of the
# runner's private network namespace, and the database is recreated over TCP.
#
# The whole run holds the machine-wide heavy lock (scripts/with-lock.sh): one E2E run at a time. In runner mode
# scripts/e2e-docker.sh holds it on the host.
# Logs: logs/e2e/app.log and logs/e2e/caddy.log. tests/e2e/fixtures/base.ts scans them for secrets.
set -eu

cd "$(dirname "$0")/.."
ROOT=$(pwd -P)

IN_DOCKER=
if [ "${E2E_IN_DOCKER:-}" = 1 ]; then
  if [ ! -f /.dockerenv ]; then
    echo 'e2e: E2E_IN_DOCKER=1 is for the runner container only; run sh scripts/e2e-docker.sh' >&2
    exit 1
  fi
  IN_DOCKER=1
elif [ "$(uname -s)" = Darwin ] && [ "${E2E_HOST:-}" != 1 ]; then
  exec sh scripts/e2e-docker.sh "$@"
fi

# Re-run under the lock unless this process already holds it (with-lock.sh exports its pid as BLINQ_LOCK_HELD).
if [ -z "$IN_DOCKER" ] && { [ -z "${BLINQ_LOCK_HELD:-}" ] ||
  [ "$(cat "${BLINQ_LOCK_DIR:-/tmp/blinq-heavy.lock}/pid" 2>/dev/null || true)" != "$BLINQ_LOCK_HELD" ]; }; then
  exec sh scripts/with-lock.sh sh scripts/e2e.sh "$@"
fi

log() { printf 'e2e: %s\n' "$*" >&2; }
fail() {
  log "error: $*"
  exit 1
}

# Last KEY=value of a dotenv file (plain values only).
dotenv_value() {
  [ -f "$1" ] || return 0
  sed -n "s/^$2=//p" "$1" | tail -n 1
}

e2e_compose() { docker compose -f "$ROOT/docker/e2e/compose.yml" "$@"; }

if [ -n "$IN_DOCKER" ]; then
  # The runner's namespace is private: its Caddy listens on 8080, and its LiveKit sends webhooks to 3000.
  HTTP_PORT=8080
  APP_PORT=3000
else
  HTTP_PORT=${E2E_HTTP_PORT:-8080}
  APP_PORT=${E2E_APP_PORT:-$(dotenv_value .env PORT)}
  APP_PORT=${APP_PORT:-3000}
fi
BASE_URL=http://localhost:$HTTP_PORT
LOG_DIR="$ROOT/logs/e2e"
DB_NAME=${E2E_DB_NAME:-blinq_e2e}
case "$APP_PORT" in *[!0-9]* | '') fail "invalid app port: $APP_PORT" ;; esac
case "$HTTP_PORT" in *[!0-9]* | '') fail "invalid e2e http port: $HTTP_PORT" ;; esac
case "$DB_NAME" in *[!a-z0-9_]* | '') fail "invalid database name: $DB_NAME" ;; esac

server_pid=
caddy_logs_pid=
caddy_started=

# shellcheck disable=SC2329 # invoked by the EXIT trap
cleanup() {
  status=$?
  trap - EXIT INT TERM
  if [ -n "$caddy_logs_pid" ]; then kill "$caddy_logs_pid" 2>/dev/null || true; fi
  if [ -n "$caddy_started" ]; then e2e_compose down --remove-orphans --timeout 5 >/dev/null 2>&1 || true; fi
  if [ -n "$server_pid" ] && kill -0 "$server_pid" 2>/dev/null; then
    kill "$server_pid" 2>/dev/null || true
    i=0
    while kill -0 "$server_pid" 2>/dev/null && [ "$i" -lt 20 ]; do
      sleep 0.5
      i=$((i + 1))
    done
    kill -9 "$server_pid" 2>/dev/null || true
  fi
  log "logs: $LOG_DIR/app.log, $LOG_DIR/caddy.log; report: pnpm exec playwright show-report"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Waits until <url> answers from the app (any status except 502/503/504, which mean the upstream is missing).
wait_http() {
  deadline=$(($(date +%s) + $3))
  while :; do
    code=$(curl -s -o /dev/null --max-time 2 -w '%{http_code}' "$2" || true)
    case "$code" in
      000 | 502 | 503 | 504) ;;
      *)
        log "$1 answers ($2 -> HTTP $code)"
        return 0
        ;;
    esac
    if [ -n "$server_pid" ] && ! kill -0 "$server_pid" 2>/dev/null; then
      tail -n 40 "$LOG_DIR/app.log" >&2 || true
      fail "the app exited during startup (see $LOG_DIR/app.log)"
    fi
    [ "$(date +%s)" -lt "$deadline" ] || fail "$1 did not answer within $3 s ($2 -> HTTP $code)"
    sleep 0.5
  done
}

# 1. Host mode: the shared dev stack. Runner mode: a Linux install into the runner's node_modules volume (the host's
# node_modules holds macOS binaries); /pnpm-store is the store volume of docker/e2e/runner.compose.yml.
dev_stack_healthy() {
  for container in blinq-dev-postgres-1 blinq-dev-livekit-1 blinq-dev-mailpit-1; do
    [ "$(docker inspect -f '{{.State.Health.Status}}' "$container" 2>/dev/null || true)" = healthy ] || return 1
  done
}
if [ -n "$IN_DOCKER" ]; then
  log "installing dependencies (pnpm install --frozen-lockfile)"
  pnpm install --frozen-lockfile --prefer-offline --store-dir /pnpm-store --reporter=append-only
elif dev_stack_healthy; then
  advertised=$(docker inspect -f '{{join .Config.Cmd " "}}' blinq-dev-livekit-1 | sed -n 's/.*--node-ip \([^ ]*\).*/\1/p')
  current=$(sh scripts/detect-ip.sh 2>/dev/null || true)
  log "dev stack is up (LiveKit node_ip $advertised)"
  if [ -n "$current" ] && [ "$advertised" != "$current" ]; then
    log "warning: this machine's IP is now $current; WebRTC media may fail until pnpm dev:deps runs again"
  fi
else
  log "starting the dev stack (pnpm dev:deps)"
  pnpm dev:deps
fi

# 2. Test build. The lock is already held, so this never waits for itself.
if [ "${E2E_SKIP_BUILD:-}" = 1 ]; then
  grep -rqs '"/dev/call"' .output/server/chunks || fail "E2E_SKIP_BUILD=1, but .output is not a test build"
  # The native argon2 binary shows which platform .output was built on (the runner's .output volume is Linux).
  platform=$(node -p 'process.platform + "-" + process.arch')
  [ -n "$(find .output/server/node_modules/@node-rs -maxdepth 1 -name "argon2-$platform*" 2>/dev/null)" ] ||
    fail "E2E_SKIP_BUILD=1, but .output was not built for $platform"
  log "reusing the test build in .output"
elif [ -n "$IN_DOCKER" ]; then
  log "building (pnpm build:test)"
  # .output is the mount point of the runner's volume, and Nitro deletes and recreates its output directory, which
  # fails on a mount point (EBUSY). A global .nuxtrc (HOME is the container's /tmp) moves Nitro's output to a
  # container directory; it is copied into the volume afterwards. scripts/build-cli.mjs writes .output/server/cli.mjs
  # into the emptied volume during the build, so the copy only adds to it.
  nitro_output=/tmp/blinq-nitro-output
  printf 'nitro.output.dir=%s\n' "$nitro_output" > "$HOME/.nuxtrc"
  rm -rf "$nitro_output"
  find .output -mindepth 1 -delete
  # Docker Desktop's VM is shared with other containers: a fixed heap fails clearly instead of being OOM-killed.
  NODE_OPTIONS="--max-old-space-size=${E2E_BUILD_HEAP_MB:-4096}" pnpm build:test
  rm -f "$HOME/.nuxtrc"
  cp -a "$nitro_output/." .output/
else
  log "building (pnpm build:test)"
  pnpm build:test
fi

# E2E environment: the public dev values of .env.dev.example (identical in CI), plus the E2E overrides below.
# Playwright inherits it too, so fixtures can mint LiveKit tokens and reach the e2e database.
set -a
# shellcheck source=/dev/null # a dotenv file with plain KEY=value lines
. ./.env.dev.example
set +a
export NODE_ENV=production
export NITRO_HOST=127.0.0.1 NITRO_PORT="$APP_PORT" PORT="$APP_PORT"
export PUBLIC_URL="$BASE_URL" LIVEKIT_PUBLIC_URL="ws://localhost:$HTTP_PORT" LIVEKIT_URL=http://127.0.0.1:7880
export DATABASE_URL="${DATABASE_URL%/*}/$DB_NAME"
export RECORDINGS_DIR="$ROOT/.data/e2e/recordings" RECORDING_WORK_DIR="$ROOT/.data/e2e/work"
export LOG_LEVEL=debug LOG_FORMAT=json
export E2E_BASE_URL="$BASE_URL" E2E_LOG_DIR="$LOG_DIR" E2E_REQUIRE_LOGS=1

mkdir -p "$LOG_DIR"
: > "$LOG_DIR/app.log"
: > "$LOG_DIR/caddy.log"
rm -rf "$ROOT/.data/e2e"
mkdir -p "$RECORDINGS_DIR" "$RECORDING_WORK_DIR"

# 3. Fresh database: in the dev Postgres container (host mode) or over TCP on the runner's Postgres (runner mode).
admin_psql() {
  if [ -n "$IN_DOCKER" ]; then
    PGOPTIONS=--client-min-messages=warning psql "${DATABASE_URL%/*}/postgres" -v ON_ERROR_STOP=1 -q "$@"
  else
    docker exec blinq-dev-postgres-1 psql -U blinq -d postgres -v ON_ERROR_STOP=1 -q "$@"
  fi
}
log "recreating database $DB_NAME"
admin_psql -c "DROP DATABASE IF EXISTS \"$DB_NAME\" WITH (FORCE)" \
  -c "CREATE DATABASE \"$DB_NAME\" OWNER blinq" > /dev/null
node .output/server/cli.mjs migrate
# First admin from ADMIN_EMAIL / ADMIN_PASSWORD (.env.dev.example: admin@blinq.local), must change password at login.
node .output/server/cli.mjs bootstrap

# 4. App server. A second Nitro server on a busy port logs EADDRINUSE but keeps running, and the old server would
# answer every request, so the port must be free first.
if [ "$(curl -s -o /dev/null --max-time 2 -w '%{http_code}' "http://127.0.0.1:$APP_PORT/" || true)" != 000 ]; then
  fail "port $APP_PORT is in use (is pnpm dev running?); stop it or set E2E_APP_PORT to another port in 3000-3005"
fi
log "starting the app on 127.0.0.1:$APP_PORT"
node .output/server/index.mjs >> "$LOG_DIR/app.log" 2>&1 &
server_pid=$!
wait_http app "http://127.0.0.1:$APP_PORT/api/health" 60
if grep -q EADDRINUSE "$LOG_DIR/app.log"; then fail "the app could not bind 127.0.0.1:$APP_PORT"; fi

# 5. e2e Caddy. The runner's Caddy is already up and writes logs/e2e/caddy.log itself. In host mode it starts here;
# on a native Linux engine, host.docker.internal needs the host-gateway forwarder (compose profile).
export E2E_APP_PORT="$APP_PORT" E2E_HTTP_PORT="$HTTP_PORT"
if [ -z "$IN_DOCKER" ]; then
  if [ "$(uname -s)" = Linux ] && ! docker info --format '{{.OperatingSystem}}' | grep -qi 'docker desktop'; then
    caddy_image=$(e2e_compose config --images | head -n 1)
    E2E_GATEWAY_IP=$(docker run --rm --add-host=gateway:host-gateway "$caddy_image" grep -w gateway /etc/hosts | awk 'NR == 1 { print $1 }')
    [ -n "$E2E_GATEWAY_IP" ] || fail "could not resolve the Docker host-gateway address"
    export E2E_GATEWAY_IP COMPOSE_PROFILES=linux
    log "native Linux engine: forwarding $E2E_GATEWAY_IP:$APP_PORT to 127.0.0.1:$APP_PORT"
  fi
  e2e_compose down --remove-orphans --timeout 5 > /dev/null 2>&1 || true
  caddy_started=1
  e2e_compose up -d --wait --quiet-pull
  # A plain command (not the shell function), so $! is the docker process itself.
  docker compose -f "$ROOT/docker/e2e/compose.yml" logs --no-color --no-log-prefix --follow caddy >> "$LOG_DIR/caddy.log" 2>&1 &
  caddy_logs_pid=$!
fi
wait_http "e2e Caddy" "$BASE_URL/api/health" 60

# 6. Playwright.
log "playwright test $*"
set +e
pnpm exec playwright test "$@"
status=$?
set -e
exit "$status"
