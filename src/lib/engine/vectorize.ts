// The shared vectorisation loop: analysis -> parameters -> trace -> render -> measure ->
// deterministic auto-tune -> choice. Pure (no DOM, no UI state): used by the web app and the CLI,
// each with its own TraceBackend.
import { analyze, recommend, type Analysis, type NoteCode } from './analyze'
import { candidates, choose, computeMetrics, HEAVY_SVG_BYTES, prepare, score, type RGBAImage, type TraceBackend } from './core'
import { editableShare } from './editable-share'
import { calibrateSolidFills, snapSolidFillsToSourcePalette } from './fill-calibration'
import { mergeAdjacentSameFillPaths } from './merge-adjacent-paths'
import type { AutoTune, TraceParams, Trial } from './types'
import { presetById } from './presets'
import { tracePixelGrid } from './pixel-grid'
import { needsHierarchyReview } from './hierarchy-review'
import { needsHardEdgeReview } from './hard-edge-review'

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

// Pixels under the alpha floor are invisible, but a native color trace would still turn each
// stray one (lossy alpha, a halo left by a cut-out) into a path of its own: hundreds of them on
// some logos. The same source is traced many times, so the cleaned copy is kept with it.
const flooredSources = new WeakMap<Uint8ClampedArray, Map<number, RGBAImage>>()
function withAlphaFloor(src: RGBAImage, floor: number): RGBAImage {
  if (floor <= 1) return src
  let known = flooredSources.get(src.data)
  if (!known) flooredSources.set(src.data, known = new Map())
  const cached = known.get(floor)
  if (cached) return cached
  let result = src
  const { data } = src
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] === 0 || data[i] >= floor) continue
    if (result === src) result = { width: src.width, height: src.height, data: new Uint8ClampedArray(data) }
    result.data[i - 3] = 0; result.data[i - 2] = 0; result.data[i - 1] = 0; result.data[i] = 0
  }
  known.set(floor, result)
  return result
}

