<script lang="ts">
  import { app, chosenTrial, doneItems, go, needsReview, sources, svgUrl } from '../store.svelte'
  import { diffImage } from '../engine/core'
  import { browserBackend, toDataUrl } from '../engine/browser-backend'
  import { downloadSvg } from '../export'
  import { alphaLabel, describeParams, kindLabel, noteLabel, num, pct, size, t } from '../i18n.svelte'

  type Mode = 'slider' | 'side' | 'diff' | 'paths'
  type Bg = 'checker' | 'light' | 'dark'
  let mode = $state<Mode>('slider')
  let bg = $state<Bg>('checker')
  let pos = $state(50)
  let diffUrl = $state<string | null>(null)

  const list = $derived(doneItems())
  const item = $derived(list.find((i) => i.id === app.selectedId) ?? list[0])
  const index = $derived(item ? list.indexOf(item) : -1)
  const trial = $derived(item ? chosenTrial(item) : null)
  const m = $derived(trial?.metrics)

  // Diff map for the chosen trial, computed on demand.
  $effect(() => {
    if (mode !== 'diff' || !item || !trial) return
    const src = sources.get(item.id)
    if (!src) return
    let cancelled = false
    diffUrl = null
    browserBackend.rasterize(trial.svg, src.width, src.height).then((render) => {
      if (!cancelled) diffUrl = toDataUrl(diffImage(src, render))
    })
    return () => (cancelled = true)
  })

  // Outline view: same SVG, paths stroked instead of filled.
  const outline = $derived(
    trial
      ? trial.svg
          .replace(/<svg([^>]*?)\swidth="\d+"\sheight="\d+"/, '<svg$1 width="100%" height="100%" preserveAspectRatio="xMidYMid meet"')
          .replace(/(<svg[^>]*>)/, '$1<style>path{fill:none!important;stroke:#3CC274;stroke-width:0.6px;vector-effect:non-scaling-stroke}</style>')
      : '',
  )

  const step = (d: number) => {
    const next = list[(index + d + list.length) % list.length]
    if (next) app.selectedId = next.id
  }
  const ringDash = $derived(m ? `${(276.5 * Math.max(0, 100 - m.pctDiff)) / 100} 276.5` : '0 276.5')
  const bgStyle = $derived(bg === 'light' ? '#ffffff' : bg === 'dark' ? '#202020' : 'var(--checker)')
</script>

