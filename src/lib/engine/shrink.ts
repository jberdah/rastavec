import type { RGBAImage } from './core'

/**
 * Box-filtered copy reduced by an integer factor, colours weighted by alpha. Each output pixel
 * averages its share of source pixels, so sides smaller than the factor (or not a multiple of
 * it) neither read past a row nor drop the remainder.
 */
export function shrink(src: RGBAImage, factor: number): RGBAImage {
  if (factor <= 1) return src
  const width = Math.max(1, Math.floor(src.width / factor)), height = Math.max(1, Math.floor(src.height / factor))
  const data = new Uint8ClampedArray(width * height * 4)
  const d = src.data
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * src.height / height), y1 = Math.floor((y + 1) * src.height / height)
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * src.width / width), x1 = Math.floor((x + 1) * src.width / width)
      let r = 0, g = 0, b = 0, a = 0
      for (let sy = y0; sy < y1; sy++) {
        for (let i = (sy * src.width + x0) * 4, end = (sy * src.width + x1) * 4; i < end; i += 4) {
          const w = d[i + 3]
          r += d[i] * w; g += d[i + 1] * w; b += d[i + 2] * w; a += w
        }
      }
      if (!a) continue
      const o = (y * width + x) * 4
      data[o] = r / a; data[o + 1] = g / a; data[o + 2] = b / a; data[o + 3] = a / ((x1 - x0) * (y1 - y0))
    }
  }
  return { width, height, data }
}
