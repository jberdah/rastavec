// Per-shape editing of a traced SVG, driven by the engine's shape hints.
//
// The engine says which <path> is an exact circle or ellipse and which is painted by a gradient
// (see EngineShapeHint). That is enough to edit a shape by its parameters instead of its path
// data: move or resize a circle, turn an ellipse, recolour a flat fill or a gradient stop.
// Everything here is a pure SVG-string rewrite: only attribute values change, so the markup
// keeps the exact form the palette filters and the grouping pass expect.
import type { EngineShapeHint } from './types'

/** A change to one hinted shape. Geometry fields apply to circles and ellipses only. */
export interface ShapePatch {
  cx?: number
  cy?: number
  /** Circle radius. */
  r?: number
  /** Ellipse semi-axes and rotation in degrees. */
  rx?: number
  ry?: number
  rotation?: number
  /** A crescent's or ring's inner circle. Moving the shape (cx, cy) moves both circles. */
  innerCx?: number
  innerCy?: number
  innerR?: number
  /** New `#rrggbb` for a flat fill. */
  fill?: string
  /** New `#rrggbb` per gradient stop, by position; `undefined` entries are left alone. */
  stops?: (string | undefined)[]
}

const KAPPA = 0.5522847498307934
const HEX = /^#[0-9a-fA-F]{6}$/
const round = (value: number) => {
  const text = (Math.round(value * 100) / 100).toString()
  return text === '-0' ? '0' : text
}

/** Four cubic arcs, the same construction the engine uses for exact circles and ellipses. */
export function ellipsePath(cx: number, cy: number, rx: number, ry: number, rotation = 0): string {
  const angle = rotation * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle)
  const at = (u: number, v: number) => `${round(cx + rx * u * cos - ry * v * sin)},${round(cy + rx * u * sin + ry * v * cos)}`
  const k = KAPPA
  return `M${at(1, 0)}C${at(1, k)} ${at(k, 1)} ${at(0, 1)}C${at(-k, 1)} ${at(-1, k)} ${at(-1, 0)}C${at(-1, -k)} ${at(-k, -1)} ${at(0, -1)}C${at(k, -1)} ${at(1, -k)} ${at(1, 0)}Z`
}

/**
 * A crescent (outer disc minus inner disc) as the engine writes it: four cubic arcs along the outer
 * circle from tip to tip, then four back along the inner circle. `null` when the circles do not
 * cross, so there is no crescent.
 */
export function crescentPath(cx: number, cy: number, r: number, icx: number, icy: number, ir: number): string | null {
  const dx = icx - cx, dy = icy - cy, d = Math.hypot(dx, dy)
  if (!(d > Math.abs(r - ir)) || !(d < r + ir) || d < 1e-9) return null
  const along = (r * r - ir * ir + d * d) / (2 * d), half = Math.sqrt(Math.max(0, r * r - along * along))
  const mx = cx + dx * along / d, my = cy + dy * along / d
  const p = { x: mx - dy * half / d, y: my + dx * half / d }, q = { x: mx + dy * half / d, y: my - dx * half / d }
  const away = Math.atan2(cy - icy, cx - icx)
  const angle = (ox: number, oy: number, at: { x: number; y: number }) => Math.atan2(at.y - oy, at.x - ox)
  const sweepThrough = (from: number, to: number, through: number) => {
    const tau = Math.PI * 2, ccw = ((to - from) % tau + tau) % tau, mid = ((through - from) % tau + tau) % tau
    return mid <= ccw ? ccw : ccw - tau
  }
  const arc = (ox: number, oy: number, radius: number, start: number, sweep: number) => {
    const step = sweep / 4, k = 4 / 3 * Math.tan(step / 4)
    let out = ''
    for (let n = 0; n < 4; n++) {
      const t0 = start + step * n, t1 = start + step * (n + 1)
      const [s0, c0, s1, c1] = [Math.sin(t0), Math.cos(t0), Math.sin(t1), Math.cos(t1)]
      const x0 = ox + radius * c0, y0 = oy + radius * s0, x1 = ox + radius * c1, y1 = oy + radius * s1
      out += `C${round(x0 - k * radius * s0)},${round(y0 + k * radius * c0)} ${round(x1 + k * radius * s1)},${round(y1 - k * radius * c1)} ${round(x1)},${round(y1)}`
    }
    return out
  }
  const outerStart = angle(cx, cy, p), innerStart = angle(icx, icy, q)
  return `M${round(p.x)},${round(p.y)}`
    + arc(cx, cy, r, outerStart, sweepThrough(outerStart, angle(cx, cy, q), away))
    + arc(icx, icy, ir, innerStart, sweepThrough(innerStart, angle(icx, icy, p), away)) + 'Z'
}

