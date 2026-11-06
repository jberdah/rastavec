<script lang="ts">
  import { onDestroy } from 'svelte'
  import type { NearbyGroup, NearbyResult, NearbyZone } from '../engine/group-nearby'
  import { download } from '../export'
  import { i18n } from '../i18n.svelte'

  function colorName(hex: string, locale: string) {
    const rgb = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255)
    const max = Math.max(...rgb), min = Math.min(...rgb), delta = max - min, light = (max + min) / 2
    const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * light - 1))
    if (saturation < 0.16) return locale === 'fr' ? light < 0.18 ? 'noir' : light > 0.88 ? 'blanc' : 'gris' : light < 0.18 ? 'black' : light > 0.88 ? 'white' : 'gray'
    let hue = 0
    if (max === rgb[0]) hue = 60 * (((rgb[1] - rgb[2]) / delta) % 6)
    else if (max === rgb[1]) hue = 60 * ((rgb[2] - rgb[0]) / delta + 2)
    else hue = 60 * ((rgb[0] - rgb[1]) / delta + 4)
    if (hue < 0) hue += 360
    const en = hue < 15 || hue >= 345 ? 'red' : hue < 40 ? 'orange' : hue < 70 ? 'yellow' : hue < 155 ? 'green' : hue < 190 ? 'turquoise' : hue < 250 ? 'blue' : hue < 290 ? 'purple' : hue < 330 ? 'magenta' : 'red'
    const fr: Record<string, string> = { red: 'rouge', orange: 'orange', yellow: 'jaune', green: 'vert', turquoise: 'turquoise', blue: 'bleu', purple: 'violet', magenta: 'magenta' }
    return locale === 'fr' ? fr[en] : en
  }
  function zoneName(zone: NearbyZone, locale: string) {
    const fr: Record<NearbyZone, string> = {
      'top-left': 'en haut à gauche', top: 'en haut', 'top-right': 'en haut à droite', left: 'à gauche', center: 'au centre', right: 'à droite',
      'bottom-left': 'en bas à gauche', bottom: 'en bas', 'bottom-right': 'en bas à droite',
    }
    const en: Record<NearbyZone, string> = {
      'top-left': 'top left', top: 'top', 'top-right': 'top right', left: 'left', center: 'center', right: 'right',
      'bottom-left': 'bottom left', bottom: 'bottom', 'bottom-right': 'bottom right',
    }
    return (locale === 'fr' ? fr : en)[zone]
  }

  let { svg, name }: { svg: string; name: string } = $props()
  const words = $derived(i18n.locale === 'fr' ? {
    title: 'Regrouper les formes proches', description: 'Propose des groupes géométriques de chemins voisins. Ce ne sont pas des objets reconnus : vérifiez chaque groupe avant de l’utiliser.',
    distance: 'Distance maximale (unités du SVG)', run: 'Proposer des groupes', running: 'Analyse…', empty: 'Aucun groupe proposé avec ces réglages.',
    count: (n: number) => `${n} groupe${n > 1 ? 's' : ''} proposé${n > 1 ? 's' : ''}`,
    details: (n: number, s: number) => `${n} chemins examinés · ${s} ignorés par précaution`,
    limit: (kind: string) => kind === 'path-count' ? 'Analyse arrêtée : plus de 10 000 chemins.' : 'Analyse arrêtée : géométrie trop complexe pour ces limites de sécurité.',
    group: 'Groupe sélectionné', groupLevel: 'Niveau de regroupement', allLevels: 'Tous les niveaux', nearbyLevel: 'Groupes proches', clusterLevel: 'Ensembles larges', search: 'Rechercher dans les groupes', list: 'Groupes proposés', noResults: 'Aucun groupe ne correspond à cette recherche.', name: 'Nom du groupe', nameHint: 'Nom descriptif automatique : couleur dominante et position. Modifiable avant export.', previous: 'Groupe précédent', next: 'Groupe suivant',
    preview: 'Aperçu du groupe isolé', save: 'Télécharger le SVG groupé', stale: 'Les réglages ou l’image ont changé. Relancez la proposition.',
    limitation: 'Les groupes larges contiennent les petits groupes proches ; les noms auto décrivent seulement la couleur dominante et la position. L’ordre de dessin est conservé. Le SVG groupé se télécharge séparément ; le ZIP du lot reste inchangé.',
    error: 'Impossible de proposer les groupes',
  } : {
    title: 'Group nearby shapes', description: 'Suggests geometric groups of nearby paths. These are not recognized objects: review each group before using it.',
    distance: 'Maximum distance (SVG units)', run: 'Suggest groups', running: 'Analyzing…', empty: 'No groups found with these settings.',
    count: (n: number) => `${n} suggested group${n === 1 ? '' : 's'}`,
    details: (n: number, s: number) => `${n} paths examined · ${s} skipped conservatively`,
    limit: (kind: string) => kind === 'path-count' ? 'Analysis stopped: more than 10,000 paths.' : 'Analysis stopped: geometry exceeds the safety limits.',
    group: 'Selected group', groupLevel: 'Grouping level', allLevels: 'All levels', nearbyLevel: 'Nearby groups', clusterLevel: 'Larger clusters', search: 'Search groups', list: 'Suggested groups', noResults: 'No groups match this search.', name: 'Group name', nameHint: 'Automatic descriptive name from dominant colour and position. Edit before export.', previous: 'Previous group', next: 'Next group',
    preview: 'Isolated group preview', save: 'Download grouped SVG', stale: 'The settings or image changed. Run the suggestion again.',
    limitation: 'Larger groups contain nearby smaller groups; automatic names describe only dominant colour and position. Drawing order is preserved. The grouped SVG downloads separately; the batch ZIP is unchanged.',
    error: 'Could not suggest groups',
  })
  const maxDistance = $derived.by(() => {
    const match = svg.match(/\bviewBox="\s*[-+\d.eE]+[\s,]+[-+\d.eE]+[\s,]+([-+\d.eE]+)[\s,]+([-+\d.eE]+)/)
    return match ? Math.min(Number(match[1]), Number(match[2])) * 0.1 : 0
  })
  let distance = $state(0)
  $effect(() => { distance = Math.min(maxDistance, Math.max(0.5, Math.min(8, maxDistance * 0.05))) })
  let busy = $state(false)
  let output = $state.raw<NearbyResult | null>(null)
  let source = $state('')
  let usedDistance = $state(0)
  let selected = $state('')
  let groupLevel = $state<'all' | 'nearby' | 'cluster'>('all')
  let search = $state('')
  let customNames = $state<Record<string, string>>({})
  let error = $state('')
  const current = $derived(!!output && source === svg && usedDistance === distance)
  const levelGroups = $derived(output?.groups.filter((group) => groupLevel === 'all' || (groupLevel === 'cluster' ? group.level === 1 : group.level === 0)) ?? [])
  const groupOrdinals = $derived.by(() => {
    const counts = new Map<number, number>(), ordinals = new Map<string, number>()
    for (const group of output?.groups ?? []) {
      const ordinal = counts.get(group.level) ?? 0
      ordinals.set(group.id, ordinal)
      counts.set(group.level, ordinal + 1)
    }
    return ordinals
  })
  const visibleGroups = $derived(levelGroups.filter((group, index) => !search.trim() || labelFor(group, index).toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())))
  const selectedIndex = $derived(visibleGroups.findIndex((group) => group.id === selected))
  const selectedGroup = $derived(output?.groups.find((group) => group.id === selected))
  let worker: Worker | null = null
  let destroyed = false
  onDestroy(() => { destroyed = true; worker?.terminate(); worker = null })

  function step(offset: number) {
    const next = visibleGroups[selectedIndex + offset]
    if (next) selected = next.id
  }
  function moveListSelection(event: KeyboardEvent, index: number) {
    let next = index
    if (event.key === 'ArrowDown') next = Math.min(visibleGroups.length - 1, index + 1)
    else if (event.key === 'ArrowUp') next = Math.max(0, index - 1)
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = visibleGroups.length - 1
    else return
    event.preventDefault()
    const group = visibleGroups[next]
    if (!group) return
    selected = group.id
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`.group-option[data-index="${next}"]`)?.focus())
  }
  function changeGroupLevel(event: Event) {
    const level = (event.currentTarget as HTMLSelectElement).value as typeof groupLevel
    groupLevel = level
    search = ''
    selected = output?.groups.find((group) => level === 'all' || (level === 'cluster' ? group.level === 1 : group.level === 0))?.id ?? ''
  }
  function changeSearch(event: Event) {
    search = (event.currentTarget as HTMLInputElement).value
    const query = search.trim().toLocaleLowerCase()
    const matches = levelGroups.filter((group, index) => !query || labelFor(group, index).toLocaleLowerCase().includes(query))
    if (!query || matches.some((group) => group.id === selected)) return
    selected = matches[0]?.id ?? ''
  }

  async function run() {
    if (busy) return
    busy = true; error = ''; output = null
    const input = svg, d = distance
    try {
      worker = new Worker(new URL('../engine/group-nearby-worker.ts', import.meta.url), { type: 'module' })
      const active = worker
      const result = await new Promise<NearbyResult>((resolve, reject) => {
        active.onmessage = (event: MessageEvent<{ result?: NearbyResult; error?: string }>) => {
          if (event.data.error || !event.data.result) reject(new Error(event.data.error ?? 'Analysis failed'))
          else resolve(event.data.result)
        }
        active.onerror = (event) => reject(new Error(event.message || 'Analysis failed'))
        active.onmessageerror = () => reject(new Error('Invalid analysis response'))
        active.postMessage({ svg: input, distance: d })
      })
      if (destroyed) return
      source = input; usedDistance = d; output = result; customNames = {}
      search = ''
      groupLevel = result.groups.some((group) => group.level === 1) ? 'cluster' : 'nearby'
      selected = result.groups.find((group) => group.level === (groupLevel === 'cluster' ? 1 : 0))?.id ?? result.groups[0]?.id ?? ''
    } catch (e) { if (!destroyed) error = e instanceof Error ? e.message : String(e) }
    finally { worker?.terminate(); worker = null; if (!destroyed) busy = false }
  }

  function autoName(group: NearbyGroup, index: number) {
    const locale = i18n.locale
    const noun = locale === 'fr'
      ? `${group.level === 1 ? 'Ensemble' : 'Groupe'} ${index + 1} · ${group.count} formes`
      : `${group.level === 1 ? 'Cluster' : 'Group'} ${index + 1} · ${group.count} shapes`
    return `${noun} · ${colorName(group.fill, locale)} · ${zoneName(group.zone, locale)}`
  }
  function labelFor(group: NearbyGroup, index: number) {
    const ordinal = groupOrdinals.get(group.id) ?? index
    return customNames[group.id]?.trim() || autoName(group, ordinal)
  }
  function renameSelected(event: Event) {
    if (!selected) return
    customNames = { ...customNames, [selected]: (event.currentTarget as HTMLInputElement).value }
  }
  function escapeXml(value: string) {
    return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
  }
  function labelledSvg() {
    if (!output) return ''
    return output.groups.reduce((svgText, group, index) => {
      const open = `<g id="${group.id}" data-rastavec-group="proximity" data-rastavec-level="${group.level}">`
      const title = escapeXml(labelFor(group, index))
      return svgText.replace(open, `<g id="${group.id}" data-rastavec-group="proximity" aria-label="${title}"><title>${title}</title>`)
    }, output.svg)
  }

  // Isolation is a disposable preview: retain ancestors and definitions so inherited
  // transforms, opacity and clipping continue to apply, and remove unrelated artwork.
  function isolatedSvg(input: string, id: string) {
    const doc = new DOMParser().parseFromString(input, 'image/svg+xml')
    if (doc.querySelector('parsererror')) throw new Error('Invalid SVG')
    const group = Array.from(doc.querySelectorAll('[id]')).find((el) => el.getAttribute('id') === id)
    if (!group) throw new Error('Group not found')
    const technical = new Set(['defs', 'clippath', 'mask', 'pattern', 'symbol'])
    for (const el of Array.from(doc.querySelectorAll('path,rect,circle,ellipse,line,polyline,polygon,image,text,use'))) {
      let parent: Element | null = el
      let protectedElement = false
      while (parent) { if (technical.has(parent.localName.toLowerCase())) { protectedElement = true; break } parent = parent.parentElement }
      if (!protectedElement && !group.contains(el)) el.remove()
    }
    return new XMLSerializer().serializeToString(doc)
  }
  let previewUrl = $state('')
  $effect(() => {
    if (!current || !output || !selected) { previewUrl = ''; return }
    try {
      const url = URL.createObjectURL(new Blob([isolatedSvg(output.svg, selected)], { type: 'image/svg+xml' }))
      previewUrl = url
      return () => URL.revokeObjectURL(url)
    } catch { previewUrl = '' }
  })
  function save() {
    if (current && output) download(new Blob([labelledSvg()], { type: 'image/svg+xml' }), `${name}-groupes.svg`)
  }
