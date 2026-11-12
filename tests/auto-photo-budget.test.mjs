import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const { buildSync } = createRequire(new URL('../cli/package.json', import.meta.url))('esbuild')
const bundled = buildSync({
  stdin: { contents: "export { vectorize } from './src/lib/engine/vectorize'; export { DEFAULT_PARAMS } from './src/lib/engine/presets'", resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'esm',
}).outputFiles[0].text
const { vectorize, DEFAULT_PARAMS } = await import(`data:text/javascript;base64,${Buffer.from(bundled).toString('base64')}`)

const makePhoto = () => {
  const width = 20, height = 20, data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4
    data.set([(x * 13) % 256, (y * 17) % 256, ((x + y) * 11) % 256, 255], i)
  }
  return { width, height, data }
}

const analysis = { width: 20, height: 20, kind: 'photo', alpha: 'opaque', softPct: 0, transparentPct: 0, dominantColors: 211, gradient: 0.8, grayscale: false }
const backend = (src) => ({
  name: 'photo-budget-test',
  async trace() { return '<svg/>' },
  async traceColorSource(_source, params) {
    const prefix = `<svg data-pp="${params.pathPrecision}">`
    const size = params.pathPrecision < DEFAULT_PARAMS.pathPrecision ? 200 : 2_000
    return `${prefix}${' '.repeat(size - prefix.length - 6)}</svg>`
  },
  async rasterize(svg, width, height) {
    const simplified = Number(svg.match(/data-pp="(\d+)"/)?.[1]) < DEFAULT_PARAMS.pathPrecision
    const data = new Uint8ClampedArray(src.data)
    if (simplified) for (let i = 0; i < data.length; i += 4) data.set([0, 0, 0, 255], i)
    return { width, height, data }
  },
})

const run = (src, overrides = {}, opts = {}) => vectorize(src, {
  presetId: 'auto', params: { ...DEFAULT_PARAMS },
  auto: { enabled: true, threshold: 3, maxKB: 1, ...overrides },
}, backend(src), { analysis, ...opts })

test('Auto adds two measured photo simplifications only when the existing trials miss the size budget', async () => {
  const src = makePhoto()
  const constrained = await run(src, { maxKB: 1 })
  const simplified = constrained.trials.filter((trial) => trial.params.pathPrecision === 1)
  assert.equal(simplified.length, 2)
  assert.ok(simplified.every((trial) => trial.metrics.bytes === 200))
  assert.ok(simplified.every((trial) => trial.metrics.bytes <= 1024), 'fallbacks are measured below the target')
  assert.equal(constrained.trials[constrained.chosen].metrics.pctDiff, 0,
    'soft budget selection may keep the exact over-target trace when simplification costs too much fidelity')
  assert.ok(constrained.trials[constrained.chosen].metrics.bytes > 1024,
    'the exact chosen trace is explicitly over budget in this fixture')

  const roomyProgress = []
  const roomy = await run(src, { maxKB: 800 }, { onProgress: (done, total) => roomyProgress.push({ done, total }) })
  assert.equal(roomy.trials.some((trial) => trial.params.pathPrecision === 1), false)
  assert.equal(roomy.trials[roomy.chosen].metrics.pctDiff, 0)
  assert.deepEqual(roomyProgress.at(-1), { done: 4, total: 4 },
    'skipped photo simplifications are removed from the trial progress total')

  const disabled = await vectorize(src, {
    presetId: 'auto', params: { ...DEFAULT_PARAMS }, auto: { enabled: false, threshold: 3, maxKB: 1 },
  }, backend(src), { analysis })
  assert.equal(disabled.trials.some((trial) => trial.params.pathPrecision === 1), false)

  const custom = await vectorize(src, {
    presetId: 'custom', params: { ...DEFAULT_PARAMS }, auto: { enabled: true, threshold: 3, maxKB: 1 },
  }, backend(src), { analysis })
  assert.equal(custom.trials.some((trial) => trial.params.pathPrecision === 1), false)

  const nonPhoto = await vectorize(src, {
    presetId: 'auto', params: { ...DEFAULT_PARAMS }, auto: { enabled: true, threshold: 3, maxKB: 1 },
  }, backend(src), { analysis: { ...analysis, kind: 'shaded' } })
  assert.equal(nonPhoto.trials.some((trial) => trial.params.pathPrecision === 1), false)
})
