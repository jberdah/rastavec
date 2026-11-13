// Auto on artwork under JPEG artifacts or noise: a cleaned copy is traced, so the result stays
// close to what the clean image gives instead of one path per ripple, and it is measured against
// the image as given. Clean images, textures and images with transparency are left as they are.
// Analysis only detects (cheap); the clean-up runs inside Auto, can be cancelled, keeps nothing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import init, { vectorize_rgba, vectorize_rgba_structured } from '../src/lib/engine/vtracer-next-wasm/vtracer_next.js'

const require = createRequire(new URL('../cli/package.json', import.meta.url))
const sharp = require('sharp')
const code = require('esbuild').buildSync({
  stdin: {
    contents: `export { vectorize, VectorizationCancelled } from './src/lib/engine/vectorize'
export { analyze, cleanSource, photographic, recommend } from './src/lib/engine/analyze'
export { marginal } from './src/lib/engine/degradation'
export { choose, computeMetrics } from './src/lib/engine/core'
export { measureDegradation, restoreArtwork } from './src/lib/engine/degradation'
export { DEFAULT_PARAMS } from './src/lib/engine/presets'
export { withVTracerNext, nextOptions } from './src/lib/engine/vtracer-next-trace'
export { parsePaths } from './src/lib/engine/trace-options'`,
    resolveDir: process.cwd(),
  },
  bundle: true, write: false, platform: 'node', format: 'esm',
}).outputFiles[0].text
const { vectorize, VectorizationCancelled, analyze, cleanSource, photographic, marginal, recommend, choose, computeMetrics, measureDegradation, restoreArtwork, DEFAULT_PARAMS, withVTracerNext, nextOptions, parsePaths } =
  await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
await init({ module_or_path: await readFile(new URL('../src/lib/engine/vtracer-next-wasm/vtracer_next_bg.wasm', import.meta.url)) })
// The product's own engine options (shape detection included) and both trace modes, as in the CLI.
const convert = async (image, params, binary, gradients) => {
  const rgba = new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength)
  const options = nextOptions(params, binary, gradients)
  if (binary) return vectorize_rgba(rgba, image.width, image.height, options)
  const [svg, report] = vectorize_rgba_structured(rgba, image.width, image.height, options)
  return { svg, report }
}
const backend = withVTracerNext(
  { async rasterize(svg, width, height) { return { width, height, data: new Uint8ClampedArray(await sharp(Buffer.from(svg)).resize(width, height).ensureAlpha().raw().toBuffer()) } } },
  false,
  convert,
  async (image, params, binary) => {
    const result = await convert(image, params, binary, false)
    return parsePaths(typeof result === 'string' ? result : result.svg, params.compactPaths, params.pathPrecision)
  },
)
/** What Auto does to a degraded image before tracing it; null when it leaves the image alone. */
const cleanedSource = async (img) => { const found = analyze(img).degradation; return found ? cleanSource(img, found) : null }
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
    assert.equal(analyze(img).degradation, null)
    assert.equal(await cleanedSource(img), null)
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
    assert.ok(analyze(img).degradation, `q${quality} ${chroma} not detected`)
    const a = (await cleanedSource(img)).analysis
    assert.ok(a.cleanup)
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
    // Analysis describes the file as given: grain everywhere reads as a photo until Auto cleans it.
    assert.equal(analyze(img).kind, 'photo')
    const cleaned = await cleanedSource(img)
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
    const cleaned = await cleanedSource(img)
    assert.ok(rmse(cleaned.image, clean) < rmse(img, clean), `q${quality}`)
    assert.ok(visibleDiff(cleaned.image, clean) <= visibleDiff(img, clean) + 0.05, `q${quality}: ${visibleDiff(cleaned.image, clean)} vs ${visibleDiff(img, clean)}`)
  }
})

