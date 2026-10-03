# blinq API

The HTTP API served by Nitro under `/api`, plus the LiveKit, SSE, link, cookie and crypto contracts the clients rely on.
The zod schemas in `shared/schemas/<domain>.ts` are the executable form of this document. If the two disagree, the
schema wins and this document gets fixed. Items marked "(decision)" were not fixed by the plan and await orchestrator
review.

## 1. Conventions

- **Base path** `/api`. Request and response bodies are JSON (`application/json; charset=utf-8`), except the SSE stream,
  recording chunk uploads (`application/octet-stream`) and the recording file (`video/mp4`). Every `/api/**` response
  has `cache-control: no-store`.
- **Body size**: 1 MB (Caddy and nuxt-security). `/api/recordings/**` allows 20 MB; the chunk handler enforces
  `RECORDING_CHUNK_MAX_BYTES` (16 MiB) while streaming.
- **Types** below are TypeScript-style and use the names exported from `shared/schemas/*`. `Id` = uuid string,
  `IsoDate` = ISO 8601 string with offset, `B64u` = base64url without padding. Request schemas are zod objects
  parsed with `readValidatedBody(event, schema.parse)`; unknown keys are stripped, never stored.
- **Pagination**: list endpoints take `?page=1&pageSize=25&q=` (`paginationQuerySchema`: page ≥ 1, pageSize 1..100,
  default 25, `q` ≤ 200 chars) and return `Paginated<T> = { items: T[]; page: number; pageSize: number; total: number }`.
- **Timestamps** are UTC ISO strings; durations are milliseconds.

### 1.1 Auth modes
| Mode | Meaning |
|---|---|
| `none` | No credentials needed (a session, if present, may change the result). |
| `session` | Cookie `__Host-blinq_session` → `requireUser`. Missing or expired → 401 `UNAUTHENTICATED`. |
| `admin` | `session` and `role = 'admin'` → `requireAdmin`; otherwise 403 `FORBIDDEN`. |
| `caller` | `session` or the room's guest cookie `__Host-blinq_g_<slug>` → `resolveCaller(event, roomId)`: the caller's own `call_participants` row in the live meeting; otherwise 403 `CALL_NOT_PARTICIPANT`. The action is then checked with `canPerform` (`shared/utils/permissions.ts`) → 403 `CALL_FORBIDDEN`. |
| `request-owner` | The user session or guest session that created the join request; anyone else → 403 `FORBIDDEN`. |
| `webhook` | LiveKit webhook signature (`Authorization` header, verified by `WebhookReceiver`); loopback only. |

- **Forced password change**: while the signed-in user has `mustChangePassword`, every endpoint answers 403
  `AUTH_PASSWORD_CHANGE_REQUIRED` except `GET /api/auth/me`, `POST /api/auth/password`, `POST /api/auth/logout`,
  `GET /api/config`, `GET /api/health`, `GET /api/ready`.
- **CSRF**: every `POST`, `PUT`, `PATCH` and `DELETE` needs `Origin` equal to the origin of `PUBLIC_URL`, and
  `Sec-Fetch-Site: same-origin` when that header is present; otherwise 403 `CSRF_REJECTED`. `Host` and
  `X-Forwarded-Host` are never trusted. `POST /api/webhooks/livekit` is exempt (signature auth, never public).
- **Client IP** comes from the loopback proxy (the first `X-Forwarded-For` entry, trusted only when the TCP peer is loopback — Caddy replaces untrusted values). IPv6
  addresses are keyed by their /64.

### 1.2 Rate limits (decision on all numbers)
All limiters answer 429 `RATE_LIMITED` with `Retry-After` (seconds). Backoff is exponential, never a hard lockout.

