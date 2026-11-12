// Applies a per-shape edit to an item. An edit never rewrites a traced trial: it produces a
// "shapes-edited" variant of the chosen trial and selects it, so palette filters, grouping,
// animation and export keep working on a trial like any other, and the original stays available
// in the trial list.
import { forgetTrialCaches } from './edit'
import { score } from './engine/core'
import { editableShare } from './engine/editable-share'
import { editShape, type ShapePatch } from './engine/shape-edits'
import type { Item, Trial } from './engine/types'
import { measureSvg, refreshOutputMetrics } from './pipeline'
import { chosenTrial, dropSvgUrl } from './store.svelte'

/** Edit one hinted shape of the item's chosen trial. Returns false when the edit is not possible. */
export function applyShapeEdit(item: Item, index: number, patch: ShapePatch): boolean {
  const current = chosenTrial(item)
  if (!current.shapes) return false
  const edited = editShape(current.svg, current.shapes, index, patch)
  if (!edited) return false

  const next: Trial = {
    ...current,
    base: false,
    traceMethod: 'shapes-edited',
    svg: edited.svg,
    shapes: edited.hints,
    sourceTrial: current.sourceTrial ?? item.chosen,
    // Provisional until the edited SVG is measured against the source below.
    metrics: { ...current.metrics, bytes: new Blob([edited.svg]).size },
    ms: 0,
  }
  // Keep a single edited variant per editing run: later edits replace it in place.
  let target = item.chosen
  if (current.traceMethod === 'shapes-edited') item.trials[target] = next
  else target = item.trials.push(next) - 1
  // The trial as stored (reactive). Undo / redo keep this same object, so the measurement below
  // lands on it even if the edit was undone and redone before the measurement finished.
  const stored = item.trials[target]
  dropSvgUrl(item, target)
  forgetTrialCaches(item)
  // Palette settings belong to a trial; carry them over to the variant.
  if (item.edit && item.edit.trial === item.chosen) item.edit = { ...item.edit, trial: target }
  item.chosen = target

  void measureSvg(item, edited.svg).then((metrics) => {
    if (!metrics || stored.svg !== edited.svg) return
    stored.metrics = { ...metrics, editableShare: editableShare(edited.svg, edited.hints) }
    stored.score = score(stored.metrics)
  }).catch(() => { /* keep the provisional metrics; the output measurement reports errors */ })
  refreshOutputMetrics(item)
  return true
}
