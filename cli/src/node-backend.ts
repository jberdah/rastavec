// Node backend: VTracer 1.0 (official @visioncortex/vtracer wasm, no DOM) for tracing,
// sharp (libvips + librsvg) for decoding, SVG rendering and PNG output.
import sharp from 'sharp'
import * as vtracer from '@visioncortex/vtracer'
import { normalizeHex, type Prepared, type RGBAImage, type TraceBackend } from '../../src/lib/engine/core'
import { compactPath } from '../../src/lib/engine/compact'
import { composeSvg, type RawPath } from '../../src/lib/engine/compose'
import type { TraceParams } from '../../src/lib/engine/types'

// A single 40 MP RGBA buffer is 160 MB; tracing can need several copies.
// Reject oversized sources before allocating them and retain sharp's decode guard.
export const MAX_INPUT_PIXELS = 40_000_000
export const MAX_INPUT_SIDE = 16_384

function vtracerOptions(p: TraceParams, binary: boolean) {
  return {
    clustering: binary ? 'bw' : 'color-cluster',
    ...(binary ? { binaryThreshold: 128 } : {}),
    hierarchical: 'stacked',
    mode: p.mode,
    filterSpeckle: p.speckle,
    colorPrecision: p.colorPrecision,
    layerDifference: p.layerDifference,
    cornerThreshold: p.cornerThreshold,
    lengthThreshold: p.lengthThreshold,
    spliceThreshold: p.spliceThreshold,
    pathPrecision: p.pathPrecision,
  } as const
}

function parsePaths(svg: string, compact: boolean, precision: number): RawPath[] {
  const out: RawPath[] = []
  for (const m of svg.matchAll(/<path\b([^>]*?)\/?>/g)) {
    const attrs = m[1]
    const d = attrs.match(/\sd="([^"]*)"/)?.[1]?.trim()
    if (!d) continue
    const fill = normalizeHex(attrs.match(/\sfill="([^"]*)"/)?.[1] ?? '#000000')
    const transform = attrs.match(/\stransform="([^"]*)"/)?.[1] ?? null
    const small = compact ? compactPath(d, transform, precision) : null
    out.push(small !== null ? { d: small, fill, transform: null } : { d, fill, transform })
  }
  return out
}

async function runConverter(image: RGBAImage, p: TraceParams, binary: boolean): Promise<RawPath[]> {
  const rgba = new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.length)
  const svg = vtracer.convertPixels(rgba, image.width, image.height, vtracerOptions(p, binary))
  return parsePaths(svg, p.compactPaths, p.pathPrecision)
}

const toRGBA = (data: Buffer, width: number, height: number): RGBAImage => ({
  data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length),
  width,
  height,
})

export const nodeBackend: TraceBackend = {
  name: 'vtracer 1.0.0-alpha.4 (node) + sharp',
  trace(prep: Prepared, p: TraceParams) {
    return composeSvg(prep, p, runConverter)
  },
  async rasterize(svg: string, width: number, height: number) {
    // The SVG declares width/height = source size, so 72 dpi renders it 1:1.
    const { data, info } = await sharp(Buffer.from(svg), { density: 72, limitInputPixels: MAX_INPUT_PIXELS })
      .resize(width, height, { fit: 'fill' })
      .toColourspace('srgb')
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    return toRGBA(data, info.width, info.height)
  },
}

/** Decode any supported raster file to RGBA, applying EXIF orientation. */
export async function decode(file: string | Buffer): Promise<RGBAImage> {
  // Reading headers does not allocate the decoded image. Read dimensions first to report
  // our actionable error, then apply sharp's limit during the actual decode as a backstop.
  const metadata = await sharp(file, { limitInputPixels: false }).metadata()
  if (metadata.width && metadata.height && (metadata.width * metadata.height > MAX_INPUT_PIXELS || metadata.width > MAX_INPUT_SIDE || metadata.height > MAX_INPUT_SIDE))
    throw new Error(`image dimensions ${metadata.width}×${metadata.height} exceed the ${MAX_INPUT_PIXELS.toLocaleString('en-US')}-pixel or ${MAX_INPUT_SIDE.toLocaleString('en-US')}-pixel side limit; resize the image before retrying`)
  const { data, info } = await sharp(file, { limitInputPixels: MAX_INPUT_PIXELS }).rotate().toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  if (info.channels !== 4) throw new Error(`unexpected channel count ${info.channels}`)
  return toRGBA(data, info.width, info.height)
}

const raw = (img: RGBAImage) => sharp(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length), { raw: { width: img.width, height: img.height, channels: 4 } })

export async function writePng(img: RGBAImage, path: string) {
  await raw(img).png().toFile(path)
}

/** 2 x 2 board: source | SVG, on white (top) and dark #202020 (bottom). */
export async function writeComparison(src: RGBAImage, render: RGBAImage, path: string) {
  const pw = Math.min(src.width, 600)
  const ph = Math.max(1, Math.round((src.height * pw) / src.width))
  const panels: Buffer[] = []
  for (const bg of ['#ffffff', '#202020']) for (const img of [src, render]) panels.push(await raw(img).flatten({ background: bg }).resize(pw, ph).png().toBuffer())
  await sharp({ create: { width: pw * 2, height: ph * 2, channels: 3, background: '#ffffff' } })
    .composite(panels.map((input, k) => ({ input, left: (k % 2) * pw, top: Math.floor(k / 2) * ph })))
    .png()
    .toFile(path)
}
