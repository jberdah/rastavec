import JSZip from 'jszip'
import type { Item } from './engine/types'
import { COLOR_WEIGHT, EDITABLE_WEIGHT, FALSE_EDGE_WEIGHT, FIDELITY_KNEE, SIZE_FLOOR_BYTES, SIZE_WEIGHT } from './engine/core'
import { app, chosenTrial, clone, outputMetrics } from './store.svelte'
import { browserBackend } from './engine/browser-backend'
import { activeEdit, outputSvg } from './edit'

const r4 = (x: number | null) => (x === null ? '' : Math.round(x * 10000) / 10000)

export function metricsCsv(items: Item[]): string {
  const cols = ['name', 'silhouette_iou', 'pct_pixels_diff_gt_32', 'mean_abs_rgb_diff_on_white', 'mean_abs_rgb_diff_on_dark', 'mean_abs_alpha_diff', 'embedded_raster', 'path_count', 'svg_bytes', 'width', 'height', 'auto_tuned', 'params', 'error', 'trace_scale', 'trace_method']
  const cell = (v: unknown) => {
    const s = v === undefined || v === null ? '' : String(v)
    // Prefix only untrusted text; numbers, including negative numbers, remain numeric CSV cells.
    const safe = typeof v === 'string' && /^[\s\p{Cc}]*[=+\-@]/u.test(s) ? `'${s}` : s
    return /[",;\t\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
  }
  const rows = items.map((i) => {
    if (i.status !== 'done') return [i.name, '', '', '', '', '', '', '', '', i.width, i.height, '', '', i.error ?? i.status, '', '']
    const t = chosenTrial(i), m = outputMetrics(i)
    if (!m) throw new Error(`Output metrics unavailable: ${i.name}`)
    return [i.name, r4(m.iou), r4(m.pctDiff), r4(m.rgbWhite), r4(m.rgbDark), r4(m.alphaDiff), m.embeddedRaster, m.paths, m.bytes, m.width, m.height, i.autoTuned, JSON.stringify(t.params), '', t.traceScale ?? 1, t.traceMethod ?? 'vtracer']
  })
  return [cols.join(','), ...rows.map((r) => r.map(cell).join(','))].join('\n') + '\n'
}

/** Record the chosen parameters and palette filters for the exported batch. */
export function config(items: Item[]) {
  const settings = app.batchSettings ?? { presetId: app.presetId, params: app.params, auto: app.auto }
  const traceEngine = app.batchSettings?.traceEngine
  const engine = traceEngine === 'next-gradients' ? 'VTracer-Next (WASM, gradients)' :
    traceEngine === 'next' ? 'VTracer-Next (WASM)' :
      traceEngine === 'official' ? 'VTracer official (historical batch)' : browserBackend.name
  return {
    app: 'rastavec',
    engine,
    ...(traceEngine ? { traceEngine } : {}),
    preset: settings.presetId,
    params: clone(settings.params),
    autoTune: {
      ...clone(settings.auto),
      scoreWeights: {
        visibleDifference: 1, meanRgbDifference: COLOR_WEIGHT, fidelityKnee: FIDELITY_KNEE,
        falseEdges: FALSE_EDGE_WEIGHT, sizePerDoubling: SIZE_WEIGHT, sizeFloorBytes: SIZE_FLOOR_BYTES, editableShare: EDITABLE_WEIGHT,
      },
    },
    items: items
      .filter((i) => i.status === 'done')
      .map((i) => {
        const edit = activeEdit(i)
        return { name: i.name, params: clone(chosenTrial(i).params), traceScale: chosenTrial(i).traceScale ?? 1, traceMethod: chosenTrial(i).traceMethod ?? 'vtracer', autoTuned: i.autoTuned, ...(edit ? { paletteFilters: clone(edit) } : {}) }
      }),
  }
}

export function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export async function exportZip(items: Item[]) {
  const zip = new JSZip()
  for (const i of items) if (i.status === 'done') {
    zip.file(`svg/${i.name}.svg`, outputSvg(i))
    if (i.grouping && outputSvg(i) === i.grouping.svg) {
      const { sourceHash, distance, colorMode, includeSingletons, strategy, regionCount, considered, skipped, groups } = i.grouping
      zip.file(`group-metadata/${i.name}.json`, JSON.stringify({ sourceHash, distance, colorMode, ...(includeSingletons === undefined ? {} : { includeSingletons }), ...(strategy === undefined ? {} : { strategy }), ...(regionCount === undefined ? {} : { regionCount }), considered, skipped, groups }, null, 2) + '\n')
    }
  }
  zip.file('metrics.csv', metricsCsv(items))
  zip.file('config.json', JSON.stringify(config(items), null, 2) + '\n')
  download(await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' }), 'rastavec-export.zip')
}

export function downloadSvg(item: Item) {
  download(new Blob([outputSvg(item)], { type: 'image/svg+xml' }), `${item.name}.svg`)
}
