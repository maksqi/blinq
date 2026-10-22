# syntax=docker/dockerfile:1
# blinq Caddy image: Caddy 2.11.4 with caddy-l4 (TURN/TLS on port 443, routed by SNI) and the blinq entrypoint that
# renders the Caddyfile for this deployment (docs/DEPLOYMENT.md §6). docker-compose.yml builds it as blinq-caddy:local.

# Cross-compiles on the build machine's platform, so a multi-platform build needs no emulation.
FROM --platform=$BUILDPLATFORM caddy:2.11.4-builder AS build
ARG TARGETOS
ARG TARGETARCH
# No file capabilities: the container runs as root with only NET_BIND_SERVICE (docker-compose.yml).
# (decision) Caddy 2.11.4 pins Go modules with known HIGH vulnerabilities (x/crypto, x/net, x/text, grpc,
# klauspost/compress), and its builder image ships Go 1.26.8 (net/http and crypto/tls advisories). The replacements
# raise the modules to fixed releases (one consistent set: what x/net 0.60.0 requires) and GOTOOLCHAIN builds with the
# fixed Go release, instead of moving to Caddy 2.11.6+, which changes defaults and is not the release caddy-l4 v0.1.2
# is built against. Drop them when Caddy is upgraded; `trivy image` on the result must report none of them.
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH XCADDY_SETCAP=0 GOTOOLCHAIN=go1.26.10 \
    xcaddy build v2.11.4 --with github.com/mholt/caddy-l4@v0.1.2 \
      --replace golang.org/x/crypto=golang.org/x/crypto@v0.57.0 \
      --replace golang.org/x/net=golang.org/x/net@v0.60.0 \
      --replace golang.org/x/text=golang.org/x/text@v0.42.0 \
      --replace google.golang.org/grpc=google.golang.org/grpc@v1.83.2 \
      --replace github.com/klauspost/compress=github.com/klauspost/compress@v1.18.7 \
      --output /out/caddy

FROM caddy:2.11.4-alpine
LABEL org.opencontainers.image.title="blinq-caddy" \
      org.opencontainers.image.description="Caddy 2.11.4 with caddy-l4 for blinq" \
      org.opencontainers.image.source="https://github.com/maksqi/blinq"
COPY --from=build /out/caddy /usr/bin/caddy
COPY site.caddyfile turn-site.caddyfile turn-listener.caddyfile health.caddyfile /etc/blinq/caddy/
COPY --chmod=0755 entrypoint.sh /usr/local/bin/blinq-caddy
HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --start-interval=1s --retries=6 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${CADDY_HEALTH_PORT:-2020}/" || exit 1
ENTRYPOINT ["/usr/local/bin/blinq-caddy"]
CMD []
