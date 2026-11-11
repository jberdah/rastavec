import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const { buildSync } = createRequire(new URL('../cli/package.json', import.meta.url))('esbuild')
const bundled = buildSync({
  stdin: { contents: "export { choose, computeMetrics, score } from './src/lib/engine/core'", resolveDir: process.cwd() },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
}).outputFiles[0].text
const { choose, computeMetrics, score } = await import(`data:text/javascript;base64,${Buffer.from(bundled).toString('base64')}`)

const metric = (overrides = {}) => ({
  width: 100,
  height: 100,
  iou: 0.99,
  alphaDiff: 4,
  rgbWhite: 5,
  rgbDark: 5,
  pctDiff: 1,
  bytes: 10_000,
  paths: 100,
  embeddedRaster: false,
  ...overrides,
})

test('simplicity preserves a localized contour even when whole-image errors are near equal', () => {
  // Same 32px square and missing left column as edge-metrics.test.mjs;
  // a larger canvas puts the global difference inside the simplicity tolerance.
  const width = 256, height = 256
  const data = new Uint8ClampedArray(width * height * 4).fill(255)
  for (let y = 16; y < 48; y++) for (let x = 16; x < 48; x++) data.set([0, 0, 0, 255], (y * width + x) * 4)
  const source = { width, height, data }
  const damaged = new Uint8ClampedArray(data)
  for (let y = 16; y < 48; y++) damaged.set([255, 255, 255, 255], (y * width + 16) * 4)
  const exactSvg = '<svg><path/><path/><path/><path/></svg>'
  const simplerSvg = '<svg><path/><path/></svg>'
  const exact = computeMetrics(source, source, exactSvg)
  const simpler = computeMetrics(source, { width, height, data: damaged }, simplerSvg)
  const trials = [exact, simpler].map((metrics) => ({ metrics, score: score(metrics) }))

  assert.equal(simpler.pctDiff, 100 * 32 / (width * height))
  assert.ok(simpler.edgePctDiff > 12)
  assert.equal(choose(trials, 400 * 1024, { preferSimplicity: true }), 0)
  // Isolate the guard: without contour evidence, the old near-equal tie-break applies.
  const withoutEdges = trials.map((trial) => ({ ...trial, metrics: { ...trial.metrics, edgePctDiff: undefined } }))
  assert.equal(choose(withoutEdges, 400 * 1024, { preferSimplicity: true }), 1)
  const equallyFaithful = computeMetrics(source, source, simplerSvg)
  assert.equal(choose([trials[0], { metrics: equallyFaithful, score: trials[0].score + 0.001 }], 400 * 1024, { preferSimplicity: true }), 1)
})

test('Auto-Tune uses a simpler near-equal candidate from stored metrics and respects synthetic boundaries', () => {
    // Archived .tmp/mixed-svg-roundtrip-20261108/path-cost-sweep-20261108.json,
    // OpenClipart oc-400-5. That archive stores pctDiff/paths/bytes/score but not
    // RGB, alpha, or IoU; the shared remaining fields isolate the recorded pair.
    const baseline = {
      metrics: metric({ pctDiff: 4.8168182373046875, paths: 118, bytes: 39_001 }),
      score: 4.892992065429688,
    }
    const simpler = {
      metrics: metric({ pctDiff: 4.8492431640625, paths: 104, bytes: 36_708 }),
      score: 4.9209384765625,
    }

    assert.equal(choose([baseline, simpler], 400 * 1024), 0, 'ordinary selection keeps the score winner')
    assert.equal(choose([baseline, simpler], 400 * 1024, { preferSimplicity: true }), 1)

    const fidelityWinnerOverTarget = {
      metrics: metric({ bytes: 11_000, pctDiff: 1 }),
      score: 1,
    }
    const slightlyWorseUnderTarget = {
      metrics: metric({ bytes: 9_500, pctDiff: 1.3 }),
      score: 1.5,
    }
    assert.equal(choose([fidelityWinnerOverTarget, slightlyWorseUnderTarget], 10_000), 0,
      'a 10% overshoot costs 0.4 points, so a 0.5-point fidelity gain can win')

    const materiallyBetterUnderTarget = {
      metrics: metric({ bytes: 9_500, pctDiff: 1.2 }),
      score: 1.2,
    }
    const weakOverTarget = {
      metrics: metric({ bytes: 15_000, pctDiff: 1.1 }),
      score: 1.1,
    }
    assert.equal(choose([weakOverTarget, materiallyBetterUnderTarget], 10_000), 1,
      'a 50% overshoot adds 2 points, so a small fidelity gain cannot justify it')

    const syntheticBaseline = { metrics: metric(), score: 1 }
    const atBoundary = {
      metrics: metric({
        pctDiff: 1.05,
        rgbWhite: 5.5,
        rgbDark: 5.5,
        alphaDiff: 4.5,
        iou: 0.989,
        paths: 90,
        bytes: 9_500,
      }),
      score: 1.01,
    }
    assert.equal(choose([syntheticBaseline, atBoundary], 20_000, { preferSimplicity: true }), 1)

    const beyond = [
      metric({ ...atBoundary.metrics, pctDiff: 1.050001 }),
      metric({ ...atBoundary.metrics, rgbWhite: 5.500001, rgbDark: 5.500001 }),
      metric({ ...atBoundary.metrics, alphaDiff: 4.500001 }),
      metric({ ...atBoundary.metrics, iou: 0.988999 }),
    ]
    for (const metrics of beyond) {
      assert.equal(choose([syntheticBaseline, { metrics, score: 1.01 }], 20_000, { preferSimplicity: true }), 0)
    }

    const tooSmall = {
      metrics: metric({ paths: 91, bytes: 9_744 }),
      score: 1.01,
    }
    assert.equal(choose([syntheticBaseline, tooSmall], 20_000, { preferSimplicity: true }), 0)

    const overBudget = {
      metrics: metric({ paths: 80, bytes: 20_001 }),
      score: 1.01,
    }
    assert.equal(choose([syntheticBaseline, overBudget], 20_000, { preferSimplicity: true }), 0)
})
