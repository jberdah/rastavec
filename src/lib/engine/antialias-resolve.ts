// Anti-aliasing resolution for small artwork. Pure TS, no DOM.
//
// A small icon rasterized with anti-aliasing stores its sub-pixel edge position in the colour of
// its edge pixels: a pixel 30 % of the way from a brown face to a dark outline is a 30/70 mix of
// both. Traced directly, such a raster leaves VTracer two bad choices: absorb those pixels (edges
// move by up to a pixel, which on a 150 px icon changes 5-10 % of the pixels visibly), or keep
// every mix as its own colour layer (a thin path per ramp: 20 shapes become 1000+ paths).
//
// `resolveAntialiasing` enlarges the image by an integer factor and paints each mixed pixel as a
// block of sub-pixels in the two flat colours it mixes, in the same proportion. The split line
// follows the local edge direction (estimated from the neighbours' mix ratios), so consecutive
// edge pixels join into one straight or gently curving boundary instead of a staircase. The
// traced shapes only carry the flat colours; rendered back at the original size, the vector's own
// anti-aliasing recreates the mix.

import type { RGBAImage } from './core'

/** Minimum per-channel (premultiplied) contrast between the two colours of an edge. */
const MIN_CONTRAST = 64
/** Maximum per-channel distance between a pixel and the closest mix of the two colours. Looser
 *  than analyze's hardEdged test (6), which classifies images rather than splitting pixels. */
const MAX_RESIDUAL = 12
/** Ramps up to two pixels wide: the flat colours may sit two pixels away. */
const REACH = 2

// Opposite directions: horizontal, vertical and both diagonals. A lies towards (dx, dy), B the
// other way.
const PAIRS: [number, number][] = [[-1, 0], [0, -1], [-1, -1], [1, -1]]

/** Which pixels are mixes, and of what: computed without enlarging anything. */
export interface AntialiasAnalysis {
  /** Pixels recognized as a mix of two neighbouring colours. */
  blended: number
  /** Visible source pixels (alpha > 0). */
  visible: number
  /** Per pixel: index of colour A (-1: not a mix, -2: transparent outside the image). */
  a: Int32Array
  b: Int32Array
  /** Share of B in the mix. */
  t: Float32Array
  /** Index in PAIRS of the direction the mix was found along. */
  dir: Uint8Array
}

/** Find the pixels that mix two contrasted neighbouring colours. Cheap: no enlargement. */
export function analyzeAntialiasing(src: RGBAImage, minContrast = MIN_CONTRAST): AntialiasAnalysis {
  const { width: w, height: h, data: d } = src
  const n = w * h
  // Premultiplied, so that a mix with transparency is a plain linear mix too. Outside the image
  // counts as transparent, so the edge pixels of a cut-out touching the border resolve too.
  const pm = new Float32Array((n + 1) * 4)
  for (let p = 0; p < n; p++) {
    const a = d[p * 4 + 3] / 255
    for (let c = 0; c < 3; c++) pm[p * 4 + c] = d[p * 4 + c] * a
    pm[p * 4 + 3] = d[p * 4 + 3]
  }
  const OUTSIDE = n
  const A = new Int32Array(n).fill(-1), B = new Int32Array(n).fill(-1), T = new Float32Array(n), D = new Uint8Array(n)
  let blended = 0, visible = 0
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = y * w + x
    if (d[p * 4 + 3] > 0) visible++
    let bestNorm = 0
    for (let q = 0; q < PAIRS.length; q++) for (let ka = 1; ka <= REACH; ka++) for (let kb = 1; kb <= REACH; kb++) {
      const [dx, dy] = PAIRS[q]
      const ax = x + dx * ka, ay = y + dy * ka, bx = x - dx * kb, by = y - dy * kb
      const aIn = ax >= 0 && ay >= 0 && ax < w && ay < h, bIn = bx >= 0 && by >= 0 && bx < w && by < h
      // Only the nearest outside position stands for "transparent beyond the border".
      if ((!aIn && ka > 1) || (!bIn && kb > 1) || (!aIn && !bIn)) continue
      const a = aIn ? ay * w + ax : OUTSIDE, b = bIn ? by * w + bx : OUTSIDE
      let contrast = 0, dot = 0, norm = 0
      for (let c = 0; c < 4; c++) {
        const e = pm[b * 4 + c] - pm[a * 4 + c]
        contrast = Math.max(contrast, Math.abs(e))
        dot += (pm[p * 4 + c] - pm[a * 4 + c]) * e
        norm += e * e
      }
      if (contrast < minContrast || norm <= bestNorm) continue
      const t = dot / norm
      // Nearly pure A or B: not a mix worth splitting.
      if (t <= 0.04 || t >= 0.96) continue
      let residual = 0
      for (let c = 0; c < 4; c++) residual = Math.max(residual, Math.abs(pm[a * 4 + c] + t * (pm[b * 4 + c] - pm[a * 4 + c]) - pm[p * 4 + c]))
      // Among the mixes that explain the pixel, the most contrasted pair holds the flat colours;
      // a nearer pair may be the other half of a two-pixel ramp.
      if (residual > MAX_RESIDUAL) continue
      bestNorm = norm
      A[p] = a === OUTSIDE ? -2 : a; B[p] = b === OUTSIDE ? -2 : b; T[p] = t; D[p] = q
    }
    if (bestNorm > 0) blended++
  }
  return { blended, visible, a: A, b: B, t: T, dir: D }
}

