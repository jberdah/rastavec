// Share of an SVG painted by what the engine recovered as objects rather than plain outlines:
// gradient-painted paths and exact circles / ellipses. The Auto-Tune score rewards it, since
// those are what a user can edit by their parameters afterwards.
import { flattenPath } from './palette'
import type { EngineShapeHint } from './types'

const VIEW_BOX = /\bviewBox="[-\d.]+[ ,]+[-\d.]+[ ,]+([\d.]+)[ ,]+([\d.]+)"/
const PATH_DATA = /<path\b[^>]*\bd="([^"]*)"/g

/** Area of a path: its first ring minus the following ones (holes), which is how traces are built. */
function pathArea(d: string): number {
  let area = 0, first = true
  for (const points of flattenPath(d)) {
    let ring = 0
    for (let k = 0; k + 1 < points.length; k += 2) {
      const next = (k + 2) % points.length
      ring += points[k] * points[next + 1] - points[next] * points[k + 1]
    }
    area += (first ? 1 : -1) * Math.abs(ring) / 2
    first = false
  }
  return Math.max(0, area)
}

/** 0-1. Translucent overlays are skipped: they sit on a shape that is already counted. */
export function editableShare(svg: string, shapes: EngineShapeHint[] | undefined): number {
  const hints = (shapes ?? []).filter((hint) => hint.overlayOf === undefined && (hint.kind !== 'path' || hint.gradient))
  if (!hints.length) return 0
  const view = VIEW_BOX.exec(svg)
  if (!view) return 0
  const total = Number(view[1]) * Number(view[2])
  if (!(total > 0)) return 0
  let tags: RegExpMatchArray[] | undefined
  let area = 0
  for (const hint of hints) {
    if (hint.kind === 'circle') area += Math.PI * (hint.r ?? 0) ** 2
    else if (hint.kind === 'ellipse') area += Math.PI * (hint.rx ?? 0) * (hint.ry ?? 0)
    else if (hint.kind === 'crescent') area += crescentArea(hint.r ?? 0, hint.innerR ?? 0, Math.hypot((hint.innerCx ?? 0) - (hint.cx ?? 0), (hint.innerCy ?? 0) - (hint.cy ?? 0)))
    else {
      tags ??= [...svg.matchAll(PATH_DATA)]
      const d = tags[hint.index]?.[1]
      if (d) area += pathArea(d)
    }
  }
  return Math.min(1, area / total)
}

/** Area of the outer disc minus its overlap with the inner one (circles `d` apart). */
function crescentArea(r: number, ir: number, d: number): number {
  if (d >= r + ir) return Math.PI * r * r
  if (d <= Math.abs(r - ir)) return Math.max(0, Math.PI * (r * r - Math.min(r, ir) ** 2))
  const a = r * r * Math.acos((d * d + r * r - ir * ir) / (2 * d * r))
  const b = ir * ir * Math.acos((d * d + ir * ir - r * r) / (2 * d * ir))
  const c = 0.5 * Math.sqrt((-d + r + ir) * (d + r - ir) * (d - r + ir) * (d + r + ir))
  return Math.PI * r * r - (a + b - c)
}
