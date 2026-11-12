import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const { buildSync } = createRequire(new URL('../cli/package.json', import.meta.url))('esbuild')
const bundled = buildSync({
  stdin: { contents: "export { computeMetrics } from './src/lib/engine/core'", resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'esm',
}).outputFiles[0].text
const { computeMetrics } = await import(`data:text/javascript;base64,${Buffer.from(bundled).toString('base64')}`)

test('contour metric exposes a localized edge error without affecting the whole-image score', () => {
  const width = 64, height = 64
  const source = new Uint8ClampedArray(width * height * 4)
  for (let p = 0; p < width * height; p++) source.set([255, 255, 255, 255], p * 4)
  for (let y = 16; y < 48; y++) for (let x = 16; x < 48; x++) source.set([0, 0, 0, 255], (y * width + x) * 4)
  const render = new Uint8ClampedArray(source)
  for (let y = 16; y < 48; y++) render.set([255, 255, 255, 255], (y * width + 16) * 4)
  const metrics = computeMetrics({ width, height, data: source }, { width, height, data: render }, '<svg/>')
  assert.ok(metrics.edgePctDiff > metrics.pctDiff * 5)
  assert.equal(metrics.pctDiff, 100 * 32 / (width * height))

  const flat = new Uint8ClampedArray(width * height * 4)
  for (let p = 0; p < width * height; p++) flat.set([255, 255, 255, 255], p * 4)
  assert.equal(computeMetrics({ width, height, data: flat }, { width, height, data: flat }, '<svg/>').edgePctDiff, undefined)

  // Opaque white and transparent white look identical on white, but form a
  // strong source edge on a dark background.
  const transparent = new Uint8ClampedArray(flat)
  for (let y = 16; y < 48; y++) for (let x = 16; x < 48; x++) transparent[(y * width + x) * 4 + 3] = 0
  const alphaRender = new Uint8ClampedArray(transparent)
  for (let y = 16; y < 48; y++) alphaRender[(y * width + 16) * 4 + 3] = 255
  const alphaMetrics = computeMetrics({ width, height, data: transparent }, { width, height, data: alphaRender }, '<svg/>')
  assert.ok(alphaMetrics.edgePctDiff > alphaMetrics.pctDiff * 5)
})
