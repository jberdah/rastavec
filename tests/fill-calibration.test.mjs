import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'

test('quality score accounts for average color error as well as visible outliers and size', async () => {
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
  try {
    const { score } = await server.ssrLoadModule('/src/lib/engine/core.ts')
    assert.equal(score({ pctDiff: 0.5, rgbWhite: 2, rgbDark: 4, bytes: 1024 }), 0.532)
  } finally {
    await server.close()
  }
})

test('solid-fill calibration only makes small, well-supported corrections', async () => {
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
  try {
    const { calibrateSolidFills } = await server.ssrLoadModule('/src/lib/engine/fill-calibration.ts')
    const makeImages = (count, sourceColor = [103, 102, 101], alpha = 255) => {
      const data = new Uint8ClampedArray(count * 4)
      const rendered = new Uint8ClampedArray(count * 4)
      for (let i = 0; i < count; i++) {
        data.set([...sourceColor, alpha], i * 4)
        rendered.set([100, 100, 100, 255], i * 4)
      }
      return { source: { width: count, height: 1, data }, rendered: { width: count, height: 1, data: rendered } }
    }

    const svg = '<svg><path fill="#646464"/><path fill="#646464"/><path fill="#abc"/></svg>'
    const { source, rendered } = makeImages(25)
    const corrected = calibrateSolidFills(svg, source, rendered)
    assert.equal(corrected.changedFills, 1)
    assert.equal(corrected.svg, '<svg><path fill="#676665"/><path fill="#676665"/><path fill="#abc"/></svg>')

    const tooFewSamples = makeImages(19)
    assert.deepEqual(calibrateSolidFills(svg, tooFewSamples.source, tooFewSamples.rendered), { svg, changedFills: 0 })

    const spread = makeImages(25)
    for (let i = 13; i < 25; i++) spread.source.data.set([120, 120, 120, 255], i * 4)
    assert.deepEqual(calibrateSolidFills(svg, spread.source, spread.rendered), { svg, changedFills: 0 })

    const tooLarge = makeImages(25, [120, 120, 120])
    assert.deepEqual(calibrateSolidFills(svg, tooLarge.source, tooLarge.rendered), { svg, changedFills: 0 })

    const partlyTransparent = makeImages(25, [103, 102, 101], 249)
    assert.deepEqual(calibrateSolidFills(svg, partlyTransparent.source, partlyTransparent.rendered), { svg, changedFills: 0 })
  } finally {
    await server.close()
  }
})

test('source-palette refinement maps nearby fills to frequent opaque raster colors', async () => {
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
  try {
    const { snapSolidFillsToSourcePalette } = await server.ssrLoadModule('/src/lib/engine/fill-calibration.ts')
    const data = new Uint8ClampedArray(100 * 4)
    for (let i = 0; i < 60; i++) data.set([250, 50, 20, 255], i * 4)
    for (let i = 60; i < 100; i++) data.set([20, 60, 240, 255], i * 4)
    const source = { width: 100, height: 1, data }
    const svg = '<svg><path fill="#f83214"/><path fill="#143be4"/><path fill="#abc"/></svg>'
    const result = snapSolidFillsToSourcePalette(svg, source)
    assert.equal(result.changedFills, 2)
    assert.equal(result.svg, '<svg><path fill="#fa3214"/><path fill="#143cf0"/><path fill="#abc"/></svg>')

    const transparent = { width: 1, height: 1, data: new Uint8ClampedArray([0, 0, 0, 0]) }
    assert.deepEqual(snapSolidFillsToSourcePalette(svg, transparent), { svg, changedFills: 0 })

    const rareColorData = new Uint8ClampedArray(1000 * 4)
    for (let i = 0; i < 985; i++) rareColorData.set([40, 45, 50, 255], i * 4)
    for (let i = 985; i < 1000; i++) rareColorData.set([0, 255, 0, 255], i * 4)
    const rareColorSvg = '<svg><path fill="#00f000"/></svg>'
    assert.deepEqual(
      snapSolidFillsToSourcePalette(rareColorSvg, { width: 1000, height: 1, data: rareColorData }),
      { svg: rareColorSvg, changedFills: 0 },
      'rare source colors do not become palette targets',
    )
  } finally {
    await server.close()
  }
})