test('a noisy gradient stays a gradient: no bands, no flattening', async () => {
  const clean = await render(GRADIENT)
  const cleaned = await cleanedSource(noisy(clean, 4))
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
  assert.equal(await cleanedSource(texture), null)
  assert.equal(analyze(texture).kind, 'photo')
  // Transparency: lossy formats that matter here have none.
  const cutout = noisy(await render(LOGO), 5)
  cutout.data[3] = 0
  assert.equal(measureDegradation(cutout), null)
  assert.equal(analyze(cutout).degradation, null)
})

test('restoring leaves flat areas far from edges untouched', async () => {
  const img = await jpeg(LOGO, 75)
  const restored = await restoreArtwork(img, measureDegradation(img))
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
  // The clean logo is 5 paths. Before the clean-up the JPEGs gave 315 and 429; quality 40 still
  // leaves specks along the edges.
  for (const [name, img, maxPaths, maxBytes] of [['jpeg q75', await jpeg(LOGO, 75), 20, 3072], ['jpeg q40', await jpeg(LOGO, 40), 80, 16384], ['noise 5', noisy(clean, 5), 10, 2048]]) {
    const result = await vectorize(img, settings, backend)
    const trial = result.trials[result.chosen]
    assert.ok(result.analysis.cleanup, name)
    assert.ok(result.notes.includes('cleaned'), name)
    assert.equal(result.analysis.kind, 'flat', name)
    assert.ok(trial.metrics.paths <= maxPaths, `${name}: ${trial.metrics.paths} paths, clean ${best.metrics.paths}`)
    assert.ok(trial.metrics.bytes <= maxBytes, `${name}: ${trial.metrics.bytes} bytes, clean ${best.metrics.bytes}`)
    // Reported differences are against the image as given, not against the cleaned copy.
    const rendered = await backend.rasterize(trial.svg, clean.width, clean.height)
    assert.equal(trial.metrics.pctDiff, computeMetrics(img, rendered, trial.svg).pctDiff, name)
    // Against the clean image, the trace of the degraded one is about as close as the degraded image itself.
    assert.ok(visibleDiff(rendered, clean) <= visibleDiff(img, clean) + 1.5, `${name}: ${visibleDiff(rendered, clean)}% vs input ${visibleDiff(img, clean)}%`)
  }
})

test('a chosen preset traces the image as given and keeps its analysis', async () => {
  const img = await jpeg(LOGO, 75)
  const given = analyze(img)
  const result = await vectorize(img, { ...settings, presetId: 'flat' }, backend, { analysis: given })
  assert.equal(result.notes, undefined)
  assert.equal(result.analysis.cleanup, undefined)
  assert.equal(result.analysis.kind, given.kind)
  assert.equal(result.analysis.dominantColors, given.dominantColors)
  // Detection is still reported.
  assert.ok(result.analysis.degradation)
})

test('analysis detects without cleaning, and stays cheap on a large image', async () => {
  // 12 megapixels of noisy flat shapes.
  const width = 4000, height = 3000
  const big = { width, height, data: new Uint8ClampedArray(width * height * 4) }
  let s = 99
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    const v = ((x >> 8) + (y >> 8)) & 1 ? 200 : 60
    big.data[i] = v + (s & 15) - 8; big.data[i + 1] = v + ((s >> 4) & 15) - 8; big.data[i + 2] = v + ((s >> 8) & 15) - 8; big.data[i + 3] = 255
  }
  analyze({ width: 64, height: 64, data: new Uint8ClampedArray(64 * 64 * 4).fill(255) })
  const started = performance.now()
  const a = analyze(big)
  const elapsed = performance.now() - started
  assert.ok(a.degradation, 'not detected')
  assert.equal(a.cleanup, undefined)
  // About 0.3 s on a quiet machine; the clean-up itself takes over ten.
  assert.ok(elapsed < 5000, `analysis took ${Math.round(elapsed)} ms`)
})

test('the clean-up can be cancelled while it runs, and Auto stops with it', async () => {
  const img = noisy(await render(LOGO), 5)
  let pauses = 0
  await assert.rejects(restoreArtwork(img, measureDegradation(img), async () => { if (++pauses === 3) throw new Error('stop') }), /stop/)
  let asked = 0
  await assert.rejects(vectorize(img, settings, backend, { shouldCancel: () => ++asked > 2 }), VectorizationCancelled)
})

