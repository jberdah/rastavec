import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import init, { vectorize_rgba } from '../src/lib/engine/vtracer-next-wasm/vtracer_next.js'

const sharp = createRequire(new URL('../cli/package.json', import.meta.url))('sharp')
const { buildSync } = createRequire(new URL('../cli/package.json', import.meta.url))('esbuild')
const bundled = buildSync({ stdin: { contents: `export { vectorize } from './src/lib/engine/vectorize'; export { DEFAULT_PARAMS } from './src/lib/engine/presets'; export { withVTracerNext } from './src/lib/engine/vtracer-next-trace'; export { optionsFor } from './src/lib/engine/trace-options';`, resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node', format: 'esm' }).outputFiles[0].text
const { vectorize, DEFAULT_PARAMS, withVTracerNext, optionsFor } = await import(`data:text/javascript;base64,${Buffer.from(bundled).toString('base64')}`)
await init({ module_or_path: await readFile(new URL('../src/lib/engine/vtracer-next-wasm/vtracer_next_bg.wasm', import.meta.url)) })

function fixture(alpha = 128, pattern = 'rectangle') {
  const width = 48, height = 32, data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const inner = pattern === 'circle' ? (x - 24) ** 2 + (y - 16) ** 2 < 120 : x >= 16 && x < 32 && y >= 8 && y < 24
    data.set(inner ? [30, 80, 220, alpha] : [220, 40, 30, alpha], (y * width + x) * 4)
  }
  return { width, height, data }
}

function lensFixture() {
  const width = 64, height = 48, data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const boundary = 31.5 + 0.13 * (y - 24) ** 2 / 4
    if (Math.abs(x - boundary) < 22 && Math.abs(y - 24) < 17)
      data.set(x < boundary ? [18, 170, 210, 112] : [238, 100, 30, 168], (y * width + x) * 4)
  }
  return { width, height, data }
}

test('native Auto-Tune compares one Cutout even for a passing translucent base; opaque skips it', async () => {
    const convert = async (src, params, binary, gradients) => {
      return vectorize_rgba(new Uint8Array(src.data), src.width, src.height, { ...optionsFor(params, binary), experimentalGradients: gradients })
    }
    const base = { async rasterize(svg, width, height) {
      const data = await sharp(Buffer.from(svg)).resize(width, height).ensureAlpha().raw().toBuffer()
      return { width, height, data: new Uint8ClampedArray(data) }
    } }
    const backend = withVTracerNext(base, false, convert, () => { throw Error('unexpected binary route') })
    const settings = { presetId: 'shaded', params: { ...DEFAULT_PARAMS, mode: 'polygon', speckle: 0, colorPrecision: 8, layerDifference: 8 }, auto: { enabled: true, threshold: 100, maxKB: 400 } }
    const result = await vectorize(fixture(), settings, backend)
    assert.equal(result.trials.length, 2)
    assert.equal(result.trials[0].params.hierarchical, 'stacked')
    assert.equal(result.trials[1].params.hierarchical, 'cutout')
    console.log('translucent hierarchy scores:', result.trials.map(({ params, score, metrics, ms }) => ({ mode: params.hierarchical, score, ...metrics, ms })))
    assert.equal(result.chosen, 0)
    const seam = await vectorize(lensFixture(), { ...settings, params: { ...settings.params, mode: 'spline' } }, backend)
    console.log('lens hierarchy scores:', seam.trials.map(({ params, score, metrics, ms }) => ({ mode: params.hierarchical, score, ...metrics, ms })))
    assert.equal(seam.trials.length, 2)
    assert.equal(seam.trials[seam.chosen].params.hierarchical, 'cutout')
    assert.ok(seam.trials[1].metrics.alphaDiff < seam.trials[0].metrics.alphaDiff)
    // A curved polygon seam can favor Stacked even when Cutout has lower alpha MAE.
    const curved = await vectorize(fixture(128, 'circle'), settings, backend)
    assert.equal(curved.trials[curved.chosen].params.hierarchical, 'stacked')
    const opaque = await vectorize(fixture(255), settings, backend)
    assert.equal(opaque.trials.length, 1)
    assert.equal(opaque.trials[opaque.chosen].params.hierarchical, 'stacked')
    const disabled = await vectorize(fixture(), { ...settings, auto: { ...settings.auto, enabled: false } }, backend)
    assert.equal(disabled.trials.length, 1)
    const gradients = withVTracerNext(base, true, convert, () => { throw Error('unexpected binary route') })
    assert.equal(gradients.supportsHierarchyComparison, false)
    const unsupported = await vectorize(fixture(), settings, { ...backend, supportsHierarchyComparison: false })
    assert.equal(unsupported.trials.length, 1)
    const calls = []
    const failing = { ...backend, traceColorSource: async (src, params) => {
      calls.push(params.hierarchical)
      if (params.hierarchical === 'cutout') throw Error('optional failure')
      return backend.traceColorSource(src, params)
    } }
    const recovered = await vectorize(fixture(), settings, failing)
    assert.deepEqual(calls, ['stacked', 'cutout'])
    assert.equal(recovered.trials.length, 1)
    assert.equal(recovered.failedTrials.length, 1)
    assert.equal(recovered.chosen, 0)
    assert.equal(optionsFor({ ...settings.params, hierarchical: 'cutout' }, true).hierarchical, 'stacked')
})
