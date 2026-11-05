// Browser backend: official visioncortex VTracer webapp build (wasm) + canvas rendering.
// vtracer-webapp reads its input from a <canvas> and writes <path>s into an <svg>, both looked
// up by id in the document, so it must run on the main thread. It works incrementally (tick),
// which we time-slice to keep the UI responsive.
import type { Prepared, RGBAImage, TraceBackend } from './core'
import { normalizeHex } from './core'
import { composeSvg, type RawPath } from './compose'
import { compactPath } from './compact'
import type { TraceParams } from './types'

type Wasm = typeof import('vtracer-webapp')
let wasmPromise: Promise<Wasm> | null = null
const loadWasm = () => (wasmPromise ??= import('vtracer-webapp'))

const SVG_NS = 'http://www.w3.org/2000/svg'
let host: HTMLDivElement | null = null
let counter = 0

function getHost() {
  if (!host) {
    host = document.createElement('div')
    host.setAttribute('aria-hidden', 'true')
    host.style.cssText = 'position:fixed;left:-100000px;top:0;width:1px;height:1px;overflow:hidden;pointer-events:none'
    document.body.appendChild(host)
  }
  return host
}

const deg2rad = (d: number) => (d * Math.PI) / 180
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

function runTicks(conv: { tick(): boolean }): Promise<void> {
  return new Promise((resolve, reject) => {
    const step = () => {
      const t0 = performance.now()
      try {
        while (!conv.tick()) {
          if (performance.now() - t0 > 14) {
            setTimeout(step, 0)
            return
          }
        }
        resolve()
      } catch (e) {
        reject(e)
      }
    }
    step()
  })
}

function collect(svg: SVGSVGElement, compact: boolean, precision: number): RawPath[] {
  const out: RawPath[] = []
  for (const el of Array.from(svg.children)) {
    if (el.tagName.toLowerCase() !== 'path') continue
    const d = el.getAttribute('d')
    if (!d || !d.trim()) continue
    const raw = el.getAttribute('fill') || (el.getAttribute('style') || '').match(/fill:\s*([^;]+)/)?.[1] || '#000000'
    const transform = el.getAttribute('transform')
    // Bake the translation and re-encode compactly; keep the original if the path is unusual.
    const small = compact ? compactPath(d.trim(), transform, precision) : null
    out.push(small !== null ? { d: small, fill: normalizeHex(raw), transform: null } : { d: d.trim(), fill: normalizeHex(raw), transform })
  }
  return out
}

export const browserBackend: TraceBackend = {
  name: 'vtracer-webapp 0.4.0 (wasm) + canvas',

  trace(prep: Prepared, p: TraceParams) {
    return composeSvg(prep, p, runConverter)
  },

  async rasterize(svg: string, width: number, height: number) {
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
    try {
      const img = new Image()
      img.src = url
      await img.decode()
      const c = document.createElement('canvas')
      c.width = width
      c.height = height
      const ctx = c.getContext('2d', { willReadFrequently: true })!
      ctx.drawImage(img, 0, 0, width, height)
      const d = ctx.getImageData(0, 0, width, height)
      return { data: d.data, width, height }
    } finally {
      URL.revokeObjectURL(url)
    }
  },
}

async function runConverter(image: RGBAImage, p: TraceParams, binary: boolean): Promise<RawPath[]> {
  {
    const vt = await loadWasm()
    const id = ++counter
    const canvas = document.createElement('canvas')
    canvas.id = `vt-canvas-${id}`
    canvas.width = image.width
    canvas.height = image.height
    const svg = document.createElementNS(SVG_NS, 'svg')
    svg.id = `vt-svg-${id}`
    getHost().append(canvas, svg)
    try {
      canvas.getContext('2d', { willReadFrequently: true })!.putImageData(new ImageData(image.data, image.width, image.height), 0, 0)
      const common = {
        canvas_id: canvas.id,
        svg_id: svg.id,
        mode: p.mode,
        corner_threshold: deg2rad(p.cornerThreshold),
        length_threshold: p.lengthThreshold,
        max_iterations: 10,
        splice_threshold: deg2rad(p.spliceThreshold),
        // Same conventions as the Python binding: speckle is a side length, precision is kept bits.
        filter_speckle: p.speckle * p.speckle,
        path_precision: p.pathPrecision,
      }
      const conv =
        binary
          ? vt.BinaryImageConverter.new_with_string(JSON.stringify(common))
          : vt.ColorImageConverter.new_with_string(
              JSON.stringify({ ...common, hierarchical: 'stacked', color_precision: 8 - p.colorPrecision, layer_difference: p.layerDifference }),
            )
      try {
        conv.init()
        await runTicks(conv)
      } finally {
        conv.free()
      }
      return collect(svg, p.compactPaths, p.pathPrecision)
    } finally {
      canvas.remove()
      svg.remove()
    }
  }
}

/** Decode a file to RGBA, applying EXIF orientation. */
export async function decodeFile(file: File): Promise<RGBAImage> {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image', premultiplyAlpha: 'none', colorSpaceConversion: 'none' })
  const c = document.createElement('canvas')
  c.width = bmp.width
  c.height = bmp.height
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(bmp, 0, 0)
  bmp.close()
  const d = ctx.getImageData(0, 0, c.width, c.height)
  return { data: d.data, width: c.width, height: c.height }
}

/** Encode an RGBA image as a PNG File. */
export async function toPngFile(img: RGBAImage, name: string): Promise<File> {
  const c = document.createElement('canvas')
  c.width = img.width
  c.height = img.height
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0)
  const blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('PNG encoding failed'))), 'image/png'))
  return new File([blob], name, { type: 'image/png' })
}

export function toDataUrl(img: RGBAImage): string {
  const c = document.createElement('canvas')
  c.width = img.width
  c.height = img.height
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0)
  return c.toDataURL('image/png')
}
