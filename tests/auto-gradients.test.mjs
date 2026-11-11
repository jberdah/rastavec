import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const { buildSync } = createRequire(new URL('../cli/package.json', import.meta.url))('esbuild')
const bundled = buildSync({
  stdin: { contents: "export { vectorize } from './src/lib/engine/vectorize'; export { choose } from './src/lib/engine/core'; export { DEFAULT_PARAMS } from './src/lib/engine/presets'", resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'esm',
}).outputFiles[0].text
const { vectorize, choose, DEFAULT_PARAMS } = await import(`data:text/javascript;base64,${Buffer.from(bundled).toString('base64')}`)

test('Auto evaluates one same-engine gradient candidate for shaded opaque art even when analysis sees few gradients', async () => {
    const { width, height } = { width: 20, height: 20 }
    const src = { width, height, data: new Uint8ClampedArray(width * height * 4) }
    for (let i = 0; i < width * height; i++) src.data.set([120, 100, 80, 255], i * 4)
    const analysis = { width, height, kind: 'shaded', alpha: 'opaque', softPct: 0, transparentPct: 0, dominantColors: 40, gradient: 0.0022, grayscale: false }
    const backend = {
      name: 'gradient-candidate-test',
      async trace(_prepared, params) { return `<svg data-mode="${params.mode}"/>` },
      async traceColorSource() { return '<svg data-gradient="off"/>' },
      async traceColorSourceWithGradients() { return '<svg data-gradient="on"/>' },
      async rasterize(svg, w, h) {
        const data = new Uint8ClampedArray(w * h * 4)
        for (let i = 0; i < w * h; i++) data.set(svg.includes('data-gradient="on"') ? [120, 100, 80, 255] : [0, 0, 0, 255], i * 4)
        return { width: w, height: h, data }
      },
    }
    const settings = { presetId: 'auto', params: DEFAULT_PARAMS, auto: { enabled: true, threshold: 3, maxKB: 400 } }
    const progress = []
    const result = await vectorize(src, settings, backend, { analysis, onProgress: (done, total) => progress.push(`${done}/${total}`) })
    const candidate = result.trials.find((trial) => trial.traceMethod === 'experimental-gradients')
    assert.ok(candidate)
    assert.equal(candidate.metrics.pctDiff, 0)
    const native = result.trials.filter((trial) => !trial.traceMethod && (trial.traceScale ?? 1) === 1)
    assert.deepEqual(candidate.params, native[choose(native, settings.auto.maxKB * 1024, { preferSimplicity: settings.auto.enabled })].params)
    assert.equal(result.trials.filter((trial) => trial.traceMethod === 'experimental-gradients').length, 1)
    assert.equal(result.trials[result.chosen], candidate)
    assert.equal(progress.at(-1), progress[0].split('/')[1] + '/' + progress[0].split('/')[1])

    const flat = await vectorize(src, settings, backend, { analysis: { ...analysis, kind: 'flat' } })
    assert.equal(flat.trials.some((trial) => trial.traceMethod === 'experimental-gradients'), false)
    const explicit = await vectorize(src, { ...settings, presetId: 'custom' }, backend, { analysis })
    assert.equal(explicit.trials.some((trial) => trial.traceMethod === 'experimental-gradients'), false)
})

test('Auto keeps the regular trace when its optional gradient candidate fails', async () => {
    const src = { width: 4, height: 4, data: new Uint8ClampedArray(4 * 4 * 4).fill(255) }
    const analysis = { width: 4, height: 4, kind: 'shaded', alpha: 'opaque', softPct: 0, transparentPct: 0, dominantColors: 40, gradient: 0.0022, grayscale: false }
    const backend = {
      name: 'failing-gradient-candidate-test',
      async trace() { return '<svg/>' },
      async traceColorSource() { return '<svg/>' },
      async traceColorSourceWithGradients() { throw new Error('gradient trial unavailable') },
      async rasterize(_svg, width, height) { return { width, height, data: new Uint8ClampedArray(width * height * 4).fill(255) } },
    }
    const result = await vectorize(src, { presetId: 'auto', params: DEFAULT_PARAMS, auto: { enabled: true, threshold: 3, maxKB: 400 } }, backend, { analysis })
    assert.equal(result.trials.some((trial) => trial.traceMethod === 'experimental-gradients'), false)
    assert.ok(result.trials.length >= 1)
    assert.ok(result.failedTrials.some((failure) => failure.message === 'gradient trial unavailable'))
})

test('Auto still compares solid-fill calibration when the gradient candidate wins the first pass', async () => {
    const width = 20, height = 20
    const src = { width, height, data: new Uint8ClampedArray(width * height * 4) }
    for (let i = 0; i < width * height; i++) src.data.set([120, 100, 80, 255], i * 4)
    const analysis = { width, height, kind: 'shaded', alpha: 'opaque', softPct: 0, transparentPct: 0, dominantColors: 40, gradient: 0.0022, grayscale: false }
    const solid = '<svg><path fill="#756150" d="M0 0h20v20H0z"/></svg>'
    const gradient = '<svg><defs><linearGradient id="paint"><stop stop-color="#786450"/></linearGradient></defs><path fill="url(#paint)" d="M0 0h20v20H0z"/></svg>'
    const backend = {
      name: 'gradient-and-solid-calibration-test',
      async trace() { return solid },
      async traceColorSource() { return solid },
      async traceColorSourceWithGradients() { return gradient },
      async rasterize(svg, w, h) {
        const color = svg.includes('url(#paint)') || svg.includes('#786450')
          ? [120, 100, 80, 255]
          : [117, 97, 80, 255]
        const data = new Uint8ClampedArray(w * h * 4)
        for (let i = 0; i < w * h; i++) data.set(color, i * 4)
        return { width: w, height: h, data }
      },
    }
    const settings = { presetId: 'auto', params: DEFAULT_PARAMS, auto: { enabled: true, threshold: 3, maxKB: 400 } }
    const result = await vectorize(src, settings, backend, { analysis })
    const native = result.trials.filter((trial) => !trial.traceMethod && (trial.traceScale ?? 1) === 1)
    const gradientTrial = result.trials.find((trial) => trial.traceMethod === 'experimental-gradients')
    assert.ok(gradientTrial)
    assert.ok(gradientTrial.score < native[choose(native, settings.auto.maxKB * 1024, { preferSimplicity: settings.auto.enabled })].score,
      'gradient trial should win before paint calibration is considered')
    assert.ok(result.trials.some((trial) => trial.traceMethod === 'fill-calibrated'))
    const chosen = result.trials[result.chosen]
    assert.equal(chosen.traceMethod, 'fill-calibrated')
    assert.equal(chosen.metrics.rgbWhite, 0)
    assert.equal(chosen.metrics.rgbDark, 0)
})
