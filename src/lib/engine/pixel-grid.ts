import type { RGBAImage } from './core'

/** Hard limits for a bounded, editable pixel-grid candidate. */
const MAX_PIXELS = 16384
const MAX_SIDE = 128
// Shaded sprites use many near shades: a 32 x 32 wizard has 274. Size stays bounded by the
// pixel and segment limits.
const MAX_COLORS = 1024
const MAX_SEGMENTS = 8192

/**
 * Return an exact per-pixel vector, or null when it would be too complex.
 * Horizontal runs are merged vertically and emitted as individual path elements.
 * Transparent pixels do not need shapes. Groups retain opacity so palette editing
 * can still address the inner, ordinary filled paths.
 */
export function tracePixelGrid(src: RGBAImage): string | null {
  const { width: w, height: h, data } = src
  if (w < 1 || h < 1 || w > MAX_SIDE || h > MAX_SIDE || w * h > MAX_PIXELS || data.length !== w * h * 4) return null
  type Run = { x: number; y: number; w: number; h: number; rgba: string }
  const completed: Run[] = []
  let active = new Map<string, Run>()
  const colors = new Set<string>()
  for (let y = 0; y < h; y++) {
    const next = new Map<string, Run>()
    let x = 0
    while (x < w) {
      const i = (y * w + x) * 4
      if (data[i + 3] === 0) { x++; continue }
      const rgba = Array.from(data.subarray(i, i + 4), (v) => v.toString(16).padStart(2, '0')).join('')
      colors.add(rgba)
      if (colors.size > MAX_COLORS) return null
      const start = x++
      while (x < w) {
        const j = (y * w + x) * 4
        if (data[j] !== data[i] || data[j + 1] !== data[i + 1] || data[j + 2] !== data[i + 2] || data[j + 3] !== data[i + 3]) break
        x++
      }
      const key = `${start}:${x - start}:${rgba}`
      const run = active.get(key)
      if (run) { run.h++; active.delete(key); next.set(key, run) }
      else next.set(key, { x: start, y, w: x - start, h: 1, rgba })
    }
    completed.push(...active.values())
    if (completed.length + next.size > MAX_SEGMENTS) return null
    active = next
  }
  completed.push(...active.values())
  if (completed.length > MAX_SEGMENTS) return null
  const body = completed.map((r) => {
    const alpha = parseInt(r.rgba.slice(6), 16)
    const path = `<path d="M${r.x} ${r.y}h${r.w}v${r.h}h-${r.w}z" fill="#${r.rgba.slice(0, 6)}"/>`
    return alpha === 255 ? path : `<g opacity="${(alpha / 255).toFixed(6)}">${path}</g>`
  }).join('\n')
  return `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges">\n${body}\n</svg>\n`
}
