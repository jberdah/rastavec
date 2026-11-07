<script lang="ts">
  import { app, chosenTrial, clone, doneItems, go, outputMetrics, svgUrl } from '../store.svelte'
  import { DEFAULT_FILTERS, FILTER_PRESETS, MAX_COLOURS, isDefault, type FilterSettings, type PresetId, type ThemeId } from '../engine/palette'
  import { filtered } from '../edit'
  import { refreshOutputMetrics } from '../pipeline'
  import { downloadSvg } from '../export'
  import type { GroupingMetadata } from '../engine/types'
  import { num, pct, size, t } from '../i18n.svelte'
  import GroupReview from './GroupReview.svelte'

  type Bg = 'checker' | 'light' | 'dark'
  let bg = $state<Bg>('checker')

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
    item.edit = { settings: { ...clone(settings), ...patch }, trial: item.chosen }
    void refreshOutputMetrics(item)
  }
  function preset(id: PresetId) {
    if (!item) return
    item.edit = { settings: { ...DEFAULT_FILTERS, ...FILTER_PRESETS[id] }, trial: item.chosen }
    void refreshOutputMetrics(item)
  }
  const activePreset = $derived(
    (Object.keys(FILTER_PRESETS) as PresetId[]).find((id) => {
      const p = { ...DEFAULT_FILTERS, ...FILTER_PRESETS[id] }
      return (Object.keys(p) as (keyof FilterSettings)[]).every((k) => p[k] === settings[k])
    }) ?? null,
  )

  const result = $derived(item ? filtered(item, clone(settings)) : null)
  const trial = $derived(item ? chosenTrial(item) : null)
  function saveGrouping(grouping: GroupingMetadata) { if (item) item.grouping = grouping }

  // Preview URL of the filtered SVG.
  let outUrl = $state<string | null>(null)
  $effect(() => {
    if (!result) return
    const url = URL.createObjectURL(new Blob([result.svg], { type: 'image/svg+xml' }))
    outUrl = url
    return () => setTimeout(() => URL.revokeObjectURL(url), 2000)
  })

  const fidelity = $derived(item ? outputMetrics(item)?.pctDiff ?? null : null)
  const measuring = $derived(!!item && !outputMetrics(item))

  function applyToAll() {
    if (!item) return
    const s = clone(settings)
    for (const i of list) {
      i.edit = { settings: clone(s), trial: i.chosen }
      void refreshOutputMetrics(i)
    }
  }
  const appliedCount = $derived(list.filter((i) => i.edit && i.edit.trial === i.chosen && !isDefault(i.edit.settings)).length)

  const PRESET_IDS = Object.keys(FILTER_PRESETS) as PresetId[]
  const THEME_IDS: ThemeId[] = ['', 'brand', 'duo', 'mono', 'pastel', 'night']
  const bgStyle = $derived(bg === 'light' ? '#ffffff' : bg === 'dark' ? '#202020' : 'var(--checker)')
  const hueSwatch = (h: number) => `oklch(0.72 0.15 ${h})`
  const signed = (v: number) => (v > 0 ? `+${v}` : `${v}`)
</script>

