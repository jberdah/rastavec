import type { Item, AutoTune, TraceParams } from './engine/types'
import { app, clone, outputMeasurementKey, sources } from './store.svelte'
import { decodeFile } from './engine/browser-backend'
import { analyze } from './engine/analyze'
import { refreshOutputMetrics } from './pipeline'
import { DEFAULT_PARAMS } from './engine/presets'

// One record per origin. An IndexedDB transaction replaces it atomically: a quota failure
// leaves the preceding saved session intact. Files and SVGs remain on this device.
const DB = 'rastavec-session'
const STORE = 'sessions'
const KEY = 'current'

type SavedItem = Omit<Item, 'srcUrl'>
export interface SessionRecord {
  version: 1
  savedAt: number
  elapsedMs: number
  presetId: string
  params: TraceParams
  auto: AutoTune
  batchSettings: typeof app.batchSettings
  selectedId: string | null
  items: SavedItem[]
}

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Cannot open local storage'))
    request.onblocked = () => reject(new Error('Local storage is blocked by another window'))
  })
}

async function transaction<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database()
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode)
      const request = operation(tx.objectStore(STORE))
      let result: T
      request.onsuccess = () => { result = request.result }
      tx.oncomplete = () => resolve(result)
      tx.onabort = () => reject(tx.error ?? request.error ?? new Error('Local storage transaction aborted'))
      tx.onerror = () => { /* onabort reports the transaction failure */ }
    })
  } finally { db.close() }
}

export function captureSession(): SessionRecord {
  if (app.running || !app.items.length) throw new Error('No complete session to save')
  const items = app.items.map((item) => {
    // Svelte proxies cannot be structured-cloned. Keep the original File, and copy plain data.
    const { file, srcUrl: _url, ...rest } = item
    return { ...clone(rest), file }
  })
  return {
    version: 1, savedAt: Date.now(),
    elapsedMs: app.finishedAt && app.startedAt ? Math.max(0, app.finishedAt - app.startedAt) : 0,
    presetId: app.presetId, params: clone(app.params), auto: clone(app.auto),
    batchSettings: app.batchSettings ? clone(app.batchSettings) : null,
    selectedId: app.selectedId, items,
  }
}

export async function loadSession(): Promise<SessionRecord | undefined> {
  return transaction('readonly', (store) => store.get(KEY))
}
export async function saveSession(value: SessionRecord): Promise<void> {
  await transaction('readwrite', (store) => store.put(value, KEY))
}
export async function deleteSession(): Promise<void> {
  await transaction('readwrite', (store) => store.delete(KEY))
}

/** Prepare completely before touching the current batch: failed or conflicting restores do not replace it. */
export async function restoreSession(record: SessionRecord): Promise<void> {
  if (app.running || app.items.length) throw new Error('The current batch is not empty')
  if (!record || record.version !== 1 || !Array.isArray(record.items) || !record.items.length ||
      !record.params || !record.auto || typeof record.presetId !== 'string') throw new Error('Unsupported or invalid saved session')
  const decoded = new Map<string, Awaited<ReturnType<typeof decodeFile>>>()
  const prepared: Item[] = []
  try {
    for (const saved of record.items) {
      if (!saved.id || !saved.name || !(saved.file instanceof Blob) || !Array.isArray(saved.trials) ||
          !['done', 'queued', 'error'].includes(saved.status) ||
          (saved.status === 'done' && (!Number.isInteger(saved.chosen) || !saved.trials[saved.chosen]?.svg)))
        throw new Error('Unsupported or invalid saved image')
      const storedFile: Blob = saved.file
      const file = storedFile instanceof File ? storedFile : new File([storedFile], saved.name, { type: storedFile.type })
      let image: Awaited<ReturnType<typeof decodeFile>> | null = null
      let decodeError: string | undefined
      if (saved.status !== 'error') {
        try { image = await decodeFile(file) }
        catch (e) {
          if (saved.status === 'done') throw e
          decodeError = e instanceof Error ? e.message : String(e)
        }
      }
      if (image) decoded.set(saved.id, image)
      prepared.push({ ...saved, file, srcUrl: URL.createObjectURL(file), progress: '',
        ...(decodeError ? { status: 'error' as const, error: decodeError } : {}),
        ...(image ? { width: image.width, height: image.height, analysis: saved.analysis ?? analyze(image) } : {}) })
    }
    if (app.running || app.items.length) throw new Error('The current batch changed while restoring')
  } catch (e) {
    for (const item of prepared) URL.revokeObjectURL(item.srcUrl)
    throw e
  }
  sources.clear()
  for (const [id, img] of decoded) sources.set(id, img)
  app.params = { ...DEFAULT_PARAMS, ...record.params }
  app.auto = record.auto
  app.presetId = record.presetId
  app.batchSettings = record.batchSettings
    ? { ...record.batchSettings, params: { ...DEFAULT_PARAMS, ...record.batchSettings.params } }
    : null
  app.selectedId = record.selectedId
  app.finishedAt = performance.now()
  // performance.now() starts afresh after a reload; the previous duration can exceed it.
  app.startedAt = app.finishedAt - record.elapsedMs
  app.items = prepared
  app.route = prepared.some((i) => i.status === 'done') ? 'lot' : 'import'
  // A measurement may have been pending at the instant of the last save. Never reuse it
  // for different output markup; recalculate missing/stale edit or grouping measurements.
  for (const item of app.items) {
    const key = outputMeasurementKey(item)
    if (item.status === 'done' && key && (item.outputMeasurement?.key !== key || !item.outputMeasurement.metrics))
      refreshOutputMetrics(item)
  }
}
