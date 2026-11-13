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
export { analyzeAntialiasing, resolveAntialiasing } from './src/lib/engine/antialias-resolve'
export { DEFAULT_PARAMS } from './src/lib/engine/presets'
export { withVTracerNext } from './src/lib/engine/vtracer-next-trace'
export { optionsFor } from './src/lib/engine/trace-options'`,
    resolveDir: process.cwd(),
  },
  bundle: true, write: false, platform: 'node', format: 'esm',
}).outputFiles[0].text
const { vectorize, analyze, pixelBlockSize, analyzeAntialiasing, resolveAntialiasing, DEFAULT_PARAMS, withVTracerNext, optionsFor } =
  await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
await init({ module_or_path: await readFile(new URL('../src/lib/engine/vtracer-next-wasm/vtracer_next_bg.wasm', import.meta.url)) })
const backend = withVTracerNext(
  { async rasterize(svg, width, height) { return { width, height, data: new Uint8ClampedArray(await sharp(Buffer.from(svg)).resize(width, height).ensureAlpha().raw().toBuffer()) } } },
  false,
  async (src, p, b, g) => vectorize_rgba(new Uint8Array(src.data), src.width, src.height, { ...optionsFor(p, b), experimentalGradients: g }),
  () => { throw Error('unexpected binary') },
)
const settings = { presetId: 'auto', params: DEFAULT_PARAMS, auto: { enabled: true, threshold: 3, maxKB: 0 } }
async function rasterSvg(svg, threshold = false) {
  const { data, info } = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  if (threshold) for (let i = 3; i < data.length; i += 4) data[i] = data[i] >= 128 ? 255 : 0
  return { width: info.width, height: info.height, data: new Uint8ClampedArray(data) }
}
const colourCount = (img) => { const s = new Set(); for (let i = 0; i < img.data.length; i += 4) if (img.data[i + 3]) s.add(img.data.slice(i, i + 4).join()); return s.size }
const EMOJI = '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><circle cx="24" cy="24" r="21" fill="#fdd835" stroke="#6d4c41" stroke-width="3"/><circle cx="16" cy="19" r="3" fill="#4e342e"/><circle cx="32" cy="19" r="3" fill="#4e342e"/><path d="M13 28 q11 11 22 0" stroke="#4e342e" stroke-width="3" fill="none"/></svg>'
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
  // Alpha thresholded to 0/255 hides anti-aliasing at the silhouette, not between the inner
  // colours; an opaque anti-aliased icon has no alpha at all. Neither is pixel art.
  assert.notEqual(analyze(await rasterSvg(EMOJI, true)).kind, 'pixel', 'binary-alpha anti-aliased emoji')
  assert.notEqual(analyze(await rasterSvg(EMOJI.replace('<circle', '<rect width="48" height="48" fill="#fff"/><circle'))).kind, 'pixel', 'opaque anti-aliased emoji')
  // A sprite enlarged by a whole factor with nearest-neighbour scaling is still pixel art, even
  // padded off the grid.
  const wizard = await decode('pixel-art/tiny-wizard')
  assert.equal(pixelBlockSize(wizard), 1)
  const big = enlarge(wizard, 4)
  assert.equal(pixelBlockSize(big), 4)
  assert.equal(analyze(big).kind, 'pixel')
  const padded = { width: big.width + 1, height: big.height + 1, data: new Uint8ClampedArray((big.width + 1) * (big.height + 1) * 4) }
  for (let y = 0; y < big.height; y++) padded.data.set(big.data.subarray(y * big.width * 4, (y + 1) * big.width * 4), ((y + 1) * padded.width + 1) * 4)
  assert.equal(pixelBlockSize(padded), 4)
  assert.equal(analyze(padded).kind, 'pixel')
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
  const source = { width, height, data }
  assert.equal(analyzeAntialiasing(source).blended, 3)
  const image = resolveAntialiasing(source, scale)
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
  const lone = { width: 1, height: 1, data: new Uint8ClampedArray([10, 20, 30, 255]) }
  assert.equal(analyzeAntialiasing(lone).blended, 0)
  assert.deepEqual([...resolveAntialiasing(lone, 2).data], [10, 20, 30, 255, 10, 20, 30, 255, 10, 20, 30, 255, 10, 20, 30, 255])
  // A half-covered pixel on the image border mixes with the transparency beyond it.
  const border = { width: 2, height: 1, data: new Uint8ClampedArray([200, 0, 0, 128, 200, 0, 0, 255]) }
  assert.equal(analyzeAntialiasing(border).blended, 1)
  const edge = resolveAntialiasing(border, 4)
  let opaque = 0
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
    const alpha = edge.data[(y * 8 + x) * 4 + 3]
    assert.ok(alpha === 0 || alpha === 255)
    if (alpha) { opaque++; assert.ok(x >= 2, 'the opaque half faces the opaque neighbour') }
  }
  assert.equal(opaque, 8)
})

test('the many-shade exact grid is for pixel art only', async () => {
  // A small anti-aliased gradient icon with hundreds of colours, transparent around.
  const icon = await rasterSvg('<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><defs><linearGradient id="g"><stop offset="0" stop-color="#e91e63"/><stop offset="1" stop-color="#3f51b5"/></linearGradient></defs><rect x="6" y="6" width="84" height="84" rx="18" fill="url(#g)"/><circle cx="48" cy="48" r="20" fill="#fff"/></svg>')
  assert.ok(colourCount(icon) > 256)
  assert.notEqual(analyze(icon).kind, 'pixel')
  const r = await vectorize(icon, settings, backend)
  assert.ok(!r.trials.some((trial) => trial.traceMethod === 'pixel-grid'), 'no grid of hundreds of colours on an anti-aliased icon')
})

test('many-colour images keep fine shade steps and skip anti-aliasing resolution', async () => {
  const width = 64, height = 64, data = new Uint8ClampedArray(width * height * 4)
  let seed = 1
  const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set([x * 4, y * 4, (random() * 255) | 0, 255], (y * width + x) * 4)
  const noise = { width, height, data }
  // Noise reads as anti-aliasing mixes almost everywhere; resolving it would only cost time.
  assert.ok(analyzeAntialiasing(noise).blended > 0.3 * width * height)
  const r = await vectorize(noise, settings, backend)
  assert.ok(analyze(noise).dominantColors > 400)
  assert.ok(!r.trials.some((trial) => trial.traceMethod === 'antialias-resolved'))
  const scaled = r.trials.filter((trial) => (trial.traceScale ?? 1) > 1)
  assert.ok(scaled.length > 0)
  for (const trial of scaled) assert.equal(trial.params.layerDifference, 4)
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
