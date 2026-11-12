// TIFF decoding for the browser editor.
// Chromium (web and Windows WebView2) and Firefox cannot decode TIFF natively, so the editor reads it
// with UTIF (loaded on demand, only when a TIFF is opened). The first full-resolution page is used.
import { validateImageDimensions } from './image-limits.js'

/** @typedef {{ data: Uint8ClampedArray, width: number, height: number }} TiffImage */

/** True for the classic little-endian ("II*\0") and big-endian ("MM\0*") TIFF signatures. */
export function isTiffHeader(/** @type {Uint8Array} */ head) {
  if (head.length < 4) return false
  return (head[0] === 0x49 && head[1] === 0x49 && head[2] === 0x2a && head[3] === 0x00) ||
    (head[0] === 0x4d && head[1] === 0x4d && head[2] === 0x00 && head[3] === 0x2a)
}

/** BigTIFF ("II+\0" / "MM\0+") is a different container that the decoder does not read. */
function isBigTiffHeader(/** @type {Uint8Array} */ head) {
  if (head.length < 4) return false
  return (head[0] === 0x49 && head[1] === 0x49 && head[2] === 0x2b && head[3] === 0x00) ||
    (head[0] === 0x4d && head[1] === 0x4d && head[2] === 0x00 && head[3] === 0x2b)
}

/** Detect TIFF from the file signature (saved sessions keep no extension, and MIME types are unreliable). */
export async function isTiffBlob(/** @type {Blob} */ blob) {
  const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer())
  return isTiffHeader(head) || isBigTiffHeader(head)
}

/** @param {Record<string, any>} ifd @param {number} tag */
const tagValue = (ifd, tag) => (Array.isArray(ifd['t' + tag]) || ArrayBuffer.isView(ifd['t' + tag]) ? ifd['t' + tag][0] : undefined)

/**
 * Decode the first full-resolution page of a TIFF to straight-alpha RGBA, applying its orientation tag.
 * @param {ArrayBuffer} buffer
 * @returns {Promise<TiffImage>}
 */
export async function decodeTiff(buffer) {
  const head = new Uint8Array(buffer, 0, Math.min(4, buffer.byteLength))
  if (isBigTiffHeader(head)) throw new Error('BigTIFF files are not supported. Save the image as a standard TIFF or PNG and try again.')
  if (!isTiffHeader(head)) throw new Error('The source image is not a TIFF file.')
  // The bundled typings omit decodeImage's third argument and type IFDs too narrowly.
  const UTIF = /** @type {any} */ ((await import('utif2')).default)
  /** @type {Record<string, any>[]} */
  let ifds
  try {
    ifds = UTIF.decode(buffer)
  } catch {
    throw new Error('The TIFF image could not be read.')
  }
  // Skip reduced-resolution thumbnails (NewSubfileType bit 0) when a full page exists.
  const pages = ifds.filter((ifd) => tagValue(ifd, 256) && tagValue(ifd, 257))
  const page = pages.find((ifd) => !((tagValue(ifd, 254) ?? 0) & 1)) ?? pages[0]
  if (!page) throw new Error('The TIFF file contains no image.')
  validateImageDimensions(tagValue(page, 256), tagValue(page, 257))

  /** @type {Uint8Array} */
  let rgba
  try {
    UTIF.decodeImage(buffer, page, ifds)
    rgba = UTIF.toRGBA8(page)
  } catch {
    throw new Error('This TIFF uses a compression or color format RastaVec cannot read. Save it as PNG and try again.')
  }
  const { width, height } = page
  if (!width || !height || rgba.length !== width * height * 4)
    throw new Error('This TIFF uses a compression or color format RastaVec cannot read. Save it as PNG and try again.')

  const data = new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.length)
  // ExtraSamples = 1 marks premultiplied (associated) alpha; the engine expects straight alpha.
  if (tagValue(page, 338) === 1) unpremultiply(data)
  return orient({ data, width, height }, tagValue(page, 274) ?? 1)
}

function unpremultiply(/** @type {Uint8ClampedArray} */ data) {
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3]
    if (a === 0 || a === 255) continue
    data[i] = (data[i] * 255) / a
    data[i + 1] = (data[i + 1] * 255) / a
    data[i + 2] = (data[i + 2] * 255) / a
  }
}

/**
 * Apply the TIFF/EXIF Orientation tag (1–8) so the result matches what viewers display.
 * @param {TiffImage} img
 * @param {number} orientation
 * @returns {TiffImage}
 */
export function orient(img, orientation) {
  if (!(orientation >= 2 && orientation <= 8)) return img
  const { data, width: w, height: h } = img
  const swap = orientation >= 5
  const ow = swap ? h : w
  const oh = swap ? w : h
  const out = new Uint8ClampedArray(data.length)
  const src = new Uint32Array(data.buffer, data.byteOffset, w * h)
  const dst = new Uint32Array(out.buffer)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let dx, dy
      switch (orientation) {
        case 2: dx = w - 1 - x; dy = y; break // mirror horizontal
        case 3: dx = w - 1 - x; dy = h - 1 - y; break // rotate 180
        case 4: dx = x; dy = h - 1 - y; break // mirror vertical
        case 5: dx = y; dy = x; break // transpose
        case 6: dx = h - 1 - y; dy = x; break // rotate 90 clockwise
        case 7: dx = h - 1 - y; dy = w - 1 - x; break // transverse
        default: dx = y; dy = w - 1 - x; break // 8: rotate 90 counter-clockwise
      }
      dst[dy * ow + dx] = src[y * w + x]
    }
  }
  return { data: out, width: ow, height: oh }
}
