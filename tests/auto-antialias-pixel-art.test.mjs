// Auto on small raster artwork: native pixel art goes to the exact pixel grid, anti-aliased
// icons are traced with their anti-aliasing resolved into flat shapes instead of one thin
// layer per edge shade.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import init, { vectorize_rgba } from '../src/lib/engine/vtracer-next-wasm/vtracer_next.js'

const require = createRequire(new URL('../cli/package.json', import.meta.url))
const sharp = require('sharp')
const code = require('esbuild').buildSync({
  stdin: {
    contents: `export { vectorize } from './src/lib/engine/vectorize'
export { analyze, pixelBlockSize } from './src/lib/engine/analyze'
export { resolveAntialiasing } from './src/lib/engine/antialias-resolve'
export { DEFAULT_PARAMS } from './src/lib/engine/presets'
export { withVTracerNext } from './src/lib/engine/vtracer-next-trace'
export { optionsFor } from './src/lib/engine/trace-options'`,
    resolveDir: process.cwd(),
  },
  bundle: true, write: false, platform: 'node', format: 'esm',
}).outputFiles[0].text
const { vectorize, analyze, pixelBlockSize, resolveAntialiasing, DEFAULT_PARAMS, withVTracerNext, optionsFor } =
  await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
await init({ module_or_path: await readFile(new URL('../src/lib/engine/vtracer-next-wasm/vtracer_next_bg.wasm', import.meta.url)) })
const backend = withVTracerNext(
  { async rasterize(svg, width, height) { return { width, height, data: new Uint8ClampedArray(await sharp(Buffer.from(svg)).resize(width, height).ensureAlpha().raw().toBuffer()) } } },
  false,
  async (src, p, b, g) => vectorize_rgba(new Uint8Array(src.data), src.width, src.height, { ...optionsFor(p, b), experimentalGradients: g }),
  () => { throw Error('unexpected binary') },
)
const settings = { presetId: 'auto', params: DEFAULT_PARAMS, auto: { enabled: true, threshold: 3, maxKB: 0 } }
async function decode(file) {
  const { data, info } = await sharp(`tests/fixtures/${file}.png`).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return { width: info.width, height: info.height, data: new Uint8ClampedArray(data) }
}
function enlarge(src, k) {
  const out = { width: src.width * k, height: src.height * k, data: new Uint8ClampedArray(src.data.length * k * k) }
  for (let y = 0; y < out.height; y++) for (let x = 0; x < out.width; x++) {
    const from = (Math.floor(y / k) * src.width + Math.floor(x / k)) * 4
    out.data.set(src.data.subarray(from, from + 4), (y * out.width + x) * 4)
  }
  return out
}

test('binary-alpha sprites are pixel art; anti-aliased icons are not', async () => {
  // Shaded sprites have many small colour steps, which the gradient test alone took for shading.
  for (const file of ['pixel-art/tiny-wizard', 'pixel-art/shield', 'pixel-art/potion', 'pixel-art/sword', 'grouping-corpus/armor', 'grouping-corpus/gold']) {
    assert.equal(analyze(await decode(file)).kind, 'pixel', file)
  }
  // Partially transparent edges mean anti-aliasing, whatever the size or colour count.
  for (const file of ['grouping-corpus/kenney-arrow', 'grouping-corpus/kenney-button', 'grouping-corpus/kenney-bear']) {
    assert.notEqual(analyze(await decode(file)).kind, 'pixel', file)
  }
  // A sprite enlarged by a whole factor with nearest-neighbour scaling is still pixel art.
  const wizard = await decode('pixel-art/tiny-wizard')
  assert.equal(pixelBlockSize(wizard), 1)
  const big = enlarge(wizard, 4)
  assert.equal(pixelBlockSize(big), 4)
  assert.equal(analyze(big).kind, 'pixel')
})

test('anti-aliasing mixes become sub-pixels of their two flat colours, in proportion', () => {
  // Red | 25 % red over blue | blue, on three rows.
  const width = 3, height = 3, data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    data.set([255, 0, 0, 255], (y * width) * 4)
    data.set([64, 0, 191, 255], (y * width + 1) * 4)
    data.set([0, 0, 255, 255], (y * width + 2) * 4)
  }
  const scale = 8
  const { image, blended } = resolveAntialiasing({ width, height, data }, scale)
  assert.equal(blended, 3)
  let red = 0
  for (let j = 0; j < scale; j++) for (let i = 0; i < scale; i++) {
    const k = ((scale + j) * image.width + scale + i) * 4
    const pixel = [...image.data.subarray(k, k + 4)].join()
    assert.ok(pixel === '255,0,0,255' || pixel === '0,0,255,255', `only flat colours, got ${pixel}`)
    if (pixel === '255,0,0,255') {
      red++
      assert.ok(i < scale / 2, 'red sub-pixels sit on the red side')
    }
  }
  assert.equal(red, 16, '25 % of the 64 sub-pixels')
  // Low-contrast or unexplained pixels keep their own colour.
  const flat = resolveAntialiasing({ width: 1, height: 1, data: new Uint8ClampedArray([10, 20, 30, 255]) }, 2)
  assert.equal(flat.blended, 0)
  assert.deepEqual([...flat.image.data], [10, 20, 30, 255, 10, 20, 30, 255, 10, 20, 30, 255, 10, 20, 30, 255])
})

test('Auto traces native pixel art exactly', async () => {
  for (const file of ['pixel-art/tiny-wizard', 'pixel-art/shield']) {
    const r = await vectorize(await decode(file), settings, backend)
    // The exact grid is compared; it, or an enlarged trace just as exact and lighter, wins.
    assert.ok(r.trials.some((trial) => trial.traceMethod === 'pixel-grid'), file)
    const chosen = r.trials[r.chosen]
    assert.equal(chosen.metrics.pctDiff, 0, file)
    assert.equal(chosen.metrics.alphaDiff, 0, file)
    assert.ok((chosen.metrics.rgbWhite + chosen.metrics.rgbDark) / 2 < 0.5, file)
  }
})

test('Auto keeps small anti-aliased icons light and faithful', async () => {
  // Before: an enlarged copy of every pixel, 1128 paths and 72 KB.
  const bear = await vectorize(await decode('grouping-corpus/kenney-bear'), settings, backend)
  const chosen = bear.trials[bear.chosen]
  assert.equal(chosen.traceMethod, 'antialias-resolved')
  assert.ok(chosen.metrics.paths <= 200, `${chosen.metrics.paths} paths`)
  assert.ok(chosen.metrics.bytes <= 40 * 1024, `${chosen.metrics.bytes} bytes`)
  assert.ok(chosen.metrics.pctDiff < 1, `${chosen.metrics.pctDiff} % visibly different`)
  assert.match(chosen.svg, /^<svg\b[^>]*width="154" height="132"/)
  // Before: 8548 paths and 532 KB for a 121 x 120 painted icon.
  const spell = await vectorize(await decode('grouping-corpus/spell'), settings, backend)
  const spellChosen = spell.trials[spell.chosen]
  assert.ok(spellChosen.metrics.bytes < 300 * 1024, `${spellChosen.metrics.bytes} bytes`)
  assert.ok(spellChosen.metrics.pctDiff < 1, `${spellChosen.metrics.pctDiff} % visibly different`)
})
