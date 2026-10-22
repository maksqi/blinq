# Changelog

All notable changes to blinq are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-10-22

The first release: self-hosted, end-to-end encrypted video meetings of up to 25 people on one Linux server, started
with `docker compose up`.

### Added

#### Accounts and sign-in

- Invite-only accounts by default. Admins can switch to open registration or registration restricted to email domains
  (domain mode needs SMTP and verifies the address).
- Account invites: single-use links, optionally bound to an email address. Invites for the admin role are always bound
  and expire within 24 hours.
- Email verification and password reset by email when SMTP is configured, password change, profile name, and a list
  of your sessions that you can revoke one by one.
- The first admin comes from `ADMIN_EMAIL` and `ADMIN_PASSWORD` in `.env` and must choose a new password at the first
  sign-in. There is no "first user becomes admin" rule.
- Passwords need at least 12 characters and are checked against a list of common passwords.

#### Admin panel

- Users: create with a temporary password (shown once or emailed), invite, disable, change role, reset the password,
  revoke sessions and delete. The last admin cannot be demoted, disabled or deleted.
- Settings that apply without a restart: registration mode and allowed domains, guests, the maximum camera and
  screen-share quality, participant and room limits, recording (on or off, retention, maximum duration and resolution,
  per-user quota), and how long IP addresses and the audit log are kept.
- Every room with its live participant count, ending or deleting a room, and each room's meeting history (metadata
  only: never chat, media or keys).
- The audit log with filters, the SMTP status with a test email, and all stored recordings.

#### Rooms, invites and joining

- Persistent rooms and instant meetings from the dashboard. The browser generates each room's address and its 256-bit
  room key; the key travels only in the link fragment (`#k=…`), which browsers never send to a server.
- Joining proves possession of the key without revealing it: without the key, the server gives out neither room
  details nor a meeting token.
- Room settings: name, password, waiting room, guests allowed, mute on join, whether people may unmute themselves,
  who may share the screen (everyone or hosts), chat on or off, and up to 25 participants.
- Room invite links with a label, an expiry (1 hour, 24 hours, 7 days or never) and an optional number of uses; links
  can be revoked. They are shared from the browser (copy, the system share sheet or your mail app); the server never
  emails a room link.
- Co-hosts, and key rotation between meetings: old links stop working.
- Guests join from an invite link without an account. A waiting room lets hosts admit or deny people as they arrive.
- A clear screen with a next step for every reason a join can fail, and a prompt when the meeting is already open in
  another tab of the same browser.

#### Calls

- A pre-join screen with camera preview, device selection and effects.
- Grid view (up to 5×5, paged on phones) and speaker view, pinning, an active-speaker highlight, connection quality and
  muted indicators, and a reconnect banner.
- Screen share at 720p–1080p and 5–30 fps within the admin's limits, with tab or system audio where the browser offers
  it.
- An encryption badge that turns green only when all remote media is encrypted, with a safety code that participants
  compare to confirm they share one key.
- End-to-end encrypted chat with clickable links, reactions, and raise hand with an ordered queue.
- Host and co-host controls: the waiting-room panel; a participants panel with search; per person: mute the microphone,
  stop the camera or screen share, ask to unmute, allow or take away the microphone and camera, volume for everyone,
  rename, make co-host, lower hand and remove; for the room: mute all, lock, live room settings and end for all. After
  a removal the host is prompted to rotate the key before the next meeting.
- Keyboard shortcuts: M (microphone), V (camera), hold Space to talk while muted, ? (help). They also work with
  non-Latin keyboard layouts.
- An Invite button in the call for hosts and co-hosts.

#### Media processing

