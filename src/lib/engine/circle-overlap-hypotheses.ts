import type { RGBAImage } from './core'
import { createMaskHypothesis, type ObjectHypothesis } from './object-hypotheses'

export interface CircleOverlapDiagnostics {
  analysisSize: { width: number; height: number }
  background: [number, number, number]
  backgroundBorderSupportFraction: number
  backgroundCornerSupportCount: number
  seedColors: Array<[number, number, number]>
  boundaryPointCounts: number[]
  boundaryArcCoverageDegrees: number[]
  minimumBoundaryArcCoverageDegrees: number
  relativeRadialRms: number[]
  membershipPixelCounts: number[]
  orderFit?: { bestRmse: number; runnerUpRmse: number; margin: number; orderIdentifiable: boolean; bottomToTop?: string[] }
  warnings: string[]
}

export type CircleOverlapProposalResult =
  | { status: 'proposed'; hypotheses: ObjectHypothesis[]; diagnostics: CircleOverlapDiagnostics }
  | { status: 'abstained'; reason: string; diagnostics?: Partial<CircleOverlapDiagnostics> }

interface ColorEntry { color: [number, number, number]; count: number; firstPixel: number; exposedBoundary: number }
interface CircleFit { cx: number; cy: number; radius: number; boundaryPoints: number; angularCoverageDegrees: number; radialRms: number }
interface OrderFit { order: number[]; opacity: number[]; rmse: number }
type SeedDiscoveryResult =
  | { ok: true; background: [number, number, number]; backgroundBorderSupportFraction: number; backgroundCornerSupportCount: number; seeds: Array<[number, number, number]>; colors: number }
  | { ok: false; error: string; backgroundBorderSupportFraction?: number; backgroundCornerSupportCount?: number }

const COLOR_TOLERANCE = 24
const BACKGROUND_TOLERANCE = 24
const MAX_ANALYSIS_DIMENSION = 800
const MAX_PALETTE_COLORS = 4096
const MIN_BACKGROUND_BORDER_SUPPORT_FRACTION = 0.75
const MIN_BACKGROUND_CORNER_SUPPORT_COUNT = 4
const MIN_BOUNDARY_ARC_COVERAGE_DEGREES = 150

function colorDistanceSquared(a: ArrayLike<number>, b: ArrayLike<number>) {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2
}

function pixelRgb(data: ArrayLike<number>, index: number): [number, number, number] {
  const offset = index * 4
  return [data[offset], data[offset + 1], data[offset + 2]]
}

function analyzeRaster(image: RGBAImage) {
  const scale = Math.min(1, MAX_ANALYSIS_DIMENSION / Math.max(image.width, image.height))
  const width = Math.max(1, Math.round(image.width * scale))
  const height = Math.max(1, Math.round(image.height * scale))
  const rgba = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sx = Math.min(image.width - 1, Math.floor((x + 0.5) * image.width / width))
    const sy = Math.min(image.height - 1, Math.floor((y + 0.5) * image.height / height))
    const source = (sy * image.width + sx) * 4
    const target = (y * width + x) * 4
    rgba[target] = image.data[source]
    rgba[target + 1] = image.data[source + 1]
    rgba[target + 2] = image.data[source + 2]
    rgba[target + 3] = image.data[source + 3]
  }
  return { data: rgba, width, height }
}

