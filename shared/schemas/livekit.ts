import { z } from 'zod'

/** LiveKit contracts (docs/API.md). Only the server writes room metadata and participant attributes. */

export const participantRoleSchema = z.enum(['host', 'cohost', 'participant'])
export type ParticipantRole = z.infer<typeof participantRoleSchema>

export const participantKindSchema = z.enum(['user', 'guest'])
export type ParticipantKind = z.infer<typeof participantKindSchema>

/** Identity format: `p_` + 16 base62 characters. Never derived from user ids or emails. */
export const identitySchema = z.string().regex(/^p_[A-Za-z0-9]{16}$/)

/** Participant attributes (all values are strings, as LiveKit requires). */
export const participantAttributesSchema = z.object({
  role: participantRoleSchema,
  kind: participantKindSchema,
  /** "" when not raised, otherwise epoch milliseconds as a string. */
  hand: z.string().regex(/^(\d{13})?$/).default(''),
  /** Host-set volume for everyone, "0".."100". */
  vol: z.string().regex(/^(100|[1-9]?\d)$/).default('100'),
})
export type ParticipantAttributes = z.infer<typeof participantAttributesSchema>

export const recordingStateSchema = z.object({
  mode: z.enum(['server', 'local']),
  by: z.string(),
  startedAt: z.string(),
})

/** Room metadata JSON, written only by `publishRoomState(roomId)` on the server. */
export const roomMetadataSchema = z.object({
  v: z.literal(1),
  /** base64url(16 random bytes); salt for per-meeting key derivation. */
  epoch: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  locked: z.boolean(),
  waitingRoom: z.boolean(),
  screenSharePolicy: z.enum(['everyone', 'hosts']),
  allowSelfUnmute: z.boolean(),
  chatEnabled: z.boolean(),
  recording: recordingStateSchema.nullable(),
})
export type RoomMetadata = z.infer<typeof roomMetadataSchema>

export const DATA_TOPICS = {
  /** client → client, encrypted app envelope, reliable */
  chat: 'blinq.chat.v1',
  /** client → client, encrypted app envelope, reliable */
  reaction: 'blinq.reaction.v1',
  /** server → specific identities, plain JSON hint; never a token, never destructive; clients refetch */
  server: 'blinq.srv.v1',
} as const

export const serverHintSchema = z.object({
  type: z.enum(['lobby.changed', 'participant.changed', 'ask-unmute']),
})
export type ServerHint = z.infer<typeof serverHintSchema>

export const CHAT_MAX_LENGTH = 2000
export const chatBodySchema = z.object({ text: z.string().min(1).max(CHAT_MAX_LENGTH) })
export type ChatBody = z.infer<typeof chatBodySchema>

export const REACTIONS = ['thumbs_up', 'clap', 'heart', 'laugh', 'surprised', 'party'] as const
export const reactionBodySchema = z.object({ reaction: z.enum(REACTIONS) })
export type ReactionBody = z.infer<typeof reactionBodySchema>
