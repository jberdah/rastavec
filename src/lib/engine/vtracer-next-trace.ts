import { composeSvg, type RunConverter } from './compose'
import type { RGBAImage, TraceBackend } from './core'
import { optionsFor } from './trace-options'
import type { EngineShapeHint, TraceParams } from './types'

/**
 * How a color trace treats gradients: not at all, fitted as closely as the color bands were
 * (`true`), or `'simple'`: fewer, simpler gradient shapes at some cost in fidelity.
 */
export type GradientMode = boolean | 'simple'

/** RMS color tolerance of the engine's `'simple'` gradient mode (its default is 4). */
export const SIMPLE_GRADIENT_TOLERANCE = 10

/** A converter returns the SVG, optionally with the engine's JSON shape report. */
export type NextConvert = (image: RGBAImage, params: TraceParams, binary: boolean, gradients: GradientMode) => Promise<string | { svg: string; report?: string }>

/**
 * Options for one VTracer-Next call. The gradient route also keeps gentle gradients as bands
 * (otherwise the engine flattens them before it can fit anything). Shape detection only
 * replaces outlines the engine has verified as circles, so every color trace asks for it.
 */
export const nextOptions = (params: TraceParams, binary: boolean, gradients: GradientMode) => ({
  ...optionsFor(params, binary),
  experimentalGradients: gradients !== false,
  preserveGradients: gradients !== false,
  ...(gradients === 'simple' ? { gradientTolerance: SIMPLE_GRADIENT_TOLERANCE } : {}),
  detectShapes: !binary,
})

/** Keep only the paths the engine has something to say about. */
export function parseShapeHints(report: string): EngineShapeHint[] {
  try {
    const shapes = (JSON.parse(report) as { shapes?: EngineShapeHint[] }).shapes
    if (!Array.isArray(shapes)) return []
    return shapes
      .filter((shape) => shape.kind !== 'path' || shape.gradient !== undefined || shape.overlayOf !== undefined)
      .map(({ index, kind, cx, cy, r, rx, ry, rotation, innerCx, innerCy, innerR, gradient, overlayOf, bounds }) => ({
        index, kind,
        ...(kind === 'circle' ? { cx, cy, r } : kind === 'ellipse' ? { cx, cy, rx, ry, rotation }
          : kind === 'crescent' ? { cx, cy, r, innerCx, innerCy, innerR } : {}),
        ...(gradient ? { gradient } : {}), ...(overlayOf !== undefined ? { overlayOf } : {}), bounds,
      }))
  } catch {
    return []
  }
}

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
  // Hints are keyed by the exact SVG handed back, for the caller to pick up right after a trace.
  const hints = new Map<string, EngineShapeHint[]>()
  const colorTrace = async (source: RGBAImage, params: TraceParams, withGradients: GradientMode) => {
    const result = await convert(source, params, false, withGradients)
    const svg = withViewport(typeof result === 'string' ? result : result.svg, source)
    const shapes = typeof result === 'string' || !result.report ? [] : parseShapeHints(result.report)
    if (shapes.length) {
      hints.set(svg, shapes)
      if (hints.size > 16) hints.delete(hints.keys().next().value!)
    }
    return svg
  }
  return {
    name: gradients ? 'VTracer-Next (experimental gradients)' : 'VTracer-Next',
    supportsHierarchyComparison: !gradients,
    rasterize: base.rasterize.bind(base),
    trace(prepared, params) {
      return composeSvg(prepared, params, binaryConverter)
    },
    gradientsByDefault: gradients,
    traceColorSource: (source, params) => colorTrace(source, params, gradients),
    traceColorSourceWithGradients: (source: RGBAImage, params: TraceParams, simple = false) => colorTrace(source, params, simple ? 'simple' : true),
    shapeHintsFor: (svg) => hints.get(svg),
  }
}
