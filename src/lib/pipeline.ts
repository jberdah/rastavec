import { alphaStats, candidates, choose, computeMetrics, prepare, score, type TraceBackend } from './engine/core'
import { browserBackend, decodeFile } from './engine/browser-backend'
import { describe } from './engine/presets'
import { analyze, recommend } from './engine/analyze'
import type { Item, TraceParams, Trial } from './engine/types'
import { app, clone, forgetUrls, sources } from './store.svelte'

const backend: TraceBackend = browserBackend
export const engineName = backend.name

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp)$/i

export function addFiles(files: Iterable<File>) {
  const names = new Set(app.items.map((i) => i.name))
  for (const file of files) {
    if (!IMAGE_EXT.test(file.name)) continue
    const name = file.name.replace(/\.[^.]+$/, '')
    if (names.has(name)) continue
    names.add(name)
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
  }
  app.items.sort((a, b) => a.name.localeCompare(b.name, 'fr', { numeric: true }))
  void analyzePending()
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
    if (!sources.has(item.id)) sources.set(item.id, await decodeFile(item.file))
    const src = sources.get(item.id)!
    item.width = src.width
    item.height = src.height
    if (!item.analysis) item.analysis = analyze(src)
  } catch (e) {
    item.status = 'error'
    item.error = e instanceof Error ? e.message : String(e)
  }
}

export function clearItems() {
  for (const i of app.items) {
    URL.revokeObjectURL(i.srcUrl)
    forgetUrls(i)
  }
  sources.clear()
  app.items.length = 0
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

async function runTrial(itemId: string, params: TraceParams, label: string): Promise<Trial> {
  const src = sources.get(itemId)!
  const t0 = performance.now()
  const svg = await backend.trace(prepare(src, params), params)
  const render = await backend.rasterize(svg, src.width, src.height)
  const metrics = computeMetrics(src, render, svg)
  return { label, params: { ...params }, svg, metrics, score: score(metrics), ms: performance.now() - t0 }
}

async function processItem(item: Item) {
  item.status = 'tracing'
  item.progress = 'décodage'
  item.trials = []
  item.autoTuned = false
  item.error = undefined
  forgetUrls(item)
  try {
    await ensureAnalysis(item)
    if (!sources.has(item.id)) throw new Error(item.error ?? 'image illisible')
    const src = sources.get(item.id)!
    item.semiPct = alphaStats(src).semiPct

    let base = clone(app.params) as TraceParams
    item.notes = undefined
    if (app.presetId === 'auto' && item.analysis) {
      const rec = recommend(item.analysis)
      base = rec.params
      item.notes = rec.notes
    }
    const auto = clone(app.auto)
    const transparent = src.data.some((v, k) => (k & 3) === 3 && v < 255)
    const grid = candidates(base, { transparent })
    const total = auto.enabled ? grid.length + 1 : 1
    item.progress = `essai 1/${total}`
    const first = await runTrial(item.id, base, 'Préréglage · ' + describe(base))
    item.trials.push(first)
    const over = first.metrics.pctDiff > auto.threshold || first.metrics.bytes > auto.maxKB * 1024
    if (auto.enabled && over) {
      for (const [k, c] of grid.entries()) {
        item.progress = `essai ${k + 2}/${total}`
        item.trials.push(await runTrial(item.id, c.params, describe(c.params)))
      }
    }
    item.chosen = choose(item.trials, auto.maxKB * 1024)
    item.autoTuned = item.chosen !== 0
    item.status = 'done'
  } catch (e) {
    item.status = 'error'
    item.error = e instanceof Error ? e.message : String(e)
  }
  item.progress = ''
}

export async function processAll() {
  if (app.running) return
  app.running = true
  app.startedAt = performance.now()
  app.finishedAt = 0
  for (const item of app.items) {
    item.status = 'queued'
    item.trials = []
  }
  for (const item of app.items) await processItem(item)
  app.finishedAt = performance.now()
  app.running = false
}
