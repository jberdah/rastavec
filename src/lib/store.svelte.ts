import { isDefault } from './engine/palette'
import { svgFingerprint } from './engine/group-nearby'
import { presetById } from './engine/presets'
import type { AutoTune, Item, TraceParams } from './engine/types'
import type { RGBAImage } from './engine/core'
import type { TraceEngine, TraceEngineProvenance } from './engine/web-trace-engine'

export type Route = 'import' | 'lot' | 'detail' | 'edit' | 'animate'

export const app = $state({
  route: 'import' as Route,
  landingHandoffFailed: false,
  items: [] as Item[],
  presetId: 'auto',
  traceEngine: 'next' as TraceEngine,
  params: { ...presetById('shaded').params } as TraceParams,
  auto: { enabled: true, threshold: 3, maxKB: 400 } as AutoTune,
  batchSettings: null as { presetId: string; params: TraceParams; auto: AutoTune; traceEngine?: TraceEngineProvenance } | null,
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
const trialFingerprints = new WeakMap<object, string>()
const chosenTrialFingerprint = (item: Item) => {
  const trial = chosenTrial(item)
  const cached = trialFingerprints.get(trial)
  if (cached) return cached
  const fingerprint = svgFingerprint(trial.svg)
  trialFingerprints.set(trial, fingerprint)
  return fingerprint
}
const groupingFingerprints = new WeakMap<object, string>()
const groupingFingerprint = (item: Item) => {
  const grouping = item.grouping
  if (!grouping) return ''
  const cached = groupingFingerprints.get(grouping)
  if (cached) return cached
  const fingerprint = `${grouping.sourceHash}:${svgFingerprint(grouping.svg)}`
  groupingFingerprints.set(grouping, fingerprint)
  return fingerprint
}
/** Key for the measured final SVG, including grouping markup as well as palette edits. */
export const outputMeasurementKey = (i: Item): string | null => {
  const edit = editKey(i)
  const grouping = i.grouping
  if (!edit) {
    if (!grouping) return null
    const sourceHash = chosenTrialFingerprint(i)
    // Stale grouping is not part of outputSvg; use the current trial's native metrics.
    if (grouping.sourceHash !== sourceHash) return null
    return `trial:${i.chosen}:${sourceHash}:group:${groupingFingerprint(i)}`
  }
  return grouping ? `${edit}:group:${groupingFingerprint(i)}` : edit
}
export const outputMetrics = (i: Item) => {
  const key = outputMeasurementKey(i)
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
