// Carry reviewed groups onto an edited SVG.
//
// Groups reference paths by position (`pathIndices`) and their markup is the source SVG with
// <g> wrappers added. A shape edit or a palette filter rewrites path data, fills and gradient
// stops, but keeps every path in place: the groups still describe the same artwork, so they are
// re-applied to the edited SVG instead of being dropped. When the edit changed the structure
// (a path dropped, added or moved, other markup changed), positions no longer mean the same thing
// and the grouping cannot be carried.
//
// This runs on every tick of a colour slider, so the common case (only colours changed) must stay
// cheap on SVGs with thousands of paths: parsed SVGs are cached, the grouped markup is kept as a
// template (the text between paths, plus which path goes in each slot) so it is never re-parsed,
// and path geometry is only re-measured for paths whose data actually changed.
import type { GroupingMetadata } from './types'
import { parsePathTags, pathBounds, solidFillResolver, svgFingerprint, type ParsedPath } from './group-nearby'

type Bounds = [number, number, number, number]
type Group = GroupingMetadata['groups'][number]
const GRADIENT = /<(linearGradient|radialGradient)\b[^>]*\bid="([^"]+)"[^>]*>[\s\S]*?<\/\1>/g

/** Work counters, for tests: how many paths had to be flattened to re-measure them. */
export const carryStats = { flattened: 0 }

const decode = (value: string) => value
  .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
  .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(Number(dec)))
  .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
/** A path element's identity, independent of attribute order and serializer escaping or whitespace. */
export function pathKey(raw: string): string {
  return [...raw.matchAll(/\b([A-Za-z][\w:.-]*)="([^"]*)"/g)].map((a) => `${a[1]}=${decode(a[2])}`).sort().join('\u0001')
}

interface Parsed { paths: ParsedPath[]; skeleton: string; gradients: Map<string, string>; fill: (fill: string | null) => string | null }
// The SVG before an edit is the SVG after the previous one: keep the last few parses.
const parsedCache = new Map<string, Parsed>()
function parse(svg: string): Parsed {
  const hit = parsedCache.get(svg)
  if (hit) { parsedCache.delete(svg); parsedCache.set(svg, hit); return hit }
  const paths = parsePathTags(svg)
  // Everything that is not a path or a gradient definition: what an edit must leave untouched.
  let skeleton = '', cursor = 0
  for (const path of paths) { skeleton += svg.slice(cursor, path.start) + '\u0000'; cursor = path.start + path.raw.length }
  skeleton = (skeleton + svg.slice(cursor)).replace(GRADIENT, (_m, _kind: string, id: string) => `\u0002${id}\u0002`)
  const gradients = new Map<string, string>()
  for (const match of svg.matchAll(GRADIENT)) gradients.set(match[2], match[0])
  const parsed = { paths, skeleton, gradients, fill: solidFillResolver(svg) }
  parsedCache.set(svg, parsed)
  if (parsedCache.size > 4) parsedCache.delete(parsedCache.keys().next().value!)
  return parsed
}

/** The grouped markup as text between paths (`segments`) and the source path in each slot (`order`). */
interface Template { segments: string[]; order: number[] }
const templates = new WeakMap<GroupingMetadata, Template>()
function templateOf(grouping: GroupingMetadata, old: ParsedPath[]): Template | null {
  const known = templates.get(grouping)
  if (known) return known
  // Each path of the grouped markup is one of the old SVG's paths, in document order except where
  // the grouping pass reordered separated clusters: identify it by its markup or, when a browser
  // re-serialized it, by its attributes.
  const grouped = parsePathTags(grouping.svg)
  if (grouped.length !== old.length) return null
  const match = (key: (raw: string) => string): Template | null => {
    const positions = new Map<string, number[]>()
    old.forEach((path, position) => {
      const k = key(path.raw)
      const list = positions.get(k)
      if (list) list.push(position); else positions.set(k, [position])
    })
    const segments: string[] = [], order: number[] = []
    let cursor = 0
    for (const path of grouped) {
      const position = positions.get(key(path.raw))?.shift()
      if (position === undefined) return null
      segments.push(grouping.svg.slice(cursor, path.start))
      order.push(position)
      cursor = path.start + path.raw.length
    }
    segments.push(grouping.svg.slice(cursor))
    return { segments, order }
  }
  return match((raw) => raw) ?? match(pathKey)
}

const center = (box: Bounds): [number, number] => [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2]
const union = (a: Bounds, b: Bounds): Bounds => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]
const sameMatrix = (a: ParsedPath['transform'], b: ParsedPath['transform']) => a === b || (!!a && !!b && a.every((value, index) => value === b[index]))

/**
 * The grouping re-applied to `newSvg`, given the SVG it was made for (`oldSvg`).
 * Returns the grouping unchanged when the SVG did not change, and null when it cannot be carried.
 */
