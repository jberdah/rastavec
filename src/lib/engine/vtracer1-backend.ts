import init, { vectorize_rgba } from './vtracer1-wasm/vtracer1.js'
import { normalizeHex, type Prepared, type RGBAImage, type TraceBackend } from './core'
import { compactPath } from './compact'
import { composeSvg, type RawPath } from './compose'
import type { TraceParams } from './types'

let wasmPromise: Promise<unknown> | null = null
const loadWasm = () => (wasmPromise ??= init())

function optionsFor(p: TraceParams, binary: boolean) {
  return {
    clustering: binary ? 'bw' : 'color-cluster',
    ...(binary ? { binaryThreshold: 128 } : {}),
    hierarchical: 'stacked',
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

function parsePaths(svg: string, compact: boolean, precision: number): RawPath[] {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
  if (doc.querySelector('parsererror')) throw new Error('VTracer 1 returned invalid SVG.')
  const paths: RawPath[] = []
  for (const el of Array.from(doc.querySelectorAll('path'))) {
    const d = el.getAttribute('d')?.trim()
    if (!d) continue
    const fill = normalizeHex(el.getAttribute('fill') ?? '#000000')
    const transform = el.getAttribute('transform')
    const small = compact ? compactPath(d, transform, precision) : null
    paths.push(small !== null ? { d: small, fill, transform: null } : { d, fill, transform })
  }
  return paths
}

async function runVTracer(image: RGBAImage, p: TraceParams, binary: boolean): Promise<RawPath[]> {
  await loadWasm()
  const data = new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength)
  const svg = vectorize_rgba(data, image.width, image.height, optionsFor(p, binary))
  return parsePaths(svg, p.compactPaths, p.pathPrecision)
}

export const vtracer1Backend: TraceBackend = {
  name: 'VTracer 1.0.0-alpha.4 (WASM) + canvas',

  trace(prepared: Prepared, params: TraceParams) {
    return composeSvg(prepared, params, runVTracer)
  },

  async rasterize(svg: string, width: number, height: number) {
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
    try {
      const image = new Image()
      image.src = url
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d', { willReadFrequently: true })
      if (!context) throw new Error('Could not allocate a canvas to render SVG output.')
      context.drawImage(image, 0, 0, width, height)
      const pixels = context.getImageData(0, 0, width, height)
      return { data: pixels.data, width, height }
    } finally {
      URL.revokeObjectURL(url)
    }
  },
}
