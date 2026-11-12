import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import init, { vectorize_rgba, vectorize_rgba_structured } from '../src/lib/engine/vtracer-next-wasm/vtracer_next.js'

const sharp = createRequire(new URL('../cli/package.json', import.meta.url))('sharp')
const { buildSync } = createRequire(new URL('../cli/package.json', import.meta.url))('esbuild')
const bundled = buildSync({ stdin: { contents: `export { runTrial } from './src/lib/engine/vectorize'; export { DEFAULT_PARAMS } from './src/lib/engine/presets'; export { nextOptions, withVTracerNext } from './src/lib/engine/vtracer-next-trace'`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'node', external: ['sharp'] }).outputFiles[0].text
const { runTrial, DEFAULT_PARAMS, nextOptions, withVTracerNext } = await import(`data:text/javascript;base64,${Buffer.from(bundled).toString('base64')}`)
await init({ module_or_path: await readFile(new URL('../src/lib/engine/vtracer-next-wasm/vtracer_next_bg.wasm', import.meta.url)) })

const base = { async rasterize(svg, width, height) {
  const data = await sharp(Buffer.from(svg)).resize(width, height).ensureAlpha().raw().toBuffer()
  return { width, height, data: new Uint8ClampedArray(data) }
} }
const convert = async (src, params, binary, gradients) => {
  const options = nextOptions(params, binary, gradients)
  if (binary) return vectorize_rgba(new Uint8Array(src.data), src.width, src.height, options)
  const [svg, report] = vectorize_rgba_structured(new Uint8Array(src.data), src.width, src.height, options)
  return { svg, report }
}
const backend = withVTracerNext(base, false, convert, () => { throw Error('unexpected binary route') })

function image(width, height, colour) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(colour(x + 0.5, y + 0.5), (y * width + x) * 4)
  return { width, height, data }
}

test('a color trace reports overlapping discs as exact circles, the hidden one completed', async () => {
  // A blue disc partly covering a red one, on white.
  const discs = image(200, 140, (x, y) => Math.hypot(x - 120, y - 75) <= 42 ? [40, 90, 200, 255] : Math.hypot(x - 75, y - 65) <= 45 ? [220, 60, 50, 255] : [255, 255, 255, 255])
  const trial = await runTrial(discs, { ...DEFAULT_PARAMS }, true, backend)
  const circles = (trial.shapes ?? []).filter((shape) => shape.kind === 'circle')
  assert.equal(circles.length, 2, JSON.stringify(trial.shapes))
  const red = circles.find((circle) => Math.abs(circle.cx - 75) < 1)
  assert.ok(red && Math.abs(red.cy - 65) < 1 && Math.abs(red.r - 45) < 1, 'the partly hidden disc is reported whole')
  // The hint index is the ordinal of the <path> in the SVG.
  const outlines = [...trial.svg.matchAll(/<path\b[^>]*\bd="([^"]*)"/g)].map((match) => match[1])
  for (const circle of circles) assert.equal((outlines[circle.index].match(/[Cc]/g) ?? []).length, 4, outlines[circle.index])
  assert.ok(trial.metrics.pctDiff < 1, `completion keeps the picture: ${trial.metrics.pctDiff}`)
})

test('the gradient route keeps a gentle ramp and reports its gradient paint', async () => {
  // Half a level per pixel: without band preservation the engine flattens it to one colour.
  const ramp = image(400, 80, (x) => [30 + x / 2, 225 - x / 2, 120, 255])
  const flat = await runTrial(ramp, { ...DEFAULT_PARAMS }, true, backend)
  const fitted = await runTrial(ramp, { ...DEFAULT_PARAMS }, false, backend, 1, true)
  assert.equal(fitted.traceMethod, 'experimental-gradients')
  assert.match(fitted.svg, /<linearGradient\b/)
  const gradients = (fitted.shapes ?? []).filter((shape) => shape.gradient)
  assert.ok(gradients.length >= 1, JSON.stringify(fitted.shapes))
  for (const shape of gradients) assert.ok(fitted.svg.includes(`id="${shape.gradient.id}"`))
  assert.ok(fitted.metrics.rgbWhite < flat.metrics.rgbWhite / 3, `fitted ${fitted.metrics.rgbWhite} vs flat ${flat.metrics.rgbWhite}`)
})

test('a tilted ellipse crossed by a bar is reported whole, with its axes and rotation', async () => {
  const [cx, cy, rx, ry, tilt] = [110, 80, 70, 32, 0.4]
  const scene = image(220, 160, (x, y) => {
    if (x > 150 && x < 186 && y > 20 && y < 141) return [30, 40, 60, 255]
    const dx = x - cx, dy = y - cy
    const u = (dx * Math.cos(tilt) + dy * Math.sin(tilt)) / rx, v = (-dx * Math.sin(tilt) + dy * Math.cos(tilt)) / ry
    return u * u + v * v <= 1 ? [240, 150, 40, 255] : [255, 255, 255, 255]
  })
  const trial = await runTrial(scene, { ...DEFAULT_PARAMS }, true, backend)
  const ellipse = (trial.shapes ?? []).find((shape) => shape.kind === 'ellipse')
  assert.ok(ellipse, JSON.stringify(trial.shapes))
  assert.ok(Math.abs(ellipse.cx - cx) < 1 && Math.abs(ellipse.cy - cy) < 1, JSON.stringify(ellipse))
  assert.ok(Math.abs(ellipse.rx - rx) < 1 && Math.abs(ellipse.ry - ry) < 1, JSON.stringify(ellipse))
  const turn = ((ellipse.rotation - tilt * 180 / Math.PI) % 180 + 180) % 180
  assert.ok(turn < 1 || turn > 179, JSON.stringify(ellipse))
  assert.ok(trial.metrics.pctDiff < 1, `completion keeps the picture: ${trial.metrics.pctDiff}`)
})
