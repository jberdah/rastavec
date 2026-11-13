import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const { buildSync } = createRequire(new URL('../cli/package.json', import.meta.url))('esbuild')
const bundled = buildSync({
  stdin: {
    contents: "export { vectorize } from './src/lib/engine/vectorize'; export { analyze } from './src/lib/engine/analyze'; export { DEFAULT_PARAMS } from './src/lib/engine/presets'; export { nextOptions, SIMPLE_GRADIENT_TOLERANCE } from './src/lib/engine/vtracer-next-trace'",
    resolveDir: process.cwd(),
  },
  bundle: true, write: false, platform: 'node', format: 'esm',
}).outputFiles[0].text
const { vectorize, analyze, DEFAULT_PARAMS, nextOptions, SIMPLE_GRADIENT_TOLERANCE } = await import(`data:text/javascript;base64,${Buffer.from(bundled).toString('base64')}`)

const settings = { presetId: 'auto', params: DEFAULT_PARAMS, auto: { enabled: true, threshold: 3, maxKB: 0 } }
const shaded = (alpha) => ({ width: 8, height: 8, kind: 'shaded', alpha, softPct: 0, transparentPct: alpha === 'opaque' ? 0 : 50, dominantColors: 40, gradient: 0.2, grayscale: false })

/** A backend that records what it is asked and renders every trace as the source. */
function recorder(src, extra = {}) {
  const calls = []
  return {
    calls,
    backend: {
      name: 'recorder',
      async trace() { return '<svg/>' },
      async traceColorSource(source) { calls.push({ kind: 'plain', source }); return '<svg data-kind="plain"/>' },
      async traceColorSourceWithGradients(source, _params, simple) { calls.push({ kind: simple ? 'simple' : 'exact', source }); return `<svg data-kind="${simple ? 'simple' : 'exact'}"><linearGradient id="g"/></svg>` },
      async rasterize(_svg, width, height) { return { width, height, data: new Uint8ClampedArray(src.data) } },
      ...extra,
    },
  }
}

test('the engine options for simplified gradients raise the tolerance and nothing else', () => {
  const exact = nextOptions(DEFAULT_PARAMS, false, true)
  const simple = nextOptions(DEFAULT_PARAMS, false, 'simple')
  assert.equal(exact.experimentalGradients, true)
  assert.equal(exact.gradientTolerance, undefined)
  assert.deepEqual(simple, { ...exact, gradientTolerance: SIMPLE_GRADIENT_TOLERANCE })
  assert.equal(nextOptions(DEFAULT_PARAMS, false, false).experimentalGradients, false)
})

test('Auto tries exact and simplified gradients on shaded art, cut-outs included', async () => {
  const src = { width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4).fill(200) }
  for (const alpha of ['opaque', 'edges', 'hard']) {
    const { backend } = recorder(src)
    const result = await vectorize(src, settings, backend, { analysis: shaded(alpha) })
    const methods = result.trials.map((trial) => trial.traceMethod).filter(Boolean)
    assert.ok(methods.includes('experimental-gradients'), alpha)
    assert.ok(methods.includes('simple-gradients'), alpha)
  }
  // Soft alpha (glows, translucent areas) stays on the regular path.
  const { backend } = recorder(src)
  const soft = await vectorize(src, settings, backend, { analysis: shaded('soft') })
  assert.equal(soft.trials.some((trial) => trial.traceMethod === 'experimental-gradients' || trial.traceMethod === 'simple-gradients'), false)
})

test('when gradients are forced, only the simplified variant is added', async () => {
  const src = { width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4).fill(200) }
  const { backend, calls } = recorder(src, { gradientsByDefault: true })
  const result = await vectorize(src, settings, backend, { analysis: shaded('opaque') })
  assert.equal(result.trials.filter((trial) => trial.traceMethod === 'simple-gradients').length, 1)
  assert.equal(result.trials.some((trial) => trial.traceMethod === 'experimental-gradients'), false)
  assert.equal(calls.some((call) => call.kind === 'exact'), false)
})

test('pixels under the alpha floor never reach a native color trace', async () => {
  const src = { width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4) }
  for (let i = 0; i < 64; i++) src.data.set(i < 32 ? [90, 20, 60, 255] : [10, 0, 5, i % 2 ? 3 : 0], i * 4)
  const { backend, calls } = recorder(src)
  await vectorize(src, settings, backend, { analysis: { ...shaded('edges'), kind: 'flat' } })
  assert.ok(calls.length > 0)
  for (const { source } of calls) {
    for (let i = 0; i < 64; i++) {
      const alpha = source.data[i * 4 + 3]
      assert.ok(alpha === 0 || alpha >= DEFAULT_PARAMS.alphaFloor, `pixel ${i} alpha ${alpha}`)
    }
    assert.deepEqual([...source.data.subarray(0, 4)], [90, 20, 60, 255])
  }
  // The source itself is left alone: metrics are still measured against it.
  assert.equal(src.data[33 * 4 + 3], 3)
})

test('two or three colors are flat art, whatever the antialiasing says', () => {
  // One dark color on an empty canvas, with a noisy outline between them.
  const width = 200, height = 200
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const inside = (x >> 3) % 2 === 0
    const noise = ((x * 7 + y * 13) % 5) * 3
    data.set(inside ? [80 + noise, 12, 52 + noise, 255] : [0, 0, 0, 0], (y * width + x) * 4)
  }
  const analysis = analyze({ width, height, data })
  assert.ok(analysis.dominantColors <= 3, JSON.stringify(analysis))
  assert.ok(analysis.gradient >= 0.12, JSON.stringify(analysis))
  assert.notEqual(analysis.kind, 'shaded')
})
