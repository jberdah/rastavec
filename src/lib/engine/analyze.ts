// Deterministic image analysis -> recommended tracing parameters. Pure TS, no DOM.
import type { RGBAImage } from './core'
import { DEFAULT_PARAMS } from './presets'
import type { TraceParams } from './types'

export type ImageKind = 'flat' | 'shaded' | 'line' | 'pixel' | 'photo'
export type AlphaKind = 'opaque' | 'hard' | 'edges' | 'soft'

export interface Analysis {
  width: number
  height: number
  kind: ImageKind
  alpha: AlphaKind
  /** % of transparent pixels (alpha < 8). */
  transparentPct: number
  /** % of semi-transparent pixels (8 <= alpha < 240). */
  softPct: number
  /** Number of 12-bit colors needed to cover 95 % of the visible pixels. */
  dominantColors: number
  /** Share (0-1) of neighbouring visible pixels with a smooth, non-zero transition. */
  gradient: number
  grayscale: boolean
}

/** Why Auto picked its parameters (language-neutral; rendered by the UI). */
export type NoteCode = 'flat' | 'shaded' | 'line-binary' | 'line-color' | 'pixel' | 'photo' | 'soft' | 'edges'

export function analyze(img: RGBAImage): Analysis {
  const { data: d, width: w, height: h } = img
  const total = w * h
  // Sample at most ~1M pixels with a fixed stride (deterministic).
  const stride = Math.max(1, Math.floor(Math.sqrt(total / 1_000_000)))
  let n = 0, transparent = 0, soft = 0, visible = 0, colored = 0, boundary = 0, pairs = 0, smooth = 0, gray = 0
  const bins = new Map<number, number>()
  const vis = (x: number, y: number) => d[(y * w + x) * 4 + 3] >= 128
  for (let y = 0; y < h; y += stride) {
    for (let x = 0; x < w; x += stride) {
      const i = (y * w + x) * 4
      const a = d[i + 3]
      n++
      if (a < 8) transparent++
      else if (a < 240) soft++
      if (a < 8) continue
      colored++
      const r = d[i], g = d[i + 1], b = d[i + 2]
      if (Math.max(r, g, b) - Math.min(r, g, b) < 12) gray++
      const k = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)
      bins.set(k, (bins.get(k) ?? 0) + 1)
      if (a < 128) continue
      visible++
      // Boundary: visible pixel touching a non-visible neighbour.
      if ((x > 0 && !vis(x - 1, y)) || (x < w - 1 && !vis(x + 1, y)) || (y > 0 && !vis(x, y - 1)) || (y < h - 1 && !vis(x, y + 1))) boundary++
      for (const [dx, dy] of [[1, 0], [0, 1]]) {
        const X = x + dx, Y = y + dy
        if (X >= w || Y >= h || !vis(X, Y)) continue
        const j = (Y * w + X) * 4
        const diff = Math.max(Math.abs(r - d[j]), Math.abs(g - d[j + 1]), Math.abs(b - d[j + 2]))
        pairs++
        if (diff >= 2 && diff <= 28) smooth++
      }
    }
  }
  const sorted = [...bins.values()].sort((a, b) => b - a)
  let acc = 0, dominant = 0
  for (const c of sorted) {
    acc += c
    dominant++
    if (acc >= colored * 0.95) break
  }
  const gradient = pairs ? smooth / pairs : 0
  const transparentPct = (100 * transparent) / n
  const softPct = (100 * soft) / n
  const grayscale = colored > 0 && gray / colored > 0.97
  // Stroke-like artwork has a lot of outline for its area.
  const thin = visible > 0 && boundary / visible > 0.2

  // Alpha profile: anti-aliased edges are ~1-2 soft pixels per boundary pixel; glows and
  // translucent areas are much wider.
  let alpha: AlphaKind
  if (!transparent && !soft) alpha = 'opaque'
  else if (softPct < 0.05) alpha = 'hard'
  else alpha = softPct > 0.5 && (!boundary || soft / boundary > 2.5) ? 'soft' : 'edges'

  const long = Math.max(w, h)
  let kind: ImageKind
  if (grayscale && dominant <= 3 && (alpha === 'opaque' || thin)) kind = 'line'
  else if (dominant <= 2 && thin) kind = 'line'
  else if (long <= 160 && gradient < 0.04 && dominant <= 48) kind = 'pixel'
  else if (gradient > 0.45 || dominant > 400) kind = 'photo' // detailed illustrations reach 100-200 colours
  else if (dominant <= 12 && gradient < 0.12) kind = 'flat'
  // Two or three colors cannot be shading: what looks like gentle steps is antialiasing on a
  // dense outline, or lossy-compression noise.
  else if (dominant <= 3 && gradient < 0.3) kind = 'flat'
  else kind = 'shaded'

  return { width: w, height: h, kind, alpha, transparentPct, softPct, dominantColors: dominant, gradient, grayscale }
}

/** Recommended parameters for an analysed image, with a short justification. */
export function recommend(a: Analysis): { params: TraceParams; notes: NoteCode[] } {
  const px = a.width * a.height
  // Speckle scales with resolution: ~2 px at 256², ~7 px at 1200².
  const speckle = Math.max(2, Math.min(12, Math.round(Math.sqrt(px) / 180)))
  const p: TraceParams = { ...DEFAULT_PARAMS, speckle }
  const notes: NoteCode[] = []
  switch (a.kind) {
    case 'flat':
      p.colorPrecision = a.dominantColors <= 6 ? 5 : 6
      p.layerDifference = 16
      notes.push('flat')
      break
    case 'shaded':
      p.colorPrecision = 8
      p.layerDifference = 8
      notes.push('shaded')
      break
    case 'line':
      if (a.grayscale && a.alpha === 'opaque') {
        p.colormode = 'binary'
        notes.push('line-binary')
      } else {
        p.colorPrecision = 4
        p.layerDifference = 24
        notes.push('line-color')
      }
      p.speckle = Math.max(2, speckle - 2)
      break
    case 'pixel':
      p.mode = 'polygon'
      p.speckle = 1
      p.colorPrecision = 8
      p.layerDifference = 4
      notes.push('pixel')
      break
    case 'photo':
      p.colorPrecision = 6
      p.layerDifference = 24
      p.speckle = speckle + 2
      notes.push('photo')
      break
  }
  // Flat artwork with narrow alpha fringes benefits from a tighter contour without an extra trace pass.
  if (a.kind === 'flat' && a.alpha === 'edges' && a.softPct < 1) p.silhouetteCut = 192
  if (a.alpha === 'soft') {
    p.softLayers = 2
    p.softColor = true
    notes.push('soft')
  } else {
    p.softLayers = 0
    if (a.alpha === 'edges') notes.push('edges')
  }
  return { params: p, notes }
}
