<script lang="ts">
  import { app, go } from '../store.svelte'
  import { PRESETS, presetById } from '../engine/presets'
  import { addFiles, addGridSheet, addSheet, clearItems, filesFromDrop, processAll } from '../pipeline'
  import type { ImageKind } from '../engine/analyze'
  import { kbUnit, kindLabel, num, pct, presetDesc, presetName, size, t } from '../i18n.svelte'

  let dragging = $state(false)
  let fileInput: HTMLInputElement
  let folderInput: HTMLInputElement
  let sheetInput: HTMLInputElement
  let gridSheetInput: HTMLInputElement
  let sheetInfo = $state<string | null>(null)
  let slicing = $state(false)
  let gridFile = $state<File | null>(null)
  let gridPreviewUrl = $state('')
  let gridSize = $state<{ width: number; height: number } | null>(null)
  let gridCellWidth = $state(80)
  let gridCellHeight = $state(110)
  let gridMarginX = $state(0)
  let gridMarginY = $state(0)
  let gridSpacingX = $state(0)
  let gridSpacingY = $state(0)

  const gridColumns = $derived.by(() => {
    if (!gridSize || gridCellWidth < 1 || gridMarginX < 0 || gridSpacingX < 0 || gridMarginX + gridCellWidth > gridSize.width) return 0
    return Math.max(0, Math.floor((gridSize.width - gridMarginX + gridSpacingX) / (gridCellWidth + gridSpacingX)))
  })
  const gridRows = $derived.by(() => {
    if (!gridSize || gridCellHeight < 1 || gridMarginY < 0 || gridSpacingY < 0 || gridMarginY + gridCellHeight > gridSize.height) return 0
    return Math.max(0, Math.floor((gridSize.height - gridMarginY + gridSpacingY) / (gridCellHeight + gridSpacingY)))
  })
  const gridCellCount = $derived(gridColumns * gridRows)
  const gridCells = $derived(Array.from({ length: Math.min(1000, gridCellCount) }, (_, index) => index))

  async function onSheet(e: Event) {
    const input = e.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    slicing = true
    sheetInfo = null
    try {
      const r = await addSheet(file)
      sheetInfo = t('sheet.result', r.name, r.count, r.background !== 'transparent' ? r.background : null, r.dropped)
    } catch (err) {
      sheetInfo = t('sheet.error', err instanceof Error ? err.message : String(err))
    } finally {
      slicing = false
    }
  }

  async function onGridSheet(e: Event) {
    const input = e.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    if (gridPreviewUrl) URL.revokeObjectURL(gridPreviewUrl)
    gridFile = file
    gridPreviewUrl = URL.createObjectURL(file)
    gridSize = null
    sheetInfo = null
    try {
      const bitmap = await createImageBitmap(file)
      gridSize = { width: bitmap.width, height: bitmap.height }
      bitmap.close()
    } catch (err) {
      sheetInfo = t('sheet.error', err instanceof Error ? err.message : String(err))
      closeGridSheet()
    }
  }

  function closeGridSheet() {
    if (gridPreviewUrl) URL.revokeObjectURL(gridPreviewUrl)
    gridFile = null
    gridPreviewUrl = ''
    gridSize = null
  }

  async function importGridSheet() {
    if (!gridFile || !gridSize || !gridCellCount || gridCellCount > 1000) return
    slicing = true
    try {
      const result = await addGridSheet(gridFile, {
        cellWidth: gridCellWidth, cellHeight: gridCellHeight, marginX: gridMarginX, marginY: gridMarginY,
        spacingX: gridSpacingX, spacingY: gridSpacingY,
      })
      sheetInfo = t('sheet.grid.result', result.name, result.count, result.columns, result.rows, result.empty)
      closeGridSheet()
    } catch (err) {
      sheetInfo = t('sheet.error', err instanceof Error ? err.message : String(err))
    } finally {
      slicing = false
    }
  }

  function pickPreset(id: string) {
    app.presetId = id
    if (id !== 'custom') app.params = { ...presetById(id).params }
  }
  const markCustom = () => (app.presetId = 'custom')

  async function onDrop(e: DragEvent) {
    e.preventDefault()
    dragging = false
    if (!app.running && !slicing && e.dataTransfer) addFiles(await filesFromDrop(e.dataTransfer))
  }
  function onPick(e: Event) {
    const input = e.currentTarget as HTMLInputElement
    if (input.files) addFiles(input.files)
    input.value = ''
  }
  function start() {
    go('lot')
    processAll()
  }
  const total = $derived(app.items.reduce((s, i) => s + i.srcBytes, 0))
  const analysed = $derived(app.items.filter((i) => i.analysis))
  const analysisErrors = $derived(app.items.filter((i) => i.error && !i.analysis))
  const analysisFinished = $derived(analysed.length + analysisErrors.length)
  const kinds = $derived.by(() => {
    const m = new Map<ImageKind, number>()
    for (const i of analysed) m.set(i.analysis!.kind, (m.get(i.analysis!.kind) ?? 0) + 1)
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  })
  const softCount = $derived(analysed.filter((i) => i.analysis!.alpha === 'soft').length)
  const photoCount = $derived(analysed.filter((i) => i.analysis!.kind === 'photo').length)
