// Study bench for the Auto-Tune score: runs the real Auto-Tune (real engine module) over a set
// of images and records every trial with its metrics, plus two measures the score does not see
// today:
//
//   falseEdgePct   share of pixels where the render shows a color step that the source does not
//                  (banding of a smooth area);
//   editableShare  share of the image painted by a gradient or an exact circle / ellipse, i.e.
//                  what the engine recovered as objects rather than as plain outlines.
//
//   node scripts/score-study.mjs <image or directory>... [--out .tmp/score-study/results.json]
//
// Analysis is separate (scripts/score-study-analyze.mjs) so weights can be tried without
// re-tracing.
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, extname, join, resolve } from 'node:path'
import init, { vectorize_rgba, vectorize_rgba_structured } from '../src/lib/engine/vtracer-next-wasm/vtracer_next.js'

const require = createRequire(new URL('../cli/package.json', import.meta.url))
const sharp = require('sharp')
const { buildSync } = require('esbuild')
const bundled = buildSync({
  stdin: {
    contents: `export { vectorize } from './src/lib/engine/vectorize'; export { DEFAULT_PARAMS } from './src/lib/engine/presets'; export { nextOptions, withVTracerNext } from './src/lib/engine/vtracer-next-trace'; export { parsePaths } from './src/lib/engine/trace-options'; export { flattenPath } from './src/lib/engine/palette'`,
    resolveDir: process.cwd(), loader: 'ts',
  },
  bundle: true, write: false, format: 'esm', platform: 'node', external: ['sharp'],
}).outputFiles[0].text
const { vectorize, DEFAULT_PARAMS, nextOptions, withVTracerNext, parsePaths, flattenPath } = await import(`data:text/javascript;base64,${Buffer.from(bundled).toString('base64')}`)
await init({ module_or_path: readFileSync(new URL('../src/lib/engine/vtracer-next-wasm/vtracer_next_bg.wasm', import.meta.url)) })

const args = process.argv.slice(2)
const outIndex = args.indexOf('--out')
const out = resolve(outIndex >= 0 ? args.splice(outIndex, 2)[1] : '.tmp/score-study/results.json')
const files = args.flatMap((entry) => {
  const path = resolve(entry)
  return statSync(path).isDirectory()
    ? readdirSync(path).filter((name) => /\.(png|jpe?g|webp)$/i.test(name)).sort().map((name) => join(path, name))
    : [path]
})
if (!files.length) throw new Error('No images given.')

const rasterize = async (svg, width, height) => {
  const data = await sharp(Buffer.from(svg)).resize(width, height, { fit: 'fill' }).ensureAlpha().raw().toBuffer()
  return { width, height, data: new Uint8ClampedArray(data) }
}
const convert = async (src, params, binary, gradients) => {
  const options = nextOptions(params, binary, gradients)
  const rgba = new Uint8Array(src.data.buffer, src.data.byteOffset, src.data.byteLength)
  if (binary) return vectorize_rgba(rgba, src.width, src.height, options)
  const [svg, report] = vectorize_rgba_structured(rgba, src.width, src.height, options)
  return { svg, report }
}
const backend = withVTracerNext({ rasterize }, false, convert, async (image, params, binary) => {
  const result = await convert(image, params, binary, false)
  return parsePaths(typeof result === 'string' ? result : result.svg, params.compactPaths, params.pathPrecision)
})

