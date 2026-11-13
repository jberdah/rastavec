// Pure, environment-agnostic engine pieces: no DOM, no wasm. Reusable from a browser,
// a desktop shell or a Node CLI / MCP server driving an agent.
import type { Metrics, TraceParams, EngineShapeHint } from './types'

/** Minimal RGBA image, compatible with the browser's ImageData. */
export interface RGBAImage {
  data: Uint8ClampedArray
  width: number
  height: number
}

/** Output of `prepare`: an opaque image for the tracer, plus what is needed to restore transparency. */
export interface Prepared {
  image: RGBAImage
  /** Key color painted on transparent pixels (color mode); its paths are dropped. */
  keyHex: string | null
  /** Black-on-white silhouette (alpha >= silhouetteCut) used to clip the color result, or null if opaque. */
  mask: RGBAImage | null
  /** Semi-transparent layers for soft edges, outermost first, drawn under the clipped result. */
  soft: SoftLayer[]
  /** Opacity of the main artwork: < 1 only when the whole artwork is semi-transparent. */
  opacity: number
  /** Soft area traced in color (pixels floor <= alpha < cut), drawn at the area's mean alpha. */
  softColor: { image: RGBAImage; keyHex: string; opacity: number } | null
  /** Binary mode: mean color of dark (ink) pixels, and of light (paper) pixels when the image is opaque. */
  ink: string
  paper: string | null
}

export interface SoftLayer {
  /** Black-on-white mask of pixels with alpha >= lo (cumulative). */
  mask: RGBAImage
  fill: string
  /** Opacity to apply so that, stacked over the previous layers, the band reaches its mean alpha. */
  opacity: number
}

/** A tracing backend turns raster input into SVG markup. Native alpha tracing can use the source. */
export interface TraceBackend {
  name: string
  /** Native color backend can compare Stacked/Cutout without changing engines. */
  supportsHierarchyComparison?: boolean
  trace(prepared: Prepared, params: TraceParams): Promise<string>
  /** Optional color route for engines that handle source alpha directly. */
  traceColorSource?(source: RGBAImage, params: TraceParams): Promise<string>
  /** Optional one-off Auto candidate using the same engine's experimental gradient path. */
  /** Same trace with gradients fitted; `simple` asks for fewer, simpler gradient shapes. */
  traceColorSourceWithGradients?(source: RGBAImage, params: TraceParams, simple?: boolean): Promise<string>
  /** True when `traceColorSource` already fits gradients (the user forced them). */
  gradientsByDefault?: boolean
  /** Engine hints for an SVG this backend just returned from a color trace, if it has any. */
  shapeHintsFor?(svg: string): EngineShapeHint[] | undefined
  /** Render SVG markup at exactly width x height, unpremultiplied RGBA. */
  rasterize(svg: string, width: number, height: number): Promise<RGBAImage>
}

const DARK = 32 // #202020
const DIFF_THRESHOLD = 32

export function alphaStats(img: RGBAImage) {
  const d = img.data
  let semi = 0
  for (let i = 3; i < d.length; i += 4) if (d[i] >= 16 && d[i] < 240) semi++
  return { semiPct: (100 * semi) / (img.width * img.height) }
}

const toHex = (r: number, g: number, b: number) =>
  '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')

/**
 * Make the image opaque for the tracer. Pixels below the alpha floor are replaced by a
 * key color absent from the artwork (white in binary mode); the key paths are dropped
 * after tracing. Because the wasm build may promote the subject's color to a full-canvas
 * background, the color result is also clipped by a separately traced silhouette
 * (the "two-pass" technique validated on the Brainclaw avatars).
 */
