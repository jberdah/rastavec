import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { resolve } from 'node:path'
import sharp from 'sharp'

const bundle = await build({ stdin: { contents: `export { groupNearbyPaths } from './src/lib/engine/group-nearby.ts'`, resolveDir: resolve('..') }, bundle: true, write: false, format: 'esm', platform: 'node' })
const { groupNearbyPaths } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
const render = async (svg) => sharp(Buffer.from(svg), { density: 72 }).ensureAlpha().raw().toBuffer()

test('nearby consecutive paths form real groups while paint order, alpha and masks remain intact', async () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">
<defs><clipPath id="clip"><path d="M0 0h200v200h-200z" fill="#ffffff"/></clipPath></defs>
<g clip-path="url(#clip)"><path d="M5 5h25v25h-25z" fill="#ff0000"/>
<path d="M20 20h25v25h-25z" fill="#0000ff"/>
<path d="M160 160h20v20h-20z" fill="#00ff00"/></g>
<g opacity="0.4"><path d="M50 50h12v12h-12z" fill="#ffff00"/>
<path d="M61 61h12v12h-12z" fill="#00ffff"/></g></svg>`
  const result = groupNearbyPaths(svg)
  assert.equal(result.groups.length, 2)
  assert.deepEqual(result.groups.map((group) => group.count), [2, 2])
  assert.ok(result.svg.includes('<clipPath id="clip"><path'))
  assert.deepEqual(await render(result.svg), await render(svg))
})

test('distant paths, protected definitions, background, foreign styles and unsupported transforms are left unchanged', () => {
  const header = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">'
  const distant = header + '<path d="M1 1h2v2h-2z" fill="#ff0000"/>\n<path d="M90 90h2v2h-2z" fill="#00ff00"/></svg>'
  assert.equal(groupNearbyPaths(distant).svg, distant)
  const defs = header + '<defs><clipPath id="x"><path d="M1 1h5v5h-5z" fill="#ff0000"/>\n<path d="M3 3h5v5h-5z" fill="#00ff00"/></clipPath></defs></svg>'
  assert.equal(groupNearbyPaths(defs).svg, defs)
  const styled = header + '<style>g > path { opacity: .5 }</style><path d="M1 1h5v5h-5z" fill="#ff0000"/>\n<path d="M3 3h5v5h-5z" fill="#00ff00"/></svg>'
  assert.equal(groupNearbyPaths(styled).svg, styled)
  const transformed = header + '<path d="M1 1h5v5h-5z" fill="#ff0000" transform="rotate(20)"/>\n<path d="M3 3h5v5h-5z" fill="#00ff00"/></svg>'
  assert.equal(groupNearbyPaths(transformed).svg, transformed)
})

test('existing IDs cannot collide with generated group IDs', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><g id="rastavec-proximity-1"><path d="M1 1h5v5h-5z" fill="#ff0000"/>\n<path d="M3 3h5v5h-5z" fill="#00ff00"/></g></svg>'
  assert.equal(groupNearbyPaths(svg).groups[0].id, 'rastavec-proximity-2')
})

test('refuses excessive geometry without altering the SVG', () => {
  const longPath = 'M0 0' + 'L1 1'.repeat(25001) + 'z'
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><path d="${longPath}" fill="#ff0000"/></svg>`
  const result = groupNearbyPaths(svg)
  assert.equal(result.limit, 'geometry-size')
  assert.equal(result.svg, svg)
  assert.equal(result.groups.length, 0)
})
