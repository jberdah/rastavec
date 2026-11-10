import type { BinarySegmentationMask } from './segmentation-mask'
import type { ConnectedComponentProposalResult } from './connected-component-hypotheses'
import { createMaskHypothesis, type ObjectHypothesis } from './object-hypotheses'

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

export interface PromptGridFilterResult {
  prompts: PromptPoint[]
  requestedCount: number
  retainedCount: number
  skippedCount: number
  applied: boolean
}

export interface PromptGridSelection extends PromptGridFilterResult {
  mode: 'foreground-gated' | 'full-grid'
  reason: string
  foregroundMaskCount: number
}

/** Shared MobileSAM diagnostics shape for browser, desktop, and CLI reports. */
export interface MobileSamRunDiagnostics {
  analysisSize: { width: number; height: number }
  gridSize: number
  promptsRequested: number
  promptsRetained: number
  promptsSkipped: number
  promptFilterApplied: boolean
  promptSelectionMode: PromptGridSelection['mode']
  promptSelectionReason: string
  foregroundComponentMasks: number
  uniqueMasks: number
  elapsedMs: number
  modelsVerifiedBySha256: boolean
}

/** Normalize provider metadata so every target emits the same object hypothesis shape. */
export function createMobileSamHypotheses(
  candidates: readonly MaskCandidate[],
  promptSelection: Pick<PromptGridSelection, 'applied' | 'reason'>,
): ObjectHypothesis[] {
  return candidates.map((candidate) => createMaskHypothesis({
    id: `mobile-sam-${candidate.prompt.row}-${candidate.prompt.column}`,
    mask: { width: candidate.width, height: candidate.height, data: candidate.data },
    source: {
      provider: 'mobile-sam',
      model: 'MobileSAM ONNX',
      prompt: candidate.prompt,
      description: promptSelection.applied
        ? `Visible-region proposal from a positive prompt retained inside a supported foreground component (${promptSelection.reason}); hidden geometry is not completed.`
        : `Visible-region proposal from the full positive-point grid (${promptSelection.reason}); hidden geometry is not completed.`,
    },
    score: { value: candidate.score, kind: 'provider-native', label: 'decoder score' },
  }))
}

export function createMobileSamRunDiagnostics(input: {
  imageSize: { width: number; height: number }
  gridSize: number
  promptSelection: PromptGridSelection
  uniqueMasks: number
  elapsedMs: number
  modelsVerifiedBySha256: boolean
}): MobileSamRunDiagnostics {
  const { imageSize, gridSize, promptSelection, uniqueMasks, elapsedMs, modelsVerifiedBySha256 } = input
  return {
    analysisSize: { ...imageSize },
    gridSize,
    promptsRequested: promptSelection.requestedCount,
    promptsRetained: promptSelection.retainedCount,
    promptsSkipped: promptSelection.skippedCount,
    promptFilterApplied: promptSelection.applied,
    promptSelectionMode: promptSelection.mode,
    promptSelectionReason: promptSelection.reason,
    foregroundComponentMasks: promptSelection.foregroundMaskCount,
    uniqueMasks,
    elapsedMs,
    modelsVerifiedBySha256,
  }
}

/** Keep automatic positive prompts on a foreground region when an independent raster mask is available. */
export function filterPromptGridToMasks(
  prompts: readonly PromptPoint[],
  promptImage: { width: number; height: number },
  foregroundMasks: readonly BinarySegmentationMask[],
): PromptGridFilterResult {
  if (!Number.isSafeInteger(promptImage.width) || !Number.isSafeInteger(promptImage.height) || promptImage.width < 1 || promptImage.height < 1)
    throw new Error('image-size')
  if (!foregroundMasks.length)
    return { prompts: [...prompts], requestedCount: prompts.length, retainedCount: prompts.length, skippedCount: 0, applied: false }
  for (const mask of foregroundMasks) if (!Number.isSafeInteger(mask.width) || !Number.isSafeInteger(mask.height)
    || mask.width < 1 || mask.height < 1 || mask.data.length !== mask.width * mask.height)
    throw new Error('mask-size')

  const retained = prompts.filter((prompt) => {
    const imageX = Math.max(0, Math.min(promptImage.width - 1, Math.floor(prompt.x)))
    const imageY = Math.max(0, Math.min(promptImage.height - 1, Math.floor(prompt.y)))
    return foregroundMasks.some((mask) => {
      const x = Math.min(mask.width - 1, Math.floor((imageX + 0.5) * mask.width / promptImage.width))
      const y = Math.min(mask.height - 1, Math.floor((imageY + 0.5) * mask.height / promptImage.height))
      return mask.data[y * mask.width + x] !== 0
    })
  })
  return { prompts: retained, requestedCount: prompts.length, retainedCount: retained.length,
    skippedCount: prompts.length - retained.length, applied: true }
}

/** Route to a foreground-gated or full MobileSAM grid from component-analysis evidence. */
export function selectMobileSamPromptGrid(
  prompts: readonly PromptPoint[],
  promptImage: { width: number; height: number },
  components: ConnectedComponentProposalResult | null | undefined,
): PromptGridSelection {
  const fullGrid = (reason: string, foregroundMaskCount = 0): PromptGridSelection => ({
    prompts: [...prompts], requestedCount: prompts.length, retainedCount: prompts.length,
    skippedCount: 0, applied: false, mode: 'full-grid', reason, foregroundMaskCount,
  })
  if (!components || components.status !== 'proposed') return fullGrid('component-analysis-abstained')
  const foregroundMaskCount = components.hypotheses.length
  const diagnostics = components.diagnostics
  if (diagnostics.components.truncated > 0) return fullGrid('foreground-components-truncated', foregroundMaskCount)
  if (diagnostics.background.kind === 'opaque-border-median'
    && (diagnostics.background.flatColorSupport ?? 0) < 0.75)
    return fullGrid('opaque-background-support-below-0.75', foregroundMaskCount)

  const filtered = filterPromptGridToMasks(prompts, promptImage, components.hypotheses.map(({ mask }) => mask))
  if (!filtered.retainedCount) return fullGrid('no-grid-prompt-inside-supported-foreground', foregroundMaskCount)
  const reason = diagnostics.background.kind === 'transparent-border'
    ? 'transparent-border-alpha-components'
    : 'opaque-border-support-at-least-0.75'
  return { ...filtered, mode: 'foreground-gated', reason, foregroundMaskCount }
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
  if (!Number.isSafeInteger(gridSize) || gridSize < 2 || gridSize > 6)
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
