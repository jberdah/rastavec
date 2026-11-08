import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'

test('Auto tightens only flat images with narrow alpha edges', async () => {
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
  try {
    const { recommend } = await server.ssrLoadModule('/src/lib/engine/analyze.ts')
    const flatEdges = { width: 512, height: 512, kind: 'flat', alpha: 'edges', softPct: 0.6, dominantColors: 6, gradient: 0.02, grayscale: false, transparentPct: 40 }
    assert.equal(recommend(flatEdges).params.silhouetteCut, 192)
    assert.equal(recommend({ ...flatEdges, softPct: 1 }).params.silhouetteCut, 128)
    assert.equal(recommend({ ...flatEdges, kind: 'shaded' }).params.silhouetteCut, 128)
    assert.equal(recommend({ ...flatEdges, alpha: 'soft' }).params.silhouetteCut, 128)
  } finally {
    await server.close()
  }
})

test('Auto searches the 224 alpha cut without adding it to other presets', async () => {
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
  try {
    const { candidates } = await server.ssrLoadModule('/src/lib/engine/core.ts')
    const { DEFAULT_PARAMS } = await server.ssrLoadModule('/src/lib/engine/presets.ts')
    const autoCuts = candidates(DEFAULT_PARAMS, { transparent: true, includeHighSilhouetteCut: true }).map(({ params }) => params.silhouetteCut)
    const otherPresetCuts = candidates(DEFAULT_PARAMS, { transparent: true }).map(({ params }) => params.silhouetteCut)
    assert.ok(autoCuts.includes(224))
    assert.ok(!otherPresetCuts.includes(224))
  } finally {
    await server.close()
  }
})

test('Auto checks a 224 alpha cut for passing flat artwork with narrow edges', async () => {
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
  try {
    const { vectorize } = await server.ssrLoadModule('/src/lib/engine/vectorize.ts')
    const { DEFAULT_PARAMS } = await server.ssrLoadModule('/src/lib/engine/presets.ts')
    const width = 10, height = 10
    const src = { width, height, data: new Uint8ClampedArray(width * height * 4) }
    src.data.set([20, 40, 60, 255], 0)
    src.data.set([20, 40, 60, 255], 4)
    const analysis = { width, height, kind: 'flat', alpha: 'edges', softPct: 0.5, transparentPct: 99, dominantColors: 2, gradient: 0, grayscale: false }
    const backend = {
      name: 'high-alpha-cut-review-test',
      async trace(_prepared, params) { return `<svg data-cut="${params.silhouetteCut}"/>` },
      async rasterize(svg, w, h) {
        const data = new Uint8ClampedArray(w * h * 4)
        data.set([20, 40, 60, 255], 0)
        if (svg.includes('data-cut="224"')) data.set([20, 40, 60, 255], 4)
        return { width: w, height: h, data }
      },
    }
    const settings = { presetId: 'auto', params: DEFAULT_PARAMS, auto: { enabled: true, threshold: 3, maxKB: 400 } }
    const progress = []
    const result = await vectorize(src, settings, backend, { analysis, onProgress: (done, total) => progress.push(`${done}/${total}`) })
    assert.equal(result.trials.length, 3, 'Auto also compares one polygon-mode candidate')
    assert.equal(result.trials[0].params.silhouetteCut, 192)
    assert.equal(result.trials[1].params.silhouetteCut, 224)
    assert.equal(result.trials[2].params.mode, 'polygon')
    assert.equal(result.trials[0].metrics.pctDiff, 1, 'the base output already passes the 3% threshold')
    assert.equal(result.trials[result.chosen].metrics.pctDiff, 0)
    assert.equal(result.autoTuned, true)
    assert.deepEqual(progress, ['1/6', '2/6', '3/6', '4/6', '5/6', '6/6'])

    const custom = await vectorize(src, { ...settings, presetId: 'custom' }, backend, { analysis })
    assert.equal(custom.trials.length, 1, 'the extra quality pass is Auto-only')

    const widerEdges = await vectorize(src, settings, backend, { analysis: { ...analysis, softPct: 1 } })
    assert.equal(widerEdges.trials.length, 2, 'wide alpha fringes still get the general polygon comparison')
    assert.ok(!widerEdges.trials.some((trial) => trial.params.silhouetteCut === 224), 'the dedicated high-cut pass stays restricted to narrow alpha fringes')
  } finally {
    await server.close()
  }
})

