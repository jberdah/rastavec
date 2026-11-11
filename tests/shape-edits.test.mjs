import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const sharp = createRequire(new URL('../cli/package.json', import.meta.url))('sharp')
const { buildSync } = createRequire(new URL('../cli/package.json', import.meta.url))('esbuild')
const bundled = buildSync({ stdin: { contents: `export * from './src/lib/engine/shape-edits'; export { analyzeShapes, applyFilters, DEFAULT_FILTERS } from './src/lib/engine/palette'`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'node' }).outputFiles[0].text
const { editShape, ellipsePath, shapeCapabilities, analyzeShapes, applyFilters, DEFAULT_FILTERS } = await import(`data:text/javascript;base64,${Buffer.from(bundled).toString('base64')}`)

// Engine-style output: a background, a flat circle, a gradient-painted ellipse with one overlay.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120" viewBox="0 0 200 120">
<defs>
<linearGradient id="vtracer-gradient-2" gradientUnits="userSpaceOnUse" x1="110" y1="60" x2="190" y2="60">
<stop offset="0" stop-color="#ff0000"/>
<stop offset="1" stop-color="#0000ff"/>
</linearGradient>
<radialGradient id="vtracer-gradient-3" gradientUnits="userSpaceOnUse" cx="150" cy="60" r="10">
<stop offset="0" stop-color="#ffffff" stop-opacity=".6"/>
<stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
</radialGradient>
</defs>
<path d="M0,0H200V120H0Z" fill="#ffffff"/>
<path d="${ellipsePath(50, 60, 30, 30)}" fill="#dc3c32"/>
<path d="${ellipsePath(150, 60, 40, 20, 0)}" fill="url(#vtracer-gradient-2)"/>
<path d="M140,50H160V70H140Z" fill="url(#vtracer-gradient-3)"/>
</svg>`
const hints = [
  { index: 1, kind: 'circle', cx: 50, cy: 60, r: 30, bounds: [20, 30, 80, 90] },
  { index: 2, kind: 'ellipse', cx: 150, cy: 60, rx: 40, ry: 20, rotation: 0, gradient: { id: 'vtracer-gradient-2', type: 'linear', stops: 2, opaque: true }, bounds: [110, 40, 190, 80] },
  { index: 3, kind: 'path', gradient: { id: 'vtracer-gradient-3', type: 'radial', stops: 2, opaque: false }, overlayOf: 2, bounds: [140, 50, 160, 70] },
]
const pixel = async (markup, x, y) => {
  const { data, info } = await sharp(Buffer.from(markup)).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return [...data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 3)]
}

test('capabilities say what each hinted shape allows', () => {
  assert.deepEqual(shapeCapabilities(svg, hints, 1), { geometry: true, fill: '#dc3c32' })
  // The ellipse carries an overlay cut to its shape, so only its colours can change.
  assert.deepEqual(shapeCapabilities(svg, hints, 2), { geometry: false, stops: ['#ff0000', '#0000ff'] })
  assert.deepEqual(shapeCapabilities(svg, hints, 3), { geometry: false, stops: ['#ffffff', '#ffffff'] })
  assert.equal(shapeCapabilities(svg, hints, 0), null, 'an unhinted path is not editable here')
})

test('a circle is moved, resized and recoloured by its parameters', async () => {
  const edited = editShape(svg, hints, 1, { cx: 70, cy: 50, r: 20, fill: '#00AA00' })
  assert.ok(edited)
  assert.deepEqual(edited.hints[0], { index: 1, kind: 'circle', cx: 70, cy: 50, r: 20, bounds: [50, 30, 90, 70] })
  assert.deepEqual(await pixel(edited.svg, 70, 50), [0, 170, 0], 'the new centre is painted in the new colour')
  assert.deepEqual(await pixel(edited.svg, 25, 60), [255, 255, 255], 'the old left edge is uncovered')
  // Only attribute values changed: the palette filters still see every flat shape.
  assert.equal(analyzeShapes(edited.svg).shapes.length, analyzeShapes(svg).shapes.length)
  assert.equal(applyFilters(edited.svg, analyzeShapes(edited.svg), DEFAULT_FILTERS).total, 2)
  // Other paths and the gradients are untouched.
  assert.equal(edited.svg.replace(/<path[^>]*fill="#00aa00"\/>/, ''), svg.replace(/<path[^>]*fill="#dc3c32"\/>/, ''))
})

test('gradient stops are recoloured one by one, and refused geometry leaves the SVG alone', async () => {
  const recoloured = editShape(svg, hints, 2, { stops: [undefined, '#00ff00'] })
  assert.ok(recoloured)
  assert.deepEqual(shapeCapabilities(recoloured.svg, recoloured.hints, 2).stops, ['#ff0000', '#00ff00'])
  assert.match(recoloured.svg, /stop-opacity="0"/, 'the overlay gradient is untouched')
  const right = await pixel(recoloured.svg, 185, 60)
  assert.ok(right[1] > 200 && right[2] < 60, `the far end turned green: ${right}`)
  assert.equal(editShape(svg, hints, 2, { cx: 120 }), null, 'geometry is refused while an overlay depends on the shape')
  assert.equal(editShape(svg, hints, 1, { r: -3 }), null)
  assert.equal(editShape(svg, hints, 1, { fill: 'red' }), null)
  assert.equal(editShape(svg, hints, 9, { fill: '#000000' }), null)
})

test('a gradient follows the shape it paints when the shape moves', async () => {
  const free = hints.filter((hint) => hint.index !== 3)
  const moved = editShape(svg, free, 2, { cx: 130, cy: 70, rotation: 30 })
  assert.ok(moved)
  assert.match(moved.svg, /<linearGradient id="vtracer-gradient-2"[^>]*x1="90" y1="70" x2="170" y2="70"/)
  assert.equal(moved.hints.find((hint) => hint.index === 2).rotation, 30)
  const centre = await pixel(moved.svg, 130, 70)
  assert.ok(Math.abs(centre[0] - centre[2]) < 12, `the middle of the ramp is still at the centre: ${centre}`)
})
