import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const { buildSync } = createRequire(new URL('../cli/package.json', import.meta.url))('esbuild')
const bundled = buildSync({
  stdin: {
    contents: "export { choose, computeMetrics, falseEdgePct, score } from './src/lib/engine/core'; export { editableShare } from './src/lib/engine/editable-share'; export { needsReviewResult, overBudget } from './src/lib/engine/vectorize'",
    resolveDir: process.cwd(),
  },
  bundle: true, write: false, platform: 'node', format: 'esm',
}).outputFiles[0].text
const { choose, computeMetrics, falseEdgePct, score, editableShare, needsReviewResult, overBudget } = await import(`data:text/javascript;base64,${Buffer.from(bundled).toString('base64')}`)

const metric = (overrides = {}) => ({
  width: 100, height: 100, iou: 1, alphaDiff: 0, rgbWhite: 1, rgbDark: 1, pctDiff: 0.5,
  bytes: 20_000, paths: 50, embeddedRaster: false, ...overrides,
})
const trial = (overrides, extra = {}) => { const metrics = metric(overrides); return { metrics, score: score(metrics), ...extra } }

/** Horizontal ramp from 40 to 200, optionally quantized into `bands` flat steps. */
function ramp(width, height, bands = 0) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const t = bands ? (Math.floor(x * bands / width) + 0.5) / bands : x / (width - 1)
    const v = Math.round(40 + 160 * t)
    data.set([v, v, v, 255], (y * width + x) * 4)
  }
  return { width, height, data }
}

test('banding of a smooth area is measured as false edges and costs score', () => {
  const source = ramp(160, 20), banded = ramp(160, 20, 8)
  assert.equal(falseEdgePct(source, source), 0)
  // Seven steps of 20 levels, one pixel column each.
  assert.equal(falseEdgePct(source, banded), 100 * 7 / 160)
  const smooth = computeMetrics(source, source, '<svg><path/></svg>')
  const stepped = computeMetrics(source, banded, '<svg><path/></svg>')
  assert.equal(smooth.falseEdgePct, 0)
  // No pixel is far enough from the source to count as a visible difference: only the false
  // edges (and the small mean color error) tell the two renders apart.
  assert.equal(stepped.pctDiff, 0)
  assert.ok(score(stepped) - score(smooth) > 0.5 * stepped.falseEdgePct)
})

test('a real edge of the source is not a false edge', () => {
  const width = 40, height = 10
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i++) data.set((i % width) < 20 ? [0, 0, 0, 255] : [255, 255, 255, 255], i * 4)
  const source = { width, height, data }
  assert.equal(falseEdgePct(source, source), 0)
})

test('without a budget the score alone weighs size against fidelity', () => {
  // Twice the bytes cost about 1.5 points: worth it for 2 points of visible difference, not for 0.2.
  const light = trial({ pctDiff: 2.5, bytes: 600_000 })
  const heavyAndFaithful = trial({ pctDiff: 0.5, bytes: 1_200_000 })
  assert.equal(choose([light, heavyAndFaithful], 0), 1)
  const barelyBetter = trial({ pctDiff: 2.3, bytes: 1_200_000 })
  assert.equal(choose([light, barelyBetter], 0), 0)
  // A budget, when the user sets one, still pushes back.
  assert.equal(choose([light, heavyAndFaithful], 600 * 1024), 0)
})

test('a visible difference costs more as it grows', () => {
  const step = (from) => score(metric({ pctDiff: from + 1 })) - score(metric({ pctDiff: from }))
  assert.ok(step(4) > 2 * step(0.2))
})

test('a few bytes on a tiny SVG do not outweigh fidelity', () => {
  const tiny = trial({ pctDiff: 0.3, bytes: 300 })
  const tinyAndExact = trial({ pctDiff: 0, rgbWhite: 0, rgbDark: 0, bytes: 450 })
  assert.equal(choose([tiny, tinyAndExact], 0), 1)
})

test('recovered gradients and shapes are preferred at equal fidelity and weight', () => {
  const outlines = trial({})
  const objects = trial({ editableShare: 0.4 })
  assert.equal(choose([outlines, objects], 0), 1)
  // But not at any price: 0.6 points at most, for a fully editable image.
  const objectsButWrong = trial({ editableShare: 1, pctDiff: 1.5 })
  assert.equal(choose([outlines, objectsButWrong], 0), 0)
})

