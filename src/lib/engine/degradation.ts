// Lossy-compression and noise clean-up for Auto. Pure TS, no DOM.
//
// A logo saved as JPEG, a screenshot or a scan is artwork plus a small perturbation: ringing
// and blotches around edges (JPEG), or grain everywhere (noise). Traced as is, every ripple
// becomes a path. `measureDegradation` tells such an image from clean artwork, and
// `restoreArtwork` removes the perturbation while keeping edges and gradients, so that Auto
// traces (and scores against) what the image was meant to be.
import type { RGBAImage } from './core'

export interface Degradation {
  /** Share (0-1) of strong edges followed by a small ripple on the flat side (JPEG ringing, noise). */
  ringing: number
  /** Share (0-1) of pixels standing out from all eight neighbours by a small amount (grain). */
  grain: number
  /** How much larger small steps are across the 8 x 8 JPEG block grid than inside blocks (1: no grid). */
  blocks: number
  /** Estimated noise standard deviation per channel, in levels (0 for ringing alone). */
  sigma: number
  /** Size of the ripples beside an edge, as a share (0-0.2) of its step, noise excluded. */
  reach: number
}

// An edge is a step of at least EDGE_STEP between pixels two apart; its flat side is the
// RIPPLE_RUN pixels starting RIPPLE_GAP further out (past the anti-aliasing).
const EDGE_STEP = 64, RIPPLE_GAP = 3, RIPPLE_RUN = 5
/** A ripple goes up and down again by at least this much in one channel. */
const RIPPLE_MIN = 2
/** A flat side varies by at most this share of the step; more is another edge or a detail. */
const RIPPLE_CAP = 0.2
/** Edges needed before their ripple share means anything. */
const MIN_EDGES = 40
/**
 * Ripple share from which an image is degraded. Clean renders reach 0.21 (steep gradients next
 * to an edge), a Lanczos-reduced logo 0.31; JPEG gives 0.40 or more at any quality, noise 0.9.
 */
export const RINGING_SHARE = 0.36
/**
 * With a visible JPEG block grid, fewer ripples are enough: at low quality most are flattened
 * out or leave one slow wave. Clean renders with a grid-like layout stay under 1.3 on one axis
 * at least and have no ripples at all.
 */
export const BLOCK_GRID = 1.3, BLOCK_RINGING_SHARE = 0.12
/** Least share of grains per level of estimated sigma for the variation to be noise, and where that share levels off. */
const NOISE_GRAIN = 0.04, NOISE_GRAIN_MAX = 0.15
/** Steps up to this size count for the block grid (larger ones are edges), and samples needed per position. */
const BLOCK_STEP = 24, BLOCK_SAMPLES = 500
/** Grain share from which an image without edges is noisy: clean renders stay under 0.002, sigma 2 gives 0.1. */
export const GRAIN_SHARE = 0.03

/**
 * Measures the perturbation of a fully opaque image; null when it has transparency (lossy
 * formats that matter here have none) or reads as clean.
 */
export function measureDegradation(img: RGBAImage): Degradation | null {
  const measured = measure(img)
  return measured && (measured.ringing >= RINGING_SHARE || measured.grain >= GRAIN_SHARE || measured.blocks >= BLOCK_GRID) ? measured : null
}

/** True when ripples or grain are left all over an image: a texture or a photo, not artwork under artifacts. */
export function stillRippled(img: RGBAImage): boolean {
  const measured = measure(img)
  return measured !== null && (measured.ringing >= RINGING_SHARE || measured.grain >= GRAIN_SHARE)
}

