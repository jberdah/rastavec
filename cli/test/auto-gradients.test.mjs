import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import sharp from 'sharp'

const cli = resolve('dist/rastavec.cjs')
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' })

// Gentle, clean gradients (few 12-bit colours, sub-threshold per-pixel steps) used to come out as
// one flat fill: the gradient trials were skipped (analysed as flat) or rejected by the engine
// (run over the cutout mosaic picked by the hierarchy review).
const cases = [
  {
    name: 'linear-rounded-rect',
    gradient: 'linearGradient',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="180">
      <defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#e08a68"/><stop offset="1" stop-color="#e9b48e"/></linearGradient></defs>
      <rect x="20" y="30" width="200" height="120" rx="24" fill="url(#g)"/></svg>`,
  },
  {
    name: 'radial-glow-opaque',
    gradient: 'radialGradient',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="150">
      <defs><radialGradient id="g"><stop offset="0" stop-color="#c8a0a0"/><stop offset="1" stop-color="#905a88"/></radialGradient></defs>
      <rect width="200" height="150" fill="#17202c"/><ellipse cx="100" cy="75" rx="80" ry="60" fill="url(#g)"/></svg>`,
  },
]

for (const c of cases) {
  test(`Auto keeps a clean ${c.name} as an SVG gradient`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'rastavec-auto-gradient-'))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    const input = join(dir, `${c.name}.png`)
    const out = join(dir, 'out')
    mkdirSync(out)
    await sharp(Buffer.from(c.svg)).png().toFile(input)

    const result = run('trace', input, '--out', out, '--json')
    assert.equal(result.status, 0, result.stderr || result.stdout)
    const item = JSON.parse(result.stdout).items[0]
    assert.match(item.traceMethod, /gradients/, `chose ${item.traceMethod} (${item.analysis.kind}/${item.analysis.alpha})`)
    assert.ok(item.metrics.pctDiff < 1, `visible difference was ${item.metrics.pctDiff}%`)
    assert.match(readFileSync(join(out, `${c.name}.svg`), 'utf8'), new RegExp(`<${c.gradient}\\b`))
  })
}

test('Auto keeps flat artwork free of gradients', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rastavec-auto-flat-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const input = join(dir, 'flat.png')
  const out = join(dir, 'out')
  mkdirSync(out)
  await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="240" height="180">
    <rect width="240" height="180" fill="#f4f5f9"/><circle cx="90" cy="90" r="60" fill="#7350b8"/>
    <rect x="110" y="40" width="100" height="90" rx="12" fill="#e9875a" fill-opacity=".8"/></svg>`)).png().toFile(input)

  const result = run('trace', input, '--out', out, '--json')
  assert.equal(result.status, 0, result.stderr || result.stdout)
  const item = JSON.parse(result.stdout).items[0]
  assert.equal(item.analysis.kind, 'flat')
  assert.doesNotMatch(readFileSync(join(out, 'flat.svg'), 'utf8'), /Gradient\b/)
})
