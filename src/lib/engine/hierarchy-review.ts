import type { RGBAImage } from './core'

/** Touching differently painted translucent regions can reveal hidden stacked fills.
 * Ignore almost invisible pixels and tiny isolated fringes. Scan only right/down
 * neighbours, in source resolution, without allocating another image.
 */
export function needsHierarchyReview({ data, width, height }: RGBAImage): boolean {
  let boundaries = 0
  const required = Math.max(4, Math.ceil(Math.sqrt(width * height) / 8))
  const differs = (a: number, b: number) => {
    const aa = data[a + 3], ba = data[b + 3]
    if (aa < 16 || ba < 16 || (aa >= 240 && ba >= 240)) return false
    return Math.max(Math.abs(data[a] - data[b]), Math.abs(data[a + 1] - data[b + 1]), Math.abs(data[a + 2] - data[b + 2])) >= 24
      || Math.abs(aa - ba) >= 24
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 4
    if ((x + 1 < width && differs(offset, offset + 4)) || (y + 1 < height && differs(offset, offset + width * 4))) {
      if (++boundaries >= required) return true
    }
  }
  return false
}
