import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, linkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import sharp from 'sharp'

const cli = resolve('dist/rastavec.cjs')
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' })
const png = async (path, color = '#ff0000') => sharp({ create: { width: 32, height: 32, channels: 4, background: color } }).png().toFile(path)
const fixture = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rastavec-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('trace assigns distinct output names even when suffixes already exist', async (t) => {
  const dir = fixture(t), out = join(dir, 'out')
  mkdirSync(join(dir, 'other'))
  await png(join(dir, 'a.png'))
  await png(join(dir, 'other', 'a.png'), '#0000ff')
  await png(join(dir, 'a-2.png'), '#00ff00')
  const r = run('trace', join(dir, 'a.png'), join(dir, 'other', 'a.png'), join(dir, 'a-2.png'), '-o', out, '--no-auto', '--threshold', '100', '--json')
  assert.equal(r.status, 0, r.stderr)
  const report = JSON.parse(r.stdout)
  assert.equal(new Set(report.items.map((i) => i.output.toLowerCase())).size, 3)
  for (const item of report.items) assert.ok(existsSync(item.output))
})

test('trace refuses report and comparison clashes before writing any output', async (t) => {
  const dir = fixture(t), out = join(dir, 'out'), input = join(dir, 'a.png')
  await png(input)
  mkdirSync(out)
  for (const file of ['report.json', 'a.comparison.png', 'a.diff.png']) {
    const target = join(out, file)
    writeFileSync(target, 'previous content')
    const r = run('trace', input, '-o', out, '--compare', '--no-auto')
    assert.equal(r.status, 2, `${file}: ${r.stderr}`)
    assert.equal(readFileSync(target, 'utf8'), 'previous content')
    assert.equal(existsSync(join(out, 'a.svg')), false)
    rmSync(target)
  }
})

test('trace never overwrites another input even with --force', async (t) => {
  const dir = fixture(t), first = join(dir, 'a.png'), second = join(dir, 'a.comparison.png')
  await png(first)
  await png(second, '#0000ff')
  const original = readFileSync(second)
  const r = run('trace', first, second, '-o', dir, '--compare', '--force', '--no-auto')
  assert.equal(r.status, 2, r.stdout)
  assert.match(r.stderr, /overwrite an input/i)
  assert.deepEqual(readFileSync(second), original)
  assert.equal(existsSync(join(dir, 'a.svg')), false)
})

test('empty sheet fails instead of reporting a successful empty trace or slice', async (t) => {
  const dir = fixture(t), input = join(dir, 'empty.png')
  await sharp({ create: { width: 80, height: 80, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toFile(input)
  for (const args of [['trace', input, '--slice'], ['slice', input]]) {
    const out = join(dir, args[0])
    const r = run(...args, '-o', out, '--json')
    assert.equal(r.status, 2, r.stdout)
    assert.match(r.stderr, /no elements found/i)
    assert.equal(existsSync(out), false)
  }
})

test('slice checks all destination files before creating any', async (t) => {
  const dir = fixture(t), out = join(dir, 'out'), input = join(dir, 'sheet.png')
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect x="30" y="50" width="70" height="80" fill="red"/><circle cx="300" cy="90" r="45" fill="blue"/></svg>'
  await sharp(Buffer.from(svg)).png().toFile(input)
  mkdirSync(out)
  writeFileSync(join(out, 'sheet-02.png'), 'previous content')
  const r = run('slice', input, '-o', out)
  assert.equal(r.status, 2, r.stderr)
  assert.equal(existsSync(join(out, 'sheet-01.png')), false)
  assert.equal(readFileSync(join(out, 'sheet-02.png'), 'utf8'), 'previous content')
})

test('slice refuses an output hard-linked to its source even with --force', async (t) => {
  const dir = fixture(t), out = join(dir, 'out'), input = join(dir, 'sheet.png')
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect x="30" y="50" width="70" height="80" fill="red"/><circle cx="300" cy="90" r="45" fill="blue"/></svg>'
  await sharp(Buffer.from(svg)).png().toFile(input)
  mkdirSync(out)
  try { linkSync(input, join(out, 'sheet-01.png')) } catch (err) { t.skip(`hard links unavailable: ${err.message}`); return }
  const original = readFileSync(input)
  const r = run('slice', input, '-o', out, '--force')
  assert.equal(r.status, 2, r.stdout)
  assert.match(r.stderr, /overwrite an input/i)
  assert.deepEqual(readFileSync(input), original)
})
