// The shared vectorisation loop: analysis -> parameters -> trace -> render -> measure ->
// deterministic auto-tune -> choice. Pure (no DOM, no UI state): used by the web app and the CLI,
// each with its own TraceBackend.
import { analyze, cleanSource, photographic, recommend, type Analysis, type NoteCode } from './analyze'
import { marginal, measureDegradation, restorable, restoreArtwork, type Degradation } from './degradation'
import { crop } from './slice'
import { candidates, choose, computeMetrics, HEAVY_SVG_BYTES, MIN_INK_KEPT, prepare, score, type RGBAImage, type TraceBackend } from './core'
import { editableShare } from './editable-share'
import { calibrateSolidFills, snapSolidFillsToSourcePalette } from './fill-calibration'
import { mergeAdjacentSameFillPaths } from './merge-adjacent-paths'
import type { AutoTune, TraceParams, Trial } from './types'
import { presetById } from './presets'
import { tracePixelGrid } from './pixel-grid'
import { needsHierarchyReview } from './hierarchy-review'
import { needsHardEdgeReview } from './hard-edge-review'
import { analyzeAntialiasing, resolveAntialiasing } from './antialias-resolve'
import { pixelBlockSize } from './analyze'
import { shrink } from './shrink'

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

/** Share of smooth ramps (Analysis.smoothRamps) from which flat-looking art gets gradient trials. */
export const GENTLE_GRADIENT_RAMPS = 0.1

/** Above this many pixels, gradient trials run only when a reduced probe shows they help. */
export const GRADIENT_PROBE_PIXELS = 1_000_000
const PROBE_MAX_PIXELS = 256 * 1024

const HAS_GRADIENT = /<(?:linear|radial)Gradient[\s/>]/

/** Score points by which the gradient trace must beat the winner on the reduced copy. Measured
 *  against the full trials, the probe's predicted gain is off by 0.1-0.2 points either way: a
 *  detailed logo (gradients lose by 0.13 at full size, the probe sees a 0.07 gain) and clean
 *  single gradients on large canvases (they win by 0.25-0.6, the probe sees 0.17-0.48). A wrong
 *  "yes" only costs time, a wrong "no" loses a gradient, so the margin stays small. */
const GRADIENT_PROBE_MARGIN = 0.1

/** True when, on the reduced copy, the simple-gradient trace actually contains a gradient and
 *  beats the current winner's own configuration on Auto's score by GRADIENT_PROBE_MARGIN: the
 *  comparison the full trials would face. Traces of a reduced copy are lighter, and the size floor
 *  of the score would flatten their difference, so both are first scaled to the winner's weight. */
async function gradientsWin(src: RGBAImage, winner: Trial, params: TraceParams, backend: TraceBackend, yieldControl: () => Promise<void>): Promise<boolean> {
  const plain = await runTrial(src, winner.params, false, backend)
  await yieldControl()
  const fitted = await runTrial(src, params, false, backend, 1, 'simple')
  if (!HAS_GRADIENT.test(fitted.svg)) return false
  const weight = winner.metrics.bytes / Math.max(1, plain.metrics.bytes)
  const atFullSize = (trial: Trial) => score({ ...trial.metrics, bytes: trial.metrics.bytes * weight })
  return atFullSize(fitted) < atFullSize(plain) - GRADIENT_PROBE_MARGIN
}

/** Side of the sample cleaned first when the evidence of artifacts is thin, and the image size from which it is worth it. */
const SAMPLE_SIDE = 512, SAMPLE_MIN_PIXELS = 600_000
/** Share of its paths the trace of the sample must lose once cleaned for the whole image to be cleaned:
 *  a clean logo with ringing of its own loses a quarter (24 to 18), a JPEG of quality 95 three quarters (66 to 16). */
const SAMPLE_GAIN = 0.4

/**
 * False when the evidence of artifacts is thin (see `marginal`) and cleaning the busiest
 * SAMPLE_SIDE square of the image does not simplify its trace: a clean logo with a little
 * ringing of its own, which the clean-up would only cost seconds on (about three per megapixel)
 * for the same result. Small images are cleaned without asking: that is as cheap as the sample.
 */
