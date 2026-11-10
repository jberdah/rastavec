import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { resolve } from 'node:path'

const bundle = await build({
  stdin: { contents: `export { recommendObjectRoute } from './src/lib/engine/object-route-planner.ts'`, resolveDir: resolve('.'), sourcefile: 'object-route-planner-entry.ts' },
  bundle: true, write: false, format: 'esm', platform: 'node',
})
const { recommendObjectRoute } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)

test('the specialist router selects a low-residual three-circle route for review', () => {
  const decision = recommendObjectRoute([
    { provider: 'circle-visible-arc-fit', status: 'proposed', diagnostics: { relativeRadialRms: [0.001, 0.002, 0.004], boundaryArcCoverageDegrees: [205, 192, 210], minimumBoundaryArcCoverageDegrees: 150, backgroundBorderSupportFraction: 1, backgroundCornerSupportCount: 4 } },
    { provider: 'planar-color-adjacency', status: 'proposed', diagnostics: { paintFit: { bestRmse: 70 }, graph: { isTree: false } } },
  ])
  assert.equal(decision.status, 'selected-for-review')
  assert.equal(decision.selectedProvider, 'circle-visible-arc-fit')
  assert.equal(decision.humanReviewRequired, true)
})

test('the router reuses the planar compositing gate and keeps competing specialist routes unresolved', () => {
  const planar = recommendObjectRoute([
    { provider: 'planar-color-adjacency', status: 'proposed', diagnostics: { paintFit: { bestRmse: 9.99 }, graph: { isTree: false } } },
  ])
  assert.equal(planar.selectedProvider, 'planar-color-adjacency')

  const competing = recommendObjectRoute([
    { provider: 'circle-visible-arc-fit', status: 'proposed', diagnostics: { relativeRadialRms: [0.001, 0.002, 0.003], boundaryArcCoverageDegrees: [205, 192, 210], minimumBoundaryArcCoverageDegrees: 150, backgroundBorderSupportFraction: 1, backgroundCornerSupportCount: 4 } },
    { provider: 'planar-color-adjacency', status: 'proposed', diagnostics: { paintFit: { bestRmse: 2 }, graph: { isTree: false } } },
  ])
  assert.equal(competing.status, 'competing-specialists')
  assert.equal(competing.selectedProvider, null)
})

test('the router falls back to visible masks when specialized evidence fails', () => {
  const decision = recommendObjectRoute([
    { provider: 'circle-visible-arc-fit', status: 'proposed', diagnostics: { relativeRadialRms: [0.001, 0.002, 0.003], boundaryArcCoverageDegrees: [205, 149, 210], minimumBoundaryArcCoverageDegrees: 150, backgroundBorderSupportFraction: 1, backgroundCornerSupportCount: 4 } },
    { provider: 'planar-color-adjacency', status: 'abstained' },
    { provider: 'visible-connected-components', status: 'proposed', hypotheses: [{}] },
  ])
  assert.equal(decision.status, 'fallback-for-review')
  assert.equal(decision.selectedProvider, 'visible-connected-components')
})

test('the router rejects low-residual circle fits without adequate exposed-arc coverage', () => {
  const decision = recommendObjectRoute([
    { provider: 'circle-visible-arc-fit', status: 'proposed', diagnostics: { relativeRadialRms: [0.001, 0.002, 0.003], boundaryArcCoverageDegrees: [205, 149, 210], minimumBoundaryArcCoverageDegrees: 150, backgroundBorderSupportFraction: 1, backgroundCornerSupportCount: 4 } },
    { provider: 'visible-connected-components', status: 'proposed', hypotheses: [{}] },
  ])
  assert.equal(decision.status, 'fallback-for-review')
  assert.equal(decision.selectedProvider, 'visible-connected-components')
  assert.equal(decision.assessments.find(({ provider }) => provider === 'circle-visible-arc-fit')?.eligible, false)
})

test('the router rejects circle hypotheses without reliable border and corner background evidence', () => {
  const decision = recommendObjectRoute([
    { provider: 'circle-visible-arc-fit', status: 'proposed', diagnostics: { relativeRadialRms: [0.001, 0.002, 0.003], boundaryArcCoverageDegrees: [205, 192, 210], minimumBoundaryArcCoverageDegrees: 150, backgroundBorderSupportFraction: 0.72, backgroundCornerSupportCount: 3 } },
    { provider: 'visible-connected-components', status: 'proposed', hypotheses: [{}] },
  ])
  assert.equal(decision.status, 'fallback-for-review')
  assert.equal(decision.selectedProvider, 'visible-connected-components')
  assert.equal(decision.assessments.find(({ provider }) => provider === 'circle-visible-arc-fit')?.eligible, false)
})

test('the router enforces its 150-degree circle floor when a candidate reports a lower minimum', () => {
  const decision = recommendObjectRoute([
    { provider: 'circle-visible-arc-fit', status: 'proposed', diagnostics: { relativeRadialRms: [0.001, 0.002, 0.003], boundaryArcCoverageDegrees: [205, 120, 210], minimumBoundaryArcCoverageDegrees: 120, backgroundBorderSupportFraction: 1, backgroundCornerSupportCount: 4 } },
    { provider: 'visible-connected-components', status: 'proposed', hypotheses: [{}] },
  ])
  assert.equal(decision.status, 'fallback-for-review')
  assert.equal(decision.selectedProvider, 'visible-connected-components')
  const circle = decision.assessments.find(({ provider }) => provider === 'circle-visible-arc-fit')
  assert.equal(circle?.eligible, false)
  assert.match(circle?.basis ?? '', /below the 150\.0° gate/)
})

test('MobileSAM is a visible-mask fallback only when enabled', () => {
  const candidates = [
    { provider: 'mobile-sam', status: 'proposed', hypotheses: [{}] },
    { provider: 'visible-connected-components', status: 'proposed', hypotheses: [{}] },
  ]
  assert.equal(recommendObjectRoute(candidates, true).selectedProvider, 'mobile-sam')
  assert.equal(recommendObjectRoute(candidates, false).selectedProvider, 'visible-connected-components')
})
