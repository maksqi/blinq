#!/usr/bin/env sh
# Checks a host before the first `docker compose up` (docs/DEPLOYMENT.md §7) and prints how to fix each problem.
#
#   sh scripts/preflight.sh [prod|dev] [--env-file FILE]
#
# prod (default): Linux; Docker Engine >= 28.0.1 and Compose v2; .env (mode 600, required values set, no placeholders);
#   DNS of DOMAIN and TURN_DOMAIN; free ports; CPU and RAM; UDP buffer sysctls; clock synchronization; disk space.
# dev: the tools for local development (Node, pnpm, Docker, Compose v2).
# Exit codes: 0 everything passed, 1 at least one failure, 2 warnings only.
set -u

cd "$(dirname "$0")/.." || exit 1

mode=prod
env_file=.env
while [ "$#" -gt 0 ]; do
  case "$1" in
    prod | dev) mode=$1 ;;
    --env-file)
      env_file=${2?--env-file needs a value}
      shift
      ;;
    -h | --help)
      sed -n '2,9s/^# \{0,1\}//p' "$0"
      exit 0
      ;;
    *)
      echo "preflight: unknown argument '$1' (see --help)" >&2
      exit 1
      ;;
  esac
  shift
done

failures=0
warnings=0
ok() { printf '  ok    %s\n' "$*"; }
warn() {
  printf '  warn  %s\n' "$*"
  warnings=$((warnings + 1))
}
fail() {
  printf '  FAIL  %s\n' "$*"
  failures=$((failures + 1))
}
section() { printf '\n%s\n' "$*"; }
have() { command -v "$1" > /dev/null 2>&1; }

# version_ge A B: A >= B for dotted versions (a "v" prefix and a suffix such as -rc1 are ignored).
version_ge() {
  a=$(printf '%s' "$1" | sed 's/^v//; s/[^0-9.].*$//')
  b=$(printf '%s' "$2" | sed 's/^v//; s/[^0-9.].*$//')
  old_ifs=$IFS
  IFS=.
  # shellcheck disable=SC2086 # split into parts
  set -- $a
  a1=${1:-0} a2=${2:-0} a3=${3:-0}
  # shellcheck disable=SC2086
  set -- $b
  IFS=$old_ifs
  b1=${1:-0} b2=${2:-0} b3=${3:-0}
  [ "$a1" -gt "$b1" ] && return 0
  [ "$a1" -lt "$b1" ] && return 1
  [ "$a2" -gt "$b2" ] && return 0
  [ "$a2" -lt "$b2" ] && return 1
  [ "$a3" -ge "$b3" ]
}

check_docker() {
  if ! have docker; then
    fail "docker is not installed: https://docs.docker.com/engine/install/"
    return
  fi
  engine=$(docker version --format '{{.Server.Version}}' 2> /dev/null || true)
  if [ -z "$engine" ]; then
    fail "the Docker daemon is not reachable (is it running, and is your user in the docker group?)"
    return
  fi
  if version_ge "$engine" 28.0.1; then
    ok "Docker Engine $engine"
  else
    warn "Docker Engine $engine is older than 28.0.1: upgrade from the official repository (https://docs.docker.com/engine/install/)"
  fi
  compose=$(docker compose version --short 2> /dev/null || true)
  if [ -n "$compose" ]; then
    ok "Docker Compose $compose (plugin)"
  elif have docker-compose; then
    fail "only Compose v1 (docker-compose) is installed; install the Compose v2 plugin (docker compose)"
  else
    fail "the Compose v2 plugin is missing: install docker-compose-plugin"
  fi
}

if [ "$mode" = dev ]; then
  section "Development tools"
  if have node; then
    node_version=$(node -p 'process.versions.node')
    if version_ge "$node_version" 22.19.0; then ok "Node $node_version"; else fail "Node $node_version: install Node 24 (.node-version)"; fi
  else
    fail "Node is not installed: install Node 24 (.node-version)"
  fi
  if have pnpm; then
    pnpm_version=$(pnpm --version)
    if version_ge "$pnpm_version" 11.20.0; then ok "pnpm $pnpm_version"; else warn "pnpm $pnpm_version: the project pins pnpm 11.20 (packageManager)"; fi
  else
    fail "pnpm is not installed: npm install -g pnpm@11.20.0"
  fi
  check_docker
  if have ffmpeg; then ok "ffmpeg found (recording tests)"; else warn "ffmpeg not found: the recording tests need ffmpeg 9"; fi
  printf '\n'
  [ "$failures" -eq 0 ] || exit 1
  [ "$warnings" -eq 0 ] || exit 2
  exit 0