async function cleaningHelps(src: RGBAImage, degradation: Degradation, backend: TraceBackend, pause: () => Promise<void>): Promise<boolean> {
  if (!marginal(degradation) || src.width * src.height < SAMPLE_MIN_PIXELS) return true
  const { data: d, width: w, height: h } = src
  const side = Math.min(SAMPLE_SIDE, w, h)
  // The square with the most edges, among those half a side apart.
  let best = { x: 0, y: 0, w: side, h: side }, most = -1
  for (let y = 0; ; y += side >> 1) {
    const top = Math.min(y, h - side)
    for (let x = 0; ; x += side >> 1) {
      const left = Math.min(x, w - side)
      let edges = 0
      for (let Y = top; Y < top + side; Y += 4) for (let i = (Y * w + left) * 4, e = i + (side - 2) * 4; i < e; i += 16) {
        if (Math.abs(d[i] - d[i + 8]) >= 64 || Math.abs(d[i + 1] - d[i + 9]) >= 64 || Math.abs(d[i + 2] - d[i + 10]) >= 64) edges++
      }
      if (edges > most) { most = edges; best = { x: left, y: top, w: side, h: side } }
      if (left === w - side) break
    }
    if (top === h - side) break
  }
  const sample = crop(src, best)
  const cleaned = await restoreArtwork(sample, degradation, pause)
  const params = recommend(analyze(sample)).params
  const before = await runTrial(sample, params, false, backend)
  await pause()
  const after = await runTrial(cleaned, params, false, backend)
  return after.metrics.paths <= before.metrics.paths * (1 - SAMPLE_GAIN)
}

// A cleaned copy (see `cleanSource`) is traced in place of the image it came from, which stays
// the reference every result is measured against.
const references = new WeakMap<Uint8ClampedArray, RGBAImage>()
const referenceOf = (src: RGBAImage) => references.get(src.data) ?? src

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
  const metrics = { ...computeMetrics(referenceOf(src), render, svg), ...(shapes ? { editableShare: editableShare(svg, shapes) } : {}) }
  return { base, params: { ...params }, traceScale, ...(experimentalGradients ? { traceMethod: experimentalGradients === 'simple' ? 'simple-gradients' as const : 'experimental-gradients' as const } : {}), svg, ...(shapes ? { shapes } : {}), metrics, score: score(metrics), ms: now() - t0 }
}

async function runPixelGridTrial(src: RGBAImage, svg: string, backend: TraceBackend): Promise<Trial | null> {
  const t0 = now()
  try {
    const rendered = await backend.rasterize(svg, src.width, src.height)
    const metrics = computeMetrics(referenceOf(src), rendered, svg)
    return { base: false, params: { ...presetById('pixel').params }, traceScale: 1, traceMethod: 'pixel-grid', svg, metrics, score: score(metrics), ms: now() - t0 }
  } catch {
    // An optional exact-grid candidate must not discard valid VTracer trials.
    return null
  }
}

// Enlargement used to resolve anti-aliasing into sub-pixel edges. VTracer moves polygon
// vertices by about one traced pixel: at 8x that is 1/8 of a source pixel (at 4x, ~2 % of a
// small icon stayed visibly off). The traced side is capped, which costs time and memory:
// 8x up to 192 px, then less (6x at 256 px, the largest enlarged trace).
const antialiasScale = (long: number) => Math.max(4, Math.min(8, Math.floor(1536 / long)))
/** Share of visible pixels that must be anti-aliasing mixes before that trace is worth a try. */
const MIN_ANTIALIAS_SHARE = 0.01
/**
 * Many colours (analyze's photo cut-off): photos and noise. Enlarged traces of such images keep
 * fine shade steps (merging them turned 256 px noise 1.5 % visibly different instead of 0.2 %),
 * while detailed icons, 100-250 colours, lose nothing visible and stay 1.3-1.7x lighter.
 */
const MANY_COLOURS = 400

