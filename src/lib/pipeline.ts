import { outputQueue } from './measurement-queue.js'
import { alphaStats, computeMetrics, type RGBAImage } from './engine/core'
import { forgetEdits, outputSvg } from './edit'
import { browserBackend, decodeFile, previewUrlFor, toPngFile } from './engine/browser-backend'
import { crop, keyBackground, sliceGrid, sliceSheet, type GridSliceOptions } from './engine/slice'
import { analyze } from './engine/analyze'
import { vectorize, VectorizationCancelled, type VectorizeResult, type VectorizeSettings } from './engine/vectorize'
import { createVectorizationWorkerPool, type VectorizationWorkerPool } from './engine/vectorization-worker-client'
import { selectTraceBackend, type TraceEngine } from './engine/web-trace-engine'
import type { Item, TraceParams } from './engine/types'
import { app, clone, forgetUrls, outputMeasurementKey, sources } from './store.svelte'
import { uniqueImportName } from './import-names.js'

let activeVectorizationWorkers: VectorizationWorkerPool | null = null

/** Fidelity of any SVG against the item's source image (same metrics as the trials). */
export async function measureSvg(item: Item, svg: string) {
  await ensureAnalysis(item)
  const src = sources.get(item.id)
  if (!src) return null
  return computeMetrics(src, await browserBackend.rasterize(svg, src.width, src.height), svg)
}

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i

export function addFiles(files: Iterable<File>) {
  // A running batch iterates app.items directly; never insert or sort it mid-run.
  if (app.running) return 0
  const names = new Set(app.items.map((i) => i.name.toLocaleLowerCase('en-US')))
  let added = 0
  for (const file of files) {
    if (!IMAGE_EXT.test(file.name)) continue
    const name = uniqueImportName(file.name.replace(/\.[^.]+$/, ''), names)
    app.items.push({
      id: crypto.randomUUID(),
      name,
      file,
      srcUrl: URL.createObjectURL(file),
      srcBytes: file.size,
      width: 0,
      height: 0,
      semiPct: 0,
      status: 'queued',
      progress: '',
      trials: [],
      chosen: 0,
      autoTuned: false,
    })
    added++
  }
  app.items.sort((a, b) => a.name.localeCompare(b.name, 'fr', { numeric: true }))
  void analyzePending()
  return added
}

let analyzing = false
/** Decode and analyse newly added images, one at a time, so the import screen can suggest settings. */
async function analyzePending() {
  if (analyzing) return
  analyzing = true
  try {
    for (let item = app.items.find((i) => !i.analysis && !i.error); item; item = app.items.find((i) => !i.analysis && !i.error)) {
      await ensureAnalysis(item)
      await new Promise((r) => setTimeout(r, 0))
    }
  } finally {
    analyzing = false
  }
}

async function ensureAnalysis(item: Item) {
  try {
    if (!sources.has(item.id)) {
      const decoded = await decodeFile(item.file)
      if (!app.items.some((i) => i.id === item.id)) return
      sources.set(item.id, decoded)
      // TIFF cannot be shown by <img> in most browsers: swap in a PNG preview once decoded.
      const preview = await previewUrlFor(item.file, decoded)
      if (preview && app.items.some((i) => i.id === item.id)) {
        URL.revokeObjectURL(item.srcUrl)
        item.srcUrl = preview
      } else if (preview) URL.revokeObjectURL(preview)
    }
    const src = sources.get(item.id)!
    item.width = src.width
    item.height = src.height
    if (!item.analysis) item.analysis = analyze(src)
  } catch (e) {
    item.status = 'error'
    item.error = e instanceof Error ? e.message : String(e)
  }
}

/**
 * Split a sprite sheet / brand board into one image per element and add them to the batch.
 * Works on transparent sheets, and on opaque ones with a uniform background (made transparent).
 */
export async function addSheet(file: File): Promise<{ name: string; count: number; background: string; dropped: number }> {
  const img = await decodeFile(file)
  const res = sliceSheet(img)
  const stem = file.name.replace(/\.[^.]+$/, '')
  const files: File[] = []
  for (const [k, box] of res.boxes.entries()) {
    let part = crop(img, box)
    if (res.background !== 'transparent') part = keyBackground(part, res.background)
    files.push(await toPngFile(part, `${stem}-${String(k + 1).padStart(2, '0')}.png`))
  }
  const count = addFiles(files)
  return { name: file.name, count, background: res.background, dropped: res.dropped }
}

/** Slice a regular frame grid while keeping every pose on the same canvas. */
export async function addGridSheet(file: File, options: GridSliceOptions): Promise<{ name: string; count: number; columns: number; rows: number; empty: number }> {
  const img = await decodeFile(file)
  const res = sliceGrid(img, options)
  const stem = file.name.replace(/\.[^.]+$/, '')
  const files: File[] = []
  for (const box of res.boxes) {
    let part = crop(img, box)
    if (res.background !== 'transparent') part = keyBackground(part, res.background)
    const poseName = `r${String(box.row + 1).padStart(2, '0')}-c${String(box.column + 1).padStart(2, '0')}`
    files.push(await toPngFile(part, `${stem}-${poseName}.png`))
  }
  return { name: file.name, count: addFiles(files), columns: res.columns, rows: res.rows, empty: res.dropped }
}