test('the simplicity tie-break does not undo what the score rewards', () => {
  // Cityscape: the gradient trace wins on score; a lighter flat variant is near-equal in pixels.
  const gradients = trial({ pctDiff: 1.54, bytes: 113_000, paths: 919, falseEdgePct: 0.56, editableShare: 0.77 })
  const flat = trial({ pctDiff: 1.48, bytes: 102_000, paths: 917, falseEdgePct: 0.63 })
  assert.equal(choose([gradients, flat], 0), 0)
  assert.equal(choose([gradients, flat], 0, { preferSimplicity: true }), 0)
  // Without that difference, the lighter near-equal trial is still preferred.
  const sameStructure = trial({ pctDiff: 1.56, bytes: 100_000, paths: 800, falseEdgePct: 0.56, editableShare: 0.77 })
  const scoreWinner = { ...gradients, score: sameStructure.score - 0.01 }
  assert.equal(choose([scoreWinner, sameStructure], 0, { preferSimplicity: true }), 1)
})

test('on pixel art an exact grid is not traded for a lighter, softened trace', () => {
  const softened = trial({ pctDiff: 0.4, bytes: 3_000 })
  const grid = trial({ pctDiff: 0, rgbWhite: 0, rgbDark: 0, bytes: 40_000 }, { traceMethod: 'pixel-grid' })
  assert.equal(choose([softened, grid], 0), 0, 'the plain score prefers the much lighter trace')
  assert.equal(choose([softened, grid], 0, { preferExactPixelGrid: true }), 1)
  // Another exact trial may still win on score, and a budget the grid misses lifts the preference.
  const exactTrace = trial({ pctDiff: 0, rgbWhite: 0, rgbDark: 0, bytes: 5_000 })
  assert.equal(choose([softened, grid, exactTrace], 0, { preferExactPixelGrid: true }), 2)
  assert.equal(choose([softened, grid], 20 * 1024, { preferExactPixelGrid: true }), 0)
  // An inexact grid gets no preference.
  const roughGrid = trial({ pctDiff: 0.2, bytes: 40_000 }, { traceMethod: 'pixel-grid' })
  assert.equal(choose([softened, roughGrid], 0, { preferExactPixelGrid: true }), 0)
})

test('editable share counts gradient paths and exact shapes, not plain outlines or overlays', () => {
  const svg = '<svg viewBox="0 0 100 100"><path fill="url(#g)" d="M0 0h50v100H0z"/><path fill="#123456" d="M50 0h50v100H50z"/><path d="M0 0"/><path fill="url(#o)" d="M0 0h100v100H0z"/></svg>'
  const gradient = { id: 'g', type: 'linear', stops: 2, opaque: true }
  assert.equal(editableShare(svg, undefined), 0)
  assert.equal(editableShare(svg, [{ index: 0, kind: 'path', gradient }, { index: 1, kind: 'path' }]), 0.5)
  const withCircle = editableShare(svg, [{ index: 0, kind: 'path', gradient }, { index: 2, kind: 'circle', cx: 75, cy: 50, r: 10 }])
  assert.ok(Math.abs(withCircle - (0.5 + Math.PI / 100)) < 1e-9)
  // A translucent overlay sits on a shape that is already counted.
  assert.equal(editableShare(svg, [{ index: 0, kind: 'path', gradient }, { index: 3, kind: 'path', gradient: { ...gradient, id: 'o', opaque: false }, overlayOf: 0 }]), 0.5)
  // A hole is subtracted.
  const ring = '<svg viewBox="0 0 10 10"><path fill="url(#g)" d="M0 0h10v10H0zM2 2v6h6V2z"/></svg>'
  assert.equal(editableShare(ring, [{ index: 0, kind: 'path', gradient }]), 0.64)
})

test('size only flags a result for review when a budget is set', () => {
  const result = { trials: [{ metrics: metric({ pctDiff: 1, bytes: 900_000 }) }], chosen: 0 }
  assert.equal(overBudget(900_000, { enabled: true, threshold: 3, maxKB: 0 }), false)
  assert.equal(needsReviewResult(result, { enabled: true, threshold: 3, maxKB: 0 }), false)
  assert.equal(needsReviewResult(result, { enabled: true, threshold: 3, maxKB: 400 }), true)
  assert.equal(needsReviewResult(result, { enabled: true, threshold: 0.5, maxKB: 0 }), true)
})