function measure(img: RGBAImage): Degradation | null {
  const { data: d, width: w, height: h } = img
  if (w < 16 || h < 16) return null
  for (let i = 3; i < d.length; i += 4) if (d[i] !== 255) return null
  const stride = Math.max(1, Math.floor(Math.sqrt((w * h) / 1_000_000)))
  let edges = 0, rippled = 0, interior = 0, grains = 0
  // Variation of each flat side and the step of its edge, to size the ripples afterwards.
  const ranges: number[] = [], steps: number[] = []
  // Flat side of an edge: `from` is its first pixel, `st` the offset to the next one outwards.
  const side = (from: number, st: number, step: number) => {
    const cap = Math.max(8, RIPPLE_CAP * step)
    let ripple = false, range = 0
    for (let c = 0; c < 3; c++) {
      let min = 255, max = 0, up = 0, down = 0, prev = d[from + c]
      for (let k = 0; k < RIPPLE_RUN; k++) {
        const v = d[from + k * st + c]
        if (v < min) min = v
        if (v > max) max = v
        if (v - prev > up) up = v - prev
        if (prev - v > down) down = prev - v
        prev = v
      }
      if (max - min > cap) return
      if (max - min > range) range = max - min
      if (up >= RIPPLE_MIN && down >= RIPPLE_MIN) ripple = true
    }
    edges++
    if (ripple) rippled++
    if (edges % 4 === 0) { ranges.push(range); steps.push(step) }
  }
  const reach = RIPPLE_GAP + RIPPLE_RUN - 1
  const laplacians: number[] = []
  const luma = (i: number) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
  const row = w * 4
  for (let y = 0; y < h; y += stride) for (let x = 0; x < w; x += stride) {
    const i = (y * w + x) * 4
    if (x + 2 < w) {
      const j = i + 8
      const step = Math.max(Math.abs(d[i] - d[j]), Math.abs(d[i + 1] - d[j + 1]), Math.abs(d[i + 2] - d[j + 2]))
      if (step >= EDGE_STEP) {
        if (x - reach >= 0) side(i - RIPPLE_GAP * 4, -4, step)
        if (x + 2 + reach < w) side(j + RIPPLE_GAP * 4, 4, step)
      }
    }
    if (y + 2 < h) {
      const j = i + 2 * row
      const step = Math.max(Math.abs(d[i] - d[j]), Math.abs(d[i + 1] - d[j + 1]), Math.abs(d[i + 2] - d[j + 2]))
      if (step >= EDGE_STEP) {
        if (y - reach >= 0) side(i - RIPPLE_GAP * row, -row, step)
        if (y + 2 + reach < h) side(j + RIPPLE_GAP * row, row, step)
      }
    }
    // Grain and noise level from every other pixel: shares and a median need no more.
    if (((x ^ y) / stride) & 1 || x === 0 || y === 0 || x >= w - 1 || y >= h - 1) continue
    interior++
    for (let c = 0; c < 3; c++) {
      const k = i + c, v = d[k]
      const min = Math.min(d[k - row - 4], d[k - row], d[k - row + 4], d[k - 4], d[k + 4], d[k + row - 4], d[k + row], d[k + row + 4])
      const max = Math.max(d[k - row - 4], d[k - row], d[k - row + 4], d[k - 4], d[k + 4], d[k + row - 4], d[k + row], d[k + row + 4])
      if (v - max >= RIPPLE_MIN || min - v >= RIPPLE_MIN) { grains++; break }
    }
    // Noise level from a Laplacian that cancels constant and linear content (Immerkaer).
    if (interior % 3 === 0) {
      laplacians.push(Math.abs(luma(i - row - 4) - 2 * luma(i - row) + luma(i - row + 4) - 2 * luma(i - 4) + 4 * luma(i)
        - 2 * luma(i + 4) + luma(i + row - 4) - 2 * luma(i + row) + luma(i + row + 4)))
    }
  }
  const ringing = edges >= MIN_EDGES ? rippled / edges : 0
  const grain = interior ? grains / interior : 0
  const blocks = ringing >= BLOCK_RINGING_SHARE && ringing < RINGING_SHARE ? blockGrid(img, stride) : 1
  laplacians.sort((a, b) => a - b)
  // The mask has norm 6, the median of |N(0, 1)| is 0.6745, and luma averages three channels
  // of independent noise down to 0.67 of each.
  let sigma = (laplacians[laplacians.length >> 1] ?? 0) / (6 * 0.6745 * 0.67)
  // Noise makes grains in proportion (0.05 to 0.1 of the pixels per level of sigma, up to a third
  // of them). A painted or photographic texture varies as much with far fewer: not noise.
  if (grain < Math.min(NOISE_GRAIN_MAX, NOISE_GRAIN * sigma)) sigma = 0
  // Ripples, noise excluded (five noisy samples span about four sigma): what nine sides in ten
  // stay under. Fainter shapes beside an edge count as ripples here; the clean-up tells them apart.
  const shares = ranges.map((range, k) => Math.max(0, range - 4 * sigma) / steps[k]).sort((a, b) => a - b)
  return { ringing, grain, blocks, sigma, reach: Math.min(RIPPLE_CAP, shares[Math.floor(shares.length * 0.9)] ?? 0) }
}

