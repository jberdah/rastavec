<script lang="ts">
  // Lists the shapes the engine recognised in the chosen trace and edits the selected one by
  // its parameters: centre and radius of a circle, axes and rotation of an ellipse, flat fill
  // or gradient stop colours.
  import { editableShapes, type ShapePatch } from '../engine/shape-edits'
  import type { EngineShapeHint } from '../engine/types'
  import { t } from '../i18n.svelte'

  let { svg, shapes, selected = $bindable(null), hovered = $bindable(null), onEdit, onReset, onAnimate }: {
    svg: string
    shapes: EngineShapeHint[]
    selected?: number | null
    /** Shape under the pointer, on the canvas or in this list; each highlights the other. */
    hovered?: number | null
    onEdit: (index: number, patch: ShapePatch) => void
    /** Present when shape edits can be undone. */
    onReset?: () => void
    /** Present when the recognised shapes can be sent to the Animate screen as groups. */
    onAnimate?: () => void
  } = $props()

  const entries = $derived(editableShapes(svg, shapes))
  const current = $derived(entries.find((entry) => entry.hint.index === selected) ?? null)
  const label = (hint: EngineShapeHint) =>
    hint.overlayOf !== undefined ? t('shapeEdit.overlay') : hint.kind === 'circle' ? t('shapeEdit.circle') : hint.kind === 'ellipse' ? t('shapeEdit.ellipse') : hint.kind === 'crescent' ? t('shapeEdit.crescent') : t('shapeEdit.gradientRegion')
  // Layer names like a vector editor: "Circle 1", "Ellipse 2"…, numbered per kind in paint order.
  const names = $derived.by(() => {
    const counts = new Map<string, number>()
    return new Map(entries.map((entry) => {
      const base = label(entry.hint)
      const n = (counts.get(base) ?? 0) + 1
      counts.set(base, n)
      return [entry.hint.index, `${base} ${n}`]
    }))
  })
  const swatch = (entry: (typeof entries)[number]) => {
    const { fill, stops } = entry.capabilities
    return fill ?? (stops && stops.length > 1 ? `linear-gradient(90deg, ${stops.join(', ')})` : stops?.[0] ?? 'transparent')
  }
  const fields = $derived.by(() => {
    const hint = current?.hint
    if (!hint || !current?.capabilities?.geometry) return []
    const centre = [{ key: 'cx', value: hint.cx }, { key: 'cy', value: hint.cy }] as const
    if (hint.kind === 'crescent') {
      return [...centre, { key: 'r', value: hint.r } as const, { key: 'innerCx', value: hint.innerCx } as const,
        { key: 'innerCy', value: hint.innerCy } as const, { key: 'innerR', value: hint.innerR } as const]
    }
    return hint.kind === 'circle'
      ? [...centre, { key: 'r', value: hint.r } as const]
      : [...centre, { key: 'rx', value: hint.rx } as const, { key: 'ry', value: hint.ry } as const, { key: 'rotation', value: hint.rotation } as const]
  })
  function setNumber(key: keyof ShapePatch, raw: string) {
    const value = Number(raw)
    if (selected === null || raw.trim() === '' || !Number.isFinite(value)) return
    onEdit(selected, { [key]: value })
  }
  function setStop(position: number, colour: string) {
    if (selected === null) return
    const stops: (string | undefined)[] = []
    stops[position] = colour
    onEdit(selected, { stops })
  }
</script>

<div class="card stack">
  <div class="between"><h2 class="h3">{t('shapeEdit.title')}</h2><span class="muted tiny">{t('shapeEdit.hint')}</span></div>
  <span class="muted tiny">{t('shapeEdit.pick')}</span>
  <div class="shapes" role="listbox" aria-label={t('shapeEdit.title')}>
    {#each entries as entry (entry.hint.index)}
      <button type="button" class="shape" class:hover={hovered === entry.hint.index} role="option" aria-selected={selected === entry.hint.index}
        onclick={() => (selected = selected === entry.hint.index ? null : entry.hint.index)}
        onmouseenter={() => (hovered = entry.hint.index)} onmouseleave={() => (hovered = null)}>
        <span class="dot" style:background={swatch(entry)}></span><span class="nm">{names.get(entry.hint.index)}</span>
        {#if !entry.capabilities.geometry}<span class="muted tiny lock" title={t('shapeEdit.geometryLocked')}>🔒</span>{/if}
      </button>
    {/each}
  </div>
  {#if current}
    {#if fields.length}
      <div class="grid">
        {#each fields as field (field.key)}
          <label class="num"><span class="muted tiny">{t(`shapeEdit.${field.key}`)}</span>
            <input type="number" step="1" min={field.key === 'r' || field.key === 'rx' || field.key === 'ry' || field.key === 'innerR' ? 1 : undefined} value={Math.round((field.value ?? 0) * 10) / 10} onchange={(e) => setNumber(field.key, e.currentTarget.value)} />
          </label>
        {/each}
      </div>
    {:else if current.hint.kind !== 'path'}
      <span class="muted tiny">{t('shapeEdit.geometryLocked')}</span>
    {/if}
    <div class="row colours">
      {#if current.capabilities?.fill}
        <label class="colour"><span class="muted tiny">{t('shapeEdit.fill')}</span>
          <input type="color" value={current.capabilities.fill} onchange={(e) => selected !== null && onEdit(selected, { fill: e.currentTarget.value })} />
        </label>
      {/if}
      {#each current.capabilities?.stops ?? [] as stop, position (position)}
        <label class="colour"><span class="muted tiny">{t('shapeEdit.stop', position + 1)}</span>
          <input type="color" value={stop} onchange={(e) => setStop(position, e.currentTarget.value)} />
        </label>
      {/each}
    </div>
  {/if}
  {#if onReset || onAnimate}
    <div class="row actions">
      {#if onReset}<button type="button" class="btn" onclick={onReset}>{t('shapeEdit.reset')}</button>{/if}
      {#if onAnimate}<button type="button" class="btn" onclick={onAnimate}>{t('shapeEdit.animate')}</button>{/if}
    </div>
  {/if}
</div>

<style>
  .shapes { display: flex; flex-direction: column; gap: 2px; max-height: 260px; overflow-y: auto; border: 1px solid var(--line-2); border-radius: 10px; padding: 4px; }
  .shape { display: flex; align-items: center; gap: 10px; min-height: 34px; padding: 0 10px; border-radius: 8px; border: 1px solid transparent; background: transparent; color: inherit; font-size: 13px; text-align: left; cursor: pointer; }
  .shape .nm { flex: 1; }
  .shape.hover, .shape:hover { background: var(--surface-2); }
  .shape[aria-selected='true'] { border-color: var(--accent); background: var(--accent-bg); color: var(--accent-text, var(--accent)); }
  .lock { font-size: 11px; }
  .dot { width: 12px; height: 12px; border-radius: 50%; border: 1px solid var(--line-3); }
  .grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
  .num { display: flex; flex-direction: column; gap: 4px; }
  .num input { width: 100%; min-height: 34px; padding: 0 8px; border-radius: 8px; border: 1px solid var(--line-2); background: transparent; color: inherit; font-family: 'Geist Mono', monospace; font-size: 13px; }
  .colours { flex-wrap: wrap; gap: 12px; }
  .actions { flex-wrap: wrap; gap: 8px; }
  .colour { display: flex; flex-direction: column; gap: 4px; }
  .colour input { width: 44px; height: 32px; padding: 0; border: 1px solid var(--line-2); border-radius: 8px; background: transparent; cursor: pointer; }
</style>