</script>

<div class="card stack group-review">
  <div class="between heading">
    <div><h2 class="h3">{words.title}</h2><p class="muted small">{words.description}</p></div>
    <div class="run-controls">
      <label class="small" for="group-distance">{words.distance}</label>
      <input id="group-distance" type="number" min="0" max={maxDistance} step="0.1" bind:value={distance} disabled={busy || !maxDistance} />
      <button type="button" class="btn btn-primary" onclick={run} disabled={busy || !Number.isFinite(distance) || distance < 0 || distance > maxDistance}>{busy ? words.running : words.run}</button>
    </div>
  </div>
  {#if error}<span role="alert" class="small">{words.error}: {error}</span>{/if}
  {#if output && !current}<span class="muted small">{words.stale}</span>{/if}
  {#if output && current}
    <div class="result-summary"><span aria-live="polite" class="small">{output.groups.length ? words.count(output.groups.length) : words.empty}</span><span class="muted tiny">{words.details(output.considered, output.skipped)}</span></div>
    {#if output.limit}<span role="status" class="small">{words.limit(output.limit)}</span>{/if}
    {#if output.groups.length}
      <div class="manager">
        <section class="group-list" aria-label={words.list}>
          <div class="list-controls">
            <label class="small" for="group-level">{words.groupLevel}</label>
            <select id="group-level" bind:value={groupLevel} onchange={changeGroupLevel}>
              <option value="all">{words.allLevels}</option>
              <option value="nearby">{words.nearbyLevel}</option>
              {#if output.groups.some((group) => group.level === 1)}<option value="cluster">{words.clusterLevel}</option>{/if}
            </select>
            <label class="small" for="group-search">{words.search}</label>
            <input id="group-search" type="search" value={search} oninput={changeSearch} />
            <div class="between"><span class="small">{words.list}</span><span class="muted tiny">{visibleGroups.length} / {levelGroups.length}</span></div>
          </div>
          <div class="group-items" aria-label={words.list}>
            {#each visibleGroups as group, index (group.id)}
              <button type="button" aria-pressed={selected === group.id} tabindex={selected === group.id || (selectedIndex < 0 && index === 0) ? 0 : -1} data-index={index} class="group-option" class:child={groupLevel === 'all' && !!group.parentId} onclick={() => (selected = group.id)} onkeydown={(event) => moveListSelection(event, index)}>
                <span class="swatch" style:background={group.fill}></span><span class="option-text">{#if groupLevel === 'all' && group.parentId}<span class="branch" aria-hidden="true">↳</span>{/if}{labelFor(group, index)}</span>
              </button>
            {/each}
            {#if !visibleGroups.length}<p class="muted small no-results">{words.noResults}</p>{/if}
          </div>
        </section>
        <section class="group-detail" aria-label={words.group}>
          {#if selectedGroup}
            <div class="between detail-heading"><div><span class="muted tiny">{words.group}</span><h3 class="h3">{labelFor(selectedGroup, selectedIndex)}</h3></div><div class="row nav" style="gap:8px">
              <button type="button" class="btn" aria-label={words.previous} onclick={() => step(-1)} disabled={selectedIndex <= 0}>‹</button>
              <span class="small" aria-live="polite">{selectedIndex + 1} / {visibleGroups.length}</span>
              <button type="button" class="btn" aria-label={words.next} onclick={() => step(1)} disabled={selectedIndex < 0 || selectedIndex >= visibleGroups.length - 1}>›</button>
            </div></div>
            <label for="group-name" class="small">{words.name}</label>
            <input id="group-name" type="text" maxlength="80" value={customNames[selectedGroup.id] ?? labelFor(selectedGroup, selectedIndex)} oninput={renameSelected} />
            <span class="muted tiny">{words.nameHint}</span>
            {#if previewUrl}<div class="preview"><img src={previewUrl} alt={words.preview} /></div>{/if}
            <button type="button" class="btn btn-primary" onclick={save}>{words.save}</button>
          {/if}
        </section>
      </div>
    {/if}
  {/if}
  <p class="muted tiny">{words.limitation}</p>
</div>

<style>
  .h3 { font-size: 16px; margin: 0; }
  .heading p { margin: 6px 0 0; max-width: 680px; }
  .run-controls { display: flex; align-items: center; gap: 10px; }
  .result-summary { display: flex; gap: 16px; align-items: baseline; flex-wrap: wrap; }
  .manager { display: grid; grid-template-columns: minmax(260px, 0.8fr) minmax(0, 1.2fr); gap: 18px; min-height: 420px; }
  .group-list, .group-detail { min-width: 0; border: 1px solid var(--line-2); border-radius: 12px; }
  .group-list { display: flex; flex-direction: column; overflow: hidden; }
  .list-controls { padding: 12px; display: grid; grid-template-columns: auto minmax(0,1fr); align-items: center; gap: 8px 12px; border-bottom: 1px solid var(--line-2); }
  .list-controls > label:nth-of-type(2), .list-controls > .between { grid-column: 1 / -1; }
  .list-controls > .between { margin-top: 4px; }
  .group-items { overflow: auto; max-height: 540px; padding: 6px; }
  .group-option { width: 100%; min-height: 38px; display: flex; align-items: center; gap: 9px; text-align: left; padding: 7px 9px; border: 1px solid transparent; border-radius: 8px; background: transparent; color: var(--text); }
  .group-option:hover { background: var(--surface-2); }
  .group-option[aria-pressed='true'] { background: var(--surface-2); border-color: var(--accent-line); }
  .group-option.child { padding-left: 22px; }
  .option-text { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 13px; }
  .branch { color: var(--muted); margin-right: 5px; }
  .swatch { width: 12px; height: 12px; flex: 0 0 12px; border: 1px solid var(--line-3); border-radius: 4px; }
  .no-results { padding: 8px 12px; }
  .group-detail { padding: 16px; display: flex; flex-direction: column; align-items: stretch; gap: 10px; }
  .detail-heading { align-items: flex-start; }
  .nav { flex-shrink: 0; }
  .small { font-size: 13px; }
  .tiny { font-size: 12px; }
  .group-review input, .group-review select { max-width: 100%; min-width: 0; padding: 8px; color: var(--text); background: var(--surface-2); border: 1px solid var(--line-2); border-radius: 8px; }
  .preview { flex: 1; min-height: 250px; max-height: 420px; background: var(--checker); border: 1px solid var(--line-2); border-radius: 12px; }
  .preview img { width: 100%; height: 100%; object-fit: contain; }
  @media (max-width: 760px) { .heading { align-items: flex-start; flex-direction: column; gap: 12px; } .run-controls { flex-wrap: wrap; } .manager { grid-template-columns: minmax(0,1fr); } .group-items { max-height: 300px; } .preview { min-height: 220px; } }
</style>