/** Thinnest band, in viewBox units, the engine accepts for a ring. */
export const RING_MIN_THICKNESS = 1.5

/** Narrowest width of a ring's band: where the inner circle comes closest to the outer one. */
export const ringBand = (cx: number, cy: number, r: number, icx: number, icy: number, ir: number) => r - Math.hypot(icx - cx, icy - cy) - ir

/**
 * Thinnest band an edit may leave on a ring whose band is `band` now. The engine writes rings with
 * at least `RING_MIN_THICKNESS`, but its report reparses rounded coordinates, so a ring born at the
 * limit can come back a hair under it: such a ring may still be moved or edited, just not made
 * thinner than it is (less a tenth, for edits rounded to a tenth).
 */
export const ringMinBand = (band: number) => Math.min(RING_MIN_THICKNESS, band - 0.1)

/**
 * A ring (outer disc minus an inner disc lying wholly inside it) as the engine writes it: the outer
 * circle as four cubic arcs, then the inner one wound the other way, so the hole stays unpainted
 * under either fill rule. `null` when the inner circle does not lie inside the outer one with a
 * band of at least `minBand` (and always more than 0).
 */
export function ringPath(cx: number, cy: number, r: number, icx: number, icy: number, ir: number, minBand = RING_MIN_THICKNESS): string | null {
  const band = ringBand(cx, cy, r, icx, icy, ir)
  if (!(ir > 0) || !(band > 0) || !(band >= minBand)) return null
  const k = KAPPA
  const at = (ox: number, oy: number, radius: number, u: number, v: number) => `${round(ox + radius * u)},${round(oy + radius * v)}`
  const o = (u: number, v: number) => at(icx, icy, ir, u, v)
  return ellipsePath(cx, cy, r, r)
    + `M${o(1, 0)}C${o(1, -k)} ${o(k, -1)} ${o(0, -1)}C${o(-k, -1)} ${o(-1, -k)} ${o(-1, 0)}C${o(-1, k)} ${o(-k, 1)} ${o(0, 1)}C${o(k, 1)} ${o(1, k)} ${o(1, 0)}Z`
}

/** A ring during a drag: outer centre and radius (`rx`, kept equal to `ry`), inner circle. */
export type RingGeometry = { cx: number; cy: number; rx: number; ry: number; icx: number; icy: number; ir: number }

/**
 * Clamp a drag on a ring (from `from` to `g`) so it stays a ring: the value the gesture changes
 * stops where the band reaches RING_MIN_THICKNESS plus a margin for the rounding of the committed
 * values to a tenth. A ring already thinner than that keeps its band but loses no more of it. Each
 * gesture changes one value with the others fixed, so its starting value is always within the clamp.
 */
