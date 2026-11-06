import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import sharp from 'sharp'
import { resolve } from 'node:path'
import { readFile, readdir } from 'node:fs/promises'

test('pixel grid reconstructs RGBA on white and dark and remains palette editable', async () => {
  const bundle = await build({ stdin: { contents: `
    export { tracePixelGrid } from './src/lib/engine/pixel-grid.ts'
    export { computeMetrics } from './src/lib/engine/core.ts'
    export { analyzeShapes, applyFilters, DEFAULT_FILTERS } from './src/lib/engine/palette.ts'
  `, resolveDir: resolve('..') }, bundle: true, write: false, format: 'esm', platform: 'node' })
  const { tracePixelGrid, computeMetrics, analyzeShapes, applyFilters, DEFAULT_FILTERS } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
    const src = { width: 3, height: 2, data: new Uint8ClampedArray([
      255,0,0,255, 255,0,0,255, 0,0,0,0,
      255,0,0,128, 0,255,0,255, 0,0,255,64,
    ]) }
    const svg = tracePixelGrid(src)
    assert.ok(svg)
    assert.doesNotMatch(svg, /<image\b/)
    const data = await sharp(Buffer.from(svg), { density: 72 }).ensureAlpha().raw().toBuffer()
    const metrics = computeMetrics(src, { width: 3, height: 2, data: new Uint8ClampedArray(data) }, svg)
    assert.equal(metrics.pctDiff, 0)
    assert.ok(metrics.alphaDiff < 1)
    const shapes = analyzeShapes(svg)
    const changed = applyFilters(svg, shapes, { ...DEFAULT_FILTERS, hue: 140 })
    assert.notEqual(changed.svg, svg)
    assert.equal(tracePixelGrid({ width: 129, height: 1, data: new Uint8ClampedArray(129 * 4) }), null)
    for (const name of ['sword', 'potion', 'shield']) {
      const source = await readFile(resolve(`../tests/fixtures/pixel-art/${name}.png`))
      const { data: raw, info } = await sharp(source).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
      const image = { width: info.width, height: info.height, data: new Uint8ClampedArray(raw) }
      const traced = tracePixelGrid(image)
      assert.ok(traced, name)
      const rendered = await sharp(Buffer.from(traced), { density: 72 }).ensureAlpha().raw().toBuffer()
      const measured = computeMetrics(image, { width: info.width, height: info.height, data: new Uint8ClampedArray(rendered) }, traced)
      assert.equal(measured.pctDiff, 0, name)
      assert.ok(measured.alphaDiff < 1, name)
      assert.doesNotMatch(traced, /<image\b/i)
    }
})

test('eligible open-source PNGs preserve visible pixels and alpha in pixel-grid output', async () => {
  const bundle = await build({ stdin: { contents: `
    export { tracePixelGrid } from './src/lib/engine/pixel-grid.ts'
    export { computeMetrics } from './src/lib/engine/core.ts'
  `, resolveDir: resolve('..') }, bundle: true, write: false, format: 'esm', platform: 'node' })
  const { tracePixelGrid, computeMetrics } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
  const dir = resolve('../tests/fixtures/grouping-corpus')
  const files = (await readdir(dir)).filter((file) => file.endsWith('.png')).sort()
  assert.equal(files.length, 10, 'the documented corpus must be present')
  let eligible = 0
  for (const file of files) {
    const { data, info } = await sharp(await readFile(resolve(dir, file))).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const source = { width: info.width, height: info.height, data: new Uint8ClampedArray(data) }
    const svg = tracePixelGrid(source)
    if (!svg) continue // Size, colour or shape limits intentionally reject complex images.
    eligible++
    const rendered = await sharp(Buffer.from(svg), { density: 72 }).ensureAlpha().raw().toBuffer()
    const metrics = computeMetrics(source, { width: info.width, height: info.height, data: new Uint8ClampedArray(rendered) }, svg)
    assert.equal(metrics.pctDiff, 0, file)
    assert.ok(metrics.alphaDiff < 1, file)
    assert.doesNotMatch(svg, /<image\b/i, file)
  }
  assert.ok(eligible >= 2, 'the corpus must exercise multiple eligible images')
})