export function prepare(img: RGBAImage, p: TraceParams): Prepared {
  const src = img.data
  const floor = Math.max(1, p.alphaFloor)
  const out = new Uint8ClampedArray(src.length)
  let transparent = 0
  const used = new Set<number>()
  for (let i = 0; i < src.length; i += 4) {
    if (src[i + 3] < floor) transparent++
    else used.add((src[i] << 16) | (src[i + 1] << 8) | src[i + 2])
  }
  let key: [number, number, number] | null = null
  if (transparent) {
    if (p.colormode === 'binary') key = [255, 255, 255]
    else {
      const candidates: [number, number, number][] = [[255, 0, 255], [0, 255, 255], [255, 255, 0], [1, 254, 3], [254, 1, 253]]
      key = candidates.find((c) => !used.has((c[0] << 16) | (c[1] << 8) | c[2])) ?? null
      for (let v = 0x123457; !key && v < 0xffffff; v += 7919) if (!used.has(v)) key = [(v >> 16) & 255, (v >> 8) & 255, v & 255]
    }
  }
  for (let i = 0; i < src.length; i += 4) {
    if (key && src[i + 3] < floor) {
      out[i] = key[0]; out[i + 1] = key[1]; out[i + 2] = key[2]
    } else {
      out[i] = src[i]; out[i + 1] = src[i + 1]; out[i + 2] = src[i + 2]
    }
    out[i + 3] = 255
  }
  let mask: RGBAImage | null = null
  let opacity = 1
  let cut = Math.max(floor, p.silhouetteCut)
  if (key && p.colormode === 'color') {
    // Default 128 = the 50 % coverage edge, same as the IoU metric. Soft edges or glows below
    // the cut are dropped instead of becoming an opaque halo. Fall back to the alpha floor
    // for artwork that is entirely semi-transparent.
    let any = false
    for (let i = 3; i < src.length && !any; i += 4) any = src[i] >= cut
    if (!any) {
      // Entirely semi-transparent artwork: trace it whole, then apply its mean alpha.
      cut = floor
      let n = 0, sum = 0
      for (let i = 3; i < src.length; i += 4) if (src[i] >= floor) { n++; sum += src[i] }
      opacity = n ? sum / n / 255 : 1
    }
    const m = new Uint8ClampedArray(src.length)
    for (let i = 0; i < src.length; i += 4) {
      const v = src[i + 3] >= cut ? 0 : 255
      m[i] = m[i + 1] = m[i + 2] = v
      m[i + 3] = 255
    }
    mask = { data: m, width: img.width, height: img.height }
  }
  return {
    image: { data: out, width: img.width, height: img.height },
    keyHex: key && p.colormode === 'color' ? toHex(...key) : null,
    mask,
    opacity,
    soft: mask && !p.softColor ? softLayers(img, floor, cut, p.softLayers) : [],
    softColor: mask && p.softColor && key ? softColorImage(img, floor, cut, key) : null,
    ...inkAndPaper(src, floor, !transparent),
  }
}

/** Opaque copy of the soft pixels only (others keyed), for a color trace of translucent areas. */
function softColorImage(img: RGBAImage, floor: number, cut: number, key: [number, number, number]) {
  const src = img.data
  const out = new Uint8ClampedArray(src.length)
  let n = 0, a = 0
  for (let i = 0; i < src.length; i += 4) {
    const al = src[i + 3]
    if (al >= floor && al < cut) {
      out[i] = src[i]; out[i + 1] = src[i + 1]; out[i + 2] = src[i + 2]
      n++; a += al
    } else {
      out[i] = key[0]; out[i + 1] = key[1]; out[i + 2] = key[2]
    }
    out[i + 3] = 255
  }
  if (n < img.width * img.height * 0.002) return null
  return { image: { data: out, width: img.width, height: img.height }, keyHex: toHex(...key), opacity: a / n / 255 }
}

/** Mean dark / light colors (luminance split at 128), for binary tracing. */
function inkAndPaper(src: Uint8ClampedArray, floor: number, opaque: boolean): { ink: string; paper: string | null } {
  const ink = [0, 0, 0, 0], paper = [0, 0, 0, 0]
  for (let i = 0; i < src.length; i += 4) {
    if (src[i + 3] < floor) continue
    const t = 0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2] < 128 ? ink : paper
    t[0] += src[i]; t[1] += src[i + 1]; t[2] += src[i + 2]; t[3]++
  }
  const mean = (t: number[], dflt: string) => (t[3] ? toHex(Math.round(t[0] / t[3]), Math.round(t[1] / t[3]), Math.round(t[2] / t[3])) : dflt)
  return { ink: mean(ink, '#000000'), paper: opaque ? mean(paper, '#ffffff') : null }
}

/**
 * Split the alpha range [floor, cut) into `count` bands. Each band becomes a cumulative
 * silhouette filled with the band's mean color; opacities are corrected so stacked layers
 * reach each band's mean alpha. Skipped when the soft area is negligible (< 0.2 % of pixels).
 */
