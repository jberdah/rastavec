import type { TraceBackend } from './core'
import { parsePaths } from './trace-options'
import { nextOptions, withVTracerNext, type NextConvert } from './vtracer-next-trace'

interface NextModule {
  default: () => Promise<unknown>
  vectorize_rgba: (data: Uint8Array, width: number, height: number, options: ReturnType<typeof nextOptions>) => string
  /** Returns `[svg, reportJson]`. */
  vectorize_rgba_structured: (data: Uint8Array, width: number, height: number, options: ReturnType<typeof nextOptions>) => [string, string]
}

const modules = import.meta.glob<NextModule>('./vtracer-next-wasm/vtracer_next.js')
let initialized: Promise<NextModule> | undefined

async function loadNext(): Promise<NextModule> {
  const load = modules['./vtracer-next-wasm/vtracer_next.js']
  if (!load) throw new Error('VTracer-Next WASM is missing. Restore the generated module or run npm run build:vtracer-next.')
  initialized ??= load().then(async (module) => {
    await module.default()
    return module
  }).catch((error: unknown) => {
    initialized = undefined
    throw error
  })
  return initialized
}

export function createVTracerNextBackend(base: Pick<TraceBackend, 'rasterize'>, gradients: boolean): TraceBackend {
  const convert: NextConvert = async (image, params, binary, experimentalGradients) => {
    const module = await loadNext()
    const data = new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength)
    const options = nextOptions(params, binary, experimentalGradients)
    if (binary) return module.vectorize_rgba(data, image.width, image.height, options)
    const [svg, report] = module.vectorize_rgba_structured(data, image.width, image.height, options)
    return { svg, report }
  }

  return withVTracerNext(base, gradients, convert, async (image, params, binary) => {
    const result = await convert(image, params, binary, false)
    return parsePaths(typeof result === 'string' ? result : result.svg, params.compactPaths, params.pathPrecision)
  })
}
