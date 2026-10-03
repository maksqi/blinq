# Security

This document defines what blinq protects, against whom, and how. It is binding for every contributor: a change
that weakens a guarantee listed here needs an explicit decision recorded in this file.

## 1. Goals and non-goals

**Goals**
- The server operator, the media server (SFU), the network and anyone with database or disk access cannot see or
  hear live calls, and cannot read chat.
- Only people with a valid invite (or room membership) **and** the room key can join a room.
- Accounts are protected against credential stuffing, brute force, session theft and CSRF.
- The app is secure by default: HTTPS only, strict CSP, minimal network exposure, secrets only in `.env`.
- Recordings are encrypted at rest, access-controlled and retained only as long as configured.

**Non-goals (documented limitations)**
- **A malicious or compromised app server** can serve modified JavaScript that exfiltrates the room key. This is
  inherent to web-delivered E2EE. Integrity of the served code is the operator's responsibility.
- **Per-sender authenticity.** All participants share one key, so any key holder (together with a cooperating SFU)
  could impersonate another participant's media or messages.
- **Metadata privacy.** The server sees who joins which room and when, display names, participant counts, message
  sizes and timing, and audio levels (used for active-speaker detection).
- **Revoking a removed participant's knowledge of the key.** A removed participant can no longer connect, but still
  knows the key. The host is prompted to rotate it before the next meeting. Mid-call rotation is on the backlog.
- **Server-stored recordings are not end-to-end encrypted** (§6). The local-only recording mode is.

## 2. Threat model

| Adversary | Can | Must not be able to |
|---|---|---|
| Network attacker | Observe and modify traffic | Read anything (TLS everywhere, SRTP + E2EE frames), downgrade to HTTP (HSTS) |
| Curious or compromised SFU / LiveKit operator | See encrypted frames, signaling metadata, inject packets | Decrypt media or chat; get unencrypted media played or recorded (blocked client-side) |
| Database or disk thief (backups included) | Read every table and file | Recover passwords (argon2id), session tokens (hashed), room keys (never stored), recordings (BLQ1 with a key only in `.env`) |
| Outsider with a room link but no invite | Load the page | Get room info or a token (invite required unless room member) |
| Holder of an invite without the key (truncated link) | Call the API | Get a token (join proof missing) |
| Guest or participant | Use the call UI and API | Perform host actions, record, see other people's tokens, rejoin after removal |
| Co-host | Moderate participants | Manage co-hosts, act on the host, end the meeting for all, change room settings |
| Logged-in user | Use own rooms and recordings | Access other users' rooms/recordings (IDOR), admin endpoints |
| Admin | Manage users, settings, rooms, recordings | Decrypt live calls or chat (keys never reach the server) |

**Trust boundaries**
- Browser ↔ Caddy (public internet).
- Caddy ↔ app and LiveKit (loopback).
- App ↔ Postgres (unix socket).
- Browser ↔ browser, which crosses the SFU, protected by E2EE.

## 3. End-to-end encryption

### 3.1 Keys and derivations
All derivations use HKDF-SHA256 via WebCrypto. The exact info strings are in [`API.md`](API.md).

- **Room key `K`** — 32 random bytes generated in the browser when a room is created or its key is rotated.
  - It is transported only in the URL fragment `#k=` (browsers never send fragments to servers).
  - Kept in sessionStorage for the current tab, and in a localStorage key vault only for rooms the user owns or
    co-hosts. The vault is namespaced by user id and cleared on logout or a 401.
- **Join proof** `P = HKDF(K, "blinq/v1/join|"+slug)` — sent in POST bodies.
  - The server stores `sha256(P)` and compares in constant time.
  - It proves key possession without revealing `K`, since HKDF is one-way and `K` is 256 random bits.
  - Without a matching proof the server returns neither room info nor tokens.
- **Meeting epoch** — 16 random bytes created by the server per meeting and handed out with the token.
  - Per-meeting keys prevent AES-GCM IV reuse across meetings with a persistent room key.