| Limiter | Key | Rule | Used by |
|---|---|---|---|
| `login` | `email:<address>` and `ip:<address>` / `net:<ipv6 /64>` (table `login_throttle`) | 5 free failures, then `2^(n-5)` s, max 900 s; success resets the email key | `POST /api/auth/login` |
| `auth-ip` | IP (/64) | 10 per minute | register, verify-email, password-reset/*, invites/* |
| `reset-email` | email | 3 per hour, silent (still 202) | `POST /api/auth/password-reset/request` |
| `join-ip` | IP (/64) | 30 per minute | `POST /api/join/:slug/info`, `POST /api/join/:slug` |
| `room-password` | room + IP (/64) | backoff like `login` | wrong room passwords |
| `room-create` | user | 20 per hour | `POST /api/rooms`, `POST /api/rooms/:id/invites` |
| `call-actions` | participant row | 120 per minute | `/api/calls/**` |
| `recording-chunks` | recording | 8 per second | `PUT /api/recordings/:id/chunks/:seq` |

The waiting room holds at most 50 requests per room (409 `LOBBY_FULL`); this is a cap, not a rate limit.

### 1.3 Errors
Handlers throw `apiError(code, statusCode, details?)` (`server/utils/api-error.ts`). Every error response is:

```ts
type ApiErrorBody = { statusCode: number; statusMessage: string; data: { code: ErrorCode; details?: unknown } }
```

`statusMessage` is the English text from `ERROR_MESSAGES`. Validation errors carry
`details: { issues: Array<{ path: string; message: string }> }` (decision). Codes live in
`shared/utils/error-codes/index.ts`; the status per code (decision):

| Domain | Code → status |
|---|---|
| common | `VALIDATION_FAILED` 400 · `CSRF_REJECTED` 403 · `RATE_LIMITED` 429 · `UNAUTHENTICATED` 401 · `FORBIDDEN` 403 · `NOT_FOUND` 404 · `CONFLICT` 409 · `INTERNAL` 500 (501 for unimplemented stubs) · `SERVICE_UNAVAILABLE` 503 |
| auth | `AUTH_INVALID_CREDENTIALS` 401 · `AUTH_PASSWORD_CHANGE_REQUIRED` 403 · `AUTH_PASSWORD_WEAK` 400 · `AUTH_ACCOUNT_DISABLED` 403 · `AUTH_EMAIL_NOT_VERIFIED` 403 · `AUTH_TOKEN_INVALID` 400 · `AUTH_TOKEN_EXPIRED` 400 · `REGISTRATION_CLOSED` 403 · `REGISTRATION_DOMAIN_NOT_ALLOWED` 403 · `INVITE_INVALID` 400 · `INVITE_EXPIRED` 410 · `INVITE_USED` 410 |
| rooms / join / calls | `ROOM_NOT_FOUND` 404 · `ROOM_LIMIT_REACHED` 409 · `ROOM_KEY_INVALID` 403 · `ROOM_LOCKED` 403 · `ROOM_FULL` 409 · `ROOM_PASSWORD_REQUIRED` 403 · `ROOM_PASSWORD_INVALID` 403 · `ROOM_GUESTS_NOT_ALLOWED` 403 · `ROOM_INVITE_REQUIRED` 403 · `ROOM_INVITE_INVALID` 403 · `JOIN_REMOVED` 403 · `JOIN_DENIED` 403 · `LOBBY_FULL` 409 · `MEETING_LIVE` 409 · `CALL_NOT_PARTICIPANT` 403 · `CALL_FORBIDDEN` 403 |
| recording | `RECORDING_DISABLED` 403 · `RECORDING_ACTIVE` 409 · `RECORDING_NOT_ALLOWED` 403 · `RECORDING_QUOTA_EXCEEDED` 409 · `RECORDING_TOO_LARGE` 413 · `RECORDING_INVALID_MEDIA` 422 · `RECORDING_NOT_READY` 409 |

`CONFLICT` uses `details.reason` for specifics: `last_admin`, `self`, `slug_taken`, `email_taken`, `already_cohost`,
`not_recording`, `not_live` (decision).

Framework errors keep their HTTP status and get the closest generic code: 405 → `NOT_FOUND`; 413 (body over the size
limit), 415 and 416 → `VALIDATION_FAILED`. `SERVICE_UNAVAILABLE` 503 also answers any call that needs LiveKit while it
is unreachable (join, in-call actions, recording start and upload).

## 2. Public

| Method | Path | Auth | Request | Response | Errors |
|---|---|---|---|---|---|
| GET | `/api/config` | none | — | `PublicConfig` | — |
| GET | `/api/health` | none | — | `{ status: 'ok' }` (liveness, no DB access) | — |
| GET | `/api/ready` | none | — | `{ status: 'ready'; checks: { db: 'ok'; migrations: 'ok'; livekit: 'ok' \| 'down' } }` | `SERVICE_UNAVAILABLE` 503 with `details.checks` |

```ts
type PublicConfig = {           // publicConfigSchema
  appName: string; publicUrl: string
  livekitUrl: string            // LIVEKIT_PUBLIC_URL, default wss://$DOMAIN (the SDK uses /rtc/v1, falls back to /rtc)
  registration: { mode: 'invite_only' | 'open' | 'domain'; allowedDomains: string[] }
  guestsAllowed: boolean; smtpEnabled: boolean
  media: { maxCameraResolution: '720p' | '1080p'; maxScreenShareResolution: '720p' | '1080p'; maxScreenShareFps: number }
  limits: { maxParticipantsPerRoom: number }
  recording: { enabled: boolean; maxDurationMinutes: number; maxResolution: '720p' | '1080p' }
}
```
Readiness gates on the DB and applied migrations only; LiveKit is reported, not gating (decision).

## 3. Auth

| Method | Path | Auth | Limit | Request | Response | Errors |
|---|---|---|---|---|---|---|
| POST | `/api/auth/login` | none | `login` | `loginSchema` | `{ user: AuthUser }` + session cookie | `AUTH_INVALID_CREDENTIALS`, `AUTH_ACCOUNT_DISABLED`, `AUTH_EMAIL_NOT_VERIFIED`, `RATE_LIMITED` |
| POST | `/api/auth/logout` | session | — | — | 204, cookie cleared | `UNAUTHENTICATED` |
| GET | `/api/auth/me` | none | — | — | `MeResponse` (`{ user: null }` when anonymous) | — |
| POST | `/api/auth/register` | none | `auth-ip` | `registerSchema` | 201 `{ user: AuthUser }` + cookie (open) · 202 `{ verificationRequired: true }` (domain) | `REGISTRATION_CLOSED`, `REGISTRATION_DOMAIN_NOT_ALLOWED`, `AUTH_PASSWORD_WEAK`, `CONFLICT` (open mode, `email_taken`), `SERVICE_UNAVAILABLE` (domain mode without SMTP) |
| POST | `/api/auth/verify-email` | none | `auth-ip` | `tokenBodySchema` | `{ ok: true }` | `AUTH_TOKEN_INVALID`, `AUTH_TOKEN_EXPIRED` |
| POST | `/api/auth/password` | session (guard-exempt) | — | `changePasswordSchema` | `{ user: AuthUser }` + rotated cookie; other sessions revoked | `AUTH_INVALID_CREDENTIALS`, `AUTH_PASSWORD_WEAK` |
| POST | `/api/auth/password-reset/request` | none | `auth-ip`, `reset-email` | `passwordResetRequestSchema` | 202 `{ ok: true }` (always) | `SERVICE_UNAVAILABLE` (no SMTP) |
| POST | `/api/auth/password-reset/confirm` | none | `auth-ip` | `passwordResetConfirmSchema` | `{ ok: true }`; all sessions revoked | `AUTH_TOKEN_INVALID`, `AUTH_TOKEN_EXPIRED`, `AUTH_PASSWORD_WEAK` |
| POST | `/api/auth/invites/preview` | none | `auth-ip` | `tokenBodySchema` | `InvitePreview` | `INVITE_INVALID`, `INVITE_EXPIRED`, `INVITE_USED` |
| POST | `/api/auth/invites/accept` | none | `auth-ip` | `acceptInviteSchema` | 201 `{ user: AuthUser }` + cookie | `INVITE_INVALID` (unknown, revoked, or email differs from a bound invite), `INVITE_EXPIRED`, `INVITE_USED`, `AUTH_PASSWORD_WEAK`, `CONFLICT` (`email_taken`) |
| GET | `/api/auth/sessions` | session | — | — | `{ items: SessionInfo[] }` | — |
| DELETE | `/api/auth/sessions/:id` | session | — | — | 204 (own sessions only) | `NOT_FOUND` |

```ts
loginSchema = { email: string /* trimmed, lowercased, ≤254 */; password: string /* 1..256 */ }
registerSchema = { email; displayName: string /* normalized, 1..64 */; password: string /* 12..256 + denylist */ }
changePasswordSchema = { currentPassword: string; newPassword: string }
tokenBodySchema = { token: B64u /* 43 chars, 32 bytes */ }
acceptInviteSchema = { token; email?: string /* required unless the invite is bound */; displayName; password }
passwordResetRequestSchema = { email }       passwordResetConfirmSchema = { token; newPassword }
type AuthUser = { id: Id; email: string; displayName: string; role: 'admin' | 'user'; mustChangePassword: boolean; emailVerified: boolean }
type MeResponse = { user: AuthUser | null }
type InvitePreview = { email: string | null; role: 'admin' | 'user'; expiresAt: IsoDate }
type SessionInfo = { id: string; current: boolean; createdAt: IsoDate; lastSeenAt: IsoDate; ip: string | null; userAgent: string | null }
```
Rules: unknown emails pay the argon2 cost and get the same 401 as a wrong password; disabled and unverified states are
revealed only after a correct password. Reset, verify and account-invite tokens are single use; reset 1 h, verify 24 h
(decision); account invites expire per `adminCreateInviteSchema`. Tokens travel in the URL fragment and the request
body, never in a query string. `AUTH_PASSWORD_WEAK` carries `details.reason`: `too_short`, `too_long`, `common` or
`same_as_current`. Wrong current passwords on `POST /api/auth/password` count toward the login backoff (429).
`SessionInfo.id` is the session hash (never the token). Audit actions: `auth.login`, `auth.login_failed`,
`auth.logout`, `auth.password_changed`, `auth.password_reset`, `auth.invite_accepted`, `auth.session_revoked`,
`user.profile_updated`, `admin.user_created`, `admin.user_updated`, `admin.invite_created`, `admin.invite_revoked`.

## 4. Me

| Method | Path | Auth | Request | Response | Errors |
|---|---|---|---|---|---|
| PATCH | `/api/me` | session | `updateMeSchema = { displayName }` | `{ user: AuthUser }` | `VALIDATION_FAILED` |

The current user is read with `GET /api/auth/me`.

## 5. Rooms

| Method | Path | Auth | Limit | Request | Response | Errors |
|---|---|---|---|---|---|---|
| GET | `/api/rooms` | session | — | `paginationQuerySchema` | `Paginated<RoomSummary>` (owned and co-hosted) | — |
| POST | `/api/rooms` | session | `room-create` | `createRoomSchema` | 201 `{ room: RoomDetails }` | `ROOM_LIMIT_REACHED`, `CONFLICT` (`slug_taken`) |
| GET | `/api/rooms/:id` | session, owner or co-host | — | — | `{ room: RoomDetails }` | `ROOM_NOT_FOUND` |
| PATCH | `/api/rooms/:id` | session, owner | — | `updateRoomSchema` | `{ room: RoomDetails }` | `ROOM_NOT_FOUND`, `FORBIDDEN` (co-host) |
| DELETE | `/api/rooms/:id` | session, owner | — | — | 204 (soft delete; live meeting ended) | `ROOM_NOT_FOUND`, `FORBIDDEN` |
| PUT | `/api/rooms/:id/key` | session, owner | — | `rotateRoomKeySchema` | `{ room: RoomDetails }` (`keyVersion + 1`) | `MEETING_LIVE`, `ROOM_NOT_FOUND`, `FORBIDDEN` |
| POST | `/api/rooms/:id/cohosts` | session, owner | — | `addCohostSchema` | `{ room: RoomDetails }` (decision) | `NOT_FOUND` (user), `CONFLICT` (`already_cohost`) |
| DELETE | `/api/rooms/:id/cohosts/:userId` | session, owner | — | — | 204 | `NOT_FOUND` |
| GET | `/api/rooms/:id/invites` | session, owner or co-host | — | — | `{ items: RoomInvite[] }` (tokens re-derived) | `ROOM_NOT_FOUND` |
| POST | `/api/rooms/:id/invites` | session, owner or co-host | `room-create` | `createRoomInviteSchema` | 201 `{ invite: RoomInvite }` | `ROOM_NOT_FOUND` |
| DELETE | `/api/rooms/:id/invites/:inviteId` | session, owner or co-host | — | — | 204 (sets `revoked_at`) | `NOT_FOUND` |
| GET | `/api/rooms/:id/meetings` | session, owner or co-host | — | `paginationQuerySchema` | `Paginated<MeetingSummary>` | `ROOM_NOT_FOUND` |

```ts
roomSettingsSchema = { name: string /* 1..80 */; waitingRoom: boolean; allowGuests: boolean; muteOnJoin: boolean
  allowSelfUnmute: boolean; screenSharePolicy: 'everyone' | 'hosts'; chatEnabled: boolean; maxParticipants: number /* 2..25 */ }
