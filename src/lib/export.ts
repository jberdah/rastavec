import JSZip from 'jszip'
import type { Item } from './engine/types'
import { SIZE_WEIGHT } from './engine/core'
import { app, chosenTrial, clone } from './store.svelte'
import { engineName } from './pipeline'

const r4 = (x: number | null) => (x === null ? '' : String(Math.round(x * 10000) / 10000))

export function metricsCsv(items: Item[]): string {
  const cols = ['name', 'silhouette_iou', 'pct_pixels_diff_gt_32', 'mean_abs_rgb_diff_on_white', 'mean_abs_rgb_diff_on_dark', 'mean_abs_alpha_diff', 'embedded_raster', 'path_count', 'svg_bytes', 'width', 'height', 'auto_tuned', 'params', 'error']
  const cell = (v: unknown) => {
    const s = v === undefined || v === null ? '' : String(v)
    return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const rows = items.map((i) => {
    if (i.status !== 'done') return [i.name, '', '', '', '', '', '', '', '', i.width, i.height, '', '', i.error ?? i.status]
    const t = chosenTrial(i), m = t.metrics
    return [i.name, r4(m.iou), r4(m.pctDiff), r4(m.rgbWhite), r4(m.rgbDark), r4(m.alphaDiff), m.embeddedRaster, m.paths, m.bytes, m.width, m.height, i.autoTuned, JSON.stringify(t.params), '']
  })
  return [cols.join(','), ...rows.map((r) => r.map(cell).join(','))].join('\n') + '\n'
}

/** Everything needed to replay the batch identically. */
export function config(items: Item[]) {
  return {
    app: 'rastavec',
    engine: engineName,
    preset: app.presetId,
    params: clone(app.params),
    autoTune: { ...clone(app.auto), sizeWeightPerKiB: SIZE_WEIGHT },
    items: items
      .filter((i) => i.status === 'done')
      .map((i) => ({ name: i.name, params: clone(chosenTrial(i).params), autoTuned: i.autoTuned })),
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
  for (const i of items) if (i.status === 'done') zip.file(`svg/${i.name}.svg`, chosenTrial(i).svg)
  zip.file('metrics.csv', metricsCsv(items))
  zip.file('config.json', JSON.stringify(config(items), null, 2) + '\n')
  download(await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' }), 'rastavec-export.zip')
}

export function downloadSvg(item: Item) {
  download(new Blob([chosenTrial(item).svg], { type: 'image/svg+xml' }), `${item.name}.svg`)
}
