// Undo / redo for the Edit screen, one history per image.
//
// Every edit (palette filters, shape edits, groups) changes a few fields of the item: its filter
// settings, the chosen trial, the trial list (a shape edit adds or replaces a "shapes-edited"
// variant) and its grouping. A snapshot keeps references to those values; trial objects are
// replaced, never mutated, by an edit, so a shallow copy of the list is enough to restore them.
import { forgetTrialCaches } from './edit'
import type { Item, Trial } from './engine/types'
import { refreshOutputMetrics } from './pipeline'
import { dropSvgUrl, outsideEdits } from './store.svelte'

interface Snapshot {
  chosen: number
  trials: Trial[]
  edit: Item['edit']
  grouping: Item['grouping']
}

interface History {
  past: Snapshot[]
  future: Snapshot[]
  /** Consecutive records with the same key within COALESCE_MS are one step (a slider drag). */
  lastKey: string
  lastAt: number
  /** `outsideEdits[item.id]` when this history was started; a change empties it. */
  stamp: number
}

const LIMIT = 100
const COALESCE_MS = 800
// Plain storage (no deep proxies over trial lists); `version` is what the buttons react to.
const histories: Record<string, History> = {}
let version = $state(0)

function take(item: Item): Snapshot {
  return {
    chosen: item.chosen,
    trials: [...item.trials],
    edit: item.edit ? { settings: { ...item.edit.settings }, trial: item.edit.trial } : undefined,
    grouping: item.grouping,
  }
}

function historyOf(item: Item): History {
  const stamp = outsideEdits[item.id] ?? 0
  const h = (histories[item.id] ??= { past: [], future: [], lastKey: '', lastAt: 0, stamp })
  if (h.stamp !== stamp) Object.assign(h, { past: [], future: [], lastKey: '', lastAt: 0, stamp })
  return h
}

/** Call right before changing `item`. `key` groups a burst of similar changes into one step. */
export function record(item: Item, key: string) {
  const h = historyOf(item)
  const now = Date.now()
  const burst = key === h.lastKey && now - h.lastAt < COALESCE_MS
  h.lastKey = key
  h.lastAt = now
  if (burst) return
  h.past.push(take(item))
  if (h.past.length > LIMIT) h.past.shift()
  h.future = []
  version++
}

function restore(item: Item, snapshot: Snapshot) {
  const changed = new Set<number>()
  const length = Math.max(item.trials.length, snapshot.trials.length)
  for (let index = 0; index < length; index++) if (item.trials[index] !== snapshot.trials[index]) changed.add(index)
  item.trials = snapshot.trials
  item.chosen = snapshot.chosen
  item.edit = snapshot.edit
  item.grouping = snapshot.grouping
  for (const index of changed) dropSvgUrl(item, index)
  forgetTrialCaches(item)
  void refreshOutputMetrics(item)
}

function step(item: Item, from: 'past' | 'future') {
  const h = historyOf(item)
  const snapshot = h[from].pop()
  if (!snapshot) return false
  ;(from === 'past' ? h.future : h.past).push(take(item))
  // A new drag after an undo must open a new step, not merge into the restored one.
  h.lastKey = ''
  restore(item, snapshot)
  version++
  return true
}

export const undo = (item: Item) => step(item, 'past')
export const redo = (item: Item) => step(item, 'future')
const current = (item: Item) => {
  const h = histories[item.id]
  return h && h.stamp === (outsideEdits[item.id] ?? 0) ? h : undefined
}
export const canUndo = (item: Item | undefined) => version >= 0 && !!item && (current(item)?.past.length ?? 0) > 0
export const canRedo = (item: Item | undefined) => version >= 0 && !!item && (current(item)?.future.length ?? 0) > 0

/** Forget the newest step without restoring it: the change it was recorded for did not happen. */
export function dropLastStep(item: Item) {
  const h = current(item)
  if (!h?.past.length) return
  h.past.pop()
  h.lastKey = ''
  version++
}

