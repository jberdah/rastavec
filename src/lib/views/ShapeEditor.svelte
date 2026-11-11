<script lang="ts">
  // Lists the shapes the engine recognised in the chosen trace and edits the selected one by
  // its parameters: centre and radius of a circle, axes and rotation of an ellipse, flat fill
  // or gradient stop colours.
  import { shapeCapabilities, type ShapePatch } from '../engine/shape-edits'
  import type { EngineShapeHint } from '../engine/types'
  import { t } from '../i18n.svelte'

  let { svg, shapes, selected = $bindable(null), onEdit }: {
    svg: string
    shapes: EngineShapeHint[]
    selected?: number | null
    onEdit: (index: number, patch: ShapePatch) => void
  } = $props()

  const entries = $derived(shapes.map((hint) => ({ hint, capabilities: shapeCapabilities(svg, shapes, hint.index) })).filter((entry) => entry.capabilities))
  const current = $derived(entries.find((entry) => entry.hint.index === selected) ?? null)
  const label = (hint: EngineShapeHint) =>
    hint.overlayOf !== undefined ? t('shapeEdit.overlay') : hint.kind === 'circle' ? t('shapeEdit.circle') : hint.kind === 'ellipse' ? t('shapeEdit.ellipse') : t('shapeEdit.gradientRegion')
  const swatch = (entry: (typeof entries)[number]) => {
    const { fill, stops } = entry.capabilities!
    return fill ?? (stops && stops.length > 1 ? `linear-gradient(90deg, ${stops.join(', ')})` : stops?.[0] ?? 'transparent')
  }
  const fields = $derived.by(() => {
    const hint = current?.hint
    if (!hint || !current?.capabilities?.geometry) return []
    const centre = [{ key: 'cx', value: hint.cx }, { key: 'cy', value: hint.cy }] as const
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
  <div class="shapes" role="listbox" aria-label={t('shapeEdit.title')}>
    {#each entries as entry (entry.hint.index)}
      <button type="button" class="shape" role="option" aria-selected={selected === entry.hint.index} onclick={() => (selected = selected === entry.hint.index ? null : entry.hint.index)}>
        <span class="dot" style:background={swatch(entry)}></span>{label(entry.hint)}
      </button>
    {/each}
  </div>
  {#if current}
    {#if fields.length}
      <div class="grid">
        {#each fields as field (field.key)}
          <label class="num"><span class="muted tiny">{t(`shapeEdit.${field.key}`)}</span>
            <input type="number" step={field.key === 'rotation' ? 1 : 0.5} min={field.key === 'r' || field.key === 'rx' || field.key === 'ry' ? 0.5 : undefined} value={Math.round((field.value ?? 0) * 100) / 100} onchange={(e) => setNumber(field.key, e.currentTarget.value)} />
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
  {:else}
    <span class="muted tiny">{t('shapeEdit.pick')}</span>
  {/if}
</div>

<style>
  .shapes { display: flex; flex-wrap: wrap; gap: 6px; max-height: 132px; overflow-y: auto; }
  .shape { display: inline-flex; align-items: center; gap: 6px; min-height: 30px; padding: 0 10px; border-radius: 999px; border: 1px solid var(--line-2); background: var(--surface-2, transparent); color: inherit; font-size: 12px; cursor: pointer; }
  .shape[aria-selected='true'] { border-color: var(--accent); color: var(--accent); }
  .dot { width: 12px; height: 12px; border-radius: 50%; border: 1px solid var(--line-3); }
  .grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
  .num { display: flex; flex-direction: column; gap: 4px; }
  .num input { width: 100%; min-height: 34px; padding: 0 8px; border-radius: 8px; border: 1px solid var(--line-2); background: transparent; color: inherit; font-family: 'Geist Mono', monospace; font-size: 13px; }
  .colours { flex-wrap: wrap; gap: 12px; }
  .colour { display: flex; flex-direction: column; gap: 4px; }
  .colour input { width: 44px; height: 32px; padding: 0; border: 1px solid var(--line-2); border-radius: 8px; background: transparent; cursor: pointer; }
</style>
