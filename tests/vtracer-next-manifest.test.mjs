import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describeVTracerNext, verifyVTracerNext } from '../scripts/verify-vtracer-next.mjs'

test('checked-in VTracer-Next artifact manifest has exact inputs and files', () => {
  assert.doesNotThrow(() => verifyVTracerNext())
})

test('VTracer-Next artifact inspection rejects missing and extra WASM files', () => {
  const root = mkdtempSync(join(tmpdir(), 'rastavec-vtracer-manifest-'))
  try {
    const missing = join(root, 'missing')
    const extra = join(root, 'extra')
    mkdirSync(missing)
    mkdirSync(extra)
    writeFileSync(join(extra, 'unexpected.wasm'), new Uint8Array())

    assert.throws(
      () => describeVTracerNext(pathToFileURL(missing + sep)),
      /WASM artifact set mismatch.*Missing: vtracer_next_bg\.wasm/,
    )
    assert.throws(
      () => describeVTracerNext(pathToFileURL(extra + sep)),
      /WASM artifact set mismatch.*extra: unexpected\.wasm/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
