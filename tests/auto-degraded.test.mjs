// Auto on artwork under JPEG artifacts or noise: the image is cleaned before tracing, so the
// result stays close to what the clean image gives instead of one path per ripple. Clean
// images, textures and images with transparency are left as they are.
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
export { analyze, cleanedSource, recommend } from './src/lib/engine/analyze'
export { measureDegradation, restoreArtwork } from './src/lib/engine/degradation'
export { DEFAULT_PARAMS } from './src/lib/engine/presets'
export { withVTracerNext } from './src/lib/engine/vtracer-next-trace'
export { optionsFor } from './src/lib/engine/trace-options'`,
    resolveDir: process.cwd(),
  },
  bundle: true, write: false, platform: 'node', format: 'esm',
}).outputFiles[0].text
const { vectorize, analyze, cleanedSource, recommend, measureDegradation, restoreArtwork, DEFAULT_PARAMS, withVTracerNext, optionsFor } =
  await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
await init({ module_or_path: await readFile(new URL('../src/lib/engine/vtracer-next-wasm/vtracer_next_bg.wasm', import.meta.url)) })
const backend = withVTracerNext(
  { async rasterize(svg, width, height) { return { width, height, data: new Uint8ClampedArray(await sharp(Buffer.from(svg)).resize(width, height).ensureAlpha().raw().toBuffer()) } } },
  false,
  async (src, p, b, g) => vectorize_rgba(new Uint8Array(src.data), src.width, src.height, { ...optionsFor(p, b), experimentalGradients: g }),
  () => { throw Error('unexpected binary') },
)
const settings = { presetId: 'auto', params: DEFAULT_PARAMS, auto: { enabled: true, threshold: 3, maxKB: 0 } }

const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="320" height="240" fill="#f4f1ea"/>
  <circle cx="110" cy="120" r="78" fill="#1f6fd1"/><rect x="150" y="60" width="130" height="120" rx="18" fill="#f2912d"/>
  <path d="M60 200 L160 40 L260 200 Z" fill="#6a4fb3"/><circle cx="160" cy="150" r="22" fill="#ffffff"/></svg>`
