import { vectorize, VectorizationCancelled } from './vectorize'
import type { Analysis } from './analyze'
import type { RGBAImage } from './core'
import type { VectorizeResult, VectorizeSettings } from './vectorize'
import { workerBackend } from './worker-backend'
import { beginWorkerRasterRequest, endWorkerRasterRequest, resolveWorkerRasterization, type RasterizeReplyMessage } from './worker-raster-rpc'

type VectorizeMessage = {
  type: 'vectorize'
  requestId: number
  buffer: ArrayBuffer
  width: number
  height: number
  settings: VectorizeSettings
  analysis?: Analysis
}
type CancelMessage = { type: 'cancel'; requestId: number }
type RequestMessage = VectorizeMessage | CancelMessage | RasterizeReplyMessage
type ResponseMessage =
  | { type: 'progress'; requestId: number; done: number; total: number }
  | { type: 'result'; requestId: number; result: VectorizeResult; sourceBuffer: ArrayBuffer }
  | { type: 'error'; requestId: number; message: string; cancelled: boolean; sourceBuffer: ArrayBuffer }
  | { type: 'rasterize'; requestId: number; rasterId: number; svg: string; width: number; height: number }

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<RequestMessage>) => void) | null
  postMessage: (message: ResponseMessage, transfer?: Transferable[]) => void
}
const cancelled = new Set<number>()
const yieldToWorkerEvents = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

async function run(message: VectorizeMessage) {
  beginWorkerRasterRequest(message.requestId)
  const source: RGBAImage = {
    data: new Uint8ClampedArray(message.buffer),
    width: message.width,
    height: message.height,
  }
  try {
    const result = await vectorize(source, message.settings, workerBackend, {
      analysis: message.analysis,
      onProgress: (done, total) => scope.postMessage({ type: 'progress', requestId: message.requestId, done, total }),
      shouldCancel: () => cancelled.has(message.requestId),
      yieldControl: yieldToWorkerEvents,
    })
    scope.postMessage({ type: 'result', requestId: message.requestId, result, sourceBuffer: message.buffer }, [message.buffer])
  } catch (error) {
    scope.postMessage({
      type: 'error',
      requestId: message.requestId,
      message: error instanceof Error ? error.message : String(error),
      cancelled: error instanceof VectorizationCancelled,
      sourceBuffer: message.buffer,
    }, [message.buffer])
  } finally {
    endWorkerRasterRequest(message.requestId)
    cancelled.delete(message.requestId)
  }
}

scope.onmessage = (event) => {
  if (event.data.type === 'cancel') cancelled.add(event.data.requestId)
  else if (event.data.type === 'rasterized' || event.data.type === 'rasterize-error') resolveWorkerRasterization(event.data)
  else void run(event.data)
}