/**
 * Mean small step across the boundaries of the 8 x 8 JPEG grid over the mean inside blocks,
 * on both axes (geometric mean; 1 when either axis shows no grid or the image is too small).
 */
function blockGrid(img: RGBAImage, stride: number): number {
  const { data: d, width: w, height: h } = img
  const sum = new Float64Array(16), count = new Float64Array(16)
  const add = (i: number, j: number, slot: number) => {
    const step = Math.max(Math.abs(d[i] - d[j]), Math.abs(d[i + 1] - d[j + 1]), Math.abs(d[i + 2] - d[j + 2]))
    if (step <= BLOCK_STEP) { sum[slot] += step; count[slot]++ }
  }
  for (let y = 0; y < h; y += stride) for (let x = 1, i = (y * w + 1) * 4; x < w; x++, i += 4) add(i, i - 4, x & 7)
  for (let x = 0; x < w; x += stride) for (let y = 1, i = (w + x) * 4; y < h; y++, i += w * 4) add(i, i - w * 4, 8 + (y & 7))
  let grid = 1
  for (const axis of [0, 8]) {
    const inside: number[] = []
    for (let k = 0; k < 8; k++) {
      if (count[axis + k] < BLOCK_SAMPLES) return 1
      if (k) inside.push(sum[axis + k] / count[axis + k])
    }
    inside.sort((a, b) => a - b)
    const ratio = inside[3] > 0 ? sum[axis] / count[axis] / inside[3] : 1
    if (ratio < 1.15) return 1
    grid *= ratio
  }
  return Math.sqrt(grid)
}

/** Half-width of the smoothing window. */
const WINDOW = 2
/** Half-width of the neighbourhood whose contrast sets the ripple allowance: an edge ripples through its whole 8 x 8 JPEG block. */
const CONTRAST_WINDOW = 8
/** Largest share of an edge transition put back on each of its two sides. */
const EDGE_SPREAD = 0.4
/** An edge is one of hue when its two sides differ in lightness by less than this share of their largest channel difference. */
const CHROMA_EDGE = 0.35
/** Lightness difference between two sides from which it places the pixels between them. */
const LUMA_EDGE = 32
/** Largest blotch absorbed by the flat colour around it: a JPEG block. */
const ISLAND_PIXELS = 64
/** Share of the image under which a flat colour may itself be a blotch. */
const SMALL_COLOUR = 0.005
/** Levels a blotch may stand off its flat colour, per unit of ripple reach (25 at JPEG quality 40, 12 at 95). */
const ISLAND_REACH = 160
/** Half-width of the neighbourhood searched for the two sides of an edge pixel (4:2:0 chroma spreads an edge over four pixels). */
const SIDES = 4
/** Pixels of a flat colour needed around an edge pixel for it to count as one of its two sides. */
const MIX_PIXELS = 3
/** Share of the ripple reach within which a settled pixel is put back on a flat colour. */
const SNAP_SHARE = 0.35