- **Media key** = `HKDF(K, salt=epoch, "blinq/v1/media|"+slug)`, loaded into LiveKit's `ExternalE2EEKeyProvider`
  with `keySize: 256`. LiveKit's frame cryptor encrypts every audio and video frame (AES-GCM) in a worker.
- **Chat key** = `HKDF(K, salt=epoch, "blinq/v1/chat|"+slug)` for the app-message envelope.
- **Safety code** = `HKDF(K, salt=epoch, "blinq/v1/safety|"+slug)`, 80 bits shown as 16 characters.
  - Participants can compare it verbally.
  - It proves only that everyone has the same key.

### 3.2 Media
- The Room is created with LiveKit's `encryption` option (media + data). E2EE is enabled before connecting.
- Unsupported browsers (`isE2EESupported() === false`) get an explanatory screen. There is no silent fallback to
  unencrypted calls.
- **Unencrypted media is blocked.** `autoSubscribe` is off; the SubscriptionManager subscribes only to
  publications whose encryption is not `NONE`.
  - Anything else is never attached, mixed or recorded, and the UI shows a warning.
  - The E2EE badge means "all remote media in this call is encrypted", not merely "my encryption is on".
- **Codecs:** VP8 simulcast. AV1, backup codecs and Opus RED are disabled (not supported under E2EE). Safari
  earlier than 17.2 publishes without simulcast.

### 3.3 Chat, reactions and other app messages
- **Envelope:** each message is encrypted with the chat key using AES-256-GCM, a random 96-bit IV and
  AAD = `"blinq/app/v1|" + slug + "|" + senderIdentity`. It is then sent over LiveKit's (also encrypted) reliable
  data channel.
- **Receivers drop** a packet whose:
  - LiveKit `encryptionType` is `NONE`,
  - sender is unknown,
  - envelope sender differs from the LiveKit sender, or
  - message id was already seen.
- **Server hints:** data sent by the server (`blinq.srv.v1`) is only a hint to refetch state from the authenticated
  API.
  - It never carries tokens or secrets, and never triggers destructive actions.
  - "No sender" is not proof of server origin, because unknown and hidden participants look the same.
  - Authoritative state comes only from room metadata and participant attributes (server-written) and the API.
- **No RPC:** blinq registers no LiveKit RPC methods, because RPC delivers no encryption information.

### 3.4 Links and URL hygiene
- **Where secrets go:** every secret-bearing link keeps the secret in the fragment.
  - Room keys: `#k=`.
  - Room invite tokens: `#t=`.
  - Account invites, verification and reset tokens: `/invite#…`, `/verify-email#…`, `/reset-password#…`.
- **Stripping:** a client plugin runs first, captures the fragment into sessionStorage and strips it from the
  address bar before any route middleware runs. Redirects use only `route.path` and must be relative same-origin
  paths, which also blocks open redirects.
- **Sharing:** room links are shared client-side only (copy, `navigator.share`, `mailto:`). **The server never
  emails room links**, because the key would then pass through the server and SMTP.
- **Referrers:** `Referrer-Policy: no-referrer`.

### 3.5 Key rotation
- A host can rotate the room key when no meeting is live. This produces a new `K` and a new proof hash; old links
  stop working.
- After removing a participant or revoking an invite, the UI recommends rotating before the next meeting.

## 4. Accounts, sessions and access control

- **Passwords:**
  - argon2id (`m=19456 KiB, t=2, p=1`, OWASP) via `@node-rs/argon2`; at least 12 characters plus a
    common-password denylist.
  - Concurrent hashing is capped by a semaphore to prevent CPU exhaustion.
  - Unknown emails still pay the argon2 cost (dummy hash), and errors are generic (no account enumeration).