export function clearItems() {
  // Remove from the UI first, then release the object URLs once the thumbnails are gone.
  const old = app.items.splice(0, app.items.length)
  sources.clear()
  app.batchSettings = null
  app.batchCancelled = false
  setTimeout(() => {
    for (const i of old) {
      URL.revokeObjectURL(i.srcUrl)
      forgetUrls(i)
      forgetEdits(i)
    }
  }, 1000)
}

/** Recursively collect files from a drop (folders included). */
export async function filesFromDrop(dt: DataTransfer): Promise<File[]> {
  const entries = Array.from(dt.items)
    .map((it) => it.webkitGetAsEntry?.())
    .filter(Boolean) as FileSystemEntry[]
  if (!entries.length) return Array.from(dt.files)
  const out: File[] = []
  const walk = async (e: FileSystemEntry): Promise<void> => {
    if (e.isFile) out.push(await new Promise<File>((res, rej) => (e as FileSystemFileEntry).file(res, rej)))
    else if (e.isDirectory) {
      const reader = (e as FileSystemDirectoryEntry).createReader()
      let batch: FileSystemEntry[]
      do {
        batch = await new Promise((res, rej) => reader.readEntries(res, rej))
        for (const child of batch) await walk(child)
      } while (batch.length)
    }
  }
  for (const e of entries) await walk(e)
  return out
}

type PendingResult = { result: VectorizeResult; semiPct: number } | { error: string }

/** Restore an image buffer transferred to a worker before cancellation escapes the item runner. */
export async function recoverWorkerSource(
  source: RGBAImage,
  itemId: string,
  sourceCache: Map<string, RGBAImage>,
  restore: () => Promise<RGBAImage>,
  shouldCancel: () => boolean,
  workerError: unknown,
  makeCancelledError: () => Error,
): Promise<RGBAImage> {
  const workerCancelled = !!(workerError && typeof workerError === 'object' && 'cancelled' in workerError && workerError.cancelled)
  const cancellationRequested = () => shouldCancel() || workerCancelled
  let recovered = source

  if (source.data.byteLength !== source.width * source.height * 4) {
    const detachedSource = source
    const ownsCacheEntry = sourceCache.get(itemId) === detachedSource
    try {
      recovered = await restore()
      if (ownsCacheEntry && sourceCache.get(itemId) === detachedSource) sourceCache.set(itemId, recovered)
    } catch (restoreError) {
      // Never leave a detached typed array in the cache, even if decoding cannot recover it.
      if (sourceCache.get(itemId) === detachedSource) sourceCache.delete(itemId)
      if (cancellationRequested()) throw makeCancelledError()
      throw restoreError
    }
  }

  if (cancellationRequested()) throw makeCancelledError()
  return recovered
}

