<script lang="ts">
  import { app, go } from '../store.svelte'
  import { PRESETS, presetById } from '../engine/presets'
  import { addFiles, addSheet, clearItems, filesFromDrop, processAll } from '../pipeline'
  import { KIND_LABEL, type ImageKind } from '../engine/analyze'

  let dragging = $state(false)
  let fileInput: HTMLInputElement
  let folderInput: HTMLInputElement
  let sheetInput: HTMLInputElement
  let sheetInfo = $state<string | null>(null)
  let slicing = $state(false)

  async function onSheet(e: Event) {
    const input = e.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    slicing = true
    sheetInfo = null
    try {
      const r = await addSheet(file)
      sheetInfo = r.count
        ? `${r.name} : ${r.count} élément${r.count > 1 ? 's' : ''} découpé${r.count > 1 ? 's' : ''}` +
          (r.background !== 'transparent' ? `, fond ${r.background} rendu transparent` : '') +
          (r.dropped ? ` (${r.dropped} petit${r.dropped > 1 ? 's' : ''} détail${r.dropped > 1 ? 's' : ''} isolé${r.dropped > 1 ? 's' : ''} ignoré${r.dropped > 1 ? 's' : ''})` : '')
        : `${r.name} : aucun élément trouvé`
    } catch (err) {
      sheetInfo = `Découpage impossible : ${err instanceof Error ? err.message : String(err)}`
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
    if (e.dataTransfer) addFiles(await filesFromDrop(e.dataTransfer))
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
  const sizeLabel = (b: number) => (b > 1048576 ? (b / 1048576).toFixed(1).replace('.', ',') + ' Mo' : Math.round(b / 1024) + ' Ko')
  const total = $derived(app.items.reduce((s, i) => s + i.srcBytes, 0))
  const analysed = $derived(app.items.filter((i) => i.analysis))
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
      <span class="mono eyebrow">SMOOTH VECTORS. GOOD VIBES.</span>
      <h1>Du pixel au vecteur,<br />en un glisser-déposer.</h1>
      <p class="muted lead">Vectorisez une image ou un dossier entier. Chaque SVG est comparé à l'original et réglé automatiquement jusqu'à passer sous le seuil d'écart.</p>
    </div>
    <img class="hero-mascot" src="/brand/mascot-welcome.webp" alt="" width="220" height="220" />
    </div>

    <div
      class="drop"
      class:dragging
      role="region"
      aria-label="Zone de dépôt des images"
      ondragover={(e) => { e.preventDefault(); dragging = true }}
      ondragleave={() => (dragging = false)}
      ondrop={onDrop}
    >
      <div class="drop-inner">
        <div class="stack" style="flex: 1 1 320px">
          <h2>Déposez vos images ici</h2>
          <p class="muted">PNG, JPEG, WebP, GIF — fichiers isolés ou dossier complet. Les originaux ne sont jamais modifiés.</p>
          <div class="row" style="flex-wrap: wrap">
            <button type="button" class="btn btn-primary" onclick={() => fileInput.click()}>Choisir des fichiers</button>
            <button type="button" class="btn" onclick={() => folderInput.click()}>Choisir un dossier</button>
            <button type="button" class="btn" onclick={() => sheetInput.click()} disabled={slicing || app.running} title="Sépare automatiquement les éléments d'une planche (fond transparent ou uni)">
              {#if slicing}<span class="spinner"></span>{/if}
              Découper une planche
            </button>
            {#if app.items.length}
              <button type="button" class="btn" onclick={clearItems} disabled={app.running}>Vider</button>
            {/if}
          </div>
          <input bind:this={fileInput} class="sr-only" type="file" multiple accept="image/png,image/jpeg,image/webp,image/gif,image/bmp" onchange={onPick} tabindex="-1" />
          <input bind:this={folderInput} class="sr-only" type="file" multiple {...{ webkitdirectory: true }} onchange={onPick} tabindex="-1" />
          <input bind:this={sheetInput} class="sr-only" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/bmp" onchange={onSheet} tabindex="-1" />
          {#if sheetInfo}<span class="small" style="color: var(--accent-text)" role="status">{sheetInfo}</span>{/if}
        </div>
        {#if app.items.length}
          <div class="picked">
            <div class="thumbs">
              {#each app.items.slice(0, 12) as it (it.id)}
                <img src={it.srcUrl} alt={it.name} class="checker" />
              {/each}
            </div>
            <span class="mono muted small">{app.items.length} image{app.items.length > 1 ? 's' : ''} · {sizeLabel(total)}</span>
            {#if analysed.length < app.items.length}
              <span class="row muted small"><span class="spinner"></span>Analyse {analysed.length}/{app.items.length}…</span>
            {:else}
              <div class="row" style="flex-wrap: wrap; gap: 6px">
                {#each kinds as [k, n] (k)}<span class="chip chip-ok">{n} × {KIND_LABEL[k]}</span>{/each}
                {#if softCount}<span class="chip chip-warn">{softCount} avec transparence douce</span>{/if}
                {#if photoCount}<span class="chip chip-warn">{photoCount} photo{photoCount > 1 ? 's' : ''} : résultat approximatif</span>{/if}
              </div>
            {/if}
          </div>
        {/if}
      </div>
    </div>

    <div class="stack">
      <div class="between">
        <h2>Préréglage</h2>
        <span class="muted small">Point de départ du réglage automatique</span>
      </div>
      <div class="presets">
        {#each PRESETS as p (p.id)}
          <button type="button" class="preset" aria-pressed={app.presetId === p.id} onclick={() => pickPreset(p.id)}>
            <span class="between" style="width: 100%">
              <span class="row" style="gap: 4px">
                {#each p.swatches as c}<span class="dot" style:background={c}></span>{/each}
              </span>
              {#if p.recommended}<span class="chip chip-accent">Validé</span>{/if}
            </span>
            <span class="pname">{p.name}</span>
            <span class="muted small">{p.desc}</span>
          </button>
        {/each}
      </div>
    </div>
  </section>

  <aside class="side">
    <div class="card stack">
      <div class="between" style="flex-wrap: nowrap">
        <div class="stack" style="gap: 4px">
          <h2 class="h3">Réglage automatique</h2>
          <span class="muted small">Essaie d'autres réglages sur les images au-dessus du seuil ou trop lourdes</span>
        </div>
        <button type="button" class="toggle" aria-label="Activer le réglage automatique" aria-pressed={app.auto.enabled} onclick={() => (app.auto.enabled = !app.auto.enabled)}><span></span></button>
      </div>
      <div class="field">
        <label for="thr"><span>Seuil d'écart visible</span><span class="value accent">{app.auto.threshold.toFixed(1).replace('.', ',')} %</span></label>
        <input id="thr" type="range" min="0.5" max="10" step="0.5" bind:value={app.auto.threshold} />
      </div>
      <div class="field">
        <label for="kb"><span>Poids max par SVG</span><span class="value accent">{app.auto.maxKB} Ko</span></label>
        <input id="kb" type="range" min="50" max="3000" step="50" bind:value={app.auto.maxKB} />
      </div>
      <span class="mono faint small">score = % écart + 0,002 × Ko · même entrée → même SVG</span>
    </div>

    <div class="card stack">
      <div class="between">
        <h2 class="h3">Paramètres</h2>
        <span class="mono muted small">vtracer</span>
      </div>
      {#if app.presetId === 'auto'}
        <span class="small" style="color: var(--accent-text)">Mode Auto : ces valeurs sont recalculées pour chaque image à partir de son analyse. Modifier un réglage passe en Personnalisé.</span>
      {/if}
      <div class="seg" role="group" aria-label="Couleur">
        <button type="button" aria-pressed={app.params.colormode === 'color'} onclick={() => { app.params.colormode = 'color'; markCustom() }}>Couleur</button>
        <button type="button" aria-pressed={app.params.colormode === 'binary'} onclick={() => { app.params.colormode = 'binary'; markCustom() }}>Noir & blanc</button>
      </div>
      <div class="seg" role="group" aria-label="Courbes">
        <button type="button" aria-pressed={app.params.mode === 'spline'} onclick={() => { app.params.mode = 'spline'; markCustom() }}>Courbes</button>
        <button type="button" aria-pressed={app.params.mode === 'polygon'} onclick={() => { app.params.mode = 'polygon'; markCustom() }}>Polygones</button>
      </div>
      <div class="field">
        <label for="ld"><span>Écart entre couches</span><span class="value">{app.params.layerDifference}</span></label>
        <input id="ld" type="range" min="1" max="64" bind:value={app.params.layerDifference} oninput={markCustom} disabled={app.params.colormode === 'binary'} />
      </div>
      <div class="field">
        <label for="cp"><span>Précision des couleurs</span><span class="value">{app.params.colorPrecision} / 8</span></label>
        <input id="cp" type="range" min="1" max="8" bind:value={app.params.colorPrecision} oninput={markCustom} disabled={app.params.colormode === 'binary'} />
      </div>
      <div class="field">
        <label for="sp"><span>Taille min. des taches</span><span class="value">{app.params.speckle} px</span></label>
        <input id="sp" type="range" min="0" max="32" bind:value={app.params.speckle} oninput={markCustom} />
      </div>
      <div class="field">
        <label for="af"><span>Nettoyage transparence</span><span class="value">α &lt; {app.params.alphaFloor}</span></label>
        <input id="af" type="range" min="0" max="64" bind:value={app.params.alphaFloor} oninput={markCustom} />
      </div>
      <div class="field">
        <label for="cut"><span>Seuil de silhouette</span><span class="value">α ≥ {app.params.silhouetteCut}</span></label>
        <input id="cut" type="range" min="16" max="240" step="8" bind:value={app.params.silhouetteCut} oninput={markCustom} disabled={app.params.colormode === 'binary'} />
      </div>
      <div class="field">
        <label for="soft"><span>Bords adoucis (couches semi-transparentes)</span><span class="value">{app.params.softLayers || 'aucune'}</span></label>
        <input id="soft" type="range" min="0" max="4" bind:value={app.params.softLayers} oninput={markCustom} disabled={app.params.colormode === 'binary' || app.params.softColor} />
      </div>
      <label class="row small muted" style="justify-content: space-between; min-height: 40px">
        Tracer les zones semi-transparentes en couleur
        <input type="checkbox" bind:checked={app.params.softColor} onchange={markCustom} disabled={app.params.colormode === 'binary'} />
      </label>
    </div>

    <button type="button" class="btn btn-light cta" disabled={!app.items.length || app.running} onclick={start}>
      {app.running ? 'Vectorisation en cours…' : app.items.length ? `Vectoriser ${app.items.length} image${app.items.length > 1 ? 's' : ''}` : 'Ajoutez des images'}
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