{#if !item || !trial || !result}
  <div class="card stack" style="max-width: 560px; align-items: flex-start">
    <img src="/brand/mascot-laptop.webp" alt="" width="160" height="160" style="width: 160px; height: auto" />
    <h1>{t('edit.empty')}</h1>
    <button type="button" class="btn" onclick={() => go('import')}>{t('detail.import')}</button>
  </div>
{:else}
  <div class="stack" style="gap: 20px">
    <div class="between">
      <div class="row" style="flex-wrap: wrap; gap: 12px">
        <button type="button" class="btn" onclick={() => go('lot')}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
          {t('detail.back')}
        </button>
        <h1 class="mono name">{item.name}</h1>
        {#if !isDefault(settings)}<span class="chip chip-accent">{t('edit.edited')}</span>{/if}
      </div>
      <div class="row">
        <button type="button" class="btn icon-btn" aria-label={t('detail.prev')} onclick={() => step(-1)}>‹</button>
        <span class="mono muted small">{index + 1} / {list.length}</span>
        <button type="button" class="btn icon-btn" aria-label={t('detail.next')} onclick={() => step(1)}>›</button>
      </div>
    </div>

    <div class="wrap" style="gap: 20px; align-items: flex-start">
      <section class="stagecol">
        <div class="between">
          <span class="muted small">{t('edit.lead')}</span>
          <div class="seg" role="group" aria-label={t('detail.bgGroup')}>
            <button type="button" aria-label={t('detail.bgChecker')} aria-pressed={bg === 'checker'} onclick={() => (bg = 'checker')}><span class="swatch checker"></span></button>
            <button type="button" aria-label={t('detail.bgLight')} aria-pressed={bg === 'light'} onclick={() => (bg = 'light')}><span class="swatch" style="background: #fff"></span></button>
            <button type="button" aria-label={t('detail.bgDark')} aria-pressed={bg === 'dark'} onclick={() => (bg = 'dark')}><span class="swatch" style="background: #202020"></span></button>
          </div>
        </div>
        <div class="stage" style:background={bgStyle}>
          <div class="half"><img class="fit" src={svgUrl(item)} alt={t('edit.before')} /><span class="lab mono l">{t('edit.before')}</span></div>
          <div class="half">{#if outUrl}<img class="fit" src={outUrl} alt={t('edit.after')} />{/if}<span class="lab mono r">{t('edit.after')}</span></div>
        </div>
        <div class="card stack">
          <div class="between"><h2 class="h3">{t('edit.presets')}</h2><span class="muted tiny">{t('edit.presetsHint')}</span></div>
          <div class="presets">
            {#each PRESET_IDS as id (id)}
              <button type="button" class="preset" aria-pressed={activePreset === id} onclick={() => preset(id)}>{t(`edit.preset.${id}` as 'edit.preset.original')}</button>
            {/each}
          </div>
        </div>
      </section>

      <aside class="panel">
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

        <div class="card stack">
          <h2 class="h3">{t('edit.family')}</h2>
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

        <div class="card stack">
          <h2 class="h3">{t('edit.theme')}</h2>
          <div class="seg" role="group" aria-label={t('edit.theme')}>
            {#each THEME_IDS as id (id)}
              <button type="button" aria-pressed={settings.theme === id} onclick={() => update({ theme: id })}>{t(`edit.theme.${id || 'none'}` as 'edit.theme.none')}</button>
            {/each}
          </div>
        </div>

        <div class="card stack">
          <div class="between"><h2 class="h3">{t('edit.result')}</h2><span class="mono faint tiny">{t('edit.resultNote')}</span></div>
          <div class="statgrid">
            <div><span class="muted tiny">{t('edit.coloursStat')}</span><span class="sv">{num(result.colours)}</span></div>
            <div><span class="muted tiny">{t('edit.shapesStat')}</span><span class="sv">{num(result.kept)}<span class="muted tiny"> / {num(result.total)}</span></span></div>
            <div><span class="muted tiny">{t('stat.size')}</span><span class="sv">{size(new Blob([result.svg]).size)}</span></div>
          </div>
          <div class="between small">
            <span class="muted">{t('edit.diff')}</span>
            <span class="mono" class:faint={measuring}>{fidelity === null ? '…' : pct(fidelity)} <span class="faint">({t('edit.trace')} {pct(trial.metrics.pctDiff)})</span></span>
          </div>
          <div class="pal" aria-label={t('edit.palette')}>
            {#each result.palette.slice(0, 40) as h (h)}<span style:background={h} title={h}></span>{/each}
          </div>
        </div>

        <div class="row" style="flex-wrap: wrap; gap: 8px">
          <button type="button" class="btn" disabled={isDefault(settings)} onclick={() => preset('original')}>{t('edit.reset')}</button>
          <button type="button" class="btn" disabled={list.length < 2} onclick={applyToAll}>{t('edit.applyAll', list.length)}</button>
          <button type="button" class="btn btn-primary" onclick={() => downloadSvg(item)}>{t('detail.download')}</button>
        </div>
        {#if appliedCount > 1}<span class="muted tiny">{t('edit.appliedCount', appliedCount)}</span>{/if}
      </aside>
    </div>
    <GroupReview svg={result.svg} name={item.name} grouping={item.grouping} onGroupingChange={saveGrouping} />
  </div>
{/if}

<style>
  .name { font-size: 22px; font-weight: 500; }
  .small { font-size: 13px; }
  .tiny { font-size: 12px; }
  .h3 { font-size: 16px; }
  .stagecol { flex: 999 1 600px; min-width: 0; display: flex; flex-direction: column; gap: 12px; }
  .panel { flex: 1 1 340px; min-width: 0; display: flex; flex-direction: column; gap: 14px; }
  .stage { position: relative; height: clamp(300px, calc(100vh - 420px), 900px); border-radius: 22px; overflow: hidden; border: 1px solid var(--line-2); display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .half { position: relative; border-right: 1px solid var(--line-2); }
  .half:last-child { border-right: 0; }
  .fit { position: absolute; inset: 5%; width: 90%; height: 90%; object-fit: contain; }
  .lab { position: absolute; top: 14px; font-size: 12px; border-radius: 6px; padding: 4px 8px; }
  .lab.l { left: 14px; background: rgba(10, 11, 15, 0.85); }
  .lab.r { right: 14px; color: #0a0b0f; background: var(--accent); }
  .swatch { display: block; width: 20px; height: 20px; border-radius: 6px; border: 1px solid var(--line-3); background-size: 8px 8px; }
  .presets { display: grid; grid-template-columns: repeat(auto-fill, minmax(118px, 1fr)); gap: 8px; }
  .preset { min-height: 40px; padding: 0 12px; border-radius: 10px; border: 1px solid var(--line-2); background: var(--surface-2); font-size: 14px; }
  .preset:hover { border-color: var(--accent-line); }
  .preset[aria-pressed='true'] { background: var(--accent); border-color: var(--accent); color: #0a0b0f; font-weight: 600; }
  .hue { display: inline-block; width: 14px; height: 14px; border-radius: 50%; border: 1px solid var(--line-3); }
  .statgrid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
  .statgrid div { display: flex; flex-direction: column; gap: 4px; }
  .sv { font-size: 20px; font-weight: 600; }
  .pal { display: flex; flex-wrap: wrap; gap: 4px; }
  .pal span { width: 18px; height: 18px; border-radius: 5px; border: 1px solid rgba(255, 255, 255, 0.12); }
</style>
