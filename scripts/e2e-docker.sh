#!/usr/bin/env sh
# Runs Playwright inside Docker: no browser ever starts on the host (docs/TESTING.md §6.2). On macOS, scripts/e2e.sh
# hands over to this script by default.
#
#   sh scripts/e2e-docker.sh [playwright args...]
#   sh scripts/e2e-docker.sh --project=chromium --project=firefox tests/e2e/call/e2ee.spec.ts
#   sh scripts/e2e-docker.sh --config tests/load/playwright.config.ts
#
# 1. builds the runner image (docker/e2e/runner.Dockerfile: Playwright 1.63 browsers, ffmpeg, psql, PulseAudio)
# 2. starts docker/e2e/runner.compose.yml (project blinq-e2e-docker): the runner plus its own Caddy, LiveKit, Postgres
#    and Mailpit, all in the runner's network namespace; no host port is published
# 3. runs scripts/e2e.sh in runner mode inside the runner: pnpm install into a volume, pnpm build:test (skipped with
#    E2E_SKIP_BUILD=1), a fresh blinq_e2e database, the app on 127.0.0.1:3000, then playwright test "$@"
# 4. always removes the containers again; the node_modules, .output, .nuxt and pnpm store volumes stay for the next run
#
# The checkout is mounted at its own absolute path, so test-results/, playwright-report/, logs/e2e/ and .data/e2e/
# land in it as in host mode. The exit code is Playwright's.
# Forwarded into the runner: E2E_*, SWARM_*, PLAYWRIGHT_* and PW_* variables, CI, DEBUG and NO_COLOR.
# E2E_LIVEKIT_SEND_SIDE_BWE=false starts the runner's LiveKit without send-side bandwidth estimation (on by default).
# The whole run holds the machine-wide heavy lock (scripts/with-lock.sh): one E2E run at a time.
set -eu

cd "$(dirname "$0")/.."
ROOT=$(pwd -P)

# Re-run under the lock unless this process already holds it (with-lock.sh exports its pid as BLINQ_LOCK_HELD).
if [ -z "${BLINQ_LOCK_HELD:-}" ] ||
  [ "$(cat "${BLINQ_LOCK_DIR:-/tmp/blinq-heavy.lock}/pid" 2>/dev/null || true)" != "$BLINQ_LOCK_HELD" ]; then
  exec sh scripts/with-lock.sh sh scripts/e2e-docker.sh "$@"
fi

log() { printf 'e2e-docker: %s\n' "$*" >&2; }
fail() {
  log "error: $*"
  exit 1
}

PROJECT=blinq-e2e-docker
RUNNER=$PROJECT-runner-1

# msedge has no Linux arm64 build and the nightly webkit project needs macOS WebKit (E2EE); neither runs in Linux.
if [ "${E2E_NIGHTLY_BROWSERS:-}" = 1 ]; then
  fail "E2E_NIGHTLY_BROWSERS=1 adds msedge and macOS webkit, which the Linux runner cannot run (docs/TESTING.md §6.3)"
fi
command -v docker > /dev/null 2>&1 || fail "docker is not installed"
docker info > /dev/null 2>&1 || fail "the Docker engine does not answer (is Docker Desktop running?)"

# Volumes are named after the checkout, so a worktree and the main checkout never share node_modules or .output.
checkout_id() {
  if command -v shasum > /dev/null 2>&1; then
    printf '%s' "$ROOT" | shasum -a 256 | cut -c1-12
  else
    printf '%s' "$ROOT" | sha256sum | cut -c1-12
  fi
}
E2E_ROOT=$ROOT
E2E_VOLUME_PREFIX=blinq-e2e-$(checkout_id)
export E2E_ROOT E2E_VOLUME_PREFIX
unset COMPOSE_PROJECT_NAME COMPOSE_FILE COMPOSE_PROFILES

runner_compose() { docker compose -p "$PROJECT" -f "$ROOT/docker/e2e/runner.compose.yml" "$@"; }

started=
tests_pid=
# shellcheck disable=SC2329 # invoked by the EXIT trap
cleanup() {
  status=$?
  trap - EXIT INT TERM
  if [ -n "$tests_pid" ]; then kill "$tests_pid" 2>/dev/null || true; fi
  if [ -n "$started" ]; then
    # A native Linux engine writes the runner's root-owned files straight into the checkout; hand them back.
    if [ "$(uname -s)" != Darwin ]; then
      runner_compose exec -T runner chown -R "$(id -u):$(id -g)" logs/e2e test-results playwright-report .data/e2e \
        public/vendor > /dev/null 2>&1 || true
    fi
    runner_compose down --remove-orphans --timeout 5 > /dev/null 2>&1 || true
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Caddy writes its access log into logs/e2e/caddy.log through a bind mount, so the directory must exist first.
mkdir -p logs/e2e
: > logs/e2e/app.log
: > logs/e2e/caddy.log
# Caddy runs as root without capabilities: on a native Linux engine it can only write a file that others may write.
if [ "$(uname -s)" != Darwin ]; then chmod a+w logs/e2e/caddy.log; fi

log "building the runner image"
runner_compose build --quiet runner
# A run that was killed may have left containers behind.
runner_compose down --remove-orphans --timeout 5 > /dev/null 2>&1 || true
log "starting the runner stack (project $PROJECT, volumes $E2E_VOLUME_PREFIX-*)"
started=1
if ! runner_compose up -d --wait --quiet-pull; then
  runner_compose ps -a >&2 || true
  runner_compose logs --no-color --tail 40 >&2 || true
  fail "the runner stack did not become healthy"
fi
node_ip=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$RUNNER")
log "runner stack is up (LiveKit node_ip $node_ip, send-side BWE ${E2E_LIVEKIT_SEND_SIDE_BWE:-true})"

# Forward the caller's E2E and Playwright settings. `-e NAME` takes the value from this environment, so values never
# appear on a command line. The runner's own settings (container names, mode) are never overridden.
forward=
for name in $(env | sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' | sort -u); do
  case "$name" in
    E2E_IN_DOCKER | E2E_ROOT | E2E_VOLUME_PREFIX | E2E_HOST | E2E_LIVEKIT_CONTAINER | E2E_POSTGRES_CONTAINER) ;;
    E2E_* | SWARM_* | PLAYWRIGHT_* | PW_* | CI | DEBUG | NO_COLOR) forward="$forward -e $name" ;;
  esac
done
# Colored Playwright output when this script writes to a terminal (exec -T has none).
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then forward="$forward -e FORCE_COLOR=1"; fi

# In the background, so INT and TERM reach the trap at once (sh runs traps only after a foreground command ends) and
# the cleanup removes the containers, which also ends the tests.
# shellcheck disable=SC2086 # $forward is a list of -e NAME words (names only)
runner_compose exec -T $forward runner sh scripts/e2e.sh "$@" &
tests_pid=$!
set +e
wait "$tests_pid"
status=$?
set -e
tests_pid=
exit "$status"
