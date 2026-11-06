// Synthetic reference corpus. Fixtures are generated in a private temporary directory;
// no user artwork, network access, or visual quality threshold is needed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import sharp from 'sharp'

const cli = resolve('dist/rastavec.cjs')
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' })

const svg = (body, width = 128, height = 128) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${body}</svg>`

async function writeCorpus(dir) {
  const fixtures = {
    transparent: svg(''),
    logo: svg('<circle cx="64" cy="64" r="45" fill="#147d42"/><path d="M40 64h48M64 40v48" stroke="white" stroke-width="8"/>'),
    small_shapes: svg('<rect x="20" y="20" width="8" height="8" fill="#d82028"/><rect x="80" y="80" width="10" height="10" fill="#2049cc"/>'),
    gradient: svg('<defs><linearGradient id="g"><stop stop-color="#f33"/><stop offset="1" stop-color="#238"/></linearGradient></defs><rect x="8" y="8" width="112" height="112" fill="url(#g)"/>'),
    sheet: svg('<rect x="30" y="50" width="70" height="80" fill="red"/><circle cx="300" cy="90" r="45" fill="blue"/>', 400, 200),
  }
  for (const [name, content] of Object.entries(fixtures)) await sharp(Buffer.from(content)).png().toFile(join(dir, `${name}.png`))
  return Object.keys(fixtures)
}

test('synthetic corpus traces to valid repeatable SVGs with consistent reports', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rastavec-corpus-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const input = join(dir, 'input'), out1 = join(dir, 'first'), out2 = join(dir, 'second')
  mkdirSync(input)
  const names = await writeCorpus(input)
  const invoke = (out) => run('trace', input, '-o', out, '--no-auto', '--threshold', '100', '--max-size', '100000', '--json')
  const first = invoke(out1), second = invoke(out2)
  assert.equal(first.status, 0, first.stderr)
  assert.equal(second.status, 0, second.stderr)
  const report = JSON.parse(first.stdout)
  assert.equal(report.summary.total, names.length)
  assert.equal(report.summary.errors, 0)
  assert.deepEqual(new Set(report.items.map((item) => item.name)), new Set(names))
  for (const item of report.items) {
    const data = readFileSync(join(out1, `${item.name}.svg`))
    assert.deepEqual(data, readFileSync(join(out2, `${item.name}.svg`)), `${item.name} is not repeatable`)
    const markup = data.toString('utf8')
    assert.match(markup, /<svg\b/)
    assert.doesNotMatch(markup, /<image\b/i)
    const metadata = await sharp(data).metadata()
    assert.equal(metadata.width, item.width)
    assert.equal(metadata.height, item.height)
    assert.equal(item.metrics.bytes, data.length)
    assert.equal(item.metrics.embeddedRaster, false)
    assert.ok(Number.isFinite(item.metrics.pctDiff) && item.metrics.pctDiff >= 0 && item.metrics.pctDiff <= 100)
  }
})

test('synthetic sheet produces two readable, bounded elements', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rastavec-corpus-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  await writeCorpus(dir)
  const out = join(dir, 'slices')
  const result = run('slice', join(dir, 'sheet.png'), '-o', out, '--json')
  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.elements.length, 2)
  for (const part of report.elements) {
    assert.ok(part.x >= 0 && part.y >= 0 && part.w > 0 && part.h > 0)
    assert.ok(part.x + part.w <= 400 && part.y + part.h <= 200)
    const metadata = await sharp(part.path).metadata()
    assert.equal(metadata.width, part.w)
    assert.equal(metadata.height, part.h)
  }
})