// Composite over white, as the fidelity metrics do.
const overWhite = (image) => {
  const { data } = image, n = image.width * image.height, flat = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    const a = data[i * 4 + 3] / 255
    for (let c = 0; c < 3; c++) flat[i * 3 + c] = data[i * 4 + c] * a + 255 * (1 - a)
  }
  return flat
}
/** Largest channel step from pixel i to its right and lower neighbours. */
const stepAt = (flat, width, height, x, y) => {
  const i = (y * width + x) * 3
  let step = 0
  if (x + 1 < width) for (let c = 0; c < 3; c++) step = Math.max(step, Math.abs(flat[i + c] - flat[i + 3 + c]))
  if (y + 1 < height) for (let c = 0; c < 3; c++) step = Math.max(step, Math.abs(flat[i + c] - flat[i + width * 3 + c]))
  return step
}
const SMOOTH = 6, STEP = 12
function falseEdgePct(sourceFlat, renderFlat, width, height) {
  let falseEdges = 0, smooth = 0
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (stepAt(sourceFlat, width, height, x, y) > SMOOTH) continue
    smooth++
    if (stepAt(renderFlat, width, height, x, y) >= STEP) falseEdges++
  }
  return { falseEdgePct: 100 * falseEdges / (width * height), smoothPct: 100 * smooth / (width * height) }
}
/** Share of the viewBox painted by gradient paths or exact circles / ellipses. */
function editableShare(trial) {
  const hints = (trial.shapes ?? []).filter((hint) => hint.overlayOf === undefined && (hint.kind !== 'path' || hint.gradient))
  if (!hints.length) return 0
  const view = /\bviewBox="[-\d.]+[ ,]+[-\d.]+[ ,]+([\d.]+)[ ,]+([\d.]+)"/.exec(trial.svg)
  if (!view) return 0
  const total = Number(view[1]) * Number(view[2])
  const tags = [...trial.svg.matchAll(/<path\b[^>]*\bd="([^"]*)"/g)]
  let area = 0
  for (const hint of hints) {
    if (hint.kind === 'circle') area += Math.PI * hint.r * hint.r
    else if (hint.kind === 'ellipse') area += Math.PI * hint.rx * hint.ry
    else {
      const d = tags[hint.index]?.[1]
      if (!d) continue
      // Even-odd is close enough here: outer ring minus holes.
      let signed = 0
      for (const points of flattenPath(d)) {
        let ring = 0
        for (let k = 0; k + 1 < points.length; k += 2) {
          const next = (k + 2) % points.length
          ring += points[k] * points[next + 1] - points[next] * points[k + 1]
        }
        signed += Math.abs(ring) / 2 * (signed === 0 ? 1 : -1)
      }
      area += Math.max(0, signed)
    }
  }
  return Math.min(1, area / total)
}

const results = []
for (const [index, file] of files.entries()) {
  const started = Date.now()
  try {
    const { data, info } = await sharp(file).rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const src = { width: info.width, height: info.height, data: new Uint8ClampedArray(data) }
    const sourceFlat = overWhite(src)
    const result = await vectorize(src, { presetId: 'auto', params: { ...DEFAULT_PARAMS }, auto: { enabled: true, threshold: 3, maxKB: 0 } }, backend)
    const trials = []
    for (const [k, trial] of result.trials.entries()) {
      const render = await rasterize(trial.svg, src.width, src.height)
      const edges = falseEdgePct(sourceFlat, overWhite(render), src.width, src.height)
      trials.push({
        k, label: trial.traceMethod ?? `${trial.params.mode} cp${trial.params.colorPrecision} ld${trial.params.layerDifference} sp${trial.params.speckle} ${trial.params.hierarchical ?? 'stacked'}${(trial.traceScale ?? 1) > 1 ? ` x${trial.traceScale}` : ''}`,
        pctDiff: trial.metrics.pctDiff, meanRgb: (trial.metrics.rgbWhite + trial.metrics.rgbDark) / 2, alphaDiff: trial.metrics.alphaDiff,
        bytes: trial.metrics.bytes, paths: trial.metrics.paths, score: trial.score,
        ...edges, editableShare: editableShare(trial),
        // What the product measured for its own score, to check it against the study's measures.
        productFalseEdgePct: trial.metrics.falseEdgePct, productEditableShare: trial.metrics.editableShare ?? 0,
        gradients: (trial.svg.match(/<(?:linear|radial)Gradient\b/g) ?? []).length,
        circles: (trial.shapes ?? []).filter((hint) => hint.kind === 'circle').length,
        ellipses: (trial.shapes ?? []).filter((hint) => hint.kind === 'ellipse').length,
      })
    }
    results.push({ file, name: basename(file, extname(file)), width: src.width, height: src.height, kind: result.analysis?.kind, chosen: result.chosen, trials })
    console.log(`[${index + 1}/${files.length}] ${basename(file)}: ${trials.length} trials, ${((Date.now() - started) / 1000).toFixed(1)} s`)
  } catch (error) {
    console.log(`[${index + 1}/${files.length}] ${basename(file)}: FAILED ${String(error?.message ?? error).slice(0, 120)}`)
  }
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, JSON.stringify(results))
}
console.log(`Wrote ${out}: ${results.length} images.`)