createRoomSchema = Partial<RoomSettings> & { slug: string /* xxx-xxxx-xxx */; name: string; proof: B64u /* join proof */
  ephemeral: boolean /* default false */; password?: string /* 4..128 */ }
updateRoomSchema = Partial<RoomSettings> & { password?: string | null /* null removes it */ }
rotateRoomKeySchema = { proof: B64u }        addCohostSchema = { userId: Id }
createRoomInviteSchema = { label?: string /* ≤80 */; expiresIn: '1h' | '24h' | '7d' | 'never' /* default 24h */; maxUses: number | null /* 1..1000, default null */ }
type RoomSummary = { id: Id; slug: string; name: string; ephemeral: boolean; isOwner: boolean; role: 'host' | 'cohost'
  hasPassword: boolean; waitingRoom: boolean; live: boolean; participantCount: number; lastActiveAt: IsoDate | null; createdAt: IsoDate }
type RoomDetails = RoomSummary & { allowGuests: boolean; muteOnJoin: boolean; allowSelfUnmute: boolean
  screenSharePolicy: 'everyone' | 'hosts'; chatEnabled: boolean; maxParticipants: number; locked: boolean; keyVersion: number
  cohosts: Array<{ userId: Id; displayName: string; email: string }> }
type RoomInvite = { id: Id; label: string | null; token: string; expiresAt: IsoDate | null; maxUses: number | null
  useCount: number; revoked: boolean; createdAt: IsoDate }
