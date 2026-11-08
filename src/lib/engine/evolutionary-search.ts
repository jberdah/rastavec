import type { TraceParams } from './types'

export interface SearchSample {
  params: TraceParams
  score: number
}

export interface EvolutionOptions {
  /** Hard upper bound on additional traces. */
  maxEvaluations?: number
  /** Number of offspring proposed before selecting the next generation. */
  generationSize?: number
  /** Hard upper bound on generations. */
  generations?: number
}

type Gene = 'colorPrecision' | 'layerDifference' | 'speckle' | 'cornerThreshold' | 'lengthThreshold' | 'mode' | 'silhouetteCut' | 'softLayers' | 'softColor'
const COLOR_GENES: Gene[] = ['colorPrecision', 'layerDifference', 'speckle', 'cornerThreshold', 'lengthThreshold', 'mode', 'silhouetteCut', 'softLayers', 'softColor']
const BINARY_GENES: Gene[] = ['speckle', 'mode']
const SILHOUETTE_CUTS = [32, 64, 96, 128, 160, 192, 224, 255]

const keyOf = (params: TraceParams) => JSON.stringify(params)
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, Math.round(value)))

function hashText(text: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 0x01000193) }
  return hash >>> 0
}

function randomGenerator(seed: number) {
  let state = seed || 0x9e3779b9
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0x1_0000_0000
  }
}

function mutate(params: TraceParams, gene: Gene, random: () => number): TraceParams {
  const next = { ...params }
  const direction = random() < 0.5 ? -1 : 1
  switch (gene) {
    case 'colorPrecision': next.colorPrecision = clamp(next.colorPrecision + direction, 1, 8); break
    case 'layerDifference': next.layerDifference = clamp(next.layerDifference + direction * (1 + Math.floor(random() * 4)), 1, 255); break
    case 'speckle': next.speckle = clamp(next.speckle + direction * (1 + Math.floor(random() * 3)), 0, 128); break
    case 'cornerThreshold': next.cornerThreshold = clamp(next.cornerThreshold + direction * (5 + Math.floor(random() * 16)), 0, 180); break
    case 'lengthThreshold': next.lengthThreshold = clamp(next.lengthThreshold + direction * (1 + Math.floor(random() * 3)), 0, 100); break
    case 'mode': next.mode = next.mode === 'spline' ? 'polygon' : 'spline'; break
    case 'silhouetteCut': {
      const index = SILHOUETTE_CUTS.indexOf(next.silhouetteCut)
      const current = index < 0 ? SILHOUETTE_CUTS.reduce((best, value, i) => Math.abs(value - next.silhouetteCut) < Math.abs(SILHOUETTE_CUTS[best] - next.silhouetteCut) ? i : best, 0) : index
      next.silhouetteCut = SILHOUETTE_CUTS[clamp(current + direction, 0, SILHOUETTE_CUTS.length - 1)]
      break
    }
    case 'softLayers': next.softLayers = clamp(next.softLayers + direction, 0, 6); break
    case 'softColor': next.softColor = !next.softColor; break
  }
  return next
}

/** Propose a deterministic, unique generation from the best-scoring previous samples. */
export function proposeEvolutionaryCandidates(
  population: readonly SearchSample[],
  occupied: ReadonlySet<string>,
  generation: number,
  count: number,
): TraceParams[] {
  if (!population.length || count <= 0) return []
  const ranked = [...population].sort((a, b) => a.score - b.score || keyOf(a.params).localeCompare(keyOf(b.params)))
  const parents = ranked.slice(0, Math.min(4, ranked.length))
  const genes = parents[0].params.colormode === 'binary' ? BINARY_GENES : COLOR_GENES
  const seed = hashText(`${generation}|${parents.map((sample) => `${keyOf(sample.params)}:${sample.score.toPrecision(12)}`).join('|')}`)
  const random = randomGenerator(seed)
  const seen = new Set(occupied)
  const candidates: TraceParams[] = []
  let attempts = 0
  while (candidates.length < count && attempts++ < count * 64) {
    const firstIndex = Math.floor(random() * parents.length)
    let secondIndex = parents.length > 1 ? Math.floor(random() * (parents.length - 1)) : firstIndex
    if (secondIndex >= firstIndex) secondIndex++
    const first = parents[firstIndex].params
    const second = parents[secondIndex].params
    let child = { ...first }
    for (const gene of genes) if (random() < 0.45) child = { ...child, [gene]: second[gene] }
    const mutationCount = 1 + Math.floor(random() * Math.min(3, genes.length))
    for (let mutation = 0; mutation < mutationCount; mutation++) {
      const gene = genes[Math.floor(random() * genes.length)]
      child = mutate(child, gene, random)
    }
    const key = keyOf(child)
    if (seen.has(key)) continue
    seen.add(key)
    candidates.push(child)
  }
  return candidates
}

/** Evaluate a fixed number of deterministic generations; the caller supplies the expensive trace. */
export async function runEvolutionarySearch<T extends SearchSample>(
  initial: readonly T[],
  evaluate: (params: TraceParams) => Promise<T>,
  options: EvolutionOptions = {},
): Promise<T[]> {
  const maxEvaluations = clamp(options.maxEvaluations ?? 8, 0, 64)
  const generationSize = clamp(options.generationSize ?? 4, 1, 16)
  const generations = clamp(options.generations ?? 2, 1, 8)
  const population: T[] = [...initial]
  const extras: T[] = []
  const occupied = new Set(population.map((sample) => keyOf(sample.params)))
  for (let generation = 0; generation < generations && extras.length < maxEvaluations; generation++) {
    const count = Math.min(generationSize, maxEvaluations - extras.length)
    const params = proposeEvolutionaryCandidates(population, occupied, generation, count)
    if (!params.length) break
    for (const candidate of params) {
      const sample = await evaluate(candidate)
      extras.push(sample)
      population.push(sample)
      occupied.add(keyOf(candidate))
      if (extras.length >= maxEvaluations) break
    }
  }
  return extras
}
