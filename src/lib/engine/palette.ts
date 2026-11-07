// Global palette filters for traced SVGs (pure TS, no DOM, no imports, deterministic).
//
// Traced SVGs are stacks of filled shapes with hundreds of fill colours (shading, anti-aliasing).
// Instead of editing colours one by one, filters transform the whole palette at once:
// - colours: reduce the palette to N colours (weighted k-means in OKLab),
// - detail: hide small, low-contrast shapes (the shape underneath shows through, no holes),
// - hue / saturation / lightness / contrast adjustments in OKLCH,
// - replace one hue family by another, with a smooth falloff,
// - map onto a theme palette, by lightness then hue.
// Only `<path d="…" fill="#rrggbb"/>` shapes are filtered; the silhouette clip path and the
// soft (semi-transparent) layers are left as they are.

export type ThemeId = '' | 'brand' | 'mono' | 'duo' | 'pastel' | 'night'

export interface FilterSettings {
  /** Palette size, 2..MAX_COLOURS; MAX_COLOURS = keep every colour. */
  colours: number
  /** Detail filter, 0..40: hide low-contrast shapes smaller than detail/20 % of the image. */
  detail: number
  /** Hue rotation, degrees. */
  hue: number
  /** Chroma, % (100 = unchanged). */
  sat: number
  /** Lightness offset, -30..30. */
  light: number
  /** Lightness contrast, % (100 = unchanged). */
  contrast: number
  /** Hue family replacement: centre hue, half-width (0 = off) and target hue, degrees. */
  from: number
  range: number
  to: number
  theme: ThemeId
}

export const MAX_COLOURS = 64

export const DEFAULT_FILTERS: FilterSettings = { colours: MAX_COLOURS, detail: 0, hue: 0, sat: 100, light: 0, contrast: 100, from: 60, range: 0, to: 260, theme: '' }

export type PresetId = 'original' | 'flat12' | 'flat6' | 'sticker' | 'hue' | 'family' | 'brand' | 'duo' | 'mono' | 'pastel' | 'night'

export const FILTER_PRESETS: Record<PresetId, Partial<FilterSettings>> = {
  original: {},
  flat12: { colours: 12 },
  flat6: { colours: 6, detail: 4 },
  sticker: { colours: 8, detail: 10, contrast: 115, sat: 115 },
  hue: { hue: 140 },
  family: { from: 60, range: 35, to: 300 },
  brand: { theme: 'brand', colours: 10 },
  duo: { theme: 'duo' },
  mono: { theme: 'mono' },
  pastel: { theme: 'pastel', colours: 10 },
  night: { theme: 'night', colours: 10 },
}

export const THEMES: Record<Exclude<ThemeId, ''>, string[]> = {
  brand: ['#1a1c22', '#1f8f4a', '#3cc274', '#ffd34d', '#ff8a28', '#e74a3b', '#fff8e6'],
  mono: ['#0a0b0f', '#2b2e36', '#555a66', '#8a8f9b', '#c4c7ce', '#f4f5f7'],
  duo: ['#1a1c22', '#1f5f3a', '#1f8f4a', '#7fcf9d', '#e6f5ec'],
  pastel: ['#3d3a4b', '#f4a6a6', '#f9d38c', '#a8dfb1', '#9cc8f0', '#cdb4f2', '#fffaf0'],
  night: ['#0b0820', '#2a1b5c', '#ff2e88', '#00e5ff', '#b6ff3b', '#fef9ff'],
}

export const isDefault = (s: FilterSettings) => (Object.keys(DEFAULT_FILTERS) as (keyof FilterSettings)[]).every((k) => s[k] === DEFAULT_FILTERS[k])

// ---------------------------------------------------------------- colour maths (OKLab / OKLCH)

type Lab = [number, number, number]
const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
const gam = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)

export function hexToLab(h: string): Lab {
  const n = parseInt(h.slice(1), 16)
  const r = lin(((n >> 16) & 255) / 255), g = lin(((n >> 8) & 255) / 255), b = lin((n & 255) / 255)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s]
}