// Native color trace of the source with each anti-aliasing mix split into its two flat colours
// at sub-pixel precision (see antialias-resolve.ts). Displayed at the original size like the
// other enlarged traces.
async function runAntialiasResolvedTrial(resolved: RGBAImage, scale: number, src: RGBAImage, params: TraceParams, backend: TraceBackend): Promise<Trial> {
  params = { ...params, hierarchical: params.hierarchical ?? 'stacked' }
  const t0 = now()
  let svg = await backend.traceColorSource!(resolved, params)
  const shapes = backend.shapeHintsFor?.(svg)
  svg = svg.replace(/^(<svg\b[^>]*?)\bwidth="\d+"\s+height="\d+"/, `$1width="${src.width}" height="${src.height}"`)
  const render = await backend.rasterize(svg, src.width, src.height)
  const metrics = { ...computeMetrics(referenceOf(src), render, svg), ...(shapes ? { editableShare: editableShare(svg, shapes) } : {}) }
  return { base: false, params: { ...params }, traceScale: scale, traceMethod: 'antialias-resolved', svg, ...(shapes ? { shapes } : {}), metrics, score: score(metrics), ms: now() - t0 }
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
  let analysis = opts.analysis ?? analyze(src)
  // Artwork under JPEG artifacts or noise: Auto traces a cleaned copy, so that ripples do not
  // become paths, and still measures every trial against the image as given: the reported
  // difference is the honest one, and strokes the clean-up kept count for the trial that keeps them.
  let uncleaned = false
  if (settings.presetId === 'auto') {
    // Analyses saved before detection existed have no `degradation` field.
    const degradation = analysis.degradation === undefined ? measureDegradation(src) : analysis.degradation
    // Photographs are traced as they are, and so are images too large to clean in a few seconds.
    if (degradation && !photographic(analysis)) {
      // The clean-up pauses every 100 000 pixels; yielding (a timer in a worker) that often would
      // cost more than the work.
      let paused = now()
      const pause = async () => {
        if (now() - paused < 100) return
        await yieldControl()
        paused = now()
      }
      if (!restorable(src, degradation)) uncleaned = true
      else if (await cleaningHelps(src, degradation, backend, pause)) {
        const cleaned = await cleanSource(src, degradation, pause)
        if (cleaned) {
          references.set(cleaned.image.data, src)
          src = cleaned.image
          analysis = cleaned.analysis
        }
      }
    }
  }
  const reference = referenceOf(src)
  let base = { ...settings.params }
  let notes: NoteCode[] | undefined
  if (settings.presetId === 'auto') {
    const rec = recommend(analysis)
    base = rec.params
    notes = uncleaned ? [...rec.notes, 'uncleaned'] : rec.notes
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
  // Enlarged traces copy every source pixel. Pixel art keeps each shade apart; on other artwork
  // with a moderate palette that turns every anti-aliasing ramp into one thin layer per shade
  // (8548 paths, 532 KB for a 121 x 120 icon). Merging shades 16 apart, as the flat preset does,
  // keeps the edges. Images with many colours (noise, photos) keep fine steps.
  const fewColours = analysis.dominantColors <= MANY_COLOURS
  const pixelArt = settings.presetId === 'pixel' || analysis.kind === 'pixel'
  // On pixel art the enlarged staircase must stay a staircase: shape detection fitted "circles"
  // on pixel clusters (3 on a 32 px wizard) and its editable-share bonus outscored the exact grid.
  const scaledParams = pixelArt
    ? { ...presetById('pixel').params, detectShapes: false }
    : !fewColours ? presetById('pixel').params : { ...presetById('pixel').params, layerDifference: 16 }
  // Only known pixel art may use many near shades in the exact grid: on an anti-aliased icon a
  // grid of hundreds of colours would beat a smooth trace on the score while being no vector.
  const exactGrid = auto.enabled && (settings.presetId === 'auto' || settings.presetId === 'pixel')
    ? tracePixelGrid(src, pixelArt ? { maxColors: 1024, blockSize: pixelBlockSize(src) } : {})
    : null
  await yieldControl()
  const trials: Trial[] = [await runTrial(src, base, true, backend)]
  checkCancelled()
  const failedTrials: VectorizeResult['failedTrials'] = []
  const first = trials[0].metrics
  const needsTune = first.pctDiff > auto.threshold || first.bytes > heavyBytes
  // Small anti-aliased artwork the regular trace misses: one trace with the anti-aliasing
  // resolved into flat colours at sub-pixel precision. Its few flat shapes compete with the
  // enlarged copies of every pixel; the score decides.
  // The mixes are found first, without enlarging anything; the enlarged copy is only built for
  // the trial itself.
  const antialiasSource = auto.enabled && needsTune && settings.presetId === 'auto' && nativeColor
    // Photos and noise read as mixes nearly everywhere: resolving them only costs time.
    && analysis.kind !== 'pixel' && analysis.kind !== 'photo' && fewColours && pixelScales.length > 0
    ? withAlphaFloor(src, base.alphaFloor)
    : null
  const antialiasMixes = antialiasSource ? analyzeAntialiasing(antialiasSource) : null
  const includeAntialiasReview = antialiasMixes !== null
    && antialiasMixes.blended >= antialiasMixes.visible * MIN_ANTIALIAS_SHARE
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
  // alpha, flat artwork without smooth ramps, and very large rasters stay on the regular path. When the user forced
  // gradients the base trace already fits them closely; only the simplified one is added.
  const includeGradientReview = auto.enabled
    && settings.presetId === 'auto'
    && nativeColor
    && backend.traceColorSourceWithGradients !== undefined
    // A few colours and no per-pixel steps read as flat, yet a gentle linear or radial
    // gradient looks exactly like that: smooth ramps over a tenth of the opaque area tell it
    // apart from flat fills (near 0). The score still decides whether gradients win.
    && (analysis.kind === 'shaded' || (analysis.kind === 'flat' && (analysis.smoothRamps ?? 0) >= GENTLE_GRADIENT_RAMPS))
    && analysis.alpha !== 'soft'
    // Above 1 MP the reduced probe decides first, so 4K-5K sources can afford the full trials
    // when they pay (a 4K landscape: one flat sky at 37 % pctDiff without them, 1 % with).
    && src.width * src.height <= 16_000_000
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
      ? grid.length + pixelScales.length + (exactGrid !== null ? 1 : 0) + Number(includeAntialiasReview)
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
  // Black and white cuts at mid-grey: thin, light or anti-aliased strokes (small grey text) fall
  // on the white side and the trace comes out nearly empty. One colour trace, as for flat
  // artwork, then competes; a result that lost the drawing is never chosen over one that kept it.
  const includeColourRecovery = auto.enabled && settings.presetId === 'auto'
    && base.colormode === 'binary' && (first.inkKept ?? 1) < MIN_INK_KEPT
  let total = 1 + Number(includeColourRecovery) + tuningTrials + Number(includePolygonReview) + Number(includeHierarchyReview) + Number(includeHardEdgeReview) + gradientModes.length + (includePhotoBudgetReview ? 2 : 0) + Number(includeFillCalibration) + Number(includePaletteSnap) + Number(includePathMerge)
  let completed = 1
  const reportProgress = () => opts.onProgress?.(completed, total)
  const completeTrial = () => { completed++; reportProgress() }
  reportProgress()
  if (includeColourRecovery) {
    await yieldControl()
    try {
      trials.push(await runTrial(src, recommend({ ...analysis, kind: 'flat' }).params, false, backend))
    } catch (error) {
      checkCancelled()
      failedTrials.push({ traceScale: 1, message: error instanceof Error ? error.message : String(error) })
    }
    checkCancelled()
    completeTrial()
  }
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
        trials.push(await runTrial(src, scaledParams, false, backend, scale))
      } catch (error) {
        checkCancelled()
        failedTrials.push({ traceScale: scale, message: error instanceof Error ? error.message : String(error) })
      }
      checkCancelled()
      completeTrial()
    }
    if (includeAntialiasReview && antialiasSource && antialiasMixes) {
      const scale = antialiasScale(Math.max(src.width, src.height))
      await yieldControl()
      try {
        const resolved = resolveAntialiasing(antialiasSource, scale, antialiasMixes)
        await yieldControl()
        // Only flat colours are left to trace, one source pixel is scale² traced pixels: drop
        // specks under one source pixel, and keep the sub-pixel boundary as polygons; curves
        // fitted along it made the SVG 2-4x larger for the same edges.
        trials.push(await runAntialiasResolvedTrial(resolved, scale, src,
          { ...base, mode: 'polygon', speckle: scale, colorPrecision: 8, layerDifference: 16 }, backend))
      } catch (error) {
        if (error instanceof VectorizationCancelled) throw error
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
        const polygon = await runTrial(src, { ...polygonBase.params, mode: 'polygon' }, false, backend)
        // Curves stay smoother when scaled and edited, and polygons are usually lighter, so
        // the size term alone would pick polygons for curved logos (a crescent moon came out
        // as 147 straight segments). Polygons keep their point, sharp corners, only when they
        // are clearly more faithful; otherwise they are listed for comparison only. Only for flat
        // artwork: on shaded images the polygon trace is often both lighter and, once gradients
        // are fitted over it, more faithful.
        if (analysis.kind === 'flat' && !(polygon.metrics.pctDiff < polygonBase.metrics.pctDiff * 0.9)) polygon.comparisonOnly = true
        trials.push(polygon)
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
    // Isolate the gradient fitter: reuse the best native parameters so this
    // comparison measures paint fitting instead of changing segmentation and geometry too.
    // The engine fits gradients over stacked layers only: when the hierarchy review
    // picked a cutout mosaic, it rejected every gradient trial as unsupported.
    const params = { ...current.params, hierarchical: 'stacked' as const }
    // On a large raster each full-size gradient fit costs seconds. Probe a reduced copy first
    // (shrunk by a power of two to at most PROBE_MAX_PIXELS): the full trials run only when the
    // gradient trace wins there.
    let worthIt = true
    if (src.width * src.height > GRADIENT_PROBE_PIXELS) {
      await yieldControl()
      try {
        let factor = 2
        while (src.width * src.height > PROBE_MAX_PIXELS * factor * factor) factor *= 2
        worthIt = await gradientsWin(shrink(src, factor), current, params, backend, yieldControl)
      } catch (error) {
        if (error instanceof VectorizationCancelled) throw error
        // An inconclusive probe keeps the full comparison.
      }
      checkCancelled()
    }
    // A "gradient" trace in which the engine fitted no gradient is the plain stacked trace again:
    // it is not listed under a gradient label. 'failed' when the engine refused the trial.
    const gradientTrial = async (mode: true | 'simple'): Promise<Trial | null | 'failed'> => {
      await yieldControl()
      try {
        const trial = await runTrial(src, params, false, backend, 1, mode)
        checkCancelled()
        return HAS_GRADIENT.test(trial.svg) ? trial : null
      } catch (error) {
        checkCancelled()
        failedTrials.push({ traceScale: 1, message: error instanceof Error ? error.message : String(error) })
        return 'failed'
      }
    }
    if (worthIt) {
      // The simplified fit runs first: when even its looser tolerance finds no gradient, the
      // close fit finds none either and is skipped. Trials keep their usual order (close fit
      // first), so ties resolve as before.
      const simple = gradientModes.includes('simple') ? await gradientTrial('simple') : null
      completeTrial()
      const exact = gradientModes.includes(true) && simple !== null ? await gradientTrial(true) : null
      if (gradientModes.includes(true)) completeTrial()
      for (const trial of [exact, simple]) if (trial && trial !== 'failed') trials.push(trial)
    } else {
      for (let k = 0; k < gradientModes.length; k++) completeTrial()
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
          const metrics = { ...computeMetrics(reference, calibratedRender, calibrated.svg), editableShare: current.metrics.editableShare }
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
          const metrics = { ...computeMetrics(reference, rendered, snapped.svg), editableShare: current.metrics.editableShare }
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
          const metrics = computeMetrics(reference, rendered, merged.svg)
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