- Background blur (light or strong) and noise suppression (off, the browser's own, or RNNoise), plus your own
  microphone volume, in pre-join and during the call. Switching never restarts your audio or video for the others.
- Choices are remembered per device. All models and audio processors are served by your own server; browsers that
  cannot run an effect get an explanation, and heavy CPU use shows a warning.

#### Recording

- Hosts and co-hosts with an account record in their own browser, the only place where the media is not encrypted. The
  recording shows the participant grid with names (the shared screen when someone presents) and mixes everyone's
  audio.
- Two modes: uploaded to the server (encrypted at rest with `RECORDING_ENCRYPTION_KEY`, converted to an MP4 file, and
  playable or downloadable by the recorder, the room owner and admins), or saved only on the recording device, which
  keeps it end-to-end encrypted.
- Everyone sees a REC indicator, including on the pre-join screen. A recording whose recorder leaves without stopping is
  finished with what was uploaded.
- Retention (30 days by default), per-user quotas and free-disk checks.

#### Interface

- Dark and light theme (follows the system), a responsive layout down to phones with touch-sized controls, and
  keyboard and screen-reader support, checked with axe in both themes.

#### Deployment and operations

- One `docker compose up -d --wait` starts Caddy, the app, LiveKit and PostgreSQL on a Linux server with host
  networking. PostgreSQL has no network at all, the app listens on loopback only, and Caddy is the only way in.
- Automatic HTTPS (Let's Encrypt, Caddy's internal CA for LAN installs, or your own certificate files), HTTP/3, and
  TURN over TLS on port 443 for networks that allow only HTTPS.
- `scripts/init-env.sh` writes `.env` with generated secrets, and `scripts/preflight.sh` checks the server (DNS, ports,
  Docker, CPU, RAM, UDP buffers, clock, disk) before the first start.
- Migrations run on every start, and the first admin is created on the first one. A command-line tool resets any
  account's password, reading it from stdin.
- `/api/health` and `/api/ready`, a one-line startup summary, JSON logs on request, and rotated container logs.
- Optional `LIVEKIT_MAX_TRACKS` and `LIVEKIT_MAX_BYTES_PER_SEC` settings match LiveKit's limits to the server.
- Documented backup and restore, upgrades, sizing from load tests, and troubleshooting (README and
  `docs/DEPLOYMENT.md`).

### Security

#### End-to-end encryption

- The room key never reaches the server. Each meeting derives its own media, chat and safety-code keys from it, so
  the SFU, TURN, the network, the database and backups see only ciphertext.
- Audio and video are encrypted frame by frame (AES-GCM); chat, reactions and other app messages travel in an
  AES-256-GCM envelope bound to the room and the sender. Messages that are unencrypted, from an unknown sender, repeated
  or more than 5 minutes away from the local clock are dropped.
- Unencrypted media is never played, mixed or recorded. A participant who ever announces an unencrypted track stays
  blocked for the rest of the call, and frames that cannot be decrypted are dropped, so a compromised media server
  cannot slip plaintext into a call.
- Keys and other secrets in links (room keys, invite tokens, account and reset tokens) stay in the URL fragment and are
  removed from the address bar on arrival. Forms cannot put credentials or links into the URL, even before the page
  has finished loading.
- Keys kept for the rooms you own or co-host are cleared on sign-out and when the session expires.

#### Accounts and abuse

- Passwords are hashed with argon2id. Unknown email addresses take as long as known ones, and password-reset requests
  answer before any account lookup, so neither reveals whether an account exists.
- Sign-in backoff without a hard lockout: attempts count before the password is checked, so parallel guesses cannot
  race it. Waits apply per network and per account, and the account's wait only slows networks that already failed
  for it, so its owner can always sign in from a clean network. At most 8 sign-ins run at once per network, and
  password hashing is capped (4 at a time, 16 waiting, then 429).
- Room passwords have the same backoff per network and room. Changing a room password counts against the user's
  room-creation limit.
- After a removal or denial, joiners from the same network go through the waiting room for the rest of the meeting.
- Waiting rooms hold at most 50 requests, and each network at most 50 waiting-room connections.
- Sessions use `__Host-` cookies (`HttpOnly`, `Secure`, `SameSite=Lax`), rotate on sign-in and privilege changes, and
  are revoked by a password change, a disable or an admin. Every mutating request must come from the app's own origin
  (CSRF protection).

#### Web and server

- A strict, nonce-based Content Security Policy with no third-party sources, HSTS, `no-referrer`, COOP and CORP
  `same-origin`, and a Permissions-Policy that allows camera, microphone and screen capture for the app itself only.
- API responses are never cached and carry only an error code and message on failure (no URLs, internal messages or
  stack traces). Request bodies are limited to 1 MB by Caddy and again by the app, including bodies sent without a
  length.
- Caddy's access log keeps no query strings for pages and redacts credentials, tokens, keys and LiveKit's signaling
  parameters on API and signaling requests. App logs redact secrets.
- Recordings are stored encrypted (authenticated 1 MiB segments, so truncation and tampering are detected). Uploads are
  checked against an allowlist before a hardened ffmpeg re-encodes them, plaintext stays in a RAM-only work area, and
  files are served with a sandboxing Content Security Policy. Every playback or download by an admin is audited.

#### Containers and supply chain

- Containers run without new privileges, with all capabilities dropped (except what Caddy and PostgreSQL's startup
  need) and read-only root filesystems. No container publishes ports.
- Images are pinned to full versions. The app's runtime image contains no package manager, and Caddy is built with
  patched Go modules. The release scan (trivy) found no fixable HIGH or CRITICAL vulnerability in either image.
- Dependencies install from a frozen lockfile, only allowlisted packages may run install scripts, and freshly
  published versions are held back. The two local patches (livekit-client and @tanstack/vue-form) are reviewed and
  guarded by tests.
- Secrets live only in `.env` (generated by `scripts/init-env.sh`); placeholder values refuse to start.

### Known limitations

- **A compromised app server can steal room keys.** It could serve JavaScript that reads the key. This is inherent to
  end-to-end encryption delivered by a website: deploy tagged releases and protect the server.
- **No per-sender authenticity.** Everyone in a meeting shares one key, so any key holder could, with a cooperating
  media server, impersonate another participant.
- **The server sees metadata:** who joins which room and when, display names, participant counts, message sizes and
  timing, and audio levels (for the active-speaker highlight).
- **A removed participant still knows the key.** They cannot reconnect, and joiners from their network go through the
  waiting room, but with an invite link from another network they can ask to join again: lock the room or revoke the
  link. The key can be rotated only between meetings; mid-call key rotation is planned.
- **Server-stored recordings are not end-to-end encrypted:** the server and its admins can decrypt them. Local-only
  recordings are. `RECORDING_ENCRYPTION_KEY` cannot be rotated; losing it makes stored recordings unrecoverable.
- **One server only.** There is no multi-node mode (LiveKit with Redis, a shared event bus and limiters).
- **Chat** has no history for people who join later and no private messages.
- **Not yet available:** virtual backgrounds with images, sign-in through OIDC providers, scheduled meetings and
  calendar integration, a deny-all button in the waiting room, adding co-hosts outside a call, and published container
  images (you build the images on the server).
- **Browsers:** no screen sharing on iOS or Android; no speaker selection on Safari, iOS or Android; Safari before 17.2
  sends video without simulcast; browsers without support for end-to-end encryption cannot join. Safari on macOS is
  tested by hand, not automatically.
- **Poor networks:** under heavy packet loss (tested: 5 % loss, 150 ms, 500 kbit/s) video drops to a few frames per
  second and keeps a high resolution rather than switching to a lower layer; the call stays connected and recovers
  within seconds.
- **Sizing** is measured on one machine; the figures for a Linux VM are planning values until they are confirmed on a
  dedicated server.
- **Deployment:** Linux with Docker Engine only (Docker Desktop is not supported in production), and no CDN or other
  reverse proxy in front of Caddy.

[Unreleased]: https://github.com/maksqi/blinq/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/maksqi/blinq/releases/tag/v1.0.0
