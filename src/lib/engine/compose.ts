// SVG assembly shared by every tracing backend (browser wasm, Node CLI): colour paths, silhouette
// clip, soft (semi-transparent) layers, binary ink/paper. A backend only supplies `run`, which traces
// one opaque RGBA image (colour or binary) into raw paths.
import { isKeyFill, type Prepared, type RGBAImage } from './core'
import type { TraceParams } from './types'

export interface RawPath {
  d: string
  fill: string
  transform: string | null
}

export type RunConverter = (image: RGBAImage, params: TraceParams, binary: boolean) => Promise<RawPath[]>

const SVG_NS = 'http://www.w3.org/2000/svg'
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
const pathTag = (p: RawPath, fill = true) =>
  `<path d="${esc(p.d)}"${fill ? ` fill="${p.fill}"` : ''}${p.transform ? ` transform="${esc(p.transform)}"` : ''}/>`

export async function composeSvg(prep: Prepared, p: TraceParams, run: RunConverter): Promise<string> {
  const { width: w, height: h } = prep.image
  const head = `<svg xmlns="${SVG_NS}" version="1.1" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`
  if (p.colormode === 'binary') {
    // Ink paths in their real mean colour, over the paper colour when the source is opaque.
    const ink = await run(prep.image, p, true)
    const paper = prep.paper ? `<rect width="${w}" height="${h}" fill="${prep.paper}"/>\n` : ''
    return `${head}\n${paper}<g fill="${prep.ink}">\n${ink.map((x) => pathTag(x, false)).join('\n')}\n</g>\n</svg>\n`
  }
  const color = (await run(prep.image, p, false)).filter((x) => !isKeyFill(x.fill, prep.keyHex))
  const body = color.map((x) => pathTag(x)).join('\n')
  if (!prep.mask) return `${head}\n${body}\n</svg>\n`
  // Silhouette pass: binary trace of the alpha mask, used as a clip path.
  const silParams: TraceParams = { ...p, colormode: 'binary', speckle: Math.max(2, Math.min(p.speckle, 8)) }
  const sil = await run(prep.mask, silParams, true)
  if (!sil.length) return `${head}\n${body}\n</svg>\n`
  const clip = sil.map((x) => pathTag(x, false)).join('')
  // Soft edges: semi-transparent silhouettes (or a colour trace of the soft area) under the clipped artwork.
  let soft = ''
  if (prep.softColor) {
    const sc = prep.softColor
    const paths = (await run(sc.image, { ...p, speckle: Math.min(p.speckle, 2) }, false)).filter((x) => !isKeyFill(x.fill, sc.keyHex))
    if (paths.length) soft += `<g id="soft-color" fill-opacity="${sc.opacity.toFixed(3)}">${paths.map((x) => pathTag(x)).join('')}</g>\n`
  }
  for (const [k, layer] of prep.soft.entries()) {
    const paths = await run(layer.mask, silParams, true)
    if (paths.length) soft += `<g id="soft-${k + 1}" fill="${layer.fill}" fill-opacity="${layer.opacity.toFixed(3)}">${paths.map((x) => pathTag(x, false)).join('')}</g>\n`
  }
  const opacity = prep.opacity < 1 ? ` opacity="${prep.opacity.toFixed(3)}"` : ''
  return `${head}\n<defs><clipPath id="silhouette" clipPathUnits="userSpaceOnUse">${clip}</clipPath></defs>\n${soft}<g clip-path="url(#silhouette)"${opacity}>\n${body}\n</g>\n</svg>\n`
}