- **Sessions:**
  - 32 random bytes; the database stores `sha256`.
  - Cookie `__Host-blinq_session`: `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`.
  - Absolute lifetime of 30 days, idle lifetime of 7 days. The validation cache is at most 30 s.
  - Rotated on login and privilege change. Revoked on password change, disable or admin action; this also removes
    the user from live LiveKit rooms.
- **Guest sessions:** a per-room cookie `__Host-blinq_g_<slug>`, valid for 12 h.
- **Bootstrap admin:**
  - Created from `ADMIN_EMAIL`/`ADMIN_PASSWORD` only when no admin exists and bootstrap has never run.
  - The account must change its password on first login; until then every other API answers
    `AUTH_PASSWORD_CHANGE_REQUIRED`.
  - Placeholder or weak bootstrap passwords are refused at startup (only while bootstrap is pending).
  - There is no "first user becomes admin" rule.
- **Recovery:** `cli.mjs reset-password <email>` reads the new password from stdin (never argv), revokes sessions,
  clears throttling and writes an audit entry.
- **Registration:** `invite_only` (default), `open`, or `domain`. Domain mode requires SMTP and email verification,
  so anyone can't claim `@company.com`. Known trade-off: in open mode, registering an existing address answers 409
  (`CONFLICT`, reason `email_taken`), which reveals that the address has an account; login and password reset never
  reveal it. Admin-role invites must be bound to an email and expire within 24 h.
- **Brute force:**
  - Purpose-built limiters keyed by IP (IPv6 aggregated to /64), account and room, with exponential backoff and
    `Retry-After`.
  - No hard lockout, which attackers could use to lock out the admin.
  - Room passwords are limited per IP + room. Waiting requests are capped per room.
- **CSRF:**
  - Mutating requests must carry `Origin` equal to `PUBLIC_URL`, and `Sec-Fetch-Site: same-origin` when the
    header is present.
  - `SameSite=Lax` cookies add depth.
  - The LiveKit webhook is exempt: it is verified by signature and reachable only on loopback, and Caddy answers
    `/api/webhooks/*` with 404.
- **Authorization:**
  - Every handler authenticates with `requireUser`, `requireAdmin` or `resolveCaller`.
  - In-call endpoints resolve the caller to their own `call_participants` row and check the role against the
    permission matrix in `shared/utils/permissions.ts`.
  - Object access is always scoped by owner or role (no IDOR).
  - SSE and cancel endpoints for waiting requests accept only the session or guest cookie that owns the row.
- **LiveKit tokens:**
  - TTL of 5 minutes; LiveKit refreshes them to 10 minutes while connected. `canUpdateOwnMetadata` is false.
  - `canPublishSources` follows role, room policy and per-person allowances.
  - Tokens never grant `hidden`, `roomAdmin`, `roomCreate`, `roomRecord`, `recorder` or agent kind.
  - Rooms are created only by the server (`auto_create: false`).
- **Enforcement at LiveKit:**
  - Removal uses `revokeTokenTs` and marks the row final for the meeting.
  - The `participant_joined` webhook removes anyone whose row isn't admitted or joined.
  - Deleting a room or disabling a user removes affected participants.

## 5. Web application security

- **CSP** (nonce-based, via nuxt-security):
  `default-src 'self'; script-src 'self' 'nonce-…' 'strict-dynamic' 'wasm-unsafe-eval'; worker-src 'self' blob:;
  style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self';
  font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`.
  - Everything is self-hosted (fonts, MediaPipe wasm and model, RNNoise worklet).
  - `blob:` in `worker-src` exists only for the track-processors frame timer.
  - The RNNoise worklet is a same-origin file.
- **Other headers:**
  - HSTS (`max-age=31536000; includeSubDomains`, from Caddy); `X-Content-Type-Options: nosniff`;
    `Referrer-Policy: no-referrer`; COOP and CORP `same-origin`.
  - Permissions-Policy allowing `camera`, `microphone`, `display-capture`, `fullscreen`, `speaker-selection`,
    `picture-in-picture` and `autoplay` for `self` only (the nuxt-security default blocks media and is overridden).
