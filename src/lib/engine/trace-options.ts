import { normalizeHex } from './core'
import { compactPath } from './compact'
import type { RawPath } from './compose'
import type { TraceParams } from './types'

export function optionsFor(p: TraceParams, binary: boolean) {
  return {
    clustering: binary ? 'bw' : (p.clustering ?? 'color-cluster'),
    watershedDetail: p.watershedDetail ?? 128,
    ...(binary ? { binaryThreshold: 128 } : {}),
    hierarchical: binary ? 'stacked' : (p.hierarchical ?? 'stacked'),
    mode: p.mode,
    filterSpeckle: p.speckle,
    colorPrecision: p.colorPrecision,
    layerDifference: p.layerDifference,
    cornerThreshold: p.cornerThreshold,
    lengthThreshold: p.lengthThreshold,
    maxIterations: 10,
    spliceThreshold: p.spliceThreshold,
    pathPrecision: p.pathPrecision,
    optimize: 1,
  } as const
}

export function parsePaths(svg: string, compact: boolean, precision: number): RawPath[] {
  const paths: RawPath[] = []
  // Avoid DOMParser so browser, worker, Node CLI, and benchmarks share one parser.
  // VTracer emits quoted attributes and path data with no embedded `>` characters.
  if (!/<svg\b/i.test(svg) || !/<\/svg\s*>\s*$/i.test(svg)) throw new Error('VTracer-Next returned invalid SVG.')
  for (const match of svg.matchAll(/<path\b([^>]*)\/?\s*>/gi)) {
    const attributes = Object.fromEntries([...match[1].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map((attribute) => [attribute[1].toLowerCase(), attribute[2] ?? attribute[3] ?? '']))
    const d = attributes.d?.trim()
    if (!d) continue
    const fill = normalizeHex(attributes.fill ?? '#000000')
    const transform = attributes.transform ?? null
    const small = compact ? compactPath(d, transform, precision) : null
    paths.push(small !== null ? { d: small, fill, transform: null } : { d, fill, transform })
  }
  return paths
}