</script>

<div class="layout">
  <section class="main">
    <div class="hero-row">
    <div class="hero">
      <span class="mono eyebrow">{t('import.eyebrow')}</span>
      <h1>{t('import.title1')}<br />{t('import.title2')}</h1>
      <p class="muted lead">{t('import.lead')}</p>
    </div>
    <img class="hero-mascot" src="/brand/mascot-welcome.webp" alt="" width="220" height="220" />
    </div>

    <div
      class="drop"
      class:dragging
      role="region"
      aria-label={t('drop.region')}
      ondragover={(e) => { e.preventDefault(); dragging = true }}
      ondragleave={() => (dragging = false)}
      ondrop={onDrop}
    >
      <div class="drop-inner">
        <div class="stack" style="flex: 1 1 320px">
          <h2>{t('drop.title')}</h2>
          <p class="muted">{t('drop.text')}</p>
          <div class="row" style="flex-wrap: wrap">
            <button type="button" class="btn btn-primary" onclick={() => fileInput.click()} disabled={app.running || slicing}>{t('drop.files')}</button>
            <button type="button" class="btn" onclick={() => folderInput.click()} disabled={app.running || slicing}>{t('drop.folder')}</button>
            <button type="button" class="btn" onclick={() => sheetInput.click()} disabled={slicing || app.running} title={t('drop.sheetHint')}>
              {#if slicing}<span class="spinner"></span>{/if}
              {t('drop.sheet')}
            </button>
            <button type="button" class="btn" onclick={() => gridSheetInput.click()} disabled={slicing || app.running} title={t('drop.gridHint')}>
              {t('drop.grid')}
            </button>
            {#if app.items.length}
              <button type="button" class="btn" onclick={clearItems} disabled={app.running || slicing}>{t('drop.clear')}</button>
            {/if}
          </div>
          <input bind:this={fileInput} class="sr-only" type="file" multiple accept="image/png,image/jpeg,image/webp,image/gif,image/bmp" onchange={onPick} tabindex="-1" />
          <input bind:this={folderInput} class="sr-only" type="file" multiple {...{ webkitdirectory: true }} onchange={onPick} tabindex="-1" />
          <input bind:this={sheetInput} class="sr-only" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/bmp" onchange={onSheet} tabindex="-1" />
          <input bind:this={gridSheetInput} class="sr-only" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/bmp" onchange={onGridSheet} tabindex="-1" />
          {#if sheetInfo}<span class="small" style="color: var(--accent-text)" role="status">{sheetInfo}</span>{/if}
        </div>
        {#if app.items.length}
          <div class="picked">
            <div class="thumbs">
              {#each app.items.slice(0, 12) as it (it.id)}
                <img src={it.srcUrl} alt={it.name} class="checker" />
              {/each}
            </div>
            <span class="mono muted small">{t('drop.count', app.items.length, size(total))}</span>
            {#if analysisFinished < app.items.length}
              <span class="row muted small"><span class="spinner"></span>{t('drop.analysing', analysisFinished, app.items.length)}</span>
            {:else}
              <div class="row" style="flex-wrap: wrap; gap: 6px">
                {#each kinds as [k, n] (k)}<span class="chip chip-ok">{n} × {kindLabel(k)}</span>{/each}
                {#if softCount}<span class="chip chip-warn">{t('drop.soft', softCount)}</span>{/if}
                {#if photoCount}<span class="chip chip-warn">{t('drop.photos', photoCount)}</span>{/if}
              </div>
            {/if}
            {#if analysisErrors.length}
              <div role="alert" class="small">
                <span class="chip chip-warn">{t('drop.analysisErrors', analysisErrors.length)}</span>
                <ul>{#each analysisErrors as it (it.id)}<li>{it.name}: {it.error}</li>{/each}</ul>
              </div>
            {/if}
          </div>
        {/if}
      </div>
    </div>

    {#if gridFile && gridSize}
      <section class="grid-sheet-panel" aria-labelledby="grid-sheet-title">
        <div class="between">
          <div class="stack" style="gap: 6px">
            <h2 id="grid-sheet-title">{t('sheet.grid.title')}</h2>
            <p class="muted small">{t('sheet.grid.instructions')}</p>
          </div>
          <button type="button" class="btn" onclick={closeGridSheet} disabled={slicing}>{t('sheet.grid.cancel')}</button>
        </div>
        <div class="grid-sheet-layout">
          <div class="grid-preview" style={`aspect-ratio: ${gridSize.width} / ${gridSize.height}`}>
            <img src={gridPreviewUrl} alt={gridFile.name} />
            <svg viewBox={`0 0 ${gridSize.width} ${gridSize.height}`} preserveAspectRatio="none" aria-hidden="true">
              {#each gridCells as index (index)}
                {@const column = index % Math.max(1, gridColumns)}
                {@const row = Math.floor(index / Math.max(1, gridColumns))}
                <rect x={gridMarginX + column * (gridCellWidth + gridSpacingX)} y={gridMarginY + row * (gridCellHeight + gridSpacingY)} width={gridCellWidth} height={gridCellHeight} />
              {/each}
            </svg>
          </div>
          <div class="grid-controls">
            <label><span>{t('sheet.grid.cellWidth')}</span><input type="number" min="1" max={gridSize.width} step="1" bind:value={gridCellWidth} /></label>
            <label><span>{t('sheet.grid.cellHeight')}</span><input type="number" min="1" max={gridSize.height} step="1" bind:value={gridCellHeight} /></label>
            <label><span>{t('sheet.grid.marginX')}</span><input type="number" min="0" max={gridSize.width} step="1" bind:value={gridMarginX} /></label>
            <label><span>{t('sheet.grid.marginY')}</span><input type="number" min="0" max={gridSize.height} step="1" bind:value={gridMarginY} /></label>
            <label><span>{t('sheet.grid.spacingX')}</span><input type="number" min="0" max={gridSize.width} step="1" bind:value={gridSpacingX} /></label>
            <label><span>{t('sheet.grid.spacingY')}</span><input type="number" min="0" max={gridSize.height} step="1" bind:value={gridSpacingY} /></label>
          </div>
        </div>
        <div class="between grid-sheet-footer">
          <span class="mono muted small">{t('sheet.grid.preview', gridColumns, gridRows, gridCellCount)}</span>
          <button type="button" class="btn btn-primary" onclick={importGridSheet} disabled={slicing || !gridCellCount || gridCellCount > 1000}>
            {slicing ? t('cta.running') : t('sheet.grid.apply')}
          </button>
        </div>
      </section>
    {/if}

    <div class="stack">
      <div class="between">
        <h2>{t('presets.title')}</h2>
        <span class="muted small">{t('presets.hint')}</span>
      </div>
      <div class="presets">
        {#each PRESETS as p (p.id)}
          <button type="button" class="preset" aria-pressed={app.presetId === p.id} onclick={() => pickPreset(p.id)}>
            <span class="between" style="width: 100%">
              <span class="row" style="gap: 4px">
                {#each p.swatches as c}<span class="dot" style:background={c}></span>{/each}
              </span>
              {#if p.recommended}<span class="chip chip-accent">{t('presets.validated')}</span>{/if}
            </span>
            <span class="pname">{presetName(p.id)}</span>
            <span class="muted small">{presetDesc(p.id)}</span>
          </button>
        {/each}
      </div>
    </div>
  </section>

  <aside class="side">
    <div class="card stack">
      <div class="between" style="flex-wrap: nowrap">
        <div class="stack" style="gap: 4px">
          <h2 class="h3">{t('auto.title')}</h2>
          <span class="muted small">{t('auto.desc')}</span>
        </div>
        <button type="button" class="toggle" aria-label={t('auto.toggle')} aria-pressed={app.auto.enabled} onclick={() => (app.auto.enabled = !app.auto.enabled)}><span></span></button>
      </div>
      <div class="field">
        <label for="thr"><span>{t('auto.threshold')}</span><span class="value accent">{pct(app.auto.threshold, 1)}</span></label>
        <input id="thr" type="range" min="0.5" max="10" step="0.5" bind:value={app.auto.threshold} />
      </div>
      <div class="field">
        <label for="kb"><span>{t('auto.maxSize')}</span><span class="value accent">{num(app.auto.maxKB)} {kbUnit()}</span></label>
        <input id="kb" type="range" min="50" max="3000" step="50" bind:value={app.auto.maxKB} />
      </div>
      <span class="mono faint small">{t('auto.score', kbUnit())}</span>
    </div>

    <div class="card stack">
      <div class="between">
        <h2 class="h3">{t('params.title')}</h2>
        <span class="mono muted small">vtracer</span>
      </div>
      {#if app.presetId === 'auto'}
        <span class="small" style="color: var(--accent-text)">{t('params.autoNote')}</span>
      {/if}
      <div class="seg" role="group" aria-label={t('params.colorGroup')}>
        <button type="button" aria-pressed={app.params.colormode === 'color'} onclick={() => { app.params.colormode = 'color'; markCustom() }}>{t('params.color')}</button>
        <button type="button" aria-pressed={app.params.colormode === 'binary'} onclick={() => { app.params.colormode = 'binary'; markCustom() }}>{t('params.binary')}</button>
      </div>
      <div class="seg" role="group" aria-label={t('params.curveGroup')}>
        <button type="button" aria-pressed={app.params.mode === 'spline'} onclick={() => { app.params.mode = 'spline'; markCustom() }}>{t('params.spline')}</button>
        <button type="button" aria-pressed={app.params.mode === 'polygon'} onclick={() => { app.params.mode = 'polygon'; markCustom() }}>{t('params.polygon')}</button>
      </div>
      <div class="field">
        <label for="ld"><span>{t('params.layerDifference')}</span><span class="value">{app.params.layerDifference}</span></label>
        <input id="ld" type="range" min="1" max="64" bind:value={app.params.layerDifference} oninput={markCustom} disabled={app.params.colormode === 'binary'} />
      </div>
      <div class="field">
        <label for="cp"><span>{t('params.colorPrecision')}</span><span class="value">{app.params.colorPrecision} / 8</span></label>
        <input id="cp" type="range" min="1" max="8" bind:value={app.params.colorPrecision} oninput={markCustom} disabled={app.params.colormode === 'binary'} />
      </div>
      <div class="field">
        <label for="sp"><span>{t('params.speckle')}</span><span class="value">{app.params.speckle} px</span></label>
        <input id="sp" type="range" min="0" max="32" bind:value={app.params.speckle} oninput={markCustom} />
      </div>
      <div class="field">
        <label for="af"><span>{t('params.alphaFloor')}</span><span class="value">α &lt; {app.params.alphaFloor}</span></label>
        <input id="af" type="range" min="0" max="64" bind:value={app.params.alphaFloor} oninput={markCustom} />
      </div>
      <div class="field">
        <label for="cut"><span>{t('params.silhouetteCut')}</span><span class="value">α ≥ {app.params.silhouetteCut}</span></label>
        <input id="cut" type="range" min="16" max="240" step="8" bind:value={app.params.silhouetteCut} oninput={markCustom} disabled={app.params.colormode === 'binary'} />
      </div>
      <div class="field">
        <label for="soft"><span>{t('params.softLayers')}</span><span class="value">{app.params.softLayers || t('params.none')}</span></label>
        <input id="soft" type="range" min="0" max="4" bind:value={app.params.softLayers} oninput={markCustom} disabled={app.params.colormode === 'binary' || app.params.softColor} />
      </div>
      <label class="row small muted" style="justify-content: space-between; min-height: 40px">
        {t('params.softColor')}
        <input type="checkbox" bind:checked={app.params.softColor} onchange={markCustom} disabled={app.params.colormode === 'binary'} />
      </label>
    </div>

    <button type="button" class="btn btn-light cta" disabled={!app.items.length || app.running || slicing} onclick={start}>
      {app.running ? t('cta.running') : app.items.length ? t('cta.run', app.items.length) : t('cta.empty')}
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></svg>
    </button>
  </aside>
</div>

<style>
  .layout { display: flex; flex-wrap: wrap; gap: 32px; align-items: flex-start; }
  .main { flex: 999 1 620px; min-width: 0; display: flex; flex-direction: column; gap: 32px; }
  .side { flex: 1 1 340px; min-width: 0; display: flex; flex-direction: column; gap: 16px; }
  .hero-row { display: flex; align-items: center; gap: 24px; }
  .hero { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 14px; }
  .hero-mascot { flex: none; width: 200px; height: auto; filter: drop-shadow(0 18px 40px rgba(0, 0, 0, 0.45)); }
  @media (max-width: 760px) { .hero-mascot { display: none; } }
  .eyebrow { font-size: 13px; color: var(--accent-text); letter-spacing: 0.08em; }
  h1 { font-size: clamp(34px, 5vw, 60px); line-height: 1.03; letter-spacing: -0.035em; }
  .lead { max-width: 620px; font-size: 18px; line-height: 1.5; }
  .small { font-size: 13px; }
  .h3 { font-size: 17px; }
  .drop { border-radius: 24px; padding: 2px; background: linear-gradient(135deg, var(--accent) 0%, var(--line-2) 40%, var(--line-2) 70%, var(--brand-gold) 100%); transition: transform 0.15s; }
  .drop.dragging { transform: scale(1.01); background: var(--accent); }
  .drop-inner { border-radius: 22px; background: var(--sunken); padding: 32px; display: flex; flex-wrap: wrap; gap: 28px; align-items: center; }
  .picked { flex: 1 1 260px; display: flex; flex-direction: column; gap: 10px; }
  .thumbs { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 6px; }
  .thumbs img { width: 100%; aspect-ratio: 1; object-fit: contain; border-radius: 8px; border: 1px solid var(--line-2); }
  .grid-sheet-panel { display: flex; flex-direction: column; gap: 18px; border: 1px solid var(--accent); border-radius: 18px; background: var(--surface); padding: 20px; }
  .grid-sheet-layout { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(260px, 1fr); gap: 20px; align-items: start; }
  .grid-preview { position: relative; width: 100%; overflow: hidden; border-radius: 10px; background: var(--sunken); }
  .grid-preview img, .grid-preview svg { position: absolute; inset: 0; display: block; width: 100%; height: 100%; }
  .grid-preview img { object-fit: fill; }
  .grid-preview svg { pointer-events: none; }
  .grid-preview rect { fill: rgba(60, 194, 115, 0.13); stroke: #3cc273; stroke-width: 2; vector-effect: non-scaling-stroke; }
  .grid-controls { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
  .grid-controls label { display: flex; flex-direction: column; gap: 6px; color: var(--muted); font-size: 12px; }
  .grid-controls input { width: 100%; min-height: 40px; padding: 0 9px; color: var(--text); background: var(--surface-2); border: 1px solid var(--line-2); border-radius: 8px; }
  .grid-sheet-footer { gap: 12px; flex-wrap: wrap; }
  @media (max-width: 760px) { .grid-sheet-layout { grid-template-columns: 1fr; } }
  .presets { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 12px; }
  .preset { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; text-align: left; padding: 18px; min-height: 150px; border-radius: 16px; background: var(--surface); border: 1.5px solid var(--line); }
  .preset[aria-pressed='true'] { background: var(--accent-bg); border-color: var(--accent); box-shadow: 0 0 0 4px var(--accent-glow); }
  .pname { font-size: 16px; font-weight: 600; }
  .dot { width: 14px; height: 14px; border-radius: 50%; border: 1px solid rgba(255, 255, 255, 0.15); }
  .toggle { position: relative; flex: none; width: 52px; height: 30px; border-radius: 999px; border: 0; background: var(--line-3); }
  .toggle span { position: absolute; top: 3px; left: 3px; width: 24px; height: 24px; border-radius: 50%; background: var(--bg); transition: left 0.15s; }
  .toggle[aria-pressed='true'] { background: var(--accent); }
  .toggle[aria-pressed='true'] span { left: 25px; }
  .cta { min-height: 56px; border-radius: 16px; font-size: 16px; }
</style>
