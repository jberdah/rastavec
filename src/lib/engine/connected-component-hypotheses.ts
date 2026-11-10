import type { RGBAImage } from './core'
import { createMaskHypothesis, type ObjectHypothesis } from './object-hypotheses'

type RGB = [number, number, number]

export interface ConnectedComponentDiagnostics {
  analysisSize: { width: number; height: number }
  background: {
    kind: 'transparent-border' | 'opaque-border-median' | 'intermediate-alpha-border'
    rgba: [number, number, number, number]
    opaqueBorderFraction: number
    nearTransparentBorderFraction: number
    flatColorSupport?: number
  }
  foregroundPixels: number
  components: { raw: number; belowMinimumArea: number; proposed: number; truncated: number }
  thresholds: {
    colorDistanceRgbEuclidean: number
    alpha: number
    minAreaPixels: number
    connectivity: 8
    borderAlphaSupportFraction: number
    transparentBorderMaxAlpha: number
    opaqueBorderMinAlpha: number
  }
  warnings: string[]
}

export type ConnectedComponentProposalResult =
  | { status: 'proposed'; hypotheses: ObjectHypothesis[]; diagnostics: ConnectedComponentDiagnostics }
  | { status: 'abstained'; reason: string; diagnostics?: Partial<ConnectedComponentDiagnostics> }

export interface ConnectedComponentOptions {
  contrastThreshold?: number
  alphaThreshold?: number
  minAreaPixels?: number
  maxHypotheses?: number
}

interface Component { label: number; area: number; bounds: [number, number, number, number] }

const MAX_ANALYSIS_DIMENSION = 800
const DEFAULT_MAX_HYPOTHESES = 32
const MIN_BORDER_BACKGROUND_SUPPORT = 0.75
const MAX_TRANSPARENT_BORDER_ALPHA = 8
const MIN_OPAQUE_BORDER_ALPHA = 250

function sampleRaster(image: RGBAImage) {
  const scale = Math.min(1, MAX_ANALYSIS_DIMENSION / Math.max(image.width, image.height))
  const width = Math.max(1, Math.round(image.width * scale))
  const height = Math.max(1, Math.round(image.height * scale))
  const data = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sx = Math.min(image.width - 1, Math.floor((x + 0.5) * image.width / width))
    const sy = Math.min(image.height - 1, Math.floor((y + 0.5) * image.height / height))
    const source = (sy * image.width + sx) * 4
    const target = (y * width + x) * 4
    data[target] = image.data[source]
    data[target + 1] = image.data[source + 1]
    data[target + 2] = image.data[source + 2]
    data[target + 3] = image.data[source + 3]
  }
  return { data, width, height }
}

function median(values: number[]) {
  values.sort((a, b) => a - b)
  return values[Math.floor(values.length / 2)] ?? 0
}

