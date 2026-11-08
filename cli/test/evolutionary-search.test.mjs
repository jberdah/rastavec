import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { resolve } from 'node:path'

const bundled = await build({
  stdin: {
    contents: `export { proposeEvolutionaryCandidates, runEvolutionarySearch } from './src/lib/engine/evolutionary-search.ts'; export { DEFAULT_PARAMS } from './src/lib/engine/presets.ts'`,
    resolveDir: resolve('..'),
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
})
const { proposeEvolutionaryCandidates, runEvolutionarySearch, DEFAULT_PARAMS } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)

test('evolutionary candidates are deterministic, unique, and bounded to valid trace parameters', () => {
  const base = { ...DEFAULT_PARAMS }
  const alternative = { ...base, colorPrecision: 6, layerDifference: 12, speckle: 9 }
  const parents = [{ params: base, score: 1 }, { params: alternative, score: 2 }]
  const occupied = new Set([JSON.stringify(base), JSON.stringify(alternative)])
  const first = proposeEvolutionaryCandidates(parents, occupied, 0, 8)
  const second = proposeEvolutionaryCandidates(parents, occupied, 0, 8)
  assert.deepEqual(first, second)
  assert.equal(first.length, 8)
  assert.equal(new Set(first.map((params) => JSON.stringify(params))).size, first.length)
  for (const params of first) {
    assert.equal(params.colormode, base.colormode)
    assert.equal(params.clustering, base.clustering)
    assert.ok(params.colorPrecision >= 1 && params.colorPrecision <= 8)
    assert.ok(params.layerDifference >= 1 && params.layerDifference <= 255)
    assert.ok(params.speckle >= 0 && params.speckle <= 128)
    assert.ok(params.cornerThreshold >= 0 && params.cornerThreshold <= 180)
    assert.ok(params.lengthThreshold >= 0 && params.lengthThreshold <= 100)
  }
})

test('search stops at its evaluation budget and returns only new evaluations', async () => {
  const first = { ...DEFAULT_PARAMS }
  const second = { ...first, colorPrecision: 6, layerDifference: 12, speckle: 9 }
  const initial = [{ params: first, score: 1 }, { params: second, score: 2 }]
  const evaluated = []
  const extras = await runEvolutionarySearch(initial, async (params) => {
    const sample = { params, score: params.colorPrecision + params.layerDifference / 100 }
    evaluated.push(sample)
    return sample
  }, { maxEvaluations: 5, generationSize: 3, generations: 4 })
  assert.equal(extras.length, 5)
  assert.equal(evaluated.length, 5)
  assert.deepEqual(extras, evaluated)
  assert.equal(new Set(extras.map((sample) => JSON.stringify(sample.params))).size, extras.length)
})