function softLayers(img: RGBAImage, floor: number, cut: number, count: number): SoftLayer[] {
  if (count <= 0 || cut <= floor) return []
  const src = img.data
  const total = img.width * img.height
  const edges = Array.from({ length: count + 1 }, (_, k) => Math.round(floor + ((cut - floor) * k) / count))
  const stats = edges.slice(0, -1).map(() => ({ n: 0, r: 0, g: 0, b: 0, a: 0 }))
  let soft = 0
  for (let i = 0; i < src.length; i += 4) {
    const a = src[i + 3]
    if (a < floor || a >= cut) continue
    soft++
    let k = count - 1
    while (k > 0 && a < edges[k]) k--
    const s = stats[k]
    s.n++; s.r += src[i]; s.g += src[i + 1]; s.b += src[i + 2]; s.a += a
  }
  if (soft < total * 0.002) return []
  const layers: SoftLayer[] = []
  let below = 0 // alpha already accumulated by previous layers
  for (let k = 0; k < count; k++) {
    const s = stats[k]
    if (!s.n) continue
    const target = s.a / s.n / 255
    const opacity = below >= target ? 0 : 1 - (1 - target) / (1 - below)
    if (opacity <= 0.01) continue
    const lo = edges[k]
    const m = new Uint8ClampedArray(src.length)
    for (let i = 0; i < src.length; i += 4) {
      const v = src[i + 3] >= lo ? 0 : 255
      m[i] = m[i + 1] = m[i + 2] = v
      m[i + 3] = 255
    }
    layers.push({ mask: { data: m, width: img.width, height: img.height }, fill: toHex(Math.round(s.r / s.n), Math.round(s.g / s.n), Math.round(s.b / s.n)), opacity })
    below = target
  }
  return layers
}

/** True when `fill` is (close to) the key color: color quantization may shift it slightly. */
export function isKeyFill(fill: string, keyHex: string | null): boolean {
  if (!keyHex) return false
  const a = parseHex(fill), b = parseHex(keyHex)
  if (!a || !b) return false
  return Math.abs(a[0] - b[0]) <= 24 && Math.abs(a[1] - b[1]) <= 24 && Math.abs(a[2] - b[2]) <= 24
}

export function parseHex(c: string): [number, number, number] | null {
  c = c.trim().toLowerCase()
  let m = c.match(/^#([0-9a-f]{6})$/)
  if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)]
  m = c.match(/^#([0-9a-f]{3})$/)
  if (m) return [...m[1]].map((x) => parseInt(x + x, 16)) as [number, number, number]
  m = c.match(/^rgba?\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)/)
  if (m) return [+m[1], +m[2], +m[3]]
  return null
}

export function normalizeHex(c: string): string {
  const v = parseHex(c)
  return v ? toHex(...v) : c
}

// The same source is compared with many Auto trials. A weak key keeps this
// compact contour mask alive only while its source pixels are reachable.
const edgeMaskCache = new WeakMap<Uint8ClampedArray, { width: number; height: number; mask: Uint8Array; count: number }>()
function sourceEdgeMask(a: RGBAImage) {
  const cached = edgeMaskCache.get(a.data)
  if (cached && cached.width === a.width && cached.height === a.height) return cached
  const A = a.data
  const edge = new Uint8Array(Math.ceil(a.width * a.height / 8))
  const sourceDistance = (left: number, right: number) => {
    const al = A[left + 3] / 255, ar = A[right + 3] / 255
    let difference = Math.abs(A[left + 3] - A[right + 3])
    for (let c = 0; c < 3; c++) {
      difference = Math.max(difference,
        Math.abs(A[left + c] * al + 255 * (1 - al) - A[right + c] * ar - 255 * (1 - ar)),
        Math.abs(A[left + c] * al + DARK * (1 - al) - A[right + c] * ar - DARK * (1 - ar)))
    }
    return difference
  }
  for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) {
    const p = y * a.width + x, i = p * 4
    if (x + 1 < a.width && sourceDistance(i, i + 4) > DIFF_THRESHOLD) {
      edge[p >> 3] |= 1 << (p & 7)
      edge[(p + 1) >> 3] |= 1 << ((p + 1) & 7)
    }
    if (y + 1 < a.height && sourceDistance(i, i + a.width * 4) > DIFF_THRESHOLD) {
      edge[p >> 3] |= 1 << (p & 7)
      edge[(p + a.width) >> 3] |= 1 << ((p + a.width) & 7)
    }
  }
  let count = 0
  for (let p = 0; p < a.width * a.height; p++) if (edge[p >> 3] & (1 << (p & 7))) count++
  const result = { width: a.width, height: a.height, mask: edge, count }
  edgeMaskCache.set(a.data, result)
  return result
}

