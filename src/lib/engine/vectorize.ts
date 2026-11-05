// The shared vectorisation loop: analysis -> parameters -> trace -> render -> measure ->
// deterministic auto-tune -> choice. Pure (no DOM, no UI state): used by the web app and the CLI,
// each with its own TraceBackend.
import { analyze, recommend, type Analysis, type NoteCode } from './analyze'
import { candidates, choose, computeMetrics, prepare, score, type RGBAImage, type TraceBackend } from './core'
import type { AutoTune, TraceParams, Trial } from './types'

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
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

export async function runTrial(src: RGBAImage, params: TraceParams, base: boolean, backend: TraceBackend): Promise<Trial> {
  const t0 = now()
  const svg = await backend.trace(prepare(src, params), params)
  const render = await backend.rasterize(svg, src.width, src.height)
  const metrics = computeMetrics(src, render, svg)
  return { base, params: { ...params }, svg, metrics, score: score(metrics), ms: now() - t0 }
}

export async function vectorize(
  src: RGBAImage,
  settings: VectorizeSettings,
  backend: TraceBackend,
  opts: { analysis?: Analysis; onProgress?: (done: number, total: number) => void } = {},
): Promise<VectorizeResult> {
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
  const total = auto.enabled ? grid.length + 1 : 1
  opts.onProgress?.(1, total)
  const trials: Trial[] = [await runTrial(src, base, true, backend)]
  const first = trials[0].metrics
  if (auto.enabled && (first.pctDiff > auto.threshold || first.bytes > auto.maxKB * 1024)) {
    for (const [k, c] of grid.entries()) {
      opts.onProgress?.(k + 2, total)
      trials.push(await runTrial(src, c.params, false, backend))
    }
  }
  const chosen = choose(trials, auto.maxKB * 1024)
  return { analysis, notes, trials, chosen, autoTuned: chosen !== 0 }
}

/** True when the chosen result misses the threshold or the size budget. */
export const needsReviewResult = (r: VectorizeResult, auto: AutoTune) =>
  r.trials[r.chosen].metrics.pctDiff > auto.threshold || r.trials[r.chosen].metrics.bytes > auto.maxKB * 1024
