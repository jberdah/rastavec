// Turns the shapes the engine recognised into animation groups.
//
// Animation works on groups (a <g> with a pivot). Nearby-path grouping is a geometric guess
// that the user has to run and review; a recognised circle, ellipse or gradient region is
// already a known object, so it can become a group as is: the shape's path, together with the
// translucent overlays the engine painted over it, pivoting on its centre.
import { svgFingerprint, type NearbyZone } from './group-nearby'
import type { EngineShapeHint, GroupingMetadata } from './types'

type Bounds = [number, number, number, number]

/** Mean stop colour of a gradient, as the group's display colour. */
function gradientColour(svg: string, id: string): string {
  const block = new RegExp(`<(linearGradient|radialGradient)\\b[^>]*\\bid="${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>[\\s\\S]*?</\\1>`).exec(svg)?.[0] ?? ''
  const stops = [...block.matchAll(/\bstop-color="#([0-9a-fA-F]{6})"/g)].map((stop) => stop[1])
  if (!stops.length) return '#808080'
  const mean = [0, 2, 4].map((offset) => Math.round(stops.reduce((sum, hex) => sum + parseInt(hex.slice(offset, offset + 2), 16), 0) / stops.length))
  return `#${mean.map((value) => value.toString(16).padStart(2, '0')).join('')}`
}

/**
 * Build grouping metadata with one group per recognised shape. `svg` must be the SVG the hints
 * describe (same paths in the same order). Returns `null` when nothing can be grouped.
 */
export function groupsFromShapes(
  svg: string,
  hints: EngineShapeHint[],
  name: (hint: EngineShapeHint, ordinal: number) => string,
): GroupingMetadata | null {
  if (/<g\b[^>]*\bdata-rastavec-group=/.test(svg)) return null
  const view = svg.match(/<svg\b[^>]*\bviewBox="\s*([-+\d.eE]+)[\s,]+([-+\d.eE]+)[\s,]+([-+\d.eE]+)[\s,]+([-+\d.eE]+)\s*"/)
  if (!view) return null
  const [viewX, viewY, width, height] = view.slice(1).map(Number)
  if (!(width > 0 && height > 0)) return null
  const tags = [...svg.matchAll(/<path\b[^>]*\/>/g)]
  const byIndex = new Map(hints.map((hint) => [hint.index, hint]))
  const zoneFor = (bounds: Bounds): NearbyZone => {
    const cx = ((bounds[0] + bounds[2]) / 2 - viewX) / width, cy = ((bounds[1] + bounds[3]) / 2 - viewY) / height
    const col = cx < 1 / 3 ? 'left' : cx > 2 / 3 ? 'right' : 'center'
    const row = cy < 1 / 3 ? 'top' : cy > 2 / 3 ? 'bottom' : 'center'
    return row === 'center' ? col : col === 'center' ? row : `${row}-${col}` as NearbyZone
  }
  const fillOf = (index: number) => {
    const fill = /\bfill="([^"]*)"/.exec(tags[index][0])?.[1] ?? ''
    const reference = /^url\(#([^)]+)\)$/.exec(fill)
    return reference ? gradientColour(svg, reference[1]) : /^#[0-9a-fA-F]{6}$/.test(fill) ? fill.toLowerCase() : '#808080'
  }

  const groups: GroupingMetadata['groups'] = []
  const runs: { start: number; end: number; id: string }[] = []
  for (const hint of [...hints].sort((a, b) => a.index - b.index)) {
    if (hint.overlayOf !== undefined || !tags[hint.index]) continue
    // The shape and the overlays painted right after it.
    const pathIndices = [hint.index]
    for (let next = hint.index + 1; byIndex.get(next)?.overlayOf === hint.index && tags[next]; next++) pathIndices.push(next)
    const bounds = pathIndices.reduce<Bounds>((box, index) => {
      const b = byIndex.get(index)!.bounds
      return [Math.min(box[0], b[0]), Math.min(box[1], b[1]), Math.max(box[2], b[2]), Math.max(box[3], b[3])]
    }, [...hint.bounds])
    const centre = (b: Bounds): [number, number] => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]
    const id = `rastavec-shape-${groups.length + 1}`
    if (svg.includes(`id="${id}"`)) return null
    groups.push({
      id, key: `shape:${pathIndices.join(',')}`, pathIndices, count: pathIndices.length, bounds,
      fill: fillOf(hint.index), zone: zoneFor(bounds), level: 0,
      name: name(hint, groups.length + 1),
      pivot: hint.cx !== undefined && hint.cy !== undefined ? [hint.cx, hint.cy] : centre(bounds),
      members: pathIndices.map((index) => {
        const b = byIndex.get(index)!.bounds
        return { pathIndex: index, bounds: [...b] as Bounds, pivot: centre(b), fill: fillOf(index), zone: zoneFor(b) }
      }),
    })
    const first = tags[pathIndices[0]], last = tags[pathIndices[pathIndices.length - 1]]
    runs.push({ start: first.index!, end: last.index! + last[0].length, id })
  }
  if (!groups.length) return null

  const chunks: string[] = []
  let cursor = 0
  for (const run of runs) {
    chunks.push(svg.slice(cursor, run.start), `<g id="${run.id}" data-rastavec-group="shape" data-rastavec-level="0">`, svg.slice(run.start, run.end), '</g>')
    cursor = run.end
  }
  chunks.push(svg.slice(cursor))
  const grouped = groups.reduce((count, group) => count + group.count, 0)
  return {
    sourceHash: svgFingerprint(svg), distance: 0, colorMode: 'proximity', strategy: 'proximity',
    considered: grouped, skipped: tags.length - grouped, svg: chunks.join(''), groups,
  }
}