function estimateBorderBackground(data: Uint8Array, width: number, height: number) {
  const histogram = new Map<string, { color: [number, number, number]; count: number }>()
  const add = (x: number, y: number) => {
    const color = pixelRgb(data, y * width + x)
    const key = color.join(',')
    const entry = histogram.get(key)
    if (entry) entry.count++
    else histogram.set(key, { color, count: 1 })
  }
  for (let x = 0; x < width; x++) { add(x, 0); add(x, height - 1) }
  for (let y = 1; y < height - 1; y++) { add(0, y); add(width - 1, y) }

  const borderPixelCount = 2 * width + 2 * height - 4
  const candidate = [...histogram.values()].sort((a, b) => b.count - a.count)[0]
  if (!candidate) return { background: [0, 0, 0] as [number, number, number], supportFraction: 0, cornerSupportCount: 0 }
  const toleranceSquared = BACKGROUND_TOLERANCE ** 2
  let support = 0
  for (let x = 0; x < width; x++) {
    if (colorDistanceSquared(pixelRgb(data, x), candidate.color) <= toleranceSquared) support++
    const bottom = (height - 1) * width + x
    if (colorDistanceSquared(pixelRgb(data, bottom), candidate.color) <= toleranceSquared) support++
  }
  for (let y = 1; y < height - 1; y++) {
    if (colorDistanceSquared(pixelRgb(data, y * width), candidate.color) <= toleranceSquared) support++
    const right = y * width + width - 1
    if (colorDistanceSquared(pixelRgb(data, right), candidate.color) <= toleranceSquared) support++
  }
  const corners = [0, width - 1, (height - 1) * width, height * width - 1]
  const cornerSupportCount = corners.filter((index) => colorDistanceSquared(pixelRgb(data, index), candidate.color) <= toleranceSquared).length
  return { background: candidate.color, supportFraction: support / borderPixelCount, cornerSupportCount }
}

function discoverSeeds(data: Uint8Array, width: number, height: number): SeedDiscoveryResult {
  const border = estimateBorderBackground(data, width, height)
  if (border.supportFraction < MIN_BACKGROUND_BORDER_SUPPORT_FRACTION || border.cornerSupportCount < MIN_BACKGROUND_CORNER_SUPPORT_COUNT) return {
    ok: false,
    error: `The image border does not reliably identify a flat background (${(border.supportFraction * 100).toFixed(1)}% border support; ${border.cornerSupportCount}/4 corners). At least ${MIN_BACKGROUND_BORDER_SUPPORT_FRACTION * 100}% border support and all four corners are required.`,
    backgroundBorderSupportFraction: border.supportFraction,
    backgroundCornerSupportCount: border.cornerSupportCount,
  }
  const histogram = new Map<string, ColorEntry>()
  const pixelCount = width * height
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
    const color = pixelRgb(data, pixelIndex)
    const key = color.join(',')
    const entry = histogram.get(key)
    if (entry) entry.count++
    else {
      if (histogram.size >= MAX_PALETTE_COLORS) return { ok: false, error: 'Too many distinct colors for the flat-color circle provider.' }
      histogram.set(key, { color, count: 1, firstPixel: pixelIndex, exposedBoundary: 0 })
    }
  }
  const palette = [...histogram.values()].sort((a, b) => b.count - a.count)
  if (palette.length < 4) return { ok: false, error: 'A flat background and three distinct exposed circle colors are required.' }
  const backgroundColor = border.background
  const backgroundToleranceSquared = BACKGROUND_TOLERANCE ** 2
  const candidatePalette = palette
    .filter((entry) => colorDistanceSquared(entry.color, backgroundColor) > backgroundToleranceSquared)
    .slice(0, 64)
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    const index = y * width + x
    const color = pixelRgb(data, index)
    if (colorDistanceSquared(color, backgroundColor) <= backgroundToleranceSquared) continue
    const neighbors = [index - 1, index + 1, index - width, index + width]
    if (!neighbors.some((neighbor) => colorDistanceSquared(pixelRgb(data, neighbor), backgroundColor) <= backgroundToleranceSquared)) continue
    for (const candidate of candidatePalette)
      if (colorDistanceSquared(color, candidate.color) <= COLOR_TOLERANCE ** 2) candidate.exposedBoundary++
  }

  const minimumSeedPixelCount = Math.max(64, Math.ceil(pixelCount * 0.001))
  const candidates = candidatePalette
    .filter((entry) => entry.count >= minimumSeedPixelCount && entry.exposedBoundary >= 12)
    .sort((a, b) => b.exposedBoundary - a.exposedBoundary || b.count - a.count)
  const selected: ColorEntry[] = []
  for (const candidate of candidates) {
    if (selected.every((prior) => colorDistanceSquared(prior.color, candidate.color) > (COLOR_TOLERANCE * 1.5) ** 2)) selected.push(candidate)
    if (selected.length === 3) break
  }
  if (selected.length !== 3) return { ok: false, error: `Only ${selected.length}/3 distinct exposed flat colors were found.` }
  return {
    ok: true, background: backgroundColor, backgroundBorderSupportFraction: border.supportFraction,
    backgroundCornerSupportCount: border.cornerSupportCount,
    seeds: selected.map((entry) => entry.color), colors: histogram.size,
  }
}

