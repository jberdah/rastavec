import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { resolve } from 'node:path'

const bundle = await build({
  entryPoints: [resolve('src/lib/engine/planar-color-hypotheses.ts')],
  bundle: true, write: false, format: 'esm', platform: 'node',
})
const { proposePlanarColorHypotheses } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)

const width = 160, height = 160
const background = [255, 255, 255]
const blue = [0, 50, 250]
const red = [240, 20, 10]
const over = (top, alpha, bottom) => top.map((channel, index) => Math.round(channel * alpha + bottom[index] * (1 - alpha)))

function makeScene(withOutOfModelPatch = false) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const inBlue = x >= 20 && x < 105 && y >= 25 && y < 126
    const inRed = x >= 65 && x < 146 && y >= 50 && y < 141
    let color = [...background]
    if (inBlue) color = over(blue, 0.7, color)
    if (inRed) color = over(red, 0.7, color)
    if (withOutOfModelPatch && x >= 8 && x < 18 && y >= 8 && y < 18) color = [0, 250, 255]
    const offset = (y * width + x) * 4
    data.set([...color, 255], offset)
  }
  return { data, width, height }
}

function truthMask(isBlue) {
  const data = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const contains = isBlue
      ? x >= 20 && x < 105 && y >= 25 && y < 126
      : x >= 65 && x < 146 && y >= 50 && y < 141
    if (contains) data[y * width + x] = 1
  }
  return { width, height, data }
}

function maskIou(a, b) {
  let intersection = 0, union = 0
  for (let index = 0; index < a.data.length; index++) {
    if (a.data[index] && b.data[index]) intersection++
    if (a.data[index] || b.data[index]) union++
  }
  return union ? intersection / union : 1
}

test('planar masks exclude out-of-model pixels from counts, fitting, adjacency, and output', () => {
  const baseline = proposePlanarColorHypotheses(makeScene())
  const withPatch = proposePlanarColorHypotheses(makeScene(true))
  assert.equal(baseline.status, 'proposed')
  assert.equal(withPatch.status, 'proposed')

  const { outOfModelPixelCount, outOfModelFraction } = withPatch.diagnostics.adjacency
  assert.equal(outOfModelPixelCount, 100)
  assert.ok(outOfModelFraction > 0)
  assert.equal(withPatch.diagnostics.colorStates.reduce((sum, state) => sum + state.pixels, 0), width * height - outOfModelPixelCount)
  assert.ok(withPatch.diagnostics.warnings.some((warning) => warning.includes('excluded from state counts, paint fitting, adjacency, and masks')))
  assert.deepEqual(withPatch.diagnostics.graph, baseline.diagnostics.graph)
  assert.deepEqual(withPatch.diagnostics.paintFit, baseline.diagnostics.paintFit)

  for (const hypothesis of withPatch.hypotheses) {
    for (let y = 8; y < 18; y++) for (let x = 8; x < 18; x++) assert.equal(hypothesis.mask.data[y * width + x], 0)
  }
  assert.deepEqual(withPatch.hypotheses.map(({ id }) => id), baseline.hypotheses.map(({ id }) => id))
  assert.deepEqual(withPatch.hypotheses.map(({ mask }) => [...mask.data]), baseline.hypotheses.map(({ mask }) => [...mask.data]))
})

test('planar membership masks recover the expected full regions on an exact two-object control', () => {
  const result = proposePlanarColorHypotheses(makeScene())
  assert.equal(result.status, 'proposed')
  const truth = [truthMask(true), truthMask(false)]
  const scores = truth.map((mask) => result.hypotheses.map((hypothesis) => maskIou(mask, hypothesis.mask)))
  const direct = [scores[0][0], scores[1][1]]
  const swapped = [scores[0][1], scores[1][0]]
  const best = direct.reduce((sum, score) => sum + score, 0) >= swapped.reduce((sum, score) => sum + score, 0) ? direct : swapped
  assert.ok(best.every((score) => score >= 0.95), `expected high-IoU full membership masks, received ${best.join(', ')}`)
})