test('Auto retries faint soft-alpha artwork when the traced silhouette is badly incomplete', async () => {
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
  try {
    const { vectorize } = await server.ssrLoadModule('/src/lib/engine/vectorize.ts')
    const { DEFAULT_PARAMS } = await server.ssrLoadModule('/src/lib/engine/presets.ts')
    const width = 100, height = 100
    const src = { width, height, data: new Uint8ClampedArray(width * height * 4) }
    const opaque = Array.from({ length: 20 }, (_, i) => (1000 + i * 10) * 4)
    for (let i = 0; i < 200; i++) src.data.set([0, 0, 0, 16], i * 4)
    for (const i of opaque) src.data.set([0, 0, 0, 255], i)
    const analysis = { width, height, kind: 'line', alpha: 'soft', softPct: 2, transparentPct: 98, dominantColors: 2, gradient: 0.1, grayscale: false }
    const backend = {
      name: 'soft-alpha-recovery-test',
      async trace(_prepared, params) {
        return `<svg data-variant="${params.softColor ? 'soft-color' : 'soft-layers'}"/>`
      },
      async rasterize(svg, w, h) {
        const data = new Uint8ClampedArray(w * h * 4)
        if (svg.includes('soft-layers')) data.set(src.data)
        else for (const i of opaque.slice(0, 4)) data.set([0, 0, 0, 255], i)
        return { width: w, height: h, data }
      },
    }
    const settings = { presetId: 'auto', params: DEFAULT_PARAMS, auto: { enabled: true, threshold: 3, maxKB: 400 } }
    const progress = []
    const result = await vectorize(src, settings, backend, { analysis, onProgress: (done, total) => progress.push(`${done}/${total}`) })
    assert.equal(result.trials[0].metrics.pctDiff, 0.16, 'the ordinary pixel gate should pass this sparse faint image')
    assert.equal(result.trials[0].metrics.iou, 0.2, 'the traced silhouette misses most opaque shapes')
    assert.equal(result.trials.length, 3, 'Auto adds the recovery trial and one polygon comparison')
    assert.equal(result.trials[1].params.softColor, false)
    assert.equal(result.trials[1].params.softLayers, 1)
    assert.equal(result.trials[2].params.mode, 'polygon')
    assert.equal(result.trials[result.chosen].metrics.pctDiff, 0)
    assert.equal(result.autoTuned, true)
    assert.deepEqual(progress, ['1/5', '2/5', '3/5', '4/5', '5/5'], 'progress includes optional color and path refinement passes')

    const edgeResult = await vectorize(src, settings, backend, { analysis: { ...analysis, alpha: 'edges' } })
    assert.equal(edgeResult.trials.length, 2, 'low silhouette IoU with hard edges does not trigger the soft-alpha fallback')
    assert.equal(edgeResult.trials[1].params.mode, 'polygon')
  } finally {
    await server.close()
  }
})

test('Auto compares polygon geometry on vector-like artwork and keeps the better render', async () => {
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
  try {
    const { vectorize } = await server.ssrLoadModule('/src/lib/engine/vectorize.ts')
    const { DEFAULT_PARAMS } = await server.ssrLoadModule('/src/lib/engine/presets.ts')
    const width = 300, height = 300
    const src = { width, height, data: new Uint8ClampedArray(width * height * 4) }
    src.data.set([20, 40, 60, 255], 0)
    src.data.set([20, 40, 60, 255], 4)
    const analysis = { width, height, kind: 'flat', alpha: 'edges', softPct: 0.5, transparentPct: 99, dominantColors: 2, gradient: 0, grayscale: false }
    const backend = {
      name: 'polygon-review-test',
      async trace(_prepared, params) { return `<svg data-mode="${params.mode}" data-cut="${params.silhouetteCut}"/>` },
      async rasterize(svg, w, h) {
        const data = new Uint8ClampedArray(w * h * 4)
        if (svg.includes('data-mode="polygon"')) data.set(src.data.subarray(0, 8))
        else data.set(src.data.subarray(0, 4))
        return { width: w, height: h, data }
      },
    }
    const settings = { presetId: 'auto', params: DEFAULT_PARAMS, auto: { enabled: true, threshold: 3, maxKB: 400 } }
    const progress = []
    const result = await vectorize(src, settings, backend, { analysis, onProgress: (done, total) => progress.push(`${done}/${total}`) })
    assert.equal(result.trials.length, 3, 'baseline, dedicated alpha-cut review, and polygon review are all counted')
    assert.equal(result.trials[2].params.mode, 'polygon')
    assert.equal(result.trials[0].metrics.pctDiff, 0.0011111111111111111)
    assert.equal(result.trials[2].metrics.pctDiff, 0)
    assert.equal(result.trials[result.chosen].params.mode, 'polygon')
    assert.equal(result.autoTuned, true)
    assert.deepEqual(progress, ['1/6', '2/6', '3/6', '4/6', '5/6', '6/6'])

    const custom = await vectorize(src, { ...settings, presetId: 'custom' }, backend, { analysis })
    assert.equal(custom.trials.length, 1, 'custom mode keeps its requested trace parameters')

    const opaque = new Uint8ClampedArray(300 * 300 * 4)
    for (let i = 0; i < opaque.length; i += 4) opaque.set([20, 40, 60, 255], i)
    const pixelAnalysis = { ...analysis, kind: 'pixel', alpha: 'opaque', softPct: 0, transparentPct: 0 }
    const pixelBackend = {
      ...backend,
      async rasterize(_svg, w, h) { return { width: w, height: h, data: opaque } },
    }
    const pixelResult = await vectorize({ width, height, data: opaque }, settings, pixelBackend, { analysis: pixelAnalysis })
    assert.equal(pixelResult.trials.length, 1, 'pixel artwork does not receive a duplicate polygon-mode Auto trial')
  } finally {
    await server.close()
  }
})