export function keepRing<G extends RingGeometry>(g: G, from: G, mode: 'move' | 'resize' | 'rotate' | 'inner-move' | 'inner-resize'): G {
  const floor = Math.min(RING_MIN_THICKNESS + 0.2, ringBand(from.cx, from.cy, from.rx, from.icx, from.icy, from.ir))
  const d = Math.hypot(g.icx - g.cx, g.icy - g.cy)
  if (mode === 'inner-resize') {
    // Not below 1, or below the starting radius when that is already under 1.
    const lo = Math.min(1, from.ir), hi = Math.max(lo, g.rx - d - floor)
    return { ...g, ir: Math.min(hi, Math.max(lo, g.ir)) }
  }
  if (mode === 'resize') {
    const r = Math.max(g.rx, d + g.ir + floor)
    return { ...g, rx: r, ry: r }
  }
  if (mode === 'inner-move') {
    const hi = Math.max(0, g.rx - g.ir - floor)
    if (d <= hi) return g
    const k = hi / d
    return { ...g, icx: g.cx + (g.icx - g.cx) * k, icy: g.cy + (g.icy - g.cy) * k }
  }
  return g
}

/** Axis-aligned bounds of an ellipse. */
function ellipseBounds(cx: number, cy: number, rx: number, ry: number, rotation: number): [number, number, number, number] {
  const angle = rotation * Math.PI / 180
  const ex = Math.hypot(rx * Math.cos(angle), ry * Math.sin(angle)), ey = Math.hypot(rx * Math.sin(angle), ry * Math.cos(angle))
  return [cx - ex, cy - ey, cx + ex, cy + ey]
}

/** What can be edited on a hinted shape. */
export interface ShapeCapabilities {
  /**
   * Circles, ellipses, crescents and rings can be moved and resized. Their overlays (pieces the
   * engine painted right over them: translucent glows, or the residual pieces of a crescent or
   * ring) follow them, unless one cannot (no path data, or a gradient shared with another path).
   */
  geometry: boolean
  /**
   * Set when the shape can be moved but not reshaped: a translucent gradient overlay is cut to its
   * outline, so a resized or turned shape would leave it sticking out.
   */
  moveOnly?: true
  /** Current flat fill, when the shape has one. */
  fill?: string
  /** Current gradient stop colours, when the shape is painted by a gradient. */
  stops?: string[]
}

const pathTags = (svg: string) => [...svg.matchAll(/<path\b[^>]*>/g)]

function gradientBlock(svg: string, id: string) {
  const match = new RegExp(`<(linearGradient|radialGradient)\\b[^>]*\\bid="${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>[\\s\\S]*?</\\1>`).exec(svg)
  return match ? { start: match.index, text: match[0] } : null
}

/** Capabilities of every hinted shape, in hint order; shapes that cannot be edited are left out. */
export function editableShapes(svg: string, hints: EngineShapeHint[]): { hint: EngineShapeHint; capabilities: ShapeCapabilities }[] {
  const tags = pathTags(svg)
  // The engine paints a color field as an underlay and a top shape sharing one gradient
  // definition. Editing either edits the definition, so the pair is one entry: the first.
  const listed = new Set<string>()
  return hints.flatMap((hint) => {
    if (hint.kind === 'path' && hint.gradient) {
      if (listed.has(hint.gradient.id)) return []
      listed.add(hint.gradient.id)
    }
    const capabilities = shapeCapabilities(svg, hints, hint.index, tags)
    return capabilities ? [{ hint, capabilities }] : []
  })
}