test('a result that lost the drawing is never chosen over one that kept it', () => {
  const metrics = (extra) => ({ width: 100, height: 100, iou: 1, alphaDiff: 0, rgbWhite: 3, rgbDark: 3, pctDiff: 6.5, bytes: 20000, paths: 150, embeddedRaster: false, ...extra })
  const real = { metrics: metrics({ inkKept: 0.48 }), score: 41.9 }
  const empty = { metrics: metrics({ pctDiff: 6.8, bytes: 182, paths: 0, inkKept: 0 }), score: 40.8 }
  const faint = { metrics: metrics({ bytes: 6700, paths: 80, inkKept: 0.07 }), score: 40.9 }
  assert.equal(choose([empty, faint, real], 0, { preferSimplicity: true }), 2)
  // Nothing kept anything: the usual rules apply.
  assert.equal(choose([empty, { ...empty, score: 50 }], 0), 0)
  // Results without the measure (older sessions) are not penalised.
  assert.equal(choose([{ metrics: metrics({}), score: 30 }, real], 0), 0)
  // A result that draws too much does not set the bar: the faithful one stays in.
  const bloated = { metrics: metrics({ inkKept: 2.2 }), score: 45 }
  assert.equal(choose([bloated, { metrics: metrics({ inkKept: 0.95 }), score: 30 }], 0), 1)
})

test('a JPEG photograph is traced as it is', async () => {
  // A smooth, many-coloured scene with a horizon and a few hard shapes, saved as JPEG.
  const width = 480, height = 320
  const scene = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 3
    const sky = y < 170 + 12 * Math.sin(x / 40)
    const sun = (x - 350) ** 2 + (y - 70) ** 2 < 900
    scene[i] = sun ? 250 : sky ? 90 + y * 0.6 + 30 * Math.sin(x / 90) : 60 + (y - 170) * 0.5 + 25 * Math.sin(x / 23 + y / 31)
    scene[i + 1] = sun ? 235 : sky ? 130 + y * 0.4 : 110 + (y - 170) * 0.3 + 30 * Math.sin(x / 37)
    scene[i + 2] = sun ? 170 : sky ? 210 - y * 0.2 + 20 * Math.cos(x / 70) : 50 + 20 * Math.sin(y / 17 + x / 53)
  }
  const img = await raw(await sharp(scene, { raw: { width, height, channels: 3 } }).jpeg({ quality: 75 }).toBuffer())
  const a = analyze(img)
  assert.ok(a.degradation, 'artifacts not detected')
  assert.ok(photographic(a), `${a.kind}, ${a.dominantColors} colours, ramps ${a.smoothRamps}`)
  const result = await vectorize(img, settings, backend, { analysis: a })
  assert.equal(result.analysis.cleanup, undefined)
  assert.ok(!result.notes.includes('cleaned') && !result.notes.includes('uncleaned'), result.notes.join())
  // Artwork is not photographic, whatever JPEG did to it: a logo, a gradient.
  assert.ok(!photographic(analyze(await jpeg(LOGO, 40))))
  assert.ok(!photographic(analyze(await jpeg(GRADIENT, 75))))
})

test('thin evidence of artifacts is told from a JPEG, a block grid or noise', () => {
  const found = (extra) => ({ ringing: 0.5, grain: 0.004, blocks: 1, sigma: 0, reach: 0.1, ...extra })
  // A clean logo with a little ringing of its own measured 0.38; a JPEG of quality 95 0.40.
  assert.ok(marginal(found({ ringing: 0.38 })))
  assert.ok(!marginal(found({ ringing: 0.5 })))
  assert.ok(!marginal(found({ ringing: 0.3, blocks: 1.5 })))
  assert.ok(!marginal(found({ ringing: 0.4, grain: 0.15, sigma: 2 })))
})