/** Same core metrics as the skill's compare.cjs, plus a source-contour diagnostic. */
// Banding: a color step in the render where the source is smooth. Both thresholds are in
// channel levels after compositing on white, between a pixel and its right / lower neighbour.
const SMOOTH_SOURCE_STEP = 6
const FALSE_EDGE_STEP = 12
const whiteStep = (data: Uint8ClampedArray, i: number, j: number) => {
  const ai = data[i + 3] / 255, aj = data[j + 3] / 255
  let step = 0
  for (let c = 0; c < 3; c++) {
    const d = Math.abs(data[i + c] * ai + 255 * (1 - ai) - data[j + c] * aj - 255 * (1 - aj))
    if (d > step) step = d
  }
  return step
}
const neighbourStep = (image: RGBAImage, x: number, y: number) => {
  const i = (y * image.width + x) * 4
  let step = 0
  if (x + 1 < image.width) step = whiteStep(image.data, i, i + 4)
  if (y + 1 < image.height) step = Math.max(step, whiteStep(image.data, i, i + image.width * 4))
  return step
}
const smoothMaskCache = new WeakMap<Uint8ClampedArray, { width: number; height: number; mask: Uint8Array }>()
function sourceSmoothMask(a: RGBAImage) {
  const cached = smoothMaskCache.get(a.data)
  if (cached && cached.width === a.width && cached.height === a.height) return cached.mask
  const mask = new Uint8Array(Math.ceil(a.width * a.height / 8))
  for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) {
    const p = y * a.width + x
    if (neighbourStep(a, x, y) <= SMOOTH_SOURCE_STEP) mask[p >> 3] |= 1 << (p & 7)
  }
  smoothMaskCache.set(a.data, { width: a.width, height: a.height, mask })
  return mask
}
/** % of pixels that are smooth in the source `a` and carry a visible step in the render `b`. */
export function falseEdgePct(a: RGBAImage, b: RGBAImage): number {
  const smooth = sourceSmoothMask(a)
  let falseEdges = 0
  for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) {
    const p = y * a.width + x
    if ((smooth[p >> 3] & (1 << (p & 7))) && neighbourStep(b, x, y) >= FALSE_EDGE_STEP) falseEdges++
  }
  return (100 * falseEdges) / Math.max(1, a.width * a.height)
}

// What a source draws: its pixels further than the visibility threshold from its most common
// colour, both seen on white. Kept with the source, which is measured against many renders.
const inkCache = new WeakMap<Uint8ClampedArray, { paper: [number, number, number]; count: number }>()
const onWhite = (data: Uint8ClampedArray, i: number, c: number) => (data[i + c] * data[i + 3] + 255 * (255 - data[i + 3])) / 255
const offPaper = (data: Uint8ClampedArray, i: number, paper: [number, number, number]) =>
  Math.abs(onWhite(data, i, 0) - paper[0]) > DIFF_THRESHOLD || Math.abs(onWhite(data, i, 1) - paper[1]) > DIFF_THRESHOLD || Math.abs(onWhite(data, i, 2) - paper[2]) > DIFF_THRESHOLD
function sourceInk(a: RGBAImage) {
  const cached = inkCache.get(a.data)
  if (cached) return cached
  const bins = new Map<number, number>()
  let best = 0, bestCount = 0
  for (let i = 0; i < a.data.length; i += 4) {
    const k = ((onWhite(a.data, i, 0) >> 4) << 8) | ((onWhite(a.data, i, 1) >> 4) << 4) | (onWhite(a.data, i, 2) >> 4)
    const n = (bins.get(k) ?? 0) + 1
    bins.set(k, n)
    if (n > bestCount) { best = k; bestCount = n }
  }
  const paper: [number, number, number] = [((best >> 8) & 15) * 16 + 8, ((best >> 4) & 15) * 16 + 8, (best & 15) * 16 + 8]
  let count = 0
  for (let i = 0; i < a.data.length; i += 4) if (offPaper(a.data, i, paper)) count++
  const ink = { paper, count }
  inkCache.set(a.data, ink)
  return ink
}