type MeetingSummary = { id: Id; startedAt: IsoDate; endedAt: IsoDate | null; peakParticipants: number }
```
Rules: the slug and K are generated by the creating browser; only the join proof reaches the server, stored as
`sha256(proof)`. `maxParticipants` is clamped to `limits.maxParticipantsPerRoom`. Rooms the caller cannot see answer
404. Changes that affect room state during a live meeting trigger `publishRoomState`.

## 6. Join

| Method | Path | Auth | Limit | Request | Response | Errors |
|---|---|---|---|---|---|---|
| POST | `/api/join/:slug/info` | none (session optional) | `join-ip` | `joinInfoSchema` | `JoinInfo` | `ROOM_NOT_FOUND`, `ROOM_KEY_INVALID`, `ROOM_INVITE_INVALID`, `RATE_LIMITED` |
| POST | `/api/join/:slug` | none (session or guest cookie optional) | `join-ip`, `room-password` | `joinRequestSchema` | 200 `JoinGrant` · 202 `JoinWaiting`; guests get `__Host-blinq_g_<slug>` | `ROOM_NOT_FOUND`, `ROOM_KEY_INVALID`, `ROOM_INVITE_REQUIRED`, `ROOM_INVITE_INVALID`, `ROOM_GUESTS_NOT_ALLOWED`, `ROOM_LOCKED`, `ROOM_PASSWORD_REQUIRED`, `ROOM_PASSWORD_INVALID`, `JOIN_REMOVED`, `JOIN_DENIED`, `ROOM_FULL`, `LOBBY_FULL`, `VALIDATION_FAILED`, `RATE_LIMITED` |
| GET | `/api/join/requests/:id/events` | request-owner | — | — | `text/event-stream` of `WaitingEvent` | `FORBIDDEN`, `NOT_FOUND` |
| POST | `/api/join/requests/:id/cancel` | request-owner | — | — | 204 | `FORBIDDEN`, `NOT_FOUND` |

```ts
joinInfoSchema = { proof: B64u; inviteToken?: B64u }
joinRequestSchema = { proof: B64u; inviteToken?: B64u; displayName?: string /* guests: required; ignored for users */
  password?: string /* ≤128 */; clientId: string /* 16..64 base64url chars, per tab */ }
type JoinInfo = { roomId: Id; name: string; needsPassword: boolean; waitingRoom: boolean; recordingActive: boolean
  yourRole: 'host' | 'cohost' | 'participant'; signedIn: boolean; guestsAllowed: boolean; muteOnJoin: boolean }
type JoinGrant = { status: 'admitted'; token: string; url: string; epoch: B64u /* 16 bytes */; identity: string
  role: 'host' | 'cohost' | 'participant'; roomId: Id }
type JoinWaiting = { status: 'waiting'; requestId: Id }
type JoinResponse = JoinGrant | JoinWaiting
```
Check order for `POST /api/join/:slug`: proof → invite (everyone except the host and co-hosts needs a valid, unexpired,
unrevoked invite — otherwise invite expiry would not apply to signed-in users, because the key is in every link)
→ guests allowed (global `guests.allowed` and room `allowGuests`) → lock (host and co-hosts bypass) → password →
removed or denied in the current meeting → capacity (admitted + joined rows) → waiting room (everyone except host and
co-hosts). `info` checks only the proof and a supplied invite and never consumes the invite. Resume: the same session
or guest session with the same `clientId` in the same live meeting gets a new token for the same identity without the
lobby; older meetings never skip it. The first admitted join creates the meeting (new epoch) and the LiveKit room.

### 6.1 Waiting-room SSE
`GET /api/join/requests/:id/events` (`Content-Type: text/event-stream`). On connect the server sends the current state
first (`status`, or the final event if already decided) (decision). A comment heartbeat `: ping` is sent every 15 s.
`admitted`, `denied` and `ended` are final; the server closes the stream after them.

| Event | Data (JSON) |
|---|---|
| `status` | `{ status: 'waiting' }` |
| `admitted` | `{ token, url, epoch, identity, role, roomId }` (`JoinGrant` without `status`) |
| `denied` | `{ reason: 'denied' \| 'removed' \| 'locked' }` |
| `ended` | `{}` |

## 7. In-call

Base path `/api/calls/:roomId`. Auth `caller`; limiter `call-actions`. `:identity` is a LiveKit identity (`p_…`),
`:requestId` a waiting request id. Unknown targets → 404 `NOT_FOUND`. Every change is written to the DB first, then
applied through the `RoomServiceAdapter`, then `publishRoomState` runs when room state changed.

| Method | Path | Action (`canPerform`) | Request | Response |
|---|---|---|---|---|
| POST | `/me/name` | `self.rename` | `renameSchema = { displayName }` | 204 |
| POST | `/me/hand` | `self.hand` | `handSchema = { raised: boolean }` | 204 |
| GET | `/participants` | any caller (decision) | — | `{ items: CallParticipantInfo[] }` |
| GET | `/lobby` | `lobby.view` | — | `{ items: LobbyEntry[] }` |
| POST | `/lobby/:requestId/admit` | `lobby.admit` | — | 204 |
| POST | `/lobby/:requestId/deny` | `lobby.deny` | — | 204 |
| POST | `/lobby/admit-all` | `lobby.admit` | — | `{ admitted: number }` |
| POST | `/participants/:identity/mute` | `participant.mute` | `muteSchema = { source: 'microphone' \| 'camera' \| 'screen_share' }` | 204 |
| POST | `/participants/:identity/permissions` | `participant.permissions` | `permissionsSchema = { microphone?: boolean; camera?: boolean }` | 204 |
| POST | `/participants/:identity/ask-unmute` | `participant.askUnmute` | — | 204 |
| POST | `/participants/:identity/volume` | `participant.volume` | `volumeSchema = { level: 0..100 }` | 204 |
| POST | `/participants/:identity/remove` | `participant.remove` | — | 204 |
| POST | `/participants/:identity/role` | `participant.role` (host only) | `roleChangeSchema = { role: 'cohost' \| 'participant' }` | 204 |
| POST | `/participants/:identity/name` | `participant.rename` | `renameSchema` | 204 |
| POST | `/participants/:identity/lower-hand` | `participant.lowerHand` | — | 204 |
| POST | `/mute-all` | `call.muteAll` | `muteAllSchema = { preventSelfUnmute: boolean /* default false */ }` | 204 |
| PATCH | `/settings` | `call.lock` for `locked`, `call.settings` (host) for the rest | `liveSettingsSchema = Partial<{ locked; waitingRoom; screenSharePolicy; allowSelfUnmute; chatEnabled }>` | `{ state: RoomMetadata }` |
| POST | `/end` | `call.end` (host) | — | 204 |
| POST | `/recording/start` | `recording.start` (host or co-host with an account) | `startRecordingSchema` | 201 `StartRecordingResponse` |
| POST | `/recording/stop` | `recording.stop` | — | 204 |

```ts
type LobbyEntry = { requestId: Id; displayName: string; kind: 'user' | 'guest'; requestedAt: IsoDate }
type CallParticipantInfo = { identity: string; displayName: string; role: 'host' | 'cohost' | 'participant'; kind: 'user' | 'guest'
  micAllowed: boolean; cameraAllowed: boolean; volumeLevel: number; handRaisedAt: IsoDate | null; joinedAt: IsoDate | null }
