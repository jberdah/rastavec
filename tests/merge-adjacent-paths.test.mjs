import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'

let server
let mergeAdjacentSameFillPaths
let vectorize
let DEFAULT_PARAMS

before(async () => {
  server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
  ;({ mergeAdjacentSameFillPaths } = await server.ssrLoadModule('/src/lib/engine/merge-adjacent-paths.ts'))
  ;({ vectorize } = await server.ssrLoadModule('/src/lib/engine/vectorize.ts'))
  ;({ DEFAULT_PARAMS } = await server.ssrLoadModule('/src/lib/engine/presets.ts'))
})

after(async () => { await server?.close() })

test('merges only consecutive artwork paths with identical paint attributes', () => {
  const svg = '<svg><path d="M0 0" fill="#123"/><path d="M1 1" fill="#123" transform="translate(2)"/><path d="M2 2" fill="#123" transform="translate(2)"/><path d="M3 3" fill="#abc" transform="translate(2)"/></svg>'
  const result = mergeAdjacentSameFillPaths(svg)
  assert.equal(result.merged, 1)
  assert.match(result.svg, /d="M1 1 M2 2" fill="#123" transform="translate\(2\)"/)
  assert.match(result.svg, /<path d="M0 0" fill="#123"\/>/)
  assert.match(result.svg, /<path d="M3 3" fill="#abc"/)
})

test('does not cross markup, differing attributes, or path data without a move command', () => {
  const svg = '<svg><path d="M0 0" fill="#123"/><rect/><path d="M1 1" fill="#123"/><path d="M2 2" fill="#456"/><path d="L3 3" fill="#456"/></svg>'
  assert.deepEqual(mergeAdjacentSameFillPaths(svg), { svg, merged: 0 })
})

test('does not merge silhouette clip geometry or soft layers', () => {
  const svg = '<svg><defs><clipPath id="silhouette"><path d="M0 0"/><path d="M1 1"/></clipPath></defs><g id="soft-1" fill="#123"><path d="M2 2" fill="#123"/><path d="M3 3" fill="#123"/></g><g clip-path="url(#silhouette)"><path d="M4 4" fill="#abc"/><path d="M5 5" fill="#abc"/></g></svg>'
  const result = mergeAdjacentSameFillPaths(svg)
  assert.equal(result.merged, 1)
  assert.equal((result.svg.match(/<path\b/g) ?? []).length, 5)
  assert.match(result.svg, /<path d="M0 0"\/><path d="M1 1"\/>/)
  assert.match(result.svg, /<path d="M2 2" fill="#123"\/><path d="M3 3" fill="#123"\/>/)
  assert.match(result.svg, /d="M4 4 M5 5" fill="#abc"/)
})

test('Auto retains a merged-path candidate only when render metrics stay safe', async () => {
  const src = { width: 2, height: 1, data: new Uint8ClampedArray([20, 30, 40, 255, 20, 30, 40, 255]) }
  const analysis = { width: 2, height: 1, kind: 'flat', alpha: 'opaque', softPct: 0, transparentPct: 0, dominantColors: 1, gradient: 0, grayscale: false }
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="1" viewBox="0 0 2 1"><path d="M0 0" fill="#141e28"/><path d="M1 0" fill="#141e28"/></svg>'
  const backend = {
    name: 'safe-path-merge-test',
    async trace() { return svg },
    async rasterize() { return { ...src, data: new Uint8ClampedArray(src.data) } },
  }
  const settings = { presetId: 'auto', params: DEFAULT_PARAMS, auto: { enabled: true, threshold: 3, maxKB: 400 } }
  const result = await vectorize(src, settings, backend, { analysis })
  const merged = result.trials.find((trial) => trial.traceMethod === 'paths-merged')
  assert.ok(merged)
  assert.equal(merged.metrics.paths, 1)
  assert.ok(merged.metrics.bytes < result.trials[0].metrics.bytes)
  assert.equal(result.trials[result.chosen].traceMethod, 'paths-merged')

  const unsafeBackend = {
    ...backend,
    name: 'unsafe-path-merge-test',
    async rasterize(candidate) {
      const data = new Uint8ClampedArray(src.data)
      if (candidate.includes('M0 0 M1 0')) data[0] = 255
      return { width: src.width, height: src.height, data }
    },
  }
  const unsafe = await vectorize(src, settings, unsafeBackend, { analysis })
  assert.ok(!unsafe.trials.some((trial) => trial.traceMethod === 'paths-merged'))
})

test('path merging stays out of custom mode', async () => {
  const src = { width: 1, height: 1, data: new Uint8ClampedArray([20, 30, 40, 255]) }
  const backend = {
    name: 'custom-path-merge-test',
    async trace() { return '<svg><path d="M0 0" fill="#141e28"/><path d="M0 0" fill="#141e28"/></svg>' },
    async rasterize() { return { ...src, data: new Uint8ClampedArray(src.data) } },
  }
  const result = await vectorize(src, { presetId: 'custom', params: DEFAULT_PARAMS, auto: { enabled: true, threshold: 3, maxKB: 400 } }, backend, {
    analysis: { width: 1, height: 1, kind: 'flat', alpha: 'opaque', softPct: 0, transparentPct: 0, dominantColors: 1, gradient: 0, grayscale: false },
  })
  assert.equal(result.trials.length, 1)
  assert.ok(!result.trials.some((trial) => trial.traceMethod === 'paths-merged'))
})
