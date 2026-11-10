import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'

let viteServer
let apiPromise
async function loadApi() {
  if (!apiPromise) {
    viteServer = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
    apiPromise = viteServer.ssrLoadModule('/src/lib/engine/path-hypothesis-associations.ts')
  }
  return apiPromise
}
after(async () => { await viteServer?.close() })

test('path inventory keeps trace indices and inherited SVG paint context', async () => {
    const { inspectTracedSvgPaths } = await loadApi()
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="1" viewBox="0 0 8 1"><defs><clipPath id="clip"><path d="clip"/></clipPath></defs><g transform="translate(1 2)" clip-path="url(#clip)" opacity="0.5" fill="#123456"><path d="bottom"/><path d="top"/></g></svg>'
    const inventory = inspectTracedSvgPaths(svg)

    assert.equal(inventory.status, 'ready')
    assert.equal(inventory.totalSvgPaths, 3)
    assert.equal(inventory.paintedPaths, 2)
    assert.deepEqual(inventory.paths.map(({ pathIndex, definition, paintOrder }) => ({ pathIndex, definition, paintOrder })), [
      { pathIndex: 0, definition: true, paintOrder: null },
      { pathIndex: 1, definition: false, paintOrder: 0 },
      { pathIndex: 2, definition: false, paintOrder: 1 },
    ])
    assert.deepEqual(inventory.paths[1].transformChain, ['translate(1 2)'])
    assert.deepEqual(inventory.paths[1].clipPathIds, ['clip'])
    assert.equal(inventory.paths[1].fill, '#123456')
    assert.equal(inventory.paths[1].effectiveOpacity, 0.5)
})

test('path supports preserve clips, isolate paint elements and account for paint order and group opacity', async () => {
    const { associateTracedPathsToHypotheses, rasterizeTracedPathSupports } = await loadApi()
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="1" viewBox="0 0 8 1"><defs><clipPath id="clip"><path d="clip"/></clipPath></defs><g transform="translate(1 2)" clip-path="url(#clip)" opacity="0.5" fill="#123456"><path d="bottom"/><path d="top"/></g></svg>'
    const renderInputs = []
    const rasterize = async (isolated, width, height) => {
      renderInputs.push(isolated)
      const rgba = new Uint8ClampedArray(width * height * 4)
      const bottomVisible = /<path\b(?=[^>]*\bd="bottom")/.test(isolated)
      const topVisible = /<path\b(?=[^>]*\bd="top")/.test(isolated)
      const paint = bottomVisible ? [0, 4] : topVisible ? [3, 7] : null
      if (paint) for (let x = paint[0]; x <= paint[1]; x++) rgba[x * 4 + 3] = 255
      return { width, height, data: rgba }
    }
    const rasterized = await rasterizeTracedPathSupports(svg, rasterize, 8, 1)

    assert.equal(rasterized.status, 'ready')
    assert.equal(rasterized.diagnostics.rendererCalls, 2)
    assert.ok(renderInputs.every((input) => input.includes('<clipPath id="clip">')))
    assert.ok(renderInputs.every((input) => input.includes('clip-path="url(#clip)"')))
    assert.ok(renderInputs.every((input) => input.includes('transform="translate(1 2)"')))
    assert.ok(renderInputs.every((input) => input.includes('opacity="1"')))
    assert.ok(renderInputs.every((input) => !input.includes('visibility="hidden"')))
    assert.equal(renderInputs.filter((input) => input.includes('d="bottom"')).length, 1)
    assert.equal(renderInputs.filter((input) => input.includes('d="top"')).length, 1)
    assert.ok(renderInputs.every((input) => input.includes('d="clip"')), 'clip geometry remains available in defs')

    assert.deepEqual([...rasterized.supports[0].geometricSupport.data], [1, 1, 1, 1, 1, 0, 0, 0])
    assert.deepEqual([...rasterized.supports[1].geometricSupport.data], [0, 0, 0, 1, 1, 1, 1, 1])
    assert.deepEqual([...rasterized.supports[0].visibleSupport.data], [1, 1, 1, 0, 0, 0, 0, 0])
    assert.deepEqual([...rasterized.supports[1].visibleSupport.data], [0, 0, 0, 1, 1, 1, 1, 1])

    const mask = (pixels) => ({ width: 8, height: 1, data: Uint8Array.from(pixels) })
    const hypotheses = [
      { id: 'bottom-visible', mask: mask([1, 1, 1, 0, 0, 0, 0, 0]), maskMeaning: 'visible-object', source: { provider: 'fixture' } },
      { id: 'bottom-complete', mask: mask([1, 1, 1, 1, 1, 0, 0, 0]), maskMeaning: 'completed-object', source: { provider: 'fixture' } },
      { id: 'meaning-unknown', mask: mask([1, 1, 1, 0, 0, 0, 0, 0]), maskMeaning: 'unknown', source: { provider: 'fixture' } },
      { id: 'unrelated', mask: mask([0, 0, 0, 0, 0, 0, 0, 1]), maskMeaning: 'visible-object', source: { provider: 'fixture' } },
    ]
    const associated = associateTracedPathsToHypotheses(rasterized.supports, hypotheses)

    assert.equal(associated.edges.find((edge) => edge.pathId === 'trace-path-0001' && edge.hypothesisId === 'bottom-visible').status, 'supporting')
    assert.equal(associated.edges.find((edge) => edge.pathId === 'trace-path-0001' && edge.hypothesisId === 'bottom-complete').status, 'supporting')
    assert.equal(associated.edges.find((edge) => edge.pathId === 'trace-path-0001' && edge.hypothesisId === 'meaning-unknown').status, 'ambiguous')
    assert.equal(associated.edges.find((edge) => edge.pathId === 'trace-path-0001' && edge.hypothesisId === 'unrelated').status, 'unrelated')
    assert.equal(associated.hypotheses[0].pathAssociations[0].pathIndex, 1)
    assert.equal(hypotheses[0].pathAssociations, undefined, 'association does not mutate provider-owned hypotheses')
})

test('path association abstains on paint effects it cannot preserve safely', async () => {
    const { inspectTracedSvgPaths, rasterizeTracedPathSupports } = await loadApi()
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1" viewBox="0 0 1 1"><g style="mix-blend-mode:multiply"><path d="M0 0h1v1z" fill="#f00"/></g></svg>'
    const rootStyleSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1" viewBox="0 0 1 1" style="mix-blend-mode:multiply"><path d="M0 0h1v1z" fill="#f00"/></svg>'
    let rendererCalls = 0
    const inventory = inspectTracedSvgPaths(svg)
    const rasterized = await rasterizeTracedPathSupports(svg, async () => { rendererCalls++; throw new Error('must not render') }, 1, 1)
    const rootStyleInventory = inspectTracedSvgPaths(rootStyleSvg)

    assert.equal(inventory.status, 'unsupported')
    assert.equal(rasterized.status, 'abstained')
    assert.match(rasterized.reason, /unsupported paint attribute "style"/)
    assert.equal(rootStyleInventory.status, 'unsupported')
    assert.match(rootStyleInventory.reason, /unsupported paint attribute "style"/)
    assert.equal(rendererCalls, 0)
})
