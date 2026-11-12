// Conservative, non-semantic grouping for the path format emitted by RastaVec.
// Only consecutive paths in the same existing parent can become a real SVG group:
// changing the order of overlapping artwork would change how it looks.
import { flattenPath } from './palette'

type Bounds = [number, number, number, number]
export type NearbyZone = 'top-left' | 'top' | 'top-right' | 'left' | 'center' | 'right' | 'bottom-left' | 'bottom' | 'bottom-right'
export interface NearbyGroupMember { pathIndex: number; bounds: Bounds; pivot: [number, number]; fill: string; zone: NearbyZone }
export interface NearbyGroup { id: string; key: string; pathIndices: number[]; count: number; bounds: Bounds; pivot: [number, number]; fill: string; zone: NearbyZone; level: 0 | 1; parentId?: string; role?: string; members?: NearbyGroupMember[]; fragmentIds?: string[] }
export type NearbyColorMode = 'proximity' | 'same-color'
export type NearbyStrategy = 'proximity' | 'spatial'
export interface NearbyResult { svg: string; groups: NearbyGroup[]; considered: number; skipped: number; limit?: 'path-count' | 'geometry-size' | 'geometry-work' | 'singleton-count' }

/** Small deterministic fingerprint used to attach reviewed annotations to one exact SVG. */
export function svgFingerprint(svg: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < svg.length; i++) { hash ^= svg.charCodeAt(i); hash = Math.imul(hash, 0x01000193) }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

const MAX_PATHS = 10000
const MAX_PER_GROUP = 64
const MAX_SINGLETON_GROUPS = 1000
// Parsing and curve flattening run on the UI thread: also bound work per path and in total.
const MAX_PATH_DATA = 100000
const MAX_TOTAL_PATH_DATA = 1000000
const MAX_GEOMETRY_TESTS = 2_000_000

type Matrix = [number, number, number, number, number, number]
function isAxisAlignedTransform(matrix: Matrix | null): matrix is Matrix {
  return !!matrix && Math.abs(matrix[1]) < 1e-9 && Math.abs(matrix[2]) < 1e-9
}
const multiplyMatrix = (a: Matrix, b: Matrix): Matrix => [
  a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
]
function parseTransform(attribute: string): Matrix | null {
  if (!attribute) return [1, 0, 0, 1, 0, 0]
  const value = attribute.match(/^ transform="([^"]*)"$/)?.[1]
  if (value === undefined) return null
  let matrix: Matrix = [1, 0, 0, 1, 0, 0], cursor = 0
  const transform = /([a-zA-Z]+)\s*\(([^)]*)\)/g
  let match: RegExpExecArray | null
  while ((match = transform.exec(value))) {
    if (!/^[\s,]*$/.test(value.slice(cursor, match.index))) return null
    cursor = transform.lastIndex
    const args = match[2].trim().split(/[\s,]+/).filter(Boolean).map(Number)
    if (args.some((n) => !Number.isFinite(n))) return null
    const [a, b, c] = args
    let next: Matrix
    switch (match[1]) {
      case 'matrix': if (args.length !== 6) return null; next = args as Matrix; break
      case 'translate': if (args.length < 1 || args.length > 2) return null; next = [1, 0, 0, 1, a, b ?? 0]; break
      case 'scale': if (args.length < 1 || args.length > 2) return null; next = [a, 0, 0, b ?? a, 0, 0]; break
      case 'rotate': {
        if (args.length !== 1 && args.length !== 3) return null
        const radians = a * Math.PI / 180, cos = Math.cos(radians), sin = Math.sin(radians)
        next = [cos, sin, -sin, cos, 0, 0]
        if (args.length === 3) next = multiplyMatrix([1, 0, 0, 1, b, c], multiplyMatrix(next, [1, 0, 0, 1, -b, -c]))
        break
      }
      case 'skewX': if (args.length !== 1) return null; next = [1, 0, Math.tan(a * Math.PI / 180), 1, 0, 0]; break
      case 'skewY': if (args.length !== 1) return null; next = [1, Math.tan(a * Math.PI / 180), 0, 1, 0, 0]; break
      default: return null
    }
    matrix = multiplyMatrix(matrix, next)
  }
  return /^[\s,]*$/.test(value.slice(cursor)) && value.trim() ? matrix : null
}

