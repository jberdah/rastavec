import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import sharp from 'sharp'

const cli = resolve('dist/rastavec.cjs')
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' })

// A flat logo saved as JPEG, or with sensor-like noise, used to be traced ripple by ripple:
// several times the paths and bytes of the clean logo for no gain in fidelity, and the noisy
// one was taken for a photo. Auto now cleans such images first (real engine, end to end).
const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="320" height="240" fill="#f4f1ea"/>
  <circle cx="110" cy="120" r="78" fill="#1f6fd1"/><rect x="150" y="60" width="130" height="120" rx="18" fill="#f2912d"/>
  <path d="M60 200 L160 40 L260 200 Z" fill="#6a4fb3"/><circle cx="160" cy="150" r="22" fill="#ffffff"/></svg>`

async function noisyPng(sigma, file) {
  const { data, info } = await sharp(Buffer.from(LOGO)).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  let s = 20261113
  const uniform = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) + 0.5) / 4294967296
  const out = Buffer.alloc(data.length)
  for (let i = 0; i < data.length; i++) out[i] = Math.max(0, Math.min(255, Math.round(data[i] + sigma * Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform()))))
  await sharp(out, { raw: { width: info.width, height: info.height, channels: 3 } }).png().toFile(file)
}

test('Auto traces a JPEG or noisy logo about like the clean one', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rastavec-auto-jpeg-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const inputs = join(dir, 'in')
  mkdirSync(inputs)
  await sharp(Buffer.from(LOGO)).png().toFile(join(inputs, 'clean.png'))
  await sharp(Buffer.from(LOGO)).jpeg({ quality: 92 }).toFile(join(inputs, 'q92.jpg'))
  await sharp(Buffer.from(LOGO)).jpeg({ quality: 75 }).toFile(join(inputs, 'q75.jpg'))
  await sharp(Buffer.from(LOGO)).jpeg({ quality: 40 }).toFile(join(inputs, 'q40.jpg'))
  await noisyPng(5, join(inputs, 'noise5.png'))

  const out = join(dir, 'out')
  const result = run('trace', inputs, '--out', out, '--json')
  assert.equal(result.status, 0, result.stderr || result.stdout)
  const items = Object.fromEntries(JSON.parse(result.stdout).items.map((item) => [item.name, item]))
  const clean = items.clean
  assert.equal(clean.analysis.kind, 'flat')
  assert.equal(clean.analysis.cleanup, undefined)
  assert.ok(!clean.notes.includes('cleaned'))

  // Paths allowed relative to the clean trace: low quality leaves a few specks.
  for (const [name, factor] of [['q92', 2], ['q75', 2], ['q40', 5], ['noise5', 2]]) {
    const item = items[name]
    assert.ok(item.analysis.cleanup, `${name}: not detected as degraded`)
    assert.ok(item.notes.includes('cleaned'), name)
    assert.equal(item.analysis.kind, 'flat', name)
    assert.ok(item.metrics.paths <= clean.metrics.paths * factor + 4, `${name}: ${item.metrics.paths} paths, clean ${clean.metrics.paths}`)
    assert.ok(item.metrics.bytes <= clean.metrics.bytes * factor + 1024, `${name}: ${item.metrics.bytes} bytes, clean ${clean.metrics.bytes}`)
    assert.ok(item.metrics.pctDiff < 1.5, `${name}: ${item.metrics.pctDiff}% from the cleaned image`)
    assert.match(readFileSync(join(out, `${name}.svg`), 'utf8'), /^<svg\b/)
  }
  assert.ok(Math.abs(items.noise5.analysis.cleanup.sigma - 5) < 1.5, `sigma ${items.noise5.analysis.cleanup.sigma}`)
})

test('a chosen preset traces a JPEG as given', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rastavec-auto-jpeg-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const input = join(dir, 'q75.jpg')
  await sharp(Buffer.from(LOGO)).jpeg({ quality: 75 }).toFile(input)
  const result = run('trace', input, '--preset', 'flat', '--out', join(dir, 'out'), '--json')
  assert.equal(result.status, 0, result.stderr || result.stdout)
  const item = JSON.parse(result.stdout).items[0]
  assert.ok(!item.notes.includes('cleaned'))
})
