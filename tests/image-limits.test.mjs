import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_IMAGE_BYTES, validateImageBytes, validateImageDimensions } from '../src/lib/engine/image-limits.js'

test('file size boundaries produce an actionable error', () => {
  assert.doesNotThrow(() => validateImageBytes(MAX_IMAGE_BYTES))
  assert.throws(() => validateImageBytes(MAX_IMAGE_BYTES + 1), /64 MiB/)
})
test('dimensions enforce both pixel count and side length', () => {
  assert.doesNotThrow(() => validateImageDimensions(8000, 5000))
  assert.doesNotThrow(() => validateImageDimensions(16384, 1))
  assert.throws(() => validateImageDimensions(8001, 5000), /40 megapixels/)
  assert.throws(() => validateImageDimensions(16385, 1), /16,384/)
  for (const value of [0, -1, NaN, Infinity, 1.5]) assert.throws(() => validateImageDimensions(value, 1), /invalid/)
})

test('decode checks dimensions before bitmap allocation and rechecks the bitmap', async () => {
  const { createServer } = await import('vite')
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
  const old = { Image: globalThis.Image, createImageBitmap: globalThis.createImageBitmap, create: URL.createObjectURL, revoke: URL.revokeObjectURL }
  let bitmapCalls = 0, bitmapClosed = 0, revoked = 0, width = 20000, bitmapWidth = 1
  try {
    globalThis.Image = class {
      naturalWidth = width
      naturalHeight = 1
      set src(value) { queueMicrotask(() => this.onload()) }
    }
    URL.createObjectURL = () => 'blob:fake'
    URL.revokeObjectURL = () => { revoked++ }
    globalThis.createImageBitmap = async () => { bitmapCalls++; return { width: bitmapWidth, height: 1, close() { bitmapClosed++ } } }
    const { decodeFile } = await server.ssrLoadModule('/src/lib/engine/browser-backend.ts')
    // decodeFile sniffs the signature to route TIFF, so pass a real (non-TIFF) file.
    const png = () => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'x.png', { type: 'image/png' })
    await assert.rejects(() => decodeFile(png()), /16,384/)
    assert.equal(bitmapCalls, 0)
    assert.equal(revoked, 1)
    width = 100
    bitmapWidth = 20000
    await assert.rejects(() => decodeFile(png()), /16,384/)
    assert.equal(bitmapCalls, 1)
    assert.equal(bitmapClosed, 1)
    assert.equal(revoked, 2)
  } finally {
    globalThis.Image = old.Image
    globalThis.createImageBitmap = old.createImageBitmap
    URL.createObjectURL = old.create
    URL.revokeObjectURL = old.revoke
    await server.close()
  }
})
