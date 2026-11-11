import { rasterizeOnMain } from './worker-raster-rpc'
import type { Prepared, RGBAImage, TraceBackend } from './core'
import type { TraceParams } from './types'

export const workerBackend: TraceBackend = {
  name: 'VTracer-Next (WASM) worker + main-thread Canvas',

  async trace(_prepared: Prepared, _params: TraceParams) {
    throw new Error('Select the VTracer-Next tracing backend before vectorizing.')
  },

  rasterize: rasterizeOnMain,
}