startRecordingSchema = { mode: 'server' | 'local'; mimeType?: string /* video/mp4|webm… */; width?: 320..1920; height?: 180..1080 }
type StartRecordingResponse = { recordingId: Id; maxDurationMs: number; chunkMaxBytes: number }
```
Errors: `CALL_NOT_PARTICIPANT`, `CALL_FORBIDDEN`, `NOT_FOUND`, `VALIDATION_FAILED`, `RATE_LIMITED`; recording start
adds `RECORDING_DISABLED`, `RECORDING_ACTIVE`, `RECORDING_NOT_ALLOWED`, `RECORDING_QUOTA_EXCEEDED`.
Effects: `mute` calls `mutePublishedTrack`; `permissions` rewrites `canPublishSources` (revoking the mic also stops
self-unmute; screen-share audio goes with screen share); `ask-unmute` sends the `ask-unmute` hint to the target only
(never forces); `volume` sets the `vol` attribute; `remove` marks the row `removed` (final for the meeting) and calls
`removeParticipant` with `revokeTokensIssuedBefore`; `role` persists co-hosts with accounts in `room_members`; `end`
calls `deleteRoom`, ends the meeting and sends `ended` to waiters. Nobody targets themselves or the host
(`canPerform`). Recording routes are owned by `recording-server`; local recordings also create a row (mode `local`)
so the REC indicator and audit work, but nothing is uploaded.

## 8. Recordings

| Method | Path | Auth | Limit | Request | Response | Errors |
|---|---|---|---|---|---|---|
| GET | `/api/recordings` | session | — | `paginationQuerySchema` | `Paginated<RecordingSummary>` (own recordings and recordings of owned rooms) | — |
| GET | `/api/recordings/:id` | session: recorder, room owner or admin | — | — | `{ recording: RecordingSummary }` | `NOT_FOUND` |
| DELETE | `/api/recordings/:id` | recorder, room owner or admin | — | — | 204 (file and row deleted, audited) | `NOT_FOUND` |
| PUT | `/api/recordings/:id/chunks/:seq` | session: the recorder | `recording-chunks` | body `application/octet-stream`, ≤ `chunkMaxBytes`; `seq` 0-based integer | 204 (idempotent per `seq`) | `FORBIDDEN`, `CONFLICT` (`not_recording`), `RECORDING_TOO_LARGE`, `RECORDING_QUOTA_EXCEEDED` |
| POST | `/api/recordings/:id/complete` | the recorder | — | `completeRecordingSchema = { chunkCount: number; durationMs: number }` | 202 `{ status: 'processing' }` | `CONFLICT`, `VALIDATION_FAILED` |
| GET | `/api/recordings/:id/file` | recorder, room owner or admin | — | `?download=1`; `Range` supported | `video/mp4` bytes (200 / 206) | `NOT_FOUND`, `RECORDING_NOT_READY` |

```ts
type RecordingSummary = { id: Id; roomId: Id; roomName: string; mode: 'server' | 'local'
  status: 'recording' | 'processing' | 'ready' | 'failed'; partial: boolean; title: string | null; durationMs: number | null
  sizeBytes: number | null; width: number | null; height: number | null; createdBy: { id: Id; displayName: string }
  startedAt: IsoDate; expiresAt: IsoDate | null }
