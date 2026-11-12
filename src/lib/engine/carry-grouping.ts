// Carry reviewed groups onto an edited SVG.
//
// Groups reference paths by position (`pathIndices`) and their markup is the source SVG with
// <g> wrappers added. A shape edit or a palette filter rewrites path data, fills and gradient
// stops, but keeps every path in place: the groups still describe the same artwork, so they are
// re-applied to the edited SVG instead of being dropped. When the edit changed the structure
// (a path dropped, added or moved, other markup changed), positions no longer mean the same thing
// and the grouping cannot be carried.
import type { GroupingMetadata } from './types'
import { parsePathTags, pathBounds, solidFillResolver, svgFingerprint, type ParsedPath } from './group-nearby'

type Bounds = [number, number, number, number]
const GRADIENT = /<(linearGradient|radialGradient)\b[^>]*\bid="([^"]+)"[^>]*>[\s\S]*?<\/\1>/g

const decode = (value: string) => value.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
/** A path element's identity, independent of attribute order and serializer whitespace. */
function pathKey(raw: string): string {
  return [...raw.matchAll(/\b([A-Za-z][\w:.-]*)="([^"]*)"/g)].map((a) => `${a[1]}=${decode(a[2])}`).sort().join('\u0001')
}

/** Everything that is not a path or a gradient definition: what an edit must leave untouched. */
function skeleton(svg: string, paths: ParsedPath[]): string {
  let out = '', cursor = 0
  for (const path of paths) { out += svg.slice(cursor, path.start) + '\u0000'; cursor = path.start + path.raw.length }
  out += svg.slice(cursor)
  return out.replace(GRADIENT, (_m, _kind: string, id: string) => `\u0002${id}\u0002`)
}

function gradients(svg: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const match of svg.matchAll(GRADIENT)) map.set(match[2], match[0])
  return map
}

const center = (box: Bounds): [number, number] => [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2]
const union = (a: Bounds, b: Bounds): Bounds => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]
const sameBox = (a: Bounds, b: Bounds) => a.every((value, index) => value === b[index])
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The grouping re-applied to `newSvg`, given the SVG it was made for (`oldSvg`).
 * Returns the grouping unchanged when the SVG did not change, and null when it cannot be carried.
 */
export function carryGrouping(grouping: GroupingMetadata, oldSvg: string, newSvg: string): GroupingMetadata | null {
  if (grouping.sourceHash !== svgFingerprint(oldSvg)) return null
  if (oldSvg === newSvg) return grouping
  const oldPaths = parsePathTags(oldSvg), newPaths = parsePathTags(newSvg)
  if (oldPaths.length !== newPaths.length || skeleton(oldSvg, oldPaths) !== skeleton(newSvg, newPaths)) return null

  // Each path of the grouped markup is one of the old SVG's paths, in document order except where
  // the grouping pass reordered separated clusters: identify it by its attributes.
  const byKey = new Map<string, number[]>()
  oldPaths.forEach((path, index) => {
    const key = pathKey(path.raw)
    const list = byKey.get(key)
    if (list) list.push(index); else byKey.set(key, [index])
  })
  const groupedPaths = parsePathTags(grouping.svg)
  if (groupedPaths.length !== oldPaths.length) return null
  let svg = '', cursor = 0
  for (const path of groupedPaths) {
    const index = byKey.get(pathKey(path.raw))?.shift()
    if (index === undefined) return null
    svg += grouping.svg.slice(cursor, path.start) + newPaths[index].raw
    cursor = path.start + path.raw.length
  }
  svg += grouping.svg.slice(cursor)
  // Gradient definitions (stops recoloured, coordinates moved with their shape) follow the edit too.
  const oldGradients = gradients(oldSvg), newGradients = gradients(newSvg)
  const changed = [...newGradients].filter(([id, markup]) => oldGradients.get(id) !== markup)
  if (changed.length) {
    const grouped = gradients(svg)
    for (const [id, markup] of changed) {
      const current = grouped.get(id)
      if (current === undefined) return null
      svg = svg.replace(current, () => markup)
    }
  }

  // Geometry and colour of the groups follow their paths. A group's pivot moves with its centre,
  // so a pivot the user placed keeps its place on the shape.
  const resolveOld = solidFillResolver(oldSvg), resolveNew = solidFillResolver(newSvg)
  const oldBoxes = oldPaths.map(pathBounds), newBoxes = newPaths.map(pathBounds)
  const fillOf = (index: number, fallback: string) => resolveNew(newPaths[index].fill) ?? fallback
  const pivotUpdates = new Map<string, [number, number]>()
  const groups = grouping.groups.map((group) => {
    const touched = group.pathIndices.some((index) => {
      const before = oldBoxes[index], after = newBoxes[index]
      return !before !== !after || (before && after && !sameBox(before, after)) || resolveOld(oldPaths[index]?.fill) !== resolveNew(newPaths[index]?.fill)
    })
    if (!touched) return group
    const boxes = group.pathIndices.map((index) => newBoxes[index]).filter((box): box is Bounds => !!box)
    const bounds = boxes.length ? boxes.slice(1).reduce(union, boxes[0]) : group.bounds
    const [ox, oy] = center(group.bounds), [nx, ny] = center(bounds)
    const pivot: [number, number] = [group.pivot[0] + nx - ox, group.pivot[1] + ny - oy]
    if (pivot[0] !== group.pivot[0] || pivot[1] !== group.pivot[1]) for (const id of group.fragmentIds?.length ? group.fragmentIds : [group.id]) pivotUpdates.set(id, pivot)
    const counts = new Map<string, number>()
    for (const index of group.pathIndices) { const fill = resolveNew(newPaths[index]?.fill ?? null); if (fill) counts.set(fill, (counts.get(fill) ?? 0) + 1) }
    const fill = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? group.fill
    const members = group.members?.map((member) => {
      const box = newBoxes[member.pathIndex]
      return box ? { ...member, bounds: box, pivot: center(box), fill: fillOf(member.pathIndex, member.fill) } : member
    })
    return { ...group, bounds, pivot, fill, ...(members ? { members } : {}) }
  })
  // The exported markup carries each group's pivot as attributes.
  for (const [id, [x, y]] of pivotUpdates) {
    svg = svg.replace(new RegExp(`<g\\b[^>]*\\bid="${escapeRegExp(id)}"[^>]*>`), (tag) => tag
      .replace(/(\bdata-rastavec-pivot-x=")[^"]*(")/, (_m, head: string, tail: string) => head + x + tail)
      .replace(/(\bdata-rastavec-pivot-y=")[^"]*(")/, (_m, head: string, tail: string) => head + y + tail))
  }
  return { ...grouping, sourceHash: svgFingerprint(newSvg), svg, groups }
}
