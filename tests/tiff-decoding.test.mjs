import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import UTIF from 'utif2'
import { decodeTiff, isTiffBlob, isTiffHeader, orient } from '../src/lib/engine/tiff.js'

// sharp is installed for the CLI; use it to write TIFFs with real-world compressions.
let sharp = null
try { sharp = createRequire(new URL('../cli/package.json', import.meta.url))('sharp') } catch {}

const W = 4
const H = 3
/** Distinct opaque colour per pixel so orientation and channel order errors are visible. */
function pattern() {
  const data = new Uint8Array(W * H * 4)
  for (let i = 0; i < W * H; i++) data.set([i * 20, 255 - i * 15, (i * 37) % 256, 255], i * 4)
  return data
}
const toArrayBuffer = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
const px = (img, x, y) => Array.from(img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 4))

test('TIFF signatures are recognised in both byte orders', async () => {
  assert.equal(isTiffHeader(new Uint8Array([0x49, 0x49, 0x2a, 0x00])), true)
  assert.equal(isTiffHeader(new Uint8Array([0x4d, 0x4d, 0x00, 0x2a])), true)
  assert.equal(isTiffHeader(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), false)
  assert.equal(isTiffHeader(new Uint8Array([0x42, 0x4d])), false)
  assert.equal(await isTiffBlob(new Blob([new Uint8Array([0x4d, 0x4d, 0x00, 0x2a, 0])])), true)
  assert.equal(await isTiffBlob(new Blob([new Uint8Array([0x42, 0x4d, 0, 0])])), false)
})

test('uncompressed straight-alpha RGBA decodes exactly', async () => {
  const src = pattern()
  src[3] = 128 // one translucent pixel must keep its colour
  const img = await decodeTiff(UTIF.encodeImage(src, W, H, { t338: [2] }))
  assert.equal(img.width, W)
  assert.equal(img.height, H)
  assert.deepEqual(Array.from(img.data), Array.from(src))
})

test('premultiplied (associated) alpha is converted to straight alpha', async () => {
  const src = new Uint8Array(W * H * 4).fill(255)
  src.set([100, 50, 0, 128], 0) // premultiplied of ~(199, 100, 0) at alpha 128
  const img = await decodeTiff(UTIF.encodeImage(src, W, H, { t338: [1] }))
  assert.deepEqual(px(img, 0, 0), [199, 100, 0, 128])
})

test('orientation tag is applied', async () => {
  const src = pattern()
  const rotated = await decodeTiff(UTIF.encodeImage(src, W, H, { t338: [2], t274: [6] }))
  assert.equal(rotated.width, H)
  assert.equal(rotated.height, W)
  // Rotate 90° clockwise: source bottom-left lands at the top-left.
  assert.deepEqual(px(rotated, 0, 0), Array.from(src.slice(((H - 1) * W) * 4, ((H - 1) * W) * 4 + 4)))
  // All eight orientations are permutations that preserve every pixel.
  const base = { data: new Uint8ClampedArray(src), width: W, height: H }
  for (let o = 1; o <= 8; o++) {
    const out = orient(base, o)
    assert.deepEqual(Array.from(out.data).sort(), Array.from(src).sort(), `orientation ${o}`)
    assert.equal(out.width * out.height, W * H)
  }
})

test('BigTIFF and corrupt files report actionable errors', async () => {
  await assert.rejects(decodeTiff(new Uint8Array([0x49, 0x49, 0x2b, 0x00, 8, 0, 0, 0]).buffer), /BigTIFF/)
  await assert.rejects(decodeTiff(new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer), /not a TIFF/)
  await assert.rejects(decodeTiff(new Uint8Array([0x49, 0x49, 0x2a, 0x00, 0xff, 0xff, 0xff, 0x0f]).buffer))
})

test('oversized TIFF is rejected before pixel decoding', async () => {
  await assert.rejects(decodeTiff(UTIF.encodeImage(new Uint8Array(4), 1, 1, { t256: [20000], t257: [20000] })), /megapixels|16,384/)
})

for (const compression of ['lzw', 'deflate', 'none']) {
  test(`sharp-written ${compression} RGBA TIFF matches its source`, { skip: !sharp && 'sharp not installed' }, async () => {
    const src = pattern()
    src[7] = 0 // a fully transparent pixel
    const tiff = await sharp(Buffer.from(src), { raw: { width: W, height: H, channels: 4 } }).tiff({ compression }).toBuffer()
    const img = await decodeTiff(toArrayBuffer(tiff))
    assert.deepEqual([img.width, img.height], [W, H])
    for (let i = 0; i < W * H; i++) {
      if (src[i * 4 + 3] === 0) { assert.equal(img.data[i * 4 + 3], 0); continue }
      assert.deepEqual(Array.from(img.data.slice(i * 4, i * 4 + 4)), Array.from(src.slice(i * 4, i * 4 + 4)), `pixel ${i}`)
    }
  })
}

test('sharp-written JPEG-compressed and 16-bit TIFFs decode to close colours', { skip: !sharp && 'sharp not installed' }, async () => {
  const flat = Buffer.alloc(16 * 16 * 3)
  for (let i = 0; i < 16 * 16; i++) flat.set([200, 40, 90], i * 3)
  const jpeg = await sharp(flat, { raw: { width: 16, height: 16, channels: 3 } }).tiff({ compression: 'jpeg', quality: 95 }).toBuffer()
  const deep = await sharp(flat, { raw: { width: 16, height: 16, channels: 3 } }).toColourspace('rgb16').tiff({ compression: 'lzw' }).toBuffer()
  for (const [label, buf] of [['jpeg', jpeg], ['16-bit', deep]]) {
    const img = await decodeTiff(toArrayBuffer(buf))
    assert.deepEqual([img.width, img.height], [16, 16], label)
    const [r, g, b, a] = px(img, 8, 8)
    assert.ok(Math.abs(r - 200) <= 4 && Math.abs(g - 40) <= 4 && Math.abs(b - 90) <= 4 && a === 255, `${label}: ${[r, g, b, a]}`)
  }
})
