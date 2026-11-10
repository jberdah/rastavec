import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import sharp from 'sharp'
import * as ort from 'onnxruntime-web/wasm'
import type { RGBAImage } from '../../src/lib/engine/core'
import type { ObjectHypothesis } from '../../src/lib/engine/object-hypotheses'
import { createMobileSamHypotheses, createMobileSamRunDiagnostics, MOBILE_SAM_ARTIFACTS, makePromptGrid, selectMobileSamPromptGrid, uniqueMaskCandidates, type MaskCandidate, type MobileSamRunDiagnostics } from '../../src/lib/engine/mobile-sam-inference'
import type { ConnectedComponentProposalResult } from '../../src/lib/engine/connected-component-hypotheses'

const requireFromCli = createRequire(__filename)
ort.env.wasm.wasmPaths = { wasm: requireFromCli.resolve('onnxruntime-web/ort-wasm-simd-threaded.wasm') }
ort.env.wasm.numThreads = 1

export interface MobileSamCliProvider {
  propose(image: RGBAImage, gridSize: number, components?: ConnectedComponentProposalResult | null): Promise<{ hypotheses: ObjectHypothesis[]; diagnostics: MobileSamRunDiagnostics }>
  dispose(): Promise<void>
}

function hash(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex')
}

function assertInterfaces(encoder: ort.InferenceSession, decoder: ort.InferenceSession) {
  if (!encoder.inputNames.includes('input_image') || !encoder.outputNames.includes('image_embeddings'))
    throw new Error('MobileSAM encoder interface is unsupported.')
  for (const name of ['image_embeddings', 'point_coords', 'point_labels', 'mask_input', 'has_mask_input', 'orig_im_size'])
    if (!decoder.inputNames.includes(name)) throw new Error(`MobileSAM decoder is missing ${name}.`)
  if (!decoder.outputNames.includes('masks') || !decoder.outputNames.includes('iou_predictions'))
    throw new Error('MobileSAM decoder outputs are unsupported.')
}

async function makeInput(image: RGBAImage) {
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

function binaryMask(tensor: ort.Tensor, width: number, height: number) {
  if (tensor.dims.length !== 4 || tensor.dims[0] !== 1 || tensor.dims[1] !== 1 || tensor.dims[2] !== height || tensor.dims[3] !== width)
    throw new Error('MobileSAM mask dimensions do not match the encoded image.')
  const values = tensor.data as Float32Array
  const data = new Uint8Array(width * height)
  for (let index = 0; index < data.length; index++) data[index] = values[index] > 0 ? 1 : 0
  return data
}

export async function createMobileSamCliProvider(encoderPath: string, decoderPath: string): Promise<MobileSamCliProvider> {
  const [encoderBytes, decoderBytes] = await Promise.all([readFile(encoderPath), readFile(decoderPath)])
  const encoderHash = hash(encoderBytes), decoderHash = hash(decoderBytes)
  if (encoderHash !== MOBILE_SAM_ARTIFACTS.encoder.sha256 || decoderHash !== MOBILE_SAM_ARTIFACTS.decoder.sha256)
    throw new Error('MobileSAM model hashes do not match the supported encoder/decoder pair.')

  const encoder = await ort.InferenceSession.create(new Uint8Array(encoderBytes), { executionProviders: ['wasm'] })
  let decoder: ort.InferenceSession | null = null
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
      const input = await makeInput(image)
      const requestedPrompts = makePromptGrid(input.width, input.height, gridSize)
      const promptSelection = selectMobileSamPromptGrid(requestedPrompts, input, components)
      const prompts = promptSelection.prompts
      // Same measurement boundary as the worker: encoder/decoder inference and mask post-processing.
      const started = performance.now()
      const encoded = await encoder.run({ input_image: input.tensor })
      const embeddings = encoded.image_embeddings
      if (!(embeddings instanceof ort.Tensor)) throw new Error('MobileSAM encoder returned no image embeddings.')

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

      const uniqueCandidates = uniqueMaskCandidates(candidates)
      const elapsedMs = Math.round(performance.now() - started)
      const hypotheses = createMobileSamHypotheses(uniqueCandidates, promptSelection)
      return {
        hypotheses,
        diagnostics: createMobileSamRunDiagnostics({
          imageSize: input,
          gridSize,
          promptSelection,
          uniqueMasks: uniqueCandidates.length,
          elapsedMs,
          modelsVerifiedBySha256: true,
        }),
      }
    },
    async dispose() {
      await Promise.all([encoder.release(), decoder!.release()])
    },
  }
}