function applyTransform(polygons: number[][], matrix: Matrix): number[][] {
  return polygons.map((points) => {
    const result = new Array<number>(points.length)
    for (let i = 0; i + 1 < points.length; i += 2) {
      const x = points[i], y = points[i + 1]
      result[i] = matrix[0] * x + matrix[2] * y + matrix[4]
      result[i + 1] = matrix[1] * x + matrix[3] * y + matrix[5]
    }
    return result
  })
}

/** Group nearby consecutive paths without reordering, altering or moving any path.
 * Bounds approximate curves, not semantic objects; artwork in defs/masks is never touched.
 * Non-RastaVec path syntax, rotated/skewed transforms and large background-like paths are skipped.
 */
export function groupNearbyPaths(svg: string, options: { distance?: number; colorMode?: NearbyColorMode; includeSingletons?: boolean; strategy?: NearbyStrategy; regionCount?: number } = {}): NearbyResult {
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
  const colorMode = options.colorMode ?? 'proximity'
  const includeSingletons = options.includeSingletons ?? false
  const strategy = options.strategy ?? 'proximity'
  if (!Number.isFinite(distance) || distance < 0 || distance > Math.min(width, height) * 0.1) return fallback()
  // Read path styles and transforms through their ancestors. VTracer emits both flat paths
  // and paths inside fill-bearing groups; ignoring inherited styles silently left whole
  // presets (notably Pixel art) with zero animation groups.
  const protectedTag = new Set(['defs', 'clippath', 'mask', 'symbol', 'pattern'])
  const tag = /<!--[\s\S]*?-->|<\/?([A-Za-z][\w:.-]*)\b[^>]*>/g
  type Context = { name: string; fill: string | null; transform: Matrix | null; reorderSafe: boolean }
  type ParsedPath = { start: number; raw: string; d: string; fill: string | null; transform: Matrix | null; parentTransform: Matrix | null; protected: boolean; reorderSafe: boolean }
  const unsafeReorderAttributes = new Set(['filter', 'marker-start', 'marker-mid', 'marker-end', 'mix-blend-mode', 'style', 'stroke'])
  const stack: Context[] = []
  const matches: ParsedPath[] = []
  for (const match of svg.matchAll(tag)) {
    const full = match[0], rawName = match[1]
    if (!rawName) continue
    const name = rawName.toLowerCase()
    if (full.startsWith('</')) {
      const index = stack.map((context) => context.name).lastIndexOf(name)
      if (index >= 0) stack.length = index
      continue
    }
    const attributes = Object.fromEntries([...full.matchAll(/\b([A-Za-z][\w:.-]*)="([^"]*)"/g)].map((attribute) => [attribute[1].toLowerCase(), attribute[2]]))
    const parent = stack.at(-1)
    const fill = (attributes.fill ?? parent?.fill ?? null)?.toLowerCase() ?? null
    const reorderSafe = (parent?.reorderSafe ?? true) && !Object.keys(attributes).some((attribute) => unsafeReorderAttributes.has(attribute))
    const ownTransform = parseTransform(attributes.transform === undefined ? '' : ` transform="${attributes.transform}"`)
    const transform = parent?.transform === null ? null : parent?.transform ? ownTransform ? multiplyMatrix(parent.transform, ownTransform) : null : ownTransform
    if (name === 'path' && attributes.d !== undefined && full.endsWith('/>')) {
      matches.push({ start: match.index!, raw: full, d: attributes.d, fill, transform, parentTransform: parent ? parent.transform : [1, 0, 0, 1, 0, 0], protected: stack.some((context) => protectedTag.has(context.name)), reorderSafe })
    }
    if (!full.endsWith('/>')) stack.push({ name, fill, transform, reorderSafe })
  }
  // Reject exceptionally complex documents instead of blocking the interface indefinitely.
  if (matches.length > MAX_PATHS) return { ...fallback(), skipped: matches.length, limit: 'path-count' }
  let totalPathData = 0
  for (const match of matches) {
    totalPathData += match.d.length
    if (match.d.length > MAX_PATH_DATA || totalPathData > MAX_TOTAL_PATH_DATA)
      return { ...fallback(), skipped: matches.length, limit: 'geometry-size' }
  }

  // A path painted with a gradient is grouped under the gradient's mean stop colour,
  // so gradient regions can be grouped, named and animated like flat ones.
  const gradientFills = new Map<string, string>()
  for (const gradient of svg.matchAll(/<(linearGradient|radialGradient)\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/\1>/g)) {
    const stops = [...gradient[3].matchAll(/\bstop-color="#([0-9a-fA-F]{6})"/g)].map((stop) => stop[1])
    if (!stops.length) continue
    const mean = [0, 2, 4].map((offset) => Math.round(stops.reduce((sum, hex) => sum + parseInt(hex.slice(offset, offset + 2), 16), 0) / stops.length))
    gradientFills.set(gradient[2].toLowerCase(), `#${mean.map((value) => value.toString(16).padStart(2, '0')).join('')}`)
  }
  const solidFill = (fill: string | null): string | null => {
    if (!fill) return null
    if (/^#[0-9a-f]{6}$/i.test(fill)) return fill.toLowerCase()
    const reference = /^url\(#([^)]+)\)$/i.exec(fill)
    return reference ? gradientFills.get(reference[1].toLowerCase()) ?? null : null
  }

  const area = width * height
  let skipped = 0
  type FlatPoly = { points: number[]; bounds: Bounds }
  type Candidate = { start: number; end: number; pathIndex: number; box: Bounds; center: [number, number]; area: number; parentTransform: Matrix | null; fill: string; polygons: FlatPoly[]; reorderSafe: boolean }
  const candidates: Candidate[] = []
  const largeShapes: Candidate[] = []
  const pathCenter = (polygons: FlatPoly[], box: Bounds): [number, number] => {
    let twiceArea = 0, weightedX = 0, weightedY = 0
    for (const { points } of polygons) for (let i = 0; i + 1 < points.length; i += 2) {
      const next = (i + 2) % points.length, x = points[i], y = points[i + 1], nx = points[next], ny = points[next + 1]
      const cross = x * ny - nx * y
      twiceArea += cross
      weightedX += (x + nx) * cross
      weightedY += (y + ny) * cross
    }
    if (Math.abs(twiceArea) > 1e-8) {
      const x = weightedX / (3 * twiceArea), y = weightedY / (3 * twiceArea)
      if (Number.isFinite(x) && Number.isFinite(y) && x >= box[0] && x <= box[2] && y >= box[1] && y <= box[3]) return [x, y]
    }
    return [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2]
  }
  const pathArea = (polygons: FlatPoly[]) => {
    let twiceArea = 0
    for (const { points } of polygons) for (let i = 0; i + 1 < points.length; i += 2) {
      const next = (i + 2) % points.length
      twiceArea += points[i] * points[next + 1] - points[next] * points[i + 1]
    }
    return Math.abs(twiceArea) / 2
  }
  for (const [pathIndex, match] of matches.entries()) {
    const start = match.start, end = start + match.raw.length
    const fill = solidFill(match.fill)
    if (match.protected || !isAxisAlignedTransform(match.transform) || !fill) { skipped++; continue }
    const polygons = applyTransform(flattenPath(match.d), match.transform)
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const poly of polygons) for (let i = 0; i + 1 < poly.length; i += 2) {
      x0 = Math.min(x0, poly[i]); y0 = Math.min(y0, poly[i + 1]); x1 = Math.max(x1, poly[i]); y1 = Math.max(y1, poly[i + 1])
    }
    const box: Bounds = [x0, y0, x1, y1]
    // Large silhouettes can touch almost everything, joining unrelated parts.
    // Keep them available as individual editable shapes when explicitly requested.
    if (!box.every(Number.isFinite) || x1 <= x0 || y1 <= y0) { skipped++; continue }
    const flatPolygons = polygons.map((points) => {
      let px0 = Infinity, py0 = Infinity, px1 = -Infinity, py1 = -Infinity
      for (let i = 0; i + 1 < points.length; i += 2) {
        px0 = Math.min(px0, points[i]); py0 = Math.min(py0, points[i + 1]); px1 = Math.max(px1, points[i]); py1 = Math.max(py1, points[i + 1])
      }
      return { points, bounds: [px0, py0, px1, py1] as Bounds }
    }).filter((poly) => poly.points.length >= 6)
    if (!flatPolygons.length) { skipped++; continue }
    const candidate = { start, end, pathIndex, box, center: pathCenter(flatPolygons, box), area: pathArea(flatPolygons), parentTransform: match.parentTransform, fill, polygons: flatPolygons, reorderSafe: match.reorderSafe }
    const groupingArea = strategy === 'spatial' ? candidate.area : (x1 - x0) * (y1 - y0)
    if (groupingArea > area * 0.15) {
      largeShapes.push(candidate)
      if (!includeSingletons && strategy === 'proximity') skipped++
      continue
    }
    candidates.push(candidate)
  }
  if (strategy === 'spatial') {
    const identity: Matrix = [1, 0, 0, 1, 0, 0]
    const eligible = candidates.filter((candidate) => {
      const parent = candidate.parentTransform
      const safe = !!parent && parent.every((value, index) => Math.abs(value - identity[index]) < 1e-9)
      if (!safe) skipped++
      return safe
    }).sort((a, b) => a.start - b.start)
    const largeEligible = includeSingletons ? largeShapes.filter((candidate) => {
      const parent = candidate.parentTransform
      const safe = !!parent && parent.every((value, index) => Math.abs(value - identity[index]) < 1e-9)
      if (!safe) skipped++
      return safe
    }).sort((a, b) => a.start - b.start) : []
    if (!includeSingletons) skipped += largeShapes.length
    if (!eligible.length && !largeEligible.length) return { ...fallback(), skipped: matches.length }

    // Deterministic farthest-point initialization followed by Lloyd iterations.
    // Each path remains in its original paint-order position; the resulting
    // logical group is represented by one lightweight wrapper per path.
    const recommended = Math.max(6, Math.min(32, Math.round(Math.sqrt(eligible.length) * 1.35)))
    const requested = Number.isFinite(options.regionCount) ? Math.round(options.regionCount!) : recommended
    const clusterCount = Math.min(eligible.length, Math.min(64, Math.max(2, requested)))
    const squaredDistance = (a: [number, number], b: [number, number]) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2
    const centers: [number, number][] = eligible.length ? [eligible[0].center] : []
    const seeded = new Set([0])
    while (centers.length < clusterCount) {
      let bestIndex = -1, bestDistance = -1
      for (let index = 0; index < eligible.length; index++) {
        if (seeded.has(index)) continue
        const nearest = Math.min(...centers.map((center) => squaredDistance(eligible[index].center, center)))
        if (nearest > bestDistance) { bestDistance = nearest; bestIndex = index }
      }
      if (bestIndex < 0 || bestDistance < 1e-12) break
      seeded.add(bestIndex)
      centers.push(eligible[bestIndex].center)
    }
    let partitions: Candidate[][] = []
    for (let iteration = 0; iteration < 32 && centers.length; iteration++) {
      partitions = centers.map(() => [])
      for (const candidate of eligible) {
        let bestIndex = 0, bestDistance = squaredDistance(candidate.center, centers[0])
        for (let index = 1; index < centers.length; index++) {
          const nextDistance = squaredDistance(candidate.center, centers[index])
          if (nextDistance < bestDistance) { bestDistance = nextDistance; bestIndex = index }
        }
        partitions[bestIndex].push(candidate)
      }
      let maxShift = 0
      const nextCenters = centers.map((center, index) => {
        const cluster = partitions[index]
        if (!cluster.length) return center
        const next: [number, number] = [cluster.reduce((sum, candidate) => sum + candidate.center[0], 0) / cluster.length, cluster.reduce((sum, candidate) => sum + candidate.center[1], 0) / cluster.length]
        maxShift = Math.max(maxShift, Math.sqrt(squaredDistance(center, next)))
        return next
      })
      centers.splice(0, centers.length, ...nextCenters)
      if (maxShift < 1e-4) break
    }

    const uniqueId = (base: string, used: Set<string>) => {
      let id = base, suffix = 2
      while (used.has(id) || svg.includes(`id="${id}"`) || svg.includes(`id='${id}'`)) id = `${base}-${suffix++}`
      used.add(id)
      return id
    }
    const usedIds = new Set<string>()
    const groups: NearbyGroup[] = []
    const fragments: { candidate: Candidate; wrapperId: string; groupId: string }[] = []
    const nonEmpty = [...partitions.filter((cluster) => cluster.length), ...largeEligible.map((candidate) => [candidate])].sort((a, b) => Math.min(...a.map((candidate) => candidate.start)) - Math.min(...b.map((candidate) => candidate.start)))
    const zoneFor = (bounds: Bounds): NearbyZone => {
      const cx = ((bounds[0] + bounds[2]) / 2 - viewX) / width
      const cy = ((bounds[1] + bounds[3]) / 2 - viewY) / height
      const col = cx < 1 / 3 ? 'left' : cx > 2 / 3 ? 'right' : 'center'
      const row = cy < 1 / 3 ? 'top' : cy > 2 / 3 ? 'bottom' : 'center'
      return row === 'center' ? col : col === 'center' ? row : `${row}-${col}` as NearbyZone
    }
    for (const [clusterIndex, cluster] of nonEmpty.entries()) {
      const ordered = [...cluster].sort((a, b) => a.pathIndex - b.pathIndex)
      const pathIndices = ordered.map((candidate) => candidate.pathIndex)
      const bounds: Bounds = ordered.slice(1).reduce((box, candidate) => [Math.min(box[0], candidate.box[0]), Math.min(box[1], candidate.box[1]), Math.max(box[2], candidate.box[2]), Math.max(box[3], candidate.box[3])], [...ordered[0].box] as Bounds)
      const fills = new Map<string, number>()
      for (const candidate of ordered) fills.set(candidate.fill, (fills.get(candidate.fill) ?? 0) + 1)
      const fill = [...fills].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0]
      const id = uniqueId(`rastavec-spatial-${clusterIndex + 1}`, usedIds)
      const fragmentIds = ordered.map((_, index) => uniqueId(`${id}-part-${index + 1}`, usedIds))
      const members = ordered.map((candidate) => ({ pathIndex: candidate.pathIndex, bounds: [...candidate.box] as Bounds, pivot: [(candidate.box[0] + candidate.box[2]) / 2, (candidate.box[1] + candidate.box[3]) / 2] as [number, number], fill: candidate.fill, zone: zoneFor(candidate.box) }))
      groups.push({ id, key: `spatial:${pathIndices.join(',')}`, pathIndices, count: pathIndices.length, bounds, pivot: [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2], fill, zone: zoneFor(bounds), level: 0, members, fragmentIds })
      ordered.forEach((candidate, index) => fragments.push({ candidate, wrapperId: fragmentIds[index], groupId: id }))
    }
    const chunks: string[] = []
    let cursor = 0
    for (const { candidate, wrapperId, groupId } of fragments.sort((a, b) => a.candidate.start - b.candidate.start)) {
      chunks.push(svg.slice(cursor, candidate.start))
      chunks.push(`<g id="${wrapperId}" data-rastavec-group="spatial" data-rastavec-level="0" data-rastavec-fragment-of="${groupId}">${svg.slice(candidate.start, candidate.end)}</g>`)
      cursor = candidate.end
    }
    chunks.push(svg.slice(cursor))
    return { svg: chunks.join(''), groups, considered: matches.length, skipped }
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
  type Run = { start: number; end: number; count: number; bounds: Bounds; fills: Map<string, number>; polygons: FlatPoly[][]; pathIndices: number[]; members: { pathIndex: number; bounds: Bounds; fill: string }[] }
  const runs: Run[] = []
  let current: Run | undefined
  for (const candidate of candidates) {
    const b = current && union(current.bounds, candidate.box)
    // Whitespace-only adjacency is deliberate: no other markup, parent, opacity or clip
    // can be crossed; skipped paths also break the run.
    const colorCompatible = colorMode !== 'same-color' || (!!current && current.fills.size === 1 && current.fills.has(candidate.fill))
    if (current && b && colorCompatible && current.count < MAX_PER_GROUP && /^\s*$/.test(svg.slice(current.end, candidate.start)) && close(current.bounds, candidate.box) && regionsNear(current.polygons, [candidate.polygons], distance) && (b[2] - b[0]) * (b[3] - b[1]) <= area * 0.15) {
      current.end = candidate.end; current.count++; current.bounds = b
      current.fills.set(candidate.fill, (current.fills.get(candidate.fill) ?? 0) + 1)
      current.polygons.push(candidate.polygons)
      current.pathIndices.push(candidate.pathIndex)
      current.members.push({ pathIndex: candidate.pathIndex, bounds: candidate.box, fill: candidate.fill })
    } else {
      if (current && current.count > 1) runs.push(current)
      current = { start: candidate.start, end: candidate.end, count: 1, bounds: candidate.box, fills: new Map([[candidate.fill, 1]]), polygons: [candidate.polygons], pathIndices: [candidate.pathIndex], members: [{ pathIndex: candidate.pathIndex, bounds: candidate.box, fill: candidate.fill }] }
    }
  }
  if (current && current.count > 1) runs.push(current)
  if (geometryLimit) return { ...fallback(), skipped: matches.length, limit: 'geometry-work' }
  const groupedPathIndices = new Set(runs.flatMap((run) => run.pathIndices))
  const singletonCandidates = includeSingletons
    ? [...candidates.filter((candidate) => !groupedPathIndices.has(candidate.pathIndex)), ...largeShapes].sort((a, b) => a.start - b.start)
    : []
  const singletonOverflow = singletonCandidates.length > MAX_SINGLETON_GROUPS
  if (singletonOverflow) skipped += singletonCandidates.length
  const singletonRuns: Run[] = !singletonOverflow ? singletonCandidates.map((candidate) => ({
    start: candidate.start, end: candidate.end, count: 1, bounds: candidate.box,
    fills: new Map([[candidate.fill, 1]]), polygons: [candidate.polygons],
    pathIndices: [candidate.pathIndex], members: [{ pathIndex: candidate.pathIndex, bounds: candidate.box, fill: candidate.fill }],
  })) : []
  // A second, wider pass nests nearby fine groups when they are adjacent in paint order.
  // This creates a useful coarse-to-fine outline without moving any artwork.
  type ParentRun = { start: number; end: number; count: number; bounds: Bounds; fills: Map<string, number>; children: Run[]; polygons: FlatPoly[][]; pathIndices: number[]; members: Run['members'] }
  const parentRuns: ParentRun[] = []
  const parentDistance = Math.min(Math.min(width, height) * 0.1, Math.max(distance + 1, distance * 3))
  let parent: ParentRun | undefined
  for (const run of runs) {
    const b = parent && union(parent.bounds, run.bounds)
    const colorCompatible = colorMode !== 'same-color' || (!!parent && parent.fills.size === 1 && run.fills.size === 1 && parent.fills.keys().next().value === run.fills.keys().next().value)
    if (parent && b && colorCompatible && parent.count + run.count <= MAX_PER_GROUP * 4 && /^\s*$/.test(svg.slice(parent.end, run.start)) && close(parent.bounds, run.bounds, parentDistance) && regionsNear(parent.polygons, run.polygons, parentDistance) && (b[2] - b[0]) * (b[3] - b[1]) <= area * 0.45) {
      parent.end = run.end; parent.count += run.count; parent.bounds = b; parent.children.push(run)
      parent.pathIndices.push(...run.pathIndices)
      parent.members.push(...run.members)
      for (const [fill, count] of run.fills) parent.fills.set(fill, (parent.fills.get(fill) ?? 0) + count)
      parent.polygons.push(...run.polygons)
    } else {
      if (parent && parent.children.length > 1) parentRuns.push(parent)
      // The parent accumulates paths from later runs. Copy every mutable child
      // collection so that this pass cannot mutate the already-built leaf run.
      parent = { ...run, pathIndices: [...run.pathIndices], fills: new Map(run.fills), children: [run], polygons: [...run.polygons], members: [...run.members] }
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
  const describe = (id: string, run: Pick<Run, 'count' | 'bounds' | 'fills' | 'pathIndices' | 'members'>, level: 0 | 1, parentId?: string): NearbyGroup => {
    const fill = [...run.fills].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0]
    const zoneFor = (bounds: Bounds): NearbyZone => {
      const cx = ((bounds[0] + bounds[2]) / 2 - viewX) / width
      const cy = ((bounds[1] + bounds[3]) / 2 - viewY) / height
      const col = cx < 1 / 3 ? 'left' : cx > 2 / 3 ? 'right' : 'center'
      const row = cy < 1 / 3 ? 'top' : cy > 2 / 3 ? 'bottom' : 'center'
      return row === 'center' ? col : col === 'center' ? row : `${row}-${col}` as NearbyZone
    }
    const zone = zoneFor(run.bounds)
    const key = `${level}:${run.pathIndices.join(',')}`
    const members = level === 0 ? run.members.map((member) => ({ ...member, pivot: [(member.bounds[0] + member.bounds[2]) / 2, (member.bounds[1] + member.bounds[3]) / 2] as [number, number], zone: zoneFor(member.bounds) })) : undefined
    return { id, key, pathIndices: [...run.pathIndices], count: run.count, bounds: run.bounds, pivot: [(run.bounds[0] + run.bounds[2]) / 2, (run.bounds[1] + run.bounds[3]) / 2], fill, zone, level, parentId, ...(members ? { members } : {}) }
  }
  const candidateByIndex = new Map(candidates.map((candidate) => [candidate.pathIndex, candidate]))
  const splitRunSpatially = (run: Run): [Run, Run] | null => {
    if (run.count < 4 || run.pathIndices.length !== run.count) return null
    const members = run.pathIndices.map((index) => candidateByIndex.get(index))
    if (members.some((member) => !member)) return null
    const points = members as Candidate[]
    let best: { first: Candidate[]; second: Candidate[]; score: number } | undefined
    for (const axis of [0, 1] as const) {
      const ordered = [...points].sort((a, b) => (a.box[axis] + a.box[axis + 2]) - (b.box[axis] + b.box[axis + 2]) || a.start - b.start)
      for (let cut = 2; cut <= ordered.length - 2; cut++) {
        const first = ordered.slice(0, cut), second = ordered.slice(cut)
        const center = (cluster: Candidate[]): [number, number] => [
          cluster.reduce((sum, member) => sum + (member.box[0] + member.box[2]) / 2, 0) / cluster.length,
          cluster.reduce((sum, member) => sum + (member.box[1] + member.box[3]) / 2, 0) / cluster.length,
        ]
        const firstCenter = center(first), secondCenter = center(second)
        const radius = (cluster: Candidate[], clusterCenter: [number, number]) => Math.sqrt(cluster.reduce((sum, member) => {
          const dx = (member.box[0] + member.box[2]) / 2 - clusterCenter[0]
          const dy = (member.box[1] + member.box[3]) / 2 - clusterCenter[1]
          return sum + dx * dx + dy * dy
        }, 0) / cluster.length)
        const separation = Math.hypot(firstCenter[0] - secondCenter[0], firstCenter[1] - secondCenter[1])
        const score = separation / Math.max(1, radius(first, firstCenter) + radius(second, secondCenter))
        if (!best || score > best.score) best = { first, second, score }
      }
    }
    // Keep ordinary chains intact. Split only when two compact spatial lobes
    // are clearly separated, and only when regrouping cannot change paint order.
    if (!best || best.score < 1.5) return null
    const makeRun = (cluster: Candidate[]): Run => {
      const ordered = [...cluster].sort((a, b) => a.start - b.start)
      const bounds = ordered.slice(1).reduce((value, candidate) => union(value, candidate.box), ordered[0].box)
      const fills = new Map<string, number>()
      for (const candidate of ordered) fills.set(candidate.fill, (fills.get(candidate.fill) ?? 0) + 1)
      return {
        start: ordered[0].start, end: ordered.at(-1)!.end, count: ordered.length, bounds, fills,
        polygons: ordered.map((candidate) => candidate.polygons),
        pathIndices: ordered.map((candidate) => candidate.pathIndex),
        members: ordered.map(({ pathIndex, box, fill }) => ({ pathIndex, bounds: box, fill })),
      }
    }
    const first = makeRun(best.first), second = makeRun(best.second)
    const splitArea = (cluster: Run) => (cluster.bounds[2] - cluster.bounds[0]) * (cluster.bounds[3] - cluster.bounds[1])
    if (splitArea(first) > area * 0.15 || splitArea(second) > area * 0.15) return null
    const reordered = [first, second].sort((a, b) => a.start - b.start)
    const proposed = reordered.flatMap((cluster) => cluster.pathIndices)
    const originalPosition = new Map(run.pathIndices.map((index, position) => [index, position]))
    const reorderGuard = Math.max(0.05, Math.min(0.5, distance * 0.1))
    for (let i = 0; i < proposed.length; i++) for (let j = i + 1; j < proposed.length; j++) {
      const earlier = candidateByIndex.get(proposed[i])!, later = candidateByIndex.get(proposed[j])!
      if (originalPosition.get(earlier.pathIndex)! <= originalPosition.get(later.pathIndex)!) continue
      if (!earlier.reorderSafe || !later.reorderSafe) return null
      const dx = Math.max(0, earlier.box[0] - later.box[2], later.box[0] - earlier.box[2])
      const dy = Math.max(0, earlier.box[1] - later.box[3], later.box[1] - earlier.box[3])
      if (Math.hypot(dx, dy) <= reorderGuard) return null
    }
    return [reordered[0], reordered[1]]
  }
  type Node = { group: NearbyGroup | null; run: Pick<Run, 'start' | 'end'>; children?: Node[]; spatialContainer?: boolean }
  const allLeafRuns = [...runs, ...singletonRuns]
  const leafNodes: Node[] = allLeafRuns.map((run) => ({ group: describe(makeId(), run, 0), run }))
  const spatialContainers = new Map<Node['run'], Node>()
  const spatialChildren: Node[] = []
  for (const run of runs) {
    const split = splitRunSpatially(run)
    if (!split) continue
    const children = split.map((child) => ({ group: describe(makeId(), child, 0), run: child }))
    spatialChildren.push(...children)
    spatialContainers.set(run, { group: null, run, children, spatialContainer: true })
  }
  const leafNodeByRun = new Map(leafNodes.map((node) => [node.run, node]))
  const nodes = new Map(runs.map((run) => [run, spatialContainers.get(run) ?? leafNodeByRun.get(run)!]))
  const parentNodes: Node[] = parentRuns.map((run) => {
    const id = makeId()
    const children = run.children.map((child) => nodes.get(child)!)
    for (const child of children) {
      if (child.spatialContainer) for (const member of child.children ?? []) member.group!.parentId = id
      else child.group!.parentId = id
    }
    return { group: describe(id, run, 1), run, children }
  })
  const allNodes = [
    ...leafNodes.filter((node) => !spatialContainers.has(node.run)),
    ...spatialChildren,
    ...parentNodes,
  ].sort((a, b) => a.run.start - b.run.start || b.run.end - a.run.end)
  const groups = allNodes.flatMap((node) => node.group ? [node.group] : [])
  const serialize = (start: number, end: number, children: Node[]) => {
    let cursor = start, out = ''
    for (const node of children) {
      out += svg.slice(cursor, node.run.start)
      if (node.spatialContainer) {
        out += '<g data-rastavec-order-container="spatial">'
        for (const child of node.children ?? []) {
          const group = child.group!
          out += `<g id="${group.id}" data-rastavec-group="proximity" data-rastavec-level="${group.level}">`
          out += group.pathIndices.map((pathIndex) => matches[pathIndex].raw).join('')
          out += '</g>'
        }
        out += '</g>'
      } else {
        const group = node.group!
        out += `<g id="${group.id}" data-rastavec-group="proximity" data-rastavec-level="${group.level}">`
        out += node.children ? serialize(node.run.start, node.run.end, node.children) : svg.slice(node.run.start, node.run.end)
        out += '</g>'
      }
      cursor = node.run.end
    }
    return out + svg.slice(cursor, end)
  }
  const parentedRuns = new Set(parentRuns.flatMap((run) => run.children))
  const rootNodes = leafNodes.filter((node) => !parentedRuns.has(node.run as Run)).map((node) => spatialContainers.get(node.run) ?? node)
  const topNodes = [...rootNodes, ...parentNodes].sort((a, b) => a.run.start - b.run.start)
  return { svg: groups.length ? serialize(0, svg.length, topNodes) : svg, groups, considered: matches.length, skipped, ...(singletonOverflow ? { limit: 'singleton-count' as const } : {}) }
}