fi

# --- prod ----------------------------------------------------------------------------------------------------------

section "System"
if [ "$(uname -s)" = Linux ]; then
  ok "Linux $(uname -r) on $(uname -m)"
else
  fail "production needs Linux (host networking); this is $(uname -s). For development, run: sh scripts/preflight.sh dev"
fi
cpus=$(getconf _NPROCESSORS_ONLN 2> /dev/null || nproc 2> /dev/null || echo 0)
mem_kb=$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo 2> /dev/null || echo 0)
mem_gb=$((${mem_kb:-0} / 1024 / 1024))
if [ "$cpus" -lt 2 ]; then
  fail "$cpus CPU: blinq needs at least 2 (sizing: docs/DEPLOYMENT.md §2)"
elif [ "$cpus" -lt 4 ]; then
  warn "$cpus CPUs: fine for small calls; 4 or more for full 25-person rooms (docs/DEPLOYMENT.md §2)"
else
  ok "$cpus CPUs"
fi
if [ "${mem_kb:-0}" -eq 0 ]; then
  warn "could not read the memory size"
elif [ "$mem_kb" -lt 1900000 ]; then
  fail "${mem_gb} GB RAM: blinq needs at least 2 GB (docs/DEPLOYMENT.md §2)"
elif [ "$mem_kb" -lt 3800000 ]; then
  warn "about ${mem_gb} GB RAM: 4 GB or more for full rooms and recordings (docs/DEPLOYMENT.md §2)"
else
  ok "about ${mem_gb} GB RAM"
fi
for key in rmem_max wmem_max; do
  value=$(cat "/proc/sys/net/core/$key" 2> /dev/null || echo 0)
  if [ "$value" -ge 7500000 ]; then
    ok "net.core.$key = $value"
  else
    warn "net.core.$key = $value (below 7500000; LiveKit and HTTP/3 drop UDP packets under load). Fix:
          printf 'net.core.rmem_max=7500000\\nnet.core.wmem_max=7500000\\n' | sudo tee /etc/sysctl.d/99-blinq.conf
          sudo sysctl --system"
  fi
done
if have timedatectl; then
  if [ "$(timedatectl show -p NTPSynchronized --value 2> /dev/null)" = yes ]; then
    ok "clock synchronized (NTP)"
  else
    warn "the clock is not NTP-synchronized (certificates and tokens need the right time): sudo timedatectl set-ntp true"
  fi
else
  warn "timedatectl not found: make sure the clock is synchronized (NTP)"
fi

section "Docker"
check_docker
if [ -n "${engine:-}" ]; then
  docker_root=$(docker info --format '{{.DockerRootDir}}' 2> /dev/null || echo /var/lib/docker)
  free_kb=$(df -Pk "$docker_root" 2> /dev/null | awk 'NR == 2 { print $4 }')
  if [ -z "$free_kb" ]; then
    warn "could not read the free space of $docker_root"
  elif [ "$free_kb" -lt 5000000 ]; then
    fail "$((free_kb / 1024 / 1024)) GB free in $docker_root: the images and the database need about 10 GB, plus recordings"
  elif [ "$free_kb" -lt 10000000 ]; then
    warn "$((free_kb / 1024 / 1024)) GB free in $docker_root: about 10 GB for images and the database, plus recordings"
  else
    ok "$((free_kb / 1024 / 1024)) GB free in $docker_root"
  fi
fi

section "Configuration ($env_file)"
# Last KEY=value of the file, without surrounding quotes.
env_value() {
  value=$(sed -n "s/^$1=//p" "$env_file" | tail -n 1)
  case "$value" in
    \"*\") value=${value#\"} value=${value%\"} ;;
    \'*\') value=${value#\'} value=${value%\'} ;;
  esac
  printf '%s' "$value"
}
is_placeholder() {
  case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
    change-me* | changeme* | replace-me* | replaceme* | example* | placeholder* | secret* | password*) return 0 ;;
  esac
  return 1
}

DOMAIN=''
TURN_DOMAIN=''
TLS_MODE=acme
LIVEKIT_NODE_IP=''
if [ ! -f "$env_file" ]; then
  fail "$env_file is missing: create it with sh scripts/init-env.sh"