export function labToHex([L, A, B]: Lab): string {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3
  const rgb = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s]
  return '#' + rgb.map((v) => Math.round(Math.min(1, Math.max(0, gam(Math.max(0, v)))) * 255).toString(16).padStart(2, '0')).join('')
}

const toLch = ([L, a, b]: Lab): Lab => [L, Math.hypot(a, b), ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360]
const fromLch = ([L, C, H]: Lab): Lab => [L, C * Math.cos((H * Math.PI) / 180), C * Math.sin((H * Math.PI) / 180)]
export const labDistance = (p: Lab, q: Lab) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])
const hueDelta = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360
  return d > 180 ? 360 - d : d
}

// ---------------------------------------------------------------- path geometry (bbox, flattening, point in fill)

const CMD = /[MmLlHhVvCcSsQqTtAaZz]/
const TOKEN = /[MmLlHhVvCcSsQqTtAaZz]|[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/gi
const ARGS: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 }

/** Closed polygons approximating the path (curves flattened), in absolute coordinates. */
export function flattenPath(d: string, dx = 0, dy = 0): number[][] {
  const tokens = d.match(TOKEN) ?? []
  const polys: number[][] = []
  let poly: number[] = []
  let x = 0, y = 0, sx = 0, sy = 0, cmd = '', i = 0
  let lcx = 0, lcy = 0 // last control point (for S/T reflection)
  let lastOp = ''
  const push = (px: number, py: number) => poly.push(px + dx, py + dy)
  const close = () => {
    if (poly.length >= 6) polys.push(poly)
    poly = []
  }
  const cubic = (x1: number, y1: number, x2: number, y2: number, ex: number, ey: number) => {
    for (let k = 1; k <= 6; k++) {
      const t = k / 6, u = 1 - t
      push(u * u * u * x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * ex, u * u * u * y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * ey)
    }
    lcx = x2; lcy = y2; x = ex; y = ey
  }
  while (i < tokens.length) {
    if (CMD.test(tokens[i])) cmd = tokens[i++]
    else if (!cmd) { i++; continue }
    const up = cmd.toUpperCase(), rel = cmd !== up
    if (up === 'Z') { x = sx; y = sy; close(); cmd = ''; continue }
    const n = ARGS[up]
    if (i + n > tokens.length) break
    const a = tokens.slice(i, i + n).map(Number)
    i += n
    if (a.some((v) => !Number.isFinite(v))) break
    const ox = rel ? x : 0, oy = rel ? y : 0
    switch (up) {
      case 'M':
        close()
        x = a[0] + ox; y = a[1] + oy; sx = x; sy = y; push(x, y)
        cmd = rel ? 'l' : 'L' // implicit lineto after moveto
        break
      case 'L': x = a[0] + ox; y = a[1] + oy; push(x, y); break
      case 'H': x = a[0] + (rel ? x : 0); push(x, y); break
      case 'V': y = a[0] + (rel ? y : 0); push(x, y); break
      case 'C': cubic(a[0] + ox, a[1] + oy, a[2] + ox, a[3] + oy, a[4] + ox, a[5] + oy); break
      case 'S': cubic(2 * x - lcx, 2 * y - lcy, a[0] + ox, a[1] + oy, a[2] + ox, a[3] + oy); break
      case 'Q': { const qx = a[0] + ox, qy = a[1] + oy; cubic(x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), a[2] + ox + (2 / 3) * (qx - a[2] - ox), a[3] + oy + (2 / 3) * (qy - a[3] - oy), a[2] + ox, a[3] + oy); lcx = qx; lcy = qy; break }
      case 'T': {
        const qx = (lastOp === 'Q' || lastOp === 'T') ? 2 * x - lcx : x
        const qy = (lastOp === 'Q' || lastOp === 'T') ? 2 * y - lcy : y
        const ex = a[0] + ox, ey = a[1] + oy
        cubic(x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), ex + (2 / 3) * (qx - ex), ey + (2 / 3) * (qy - ey), ex, ey)
        lcx = qx; lcy = qy
        break
      }
      case 'A': {
        let rx = Math.abs(a[0]), ry = Math.abs(a[1])
        const phi = a[2] * Math.PI / 180, cos = Math.cos(phi), sin = Math.sin(phi)
        const ex = a[5] + ox, ey = a[6] + oy
        if (!rx || !ry || (x === ex && y === ey)) { x = ex; y = ey; push(x, y); break }
        const xp = cos * (x - ex) / 2 + sin * (y - ey) / 2
        const yp = -sin * (x - ex) / 2 + cos * (y - ey) / 2
        const lambda = xp * xp / (rx * rx) + yp * yp / (ry * ry)
        if (lambda > 1) { const scale = Math.sqrt(lambda); rx *= scale; ry *= scale }
        const denominator = rx * rx * yp * yp + ry * ry * xp * xp
        const numerator = Math.max(0, rx * rx * ry * ry - denominator)
        const sign = Number(a[3] === a[4]) ? -1 : 1
        const factor = denominator ? sign * Math.sqrt(numerator / denominator) : 0
        const cxp = factor * rx * yp / ry, cyp = factor * -ry * xp / rx
        const cx = cos * cxp - sin * cyp + (x + ex) / 2
        const cy = sin * cxp + cos * cyp + (y + ey) / 2
        const ux = (xp - cxp) / rx, uy = (yp - cyp) / ry
        const vx = (-xp - cxp) / rx, vy = (-yp - cyp) / ry
        const angle = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
        let start = angle(1, 0, ux, uy), sweep = angle(ux, uy, vx, vy)
        if (!a[4] && sweep > 0) sweep -= 2 * Math.PI
        if (a[4] && sweep < 0) sweep += 2 * Math.PI
        const steps = Math.min(48, Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 12))))
        for (let step = 1; step <= steps; step++) {
          const theta = start + sweep * step / steps
          push(cx + cos * rx * Math.cos(theta) - sin * ry * Math.sin(theta), cy + sin * rx * Math.cos(theta) + cos * ry * Math.sin(theta))
        }
        x = ex; y = ey
        break
      }
    }
    if (up !== 'C' && up !== 'S' && up !== 'Q' && up !== 'T') { lcx = x; lcy = y }
    lastOp = up
  }
  close()
  return polys
}