const GRADIENT = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240">
  <defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="#2a4d8f"/><stop offset="1" stop-color="#e9b48e"/></linearGradient></defs>
  <rect width="320" height="240" fill="url(#g)"/></svg>`

const image = ({ data, info }) => ({ width: info.width, height: info.height, data: new Uint8ClampedArray(data) })
const raw = (input) => sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true }).then(image)
const render = (svg) => raw(Buffer.from(svg))
const jpeg = async (svg, quality, chromaSubsampling = '4:2:0') => raw(await sharp(Buffer.from(svg)).jpeg({ quality, chromaSubsampling }).toBuffer())
/** Additive Gaussian noise per channel, from a fixed seed. */
function noisy(img, sigma, seed = 20261113) {
  let s = seed >>> 0
  const uniform = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) + 0.5) / 4294967296
  const out = { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) }
  for (let i = 0; i < out.data.length; i++) {
    if ((i & 3) === 3) continue
    out.data[i] = img.data[i] + sigma * Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform())
  }
  return out
}
function rmse(a, b) {
  let sum = 0
  for (let i = 0; i < a.data.length; i += 4) for (let c = 0; c < 3; c++) sum += (a.data[i + c] - b.data[i + c]) ** 2
  return Math.sqrt(sum / (a.width * a.height * 3))
}
/** Share (%) of pixels further than 32 levels from the reference in some channel. */
function visibleDiff(a, b) {
  let n = 0
  for (let i = 0; i < a.data.length; i += 4) if (Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2])) > 32) n++
  return (100 * n) / (a.width * a.height)
}

test('clean artwork is not taken for degraded', async () => {
  for (const svg of [LOGO, GRADIENT]) {
    const img = await render(svg)
    assert.equal(measureDegradation(img), null)
    assert.equal(cleanedSource(img), null)
    assert.equal(analyze(img).cleanup, undefined)
  }
  // Resampling (ringing of its own, softer edges) is not degradation either.
  const half = await raw(await sharp(Buffer.from(LOGO)).resize(160).png().toBuffer())
  assert.equal(measureDegradation(half), null)
})

test('JPEG artifacts are detected at any usual quality and the logo reads as flat again', async () => {
  const clean = analyze(await render(LOGO))
  assert.equal(clean.kind, 'flat')
  for (const [quality, chroma] of [[40, '4:2:0'], [75, '4:2:0'], [75, '4:4:4'], [92, '4:2:0']]) {
    const img = await jpeg(LOGO, quality, chroma)
    const a = analyze(img)
    assert.ok(a.cleanup, `q${quality} ${chroma} not detected`)
    assert.equal(a.kind, 'flat', `q${quality} ${chroma}`)
    // Quality 40 leaves a few more shades along edges.
    assert.ok(a.dominantColors <= clean.dominantColors + (quality < 60 ? 4 : 1), `q${quality} ${chroma}: ${a.dominantColors} colours`)
    assert.deepEqual(recommend(a).notes.at(-1), 'cleaned')
  }
})

test('noise is detected and removed; the logo reads as flat, not as a photo', async () => {
  const clean = await render(LOGO)
  for (const sigma of [2, 5, 10]) {
    const img = noisy(clean, sigma)
    const cleaned = cleanedSource(img)
    assert.ok(cleaned, `sigma ${sigma} not detected`)
    assert.ok(Math.abs(cleaned.analysis.cleanup.sigma - sigma) < sigma * 0.35, `sigma ${sigma} estimated ${cleaned.analysis.cleanup.sigma}`)
    assert.equal(cleaned.analysis.kind, 'flat')
    assert.equal(cleaned.analysis.dominantColors, analyze(clean).dominantColors)
    assert.ok(rmse(cleaned.image, clean) < rmse(img, clean) * 0.6, `sigma ${sigma}: ${rmse(cleaned.image, clean)} vs ${rmse(img, clean)}`)
  }
})

test('cleaning brings a JPEG closer to the clean image and keeps its edges', async () => {
  const clean = await render(LOGO)
  for (const quality of [40, 75]) {
    const img = await jpeg(LOGO, quality)
    const cleaned = cleanedSource(img)
    assert.ok(rmse(cleaned.image, clean) < rmse(img, clean), `q${quality}`)
    assert.ok(visibleDiff(cleaned.image, clean) <= visibleDiff(img, clean) + 0.05, `q${quality}: ${visibleDiff(cleaned.image, clean)} vs ${visibleDiff(img, clean)}`)
  }
})

test('a noisy gradient stays a gradient: no bands, no flattening', async () => {
  const clean = await render(GRADIENT)
  const cleaned = cleanedSource(noisy(clean, 4))
  assert.ok(cleaned)
  assert.notEqual(cleaned.analysis.kind, 'photo')
  assert.ok(cleaned.analysis.smoothRamps > 0.8, `ramps ${cleaned.analysis.smoothRamps}`)
  assert.ok(rmse(cleaned.image, clean) < 1.5, `rmse ${rmse(cleaned.image, clean)}`)
  let worst = 0
  const d = cleaned.image.data
  for (let y = 0; y < 240; y++) for (let x = 1; x < 320; x++) {
    const i = (y * 320 + x) * 4
    worst = Math.max(worst, Math.abs(d[i] - d[i - 4]), Math.abs(d[i + 1] - d[i - 3]), Math.abs(d[i + 2] - d[i - 2]))
  }
  assert.ok(worst <= 6, `largest step ${worst}`)
})

test('textures, photos and images with transparency are left alone', async () => {
  // A texture: strong, structured variation everywhere.
  const width = 256, height = 192
  const texture = { width, height, data: new Uint8ClampedArray(width * height * 4) }
  let s = 7
  const rand = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4
    const v = 128 + 60 * Math.sin(x / 3.1) * Math.cos(y / 2.3) + 50 * Math.sin((x + 2 * y) / 7.7) + 90 * (rand() - 0.5)
    texture.data[i] = v; texture.data[i + 1] = v * 0.8 + 30 * rand(); texture.data[i + 2] = 255 - v; texture.data[i + 3] = 255
  }
  assert.equal(cleanedSource(texture), null)
  assert.equal(analyze(texture).kind, 'photo')
  // Transparency: lossy formats that matter here have none.
  const cutout = noisy(await render(LOGO), 5)
  cutout.data[3] = 0
  assert.equal(measureDegradation(cutout), null)
  assert.equal(cleanedSource(cutout), null)
})

test('restoring leaves flat areas far from edges untouched', async () => {
  const img = await jpeg(LOGO, 75)
  const restored = restoreArtwork(img, measureDegradation(img))
  // The top-left corner is plain background, far from any shape.
  for (let y = 0; y < 12; y++) for (let x = 0; x < 12; x++) {
    const i = (y * img.width + x) * 4
    assert.deepEqual([...restored.data.subarray(i, i + 4)], [...img.data.subarray(i, i + 4)])
  }
})

test('Auto on a JPEG or noisy logo gives about what the clean logo gives', async () => {
  const clean = await render(LOGO)
  const reference = await vectorize(clean, settings, backend)
  const best = reference.trials[reference.chosen]
  assert.equal(reference.analysis.cleanup, undefined)
  // Paths allowed relative to the clean trace: low quality leaves a few specks.
  for (const [name, img, factor] of [['jpeg q75', await jpeg(LOGO, 75), 2], ['jpeg q40', await jpeg(LOGO, 40), 5], ['noise 5', noisy(clean, 5), 2]]) {
    const result = await vectorize(img, settings, backend)
    const trial = result.trials[result.chosen]
    assert.ok(result.analysis.cleanup, name)
    assert.ok(result.notes.includes('cleaned'), name)
    assert.equal(result.analysis.kind, 'flat', name)
    assert.ok(trial.metrics.paths <= best.metrics.paths * factor + 4, `${name}: ${trial.metrics.paths} paths, clean ${best.metrics.paths}`)
    assert.ok(trial.metrics.bytes <= best.metrics.bytes * factor + 1024, `${name}: ${trial.metrics.bytes} bytes, clean ${best.metrics.bytes}`)
    // Against the clean image, the trace of the degraded one is about as close as the degraded image itself.
    const rendered = await backend.rasterize(trial.svg, clean.width, clean.height)
    assert.ok(visibleDiff(rendered, clean) <= visibleDiff(img, clean) + 1.5, `${name}: ${visibleDiff(rendered, clean)}% vs input ${visibleDiff(img, clean)}%`)
  }
})

test('a chosen preset traces the image as given', async () => {
  const img = await jpeg(LOGO, 75)
  const result = await vectorize(img, { ...settings, presetId: 'flat' }, backend)
  assert.equal(result.notes, undefined)
  // Scored against the JPEG itself: same size, and its analysis may still say what Auto would do.
  assert.equal(result.trials[0].metrics.width, img.width)
})
