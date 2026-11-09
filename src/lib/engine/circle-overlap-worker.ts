/// <reference lib="webworker" />
import type { RGBAImage } from './core'
import { proposeThreeCircleOverlaps, type CircleOverlapProposalResult } from './circle-overlap-hypotheses'

type Request = { type: 'propose'; requestId: number; width: number; height: number; pixels: ArrayBuffer }
type Response =
  | { type: 'done'; requestId: number; result: CircleOverlapProposalResult }
  | { type: 'error'; requestId: number }

const scope = self as unknown as DedicatedWorkerGlobalScope

scope.onmessage = (event: MessageEvent<Request>) => {
  const request = event.data
  if (request.type !== 'propose') return
  try {
    const image: RGBAImage = {
      data: new Uint8ClampedArray(request.pixels),
      width: request.width,
      height: request.height,
    }
    const result = proposeThreeCircleOverlaps(image)
    const transfer = result.status === 'proposed'
      ? result.hypotheses.map((hypothesis) => hypothesis.mask.data.buffer as ArrayBuffer)
      : []
    scope.postMessage({ type: 'done', requestId: request.requestId, result } satisfies Response, transfer)
  } catch {
    scope.postMessage({ type: 'error', requestId: request.requestId } satisfies Response)
  }
}