- **Output encoding:** Vue escaping everywhere, and `v-html` is forbidden by lint. Chat renders text; links are
  auto-detected for `http(s)` only, with `rel="noopener noreferrer"`.
- **Display names:** normalized (control, bidi and zero-width characters removed, 1–64 characters); guests carry a
  visible badge.
- **Input validation:** shared zod schemas at every boundary. Request bodies are limited in Caddy (1 MB, larger only
  for the chunk upload route) and in handlers, which count streamed bytes.
- **Hosts and URLs:** absolute URLs are built only from `PUBLIC_URL`. `Host` and `X-Forwarded-Host` are never
  trusted, which prevents password-reset poisoning.
- **Identifiers:** LiveKit identities are random (`p_…`). Emails and user ids never appear in LiveKit identities,
  attributes or metadata. Room slugs have at least 10 random letters.

## 6. Recording security

- **Why the server can decrypt:** recording happens in the browser of a host or co-host (it is the only place with
  plaintext media). By default the file is uploaded and stored on the server, encrypted with
  `RECORDING_ENCRYPTION_KEY`. **The server and its admins can therefore decrypt server-stored recordings.**
  - The start dialog and the REC indicator say so.
  - The local-only mode saves to the recorder's device and never uploads.
- **Indicator:** every participant sees a REC indicator driven by server-written room metadata, including in the
  pre-join screen.
- **At rest (BLQ1):**
  - Streaming AEAD in the Tink style: per-file key `HKDF(master, salt, "blinq/v1/rec|"+recordingId)`, 1 MiB
    AES-256-GCM segments, `IV = noncePrefix ‖ index ‖ lastFlag`, header as AAD, and a mandatory final segment.
  - Truncation, reordering and tampering are detected, and Range reads stay possible.
  - Chunks are encrypted as they arrive.
- **Processing:**
  - Input and output never touch persistent disk in plaintext: they use a `pipe:` or a size-capped tmpfs.
  - ffprobe checks an allowlist first: container, codecs, at most 4096 px, duration limit.
  - ffmpeg runs with:
    - a forced demuxer and `-protocol_whitelist pipe,file`;
    - `-max_alloc`/`-max_pixels`;
    - strict mapping, with metadata, chapters, data and subtitle streams dropped;
    - always a re-encode to H.264/AAC.
  - The ffmpeg process gets a PATH-only environment (no secrets), a hard timeout with SIGKILL, `nice`, and
    container limits.
  - Accepted risk: ffmpeg runs as the app's own uid, because the container drops every capability and sets
    `no-new-privileges`, so it cannot switch users. Code execution through an ffmpeg demuxer bug could therefore read
    the app's environment from `/proc`. The input comes only from signed-in hosts and co-hosts and passes the ffprobe
    allowlist first; keep ffmpeg current (the pinned `mwader/static-ffmpeg` image).
