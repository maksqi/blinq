/**
 * Counting semaphore (server-core): at most `max` tasks run at once, the rest wait in FIFO order.
 * Used to cap concurrent argon2 work (docs/SECURITY.md §4); reusable for other CPU-heavy jobs.
 *
 *   const cpu = createSemaphore(4, { maxWaiting: 16 })
 *   await cpu.run(() => expensive())   // rejects with SemaphoreFullError when 16 tasks already wait
 *
 * `maxWaiting` bounds the queue (F-016): under a flood, extra work is refused at once instead of making every caller,
 * legitimate ones included, wait behind it. Without it the queue is unbounded.
 */
export interface Semaphore {
  run<T>(task: () => Promise<T>): Promise<T>
  readonly active: number
  readonly waiting: number
}

export class SemaphoreFullError extends Error {
  constructor() {
    super('Too many tasks are waiting')
    this.name = 'SemaphoreFullError'
  }
}

export function createSemaphore(max: number, options: { maxWaiting?: number } = {}): Semaphore {
  if (!Number.isInteger(max) || max < 1) throw new RangeError('Semaphore size must be a positive integer')
  const maxWaiting = options.maxWaiting ?? Number.POSITIVE_INFINITY
  if (!(maxWaiting >= 0)) throw new RangeError('maxWaiting must not be negative')
  let active = 0
  const queue: Array<() => void> = []

  const release = () => {
    const next = queue.shift()
    if (next) next()
    else active--
  }

  return {
    async run<T>(task: () => Promise<T>): Promise<T> {
      if (active < max) active++
      else if (queue.length >= maxWaiting) throw new SemaphoreFullError()
      else await new Promise<void>((resolve) => queue.push(resolve))
      try {
        return await task()
      } finally {
        release()
      }
    },
    get active() {
      return active
    },
    get waiting() {
      return queue.length
    },
  }
}
