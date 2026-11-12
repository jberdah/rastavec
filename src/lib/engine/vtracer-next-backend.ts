import type { TraceBackend } from './core'
import { parsePaths } from './trace-options'
import { nextOptions, withVTracerNext, type NextConvert } from './vtracer-next-trace'
// Static import on purpose: in the macOS WebView (WKWebView, tauri:// scheme) a dynamic import()
// inside a module worker never settles, which left every batch stuck before its first trial.
// Only the small JS glue is bundled here; the WASM binary is still fetched on first use.
import * as nextGlue from './vtracer-next-wasm/vtracer_next.js'

interface NextModule {
  default: () => Promise<unknown>
  vectorize_rgba: (data: Uint8Array, width: number, height: number, options: ReturnType<typeof nextOptions>) => string
  /** Returns `[svg, reportJson]`. */
  vectorize_rgba_structured: (data: Uint8Array, width: number, height: number, options: ReturnType<typeof nextOptions>) => [string, string]
}

let initialized: Promise<NextModule> | undefined

async function loadNext(): Promise<NextModule> {
  const module = nextGlue as unknown as NextModule
  initialized ??= module.default().then(() => module).catch((error: unknown) => {
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