export function carryGrouping(grouping: GroupingMetadata, oldSvg: string, newSvg: string): GroupingMetadata | null {
  if (grouping.sourceHash !== svgFingerprint(oldSvg)) return null
  if (oldSvg === newSvg) return grouping
  // Nothing references a path: the markup is just the new SVG.
  if (!grouping.groups.length) return { ...grouping, sourceHash: svgFingerprint(newSvg), svg: newSvg }
  const before = parse(oldSvg), after = parse(newSvg)
  const oldPaths = before.paths, newPaths = after.paths
  if (oldPaths.length !== newPaths.length || before.skeleton !== after.skeleton) return null
  const template = templateOf(grouping, oldPaths)
  if (!template) return null

  // What changed, path by path. Geometry is re-measured only where the path data changed.
  const geometryChanged = newPaths.map((path, index) => path.d !== oldPaths[index].d || !sameMatrix(path.transform, oldPaths[index].transform))
  const newFill = newPaths.map((path) => after.fill(path.fill))
  const fillChanged = newFill.map((fill, index) => fill !== before.fill(oldPaths[index].fill))
  const boxes = new Map<number, Bounds | null>()
  const box = (index: number) => {
    if (!boxes.has(index)) { carryStats.flattened++; boxes.set(index, pathBounds(newPaths[index])) }
    return boxes.get(index)!
  }

  const pivotUpdates = new Map<string, [number, number]>()
  const groups = grouping.groups.map((group): Group => {
    const moved = group.pathIndices.some((index) => geometryChanged[index])
    const recoloured = group.pathIndices.some((index) => fillChanged[index])
    if (!moved && !recoloured) return group
    const counts = new Map<string, number>()
    for (const index of group.pathIndices) { const fill = newFill[index]; if (fill) counts.set(fill, (counts.get(fill) ?? 0) + 1) }
    const fill = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? group.fill
    if (!moved) {
      // Colours only: geometry, bounds and pivots stay as they are.
      const members = group.members?.map((member) => fillChanged[member.pathIndex] ? { ...member, fill: newFill[member.pathIndex] ?? member.fill } : member)
      return { ...group, fill, ...(members ? { members } : {}) }
    }
    // Geometry follows the paths; a pivot moves with its shape's centre, so a pivot the user placed
    // keeps its place on the shape, unless the group's annotations are protected.
    const memberBox = new Map(group.members?.map((member) => [member.pathIndex, member.bounds]) ?? [])
    const boxesOf = group.pathIndices.map((index) => geometryChanged[index] || !memberBox.has(index) ? box(index) : memberBox.get(index)!).filter((b): b is Bounds => !!b)
    const bounds = boxesOf.length ? boxesOf.slice(1).reduce(union, boxesOf[0]) : group.bounds
    const [ox, oy] = center(group.bounds), [nx, ny] = center(bounds)
    const pivot: [number, number] = group.locked ? group.pivot : [group.pivot[0] + nx - ox, group.pivot[1] + ny - oy]
    if (pivot[0] !== group.pivot[0] || pivot[1] !== group.pivot[1]) for (const id of group.fragmentIds?.length ? group.fragmentIds : [group.id]) pivotUpdates.set(id, pivot)
    const members = group.members?.map((member) => {
      const next = geometryChanged[member.pathIndex] ? box(member.pathIndex) : null
      const memberFill = newFill[member.pathIndex] ?? member.fill
      if (!next) return fillChanged[member.pathIndex] ? { ...member, fill: memberFill } : member
      const [mx, my] = center(member.bounds), [qx, qy] = center(next)
      return { ...member, bounds: next, pivot: [member.pivot[0] + qx - mx, member.pivot[1] + qy - my] as [number, number], fill: memberFill }
    })
    return { ...group, bounds, pivot, fill, ...(members ? { members } : {}) }
  })

  // Gradient definitions (stops recoloured, coordinates moved with their shape) follow the edit, and
  // the exported markup carries each group's pivot as attributes.
  const changedGradients = new Map([...after.gradients].filter(([id, markup]) => before.gradients.get(id) !== markup))
  let segments = template.segments
  if (changedGradients.size || pivotUpdates.size) {
    let replaced = 0
    segments = segments.map((segment) => {
      let text = segment
      if (changedGradients.size) text = text.replace(GRADIENT, (whole, _kind: string, id: string) => {
        const markup = changedGradients.get(id)
        if (markup === undefined) return whole
        replaced++
        return markup
      })
      if (pivotUpdates.size) text = text.replace(/<g\b[^>]*>/g, (tag) => {
        const id = /\bid="([^"]*)"/.exec(tag)?.[1]
        const pivot = id === undefined ? undefined : pivotUpdates.get(decode(id))
        if (!pivot) return tag
        return tag
          .replace(/(\bdata-rastavec-pivot-x=")[^"]*(")/, (_m, head: string, tail: string) => head + pivot[0] + tail)
          .replace(/(\bdata-rastavec-pivot-y=")[^"]*(")/, (_m, head: string, tail: string) => head + pivot[1] + tail)
      })
      return text
    })
    if (replaced < changedGradients.size) return null
  }
  let svg = segments[0]
  for (let slot = 0; slot < template.order.length; slot++) svg += newPaths[template.order[slot]].raw + segments[slot + 1]
  const carried: GroupingMetadata = { ...grouping, sourceHash: svgFingerprint(newSvg), svg, groups }
  templates.set(carried, { segments, order: template.order })
  return carried
}
