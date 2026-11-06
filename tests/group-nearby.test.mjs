import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { createServer } from 'vite'

const require = createRequire(path.resolve('cli/package.json'))
const sharp = require('sharp')

test('nearby path grouping preserves SVG appearance and avoids protected or distant paths', async () => {
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
  try {
    const { groupNearbyPaths } = await server.ssrLoadModule('/src/lib/engine/group-nearby.ts')
    const source = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><defs><clipPath id="clip"><path d="M0 0h100v100H0z"/></clipPath></defs><g opacity="0.6" clip-path="url(#clip)"><path d="M10 10h20v20h-20z" fill="#ff0000"/><path d="M25 25h20v20h-20z" fill="#00ff00"/><path d="M80 80h10v10h-10z" fill="#0000ff"/></g></svg>`
    const result = groupNearbyPaths(source, { distance: 1 })

    assert.equal(result.groups.length, 1)
    assert.equal(result.groups[0].count, 2)
    assert.match(result.svg, /<g id="rastavec-proximity-1" data-rastavec-group="proximity" data-rastavec-level="0"><path/)
    assert.equal((result.svg.match(/<clipPath\b/g) ?? []).length, 1)
    assert.equal((result.svg.match(/fill="#0000ff"/g) ?? []).length, 1)

    const render = async (svg) => sharp(Buffer.from(svg), { density: 72 }).ensureAlpha().raw().toBuffer()
    assert.deepEqual(await render(result.svg), await render(source))
    assert.deepEqual(groupNearbyPaths(source.replace('<defs>', '<style>path{opacity:.5}</style><defs>')).svg, source.replace('<defs>', '<style>path{opacity:.5}</style><defs>'))

    const hierarchy = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><path d="M10 10h1v1h-1z" fill="#ff0000"/><path d="M10.5 10h1v1h-1z" fill="#ff0000"/><path d="M12.5 10h1v1h-1z" fill="#ffff00"/><path d="M13 10h1v1h-1z" fill="#ffff00"/></svg>`
    const nested = groupNearbyPaths(hierarchy, { distance: 0.5 })
    assert.equal(nested.groups.filter((group) => group.level === 0).length, 2)
    const parent = nested.groups.find((group) => group.level === 1)
    assert.ok(parent)
    assert.equal(parent.count, 4)
    assert.ok(nested.groups.filter((group) => group.level === 0).every((group) => group.parentId === parent.id))
    assert.match(nested.svg, /data-rastavec-level="1"><g[^]*data-rastavec-level="0"/)
    assert.deepEqual(await render(nested.svg), await render(hierarchy))

    const concave = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><path d="M10 10h20v3h-17v17h-3z" fill="#ff0000"/><path d="M25 25h3v3h-3z" fill="#0000ff"/></svg>`
    assert.equal(groupNearbyPaths(concave, { distance: 1 }).groups.length, 0, 'overlapping bounding boxes alone must not join distant contours')

    const ring = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><path d="M20 20h60v60H20z M35 35v30h30V35z" fill="#ff0000"/><path d="M45 45h10v10H45z" fill="#0000ff"/></svg>`
    assert.equal(groupNearbyPaths(ring, { distance: 1 }).groups.length, 0, 'a path in a compound contour hole is not inside the filled shape')
    assert.deepEqual(await render(groupNearbyPaths(ring, { distance: 1 }).svg), await render(ring))

    const crowded = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10">${'<path d="M1 1h1v1h-1z" fill="#ff0000"/>'.repeat(10001)}</svg>`
    const limited = groupNearbyPaths(crowded)
    assert.equal(limited.limit, 'path-count')
    assert.equal(limited.svg, crowded, 'limit must return the unchanged source')
  } finally {
    await server.close()
  }
})
