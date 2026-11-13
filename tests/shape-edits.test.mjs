import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const sharp = createRequire(new URL('../cli/package.json', import.meta.url))('sharp')
const { buildSync } = createRequire(new URL('../cli/package.json', import.meta.url))('esbuild')
const bundled = buildSync({ stdin: { contents: `export * from './src/lib/engine/shape-edits'; export { analyzeShapes, applyFilters, DEFAULT_FILTERS } from './src/lib/engine/palette'`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'node' }).outputFiles[0].text
const { editShape, ellipsePath, crescentPath, ringPath, keepRing, shapeCapabilities, analyzeShapes, applyFilters, DEFAULT_FILTERS } = await import(`data:text/javascript;base64,${Buffer.from(bundled).toString('base64')}`)

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

test('recognised shapes become animation groups, overlays staying with their base', async () => {
  const groupsBundle = buildSync({ stdin: { contents: `export { groupsFromShapes } from './src/lib/engine/shape-groups'; export { svgFingerprint } from './src/lib/engine/group-nearby'`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'node' }).outputFiles[0].text
  const { groupsFromShapes, svgFingerprint } = await import(`data:text/javascript;base64,${Buffer.from(groupsBundle).toString('base64')}`)
  const grouping = groupsFromShapes(svg, hints, (hint, ordinal) => `${hint.kind} ${ordinal}`)
  assert.ok(grouping)
  assert.equal(grouping.sourceHash, svgFingerprint(svg))
  assert.deepEqual(grouping.groups.map((group) => [group.id, group.name, group.pathIndices, group.pivot]), [
    ['rastavec-shape-1', 'circle 1', [1], [50, 60]],
    ['rastavec-shape-2', 'ellipse 2', [2, 3], [150, 60]],
  ])
  assert.equal(grouping.groups[1].fill, '#800080', 'a gradient group is shown in its mean stop colour')
  assert.equal(grouping.considered, 3)
  assert.equal(grouping.skipped, 1)
  // Wrapping adds groups only: the picture and the paths are unchanged.
  assert.equal(grouping.svg.replace(/<g id="rastavec-shape-\d+" data-rastavec-group="shape" data-rastavec-level="0">|<\/g>/g, ''), svg)
  assert.match(grouping.svg, /<g id="rastavec-shape-2"[^>]*><path[^>]*url\(#vtracer-gradient-2\)"\/>\n<path[^>]*url\(#vtracer-gradient-3\)"\/><\/g>/)
  for (const at of [[50, 60], [150, 60], [5, 5]]) assert.deepEqual(await pixel(grouping.svg, ...at), await pixel(svg, ...at))
  assert.equal(groupsFromShapes(grouping.svg, hints, () => 'x'), null, 'an already grouped SVG is left alone')
  assert.equal(groupsFromShapes(svg, [], () => 'x'), null)
})

test('a crescent is moved as a whole, or reshaped by its inner circle, and stays a crescent', async () => {
  const d = crescentPath(100, 100, 60, 125, 85, 50)
  assert.ok(d && /^M[^MZ]+Z$/.test(d) && (d.match(/C/g) ?? []).length === 8, d)
  assert.equal(crescentPath(100, 100, 60, 300, 300, 20), null, 'circles that do not cross make no crescent')
  const moon = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">
<path d="M0,0H200V200H0Z" fill="#fafaf5"/>
<path d="${d}" fill="#25303e"/>
</svg>`
  const hints = [{ index: 1, kind: 'crescent', cx: 100, cy: 100, r: 60, innerCx: 125, innerCy: 85, innerR: 50, bounds: [40, 40, 160, 160] }]
  assert.equal(shapeCapabilities(moon, hints, 1).geometry, true)

  const moved = editShape(moon, hints, 1, { cx: 110, cy: 90 })
  const after = moved.hints[0]
  assert.deepEqual([after.cx, after.cy, after.innerCx, after.innerCy], [110, 90, 135, 75], 'the inner circle travels with the crescent')
  assert.ok(moved.svg.includes(`d="${crescentPath(110, 90, 60, 135, 75, 50)}"`))

  const thinner = editShape(moon, hints, 1, { innerCx: 115, innerR: 55 })
  assert.deepEqual([thinner.hints[0].cx, thinner.hints[0].innerCx, thinner.hints[0].innerR], [100, 115, 55])
  assert.equal(editShape(moon, hints, 1, { innerCx: 400 }), null, 'an inner circle moved off the crescent is refused')
  assert.equal(editShape(moon, hints, 1, { innerR: 0 }), null)
})

// The cubics of a path, each as [start, c1, c2, end].
const cubics = (d) => {
  const out = []
  let current
  for (const [, op, args] of d.matchAll(/([MCZ])([^MCZ]*)/g)) {
    const n = args.trim().split(/[\s,]+/).filter(Boolean).map(Number)
    if (op === 'M') current = [n[0], n[1]]
    if (op === 'C') { const end = [n[4], n[5]]; out.push([current, [n[0], n[1]], [n[2], n[3]], end]); current = end }
  }
  return out
}

test('a ring path is the engine construction: the outer circle, then the inner one wound the other way', () => {
  const d = ringPath(100, 100, 50, 110, 95, 20)
  const parts = d.split(/(?=M)/)
  assert.equal(parts.length, 2, d)
  assert.equal(parts[0], ellipsePath(100, 100, 50, 50), 'the outer subpath is the exact circle the engine writes')
  // Engine (shapes/ring.rs): inner subpath starts at (cx + r, cy) and goes through (cx, cy - r) first.
  assert.ok(parts[1].startsWith('M130,95C130,83.95 121.05,75 110,75C'), parts[1])
  assert.ok(/Z$/.test(parts[0]) && /Z$/.test(parts[1]))
  const segments = cubics(d)
  assert.equal(segments.length, 8)
  const turn = (list, [ox, oy]) => list.reduce((sum, [a, , , b]) => sum + (a[0] - ox) * (b[1] - oy) - (a[1] - oy) * (b[0] - ox), 0)
  for (const [list, centre, radius] of [[segments.slice(0, 4), [100, 100], 50], [segments.slice(4), [110, 95], 20]]) {
    for (const [p0, p1, p2, p3] of list) {
      for (const p of [p0, p3]) assert.ok(Math.abs(Math.hypot(p[0] - centre[0], p[1] - centre[1]) - radius) < 0.01)
      const mid = [0, 1].map((axis) => (p0[axis] + 3 * p1[axis] + 3 * p2[axis] + p3[axis]) / 8)
      assert.ok(Math.abs(Math.hypot(mid[0] - centre[0], mid[1] - centre[1]) - radius) < 0.02, `cubic midpoint on the circle: ${mid}`)
    }
  }
  assert.ok(turn(segments.slice(0, 4), [100, 100]) * turn(segments.slice(4), [110, 95]) < 0, 'opposite windings')
  assert.equal(ringPath(100, 100, 50, 120, 100, 29), null, 'a band under 1.5 is no ring')
  assert.equal(ringPath(100, 100, 50, 160, 100, 10), null, 'an inner circle outside the disc is no ring')
  assert.equal(ringPath(100, 100, 50, 100, 100, 0), null)
})

test('a ring is moved as a whole, its hole moved or resized inside it, and stays a ring', async () => {
  const donut = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">
<path d="M0,0H200V200H0Z" fill="#ffffff"/>
<path d="${ringPath(100, 100, 60, 100, 100, 30)}" fill="#1f6feb"/>
</svg>`
  const hints = [{ index: 1, kind: 'ring', cx: 100, cy: 100, r: 60, innerCx: 100, innerCy: 100, innerR: 30, bounds: [40, 40, 160, 160] }]
  assert.equal(shapeCapabilities(donut, hints, 1).geometry, true)
  assert.deepEqual(await pixel(donut, 100, 100), [255, 255, 255], 'the hole shows the background')
  assert.deepEqual(await pixel(donut, 145, 100), [31, 111, 235])

  const moved = editShape(donut, hints, 1, { cx: 90, cy: 110 })
  assert.deepEqual([moved.hints[0].cx, moved.hints[0].cy, moved.hints[0].innerCx, moved.hints[0].innerCy, moved.hints[0].innerR], [90, 110, 90, 110, 30], 'the hole travels with the ring')
  assert.ok(moved.svg.includes(`d="${ringPath(90, 110, 60, 90, 110, 30)}"`))
  assert.deepEqual(moved.hints[0].bounds, [30, 50, 150, 170])
  assert.deepEqual(await pixel(moved.svg, 90, 110), [255, 255, 255])

  const shifted = editShape(donut, hints, 1, { innerCx: 115, innerR: 25 })
  assert.deepEqual([shifted.hints[0].cx, shifted.hints[0].innerCx, shifted.hints[0].innerCy, shifted.hints[0].innerR], [100, 115, 100, 25])
  assert.deepEqual(await pixel(shifted.svg, 130, 100), [255, 255, 255])
  assert.deepEqual(await pixel(shifted.svg, 80, 100), [31, 111, 235])

  assert.ok(editShape(donut, hints, 1, { r: 40 }), 'shrinking the disc while the band stays is fine')
  assert.equal(editShape(donut, hints, 1, { r: 31 }), null, 'a disc shrunk onto its hole is refused')
  assert.equal(editShape(donut, hints, 1, { innerR: 59 }), null, 'a hole as large as the disc is refused')
  assert.equal(editShape(donut, hints, 1, { innerCx: 140 }), null, 'a hole moved through the rim is refused')
  assert.equal(editShape(donut, hints, 1, { innerR: 0 }), null)
})

test('a ring reported a hair under the minimum band stays pickable and editable, but no thinner', () => {
  // Born at a 1.5 band, reparsed from rounded coordinates as 1.49.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">
<path d="M0,0H200V200H0Z" fill="#ffffff"/>
<path d="${ringPath(100, 100, 30, 100, 100, 28.51, 0)}" fill="#1f6feb"/>
</svg>`
  assert.equal(ringPath(100, 100, 30, 100, 100, 28.51), null, 'under the engine minimum by default')
  assert.ok(ringPath(100, 100, 30, 100, 100, 28.51, 0), 'the pick outline only needs a band')
  assert.equal(ringPath(100, 100, 30, 100, 100, 30, 0), null, 'no band, no ring')
  const hints = [{ index: 1, kind: 'ring', cx: 100, cy: 100, r: 30, innerCx: 100, innerCy: 100, innerR: 28.51, bounds: [70, 70, 130, 130] }]
  const moved = editShape(svg, hints, 1, { cx: 120, cy: 90 })
  assert.ok(moved, 'a move keeps the band, so it is accepted')
  assert.deepEqual([moved.hints[0].innerCx, moved.hints[0].innerCy, moved.hints[0].innerR], [120, 90, 28.51])
  assert.ok(editShape(svg, hints, 1, { r: 35 }), 'a wider band is fine')
  assert.ok(editShape(svg, hints, 1, { innerR: 28.5 }), 'a tenth-rounded value near the current band is fine')
  assert.equal(editShape(svg, hints, 1, { innerR: 29 }), null, 'a thinner band is refused')
  assert.equal(editShape(svg, hints, 1, { innerCx: 101 }), null)
})

test('ring gestures clamp to the band floor, never past the starting value', () => {
  const ring = (rx, icx, ir) => ({ cx: 100, cy: 100, rx, ry: rx, icx, icy: 100, ir })
  const band = (g) => g.rx - Math.hypot(g.icx - g.cx, g.icy - g.cy) - g.ir
  // Inner resize of a tiny ring: clamped, not handed back unclamped.
  const tiny = ring(2.5, 100, 0.5)
  const grown = keepRing({ ...tiny, ir: 5 }, tiny, 'inner-resize')
  assert.ok(Math.abs(grown.ir - 0.8) < 1e-9 && band(grown) >= 1.7 - 1e-9, JSON.stringify(grown))
  // A sub-1 inner radius does not jump to 1, and is not shrunk past where it started below 1.
  assert.equal(keepRing({ ...tiny, ir: 0.6 }, tiny, 'inner-resize').ir, 0.6)
  assert.equal(keepRing({ ...tiny, ir: 0.1 }, tiny, 'inner-resize').ir, 0.5)
  const usual = ring(50, 100, 20)
  assert.equal(keepRing({ ...usual, ir: 0.2 }, usual, 'inner-resize').ir, 1)
  assert.ok(Math.abs(keepRing({ ...usual, ir: 80 }, usual, 'inner-resize').ir - 48.3) < 1e-9)
  // Resize of a ring whose band is between 1.5 and 1.7: shrinking stops where it is, never grows.
  const thin = ring(31.6, 100, 30)
  for (const rx of [31, 31.6, 20]) assert.ok(Math.abs(keepRing({ ...thin, rx, ry: rx }, thin, 'resize').rx - 31.6) < 1e-9, `rx ${rx}`)
  assert.equal(keepRing({ ...thin, rx: 40, ry: 40 }, thin, 'resize').rx, 40)
  assert.ok(Math.abs(keepRing({ ...usual, rx: 10, ry: 10 }, usual, 'resize').rx - 21.7) < 1e-9)
  // Inner move stops at the floor, and a thin ring's hole cannot move closer to the rim.
  const off = keepRing({ ...usual, icx: 200 }, usual, 'inner-move')
  assert.ok(Math.abs(band(off) - 1.7) < 1e-9, JSON.stringify(off))
  const stuck = keepRing({ ...thin, icx: 105 }, thin, 'inner-move')
  assert.ok(Math.abs(stuck.icx - 100) < 1e-9, JSON.stringify(stuck))
  assert.deepEqual(keepRing({ ...usual, cx: 140, icx: 140 }, usual, 'move'), { ...usual, cx: 140, icx: 140 })
})
