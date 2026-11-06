// Conservative, non-semantic grouping for the path format emitted by RastaVec.
// Only consecutive paths in the same existing parent can become a real SVG group:
// changing the order of overlapping artwork would change how it looks.
import { flattenPath } from './palette'

type Bounds = [number, number, number, number]
export type NearbyZone = 'top-left' | 'top' | 'top-right' | 'left' | 'center' | 'right' | 'bottom-left' | 'bottom' | 'bottom-right'
export interface NearbyGroup { id: string; count: number; bounds: Bounds; fill: string; zone: NearbyZone; level: 0 | 1; parentId?: string }
export interface NearbyResult { svg: string; groups: NearbyGroup[]; considered: number; skipped: number; limit?: 'path-count' | 'geometry-size' | 'geometry-work' }

const PATH = /<path d="([^"]*)" fill="(#[0-9a-fA-F]{6})"((?: transform="[^"]*")?)\/>/g
const MAX_PATHS = 10000
const MAX_PER_GROUP = 64
// Parsing and curve flattening run on the UI thread: also bound work per path and in total.
const MAX_PATH_DATA = 100000
const MAX_TOTAL_PATH_DATA = 1000000
const MAX_GEOMETRY_TESTS = 2_000_000

/** Group nearby consecutive paths without reordering, altering or moving any path.
 * Bounds approximate curves, not semantic objects; artwork in defs/masks is never touched.
 * Non-RastaVec path syntax, arcs, unknown transforms and large background-like paths are skipped.
 */
export function groupNearbyPaths(svg: string, options: { distance?: number } = {}): NearbyResult {
  const fallback = (): NearbyResult => ({ svg, groups: [], considered: 0, skipped: 0 })
  // A stylesheet can target the added <g> or depend on parent/child selectors.
  // This feature is for RastaVec's generated SVG, not arbitrary external SVGs.
  if (/<(?:style|script|foreignObject|use|image)\b|<\?xml-stylesheet|<!ENTITY/i.test(svg)) return fallback()
  const root = svg.match(/<svg\b[^>]*\bviewBox="\s*([-+\d.eE]+)[\s,]+([-+\d.eE]+)[\s,]+([-+\d.eE]+)[\s,]+([-+\d.eE]+)\s*"/)
  if (!root) return fallback()
  const [viewX, viewY, width, height] = root.slice(1).map(Number)
  if (!(width > 0 && height > 0 && [viewX, viewY, width, height].every(Number.isFinite))) return fallback()
  const defaultDistance = Math.max(0.5, Math.min(8, 0.005 * Math.min(width, height)))
  const distance = options.distance === undefined ? defaultDistance : options.distance
  if (!Number.isFinite(distance) || distance < 0 || distance > Math.min(width, height) * 0.1) return fallback()
  // Reject exceptionally complex documents instead of blocking the interface indefinitely.
  const matches = [...svg.matchAll(PATH)]
  if (matches.length > MAX_PATHS) return { ...fallback(), skipped: matches.length, limit: 'path-count' }
  let totalPathData = 0
  for (const match of matches) {
    totalPathData += match[1].length
    if (match[1].length > MAX_PATH_DATA || totalPathData > MAX_TOTAL_PATH_DATA)
      return { ...fallback(), skipped: matches.length, limit: 'geometry-size' }
  }

  // Generated SVG uses regular XML tags. Track protected sections incrementally: clips,
  // masks, defs, symbols and patterns are rendering machinery, not artwork to group.
  const protectedTag = new Set(['defs', 'clippath', 'mask', 'symbol', 'pattern'])
  const tag = /<!--[\s\S]*?-->|<\/?([A-Za-z][\w:.-]*)\b[^>]*>/g
  const stack: string[] = []
  let pending = tag.exec(svg)
  const protectedAt = (at: number) => {
    while (pending && pending.index < at) {
      const full = pending[0], name = pending[1]?.toLowerCase()
      if (name && !full.startsWith('<!--')) {
        if (full.startsWith('</')) { if (stack[stack.length - 1] === name) stack.pop() }
        else if (!full.endsWith('/>')) stack.push(name)
      }
      pending = tag.exec(svg)
    }
    return stack.some((name) => protectedTag.has(name))
  }
  const area = width * height
  let skipped = 0
  type FlatPoly = { points: number[]; bounds: Bounds }
  type Candidate = { start: number; end: number; box: Bounds; fill: string; polygons: FlatPoly[] }
  const candidates: Candidate[] = []
  for (const m of matches) {
    const start = m.index!, end = start + m[0].length
    const protectedPath = protectedAt(start)
    const translation = m[3].match(/^ transform="translate\(\s*([-+\d.eE]+)(?:[\s,]+([-+\d.eE]+))?\s*\)"$/)
    if (protectedPath || /[Aa]/.test(m[1]) || (m[3] && !translation)) { skipped++; continue }
    const polygons = flattenPath(m[1], translation ? Number(translation[1]) : 0, translation?.[2] ? Number(translation[2]) : 0)
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const poly of polygons) for (let i = 0; i + 1 < poly.length; i += 2) {
      x0 = Math.min(x0, poly[i]); y0 = Math.min(y0, poly[i + 1]); x1 = Math.max(x1, poly[i]); y1 = Math.max(y1, poly[i + 1])
    }
    const box: Bounds = [x0, y0, x1, y1]
    // A backdrop or silhouette can touch almost everything, joining unrelated parts.
    if (!box.every(Number.isFinite) || x1 <= x0 || y1 <= y0 || (x1 - x0) * (y1 - y0) > area * 0.15) { skipped++; continue }
    const flatPolygons = polygons.map((points) => {
      let px0 = Infinity, py0 = Infinity, px1 = -Infinity, py1 = -Infinity
      for (let i = 0; i + 1 < points.length; i += 2) {
        px0 = Math.min(px0, points[i]); py0 = Math.min(py0, points[i + 1]); px1 = Math.max(px1, points[i]); py1 = Math.max(py1, points[i + 1])
      }
      return { points, bounds: [px0, py0, px1, py1] as Bounds }
    }).filter((poly) => poly.points.length >= 6)
    if (!flatPolygons.length) { skipped++; continue }
    candidates.push({ start, end, box, fill: m[2].toLowerCase(), polygons: flatPolygons })
  }
  const union = (a: Bounds, b: Bounds): Bounds => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]
  const close = (a: Bounds, b: Bounds, threshold = distance) => {
    const dx = Math.max(0, a[0] - b[2], b[0] - a[2]), dy = Math.max(0, a[1] - b[3], b[1] - a[3])
    return Math.hypot(dx, dy) <= threshold
  }
  let geometryTests = 0, geometryLimit = false
  const pointSegmentDistanceSquared = (px: number, py: number, ax: number, ay: number, bx: number, by: number) => {
    const dx = bx - ax, dy = by - ay, length = dx * dx + dy * dy
    const t = length ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length)) : 0
    const ex = px - (ax + t * dx), ey = py - (ay + t * dy)
    return ex * ex + ey * ey
  }
  const orientation = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
  const segmentsCross = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number) => {
    const abC = orientation(ax, ay, bx, by, cx, cy), abD = orientation(ax, ay, bx, by, dx, dy)
    const cdA = orientation(cx, cy, dx, dy, ax, ay), cdB = orientation(cx, cy, dx, dy, bx, by)
    return ((abC <= 0 && abD >= 0) || (abC >= 0 && abD <= 0)) && ((cdA <= 0 && cdB >= 0) || (cdA >= 0 && cdB <= 0))
  }
  const pointInPath = (polygons: FlatPoly[], px: number, py: number) => {
    let winding = 0
    for (const { points } of polygons) {
      for (let k = 0, n = points.length; k < n; k += 2) {
        if (++geometryTests > MAX_GEOMETRY_TESTS) { geometryLimit = true; return false }
        const x1 = points[k], y1 = points[k + 1], x2 = points[(k + 2) % n], y2 = points[(k + 3) % n]
        const side = (x2 - x1) * (py - y1) - (px - x1) * (y2 - y1)
        if (y1 <= py) { if (y2 > py && side > 0) winding++ }
        else if (y2 <= py && side < 0) winding--
      }
    }
    return winding !== 0
  }
  const polygonsNear = (a: FlatPoly, b: FlatPoly, threshold: number) => {
    if (!close(a.bounds, b.bounds, threshold)) return false
    const ap = a.points, bp = b.points
    const limitSquared = threshold * threshold
    for (let i = 0; i + 1 < ap.length; i += 2) {
      const ai = (i + 2) % ap.length, ax = ap[i], ay = ap[i + 1], bx = ap[ai], by = ap[ai + 1]
      for (let j = 0; j + 1 < bp.length; j += 2) {
        if (++geometryTests > MAX_GEOMETRY_TESTS) { geometryLimit = true; return false }
        const bi = (j + 2) % bp.length, cx = bp[j], cy = bp[j + 1], dx = bp[bi], dy = bp[bi + 1]
        if (Math.max(ax, bx) + threshold < Math.min(cx, dx) || Math.max(cx, dx) + threshold < Math.min(ax, bx) || Math.max(ay, by) + threshold < Math.min(cy, dy) || Math.max(cy, dy) + threshold < Math.min(ay, by)) continue
        if (segmentsCross(ax, ay, bx, by, cx, cy, dx, dy)) return true
        if (pointSegmentDistanceSquared(ax, ay, cx, cy, dx, dy) <= limitSquared || pointSegmentDistanceSquared(bx, by, cx, cy, dx, dy) <= limitSquared || pointSegmentDistanceSquared(cx, cy, ax, ay, bx, by) <= limitSquared || pointSegmentDistanceSquared(dx, dy, ax, ay, bx, by) <= limitSquared) return true
      }
    }
    return false
  }
  const regionsNear = (a: FlatPoly[][], b: FlatPoly[][], threshold: number) => {
    for (const pathA of a) for (const pathB of b) {
      for (const polyB of pathB) if (pointInPath(pathA, polyB.points[0], polyB.points[1])) return true
      if (geometryLimit) return false
      for (const polyA of pathA) if (pointInPath(pathB, polyA.points[0], polyA.points[1])) return true
      if (geometryLimit) return false
      for (const polyA of pathA) for (const polyB of pathB) {
        if (polygonsNear(polyA, polyB, threshold)) return true
        if (geometryLimit) return false
      }
    }
    return false
  }
  type Run = { start: number; end: number; count: number; bounds: Bounds; fills: Map<string, number>; polygons: FlatPoly[][] }
  const runs: Run[] = []
  let current: Run | undefined
  for (const candidate of candidates) {
    const b = current && union(current.bounds, candidate.box)
    // Whitespace-only adjacency is deliberate: no other markup, parent, opacity or clip
    // can be crossed; skipped paths also break the run.
    if (current && b && current.count < MAX_PER_GROUP && /^\s*$/.test(svg.slice(current.end, candidate.start)) && close(current.bounds, candidate.box) && regionsNear(current.polygons, [candidate.polygons], distance) && (b[2] - b[0]) * (b[3] - b[1]) <= area * 0.2) {
      current.end = candidate.end; current.count++; current.bounds = b
      current.fills.set(candidate.fill, (current.fills.get(candidate.fill) ?? 0) + 1)
      current.polygons.push(candidate.polygons)
    } else {
      if (current && current.count > 1) runs.push(current)
      current = { start: candidate.start, end: candidate.end, count: 1, bounds: candidate.box, fills: new Map([[candidate.fill, 1]]), polygons: [candidate.polygons] }
    }
  }
  if (current && current.count > 1) runs.push(current)
  if (geometryLimit) return { ...fallback(), skipped: matches.length, limit: 'geometry-work' }
  // A second, wider pass nests nearby fine groups when they are adjacent in paint order.
  // This creates a useful coarse-to-fine outline without moving any artwork.
  type ParentRun = { start: number; end: number; count: number; bounds: Bounds; fills: Map<string, number>; children: Run[]; polygons: FlatPoly[][] }
  const parentRuns: ParentRun[] = []
  const parentDistance = Math.min(Math.min(width, height) * 0.1, Math.max(distance + 1, distance * 3))
  let parent: ParentRun | undefined
  for (const run of runs) {
    const b = parent && union(parent.bounds, run.bounds)
    if (parent && b && parent.count + run.count <= MAX_PER_GROUP * 4 && /^\s*$/.test(svg.slice(parent.end, run.start)) && close(parent.bounds, run.bounds, parentDistance) && regionsNear(parent.polygons, run.polygons, parentDistance) && (b[2] - b[0]) * (b[3] - b[1]) <= area * 0.45) {
      parent.end = run.end; parent.count += run.count; parent.bounds = b; parent.children.push(run)
      for (const [fill, count] of run.fills) parent.fills.set(fill, (parent.fills.get(fill) ?? 0) + count)
      parent.polygons.push(...run.polygons)
    } else {
      if (parent && parent.children.length > 1) parentRuns.push(parent)
      parent = { ...run, fills: new Map(run.fills), children: [run], polygons: [...run.polygons] }
    }
  }
  if (parent && parent.children.length > 1) parentRuns.push(parent)
  if (geometryLimit) return { ...fallback(), skipped: matches.length, limit: 'geometry-work' }

  let nextId = 1
  const makeId = () => {
    let id: string
    do { id = `rastavec-proximity-${nextId++}` } while (svg.includes(`id="${id}"`) || svg.includes(`id='${id}'`))
    return id
  }
  const describe = (id: string, run: Pick<Run, 'count' | 'bounds' | 'fills'>, level: 0 | 1, parentId?: string): NearbyGroup => {
    const fill = [...run.fills].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0]
    const cx = ((run.bounds[0] + run.bounds[2]) / 2 - viewX) / width
    const cy = ((run.bounds[1] + run.bounds[3]) / 2 - viewY) / height
    const col = cx < 1 / 3 ? 'left' : cx > 2 / 3 ? 'right' : 'center'
    const row = cy < 1 / 3 ? 'top' : cy > 2 / 3 ? 'bottom' : 'center'
    const zone: NearbyZone = row === 'center' ? col : col === 'center' ? row : `${row}-${col}` as NearbyZone
    return { id, count: run.count, bounds: run.bounds, fill, zone, level, parentId }
  }
  type Node = { group: NearbyGroup; run: Pick<Run, 'start' | 'end'>; children?: Node[] }
  const leafNodes: Node[] = runs.map((run) => ({ group: describe(makeId(), run, 0), run }))
  const nodes = new Map(runs.map((run, index) => [run, leafNodes[index]]))
  const parentNodes: Node[] = parentRuns.map((run) => {
    const id = makeId()
    const children = run.children.map((child) => nodes.get(child)!)
    for (const child of children) child.group.parentId = id
    return { group: describe(id, run, 1), run, children }
  })
  const allNodes = [...leafNodes, ...parentNodes].sort((a, b) => a.run.start - b.run.start || b.run.end - a.run.end)
  const groups = allNodes.map((node) => node.group)
  const serialize = (start: number, end: number, children: Node[]) => {
    let cursor = start, out = ''
    for (const node of children) {
      out += svg.slice(cursor, node.run.start) + `<g id="${node.group.id}" data-rastavec-group="proximity" data-rastavec-level="${node.group.level}">`
      out += node.children ? serialize(node.run.start, node.run.end, node.children) : svg.slice(node.run.start, node.run.end)
      out += '</g>'
      cursor = node.run.end
    }
    return out + svg.slice(cursor, end)
  }
  const topNodes = [...leafNodes.filter((node) => !node.group.parentId), ...parentNodes].sort((a, b) => a.run.start - b.run.start)
  return { svg: groups.length ? serialize(0, svg.length, topNodes) : svg, groups, considered: matches.length, skipped }
}
