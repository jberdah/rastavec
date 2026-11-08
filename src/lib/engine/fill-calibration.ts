import type { RGBAImage } from './core'

const MIN_SAMPLES = 20
const MAX_SHIFT = 6
const MAX_CHANNEL_SPREAD = 10
const MIN_UNIFORM_SHARE = 0.85
const PALETTE_BUCKETS = 1 << 15
const MIN_PALETTE_COLOR_PIXELS = 20
const MIN_PALETTE_COLOR_SHARE = 0.00005
const MAX_PALETTE_CANDIDATES = 48
const PALETTE_MERGE_DISTANCE = 12
const MAX_PALETTE_SNAP_DISTANCE = 18

interface ColorStats {
  count: number
  red: Uint32Array
  green: Uint32Array
  blue: Uint32Array
}

export interface FillCalibration {
  svg: string
  changedFills: number
}

interface PaletteColor {
  red: number
  green: number
  blue: number
  count: number
}

const colorKey = (r: number, g: number, b: number) => (r << 16) | (g << 8) | b

function hexColor(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

function channelMedian(histogram: Uint32Array, count: number): number {
  const target = Math.floor((count - 1) / 2)
  let cumulative = 0
  for (let value = 0; value < histogram.length; value++) {
    cumulative += histogram[value]
    if (cumulative > target) return value
  }
  return 0
}

/**
 * Correct small, consistent fill-color shifts against the source raster. This keeps
 * traced geometry intact and ignores antialiased/transparent pixels and mixed-color fills.
 */
export function calibrateSolidFills(svg: string, source: RGBAImage, rendered: RGBAImage): FillCalibration {
  if (source.width !== rendered.width || source.height !== rendered.height) return { svg, changedFills: 0 }

  const fillPattern = /\bfill=(['"])#([0-9a-fA-F]{6})\1/g
  const fillColors = new Map<number, string>()
  for (const match of svg.matchAll(fillPattern)) {
    const hex = match[2].toLowerCase()
    const rgb = Number.parseInt(hex, 16)
    fillColors.set(rgb, `#${hex}`)
  }
  if (!fillColors.size || fillColors.size > 256) return { svg, changedFills: 0 }

  const stats = new Map<number, ColorStats>()
  for (const rgb of fillColors.keys()) {
    stats.set(rgb, { count: 0, red: new Uint32Array(256), green: new Uint32Array(256), blue: new Uint32Array(256) })
  }

  const src = source.data
  const out = rendered.data
  for (let i = 0; i < src.length; i += 4) {
    if (src[i + 3] < 250 || out[i + 3] < 250) continue
    const sample = stats.get(colorKey(out[i], out[i + 1], out[i + 2]))
    if (!sample) continue
    sample.count++
    sample.red[src[i]]++
    sample.green[src[i + 1]]++
    sample.blue[src[i + 2]]++
  }

  const medians = new Map<number, [number, number, number]>()
  for (const [rgb, sample] of stats) {
    if (sample.count < MIN_SAMPLES) continue
    const median: [number, number, number] = [
      channelMedian(sample.red, sample.count),
      channelMedian(sample.green, sample.count),
      channelMedian(sample.blue, sample.count),
    ]
    const current: [number, number, number] = [(rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255]
    const shift = Math.hypot(median[0] - current[0], median[1] - current[1], median[2] - current[2])
    if (shift > 0 && shift <= MAX_SHIFT) medians.set(rgb, median)
  }
  if (!medians.size) return { svg, changedFills: 0 }

  const uniform = new Map<number, number>()
  const eligible = new Map<number, number>()
  for (let i = 0; i < src.length; i += 4) {
    if (src[i + 3] < 250 || out[i + 3] < 250) continue
    const rgb = colorKey(out[i], out[i + 1], out[i + 2])
    const median = medians.get(rgb)
    if (!median) continue
    eligible.set(rgb, (eligible.get(rgb) ?? 0) + 1)
    if (
      Math.max(Math.abs(src[i] - median[0]), Math.abs(src[i + 1] - median[1]), Math.abs(src[i + 2] - median[2]))
      <= MAX_CHANNEL_SPREAD
    ) uniform.set(rgb, (uniform.get(rgb) ?? 0) + 1)
  }

  const replacements = new Map<string, string>()
  for (const [rgb, median] of medians) {
    const count = eligible.get(rgb) ?? 0
    if (count && (uniform.get(rgb) ?? 0) / count >= MIN_UNIFORM_SHARE) {
      replacements.set(fillColors.get(rgb)!, hexColor(...median))
    }
  }
  if (!replacements.size) return { svg, changedFills: 0 }

  const corrected = svg.replace(fillPattern, (attribute, quote: string, hex: string) => {
    const replacement = replacements.get(`#${hex.toLowerCase()}`)
    return replacement ? `fill=${quote}${replacement}${quote}` : attribute
  })
  return { svg: corrected, changedFills: replacements.size }
}

/**
 * Snap traced fills to frequent opaque source colors. This is useful for flat vector
 * artwork whose raster edges introduce many nearly-identical fringe colors. The caller
 * must compare the result against the unmodified SVG before retaining it.
 */
export function snapSolidFillsToSourcePalette(svg: string, source: RGBAImage): FillCalibration {
  const counts = new Uint32Array(PALETTE_BUCKETS)
  const redSums = new Float64Array(PALETTE_BUCKETS)
  const greenSums = new Float64Array(PALETTE_BUCKETS)
  const blueSums = new Float64Array(PALETTE_BUCKETS)
  let opaqueCount = 0

  for (let i = 0; i < source.data.length; i += 4) {
    const red = source.data[i], green = source.data[i + 1], blue = source.data[i + 2]
    if (source.data[i + 3] < 250) continue
    const bucket = ((red >> 3) << 10) | ((green >> 3) << 5) | (blue >> 3)
    counts[bucket]++
    redSums[bucket] += red
    greenSums[bucket] += green
    blueSums[bucket] += blue
    opaqueCount++
  }
  if (!opaqueCount) return { svg, changedFills: 0 }

  const minCount = Math.max(MIN_PALETTE_COLOR_PIXELS, Math.floor(opaqueCount * MIN_PALETTE_COLOR_SHARE))
  const ranked: PaletteColor[] = []
  for (let bucket = 0; bucket < counts.length; bucket++) {
    const count = counts[bucket]
    if (count < minCount) continue
    ranked.push({
      red: redSums[bucket] / count,
      green: greenSums[bucket] / count,
      blue: blueSums[bucket] / count,
      count,
    })
  }
  ranked.sort((a, b) => b.count - a.count)

  const palette: PaletteColor[] = []
  for (const color of ranked) {
    const close = palette.find((candidate) => Math.hypot(
      color.red - candidate.red,
      color.green - candidate.green,
      color.blue - candidate.blue,
    ) <= PALETTE_MERGE_DISTANCE)
    if (close) {
      const count = close.count + color.count
      close.red = (close.red * close.count + color.red * color.count) / count
      close.green = (close.green * close.count + color.green * color.count) / count
      close.blue = (close.blue * close.count + color.blue * color.count) / count
      close.count = count
    } else if (palette.length < MAX_PALETTE_CANDIDATES) {
      palette.push({ ...color })
    }
  }
  if (!palette.length) return { svg, changedFills: 0 }

  const fillPattern = /\bfill=(["'])#([0-9a-fA-F]{6})\1/g
  const fillColors = new Map<number, string>()
  for (const match of svg.matchAll(fillPattern)) {
    const hex = match[2].toLowerCase()
    fillColors.set(Number.parseInt(hex, 16), `#${hex}`)
  }
  if (!fillColors.size || fillColors.size > 256) return { svg, changedFills: 0 }

  const replacements = new Map<string, string>()
  for (const [rgb, original] of fillColors) {
    const red = (rgb >> 16) & 255, green = (rgb >> 8) & 255, blue = rgb & 255
    let nearest: PaletteColor | undefined
    let nearestDistance = Number.POSITIVE_INFINITY
    for (const candidate of palette) {
      const distance = Math.hypot(red - candidate.red, green - candidate.green, blue - candidate.blue)
      if (distance < nearestDistance) {
        nearest = candidate
        nearestDistance = distance
      }
    }
    if (!nearest || nearestDistance > MAX_PALETTE_SNAP_DISTANCE) continue
    const replacement = hexColor(Math.round(nearest.red), Math.round(nearest.green), Math.round(nearest.blue))
    if (replacement !== original) replacements.set(original, replacement)
  }
  if (!replacements.size) return { svg, changedFills: 0 }

  const corrected = svg.replace(fillPattern, (attribute, quote: string, hex: string) => {
    const replacement = replacements.get(`#${hex.toLowerCase()}`)
    return replacement ? `fill=${quote}${replacement}${quote}` : attribute
  })
  return { svg: corrected, changedFills: replacements.size }
}