/** Describe what `editShape` can change on the shape at `index`. */
export function shapeCapabilities(svg: string, hints: EngineShapeHint[], index: number, tags = pathTags(svg)): ShapeCapabilities | null {
  const hint = hints.find((candidate) => candidate.index === index)
  const tag = tags[index]?.[0]
  if (!hint || !tag) return null
  const fill = /\bfill="([^"]*)"/.exec(tag)?.[1]
  // A shape sharing its gradient definition with another cannot move it: that would repaint the other.
  const ownGradient = (shape: EngineShapeHint) => !shape.gradient || !hints.some((other) => other.index !== shape.index && other.gradient?.id === shape.gradient!.id)
  // A gradient that moves with its shape: its own, and one translateGradient can shift.
  const movableGradient = (shape: EngineShapeHint) => {
    if (!shape.gradient) return true
    const block = gradientBlock(svg, shape.gradient.id)
    return ownGradient(shape) && !!block && gradientMovable(block.text)
  }
  // Overlays follow the shape (see editShape): each needs readable path data, no transform of
  // its own, a gradient that can move, and no overlays of its own (a chain is not followed).
  const overlays = hints.filter((other) => other.overlayOf === index)
  const follows = (overlay: EngineShapeHint) => {
    const overlayTag = tags[overlay.index]?.[0]
    const data = overlayTag ? /\bd="([^"]+)"/.exec(overlayTag)?.[1] : undefined
    return !!data && translatePath(data, 0, 0) !== null && !/\stransform=/.test(overlayTag!)
      && movableGradient(overlay) && !hints.some((other) => other.overlayOf === overlay.index)
  }
  const capabilities: ShapeCapabilities = {
    geometry: hint.kind !== 'path' && movableGradient(hint) && overlays.every(follows),
  }
  if (capabilities.geometry && overlays.some(isGlow)) capabilities.moveOnly = true
  if (fill && HEX.test(fill)) capabilities.fill = fill.toLowerCase()
  if (hint.gradient) {
    const block = gradientBlock(svg, hint.gradient.id)
    if (block) capabilities.stops = [...block.text.matchAll(/\bstop-color="(#[0-9a-fA-F]{6})"/g)].map((stop) => stop[1].toLowerCase())
  }
  return capabilities
}

const PATH_PARAMETERS: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 }
const PATH_NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/

/**
 * Path data moved by (dx, dy): absolute coordinates are shifted in place, everything else
 * (commands, separators, relative coordinates, which follow their start point) is kept exactly as
 * written, so moving back restores the same text. `null` when the data cannot be read.
 */
export function translatePath(d: string, dx: number, dy: number): string | null {
  let i = 0, command = '', first = true
  const edits: [number, number, string][] = []
  const skip = () => { while (i < d.length && /[\s,]/.test(d[i])) i++ }
  const number = () => { const match = PATH_NUMBER.exec(d.slice(i)); if (!match) return null; i += match[0].length; return { text: match[0], start: i - match[0].length, end: i } }
  const flag = () => (d[i] === '0' || d[i] === '1' ? { text: d[i], start: i, end: ++i } : null)
  skip()
  while (i < d.length) {
    if (/[a-zA-Z]/.test(d[i])) {
      command = d[i++]
      if (!(command.toLowerCase() in PATH_PARAMETERS)) return null
      skip()
      if (command.toLowerCase() === 'z') continue
    } else if (!command || command.toLowerCase() === 'z') {
      return null
    }
    const lower = command.toLowerCase()
    const values: { text: string; start: number; end: number }[] = []
    for (let k = 0; k < PATH_PARAMETERS[lower]; k++) {
      skip()
      const value = lower === 'a' && (k === 3 || k === 4) ? flag() : number()
      if (!value) return null
      values.push(value)
    }
    // The first move of the data is absolute even when written relative.
    if (command !== lower || (lower === 'm' && first)) {
      const shift = (at: number, delta: number) => {
        if (delta === 0) return
        const value = values[at], text = round(Number(value.text) + delta)
        // A sign may have stood for the separator from the previous number (unless that number,
        // rewritten, already added one).
        const previous = edits[edits.length - 1]
        const glued = value.start > 0 && /[\d.]/.test(d[value.start - 1]) && !/^[-+]/.test(text) && !(previous?.[1] === value.start && previous[2].endsWith(' '))
        // And a number written right after it with no separator (".5") must stay apart.
        const tail = d[value.end] === '.' && !text.includes('.') ? ' ' : ''
        edits.push([value.start, value.end, (glued ? ' ' : '') + text + tail])
      }
      if (lower === 'h') shift(0, dx)
      else if (lower === 'v') shift(0, dy)
      else if (lower === 'a') { shift(5, dx); shift(6, dy) }
      else for (let at = 0; at < values.length; at += 2) { shift(at, dx); shift(at + 1, dy) }
    }
    first = false
    // Pairs after a move are line segments.
    if (lower === 'm') command = command === 'm' ? 'l' : 'L'
    skip()
  }
  let out = d
  for (const [from, to, text] of edits.reverse()) out = out.slice(0, from) + text + out.slice(to)
  return out
}