```
File responses always send `Content-Type: video/mp4`, `X-Content-Type-Options: nosniff`,
`Content-Security-Policy: sandbox; default-src 'none'`, `Cache-Control: no-store` and an RFC 5987 filename;
`?download=1` switches to `Content-Disposition: attachment`. Unprocessed or failed recordings are never served. Every
admin playback or download is audited.

Upload protocol details: `seq` counts from 0 with one request in flight; resending a `seq` replaces it. `CONFLICT`
reasons: `not_recording` (stop uploading), `chunk_gap` (resend from `details.expected`), `chunk_count_mismatch`
(`details.stored`), `recording_busy` (another recording is active; `DELETE` answers it too while the recording is
still recording or processing). Unknown recording ids answer 403 on the chunk and complete routes. An unsatisfiable
range answers 416 `VALIDATION_FAILED` (`reason: range_not_satisfiable`) with `Content-Range: bytes */<size>`. `sizeBytes` is null until the recording is
ready. Stop answers `RECORDING_NOT_ALLOWED` for guests and participants; stop only ends the indicator, chunks are still
accepted until `complete`.

## 9. Admin

Auth `admin` for every route. `recordings` routes are owned by `recording-server`, the rest by `admin`.

| Method | Path | Request | Response | Errors |
|---|---|---|---|---|
| GET | `/api/admin/users` | `adminUsersQuerySchema` (+ `role`, `status: 'active' \| 'disabled'`) | `Paginated<AdminUser>` | — |
| POST | `/api/admin/users` | `adminCreateUserSchema = { email; displayName; role /* default user */; sendEmail /* default false */ }` | 201 `{ user: AdminUser; tempPassword: string \| null; emailed: boolean }` (decision) | `CONFLICT` (`email_taken`), `SERVICE_UNAVAILABLE` (`sendEmail` without SMTP) |
| GET | `/api/admin/users/:id` | — | `{ user: AdminUser }` | `NOT_FOUND` |
| PATCH | `/api/admin/users/:id` | `adminUpdateUserSchema = Partial<{ displayName; role; disabled }>` | `{ user: AdminUser }` | `NOT_FOUND`, `CONFLICT` (`last_admin`) |
| DELETE | `/api/admin/users/:id` | — | 204 | `NOT_FOUND`, `CONFLICT` (`last_admin`, `self`) |
| POST | `/api/admin/users/:id/reset-password` | `{ sendEmail?: boolean }` (decision) | `{ tempPassword: string \| null; emailed: boolean }` | `NOT_FOUND`, `SERVICE_UNAVAILABLE` |
| POST | `/api/admin/users/:id/revoke-sessions` | — | 204 | `NOT_FOUND` |
| GET | `/api/admin/invites` | `paginationQuerySchema` | `Paginated<AdminInvite>` | — |
| POST | `/api/admin/invites` | `adminCreateInviteSchema = { email?; role; expiresIn: '24h' \| '7d' \| '30d'; sendEmail }` (admin role: email required, 24 h) | 201 `CreatedInvite` (token shown once) | `VALIDATION_FAILED`, `SERVICE_UNAVAILABLE` |
| DELETE | `/api/admin/invites/:id` | — | 204 (revoked) | `NOT_FOUND` |
| GET | `/api/admin/settings` | — | `{ settings: Settings; smtp: { configured: boolean; host: string \| null; from: string \| null } }` (decision) | — |
| PUT | `/api/admin/settings` | `settingsUpdateSchema` (partial, strict; merged result re-validated) | `{ settings: Settings }` | `VALIDATION_FAILED` (e.g. domain mode without SMTP, `details.field`) |
| POST | `/api/admin/settings/test-email` | `{ to?: string }` (default: the admin's email) (decision) | `{ ok: true }` | `SERVICE_UNAVAILABLE` (no SMTP or SMTP error, `details.smtpError`) |
| GET | `/api/admin/rooms` | `paginationQuerySchema` | `Paginated<AdminRoom>` (live counts from LiveKit) | — |
| DELETE | `/api/admin/rooms/:id` | — | 204 (soft delete, live meeting ended) | `NOT_FOUND` |
| POST | `/api/admin/rooms/:id/end` | — | 204 | `NOT_FOUND`, `CONFLICT` (`not_live`: no live meeting) |
| GET | `/api/admin/rooms/:id/meetings` | `paginationQuerySchema` | `Paginated<MeetingSummary>` | `NOT_FOUND` |
| GET | `/api/admin/audit` | `auditQuerySchema` (+ `action`, `actorUserId`) | `Paginated<AuditEntry>` | — |
| GET | `/api/admin/recordings` | `paginationQuerySchema` | `Paginated<RecordingSummary>` (all recordings) | — |
| DELETE | `/api/admin/recordings/:id` | — | 204 (audited) | `NOT_FOUND` |

```ts
type AdminUser = { id: Id; email: string; displayName: string; role: 'admin' | 'user'; disabled: boolean
  mustChangePassword: boolean; emailVerified: boolean; lastLoginAt: IsoDate | null; createdAt: IsoDate; roomCount: number }
type AdminInvite = { id: Id; email: string | null; role: 'admin' | 'user'; expiresAt: IsoDate; usedAt: IsoDate | null
  revoked: boolean; createdAt: IsoDate; createdBy: Id | null }
type CreatedInvite = AdminInvite & { token: string /* link: `${publicUrl}/invite#${token}` */; emailed: boolean }
type AdminRoom = { id: Id; slug: string; name: string; owner: { id: Id; displayName: string; email: string }; live: boolean
  participantCount: number; ephemeral: boolean; createdAt: IsoDate; lastActiveAt: IsoDate | null }
type AuditEntry = { id: Id; at: IsoDate; actor: { userId: Id | null; displayName: string | null; participantId: Id | null }
  ip: string | null; action: string; targetType: string | null; targetId: string | null; details: Record<string, unknown> | null }
