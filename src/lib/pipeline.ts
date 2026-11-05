import { alphaStats, type TraceBackend } from './engine/core'
import { browserBackend, decodeFile, toPngFile } from './engine/browser-backend'
import { crop, keyBackground, sliceSheet } from './engine/slice'
import { analyze } from './engine/analyze'
import { vectorize } from './engine/vectorize'
import type { Item, TraceParams } from './engine/types'
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
  addFiles(files)
  return { name: file.name, count: files.length, background: res.background, dropped: res.dropped }
}

export function clearItems() {
  // Remove from the UI first, then release the object URLs once the thumbnails are gone.
  const old = app.items.splice(0, app.items.length)
  sources.clear()
  setTimeout(() => {
    for (const i of old) {
      URL.revokeObjectURL(i.srcUrl)
      forgetUrls(i)
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

async function processItem(item: Item) {
  item.status = 'tracing'
  item.progress = ''
  item.trials = []
  item.autoTuned = false
  item.error = undefined
  forgetUrls(item)
  try {
    await ensureAnalysis(item)
    if (!sources.has(item.id)) throw new Error(item.error ?? 'unreadable image')
    const src = sources.get(item.id)!
    item.semiPct = alphaStats(src).semiPct

    item.notes = undefined
    const settings = { presetId: app.presetId, params: clone(app.params) as TraceParams, auto: clone(app.auto) }
    const res = await vectorize(src, settings, backend, {
      analysis: item.analysis,
      onProgress: (k, total) => (item.progress = `${k}/${total}`),
    })
    item.notes = res.notes
    item.trials = res.trials
    item.chosen = res.chosen
    item.autoTuned = res.autoTuned
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
