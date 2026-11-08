import type { RGBAImage } from './core'

export interface RasterizeRequestMessage {
  type: 'rasterize'
  requestId: number
  rasterId: number
  svg: string
  width: number
  height: number
}

export interface RasterizedMessage {
  type: 'rasterized'
  requestId: number
  rasterId: number
  buffer: ArrayBuffer
}

export interface RasterizeErrorMessage {
  type: 'rasterize-error'
  requestId: number
  rasterId: number
  message: string
}

export type RasterizeReplyMessage = RasterizedMessage | RasterizeErrorMessage

interface PendingRasterization {
  requestId: number
  width: number
  height: number
  resolve: (image: RGBAImage) => void
  reject: (error: Error) => void
}

const scope = globalThis as unknown as {
  postMessage: (message: RasterizeRequestMessage) => void
}
const pending = new Map<number, PendingRasterization>()
let activeRequestId: number | null = null
let nextRasterId = 1

export function beginWorkerRasterRequest(requestId: number) {
  activeRequestId = requestId
}

export function endWorkerRasterRequest(requestId: number) {
  if (activeRequestId === requestId) activeRequestId = null
  for (const [rasterId, request] of pending) {
    if (request.requestId !== requestId) continue
    pending.delete(rasterId)
    request.reject(new Error('Worker rasterization ended before the canvas reply arrived.'))
  }
}

/** Ask the UI thread to rasterize SVG because SVG Blob decoding is not reliable in workers. */
export function rasterizeOnMain(svg: string, width: number, height: number): Promise<RGBAImage> {
  const requestId = activeRequestId
  if (requestId === null) return Promise.reject(new Error('No active vectorization request for worker rasterization.'))
  const rasterId = nextRasterId++
  return new Promise((resolve, reject) => {
    pending.set(rasterId, { requestId, width, height, resolve, reject })
    try {
      scope.postMessage({ type: 'rasterize', requestId, rasterId, svg, width, height })
    } catch (error) {
      pending.delete(rasterId)
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

/** Resolve one outstanding main-thread render RPC. Returns false for a stale reply. */
export function resolveWorkerRasterization(message: RasterizeReplyMessage): boolean {
  const request = pending.get(message.rasterId)
  if (!request || request.requestId !== message.requestId) return false
  pending.delete(message.rasterId)
  if (message.type === 'rasterize-error') {
    request.reject(new Error(message.message))
    return true
  }

  const expectedBytes = request.width * request.height * 4
  if (!Number.isSafeInteger(expectedBytes) || message.buffer.byteLength !== expectedBytes) {
    request.reject(new Error(`Main-thread raster returned ${message.buffer.byteLength} bytes; expected ${expectedBytes}.`))
    return true
  }
  request.resolve({ data: new Uint8ClampedArray(message.buffer), width: request.width, height: request.height })
  return true
}
