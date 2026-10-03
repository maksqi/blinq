/**
 * One processing job (`processing` → `ready` | `failed`), run by the queue with concurrency 1:
 * 1. claim the row across processes (session advisory lock) and write an attempt marker (retry once after a restart);
 * 2. refuse to run unless RECORDING_WORK_DIR is a tmpfs (or RECORDING_ALLOW_DISK_WORKDIR): the row stays `processing`;
 * 3. decrypt the chunks in order into ffprobe (≤ 32 MiB) and apply the allowlist — rejects never reach ffmpeg;
 * 4. decrypt the chunks again into ffmpeg's stdin; the plaintext MP4 goes to RECORDING_WORK_DIR/<id>/out.mp4;
 * 5. ffprobe the output, encrypt it to RECORDINGS_DIR/<id>/recording.blq1 (temp, fsync, rename), mark `ready`,
 *    delete the chunks; failures mark `failed` with a short code and delete the chunks too.
 * The work dir is wiped in `finally`. Unexpected errors (database, I/O) leave the row `processing` for a retry.
 */
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { and, eq } from 'drizzle-orm'
import { useDb } from '../../database/client'
import { recordings } from '../../database/schema'
import { env } from '../../utils/env'
import { logger, type Logger } from '../../utils/logger'
import { getSettings } from '../settings/settings'
import { Blq1Error, chunkInfo, createEncryptStream, openBlq1File, recordingInfo } from './blq1'
import { targetSize, transcodeArgs } from './ffmpeg-args'
import {
  demuxerForMime,
  evaluateOutput,
  evaluateSource,
  outputProbeArgs,
  parseProbeJson,
  PROBE_INPUT_LIMIT_BYTES,
  probeArgs,
} from './probe'
import { nextAttempt, type FailureCode } from './state'
import {
  chunkPath,
  commitFile,
  ensureRecordingDir,
  fileExists,
  freeBytes,
  isTmpfs,
  masterKey,
  pathForStorageKey,
  removeChunkFiles,
  removeWorkDir,
  storageKeyFor,
  tempPath,
  workDir,
  workRoot,
} from './storage'
import { runTool, stderrSummary } from './tools'

const PROBE_TIMEOUT_MS = 60_000
const DAY_MS = 24 * 3_600_000
/** Advisory-lock namespace for processing claims (int4). */
const JOB_LOCK_NAMESPACE = 80_801
/** Head room kept free in the work dir besides the output (`-fs`). */
const WORK_DIR_RESERVE_BYTES = 16 * 1024 * 1024

type Row = typeof recordings.$inferSelect

type JobOutcome =
  | { kind: 'ready'; sizeBytes: number; durationMs: number; width: number; height: number }
  | { kind: 'failed'; code: FailureCode; detail?: string }
  | { kind: 'aborted' }

async function* decryptedChunks(id: string, count: number, key: Buffer): AsyncGenerator<Buffer> {
  for (let seq = 0; seq < count; seq++) {
    const reader = await openBlq1File(chunkPath(id, seq), { masterKey: key, info: chunkInfo(id, seq) })
    try {
      yield* reader.segments()
    } finally {
      await reader.close()
    }
  }
}

/** Claims a job across processes; the lock lives on a reserved connection and dies with it. */
async function claimJob(id: string): Promise<{ release(): Promise<void> } | null> {
  const reserved = await useDb().$client.reserve()
  try {
    const [row] = await reserved<Array<{ locked: boolean }>>`select pg_try_advisory_lock(${JOB_LOCK_NAMESPACE}, hashtext(${id})) as locked`
    if (!row?.locked) {
      reserved.release()
      return null
    }
  } catch (error) {
    reserved.release()
    throw error
  }
  return {
    async release() {
      try {
        await reserved`select pg_advisory_unlock(${JOB_LOCK_NAMESPACE}, hashtext(${id}))`
      } catch {
        // Releasing the connection below ends the session lock at the latest when the pool closes it.
      } finally {
        reserved.release()
      }
    },
  }
}

