import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { resolve } from 'node:path'

const bundle = await build({
  stdin: { contents: `export { binaryMaskFromRgba, selectGroupsByMask, svgViewBox } from './src/lib/engine/segmentation-mask.ts'`, resolveDir: resolve('.'), sourcefile: 'segmentation-mask-entry.ts' },
  bundle: true, write: false, format: 'esm', platform: 'node',
})
const { binaryMaskFromRgba, selectGroupsByMask, svgViewBox } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)

const group = (id, pathIndices, members, pivot = [0, 0]) => ({
  id, key: id, pathIndices, count: pathIndices.length, bounds: [0, 0, 1, 1], pivot, fill: '#000000', zone: 'center', level: 0, members,
})

test('white and transparent local masks become a compact binary mask', () => {
  const alpha = new Uint8ClampedArray([
    0, 0, 0, 0,
    0, 0, 0, 255,
  ])
  assert.deepEqual([...binaryMaskFromRgba(alpha, 2, 1).data], [0, 1])

  const grayscale = new Uint8ClampedArray([
    0, 0, 0, 255,
    255, 255, 255, 255,
  ])
  assert.deepEqual([...binaryMaskFromRgba(grayscale, 2, 1).data], [0, 1])
})

test('a local segmentation mask selects only reviewable path groups by centre overlap', () => {
  const data = new Uint8Array(100)
  for (let y = 2; y < 6; y++) for (let x = 2; x < 6; x++) data[y * 10 + x] = 1
  const mask = { width: 10, height: 10, data }
  const groups = [
    group('inside', [0], [{ pathIndex: 0, pivot: [30, 30] }], [30, 30]),
    group('outside', [1], [{ pathIndex: 1, pivot: [80, 80] }], [80, 80]),
    group('mixed', [2, 3], [
      { pathIndex: 2, pivot: [30, 30] },
      { pathIndex: 3, pivot: [80, 80] },
    ]),
    group('no-member-metadata', [4, 5], undefined, [30, 30]),
    { ...group('parent', [6], [{ pathIndex: 6, pivot: [30, 30] }], [30, 30]), level: 1 },
  ]

  const result = selectGroupsByMask(groups, mask, { x: 0, y: 0, width: 100, height: 100 }, 100, 100)
  assert.deepEqual(result.groupIds, ['inside'])
  assert.deepEqual(result.pathIndices, [0, 2])
  assert.equal(result.sampledPaths, 4)
  assert.equal(result.matchedPaths, 2)
})

test('viewBox parsing supports non-zero origins and rejects invalid dimensions', () => {
  assert.deepEqual(svgViewBox('<svg viewBox="-10 20 100 50">'), { x: -10, y: 20, width: 100, height: 50 })
  assert.equal(svgViewBox('<svg viewBox="0 0 0 40">'), null)
  assert.equal(svgViewBox('<svg width="100" height="50">'), null)
})
