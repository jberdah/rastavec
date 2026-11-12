import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createServer } from 'vite'

const { buildSync } = createRequire(new URL('../cli/package.json', import.meta.url))('esbuild')
const bundled = buildSync({ stdin: { contents: `export { carryGrouping } from './src/lib/engine/carry-grouping'; export { groupNearbyPaths, svgFingerprint } from './src/lib/engine/group-nearby'; export { editShape, ellipsePath } from './src/lib/engine/shape-edits'; export { analyzeShapes, applyFilters, DEFAULT_FILTERS } from './src/lib/engine/palette'`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'node' }).outputFiles[0].text
const { carryGrouping, groupNearbyPaths, svgFingerprint, editShape, ellipsePath, analyzeShapes, applyFilters, DEFAULT_FILTERS } = await import(`data:text/javascript;base64,${Buffer.from(bundled).toString('base64')}`)

// Four separate ellipses (one painted by a gradient) on a background, like the rotated-ellipses fixture.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">
<defs>
<linearGradient id="vtracer-gradient-4" gradientUnits="userSpaceOnUse" x1="120" y1="150" x2="180" y2="150">
<stop offset="0" stop-color="#ff0000"/>
<stop offset="1" stop-color="#0000ff"/>
</linearGradient>
</defs>
<path d="${ellipsePath(50, 50, 30, 20, 30)}" fill="#dc3c32"/>
<path d="${ellipsePath(150, 50, 25, 15, -20)}" fill="#3264dc"/>
<path d="${ellipsePath(50, 150, 20, 30, 10)}" fill="#32a050"/>
<path d="${ellipsePath(150, 150, 30, 18, 0)}" fill="url(#vtracer-gradient-4)"/>
</svg>`
const hints = [
  { index: 0, kind: 'ellipse', cx: 50, cy: 50, rx: 30, ry: 20, rotation: 30, bounds: [20, 30, 80, 70] },
  { index: 1, kind: 'ellipse', cx: 150, cy: 50, rx: 25, ry: 15, rotation: -20, bounds: [125, 35, 175, 65] },
  { index: 2, kind: 'ellipse', cx: 50, cy: 150, rx: 20, ry: 30, rotation: 10, bounds: [30, 120, 70, 180] },
  { index: 3, kind: 'ellipse', cx: 150, cy: 150, rx: 30, ry: 18, rotation: 0, gradient: { id: 'vtracer-gradient-4', type: 'linear', stops: 2, opaque: true }, bounds: [120, 132, 180, 168] },
]

/** What the Groups panel saves: the grouping pass result, labelled the way the browser serializes it. */
function reviewed(source) {
  const result = groupNearbyPaths(source, { includeSingletons: true })
  assert.equal(result.groups.length, 4)
  const groups = result.groups.map((group, index) => ({ ...group, name: index === 0 ? 'Sun' : `Group ${index + 1}`, pivot: [...group.pivot] }))
  let labelled = result.svg
  for (const group of groups) labelled = labelled.replace(new RegExp(`<g id="${group.id}"[^>]*>`), (tag) =>
    `${tag.slice(0, -1)} data-rastavec-pivot-x="${group.pivot[0]}" data-rastavec-pivot-y="${group.pivot[1]}" aria-label="${group.name}"><title>${group.name}</title>`)
  // XMLSerializer may write self-closing tags with a space: path identity must not depend on it.
  labelled = labelled.replace(/"\/>/g, '" />')
  return { sourceHash: svgFingerprint(source), distance: 1, colorMode: 'proximity', includeSingletons: true, strategy: 'proximity', considered: result.considered, skipped: result.skipped, svg: labelled, groups }
}
const unwrap = (markup) => markup.replace(/<g [^>]*data-rastavec-group[^>]*>(<title>[^<]*<\/title>)?|<\/g>/g, '').replace(/" \/>/g, '"/>')

test('groups follow a moved shape: same groups and names, new geometry, pivot moved along', () => {
  const grouping = reviewed(svg)
  const edited = editShape(svg, hints, 2, { cx: 40, cy: 150 })
  assert.ok(edited)
  const carried = carryGrouping(grouping, svg, edited.svg)
  assert.ok(carried, 'a shape edit keeps the paths in place, so the groups carry over')
  assert.equal(carried.sourceHash, svgFingerprint(edited.svg))
  assert.equal(unwrap(carried.svg), edited.svg, 'the grouped markup is the edited SVG plus the wrappers')
  assert.equal(carried.svg.match(/<g /g).length, 4)
  assert.deepEqual(carried.groups.map((group) => [group.id, group.key, group.name, group.pathIndices]), grouping.groups.map((group) => [group.id, group.key, group.name, group.pathIndices]))
  const moved = carried.groups.find((group) => group.pathIndices.includes(2)), before = grouping.groups.find((group) => group.pathIndices.includes(2))
  assert.ok(Math.abs(moved.bounds[0] - (before.bounds[0] - 10)) < 0.01 && Math.abs(moved.bounds[2] - (before.bounds[2] - 10)) < 0.01, 'bounds follow the shape')
  assert.ok(Math.abs(moved.pivot[0] - (before.pivot[0] - 10)) < 0.01 && moved.pivot[1] === before.pivot[1])
  assert.match(carried.svg, new RegExp(`<g id="${moved.id}"[^>]*data-rastavec-pivot-x="${moved.pivot[0]}"`))
  assert.deepEqual(carried.groups.filter((group) => group !== moved), grouping.groups.filter((group) => group !== before), 'untouched groups are unchanged')
  // Chained edits keep carrying; the original grouping is never modified (undo restores it).
  const again = editShape(edited.svg, edited.hints, 2, { cx: 30, cy: 150 })
  const twice = carryGrouping(carried, edited.svg, again.svg)
  assert.ok(twice)
  assert.equal(unwrap(twice.svg), again.svg)
  assert.equal(grouping.sourceHash, svgFingerprint(svg))
})

test('groups follow a recolour, gradient stops included', () => {
  const grouping = reviewed(svg)
  const recoloured = applyFilters(svg, analyzeShapes(svg), { ...DEFAULT_FILTERS, hue: 120 }).svg
  assert.notEqual(recoloured, svg)
  const carried = carryGrouping(grouping, svg, recoloured)
  assert.ok(carried)
  assert.equal(unwrap(carried.svg), recoloured)
  const red = carried.groups.find((group) => group.pathIndices.includes(0))
  assert.notEqual(red.fill, '#dc3c32', 'the group colour follows its paths')
  // A colour change through a shape's own gradient stops also follows.
  const stops = editShape(svg, hints, 3, { stops: ['#00ff00', undefined] })
  const viaStops = carryGrouping(grouping, svg, stops.svg)
  assert.ok(viaStops)
  assert.match(viaStops.svg, /stop-color="#00ff00"/)
  assert.equal(unwrap(viaStops.svg), stops.svg)
})

test('groups are not carried when the paths themselves changed, or when they were stale already', () => {
  const grouping = reviewed(svg)
  // Detail drops a path: positions no longer mean the same shapes.
  const fewer = svg.replace(/<path[^>]*fill="#3264dc"\/>\n/, '')
  assert.equal(carryGrouping(grouping, svg, fewer), null)
  assert.equal(carryGrouping(grouping, svg, svg.replace('<defs>', '<defs><clipPath id="c"/>')), null, 'other markup changed')
  assert.equal(carryGrouping(grouping, fewer, svg), null, 'a grouping made for another SVG is not carried')
  assert.equal(carryGrouping(grouping, svg, svg), grouping)
})

test('a cluster the grouping pass reordered is matched by path identity', () => {
  const source = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M0,0H10V10H0Z" fill="#111111"/><path d="M50,50H60V60H50Z" fill="#222222"/><path d="M2,2H8V8H2Z" fill="#333333"/></svg>`
  const grouped = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><g data-rastavec-order-container="spatial"><g id="a" data-rastavec-group="proximity" data-rastavec-level="0"><path d="M0,0H10V10H0Z" fill="#111111"/><path d="M2,2H8V8H2Z" fill="#333333"/></g><g id="b" data-rastavec-group="proximity" data-rastavec-level="0"><path d="M50,50H60V60H50Z" fill="#222222"/></g></g></svg>`
  const grouping = { sourceHash: svgFingerprint(source), distance: 1, colorMode: 'proximity', considered: 3, skipped: 0, svg: grouped, groups: [
    { id: 'a', key: '0:0,2', pathIndices: [0, 2], count: 2, bounds: [0, 0, 10, 10], pivot: [5, 5], fill: '#111111', zone: 'top-left', level: 0, name: 'A' },
    { id: 'b', key: '0:1', pathIndices: [1], count: 1, bounds: [50, 50, 60, 60], pivot: [55, 55], fill: '#222222', zone: 'center', level: 0, name: 'B' },
  ] }
  const edited = source.replace('#333333', '#00ff00').replace('M50,50H60V60H50Z', 'M70,50H80V60H70Z')
  const carried = carryGrouping(grouping, source, edited)
  assert.ok(carried)
  assert.match(carried.svg, /<g id="a"[^>]*><path d="M0,0H10V10H0Z" fill="#111111"\/><path d="M2,2H8V8H2Z" fill="#00ff00"\/><\/g><g id="b"[^>]*><path d="M70,50H80V60H70Z" fill="#222222"\/>/)
  assert.deepEqual(carried.groups[1].bounds, [70, 50, 80, 60])
  assert.deepEqual(carried.groups[1].pivot, [75, 55])
})

test('Edit keeps groups through a shape edit; undo and redo restore each exact state', async () => {
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
  try {
    const { record, undo, redo } = await server.ssrLoadModule('/src/lib/edit-history.svelte.ts')
    const { keepingGroups, outputSvg, appliedGrouping } = await server.ssrLoadModule('/src/lib/edit.ts')
    const metrics = { pctDiff: 1, bytes: 10 }
    const traced = { params: {}, metrics, svg, shapes: hints }
    const item = { id: 'carry', name: 'c', status: 'done', chosen: 0, autoTuned: false, width: 200, height: 200, trials: [traced] }
    item.grouping = reviewed(svg)
    const original = item.grouping
    assert.equal(outputSvg(item), original.svg)

    const nudge = (cx) => {
      record(item, `nudge:${cx}`)
      return keepingGroups(item, () => {
        const current = item.trials[item.chosen]
        const edited = editShape(current.svg, current.shapes, 2, { cx, cy: 150 })
        const next = { ...current, svg: edited.svg, shapes: edited.hints, traceMethod: 'shapes-edited', sourceTrial: 0 }
        if (current.traceMethod === 'shapes-edited') item.trials = item.trials.map((trial, index) => index === item.chosen ? next : trial)
        else { item.trials = [...item.trials, next]; item.chosen = item.trials.length - 1 }
        return true
      })
    }
    assert.deepEqual(nudge(40), { result: true, groupsKept: true })
    const carried = item.grouping
    assert.notEqual(carried, original)
    assert.equal(appliedGrouping(item), carried)
    assert.equal(outputSvg(item).match(/<g /g).length, 4, 'the export still has the groups')
    assert.match(outputSvg(item), /<title>Sun<\/title>/)

    assert.equal(undo(item), true)
    assert.equal(item.grouping, original)
    assert.equal(outputSvg(item), original.svg)
    assert.equal(redo(item), true)
    assert.equal(item.grouping, carried)
    assert.equal(outputSvg(item), carried.svg)

    // An edit that changes the paths cannot carry the groups: they stay for the SVG they fit.
    record(item, 'detail')
    const lost = keepingGroups(item, () => {
      const current = item.trials[item.chosen]
      item.trials = item.trials.map((trial, index) => index === item.chosen ? { ...current, svg: current.svg.replace(/<path[^>]*fill="#3264dc"\/>\n/, '') } : trial)
    })
    assert.equal(lost.groupsKept, false)
    assert.equal(item.grouping, carried)
    assert.equal(appliedGrouping(item), undefined)
    assert.equal(undo(item), true)
    assert.equal(appliedGrouping(item), carried, 'undo brings the groups back')
  } finally { await server.close() }
})
