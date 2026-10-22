# E2E runner image (docs/TESTING.md §6.2). scripts/e2e-docker.sh builds it with docker/e2e as the build context, so
# nothing from the repository enters the image: the checkout is bind-mounted at run time.
#
# The Playwright image matches @playwright/test 1.63.0 (pnpm-lock.yaml); change both together. On top of it:
# - ffmpeg and ffprobe 9 (static build, as in CI): recording specs and the app's server-side transcoding call them;
# - psql: scripts/e2e.sh recreates the e2e database over TCP;
# - the docker CLI: security/log-scan and rooms/key-leak read the e2e LiveKit and Postgres containers through the
#   mounted Docker socket;
# - PulseAudio with a null sink (runner-init.sh): without a sound server Firefox never runs an AudioContext;
# - an Xvfb display (runner-init.sh; Xvfb and Mesa come with the base image): headless Firefox has WebGL only with one;
# - pnpm, the version in package.json's packageManager field.
FROM mwader/static-ffmpeg:9.0.2 AS ffmpeg
FROM docker:29.8.0-cli AS docker-cli

FROM mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    postgresql-client pulseaudio pulseaudio-utils \
  && rm -rf /var/lib/apt/lists/*

COPY --from=ffmpeg /ffmpeg /ffprobe /usr/local/bin/
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
RUN npm install --global --no-audit --no-fund pnpm@11.20.0 \
  && pnpm --version && ffmpeg -hide_banner -version | head -n 1 && docker --version && psql --version

COPY runner-init.sh /usr/local/bin/blinq-e2e-runner-init

# Every process in the runner (Firefox, Chromium, pactl) finds the PulseAudio server through this socket.
ENV PULSE_SERVER=unix:/run/blinq-pulse/native
# The Xvfb display of runner-init.sh: headless Firefox needs an X display for WebGL (background blur).
ENV DISPLAY=:99

CMD ["sh", "/usr/local/bin/blinq-e2e-runner-init"]