/** Largest max-min of any channel in the (2r+1)² neighbourhood of each pixel. */
function localContrast(d: Uint8ClampedArray, w: number, h: number, r: number): Uint8Array {
  const n = w * h
  const out = new Uint8Array(n)
  const lo = new Uint8Array(n), hi = new Uint8Array(n)
  for (let c = 0; c < 3; c++) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let min = 255, max = 0
      for (let k = Math.max(0, x - r), e = Math.min(w - 1, x + r); k <= e; k++) {
        const v = d[(y * w + k) * 4 + c]
        if (v < min) min = v
        if (v > max) max = v
      }
      lo[y * w + x] = min; hi[y * w + x] = max
    }
    for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) {
      let min = 255, max = 0
      for (let k = Math.max(0, y - r), e = Math.min(h - 1, y + r); k <= e; k++) {
        if (lo[k * w + x] < min) min = lo[k * w + x]
        if (hi[k * w + x] > max) max = hi[k * w + x]
      }
      if (max - min > out[y * w + x]) out[y * w + x] = max - min
    }
  }
  return out
}

/**
 * Each pixel whose allowance is not zero becomes the mean of its neighbours no further than
 * that allowance in any channel. A pixel nearly alone there, yet with half its neighbourhood
 * within twice the allowance, is the tail of the noise (a detail has no such company, or
 * company of its own): it takes the mean of that wider set.
 */
function smooth(src: Uint8ClampedArray, w: number, h: number, allowance: Uint8Array): Uint8ClampedArray {
  const out = new Uint8ClampedArray(src)
  const half = ((2 * WINDOW + 1) ** 2) >> 1
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - WINDOW), y1 = Math.min(h - 1, y + WINDOW)
    for (let x = 0; x < w; x++) {
      const p = y * w + x, t = allowance[p]
      if (!t) continue
      const i = p * 4, r0 = src[i], g0 = src[i + 1], b0 = src[i + 2]
      const x0 = Math.max(0, x - WINDOW), x1 = Math.min(w - 1, x + WINDOW)
      let r = 0, g = 0, b = 0, n = 0, R = 0, G = 0, B = 0, N = 0
      for (let Y = y0; Y <= y1; Y++) {
        for (let j = (Y * w + x0) * 4, e = (Y * w + x1) * 4; j <= e; j += 4) {
          const dr = Math.abs(src[j] - r0), dg = Math.abs(src[j + 1] - g0), db = Math.abs(src[j + 2] - b0)
          const far = dr > dg ? (dr > db ? dr : db) : (dg > db ? dg : db)
          if (far > 2 * t) continue
          R += src[j]; G += src[j + 1]; B += src[j + 2]; N++
          if (far > t) continue
          r += src[j]; g += src[j + 1]; b += src[j + 2]; n++
        }
      }
      if (n > 2) { out[i] = r / n; out[i + 1] = g / n; out[i + 2] = b / n }
      else if (N >= half) { out[i] = R / N; out[i + 1] = G / N; out[i + 2] = B / N }
    }
  }
  return out
}

/**
 * Each pixel whose allowance is not zero takes, per channel, the median of its neighbours no
 * further than that allowance in any channel. Ripples go up and down around the colour they
 * disturb and the median lands on it, while the boundary of a faint shape, a step, stays put
 * (a mean would blur it into its surroundings).
 */
function settle(src: Uint8ClampedArray, w: number, h: number, allowance: Uint8Array): Uint8ClampedArray {
  const out = new Uint8ClampedArray(src)
  const size = (2 * WINDOW + 1) ** 2
  const values = [new Uint8Array(size), new Uint8Array(size), new Uint8Array(size)]
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - WINDOW), y1 = Math.min(h - 1, y + WINDOW)
    for (let x = 0; x < w; x++) {
      const p = y * w + x, t = allowance[p]
      if (!t) continue
      const i = p * 4, r0 = src[i], g0 = src[i + 1], b0 = src[i + 2]
      const x0 = Math.max(0, x - WINDOW), x1 = Math.min(w - 1, x + WINDOW)
      let n = 0
      for (let Y = y0; Y <= y1; Y++) {
        for (let j = (Y * w + x0) * 4, e = (Y * w + x1) * 4; j <= e; j += 4) {
          const dr = src[j] - r0, dg = src[j + 1] - g0, db = src[j + 2] - b0
          if (dr > t || -dr > t || dg > t || -dg > t || db > t || -db > t) continue
          for (let c = 0; c < 3; c++) {
            // Insertion sort: at most 25 values per channel.
            const list = values[c], v = src[j + c]
            let k = n
            while (k > 0 && list[k - 1] > v) { list[k] = list[k - 1]; k-- }
            list[k] = v
          }
          n++
        }
      }
      const mid = n >> 1
      for (let c = 0; c < 3; c++) out[i + c] = n & 1 ? values[c][mid] : (values[c][mid - 1] + values[c][mid] + 1) >> 1
    }
  }
  return out
}

