import type { Analysis } from './analyze'
import { browserBackend } from './browser-backend'
import type { RGBAImage } from './core'
import type { VectorizeResult, VectorizeSettings } from './vectorize'
import type { RasterizeRequestMessage, RasterizedMessage, RasterizeErrorMessage } from './worker-raster-rpc'

interface VectorizeInput {
  source: RGBAImage
  settings: VectorizeSettings
  analysis?: Analysis
  onProgress?: (done: number, total: number) => void
}

type WorkerReply =
  | { type: 'progress'; requestId: number; done: number; total: number }
  | { type: 'result'; requestId: number; result: VectorizeResult; sourceBuffer: ArrayBuffer }
  | { type: 'error'; requestId: number; message: string; cancelled: boolean; sourceBuffer: ArrayBuffer }
  | RasterizeRequestMessage

interface Job extends VectorizeInput {
  requestId: number
  resolve: (result: VectorizeResult) => void
  reject: (error: Error) => void
}

interface Slot {
  worker: Worker
  active: Job | null
}

export class VectorizationWorkerPool {
  private readonly slots: Slot[]
  private readonly queue: Job[] = []
  private nextRequestId = 1
  private closed = false

  constructor(size: number) {
    const slots: Slot[] = []
    try {
      for (let index = 0; index < size; index++) slots.push(this.createSlot())
    } catch (error) {
      for (const slot of slots) slot.worker.terminate()
      throw error
    }
    this.slots = slots
  }

  get size() { return this.slots.length }

  run(input: VectorizeInput): Promise<VectorizeResult> {
    if (this.closed || !this.slots.length) return Promise.reject(new Error('Vectorization workers are unavailable.'))
    return new Promise((resolve, reject) => {
      this.queue.push({ ...input, requestId: this.nextRequestId++, resolve, reject })
      this.pump()
    })
  }

  cancelAll() {
    for (const slot of this.slots) {
      if (slot.active) slot.worker.postMessage({ type: 'cancel', requestId: slot.active.requestId })
    }
    for (const job of this.queue.splice(0)) job.reject(new Error('Vectorization cancelled'))
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.cancelAll()
    for (const slot of this.slots) slot.worker.terminate()
  }

  private createSlot(): Slot {
    const worker = new Worker(new URL('./vectorization-worker.ts', import.meta.url), { type: 'module' })
    const slot: Slot = { worker, active: null }
    worker.onmessage = (event: MessageEvent<WorkerReply>) => this.onMessage(slot, event.data)
    worker.onerror = (event) => this.onWorkerError(slot, new Error(event.message || 'Vectorization worker failed.'))
    worker.onmessageerror = () => this.onWorkerError(slot, new Error('Vectorization worker returned an unreadable response.'))
    return slot
  }

  private onMessage(slot: Slot, message: WorkerReply) {
    if (message.type === 'rasterize') {
      void this.onRasterize(slot, message)
      return
    }
    const job = slot.active
    if (!job || message.requestId !== job.requestId) return
    if (message.type === 'progress') {
      job.onProgress?.(message.done, message.total)
      return
    }

    // The pixel buffer was transferred to avoid cloning 4 bytes per source pixel.
    job.source.data = new Uint8ClampedArray(message.sourceBuffer)
    slot.active = null
    if (message.type === 'result') job.resolve(message.result)
    else job.reject(Object.assign(new Error(message.message), { cancelled: message.cancelled }))
    this.pump()
  }

  private async onRasterize(slot: Slot, message: RasterizeRequestMessage) {
    const job = slot.active
    if (!job || message.requestId !== job.requestId) {
      this.replyRasterizeError(slot, message, 'The vectorization request is no longer active.')
      return
    }
    try {
      const pixels = await browserBackend.rasterize(message.svg, message.width, message.height)
      // A fatal worker error may have replaced this slot while the browser decoded the SVG.
      if (slot.active !== job) return
      const image = pixels.data
      const transferable = image.buffer instanceof ArrayBuffer
        && image.byteOffset === 0
        && image.byteLength === image.buffer.byteLength
      const buffer = transferable ? image.buffer as ArrayBuffer : image.slice().buffer
      const reply: RasterizedMessage = { type: 'rasterized', requestId: message.requestId, rasterId: message.rasterId, buffer }
      try {
        slot.worker.postMessage(reply, [buffer])
      } catch (error) {
        this.onWorkerError(slot, error instanceof Error ? error : new Error(String(error)))
      }
    } catch (error) {
      if (slot.active !== job) return
      this.replyRasterizeError(slot, message, error instanceof Error ? error.message : String(error))
    }
  }

  private replyRasterizeError(slot: Slot, request: RasterizeRequestMessage, message: string) {
    const reply: RasterizeErrorMessage = { type: 'rasterize-error', requestId: request.requestId, rasterId: request.rasterId, message }
    try {
      slot.worker.postMessage(reply)
    } catch (error) {
      this.onWorkerError(slot, error instanceof Error ? error : new Error(String(error)))
    }
  }

  private onWorkerError(slot: Slot, error: Error) {
    const job = slot.active
    slot.active = null
    if (job) job.reject(error)
    slot.worker.terminate()
    if (!this.closed) {
      try {
        const replacement = this.createSlot()
        const index = this.slots.indexOf(slot)
        if (index >= 0) this.slots[index] = replacement
      } catch {
        const index = this.slots.indexOf(slot)
        if (index >= 0) this.slots.splice(index, 1)
      }
    }
    // The pipeline has one runner per initial slot. If every worker and replacement
    // fails, queued runners must reject so processItem can use its browser fallback.
    if (!this.slots.length) {
      for (const queued of this.queue.splice(0))
        queued.reject(new Error('Vectorization workers are unavailable.'))
    }
    this.pump()
  }

  private pump() {
    if (this.closed) return
    for (const slot of this.slots) {
      if (slot.active) continue
      const job = this.queue.shift()
      if (!job) break
      slot.active = job
      const image = job.source.data
      const transferable = image.buffer instanceof ArrayBuffer
        && image.byteOffset === 0
        && image.byteLength === image.buffer.byteLength
      const buffer = transferable ? image.buffer as ArrayBuffer : image.slice().buffer
      try {
        slot.worker.postMessage({
          type: 'vectorize', requestId: job.requestId, buffer,
          width: job.source.width, height: job.source.height,
          settings: job.settings, analysis: job.analysis,
        }, [buffer])
      } catch (error) {
        slot.active = null
        job.reject(error instanceof Error ? error : new Error(String(error)))
      }
    }
  }
}

export function createVectorizationWorkerPool(size: number): VectorizationWorkerPool | null {
  if (typeof Worker === 'undefined' || typeof document === 'undefined' || typeof Image === 'undefined') return null
  try { return new VectorizationWorkerPool(Math.max(1, Math.min(2, Math.floor(size)))) }
  catch { return null }
}
