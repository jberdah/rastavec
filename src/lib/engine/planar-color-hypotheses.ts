import type { RGBAImage } from './core'
import { createMaskHypothesis, type ObjectHypothesis } from './object-hypotheses'

type RGB = [number, number, number]
type Graph = Array<Map<number, number>>

export interface PlanarColorDiagnostics {
  analysisSize: { width: number; height: number }
  background: RGB
  colorStates: Array<{ color: RGB; pixels: number; membershipMask: number }>
  graph: { objectCount: number; vertices: number; edges: number; isTree: boolean; thetaClassCount: number }
  adjacency: {
    minimumStatePixels: number
    requestedMinimumBorderPixels: number
    selectedMinimumBorderPixels: number
    radiusPixels: number
    maximumInteriorColorErrorSquared: number
    prunedEdges: Array<{ colorA: RGB; colorB: RGB; sharedBorderPixels: number }>
  }
  paintFit?: {
    model: 'source-over' | 'multiply' | 'effective-region-colors'
    bestRmse: number | null
    runnerUpRmse: number | null
    margin: number | null
    alternativeModel?: 'source-over' | 'multiply'
    alternativeModelRmse?: number
    modelMargin: number | null
    modelIdentifiable: boolean
    orderIdentifiable: boolean
    bottomToTop?: string[]
  }
  warnings: string[]
}

export type PlanarColorProposalResult =
  | { status: 'proposed'; hypotheses: ObjectHypothesis[]; diagnostics: PlanarColorDiagnostics }
  | { status: 'abstained'; reason: string; diagnostics?: Partial<PlanarColorDiagnostics> }

export interface PlanarColorOptions {
  minStatePixels?: number
  minAdjacencyPixels?: number
  adjacencyRadius?: number
  maximumInteriorColorErrorSquared?: number
}

interface Embedding {
  distances: Int16Array[]
  stateMasks: Int32Array
  edges: Array<{ a: number; b: number; border: number }>
  thetaClasses: Array<Array<{ a: number; b: number; border: number }>>
}

interface PaintFit {
  model: 'source-over' | 'multiply' | 'effective-region-colors'
  fills: RGB[]
  opacity: number[]
  order: number[]
  bestRmse: number | null
  runnerUpRmse: number | null
  margin: number | null
  alternativeModel?: 'source-over' | 'multiply'
  alternativeModelRmse?: number
  modelMargin: number | null
  modelIdentifiable: boolean
  orderIdentifiable: boolean
}

const MAX_ANALYSIS_DIMENSION = 800
const MAX_DISTINCT_COLORS = 65_536
const MAX_PALETTE_SIZE = 16
const MAX_OBJECTS = 4
const MAX_PRUNABLE_EDGES = 40

