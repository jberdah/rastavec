<script lang="ts">
  import { untrack } from 'svelte'
  import { app, chosenTrial, clone, doneItems, go, outputMeasurementKey, outputMetrics } from '../store.svelte'
  import { DEFAULT_FILTERS, FILTER_PRESETS, MAX_COLOURS, isDefault, type FilterSettings, type PresetId } from '../engine/palette'
  import { appliedGrouping, filtered, keepingGroups } from '../edit'
  import { refreshOutputMetrics } from '../pipeline'
  import { downloadSvg } from '../export'
  import type { EngineShapeHint, GroupingMetadata, Item } from '../engine/types'
  import { num, pct, size, t } from '../i18n.svelte'
  import GroupReview from './GroupReview.svelte'
  import ShapeEditor from './ShapeEditor.svelte'
  import { applyShapeEdit } from '../shape-editing'
  import { crescentPath, editShape as editShapeSvg, editableShapes, keepRing, ringPath, type ShapePatch } from '../engine/shape-edits'
  import { groupsFromShapes } from '../engine/shape-groups'
  import { canRedo, canUndo, dropLastStep, record, redo, undo } from '../edit-history.svelte'
  import { publicAsset } from '../assets'

  type Bg = 'checker' | 'light' | 'dark'
  type Tab = 'colours' | 'shapes' | 'groups'
  let bg = $state<Bg>('checker')
  let tab = $state<Tab>('colours')
  let comparing = $state(false)

  const list = $derived(doneItems())
  const item = $derived(list.find((i) => i.id === app.selectedId) ?? list[0])
  const index = $derived(item ? list.indexOf(item) : -1)
  const step = (d: number) => {
    const next = list[(index + d + list.length) % list.length]
    if (next) app.selectedId = next.id
  }

  // Settings of the current item (stored on the item, valid for its chosen trial).
  const settings = $derived<FilterSettings>(item?.edit && item.edit.trial === item.chosen ? item.edit.settings : DEFAULT_FILTERS)
  function update(patch: Partial<FilterSettings>) {
    if (!item) return
    const target = item
    record(target, `filter:${Object.keys(patch).join(',')}`)
    const next = { settings: { ...clone(settings), ...patch }, trial: target.chosen }
    changeSvg(target, () => { target.edit = next })
  }
  function preset(id: PresetId) {
    if (!item) return
    const target = item
    record(target, `preset:${id}`)
    changeSvg(target, () => { target.edit = { settings: { ...DEFAULT_FILTERS, ...FILTER_PRESETS[id] }, trial: target.chosen } })
  }

  // Groups follow every edit that keeps the image's paths (a moved shape, new colours). An edit
  // that changes the paths themselves (Detail drops small shapes) cannot carry them: say so.
  // One entry per image whose groups an edit could not carry (apply-to-all can hit several). An
  // entry only shows while those groups still do not apply; undo / redo on that image clears it.
  let groupsLost = $state<Record<string, number>>({})
  function changeSvg<T>(target: Item, edit: () => T): T {
    const { result, groupsKept } = keepingGroups(target, edit)
    if (!groupsKept) groupsLost[target.id] = target.grouping?.groups.length ?? 0
    else if (target.id in groupsLost && appliedGrouping(target)) delete groupsLost[target.id]
    void refreshOutputMetrics(target)
    return result
  }
  const groupsApplied = $derived(item ? appliedGrouping(item) : undefined)
  const staleGroups = $derived(item && !groupsApplied ? item.grouping?.groups.length ?? 0 : 0)
  const lostHere = $derived(!!item && item.id in groupsLost && staleGroups > 0)
  // Other images of the batch that lost their groups (apply-to-all), so none loses them silently.
  const lostElsewhere = $derived(list.filter((other) => other.id !== item?.id && other.id in groupsLost && !!other.grouping?.groups.length && !appliedGrouping(other)).length)
  const activePreset = $derived(
    (Object.keys(FILTER_PRESETS) as PresetId[]).find((id) => {
      const p = { ...DEFAULT_FILTERS, ...FILTER_PRESETS[id] }
      return (Object.keys(p) as (keyof FilterSettings)[]).every((k) => p[k] === settings[k])
    }) ?? null,
  )

  const result = $derived(item ? filtered(item, clone(settings)) : null)
  const trial = $derived(item ? chosenTrial(item) : null)

  // ------------------------------------------------------------------ shapes on the canvas
  let selectedShape = $state<number | null>(null)
  let hoveredShape = $state<number | null>(null)
  $effect(() => {
    // A selection is an index into one item's trace; drop it when the item changes.
    void item?.id
    selectedShape = null
    hoveredShape = null
  })
  // Picking a shape anywhere opens the Shapes tools; leaving them drops the selection, so keys
  // pressed in another tab never move a shape nobody sees.
  $effect(() => {
    if (selectedShape !== null) untrack(() => { if (tab === 'colours') tab = 'shapes' })
  })
  $effect(() => {
    if (tab !== 'shapes') untrack(() => { selectedShape = null; cancelDrag() })
  })
  const viewBox = $derived(trial ? /\bviewBox="([^"]+)"/.exec(trial.svg)?.[1] ?? `0 0 ${item?.width ?? 0} ${item?.height ?? 0}` : '')
  const entries = $derived(trial?.shapes ? editableShapes(trial.svg, trial.shapes) : [])
  // Circles and ellipses can be picked on the canvas, in paint order so the topmost one wins.
  const pickable = $derived(entries.filter((entry) => entry.hint.kind !== 'path'))
  const selectedEntry = $derived(entries.find((entry) => entry.hint.index === selectedShape) ?? null)

  function editShape(index: number, patch: ShapePatch, key = `shape:${index}:${Object.keys(patch).join(',')}`) {
    if (!item) return
    const target = item
    record(target, key)
    // A refused edit (e.g. a non-positive radius typed in a field) changes nothing: no step.
    if (!changeSvg(target, () => applyShapeEdit(target, index, patch, { refresh: false }))) dropLastStep(target)
  }
  // Undo every shape edit: go back to the traced trial the edited variant came from.
  const canResetShapes = $derived(trial?.traceMethod === 'shapes-edited' && trial.sourceTrial !== undefined)
  function resetShapes() {
    if (!item || !trial || trial.sourceTrial === undefined) return
    const target = item, sourceTrial = trial.sourceTrial
    record(target, 'reset-shapes')
    changeSvg(target, () => {
      if (target.edit && target.edit.trial === target.chosen) target.edit = { ...target.edit, trial: sourceTrial }
      target.chosen = sourceTrial
    })
    selectedShape = null
  }
  // Recognised shapes are known objects: offer them to the Animate screen as ready-made groups.
  // The hints index the trace's paths, so this needs the filtered SVG to keep every path.
  const pathCount = (markup: string) => markup.match(/<path\b/g)?.length ?? 0
  const canAnimateShapes = $derived(!!result && !!trial?.shapes?.length && pathCount(result.svg) === pathCount(trial.svg))
  function animateShapes() {
    if (!item || !result || !trial?.shapes) return
    const grouping = groupsFromShapes(result.svg, trial.shapes, (hint, ordinal) =>
      `${hint.kind === 'circle' ? t('shapeEdit.circle') : hint.kind === 'ellipse' ? t('shapeEdit.ellipse') : hint.kind === 'crescent' ? t('shapeEdit.crescent') : hint.kind === 'ring' ? t('shapeEdit.ring') : t('shapeEdit.gradientRegion')} ${ordinal}`)
    if (!grouping) return
    saveGrouping(grouping)
    go('animate', item.id)
  }

  // Direct manipulation, like a vector editor: drag the body to move, a corner or side handle to
  // resize around the centre, the top handle to rotate an ellipse. The outline follows the pointer
  // and the shape is redrawn live; one edit (one undo step) is committed on release.
  // A crescent or a ring is edited by its two circles: the body and the outer handles act on the
  // outer one (moving carries the inner circle along), the inner circle has its own centre and
  // radius grips.
  type Mode = 'move' | 'resize' | 'rotate' | 'inner-move' | 'inner-resize'
  type Geometry = { cx: number; cy: number; rx: number; ry: number; rotation: number; icx: number; icy: number; ir: number }
  let drag = $state<{ index: number; mode: Mode; sx: number; sy: number; startX: number; startY: number; startLx: number; startLy: number; from: Geometry; to: Geometry } | null>(null)
  let gesture = 0
  // Pointer position in the shape's own (unrotated) frame, as distances from its centre.
  function localDistances(at: [number, number], from: Geometry): [number, number] {
    const a = (-from.rotation * Math.PI) / 180, dx = at[0] - from.cx, dy = at[1] - from.cy
    return [Math.abs(dx * Math.cos(a) - dy * Math.sin(a)), Math.abs(dx * Math.sin(a) + dy * Math.cos(a))]
  }
  let pickSvg = $state<SVGSVGElement | null>(null)
  const geometryOf = (hint: EngineShapeHint): Geometry => ({
    cx: hint.cx ?? 0, cy: hint.cy ?? 0, rx: hint.rx ?? hint.r ?? 0, ry: hint.ry ?? hint.r ?? 0,
    rotation: hint.kind === 'ellipse' ? hint.rotation ?? 0 : 0,
    icx: hint.innerCx ?? 0, icy: hint.innerCy ?? 0, ir: hint.innerR ?? 0,
  })
  const liveGeometry = (hint: EngineShapeHint): Geometry => (drag && drag.index === hint.index ? drag.to : geometryOf(hint))
  const kindOf = (index: number) => trial?.shapes?.find((shape) => shape.index === index)?.kind
  // Resized like a circle: circles, and a crescent's or ring's outer circle.
  const hasInner = (index: number) => kindOf(index) === 'crescent' || kindOf(index) === 'ring'
  const isCircle = (index: number) => kindOf(index) === 'circle' || hasInner(index)
  function toUser(event: PointerEvent): [number, number] | null {
    const matrix = pickSvg?.getScreenCTM()
    if (!matrix) return null
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse())
    return [point.x, point.y]
  }
  function startDrag(event: PointerEvent, hint: EngineShapeHint, mode: Mode, sx = 0, sy = 0) {
    event.stopPropagation()
    selectedShape = hint.index
    const movable = entries.find((entry) => entry.hint.index === hint.index)?.capabilities.geometry
    const at = movable ? toUser(event) : null
    if (!at) return
    ;(event.currentTarget as Element).setPointerCapture(event.pointerId)
    const from = geometryOf(hint)
    // For the inner radius grip, the distance is measured from the inner centre.
    const [startLx, startLy] = mode === 'inner-resize'
      ? [Math.hypot(at[0] - from.icx, at[1] - from.icy), 0]
      : localDistances(at, from)
    gesture++
    drag = { index: hint.index, mode, sx, sy, startX: at[0], startY: at[1], startLx, startLy, from, to: from }
  }
  function moveDrag(event: PointerEvent) {
    const at = drag ? toUser(event) : null
    if (!drag || !at) return
    const { from } = drag
    let to: Geometry = from
    const dx = at[0] - drag.startX, dy = at[1] - drag.startY
    if (drag.mode === 'move') {
      to = { ...from, cx: from.cx + dx, cy: from.cy + dy, icx: from.icx + dx, icy: from.icy + dy }
    } else if (drag.mode === 'inner-move') {
      to = { ...from, icx: from.icx + dx, icy: from.icy + dy }
    } else if (drag.mode === 'inner-resize') {
      to = { ...from, ir: Math.max(Math.min(1, from.ir), from.ir + Math.hypot(at[0] - from.icx, at[1] - from.icy) - drag.startLx) }
    } else if (drag.mode === 'rotate') {
      const angle = (Math.atan2(at[1] - from.cy, at[0] - from.cx) * 180) / Math.PI + 90
      to = { ...from, rotation: round1(((angle + 540) % 360) - 180) }
    } else {
      // Around the centre, by how far the pointer moved from where it was pressed, so pressing a
      // grip slightly off the drawn handle does not snap the size to the pointer.
      const [lx, ly] = localDistances(at, from)
      const growX = lx - drag.startLx, growY = ly - drag.startLy
      if (isCircle(drag.index)) {
        const grow = drag.sx && drag.sy ? (Math.abs(growX) > Math.abs(growY) ? growX : growY) : drag.sx ? growX : growY
        const r = Math.max(1, from.rx + grow)
        to = { ...from, rx: r, ry: r }
      } else {
        to = { ...from, rx: drag.sx ? Math.max(1, from.rx + growX) : from.rx, ry: drag.sy ? Math.max(1, from.ry + growY) : from.ry }
      }
    }
    if (kindOf(drag.index) === 'crescent') to = keepCrescent(to, drag.mode)
    else if (kindOf(drag.index) === 'ring') to = keepRing(to, from, drag.mode)
    drag = { ...drag, to }
    scheduleLive()
  }
  // A crescent exists only while its two circles cross (|r - ir| < d < r + ir). Clamp the value the
  // gesture changes, so the handle stops at the last valid crescent instead of the edit being
  // refused on release.
  function keepCrescent(g: Geometry, mode: Mode): Geometry {
    const margin = 0.5
    const d = Math.hypot(g.icx - g.cx, g.icy - g.cy)
    if (mode === 'inner-resize') {
      const lo = Math.max(1, Math.abs(g.rx - d) + margin), hi = g.rx + d - margin
      return lo < hi ? { ...g, ir: Math.min(hi, Math.max(lo, g.ir)) } : g
    }
    if (mode === 'resize') {
      const lo = Math.max(1, Math.abs(g.ir - d) + margin), hi = g.ir + d - margin
      const r = lo < hi ? Math.min(hi, Math.max(lo, g.rx)) : g.rx
      return { ...g, rx: r, ry: r }
    }
    if (mode === 'inner-move') {
      const lo = Math.abs(g.rx - g.ir) + margin, hi = g.rx + g.ir - margin
      // Exactly concentric has no direction to push along: step out to the right.
      if (d === 0) return { ...g, icx: g.cx + Math.min(hi, lo) }
      const k = Math.min(hi, Math.max(lo, d)) / d
      return { ...g, icx: g.cx + (g.icx - g.cx) * k, icy: g.cy + (g.icy - g.cy) * k }
    }
    return g
  }
  const round1 = (value: number) => Math.round(value * 10) / 10
  function patchOf(index: number, from: Geometry, to: Geometry, mode: Mode): ShapePatch {
    const patch: ShapePatch = {}
    if (to.cx !== from.cx) patch.cx = round1(to.cx)
    if (to.cy !== from.cy) patch.cy = round1(to.cy)
    if (isCircle(index)) {
      if (to.rx !== from.rx) patch.r = round1(to.rx)
      if (hasInner(index)) {
        // Moving the whole crescent or ring carries the inner circle (shape-edits does that, keeping the
        // exact offset); only an inner-circle gesture places it explicitly.
        if (mode === 'inner-move') { patch.innerCx = round1(to.icx); patch.innerCy = round1(to.icy) }
        if (to.ir !== from.ir) patch.innerR = round1(to.ir)
      }
    } else {
      if (to.rx !== from.rx) patch.rx = round1(to.rx)
      if (to.ry !== from.ry) patch.ry = round1(to.ry)
      if (to.rotation !== from.rotation) patch.rotation = to.rotation
    }
    return patch
  }
  function endDrag() {
    const done = drag
    drag = null
    livePreview = null
    if (!done) return
    const patch = patchOf(done.index, done.from, done.to, done.mode)
    const moved = done.mode === 'inner-move'
      ? Math.hypot(done.to.icx - done.from.icx, done.to.icy - done.from.icy) >= 0.5
      : Math.hypot(done.to.cx - done.from.cx, done.to.cy - done.from.cy) >= 0.5
    if (Object.keys(patch).length && ((done.mode !== 'move' && done.mode !== 'inner-move') || moved)) editShape(done.index, patch, `drag:${gesture}`)
  }
  // An interrupted gesture (pointer lost, undo, tab change) is dropped, never committed.
  function cancelDrag() {
    drag = null
    livePreview = null
  }

  // Live redraw while dragging. Palette filters are recomputed on release, so the live frame is the
  // unfiltered edit; with filters active only the outline follows the pointer.
  let livePreview = $state<string | null>(null)
  let liveFrame = 0
  function scheduleLive() {
    if (liveFrame || !isDefault(settings)) return
    liveFrame = requestAnimationFrame(() => {
      liveFrame = 0
      if (!drag || !trial?.shapes) return
      const patch = patchOf(drag.index, drag.from, drag.to, drag.mode)
      livePreview = Object.keys(patch).length ? editShapeSvg(trial.svg, trial.shapes, drag.index, patch)?.svg ?? null : null
    })
  }

  // Handles keep a constant on-screen size whatever the image size: units per screen pixel.
  let unitsPerPx = $state(1)
  $effect(() => {
    const svg = pickSvg
    if (!svg) return
    const measure = () => {
      const box = svg.getBoundingClientRect()
      const [, , w, h] = viewBox.split(/[\s,]+/).map(Number)
      if (box.width && box.height && w && h) unitsPerPx = 1 / Math.min(box.width / w, box.height / h)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(svg)
    return () => observer.disconnect()
  })
  const HANDLES: [number, number][] = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]]
  const CORNERS: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]]
  // Below this on-screen radius only the corner handles are drawn, with grips no larger than the
  // drawn squares, so the middle of a small shape still moves it.
  const SMALL_SHAPE_PX = 24
  const isSmall = (g: Geometry) => Math.min(g.rx, g.ry) / unitsPerPx < SMALL_SHAPE_PX
  const handleCursor = (sx: number, sy: number) => (sx && sy ? (sx === sy ? 'nwse-resize' : 'nesw-resize') : sx ? 'ew-resize' : 'ns-resize')

  function saveGrouping(grouping: GroupingMetadata) {
    if (!item) return
    record(item, 'grouping')
    const previousKey = outputMeasurementKey(item)
    item.grouping = grouping
    if (outputMeasurementKey(item) !== previousKey) void refreshOutputMetrics(item)
  }

  // Preview URL of the filtered SVG (or of the live drag frame).
  let outUrl = $state<string | null>(null)
  $effect(() => {
    const svg = livePreview ?? result?.svg
    if (!svg) return
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
    outUrl = url
    return () => setTimeout(() => URL.revokeObjectURL(url), 2000)
  })

  const fidelity = $derived(item ? outputMetrics(item)?.pctDiff ?? null : null)
  const measuring = $derived(!!item && !outputMetrics(item))

  function applyToAll() {
    if (!item) return
    const s = clone(settings)
    for (const i of list) {
      record(i, 'apply-all')
      changeSvg(i, () => { i.edit = { settings: clone(s), trial: i.chosen } })
    }
  }
  const appliedCount = $derived(list.filter((i) => i.edit && i.edit.trial === i.chosen && !isDefault(i.edit.settings)).length)

  // Bumped on undo / redo: the groups panel keeps its own copy of the groups and is remounted
  // from the restored ones, otherwise its next action would push the undone state back.
  let restored = $state(0)
  function doUndo() { cancelDrag(); if (item && undo(item)) { selectedShape = null; restored++; delete groupsLost[item.id] } }
  function doRedo() { cancelDrag(); if (item && redo(item)) { selectedShape = null; restored++; delete groupsLost[item.id] } }

  // Keyboard: undo / redo, Escape to deselect, arrows to nudge the selected shape.
  function onKey(event: KeyboardEvent) {
    const target = event.target as HTMLElement | null
    const typing = !!target && (target.isContentEditable || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT'
      || (target.tagName === 'INPUT' && !['range', 'checkbox', 'radio', 'button', 'color'].includes((target as HTMLInputElement).type)))
    if (typing || !item || app.route !== 'edit') return
    const mod = event.ctrlKey || event.metaKey
    const key = event.key.toLowerCase()
    if (mod && key === 'z') { event.preventDefault(); if (event.shiftKey) doRedo(); else doUndo(); return }
    if (mod && key === 'y') { event.preventDefault(); doRedo(); return }
    if (event.key === 'Escape' && selectedShape !== null) { selectedShape = null; return }
    const navigating = !!target?.closest('[role=tree], [role=treeitem], [role=grid], [role=tablist]')
    if (tab === 'shapes' && selectedEntry?.capabilities.geometry && event.key.startsWith('Arrow') && !mod && target?.tagName !== 'INPUT' && !navigating) {
      event.preventDefault()
      const by = event.shiftKey ? 10 : 1
      const hint = selectedEntry.hint
      const dx = event.key === 'ArrowLeft' ? -by : event.key === 'ArrowRight' ? by : 0
      const dy = event.key === 'ArrowUp' ? -by : event.key === 'ArrowDown' ? by : 0
      editShape(hint.index, { cx: round1((hint.cx ?? 0) + dx), cy: round1((hint.cy ?? 0) + dy) }, `nudge:${hint.index}`)
    }
  }

  // One row of looks. Themes (Brand … Neon) live here only; the old separate Palette card offered
  // the same themes under other names. Demo values (Hue +140°, Orange → violet) are left to the sliders.
  const PRESET_IDS: PresetId[] = ['original', 'flat12', 'flat6', 'sticker', 'brand', 'duo', 'mono', 'pastel', 'night']

  // The colour-family card opens on its own only when the image already uses it; afterwards the
  // user decides, so a slider dragged back to "off" does not collapse under the pointer.
  let familyOpen = $state(false)
  $effect(() => {
    void item?.id
    untrack(() => { familyOpen = settings.range > 0 })
  })

  const bgStyle = $derived(bg === 'light' ? '#ffffff' : bg === 'dark' ? '#202020' : 'var(--checker)')
  const hueSwatch = (h: number) => `oklch(0.72 0.15 ${h})`
  const signed = (v: number) => (v > 0 ? `+${v}` : `${v}`)