/** Least share of the drawn pixels kept by the best-keeping result that another must keep to be chosen. */
export const MIN_INK_KEPT = 0.5

export function computeMetrics(a: RGBAImage, b: RGBAImage, svg: string): Metrics {
  const ink = sourceInk(a)
  let drawn = 0
  const pixels = a.width * a.height
  const A = a.data, B = b.data
  const edge = sourceEdgeMask(a)
  let inter = 0, union = 0, alphaDiff = 0, light = 0, dark = 0, big = 0, edgeVisible = 0
  for (let i = 0; i < A.length; i += 4) {
    const aa = A[i + 3] / 255, ab = B[i + 3] / 255
    const oa = A[i + 3] >= 128, ob = B[i + 3] >= 128
    if (oa && ob) inter++
    if (oa || ob) union++
    alphaDiff += Math.abs(A[i + 3] - B[i + 3])
    let worst = 0
    for (let c = 0; c < 3; c++) {
      const dw = Math.abs(A[i + c] * aa + 255 * (1 - aa) - (B[i + c] * ab + 255 * (1 - ab)))
      const dd = Math.abs(A[i + c] * aa + DARK * (1 - aa) - (B[i + c] * ab + DARK * (1 - ab)))
      light += dw; dark += dd
      if (dw > worst) worst = dw
      if (dd > worst) worst = dd
    }
    if (ink.count && offPaper(B, i, ink.paper)) drawn++
    if (worst > DIFF_THRESHOLD) {
      big++
      const p = i / 4
      if (edge.mask[p >> 3] & (1 << (p & 7))) edgeVisible++
    }
  }
  return {
    width: a.width,
    height: a.height,
    iou: union ? inter / union : null,
    alphaDiff: alphaDiff / pixels,
    rgbWhite: light / (pixels * 3),
    rgbDark: dark / (pixels * 3),
    pctDiff: (100 * big) / pixels,
    edgePctDiff: edge.count ? (100 * edgeVisible) / edge.count : undefined,
    falseEdgePct: falseEdgePct(a, b),
    // Under 0.1 % of drawn pixels the ratio means nothing.
    ...(ink.count >= pixels * 0.001 ? { inkKept: drawn / ink.count } : {}),
    bytes: new TextEncoder().encode(svg).length,
    paths: (svg.match(/<path\b/g) || []).length,
    embeddedRaster: /<image\b/i.test(svg),
  }
}

/** diff map: faint grey ghost of the source, magenta (the alert colour) where they differ (noise < 16 hidden). */
const DIFF_COLOR = [255, 79, 139]
export function diffImage(a: RGBAImage, b: RGBAImage): RGBAImage {
  const A = a.data, B = b.data
  const out = new Uint8ClampedArray(A.length)
  for (let i = 0; i < A.length; i += 4) {
    const aa = A[i + 3] / 255, ab = B[i + 3] / 255
    let worst = 0, lum = 0
    for (let c = 0; c < 3; c++) {
      const sw = A[i + c] * aa + 255 * (1 - aa), vw = B[i + c] * ab + 255 * (1 - ab)
      const sd = A[i + c] * aa + DARK * (1 - aa), vd = B[i + c] * ab + DARK * (1 - ab)
      worst = Math.max(worst, Math.abs(sw - vw), Math.abs(sd - vd))
      lum += sw / 3
    }
    const ghost = 205 + lum * 0.18
    const t = Math.max(0, Math.min(1, (worst - 16) / 80))
    out[i] = ghost + (DIFF_COLOR[0] - ghost) * t
    out[i + 1] = ghost + (DIFF_COLOR[1] - ghost) * t
    out[i + 2] = ghost + (DIFF_COLOR[2] - ghost) * t
    out[i + 3] = 255
  }
  return { data: out, width: a.width, height: a.height }
}

export interface DiffHotspot {
  x: number
  y: number
  width: number
  height: number
  pctDiff: number
  meanError: number
  maxError: number
  visiblePixels: number
}

