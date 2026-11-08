import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { build } from 'esbuild'

const root = resolve('..')
const cli = resolve('dist/rastavec.cjs')
const fixture = resolve('../tests/fixtures/grouping-corpus/kenney-bear.png')
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' })

test('diff summary reports the location and size of visible pixel errors', async () => {
  const bundled = await build({
    stdin: { contents: `export { summarizeDiff } from './src/lib/engine/core'`, resolveDir: root },
    bundle: true, write: false, format: 'esm', platform: 'node',
  })
  const { summarizeDiff } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)
  const width = 16, height = 8
  const sourceData = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < sourceData.length; i += 4) sourceData.set([255, 255, 255, 255], i)
  const renderData = new Uint8ClampedArray(sourceData)
  renderData.set([0, 0, 0, 255], (1 * width + 14) * 4)

  const summary = summarizeDiff(
    { data: sourceData, width, height },
    { data: renderData, width, height },
  )
  assert.deepEqual(summary.gridPctDiff[1], [0, 0, 0, 0, 0, 0, 0, 50])
  assert.deepEqual(summary.hotspots, [{ x: 14, y: 1, width: 2, height: 1, pctDiff: 50, meanError: 127.5, maxError: 255, visiblePixels: 1 }])

  const transparent = new Uint8ClampedArray([255, 0, 0, 0])
  const alsoTransparent = new Uint8ClampedArray([0, 0, 0, 0])
  assert.equal(summarizeDiff({ data: transparent, width: 1, height: 1 }, { data: alsoTransparent, width: 1, height: 1 }, 1).hotspots.length, 0)
  assert.throws(() => summarizeDiff({ data: sourceData, width, height }, { data: renderData, width: 8, height: 16 }), /same dimensions/)
})

test('CLI writes and embeds the same compact diff summary', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rastavec-diff-summary-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const out = join(dir, 'out')
  const result = run('trace', fixture, '-o', out, '--no-auto', '--threshold', '100', '--diff-summary-json', '--json')
  assert.equal(result.status, 0, result.stderr)

  const report = JSON.parse(result.stdout)
  const item = report.items[0]
  assert.equal(item.diffSummary.gridSize, 8)
  assert.equal(item.diffSummaryPath, join(out, 'kenney-bear.diff.json'))
  assert.deepEqual(JSON.parse(readFileSync(item.diffSummaryPath, 'utf8')), item.diffSummary)
  assert.equal(item.diffSummary.width, item.width)
  assert.equal(item.diffSummary.height, item.height)
  assert.ok(item.diffSummary.hotspots.length > 0)
})