const colorKey = (color: RGB) => (color[0] << 16) | (color[1] << 8) | color[2]
const colorFromKey = (key: number): RGB => [(key >>> 16) & 255, (key >>> 8) & 255, key & 255]
const squaredError = (a: ArrayLike<number>, b: ArrayLike<number>) =>
  (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2
const popcount = (value: number) => {
  let count = 0
  for (; value; value &= value - 1) count++
  return count
}
const clamp = (value: number) => Math.max(0, Math.min(1, value))
const byte = (value: number) => Math.max(0, Math.min(255, Math.round(value)))
const colorHex = (color: RGB) => `#${color.map((value) => byte(value).toString(16).padStart(2, '0')).join('')}`

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

function permutations(values: number[]): number[][] {
  if (!values.length) return [[]]
  return values.flatMap((value, index) => permutations(values.filter((_, i) => i !== index).map((rest) => rest)).map((rest) => [value, ...rest]))
}

function embedPartialCube(graph: Graph): Embedding | null {
  const distances: Int16Array[] = []
  for (let source = 0; source < graph.length; source++) {
    const distance = new Int16Array(graph.length).fill(-1)
    distance[source] = 0
    const queue = [source]
    for (let cursor = 0; cursor < queue.length; cursor++) for (const neighbor of graph[queue[cursor]].keys()) {
      if (distance[neighbor] >= 0) continue
      distance[neighbor] = distance[queue[cursor]] + 1
      queue.push(neighbor)
    }
    if (queue.length !== graph.length) return null
    distances.push(distance)
  }

  const classes = new Map<string, Array<{ a: number; b: number; border: number }>>()
  const edges: Array<{ a: number; b: number; border: number }> = []
  for (let a = 0; a < graph.length; a++) for (const [b, border] of graph[a]) if (a < b) {
    const sideA: number[] = [], sideB: number[] = []
    for (let state = 0; state < graph.length; state++) {
      const difference = distances[state][a] - distances[state][b]
      if (Math.abs(difference) !== 1) return null
      ;(difference < 0 ? sideA : sideB).push(state)
    }
    const first = sideA.join(','), second = sideB.join(',')
    const key = first < second ? `${first}|${second}` : `${second}|${first}`
    const edge = { a, b, border }
    edges.push(edge)
    if (!classes.has(key)) classes.set(key, [])
    classes.get(key)!.push(edge)
  }

  const thetaClasses = [...classes.values()]
  if (thetaClasses.length < 2 || thetaClasses.length > MAX_OBJECTS) return null
  const stateMasks = new Int32Array(graph.length)
  for (let bit = 0; bit < thetaClasses.length; bit++) {
    const { a, b } = thetaClasses[bit][0]
    const rootCloserToA = distances[0][a] < distances[0][b]
    for (let state = 0; state < graph.length; state++) {
      if ((distances[state][a] < distances[state][b]) !== rootCloserToA) stateMasks[state] |= 1 << bit
    }
  }
  if (new Set(stateMasks).size !== graph.length) return null
  for (const { a, b } of edges) if (popcount(stateMasks[a] ^ stateMasks[b]) !== 1) return null
  for (let a = 0; a < graph.length; a++) for (let b = a + 1; b < graph.length; b++) {
    if (distances[a][b] !== popcount(stateMasks[a] ^ stateMasks[b])) return null
  }
  return { distances, stateMasks, edges, thetaClasses }
}

function graphAtThreshold(adjacency: Graph, threshold: number, removed: Set<string> = new Set()): Graph {
  return adjacency.map((neighbors, a) => new Map([...neighbors].filter(([b, border]) =>
    border >= threshold && !removed.has(a < b ? `${a}:${b}` : `${b}:${a}`))))
}

function chooseEdgeRemovals<T>(edges: T[], count: number, start = 0, prefix: T[] = [], result: T[][] = []): T[][] {
  if (prefix.length === count) { result.push(prefix); return result }
  for (let index = start; index <= edges.length - (count - prefix.length); index++)
    chooseEdgeRemovals(edges, count, index + 1, [...prefix, edges[index]], result)
  return result
}

function inferPaint(
  palette: RGB[],
  stateCounts: Uint32Array,
  stateMasks: Int32Array,
  embedding: Embedding,
): PaintFit | null {
  const objectCount = embedding.thetaClasses.length
  const objectIndices = Array.from({ length: objectCount }, (_, index) => index)
  const stateIndexByMask = new Map([...stateMasks].map((mask, state) => [mask, state]))
  const colorByMask = new Map([...stateMasks].map((mask, state) => [mask, palette[state]]))
  const allSingletonsPresent = objectIndices.every((bit) => stateIndexByMask.has(1 << bit))
  if (allSingletonsPresent) {
    const singletonColors = objectIndices.map((bit) => palette[stateIndexByMask.get(1 << bit)!])
    const compose = (subset: number, order: number[], alpha: number[]) => {
      const result: RGB = [...palette[0]]
      for (const object of order) if (subset & (1 << object)) for (let channel = 0; channel < 3; channel++)
        result[channel] = singletonColors[object][channel] + (1 - alpha[object]) * (result[channel] - palette[0][channel])
      return result
    }
    const candidates = permutations(objectIndices).map((order) => {
      const alpha = singletonColors.map(() => 1)
      for (let orderIndex = 1; orderIndex < order.length; orderIndex++) {
        const upper = order[orderIndex]
        let numerator = 0, denominator = 0
        for (const lower of order.slice(0, orderIndex)) {
          const observed = colorByMask.get((1 << upper) | (1 << lower))
          if (!observed) continue
          for (let channel = 0; channel < 3; channel++) {
            const contribution = singletonColors[lower][channel] - palette[0][channel]
            numerator += (observed[channel] - singletonColors[upper][channel]) * contribution
            denominator += contribution ** 2
          }
        }
        const transmittance = denominator ? clamp(numerator / denominator) : 0
        alpha[upper] = 1 - transmittance
      }
      let error = 0, weightTotal = 0
      for (let state = 1; state < palette.length; state++) {
        const weight = Math.sqrt(stateCounts[state])
        error += squaredError(palette[state], compose(stateMasks[state], order, alpha)) * weight
        weightTotal += weight * 3
      }
      return { order, alpha, rmse: weightTotal ? Math.sqrt(error / weightTotal) : Infinity }
    }).sort((a, b) => a.rmse - b.rmse)
    const best = candidates[0], runner = candidates[1]
    if (!best || !runner) return null

    let multiplyError = 0, multiplyWeight = 0
    for (let state = 1; state < palette.length; state++) {
      const predicted: RGB = [...palette[0]]
      for (let object = 0; object < objectCount; object++) if (stateMasks[state] & (1 << object)) for (let channel = 0; channel < 3; channel++)
        predicted[channel] = palette[0][channel] === 0 ? predicted[channel] : predicted[channel] * singletonColors[object][channel] / palette[0][channel]
      const weight = Math.sqrt(stateCounts[state])
      multiplyError += squaredError(palette[state], predicted) * weight
      multiplyWeight += weight * 3
    }
    const multiplyRmse = multiplyWeight ? Math.sqrt(multiplyError / multiplyWeight) : Infinity
    if (multiplyRmse < best.rmse) {
      const modelMargin = best.rmse - multiplyRmse
      return {
      model: 'multiply',
      fills: singletonColors.map((color) => color.map((value, channel) => byte(palette[0][channel] === 0 ? value : value / palette[0][channel] * 255)) as RGB),
      opacity: singletonColors.map(() => 1), order: objectIndices,
      bestRmse: multiplyRmse, runnerUpRmse: best.rmse, margin: best.rmse - multiplyRmse,
      alternativeModel: 'source-over', alternativeModelRmse: best.rmse, modelMargin,
      modelIdentifiable: modelMargin > Math.max(1, multiplyRmse * 0.1), orderIdentifiable: false,
      }
    }
    const orderGap = runner.rmse - best.rmse
    const modelMargin = multiplyRmse - best.rmse
    const modelIdentifiable = modelMargin > Math.max(1, best.rmse * 0.1)
    return {
      model: 'source-over',
      fills: singletonColors.map((color, index) => color.map((value, channel) =>
        byte((value - (1 - best.alpha[index]) * palette[0][channel]) / Math.max(best.alpha[index], 1e-6))) as RGB),
      opacity: best.alpha, order: best.order,
      bestRmse: best.rmse, runnerUpRmse: runner.rmse, margin: orderGap,
      alternativeModel: 'multiply', alternativeModelRmse: multiplyRmse, modelMargin, modelIdentifiable,
      orderIdentifiable: modelIdentifiable && orderGap > Math.max(1, best.rmse * 0.1),
    }
  }

  const isTree = embedding.edges.length === palette.length - 1
  if (!isTree) return null
  const layers = embedding.thetaClasses.map((edges, bit) => {
    const { a, b } = edges[0]
    const child = embedding.distances[0][a] > embedding.distances[0][b] ? a : b
    return { bit, depth: embedding.distances[0][child], color: palette[child] }
  }).sort((a, b) => a.depth - b.depth || a.bit - b.bit)
  const fills = objectIndices.map((index) => [...palette[0]] as RGB)
  for (const layer of layers) fills[layer.bit] = [...layer.color]
  return {
    model: 'effective-region-colors', fills, opacity: objectIndices.map(() => 1),
    order: layers.map(({ bit }) => bit), bestRmse: null, runnerUpRmse: null, margin: null, orderIdentifiable: false,
    modelMargin: null, modelIdentifiable: false,
  }
}

/**
 * Infer object-membership masks from the adjacency graph of dominant flat-color states.
 * This is an experimental route for 2–4 overlapping objects on an opaque flat backdrop;
 * it deliberately abstains on transparent backgrounds and most continuous gradients.
 */
export function proposePlanarColorHypotheses(image: RGBAImage, options: PlanarColorOptions = {}): PlanarColorProposalResult {
  if (!Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height) || image.width < 1 || image.height < 1 || image.data.length !== image.width * image.height * 4)
    throw new Error('Source raster dimensions or RGBA data are invalid.')
  const requestedMinAdjacency = options.minAdjacencyPixels ?? 25
  const adjacencyRadius = options.adjacencyRadius ?? 2
  const maxInteriorError = options.maximumInteriorColorErrorSquared ?? 12
  if (!Number.isSafeInteger(requestedMinAdjacency) || requestedMinAdjacency < 1) throw new Error('Minimum adjacency pixels must be a positive integer.')
  if (!Number.isSafeInteger(adjacencyRadius) || adjacencyRadius < 1 || adjacencyRadius > 4) throw new Error('Adjacency radius must be an integer from 1 to 4.')
  if (!Number.isSafeInteger(maxInteriorError) || maxInteriorError < 0) throw new Error('Maximum interior color error must be a nonnegative integer.')

  let nonOpaque = 0
  for (let offset = 3; offset < image.data.length; offset += 4) if (image.data[offset] < 250) nonOpaque++
  if (nonOpaque) return { status: 'abstained', reason: 'This provider requires a fully opaque raster with a flat backdrop touching its border.' }

  const raster = sampleRaster(image)
  const pixelCount = raster.width * raster.height
  const histogram = new Map<number, number>()
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    const offset = pixel * 4
    const key = (raster.data[offset] << 16) | (raster.data[offset + 1] << 8) | raster.data[offset + 2]
    histogram.set(key, (histogram.get(key) ?? 0) + 1)
    if (histogram.size > MAX_DISTINCT_COLORS)
      return { status: 'abstained', reason: `The raster contains more than ${MAX_DISTINCT_COLORS.toLocaleString('en-US')} distinct colors at the analysis size.` }
  }

  const borderWidth = Math.max(1, Math.floor(Math.min(raster.width, raster.height) * 0.02))
  const borderHistogram = new Map<number, number>()
  let borderPixels = 0
  for (let y = 0; y < raster.height; y++) for (let x = 0; x < raster.width; x++) {
    if (x >= borderWidth && x < raster.width - borderWidth && y >= borderWidth && y < raster.height - borderWidth) continue
    const offset = (y * raster.width + x) * 4
    const key = (raster.data[offset] << 16) | (raster.data[offset + 1] << 8) | raster.data[offset + 2]
    borderHistogram.set(key, (borderHistogram.get(key) ?? 0) + 1)
    borderPixels++
  }
  const [backgroundKey, backgroundCount] = [...borderHistogram.entries()].sort((a, b) => b[1] - a[1])[0] ?? []
  if (backgroundKey === undefined || backgroundCount < borderPixels * 0.5)
    return { status: 'abstained', reason: 'No dominant flat background color was found on the image border.' }
  const background = colorFromKey(backgroundKey)
  const minStatePixels = options.minStatePixels ?? 128
  if (!Number.isSafeInteger(minStatePixels) || minStatePixels < 1) throw new Error('Minimum color-state pixels must be a positive integer.')
  const states = [...histogram.entries()]
    .filter(([key, count]) => key !== backgroundKey && count >= minStatePixels)
    .sort((a, b) => b[1] - a[1])
  const palette = [background, ...states.map(([key]) => colorFromKey(key))]
  if (palette.length < 3 || palette.length > MAX_PALETTE_SIZE)
    return { status: 'abstained', reason: `Expected 3–${MAX_PALETTE_SIZE} dominant color states including the background; found ${palette.length}.` }

  const labels = new Uint8Array(pixelCount)
  const nearestErrors = new Uint32Array(pixelCount)
  const stateCounts = new Uint32Array(palette.length)
  for (let y = 0; y < raster.height; y++) for (let x = 0; x < raster.width; x++) {
    const offset = (y * raster.width + x) * 4
    const color: RGB = [raster.data[offset], raster.data[offset + 1], raster.data[offset + 2]]
    let nearest = 0, nearestError = Infinity
    for (let state = 0; state < palette.length; state++) {
      const error = squaredError(color, palette[state])
      if (error < nearestError) { nearest = state; nearestError = error }
    }
    const index = y * raster.width + x
    labels[index] = nearest
    nearestErrors[index] = nearestError
    stateCounts[nearest]++
  }

  const adjacency: Graph = Array.from({ length: palette.length }, () => new Map<number, number>())
  const addEdge = (a: number, b: number) => {
    if (a === b) return
    adjacency[a].set(b, (adjacency[a].get(b) ?? 0) + 1)
    adjacency[b].set(a, (adjacency[b].get(a) ?? 0) + 1)
  }
  const offsets: Array<[number, number]> = []
  for (let distance = 1; distance <= adjacencyRadius; distance++) offsets.push([distance, 0], [0, distance])
  for (let y = 0; y < raster.height; y++) for (let x = 0; x < raster.width; x++) {
    const index = y * raster.width + x
    if (nearestErrors[index] > maxInteriorError) continue
    for (const [dx, dy] of offsets) {
      const nx = x + dx, ny = y + dy
      if (nx >= raster.width || ny >= raster.height) continue
      const neighbor = ny * raster.width + nx
      if (nearestErrors[neighbor] > maxInteriorError || labels[index] === labels[neighbor]) continue
      const steps = Math.abs(dx) + Math.abs(dy)
      let blockedByThirdState = false
      for (let step = 1; step < steps; step++) {
        const between = (y + dy * step / steps) * raster.width + x + dx * step / steps
        if (nearestErrors[between] <= maxInteriorError && labels[between] !== labels[index] && labels[between] !== labels[neighbor]) {
          blockedByThirdState = true
          break
        }
      }
      if (!blockedByThirdState) addEdge(labels[index], labels[neighbor])
    }
  }

  const thresholds = [...new Set([requestedMinAdjacency, Math.max(1, Math.floor(requestedMinAdjacency / 2)), Math.max(1, Math.floor(requestedMinAdjacency / 4)), 1])].sort((a, b) => b - a)
  let selected: { graph: Graph; threshold: number; removed: Array<{ a: number; b: number; border: number }>; embedding: Embedding } | null = null
  for (const threshold of thresholds) {
    const base = graphAtThreshold(adjacency, threshold)
    const direct = embedPartialCube(base)
    if (direct) { selected = { graph: base, threshold, removed: [], embedding: direct }; break }
    const edges: Array<{ a: number; b: number; border: number }> = []
    for (let a = 0; a < palette.length; a++) for (const [b, border] of base[a]) if (a < b) edges.push({ a, b, border })
    if (edges.length > MAX_PRUNABLE_EDGES) continue
    for (let count = 1; count <= Math.min(2, edges.length) && !selected; count++) {
      const valid: Array<{ graph: Graph; threshold: number; removed: Array<{ a: number; b: number; border: number }>; embedding: Embedding }> = []
      for (const removed of chooseEdgeRemovals(edges, count)) {
        const graph = graphAtThreshold(adjacency, threshold, new Set(removed.map(({ a, b }) => `${a}:${b}`)))
        const embedding = embedPartialCube(graph)
        if (embedding) valid.push({ graph, threshold, removed, embedding })
      }
      valid.sort((a, b) => a.removed.reduce((sum, edge) => sum + edge.border, 0) - b.removed.reduce((sum, edge) => sum + edge.border, 0))
      if (valid.length) selected = valid[0]
    }
    if (selected) break
  }
  if (!selected) return {
    status: 'abstained',
    reason: 'Dominant color adjacency did not form a connected partial-cube embedding for two to four objects.',
  }

  const { stateMasks } = selected.embedding
  const paint = inferPaint(palette, stateCounts, stateMasks, selected.embedding)
  const objectCount = selected.embedding.thetaClasses.length
  if (!paint) return {
    status: 'abstained',
    reason: 'The membership graph is valid, but missing singleton colors prevent the available paint model from fitting this non-tree graph.',
  }

  const layerIds = Array.from({ length: objectCount }, (_, index) => `planar-object-${index + 1}`)
  const isTree = selected.embedding.edges.length === palette.length - 1
  const warnings = [
    'Membership masks come from dominant-color adjacency; this does not identify a semantic label or primitive family.',
    'The masks do not establish fully hidden geometry beyond the color-state memberships visible in this raster.',
  ]
  if (paint.model === 'multiply') {
    if (!paint.modelIdentifiable) warnings.push('The color residuals do not clearly distinguish Multiply from source-over; treat the paint model as ambiguous.')
    warnings.push('Multiply factors commute; the source paint order is not identifiable.')
  }
  else if (paint.model === 'source-over' && !paint.modelIdentifiable) warnings.push('The color residuals do not clearly distinguish source-over from Multiply; treat both paint and order as ambiguous.')
  else if (!paint.orderIdentifiable) warnings.push('The raster does not identify a unique source paint order; any effective rendering sequence is only provisional.')
  if (paint.model === 'effective-region-colors') warnings.push('Paint uses effective region colors because singleton object colors are missing; source fill and opacity are not separated.')
  if (selected.removed.length) warnings.push(`The embedding pruned ${selected.removed.length} weak adjacency edge(s); inspect the reported color graph before accepting masks.`)

  const hypotheses = layerIds.map((id, objectIndex) => {
    const maskData = new Uint8Array(pixelCount)
    for (let pixel = 0; pixel < pixelCount; pixel++) if (stateMasks[labels[pixel]] & (1 << objectIndex)) maskData[pixel] = 1
    const hypothesis = createMaskHypothesis({
      id,
      mask: { width: raster.width, height: raster.height, data: maskData },
      source: {
        provider: 'planar-color-adjacency', model: 'partial-cube-membership',
        description: 'Object membership inferred from dominant flat-color adjacency and a validated partial-cube embedding.',
      },
      ...(paint.bestRmse !== null ? { score: { value: paint.bestRmse, kind: 'provider-native' as const, label: 'best color-model RMSE; lower is better, not a calibrated confidence' } } : {}),
    })
    hypothesis.paint = {
      fill: colorHex(paint.fills[objectIndex]),
      opacity: paint.opacity[objectIndex],
      blendMode: paint.model === 'multiply' ? 'multiply' : 'normal',
      description: paint.model === 'effective-region-colors'
        ? 'Effective color assigned from a child-side graph region; original fill and opacity are not identifiable.'
        : paint.model === 'multiply'
          ? 'Approximate per-object Multiply fit; order is not identifiable.'
          : paint.modelIdentifiable
            ? 'Source-over color-state fit; bottom-layer source alpha and fill are not separately identifiable.'
            : 'Source-over is the lower-error candidate, but the Multiply fit is close; paint and order remain uncertain.',
    }
    if (paint.model === 'source-over' && paint.orderIdentifiable) hypothesis.paintOrder = paint.order
      .filter((other) => other !== objectIndex)
      .map((other) => ({
        relatedHypothesisId: layerIds[other],
        relation: paint.order.indexOf(objectIndex) < paint.order.indexOf(other) ? 'below' as const : 'above' as const,
        evidence: `Source-over fit RMSE ${paint.bestRmse?.toFixed(3)}; next order RMSE ${paint.runnerUpRmse?.toFixed(3)}; gap ${paint.margin?.toFixed(3)} RGB levels/channel.`,
      }))
    return hypothesis
  })

  return {
    status: 'proposed', hypotheses,
    diagnostics: {
      analysisSize: { width: raster.width, height: raster.height },
      background,
      colorStates: palette.map((color, state) => ({ color, pixels: stateCounts[state], membershipMask: stateMasks[state] })),
      graph: { objectCount, vertices: palette.length, edges: selected.embedding.edges.length, isTree, thetaClassCount: selected.embedding.thetaClasses.length },
      adjacency: {
        minimumStatePixels: minStatePixels,
        requestedMinimumBorderPixels: requestedMinAdjacency,
        selectedMinimumBorderPixels: selected.threshold,
        radiusPixels: adjacencyRadius,
        maximumInteriorColorErrorSquared: maxInteriorError,
        prunedEdges: selected.removed.map(({ a, b, border }) => ({ colorA: palette[a], colorB: palette[b], sharedBorderPixels: border })),
      },
      paintFit: {
        model: paint.model, bestRmse: paint.bestRmse, runnerUpRmse: paint.runnerUpRmse,
        margin: paint.margin, alternativeModel: paint.alternativeModel,
        alternativeModelRmse: paint.alternativeModelRmse, modelMargin: paint.modelMargin,
        modelIdentifiable: paint.modelIdentifiable, orderIdentifiable: paint.orderIdentifiable,
        ...(paint.orderIdentifiable ? { bottomToTop: paint.order.map((index) => layerIds[index]) } : {}),
      },
      warnings,
    },
  }
}
