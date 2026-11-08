import { composeSvg } from './compose'
import { runVTracer } from './vtracer1-backend'
import { rasterizeOnMain } from './worker-raster-rpc'
import type { Prepared, RGBAImage, TraceBackend } from './core'
import type { TraceParams } from './types'

export const workerBackend: TraceBackend = {
  name: 'VTracer 1.0.0-alpha.4 (WASM) worker + main-thread Canvas',

  trace(prepared: Prepared, params: TraceParams) {
    return composeSvg(prepared, params, runVTracer)
  },

  rasterize: rasterizeOnMain,
}
