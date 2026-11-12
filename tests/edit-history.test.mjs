import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'

test('edit history undoes and redoes filters and shape variants, and merges slider bursts', async () => {
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' })
  try {
    const { record, undo, redo, canUndo, canRedo } = await server.ssrLoadModule('/src/lib/edit-history.svelte.ts')
    const { DEFAULT_FILTERS } = await server.ssrLoadModule('/src/lib/engine/palette.ts')
    const metrics = { pctDiff: 1, bytes: 10 }
    const traced = { params: {}, metrics, svg: '<svg/>' }
    const item = { id: 'h', name: 'h', status: 'done', chosen: 0, autoTuned: false, width: 1, height: 1, trials: [traced] }

    assert.equal(canUndo(item), false)
    // A slider drag: many records with one key inside the coalescing window make one step.
    for (const hue of [10, 20, 30]) {
      record(item, 'filter:hue')
      item.edit = { trial: 0, settings: { ...DEFAULT_FILTERS, hue } }
    }
    // A shape edit adds a variant and selects it.
    record(item, 'shape:0:cx')
    const edited = { ...traced, svg: '<svg id="e"/>', traceMethod: 'shapes-edited', sourceTrial: 0 }
    item.trials = [...item.trials, edited]
    item.chosen = 1
    item.edit = { trial: 1, settings: { ...DEFAULT_FILTERS, hue: 30 } }

    assert.equal(undo(item), true)
    assert.equal(item.chosen, 0)
    assert.equal(item.trials.length, 1)
    assert.equal(item.edit.settings.hue, 30)
    assert.equal(undo(item), true)
    assert.equal(item.edit, undefined, 'the whole drag is one step')
    assert.equal(canUndo(item), false)
    assert.equal(canRedo(item), true)

    assert.equal(redo(item), true)
    assert.equal(item.edit.settings.hue, 30)
    assert.equal(redo(item), true)
    assert.equal(item.chosen, 1)
    assert.equal(item.trials[1].svg, '<svg id="e"/>')
    assert.equal(canRedo(item), false)

    // A new edit after an undo drops the redo branch.
    undo(item)
    record(item, 'preset:mono')
    item.edit = { trial: 0, settings: { ...DEFAULT_FILTERS, theme: 'mono' } }
    assert.equal(canRedo(item), false)
  } finally { await server.close() }
})