test('Auto selects color calibration only when it improves fidelity without changing shape', async () => {
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
  try {
    const { vectorize } = await server.ssrLoadModule('/src/lib/engine/vectorize.ts')
    const { DEFAULT_PARAMS } = await server.ssrLoadModule('/src/lib/engine/presets.ts')
    const width = 10, height = 10
    const srcData = new Uint8ClampedArray(width * height * 4)
    for (let i = 0; i < srcData.length; i += 4) srcData.set([103, 102, 101, 255], i)
    const src = { width, height, data: srcData }
    const analysis = { width, height, kind: 'flat', alpha: 'opaque', softPct: 0, transparentPct: 0, dominantColors: 1, gradient: 0, grayscale: false }
    const backend = {
      name: 'fill-calibration-test',
      async trace() { return '<svg><path fill="#646464" d="M0 0h10v10z"/></svg>' },
      async rasterize(svg, w, h) {
        const match = svg.match(/fill="#([0-9a-f]{6})"/i)
        assert.ok(match, 'test output keeps one explicit solid fill')
        const color = Number.parseInt(match[1], 16)
        const data = new Uint8ClampedArray(w * h * 4)
        for (let i = 0; i < data.length; i += 4) data.set([(color >> 16) & 255, (color >> 8) & 255, color & 255, 255], i)
        return { width: w, height: h, data }
      },
    }
    const settings = { presetId: 'auto', params: DEFAULT_PARAMS, auto: { enabled: true, threshold: 3, maxKB: 400 } }
    const result = await vectorize(src, settings, backend, { analysis })
    const calibrated = result.trials[result.chosen]
    assert.equal(calibrated.traceMethod, 'fill-calibrated')
    assert.equal(calibrated.metrics.pctDiff, result.trials[0].metrics.pctDiff)
    assert.equal(calibrated.metrics.iou, result.trials[0].metrics.iou)
    assert.equal(calibrated.metrics.alphaDiff, result.trials[0].metrics.alphaDiff)
    assert.ok(calibrated.metrics.rgbWhite + calibrated.metrics.rgbDark < result.trials[0].metrics.rgbWhite + result.trials[0].metrics.rgbDark)
    assert.ok(calibrated.score <= result.trials[0].score)
    assert.match(calibrated.svg, /fill="#676665"/)

    const pixel = await vectorize(src, settings, backend, { analysis: { ...analysis, kind: 'pixel' } })
    assert.ok(!pixel.trials.some((trial) => trial.traceMethod === 'fill-calibrated'), 'pixel mode keeps its original exact palette')
  } finally {
    await server.close()
  }
})

test('Auto retains source-palette refinement only when both color and visible error improve', async () => {
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
  try {
    const { vectorize } = await server.ssrLoadModule('/src/lib/engine/vectorize.ts')
    const { DEFAULT_PARAMS } = await server.ssrLoadModule('/src/lib/engine/presets.ts')
    const width = 10, height = 10
    const analysis = { width, height, kind: 'flat', alpha: 'edges', softPct: 0, transparentPct: 20, dominantColors: 2, gradient: 0, grayscale: false }
    const settings = { presetId: 'auto', params: DEFAULT_PARAMS, auto: { enabled: true, threshold: 3, maxKB: 400 } }
    const makeBackend = (transparentRight = false, outputColor = [100, 100, 100]) => ({
      name: 'palette-calibration-test',
      async trace() {
        const hex = outputColor.map((v) => v.toString(16).padStart(2, '0')).join('')
        return `<svg><path fill="#${hex}" d="M0 0h10v10z"/></svg>`
      },
      async rasterize(svg, w, h) {
        const match = svg.match(/fill="#([0-9a-f]{6})"/i)
        assert.ok(match, 'test output keeps one explicit solid fill')
        const color = Number.parseInt(match[1], 16)
        const fill = [(color >> 16) & 255, (color >> 8) & 255, color & 255]
        const data = new Uint8ClampedArray(w * h * 4)
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const index = (y * w + x) * 4
          if (transparentRight && x >= 8) continue
          data.set([...fill, 255], index)
        }
        return { width: w, height: h, data }
      },
    })

    const safeData = new Uint8ClampedArray(width * height * 4)
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4
      if (x < 8) {
        safeData.set([110, 106, 102, 255], index)
      } else {
        safeData.set([0, 0, 0, 0], index)
      }
    }
    const safeSource = { width, height, data: safeData }
    const safe = await vectorize(safeSource, settings, makeBackend(true), { analysis })
    const paletteTrial = safe.trials[safe.chosen]
    assert.equal(paletteTrial.traceMethod, 'palette-calibrated')
    assert.equal(paletteTrial.metrics.pctDiff, safe.trials[0].metrics.pctDiff)
    assert.equal(paletteTrial.metrics.iou, safe.trials[0].metrics.iou)
    assert.equal(paletteTrial.metrics.alphaDiff, safe.trials[0].metrics.alphaDiff)
    assert.ok(paletteTrial.metrics.rgbWhite + paletteTrial.metrics.rgbDark < safe.trials[0].metrics.rgbWhite + safe.trials[0].metrics.rgbDark)

    const unsafeData = new Uint8ClampedArray(width * height * 4)
    for (let i = 0; i < width * height; i++) {
      const color = i < 80 ? [100, 100, 100] : [140, 100, 100]
      unsafeData.set([...color, 255], i * 4)
    }
    const unsafeSource = { width, height, data: unsafeData }
    const unsafe = await vectorize(unsafeSource, settings, makeBackend(false, [116, 100, 100]), { analysis })
    assert.notEqual(unsafe.trials[unsafe.chosen].traceMethod, 'palette-calibrated')
    assert.ok(!unsafe.trials.some((trial) => trial.traceMethod === 'palette-calibrated'))
  } finally {
    await server.close()
  }
})