export interface DiffSummary {
  version: 1
  width: number
  height: number
  threshold: number
  gridSize: number
  /** Rows run top to bottom; columns run left to right. Values are visible-difference percentages. */
  gridPctDiff: number[][]
  hotspots: DiffHotspot[]
}

/** Compact, spatially useful diff data for tools that cannot conveniently inspect a PNG. */
export function summarizeDiff(a: RGBAImage, b: RGBAImage, gridSize = 8, threshold = DIFF_THRESHOLD): DiffSummary {
  if (a.width !== b.width || a.height !== b.height || a.data.length !== b.data.length)
    throw new Error('Diff images must have the same dimensions and pixel data length.')
  if (!Number.isSafeInteger(gridSize) || gridSize < 1 || gridSize > 32)
    throw new Error('Diff grid size must be an integer between 1 and 32.')
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 255)
    throw new Error('Diff threshold must be between 0 and 255.')

  const cells = Array.from({ length: gridSize * gridSize }, () => ({ pixels: 0, visible: 0, error: 0, max: 0 }))
  const A = a.data, B = b.data
  for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) {
    const i = (y * a.width + x) * 4
    const aa = A[i + 3] / 255, ab = B[i + 3] / 255
    let worst = 0
    for (let c = 0; c < 3; c++) {
      const sourceWhite = A[i + c] * aa + 255 * (1 - aa)
      const vectorWhite = B[i + c] * ab + 255 * (1 - ab)
      const sourceDark = A[i + c] * aa + DARK * (1 - aa)
      const vectorDark = B[i + c] * ab + DARK * (1 - ab)
      worst = Math.max(worst, Math.abs(sourceWhite - vectorWhite), Math.abs(sourceDark - vectorDark))
    }
    const column = Math.min(gridSize - 1, Math.floor(x * gridSize / a.width))
    const row = Math.min(gridSize - 1, Math.floor(y * gridSize / a.height))
    const cell = cells[row * gridSize + column]
    cell.pixels++
    cell.error += worst
    cell.max = Math.max(cell.max, worst)
    if (worst > threshold) cell.visible++
  }

  const round1 = (value: number) => Math.round(value * 10) / 10
  const gridPctDiff = Array.from({ length: gridSize }, (_, row) =>
    Array.from({ length: gridSize }, (_, column) => {
      const cell = cells[row * gridSize + column]
      return cell.pixels ? round1(100 * cell.visible / cell.pixels) : 0
    }),
  )
  const hotspots = cells.flatMap((cell, index) => {
    if (!cell.visible) return []
    const row = Math.floor(index / gridSize), column = index % gridSize
    const x = Math.floor(column * a.width / gridSize), y = Math.floor(row * a.height / gridSize)
    const right = Math.floor((column + 1) * a.width / gridSize), bottom = Math.floor((row + 1) * a.height / gridSize)
    return [{
      x, y, width: right - x, height: bottom - y,
      pctDiff: round1(100 * cell.visible / cell.pixels),
      meanError: round1(cell.error / cell.pixels),
      maxError: round1(cell.max),
      visiblePixels: cell.visible,
    }]
  }).sort((left, right) => right.visiblePixels - left.visiblePixels || right.meanError - left.meanError || left.y - right.y || left.x - right.x).slice(0, 8)

  return { version: 1, width: a.width, height: a.height, threshold, gridSize, gridPctDiff, hotspots }
}