{#if !item || !trial || !m}
  <div class="card stack" style="max-width: 560px; align-items: flex-start">
    <img src="/brand/mascot-inspect.webp" alt="" width="160" height="160" style="width: 160px; height: auto" />
    <h1>{t('detail.empty')}</h1>
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
        {#if needsReview(item)}<span class="chip chip-warn">{t('status.review')}</span>{:else if item.autoTuned}<span class="chip chip-accent">{t('status.auto')}</span>{:else}<span class="chip chip-ok">{t('status.ok')}</span>{/if}
        <span class="mono muted small">{item.width} × {item.height} · {size(item.srcBytes)}</span>
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
          <div class="seg strong" role="group" aria-label={t('detail.modeGroup')}>
            <button type="button" aria-pressed={mode === 'slider'} onclick={() => (mode = 'slider')}>{t('detail.slider')}</button>
            <button type="button" aria-pressed={mode === 'side'} onclick={() => (mode = 'side')}>{t('detail.side')}</button>
            <button type="button" aria-pressed={mode === 'diff'} onclick={() => (mode = 'diff')}>{t('detail.diff')}</button>
            <button type="button" aria-pressed={mode === 'paths'} onclick={() => (mode = 'paths')}>{t('detail.paths')}</button>
          </div>
          <div class="seg" role="group" aria-label={t('detail.bgGroup')}>
            <button type="button" aria-label={t('detail.bgChecker')} aria-pressed={bg === 'checker'} onclick={() => (bg = 'checker')}><span class="swatch checker"></span></button>
            <button type="button" aria-label={t('detail.bgLight')} aria-pressed={bg === 'light'} onclick={() => (bg = 'light')}><span class="swatch" style="background: #fff"></span></button>
            <button type="button" aria-label={t('detail.bgDark')} aria-pressed={bg === 'dark'} onclick={() => (bg = 'dark')}><span class="swatch" style="background: #202020"></span></button>
          </div>
        </div>

        <div class="stage" style:background={mode === 'diff' ? '#f4f4f5' : mode === 'paths' ? 'var(--sunken)' : bgStyle}>
          {#if mode === 'slider'}
            <img class="fit" src={item.srcUrl} alt={t('detail.original')} />
            <img class="fit" src={svgUrl(item)} alt="SVG" style:clip-path={`inset(0 0 0 ${pos}%)`} />
            <span class="split" style:left={`${pos}%`}><span class="knob">⇆</span></span>
            <span class="lab mono l">{t('detail.original')}</span>
            <span class="lab mono r">SVG · {t('detail.pathsCount', m.paths)}</span>
          {:else if mode === 'side'}
            <div class="side">
              <div class="half"><img class="fit" src={item.srcUrl} alt={t('detail.original')} /><span class="lab mono l">{t('detail.original')}</span></div>
              <div class="half"><img class="fit" src={svgUrl(item)} alt="SVG" /><span class="lab mono r">SVG</span></div>
            </div>
          {:else if mode === 'diff'}
            {#if diffUrl}<img class="fit" src={diffUrl} alt={t('detail.diffAlt')} />{:else}<span class="center"><span class="spinner"></span></span>{/if}
            <div class="legend mono"><span>0</span><span class="grad"></span><span>96+ / 255</span><span class="faint">{t('detail.diffHidden')}</span></div>
          {:else}
            <div class="fit outline">{@html outline}</div>
            <span class="lab mono l accent">{t('detail.pathsCount', m.paths)}</span>
          {/if}
        </div>
        {#if mode === 'slider'}
          <div class="row">
            <label for="split" class="muted small nowrap">{t('detail.sliderPos')}</label>
            <input id="split" type="range" min="0" max="100" bind:value={pos} />
            <span class="mono small" style="width: 52px; text-align: right">{pct(pos, 0)}</span>
          </div>
        {/if}
      </section>

      <aside class="panel">
        <div class="card stack">
          <div class="between"><h2 class="h3">{t('fidelity.title')}</h2><span class="mono faint tiny">{t('fidelity.note')}</span></div>
          <div class="row" style="gap: 18px">
            <div class="ring">
              <svg viewBox="0 0 104 104" width="104" height="104" role="img" aria-label={t('fidelity.aria', pct(100 - m.pctDiff, 1))}><circle cx="52" cy="52" r="44" fill="none" stroke="#1F232C" stroke-width="10" /><circle cx="52" cy="52" r="44" fill="none" stroke={needsReview(item) ? '#FF4F8B' : '#1F8F4A'} stroke-width="10" stroke-linecap="round" stroke-dasharray={ringDash} transform="rotate(-90 52 52)" /></svg>
              <div class="ringlabel"><span class="big">{num(100 - m.pctDiff, 1)}</span><span class="muted tiny">{t('fidelity.faithful')}</span></div>
            </div>
            <dl class="metrics">
              <dt>{t('fidelity.diff')}</dt><dd class="mono">{pct(m.pctDiff)}</dd>
              <dt>{t('fidelity.iou')}</dt><dd class="mono">{num(m.iou ?? 0, 3)}</dd>
              <dt>{t('fidelity.colorWhite')}</dt><dd class="mono">{num(m.rgbWhite, 1)} / 255</dd>
              <dt>{t('fidelity.alpha')}</dt><dd class="mono">{num(m.alphaDiff, 1)} / 255</dd>
            </dl>
          </div>
          {#if item.semiPct > 1}
            <span class="small" style="color: var(--warn-text)">
              {t('semi.intro', pct(item.semiPct, 1))}
              {trial.params.colormode === 'color' && trial.params.softColor
                ? t('semi.color')
                : trial.params.softLayers > 0 && trial.params.colormode === 'color'
                  ? t('semi.layers', trial.params.softLayers)
                  : t('semi.opaque')}
            </span>
          {/if}
        </div>

        {#if item.analysis}
          {@const a = item.analysis}
          <div class="card stack">
            <div class="between"><h2 class="h3">{t('analysis.title')}</h2><span class="chip chip-ok">{kindLabel(a.kind)}</span></div>
            <ul class="reasons">
              <li>{t('analysis.colors', a.dominantColors)}</li>
              <li>{t('analysis.gradient', pct(a.gradient * 100, 0))}</li>
              <li>{a.alpha === 'opaque' ? t('analysis.opaque') : t('analysis.alpha', pct(a.transparentPct, 0), pct(a.softPct, 1), alphaLabel(a.alpha))}</li>
            </ul>
            {#if item.notes?.length}
              <span class="muted tiny">{t('analysis.auto')}</span>
              <ul class="reasons picked">
                {#each item.notes as n}<li>{noteLabel(n)}</li>{/each}
              </ul>
            {/if}
          </div>
        {/if}

        <div class="card stack">
          <div class="between"><h2 class="h3">{t('trials.title')}</h2><span class="mono faint tiny">{t('trials.count', item.trials.length, num(item.trials.reduce((s, x) => s + x.ms, 0) / 1000, 1))}</span></div>
          <ol class="trials">
            {#each item.trials as tr, k}
              <li>
                <button type="button" class="trial" aria-pressed={item.chosen === k} onclick={() => (item.chosen = k)}>
                  <span class="dotc" class:on={item.chosen === k}></span>
                  <span class="stack" style="gap: 3px; flex: 1; min-width: 0">
                    <span class="between" style="flex-wrap: nowrap"><span class="tl">{tr.base ? `${t('trials.base')} · ` : ''}{describeParams(tr.params)}</span><span class="mono" class:accent={item.chosen === k}>{pct(tr.metrics.pctDiff)}</span></span>
                    <span class="mono muted tiny">{t('trials.meta', size(tr.metrics.bytes), tr.metrics.paths, num(tr.score, 2))}</span>
                  </span>
                </button>
              </li>
            {/each}
          </ol>
          <span class="muted tiny">{t('trials.hint')}</span>
        </div>

        <div class="card statgrid">
          <div><span class="muted tiny">{t('stat.size')}</span><span class="sv">{size(m.bytes)}</span></div>
          <div><span class="muted tiny">{t('stat.paths')}</span><span class="sv">{num(m.paths)}</span></div>
          <div><span class="muted tiny">{t('stat.bitmap')}</span><span class="sv" class:accent={!m.embeddedRaster}>{m.embeddedRaster ? t('stat.yes') : t('stat.none')}</span></div>
        </div>

        <button type="button" class="btn btn-primary" onclick={() => downloadSvg(item)}>{t('detail.download')}</button>
      </aside>
    </div>
  </div>
{/if}

<style>
  .name { font-size: 22px; font-weight: 500; }
  .small { font-size: 13px; }
  .tiny { font-size: 12px; }
  .h3 { font-size: 16px; }
  .nowrap { white-space: nowrap; }
  .stagecol { flex: 999 1 600px; min-width: 0; display: flex; flex-direction: column; gap: 12px; }
  .panel { flex: 1 1 340px; min-width: 0; display: flex; flex-direction: column; gap: 14px; }
  .stage { position: relative; height: min(640px, 70vh); min-height: 320px; border-radius: 22px; overflow: hidden; border: 1px solid var(--line-2); }
  .fit { position: absolute; inset: 4%; width: 92%; height: 92%; object-fit: contain; }
  .outline :global(svg) { width: 100%; height: 100%; display: block; }
  .split { position: absolute; top: 0; bottom: 0; width: 2px; background: var(--accent); box-shadow: 0 0 20px var(--accent-glow); pointer-events: none; }
  .knob { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 40px; height: 40px; border-radius: 50%; background: var(--accent); border: 4px solid var(--bg); color: #0a0b0f; display: grid; place-items: center; font-weight: 700; }
  .side { position: absolute; inset: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .half { position: relative; border-right: 1px solid var(--line-2); }
  .lab { position: absolute; top: 14px; font-size: 12px; border-radius: 6px; padding: 4px 8px; }
  .lab.l { left: 14px; background: rgba(10, 11, 15, 0.85); }
  .lab.r { right: 14px; color: #0a0b0f; background: var(--accent); }
  .center { position: absolute; inset: 0; display: grid; place-items: center; }
  .legend { position: absolute; left: 14px; bottom: 14px; display: flex; align-items: center; gap: 10px; background: rgba(10, 11, 15, 0.88); border-radius: 10px; padding: 8px 12px; font-size: 12px; }
  .grad { width: 120px; height: 8px; border-radius: 999px; background: linear-gradient(90deg, #d9d9de, #ff4f8b); }
  .swatch { display: block; width: 20px; height: 20px; border-radius: 6px; border: 1px solid var(--line-3); background-size: 8px 8px; }
  .ring { position: relative; width: 104px; height: 104px; flex: none; }
  .ringlabel { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; }
  .big { font-size: 22px; font-weight: 700; letter-spacing: -0.03em; }
  .metrics { flex: 1; min-width: 0; margin: 0; display: grid; grid-template-columns: 1fr auto; gap: 8px 12px; font-size: 13px; }
  .metrics dt { color: var(--muted); }
  .metrics dd { margin: 0; }
  .trials { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .trial { width: 100%; display: flex; gap: 12px; align-items: flex-start; text-align: left; padding: 10px; border-radius: 12px; border: 1px solid transparent; background: transparent; }
  .trial[aria-pressed='true'] { background: var(--accent-bg); border-color: var(--accent-line); }
  .trial:hover { background: var(--surface-2); }
  .tl { font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dotc { width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--faint); margin-top: 3px; flex: none; }
  .dotc.on { border: 0; background: var(--accent); box-shadow: 0 0 0 4px var(--accent-glow); }
  .reasons { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: var(--muted); }
  .reasons.picked { color: var(--text); }
  .reasons.picked li::marker { color: var(--accent-text); }
  .statgrid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
  .statgrid div { display: flex; flex-direction: column; gap: 4px; }
  .sv { font-size: 20px; font-weight: 600; }
</style>
