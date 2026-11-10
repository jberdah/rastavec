import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { resolve } from 'node:path'

const bundle = await build({
  entryPoints: [resolve('src/lib/engine/circle-overlap-hypotheses.ts')],
  bundle: true, write: false, format: 'esm', platform: 'node',
})
const { proposeThreeCircleOverlaps } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)

function compositeCircles({ background, fills, opacity, width = 220, height = 220 }) {
  const circles = [[73, 83, 67], [147, 83, 67], [110, 148, 67]]
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
  const result = proposeThreeCircleOverlaps(compositeCircles({
    background: [32, 32, 40],
    fills: [[0, 240, 255], [255, 0, 127], [255, 236, 0]],
    opacity: 0.75,
  }))
  assert.equal(result.status, 'proposed')
  assert.equal(result.diagnostics.orderFit?.orderIdentifiable, true)
  assert.equal(result.diagnostics.orderFit?.bottomToTop?.length, 3)
  assert.ok(result.hypotheses.every((hypothesis) => hypothesis.paint !== undefined && hypothesis.paintOrder?.length === 2))
})
