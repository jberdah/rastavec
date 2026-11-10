import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { resolve } from 'node:path'

const bundle = await build({
  stdin: { contents: `export { createMobileSamHypotheses, createMobileSamRunDiagnostics, filterPromptGridToMasks, makePromptGrid, selectMobileSamPromptGrid, uniqueMaskCandidates } from './src/lib/engine/mobile-sam-inference.ts'`, resolveDir: resolve('.'), sourcefile: 'mobile-sam-inference-entry.ts' },
  bundle: true, write: false, format: 'esm', platform: 'node',
})
const { createMobileSamHypotheses, createMobileSamRunDiagnostics, filterPromptGridToMasks, makePromptGrid, selectMobileSamPromptGrid, uniqueMaskCandidates } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)

test('MobileSAM candidates normalize to one shared proposal metadata format', () => {
  const prompt = { x: 12, y: 8, row: 1, column: 0 }
  const candidate = { prompt, score: 0.83, width: 4, height: 3, data: new Uint8Array([1, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]) }
  const hypotheses = createMobileSamHypotheses([candidate], { applied: true, reason: 'transparent-border-alpha-components' })
  assert.equal(hypotheses.length, 1)
  assert.deepEqual(hypotheses[0], {
    id: 'mobile-sam-1-0',
    mask: { width: 4, height: 3, data: candidate.data },
    maskMeaning: 'unknown',
    source: {
      provider: 'mobile-sam',
      model: 'MobileSAM ONNX',
      prompt,
      description: 'Visible-region proposal from a positive prompt retained inside a supported foreground component (transparent-border-alpha-components); hidden geometry is not completed.',
    },
    score: { value: 0.83, kind: 'provider-native', label: 'decoder score' },
  })
})

test('MobileSAM diagnostics use a target-independent report shape', () => {
  const promptSelection = {
    prompts: [{ x: 4, y: 4, row: 0, column: 0 }],
    requestedCount: 4, retainedCount: 1, skippedCount: 3, applied: true,
    mode: 'foreground-gated', reason: 'opaque-border-support-at-least-0.75', foregroundMaskCount: 2,
  }
  assert.deepEqual(createMobileSamRunDiagnostics({
    imageSize: { width: 8, height: 8 }, gridSize: 2, promptSelection,
    uniqueMasks: 1, elapsedMs: 25, modelsVerifiedBySha256: true,
  }), {
    analysisSize: { width: 8, height: 8 }, gridSize: 2,
    promptsRequested: 4, promptsRetained: 1, promptsSkipped: 3,
    promptFilterApplied: true, promptSelectionMode: 'foreground-gated',
    promptSelectionReason: 'opaque-border-support-at-least-0.75',
    foregroundComponentMasks: 2, uniqueMasks: 1, elapsedMs: 25,
    modelsVerifiedBySha256: true,
  })
})

test('prompt grid is deterministic, row-major and bounded to the resized image', () => {
  const points = makePromptGrid(100, 60, 2)
  assert.deepEqual(points, [
    { x: 25, y: 15, row: 0, column: 0 }, { x: 75, y: 15, row: 0, column: 1 },
    { x: 25, y: 45, row: 1, column: 0 }, { x: 75, y: 45, row: 1, column: 1 },
  ])
  assert.deepEqual(makePromptGrid(100, 60, 2), points)
  assert.throws(() => makePromptGrid(100, 60, 1), /grid-size/)
})

test('proposal filtering removes empty and near-identical masks without reordering', () => {
  const candidate = (column, values) => ({ prompt: { x: column, y: 1, row: 0, column }, score: 0.8, width: 4, height: 2, data: new Uint8Array(values) })
  const first = candidate(0, [1, 1, 0, 0, 1, 1, 0, 0])
  const duplicate = candidate(1, [1, 1, 0, 0, 1, 1, 0, 0])
  const distinct = candidate(2, [0, 0, 1, 1, 0, 0, 1, 1])
  const empty = candidate(3, [0, 0, 0, 0, 0, 0, 0, 0])
  assert.deepEqual(uniqueMaskCandidates([first, duplicate, distinct, empty]), [first, distinct])
})

test('foreground component masks filter background prompts across different raster sizes', () => {
  const prompts = makePromptGrid(8, 4, 2)
  const foreground = new Uint8Array(4 * 2)
  foreground[0] = 1
  foreground[1] = 1
  foreground[4] = 1
  foreground[5] = 1
  const result = filterPromptGridToMasks(prompts, { width: 8, height: 4 }, [{ width: 4, height: 2, data: foreground }])
  assert.deepEqual(result.prompts, [prompts[0], prompts[2]])
  assert.deepEqual(result, { prompts: [prompts[0], prompts[2]], requestedCount: 4, retainedCount: 2, skippedCount: 2, applied: true })
})

test('foreground prompt filtering falls back to the full grid when component analysis abstains', () => {
  const prompts = makePromptGrid(12, 12, 3)
  const result = filterPromptGridToMasks(prompts, { width: 12, height: 12 }, [])
  assert.deepEqual(result, { prompts, requestedCount: 9, retainedCount: 9, skippedCount: 0, applied: false })
})

test('prompt routing gates only when connected components have supported background evidence', () => {
  const prompts = makePromptGrid(8, 4, 2)
  const foreground = new Uint8Array(8).fill(1)
  foreground[2] = foreground[3] = foreground[6] = foreground[7] = 0
  const proposal = (background, truncated = 0) => ({
    status: 'proposed',
    hypotheses: [{ mask: { width: 4, height: 2, data: foreground } }],
    diagnostics: { background, components: { truncated } },
  })

  const supported = selectMobileSamPromptGrid(prompts, { width: 8, height: 4 }, proposal({ kind: 'opaque-border-median', flatColorSupport: 1 }))
  assert.equal(supported.mode, 'foreground-gated')
  assert.equal(supported.reason, 'opaque-border-support-at-least-0.75')
  assert.equal(supported.retainedCount, 2)

  const weakBorder = selectMobileSamPromptGrid(prompts, { width: 8, height: 4 }, proposal({ kind: 'opaque-border-median', flatColorSupport: 0.6 }))
  assert.equal(weakBorder.mode, 'full-grid')
  assert.equal(weakBorder.reason, 'opaque-background-support-below-0.75')
  assert.deepEqual(weakBorder.prompts, prompts)

  const truncated = selectMobileSamPromptGrid(prompts, { width: 8, height: 4 }, proposal({ kind: 'transparent-border' }, 1))
  assert.equal(truncated.mode, 'full-grid')
  assert.equal(truncated.reason, 'foreground-components-truncated')

  const transparent = selectMobileSamPromptGrid(prompts, { width: 8, height: 4 }, proposal({ kind: 'transparent-border' }))
  assert.equal(transparent.mode, 'foreground-gated')
  assert.equal(transparent.reason, 'transparent-border-alpha-components')
})

test('prompt routing falls back when no grid point lands inside supported foreground', () => {
  const prompts = makePromptGrid(8, 4, 2)
  const foreground = new Uint8Array(8)
  foreground[0] = 1
  const components = {
    status: 'proposed',
    hypotheses: [{ mask: { width: 4, height: 2, data: foreground } }],
    diagnostics: { background: { kind: 'opaque-border-median', flatColorSupport: 1 }, components: { truncated: 0 } },
  }
  const selection = selectMobileSamPromptGrid(prompts, { width: 8, height: 4 }, components)
  assert.equal(selection.mode, 'full-grid')
  assert.equal(selection.reason, 'no-grid-prompt-inside-supported-foreground')
  assert.deepEqual(selection.prompts, prompts)
})