let diskWorkDirWarned = false

/** Plaintext must not touch persistent disk: production transcodes only into a tmpfs (decision: else wait). */
async function workDirAllowed(log: Logger): Promise<boolean> {
  if (await isTmpfs(workRoot())) return true
  if (env().RECORDING_ALLOW_DISK_WORKDIR) {
    if (!diskWorkDirWarned) {
      diskWorkDirWarned = true
      log.warn('RECORDING_WORK_DIR is not a tmpfs: transcoding writes plaintext to disk (allowed by RECORDING_ALLOW_DISK_WORKDIR)')
    }
    return true
  }
  log.error('refusing to transcode: RECORDING_WORK_DIR is not a tmpfs mount; the recording stays in processing')
  return false
}

function failed(code: FailureCode, detail?: string): JobOutcome {
  return { kind: 'failed', code, detail }
}

function inputFailure(error: unknown): JobOutcome {
  if (error instanceof Blq1Error) return failed('integrity', error.reason)
  throw error
}

async function transcode(row: Row, signal: AbortSignal, log: Logger): Promise<JobOutcome> {
  const id = row.id
  const config = env()
  const settings = await getSettings()
  const key = masterKey()
  if (row.chunkCount <= 0) return failed('no_chunks')
  for (let seq = 0; seq < row.chunkCount; seq++) {
    if (!(await fileExists(chunkPath(id, seq)))) return failed('missing_chunks', String(seq))
  }
  const demuxer = demuxerForMime(row.sourceMime)
  if (!demuxer) return failed('invalid_media', 'mime')

  const probe = await runTool(config.FFPROBE_PATH, probeArgs(demuxer), {
    input: decryptedChunks(id, row.chunkCount, key),
    inputLimitBytes: PROBE_INPUT_LIMIT_BYTES,
    timeoutMs: PROBE_TIMEOUT_MS,
    signal,
  })
  if (probe.aborted) return { kind: 'aborted' }
  if (probe.inputError) return inputFailure(probe.inputError)
  if (probe.timedOut || probe.code !== 0) return failed('invalid_media', stderrSummary(probe.stderr) || 'probe_failed')
  const maxDurationMinutes = settings['recording.maxDurationMinutes']
  const source = evaluateSource(parseProbeJson(probe.stdout), { demuxer, maxDurationMinutes })
  if (!source.ok) return failed('invalid_media', source.reason)

  const dir = workDir(id)
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true, mode: 0o700 })
  try {
    const output = join(dir, 'out.mp4')
    const budget = Math.max(1024 * 1024, (await freeBytes(dir)) - WORK_DIR_RESERVE_BYTES)
    const size = targetSize(source.info, settings['recording.maxResolution'])
    const args = transcodeArgs({
      demuxer,
      width: size.width,
      height: size.height,
      maxDurationSec: maxDurationMinutes * 60,
      maxOutputBytes: budget,
      threads: config.FFMPEG_THREADS,
      output,
    })
    log.info('recording transcode started', { width: size.width, height: size.height, chunks: row.chunkCount })
    const result = await runTool(config.FFMPEG_PATH, args, {
      input: decryptedChunks(id, row.chunkCount, key),
      timeoutMs: config.FFMPEG_TIMEOUT_MINUTES * 60_000,
      signal,
    })
    if (result.aborted) return { kind: 'aborted' }
    if (result.inputError) return inputFailure(result.inputError)
    if (result.timedOut) return failed('timeout')
    if (result.code !== 0) return failed('ffmpeg_failed', stderrSummary(result.stderr))
    const sizeBytes = (await stat(output)).size
    if (sizeBytes >= budget) return failed('too_large')

    const check = await runTool(config.FFPROBE_PATH, outputProbeArgs(output), { timeoutMs: PROBE_TIMEOUT_MS, signal })
    if (check.aborted) return { kind: 'aborted' }
    const verdict = evaluateOutput(check.code === 0 ? parseProbeJson(check.stdout) : null, source.info.audioCodec !== null)
    if (!verdict.ok) return failed('ffmpeg_failed', `output_${verdict.reason}`)

    await ensureRecordingDir(id)
    const temp = tempPath(id)
    try {
      await pipeline(
        createReadStream(output),
        createEncryptStream({ masterKey: key, info: recordingInfo(id) }),
        createWriteStream(temp, { flush: true, mode: 0o600 }),
      )
      if (signal.aborted) {
        await rm(temp, { force: true })
        return { kind: 'aborted' }
      }
      await commitFile(temp, pathForStorageKey(storageKeyFor(id)))
    } catch (error) {
      await rm(temp, { force: true })
      throw error
    }
    return { kind: 'ready', sizeBytes, durationMs: verdict.info.durationMs, width: verdict.info.width, height: verdict.info.height }
  } finally {
    await removeWorkDir(id)
  }
}

