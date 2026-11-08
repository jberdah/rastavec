/**
 * Offline MobileSAM artifact checks and deterministic point prompts.
 * The expected files are the public Acly/MobileSAM encoder and decoder ONNX pair.
 * They are selected by the user and are never downloaded by RastaVec.
 */
export const MOBILE_SAM_ARTIFACTS = {
  encoder: {
    file: 'mobile_sam_image_encoder.onnx',
    sha256: '580f5fb648ea1062c0aabc26217aed56921985f03f0cbbd852bba81d760cc749',
  },
  decoder: {
    file: 'sam_mask_decoder_single.onnx',
    sha256: '93915fc7c993ab9d59ab8c9ccd3bce37f7509c81ab4150a74abd4d2abbd8570d',
  },
} as const

export interface PromptPoint { x: number; y: number; row: number; column: number }
export interface MaskCandidate {
  prompt: PromptPoint
  score: number
  width: number
  height: number
  data: Uint8Array
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const exactBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  const digest = await crypto.subtle.digest('SHA-256', exactBuffer)
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('')
}

export async function verifyMobileSamPair(encoder: Uint8Array, decoder: Uint8Array): Promise<string> {
  const [encoderHash, decoderHash] = await Promise.all([sha256Hex(encoder), sha256Hex(decoder)])
  if (encoderHash !== MOBILE_SAM_ARTIFACTS.encoder.sha256 || decoderHash !== MOBILE_SAM_ARTIFACTS.decoder.sha256)
    throw new Error('model-hash')
  return `${encoderHash}:${decoderHash}`
}

/** Row-major cell centres in the resized image coordinate system. */
export function makePromptGrid(width: number, height: number, gridSize: number): PromptPoint[] {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1)
    throw new Error('image-size')
  if (!Number.isSafeInteger(gridSize) || gridSize < 2 || gridSize > 4)
    throw new Error('grid-size')
  const points: PromptPoint[] = []
  for (let row = 0; row < gridSize; row++) for (let column = 0; column < gridSize; column++) {
    points.push({ x: (column + 0.5) * width / gridSize, y: (row + 0.5) * height / gridSize, row, column })
  }
  return points
}

/** Keep the first prompt for near-identical masks so proposal order stays deterministic. */
export function uniqueMaskCandidates(candidates: MaskCandidate[], duplicateIou = 0.985): MaskCandidate[] {
  const kept: MaskCandidate[] = []
  for (const candidate of candidates) {
    if (candidate.width < 1 || candidate.height < 1 || candidate.data.length !== candidate.width * candidate.height) continue
    let area = 0
    for (const value of candidate.data) area += value ? 1 : 0
    if (!area) continue
    const duplicate = kept.some((prior) => {
      if (prior.width !== candidate.width || prior.height !== candidate.height) return false
      let intersection = 0, union = 0
      for (let i = 0; i < candidate.data.length; i++) {
        const a = !!prior.data[i], b = !!candidate.data[i]
        if (a || b) union++
        if (a && b) intersection++
      }
      return union > 0 && intersection / union >= duplicateIou
    })
    if (!duplicate) kept.push(candidate)
  }
  return kept
}