```
Every admin mutation writes one audit entry (`admin.<verb>`): `admin.user_created`, `admin.user_updated`,
`admin.user_password_reset`, `admin.user_sessions_revoked`, `admin.user_deleted`, `admin.invite_created`,
`admin.invite_revoked`, `admin.settings_updated` (details `{ fields, old, new }`; an update that changes nothing is not
audited), `admin.test_email_sent` (only when the mail was sent), `admin.room_ended`, `admin.room_deleted`,
`admin.recording_deleted`. Admin responses never contain room keys, proofs, room invite tokens, chat or media. The last enabled admin cannot be demoted, disabled or deleted.

## 10. Webhooks

| Method | Path | Auth | Request | Response | Errors |
|---|---|---|---|---|---|
| POST | `/api/webhooks/livekit` | webhook | raw body (`application/webhook+json`) + `Authorization` | 200 `{ ok: true }` (also for ignored events) | 401 `UNAUTHENTICATED` (bad signature) |

Caddy answers 404 for `/api/webhooks/*` from outside; LiveKit posts to `127.0.0.1` (dev:
`host.docker.internal:3000…3005`). The raw body is read before anything else, verified with `WebhookReceiver`, and
deduplicated by event id (in-memory LRU, 10 min) (decision). Events for rooms missing from the DB are ignored.
`participant_joined` removes identities whose row is not `admitted` or `joined`; `participant_left` and `room_finished`
update rows and meetings.

## 11. Test-only (none in production)

Approved as built by rooms-backend: `LIVEKIT_URL=fake://…` selects the in-memory adapter only in test builds
(plain `pnpm dev` refuses it); `GET /api/__test/livekit-calls[?room=]` returns `[{ method, args, at }]` and is 404 in
every other build. Client-facing join/lobby/in-call behavior decisions are listed in the last section of
`docs/stages/04-rooms-invites-join.md`.


Production builds contain no test endpoints. `pnpm build:test` (`BLINQ_TEST_HOOKS=1`) adds only the page `/dev/call`
(`app/dev/CallHarness.vue`) and `window.__blinqTest` (`app/lib/contracts/test-hooks.ts`); CI asserts both are absent
from the production build. Proposed for API tests (decision, needs orchestrator approval before anyone builds it): in
test builds, `LIVEKIT_URL=fake://local` selects an in-memory `RoomServiceAdapter`, and
`GET /api/__test/livekit-calls` returns its recorded calls (`[{ method, args, at }]`), 404 in production builds.

## 12. LiveKit contracts

- **Room name** = `rooms.id` (uuid). Only the server creates rooms (`room.auto_create: false`), one LiveKit room per
  meeting (`createRoom` with `maxParticipants` ≤ 25).
- **Identity** = `p_` + 16 base62 characters (`call_participants.lk_identity`, `identitySchema`), random and unrelated
  to user ids or emails. **Name** = the normalized display name.
- **Attributes** (server-set only, `participantAttributesSchema`): `role` = `host` | `cohost` | `participant`;
  `kind` = `user` | `guest`; `hand` = `""` or epoch ms as a 13-digit string; `vol` = `"0"`…`"100"` (default `"100"`).
- **Room metadata** (JSON, `roomMetadataSchema`, written only by `publishRoomState(roomId)`):
  `{ v: 1, epoch, locked, waitingRoom, screenSharePolicy: 'everyone' | 'hosts', allowSelfUnmute, chatEnabled,
  recording: null | { mode: 'server' | 'local', by: displayName, startedAt: IsoDate } }`.
- **Tokens**: TTL 5 min (LiveKit refreshes while connected); grants `roomJoin`, `room`, `canSubscribe`,
  `canPublishData`, `canUpdateOwnMetadata: false`, `canPublish` = any source allowed, `canPublishSources` as below;
  never `hidden`, `roomAdmin`, `roomCreate`, `roomList`, `roomRecord`, `recorder` or an agent kind.

| Role | `canPublishSources` |
|---|---|
| host, cohost | `camera`, `microphone`, `screen_share`, `screen_share_audio` |
| participant | `microphone` if `micAllowed` (and self-unmute allowed), `camera` if `cameraAllowed`, `screen_share` + `screen_share_audio` if `screenSharePolicy = 'everyone'` |

  Permission updates send the complete `ParticipantPermissionSpec` (`server/contracts/index.ts`) because LiveKit
  replaces permissions as a whole.
- **Data topics** (`DATA_TOPICS`): `blinq.chat.v1` and `blinq.reaction.v1` (client → client, reliable, app envelope);
  `blinq.srv.v1` (server → specific identities via `destinationIdentities`, plain JSON `{ type: 'lobby.changed' |
  'participant.changed' | 'ask-unmute' | 'room.changed' }`; a hint to refetch from the API, never a token, never
  destructive; it arrives unencrypted because the server holds no key, so clients accept it only from the server).
- **App envelope** (`app/lib/e2ee/envelope.ts`): bytes `0x01 | iv(12) | AES-256-GCM ciphertext + tag(16)`; AAD = UTF-8
  `"blinq/app/v1|" + slug + "|" + senderIdentity`; plaintext UTF-8 JSON `{ id, type: 'chat' | 'reaction', from:
  identity, ts: epochMs, body }` (≤ 15 KiB); `chatBodySchema = { text: 1..2000 chars }`,
  `reactionBodySchema = { reaction: 'thumbs_up' | 'clap' | 'heart' | 'laugh' | 'surprised' | 'party' }`. Receivers drop
  packets with `encryptionType` NONE, unknown senders, `from` ≠ LiveKit sender, and duplicate ids.
- **No RPC methods** are registered. Clients connect with `autoSubscribe: false` and subscribe only to publications whose
  `encryptionType` is not NONE.

## 13. Cookies and links

| Cookie | Value | Attributes |
|---|---|---|
| `__Host-blinq_session` (dev: `blinq_session`) | 32 random bytes, base64url; DB stores sha256 hex as `sessions.id` | httpOnly, Secure (prod), SameSite=Lax, Path=/; absolute 30 d, idle 7 d |
| `__Host-blinq_g_<slug>` (dev: `blinq_g_<slug>`) | 32 random bytes, base64url; DB stores sha256 as `guest_sessions.id` | same attributes; expires with the guest session (12 h (decision)) |

| Link | Format |
|---|---|
| Host link | `https://DOMAIN/m/<slug>#k=<base64url(K)>` |
| Room invite | `https://DOMAIN/m/<slug>#k=<K>&t=<inviteToken>` (`buildRoomLink`) |
| Account invite | `https://DOMAIN/invite#<token>` |
| Email verification | `https://DOMAIN/verify-email#<token>` |
| Password reset | `https://DOMAIN/reset-password#<token>` |

Slugs are 10 random letters from `abcdefghjkmnpqrstuvwxyz`, formatted `xxx-xxxx-xxx` (`generateSlug`, `slugSchema`).
Secrets are only ever in the fragment. A client plugin captures and strips the fragment before any route middleware
runs. The server never emails room links; sharing is client-side (copy, `navigator.share`, `mailto:`).

## 14. Crypto derivations

All HKDF uses SHA-256 via WebCrypto (`app/lib/e2ee/keys.ts`); the server never sees K.

| Value | Derivation |
|---|---|
| Room key K | 32 random bytes (`generateRoomKey`), base64url in fragment `k` |
| Join proof P | `HKDF(ikm = K, salt = empty, info = "blinq/v1/join|" + slug, 32 B)`, sent base64url; server stores `sha256(P)` and compares in constant time |
| Meeting epoch | 16 random bytes from the server, base64url (22 chars), in room metadata and `JoinGrant` |
| Media key | `HKDF(K, salt = epoch, "blinq/v1/media|" + slug, 32 B)` → `ExternalE2EEKeyProvider({ keySize: 256 }).setKey(ArrayBuffer)` |
| Chat key | `HKDF(K, salt = epoch, "blinq/v1/chat|" + slug, 32 B)` → AES-256-GCM (non-extractable) |
| Safety code | `HKDF(K, salt = epoch, "blinq/v1/safety|" + slug, 10 B)` → 16 Crockford base32 chars, 4 groups of 4 |
| Room invite token | `base64url(inviteIdBytes(16) ‖ HMAC-SHA256(k_invite, inviteIdBytes)[0..16])`, `k_invite = HKDF(APP_SECRET, info "blinq/v1/invite")`; stored nowhere, re-derivable for the owner |
| Session, guest, account-invite, verify and reset tokens | 32 random bytes, base64url (43 chars); the DB stores sha256 |
| Recording at rest (BLQ1) | per-file key `HKDF(RECORDING_ENCRYPTION_KEY, salt, "blinq/v1/rec|" + recordingId, 32 B)`; format in `docs/SECURITY.md` and Stage 08 |

## 15. Settings

Table `settings` (one row per key), schema `settingsSchema` in `shared/schemas/settings.ts`. Changes apply without a
restart. Keys prefixed `system.` (for example `system.bootstrapDone`) are internal and never exposed.

| Key | Type | Default |
|---|---|---|
| `registration.mode` | `'invite_only' \| 'open' \| 'domain'` | `invite_only` |
| `registration.allowedDomains` | `string[]` (≤ 50 domains) | `[]` |
| `guests.allowed` | boolean | `true` |
| `media.maxCameraResolution` | `'720p' \| '1080p'` | `720p` |
| `media.maxScreenShareResolution` | `'720p' \| '1080p'` | `1080p` |
| `media.maxScreenShareFps` | `5 \| 15 \| 30` | `15` |
| `limits.maxParticipantsPerRoom` | integer 2..25 | `25` |
| `limits.maxRoomsPerUser` | integer 1..1000 | `50` |
| `recording.enabled` | boolean | `true` |
| `recording.retentionDays` | integer 1..3650 | `30` |
| `recording.maxDurationMinutes` | integer 1..600 | `240` |
| `recording.maxResolution` | `'720p' \| '1080p'` | `1080p` |
| `recording.userQuotaGb` | number ≥ 0 (0 = unlimited) | `20` |
| `privacy.ipRetentionDays` | integer 1..365 | `30` |
| `audit.retentionDays` | integer 30..3650 | `180` |

## 16. Environment

Parsed once by `server/utils/env.ts`; errors name the variable and placeholder secrets are refused. Full comments in
`.env.example`.

- General: `DOMAIN`, `TURN_DOMAIN` (optional), `PUBLIC_URL` (default `https://$DOMAIN`), `TLS_MODE=acme|internal|files`,
  `ACME_EMAIL`, `ACME_CA`, `TLS_CERT_FILE`, `TLS_KEY_FILE`, `TZ`, `LOG_LEVEL`, `LOG_FORMAT=pretty|json`
- Bootstrap: `ADMIN_EMAIL`, `ADMIN_PASSWORD` (only until the first admin exists)
- Secrets: `APP_SECRET` (≥ 32 chars), `RECORDING_ENCRYPTION_KEY` (base64 of 32 bytes), `LIVEKIT_API_KEY`,
  `LIVEKIT_API_SECRET` (≥ 32)
- Database: `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`; the app reads `DATABASE_URL`
- LiveKit and network: `LIVEKIT_NODE_IP`, `LIVEKIT_RTC_TCP_PORT=7881`, `LIVEKIT_RTC_PORT_RANGE_START=50000`,
  `LIVEKIT_RTC_PORT_RANGE_END=60000`, `LIVEKIT_TURN_UDP_PORT=3478`, `LIVEKIT_URL` (server → LiveKit HTTP),
  `LIVEKIT_PUBLIC_URL` (client WebSocket, default `wss://$DOMAIN`)
- Loopback ports: `APP_PORT=3000`, `LIVEKIT_HTTP_PORT=7880`, `LIVEKIT_TURN_TLS_PORT=5349`, `CADDY_HEALTH_PORT=2020`
- SMTP (optional): `SMTP_HOST`, `SMTP_PORT=587`, `SMTP_SECURE=false`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`
- Recording: `RECORDINGS_DIR=/data/recordings`, `RECORDING_WORK_DIR=/work`, `RECORDING_WORK_TMPFS_SIZE=4g`,
  `FFMPEG_PATH`, `FFPROBE_PATH`, `FFMPEG_THREADS=2`, `FFMPEG_TIMEOUT_MINUTES=120`
- Dev and test: `DEV_PG_PORT=55432`, `BLINQ_TEST_HOOKS` (build time only)
