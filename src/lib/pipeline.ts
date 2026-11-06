import { outputQueue } from './measurement-queue.js'
import { alphaStats, computeMetrics, type TraceBackend } from './engine/core'
import { forgetEdits, outputSvg } from './edit'
import { browserBackend, decodeFile, toPngFile } from './engine/browser-backend'
import { crop, keyBackground, sliceSheet } from './engine/slice'
import { analyze } from './engine/analyze'
import { vectorize, VectorizationCancelled, type VectorizeResult, type VectorizeSettings } from './engine/vectorize'
import type { Item, TraceParams } from './engine/types'
import { app, clone, editKey, forgetUrls, sources } from './store.svelte'
import { uniqueImportName } from './import-names.js'

const backend: TraceBackend = browserBackend
export const engineName = backend.name

/** Fidelity of any SVG against the item's source image (same metrics as the trials). */
export async function measureSvg(item: Item, svg: string) {
  await ensureAnalysis(item)
  const src = sources.get(item.id)
  if (!src) return null
  return computeMetrics(src, await backend.rasterize(svg, src.width, src.height), svg)
}

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp)$/i

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

async function processItem(item: Item, settings: VectorizeSettings): Promise<PendingResult> {
  item.status = 'tracing'
  item.progress = ''
  item.error = undefined
  try {
    await ensureAnalysis(item)
    if (app.cancelRequested) throw new VectorizationCancelled()
    if (!sources.has(item.id)) throw new Error(item.error ?? 'unreadable image')
    const src = sources.get(item.id)!
    const semiPct = alphaStats(src).semiPct
    const res = await vectorize(src, settings, backend, {
      analysis: item.analysis,
      onProgress: (k, total) => (item.progress = `${k}/${total}`),
      shouldCancel: () => app.cancelRequested,
    })
    return { result: res, semiPct }
  } catch (e) {
    if (e instanceof VectorizationCancelled || app.cancelRequested) throw new VectorizationCancelled()
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

/** Request cancellation; an in-progress tracing trial finishes before the batch is rolled back. */
export function cancelProcessing() { if (app.running) app.cancelRequested = true }

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
  app.batchSettings = settings
  app.startedAt = performance.now()
  app.finishedAt = 0
  for (const item of app.items) {
    item.status = 'queued'
    item.progress = ''
  }
  const results: PendingResult[] = []
  try {
    for (const item of app.items) {
      if (app.cancelRequested) throw new VectorizationCancelled()
      results.push(await processItem(item, settings))
      app.batchProcessed++
      item.status = 'prepared'
      item.progress = ''
    }
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
    app.running = false; app.cancelRequested = false; app.batchProcessed = 0
  }
}

/** Invalidate immediately, coalesce slider changes, and measure one output at a time. */
export function refreshOutputMetrics(item: Item) {
  const key = editKey(item)
  if (!key) { outputQueue.cancel(item.id); item.outputMeasurement = undefined; return }
  item.outputMeasurement = { key }
  outputQueue.schedule(item.id, async () => {
    if (editKey(item) !== key || item.outputMeasurement?.key !== key) return
    try {
      const metrics = await measureSvg(item, outputSvg(item))
      if (!metrics) throw new Error('source image unavailable')
      if (editKey(item) === key && item.outputMeasurement?.key === key) item.outputMeasurement = { key, metrics }
    } catch (e) {
      if (editKey(item) === key && item.outputMeasurement?.key === key)
        item.outputMeasurement = { key, error: e instanceof Error ? e.message : String(e) }
    }
  })
}
