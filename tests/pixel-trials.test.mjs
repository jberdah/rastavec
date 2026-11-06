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
    assert.notEqual(budget.trials[budget.chosen].traceScale, 4, 'a candidate over budget must not displace one within budget')
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
  } finally { await server.close() }
})
