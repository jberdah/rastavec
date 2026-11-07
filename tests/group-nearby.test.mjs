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
    const { attachmentPivot } = await server.ssrLoadModule('/src/lib/engine/pivot.ts')
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

    const standalone = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><path d="M2 2h50v50H2z" fill="#ff0000"/><path d="M75 5h4v4h-4z" fill="#00ff00"/><path d="M75 80h4v4h-4z" fill="#0000ff"/></svg>`
    const defaultStandalone = groupNearbyPaths(standalone)
    assert.equal(defaultStandalone.groups.length, 0, 'the conservative mode remains unchanged unless standalone shapes are requested')
    const editableStandalone = groupNearbyPaths(standalone, { includeSingletons: true })
    assert.equal(editableStandalone.groups.length, 3, 'requested standalone mode exposes even a large background-like shape')
    assert.ok(editableStandalone.groups.every((group) => group.count === 1 && group.pathIndices.length === 1 && group.members?.length === 1))
    assert.deepEqual(editableStandalone.groups.map((group) => group.pathIndices), [[0], [1], [2]])
    assert.deepEqual(await render(editableStandalone.svg), await render(standalone), 'singleton wrappers preserve exact rendered pixels')

    const interleavedRegions = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="40" viewBox="0 0 100 40"><path d="M10 10h5v5h-5z" fill="#ff0000"/><path d="M80 10h5v5h-5z" fill="#00ff00"/><path d="M20 18h5v5h-5z" fill="#0000ff"/><path d="M90 18h5v5h-5z" fill="#ffff00"/></svg>`
    const interleavedResult = groupNearbyPaths(interleavedRegions, { strategy: 'spatial', regionCount: 2 })
    assert.deepEqual(interleavedResult.groups.map((group) => group.pathIndices), [[0, 2], [1, 3]], 'spatial regions can unite nearby paths even when they are interleaved in paint order')
    assert.ok(interleavedResult.groups.every((group) => group.fragmentIds?.length === group.count && group.members?.length === group.count))
    assert.equal((interleavedResult.svg.match(/data-rastavec-fragment-of=/g) ?? []).length, 4)
    assert.deepEqual(await render(interleavedResult.svg), await render(interleavedRegions), 'fragment-based spatial grouping preserves exact rendered pixels')

    const spatialLargeShape = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="40" viewBox="0 0 100 40"><path d="M5 5h50v20H5z" fill="#ff0000"/><path d="M70 5h5v5h-5z" fill="#00ff00"/><path d="M85 20h5v5h-5z" fill="#0000ff"/></svg>`
    const spatialWithoutLarge = groupNearbyPaths(spatialLargeShape, { strategy: 'spatial', regionCount: 2 })
    const spatialWithLarge = groupNearbyPaths(spatialLargeShape, { strategy: 'spatial', regionCount: 2, includeSingletons: true })
    assert.equal(spatialWithoutLarge.groups.length, 2, 'the broad background-like shape does not pull nearby regions together')
    assert.equal(spatialWithoutLarge.skipped, 1)
    assert.equal(spatialWithLarge.groups.length, 3, 'large shapes remain individually available when requested')
    assert.equal(spatialWithLarge.groups.find((group) => group.pathIndices[0] === 0)?.count, 1)
    assert.deepEqual(await render(spatialWithLarge.svg), await render(spatialLargeShape))

    const transformedSpatial = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="40" viewBox="0 0 100 40"><g transform="translate(4 2)"><path d="M10 10h5v5h-5z" fill="#ff0000"/><path d="M20 10h5v5h-5z" fill="#00ff00"/></g></svg>`
    const safeTransformedSpatial = groupNearbyPaths(transformedSpatial, { strategy: 'spatial', regionCount: 2 })
    assert.equal(safeTransformedSpatial.groups.length, 0, 'spatial animation regions skip transformed parents until local pivots are supported')
    assert.equal(safeTransformedSpatial.svg, transformedSpatial)

    const manyStandalone = `<svg xmlns="http://www.w3.org/2000/svg" width="10000" height="10" viewBox="0 0 10000 10">${Array.from({ length: 1001 }, (_, index) => `<path d="M${index * 9 + 1} 1h1v1h-1z" fill="#ff0000"/>`).join('')}</svg>`
    const cappedSingletons = groupNearbyPaths(manyStandalone, { distance: 0, includeSingletons: true })
    assert.equal(cappedSingletons.limit, 'singleton-count', 'standalone metadata has a predictable upper bound')
    assert.equal(cappedSingletons.groups.length, 0, 'overflow does not return a partial set that could look complete')
    assert.equal(cappedSingletons.skipped, 1001)
    assert.equal(cappedSingletons.svg, manyStandalone, 'overflow leaves the source SVG untouched')

    const hierarchy = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><path d="M10 10h1v1h-1z" fill="#ff0000"/><path d="M10.5 10h1v1h-1z" fill="#ff0000"/><path d="M12.5 10h1v1h-1z" fill="#ffff00"/><path d="M13 10h1v1h-1z" fill="#ffff00"/></svg>`
    const nested = groupNearbyPaths(hierarchy, { distance: 0.5 })
    assert.equal(nested.groups.filter((group) => group.level === 0).length, 2)
    const parent = nested.groups.find((group) => group.level === 1)
    assert.ok(parent)
    assert.equal(parent.count, 4)
    const children = nested.groups.filter((group) => group.level === 0)
    assert.ok(children.every((group) => group.parentId === parent.id))
    assert.deepEqual(children.map((group) => group.pathIndices), [[0, 1], [2, 3]], 'building a parent must not add sibling paths to its first child')
    assert.ok(children.every((group) => group.count === group.pathIndices.length))
    assert.deepEqual([...new Set(children.flatMap((group) => group.pathIndices))].sort((a, b) => a - b), parent.pathIndices)
    assert.match(nested.svg, /data-rastavec-level="1"><g[^]*data-rastavec-level="0"/)
    assert.deepEqual(await render(nested.svg), await render(hierarchy))

    const byColor = groupNearbyPaths(hierarchy, { distance: 0.5, colorMode: 'same-color' })
    assert.equal(byColor.groups.length, 2, 'same-colour mode groups each colour run separately and does not create a mixed-colour parent')
    assert.ok(byColor.groups.every((group) => group.fill === '#ff0000' || group.fill === '#ffff00'))

    const transformed = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><path d="M10 10h10v10h-10z" fill="#ff0000" transform="matrix(2 0 0 2 0 0)"/><path d="M40 20h10v10h-10z" fill="#00ff00"/></svg>`
    const transformedGroups = groupNearbyPaths(transformed, { distance: 0 })
    assert.equal(transformedGroups.groups[0]?.count, 2, 'matrix-transformed bounds are compared in SVG coordinates')
    assert.deepEqual(await render(transformedGroups.svg), await render(transformed))

    const arc = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><path d="M10 10 A10 10 0 0 1 30 10 L30 30 L10 30 Z" fill="#ff0000"/><path d="M20 28h2v2h-2z" fill="#00ff00"/></svg>`
    const arcResult = groupNearbyPaths(arc, { distance: 1 })
    assert.equal(arcResult.considered, 2)
    assert.equal(arcResult.skipped, 0, 'elliptical arc paths are flattened for proximity checks')
    assert.deepEqual(await render(arcResult.svg), await render(arc))

    const concave = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><path d="M10 10h20v3h-17v17h-3z" fill="#ff0000"/><path d="M25 25h3v3h-3z" fill="#0000ff"/></svg>`
    assert.equal(groupNearbyPaths(concave, { distance: 1 }).groups.length, 0, 'overlapping bounding boxes alone must not join distant contours')

    const ring = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><path d="M20 20h60v60H20z M35 35v30h30V35z" fill="#ff0000"/><path d="M45 45h10v10H45z" fill="#0000ff"/></svg>`
    assert.equal(groupNearbyPaths(ring, { distance: 1 }).groups.length, 0, 'a path in a compound contour hole is not inside the filled shape')
    assert.deepEqual(await render(groupNearbyPaths(ring, { distance: 1 }).svg), await render(ring))

    const splitLobes = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120"><path d="M43 100h21v10H43z" fill="#a97d5b"/><path d="M23 89h20v21H23z" fill="#e2c3a1"/><path d="M25 91h32v5H25z" fill="#b68453"/><path d="M58 88h13v12H58z" fill="#fedfb0"/></svg>`
    const spatial = groupNearbyPaths(splitLobes, { distance: 0.5 })
    assert.deepEqual(spatial.groups.map((group) => group.pathIndices), [[0, 3], [1, 2]], 'a broad chain with two compact lobes becomes two spatially coherent groups')
    assert.match(spatial.svg, /data-rastavec-order-container="spatial"/)
    assert.deepEqual(await render(spatial.svg), await render(splitLobes), 'spatial regrouping must preserve exact SVG pixels')

    const overlappingLobes = splitLobes.replace('M58 88h13v12H58z', 'M50 88h13v12H50z')
    const overlapSafe = groupNearbyPaths(overlappingLobes, { distance: 0.5 })
    assert.equal(overlapSafe.groups.length, 1, 'do not reorder spatial clusters when their paths overlap')
    assert.deepEqual(await render(overlapSafe.svg), await render(overlappingLobes))

    assert.deepEqual(attachmentPivot([9, 64, 42, 101], '0 0 80 110'), [40, 55], 'an arm pivot can extend just past its bounds toward the shoulder')
    assert.deepEqual(attachmentPivot([23, 89, 57, 110], '0 0 80 110'), [40, 78.8], 'a lower-limb pivot nudges from the foot bounds toward the hip')
    assert.deepEqual(attachmentPivot([35, 76, 48, 101], '0 0 80 110'), [40, 68.5], 'a compact lower limb gets an attachment suggestion above its bounds')
    assert.deepEqual(attachmentPivot([43, 78.423439, 76.835838, 108.673241], '0 0 80 110'), [41.71, 68.35], 'fractional path bounds use the same bounded nudge toward the artwork centre')
    assert.deepEqual(attachmentPivot([30, 35, 50, 70], '0 0 80 110'), [40, 55], 'a group that contains the canvas centre keeps that point')
    assert.deepEqual(attachmentPivot([30, 40, 50, 60], 'invalid'), [40, 50], 'invalid viewBox uses the previous centred-pivot behavior')

    const crowded = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10">${'<path d="M1 1h1v1h-1z" fill="#ff0000"/>'.repeat(10001)}</svg>`
    const limited = groupNearbyPaths(crowded)
    assert.equal(limited.limit, 'path-count')
    assert.equal(limited.svg, crowded, 'limit must return the unchanged source')
  } finally {
    await server.close()
  }
})
