import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'

// VTracer-Next writes fill-opacity on every path when the source alpha is near-opaque (0.99 is
// common in exported PNG/WebP files). Palette filters used to skip those paths entirely.
const svg = `<svg version="1.1" xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">
<path d="M0 0h100v100h-100z" fill="#ff0000" fill-opacity=".9922"/>
<path d="M10 10h30v30h-30z" fill="#0000ff" fill-opacity=".9882" transform="translate(5,5)"/>
<path d="M60 60h20v20h-20z" fill="#00ff00"/>
</svg>`

test('palette filters recolour translucent paths and keep their opacity', async () => {
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
  try {
    const { analyzeShapes, applyFilters, DEFAULT_FILTERS } = await server.ssrLoadModule('/src/lib/engine/palette.ts')
    const analysis = analyzeShapes(svg)
    assert.equal(analysis.shapes.length, 3)

    const same = applyFilters(svg, analysis, DEFAULT_FILTERS)
    assert.equal(same.total, 3)
    assert.equal(same.colours, 3)

    const mono = applyFilters(svg, analysis, { ...DEFAULT_FILTERS, theme: 'mono' })
    assert.equal(mono.kept, 3)
    assert.doesNotMatch(mono.svg, /#ff0000|#0000ff|#00ff00/)
    assert.match(mono.svg, /fill-opacity="\.9922"/)
    assert.match(mono.svg, /fill-opacity="\.9882" transform="translate\(5,5\)"/)

    const two = applyFilters(svg, analysis, { ...DEFAULT_FILTERS, colours: 2 })
    assert.equal(two.colours, 2)
  } finally {
    await server.close()
  }
})
