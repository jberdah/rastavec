<script lang="ts">
  import { onDestroy } from 'svelte'
  import { app, doneItems, go, markOutsideEdit } from '../store.svelte'
  import { outputSvg } from '../edit'
  import { download } from '../export'
  import { refreshOutputMetrics } from '../pipeline'
  import { buildWalkCycleTracks, motionAt, walkAttachmentPivot } from '../engine/animation'
  import { attachmentPivot } from '../engine/pivot'
  import type { AnimationMetadata, AnimationTrack, GroupingMetadata, Item } from '../engine/types'
  import { i18n } from '../i18n.svelte'

  const items = $derived(doneItems())
  const item = $derived(items.find((candidate) => candidate.id === app.selectedId) ?? items[0])
  const svg = $derived(item ? outputSvg(item) : '')
  const grouping = $derived(item?.grouping?.svg === svg ? item.grouping : undefined)
  const groups = $derived(grouping?.groups ?? [])
  const animation = $derived(item?.animation ?? { durationMs: 1200, easing: 'ease-in-out' as const, tracks: [] })
  let selectedGroupId = $state('')
  let currentMs = $state(0)
  let draftRotation = $state(0)
  let draftTranslationY = $state(0)
  let playing = $state(false)
  let selectedKeyTime = $state<number | null>(null)
  let error = $state('')
  let previewUrl = $state('')
  let pivotOverlay = $state<SVGSVGElement | undefined>(undefined)
  let pivotMode = $state(false)
  let showGuides = $state(true)
  let draggingPivot = false
  let frameRequest = 0
  let playbackStart = 0
  let playbackOffset = 0

  const words = $derived(i18n.locale === 'fr' ? {
    title: 'Animer', intro: 'Animez chaque groupe autour de son pivot, image clé par image clé.',
    image: 'Illustration', chooseImage: 'Choisir une illustration', stage: 'Aperçu', noGroups: 'Aucun groupe prêt pour l’animation.',
    prepare: 'Préparer les groupes', groups: 'Groupes', tracks: 'Pistes', noTrack: 'Aucune image clé. Placez la tête de lecture puis créez-en une.', needMotion: 'Ajoutez au moins deux images clés à des instants différents avec des valeurs différentes pour lire ou exporter une animation.',
    duration: 'Durée', seconds: 's', play: 'Lire', pause: 'Pause', addKey: 'Créer / mettre à jour l’image clé',
    deleteKey: 'Supprimer l’image clé', rotation: 'Rotation', translateY: 'Déplacement vertical', pivot: 'Pivot', timeline: 'Timeline', export: 'Exporter le SVG animé',
    walkCycle: 'Générer une marche', walkCycleGroups: (count: number) => `${count} groupe${count > 1 ? 's' : ''} animé${count > 1 ? 's' : ''}`,
    walkRolesShort: 'Rôles dans Éditer : leg_left, leg_right, arm_left, arm_right, torso.',
    walkRoleHint: 'Rôles : leg_left, leg_right, arm_left, arm_right, torso (ou body). Les pivots par défaut des membres montent à leur attache; vos pivots manuels restent inchangés.',
    exportHint: 'Export SVG avec animations intégrées, en boucle.', noArtwork: 'Vectorisez une image avant de l’animer.',
    chooseGroup: 'Choisissez un groupe dans la liste.', keyAt: (s: string) => `Image clé à ${s} s`,
    introHint: 'Placez le pivot sur l’aperçu ou dans Éditer. Groupes et animations restent modifiables.',
    back: 'Retour à l’édition', loop: 'Boucle', frame: 'Image clé', unsupported: 'Ce SVG ne peut pas être lu pour l’animation.',
    pivotMode: 'Placer le pivot', pivotHint: 'Glissez la croix sur l’articulation à animer.',
    anchorPivot: 'Pivot côté centre', anchorPivotHint: 'Propose un point d’attache géométrique vers le centre de l’illustration ; ajustez-le selon l’articulation.',
    easing: 'Interpolation', smooth: 'Douce', linear: 'Linéaire',
    showGuides: 'Afficher les repères', hideGuides: 'Masquer les repères',
    startSequence: 'Créer une séquence de poses', sequenceHint: 'Utilise les images vectorisées de même format comme poses. Vérifiez et réordonnez la liste avant export.',
    sequenceSource: 'Source de la séquence', allCompatiblePoses: (count: number) => `Toutes les poses compatibles (${count})`,
    gridRow: (name: string, row: number, count: number) => `${name} · ligne ${row} (${count})`,
    frameSequence: 'Séquence de poses', frameNumber: (n: number, total: number) => `Pose ${n} sur ${total}`,
    frameRate: (fps: number) => `${fps.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} images/s`,
    fpsUnit: 'images/s', cadence: 'Cadence', cycleLength: (seconds: number) => `cycle ${seconds.toLocaleString('fr-FR', { maximumFractionDigits: 2 })} s`,
    addFrame: 'Ajouter une pose', removeFrame: 'Retirer', moveFrameUp: 'Monter', moveFrameDown: 'Descendre',
    backToParts: 'Revenir à l’animation par groupes', exportSequence: 'Exporter la séquence SVG', sequenceExportHint: 'Les poses sont intégrées au SVG et défilent en boucle.',
    noFrames: 'Il faut au moins deux images vectorisées de mêmes dimensions.',
  } : {
    title: 'Animate', intro: 'Animate each group around its pivot, one keyframe at a time.',
    image: 'Artwork', chooseImage: 'Choose artwork', stage: 'Preview', noGroups: 'No groups are ready for animation.',
    prepare: 'Prepare groups', groups: 'Groups', tracks: 'Tracks', noTrack: 'No keyframes yet. Move the playhead and create one.', needMotion: 'Add at least two keyframes at different times with different values to play or export an animation.',
    duration: 'Duration', seconds: 's', play: 'Play', pause: 'Pause', addKey: 'Create / update keyframe',
    deleteKey: 'Delete keyframe', rotation: 'Rotation', translateY: 'Vertical movement', pivot: 'Pivot', timeline: 'Timeline', export: 'Export animated SVG',
    walkCycle: 'Generate walk cycle', walkCycleGroups: (count: number) => `Animate ${count} tagged group${count === 1 ? '' : 's'}`,
    walkRolesShort: 'Set in Edit: leg_left, leg_right, arm_left, arm_right, torso.',
    walkRoleHint: 'Roles: leg_left, leg_right, arm_left, arm_right, torso (or body). Default limb pivots move to their attachment; your manual pivots stay unchanged.',
    exportHint: 'Export an SVG with built-in looping animation.', noArtwork: 'Vectorise an image before animating it.',
    chooseGroup: 'Choose a group from the list.', keyAt: (s: string) => `Keyframe at ${s} s`,
    introHint: 'Place pivots on the preview or in Edit. Groups and animation stay editable.',
    back: 'Back to editing', loop: 'Loop', frame: 'Keyframe', unsupported: 'This SVG could not be read for animation.',
    pivotMode: 'Place pivot', pivotHint: 'Drag the cross onto the joint you want to animate.',
    anchorPivot: 'Pivot toward center', anchorPivotHint: 'Suggest a geometric attachment point toward the artwork centre; adjust it to the joint.',
    easing: 'Interpolation', smooth: 'Ease in / out', linear: 'Linear',
    showGuides: 'Show guides', hideGuides: 'Hide guides',
    startSequence: 'Create a pose sequence', sequenceHint: 'Use vectorized images with the same dimensions as poses. Review and reorder them before export.',
    sequenceSource: 'Sequence source', allCompatiblePoses: (count: number) => `All compatible poses (${count})`,
    gridRow: (name: string, row: number, count: number) => `${name} · row ${row} (${count})`,
    frameSequence: 'Pose sequence', frameNumber: (n: number, total: number) => `Pose ${n} of ${total}`,
    frameRate: (fps: number) => `${fps.toLocaleString('en-US', { maximumFractionDigits: 1 })} fps`,
    fpsUnit: 'fps', cadence: 'Frame rate', cycleLength: (seconds: number) => `${seconds.toLocaleString('en-US', { maximumFractionDigits: 2 })} s cycle`,
    addFrame: 'Add pose', removeFrame: 'Remove', moveFrameUp: 'Move up', moveFrameDown: 'Move down',
    backToParts: 'Return to group animation', exportSequence: 'Export SVG sequence', sequenceExportHint: 'Poses are embedded in the SVG and loop continuously.',
    noFrames: 'At least two vectorized images with matching dimensions are needed.',
  })

  function trackHasMotion(track: AnimationTrack) {
    const frames = track.keyframes
      .filter((frame) => Number.isFinite(frame.timeMs) && Number.isFinite(frame.rotation) && Number.isFinite(frame.translateY ?? 0))
      .sort((a, b) => a.timeMs - b.timeMs)
    return frames.some((frame, index) => index > 0
      && frame.timeMs !== frames[index - 1].timeMs
      && (frame.rotation !== frames[index - 1].rotation || (frame.translateY ?? 0) !== (frames[index - 1].translateY ?? 0)))
  }

  const selectedGroup = $derived(groups.find((group) => group.id === selectedGroupId))
  const selectedTrack = $derived(animation.tracks.find((track) => track.groupId === selectedGroupId))
  const keyframes = $derived(selectedTrack?.keyframes ?? [])
  const walkTracks = $derived(buildWalkCycleTracks(groups))
  const hasGroups = $derived(groups.length > 0)
  const compatibleItems = $derived(item ? items.filter((candidate) => candidate.width === item.width && candidate.height === item.height) : [])
  let sequenceSource = $state('all')
  const gridSequenceRows = $derived.by(() => {
    const rows = new Map<string, { stem: string; row: number; items: Item[] }>()
    for (const candidate of compatibleItems) {
      const match = candidate.name.match(/^(.*)-r(\d+)-c\d+$/i)
      if (!match) continue
      const row = Number(match[2])
      const key = `${match[1]}-r${match[2]}`
      const entry = rows.get(key) ?? { stem: match[1], row, items: [] }
      entry.items.push(candidate)
      rows.set(key, entry)
    }
    return Array.from(rows, ([key, entry]) => ({
      key,
      label: words.gridRow(entry.stem, entry.row, entry.items.length),
      items: entry.items,
    })).filter((entry) => entry.items.length > 1)
  })
  const selectedSequenceItems = $derived(sequenceSource === 'all'
    ? compatibleItems
    : gridSequenceRows.find((row) => row.key === sequenceSource)?.items ?? compatibleItems)
  const frameItems = $derived((animation.frameIds ?? []).map((id) => items.find((candidate) => candidate.id === id)).filter((candidate): candidate is Item => !!candidate))
  const frameIndex = $derived(frameItems.length ? Math.min(frameItems.length - 1, Math.floor((currentMs % animation.durationMs) / animation.durationMs * frameItems.length)) : 0)
  const frameRate = $derived(frameItems.length ? animation.fps ?? frameItems.length * 1000 / animation.durationMs : 0)
  const activeFrame = $derived(frameItems[frameIndex])
  const availableFrameItems = $derived(compatibleItems.filter((candidate) => !animation.frameIds?.includes(candidate.id)))
  const viewBox = $derived(svg.match(/\bviewBox="\s*([^\"]+)"/)?.[1] ?? '0 0 100 100')

  $effect(() => {
    if (!selectedGroupId || !groups.some((group) => group.id === selectedGroupId)) selectedGroupId = groups[0]?.id ?? ''
  })

  // Keep the editable value in sync with scrubbing and group selection, without
  // overwriting it while the user is typing a new rotation.
  $effect(() => {
    const groupId = selectedGroupId
    const time = currentMs
    const frames = animation.tracks.find((track) => track.groupId === groupId)?.keyframes ?? []
    const motion = motionAt(frames, time, animation.easing)
    draftRotation = motion.rotation
    draftTranslationY = motion.translateY
    selectedKeyTime = frames.some((frame) => frame.timeMs === time) ? time : null
  })

  function save(next: AnimationMetadata) {
    if (item) item.animation = next
  }

  function startFrameSequence() {
    if (selectedSequenceItems.length < 2) return
    playing = false
    cancelAnimationFrame(frameRequest)
    currentMs = 0
    const fps = 12
    const durationMs = Math.max(50, Math.min(10000, selectedSequenceItems.length * 1000 / fps))
    const firstFrame = selectedSequenceItems[0]
    app.selectedId = firstFrame.id
    firstFrame.animation = {
      ...(firstFrame.animation ?? { durationMs: 1200, easing: 'ease-in-out', tracks: [] }),
      mode: 'frames',
      frameIds: selectedSequenceItems.map((candidate) => candidate.id),
      durationMs,
      fps: selectedSequenceItems.length * 1000 / durationMs,
    }
  }

  function usePartAnimation() {
    playing = false
    cancelAnimationFrame(frameRequest)
    save({ ...animation, mode: 'parts' })
  }

  function updateFrameIds(frameIds: string[]) {
    const fps = frameRate || animation.fps || 12
    const durationMs = frameIds.length ? Math.max(50, Math.min(10000, frameIds.length * 1000 / fps)) : animation.durationMs
    save({ ...animation, mode: 'frames', frameIds, durationMs, fps: frameIds.length ? frameIds.length * 1000 / durationMs : fps })
    if (frameIds.length) currentMs = Math.min(currentMs, durationMs - 1)
  }

  function moveFrame(index: number, offset: -1 | 1) {
    const frameIds = [...(animation.frameIds ?? [])]
    const target = index + offset
    if (target < 0 || target >= frameIds.length) return
    ;[frameIds[index], frameIds[target]] = [frameIds[target], frameIds[index]]
    updateFrameIds(frameIds)
  }

  function addFrame(event: Event) {
    const select = event.currentTarget as HTMLSelectElement
    if (!select.value) return
    updateFrameIds([...(animation.frameIds ?? []), select.value])
    select.value = ''
  }

  function removeFrame(frameId: string) {
    updateFrameIds((animation.frameIds ?? []).filter((id) => id !== frameId))
  }

  function trackFor(id: string, tracks: AnimationTrack[]) {
    return tracks.find((track) => track.groupId === id)
  }

  function setKeyframe() {
    if (!item || !selectedGroupId) return
    const timeMs = Math.max(0, Math.min(animation.durationMs, Math.round(currentMs / 10) * 10))
    const tracks = animation.tracks.map((track) => ({ ...track, keyframes: [...track.keyframes] }))
    let track = trackFor(selectedGroupId, tracks)
    if (!track) { track = { groupId: selectedGroupId, keyframes: [] }; tracks.push(track) }
    track.keyframes = [...track.keyframes.filter((frame) => frame.timeMs !== timeMs), { timeMs, rotation: Number(draftRotation) || 0, translateY: Number(draftTranslationY) || 0 }].sort((a, b) => a.timeMs - b.timeMs)
    currentMs = timeMs
    selectedKeyTime = timeMs
    save({ ...animation, tracks })
    error = ''
  }

  function applyWalkCycle() {
    if (!item || !walkTracks.length) return
    playing = false
    cancelAnimationFrame(frameRequest)
    if (grouping) {
      const nextGroups = grouping.groups.map((group) => ({ ...group, pivot: walkAttachmentPivot(group, viewBox) }))
      const changed = nextGroups.filter((group, index) => group.pivot.some((value, axis) => value !== grouping.groups[index].pivot[axis]))
      if (changed.length) {
        const doc = new DOMParser().parseFromString(grouping.svg, 'image/svg+xml')
        if (!doc.querySelector('parsererror')) {
          let valid = true
          for (const group of changed) {
            const ids = group.fragmentIds?.length ? group.fragmentIds : [group.id]
            const elements = ids.map((id) => Array.from(doc.querySelectorAll('g[id]')).find((candidate) => candidate.getAttribute('id') === id)).filter((element): element is Element => !!element)
            if (elements.length !== ids.length) { valid = false; break }
            for (const element of elements) {
              element.setAttribute('data-rastavec-pivot-x', String(group.pivot[0]))
              element.setAttribute('data-rastavec-pivot-y', String(group.pivot[1]))
            }
          }
          if (valid) {
            item.grouping = { ...grouping, groups: nextGroups, svg: new XMLSerializer().serializeToString(doc) }
            markOutsideEdit(item)
            void refreshOutputMetrics(item)
          }
        }
      }
    }
    currentMs = 0
    selectedGroupId = walkTracks[0].groupId
    selectedKeyTime = 0
    save({ ...animation, mode: 'parts', frameIds: undefined, durationMs: 1000, easing: 'linear', tracks: walkTracks })
    error = ''
  }

  function removeKeyframe() {
    if (!item || !selectedGroupId || selectedKeyTime === null) return
    const tracks = animation.tracks.map((track) => ({ ...track, keyframes: track.keyframes.filter((frame) => !(track.groupId === selectedGroupId && frame.timeMs === selectedKeyTime)) })).filter((track) => track.keyframes.length)
    save({ ...animation, tracks })
    selectedKeyTime = null
  }

  function updateDuration(event: Event) {
    if (!item) return
    const nextDuration = Math.round(Math.max(0.2, Math.min(10, Number((event.currentTarget as HTMLInputElement).value))) * 1000)
    const oldDuration = animation.durationMs
    if (nextDuration === oldDuration) return
    const tracks = animation.tracks.map((track) => {
      const remapped = track.keyframes.map((frame) => ({ ...frame, timeMs: Math.min(nextDuration, Math.round(frame.timeMs / oldDuration * nextDuration / 10) * 10) }))
      const unique = [...new Map(remapped.map((frame) => [frame.timeMs, frame])).values()].sort((a, b) => a.timeMs - b.timeMs)
      return { ...track, keyframes: unique }
    })
    save({ ...animation, durationMs: nextDuration, tracks })
    currentMs = Math.min(nextDuration, Math.round(currentMs / oldDuration * nextDuration))
  }

  function updateFrameRate(event: Event) {
    if (!item || frameItems.length < 2) return
    const input = Number((event.currentTarget as HTMLInputElement).value)
    if (!Number.isFinite(input)) return
    const min = frameItems.length / 10
    const max = frameItems.length / 0.05
    const fps = Math.max(min, Math.min(max, input))
    const durationMs = frameItems.length * 1000 / fps
    save({ ...animation, mode: 'frames', fps, durationMs })
    currentMs = Math.min(currentMs, durationMs - 1)
  }

  function updateEasing(event: Event) {
    save({ ...animation, easing: (event.currentTarget as HTMLSelectElement).value as AnimationMetadata['easing'] })
  }

  function chooseItem(event: Event) {
    const id = (event.currentTarget as HTMLSelectElement).value
    app.selectedId = id
    sequenceSource = 'all'
    selectedGroupId = ''
    currentMs = 0
    selectedKeyTime = null
  }

  function updatePivot(event: PointerEvent) {
    if (!pivotMode || !selectedGroup || !item || !pivotOverlay || !grouping) return
    const matrix = pivotOverlay.getScreenCTM()
    if (!matrix) return
    const point = pivotOverlay.createSVGPoint()
    point.x = event.clientX
    point.y = event.clientY
    const local = point.matrixTransform(matrix.inverse())
    setPivot([Number(local.x.toFixed(2)), Number(local.y.toFixed(2))])
  }

  function setPivot(pivot: [number, number]) {
    if (!selectedGroup || !item || !grouping) return
    const groups = grouping.groups.map((group) => group.id === selectedGroup.id ? { ...group, pivot } : group)
    const doc = new DOMParser().parseFromString(grouping.svg, 'image/svg+xml')
    if (doc.querySelector('parsererror')) return
    const ids = selectedGroup.fragmentIds?.length ? selectedGroup.fragmentIds : [selectedGroup.id]
    const elements = ids.map((id) => Array.from(doc.querySelectorAll('g[id]')).find((candidate) => candidate.getAttribute('id') === id)).filter((element): element is Element => !!element)
    if (elements.length !== ids.length) return
    for (const element of elements) {
      element.setAttribute('data-rastavec-pivot-x', String(pivot[0]))
      element.setAttribute('data-rastavec-pivot-y', String(pivot[1]))
    }
    item.grouping = { ...grouping, svg: new XMLSerializer().serializeToString(doc), groups }
    markOutsideEdit(item)
    void refreshOutputMetrics(item)
  }

  function setAttachmentPivot() {
    if (!selectedGroup) return
    setPivot(attachmentPivot(selectedGroup.bounds, viewBox))
  }

  function editPivotAxis(axis: 0 | 1, event: Event) {
    if (!selectedGroup) return
    const value = Number((event.currentTarget as HTMLInputElement).value)
    if (!Number.isFinite(value)) return
    const pivot: [number, number] = [...selectedGroup.pivot]
    pivot[axis] = value
    setPivot(pivot)
  }

  function nudgePivot(event: KeyboardEvent) {
    if (!selectedGroup) return
    const directions: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
    const direction = directions[event.key]
    if (!direction) return
    event.preventDefault()
    const step = event.shiftKey ? 10 : 1
    setPivot([selectedGroup.pivot[0] + direction[0] * step, selectedGroup.pivot[1] + direction[1] * step])
  }

  function startPivotDrag(event: PointerEvent) {
    if (!pivotMode || selectedGroup?.locked) return
    draggingPivot = true
    ;(event.currentTarget as SVGSVGElement).setPointerCapture(event.pointerId)
    updatePivot(event)
  }

  function endPivotDrag(event: PointerEvent) {
    draggingPivot = false
    const target = event.currentTarget as SVGSVGElement
    if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId)
  }

  function tick(now: number) {
    if (!playing) return
    currentMs = Math.floor((playbackOffset + now - playbackStart) % animation.durationMs)
    frameRequest = requestAnimationFrame(tick)
  }

  function togglePlayback() {
    if (playing) {
      playing = false
      cancelAnimationFrame(frameRequest)
      return
    }
    if (!hasAnyKeyframes) return
    playing = true
    playbackStart = performance.now()
    playbackOffset = currentMs
    frameRequest = requestAnimationFrame(tick)
  }

  const hasAnyKeyframes = $derived(animation.mode === 'frames'
    ? frameItems.length >= 2
    : animation.durationMs > 0 && animation.tracks.some((track) => groups.some((group) => group.id === track.groupId) && trackHasMotion(track)))

  function previewMarkup(source: string, metadata: GroupingMetadata | undefined, data: AnimationMetadata, time: number, activeId: string) {
    if (!source) return ''
    const doc = new DOMParser().parseFromString(source, 'image/svg+xml')
    if (doc.querySelector('parsererror')) return ''
    const ns = 'http://www.w3.org/2000/svg'
    for (const group of metadata?.groups ?? []) {
      const ids = group.fragmentIds?.length ? group.fragmentIds : [group.id]
      const elements = ids.map((id) => Array.from(doc.querySelectorAll('g[id]')).find((candidate) => candidate.getAttribute('id') === id)).filter((element): element is Element => !!element)
      if (elements.length !== ids.length) continue
      const motion = motionAt(data.tracks.find((track) => track.groupId === group.id)?.keyframes ?? [], time, data.easing)
      if (Math.abs(motion.rotation) > 1e-8 || Math.abs(motion.translateY) > 1e-8) {
        const pivot = group.pivot
        for (const element of elements) {
          const translated = doc.createElementNS(ns, 'g')
          if (Math.abs(motion.translateY) > 1e-8) translated.setAttribute('transform', `translate(0 ${motion.translateY})`)
          const rotated = doc.createElementNS(ns, 'g')
          if (Math.abs(motion.rotation) > 1e-8) rotated.setAttribute('transform', `rotate(${motion.rotation} ${pivot[0]} ${pivot[1]})`)
          while (element.firstChild) rotated.appendChild(element.firstChild)
          translated.appendChild(rotated)
          element.appendChild(translated)
        }
      }
      for (const element of elements) {
        element.setAttribute('data-rastavec-selected', group.id === activeId ? 'true' : 'false')
        if (group.id === activeId) element.setAttribute('style', 'filter: drop-shadow(0 0 3px #3cc274)')
      }
    }
    const style = doc.createElementNS(ns, 'style')
    style.textContent = '[data-rastavec-selected="true"]{filter:drop-shadow(0 0 3px #3cc274)}'
    doc.documentElement.insertBefore(style, doc.documentElement.firstChild)
    return new XMLSerializer().serializeToString(doc)
  }

  const previewSvg = $derived(animation.mode === 'frames'
    ? activeFrame ? outputSvg(activeFrame) : ''
    : previewMarkup(svg, grouping, animation, currentMs, showGuides ? selectedGroupId : ''))
  $effect(() => {
    if (!previewSvg) { previewUrl = ''; return }
    const url = URL.createObjectURL(new Blob([previewSvg], { type: 'image/svg+xml' }))
    previewUrl = url
    return () => URL.revokeObjectURL(url)
  })

  function exportAnimated() {
    if (!item || !grouping) return
    if (!animation.tracks.some((track) => grouping.groups.some((group) => group.id === track.groupId) && trackHasMotion(track))) {
      error = words.needMotion
      return
    }
    try {
      const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
      if (doc.querySelector('parsererror')) throw new Error(words.unsupported)
      const ns = 'http://www.w3.org/2000/svg'
      for (const track of animation.tracks) {
        const metadata = grouping.groups.find((candidate) => candidate.id === track.groupId)
        if (!metadata || track.keyframes.length < 2) continue
        const ids = metadata.fragmentIds?.length ? metadata.fragmentIds : [track.groupId]
        const groups = ids.map((id) => Array.from(doc.querySelectorAll('g[id]')).find((element) => element.getAttribute('id') === id)).filter((element): element is Element => !!element)
        if (groups.length !== ids.length) continue
        let frames = [...track.keyframes].sort((a, b) => a.timeMs - b.timeMs)
        if (frames[0].timeMs > 0) frames = [{ ...frames[0], timeMs: 0 }, ...frames]
        if (frames.at(-1)!.timeMs < animation.durationMs) frames = [...frames, { ...frames.at(-1)!, timeMs: animation.durationMs }]
        const times = frames.map((frame) => frame.timeMs / animation.durationMs)
        const keySplines = frames.slice(1).map(() => '0.42 0 0.58 1').join(';')
        const hasRotation = frames.some((frame) => frame.rotation !== frames[0].rotation)
        const hasTranslation = frames.some((frame) => (frame.translateY ?? 0) !== (frames[0].translateY ?? 0))
        if (!hasRotation && !hasTranslation) continue
        for (const groupElement of groups) {
          const translated = doc.createElementNS(ns, 'g')
          const rotated = doc.createElementNS(ns, 'g')
          while (groupElement.firstChild) rotated.appendChild(groupElement.firstChild)
          if (hasRotation) {
            const motion = doc.createElementNS(ns, 'animateTransform')
            motion.setAttribute('attributeName', 'transform')
            motion.setAttribute('type', 'rotate')
            motion.setAttribute('dur', `${animation.durationMs / 1000}s`)
            motion.setAttribute('repeatCount', 'indefinite')
            motion.setAttribute('calcMode', animation.easing === 'linear' ? 'linear' : 'spline')
            if (animation.easing !== 'linear') motion.setAttribute('keySplines', keySplines)
            motion.setAttribute('keyTimes', times.join(';'))
            motion.setAttribute('values', frames.map((frame) => `${frame.rotation} ${metadata.pivot[0]} ${metadata.pivot[1]}`).join(';'))
            rotated.appendChild(motion)
          }
          translated.appendChild(rotated)
          if (hasTranslation) {
            const motion = doc.createElementNS(ns, 'animateTransform')
            motion.setAttribute('attributeName', 'transform')
            motion.setAttribute('type', 'translate')
            motion.setAttribute('dur', `${animation.durationMs / 1000}s`)
            motion.setAttribute('repeatCount', 'indefinite')
            motion.setAttribute('calcMode', animation.easing === 'linear' ? 'linear' : 'spline')
            if (animation.easing !== 'linear') motion.setAttribute('keySplines', keySplines)
            motion.setAttribute('keyTimes', times.join(';'))
            motion.setAttribute('values', frames.map((frame) => `0 ${frame.translateY ?? 0}`).join(';'))
            translated.appendChild(motion)
          }
          groupElement.appendChild(translated)
        }
      }
      const style = doc.createElementNS(ns, 'style')
      style.textContent = '@media (prefers-reduced-motion: reduce) { animateTransform { display: none !important; } }'
      doc.documentElement.insertBefore(style, doc.documentElement.firstChild)
      const metadata = doc.createElementNS(ns, 'metadata')
      metadata.setAttribute('id', 'rastavec-animation')
      metadata.textContent = JSON.stringify({ version: 2, durationMs: animation.durationMs, loop: true, tracks: animation.tracks })
      doc.documentElement.appendChild(metadata)
      const stem = item.name.replace(/\.[^.]+$/, '')
      download(new Blob([new XMLSerializer().serializeToString(doc)], { type: 'image/svg+xml' }), `${stem}-animated.svg`)
      error = ''
    } catch (e) {
      error = e instanceof Error ? e.message : words.unsupported
    }
  }

  function exportFrameSequence() {
    if (!item || frameItems.length < 2) return
    try {
      const ns = 'http://www.w3.org/2000/svg'
      const sources = frameItems.map((frame) => new DOMParser().parseFromString(outputSvg(frame), 'image/svg+xml'))
      if (sources.some((doc) => doc.querySelector('parsererror') || doc.documentElement.localName.toLowerCase() !== 'svg')) throw new Error(words.unsupported)
      const first = sources[0].documentElement
      const viewBox = first.getAttribute('viewBox')
      const width = first.getAttribute('width')
      const height = first.getAttribute('height')
      if (!viewBox || !width || !height) throw new Error(words.unsupported)

      const doc = document.implementation.createDocument(ns, 'svg', null)
      const root = doc.documentElement
      root.setAttribute('width', width)
      root.setAttribute('height', height)
      root.setAttribute('viewBox', viewBox)
      root.setAttribute('preserveAspectRatio', first.getAttribute('preserveAspectRatio') ?? 'xMidYMid meet')
      const boundaries = Array.from({ length: frameItems.length + 1 }, (_, index) => index / frameItems.length)
      const keyTimes = boundaries.join(';')

      for (const [index, source] of sources.entries()) {
        const sourceRoot = source.documentElement
        const frame = doc.createElementNS(ns, 'g')
        frame.setAttribute('id', `rastavec-frame-${index + 1}`)
        frame.setAttribute('data-rastavec-frame', String(index))
        frame.setAttribute('opacity', index === 0 ? '1' : '0')
        const embedded = doc.createElementNS(ns, 'svg')
        embedded.setAttribute('x', '0')
        embedded.setAttribute('y', '0')
        embedded.setAttribute('width', width)
        embedded.setAttribute('height', height)
        embedded.setAttribute('viewBox', sourceRoot.getAttribute('viewBox') ?? viewBox)
        embedded.setAttribute('preserveAspectRatio', sourceRoot.getAttribute('preserveAspectRatio') ?? 'xMidYMid meet')
        for (const child of Array.from(sourceRoot.childNodes)) {
          if (child.nodeType === Node.ELEMENT_NODE && (child as Element).localName.toLowerCase() === 'metadata') continue
          embedded.appendChild(doc.importNode(child, true))
        }

        // Prefix IDs in each embedded document so gradients, clips, and symbols never collide.
        const elements = [embedded, ...Array.from(embedded.querySelectorAll('*'))]
        const idMap = new Map<string, string>()
        for (const element of elements) {
          const id = element.getAttribute('id')
          if (id) idMap.set(id, `rastavec-frame-${index + 1}-${id}`)
        }
        for (const element of elements) {
          for (const attribute of Array.from(element.attributes)) {
            let value = attribute.value
            for (const [oldId, newId] of idMap) value = value.replaceAll(`#${oldId}`, `#${newId}`)
            if (attribute.name === 'id' && idMap.has(value)) value = idMap.get(value)!
            element.setAttribute(attribute.name, value)
          }
          if (element.localName.toLowerCase() === 'style') {
            for (const [oldId, newId] of idMap) element.textContent = element.textContent?.replaceAll(`#${oldId}`, `#${newId}`) ?? ''
          }
        }
        frame.appendChild(embedded)

        const values = boundaries.map((_, boundary) => (boundary % frameItems.length === index ? '1' : '0'))
        const motion = doc.createElementNS(ns, 'animate')
        motion.setAttribute('attributeName', 'opacity')
        motion.setAttribute('calcMode', 'discrete')
        motion.setAttribute('dur', `${animation.durationMs / 1000}s`)
        motion.setAttribute('repeatCount', 'indefinite')
        motion.setAttribute('keyTimes', keyTimes)
        motion.setAttribute('values', values.join(';'))
        frame.appendChild(motion)
        root.appendChild(frame)
      }

      const reducedMotion = doc.createElementNS(ns, 'style')
      reducedMotion.textContent = '@media (prefers-reduced-motion: reduce) { animate { display: none !important; } }'
      root.insertBefore(reducedMotion, root.firstChild)
      const metadata = doc.createElementNS(ns, 'metadata')
      metadata.setAttribute('id', 'rastavec-animation')
      metadata.textContent = JSON.stringify({ version: 1, mode: 'frames', durationMs: animation.durationMs, fps: Number(frameRate.toFixed(3)), loop: true, frameIds: animation.frameIds })
      root.appendChild(metadata)

      const stem = (frameItems[0] ?? item).name.replace(/\.[^.]+$/, '')
      download(new Blob([new XMLSerializer().serializeToString(doc)], { type: 'image/svg+xml' }), `${stem}-sequence.svg`)
      error = ''
    } catch (e) {
      error = e instanceof Error ? e.message : words.unsupported
    }
  }

  onDestroy(() => { playing = false; cancelAnimationFrame(frameRequest) })
