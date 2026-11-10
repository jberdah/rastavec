import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { resolve } from 'node:path'

const bundle = await build({
  entryPoints: [resolve('src/lib/engine/circle-overlap-hypotheses.ts')],
  bundle: true, write: false, format: 'esm', platform: 'node',
})
const { proposeThreeCircleOverlaps } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)

function compositeCircles({ background, fills, opacity, width = 220, height = 220, circles = [[73, 83, 67], [147, 83, 67], [110, 148, 67]] }) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let color = [...background]
    circles.forEach(([cx, cy, radius], index) => {
      if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= radius)
        color = fills[index].map((channel, component) => Math.round(channel * opacity + color[component] * (1 - opacity)))
    })
    data.set([...color, 255], (y * width + x) * 4)
  }
  return { data, width, height }
}

function truthMask(circle, width, height) {
  const [cx, cy, radius] = circle
  const data = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++)
    if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= radius) data[y * width + x] = 1
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

function modalRgb(image) {
  const counts = new Map()
  for (let pixel = 0; pixel < image.width * image.height; pixel++) {
    const offset = pixel * 4
    const key = `${image.data[offset]},${image.data[offset + 1]},${image.data[offset + 2]}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0].split(',').map(Number)
}

function permutations(values) {
  if (!values.length) return [[]]
  return values.flatMap((value, index) => permutations(values.filter((_, other) => other !== index)).map((rest) => [value, ...rest]))
}

function bestMaskAssignment(hypotheses, circles, width, height) {
  const truths = circles.map((circle) => truthMask(circle, width, height))
  const scores = truths.map((truth) => hypotheses.map(({ mask }) => maskIou(truth, mask)))
  return permutations(hypotheses.map((_, index) => index))
    .map((assignment) => ({ assignment, scores: assignment.map((prediction, truth) => scores[truth][prediction]) }))
    .sort((a, b) => b.scores.reduce((sum, score) => sum + score, 0) - a.scores.reduce((sum, score) => sum + score, 0))[0]
}

test('circle paint fitting withholds paint and order when the best-order margin is ambiguous', () => {
  const result = proposeThreeCircleOverlaps(compositeCircles({
    background: [32, 32, 40],
    fills: [[100, 100, 110], [180, 180, 190], [240, 240, 250]],
    opacity: 0.35,
  }))
  assert.equal(result.status, 'proposed')
  assert.ok(result.diagnostics.orderFit)
  assert.ok(result.diagnostics.orderFit.margin < 2)
  assert.equal(result.diagnostics.orderFit.orderIdentifiable, false)
  assert.equal('bottomToTop' in result.diagnostics.orderFit, false)
  assert.ok(result.diagnostics.warnings.some((warning) => warning.includes('treat order as ambiguous')))
  for (const hypothesis of result.hypotheses) {
    assert.equal(hypothesis.paint, undefined)
    assert.equal(hypothesis.paintOrder, undefined)
  }
})

test('circle paint fitting retains order only when the fit margin passes its gate', () => {
  const circles = [[73, 83, 67], [147, 83, 67], [110, 148, 67]]
  const result = proposeThreeCircleOverlaps(compositeCircles({
    background: [32, 32, 40],
    fills: [[0, 240, 255], [255, 0, 127], [255, 236, 0]],
    opacity: 0.75,
  }))
  assert.equal(result.status, 'proposed')
  assert.equal(result.diagnostics.orderFit?.orderIdentifiable, true)
  assert.equal(result.diagnostics.orderFit?.bottomToTop?.length, 3)
  assert.equal(result.diagnostics.backgroundBorderSupportFraction, 1)
  assert.equal(result.diagnostics.backgroundCornerSupportCount, 4)
  assert.ok(result.diagnostics.boundaryArcCoverageDegrees.every((coverage) => coverage >= result.diagnostics.minimumBoundaryArcCoverageDegrees))
  assert.ok(result.hypotheses.every((hypothesis) => hypothesis.paint !== undefined && hypothesis.paintOrder?.length === 2))

  const best = bestMaskAssignment(result.hypotheses, circles, 220, 220)
  assert.ok(best.scores.every((score) => score >= 0.95), `expected high-IoU full circle masks, received ${best.scores.join(', ')}`)
  for (let truthIndex = 0; truthIndex < circles.length; truthIndex++) {
    const [cx, cy, radius] = circles[truthIndex]
    const geometry = result.hypotheses[best.assignment[truthIndex]].geometry.parameters
    assert.ok(Math.abs(geometry.cx - cx) <= 2, `center x ${geometry.cx} should recover ${cx}`)
    assert.ok(Math.abs(geometry.cy - cy) <= 2, `center y ${geometry.cy} should recover ${cy}`)
    assert.ok(Math.abs(geometry.radius - radius) <= 2, `radius ${geometry.radius} should recover ${radius}`)
  }
})

test('circle fitting abstains when an exposed color arc has insufficient angular coverage', () => {
  const scene = compositeCircles({
    background: [32, 32, 40],
    fills: [[255, 0, 127], [0, 240, 255], [255, 236, 0]],
    opacity: 0.75,
    width: 360,
    height: 300,
    circles: [[170, 150, 100], [100, 150, 40], [280, 150, 50]],
  })
  const result = proposeThreeCircleOverlaps(scene)
  assert.equal(result.status, 'abstained', JSON.stringify(result.diagnostics))
  assert.match(result.reason, /less than 150° of exposed-arc coverage/)
  assert.ok(result.diagnostics.boundaryArcCoverageDegrees.some((coverage) => coverage < 150))
})

test('circle provider abstains when the image border does not identify a flat background', () => {
  const result = proposeThreeCircleOverlaps(compositeCircles({
    background: [32, 32, 40],
    fills: [[0, 240, 255], [255, 0, 127], [255, 236, 0]],
    opacity: 0.75,
    width: 140,
    height: 140,
  }))
  assert.equal(result.status, 'abstained')
  assert.match(result.reason, /image border does not reliably identify a flat background/)
  assert.ok(result.diagnostics.backgroundBorderSupportFraction < 0.75)
})

test('circle background is chosen from border evidence when an interior overlap is the modal color', () => {
  const scene = compositeCircles({
    background: [32, 32, 40],
    fills: [[0, 240, 255], [255, 0, 127], [255, 236, 0]],
    opacity: 0.75,
    circles: [[103, 105, 100], [117, 105, 100], [110, 119, 100]],
  })
  assert.notDeepEqual(modalRgb(scene), [32, 32, 40], 'the generated triple-overlap color should dominate the image interior')
  const result = proposeThreeCircleOverlaps(scene)
  assert.equal(result.status, 'abstained')
  assert.match(result.reason, /less than 150° of exposed-arc coverage/)
  assert.deepEqual(result.diagnostics.background, [32, 32, 40])
  assert.equal(result.diagnostics.backgroundBorderSupportFraction, 1)
})
