import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import sharp from 'sharp'

test('CC0 pixel art retains its size and visible detail with a bounded vector', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rastavec-pixel-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const source = resolve('../tests/fixtures/pixel-art/sword.png')
  const cli = resolve('dist/rastavec.cjs')
  const run = (...args) => spawnSync(process.execPath, [cli, 'trace', source, '-o', ...args, '--json'], { encoding: 'utf8' })
  const result = run(dir, '--threshold', '2', '--max-size', '400')
  assert.equal(result.status, 0, result.stderr)
  const item = JSON.parse(result.stdout).items[0]
  assert.ok(item.metrics.pctDiff <= 2)
  assert.ok(item.metrics.bytes <= 400 * 1024)
  assert.ok(item.traceMethod === 'pixel-grid' || [2, 4].includes(item.traceScale))
  const svg = readFileSync(item.output)
  assert.doesNotMatch(svg.toString('utf8'), /<image\b/i)
  const actual = await sharp(svg).metadata(), original = await sharp(source).metadata()
  assert.equal(actual.width, original.width)
  assert.equal(actual.height, original.height)

  const constrained = run(join(dir, 'small'), '--threshold', '2', '--max-size', '2')
  assert.equal(constrained.status, 1, constrained.stderr)
  const fallback = JSON.parse(constrained.stdout).items[0]
  assert.equal(fallback.status, 'review')
  assert.equal(fallback.traceScale, 1)
  assert.equal(fallback.metrics.pctDiff, 0)
  assert.ok(fallback.metrics.bytes > 2 * 1024)
  assert.ok(readFileSync(fallback.output).length > 0, 'over-budget SVG is still written for review')
})
