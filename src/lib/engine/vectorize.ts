// The shared vectorisation loop: analysis -> parameters -> trace -> render -> measure ->
// deterministic auto-tune -> choice. Pure (no DOM, no UI state): used by the web app and the CLI,
// each with its own TraceBackend.
import { analyze, recommend, type Analysis, type NoteCode } from './analyze'
import { candidates, choose, computeMetrics, prepare, score, type RGBAImage, type TraceBackend } from './core'
import { calibrateSolidFills, snapSolidFillsToSourcePalette } from './fill-calibration'
import { mergeAdjacentSameFillPaths } from './merge-adjacent-paths'
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
  opts: { analysis?: Analysis; onProgress?: (done: number, total: number) => void; shouldCancel?: () => boolean; yieldControl?: () => Promise<void> } = {},
): Promise<VectorizeResult> {
  const checkCancelled = () => { if (opts.shouldCancel?.()) throw new VectorizationCancelled() }
  const yieldControl = async () => { await opts.yieldControl?.(); checkCancelled() }
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
  const grid = candidates(base, { transparent, includeHighSilhouetteCut: settings.presetId === 'auto' })
  const pixelScales = (settings.presetId === 'auto' || settings.presetId === 'pixel') && Math.max(src.width, src.height) <= 256 ? [2, 4] : []
  const exactGrid = auto.enabled && (settings.presetId === 'auto' || settings.presetId === 'pixel') ? tracePixelGrid(src) : null
  await yieldControl()
  const trials: Trial[] = [await runTrial(src, base, true, backend)]
  checkCancelled()
  const failedTrials: VectorizeResult['failedTrials'] = []
  const first = trials[0].metrics
  const needsTune = first.pctDiff > auto.threshold || first.bytes > auto.maxKB * 1024
  // Pixel-difference can undercount faint, sparse artwork: its lines may sit below the
  // 32/255 visibility threshold while the alpha>=128 silhouette shows that most shapes
  // disappeared. Try one low-complexity soft-layer fallback before accepting that result.
  const needsSoftOutlineRecovery = settings.presetId === 'auto'
    && analysis.alpha === 'soft'
    && first.iou !== null
    && first.iou < 0.5
  // High-quality vector sources rasterized to PNG often have a narrow antialias fringe.
  // For flat artwork in that category, a single 224 cut trial improves the render score
  // on the round-trip corpus without expanding the full tuning grid for already-passing images.
  const needsHighCutReview = settings.presetId === 'auto'
    && analysis.kind === 'flat'
    && analysis.alpha === 'edges'
    && analysis.softPct < 1
    && base.silhouetteCut === 192
    && first.iou !== null
  const comparePixelGrid = auto.enabled
    && exactGrid !== null
    && (settings.presetId === 'pixel' || analysis.kind === 'pixel')
  // Polygon tracing preserves sharp corners better than spline tracing on vector-like
  // raster sources. Compare it once in Auto, then let the normal fidelity score decide.
  const includePolygonReview = auto.enabled
    && settings.presetId === 'auto'
    && analysis.kind !== 'pixel'
    && base.mode !== 'polygon'
  const needsFocusedTrial = auto.enabled && !needsTune
    && (needsSoftOutlineRecovery || needsHighCutReview || comparePixelGrid)
  const tuningTrials = !auto.enabled
    ? 0
    : needsTune
      ? grid.length + pixelScales.length + (exactGrid !== null ? 1 : 0)
      : needsFocusedTrial ? 1 : 0
  const includeFillCalibration = auto.enabled
    && settings.presetId === 'auto'
    && base.colormode === 'color'
    && analysis.kind !== 'pixel'
  const includePaletteSnap = includeFillCalibration && analysis.kind === 'flat' && analysis.alpha === 'edges'
  const includePathMerge = auto.enabled
    && settings.presetId === 'auto'
    && base.colormode === 'color'
    && analysis.kind !== 'pixel'
  const total = 1 + tuningTrials + Number(includePolygonReview) + Number(includeFillCalibration) + Number(includePaletteSnap) + Number(includePathMerge)
  let completed = 1
  const reportProgress = () => opts.onProgress?.(completed, total)
  const completeTrial = () => { completed++; reportProgress() }
  reportProgress()
  if (auto.enabled && needsSoftOutlineRecovery && !needsTune) {
    const params = { ...base, softColor: false, softLayers: 1 }
    await yieldControl()
    trials.push(await runTrial(src, params, false, backend))
    checkCancelled()
    completeTrial()
  } else if (auto.enabled && needsHighCutReview && !needsTune) {
    const params = { ...base, silhouetteCut: 224 }
    await yieldControl()
    trials.push(await runTrial(src, params, false, backend))
    checkCancelled()
    completeTrial()
  } else if (auto.enabled && needsTune) {
    for (const c of grid) {
      await yieldControl()
      trials.push(await runTrial(src, c.params, false, backend))
      checkCancelled()
      completeTrial()
    }
    if (exactGrid !== null) {
      await yieldControl()
      const pixelGridTrial = await runPixelGridTrial(src, exactGrid, backend)
      checkCancelled()
      if (pixelGridTrial) trials.push(pixelGridTrial)
      completeTrial()
    }
    for (const scale of pixelScales) {
      await yieldControl()
      try {
        trials.push(await runTrial(src, presetById('pixel').params, false, backend, scale))
      } catch (error) {
        checkCancelled()
        failedTrials.push({ traceScale: scale, message: error instanceof Error ? error.message : String(error) })
      }
      checkCancelled()
      completeTrial()
    }
  } else if (auto.enabled && exactGrid !== null && (settings.presetId === 'pixel' || analysis.kind === 'pixel')) {
    // Compare the exact grid even when the first VTracer result already passes.
    // This avoids accepting visibly softened pixel art just because it is under
    // the generic threshold. The normal score still decides whether its larger
    // editable geometry is worth the fidelity gain.
    await yieldControl()
    const pixelGridTrial = await runPixelGridTrial(src, exactGrid, backend)
    checkCancelled()
    if (pixelGridTrial) trials.push(pixelGridTrial)
    completeTrial()
  }
  if (includePolygonReview) {
    await yieldControl()
    const polygonBase = trials
      .filter((trial) => trial.traceScale === 1 && trial.traceMethod !== 'pixel-grid' && trial.params.mode !== 'polygon')
      .sort((a, b) => a.score - b.score)[0]
    if (polygonBase) {
      try {
        trials.push(await runTrial(src, { ...polygonBase.params, mode: 'polygon' }, false, backend))
      } catch (error) {
        checkCancelled()
        failedTrials.push({ traceScale: 1, message: error instanceof Error ? error.message : String(error) })
      }
      checkCancelled()
    }
    completeTrial()
  }
  let chosen = choose(trials, auto.maxKB * 1024)
  if (includeFillCalibration) {
    await yieldControl()
    const calibrationStarted = now()
    const current = trials[chosen]
    if (current.traceMethod !== 'pixel-grid' && (current.traceScale ?? 1) === 1 && current.params.colormode === 'color') {
      try {
        const rendered = await backend.rasterize(current.svg, src.width, src.height)
        checkCancelled()
        const calibrated = calibrateSolidFills(current.svg, src, rendered)
        if (calibrated.changedFills) {
          const calibratedRender = await backend.rasterize(calibrated.svg, src.width, src.height)
          checkCancelled()
          const metrics = computeMetrics(src, calibratedRender, calibrated.svg)
          const calibratedScore = score(metrics)
          const improvesColor = metrics.rgbWhite + metrics.rgbDark < current.metrics.rgbWhite + current.metrics.rgbDark - 1e-9
          const preservesShape = metrics.iou === current.metrics.iou
            && metrics.alphaDiff === current.metrics.alphaDiff
            && metrics.paths === current.metrics.paths
          // Keep the Auto score meaningful: accept only when its combined visible/color/size
          // score, size, and silhouette do not worsen, and the average RGB error falls.
          if (
            improvesColor
            && preservesShape
            && metrics.bytes <= current.metrics.bytes
            && calibratedScore <= current.score
          ) {
            trials.push({
              ...current,
              base: false,
              traceMethod: 'fill-calibrated',
              svg: calibrated.svg,
              metrics,
              score: calibratedScore,
              ms: now() - calibrationStarted,
            })
            chosen = trials.length - 1
          }
        }
      } catch {
        checkCancelled()
        // Color calibration is an optional fidelity candidate; preserve the trace if it fails.
      }
    }
    completeTrial()
  }
  if (includePaletteSnap) {
    await yieldControl()
    const paletteStarted = now()
    const current = trials[chosen]
    if (current.traceMethod !== 'pixel-grid' && (current.traceScale ?? 1) === 1 && current.params.colormode === 'color') {
      try {
        const snapped = snapSolidFillsToSourcePalette(current.svg, src)
        if (snapped.changedFills) {
          const rendered = await backend.rasterize(snapped.svg, src.width, src.height)
          checkCancelled()
          const metrics = computeMetrics(src, rendered, snapped.svg)
          const scoreValue = score(metrics)
          const improvesColor = metrics.rgbWhite + metrics.rgbDark < current.metrics.rgbWhite + current.metrics.rgbDark - 1e-9
          const preservesShape = metrics.iou === current.metrics.iou
            && metrics.alphaDiff === current.metrics.alphaDiff
            && metrics.paths === current.metrics.paths
          // Palette snapping is more aggressive than per-fill calibration: retain it only
          // when both visible difference and average color error improve.
          if (
            improvesColor
            && metrics.pctDiff <= current.metrics.pctDiff
            && preservesShape
            && metrics.bytes <= current.metrics.bytes
            && scoreValue <= current.score
          ) {
            trials.push({
              ...current,
              base: false,
              traceMethod: 'palette-calibrated',
              svg: snapped.svg,
              metrics,
              score: scoreValue,
              ms: now() - paletteStarted,
            })
            chosen = trials.length - 1
          }
        }
      } catch {
        checkCancelled()
        // Palette snapping is an optional candidate; retain the current trace on failure.
      }
    }
    completeTrial()
  }
  if (includePathMerge) {
    await yieldControl()
    const mergeStarted = now()
    const current = trials[chosen]
    if (current.traceMethod !== 'pixel-grid' && (current.traceScale ?? 1) === 1 && current.params.colormode === 'color') {
      const merged = mergeAdjacentSameFillPaths(current.svg)
      if (merged.merged) {
        try {
          const rendered = await backend.rasterize(merged.svg, src.width, src.height)
          checkCancelled()
          const metrics = computeMetrics(src, rendered, merged.svg)
          const scoreValue = score(metrics)
          const preservesRendering = metrics.pctDiff <= current.metrics.pctDiff
            && (current.metrics.iou === null
              ? metrics.iou === null
              : metrics.iou !== null && metrics.iou >= current.metrics.iou - 1e-6)
            && metrics.alphaDiff <= current.metrics.alphaDiff + 0.001
            && metrics.rgbWhite <= current.metrics.rgbWhite + 1e-6
            && metrics.rgbDark <= current.metrics.rgbDark + 1e-6
          if (
            preservesRendering
            && metrics.paths < current.metrics.paths
            && metrics.bytes < current.metrics.bytes
            && scoreValue <= current.score
          ) {
            trials.push({
              ...current,
              base: false,
              traceMethod: 'paths-merged',
              svg: merged.svg,
              metrics,
              score: scoreValue,
              ms: now() - mergeStarted,
            })
            chosen = trials.length - 1
          }
        } catch {
          checkCancelled()
          // Keep the validated trace if this optional structural candidate fails.
        }
      }
    }
    completeTrial()
  }
  return { analysis, notes, trials, chosen, autoTuned: chosen !== 0, failedTrials }
}

/** True when the chosen result misses the threshold or the size budget. */
export const needsReviewResult = (r: VectorizeResult, auto: AutoTune) =>
  r.trials[r.chosen].metrics.pctDiff > auto.threshold || r.trials[r.chosen].metrics.bytes > auto.maxKB * 1024