// Ranking (lower is better). Weights were set on a measured study of real Auto-Tune trials
// (scripts/score-study.mjs, scripts/score-study-analyze.mjs):
//
//   f     = pctDiff + COLOR_WEIGHT * mean color difference
//   score = f + f² / FIDELITY_KNEE              a visible difference costs more as it grows
//         + FALSE_EDGE_WEIGHT * falseEdgePct     banding of smooth areas
//         + SIZE_WEIGHT * log2(bytes + SIZE_FLOOR_BYTES)   each doubling of a sizeable file costs the same
//         - EDITABLE_WEIGHT * editableShare      gradients and exact shapes are worth keeping
//
// Only differences between trials of one image matter, so the logarithm needs no reference.
export const COLOR_WEIGHT = 0.01
/** Visible difference (%) at which the quadratic part of the fidelity cost equals the linear one. */
export const FIDELITY_KNEE = 3
export const FALSE_EDGE_WEIGHT = 0.5
/** Score points per doubling of the SVG size. */
export const SIZE_WEIGHT = 1.5
/** Added to the size before the logarithm: a few bytes on a tiny SVG must not outweigh fidelity. */
export const SIZE_FLOOR_BYTES = 4096
export const EDITABLE_WEIGHT = 0.6
/** Only when the user sets a size budget: 4 score points per 100% relative overshoot. */
export const BUDGET_OVERSHOOT_WEIGHT = 4
/** Without a budget, the size above which Auto looks for lighter alternatives (it forbids nothing). */
export const HEAVY_SVG_BYTES = 400 * 1024
export const score = (m: Metrics) => {
  const fidelity = m.pctDiff + ((m.rgbWhite + m.rgbDark) / 2) * COLOR_WEIGHT
  return fidelity + (fidelity * fidelity) / FIDELITY_KNEE
    + FALSE_EDGE_WEIGHT * (m.falseEdgePct ?? 0)
    + SIZE_WEIGHT * Math.log2(Math.max(0, m.bytes) + SIZE_FLOOR_BYTES)
    - EDITABLE_WEIGHT * (m.editableShare ?? 0)
}

/** Deterministic auto-tune grid derived from the base parameters. */
export function candidates(base: TraceParams, opts: { transparent: boolean; includeHighSilhouetteCut?: boolean } = { transparent: false }): { label: string; params: TraceParams }[] {
  const raw: Partial<TraceParams>[] =
    base.colormode === 'binary'
      ? [{ speckle: Math.max(1, Math.round(base.speckle / 2)) }, { speckle: base.speckle + 4 }]
      : [
          { layerDifference: 8, colorPrecision: 8 },
          { layerDifference: 12, colorPrecision: 8 },
          { layerDifference: 4, colorPrecision: 8 },
          { layerDifference: 8, colorPrecision: 7 },
          { layerDifference: 8, colorPrecision: 8, speckle: Math.max(2, Math.round(base.speckle / 2)) },
          { layerDifference: 6, colorPrecision: 8, speckle: base.speckle + 4 },
          // Soft edges / glows: a tighter silhouette.
          ...(opts.transparent
            ? [
                { silhouetteCut: 160 },
                { silhouetteCut: 192 },
                ...(opts.includeHighSilhouetteCut ? [{ silhouetteCut: 224 }] : []),
                { softColor: !base.softColor },
              ]
            : []),
        ]
  const seen = new Set([JSON.stringify(base)])
  const out: { label: string; params: TraceParams }[] = []
  for (const r of raw) {
    const params = { ...base, ...r }
    const k = JSON.stringify(params)
    if (seen.has(k)) continue
    seen.add(k)
    out.push({ label: '', params })
  }
  return out
}

const SIMPLICITY_TOLERANCE = {
  /** Percentage points, measured by the existing visible-difference metric. */
  pctDiff: 0.05,
  /** Mean absolute channel levels, averaged over the white and dark backdrops. */
  meanRgb: 0.5,
  /** Mean absolute alpha-channel levels (0–255). */
  alphaDiff: 0.5,
  iou: 0.001,
  /** Percentage points of false edges (banding). */
  falseEdgePct: 0.05,
  /** Share of the image (0-1) recovered as gradients and exact shapes. */
  editableShare: 0.01,
}

function nearEqualFidelity(candidate: Metrics, reference: Metrics): boolean {
  const candidateMeanRgb = (candidate.rgbWhite + candidate.rgbDark) / 2
  const referenceMeanRgb = (reference.rgbWhite + reference.rgbDark) / 2
  const iouMatches = reference.iou === null
    ? candidate.iou === null
    : candidate.iou !== null && candidate.iou >= reference.iou - SIMPLICITY_TOLERANCE.iou

  return candidate.pctDiff <= reference.pctDiff + SIMPLICITY_TOLERANCE.pctDiff
    && candidateMeanRgb <= referenceMeanRgb + SIMPLICITY_TOLERANCE.meanRgb
    && candidate.alphaDiff <= reference.alphaDiff + SIMPLICITY_TOLERANCE.alphaDiff
    && iouMatches
    && (candidate.edgePctDiff === undefined || reference.edgePctDiff === undefined
      || candidate.edgePctDiff <= reference.edgePctDiff)
    && candidate.embeddedRaster === reference.embeddedRaster
    // "Simpler" must not mean banded, nor flattened back to plain outlines.
    && (candidate.falseEdgePct ?? 0) <= (reference.falseEdgePct ?? 0) + SIMPLICITY_TOLERANCE.falseEdgePct
    && (candidate.editableShare ?? 0) >= (reference.editableShare ?? 0) - SIMPLICITY_TOLERANCE.editableShare
}