- **Serving:**
  - Always `Content-Type: video/mp4`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox;
    default-src 'none'`, `Cache-Control: no-store` and an RFC 5987 filename.
  - Unprocessed or failed uploads are never served.
- **Access:**
  - The recorder, the room owner and admins can read recordings. Guests and plain participants can never record.
  - Every playback or download by an admin is written to the audit log.
  - Retention defaults to 30 days, with per-user quotas and free-disk checks.
- **Key management:** losing `RECORDING_ENCRYPTION_KEY` makes recordings unrecoverable. Back it up with `.env`. The
  file header carries a key id to allow rotation.

## 7. Infrastructure

- **Exposure:**
  - Public: 80/tcp (ACME + redirect), 443/tcp+udp (Caddy), 3478/udp (TURN), 7881/tcp (ICE/TCP), 50000–60000/udp
    (media).
  - On clouds with 1:1 NAT, also 30000–40000/udp (TURN relay hairpin).
  - Loopback only: 3000 (app), 7880 (LiveKit; `/twirp` is never proxied), 2020 (Caddy health).
  - 5349 (TURN plaintext from Caddy) listens on all interfaces but only accepts PROXY-protocol connections from
    loopback. Keep it closed in the firewall.
- **Loopback binding:** the app is forced to `127.0.0.1` (`NITRO_HOST`), asserted at startup and checked in CI with
  `ss -tulpn`.
- **Postgres:** `network_mode: none`, unix socket only, `scram-sha-256` even for local connections.
- **Containers:** no new privileges, all capabilities dropped (Caddy keeps `NET_BIND_SERVICE`), read-only root
  filesystems with tmpfs where possible, non-root app user. Docker ≥ 28.0.1 is recommended (`preflight.sh` checks).
- **Secrets:**
  - Only in `.env` (mode 600, excluded from Docker build context and git), validated at boot.
  - Placeholder values refuse to start. `scripts/init-env.sh` generates strong random values.
- **Caddy:**
  - Admin API off.
  - `access_token` query parameters are redacted from access logs.
  - The TURN hostname serves no content: HTTP requests are aborted and TLS-ALPN challenges are disabled.

## 8. Logging and privacy

- **Redaction:** logs never contain passwords, tokens (session, guest, invite, reset, verify, LiveKit), proofs or
  keys. The logger redacts known fields, and E2E tests scan app and Caddy logs for secrets.
- **Audit log:**
  - Covers admin actions, host moderation, security events (login failures, password changes, session
    revocations) and recording playback/downloads.
  - The actor is a user or a participant.
  - Retention defaults to 180 days.
- **IP retention:** IP addresses in sessions, guest sessions and the audit log are erased after 30 days by default
  (configurable).

## 9. Supply chain

- **pnpm:**
  - `allowBuilds` lists every package allowed to run install scripts; everything else is denied.
  - `minimumReleaseAge` avoids freshly published (possibly malicious) versions.
  - The lockfile is committed and CI installs with `--frozen-lockfile`.
  - Local patches (`patchedDependencies`, `patches/`) are reviewed like code and each one states why it exists. The
    only one, for livekit-client 2.22.3, marks encrypted data packets as GCM so receivers can keep rejecting
    unencrypted ones (§3.3); a unit test fails when an upgrade stops applying it.
- **Pinning:** GitHub Actions are pinned by commit SHA. Container images are pinned by version (digest pinning
  optional).
- **Scanning:** gitleaks scans for committed secrets. `pnpm audit` runs in CI; high or critical findings block a
  release.
- **Forbidden packages:** anything that phones home. For example `@mediapipe/tasks-vision` 1.x, which is reported to
  send telemetry, stays pinned at 0.10.14.

## 10. Verification

Security properties are tested, not assumed. Test locations are listed in [`TESTING.md`](TESTING.md).

- **E2EE:**
  - The key never appears in any request URL or body, WebSocket frame, SSE URL, database dump or log.
  - A wrong-key or unencrypted publisher gets no frames.
  - Chat payloads on the wire are ciphertext.
- **Access control:**
  - Table-driven authorization matrix tests for every API route: anonymous, guest, participant, co-host, host, user,
    admin.
  - IDOR tests for rooms and recordings.
  - SSE ownership tests; removed participants cannot rejoin.
- **Web:**
  - CSRF rejection; cookie flags; headers and CSP on every page type.
  - Zero `securitypolicyviolation` events in E2E; XSS payloads render as text.
- **Rate limiting and brute force:** backoff with `Retry-After`; no account enumeration; bootstrap and
  `reset-password` behavior.
- **Recording:** stored bytes are ciphertext; tampering or truncation is detected; malicious media fixtures are
  rejected; access control is enforced; admin access is audited.
- **Infrastructure:** `ss -tulpn` in the production smoke test shows only the intended public listeners.

## 11. Reporting vulnerabilities

Please report suspected vulnerabilities privately to the maintainers (contact to be published with the first
release) rather than opening a public issue.
