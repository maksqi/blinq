#!/bin/sh
# Main process of the E2E runner container (docker/e2e/runner.compose.yml): a virtual display and a sound server for
# the browsers, then idle. scripts/e2e-docker.sh runs the tests in this container with `docker compose exec`.
#
# Headless Firefox on Linux creates WebGL contexts only through an X display (GLX). Without one every
# getContext('webgl2') fails ("Exhausted GL driver options"), so background blur is unavailable and the blur specs
# cannot run; no Firefox pref or EGL setting changes that in headless mode. Xvfb provides the display (DISPLAY is set
# in the image) and Mesa's llvmpipe renders on the CPU. The browsers stay headless and show no window. Headless
# Chromium (SwiftShader) and WebKit do not use the display.
#
# Firefox plays audio only through PulseAudio. Without a server every AudioContext stays suspended, so the app's
# microphone chain publishes silence and Web Audio specs fail. This PulseAudio has a single null sink: browsers play
# into it and nothing reaches a speaker. Anonymous access on a private socket (PULSE_SERVER, set in the image) is
# enough, since only this container's processes can reach it.
set -eu

# DISPLAY is :<n>; Xvfb serves it on /tmp/.X11-unix/X<n> (no TCP).
display=${DISPLAY#:}
Xvfb ":$display" -screen 0 1920x1080x24 -nolisten tcp > /dev/null 2>&1 &
i=0
until [ -S "/tmp/.X11-unix/X$display" ]; do
  i=$((i + 1))
  if [ "$i" -ge 50 ]; then
    echo "runner-init: Xvfb did not start" >&2
    exit 1
  fi
  sleep 0.2
done
echo "runner-init: Xvfb is up (DISPLAY $DISPLAY)" >&2

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
