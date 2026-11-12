import type { RGBAImage } from './core'

/** Bound an unsimplified recovery trial to small, exact-palette sprites with thin detail. */
export function needsHardEdgeReview(src: RGBAImage): boolean {
  const { width, height, data } = src
  if (width * height > 65536 || width < 1 || height < 1 || data.length !== width * height * 4) return false
  const colors = new Set<number>()
  let visible = 0, transparent = 0, boundary = 0
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4, alpha = data[i + 3]
    if (alpha === 0) { transparent++; continue }
    if (alpha !== 255) return false
    visible++
    const color = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2]
    colors.add(color)
    if (colors.size > 64) return false
    if ([[-1, 0], [1, 0], [0, -1], [0, 1]].some(([dx, dy]) => {
      const nx = x + dx, ny = y + dy, j = (ny * width + nx) * 4
      return nx < 0 || nx >= width || ny < 0 || ny >= height || data[j + 3] !== 255
        || data[j] !== data[i] || data[j + 1] !== data[i + 1] || data[j + 2] !== data[i + 2]
    })) boundary++
  }
  return transparent > 0 && visible > 0 && boundary / visible >= 0.2
}
