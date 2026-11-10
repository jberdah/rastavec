import type { BinarySegmentationMask } from './segmentation-mask'

export type ObjectMaskMeaning = 'unknown' | 'visible-object' | 'completed-object'

export type ObjectPathAssociationStatus = 'supporting' | 'partial' | 'ambiguous' | 'unrelated'
export type ObjectPathSupportBasis = 'visible-support' | 'completed-geometry' | 'unknown-mask-meaning'

export interface ObjectPathAssociation {
  pathIndex: number
  pathId: string
  /** Coverage of the traced path using the hypothesis' declared mask meaning. */
  pathCoverage: number
  /** Coverage of the hypothesis mask using the same support basis. */
  hypothesisCoverage: number
  status: ObjectPathAssociationStatus
  supportBasis: ObjectPathSupportBasis
  geometricPathCoverage: number
  geometricHypothesisCoverage: number
  visiblePathCoverage: number
  visibleHypothesisCoverage: number
  intersectionPixels: { geometric: number; visible: number }
  reason: string
}

export interface ObjectHypothesisSource {
  provider: string
  model?: string
  prompt?: { x: number; y: number; row?: number; column?: number }
  description?: string
}

export interface ObjectGradientPaint {
  kind: 'linear' | 'radial'
  coordinateSpace: 'object-bounds' | 'source-image-pixels'
  geometry: Record<string, number>
  stops: Array<{ offset: number; color: string; opacity?: number }>
}

export type ObjectBlendMode = 'normal' | 'multiply' | 'screen' | 'overlay' | 'darken' | 'lighten' | 'unknown'

export interface ObjectHypothesis {
  id: string
  /** Coverage in source-image coordinates; dimensions may be reduced while preserving aspect ratio. */
  mask: BinarySegmentationMask
  /** A provider mask does not establish whether hidden geometry was completed. */
  maskMeaning: ObjectMaskMeaning
  source: ObjectHypothesisSource
  /** Provider-native scores are retained without treating them as calibrated confidence. */
  score?: { value: number; kind: 'provider-native' | 'calibrated'; label?: string }
  geometry?: {
    family: 'unknown' | 'circle' | 'ellipse' | 'polygon' | 'freeform'
    completeness: 'unknown' | 'visible' | 'completed'
    parameters?: Record<string, number | string>
  }
  pathAssociations?: ObjectPathAssociation[]
  paint?: {
    /** Solid fill retained for existing providers. Gradient paint is represented separately. */
    fill?: string
    gradient?: ObjectGradientPaint
    opacity?: number
    blendMode?: ObjectBlendMode
    description?: string
  }
  paintOrder?: Array<{
    relatedHypothesisId: string
    relation: 'above' | 'below'
    confidence?: number
    evidence?: string
  }>
}

export interface ProviderObjectCount {
  provider: string
  count: number
}

export interface ProviderObjectCountComparison {
  basis: 'hypothesis-count-only'
  status: 'insufficient-data' | 'counts-agree' | 'counts-disagree'
  providers: ProviderObjectCount[]
}

export interface ProviderHypothesisSet {
  provider: string
  hypotheses: readonly Pick<ObjectHypothesis, 'id' | 'mask' | 'maskMeaning'>[]
  /** Keep semantically different masks out of pairwise IoU matching while retaining their counts. */
  compareMasks?: boolean
}

export interface ProviderMaskSetComparison {
  leftProvider: string
  rightProvider: string
  leftMaskMeanings: ObjectMaskMeaning[]
  rightMaskMeanings: ObjectMaskMeaning[]
  maskMeaningsComparable: boolean
  matchingThreshold: number
  meanAssignedIoU: number | null
  meanMatchedIoU: number | null
  matchesAtThreshold: number
  matches: Array<{ leftHypothesisId: string; rightHypothesisId: string; iou: number; acceptedAtThreshold: boolean }>
  unmatchedLeft: string[]
  unmatchedRight: string[]
}

export interface ProviderHypothesisSetComparison extends Omit<ProviderObjectCountComparison, 'basis'> {
  basis: 'hypothesis-count-and-selected-mask-iou'
  maskComparableProviders: string[]
  maskComparisons: ProviderMaskSetComparison[]
}

/** Compare the number of object hypotheses from independent proposal routes.
 * Equal counts do not establish that the routes found the same objects.
 */
export function compareProviderObjectCounts(counts: readonly ProviderObjectCount[]): ProviderObjectCountComparison {
  const providers = counts.filter(({ count }) => Number.isSafeInteger(count) && count > 0).map(({ provider, count }) => ({ provider, count }))
  const distinctCounts = new Set(providers.map(({ count }) => count))
  return {
    basis: 'hypothesis-count-only',
    status: providers.length < 2 ? 'insufficient-data' : distinctCounts.size > 1 ? 'counts-disagree' : 'counts-agree',
    providers,
  }
}