/** A flat colour holds most of the pixels around it in colour space; a gradient spreads them. */
const MODE_CORE = 2.5, MODE_BALL = 9.5, MODE_PEAK = 0.6, MAX_MODES = 64

/**
 * Flat colours of a smoothed image: peaks of its colour histogram. A gradient runs through
 * colour space as a line with as many pixels further along as here, so it has none.
 */
function flatColours(d: Uint8ClampedArray, pixels: number): number[][] {
  const stride = Math.max(1, Math.floor(pixels / 1_000_000))
  const count = new Int32Array(1 << 18), sum = new Float64Array(3 << 18)
  let sampled = 0
  for (let p = 0; p < pixels; p += stride) {
    const i = p * 4, k = ((d[i] >> 2) << 12) | ((d[i + 1] >> 2) << 6) | (d[i + 2] >> 2)
    count[k]++; sum[k * 3] += d[i]; sum[k * 3 + 1] += d[i + 1]; sum[k * 3 + 2] += d[i + 2]
    sampled++
  }
  const cells: number[] = []
  for (let k = 0; k < count.length; k++) if (count[k]) cells.push(k)
  cells.sort((a, b) => count[b] - count[a])
  const minCount = Math.max(12, sampled * 0.0001)
  const claimed = new Uint8Array(1 << 18)
  const modes: number[][] = []
  // Pixels of the cells around `c` whose mean colour is within `radius` of it, with their mean.
  const around = (c: number[], radius: number, claim = false) => {
    let n = 0, r = 0, g = 0, b = 0
    const reach = Math.ceil(radius / 4) + 1
    const cr = c[0] >> 2, cg = c[1] >> 2, cb = c[2] >> 2
    for (let R = Math.max(0, cr - reach); R <= Math.min(63, cr + reach); R++)
      for (let G = Math.max(0, cg - reach); G <= Math.min(63, cg + reach); G++)
        for (let B = Math.max(0, cb - reach); B <= Math.min(63, cb + reach); B++) {
          const k = (R << 12) | (G << 6) | B, m = count[k]
          if (!m) continue
          const mr = sum[k * 3] / m, mg = sum[k * 3 + 1] / m, mb = sum[k * 3 + 2] / m
          if (Math.max(Math.abs(mr - c[0]), Math.abs(mg - c[1]), Math.abs(mb - c[2])) > radius) continue
          n += m; r += mr * m; g += mg * m; b += mb * m
          if (claim) claimed[k] = 1
        }
    return { n, mean: n ? [r / n, g / n, b / n] : c }
  }
  for (const k of cells) {
    if (modes.length >= MAX_MODES || count[k] < minCount / 8) break
    if (claimed[k]) continue
    claimed[k] = 1
    let c = [sum[k * 3] / count[k], sum[k * 3 + 1] / count[k], sum[k * 3 + 2] / count[k]]
    for (let pass = 0; pass < 2; pass++) c = around(c, MODE_CORE).mean
    const core = around(c, MODE_CORE).n
    if (core < minCount || core < around(c, MODE_BALL).n * MODE_PEAK) continue
    around(c, MODE_CORE, true)
    modes.push(c.map(Math.round))
  }
  return modes
}

/** Smoothing passes against noise: each one leaves about a fifth of the grain of the one before. */
const NOISE_PASSES = 4
/** Passes of the median against ripples. */
const RIPPLE_PASSES = 2