/**
 * Enlarge `src` by `scale`, painting each mix found by `analyzeAntialiasing` as sub-pixels of its
 * two flat colours. Every other pixel becomes a uniform block.
 */
export function resolveAntialiasing(src: RGBAImage, scale = 8, analysis = analyzeAntialiasing(src)): RGBAImage {
  const { width: w, height: h } = src
  // Whole-pixel copies below go through 32-bit views, which need an aligned buffer.
  const d = src.data.byteOffset % 4 ? new Uint8ClampedArray(src.data) : src.data
  const W = w * scale
  const out = new Uint8ClampedArray(W * h * scale * 4)
  const out32 = new Uint32Array(out.buffer)
  const src32 = new Uint32Array(d.buffer, d.byteOffset, w * h)
  const colour = (i: number) => (i < 0 ? 0 : src32[i])
  const { a: A, b: B, t: T, dir: D } = analysis
  // Mix ratio of a pixel along the A-B axis of the pixel being split, for the edge direction.
  const pm = (i: number, c: number) => (i < 0 ? 0 : d[i * 4 + c] * (c === 3 ? 1 : d[i * 4 + 3] / 255))
  const ratio = (q: number, a: number, b: number) => {
    let dot = 0, norm = 0
    for (let c = 0; c < 4; c++) { const e = pm(b, c) - pm(a, c); dot += (pm(q, c) - pm(a, c)) * e; norm += e * e }
    return Math.max(0, Math.min(1, dot / norm))
  }
  const offsets = new Float32Array(scale * scale * 2)
  for (let j = 0; j < scale; j++) for (let i = 0; i < scale; i++) {
    offsets[(j * scale + i) * 2] = (i + 0.5) / scale - 0.5
    offsets[(j * scale + i) * 2 + 1] = (j + 0.5) / scale - 0.5
  }
  const along = new Float32Array(scale * scale), sorted = new Float32Array(scale * scale)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = y * w + x
    const base = y * scale * W + x * scale
    if (A[p] === -1) {
      const v = src32[p]
      for (let j = 0; j < scale; j++) out32.fill(v, base + j * W, base + j * W + scale)
      continue
    }
    const a = A[p], b = B[p]
    // Gradient of the mix ratio over the 3x3 neighbourhood (Sobel): it points from A to B,
    // across the edge. Outside the image the ratio repeats the border.
    const r = (dx: number, dy: number) => {
      const X = Math.min(w - 1, Math.max(0, x + dx)), Y = Math.min(h - 1, Math.max(0, y + dy))
      return ratio(Y * w + X, a, b)
    }
    let gx = (r(1, -1) + 2 * r(1, 0) + r(1, 1)) - (r(-1, -1) + 2 * r(-1, 0) + r(-1, 1))
    let gy = (r(-1, 1) + 2 * r(0, 1) + r(1, 1)) - (r(-1, -1) + 2 * r(0, -1) + r(1, -1))
    if (Math.hypot(gx, gy) < 1e-3) {
      // No measurable slope around: split across the direction the mix was found along.
      gx = -PAIRS[D[p]][0]; gy = -PAIRS[D[p]][1]
    }
    for (let k = 0; k < along.length; k++) along[k] = offsets[k * 2] * gx + offsets[k * 2 + 1] * gy
    // The sub-pixels farthest towards B take B's colour, as many as its share of the mix.
    const countB = Math.round(T[p] * scale * scale)
    sorted.set(along); sorted.sort()
    const threshold = countB > 0 ? sorted[along.length - countB] : Infinity
    const ca = colour(a), cb = colour(b)
    let painted = 0
    for (let j = 0; j < scale; j++) for (let i = 0; i < scale; i++) {
      const k = j * scale + i
      const toB = along[k] >= threshold && painted < countB
      if (toB) painted++
      out32[base + j * W + i] = toB ? cb : ca
    }
  }
  return { width: W, height: h * scale, data: out }
}