async function markFailed(id: string, code: FailureCode, log: Logger, detail?: string): Promise<void> {
  await useDb()
    .update(recordings)
    .set({ status: 'failed', error: code })
    .where(and(eq(recordings.id, id), eq(recordings.status, 'processing')))
  await removeChunkFiles(id)
  log.warn('recording processing failed', { code, ...(detail ? { detail } : {}) })
}

/** Pure: the columns of a recording that became ready at `processedAt` (kept `retentionDays` from then). */
export function readyColumns(
  id: string,
  outcome: Extract<JobOutcome, { kind: 'ready' }>,
  processedAt: Date,
  retentionDays: number,
) {
  return {
    status: 'ready' as const,
    error: null,
    storageKey: storageKeyFor(id),
    sizeBytes: outcome.sizeBytes,
    durationMs: outcome.durationMs,
    width: outcome.width,
    height: outcome.height,
    processedAt,
    expiresAt: new Date(processedAt.getTime() + retentionDays * DAY_MS),
  }
}

/**
 * The queue worker. Never throws for media problems; unexpected errors propagate (the row stays `processing`).
 * `now` is the clock for `processed_at` and the retention deadline (injectable for tests).
 */
export async function processRecording(
  id: string,
  signal: AbortSignal,
  now: () => Date = () => new Date(),
): Promise<void> {
  const log = logger.child({ recordingId: id })
  const claim = await claimJob(id)
  if (!claim) {
    log.debug('recording is being processed by another process')
    return
  }
  try {
    const db = useDb()
    const [row] = await db.select().from(recordings).where(eq(recordings.id, id)).limit(1)
    if (!row || row.status !== 'processing' || row.mode !== 'server') return
    if (!(await workDirAllowed(log))) return

    const attempt = nextAttempt(row.error)
    if (attempt === 'give_up') {
      await markFailed(id, 'interrupted', log)
      return
    }
    const marked = await db
      .update(recordings)
      .set({ error: attempt.marker })
      .where(and(eq(recordings.id, id), eq(recordings.status, 'processing')))
      .returning({ id: recordings.id })
    if (!marked.length) return

    const outcome = await transcode(row, signal, log)
    if (outcome.kind === 'aborted') {
      log.info('recording processing aborted')
      return
    }
    if (outcome.kind === 'failed') {
      await markFailed(id, outcome.code, log, outcome.detail)
      return
    }
    const settings = await getSettings()
    const updated = await db
      .update(recordings)
      .set(readyColumns(id, outcome, now(), settings['recording.retentionDays']))
      .where(and(eq(recordings.id, id), eq(recordings.status, 'processing')))
      .returning({ id: recordings.id })
    if (!updated.length) {
      // Deleted while the job ran: nothing may stay behind.
      await rm(pathForStorageKey(storageKeyFor(id)), { force: true })
      return
    }
    await removeChunkFiles(id)
    log.info('recording ready', { durationMs: outcome.durationMs, sizeBytes: outcome.sizeBytes })
  } finally {
    await claim.release()
  }
}