/** Shift a userSpaceOnUse gradient so it follows a shape that moved by (dx, dy). */
function translateGradient(block: string, dx: number, dy: number): string {
  const open = /^<[^>]*>/.exec(block)![0]
  // A bounding-box gradient (the default) is laid out on the shape itself: it follows already.
  if (!/\bgradientUnits="userSpaceOnUse"/.test(open)) return block
  const number = (name: string) => new RegExp(`(\\b${name}=")(-?[\\d.]+(?:[eE][+-]?\\d+)?)(")`)
  const transform = /(\bgradientTransform=")([^"]*)(")/.exec(open)
  let moved = open
  const matrix = transform && /^\s*matrix\(([^)]*)\)\s*$/.exec(transform[2])
  const coordinates = open.startsWith('<linearGradient')
    ? [['x1', dx], ['y1', dy], ['x2', dx], ['y2', dy]] as const
    : ([['cx', dx], ['cy', dy], ['fx', dx], ['fy', dy]] as const).filter(([name]) => name === 'cx' || name === 'cy' || new RegExp(`\\b${name}=`).test(open))
  const values = matrix?.[1].trim().split(/[\s,]+/).map(Number)
  if (matrix && values!.length === 6 && values!.every(Number.isFinite)) {
    values![4] += dx; values![5] += dy
    moved = open.replace(transform![0], `${transform![1]}matrix(${values!.map(round).join(' ')})${transform![3]}`)
  } else if (!transform && coordinates.every(([name]) => number(name).test(open))) {
    for (const [name, delta] of coordinates) moved = moved.replace(number(name), (_m, head: string, value: string, tail: string) => head + round(Number(value) + delta) + tail)
  } else if (transform) {
    // Any other transform: translate in user space after it (merged into a leading translate).
    const lead = /^\s*translate\(\s*(-?[\d.]+(?:[eE][+-]?\d+)?)(?:[\s,]+(-?[\d.]+(?:[eE][+-]?\d+)?))?\s*\)/.exec(transform[2])
    const body = lead
      ? `translate(${round(Number(lead[1]) + dx)} ${round(Number(lead[2] ?? 0) + dy)})${transform[2].slice(lead[0].length)}`
      : `translate(${round(dx)} ${round(dy)}) ${transform[2].trim()}`
    moved = open.replace(transform[0], `${transform[1]}${body}${transform[3]}`)
  } else {
    // Missing or percentage coordinates: translate the whole gradient instead.
    moved = open.replace(/^<(\w+)/, `<$1 gradientTransform="translate(${round(dx)} ${round(dy)})"`)
  }
  return moved + block.slice(open.length)
}

/** Whether translateGradient can move this gradient: not one inheriting its layout from another. */
function gradientMovable(block: string): boolean {
  const open = /^<[^>]*>/.exec(block)![0]
  return !/\b(?:xlink:)?href=/.test(open)
}

/** A translucent gradient overlay: a glow cut to the outline of the shape it sits on. */
const isGlow = (hint: EngineShapeHint) => !!hint.gradient && !hint.gradient.opaque

/** What an overlay is, for its label: a glow (translucent gradient) or a piece of its shape. */
export const overlayKind = (hint: EngineShapeHint): 'glow' | 'piece' => (isGlow(hint) ? 'glow' : 'piece')

