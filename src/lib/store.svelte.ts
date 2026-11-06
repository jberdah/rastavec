import { isDefault } from './engine/palette'
import { presetById } from './engine/presets'
import type { AutoTune, Item, TraceParams } from './engine/types'
import type { RGBAImage } from './engine/core'

export type Route = 'import' | 'lot' | 'detail' | 'edit' | 'animate'

export const app = $state({
  route: 'import' as Route,
  items: [] as Item[],
  presetId: 'auto',
  params: { ...presetById('shaded').params } as TraceParams,
  auto: { enabled: true, threshold: 3, maxKB: 400 } as AutoTune,
  batchSettings: null as { presetId: string; params: TraceParams; auto: AutoTune } | null,
  selectedId: null as string | null,
  running: false,
  cancelRequested: false,
  batchProcessed: 0,
  batchCancelled: false,
  startedAt: 0,
  finishedAt: 0,
})

/** Decoded sources, kept out of reactive state (large typed arrays). */
export const sources = new Map<string, RGBAImage>()

const svgUrls = new Map<string, string>()
/** Object URL for one trial's SVG, cached. */
export function svgUrl(item: Item, index = item.chosen): string {
  const key = `${item.id}:${index}`
  let url = svgUrls.get(key)
  if (!url) {
    url = URL.createObjectURL(new Blob([item.trials[index].svg], { type: 'image/svg+xml' }))
    svgUrls.set(key, url)
  }
  return url
}

export function forgetUrls(item: Item) {
  for (const [k, url] of svgUrls) {
    if (k.startsWith(item.id + ':')) {
      URL.revokeObjectURL(url)
      svgUrls.delete(k)
    }
  }
}

export const doneItems = () => app.items.filter((i) => i.status === 'done')
export const chosenTrial = (i: Item) => i.trials[i.chosen]
export const editKey = (i: Item): string | null => {
  const e = i.edit
  return e && e.trial === i.chosen && !isDefault(e.settings) ? `${i.chosen}:${JSON.stringify(e.settings)}` : null
}
export const outputMetrics = (i: Item) => {
  const key = editKey(i)
  return key ? (i.outputMeasurement?.key === key ? i.outputMeasurement.metrics : undefined) : chosenTrial(i).metrics
}
export const needsReview = (i: Item) =>
  i.status === 'error' ||
  (i.status === 'done' && (!outputMetrics(i) || outputMetrics(i)!.pctDiff > (app.batchSettings?.auto ?? app.auto).threshold || outputMetrics(i)!.bytes > (app.batchSettings?.auto ?? app.auto).maxKB * 1024))

export function go(route: Route, selectedId?: string) {
  if (selectedId) app.selectedId = selectedId
  app.route = route
  window.scrollTo({ top: 0 })
}

/** Plain deep copy of reactive state (safe outside .svelte files). */
export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))