function solve3(matrix: number[][], rhs: number[]) {
  const a = matrix.map((row, index) => [...row, rhs[index]])
  for (let column = 0; column < 3; column++) {
    let pivot = column
    for (let row = column + 1; row < 3; row++) if (Math.abs(a[row][column]) > Math.abs(a[pivot][column])) pivot = row
    if (Math.abs(a[pivot][column]) < 1e-10) return null
    ;[a[column], a[pivot]] = [a[pivot], a[column]]
    const scale = a[column][column]
    for (let k = column; k < 4; k++) a[column][k] /= scale
    for (let row = 0; row < 3; row++) {
      if (row === column) continue
      const factor = a[row][column]
      for (let k = column; k < 4; k++) a[row][k] -= factor * a[column][k]
    }
  }
  return a.map((row) => row[3])
}

function fitCircle(points: Array<[number, number]>): CircleFit | null {
  if (points.length < 8) return null
  const matrix = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
  const rhs = [0, 0, 0]
  for (const [x, y] of points) {
    const row = [2 * x, 2 * y, 1]
    const value = x * x + y * y
    for (let i = 0; i < 3; i++) {
      rhs[i] += row[i] * value
      for (let j = 0; j < 3; j++) matrix[i][j] += row[i] * row[j]
    }
  }
  const solved = solve3(matrix, rhs)
  if (!solved) return null
  const [cx, cy, constant] = solved
  const radius = Math.sqrt(Math.max(0, constant + cx * cx + cy * cy))
  if (!Number.isFinite(radius) || radius < 2) return null
  const angles = points.map(([x, y]) => Math.atan2(y - cy, x - cx)).sort((a, b) => a - b)
  let largestGap = angles[0] + Math.PI * 2 - angles[angles.length - 1]
  for (let index = 0; index < angles.length - 1; index++) largestGap = Math.max(largestGap, angles[index + 1] - angles[index])
  const angularCoverageDegrees = (Math.PI * 2 - largestGap) * 180 / Math.PI
  const radialRms = Math.sqrt(points.reduce((sum, [x, y]) => sum + (Math.hypot(x - cx, y - cy) - radius) ** 2, 0) / points.length)
  return { cx, cy, radius, boundaryPoints: points.length, angularCoverageDegrees, radialRms }
}

function extractBoundaryPoints(labels: Int8Array, width: number, height: number, label: number): Array<[number, number]> {
  const points: Array<[number, number]> = []
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    if (labels[y * width + x] !== label) continue
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (labels[(y + dy) * width + x + dx] === 0) points.push([x + 0.5 + dx * 0.5, y + 0.5 + dy * 0.5])
    }
  }
  return points
}

function permutations(values: number[]): number[][] {
  if (!values.length) return [[]]
  return values.flatMap((value, index) => permutations(values.filter((_, i) => i !== index)).map((rest) => [value, ...rest]))
}

function meanRgb(sums: number[], count: number): [number, number, number] | null {
  return count ? [sums[0] / count, sums[1] / count, sums[2] / count] : null
}

