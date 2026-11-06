import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'

test('CSV and review status use the measured edited output, not the original trial', async () => {
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
  try {
    const { metricsCsv } = await server.ssrLoadModule('/src/lib/export.ts')
    const { editKey, outputMetrics, needsReview } = await server.ssrLoadModule('/src/lib/store.svelte.ts')
    const { DEFAULT_FILTERS } = await server.ssrLoadModule('/src/lib/engine/palette.ts')
    const metrics = { width: 10, height: 10, iou: null, alphaDiff: 0, rgbWhite: 0, rgbDark: 0, pctDiff: 0.33, bytes: 100, paths: 1, embeddedRaster: false }
    const item = { id: '1', name: 'sample', status: 'done', chosen: 0, autoTuned: false, width: 10, height: 10,
      trials: [{ params: {}, metrics }], edit: { trial: 0, settings: { ...DEFAULT_FILTERS, hue: 140 } } }
    assert.equal(outputMetrics(item), undefined)
    assert.equal(needsReview(item), true)
    assert.throws(() => metricsCsv([item]), /metrics unavailable/)
    item.outputMeasurement = { key: editKey(item), metrics: { ...metrics, pctDiff: 7.1, bytes: 123 } }
    assert.equal(needsReview(item), true)
    const csv = metricsCsv([item])
    assert.match(csv, /sample,,7\.1,/)
    assert.match(csv, /,123,10,10,/)
    item.edit.settings.hue = 141
    assert.equal(outputMetrics(item), undefined, 'stale measurements must never be exported')
  } finally { await server.close() }
})

test('review and exported settings remain tied to the completed batch', async () => {
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
  try {
    const { config } = await server.ssrLoadModule('/src/lib/export.ts')
    const { app, needsReview } = await server.ssrLoadModule('/src/lib/store.svelte.ts')
    const metrics = { pctDiff: 4, bytes: 100 }
    const item = { id: 'batch', name: 'sample', status: 'done', chosen: 0, autoTuned: false, trials: [{ params: {}, metrics }] }
    app.batchSettings = { presetId: 'flat', params: { speckle: 3 }, auto: { enabled: true, threshold: 3, maxKB: 400 } }
    app.presetId = 'line'
    app.auto.threshold = 10
    assert.equal(needsReview(item), true)
    assert.equal(config([item]).preset, 'flat')
    assert.equal(config([item]).autoTune.threshold, 3)
  } finally { await server.close() }
})
