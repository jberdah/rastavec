// Node backend: the shared VTracer-Next WASM for tracing and sharp for image I/O.
import sharp from 'sharp'
import { existsSync, realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { RGBAImage, TraceBackend } from '../../src/lib/engine/core'
import { parsePaths } from '../../src/lib/engine/trace-options'
import { nextOptions, withVTracerNext, type NextConvert } from '../../src/lib/engine/vtracer-next-trace'

// A single 40 MP RGBA buffer is 160 MB; tracing can need several copies.
// Reject oversized sources before allocating them and retain sharp's decode guard.
export const MAX_INPUT_PIXELS = 40_000_000
export const MAX_INPUT_SIDE = 16_384

const toRGBA = (data: Buffer, width: number, height: number): RGBAImage => ({
  data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length),
  width,
  height,
})

const nodeRasterBackend: Pick<TraceBackend, 'rasterize'> = {
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

export async function loadNodeNextBackend(gradients: boolean): Promise<TraceBackend> {
  const entry = process.argv[1] ? realpathSync(process.argv[1]) : process.cwd()
  const directory = process.env.RASTAVEC_NEXT_WASM_DIR ?? resolve(dirname(entry), 'vtracer-next-wasm')
  if (!existsSync(resolve(directory, 'vtracer_next.mjs'))) {
    throw new Error(`VTracer-Next WASM was not found in ${directory}. Rebuild the CLI package or set RASTAVEC_NEXT_WASM_DIR.`)
  }
  const url = pathToFileURL(resolve(directory, 'vtracer_next.mjs'))
  const module = await import(url.href)
  const wasm = await readFile(new URL('vtracer_next_bg.wasm', url))
  await module.default({ module_or_path: wasm })
  const convert: NextConvert = async (image, params, binary, experimentalGradients) => {
    const rgba = new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength)
    const options = nextOptions(params, binary, experimentalGradients)
    if (binary) return module.vectorize_rgba(rgba, image.width, image.height, options) as string
    const [svg, report] = module.vectorize_rgba_structured(rgba, image.width, image.height, options) as [string, string]
    return { svg, report }
  }
  return withVTracerNext(nodeRasterBackend, gradients, convert, async (image, params, binary) => {
    const result = await convert(image, params, binary, false)
    return parsePaths(typeof result === 'string' ? result : result.svg, params.compactPaths, params.pathPrecision)
  })
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
