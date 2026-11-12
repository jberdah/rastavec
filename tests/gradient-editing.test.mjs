import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'

// Engine output with native gradients: a base path painted by a linear gradient, a translucent
// radial overlay on top of it, and a flat shape nearby.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">
<defs>
<linearGradient id="vtracer-gradient-0" gradientUnits="userSpaceOnUse" x1="0" y1="10" x2="0" y2="40">
<stop offset="0" stop-color="#ff0000"/>
<stop offset="1" stop-color="#0000ff"/>
</linearGradient>
<radialGradient id="vtracer-gradient-1" gradientUnits="userSpaceOnUse" cx="20" cy="20" r="8">
<stop offset="0" stop-color="#ffff00" stop-opacity=".7"/>
<stop offset="1" stop-color="#ffff00" stop-opacity="0"/>
</radialGradient>
</defs>
<path d="M10 10h20v30h-20z" fill="url(#vtracer-gradient-0)"/>
<path d="M12 12h16v16h-16z" fill="url(#vtracer-gradient-1)"/>
<path d="M31 10h10v10h-10z" fill="#00ff00"/>
</svg>`

test('gradient-filled paths can be grouped, so gradient regions can be animated', async () => {
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
  try {
    const { groupNearbyPaths } = await server.ssrLoadModule('/src/lib/engine/group-nearby.ts')
    const result = groupNearbyPaths(svg, { distance: 2 })
    assert.equal(result.skipped, 0, 'no path is skipped for being gradient-filled')
    assert.equal(result.groups.length, 1)
    assert.deepEqual(result.groups[0].pathIndices, [0, 1, 2])
    // The gradient paths keep their paint; only the wrapper group is added.
    assert.match(result.svg, /<g id="rastavec-proximity-1"[^>]*><path d="M10 10h20v30h-20z" fill="url\(#vtracer-gradient-0\)"\/>/)
    assert.equal((result.svg.match(/<linearGradient\b/g) ?? []).length, 1)
    // The member colour is the gradient's mean stop colour.
    assert.equal(result.groups[0].members?.[0].fill ?? result.groups[0].fill, '#800080')
  } finally {
    await server.close()
  }
})

test('palette filters recolour gradient stops along with flat shapes', async () => {
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
  try {
    const palette = await server.ssrLoadModule('/src/lib/engine/palette.ts')
    const analysis = palette.analyzeShapes(svg)
    const neutral = palette.applyFilters(svg, analysis, palette.DEFAULT_FILTERS)
    const shifted = palette.applyFilters(svg, analysis, { ...palette.DEFAULT_FILTERS, hue: 120 })
    const stops = (text) => [...text.matchAll(/stop-color="(#[0-9a-f]{6})"/g)].map((match) => match[1])
    const flat = (text) => /fill="(#[0-9a-f]{6})"/.exec(text)?.[1]
    assert.notEqual(flat(shifted.svg), flat(neutral.svg), 'the hue shift changes the flat shape')
    assert.notDeepEqual(stops(shifted.svg), stops(neutral.svg), 'and the gradient stops with it')
    assert.equal(stops(shifted.svg).length, 4)
    assert.match(shifted.svg, /stop-opacity="0"/, 'stop opacity is untouched')
  } finally {
    await server.close()
  }
})