/** Nonzero winding test against flattened polygons. */
export function pointInPolys(polys: number[][], px: number, py: number): boolean {
  let wind = 0
  for (const p of polys) {
    for (let k = 0, n = p.length; k < n; k += 2) {
      const x1 = p[k], y1 = p[k + 1], x2 = p[(k + 2) % n], y2 = p[(k + 3) % n]
      if (y1 <= py) {
        if (y2 > py && (x2 - x1) * (py - y1) - (px - x1) * (y2 - y1) > 0) wind++
      } else if (y2 <= py && (x2 - x1) * (py - y1) - (px - x1) * (y2 - y1) < 0) wind--
    }
  }
  return wind !== 0
}

// ---------------------------------------------------------------- SVG model

const SHAPE = /<path d="([^"]*)" fill="(#[0-9a-fA-F]{6})"((?: transform="[^"]*")?)\/>/g

export interface Shape {
  hex: string
  lab: Lab
  /** Bounding box area, px². */
  area: number
  /** OKLab distance to the colour painted right under it (1 when nothing / not computed). */
  contrast: number
}

export interface ShapeAnalysis {
  width: number
  height: number
  shapes: Shape[]
}

/** Parses the filterable shapes once (geometry, colour, contrast with what lies under small shapes). */
export function analyzeShapes(svg: string): ShapeAnalysis {
  const dims = svg.match(/viewBox="[-\d.]+ [-\d.]+ ([\d.]+) ([\d.]+)"/) ?? svg.match(/width="([\d.]+)" height="([\d.]+)"/)
  const width = dims ? +dims[1] : 0, height = dims ? +dims[2] : 0
  const total = Math.max(1, width * height)
  const geo: { polys: number[][]; box: [number, number, number, number] }[] = []
  const shapes: Shape[] = []
  for (const m of svg.matchAll(SHAPE)) {
    const t = m[3].match(/translate\(\s*(-?[\d.e+-]+)(?:[\s,]+(-?[\d.e+-]+))?/)
    const polys = flattenPath(m[1], t ? +t[1] : 0, t?.[2] ? +t[2] : 0)
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const p of polys) for (let k = 0; k < p.length; k += 2) {
      x0 = Math.min(x0, p[k]); x1 = Math.max(x1, p[k]); y0 = Math.min(y0, p[k + 1]); y1 = Math.max(y1, p[k + 1])
    }
    const box: [number, number, number, number] = Number.isFinite(x0) ? [x0, y0, x1, y1] : [0, 0, 0, 0]
    geo.push({ polys, box })
    const hex = m[2].toLowerCase()
    shapes.push({ hex, lab: hexToLab(hex), area: (box[2] - box[0]) * (box[3] - box[1]), contrast: 1 })
  }
  // Contrast for small shapes only: sample a few points inside, find the shape painted under each.
  shapes.forEach((s, i) => {
    if (s.area > total * 0.02) return
    const { polys, box } = geo[i]
    const cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2
    const pts: [number, number][] = []
    if (pointInPolys(polys, cx, cy)) pts.push([cx, cy])
    const outline = polys[0] ?? []
    const step = Math.max(2, Math.floor(outline.length / 2 / 8)) * 2
    for (let k = 0; k < outline.length && pts.length < 9; k += step) {
      const px = outline[k] + (cx - outline[k]) * 0.15, py = outline[k + 1] + (cy - outline[k + 1]) * 0.15
      if (pointInPolys(polys, px, py)) pts.push([px, py])
    }
    let sum = 0, n = 0
    for (const [px, py] of pts) {
      for (let j = i - 1; j >= 0; j--) {
        const b = geo[j].box
        if (px < b[0] || px > b[2] || py < b[1] || py > b[3]) continue
        if (pointInPolys(geo[j].polys, px, py)) { sum += labDistance(s.lab, shapes[j].lab); n++; break }
      }
    }
    s.contrast = n ? sum / n : 1
  })
  return { width, height, shapes }
}

// ---------------------------------------------------------------- filters

/** Weighted k-means on the palette in OKLab (weight = sqrt(area) so small accents survive). */
function posterize(shapes: Shape[], k: number): Map<string, Lab> {
  const uniq = new Map<string, { lab: Lab; w: number }>()
  for (const s of shapes) {
    const u = uniq.get(s.hex) ?? { lab: s.lab, w: 0 }
    u.w += s.area
    uniq.set(s.hex, u)
  }
  const pts = [...uniq.entries()].sort((a, b) => b[1].w - a[1].w || (a[0] < b[0] ? -1 : 1))
  if (pts.length <= k) return new Map(pts.map(([h, u]) => [h, u.lab]))
  let C: Lab[] = [pts[0][1].lab]
  while (C.length < k) {
    // farthest point, favouring large colours a little (deterministic)
    let best = pts[0][1].lab, bd = -1
    for (const [, u] of pts) {
      const d = Math.min(...C.map((c) => labDistance(c, u.lab))) * Math.sqrt(Math.sqrt(u.w))
      if (d > bd) { bd = d; best = u.lab }
    }
    C.push(best)
  }
  const asg = new Map<string, number>()
  for (let it = 0; it < 15; it++) {
    const S = C.map(() => [0, 0, 0, 0])
    for (const [h, u] of pts) {
      let j = 0, bd = Infinity
      C.forEach((c, ci) => { const d = labDistance(c, u.lab); if (d < bd) { bd = d; j = ci } })
      asg.set(h, j)
      const w = Math.sqrt(u.w), s = S[j]
      s[0] += u.lab[0] * w; s[1] += u.lab[1] * w; s[2] += u.lab[2] * w; s[3] += w
    }
    C = C.map((c, ci) => (S[ci][3] ? [S[ci][0] / S[ci][3], S[ci][1] / S[ci][3], S[ci][2] / S[ci][3]] : c))
  }
  return new Map(pts.map(([h]) => [h, C[asg.get(h)!]]))
}

const themeCache = new Map<string, Lab[]>()
function themeLabs(id: Exclude<ThemeId, ''>): Lab[] {
  let t = themeCache.get(id)
  if (!t) themeCache.set(id, (t = THEMES[id].map(hexToLab).sort((a, b) => a[0] - b[0])))
  return t
}

/** One colour through the adjustment chain. */
export function transformColour(lab: Lab, p: FilterSettings): Lab {
  let [L, C, H] = toLch(lab)
  if (p.range > 0 && C > 0.06) {
    const d = hueDelta(H, p.from)
    if (d < p.range) {
      const t = Math.min(1, (1 - d / p.range) * 1.5)
      const delta = ((p.to - p.from + 540) % 360) - 180
      H = (H + delta * t + 360) % 360
    }
  }
  H = (H + p.hue + 360) % 360
  C *= p.sat / 100
  L = Math.min(1, Math.max(0, 0.5 + (L - 0.5) * (p.contrast / 100) + p.light / 100))
  let out = fromLch([L, C, H])
  if (p.theme) {
    // Keep the light/dark structure: target lightness spread over the theme's range, then nearest hue.
    const t = themeLabs(p.theme)
    const lo = t[0][0], hi = t[t.length - 1][0], target = lo + (hi - lo) * L
    const tonal = p.theme === 'mono' || p.theme === 'duo'
    let best = t[0], bd = Infinity
    for (const c of t) {
      const d = Math.abs(c[0] - target) * 2 + (tonal ? 0 : labDistance([0, out[1], out[2]], [0, c[1], c[2]]))
      if (d < bd) { bd = d; best = c }
    }
    out = best
  }
  return out
}

export interface FilterResult {
  svg: string
  /** Distinct fills after filtering. */
  colours: number
  /** Shapes kept / total. */
  kept: number
  total: number
  /** Most used colours after filtering (by area), for a palette preview. */
  palette: string[]
}

/** Applies the filters to an SVG produced by RastaVec. `analysis` comes from analyzeShapes(svg). */
export function applyFilters(svg: string, analysis: ShapeAnalysis, p: FilterSettings): FilterResult {
  const { shapes } = analysis
  const minArea = (p.detail / 2000) * analysis.width * analysis.height
  const drop = (s: Shape) => s.area < minArea && s.contrast < 0.25
  const kept = shapes.filter((s) => !drop(s))
  const post = p.colours < MAX_COLOURS ? posterize(kept, p.colours) : null
  const memo = new Map<string, string>()
  const areaByHex = new Map<string, number>()
  let i = 0
  const out = svg.replace(SHAPE, (_m, d: string, _fill: string, tr: string) => {
    const s = shapes[i++]
    if (!s || drop(s)) return ''
    let hex = memo.get(s.hex)
    if (!hex) memo.set(s.hex, (hex = labToHex(transformColour(post?.get(s.hex) ?? s.lab, p))))
    areaByHex.set(hex, (areaByHex.get(hex) ?? 0) + s.area)
    return `<path d="${d}" fill="${hex}"${tr}/>`
  })
  const palette = [...areaByHex.entries()].sort((a, b) => b[1] - a[1]).map(([h]) => h)
  return { svg: out.replace(/\n{2,}/g, '\n'), colours: areaByHex.size, kept: kept.length, total: shapes.length, palette }
}