</script>

<svelte:window onkeydown={onKey} />

{#if !item || !trial || !result}
  <div class="card stack" style="max-width: 560px; align-items: flex-start">
    <img src={publicAsset('brand/mascot-laptop.webp')} alt="" width="160" height="160" style="width: 160px; height: auto" />
    <h1>{t('edit.empty')}</h1>
    <button type="button" class="btn" onclick={() => go('import')}>{t('detail.import')}</button>
  </div>
{:else}
  <div class="stack" style="gap: 16px">
    <div class="between">
      <div class="row" style="flex-wrap: wrap; gap: 12px">
        <button type="button" class="btn" onclick={() => go('lot')}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
          {t('detail.back')}
        </button>
        <h1 class="mono name">{item.name}</h1>
        {#if !isDefault(settings) || trial.traceMethod === 'shapes-edited'}<span class="chip chip-accent">{t('edit.edited')}</span>{/if}
        {#if list.length > 1}
          <span class="row" style="gap: 6px">
            <button type="button" class="btn icon-btn" aria-label={t('detail.prev')} onclick={() => step(-1)}>‹</button>
            <span class="mono muted small">{index + 1} / {list.length}</span>
            <button type="button" class="btn icon-btn" aria-label={t('detail.next')} onclick={() => step(1)}>›</button>
          </span>
        {/if}
      </div>
      <!-- The actions that finish the job stay in view instead of closing a long sidebar. -->
      <div class="row actions">
        <span class="row history">
          <button type="button" class="btn icon-btn" aria-label={t('edit.undo')} title={t('edit.undo')} disabled={!canUndo(item)} onclick={doUndo}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14 4 9l5-5" /><path d="M4 9h11a5 5 0 0 1 0 10h-3" /></svg>
          </button>
          <button type="button" class="btn icon-btn" aria-label={t('edit.redo')} title={t('edit.redo')} disabled={!canRedo(item)} onclick={doRedo}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 14 5-5-5-5" /><path d="M20 9H9a5 5 0 0 0 0 10h3" /></svg>
          </button>
        </span>
        {#if list.length > 1}<button type="button" class="btn" onclick={applyToAll}>{t('edit.applyAll', list.length)}</button>{/if}
        <button type="button" class="btn btn-primary" onclick={() => downloadSvg(item)}>{t('detail.download')}</button>
      </div>
    </div>
    {#if appliedCount > 1}<span class="muted tiny">{t('edit.appliedCount', appliedCount)}</span>{/if}

    <!-- Every tool is one click away, groups included, instead of folded at the bottom of the page. -->
    <div class="tabs" role="tablist" aria-label={t('edit.tabs')}>
      <button type="button" role="tab" aria-selected={tab === 'colours'} onclick={() => (tab = 'colours')}>{t('edit.tab.colours')}</button>
      <button type="button" role="tab" aria-selected={tab === 'shapes'} onclick={() => (tab = 'shapes')}>{t('edit.tab.shapes')} <span class="count">{entries.length}</span></button>
      <button type="button" role="tab" aria-selected={tab === 'groups'} onclick={() => (tab = 'groups')}>{t('edit.tab.groups')}{#if groupsApplied?.groups.length}<span class="count">{groupsApplied.groups.length}</span>{:else if staleGroups}<span class="count stale" title={t('edit.groupsStale', staleGroups)}>!</span>{/if}</button>
    </div>
    {#if lostHere}<p class="notice small" role="status">{t('edit.groupsLost', groupsLost[item.id] || staleGroups)}</p>{/if}
    {#if lostElsewhere}<p class="notice small" role="status">{t('edit.groupsLostElsewhere', lostElsewhere)}</p>{/if}

    {#if tab === 'groups'}
      <p class="muted small intro">{t('edit.groupHint')}</p>
      {#if staleGroups && !lostHere}<p class="notice small" role="status">{t('edit.groupsStale', staleGroups)}</p>{/if}
      {#key restored}
      <GroupReview embedded svg={result.svg} name={item.name} grouping={item.grouping} sourceImage={{ url: item.srcUrl, width: item.width, height: item.height }} onGroupingChange={saveGrouping} />
      {/key}
    {:else}
      <div class="wrap" style="gap: 20px; align-items: flex-start">
        <!-- One large canvas; the original image is shown on demand instead of a permanent "Before" half. -->
        <section class="stagecol">
          <div class="between toolbar">
            <button type="button" class="btn compare" aria-pressed={comparing} onclick={() => (comparing = !comparing)}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M12 4v16" /></svg>
              {t('edit.compare')}
            </button>
            <div class="seg" role="group" aria-label={t('detail.bgGroup')}>
              <button type="button" aria-label={t('detail.bgChecker')} aria-pressed={bg === 'checker'} onclick={() => (bg = 'checker')}><span class="swatch checker"></span></button>
              <button type="button" aria-label={t('detail.bgLight')} aria-pressed={bg === 'light'} onclick={() => (bg = 'light')}><span class="swatch" style="background: #fff"></span></button>
              <button type="button" aria-label={t('detail.bgDark')} aria-pressed={bg === 'dark'} onclick={() => (bg = 'dark')}><span class="swatch" style="background: #202020"></span></button>
            </div>
          </div>
          <div class="stage" class:shapes-mode={tab === 'shapes'} style:background={bgStyle}>
            {#if comparing}
              <img class="fit" src={item.srcUrl} alt={t('edit.original')} />
              <span class="lab mono">{t('edit.original')}</span>
            {:else}
              {#if outUrl}<img class="fit" src={outUrl} alt={t('edit.after')} />{/if}
              {#if pickable.length || selectedEntry}
                <!-- Laid out exactly like the preview image: hit targets and outlines for the shapes,
                     and a selection frame with handles on the selected one. -->
                <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
                <svg class="fit pick" bind:this={pickSvg} {viewBox} preserveAspectRatio="xMidYMid meet" onclick={(event) => { if (event.target === event.currentTarget) selectedShape = null }}>
                  {#each pickable as entry (entry.hint.index)}
                    {@const g = liveGeometry(entry.hint)}
                    {#if entry.hint.kind === 'crescent' || entry.hint.kind === 'ring'}
                      <!-- The real outline, so a ring's hole is not part of the hit target. -->
                      <path
                        class="target" class:movable={entry.capabilities.geometry} class:hover={hoveredShape === entry.hint.index} class:on={selectedShape === entry.hint.index}
                        d={(entry.hint.kind === 'ring' ? ringPath(g.cx, g.cy, g.rx, g.icx, g.icy, g.ir, 0) : crescentPath(g.cx, g.cy, g.rx, g.icx, g.icy, g.ir)) ?? ''}
                        onpointerenter={() => (hoveredShape = entry.hint.index)} onpointerleave={() => (hoveredShape = null)}
                        onpointerdown={(event) => startDrag(event, entry.hint, 'move')} onpointermove={moveDrag} onpointerup={endDrag} onpointercancel={cancelDrag}
                      />
                    {:else}
                      <ellipse
                        class="target" class:movable={entry.capabilities.geometry} class:hover={hoveredShape === entry.hint.index} class:on={selectedShape === entry.hint.index}
                        cx={g.cx} cy={g.cy} rx={g.rx} ry={g.ry} transform={`rotate(${g.rotation} ${g.cx} ${g.cy})`}
                        onpointerenter={() => (hoveredShape = entry.hint.index)} onpointerleave={() => (hoveredShape = null)}
                        onpointerdown={(event) => startDrag(event, entry.hint, 'move')} onpointermove={moveDrag} onpointerup={endDrag} onpointercancel={cancelDrag}
                      />
                    {/if}
                  {/each}
                  {#if selectedEntry && selectedEntry.hint.kind !== 'path'}
                    {@const hint = selectedEntry.hint}
                    {@const g = liveGeometry(hint)}
                    {@const hs = 9 * unitsPerPx}
                    <g transform={`rotate(${g.rotation} ${g.cx} ${g.cy})`}>
                      <rect class="frame" x={g.cx - g.rx} y={g.cy - g.ry} width={g.rx * 2} height={g.ry * 2} />
                      <!-- A move-only shape (a glow is cut to it) gets no resize or rotate handles. -->
                      {#if selectedEntry.capabilities.geometry && !selectedEntry.capabilities.moveOnly}
                        {#if hint.kind === 'ellipse'}
                          <line class="frame" x1={g.cx} y1={g.cy - g.ry} x2={g.cx} y2={g.cy - g.ry - 26 * unitsPerPx} />
                          <circle class="handle" cx={g.cx} cy={g.cy - g.ry - 26 * unitsPerPx} r={hs * 0.6} />
                          <circle class="hit rotate" cx={g.cx} cy={g.cy - g.ry - 26 * unitsPerPx} r={hs * 1.2}
                            onpointerdown={(event) => startDrag(event, hint, 'rotate')} onpointermove={moveDrag} onpointerup={endDrag} onpointercancel={cancelDrag} />
                        {/if}
                        {@const small = isSmall(g)}
                        {@const grip = small ? hs / 2 : hs}
                        {#each small ? CORNERS : HANDLES as [sx, sy] (`${sx}${sy}`)}
                          <rect class="handle" x={g.cx + sx * g.rx - hs / 2} y={g.cy + sy * g.ry - hs / 2} width={hs} height={hs} />
                          <!-- A larger invisible grip than the drawn square, so handles are easy to catch
                               (not on small shapes, where it would cover the body). -->
                          <rect class="hit" style:cursor={handleCursor(sx, sy)} x={g.cx + sx * g.rx - grip} y={g.cy + sy * g.ry - grip} width={grip * 2} height={grip * 2}
                            onpointerdown={(event) => startDrag(event, hint, 'resize', sx, sy)} onpointermove={moveDrag} onpointerup={endDrag} onpointercancel={cancelDrag} />
                        {/each}
                      {/if}
                    </g>
                    {#if (hint.kind === 'crescent' || hint.kind === 'ring') && selectedEntry.capabilities.geometry && !selectedEntry.capabilities.moveOnly}
                      <!-- The disc taken out of the crescent or ring: drag its centre to move it, its rim grip to resize it. -->
                      <circle class="frame inner" cx={g.icx} cy={g.icy} r={g.ir} />
                      <circle class="handle" cx={g.icx} cy={g.icy} r={hs * 0.55} />
                      <circle class="hit" style:cursor="move" cx={g.icx} cy={g.icy} r={hs * 1.1}
                        onpointerdown={(event) => startDrag(event, hint, 'inner-move')} onpointermove={moveDrag} onpointerup={endDrag} onpointercancel={cancelDrag} />
                      <rect class="handle" x={g.icx + g.ir - hs / 2} y={g.icy - hs / 2} width={hs} height={hs} />
                      <rect class="hit" style:cursor="ew-resize" x={g.icx + g.ir - hs} y={g.icy - hs} width={hs * 2} height={hs * 2}
                        onpointerdown={(event) => startDrag(event, hint, 'inner-resize')} onpointermove={moveDrag} onpointerup={endDrag} onpointercancel={cancelDrag} />
                    {/if}
                  {:else if selectedEntry}
                    {@const b = selectedEntry.hint.bounds}
                    <rect class="frame" x={b[0]} y={b[1]} width={b[2] - b[0]} height={b[3] - b[1]} />
                  {/if}
                </svg>
              {/if}
            {/if}
          </div>
          <!-- Live result, right under the canvas it describes. -->
          <div class="resultbar" aria-label={t('edit.result')}>
            <span><span class="muted tiny">{t('edit.coloursStat')}</span> <b>{num(result.colours)}</b></span>
            <span><span class="muted tiny">{t('edit.shapesStat')}</span> <b>{num(result.kept)}</b><span class="muted tiny"> / {num(result.total)}</span></span>
            <span><span class="muted tiny">{t('stat.size')}</span> <b>{size(new Blob([result.svg]).size)}</b></span>
            <span><span class="muted tiny">{t('edit.diff')}</span> <b class="mono" class:faint={measuring}>{fidelity === null ? '…' : pct(fidelity)}</b> <span class="faint tiny mono">({t('edit.trace')} {pct(trial.metrics.pctDiff)})</span></span>
            <span class="pal" aria-label={t('edit.palette')}>
              {#each result.palette.slice(0, 24) as h (h)}<span style:background={h} title={h}></span>{/each}
            </span>
          </div>
        </section>

        <aside class="panel">
          {#if tab === 'shapes'}
            {#if entries.length}
              <ShapeEditor svg={trial.svg} shapes={trial.shapes ?? []} bind:selected={selectedShape} bind:hovered={hoveredShape} onEdit={editShape} onReset={canResetShapes ? resetShapes : undefined} onAnimate={canAnimateShapes ? animateShapes : undefined} />
            {:else}
              <div class="card stack"><h2 class="h3">{t('shapeEdit.title')}</h2><span class="muted small">{t('edit.noShapes')}</span></div>
            {/if}
          {:else}
            <div class="card stack">
              <div class="between"><h2 class="h3">{t('edit.presets')}</h2><span class="muted tiny">{t('edit.presetsHint')}</span></div>
              <div class="presets">
                {#each PRESET_IDS as id (id)}
                  <button type="button" class="preset" aria-pressed={activePreset === id} onclick={() => preset(id)}>{t(`edit.preset.${id}` as 'edit.preset.original')}</button>
                {/each}
              </div>
              <button type="button" class="btn reset" disabled={isDefault(settings)} onclick={() => preset('original')}>{t('edit.reset')}</button>
            </div>

            <div class="card stack">
              <h2 class="h3">{t('edit.simplify')}</h2>
              <div class="field">
                <label for="f-colours"><span>{t('edit.colours')}</span><span class="value accent">{settings.colours >= MAX_COLOURS ? t('edit.all') : settings.colours}</span></label>
                <input id="f-colours" type="range" min="2" max={MAX_COLOURS} step="1" value={settings.colours} oninput={(e) => update({ colours: +e.currentTarget.value })} />
              </div>
              <div class="field">
                <label for="f-detail"><span>{t('edit.detail')}</span><span class="value accent">{settings.detail ? t('edit.detailValue', pct(settings.detail / 20, 2)) : t('edit.off')}</span></label>
                <input id="f-detail" type="range" min="0" max="40" step="1" value={settings.detail} oninput={(e) => update({ detail: +e.currentTarget.value })} />
              </div>
              <span class="muted tiny">{t('edit.detailHint')}</span>
            </div>

            <div class="card stack">
              <h2 class="h3">{t('edit.adjust')}</h2>
              <div class="field">
                <label for="f-hue"><span>{t('edit.hue')}</span><span class="value accent">{signed(settings.hue)}°</span></label>
                <input id="f-hue" type="range" min="-180" max="180" step="5" value={settings.hue} oninput={(e) => update({ hue: +e.currentTarget.value })} />
              </div>
              <div class="field">
                <label for="f-sat"><span>{t('edit.sat')}</span><span class="value accent">{pct(settings.sat, 0)}</span></label>
                <input id="f-sat" type="range" min="0" max="200" step="5" value={settings.sat} oninput={(e) => update({ sat: +e.currentTarget.value })} />
              </div>
              <div class="field">
                <label for="f-light"><span>{t('edit.light')}</span><span class="value accent">{signed(settings.light)}</span></label>
                <input id="f-light" type="range" min="-30" max="30" step="1" value={settings.light} oninput={(e) => update({ light: +e.currentTarget.value })} />
              </div>
              <div class="field">
                <label for="f-contrast"><span>{t('edit.contrast')}</span><span class="value accent">{pct(settings.contrast, 0)}</span></label>
                <input id="f-contrast" type="range" min="50" max="150" step="5" value={settings.contrast} oninput={(e) => update({ contrast: +e.currentTarget.value })} />
              </div>
            </div>

            <details class="card fold" bind:open={familyOpen}>
              <summary><h2 class="h3">{t('edit.family')}</h2>{#if settings.range}<span class="value accent mono tiny">±{settings.range}°</span>{/if}</summary>
              <div class="stack fold-body">
                <div class="field">
                  <label for="f-from"><span class="row" style="gap: 8px"><span class="hue" style:background={hueSwatch(settings.from)}></span>{t('edit.from')}</span><span class="value accent">{settings.from}°</span></label>
                  <input id="f-from" type="range" min="0" max="360" step="5" value={settings.from} oninput={(e) => update({ from: +e.currentTarget.value })} />
                </div>
                <div class="field">
                  <label for="f-range"><span>{t('edit.range')}</span><span class="value accent">{settings.range ? `±${settings.range}°` : t('edit.off')}</span></label>
                  <input id="f-range" type="range" min="0" max="90" step="5" value={settings.range} oninput={(e) => update({ range: +e.currentTarget.value })} />
                </div>
                <div class="field">
                  <label for="f-to"><span class="row" style="gap: 8px"><span class="hue" style:background={hueSwatch(settings.to)}></span>{t('edit.to')}</span><span class="value accent">{settings.to}°</span></label>
                  <input id="f-to" type="range" min="0" max="360" step="5" value={settings.to} oninput={(e) => update({ to: +e.currentTarget.value })} />
                </div>
              </div>
            </details>
          {/if}
        </aside>
      </div>
    {/if}
  </div>
{/if}

<style>
  .name { font-size: 22px; font-weight: 500; }
  .small { font-size: 13px; }
  .tiny { font-size: 12px; }
  .h3 { font-size: 16px; }
  .actions { flex-wrap: wrap; gap: 8px; }
  .history { gap: 4px; }
  .tabs { display: flex; gap: 4px; padding: 4px; border-radius: 14px; background: var(--surface); border: 1px solid var(--line-2); align-self: flex-start; }
  .tabs button { display: inline-flex; align-items: center; gap: 8px; min-height: 38px; padding: 0 18px; border-radius: 10px; border: 0; background: transparent; color: var(--muted); font-size: 14px; font-weight: 500; cursor: pointer; }
  .tabs button[aria-selected='true'] { background: var(--accent); color: #0a0b0f; }
  .tabs .count { font-family: 'Geist Mono', monospace; font-size: 12px; padding: 1px 7px; border-radius: 999px; background: rgba(255, 255, 255, 0.12); }
  .tabs button[aria-selected='true'] .count { background: rgba(10, 11, 15, 0.18); }
  .tabs .count.stale { color: var(--warn-text); background: var(--warn-bg); border: 1px solid var(--warn-line); }
  .notice { margin: 0; padding: 8px 12px; border-radius: 10px; color: var(--warn-text); background: var(--warn-bg); border: 1px solid var(--warn-line); }
  .stagecol { flex: 999 1 600px; min-width: 0; display: flex; flex-direction: column; gap: 12px; }
  @media (min-width: 1000px) { .stagecol { position: sticky; top: 96px; } }
  .toolbar { gap: 12px; }
  .compare { min-height: 36px; font-size: 13px; }
  .compare[aria-pressed='true'] { border-color: var(--accent); color: var(--accent-text, var(--accent)); }
  .panel { flex: 1 1 340px; min-width: 0; display: flex; flex-direction: column; gap: 14px; }
  .stage { position: relative; height: clamp(300px, calc(100vh - 400px), 860px); border-radius: 22px; overflow: hidden; border: 1px solid var(--line-2); }
  .fit { position: absolute; inset: 4%; width: 92%; height: 92%; object-fit: contain; }
  .pick { overflow: visible; touch-action: none; }
  .pick .target { fill: transparent; stroke: none; cursor: pointer; }
  .pick .target.movable { cursor: move; }
  /* In the Shapes tab every recognised shape is outlined, so what can be edited is visible. */
  .shapes-mode .pick .target { stroke: rgba(255, 255, 255, 0.6); stroke-width: 1; stroke-dasharray: 4 3; vector-effect: non-scaling-stroke; }
  .pick .target.hover, .pick .target.on { stroke: var(--accent); stroke-width: 2; stroke-dasharray: none; vector-effect: non-scaling-stroke; }
  .pick .frame { fill: none; stroke: var(--accent); stroke-width: 1; stroke-dasharray: 5 4; vector-effect: non-scaling-stroke; pointer-events: none; }
  .pick .frame.inner { stroke: #fff; stroke-dasharray: 3 3; }
  .pick .handle { fill: #fff; stroke: var(--accent); stroke-width: 1.5; vector-effect: non-scaling-stroke; pointer-events: none; }
  .pick .hit { fill: transparent; stroke: none; }
  .pick .hit.rotate { cursor: grab; }
  .lab { position: absolute; top: 14px; left: 14px; font-size: 12px; border-radius: 6px; padding: 4px 8px; background: rgba(10, 11, 15, 0.85); }
  .swatch { display: block; width: 20px; height: 20px; border-radius: 6px; border: 1px solid var(--line-3); background-size: 8px 8px; }
  .presets { display: grid; grid-template-columns: repeat(auto-fill, minmax(118px, 1fr)); gap: 8px; }
  .preset { min-height: 40px; padding: 0 12px; border-radius: 10px; border: 1px solid var(--line-2); background: var(--surface-2); font-size: 14px; }
  .preset:hover { border-color: var(--accent-line); }
  .preset[aria-pressed='true'] { background: var(--accent); border-color: var(--accent); color: #0a0b0f; font-weight: 600; }
  .reset { align-self: flex-start; }
  .intro { margin: 0; max-width: 760px; }
  .hue { display: inline-block; width: 14px; height: 14px; border-radius: 50%; border: 1px solid var(--line-3); }
  .resultbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 22px; padding: 12px 16px; border-radius: 14px; border: 1px solid var(--line-2); background: var(--surface); font-size: 14px; }
  .resultbar b { font-weight: 600; }
  .pal { display: flex; flex-wrap: wrap; gap: 3px; margin-left: auto; }
  .pal span { width: 14px; height: 14px; border-radius: 4px; border: 1px solid rgba(255, 255, 255, 0.12); }
  .fold > summary { display: flex; align-items: center; justify-content: space-between; gap: 12px; cursor: pointer; list-style: none; }
  .fold > summary::-webkit-details-marker { display: none; }
  .fold > summary::after { content: ''; flex: none; width: 8px; height: 8px; border-right: 2px solid var(--muted); border-bottom: 2px solid var(--muted); transform: rotate(45deg); transition: transform 0.15s; }
  .fold[open] > summary::after { transform: rotate(-135deg); }
  .fold > summary > :first-child { margin-right: auto; }
  .fold-body { padding-top: 14px; }
  .fold-body.stack { gap: 14px; }
</style>
