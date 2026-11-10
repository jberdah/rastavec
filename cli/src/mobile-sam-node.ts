import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import sharp from 'sharp'
import type { RGBAImage } from '../../src/lib/engine/core'
import { createMaskHypothesis, type ObjectHypothesis } from '../../src/lib/engine/object-hypotheses'
import { MOBILE_SAM_ARTIFACTS, makePromptGrid, selectMobileSamPromptGrid, uniqueMaskCandidates, type MaskCandidate } from '../../src/lib/engine/mobile-sam-inference'
import type { ConnectedComponentProposalResult } from '../../src/lib/engine/connected-component-hypotheses'

type OrtTensor = { dims: number[]; data: Float32Array | Int32Array | Uint8Array | Int8Array | Uint32Array | Int16Array | Uint16Array | Float64Array | BigInt64Array | BigUint64Array }
type OrtInferenceSession = {
  inputNames: string[]
  outputNames: string[]
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>
  release(): Promise<void>
}
type OrtModule = {
  env: { wasm: { wasmPaths: { wasm: string }; numThreads: number } }
  Tensor: new (type: 'float32', data: Float32Array, dims: number[]) => OrtTensor
  InferenceSession: { create(model: Uint8Array, options: { executionProviders: string[] }): Promise<OrtInferenceSession> }
}
const ONNX_RUNTIME_MODULE: string = 'onnxruntime-web/wasm'

export interface MobileSamCliProvider {
  propose(image: RGBAImage, gridSize: number, components?: ConnectedComponentProposalResult | null): Promise<{ hypotheses: ObjectHypothesis[]; diagnostics: Record<string, unknown> }>
  dispose(): Promise<void>
}

function hash(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex')
}

function assertInterfaces(encoder: OrtInferenceSession, decoder: OrtInferenceSession) {
  if (!encoder.inputNames.includes('input_image') || !encoder.outputNames.includes('image_embeddings'))
    throw new Error('MobileSAM encoder interface is unsupported.')
  for (const name of ['image_embeddings', 'point_coords', 'point_labels', 'mask_input', 'has_mask_input', 'orig_im_size'])
    if (!decoder.inputNames.includes(name)) throw new Error(`MobileSAM decoder is missing ${name}.`)
  if (!decoder.outputNames.includes('masks') || !decoder.outputNames.includes('iou_predictions'))
    throw new Error('MobileSAM decoder outputs are unsupported.')
}

async function makeInput(image: RGBAImage, ort: OrtModule) {
  const scale = 1024 / Math.max(image.width, image.height)
  const width = Math.max(1, Math.round(image.width * scale))
  const height = Math.max(1, Math.round(image.height * scale))
  const raw = Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength)
  const { data } = await sharp(raw, { raw: { width: image.width, height: image.height, channels: 4 } })
    .toColourspace('srgb')
    .flatten({ background: '#ffffff' })
    .resize(width, height, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const values = new Float32Array(width * height * 3)
  for (let index = 0; index < values.length; index++) values[index] = data[index]
  return { width, height, tensor: new ort.Tensor('float32', values, [height, width, 3]) }
}

function binaryMask(tensor: OrtTensor, width: number, height: number) {
  if (tensor.dims.length !== 4 || tensor.dims[0] !== 1 || tensor.dims[1] !== 1 || tensor.dims[2] !== height || tensor.dims[3] !== width)
    throw new Error('MobileSAM mask dimensions do not match the encoded image.')
  const values = tensor.data as Float32Array
  const data = new Uint8Array(width * height)
  for (let index = 0; index < data.length; index++) data[index] = values[index] > 0 ? 1 : 0
  return data
}

