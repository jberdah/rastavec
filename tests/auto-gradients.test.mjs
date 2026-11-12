import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const { buildSync } = createRequire(new URL('../cli/package.json', import.meta.url))('esbuild')
const bundled = buildSync({
  stdin: { contents: "export { vectorize } from './src/lib/engine/vectorize'; export { choose } from './src/lib/engine/core'; export { DEFAULT_PARAMS } from './src/lib/engine/presets'; export { analyze } from './src/lib/engine/analyze'", resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'esm',
}).outputFiles[0].text
const { vectorize, choose, DEFAULT_PARAMS, analyze } = await import(`data:text/javascript;base64,${Buffer.from(bundled).toString('base64')}`)

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
    const solid = '<svg viewBox="0 0 20 20"><path fill="#756150" d="M0 0h20v20H0z"/></svg>'
    const gradient = '<svg viewBox="0 0 20 20"><defs><linearGradient id="paint"><stop stop-color="#786450"/></linearGradient></defs><path fill="url(#paint)" d="M0 0h20v20H0z"/></svg>'
    const backend = {
      name: 'gradient-and-solid-calibration-test',
      async trace() { return solid },
      async traceColorSource() { return solid },
      async traceColorSourceWithGradients() { return gradient },
      // As the real engine does: the gradient-painted path is reported, so the score counts it as editable.
      shapeHintsFor(svg) {
        return svg.includes('url(#paint)')
          ? [{ index: 0, kind: 'path', gradient: { id: 'paint', type: 'linear', stops: 1, opaque: true } }]
          : []
      },
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
    assert.equal(gradientTrial.metrics.editableShare, 1)
    const calibrated = result.trials.find((trial) => trial.traceMethod === 'fill-calibrated')
    assert.equal(calibrated.metrics.rgbWhite, 0)
    assert.equal(calibrated.metrics.rgbDark, 0)
    // Both are now exact. The flat fill is a few bytes lighter, the gradient stays editable as a
    // gradient: the score keeps the gradient.
    assert.equal(result.trials[result.chosen], gradientTrial)
})

const image = (width, height, paint) => {
    const data = new Uint8ClampedArray(width * height * 4)
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(paint(x, y), (y * width + x) * 4)
    return { width, height, data }
}

test('analysis measures gentle gradient ramps that per-pixel smoothness misses', () => {
    // A clean linear gradient over 240 px: 0-1 levels per pixel, a dozen 12-bit colours.
    const ramp = analyze(image(240, 120, (x) => [200 + Math.round(x / 12), 130 + Math.round(x / 8), 100, 255]))
    assert.equal(ramp.kind, 'flat')
    assert.ok(ramp.smoothRamps > 0.9, `ramps ${ramp.smoothRamps}`)
    // Flat shapes with hard edges: no ramps.
    const flat = analyze(image(240, 120, (x, y) => (x - 60) ** 2 + (y - 60) ** 2 < 1600 ? [115, 80, 184, 255] : x > 100 ? [233, 135, 90, 255] : [244, 245, 249, 255]))
    assert.equal(flat.kind, 'flat')
    assert.equal(flat.smoothRamps, 0)
})

test('an antialiased fringe on the canvas border is an edge, not a translucent glow', () => {
    // A 24 px wide strip whose shape is cut by the canvas: its two border columns are antialiased.
    const strip = analyze(image(24, 256, (x, y) => [20 + y / 2, 60 + y / 3, 120, x === 0 || x === 23 ? 190 : 255]))
    assert.equal(strip.alpha, 'edges')
})

test('Auto compares gradients on flat-looking art only when it has smooth ramps', async () => {
    const src = image(20, 20, () => [120, 100, 80, 255])
    const analysis = { width: 20, height: 20, kind: 'flat', alpha: 'opaque', softPct: 0, transparentPct: 0, dominantColors: 8, gradient: 0.02, smoothRamps: 0.35, grayscale: false }
    const backend = {
      name: 'flat-ramps-test',
      async trace() { return '<svg/>' },
      async traceColorSource() { return '<svg data-gradient="off"/>' },
      async traceColorSourceWithGradients() { return '<svg data-gradient="on"/>' },
      async rasterize(svg, w, h) {
        const data = new Uint8ClampedArray(w * h * 4)
        for (let i = 0; i < w * h; i++) data.set(svg.includes('data-gradient="on"') ? [120, 100, 80, 255] : [0, 0, 0, 255], i * 4)
        return { width: w, height: h, data }
      },
    }
    const settings = { presetId: 'auto', params: DEFAULT_PARAMS, auto: { enabled: true, threshold: 3, maxKB: 400 } }
    const ramps = await vectorize(src, settings, backend, { analysis })
    assert.equal(ramps.trials[ramps.chosen].traceMethod, 'experimental-gradients')
    const flat = await vectorize(src, settings, backend, { analysis: { ...analysis, smoothRamps: 0.04 } })
    assert.equal(flat.trials.some((trial) => trial.traceMethod === 'experimental-gradients'), false)
})

