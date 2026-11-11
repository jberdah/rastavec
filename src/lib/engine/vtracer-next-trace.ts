import { composeSvg, type RunConverter } from './compose'
import type { RGBAImage, TraceBackend } from './core'
import type { TraceParams } from './types'

export type NextConvert = (image: RGBAImage, params: TraceParams, binary: boolean, gradients: boolean) => Promise<string>

function withViewport(svg: string, source: RGBAImage): string {
  const root = /<svg\b[^>]*>/.exec(svg)
  if (!root || !/<\/svg>\s*$/.test(svg)) throw new Error('VTracer-Next returned invalid SVG.')
  // Start at the root and retain its coordinates when a trial is traced at higher resolution.
  if (/\sviewBox=/.test(root[0])) return svg.slice(root.index)
  const end = root.index + root[0].length - 1
  return svg.slice(root.index, end) + ` viewBox="0 0 ${source.width} ${source.height}"` + svg.slice(end)
}

export function withVTracerNext(
  base: Pick<TraceBackend, 'rasterize'>,
  gradients: boolean,
  convert: NextConvert,
  binaryConverter: RunConverter,
): TraceBackend {
  return {
    name: gradients ? 'VTracer-Next (experimental gradients)' : 'VTracer-Next',
    supportsHierarchyComparison: !gradients,
    rasterize: base.rasterize.bind(base),
    trace(prepared, params) {
      return composeSvg(prepared, params, binaryConverter)
    },
    async traceColorSource(source, params) {
      return withViewport(await convert(source, params, false, gradients), source)
    },
    ...(!gradients ? { async traceColorSourceWithGradients(source: RGBAImage, params: TraceParams) {
      return withViewport(await convert(source, params, false, true), source)
    } } : {}),
  }
}