else
  # shellcheck disable=SC2012 # the mode string of one known file, portable across GNU and BSD
  perms=$(ls -ln "$env_file" | cut -c5-10)
  if [ "$perms" = '------' ]; then ok "$env_file is readable by its owner only"; else fail "$env_file is readable by others: chmod 600 $env_file"; fi

  DOMAIN=$(env_value DOMAIN)
  TURN_DOMAIN=$(env_value TURN_DOMAIN)
  TLS_MODE=$(env_value TLS_MODE)
  TLS_MODE=${TLS_MODE:-acme}
  LIVEKIT_NODE_IP=$(env_value LIVEKIT_NODE_IP)

  case "$DOMAIN" in
    '') fail "DOMAIN is empty" ;;
    *example.com | *example.org | *example.net) fail "DOMAIN is still the example value ($DOMAIN)" ;;
    *) ok "DOMAIN=$DOMAIN" ;;
  esac
  if [ -z "$TURN_DOMAIN" ]; then
    warn "TURN_DOMAIN is empty: calls from networks that only allow HTTPS will not connect"
  elif [ "$TURN_DOMAIN" = "$DOMAIN" ]; then
    fail "TURN_DOMAIN must differ from DOMAIN"
  else
    ok "TURN_DOMAIN=$TURN_DOMAIN"
  fi
  case "$TLS_MODE" in
    acme)
      ok "TLS_MODE=acme"
      [ -n "$(env_value ACME_EMAIL)" ] || warn "ACME_EMAIL is empty: Let's Encrypt cannot send expiry notices"
      ;;
    internal) ok "TLS_MODE=internal (every client must trust Caddy's root certificate)" ;;
    files)
      ok "TLS_MODE=files"
      { [ -n "$(env_value TLS_CERT_FILE)" ] && [ -n "$(env_value TLS_KEY_FILE)" ]; } ||
        fail "TLS_MODE=files needs TLS_CERT_FILE and TLS_KEY_FILE (paths inside the caddy container)"
      ;;
    *) fail "TLS_MODE must be acme, internal or files (got '$TLS_MODE')" ;;
  esac

  for name in APP_SECRET LIVEKIT_API_SECRET; do
    value=$(env_value "$name")
    if [ -z "$value" ]; then
      fail "$name is empty (sh scripts/init-env.sh generates it)"
    elif is_placeholder "$value"; then
      fail "$name still has a placeholder value"
    elif [ "${#value}" -lt 32 ]; then
      fail "$name must have at least 32 characters"
    else
      ok "$name is set"
    fi
  done
  value=$(env_value LIVEKIT_API_KEY)
  case "$value" in
    '') fail "LIVEKIT_API_KEY is empty" ;;
    *[!A-Za-z0-9]*) fail "LIVEKIT_API_KEY must contain only letters and digits" ;;
    *) if is_placeholder "$value"; then fail "LIVEKIT_API_KEY still has a placeholder value"; else ok "LIVEKIT_API_KEY is set"; fi ;;
  esac
  value=$(env_value POSTGRES_PASSWORD)
  if [ -z "$value" ]; then
    fail "POSTGRES_PASSWORD is empty (sh scripts/init-env.sh generates it)"
  elif is_placeholder "$value"; then
    fail "POSTGRES_PASSWORD still has a placeholder value"
  else
    ok "POSTGRES_PASSWORD is set (it takes effect only when the database volume is created)"
  fi
  value=$(env_value RECORDING_ENCRYPTION_KEY)
  bytes=$(printf '%s' "$value" | base64 -d 2> /dev/null | wc -c | tr -d ' ')
  if is_placeholder "$value" || [ "$bytes" != 32 ]; then
    fail "RECORDING_ENCRYPTION_KEY must be the base64 of 32 random bytes (openssl rand -base64 32)"
  else
    ok "RECORDING_ENCRYPTION_KEY is set (back it up: without it, stored recordings are lost)"
  fi
  admin_password=$(env_value ADMIN_PASSWORD)
  if [ -z "$admin_password" ]; then
    ok "ADMIN_PASSWORD is empty (fine once the first admin exists; the first start needs it)"
  elif is_placeholder "$admin_password" || [ "${#admin_password}" -lt 12 ]; then
    fail "ADMIN_PASSWORD is a placeholder or shorter than 12 characters"
  else
    ok "ADMIN_EMAIL and ADMIN_PASSWORD are set (remove ADMIN_PASSWORD after the first login)"
  fi
  if [ -n "$(env_value SMTP_HOST)" ] && [ -z "$(env_value SMTP_FROM)" ]; then
    fail "SMTP_HOST is set but SMTP_FROM is empty"
  fi
  # Compose expands "$" in unquoted and double-quoted values.
  dollar=$(grep -E '^[A-Z_]+=' "$env_file" | grep -v -E "^[A-Z_]+='" | grep -F '$' | cut -d= -f1 | tr '\n' ' ')
  [ -z "$dollar" ] || warn "values of $dollar contain \"\$\", which Compose expands: wrap them in single quotes"
