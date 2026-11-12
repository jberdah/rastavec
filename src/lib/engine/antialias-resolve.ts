// Anti-aliasing resolution for small artwork. Pure TS, no DOM.
//
// A small icon rasterized with anti-aliasing stores its sub-pixel edge position in the colour of
// its edge pixels: a pixel 30 % of the way from a brown face to a dark outline is a 30/70 mix of
// both. Traced directly, such a raster leaves VTracer two bad choices: absorb those pixels (edges
// move by up to a pixel, which on a 150 px icon changes 5-10 % of the pixels visibly), or keep
// every mix as its own colour layer (a thin path per ramp: 20 shapes become 1000+ paths).
//
// `resolveAntialiasing` enlarges the image by an integer factor and paints each mixed pixel as a
// block of sub-pixels in the two flat colours it mixes, in the same proportion, split across the
// edge. The traced shapes then only carry the flat colours, with boundaries at sub-pixel
// precision; rendered back at the original size, the vector's own anti-aliasing recreates the mix.

import type { RGBAImage } from './core'

/** Minimum per-channel (premultiplied) contrast between the two colours of an edge. */
const MIN_CONTRAST = 64
/** Maximum per-channel distance between a pixel and the closest mix of the two colours. */
const MAX_RESIDUAL = 12
/** Ramps up to two pixels wide: the flat colours may sit two pixels away. */
const REACH = 2

// Opposite directions: horizontal, vertical and both diagonals. A lies towards (dx, dy), B the
// other way.
const PAIRS: [number, number][] = [[-1, 0], [0, -1], [-1, -1], [1, -1]]

export interface AntialiasResolution {
  image: RGBAImage
  /** Pixels painted as a mix of two neighbouring colours. */
  blended: number
  /** Visible source pixels (alpha > 0). */
  visible: number
}

/**
 * Enlarge `src` by `scale`, splitting each pixel that mixes two neighbouring colours across a
 * contrasted edge into those two colours. Every other pixel becomes a uniform block.
 */
export function resolveAntialiasing(src: RGBAImage, scale = 8): AntialiasResolution {
  const { width: w, height: h, data: d } = src
  const W = w * scale
  const out = new Uint8ClampedArray(W * h * scale * 4)
  // Premultiplied, so that a mix with transparency is a plain linear mix too.
  const pm = new Float32Array(w * h * 4)
  for (let p = 0; p < w * h; p++) {
    const a = d[p * 4 + 3] / 255
    for (let c = 0; c < 3; c++) pm[p * 4 + c] = d[p * 4 + c] * a
    pm[p * 4 + 3] = d[p * 4 + 3]
  }
  const paint = (x: number, y: number, i: number, j: number, from: number) =>
    out.set(d.subarray(from * 4, from * 4 + 4), ((y * scale + j) * W + x * scale + i) * 4)
  // Sub-pixel centres relative to the pixel centre.
  const offsets: [number, number][] = []
  for (let j = 0; j < scale; j++) for (let i = 0; i < scale; i++) offsets.push([(i + 0.5) / scale - 0.5, (j + 0.5) / scale - 0.5])
  const order = offsets.map((_, k) => k)
  const minShare = 0.5 / (scale * scale)
  let blended = 0, visible = 0
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = y * w + x
    if (d[p * 4 + 3] > 0) visible++
    let best: { a: number; b: number; t: number; dx: number; dy: number; norm: number } | null = null
    for (const [dx, dy] of PAIRS) for (let ka = 1; ka <= REACH; ka++) for (let kb = 1; kb <= REACH; kb++) {
      const ax = x + dx * ka, ay = y + dy * ka, bx = x - dx * kb, by = y - dy * kb
      if (ax < 0 || ay < 0 || bx < 0 || by < 0 || ax >= w || ay >= h || bx >= w || by >= h) continue
      const a = ay * w + ax, b = by * w + bx
      let contrast = 0, dot = 0, norm = 0
      for (let c = 0; c < 4; c++) {
        const e = pm[b * 4 + c] - pm[a * 4 + c]
        contrast = Math.max(contrast, Math.abs(e))
        dot += (pm[p * 4 + c] - pm[a * 4 + c]) * e
        norm += e * e
      }
      if (contrast < MIN_CONTRAST) continue
      const t = dot / norm
      // Nearly pure A or B: not worth splitting.
      if (t <= minShare || t >= 1 - minShare) continue
      let residual = 0
      for (let c = 0; c < 4; c++) residual = Math.max(residual, Math.abs(pm[a * 4 + c] + t * (pm[b * 4 + c] - pm[a * 4 + c]) - pm[p * 4 + c]))
      // Among the mixes that explain the pixel, the most contrasted pair holds the flat colours;
      // a nearer pair may be the other half of a two-pixel ramp.
      if (residual > MAX_RESIDUAL || (best && norm <= best.norm)) continue
      best = { a, b, t, dx, dy, norm }
    }
    if (!best) {
      for (let j = 0; j < scale; j++) for (let i = 0; i < scale; i++) paint(x, y, i, j, p)
      continue
    }
    blended++
    // The sub-pixels nearest to B take B's colour, as many as its share of the mix.
    const { a, b, t, dx, dy } = best
    const towardsB = (k: number) => -(offsets[k][0] * dx + offsets[k][1] * dy)
    order.sort((k, l) => towardsB(l) - towardsB(k) || k - l)
    const countB = Math.round(t * scale * scale)
    order.forEach((k, rank) => paint(x, y, k % scale, Math.floor(k / scale), rank < countB ? b : a))
  }
  return { image: { width: W, height: h * scale, data: out }, blended, visible }
}