export async function runTrial(src: RGBAImage, params: TraceParams, base: boolean, backend: TraceBackend, traceScale = 1, experimentalGradients: boolean | 'simple' = false): Promise<Trial> {
  params = { ...params, hierarchical: params.hierarchical ?? 'stacked' }
  const t0 = now()
  const input = traceScale === 1 ? src : enlarge(src, traceScale)
  const native = traceScale === 1 ? withAlphaFloor(src, params.alphaFloor) : enlarge(withAlphaFloor(src, params.alphaFloor), traceScale)
  let svg = await (experimentalGradients && backend.traceColorSourceWithGradients
    ? backend.traceColorSourceWithGradients(native, params, experimentalGradients === 'simple')
    : params.colormode === 'color' && backend.traceColorSource
      ? backend.traceColorSource(native, params)
    : backend.trace(prepare(input, params), params))
  const shapes = backend.shapeHintsFor?.(svg)
  // Keep the enlarged viewBox and paths, but display/export at the original dimensions.
  if (traceScale !== 1) svg = svg.replace(/^(<svg\b[^>]*?)\bwidth="\d+"\s+height="\d+"/, `$1width="${src.width}" height="${src.height}"`)
  const render = await backend.rasterize(svg, src.width, src.height)
  const metrics = { ...computeMetrics(src, render, svg), ...(shapes ? { editableShare: editableShare(svg, shapes) } : {}) }
  return { base, params: { ...params }, traceScale, ...(experimentalGradients ? { traceMethod: experimentalGradients === 'simple' ? 'simple-gradients' as const : 'experimental-gradients' as const } : {}), svg, ...(shapes ? { shapes } : {}), metrics, score: score(metrics), ms: now() - t0 }
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
  // The size budget is optional. Without one nothing is refused for its weight, but a heavy
  // first result is still worth comparing with lighter alternatives; the score then decides.
  const maxBytes = Math.max(0, auto.maxKB) * 1024
  const heavyBytes = maxBytes > 0 ? maxBytes : HEAVY_SVG_BYTES
  const nativeColor = base.colormode === 'color' && !!backend.traceColorSource
  const transparent = !nativeColor && src.data.some((v, k) => (k & 3) === 3 && v < 255)
  const grid = candidates(base, { transparent, includeHighSilhouetteCut: settings.presetId === 'auto' })
  const pixelScales = (settings.presetId === 'auto' || settings.presetId === 'pixel') && Math.max(src.width, src.height) <= 256 ? [2, 4] : []
  const exactGrid = auto.enabled && (settings.presetId === 'auto' || settings.presetId === 'pixel') ? tracePixelGrid(src) : null
  await yieldControl()
  const trials: Trial[] = [await runTrial(src, base, true, backend)]
  checkCancelled()
  const failedTrials: VectorizeResult['failedTrials'] = []
  const first = trials[0].metrics
  const needsTune = first.pctDiff > auto.threshold || first.bytes > heavyBytes
  // Pixel-difference can undercount faint, sparse artwork: its lines may sit below the
  // 32/255 visibility threshold while the alpha>=128 silhouette shows that most shapes
  // disappeared. Try one low-complexity soft-layer fallback before accepting that result.
  const needsSoftOutlineRecovery = !nativeColor && settings.presetId === 'auto'
    && analysis.alpha === 'soft'
    && first.iou !== null
    && first.iou < 0.5
  // High-quality vector sources rasterized to PNG often have a narrow antialias fringe.
  // For flat artwork in that category, a single 224 cut trial improves the render score
  // on the round-trip corpus without expanding the full tuning grid for already-passing images.
  const needsHighCutReview = !nativeColor && settings.presetId === 'auto'
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
  const includeHierarchyReview = auto.enabled && nativeColor
    && backend.supportsHierarchyComparison === true && needsHierarchyReview(src)
  const includeHardEdgeReview = auto.enabled && settings.presetId === 'auto' && nativeColor
    && backend.supportsHierarchyComparison === true && first.pctDiff > Math.max(3, auto.threshold)
    && needsHardEdgeReview(src)
  // Bounded same-engine trials for meaningfully shaded illustrations, on an opaque canvas or
  // cut out on a transparent one (hard or antialiased edges): gradients fitted closely, and
  // gradients simplified (fewer shapes, less fidelity). The score arbitrates. Photos, soft
  // alpha, flat artwork, and large rasters stay on the regular path. When the user forced
  // gradients the base trace already fits them closely; only the simplified one is added.
  const includeGradientReview = auto.enabled
    && settings.presetId === 'auto'
    && nativeColor
    && backend.traceColorSourceWithGradients !== undefined
    && analysis.kind === 'shaded'
    && analysis.alpha !== 'soft'
    && src.width * src.height <= 8_000_000
  const gradientModes: (true | 'simple')[] = !includeGradientReview ? [] : backend.gradientsByDefault ? ['simple'] : [true, 'simple']
  // Photos can produce editable but oversized region mosaics. Reserve two bounded
  // simplification slots; the traces run only if existing Auto trials all exceed
  // the user's size budget, covering moderate and stronger size reductions.
  const includePhotoBudgetReview = auto.enabled
    && settings.presetId === 'auto'
    && nativeColor
    && analysis.kind === 'photo'
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
  // On pixel art an exact grid is not traded for a lighter, slightly softened trace.
  const pick = (list: Trial[], preferSimplicity = auto.enabled) =>
    choose(list, maxBytes, { preferSimplicity, preferExactPixelGrid: comparePixelGrid })
  let total = 1 + tuningTrials + Number(includePolygonReview) + Number(includeHierarchyReview) + Number(includeHardEdgeReview) + gradientModes.length + (includePhotoBudgetReview ? 2 : 0) + Number(includeFillCalibration) + Number(includePaletteSnap) + Number(includePathMerge)
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
  if (includeHierarchyReview) {
    // One alternate of the best native trace, never a second full parameter grid.
    // Measure the actual SVG on both backgrounds using the usual score/size cap.
    const native = trials.filter((trial) => !trial.traceMethod && (trial.traceScale ?? 1) === 1)
    const current = native[pick(native, false)]
    const hierarchical = current.params.hierarchical === 'cutout' ? 'stacked' : 'cutout'
    await yieldControl()
    try {
      trials.push(await runTrial(src, { ...current.params, hierarchical }, false, backend))
    } catch (error) {
      checkCancelled()
      failedTrials.push({ traceScale: 1, message: error instanceof Error ? error.message : String(error) })
    }
    checkCancelled()
    completeTrial()
  }
  if (includeHardEdgeReview) {
    const current = trials[pick(trials, false)]
    // Existing exact-grid/upscaled candidates often already recover small sprites.
    if (current.metrics.pctDiff > Math.max(3, auto.threshold)) {
      await yieldControl()
      try {
        // Nonzero speckle rejects thread-like color regions even at speckle=1;
        // spline/polygon fitting then rounds away one-pixel detail. Preserve both
        // segmentation and pixel boundaries in this one measured alternative.
        trials.push(await runTrial(src, { ...base, mode: 'none', speckle: 0, colorPrecision: 8,
          layerDifference: 0, hierarchical: 'cutout' }, false, backend))
      } catch (error) {
        checkCancelled()
        failedTrials.push({ traceScale: 1, message: error instanceof Error ? error.message : String(error) })
      }
      checkCancelled()
    }
    completeTrial()
  }
  if (includeGradientReview) {
    const native = trials.filter((trial) => !trial.traceMethod && (trial.traceScale ?? 1) === 1)
    const current = native[pick(native)]
    for (const mode of gradientModes) {
      await yieldControl()
      try {
        // Isolate the gradient fitter: reuse the best native parameters so this
        // comparison measures paint fitting instead of changing segmentation and geometry too.
        trials.push(await runTrial(src, current.params, false, backend, 1, mode))
      } catch (error) {
        checkCancelled()
        failedTrials.push({ traceScale: 1, message: error instanceof Error ? error.message : String(error) })
      }
      checkCancelled()
      completeTrial()
    }
  }
  let chosen = pick(trials)
  const bestColorTransformInput = () => {
    const eligible = trials.filter((trial) => trial.traceMethod !== 'pixel-grid'
      && trial.traceMethod !== 'experimental-gradients'
      && trial.traceMethod !== 'simple-gradients'
      && (trial.traceScale ?? 1) === 1
      && trial.params.colormode === 'color')
    return eligible.length
      ? eligible[pick(eligible)]
      : undefined
  }
  if (includeFillCalibration) {
    await yieldControl()
    const calibrationStarted = now()
    const current = bestColorTransformInput()
    if (current) {
      try {
        const rendered = await backend.rasterize(current.svg, src.width, src.height)
        checkCancelled()
        const calibrated = calibrateSolidFills(current.svg, src, rendered)
        if (calibrated.changedFills) {
          const calibratedRender = await backend.rasterize(calibrated.svg, src.width, src.height)
          checkCancelled()
          const metrics = { ...computeMetrics(src, calibratedRender, calibrated.svg), editableShare: current.metrics.editableShare }
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
            chosen = pick(trials)
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
    const current = bestColorTransformInput()
    if (current) {
      try {
        const snapped = snapSolidFillsToSourcePalette(current.svg, src)
        if (snapped.changedFills) {
          const rendered = await backend.rasterize(snapped.svg, src.width, src.height)
          checkCancelled()
          const metrics = { ...computeMetrics(src, rendered, snapped.svg), editableShare: current.metrics.editableShare }
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
            chosen = pick(trials)
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
    const current = bestColorTransformInput()
    if (current) {
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
              // Merging renumbers the paths, so the engine hints no longer apply.
              shapes: undefined,
              svg: merged.svg,
              metrics,
              score: scoreValue,
              ms: now() - mergeStarted,
            })
            chosen = pick(trials)
          }
        } catch {
          checkCancelled()
          // Keep the validated trace if this optional structural candidate fails.
        }
      }
    }
    completeTrial()
  }
  if (includePhotoBudgetReview) {
    let photoTrialsExecuted = 0
    if (trials.every((trial) => trial.metrics.bytes > heavyBytes)) {
      const native = trials.filter((trial) => !trial.traceMethod && (trial.traceScale ?? 1) === 1)
      const best = native[pick(native, false)]
      if (best) {
        const p = best.params
        // Both levels start from the measured winner. The second increases color
        // aggregation by a fraction of that winner's current layer spacing.
        const levels = [0, Math.max(4, Math.ceil(p.layerDifference * 2 / 3))]
        for (const extraLayerDifference of levels) {
          const simplified = {
            ...p,
            mode: 'polygon' as const,
            colorPrecision: Math.max(3, p.colorPrecision - 1),
            layerDifference: Math.min(48, p.layerDifference + extraLayerDifference),
            watershedDetail: Math.max(8, Math.round(p.watershedDetail * 0.75)),
            speckle: Math.min(64, p.speckle + Math.max(2, Math.ceil(p.speckle / 2))),
            pathPrecision: Math.max(0, p.pathPrecision - 1),
          }
          await yieldControl()
          try {
            trials.push(await runTrial(src, simplified, false, backend))
          } catch (error) {
            checkCancelled()
            failedTrials.push({ traceScale: 1, message: error instanceof Error ? error.message : String(error) })
          }
          checkCancelled()
          completeTrial()
          photoTrialsExecuted++
        }
        chosen = pick(trials)
      }
    }
    const skippedPhotoTrials = 2 - photoTrialsExecuted
    if (skippedPhotoTrials > 0) {
      total -= skippedPhotoTrials
      reportProgress()
    }
  }
  return { analysis, notes, trials, chosen, autoTuned: chosen !== 0, failedTrials }
}

/** True when a size budget is set and `bytes` exceeds it. */
export const overBudget = (bytes: number, auto: AutoTune) => auto.maxKB > 0 && bytes > auto.maxKB * 1024

/** True when the chosen result misses the threshold or the size budget, if there is one. */
export const needsReviewResult = (r: VectorizeResult, auto: AutoTune) =>
  r.trials[r.chosen].metrics.pctDiff > auto.threshold || overBudget(r.trials[r.chosen].metrics.bytes, auto)