/**
 * The image without its perturbation.
 *  1. Noise is averaged out between pixels closer than three sigma (nothing to do for JPEG alone).
 *  2. Ripples are settled by a median over the pixels they can reach: a share of the contrast
 *     around, as ripples scale with the step of the edge that causes them.
 *  3. Pixels close to a flat colour of the image are put back on it exactly, blotches of a few
 *     pixels join the flat colour around them, and edge pixels go back between their two sides.
 * Flat areas far from any edge are untouched; edges, anti-aliasing and gradients are kept.
 */
export function restoreArtwork(img: RGBAImage, degradation: Degradation): RGBAImage {
  const { width: w, height: h } = img
  const n = w * h
  const contrast = localContrast(img.data, w, h, CONTRAST_WINDOW)
  const noise = Math.min(64, 3 * degradation.sigma)
  const allowance = new Uint8Array(n)
  let data: Uint8ClampedArray = new Uint8ClampedArray(img.data)
  if (noise >= 1) {
    // Exactly flat neighbourhoods have nothing to average.
    for (let p = 0; p < n; p++) allowance[p] = contrast[p] ? Math.max(2, noise) : 0
    for (let pass = 0; pass < NOISE_PASSES; pass++) data = smooth(data, w, h, allowance)
  }
  const ripple = new Uint8Array(n)
  let rippled = false
  for (let p = 0; p < n; p++) {
    ripple[p] = Math.min(255, degradation.reach * contrast[p])
    allowance[p] = ripple[p] > Math.max(2, noise) ? ripple[p] : 0
    if (allowance[p]) rippled = true
  }
  if (rippled) for (let pass = 0; pass < RIPPLE_PASSES; pass++) data = settle(data, w, h, allowance)
  const modes = flatColours(data, n)
  const floor = Math.max(2, 0.6 * degradation.sigma)
  // Flat colour each pixel sits on (NONE: an edge, a gradient).
  const NONE = 255
  const on = new Uint8Array(n).fill(NONE)
  for (let p = 0; p < n; p++) {
    const i = p * 4
    // Inside a flat area: the same colour as the pixel before.
    if (p && data[i] === data[i - 4] && data[i + 1] === data[i - 3] && data[i + 2] === data[i - 2] && on[p - 1] !== NONE) { on[p] = on[p - 1]; continue }
    let best = -1, bestDistance = contrast[p] ? Math.max(floor, SNAP_SHARE * ripple[p]) : 0
    for (let m = 0; m < modes.length; m++) {
      const c = modes[m]
      const distance = Math.max(Math.abs(data[i] - c[0]), Math.abs(data[i + 1] - c[1]), Math.abs(data[i + 2] - c[2]))
      if (distance <= bestDistance) { best = m; bestDistance = distance }
    }
    if (best < 0) continue
    data[i] = modes[best][0]; data[i + 1] = modes[best][1]; data[i + 2] = modes[best][2]
    on[p] = best
  }
  // Blotches: a few pixels inside one flat colour (touching no other), off it by no more than
  // ripples reach. Some are flat themselves (a chroma block, 16 x 16 in 4:2:0, shifted as a
  // whole) and came out as a small flat colour of their own. A fainter shape of the artwork is
  // larger than a JPEG block.
  const covered = new Int32Array(modes.length)
  for (let p = 0; p < n; p++) if (on[p] !== NONE) covered[on[p]]++
  const loose = (p: number) => on[p] === NONE || covered[on[p]] < n * SMALL_COLOUR
  const blotch = ISLAND_REACH * degradation.reach
  const visited = new Uint8Array(n)
  const queue = new Int32Array(ISLAND_PIXELS + 1)
  for (let start = 0; start < n; start++) {
    if (visited[start] || !contrast[start] || !loose(start)) continue
    let size = 0, host = NONE, alone = true
    queue[size++] = start
    visited[start] = 1
    for (let k = 0; k < size && alone; k++) {
      const p = queue[k], x = p % w
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) {
        if (q < 0 || q >= n) continue
        if (!loose(q)) {
          if (host === NONE) host = on[q]
          else if (host !== on[q]) { alone = false; break }
        } else if (!visited[q]) {
          if (size > ISLAND_PIXELS - 1) { alone = false; break }
          visited[q] = 1
          queue[size++] = q
        }
      }
    }
    if (!alone || host === NONE) continue
    const c = modes[host]
    for (let k = 0; k < size && alone; k++) {
      const p = queue[k], i = p * 4
      alone = Math.max(Math.abs(data[i] - c[0]), Math.abs(data[i + 1] - c[1]), Math.abs(data[i + 2] - c[2])) <= Math.max(floor, noise, ripple[p], blotch)
    }
    if (!alone) continue
    for (let k = 0; k < size; k++) {
      const p = queue[k], i = p * 4
      data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]
      on[p] = host
    }
  }
  // Anti-aliasing between two flat colours is a mix of the two: what stands off the line between
  // them is chroma smeared across the edge (4:2:0) or noise, and is dropped. The two colours
  // are those around the pixel that explain it best.
  // Lossy compression also spreads edges of hue over four pixels or so, which then trace as
  // slivers of in-between colours: the ends of each such transition go back to its two sides.
  const soften = Math.min(EDGE_SPREAD, 2.5 * degradation.reach)
  const seen = new Uint16Array(modes.length)
  const near: number[] = []
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = y * w + x
    if (on[p] !== NONE || !contrast[p]) continue
    near.length = 0
    const x0 = Math.max(0, x - SIDES), x1 = Math.min(w - 1, x + SIDES), y0 = Math.max(0, y - SIDES), y1 = Math.min(h - 1, y + SIDES)
    for (let Y = y0; Y <= y1; Y++) for (let q = Y * w + x0, e = Y * w + x1; q <= e; q++) {
      const m = on[q]
      if (m !== NONE && ++seen[m] === MIX_PIXELS) near.push(m)
    }
    for (let Y = y0; Y <= y1; Y++) for (let q = Y * w + x0, e = Y * w + x1; q <= e; q++) if (on[q] !== NONE) seen[on[q]] = 0
    if (near.length < 2) continue
    const i = p * 4
    let best = Math.max(floor, noise, 0.6 * ripple[p]), r = -1, g = 0, bl = 0
    for (let u = 0; u < near.length; u++) for (let v = u + 1; v < near.length; v++) {
      const a = modes[near[u]], b = modes[near[v]]
      let dot = 0, norm = 0
      for (let c = 0; c < 3; c++) { dot += (data[i + c] - a[c]) * (b[c] - a[c]); norm += (b[c] - a[c]) ** 2 }
      let t = dot / norm
      if (t <= 0 || t >= 1) continue
      let off = 0
      for (let c = 0; c < 3; c++) off = Math.max(off, Math.abs(a[c] + t * (b[c] - a[c]) - data[i + c]))
      if (off > best) continue
      best = off
      // Where the two sides differ in hue more than in lightness the transition is carried by
      // chroma, which lossy formats store at half resolution: it is as wide again as the edge.
      // With enough lightness between the sides, lightness (stored at full resolution) places
      // the pixel between them and chroma follows.
      const luma = 0.299 * (b[0] - a[0]) + 0.587 * (b[1] - a[1]) + 0.114 * (b[2] - a[2])
      const widest = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]), Math.abs(b[2] - a[2]))
      if (Math.abs(luma) < CHROMA_EDGE * widest) t = Math.max(0, Math.min(1, (t - soften) / (1 - 2 * soften)))
      else if (soften && Math.abs(luma) >= LUMA_EDGE) {
        t = Math.max(0, Math.min(1, (0.299 * (data[i] - a[0]) + 0.587 * (data[i + 1] - a[1]) + 0.114 * (data[i + 2] - a[2])) / luma))
      }
      r = a[0] + t * (b[0] - a[0]); g = a[1] + t * (b[1] - a[1]); bl = a[2] + t * (b[2] - a[2])
    }
    if (r >= 0) { data[i] = r; data[i + 1] = g; data[i + 2] = bl }
  }
  return { width: w, height: h, data }
}
