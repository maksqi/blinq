/**
 * What the `/m/<slug>` flow tells people when joining fails (rooms-ui, Stage 04): a title, one or two sentences and
 * the next step for every join error code, a missing or damaged key in the link, an unsupported browser and a meeting
 * that ended in the waiting room. Copy is keyed by stable codes, never by server text.
 */

/** API error codes the join endpoints answer with (docs/API.md §6). */
export const JOIN_API_CODES = [
  'ROOM_KEY_INVALID',
  'ROOM_NOT_FOUND',
  'ROOM_INVITE_REQUIRED',
  'ROOM_INVITE_INVALID',
  'ROOM_GUESTS_NOT_ALLOWED',
  'ROOM_LOCKED',
  'ROOM_FULL',
  'ROOM_PASSWORD_REQUIRED',
  'ROOM_PASSWORD_INVALID',
  'JOIN_REMOVED',
  'JOIN_DENIED',
  'LOBBY_FULL',
  'RATE_LIMITED',
  'VALIDATION_FAILED',
  // 503: the server could not reach LiveKit (server/services/livekit/errors.ts) or is too busy (room lock timeout).
  'SERVICE_UNAVAILABLE',
] as const

export type JoinApiCode = (typeof JOIN_API_CODES)[number]

/** Problems the client finds itself. */
export type JoinClientProblem = 'MISSING_KEY' | 'INVALID_LINK' | 'UNSUPPORTED_BROWSER' | 'MEETING_ENDED' | 'UNKNOWN'

export type JoinProblemCode = JoinApiCode | JoinClientProblem

export interface JoinProblem {
  code: JoinProblemCode
  /** Seconds until a rate limit lifts (`RATE_LIMITED` details). */
  retryAfter?: number
}

/**
 * - `home`: nothing to retry with this link; offer the way back.
 * - `retry`: the same link can work a little later (reload the flow).
 * - `signin`: sign in, then come back to the same meeting.
 */
export type JoinNextStep = 'home' | 'retry' | 'signin'

export interface JoinErrorCopy {
  title: string
  message: string
  next: JoinNextStep
}