function sampleBorder(data: Uint8Array, width: number, height: number, colorThreshold: number) {
  const samples: Array<[number, number, number, number]> = []
  const add = (x: number, y: number) => {
    const offset = (y * width + x) * 4
    samples.push([data[offset], data[offset + 1], data[offset + 2], data[offset + 3]])
  }
  for (let x = 0; x < width; x++) { add(x, 0); if (height > 1) add(x, height - 1) }
  for (let y = 1; y < height - 1; y++) { add(0, y); if (width > 1) add(width - 1, y) }
  const opaque = samples.filter((pixel) => pixel[3] >= MIN_OPAQUE_BORDER_ALPHA)
  const opaqueBorderFraction = opaque.length / Math.max(1, samples.length)
  const nearTransparentBorderFraction = samples.filter((pixel) => pixel[3] <= MAX_TRANSPARENT_BORDER_ALPHA).length / Math.max(1, samples.length)
  if (nearTransparentBorderFraction >= MIN_BORDER_BACKGROUND_SUPPORT) return {
    kind: 'transparent-border' as const,
    rgba: [0, 0, 0, 0] as [number, number, number, number],
    opaqueBorderFraction,
    nearTransparentBorderFraction,
  }
  if (opaqueBorderFraction < MIN_BORDER_BACKGROUND_SUPPORT) {
    const rgba = [0, 1, 2, 3].map((channel) => median(samples.map((pixel) => pixel[channel]))) as [number, number, number, number]
    return { kind: 'intermediate-alpha-border' as const, rgba, opaqueBorderFraction, nearTransparentBorderFraction }
  }
  const rgba = [0, 1, 2].map((channel) => median(opaque.map((pixel) => pixel[channel]))) as RGB
  const support = opaque.filter((pixel) => {
    const error = (pixel[0] - rgba[0]) ** 2 + (pixel[1] - rgba[1]) ** 2 + (pixel[2] - rgba[2]) ** 2
    return error <= colorThreshold * colorThreshold
  }).length / opaque.length
  return {
    kind: 'opaque-border-median' as const,
    rgba: [rgba[0], rgba[1], rgba[2], 255] as [number, number, number, number],
    opaqueBorderFraction,
    nearTransparentBorderFraction,
    flatColorSupport: support,
  }
}

function labelComponents(foreground: Uint8Array, width: number, height: number) {
  const labels = new Int32Array(foreground.length)
  const queue = new Int32Array(foreground.length)
  const components: Component[] = []
  for (let start = 0; start < foreground.length; start++) {
    if (!foreground[start] || labels[start]) continue
    const label = components.length + 1
    let head = 0, tail = 0
    queue[tail++] = start
    labels[start] = label
    let minX = width, minY = height, maxX = -1, maxY = -1
    while (head < tail) {
      const pixel = queue[head++]
      const x = pixel % width, y = Math.floor(pixel / width)
      minX = Math.min(minX, x); minY = Math.min(minY, y)
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y)
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue
        const nx = x + dx, ny = y + dy
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
        const neighbor = ny * width + nx
        if (!foreground[neighbor] || labels[neighbor]) continue
        labels[neighbor] = label
        queue[tail++] = neighbor
      }
    }
    components.push({ label, area: tail, bounds: [minX, minY, maxX + 1, maxY + 1] })
  }
  return { labels, components }
}

