import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { resolve } from 'node:path'

const bundle = await build({
  stdin: {
    contents: `export { compareProviderHypothesisSets } from './src/lib/engine/object-hypotheses.ts'`,
    resolveDir: resolve('.'), sourcefile: 'object-hypothesis-comparison-entry.ts',
  },
  bundle: true, write: false, format: 'esm', platform: 'node',
})
const { compareProviderHypothesisSets } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)

const provider = (name, id, meaning, values) => ({
  provider: name,
  hypotheses: [{ id, maskMeaning: meaning, mask: { width: values.length, height: 1, data: Uint8Array.from(values) } }],
})

test('provider mask comparison does not compute IoU across different or unknown mask meanings', () => {
  for (const meanings of [['visible-object', 'completed-object'], ['unknown', 'unknown']]) {
    const result = compareProviderHypothesisSets([
      provider('left', 'left-1', meanings[0], [1, 1, 0, 0]),
      provider('right', 'right-1', meanings[1], [1, 1, 0, 0]),
    ])
    const comparison = result.maskComparisons[0]
    assert.equal(comparison.maskMeaningsComparable, false)
    assert.equal(comparison.meanAssignedIoU, null)
    assert.equal(comparison.meanMatchedIoU, null)
    assert.deepEqual(comparison.matches, [])
    assert.deepEqual(comparison.unmatchedLeft, ['left-1'])
    assert.deepEqual(comparison.unmatchedRight, ['right-1'])
  }
})

test('provider comparison separates assigned IoU diagnostics from threshold-qualified matches', () => {
  const result = compareProviderHypothesisSets([
    provider('left', 'left-low', 'visible-object', [1, 1, 0, 0]),
    provider('right', 'right-low', 'visible-object', [0, 1, 1, 1]),
  ])
  const comparison = result.maskComparisons[0]
  assert.equal(comparison.maskMeaningsComparable, true)
  assert.equal(comparison.meanAssignedIoU, 0.25)
  assert.equal(comparison.meanMatchedIoU, null)
  assert.equal(comparison.matchesAtThreshold, 0)
  assert.equal(comparison.matches[0].acceptedAtThreshold, false)
  assert.deepEqual(comparison.unmatchedLeft, ['left-low'])
  assert.deepEqual(comparison.unmatchedRight, ['right-low'])
})

test('provider comparison reports IoU only for same-meaning threshold-qualified masks', () => {
  const result = compareProviderHypothesisSets([
    provider('left', 'left-1', 'completed-object', [1, 1, 0, 0]),
    provider('right', 'right-1', 'completed-object', [1, 1, 0, 0]),
  ])
  const comparison = result.maskComparisons[0]
  assert.equal(comparison.maskMeaningsComparable, true)
  assert.equal(comparison.meanAssignedIoU, 1)
  assert.equal(comparison.meanMatchedIoU, 1)
  assert.equal(comparison.matches[0].acceptedAtThreshold, true)
  assert.deepEqual(comparison.unmatchedLeft, [])
  assert.deepEqual(comparison.unmatchedRight, [])
})