function meaningfullySimpler(candidate: Metrics, reference: Metrics): boolean {
  if (candidate.paths > reference.paths || candidate.bytes > reference.bytes) return false
  const pathReduction = reference.paths - candidate.paths
  const byteReduction = reference.bytes - candidate.bytes
  const meaningfulPathReduction = pathReduction >= Math.max(2, Math.ceil(reference.paths * 0.1))
  const meaningfulByteReduction = byteReduction >= Math.max(256, Math.ceil(reference.bytes * 0.05))
  return meaningfulPathReduction || meaningfulByteReduction
}

/** A render that reproduces the source pixel for pixel, as far as the metrics can tell. */
const isExact = (m: Metrics) =>
  m.pctDiff === 0 && m.alphaDiff < 0.5 && (m.rgbWhite + m.rgbDark) / 2 < 0.5

/**
 * Pick the best trial by score. `maxBytes` is an optional size budget (0: none) that adds a soft
 * penalty above it. With `preferExactPixelGrid`, an exact pixel-grid trial rules out every trial
 * that does not reproduce the source just as exactly (zero error): on pixel art, a trace that only
 * looks exact (mean colour error under half a level, "circles" fitted on the staircase) is not a
 * fair trade for a few bytes or an editable-share bonus.
 */
export function choose(
  trials: { metrics: Metrics; score: number; traceMethod?: string; comparisonOnly?: boolean }[],
  maxBytes: number,
  options: { preferSimplicity?: boolean; preferExactPixelGrid?: boolean } = {},
): number {
  // Trials kept only for comparison never win while another trial exists.
  let idx = trials.map((_, i) => i)
  if (idx.some((i) => !trials[i].comparisonOnly)) idx = idx.filter((i) => !trials[i].comparisonOnly)
  // A result that lost most of what the source draws (an empty SVG at worst) can score as well
  // as a real one where every drawn pixel is an edge pixel, small text for instance: both are
  // "different" nearly everywhere. It never wins while another result kept twice as much of it.
  // Capped at the whole drawing: a result that draws too much (2.2 times the source for a
  // bloated trace) is not the measure of what a faithful one should keep.
  const kept = (i: number) => Math.min(1, trials[i].metrics.inkKept ?? 1)
  const most = Math.max(...idx.map(kept))
  idx = idx.filter((i) => kept(i) >= most * MIN_INK_KEPT)
  if (options.preferExactPixelGrid
    && trials.some((trial) => trial.traceMethod === 'pixel-grid' && isExact(trial.metrics)
      && (maxBytes <= 0 || trial.metrics.bytes <= maxBytes))) {
    idx = idx.filter((i) => {
      const m = trials[i].metrics
      return trials[i].traceMethod === 'pixel-grid' ? isExact(m) : m.pctDiff === 0 && m.alphaDiff === 0 && m.rgbWhite + m.rgbDark === 0
    })
  }
  const objective = (i: number) => trials[i].score + (maxBytes > 0
    ? BUDGET_OVERSHOOT_WEIGHT * Math.max(0, trials[i].metrics.bytes / maxBytes - 1)
    : 0)
  const best = idx.reduce((current, i) => (objective(i) < objective(current) ? i : current), idx[0])
  if (!options.preferSimplicity) return best

  // Keep the adjusted objective primary. Simplicity is a bounded tie-break:
  // the rendered result must remain near the score winner, while both paths and
  // bytes stay no worse and one improves by a meaningful amount.
  const alternatives = idx.filter((i) => i !== best
    && nearEqualFidelity(trials[i].metrics, trials[best].metrics)
    && meaningfullySimpler(trials[i].metrics, trials[best].metrics))
  return alternatives.reduce((current, i) => {
    const a = trials[i].metrics, b = trials[current].metrics
    return a.paths < b.paths
      || (a.paths === b.paths && a.bytes < b.bytes)
      || (a.paths === b.paths && a.bytes === b.bytes && trials[i].score < trials[current].score)
      ? i
      : current
  }, best)
}
