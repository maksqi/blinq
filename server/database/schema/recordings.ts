import { bigint, boolean, index, integer, pgEnum, pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { createdAt, pk, tstz, updatedAt } from './_columns'
import { meetings, rooms } from './rooms'
import { users } from './users'

export const recordingStatus = pgEnum('recording_status', ['recording', 'processing', 'ready', 'failed'])
export const recordingMode = pgEnum('recording_mode', ['server', 'local'])

/**
 * Recording lifecycle and metadata. Server-mode files are BLQ1-encrypted on disk (`storageKey`).
 * Local-mode rows exist only for the REC indicator and the audit trail (nothing is uploaded).
 */
export const recordings = pgTable(
  'recordings',
  {
    id: pk(),
    roomId: uuid()
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    meetingId: uuid().references(() => meetings.id, { onDelete: 'set null' }),
    createdBy: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    mode: recordingMode().notNull().default('server'),
    status: recordingStatus().notNull().default('recording'),
    /** True when finalized after the uploader disconnected or stopped sending chunks. */
    partial: boolean().notNull().default(false),
    title: text(),
    sourceMime: text(),
    chunkCount: integer().notNull().default(0),
    uploadedBytes: bigint({ mode: 'number' }).notNull().default(0),
    /** Plaintext size of the final MP4. */
    sizeBytes: bigint({ mode: 'number' }),
    durationMs: integer(),
    width: integer(),
    height: integer(),
    /** Path of the final BLQ1 file relative to RECORDINGS_DIR. */
    storageKey: text(),
    keyId: integer().notNull().default(1),
    startedAt: tstz().notNull().defaultNow(),
    endedAt: tstz(),
    lastChunkAt: tstz(),
    processedAt: tstz(),
    expiresAt: tstz(),
    error: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('recordings_room_idx').on(t.roomId),
    index('recordings_created_by_idx').on(t.createdBy),
    index('recordings_status_idx').on(t.status),
    index('recordings_expires_idx').on(t.expiresAt),
    // FK `meeting_id ON DELETE SET NULL`: without it every deleted meeting scans recordings (Stage 10, F-040).
    index('recordings_meeting_idx').on(t.meetingId),
    index('recordings_started_at_idx').on(t.startedAt),
  ],
)