fi

section "DNS"
local_addresses() {
  if have ip; then
    ip -o addr show 2> /dev/null | awk '{ split($4, a, "/"); print a[1] }'
  elif have hostname; then
    hostname -I 2> /dev/null | tr ' ' '\n'
  fi
}
resolve() {
  if have getent; then
    getent ahosts "$1" 2> /dev/null | awk '{ print $1 }' | sort -u
  elif have dig; then
    { dig +short A "$1"; dig +short AAAA "$1"; } 2> /dev/null | grep -E '^[0-9a-fA-F:.]+$' | sort -u
  fi
}
LOCAL=$(local_addresses)
check_name() { # check_name VAR NAME
  [ -n "$2" ] || return 0
  addresses=$(resolve "$2")
  if [ -z "$addresses" ]; then
    if [ "$TLS_MODE" = acme ]; then
      fail "$1=$2 does not resolve: create its A (and AAAA) record first; Let's Encrypt validates it"
    else
      warn "$1=$2 does not resolve from this host: clients must be able to resolve it"
    fi
    return
  fi
  foreign=''
  for address in $addresses; do
    if [ "$address" = "$LIVEKIT_NODE_IP" ] || printf '%s\n' "$LOCAL" | grep -qxF "$address"; then continue; fi
    foreign="$foreign $address"
  done
  if [ -z "$foreign" ]; then
    ok "$1=$2 resolves to this server ($(echo "$addresses" | tr '\n' ' ' | sed 's/ $//'))"
  else
    warn "$1=$2 resolves to$foreign, which is neither LIVEKIT_NODE_IP nor a local address (fine behind 1:1 NAT when LIVEKIT_NODE_IP is the public IP)"
  fi
}
check_name DOMAIN "$DOMAIN"
check_name TURN_DOMAIN "$TURN_DOMAIN"

section "Ports"
port_value() { # port_value VAR DEFAULT
  value=''
  [ -f "$env_file" ] && value=$(env_value "$1")
  printf '%s' "${value:-$2}"
}
if [ -n "${engine:-}" ] && [ -n "$(docker compose --env-file "$env_file" ps -q 2> /dev/null)" ]; then
  ok "blinq is running (docker compose ps): port checks skipped"
elif ! have ss; then
  warn "ss not found (iproute2): cannot check the ports"
else
  LISTEN=$(ss -Hltnu 2> /dev/null | awk '{ n = split($5, a, ":"); print $1 " " a[n] }')
  check_port() { # check_port tcp|udp PORT LABEL
    if printf '%s\n' "$LISTEN" | grep -qx "$1 $2"; then
      fail "$2/$1 ($3) is in use: sudo ss -ltnup | grep ':$2 ' shows by what"
    else
      ok "$2/$1 free ($3)"
    fi
  }
  check_port tcp 80 "HTTP, ACME"
  check_port tcp 443 "HTTPS, TURN/TLS"
  check_port udp 443 "HTTP/3"
  check_port udp "$(port_value LIVEKIT_TURN_UDP_PORT 3478)" "TURN/UDP"
  check_port tcp "$(port_value LIVEKIT_RTC_TCP_PORT 7881)" "ICE/TCP"
  check_port tcp "$(port_value APP_PORT 3000)" "app, loopback"
  check_port tcp "$(port_value LIVEKIT_HTTP_PORT 7880)" "LiveKit API, loopback"
  check_port tcp "$(port_value LIVEKIT_TURN_TLS_PORT 5349)" "TURN behind Caddy"
  check_port tcp "$(port_value CADDY_HEALTH_PORT 2020)" "Caddy health, loopback"
fi

printf '\n'
if [ "$failures" -gt 0 ]; then
  echo "preflight: $failures failure(s), $warnings warning(s). Fix the failures before docker compose up."
  exit 1
fi
if [ "$warnings" -gt 0 ]; then
  echo "preflight: no failures, $warnings warning(s)."
  exit 2
fi
echo "preflight: all checks passed."
