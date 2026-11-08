/// <reference lib="webworker" />
import * as ort from 'onnxruntime-web/wasm'
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url'
import { makePromptGrid, uniqueMaskCandidates, verifyMobileSamPair, type MaskCandidate } from './mobile-sam-inference'

type GenerateRequest = {
  type: 'generate'
  requestId: number
  encoderFile: File
  decoderFile: File
  sourceImage: Blob
  gridSize: number
}
type WorkerRequest = GenerateRequest
type ProposalMessage = { prompt: MaskCandidate['prompt']; score: number; width: number; height: number; data: ArrayBuffer }
type WorkerResponse =
  | { type: 'progress'; requestId: number; stage: 'models' | 'encoder' | 'decoder'; complete: number; total: number }
  | { type: 'done'; requestId: number; proposals: ProposalMessage[]; elapsedMs: number }
  | { type: 'error'; requestId: number; code: string }

const scope = self as unknown as DedicatedWorkerGlobalScope
let encoderSession: ort.InferenceSession | null = null
let decoderSession: ort.InferenceSession | null = null
let modelFingerprint = ''

function post(message: WorkerResponse, transfer: Transferable[] = []) { scope.postMessage(message, transfer) }

function assertModelInterfaces(encoder: ort.InferenceSession, decoder: ort.InferenceSession) {
  if (!encoder.inputNames.includes('input_image') || !encoder.outputNames.includes('image_embeddings')) throw new Error('model-interface')
  for (const name of ['image_embeddings', 'point_coords', 'point_labels', 'mask_input', 'has_mask_input', 'orig_im_size'])
    if (!decoder.inputNames.includes(name)) throw new Error('model-interface')
  if (!decoder.outputNames.includes('masks') || !decoder.outputNames.includes('iou_predictions')) throw new Error('model-interface')
}

async function loadModels(encoderBytes: Uint8Array, decoderBytes: Uint8Array) {
  const nextFingerprint = await verifyMobileSamPair(encoderBytes, decoderBytes)
  if (encoderSession && decoderSession && modelFingerprint === nextFingerprint) return
  if (encoderSession) await encoderSession.release()
  if (decoderSession) await decoderSession.release()
  encoderSession = null
  decoderSession = null
  modelFingerprint = ''
  const encoder = await ort.InferenceSession.create(encoderBytes, { executionProviders: ['wasm'] })
  try {
    const decoder = await ort.InferenceSession.create(decoderBytes, { executionProviders: ['wasm'] })
    try { assertModelInterfaces(encoder, decoder) }
    catch (cause) { await decoder.release(); throw cause }
    encoderSession = encoder
    decoderSession = decoder
    modelFingerprint = nextFingerprint
  } catch (cause) {
    await encoder.release()
    throw cause
  }
}

function makeRgbTensor(bitmap: ImageBitmap) {
  const scale = 1024 / Math.max(bitmap.width, bitmap.height)
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('canvas')
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, width, height)
  context.drawImage(bitmap, 0, 0, width, height)
  const rgba = context.getImageData(0, 0, width, height).data
  const rgb = new Float32Array(width * height * 3)
  for (let pixel = 0, src = 0, dst = 0; pixel < width * height; pixel++, src += 4, dst += 3) {
    rgb[dst] = rgba[src]
    rgb[dst + 1] = rgba[src + 1]
    rgb[dst + 2] = rgba[src + 2]
  }
  return { width, height, tensor: new ort.Tensor('float32', rgb, [height, width, 3]) }
}

function maskToBinary(tensor: ort.Tensor, width: number, height: number) {
  if (tensor.dims.length !== 4 || tensor.dims[0] !== 1 || tensor.dims[1] !== 1 || tensor.dims[2] !== height || tensor.dims[3] !== width)
    throw new Error('model-output')
  const data = new Uint8Array(width * height)
  const values = tensor.data as Float32Array
  for (let i = 0; i < data.length; i++) data[i] = values[i] > 0 ? 1 : 0
  return data
}

async function generate(request: GenerateRequest) {
  const started = performance.now()
  const encoderBytes = new Uint8Array(await request.encoderFile.arrayBuffer())
  const decoderBytes = new Uint8Array(await request.decoderFile.arrayBuffer())
  post({ type: 'progress', requestId: request.requestId, stage: 'models', complete: 0, total: 1 })
  await loadModels(encoderBytes, decoderBytes)
  post({ type: 'progress', requestId: request.requestId, stage: 'models', complete: 1, total: 1 })

  const bitmap = await createImageBitmap(request.sourceImage)
  try {
    const image = makeRgbTensor(bitmap)
    post({ type: 'progress', requestId: request.requestId, stage: 'encoder', complete: 0, total: 1 })
    const encoded = await encoderSession!.run({ input_image: image.tensor })
    const embeddings = encoded.image_embeddings
    if (!(embeddings instanceof ort.Tensor)) throw new Error('model-output')
    post({ type: 'progress', requestId: request.requestId, stage: 'encoder', complete: 1, total: 1 })

    const points = makePromptGrid(image.width, image.height, request.gridSize)
    const candidates: MaskCandidate[] = []
    for (let index = 0; index < points.length; index++) {
      const prompt = points[index]
      post({ type: 'progress', requestId: request.requestId, stage: 'decoder', complete: index, total: points.length })
      const decoded = await decoderSession!.run({
        image_embeddings: embeddings,
        point_coords: new ort.Tensor('float32', new Float32Array([prompt.x, prompt.y]), [1, 1, 2]),
        point_labels: new ort.Tensor('float32', new Float32Array([1]), [1, 1]),
        mask_input: new ort.Tensor('float32', new Float32Array(256 * 256), [1, 1, 256, 256]),
        has_mask_input: new ort.Tensor('float32', new Float32Array([0]), [1]),
        orig_im_size: new ort.Tensor('float32', new Float32Array([image.height, image.width]), [2]),
      })
      const masks = decoded.masks, scores = decoded.iou_predictions
      if (!(masks instanceof ort.Tensor) || !(scores instanceof ort.Tensor)) throw new Error('model-output')
      const predictedIou = Number(scores.data[0])
      const score = Number.isFinite(predictedIou) ? Math.max(0, Math.min(1, predictedIou)) : 0
      candidates.push({ prompt, score, width: image.width, height: image.height, data: maskToBinary(masks, image.width, image.height) })
    }
    const proposals = uniqueMaskCandidates(candidates).map((candidate): ProposalMessage => ({
      prompt: candidate.prompt, score: candidate.score, width: candidate.width, height: candidate.height, data: candidate.data.buffer as ArrayBuffer,
    }))
    const transfer = proposals.map((proposal) => proposal.data)
    post({ type: 'progress', requestId: request.requestId, stage: 'decoder', complete: points.length, total: points.length })
    post({ type: 'done', requestId: request.requestId, proposals, elapsedMs: Math.round(performance.now() - started) }, transfer)
  } finally {
    bitmap.close()
  }
}

scope.onmessage = (event: MessageEvent<WorkerRequest>) => {
  if (event.data.type !== 'generate') return
  void generate(event.data).catch((cause: unknown) => {
    const code = cause instanceof Error ? cause.message : 'inference'
    post({ type: 'error', requestId: event.data.requestId, code })
  })
}

// Vite serves package WASM files through hashed asset URLs. The default ORT
// relative URL resolves to the SPA fallback (index.html) in this worker.
ort.env.wasm.wasmPaths = { wasm: wasmUrl }
ort.env.wasm.numThreads = 1