const COPY: Record<JoinProblemCode, JoinErrorCopy> = {
  ROOM_KEY_INVALID: {
    title: "This link doesn't open the meeting",
    message:
      'The encryption key in this link is wrong or out of date. The host may have changed it. Ask the host for a new link.',
    next: 'home',
  },
  ROOM_NOT_FOUND: {
    title: 'Meeting not found',
    message: 'This meeting does not exist or was deleted. Check the link or ask the host for a new one.',
    next: 'home',
  },
  ROOM_INVITE_REQUIRED: {
    title: 'You need an invite link',
    message: 'This link has no invite in it. Ask the host to send you an invite link for this meeting.',
    next: 'home',
  },
  ROOM_INVITE_INVALID: {
    title: 'This invite no longer works',
    message: 'The invite in this link is invalid, expired, revoked or used up. Ask the host for a new invite link.',
    next: 'home',
  },
  ROOM_GUESTS_NOT_ALLOWED: {
    title: 'Sign in to join',
    message: 'Only people with an account can join this meeting. Sign in, and the meeting opens again.',
    next: 'signin',
  },
  ROOM_LOCKED: {
    title: 'The meeting is locked',
    message: 'The host has locked this meeting. Try again after they unlock it.',
    next: 'retry',
  },
  ROOM_FULL: {
    title: 'The meeting is full',
    message: 'No one else can join right now. Try again when someone leaves.',
    next: 'retry',
  },
  ROOM_PASSWORD_REQUIRED: {
    title: 'Password needed',
    message: 'This meeting has a password. Enter it to join.',
    next: 'retry',
  },
  ROOM_PASSWORD_INVALID: {
    title: 'Wrong password',
    message: 'That password is not right. Check it with the host and try again.',
    next: 'retry',
  },
  JOIN_REMOVED: {
    title: 'You were removed from this meeting',
    message: "A host removed you, so you can't rejoin this meeting.",
    next: 'home',
  },
  JOIN_DENIED: {
    title: "The host didn't let you in",
    message: 'Your request to join was declined. Contact the host if you think this is a mistake.',
    next: 'home',
  },
  LOBBY_FULL: {
    title: 'The waiting room is full',
    message: 'Too many people are waiting to be let in. Try again in a few minutes.',
    next: 'retry',
  },
  RATE_LIMITED: {
    title: 'Too many attempts',
    message: 'Wait a moment, then try again.',
    next: 'retry',
  },
  VALIDATION_FAILED: {
    title: "Couldn't join",
    message: 'Check your name and try again.',
    next: 'retry',
  },
  SERVICE_UNAVAILABLE: {
    title: "The meeting service isn't available",
    message: 'The server is busy or its media service is down right now. Try again in a minute.',
    next: 'retry',
  },
  MISSING_KEY: {
    title: 'This link is incomplete',
    message:
      "The link has no encryption key, so the meeting can't be opened. Open the full link you were sent, or ask the host for a new one.",
    next: 'home',
  },
  INVALID_LINK: {
    title: 'This link is damaged',
    message:
      'The encryption key in this link is cut off or changed, which can happen when an app shortens links. Copy the whole link and open it again.',
    next: 'home',
  },
  UNSUPPORTED_BROWSER: {
    title: "This browser can't join encrypted calls",
    message: 'Every blinq call is end-to-end encrypted. Use a current version of Chrome, Edge, Firefox or Safari.',
    next: 'home',
  },
  MEETING_ENDED: {
    title: 'The meeting has ended',
    message: 'The meeting ended before the host let you in.',
    next: 'retry',
  },
  UNKNOWN: {
    title: "Couldn't open the meeting",
    message: 'Something went wrong. Check your connection and try again.',
    next: 'retry',
  },
}

export function isJoinApiCode(value: unknown): value is JoinApiCode {
  return typeof value === 'string' && (JOIN_API_CODES as readonly string[]).includes(value)
}

/** Any API error code (or `NETWORK`) as a join problem; codes the join flow does not know become `UNKNOWN`. */
export function toJoinProblem(code: unknown, retryAfter?: unknown): JoinProblem {
  const problem: JoinProblem = { code: isJoinApiCode(code) ? code : 'UNKNOWN' }
  const seconds = Number(retryAfter)
  if (problem.code === 'RATE_LIMITED' && Number.isFinite(seconds) && seconds > 0)
    problem.retryAfter = Math.ceil(seconds)
  return problem
}

function waitText(seconds: number): string {
  if (seconds < 60) return `Try again in ${seconds} second${seconds === 1 ? '' : 's'}.`
  const minutes = Math.ceil(seconds / 60)
  return `Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`
}

export function joinErrorCopy(problem: JoinProblem): JoinErrorCopy {
  const copy = COPY[problem.code] ?? COPY.UNKNOWN
  if (problem.code === 'RATE_LIMITED' && problem.retryAfter) {
    return { ...copy, message: `Too many attempts from your network. ${waitText(problem.retryAfter)}` }
  }
  return copy
}

/**
 * Problems shown inline on the pre-join or password screen, where pressing Join again is the retry. Everything else
 * ends the join flow on a full-screen message.
 */
const INLINE: ReadonlySet<JoinProblemCode> = new Set<JoinProblemCode>([
  'ROOM_LOCKED',
  'ROOM_FULL',
  'LOBBY_FULL',
  'RATE_LIMITED',
  'VALIDATION_FAILED',
  'ROOM_PASSWORD_INVALID',
  'SERVICE_UNAVAILABLE',
  'UNKNOWN',
])

export function isInlineJoinProblem(code: JoinProblemCode): boolean {
  return INLINE.has(code)
}
