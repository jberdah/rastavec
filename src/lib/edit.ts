// Palette filters applied to the chosen trial of an item. Analyses and results are cached outside
// reactive state (keyed by item + trial), so moving a slider only re-runs the cheap colour pass.
import { outputQueue } from './measurement-queue.js'
import { analyzeShapes, applyFilters, isDefault, type FilterResult, type FilterSettings, type ShapeAnalysis } from './engine/palette'
import type { Item } from './engine/types'
import { chosenTrial, editKey, svgUrl } from './store.svelte'
import { svgFingerprint } from './engine/group-nearby'

const analyses = new Map<string, ShapeAnalysis>()
const previewUrls = new Map<string, { key: string; url: string }>()
const results = new Map<string, { key: string; result: FilterResult }>()

export function shapeAnalysis(item: Item): ShapeAnalysis {
  const key = `${item.id}:${item.chosen}`
  let a = analyses.get(key)
  if (!a) analyses.set(key, (a = analyzeShapes(chosenTrial(item).svg)))
  return a
}

/** Filtered SVG for these settings (last result cached per item). */
export function filtered(item: Item, settings: FilterSettings): FilterResult {
  const key = `${item.chosen}:${JSON.stringify(settings)}`
  const hit = results.get(item.id)
  if (hit?.key === key) return hit.result
  const result = applyFilters(chosenTrial(item).svg, shapeAnalysis(item), settings)
  results.set(item.id, { key, result })
  return result
}

/** The item's filter settings when they apply to its chosen trial and change something. */
export function activeEdit(item: Item): FilterSettings | null {
  const e = item.edit
  return e && e.trial === item.chosen && !isDefault(e.settings) ? e.settings : null
}

/** The SVG to export: the chosen trial, with its palette filters if any. */
export function outputSvg(item: Item): string {
  const s = activeEdit(item)
  const source = s ? filtered(item, s).svg : chosenTrial(item).svg
  const grouping = item.grouping
  return grouping?.sourceHash === svgFingerprint(source) ? grouping.svg : source
}

/** Preview the same filtered SVG that will be exported. */
export function outputUrl(item: Item): string {
  const key = editKey(item)
  if (!key) return svgUrl(item)
  const old = previewUrls.get(item.id)
  if (old?.key === key) return old.url
  if (old) URL.revokeObjectURL(old.url)
  const url = URL.createObjectURL(new Blob([outputSvg(item)], { type: 'image/svg+xml' }))
  previewUrls.set(item.id, { key, url })
  return url
}

/** Drop cached analyses and previews after a trial's SVG changed, keeping the item's settings. */
export function forgetTrialCaches(item: Item) {
  for (const k of analyses.keys()) if (k.startsWith(item.id + ':')) analyses.delete(k)
  results.delete(item.id)
  const preview = previewUrls.get(item.id)
  if (preview) URL.revokeObjectURL(preview.url)
  previewUrls.delete(item.id)
}

export function forgetEdits(item: Item) {
  outputQueue.cancel(item.id)
  for (const k of analyses.keys()) if (k.startsWith(item.id + ':')) analyses.delete(k)
  results.delete(item.id)
  const preview = previewUrls.get(item.id)
  if (preview) URL.revokeObjectURL(preview.url)
  previewUrls.delete(item.id)
  item.edit = undefined
  item.outputMeasurement = undefined
}