test('Auto fits gradients over stacked layers even when the hierarchy review picked a cutout', async () => {
    // Touching translucent regions of different colours make Auto compare a cutout trace.
    const src = image(32, 32, (x) => x < 16 ? [220, 40, 30, 128] : [30, 80, 220, 128])
    const analysis = { width: 32, height: 32, kind: 'shaded', alpha: 'edges', softPct: 1, transparentPct: 0, dominantColors: 20, gradient: 0.2, smoothRamps: 0.5, grayscale: false }
    const backend = {
      name: 'cutout-then-gradients-test',
      supportsHierarchyComparison: true,
      async trace() { return '<svg/>' },
      async traceColorSource(_src, params) { return `<svg data-h="${params.hierarchical}"/>` },
      // As the engine does: gradients are fitted over stacked layers only.
      async traceColorSourceWithGradients(_src, params) {
        if (params.hierarchical !== 'stacked') throw new Error('unsupported: experimental gradients require stacked color segmentation')
        return '<svg data-gradient="on"/>'
      },
      async rasterize(svg, w, h) {
        const exact = svg.includes('data-gradient="on"'), near = svg.includes('data-h="cutout"')
        return { width: w, height: h, data: new Uint8ClampedArray(src.data.map((v, i) => exact || (i & 3) === 3 ? v : near ? v - 20 : 0)) }
      },
    }
    const settings = { presetId: 'auto', params: DEFAULT_PARAMS, auto: { enabled: true, threshold: 3, maxKB: 400 } }
    const result = await vectorize(src, settings, backend, { analysis })
    assert.ok(result.trials.some((trial) => !trial.traceMethod && trial.params.hierarchical === 'cutout'), 'a cutout trial should be compared')
    assert.deepEqual(result.failedTrials, [])
    const gradient = result.trials.find((trial) => trial.traceMethod === 'experimental-gradients')
    assert.ok(gradient)
    assert.equal(gradient.params.hierarchical, 'stacked')
    assert.equal(result.trials[result.chosen], gradient)
})

test('on a large raster Auto runs the full gradient trials only when a reduced probe shows they help', async () => {
    // Over a megapixel each full-size gradient fit costs seconds: a flat logo must not pay for them.
    const src = image(1100, 1000, () => [120, 100, 80, 255])
    const analysis = { width: 1100, height: 1000, kind: 'shaded', alpha: 'opaque', softPct: 0, transparentPct: 0, dominantColors: 20, gradient: 0.2, smoothRamps: 0.5, grayscale: false }
    const run = async (helps) => {
      const sizes = []
      const backend = {
        name: 'gradient-probe-test',
        async trace() { return '<svg/>' },
        async traceColorSource(img) { sizes.push(img.width); return '<svg data-g="off"/>' },
        async traceColorSourceWithGradients(img) { sizes.push(img.width); return '<svg data-g="on"/>' },
        async rasterize(svg, w, h) {
          const exact = helps && svg.includes('data-g="on"')
          const data = new Uint8ClampedArray(w * h * 4)
          for (let i = 0; i < w * h; i++) data.set(exact ? [120, 100, 80, 255] : [180, 160, 140, 255], i * 4)
          return { width: w, height: h, data }
        },
      }
      const result = await vectorize(src, { presetId: 'auto', params: DEFAULT_PARAMS, auto: { enabled: true, threshold: 3, maxKB: 0 } }, backend, { analysis })
      return { result, sizes }
    }
    const useless = await run(false)
    assert.ok(useless.sizes.includes(275), 'the probe traces a reduced copy')
    assert.equal(useless.result.trials.some((trial) => trial.traceMethod?.endsWith('gradients')), false)
    const useful = await run(true)
    assert.equal(useful.result.trials.filter((trial) => trial.traceMethod?.endsWith('gradients')).length, 2)
    assert.equal(useful.result.trials[useful.result.chosen].traceMethod, 'experimental-gradients')
})
