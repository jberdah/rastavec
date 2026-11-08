import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { resolve } from 'node:path'

const bundle = await build({
  stdin: { contents: `export { makePromptGrid, uniqueMaskCandidates } from './src/lib/engine/mobile-sam-inference.ts'`, resolveDir: resolve('.'), sourcefile: 'mobile-sam-inference-entry.ts' },
  bundle: true, write: false, format: 'esm', platform: 'node',
})
const { makePromptGrid, uniqueMaskCandidates } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)

test('prompt grid is deterministic, row-major and bounded to the resized image', () => {
  const points = makePromptGrid(100, 60, 2)
  assert.deepEqual(points, [
    { x: 25, y: 15, row: 0, column: 0 }, { x: 75, y: 15, row: 0, column: 1 },
    { x: 25, y: 45, row: 1, column: 0 }, { x: 75, y: 45, row: 1, column: 1 },
  ])
  assert.deepEqual(makePromptGrid(100, 60, 2), points)
  assert.throws(() => makePromptGrid(100, 60, 1), /grid-size/)
})

test('proposal filtering removes empty and near-identical masks without reordering', () => {
  const candidate = (column, values) => ({ prompt: { x: column, y: 1, row: 0, column }, score: 0.8, width: 4, height: 2, data: new Uint8Array(values) })
  const first = candidate(0, [1, 1, 0, 0, 1, 1, 0, 0])
  const duplicate = candidate(1, [1, 1, 0, 0, 1, 1, 0, 0])
  const distinct = candidate(2, [0, 0, 1, 1, 0, 0, 1, 1])
  const empty = candidate(3, [0, 0, 0, 0, 0, 0, 0, 0])
  assert.deepEqual(uniqueMaskCandidates([first, duplicate, distinct, empty]), [first, distinct])
})
