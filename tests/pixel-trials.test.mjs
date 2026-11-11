import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'

test('small automatic images try enlarged traces and keep original SVG dimensions', async () => {
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
  try {
    const { vectorize } = await server.ssrLoadModule('/src/lib/engine/vectorize.ts')
    const { DEFAULT_PARAMS } = await server.ssrLoadModule('/src/lib/engine/presets.ts')
    const src = { width: 2, height: 2, data: new Uint8ClampedArray([255,0,0,255, 0,255,0,255, 0,0,255,255, 255,255,0,255]) }
    const dimensions = []
    const backend = {
      name: 'test',
      async trace(prep) {
        dimensions.push([prep.image.width, prep.image.height])
        return `<svg width="${prep.image.width}" height="${prep.image.height}" viewBox="0 0 ${prep.image.width} ${prep.image.height}"><path d="M0 0"/></svg>`
      },
      async rasterize(svg, width, height) {
        return { width, height, data: svg.includes('viewBox="0 0 8 8"') ? src.data.slice() : new Uint8ClampedArray(src.data.length) }
      },
    }
    const auto = { enabled: true, threshold: 0, maxKB: 400 }
    const result = await vectorize(src, { presetId: 'auto', params: DEFAULT_PARAMS, auto }, backend)
    const selected = result.trials[result.chosen]
    assert.equal(selected.traceScale, 4)
    assert.match(selected.svg, /width="2" height="2" viewBox="0 0 8 8"/)
    assert.ok(dimensions.some(([w, h]) => w === 8 && h === 8))
    assert.equal(selected.metrics.pctDiff, 0)
    const largeBackend = { ...backend, async trace(prep) {
      const svg = await backend.trace(prep)
      return prep.image.width === 8 ? svg.replace('</svg>', `${' '.repeat(2048)}</svg>`) : svg
    } }
    const budget = await vectorize(src, { presetId: 'auto', params: DEFAULT_PARAMS, auto: { ...auto, maxKB: 1 } }, largeBackend)
    // The size budget is a target, not a hard limit: going over it costs score in proportion
    // to the overshoot. A faithful trace twice the budget still beats traces that fit the
    // budget but miss the picture entirely, and the result is flagged for review.
    assert.equal(budget.trials[budget.chosen].traceScale, 4, 'a faithful candidate over budget beats unfaithful ones within it')
    assert.ok(budget.trials[budget.chosen].metrics.bytes > 1024)
    const { needsReviewResult } = await server.ssrLoadModule('/src/lib/engine/vectorize.ts')
    assert.equal(needsReviewResult(budget, { ...auto, maxKB: 1 }), true, 'an over-budget choice is flagged for review')
    // The penalty still decides close calls: a small fidelity gain does not pay for doubling the size.
    const { choose } = await server.ssrLoadModule('/src/lib/engine/core.ts')
    const metrics = (bytes) => ({ bytes, paths: 10, pctDiff: 0, rgbWhite: 0, rgbDark: 0, alphaDiff: 0, iou: 1 })
    assert.equal(choose([{ metrics: metrics(1000), score: 1.0 }, { metrics: metrics(2000), score: 0.9 }], 1000), 0)
    assert.equal(choose([{ metrics: metrics(1000), score: 10 }, { metrics: metrics(2000), score: 0.9 }], 1000), 1)
    assert.equal(choose([{ metrics: metrics(1000), score: 1.0 }, { metrics: metrics(2000), score: 0.9 }], 0), 1, 'no budget, no penalty')
    const custom = await vectorize(src, { presetId: 'custom', params: DEFAULT_PARAMS, auto }, backend)
    assert.ok(custom.trials.every((trial) => trial.traceScale === 1))
    const single = await vectorize(src, { presetId: 'auto', params: DEFAULT_PARAMS, auto: { ...auto, enabled: false } }, backend)
    assert.equal(single.trials.length, 1)
    const failingBackend = { ...backend, async trace(prep) {
      if (prep.image.width === 8) throw new Error('test failure')
      return backend.trace(prep)
    } }
    const partial = await vectorize(src, { presetId: 'auto', params: DEFAULT_PARAMS, auto }, failingBackend)
    assert.deepEqual(partial.failedTrials, [{ traceScale: 4, message: 'test failure' }])
    assert.ok(partial.trials.length > 0)
    const gridBackend = { ...backend, async rasterize(svg, width, height) {
      return { width, height, data: svg.includes('shape-rendering="crispEdges"') ? src.data.slice() : new Uint8ClampedArray(src.data.length) }
    } }
    const exact = await vectorize(src, { presetId: 'auto', params: DEFAULT_PARAMS, auto }, gridBackend)
    assert.equal(exact.trials[exact.chosen].traceMethod, 'pixel-grid')
    assert.equal(exact.trials[exact.chosen].metrics.pctDiff, 0)
    assert.equal(exact.trials[exact.chosen].metrics.paths, 4)

    const pixelSrc = { width: 16, height: 16, data: new Uint8ClampedArray(16 * 16 * 4) }
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const color = ((x >> 2) + (y >> 2)) % 2 ? [245, 45, 30] : [20, 70, 220]
      pixelSrc.data.set([...color, 255], (y * 16 + x) * 4)
    }
    const underThresholdPixelBackend = {
      name: 'under-threshold-pixel',
      async trace() { return '<svg width="16" height="16" data-base="true"><path d="M0 0h16v16H0z" fill="#000"/></svg>' },
      async rasterize(svg, width, height) {
        const data = pixelSrc.data.slice()
        if (svg.includes('data-base="true"')) data.set([0, 255, 0, 255], 0)
        return { width, height, data }
      },
    }
    const pixelAuto = await vectorize(pixelSrc, { presetId: 'auto', params: DEFAULT_PARAMS, auto: { ...auto, threshold: 3 } }, underThresholdPixelBackend)
    assert.equal(pixelAuto.analysis.kind, 'pixel')
    assert.equal(pixelAuto.trials.length, 2, 'Auto should compare the exact grid even when VTracer is already below threshold')
    assert.equal(pixelAuto.trials[pixelAuto.chosen].traceMethod, 'pixel-grid')
    assert.equal(pixelAuto.trials[pixelAuto.chosen].metrics.pctDiff, 0)
  } finally { await server.close() }
})