function maskIoU(a: BinarySegmentationMask, b: BinarySegmentationMask): number | null {
  if (a.width < 1 || a.height < 1 || a.data.length !== a.width * a.height || b.width < 1 || b.height < 1 || b.data.length !== b.width * b.height)
    return null
  if (a.width === b.width && a.height === b.height) {
    let intersection = 0, union = 0
    for (let pixel = 0; pixel < a.data.length; pixel++) {
      const inA = a.data[pixel] !== 0, inB = b.data[pixel] !== 0
      if (inA || inB) union++
      if (inA && inB) intersection++
    }
    return union ? intersection / union : null
  }
  const aspectA = a.width / a.height, aspectB = b.width / b.height
  if (Math.abs(aspectA - aspectB) / Math.max(aspectA, aspectB) > 0.01) return null
  const width = Math.max(a.width, b.width), height = Math.max(a.height, b.height)
  let intersection = 0, union = 0
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const ax = Math.min(a.width - 1, Math.floor((x + 0.5) * a.width / width))
    const ay = Math.min(a.height - 1, Math.floor((y + 0.5) * a.height / height))
    const bx = Math.min(b.width - 1, Math.floor((x + 0.5) * b.width / width))
    const by = Math.min(b.height - 1, Math.floor((y + 0.5) * b.height / height))
    const inA = a.data[ay * a.width + ax] !== 0
    const inB = b.data[by * b.width + bx] !== 0
    if (inA || inB) union++
    if (inA && inB) intersection++
  }
  return union ? intersection / union : null
}

/** Maximum-weight one-to-one assignment for a rectangular matrix. */
function maximumAssignment(weights: number[][]): Array<[number, number]> {
  const rowCount = weights.length
  const columnCount = weights[0]?.length ?? 0
  if (!rowCount || !columnCount) return []
  const transposed = rowCount > columnCount
  const matrix = transposed
    ? Array.from({ length: columnCount }, (_, column) => Array.from({ length: rowCount }, (_, row) => weights[row][column]))
    : weights
  const rows = matrix.length, columns = matrix[0].length
  const u = new Array<number>(rows + 1).fill(0)
  const v = new Array<number>(columns + 1).fill(0)
  const p = new Array<number>(columns + 1).fill(0)
  const way = new Array<number>(columns + 1).fill(0)
  for (let i = 1; i <= rows; i++) {
    p[0] = i
    let column0 = 0
    const minValue = new Array<number>(columns + 1).fill(Infinity)
    const used = new Array<boolean>(columns + 1).fill(false)
    do {
      used[column0] = true
      const row0 = p[column0]
      let delta = Infinity, column1 = 0
      for (let column = 1; column <= columns; column++) if (!used[column]) {
        const cost = 1 - matrix[row0 - 1][column - 1]
        const current = cost - u[row0] - v[column]
        if (current < minValue[column]) { minValue[column] = current; way[column] = column0 }
        if (minValue[column] < delta) { delta = minValue[column]; column1 = column }
      }
      for (let column = 0; column <= columns; column++) {
        if (used[column]) { u[p[column]] += delta; v[column] -= delta }
        else minValue[column] -= delta
      }
      column0 = column1
    } while (p[column0] !== 0)
    do {
      const column1 = way[column0]
      p[column0] = p[column1]
      column0 = column1
    } while (column0 !== 0)
  }
  const assignments: Array<[number, number]> = []
  for (let column = 1; column <= columns; column++) if (p[column]) {
    const pair: [number, number] = [p[column] - 1, column - 1]
    assignments.push(transposed ? [pair[1], pair[0]] : pair)
  }
  return assignments.sort((a, b) => a[0] - b[0])
}