function inferOrder(singleColors: Array<[number, number, number]>, regionColors: Array<[number, number, number]>, background: number[]): OrderFit[] {
  const pairMasks = [[0, 1], [0, 2], [1, 2]].map(([a, b]) => ({ a, b, mask: (1 << a) | (1 << b) }))
  const estimateOpacity = (bottomIndices: number[], topIndex: number) => {
    let numerator = 0, denominator = 0
    for (const bottom of bottomIndices) {
      const mask = (1 << bottom) | (1 << topIndex)
      const observedDifference = regionColors[mask].map((value, channel) => value - singleColors[topIndex][channel])
      const bottomDifference = singleColors[bottom].map((value, channel) => value - background[channel])
      numerator += observedDifference.reduce((sum, value, channel) => sum + value * bottomDifference[channel], 0)
      denominator += bottomDifference.reduce((sum, value) => sum + value * value, 0)
    }
    return denominator < 1e-9 ? 1 : Math.max(0, Math.min(1, 1 - numerator / denominator))
  }
  const results: OrderFit[] = []
  for (const order of permutations([0, 1, 2])) {
    const [bottom, middle, top] = order
    const opacity = [1, 1, 1]
    opacity[middle] = estimateOpacity([bottom], middle)
    opacity[top] = estimateOpacity([bottom, middle], top)
    let squaredError = 0
    for (const pair of pairMasks) {
      const lower = order.indexOf(pair.a) < order.indexOf(pair.b) ? pair.a : pair.b
      const upper = lower === pair.a ? pair.b : pair.a
      const predicted = singleColors[upper].map((value, channel) => value + (1 - opacity[upper]) * (singleColors[lower][channel] - background[channel]))
      squaredError += predicted.reduce((sum, value, channel) => sum + (regionColors[pair.mask][channel] - value) ** 2, 0)
    }
    const predictedTriple = singleColors[top].map((value, channel) => value
      + (1 - opacity[top]) * (singleColors[middle][channel] - background[channel])
      + (1 - opacity[top]) * (1 - opacity[middle]) * (singleColors[bottom][channel] - background[channel]))
    squaredError += predictedTriple.reduce((sum, value, channel) => sum + (regionColors[7][channel] - value) ** 2, 0)
    results.push({ order, opacity, rmse: Math.sqrt(squaredError / 12) })
  }
  return results.sort((a, b) => a.rmse - b.rmse)
}

function colorHex(rgb: number[]) {
  return `#${rgb.map((value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0')).join('')}`
}

/**
 * Proposes three full circle masks from visible, flat-color arcs on a flat opaque background.
 * This is a deliberately narrow port of the measured overlap experiment; unsupported images
 * return an explicit abstention rather than an arbitrary shape guess.
 */