export async function createMobileSamCliProvider(encoderPath: string, decoderPath: string): Promise<MobileSamCliProvider> {
  let ort: OrtModule
  try {
    ort = await import(ONNX_RUNTIME_MODULE) as OrtModule
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    throw new Error(`MobileSAM ONNX runtime is unavailable; install the optional CLI dependency \"onnxruntime-web\" to enable this provider. ${detail}`, { cause })
  }
  const requireFromCli = createRequire(__filename)
  ort.env.wasm.wasmPaths = { wasm: requireFromCli.resolve('onnxruntime-web/ort-wasm-simd-threaded.wasm') }
  ort.env.wasm.numThreads = 1

  let encoderBytes: Buffer, decoderBytes: Buffer
  try {
    [encoderBytes, decoderBytes] = await Promise.all([readFile(encoderPath), readFile(decoderPath)])
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    throw new Error(`MobileSAM model files could not be read: ${detail}`, { cause })
  }
  const encoderHash = hash(encoderBytes), decoderHash = hash(decoderBytes)
  if (encoderHash !== MOBILE_SAM_ARTIFACTS.encoder.sha256 || decoderHash !== MOBILE_SAM_ARTIFACTS.decoder.sha256)
    throw new Error('MobileSAM model hashes do not match the supported encoder/decoder pair.')

  const encoder = await ort.InferenceSession.create(new Uint8Array(encoderBytes), { executionProviders: ['wasm'] })
  let decoder: OrtInferenceSession | null = null
  try {
    decoder = await ort.InferenceSession.create(new Uint8Array(decoderBytes), { executionProviders: ['wasm'] })
    assertInterfaces(encoder, decoder)
  } catch (cause) {
    await decoder?.release()
    await encoder.release()
    throw cause
  }

  return {
    async propose(image, gridSize, components = null) {
      if (!Number.isSafeInteger(gridSize) || gridSize < 2 || gridSize > 6)
        throw new Error('MobileSAM grid must be an integer from 2 to 6.')
      const started = performance.now()
      const input = await makeInput(image, ort)
      const encoded = await encoder.run({ input_image: input.tensor })
      const embeddings = encoded.image_embeddings
      if (!(embeddings instanceof ort.Tensor)) throw new Error('MobileSAM encoder returned no image embeddings.')

      const requestedPrompts = makePromptGrid(input.width, input.height, gridSize)
      const promptSelection = selectMobileSamPromptGrid(requestedPrompts, input, components)
      const prompts = promptSelection.prompts
      const candidates: MaskCandidate[] = []
      for (const prompt of prompts) {
        const decoded = await decoder!.run({
          image_embeddings: embeddings,
          point_coords: new ort.Tensor('float32', new Float32Array([prompt.x, prompt.y]), [1, 1, 2]),
          point_labels: new ort.Tensor('float32', new Float32Array([1]), [1, 1]),
          mask_input: new ort.Tensor('float32', new Float32Array(256 * 256), [1, 1, 256, 256]),
          has_mask_input: new ort.Tensor('float32', new Float32Array([0]), [1]),
          orig_im_size: new ort.Tensor('float32', new Float32Array([input.height, input.width]), [2]),
        })
        const masks = decoded.masks, scores = decoded.iou_predictions
        if (!(masks instanceof ort.Tensor) || !(scores instanceof ort.Tensor)) throw new Error('MobileSAM decoder returned unsupported outputs.')
        const value = Number(scores.data[0])
        candidates.push({ prompt, score: Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0,
          width: input.width, height: input.height, data: binaryMask(masks, input.width, input.height) })
      }

      const hypotheses = uniqueMaskCandidates(candidates).map((candidate) => {
        const hypothesis = createMaskHypothesis({
          id: `mobile-sam-${candidate.prompt.row}-${candidate.prompt.column}`,
          mask: { width: candidate.width, height: candidate.height, data: candidate.data },
          source: { provider: 'mobile-sam', model: 'MobileSAM ONNX', prompt: candidate.prompt,
            description: promptSelection.applied
              ? `Visible-region proposal from a positive prompt retained inside a supported foreground component (${promptSelection.reason}); hidden geometry is not completed.`
              : `Visible-region proposal from the full positive-point grid (${promptSelection.reason}); hidden geometry is not completed.` },
          score: { value: candidate.score, kind: 'provider-native', label: 'decoder score' },
        })
        return hypothesis
      })
      return {
        hypotheses,
        diagnostics: { analysisSize: { width: input.width, height: input.height }, gridSize,
          promptsRequested: promptSelection.requestedCount, promptsRetained: promptSelection.retainedCount,
          promptsSkipped: promptSelection.skippedCount, promptFilterApplied: promptSelection.applied,
          promptSelectionMode: promptSelection.mode, promptSelectionReason: promptSelection.reason,
          foregroundComponentMasks: promptSelection.foregroundMaskCount, uniqueMasks: hypotheses.length,
          elapsedMs: Math.round(performance.now() - started), modelsVerifiedBySha256: true },
      }
    },
    async dispose() {
      await Promise.all([encoder.release(), decoder!.release()])
    },
  }
}
