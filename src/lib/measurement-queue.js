/** Coalesce edits by item and limit rasterisations to one at a time. */
export function createMeasurementQueue(delay = 200) {
  /** @type {Map<string, () => Promise<void>>} */
  const pending = new Map()
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null
  let running = false
  async function pump() {
    if (running || timer || !pending.size) return
    const first = pending.entries().next().value
    if (!first) return
    const [id, task] = first
    pending.delete(id)
    running = true
    try { await task() } finally { running = false; void pump() }
  }
  return {
    /** @param {string} id @param {() => Promise<void>} task */
    schedule(id, task) {
      pending.set(id, task)
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { timer = null; void pump() }, delay)
    },
    /** @param {string} id */
    cancel(id) { pending.delete(id) },
  }
}

/** Shared queue for edited outputs. */
export const outputQueue = createMeasurementQueue()