export function proposeThreeCircleOverlaps(image: RGBAImage): CircleOverlapProposalResult {
  if (!Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height) || image.width < 8 || image.height < 8 || image.data.length !== image.width * image.height * 4)
    return { status: 'abstained', reason: 'Image data or dimensions are invalid.' }
  for (let i = 3; i < image.data.length; i += 4) if (image.data[i] < 250)
    return { status: 'abstained', reason: 'The circle provider requires a fully opaque raster and flat visible background.' }

  const raster = analyzeRaster(image)
  const palette = discoverSeeds(raster.data, raster.width, raster.height)
  if (!palette.ok) return {
    status: 'abstained', reason: palette.error,
    ...(palette.backgroundBorderSupportFraction !== undefined
      ? { diagnostics: {
        backgroundBorderSupportFraction: palette.backgroundBorderSupportFraction,
        ...(palette.backgroundCornerSupportCount !== undefined ? { backgroundCornerSupportCount: palette.backgroundCornerSupportCount } : {}),
      } }
      : {}),
  }

  const labels = new Int8Array(raster.width * raster.height)
  labels.fill(-1)
  for (let i = 0; i < labels.length; i++) {
    const color = pixelRgb(raster.data, i)
    if (colorDistanceSquared(color, palette.background) <= BACKGROUND_TOLERANCE ** 2) { labels[i] = 0; continue }
    let nearest = -1, nearestDistance = Infinity
    for (let index = 0; index < palette.seeds.length; index++) {
      const distance = colorDistanceSquared(color, palette.seeds[index])
      if (distance < nearestDistance) { nearestDistance = distance; nearest = index + 1 }
    }
    if (nearestDistance <= COLOR_TOLERANCE ** 2) labels[i] = nearest
  }

  const fits = palette.seeds.map((_, index) => fitCircle(extractBoundaryPoints(labels, raster.width, raster.height, index + 1)))
  if (fits.some((fit) => !fit)) return { status: 'abstained', reason: 'At least one exposed arc is too short or degenerate to fit a circle.' }
  const circles = fits as CircleFit[]
  const boundaryArcCoverageDegrees = circles.map((circle) => circle.angularCoverageDegrees)
  if (boundaryArcCoverageDegrees.some((coverage) => coverage < MIN_BOUNDARY_ARC_COVERAGE_DEGREES)) return {
    status: 'abstained',
    reason: `At least one fitted circle has less than ${MIN_BOUNDARY_ARC_COVERAGE_DEGREES}° of exposed-arc coverage; its completed geometry is too underconstrained.`,
    diagnostics: {
      analysisSize: { width: raster.width, height: raster.height },
      background: palette.background,
      backgroundBorderSupportFraction: palette.backgroundBorderSupportFraction,
      backgroundCornerSupportCount: palette.backgroundCornerSupportCount,
      seedColors: palette.seeds,
      boundaryPointCounts: circles.map((circle) => circle.boundaryPoints),
      boundaryArcCoverageDegrees,
      minimumBoundaryArcCoverageDegrees: MIN_BOUNDARY_ARC_COVERAGE_DEGREES,
      relativeRadialRms: circles.map((circle) => circle.radialRms / circle.radius),
      warnings: ['The color labels fit circles, but at least one visible arc covers too little of its circumference for safe completion.'],
    },
  }
  const regionSums = Array.from({ length: 8 }, () => [0, 0, 0])
  const regionCounts = new Uint32Array(8)
  const sampleMargin = 4
  for (let y = 0; y < raster.height; y++) for (let x = 0; x < raster.width; x++) {
    const px = x + 0.5, py = y + 0.5
    let mask = 0, safelyInside = true
    circles.forEach((circle, index) => {
      const signedDistance = circle.radius - Math.hypot(px - circle.cx, py - circle.cy)
      if (signedDistance >= 0) mask |= 1 << index
      if (Math.abs(signedDistance) < sampleMargin) safelyInside = false
    })
    if (!mask || !safelyInside) continue
    const color = pixelRgb(raster.data, y * raster.width + x)
    for (let channel = 0; channel < 3; channel++) regionSums[mask][channel] += color[channel]
    regionCounts[mask]++
  }
  const regionColors = regionSums.map((sum, mask) => meanRgb(sum, regionCounts[mask]))
  const membershipPixelCounts = Array.from(regionCounts)
  const requiredMasks = [1, 2, 4, 3, 5, 6, 7]
  const haveAllPaintRegions = requiredMasks.every((mask) => regionColors[mask] !== null)
  const warnings: string[] = []
  if (!haveAllPaintRegions) warnings.push('Some singleton, pair, or triple membership region is not measurable; paint and order are omitted.')
  else warnings.push('Paint fit assumes source-over; Multiply, group opacity, and lower-layer source alpha are not identified separately.')
  const orderFits = haveAllPaintRegions
    ? inferOrder(circles.map((_, index) => regionColors[1 << index] as [number, number, number]), regionColors as Array<[number, number, number]>, palette.background)
    : []
  const winner = orderFits[0], runnerUp = orderFits[1]
  const orderMargin = winner && runnerUp ? runnerUp.rmse - winner.rmse : null
  const orderIdentifiable = orderMargin !== null && orderMargin >= 2
  if (winner && runnerUp && !orderIdentifiable) warnings.push('The best and next painter-order fits are close; treat order as ambiguous.')
  const orderFit = winner && runnerUp ? {
    bestRmse: winner.rmse,
    runnerUpRmse: runnerUp.rmse,
    margin: orderMargin!,
    orderIdentifiable,
    ...(orderIdentifiable ? { bottomToTop: winner.order.map((index) => `circle-${index + 1}`) } : {}),
  } : undefined

  const sx = image.width / raster.width, sy = image.height / raster.height
  const hypotheses = circles.map((circle, index) => {
    const maskData = new Uint8Array(raster.width * raster.height)
    const minX = Math.max(0, Math.floor(circle.cx - circle.radius - 1)), maxX = Math.min(raster.width, Math.ceil(circle.cx + circle.radius + 1))
    const minY = Math.max(0, Math.floor(circle.cy - circle.radius - 1)), maxY = Math.min(raster.height, Math.ceil(circle.cy + circle.radius + 1))
    for (let y = minY; y < maxY; y++) for (let x = minX; x < maxX; x++)
      if (Math.hypot(x + 0.5 - circle.cx, y + 0.5 - circle.cy) <= circle.radius) maskData[y * raster.width + x] = 1

    const sourceCircle = { cx: circle.cx * sx, cy: circle.cy * sy, radius: circle.radius * (sx + sy) / 2 }
    const hypothesis = createMaskHypothesis({
      id: `circle-${index + 1}`,
      mask: { width: raster.width, height: raster.height, data: maskData },
      source: {
        provider: 'circle-visible-arc-fit', model: 'least-squares-circle',
        description: 'Three-circle fit from exclusive flat-color arcs on a flat opaque background.',
      },
      score: { value: circle.radialRms / circle.radius, kind: 'provider-native', label: 'relative radial RMS; lower is better' },
    })
    hypothesis.maskMeaning = 'completed-object'
    hypothesis.geometry = {
      family: 'circle', completeness: 'completed',
      parameters: { cx: sourceCircle.cx, cy: sourceCircle.cy, radius: sourceCircle.radius, coordinateSpace: 'source image pixels' },
    }
    if (winner && runnerUp && orderIdentifiable) {
      const visibleColor = regionColors[1 << index] as [number, number, number]
      const opacity = winner.opacity[index]
      const fill = visibleColor.map((value, channel) => (value - (1 - opacity) * palette.background[channel]) / Math.max(opacity, 1e-6))
      hypothesis.paint = {
        fill: colorHex(fill), opacity,
        description: index === winner.order[0]
          ? 'Effective opaque lower layer by convention; its source alpha and fill are not separately identifiable.'
          : 'Source-over color fit from measured singleton, pair, and triple overlaps.',
      }
      hypothesis.paintOrder = winner.order.filter((other) => other !== index).map((other) => ({
        relatedHypothesisId: `circle-${other + 1}`,
        relation: winner.order.indexOf(index) < winner.order.indexOf(other) ? 'below' as const : 'above' as const,
        evidence: `Provisional source-over fit: best RMSE ${winner.rmse.toFixed(3)}, runner-up ${runnerUp?.rmse.toFixed(3) ?? 'unknown'} RGB levels/channel.`,
      }))
    }
    return hypothesis
  })

  return {
    status: 'proposed', hypotheses,
    diagnostics: {
      analysisSize: { width: raster.width, height: raster.height },
      background: palette.background,
      backgroundBorderSupportFraction: palette.backgroundBorderSupportFraction,
      backgroundCornerSupportCount: palette.backgroundCornerSupportCount,
      seedColors: palette.seeds,
      boundaryPointCounts: circles.map((circle) => circle.boundaryPoints),
      boundaryArcCoverageDegrees,
      minimumBoundaryArcCoverageDegrees: MIN_BOUNDARY_ARC_COVERAGE_DEGREES,
      relativeRadialRms: circles.map((circle) => circle.radialRms / circle.radius),
      membershipPixelCounts,
      ...(orderFit ? { orderFit } : {}),
      warnings,
    },
  }
}
