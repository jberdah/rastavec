import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { resolve } from 'node:path'

const bundle = await build({
  stdin: { contents: `export { proposeConnectedComponentHypotheses } from './src/lib/engine/connected-component-hypotheses.ts'; export { makePromptGrid, selectMobileSamPromptGrid } from './src/lib/engine/mobile-sam-inference.ts'`, resolveDir: resolve('.'), sourcefile: 'connected-component-hypotheses-entry.ts' },
  bundle: true, write: false, format: 'esm', platform: 'node',
})
const { proposeConnectedComponentHypotheses, makePromptGrid, selectMobileSamPromptGrid } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)

function image(width, height, rgba) {
  const data = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i++) data.set(rgba, i * 4)
  return { width, height, data }
}

function paintRect(raster, x0, y0, x1, y1, rgba) {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++)
    raster.data.set(rgba, (y * raster.width + x) * 4)
}

test('intermediate-alpha border abstains and leaves MobileSAM prompt filtering unapplied', () => {
  const raster = image(32, 32, [220, 220, 220, 128])
  paintRect(raster, 10, 10, 22, 22, [30, 30, 30, 255])

  const components = proposeConnectedComponentHypotheses(raster)
  assert.equal(components.status, 'abstained')
  assert.match(components.reason, /Border alpha is neither predominantly near-transparent nor opaque/)
  assert.equal(components.diagnostics?.background?.kind, 'intermediate-alpha-border')
  assert.equal(components.diagnostics?.background?.opaqueBorderFraction, 0)
  assert.equal(components.diagnostics?.background?.nearTransparentBorderFraction, 0)
  assert.equal(components.diagnostics?.thresholds?.borderAlphaSupportFraction, 0.75)
  assert.equal(components.diagnostics?.thresholds?.transparentBorderMaxAlpha, 8)
  assert.equal(components.diagnostics?.thresholds?.opaqueBorderMinAlpha, 250)
  assert.ok(components.diagnostics?.warnings?.includes(components.reason))

  const prompts = makePromptGrid(32, 32, 3)
  const selection = selectMobileSamPromptGrid(prompts, { width: 32, height: 32 }, components)
  assert.equal(selection.mode, 'full-grid')
  assert.equal(selection.applied, false)
  assert.equal(selection.reason, 'component-analysis-abstained-intermediate-alpha-border')
  assert.equal(selection.retainedCount, prompts.length)
  assert.equal(selection.skippedCount, 0)
})

test('near-transparent borders still produce visible component masks', () => {
  const raster = image(32, 32, [0, 0, 0, 0])
  paintRect(raster, 10, 10, 22, 22, [220, 40, 30, 255])

  const result = proposeConnectedComponentHypotheses(raster)
  assert.equal(result.status, 'proposed')
  assert.equal(result.diagnostics.background.kind, 'transparent-border')
  assert.equal(result.diagnostics.background.nearTransparentBorderFraction, 1)
  assert.equal(result.hypotheses.length, 1)
  assert.equal(result.hypotheses[0].mask.data[0], 0)
})

test('opaque flat borders still produce visible component masks', () => {
  const raster = image(32, 32, [245, 245, 245, 255])
  paintRect(raster, 10, 10, 22, 22, [20, 30, 40, 255])

  const result = proposeConnectedComponentHypotheses(raster)
  assert.equal(result.status, 'proposed')
  assert.equal(result.diagnostics.background.kind, 'opaque-border-median')
  assert.equal(result.diagnostics.background.opaqueBorderFraction, 1)
  assert.equal(result.hypotheses.length, 1)
  assert.equal(result.hypotheses[0].mask.data[0], 0)
})