/** Compare provider proposal sets without choosing a winner or treating IoU as confidence. */
export function compareProviderHypothesisSets(
  sets: readonly ProviderHypothesisSet[],
  matchingThreshold = 0.5,
): ProviderHypothesisSetComparison {
  if (!(matchingThreshold >= 0 && matchingThreshold <= 1)) throw new Error('Mask matching threshold must be between 0 and 1.')
  const usable = sets.filter(({ hypotheses }) => hypotheses.length > 0)
  const counts = compareProviderObjectCounts(usable.map(({ provider, hypotheses }) => ({ provider, count: hypotheses.length })))
  const maskComparable = usable.filter(({ compareMasks }) => compareMasks !== false)
  const maskComparisons: ProviderMaskSetComparison[] = []
  for (let left = 0; left < maskComparable.length; left++) for (let right = left + 1; right < maskComparable.length; right++) {
    const a = maskComparable[left], b = maskComparable[right]
    const leftMaskMeanings = [...new Set(a.hypotheses.map(({ maskMeaning }) => maskMeaning))]
    const rightMaskMeanings = [...new Set(b.hypotheses.map(({ maskMeaning }) => maskMeaning))]
    const meaningCounts = (hypotheses: ProviderHypothesisSet['hypotheses']) => {
      const counts = new Map<ObjectMaskMeaning, number>()
      for (const hypothesis of hypotheses) counts.set(hypothesis.maskMeaning, (counts.get(hypothesis.maskMeaning) ?? 0) + 1)
      return counts
    }
    const leftCounts = meaningCounts(a.hypotheses), rightCounts = meaningCounts(b.hypotheses)
    const maskMeaningsComparable = !leftCounts.has('unknown') && !rightCounts.has('unknown')
      && leftCounts.size === rightCounts.size
      && [...leftCounts].every(([meaning, count]) => rightCounts.get(meaning) === count)
    const sharedKnownMeanings = [...leftCounts.keys()].filter((meaning) => meaning !== 'unknown' && rightCounts.has(meaning))
    const assignedPairs: Array<{ leftIndex: number; rightIndex: number; iou: number }> = []
    for (const meaning of sharedKnownMeanings) {
      const leftIndices = a.hypotheses.flatMap((hypothesis, index) => hypothesis.maskMeaning === meaning ? [index] : [])
      const rightIndices = b.hypotheses.flatMap((hypothesis, index) => hypothesis.maskMeaning === meaning ? [index] : [])
      const matrix = leftIndices.map((leftIndex) => rightIndices.map((rightIndex) =>
        maskIoU(a.hypotheses[leftIndex].mask, b.hypotheses[rightIndex].mask) ?? 0))
      for (const [localLeft, localRight] of maximumAssignment(matrix))
        assignedPairs.push({ leftIndex: leftIndices[localLeft], rightIndex: rightIndices[localRight], iou: matrix[localLeft][localRight] })
    }
    const matches = assignedPairs.map(({ leftIndex, rightIndex, iou }) => ({
      leftHypothesisId: a.hypotheses[leftIndex].id,
      rightHypothesisId: b.hypotheses[rightIndex].id,
      iou,
      acceptedAtThreshold: iou >= matchingThreshold,
    }))
    const accepted = assignedPairs.filter(({ iou }) => iou >= matchingThreshold)
    const matchedLeft = new Set(accepted.map(({ leftIndex }) => leftIndex))
    const matchedRight = new Set(accepted.map(({ rightIndex }) => rightIndex))
    const acceptedIous = accepted.map(({ iou }) => iou)
    maskComparisons.push({
      leftProvider: a.provider, rightProvider: b.provider, leftMaskMeanings, rightMaskMeanings,
      maskMeaningsComparable, matchingThreshold,
      meanAssignedIoU: assignedPairs.length ? assignedPairs.reduce((sum, pair) => sum + pair.iou, 0) / assignedPairs.length : null,
      meanMatchedIoU: acceptedIous.length ? acceptedIous.reduce((sum, value) => sum + value, 0) / acceptedIous.length : null,
      matchesAtThreshold: accepted.length,
      matches,
      unmatchedLeft: a.hypotheses.filter((_, index) => !matchedLeft.has(index)).map(({ id }) => id),
      unmatchedRight: b.hypotheses.filter((_, index) => !matchedRight.has(index)).map(({ id }) => id),
    })
  }
  return { ...counts, basis: 'hypothesis-count-and-selected-mask-iou', maskComparableProviders: maskComparable.map(({ provider }) => provider), maskComparisons }
}

export function createMaskHypothesis(input: {
  id: string
  mask: BinarySegmentationMask
  source: ObjectHypothesisSource
  score?: ObjectHypothesis['score']
}): ObjectHypothesis {
  const { id, mask, source, score } = input
  if (!id.trim() || !source.provider.trim()) throw new Error('Object hypothesis provenance is missing.')
  if (!Number.isSafeInteger(mask.width) || !Number.isSafeInteger(mask.height) || mask.width < 1 || mask.height < 1 || mask.data.length !== mask.width * mask.height)
    throw new Error('Object hypothesis mask dimensions are invalid.')
  if (!mask.data.some((value) => value !== 0)) throw new Error('Object hypothesis mask is empty.')
  if (score && !Number.isFinite(score.value)) throw new Error('Object hypothesis score is invalid.')
  return { id, mask, maskMeaning: 'unknown', source: { ...source }, ...(score ? { score: { ...score } } : {}) }
}
