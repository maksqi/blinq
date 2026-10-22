#!/bin/sh
# Main process of the E2E runner container (docker/e2e/runner.compose.yml): a sound server for the browsers, then
# idle. scripts/e2e-docker.sh runs the tests in this container with `docker compose exec`.
#
# Firefox plays audio only through PulseAudio. Without a server every AudioContext stays suspended, so the app's
# microphone chain publishes silence and Web Audio specs fail. This PulseAudio has a single null sink: browsers play
# into it and nothing reaches a speaker. Anonymous access on a private socket (PULSE_SERVER, set in the image) is
# enough, since only this container's processes can reach it.
set -eu

socket=${PULSE_SERVER#unix:}
mkdir -p "$(dirname "$socket")"
# -n: no default.pa (no hardware detection, D-Bus or X11 modules); no realtime scheduling (it asks rtkit over D-Bus,
# which a container lacks). Root is fine in a throwaway container.
pulseaudio --daemonize=no --exit-idle-time=-1 --disallow-exit -n --realtime=no --high-priority=no \
  --log-target=stderr --log-level=error \
  --load="module-native-protocol-unix auth-anonymous=1 socket=$socket" \
  --load="module-null-sink sink_name=blinq_null sink_properties=device.description=blinq-null-sink" &

i=0
until pactl info > /dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -ge 50 ]; then
    echo "runner-init: PulseAudio did not start" >&2
    exit 1
  fi
  sleep 0.2
done
pactl set-default-sink blinq_null
echo "runner-init: PulseAudio is up (null sink blinq_null)" >&2

exec sleep infinity
