// Pure, environment-agnostic engine pieces: no DOM, no wasm. Reusable from a browser,
// a desktop shell or a Node CLI / MCP server driving an agent.
import type { Metrics, TraceParams } from './types'

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

/** A tracing backend turns a prepared opaque RGBA image into SVG markup. */
export interface TraceBackend {
  name: string
  trace(prepared: Prepared, params: TraceParams): Promise<string>
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

/** Same metrics as the skill's compare.cjs, so numbers stay comparable. */
export function computeMetrics(a: RGBAImage, b: RGBAImage, svg: string): Metrics {
  const pixels = a.width * a.height
  const A = a.data, B = b.data
  let inter = 0, union = 0, alphaDiff = 0, light = 0, dark = 0, big = 0
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
    if (worst > DIFF_THRESHOLD) big++
  }
  return {
    width: a.width,
    height: a.height,
    iou: union ? inter / union : null,
    alphaDiff: alphaDiff / pixels,
    rgbWhite: light / (pixels * 3),
    rgbDark: dark / (pixels * 3),
    pctDiff: (100 * big) / pixels,
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

/** Ranking: visible outliers, average color error, and a light size penalty (per KiB). */
export const SIZE_WEIGHT = 0.002
export const COLOR_WEIGHT = 0.01
export const score = (m: Metrics) =>
  m.pctDiff + ((m.rgbWhite + m.rgbDark) / 2) * COLOR_WEIGHT + (m.bytes / 1024) * SIZE_WEIGHT

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

/** Pick the best trial: within the size budget if possible, then lowest score. */
export function choose(trials: { metrics: Metrics; score: number }[], maxBytes: number): number {
  const idx = trials.map((_, i) => i)
  const within = idx.filter((i) => trials[i].metrics.bytes <= maxBytes)
  const pool = within.length ? within : idx
  return pool.reduce((best, i) => (trials[i].score < trials[best].score ? i : best), pool[0])
}