</script>

<div class="animate-view">
  <div class="between heading">
    <div class="stack heading-copy">
      <div class="row"><span class="chip chip-accent">{words.title}</span><h1>{words.title}</h1></div>
      <p class="muted">{words.intro}</p>
    </div>
    <div class="row top-actions">
      {#if animation.mode !== 'frames' && compatibleItems.length > 1}
        {#if gridSequenceRows.length}
          <label class="sequence-source"><span>{words.sequenceSource}</span>
            <select bind:value={sequenceSource}>
              <option value="all">{words.allCompatiblePoses(compatibleItems.length)}</option>
              {#each gridSequenceRows as row (row.key)}<option value={row.key}>{row.label}</option>{/each}
            </select>
          </label>
        {/if}
        <button type="button" class="btn" onclick={startFrameSequence}>{words.startSequence}</button>
      {/if}
      {#if animation.mode !== 'frames' && hasGroups}
        <div class="walk-preset">
          <button type="button" class="btn" title={words.walkRoleHint} onclick={applyWalkCycle} disabled={!walkTracks.length}>{words.walkCycle}</button>
          <span class="muted tiny" title={words.walkRoleHint}>{words.walkCycleGroups(walkTracks.length)}</span>
          <span class="muted tiny walk-roles">{words.walkRolesShort}</span>
        </div>
      {/if}
      {#if items.length > 1 && animation.mode !== 'frames'}
        <label class="sr-only" for="animation-item">{words.chooseImage}</label>
        <select id="animation-item" value={item?.id ?? ''} onchange={chooseItem}>
          {#each items as candidate (candidate.id)}<option value={candidate.id}>{candidate.name}</option>{/each}
        </select>
      {/if}
      <button type="button" class="btn" onclick={() => go('edit', item?.id)} disabled={!item}>{words.back}</button>
    </div>
  </div>

  {#if !item}
    <section class="card empty"><h2>{words.noArtwork}</h2><button type="button" class="btn btn-primary" onclick={() => go('import')}>{words.chooseImage}</button></section>
  {:else if animation.mode === 'frames'}
    <div class="frame-workspace">
      <section class="card editor frame-editor">
        <div class="stage-head">
          <h2>{words.frameSequence}</h2>
          <div class="row stage-actions">
            <span class="mono muted tiny">{activeFrame?.name ?? words.noFrames}</span>
            <button type="button" class="btn small-btn" onclick={usePartAnimation}>{words.backToParts}</button>
          </div>
        </div>
        <div class="stage frame-stage" class:empty-stage={!previewUrl}>
          {#if previewUrl}<img src={previewUrl} alt={`${words.stage} — ${activeFrame?.name ?? ''}`} />{:else}<span class="muted">{words.noFrames}</span>{/if}
        </div>
        <div class="sequence-playback">
          <div class="scrubber">
            <button type="button" class="btn playhead" aria-label={playing ? words.pause : words.play} onclick={togglePlayback} disabled={!hasAnyKeyframes}>{playing ? 'Ⅱ' : '▶'}</button>
            <input aria-label={words.timeline} type="range" min="0" max={animation.durationMs} step="10" value={currentMs} oninput={(event) => { playing = false; cancelAnimationFrame(frameRequest); currentMs = +event.currentTarget.value }} disabled={!hasAnyKeyframes} />
          </div>
          <div class="between sequence-status">
            <span class="mono muted tiny">{frameItems.length ? `${words.frameNumber(frameIndex + 1, frameItems.length)} · ${words.cycleLength(animation.durationMs / 1000)}` : words.noFrames}</span>
            <label class="duration"><span>{words.cadence}</span><input type="number" min={frameItems.length / 10} max={frameItems.length / 0.05} step="0.1" value={frameRate} onchange={updateFrameRate} disabled={frameItems.length < 2} /><span>{words.fpsUnit}</span></label>
          </div>
          <div class="export-row">
            <button type="button" class="btn btn-primary" onclick={exportFrameSequence} disabled={!hasAnyKeyframes}>{words.exportSequence}</button>
            <span class="muted tiny">{words.sequenceExportHint}</span>
          </div>
          {#if error}<span class="error" role="alert">{error}</span>{/if}
        </div>
      </section>

      <section class="card sequence-list-card">
        <div class="between"><h2>{words.frameSequence}</h2><span class="chip chip-muted">{frameItems.length}</span></div>
        {#if frameItems.length < 2}<p class="muted tiny">{words.noFrames}</p>{/if}
        <div class="sequence-list" role="list" aria-label={words.frameSequence}>
          {#each animation.frameIds ?? [] as frameId, index (frameId)}
            {@const frame = items.find((candidate) => candidate.id === frameId)}
            {#if frame}
              <div class="sequence-row" class:active-frame={activeFrame?.id === frameId} role="listitem">
                <span class="frame-order mono">{index + 1}</span>
                <span class="frame-name">{frame.name}</span>
                <button type="button" class="btn small-btn icon-btn" aria-label={`${words.moveFrameUp}: ${frame.name}`} title={words.moveFrameUp} onclick={() => moveFrame(index, -1)} disabled={index === 0}>↑</button>
                <button type="button" class="btn small-btn icon-btn" aria-label={`${words.moveFrameDown}: ${frame.name}`} title={words.moveFrameDown} onclick={() => moveFrame(index, 1)} disabled={index === (animation.frameIds?.length ?? 0) - 1}>↓</button>
                <button type="button" class="btn small-btn icon-btn" aria-label={`${words.removeFrame}: ${frame.name}`} title={words.removeFrame} onclick={() => removeFrame(frameId)}>×</button>
              </div>
            {/if}
          {/each}
        </div>
        {#if availableFrameItems.length}
          <label class="add-frame"><span>{words.addFrame}</span>
            <select value="" onchange={addFrame}>
              <option value="">{words.addFrame}…</option>
              {#each availableFrameItems as candidate (candidate.id)}<option value={candidate.id}>{candidate.name}</option>{/each}
            </select>
          </label>
        {/if}
        <p class="muted tiny sequence-hint">{words.sequenceHint}</p>
      </section>
    </div>
  {:else if !hasGroups}
    <section class="card empty"><h2>{words.noGroups}</h2><p class="muted">{words.introHint}</p><div class="row"><button type="button" class="btn btn-primary" onclick={() => go('edit', item.id)}>{words.prepare}</button>{#if compatibleItems.length > 1}<button type="button" class="btn" onclick={startFrameSequence}>{words.startSequence}</button>{/if}</div></section>
  {:else}
    <div class="workspace">
      <aside class="card group-panel">
        <div class="between"><h2>{words.groups}</h2><span class="chip chip-muted">{groups.length}</span></div>
        <div class="group-list" role="listbox" aria-label={words.groups}>
          {#each groups as group (group.id)}
            <button type="button" role="option" aria-selected={selectedGroupId === group.id} class="group-row" onclick={() => { selectedGroupId = group.id; selectedKeyTime = null }}>
              <span class="color-dot" style:background={group.fill}></span>
              <span class="group-copy"><strong>{group.name || group.role || group.id}</strong>{#if group.role && group.name}<small>{group.role}</small>{/if}</span>
              <span class="mono faint tiny">{animation.tracks.find((track) => track.groupId === group.id)?.keyframes.length ?? 0}</span>
            </button>
          {/each}
        </div>
        {#if selectedGroup}
          <div class="group-meta">
            <span class="muted tiny">{words.pivot}</span>
            <span class="mono tiny">{selectedGroup.pivot[0].toFixed(1)}, {selectedGroup.pivot[1].toFixed(1)}</span>
          </div>
        {/if}
      </aside>

      <section class="card editor">
        <div class="stage-head"><h2>{words.stage}</h2><div class="row stage-actions"><button type="button" class="btn small-btn" aria-pressed={showGuides} onclick={() => (showGuides = !showGuides)}>{showGuides ? words.hideGuides : words.showGuides}</button><span class="mono muted tiny">{item.name}</span></div></div>
        <div class="stage" class:empty-stage={!previewUrl}>
          {#if previewUrl}<img src={previewUrl} alt={`${words.stage} — ${item.name}`} />{:else}<span class="muted">{words.unsupported}</span>{/if}
          {#if selectedGroup && showGuides}<button type="button" class="pivot-hit-area" class:active={pivotMode} aria-label={words.pivotHint} disabled={!pivotMode || !!selectedGroup.locked} onkeydown={nudgePivot} onpointerdown={startPivotDrag} onpointermove={(event) => { if (draggingPivot) updatePivot(event) }} onpointerup={endPivotDrag} onpointercancel={endPivotDrag}>
            <svg bind:this={pivotOverlay} class="pivot-overlay" viewBox={viewBox} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
              <g class="pivot-marker" transform={`translate(${selectedGroup.pivot[0]} ${selectedGroup.pivot[1]})`}>
                <circle r="8" fill="#0a0b0f" stroke="#ffd34d" stroke-width="2" vector-effect="non-scaling-stroke" />
                <path d="M -13 0 H 13 M 0 -13 V 13" fill="none" stroke="#ffd34d" stroke-width="2" vector-effect="non-scaling-stroke" />
              </g>
            </svg>
          </button>{/if}
        </div>
        {#if selectedGroup}
          <div class="pivot-controls"><button type="button" class="btn small-btn" aria-pressed={pivotMode} onclick={() => (pivotMode = !pivotMode)} disabled={!!selectedGroup.locked}>{pivotMode ? '✓ ' : ''}{words.pivotMode}</button><button type="button" class="btn small-btn" title={words.anchorPivotHint} onclick={setAttachmentPivot} disabled={!!selectedGroup.locked}>{words.anchorPivot}</button><span class="muted tiny">{pivotMode ? words.pivotHint : words.anchorPivotHint}</span><label class="pivot-number">X <input type="number" step="any" value={selectedGroup.pivot[0]} oninput={(event) => editPivotAxis(0, event)} disabled={!!selectedGroup.locked} /></label><label class="pivot-number">Y <input type="number" step="any" value={selectedGroup.pivot[1]} oninput={(event) => editPivotAxis(1, event)} disabled={!!selectedGroup.locked} /></label></div>
        {/if}
        <div class="controls">
          <button type="button" class="btn btn-primary" onclick={togglePlayback} disabled={!hasAnyKeyframes}>{playing ? words.pause : words.play}</button>
          <label class="duration"><span>{words.duration}</span><input type="number" min="0.2" max="10" step="0.1" value={animation.durationMs / 1000} onchange={updateDuration} /><span>{words.seconds}</span></label>
          <label class="rotation"><span>{words.rotation} <strong>{draftRotation.toFixed(1)}°</strong></span><input type="range" min="-180" max="180" step="1" value={draftRotation} oninput={(event) => (draftRotation = +event.currentTarget.value)} /></label>
          <label class="rotation"><span>{words.translateY} <strong>{draftTranslationY.toFixed(1)}</strong></span><input type="range" min="-50" max="50" step="0.5" value={draftTranslationY} oninput={(event) => (draftTranslationY = +event.currentTarget.value)} /></label>
          <label class="easing"><span>{words.easing}</span><select value={animation.easing ?? 'ease-in-out'} onchange={updateEasing}><option value="ease-in-out">{words.smooth}</option><option value="linear">{words.linear}</option></select></label>
          <button type="button" class="btn" onclick={setKeyframe} disabled={!selectedGroupId}>{words.addKey}</button>
        </div>
        <div class="keyframe-row">
          <span class="muted tiny">{selectedGroup ? words.keyAt((currentMs / 1000).toFixed(2)) : words.chooseGroup}</span>
          <button type="button" class="btn small-btn" onclick={removeKeyframe} disabled={selectedKeyTime === null}>{words.deleteKey}</button>
        </div>
      </section>

      <section class="card timeline-panel">
        <div class="between timeline-heading"><div><h2>{words.timeline}</h2><span class="muted tiny">{words.loop}</span></div><span class="mono muted tiny">{(currentMs / 1000).toFixed(2)} / {(animation.durationMs / 1000).toFixed(2)} s</span></div>
        <div class="scrubber">
          <button type="button" class="btn playhead" aria-label={playing ? words.pause : words.play} onclick={togglePlayback} disabled={!hasAnyKeyframes}>{playing ? 'Ⅱ' : '▶'}</button>
          <input aria-label={words.timeline} type="range" min="0" max={animation.durationMs} step="10" value={currentMs} oninput={(event) => { playing = false; cancelAnimationFrame(frameRequest); currentMs = +event.currentTarget.value }} />
        </div>
        {#if keyframes.length}
          <div class="track-timeline" aria-label={words.tracks}>
            <div class="track-title">{selectedGroup?.name || selectedGroup?.role || words.tracks}</div>
            <div class="track-line">
              {#each keyframes as frame (frame.timeMs)}
                <button type="button" class="key-dot" class:active={selectedKeyTime === frame.timeMs} style:left={`${frame.timeMs / animation.durationMs * 100}%`} aria-label={`${words.frame}: ${(frame.timeMs / 1000).toFixed(2)} s, ${frame.rotation}°, Y ${frame.translateY ?? 0}`} title={`${(frame.timeMs / 1000).toFixed(2)} s · ${frame.rotation}° · Y ${frame.translateY ?? 0}`} onclick={() => { currentMs = frame.timeMs; selectedKeyTime = frame.timeMs; draftRotation = frame.rotation; draftTranslationY = frame.translateY ?? 0 }}></button>
              {/each}
            </div>
          </div>
        {:else}
          <p class="muted tiny no-keys">{words.noTrack}</p>
        {/if}
        {#if !hasAnyKeyframes && animation.tracks.some((track) => track.keyframes.length > 0)}<p class="muted tiny no-keys">{words.needMotion}</p>{/if}
        <div class="export-row"><button type="button" class="btn btn-primary" onclick={exportAnimated} disabled={!hasAnyKeyframes}>{words.export}</button><span class="muted tiny">{words.exportHint}</span></div>
        {#if error}<span class="error" role="alert">{error}</span>{/if}
      </section>
    </div>
  {/if}
</div>

<style>
  .animate-view { display: flex; flex-direction: column; gap: 18px; min-width: 0; }
  .heading { align-items: center; gap: 20px; }
  .heading-copy { gap: 6px; }
  .heading h1 { font-size: 26px; }
  .heading p { font-size: 15px; }
  .tiny { font-size: 12px; }
  .top-actions select { min-height: 42px; max-width: 280px; padding: 0 12px; color: var(--text); background: var(--surface-2); border: 1px solid var(--line-2); border-radius: 10px; }
  .walk-preset { display: flex; flex-direction: column; gap: 2px; align-items: flex-start; max-width: 300px; }
  .walk-roles { max-width: 300px; line-height: 1.3; }
  .sequence-source { display: flex; flex-direction: column; gap: 3px; min-width: 0; color: var(--muted); font-size: 11px; }
  .sequence-source select { width: 250px; }
  .workspace { display: grid; grid-template-columns: minmax(260px, 320px) minmax(380px, 1fr); grid-template-rows: minmax(390px, calc(100vh - 510px)) auto; gap: 14px; min-width: 0; }
  .frame-workspace { display: grid; grid-template-columns: minmax(380px, 1fr) minmax(270px, 360px); grid-template-rows: minmax(390px, calc(100vh - 300px)); gap: 14px; min-width: 0; }
  .frame-editor { min-height: 0; }
  .frame-stage { min-height: 240px; flex: 1; }
  .sequence-playback { display: flex; flex-direction: column; gap: 10px; }
  .sequence-status { align-items: center; gap: 12px; }
  .sequence-status .duration { display: grid; grid-template-columns: auto auto auto; align-items: center; gap: 7px; }
  .sequence-list-card { min-width: 0; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
  .sequence-list-card h2 { font-size: 15px; }
  .sequence-list { display: flex; flex-direction: column; gap: 6px; overflow: auto; min-height: 80px; max-height: 100%; }
  .sequence-row { min-width: 0; display: flex; align-items: center; gap: 6px; padding: 6px; border: 1px solid var(--line-2); border-radius: 9px; background: var(--surface-2); }
  .sequence-row.active-frame { border-color: var(--accent); background: var(--accent-bg); }
  .frame-order { width: 22px; flex: 0 0 22px; text-align: center; font-size: 11px; color: var(--muted); }
  .frame-name { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
  .icon-btn { width: 30px; min-height: 30px; padding: 0; }
  .add-frame { display: flex; flex-direction: column; gap: 6px; color: var(--muted); font-size: 12px; }
  .add-frame select { min-height: 38px; padding: 0 9px; color: var(--text); background: var(--surface-2); border: 1px solid var(--line-2); border-radius: 8px; }
  .sequence-hint { margin: 0; }
  .group-panel { grid-row: 1 / span 2; min-width: 0; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
  .group-panel h2, .editor h2, .timeline-panel h2 { font-size: 15px; }
  .group-list { display: flex; flex-direction: column; gap: 4px; overflow: auto; min-height: 100px; max-height: 100%; }
  .group-row { width: 100%; min-height: 46px; display: flex; align-items: center; gap: 10px; padding: 7px 8px; border: 1px solid transparent; border-radius: 9px; text-align: left; background: transparent; color: var(--text); }
  .group-row:hover { background: var(--surface-2); }
  .group-row[aria-selected='true'] { background: var(--accent-bg); border-color: var(--accent-line); }
  .color-dot { width: 12px; height: 12px; flex: 0 0 12px; border: 1px solid var(--line-3); border-radius: 4px; }
  .group-copy { min-width: 0; display: flex; flex-direction: column; gap: 2px; flex: 1; }
  .group-copy strong { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .group-copy small { font-size: 11px; color: var(--muted); }
  .group-meta { display: flex; justify-content: space-between; border-top: 1px solid var(--line-2); padding-top: 10px; }
  .editor { min-width: 0; display: flex; flex-direction: column; gap: 8px; padding: 12px; }
  .stage-head { display: flex; justify-content: space-between; gap: 8px; align-items: center; }
  .stage-actions { gap: 8px; }
  .stage { flex: 1; min-height: 130px; display: grid; place-items: center; overflow: hidden; border: 1px solid var(--line-2); border-radius: 12px; background: var(--checker); }
  .stage { position: relative; }
  .stage img { position: absolute; inset: 0; display: block; width: 100%; height: 100%; min-height: 130px; object-fit: contain; }
  .pivot-hit-area { position: absolute; inset: 0; width: 100%; height: 100%; display: block; padding: 0; border: 0; border-radius: 12px; background: transparent; pointer-events: none; }
  .pivot-hit-area.active { pointer-events: auto; cursor: crosshair; touch-action: none; }
  .pivot-overlay { display: block; width: 100%; height: 100%; overflow: visible; pointer-events: none; }
  .pivot-controls { display: flex; align-items: center; flex-wrap: wrap; gap: 9px; }
  .pivot-number { display: inline-flex; align-items: center; gap: 5px; color: var(--muted); font-size: 11px; }
  .pivot-number input { width: 74px; min-height: 34px; padding: 0 7px; color: var(--text); background: var(--surface-2); border: 1px solid var(--line-2); border-radius: 7px; font-family: 'Geist Mono', monospace; }
  .controls { display: grid; grid-template-columns: auto minmax(130px, auto) minmax(110px, 1fr) minmax(110px, 1fr) minmax(140px, auto) auto; gap: 10px; align-items: end; }
  .duration, .rotation { display: flex; flex-direction: column; gap: 7px; color: var(--muted); font-size: 12px; }
  .duration { display: grid; grid-template-columns: 1fr auto auto; align-items: center; }
  .duration input { width: 70px; min-height: 38px; padding: 0 8px; color: var(--text); background: var(--surface-2); border: 1px solid var(--line-2); border-radius: 8px; }
  .rotation span { display: flex; justify-content: space-between; }
  .rotation strong { color: var(--accent-text); font-family: 'Geist Mono', monospace; }
  .easing { display: flex; flex-direction: column; gap: 7px; color: var(--muted); font-size: 12px; }
  .easing select { min-height: 38px; padding: 0 8px; color: var(--text); background: var(--surface-2); border: 1px solid var(--line-2); border-radius: 8px; }
  .keyframe-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .small-btn { min-height: 34px; padding: 0 10px; font-size: 12px; }
  .timeline-panel { grid-column: 2; min-width: 0; display: flex; flex-direction: column; gap: 8px; padding: 12px; }
  .timeline-heading > div { display: flex; align-items: baseline; gap: 10px; }
  .scrubber { display: grid; grid-template-columns: 36px 1fr; align-items: center; gap: 10px; }
  .playhead { width: 34px; min-height: 32px; padding: 0; }
  .track-timeline { display: grid; grid-template-columns: minmax(100px, 180px) minmax(0, 1fr); gap: 12px; align-items: center; min-height: 30px; }
  .track-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
  .track-line { position: relative; height: 12px; border: 1px solid var(--line-3); border-radius: 999px; background: var(--surface-2); }
  .key-dot { position: absolute; top: 50%; width: 13px; height: 13px; transform: translate(-50%, -50%) rotate(45deg); border: 2px solid var(--accent-text); border-radius: 3px; background: var(--surface); padding: 0; }
  .key-dot.active { background: var(--accent); border-color: #b4f0cb; }
  .no-keys { margin: 0; padding: 4px 2px; }
  .export-row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding-top: 6px; border-top: 1px solid var(--line-2); }
  .error { color: var(--warn-text); font-size: 12px; }
  .empty { display: flex; flex-direction: column; align-items: flex-start; gap: 14px; max-width: 680px; }
  @media (max-width: 1100px) { .controls { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
  @media (max-width: 900px) { .workspace { grid-template-columns: minmax(190px, 230px) minmax(0, 1fr); grid-template-rows: minmax(350px, auto) auto; } .frame-workspace { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(350px, auto) auto; } .controls { grid-template-columns: 1fr 1fr; } .timeline-panel { grid-column: 2; } }
  @media (max-width: 640px) { .heading { align-items: flex-start; flex-direction: column; } .top-actions { width: 100%; flex-wrap: wrap; } .workspace { grid-template-columns: 1fr; grid-template-rows: auto auto auto; } .group-panel { grid-row: auto; max-height: 280px; } .timeline-panel { grid-column: 1; } .frame-workspace { grid-template-rows: auto auto; } .frame-stage { min-height: 280px; } .controls { grid-template-columns: 1fr 1fr; } .stage { min-height: 280px; } .sequence-row { gap: 4px; } }
</style>
