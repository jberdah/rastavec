// The shared vectorisation loop: analysis -> parameters -> trace -> render -> measure ->
// deterministic auto-tune -> choice. Pure (no DOM, no UI state): used by the web app and the CLI,
// each with its own TraceBackend.
import { analyze, recommend, type Analysis, type NoteCode } from './analyze'
import { candidates, choose, computeMetrics, prepare, score, type RGBAImage, type TraceBackend } from './core'
import type { AutoTune, TraceParams, Trial } from './types'
import { presetById } from './presets'
import { tracePixelGrid } from './pixel-grid'

export interface VectorizeSettings {
  /** 'auto' derives the parameters from the image analysis; anything else uses `params`. */
  presetId: string
  params: TraceParams
  auto: AutoTune
}

export interface VectorizeResult {
  analysis: Analysis
  notes?: NoteCode[]
  trials: Trial[]
  chosen: number
  autoTuned: boolean
  failedTrials: { traceScale: number; message: string }[]
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

export class VectorizationCancelled extends Error {
  constructor() { super('Vectorization cancelled'); this.name = 'VectorizationCancelled' }
}

function enlarge(src: RGBAImage, scale: number): RGBAImage {
  const width = src.width * scale, height = src.height * scale
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const from = (Math.floor(y / scale) * src.width + Math.floor(x / scale)) * 4
    data.set(src.data.subarray(from, from + 4), (y * width + x) * 4)
  }
  return { width, height, data }
}

export async function runTrial(src: RGBAImage, params: TraceParams, base: boolean, backend: TraceBackend, traceScale = 1): Promise<Trial> {
  const t0 = now()
  const input = traceScale === 1 ? src : enlarge(src, traceScale)
  let svg = await backend.trace(prepare(input, params), params)
  // Keep the enlarged viewBox and paths, but display/export at the original dimensions.
  if (traceScale !== 1) svg = svg.replace(/^(<svg\b[^>]*?)\bwidth="\d+"\s+height="\d+"/, `$1width="${src.width}" height="${src.height}"`)
  const render = await backend.rasterize(svg, src.width, src.height)
  const metrics = computeMetrics(src, render, svg)
  return { base, params: { ...params }, traceScale, svg, metrics, score: score(metrics), ms: now() - t0 }
}

async function runPixelGridTrial(src: RGBAImage, svg: string, backend: TraceBackend): Promise<Trial | null> {
  const t0 = now()
  try {
    const rendered = await backend.rasterize(svg, src.width, src.height)
    const metrics = computeMetrics(src, rendered, svg)
    return { base: false, params: { ...presetById('pixel').params }, traceScale: 1, traceMethod: 'pixel-grid', svg, metrics, score: score(metrics), ms: now() - t0 }
  } catch {
    // An optional exact-grid candidate must not discard valid VTracer trials.
    return null
  }
}

export async function vectorize(
  src: RGBAImage,
  settings: VectorizeSettings,
  backend: TraceBackend,
  opts: { analysis?: Analysis; onProgress?: (done: number, total: number) => void; shouldCancel?: () => boolean } = {},
): Promise<VectorizeResult> {
  const checkCancelled = () => { if (opts.shouldCancel?.()) throw new VectorizationCancelled() }
  checkCancelled()
  const analysis = opts.analysis ?? analyze(src)
  let base = { ...settings.params }
  let notes: NoteCode[] | undefined
  if (settings.presetId === 'auto') {
    const rec = recommend(analysis)
    base = rec.params
    notes = rec.notes
  }
  const { auto } = settings
  const transparent = src.data.some((v, k) => (k & 3) === 3 && v < 255)
  const grid = candidates(base, { transparent })
  const pixelScales = (settings.presetId === 'auto' || settings.presetId === 'pixel') && Math.max(src.width, src.height) <= 256 ? [2, 4] : []
  const exactGrid = auto.enabled && (settings.presetId === 'auto' || settings.presetId === 'pixel') ? tracePixelGrid(src) : null
  const total = auto.enabled ? grid.length + pixelScales.length + (exactGrid !== null ? 1 : 0) + 1 : 1
  opts.onProgress?.(1, total)
  const trials: Trial[] = [await runTrial(src, base, true, backend)]
  checkCancelled()
  const failedTrials: VectorizeResult['failedTrials'] = []
  const first = trials[0].metrics
  const needsTune = first.pctDiff > auto.threshold || first.bytes > auto.maxKB * 1024
  if (auto.enabled && needsTune) {
    for (const [k, c] of grid.entries()) {
      checkCancelled()
      opts.onProgress?.(k + 2, total)
      trials.push(await runTrial(src, c.params, false, backend))
      checkCancelled()
    }
    if (exactGrid !== null) {
      checkCancelled()
      opts.onProgress?.(grid.length + 2, total)
      const pixelGridTrial = await runPixelGridTrial(src, exactGrid, backend)
      checkCancelled()
      if (pixelGridTrial) trials.push(pixelGridTrial)
    }
    for (const [k, scale] of pixelScales.entries()) {
      checkCancelled()
      opts.onProgress?.(grid.length + (exactGrid !== null ? 1 : 0) + k + 2, total)
      try {
        trials.push(await runTrial(src, presetById('pixel').params, false, backend, scale))
      } catch (error) {
        checkCancelled()
        failedTrials.push({ traceScale: scale, message: error instanceof Error ? error.message : String(error) })
      }
      checkCancelled()
    }
  } else if (auto.enabled && exactGrid !== null && (settings.presetId === 'pixel' || analysis.kind === 'pixel')) {
    // Compare the exact grid even when the first VTracer result already passes.
    // This avoids accepting visibly softened pixel art just because it is under
    // the generic threshold. The normal score still decides whether its larger
    // editable geometry is worth the fidelity gain.
    const pixelGridTrial = await runPixelGridTrial(src, exactGrid, backend)
    checkCancelled()
    if (pixelGridTrial) trials.push(pixelGridTrial)
    opts.onProgress?.(total, total)
  }
  const chosen = choose(trials, auto.maxKB * 1024)
  return { analysis, notes, trials, chosen, autoTuned: chosen !== 0, failedTrials }
}

/** True when the chosen result misses the threshold or the size budget. */
export const needsReviewResult = (r: VectorizeResult, auto: AutoTune) =>
  r.trials[r.chosen].metrics.pctDiff > auto.threshold || r.trials[r.chosen].metrics.bytes > auto.maxKB * 1024
