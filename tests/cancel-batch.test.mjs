import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'

test('cancelling a new run keeps the previous trials, edit and batch settings', async () => {
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
  try {
    const { app, sources } = await server.ssrLoadModule('/src/lib/store.svelte.ts')
    const { browserBackend } = await server.ssrLoadModule('/src/lib/engine/browser-backend.ts')
    const { processAll, cancelProcessing } = await server.ssrLoadModule('/src/lib/pipeline.ts')
    app.traceEngine = 'test'
    const oldTrace = browserBackend.trace, oldRasterize = browserBackend.rasterize
    const pixel = { data: new Uint8ClampedArray([0, 0, 0, 255]), width: 1, height: 1 }
    let release, began
    const started = new Promise((resolve) => { began = resolve })
    browserBackend.trace = () => new Promise((resolve) => { release = () => resolve('<svg width="1" height="1"/>'); began() })
    browserBackend.rasterize = async () => pixel
    const oldTrial = { svg: '<svg/>', params: {}, metrics: { pctDiff: 7, bytes: 8 }, score: 7, ms: 1, base: true }
    const oldEdit = { trial: 0, settings: { hue: 20 } }
    const item = { id: 'prior', name: 'prior', file: {}, srcUrl: 'blob:prior', status: 'done', progress: '',
      srcBytes: 1, width: 1, height: 1, semiPct: 0, trials: [oldTrial], chosen: 0, autoTuned: false, edit: oldEdit,
      analysis: { width: 1, height: 1, kind: 'flat', alpha: 'opaque', transparentPct: 0, softPct: 0, dominantColors: 1, gradient: 0, grayscale: false } }
    app.items = [item]
    sources.set(item.id, pixel)
    const previousSettings = { presetId: 'flat', params: { ...app.params }, auto: { ...app.auto, threshold: 2 } }
    app.batchSettings = previousSettings
    app.presetId = 'shaded'
    try {
      const run = processAll()
      await started
      assert.equal(app.running, true)
      cancelProcessing()
      assert.equal(app.cancelRequested, true)
      release()
      await run
      assert.equal(app.running, false)
      assert.equal(app.batchCancelled, true)
      assert.equal(app.items[0].status, 'done')
      assert.equal(app.items[0].trials[0].svg, '<svg/>')
      assert.equal(app.items[0].edit.settings.hue, 20)
      assert.equal(app.batchSettings.presetId, 'flat')
      assert.equal(app.batchSettings.auto.threshold, 2)
      browserBackend.trace = async () => '<svg width="1" height="1" viewBox="0 0 1 1"/>'
      app.auto.enabled = false
      await processAll()
      assert.equal(app.items[0].status, 'done')
      assert.match(app.items[0].trials[0].svg, /viewBox/)
      assert.equal(app.items[0].edit, undefined, 'a completed rerun replaces the previous edit')
      assert.equal(app.batchCancelled, false)
      assert.equal(app.batchSettings.presetId, 'shaded')
      const firstSvg = app.items[0].trials[0].svg
      app.items.push({ ...item, id: 'second', name: 'second', trials: [oldTrial], edit: oldEdit })
      sources.set('second', pixel)
      let count = 0, unblock, secondStarted
      const secondTrialStarted = new Promise((resolve) => { secondStarted = resolve })
      browserBackend.trace = async () => {
        if (++count === 1) return '<svg width="1" height="1" viewBox="0 0 1 1"/>'
        return new Promise((resolve) => { unblock = () => resolve('<svg width="1" height="1"/>'); secondStarted() })
      }
      const partial = processAll()
      await secondTrialStarted
      assert.equal(app.batchProcessed, 1)
      assert.equal(app.items[0].status, 'prepared')
      cancelProcessing()
      unblock()
      await partial
      assert.equal(app.items[0].status, 'done')
      assert.equal(app.items[0].trials[0].svg, firstSvg, 'first completed new result is rolled back')
      assert.equal(app.items[1].trials[0].svg, '<svg/>')
      assert.equal(app.items[1].edit.settings.hue, 20)
    } finally { browserBackend.trace = oldTrace; browserBackend.rasterize = oldRasterize; sources.clear() }
  } finally { await server.close() }
})