/**
 * Apply `patch` to the shape at `index`. Returns the rewritten SVG and updated hints, or `null`
 * when the shape is unknown or the patch asks for something `shapeCapabilities` does not allow.
 */
export function editShape(svg: string, hints: EngineShapeHint[], index: number, patch: ShapePatch): { svg: string; hints: EngineShapeHint[] } | null {
  const hint = hints.find((candidate) => candidate.index === index)
  const match = pathTags(svg)[index]
  const capabilities = shapeCapabilities(svg, hints, index)
  if (!hint || !match || !capabilities) return null

  let tag = match[0]
  let next: EngineShapeHint = { ...hint }
  let gradientShift: [number, number] | null = null

  const geometryKeys = ['cx', 'cy', 'r', 'rx', 'ry', 'rotation', 'innerCx', 'innerCy', 'innerR'] as const
  const reshapes = (['r', 'rx', 'ry', 'rotation', 'innerCx', 'innerCy', 'innerR'] as const).some((key) => patch[key] !== undefined && patch[key] !== hint[key])
  if (capabilities.moveOnly && reshapes) return null
  if ((hint.kind === 'crescent' || hint.kind === 'ring') && geometryKeys.some((key) => patch[key] !== undefined)) {
    if (!capabilities.geometry || !/\bd="[^"]*"/.test(tag)) return null
    const cx = patch.cx ?? hint.cx ?? 0, cy = patch.cy ?? hint.cy ?? 0, r = patch.r ?? hint.r ?? 0
    // Moving the crescent or ring carries its inner circle along, unless that is placed explicitly.
    const icx = patch.innerCx ?? (hint.innerCx ?? 0) + (cx - (hint.cx ?? 0))
    const icy = patch.innerCy ?? (hint.innerCy ?? 0) + (cy - (hint.cy ?? 0))
    const ir = patch.innerR ?? hint.innerR ?? 0
    if (![cx, cy, r, icx, icy, ir].every(Number.isFinite) || r <= 0 || ir <= 0) return null
    // The engine only recognises crescents and rings among flat-filled layers (never a gradient
    // paint), so unlike circles and ellipses there is no gradient to carry along when they move.
    const d = hint.kind === 'ring'
      ? ringPath(cx, cy, r, icx, icy, ir, ringMinBand(ringBand(hint.cx ?? 0, hint.cy ?? 0, hint.r ?? 0, hint.innerCx ?? 0, hint.innerCy ?? 0, hint.innerR ?? 0)))
      : crescentPath(cx, cy, r, icx, icy, ir)
    if (!d) return null // a crescent whose circles no longer cross, a ring whose hole leaves the disc
    tag = tag.replace(/\bd="[^"]*"/, `d="${d}"`)
    next = { ...next, cx, cy, r, innerCx: icx, innerCy: icy, innerR: ir, bounds: ellipseBounds(cx, cy, r, r, 0) }
  } else if (geometryKeys.some((key) => patch[key] !== undefined)) {
    if (!capabilities.geometry) return null
    const cx = patch.cx ?? hint.cx ?? 0, cy = patch.cy ?? hint.cy ?? 0
    const rx = hint.kind === 'circle' ? patch.r ?? hint.r ?? 0 : patch.rx ?? hint.rx ?? 0
    const ry = hint.kind === 'circle' ? rx : patch.ry ?? hint.ry ?? 0
    const rotation = hint.kind === 'circle' ? 0 : patch.rotation ?? hint.rotation ?? 0
    if (![cx, cy, rx, ry, rotation].every(Number.isFinite) || rx <= 0 || ry <= 0) return null
    if (!/\bd="[^"]*"/.test(tag)) return null
    tag = tag.replace(/\bd="[^"]*"/, `d="${ellipsePath(cx, cy, rx, ry, rotation)}"`)
    next = hint.kind === 'circle'
      ? { ...next, cx, cy, r: rx, bounds: ellipseBounds(cx, cy, rx, rx, 0) }
      : { ...next, cx, cy, rx, ry, rotation, bounds: ellipseBounds(cx, cy, rx, ry, rotation) }
    const dx = cx - (hint.cx ?? cx), dy = cy - (hint.cy ?? cy)
    if (hint.gradient && (dx !== 0 || dy !== 0)) gradientShift = [dx, dy]
  }

  if (patch.fill !== undefined) {
    if (!capabilities.fill || !HEX.test(patch.fill)) return null
    tag = tag.replace(/\bfill="[^"]*"/, `fill="${patch.fill.toLowerCase()}"`)
  }

  // Overlays (glows, residual pieces) follow the shape's centre: moved with it, and kept where
  // they sit relative to it when the shape is reshaped (never scaled). Only numbers change in
  // their path data, so the document keeps its structure.
  const tags = pathTags(svg)
  const replaced = new Map<number, string>([[index, tag]])
  const movedOverlays = new Map<number, EngineShapeHint>()
  const overlayGradients: string[] = []
  const dx = (next.cx ?? 0) - (hint.cx ?? 0), dy = (next.cy ?? 0) - (hint.cy ?? 0)
  if ((dx !== 0 || dy !== 0) && Number.isFinite(dx) && Number.isFinite(dy)) {
    for (const overlay of hints.filter((other) => other.overlayOf === index)) {
      const overlayTag = tags[overlay.index]?.[0]
      const data = overlayTag ? /\bd="([^"]+)"/.exec(overlayTag)?.[1] : undefined
      const moved = data ? translatePath(data, dx, dy) : null
      if (!overlayTag || moved === null) return null
      replaced.set(overlay.index, overlayTag.replace(/\bd="[^"]*"/, () => `d="${moved}"`))
      const b = overlay.bounds
      movedOverlays.set(overlay.index, {
        ...overlay, bounds: [b[0] + dx, b[1] + dy, b[2] + dx, b[3] + dy],
        ...(overlay.cx !== undefined ? { cx: overlay.cx + dx } : {}), ...(overlay.cy !== undefined ? { cy: overlay.cy + dy } : {}),
        ...(overlay.innerCx !== undefined ? { innerCx: overlay.innerCx + dx } : {}), ...(overlay.innerCy !== undefined ? { innerCy: overlay.innerCy + dy } : {}),
      })
      if (overlay.gradient) overlayGradients.push(overlay.gradient.id)
    }
  }
  let out = svg
  for (const at of [...replaced.keys()].sort((a, b) => b - a)) {
    const original = tags[at]
    out = out.slice(0, original.index) + replaced.get(at)! + out.slice(original.index! + original[0].length)
  }
  for (const id of overlayGradients) {
    const block = gradientBlock(out, id)
    if (!block) return null
    out = out.slice(0, block.start) + translateGradient(block.text, dx, dy) + out.slice(block.start + block.text.length)
  }

  if (hint.gradient && (gradientShift || patch.stops?.some((stop) => stop !== undefined))) {
    if (patch.stops?.some((stop) => stop !== undefined && !HEX.test(stop))) return null
    const block = gradientBlock(out, hint.gradient.id)
    if (!block) return null
    let text = block.text
    if (patch.stops) {
      let position = 0
      text = text.replace(/(\bstop-color=")(#[0-9a-fA-F]{6})(")/g, (_m, head: string, current: string, tail: string) => head + (patch.stops![position++] ?? current).toLowerCase() + tail)
    }
    if (gradientShift) text = translateGradient(text, gradientShift[0], gradientShift[1])
    out = out.slice(0, block.start) + text + out.slice(block.start + block.text.length)
  } else if (patch.stops?.some((stop) => stop !== undefined)) {
    return null
  }

  return { svg: out, hints: hints.map((candidate) => candidate.index === index ? next : movedOverlays.get(candidate.index) ?? candidate) }
}