/** Propose connected visible foreground regions; this does not complete occluded shapes. */
export function proposeConnectedComponentHypotheses(image: RGBAImage, options: ConnectedComponentOptions = {}): ConnectedComponentProposalResult {
  if (!Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height) || image.width < 1 || image.height < 1 || image.data.length !== image.width * image.height * 4)
    throw new Error('Source raster dimensions or RGBA data are invalid.')
  const contrastThreshold = options.contrastThreshold ?? 18
  const alphaThreshold = options.alphaThreshold ?? 18
  const minAreaPixels = options.minAreaPixels ?? 8
  const maxHypotheses = options.maxHypotheses ?? DEFAULT_MAX_HYPOTHESES
  if (!Number.isFinite(contrastThreshold) || contrastThreshold <= 0) throw new Error('Contrast threshold must be a positive number.')
  if (!Number.isFinite(alphaThreshold) || alphaThreshold <= 0 || alphaThreshold > 255) throw new Error('Alpha threshold must be from 1 to 255.')
  if (!Number.isSafeInteger(minAreaPixels) || minAreaPixels < 1) throw new Error('Minimum component area must be a positive integer.')
  if (!Number.isSafeInteger(maxHypotheses) || maxHypotheses < 1 || maxHypotheses > 128) throw new Error('Maximum proposals must be an integer from 1 to 128.')

  const raster = sampleRaster(image)
  const background = sampleBorder(raster.data, raster.width, raster.height, contrastThreshold)
  const thresholds: ConnectedComponentDiagnostics['thresholds'] = {
    colorDistanceRgbEuclidean: contrastThreshold, alpha: alphaThreshold, minAreaPixels, connectivity: 8,
    borderAlphaSupportFraction: MIN_BORDER_BACKGROUND_SUPPORT,
    transparentBorderMaxAlpha: MAX_TRANSPARENT_BORDER_ALPHA, opaqueBorderMinAlpha: MIN_OPAQUE_BORDER_ALPHA,
  }
  if (background.kind === 'intermediate-alpha-border') {
    const reason = 'Border alpha is neither predominantly near-transparent nor opaque; connected-component segmentation is unreliable.'
    return {
      status: 'abstained', reason,
      diagnostics: {
        analysisSize: { width: raster.width, height: raster.height },
        background,
        thresholds,
        warnings: [reason],
      },
    }
  }
  const pixelCount = raster.width * raster.height
  const foreground = new Uint8Array(pixelCount)
  let foregroundPixels = 0
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    const offset = pixel * 4
    const alpha = raster.data[offset + 3] / 255
    const isForeground = background.kind === 'transparent-border'
      ? raster.data[offset + 3] >= alphaThreshold
      : Math.hypot(
        (raster.data[offset] - background.rgba[0]) * alpha,
        (raster.data[offset + 1] - background.rgba[1]) * alpha,
        (raster.data[offset + 2] - background.rgba[2]) * alpha,
      ) >= contrastThreshold
    foreground[pixel] = isForeground ? 1 : 0
    if (isForeground) foregroundPixels++
  }
  if (!foregroundPixels) return { status: 'abstained', reason: 'No visible foreground pixels passed the background or alpha threshold.' }

  const { labels, components } = labelComponents(foreground, raster.width, raster.height)
  const accepted = components.filter(({ area }) => area >= minAreaPixels)
    .sort((a, b) => b.area - a.area || a.label - b.label)
  if (!accepted.length) return { status: 'abstained', reason: `No connected foreground region reached the minimum area of ${minAreaPixels} pixels.` }
  const selected = accepted.slice(0, maxHypotheses)
  const rankByLabel = new Int16Array(components.length + 1).fill(-1)
  selected.forEach((component, index) => { rankByLabel[component.label] = index })
  const masks = selected.map(() => new Uint8Array(pixelCount))
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    const rank = rankByLabel[labels[pixel]]
    if (rank >= 0) masks[rank][pixel] = 1
  }

  const warnings = [
    'Masks describe connected visible regions only; touching or overlapping objects may merge, and one object with separated components may split.',
    'This route does not infer hidden geometry, object identity, paint, or layer order.',
  ]
  if (background.kind === 'opaque-border-median' && (background.flatColorSupport ?? 1) < 0.75)
    warnings.push('The image border has weak support for one flat background color; foreground components may be unreliable.')
  const truncated = Math.max(0, accepted.length - selected.length)
  if (truncated) warnings.push(`${truncated} smaller component(s) were omitted after the ${maxHypotheses}-proposal limit.`)
  const diagnostics: ConnectedComponentDiagnostics = {
    analysisSize: { width: raster.width, height: raster.height },
    background,
    foregroundPixels,
    components: { raw: components.length, belowMinimumArea: components.length - accepted.length, proposed: selected.length, truncated },
    thresholds,
    warnings,
  }
  const hypotheses = selected.map((component, index) => {
    const hypothesis = createMaskHypothesis({
      id: `component-${String(index + 1).padStart(3, '0')}`,
      mask: { width: raster.width, height: raster.height, data: masks[index] },
      source: {
        provider: 'visible-connected-components',
        model: 'border-background-contrast-8-connected',
        description: 'Visible foreground region separated by 8-connected component labeling.',
      },
    })
    hypothesis.maskMeaning = 'visible-object'
    hypothesis.geometry = { family: 'unknown', completeness: 'visible', parameters: { boundsInAnalysisPixels: component.bounds.join(','), analysisPixelArea: component.area } }
    return hypothesis
  })
  return { status: 'proposed', hypotheses, diagnostics }
}
