import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import sharp from 'sharp'

const cli = resolve('dist/rastavec.cjs')
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' })

test('CLI uses Next and preserves a translucent fill around a small transparent hole', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rastavec-next-alpha-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const input = join(dir, 'input.png')
  const out = join(dir, 'out')
  mkdirSync(out)

  const width = 32, height = 32
  const pixels = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 4
    pixels.set([220, 40, 30, x >= 15 && x < 18 && y >= 15 && y < 18 ? 0 : 64], offset)
  }
  await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toFile(input)

  const result = run('trace', input, '--preset', 'shaded', '--no-auto', '--out', out, '--json')
  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.engine, 'VTracer-Next')
  assert.equal(report.traceEngine, 'next')
  assert.equal(report.experimentalGradients, false)
  assert.equal(report.summary.errors, 0)
  assert.ok(report.items[0].metrics.alphaDiff < 1, `alpha difference was ${report.items[0].metrics.alphaDiff}`)

  const svg = readFileSync(join(out, 'input.svg'))
  const rendered = await sharp(svg).resize(width, height).ensureAlpha().raw().toBuffer()
  assert.equal(rendered[(8 * width + 8) * 4 + 3], 64, 'the solid region should retain its source alpha')
  assert.equal(rendered[(16 * width + 16) * 4 + 3], 0, 'the interior transparent hole should stay transparent')
})

test('the CLI gradient flag controls color fitting and preserves engine provenance', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rastavec-next-gradients-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const input = join(dir, 'ramp.png')
  const width = 96, height = 48
  const pixels = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const fraction = x / (width - 1)
    pixels.set([Math.round(20 + 200 * fraction), 100, Math.round(210 - 180 * fraction), 255], (y * width + x) * 4)
  }
  await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toFile(input)

  const color = ['--preset', 'shaded', '--color-precision', '8', '--layer-difference', '12', '--speckle', '0']
  const scenarios = [
    { name: 'default', flags: color, gradients: false },
    { name: 'gradient', flags: [...color, '--gradients'], gradients: true },
    { name: 'line', flags: ['--preset', 'line', '--gradients'], gradients: false },
    { name: 'binary', flags: ['--binary', '--gradients'], gradients: false },
  ]
  for (const { name, flags, gradients } of scenarios) {
    const out = join(dir, name)
    const result = run('trace', input, '--no-auto', '--threshold', '100', '--out', out, '--json', ...flags)
    assert.equal(result.status, 0, `${name}: ${result.stderr}`)
    const report = JSON.parse(result.stdout)
    assert.deepEqual(report, JSON.parse(readFileSync(join(out, 'report.json'), 'utf8')))
    assert.equal(report.engine, 'VTracer-Next', name)
    assert.equal(report.traceEngine, 'next', name)
    assert.equal(report.experimentalGradients, gradients, name)
    const svg = readFileSync(join(out, 'ramp.svg'), 'utf8')
    assert.equal(/<linearGradient\b/.test(svg), gradients, name)
  }

  const analyze = run('analyze', input, '--gradients')
  assert.equal(analyze.status, 2)
  assert.match(analyze.stderr, /--gradients is available for trace/)
})

test('Auto recovers a shaded landscape with weak gradient-analysis signal', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rastavec-auto-landscape-gradients-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const input = join(dir, 'landscape.png')
  const width = 256, height = 241
  const pixels = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let color
    if (y < 125) {
      color = [45 + Math.floor(x / 4) + Math.floor(y / 4), 105 + Math.floor(y / 5), 190 - Math.floor(y / 6)]
    } else {
      const mountainRidge = 132 + Math.floor(22 * Math.sin(x / 31)) + Math.floor(x / 16)
      if (y < mountainRidge) color = [105 + Math.floor(y / 5), 112 + Math.floor(y / 6), 120 + Math.floor(y / 8)]
      else if (y < 185 + Math.floor(12 * Math.sin(x / 37))) color = [55 + Math.floor(y / 8), 115 + Math.floor(y / 7), 62 + Math.floor(y / 9)]
      else color = [35 + Math.floor(y / 9), 92 + Math.floor(y / 8), 42 + Math.floor(y / 10)]
    }
    pixels.set([...color, 255], (y * width + x) * 4)
  }
  await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toFile(input)

  const settings = ['--preset', 'auto', '--threshold', '100', '--max-size', '400']
  const baselineOut = join(dir, 'baseline')
  const baselineRun = run('trace', input, '--no-auto', ...settings, '--out', baselineOut, '--json')
  assert.equal(baselineRun.status, 0, baselineRun.stderr)
  const baseline = JSON.parse(baselineRun.stdout).items[0]
  assert.equal(baseline.analysis.kind, 'shaded')
  assert.equal(baseline.analysis.alpha, 'opaque')
  assert.ok(baseline.analysis.gradient < 0.16, `analysis gradient was ${baseline.analysis.gradient}`)

  const autoOut = join(dir, 'auto')
  const autoRun = run('trace', input, ...settings, '--out', autoOut, '--json')
  assert.equal(autoRun.status, 0, autoRun.stderr)
  const auto = JSON.parse(autoRun.stdout).items[0]
  assert.equal(auto.traceMethod, 'experimental-gradients')
  assert.ok(auto.metrics.pctDiff < baseline.metrics.pctDiff * 0.03,
    `gradient Auto error ${auto.metrics.pctDiff}% should be under 3% of baseline ${baseline.metrics.pctDiff}%`)
  assert.match(readFileSync(auto.output, 'utf8'), /<linearGradient\b/)
})