async function processItem(item: Item, settings: VectorizeSettings, traceEngine: TraceEngine, workerPool: VectorizationWorkerPool | null): Promise<PendingResult> {
  item.status = 'tracing'
  item.progress = ''
  item.error = undefined
  try {
    await ensureAnalysis(item)
    if (app.cancelRequested) throw new VectorizationCancelled()
    if (!sources.has(item.id)) throw new Error(item.error ?? 'unreadable image')
    let src = sources.get(item.id)!
    const semiPct = alphaStats(src).semiPct
    const progress = (k: number, total: number) => (item.progress = `${k}/${total}`)
    const traceOnMain = async () => vectorize(src, settings, await selectTraceBackend(browserBackend, traceEngine), {
      analysis: item.analysis,
      onProgress: progress,
      shouldCancel: () => app.cancelRequested,
    })
    let res: VectorizeResult
    if (workerPool) {
      try {
        // `item` is Svelte-reactive, so its analysis may be a Proxy that cannot cross
        // the structured-clone boundary. Analysis is a small plain-data record.
        res = await workerPool.run({ source: src, settings, traceEngine, analysis: item.analysis ? clone(item.analysis) : undefined, onProgress: progress })
      } catch (error) {
        // Restore/invalidate transferred pixels before cancellation or fallback can escape.
        src = await recoverWorkerSource(src, item.id, sources, () => decodeFile(item.file),
          () => app.cancelRequested, error, () => new VectorizationCancelled())
        console.warn('Vectorization worker failed; retrying this image on the main thread.', error)
        res = await traceOnMain()
      }
    } else {
      res = await traceOnMain()
    }
    return { result: res, semiPct }
  } catch (e) {
    if (e instanceof VectorizationCancelled || app.cancelRequested) throw new VectorizationCancelled()
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

/** Request cancellation; the workers yield between trials, then the batch is rolled back atomically. */
export function cancelProcessing() {
  if (!app.running) return
  app.cancelRequested = true
  activeVectorizationWorkers?.cancelAll()
}

export async function processAll() {
  if (app.running) return
  app.running = true
  app.cancelRequested = false
  app.batchCancelled = false
  app.batchProcessed = 0
  const previousSettings = app.batchSettings
  const previousTimes = { startedAt: app.startedAt, finishedAt: app.finishedAt }
  const previous = app.items.map((item) => ({ item, status: item.status, error: item.error, progress: item.progress }))
  const settings = { presetId: app.presetId, params: clone(app.params), auto: clone(app.auto) }
  const traceEngine = settings.presetId !== 'auto' && settings.params.colormode === 'binary' ? 'next' : app.traceEngine
  const largestImagePixels = app.items.reduce((largest, item) => Math.max(largest, item.width > 0 && item.height > 0 ? item.width * item.height : 40_000_000), 0)
  const hardwareThreads = typeof navigator === 'undefined' ? 1 : Math.max(1, navigator.hardwareConcurrency || 2)
  // Two workers improve small batch throughput; large images stay serial to bound peak memory.
  const desiredWorkerCount = largestImagePixels <= 4_000_000 ? Math.min(2, Math.max(1, hardwareThreads - 1)) : 1
  const workerPool = createVectorizationWorkerPool(desiredWorkerCount)
  activeVectorizationWorkers = workerPool
  app.batchSettings = { ...settings, traceEngine }
  app.startedAt = performance.now()
  app.finishedAt = 0
  for (const item of app.items) {
    item.status = 'queued'
    item.progress = ''
  }
  const results: PendingResult[] = new Array(app.items.length)
  try {
    let nextIndex = 0
    const runQueue = async () => {
      while (true) {
        if (app.cancelRequested) throw new VectorizationCancelled()
        const index = nextIndex++
        if (index >= app.items.length) return
        const item = app.items[index]
        results[index] = await processItem(item, settings, traceEngine, workerPool)
        app.batchProcessed++
        item.status = 'prepared'
        item.progress = ''
      }
    }
    const runnerCount = workerPool?.size ?? 1
    const runnerResults = await Promise.allSettled(Array.from({ length: runnerCount }, runQueue))
    if (app.cancelRequested || runnerResults.some((result) => result.status === 'rejected' && result.reason instanceof VectorizationCancelled)) throw new VectorizationCancelled()
    const runnerError = runnerResults.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (runnerError) throw runnerError.reason
    if (app.cancelRequested) throw new VectorizationCancelled()
    // Commit the whole batch at once: a cancelled run never destroys earlier trials or edits.
    for (const [index, item] of app.items.entries()) {
      const pending = results[index]
      forgetUrls(item)
      forgetEdits(item)
      item.progress = ''
      if ('error' in pending) {
        item.status = 'error'; item.error = pending.error; item.trials = []; item.failedTrials = undefined
      } else {
        const res = pending.result
        item.semiPct = pending.semiPct; item.notes = res.notes; item.trials = res.trials; item.chosen = res.chosen
        item.autoTuned = res.autoTuned; item.failedTrials = res.failedTrials; item.error = undefined; item.status = 'done'
      }
    }
    app.finishedAt = performance.now()
  } catch (e) {
    for (const saved of previous) { saved.item.status = saved.status; saved.item.error = saved.error; saved.item.progress = saved.progress }
    app.batchSettings = previousSettings
    app.startedAt = previousTimes.startedAt; app.finishedAt = previousTimes.finishedAt
    app.batchCancelled = e instanceof VectorizationCancelled
    if (!(e instanceof VectorizationCancelled)) throw e
  } finally {
    workerPool?.close()
    if (activeVectorizationWorkers === workerPool) activeVectorizationWorkers = null
    app.running = false; app.cancelRequested = false; app.batchProcessed = 0
  }
}

/** Invalidate immediately, coalesce output changes, and measure one final SVG at a time. */
export function refreshOutputMetrics(item: Item) {
  const key = outputMeasurementKey(item)
  if (!key) { outputQueue.cancel(item.id); item.outputMeasurement = undefined; return }
  item.outputMeasurement = { key }
  outputQueue.schedule(item.id, async () => {
    if (outputMeasurementKey(item) !== key || item.outputMeasurement?.key !== key) return
    try {
      const metrics = await measureSvg(item, outputSvg(item))
      if (!metrics) throw new Error('source image unavailable')
      if (outputMeasurementKey(item) === key && item.outputMeasurement?.key === key) item.outputMeasurement = { key, metrics }
    } catch (e) {
      if (outputMeasurementKey(item) === key && item.outputMeasurement?.key === key)
        item.outputMeasurement = { key, error: e instanceof Error ? e.message : String(e) }
    }
  })
}
