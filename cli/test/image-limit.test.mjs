import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import sharp from 'sharp'

const cli = resolve('dist/rastavec.cjs')
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' })

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

test('oversized PNG headers are rejected before image decoding in every command', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rastavec-size-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const buf = await sharp({ create: { width: 1, height: 1, channels: 4, background: '#f00' } }).png().toBuffer()
  buf.writeUInt32BE(8001, 16); buf.writeUInt32BE(5000, 20)
  buf.writeUInt32BE(crc32(buf.subarray(12, 29)), 29)
  const input = join(dir, 'large.png')
  writeFileSync(input, buf)
  for (const args of [['analyze', input], ['trace', input], ['slice', input], ['trace', input, '--slice']]) {
    const out = join(dir, args.join('-').replace(/[^a-z-]/gi, '_'))
    const r = run(...args, '-o', out, '--json')
    assert.equal(r.status, 2, `${args[0]}: ${r.stderr} ${r.stdout}`)
    assert.match(r.stdout + r.stderr, /8001×5000.*40,000,000-pixel.*16,384-pixel side limit/)
  }
  buf.writeUInt32BE(16385, 16); buf.writeUInt32BE(1, 20)
  buf.writeUInt32BE(crc32(buf.subarray(12, 29)), 29)
  writeFileSync(input, buf)
  const r = run('analyze', input, '--json')
  assert.equal(r.status, 2, r.stdout)
  assert.match(r.stdout, /16385×1.*16,384-pixel side limit/)
})
