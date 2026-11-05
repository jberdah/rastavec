<script lang="ts">
  import { app, chosenTrial, doneItems, go, needsReview, svgUrl } from '../store.svelte'
  import { exportZip } from '../export'
  import type { Item } from '../engine/types'
  import { KIND_LABEL } from '../engine/analyze'

  type Filter = 'all' | 'review' | 'auto' | 'ok'
  let filter = $state<Filter>('all')
  let now = $state(performance.now())

  $effect(() => {
    if (!app.running) return
    const t = setInterval(() => (now = performance.now()), 250)
    return () => clearInterval(t)
  })

  const done = $derived(doneItems())
  const elapsed = $derived(((app.finishedAt || now) - app.startedAt) / 1000)
  const processed = $derived(app.items.filter((i) => i.status === 'done' || i.status === 'error').length)
  const fmt = (x: number, d = 2) => x.toFixed(d).replace('.', ',')
  const kb = (b: number) => (b > 1048576 ? fmt(b / 1048576, 1) + ' Mo' : Math.round(b / 1024) + ' Ko')
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)

  const stats = $derived({
    pct: mean(done.map((i) => chosenTrial(i).metrics.pctDiff)),
    iou: mean(done.map((i) => chosenTrial(i).metrics.iou ?? 0)),
    bytes: done.reduce((s, i) => s + chosenTrial(i).metrics.bytes, 0),
    src: done.reduce((s, i) => s + i.srcBytes, 0),
    raster: done.filter((i) => chosenTrial(i).metrics.embeddedRaster).length,
    auto: done.filter((i) => i.autoTuned).length,
    review: app.items.filter(needsReview).length,
    ok: done.filter((i) => !needsReview(i)).length,
  })

  const sorted = $derived(
    [...app.items].sort((a, b) => {
      const pa = a.status === 'done' ? chosenTrial(a).metrics.pctDiff : a.status === 'error' ? 999 : -1
      const pb = b.status === 'done' ? chosenTrial(b).metrics.pctDiff : b.status === 'error' ? 999 : -1
      return pb - pa
    }),
  )
  const shown = $derived(
    sorted.filter((i) =>
      filter === 'all' ? true : filter === 'review' ? needsReview(i) : filter === 'auto' ? i.autoTuned : i.status === 'done' && !needsReview(i),
    ),
  )

  // Readable scale: outliers are capped (the bar turns orange and reaches the top).
  const scaleMax = $derived(Math.max(5, app.auto.threshold * 2.5))
  const barH = (p: number) => `${Math.min(100, (100 * p) / scaleMax)}%`

  function statusChip(i: Item): { text: string; cls: string } {
    if (i.status === 'error') return { text: 'Erreur', cls: 'chip-warn' }
    if (i.status !== 'done') return { text: i.status === 'tracing' ? i.progress || 'en cours' : 'en attente', cls: 'chip-muted' }
    if (needsReview(i)) return { text: 'À revoir', cls: 'chip-warn' }
    if (i.autoTuned) return { text: 'Réglée auto', cls: 'chip-accent' }
    return { text: 'OK', cls: 'chip-ok' }
  }
</script>

<div class="stack" style="gap: 28px">
  <div class="between" style="align-items: flex-end">
    <div class="stack" style="gap: 8px">
      <span class="mono muted small">préréglage {app.presetId} · seuil {fmt(app.auto.threshold, 1)} % · max {app.auto.maxKB} Ko</span>
      <h1 class="title">
        {#if app.running}
          Vectorisation {processed}/{app.items.length} <span class="faint">· {fmt(elapsed, 0)} s</span>
        {:else}
          {done.length} image{done.length > 1 ? 's' : ''} vectorisée{done.length > 1 ? 's' : ''} <span class="faint">en {fmt(elapsed, 0)} s</span>
        {/if}
      </h1>
    </div>
    {#if !app.running && done.length}
      <div class="banner" class:warn={stats.review > 0}>
        {#if stats.review}
          {stats.review} image{stats.review > 1 ? 's' : ''} à revoir · {stats.auto} réglée{stats.auto > 1 ? 's' : ''} automatiquement
        {:else}
          Toutes sous le seuil · {stats.auto} réglée{stats.auto > 1 ? 's' : ''} automatiquement
        {/if}
      </div>
    {/if}
  </div>

  {#if app.running}
    <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax={app.items.length} aria-valuenow={processed}>
      <span style:width={`${(100 * processed) / Math.max(1, app.items.length)}%`}></span>
    </div>
  {/if}

  <div class="wrap">
    <div class="card chart">
      <div class="between">
        <h2 class="h3">Écart visible par image</h2>
        <span class="row legend muted"><span class="sw final"></span>final <span class="sw before"></span>avant réglage auto</span>
      </div>
      <div class="bars">
        <div class="thr" style:bottom={barH(app.auto.threshold)}><span class="mono">seuil {fmt(app.auto.threshold, 1)} %</span></div>
        {#each app.items as i (i.id)}
          <div class="barcol" title={i.status === 'done' ? `${i.name} · ${fmt(chosenTrial(i).metrics.pctDiff)} %` : i.name}>
            {#if i.status === 'done'}
              {#if i.autoTuned}<div class="bar before" style:height={barH(i.trials[0].metrics.pctDiff)}></div>{/if}
              <div class="bar" class:tuned={i.autoTuned} class:bad={needsReview(i)} style:height={barH(chosenTrial(i).metrics.pctDiff)}></div>
            {/if}
          </div>
        {/each}
      </div>
    </div>
    <div class="kpis">
      <div class="kpi"><span class="k">Écart moyen</span><span class="v">{fmt(stats.pct)} %</span><span class="s">pixels &gt; 32/255</span></div>
      <div class="kpi"><span class="k">Silhouette</span><span class="v">{fmt(stats.iou, 3)}</span><span class="s">IoU moyen</span></div>
      <div class="kpi"><span class="k">Poids total</span><span class="v">{kb(stats.bytes)}</span><span class="s">sources : {kb(stats.src)}</span></div>
      <div class="kpi"><span class="k">Bitmap intégré</span><span class="v" class:accent={!stats.raster}>{stats.raster}</span><span class="s">100 % chemins</span></div>
    </div>
  </div>

  <div class="between">
    <div class="seg" role="group" aria-label="Filtrer">
      <button type="button" aria-pressed={filter === 'all'} onclick={() => (filter = 'all')}>Toutes <span class="mono faint">{app.items.length}</span></button>
      <button type="button" aria-pressed={filter === 'review'} onclick={() => (filter = 'review')}>À revoir <span class="mono faint">{stats.review}</span></button>
      <button type="button" aria-pressed={filter === 'auto'} onclick={() => (filter = 'auto')}>Réglées auto <span class="mono faint">{stats.auto}</span></button>
      <button type="button" aria-pressed={filter === 'ok'} onclick={() => (filter = 'ok')}>OK <span class="mono faint">{stats.ok}</span></button>
    </div>
    <span class="muted small">Triées des pires aux meilleures</span>
  </div>

  <div class="grid">
    {#each shown as i (i.id)}
      {@const chip = statusChip(i)}
      <button type="button" class="tile" class:tuned={i.autoTuned} disabled={i.status !== 'done'} onclick={() => go('detail', i.id)}>
        <div class="thumb checker">
          <img src={i.srcUrl} alt="" class="layer raster" />
          {#if i.status === 'done'}
            <img src={svgUrl(i)} alt="" class="layer vec" />
            <span class="divider"></span>
          {:else if i.status === 'tracing'}
            <span class="busy"><span class="spinner"></span></span>
          {/if}
          <span class="lab mono l">PNG</span>
          {#if i.status === 'done'}<span class="lab mono r">SVG</span>{/if}
        </div>
        <div class="between" style="flex-wrap: nowrap">
          <span class="mono nm">{i.name}</span>
          <span class="chip {chip.cls}">{chip.text}</span>
        </div>
        {#if i.analysis}
          <span class="mono faint small">{KIND_LABEL[i.analysis.kind]} · {i.analysis.dominantColors} coul.{i.analysis.alpha === 'soft' ? ' · transp. douce' : ''}</span>
        {/if}
        {#if i.status === 'done'}
          {@const m = chosenTrial(i).metrics}
          <div class="stack" style="gap: 6px">
            <div class="between small muted"><span>Écart visible</span><span class="mono" style="color: var(--text)">{i.autoTuned ? fmt(i.trials[0].metrics.pctDiff) + ' → ' : ''}{fmt(m.pctDiff)} %</span></div>
            <div class="meter"><span style:width={barH(m.pctDiff)} class:tuned={i.autoTuned} class:bad={needsReview(i)}></span></div>
          </div>
          <div class="between mono small muted"><span>IoU {fmt(m.iou ?? 0, 3)}</span><span>{kb(m.bytes)}</span></div>
        {:else if i.status === 'error'}
          <span class="small" style="color: var(--warn-text)">{i.error}</span>
        {/if}
      </button>
    {/each}
  </div>
</div>

{#if done.length && !app.running}
  <div class="exportbar">
    <div class="inner">
      <span class="muted small">{done.length} SVG · <span class="mono">metrics.csv</span> · <span class="mono">config.json</span> pour rejouer à l'identique</span>
      <button type="button" class="btn btn-primary" onclick={() => exportZip(app.items)}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v12" /><path d="m6 10 6 6 6-6" /><path d="M4 20h16" /></svg>
        Télécharger le .zip
      </button>
    </div>
  </div>
{/if}

<style>
  .title { font-size: clamp(28px, 4vw, 42px); letter-spacing: -0.03em; }
  .small { font-size: 13px; }
  .h3 { font-size: 16px; }
  .banner { font-size: 14px; background: var(--accent-bg); border: 1px solid var(--accent-line); border-radius: 12px; padding: 10px 14px; }
  .banner.warn { background: #1e140f; border-color: #5a2e1c; color: var(--warn-text); }
  .progress { height: 6px; border-radius: 999px; background: var(--line); overflow: hidden; }
  .progress span { display: block; height: 100%; background: var(--accent); transition: width 0.3s; }
  .chart { flex: 2 1 520px; min-width: 0; display: flex; flex-direction: column; gap: 14px; }
  .legend { gap: 6px; font-size: 12px; }
  .sw { width: 10px; height: 10px; border-radius: 3px; display: inline-block; margin-left: 8px; }
  .sw.final { background: var(--accent); }
  .sw.before { border: 1.5px dashed var(--warn); }
  .bars { position: relative; height: 170px; display: flex; align-items: flex-end; gap: 4px; border-bottom: 1px solid var(--line-2); }
  .thr { position: absolute; left: 0; right: 0; border-top: 1.5px dashed var(--warn); opacity: 0.85; z-index: 1; pointer-events: none; }
  .thr span { position: absolute; right: 0; bottom: 2px; font-size: 11px; color: var(--warn-text); }
  .barcol { position: relative; flex: 1 1 0; min-width: 2px; max-width: 48px; height: 100%; display: flex; align-items: flex-end; justify-content: center; }
  .bar { position: relative; width: 70%; min-height: 2px; border-radius: 6px 6px 0 0; background: var(--accent-dim); }
  .bar.tuned { background: linear-gradient(180deg, var(--accent-hi), var(--accent)); }
  .bar.bad { background: var(--warn); }
  .bar.before { position: absolute; bottom: 0; background: none; border: 1.5px dashed var(--warn); border-bottom: 0; }
  .kpis { flex: 1 1 300px; min-width: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 16px; }
  .tile { display: flex; flex-direction: column; gap: 12px; padding: 12px 12px 16px; border-radius: 20px; background: var(--surface); border: 1.5px solid var(--line); text-align: left; color: inherit; }
  .tile:disabled { opacity: 1; cursor: default; }
  .tile:hover:not(:disabled) { border-color: var(--line-3); }
  .tile.tuned { border-color: var(--accent); box-shadow: 0 0 0 4px rgba(200, 246, 90, 0.08); }
  .thumb { position: relative; aspect-ratio: 4 / 3; border-radius: 14px; overflow: hidden; }
  .layer { position: absolute; inset: 8px; width: calc(100% - 16px); height: calc(100% - 16px); object-fit: contain; }
  .vec { clip-path: inset(0 0 0 50%); }
  .raster { image-rendering: pixelated; }
  .divider { position: absolute; top: 0; bottom: 0; left: 50%; width: 2px; background: var(--accent); }
  .busy { position: absolute; inset: 0; display: grid; place-items: center; background: rgba(10, 11, 15, 0.45); }
  .lab { position: absolute; top: 8px; font-size: 10px; border-radius: 4px; padding: 2px 6px; }
  .lab.l { left: 8px; color: var(--text); background: rgba(10, 11, 15, 0.8); }
  .lab.r { right: 8px; color: #0a0b0f; background: var(--accent); }
  .nm { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .meter { height: 6px; border-radius: 999px; background: var(--line); overflow: hidden; }
  .meter span { display: block; height: 100%; border-radius: 999px; background: var(--accent-dim); }
  .meter span.tuned { background: var(--accent); }
  .meter span.bad { background: var(--warn); }
  .exportbar { position: sticky; bottom: 0; padding: 16px 32px 24px; background: linear-gradient(180deg, rgba(10, 11, 15, 0) 0%, var(--bg) 40%); margin: 0 -32px -64px; }
  .exportbar .inner { max-width: 1360px; margin: 0 auto; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; background: var(--surface); border: 1px solid var(--line-2); border-radius: 18px; padding: 12px 12px 12px 20px; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5); }
</style>
