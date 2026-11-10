<script lang="ts">
  import { onDestroy } from 'svelte'
  import { svgFingerprint, type NearbyGroup, type NearbyResult, type NearbyStrategy, type NearbyZone } from '../engine/group-nearby'
  import type { GroupingMetadata } from '../engine/types'
  import { download } from '../export'
  import { i18n } from '../i18n.svelte'
  import { decodeFile } from '../engine/browser-backend'
  import { binaryMaskFromRgba, selectGroupsByMask, svgViewBox, type BinarySegmentationMask } from '../engine/segmentation-mask'
  import { createMobileSamHypotheses, MOBILE_SAM_ARTIFACTS, type MaskCandidate, type MobileSamRunDiagnostics } from '../engine/mobile-sam-inference'
  import { compareProviderHypothesisSets, createMaskHypothesis, type ObjectHypothesis } from '../engine/object-hypotheses'
  import type { CircleOverlapDiagnostics, CircleOverlapProposalResult } from '../engine/circle-overlap-hypotheses'
  import type { ConnectedComponentDiagnostics, ConnectedComponentProposalResult } from '../engine/connected-component-hypotheses'
  import type { PlanarColorDiagnostics, PlanarColorProposalResult } from '../engine/planar-color-hypotheses'

  type LocalMaskProposal = ObjectHypothesis & { previewUrl: string }
  type MobileSamWorkerMessage =
    | { type: 'progress'; requestId: number; stage: 'models' | 'encoder' | 'decoder'; complete: number; total: number }
    | { type: 'done'; requestId: number; proposals: Array<{ prompt: MaskCandidate['prompt']; score: number; width: number; height: number; data: ArrayBuffer }>; diagnostics: MobileSamRunDiagnostics }
    | { type: 'error'; requestId: number; code: string }
  type CircleWorkerMessage =
    | { type: 'done'; requestId: number; result: CircleOverlapProposalResult }
    | { type: 'error'; requestId: number }
  type ConnectedComponentWorkerMessage =
    | { type: 'done'; requestId: number; result: ConnectedComponentProposalResult }
    | { type: 'error'; requestId: number }
  type PlanarColorWorkerMessage =
    | { type: 'done'; requestId: number; result: PlanarColorProposalResult }
    | { type: 'error'; requestId: number }

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

  let { svg, name, grouping, sourceImage, onGroupingChange }: { svg: string; name: string; grouping?: GroupingMetadata; sourceImage?: { url: string; width: number; height: number }; onGroupingChange: (grouping: GroupingMetadata) => void } = $props()
  const recommendedRegionCount = $derived(Math.max(6, Math.min(32, Math.round(Math.sqrt((svg.match(/<path\b/g) ?? []).length) * 1.35))))
  const words = $derived(i18n.locale === 'fr' ? {
    title: 'Regrouper les formes proches', description: 'Propose des groupes géométriques de chemins voisins. Ce ne sont pas des objets reconnus : vérifiez chaque groupe avant de l’utiliser.',
    distance: 'Distance maximale (unités du SVG)', colorMode: 'Règle de couleur', proximity: 'Toutes les couleurs', sameColor: 'Même couleur uniquement', run: 'Proposer des groupes', running: 'Analyse…', empty: 'Aucun groupe proposé avec ces réglages.',
    count: (n: number) => `${n} groupe${n > 1 ? 's' : ''} proposé${n > 1 ? 's' : ''}`,
    details: (n: number, s: number) => `${n} chemins examinés · ${s} ignorés par précaution`,
    limit: (kind: string) => kind === 'path-count' ? 'Analyse arrêtée : plus de 10 000 chemins.' : 'Analyse arrêtée : géométrie trop complexe pour ces limites de sécurité.',
    group: 'Groupe sélectionné', groupLevel: 'Niveau de regroupement', allLevels: 'Tous les niveaux', nearbyLevel: 'Groupes proches', clusterLevel: 'Ensembles larges', search: 'Rechercher dans les groupes', list: 'Groupes proposés', noResults: 'Aucun groupe ne correspond à cette recherche.', name: 'Nom du groupe', nameHint: 'Nom descriptif automatique : couleur dominante et position. Modifiable avant export.', previous: 'Groupe précédent', next: 'Groupe suivant',
    preview: 'Aperçu du groupe isolé', save: 'Télécharger le SVG groupé', stale: 'Les réglages ou l’image ont changé. Relancez la proposition.', role: 'Rôle (facultatif)', pivotX: 'Pivot X', pivotY: 'Pivot Y', protect: 'Protéger les annotations', unlock: 'Déprotéger les annotations',
    previewing: 'Mise à jour de l’aperçu…', hierarchy: 'Les flèches indiquent les groupes enfants d’un ensemble large.', merge: 'Fusionner avec le suivant', split: 'Dissoudre cet ensemble', splitPaths: 'Scinder en formes', includeSingles: 'Inclure les formes seules', includeSinglesHint: 'Rend chaque chemin exploitable séparément, y compris les grandes formes exclues du regroupement automatique.', singletonLimit: 'Trop de formes seules pour les afficher ensemble. Réduisez le nombre de chemins ou désactivez cette option.',
    strategy: 'Méthode', proximityStrategy: 'Voisinage et ordre SVG', spatialStrategy: 'Zones spatiales', regionCount: 'Nombre de zones', spatialHint: 'Répartit les formes compactes en zones même si elles sont éloignées dans l’ordre SVG. Les grandes formes restent séparées; les zones ne sont pas des objets reconnus, vérifiez-les avant animation.',
    addToAssembly: 'Ajouter à l’assemblage', removeFromAssembly: 'Retirer de l’assemblage', createAssembly: (n: number) => `Assembler ${n} groupes`, clearAssembly: 'Vider la sélection', assemblyHint: 'Les chemins restent dans leur ordre de dessin ; ils partageront le même pivot et la même piste d’animation.',
    maskTitle: 'Préselectionner avec un masque local', maskDescription: 'Importez un masque PNG créé localement par un outil de segmentation. Les pixels blancs ou opaques sont considérés comme la région sélectionnée. RastaVec compare les centres des chemins aux pixels du masque ; inspectez le résultat avant assemblage. Le masque ne fournit aucun nom d’objet ni de partie du corps.', maskImport: 'Importer un masque PNG', maskApply: 'Sélectionner les groupes dans le masque', maskPreview: 'Aperçu : la zone magenta est sélectionnée', maskLoaded: (w: number, h: number) => `Masque chargé · ${w} × ${h}`, maskSelected: (g: number, p: number) => `${g} groupes présélectionnés · ${p} centres de chemins dans le masque`, maskNoGroups: 'Aucun groupe existant ne correspond assez au masque. Vérifiez le masque ou les groupes géométriques.', maskDimensions: 'Le masque et l’image source doivent avoir le même ratio largeur/hauteur.', maskError: 'Impossible de lire ce masque PNG', maskLocalOnly: 'Le fichier est lu localement et n’est pas envoyé.',
    samTitle: 'Propositions MobileSAM locales (facultatif)', samDescription: 'Choisissez vos deux fichiers ONNX MobileSAM. RastaVec exécute localement l’encodeur puis filtre les points positifs de la grille sur les régions de premier plan détectées; si cette analyse s’abstient, il garde toute la grille. Les régions proposées ne portent pas d’étiquette sémantique et ne complètent pas les parties cachées. Aucun modèle n’est téléchargé et aucune image ne quitte l’appareil.', samEncoder: 'Choisir l’encodeur ONNX', samDecoder: 'Choisir le décodeur ONNX', samNoFile: 'Aucun fichier choisi', samGrid: 'Grille de points', samGenerate: 'Générer des masques localement', samWorking: (stage: string, done: number, total: number) => `${stage} · ${done}/${total}`, samReady: (n: number, ms: number) => `${n} masques proposés · ${ms} ms`, samNoProposals: 'Aucun masque distinct proposé. Essayez une grille plus dense ou importez un masque PNG.', samModelError: 'Modèles incompatibles ou non pris en charge. Utilisez la paire MobileSAM listée ci-dessous.', samLocalError: 'Impossible de générer des masques sur cet appareil.', samHashError: 'Les sommes SHA-256 ne correspondent pas à la paire MobileSAM prise en charge.', samChooseModels: 'Choisissez les deux modèles ONNX et une image source.', samProposal: (n: number, score: number) => `Région ${n} · score ${score.toFixed(2)}`, samSource: 'Modèles MobileSAM (MIT) et empreintes attendues', samApplyProposal: 'Utiliser le masque aperçu',
    limitation: 'Les groupes larges contiennent les petits groupes proches ; les noms auto décrivent seulement la couleur dominante et la position. L’ordre de dessin est conservé. Les noms, rôles et pivots sont inclus dans le SVG et le ZIP.',
    error: 'Impossible de proposer les groupes',
  } : {
    title: 'Group nearby shapes', description: 'Suggests geometric groups of nearby paths. These are not recognized objects: review each group before using it.',
    distance: 'Maximum distance (SVG units)', colorMode: 'Color rule', proximity: 'Any colour', sameColor: 'Same colour only', run: 'Suggest groups', running: 'Analyzing…', empty: 'No groups found with these settings.',
    count: (n: number) => `${n} suggested group${n === 1 ? '' : 's'}`,
    details: (n: number, s: number) => `${n} paths examined · ${s} skipped conservatively`,
    limit: (kind: string) => kind === 'path-count' ? 'Analysis stopped: more than 10,000 paths.' : 'Analysis stopped: geometry exceeds the safety limits.',
    group: 'Selected group', groupLevel: 'Grouping level', allLevels: 'All levels', nearbyLevel: 'Nearby groups', clusterLevel: 'Larger clusters', search: 'Search groups', list: 'Suggested groups', noResults: 'No groups match this search.', name: 'Group name', nameHint: 'Automatic descriptive name from dominant colour and position. Edit before export.', previous: 'Previous group', next: 'Next group',
    preview: 'Isolated group preview', save: 'Download grouped SVG', stale: 'The settings or image changed. Run the suggestion again.', role: 'Role (optional)', pivotX: 'Pivot X', pivotY: 'Pivot Y', protect: 'Protect annotations', unlock: 'Unprotect annotations',
    previewing: 'Updating preview…', hierarchy: 'Arrows mark child groups inside a larger cluster.', merge: 'Merge with next group', split: 'Dissolve this cluster', splitPaths: 'Split into individual shapes', includeSingles: 'Include standalone shapes', includeSinglesHint: 'Make each path individually available, including large shapes excluded from automatic grouping.', singletonLimit: 'There are too many standalone shapes to show together. Reduce the path count or turn this option off.',
    strategy: 'Method', proximityStrategy: 'Proximity and SVG order', spatialStrategy: 'Spatial regions', regionCount: 'Number of regions', spatialHint: 'Partitions compact shapes into regions even when their SVG order is far apart. Large shapes stay separate; regions are not recognized objects, so review them before animation.',
    addToAssembly: 'Add to assembly', removeFromAssembly: 'Remove from assembly', createAssembly: (n: number) => `Assemble ${n} groups`, clearAssembly: 'Clear selection', assemblyHint: 'Paths stay in paint order and share one pivot and animation track.',
    maskTitle: 'Preselect groups with a local mask', maskDescription: 'Import a PNG mask created locally by a segmentation tool. White or opaque pixels count as the selected region. RastaVec compares path centres with mask pixels; review the result before assembling. The mask does not provide object or body-part names.', maskImport: 'Import PNG mask', maskApply: 'Select groups inside mask', maskPreview: 'Preview: magenta area is selected', maskLoaded: (w: number, h: number) => `Mask loaded · ${w} × ${h}`, maskSelected: (g: number, p: number) => `${g} groups preselected · ${p} path centres inside mask`, maskNoGroups: 'No existing group matches the mask closely enough. Review the mask or geometric groups.', maskDimensions: 'The mask and source image must have the same width-to-height ratio.', maskError: 'Could not read this PNG mask', maskLocalOnly: 'The file is read locally and is not uploaded.',
    samTitle: 'Local MobileSAM proposals (optional)', samDescription: 'Choose both MobileSAM ONNX files. RastaVec runs the encoder locally, then filters positive grid points to detected foreground regions; if that analysis abstains, it keeps the full grid. Proposed regions have no semantic labels and do not complete hidden parts. Models are not downloaded and the image never leaves this device.', samEncoder: 'Choose ONNX encoder', samDecoder: 'Choose ONNX decoder', samNoFile: 'No file selected', samGrid: 'Point grid', samGenerate: 'Generate masks locally', samWorking: (stage: string, done: number, total: number) => `${stage} · ${done}/${total}`, samReady: (n: number, ms: number) => `${n} masks proposed · ${ms} ms`, samNoProposals: 'No distinct masks were proposed. Try a denser grid or import a PNG mask.', samModelError: 'Models are incompatible or unsupported. Use the MobileSAM pair listed below.', samLocalError: 'Could not generate masks on this device.', samHashError: 'SHA-256 hashes do not match the supported MobileSAM pair.', samChooseModels: 'Choose both ONNX models and a source image.', samProposal: (n: number, score: number) => `Region ${n} · score ${score.toFixed(2)}`, samSource: 'MobileSAM models (MIT) and expected hashes', samApplyProposal: 'Use previewed mask',
    limitation: 'Larger groups contain nearby smaller groups; automatic names describe only dominant colour and position. Drawing order is preserved. Names, roles and pivots are included in the SVG and ZIP.',
    error: 'Could not suggest groups',
  })
  const circleWords = $derived(i18n.locale === 'fr' ? {
    title: 'Proposer trois cercles superposés (expérimental)',
    description: 'Essai local pour trois cercles de couleur unie avec arcs visibles sur un fond opaque uni. Les masques complètent les cercles cachés; couleur, alpha et ordre source-over restent à vérifier. Utiliser un masque présélectionne seulement les groupes de chemins existants par leurs centres.',
    run: 'Analyser les arcs visibles', running: 'Ajustement des cercles…',
    noFit: 'Aucune proposition : les couleurs, le fond ou les arcs ne correspondent pas aux préconditions de cet essai.',
    processingError: 'L’analyse des arcs a échoué sur cet appareil. Réessayez ou choisissez une autre méthode.',
    ready: (count: number) => `${count} hypothèses de cercle proposées`,
    candidate: (index: number, errorPercent: number) => `Cercle ${index} · erreur radiale relative ${errorPercent.toFixed(2)} %`,
    order: (order: string, margin: number) => `Ordre candidat dessous → dessus : ${order} · écart au second ajustement ${margin.toFixed(2)}`,
    orderAmbiguous: (margin: number) => `Ordre non identifiable : l’écart au second ajustement est de ${margin.toFixed(2)}.`,
    warning: 'L’ajustement de peinture suppose un compositing source-over; il ne distingue pas Multiply ni l’opacité de groupe.',
  } : {
    title: 'Propose three overlapping circles (experimental)',
    description: 'Local probe for three flat-color circles with exposed arcs against a flat opaque backdrop. Masks complete the hidden circles; color, alpha and source-over order are hypotheses to review. Using a mask only preselects existing path groups by their centres.',
    run: 'Fit visible arcs', running: 'Fitting circles…',
    noFit: 'No proposal: this image does not meet this experiment’s color, backdrop or arc requirements.',
    processingError: 'Circle analysis failed on this device. Try again or choose another method.',
    ready: (count: number) => `${count} circle hypotheses proposed`,
    candidate: (index: number, errorPercent: number) => `Circle ${index} · relative radial error ${errorPercent.toFixed(2)}%`,
    order: (order: string, margin: number) => `Candidate order bottom → top: ${order} · gap to second fit ${margin.toFixed(2)}`,
    orderAmbiguous: (margin: number) => `Order is not identifiable: the gap to the second fit is ${margin.toFixed(2)}.`,
    warning: 'Paint fitting assumes source-over compositing; it does not distinguish Multiply or group opacity.',
  })
  const planarWords = $derived(i18n.locale === 'fr' ? {
    title: 'Proposer des masques par graphe de couleurs (expérimental)',
    description: 'Route locale pour 2 à 4 formes superposées à aplats, sur fond opaque uni. Elle infère les appartenances depuis les adjacences de couleurs; elle ne garantit ni la famille de forme ni la géométrie entièrement cachée.',
    run: 'Analyser les adjacences',
    noFit: 'Aucune proposition : cette image ne fournit pas un graphe de couleurs compatible avec cet essai.',
    processingError: 'L’analyse du graphe de couleurs a échoué sur cet appareil. Réessayez ou choisissez une autre méthode.',
    ready: (count: number) => `${count} masques d’objet proposés · à vérifier`,
    candidate: (index: number, model: string) => `Objet ${index} · peinture ${model}`,
  } : {
    title: 'Propose masks from a color graph (experimental)',
    description: 'Local route for 2–4 overlapping flat-color shapes on a flat opaque backdrop. It infers membership from color adjacency; it does not guarantee a shape family or fully hidden geometry.',
    run: 'Analyze color adjacency',
    noFit: 'No proposal: this image did not produce a compatible color-state graph for this experiment.',
    processingError: 'Color-graph analysis failed on this device. Try again or choose another method.',
    ready: (count: number) => `${count} object masks proposed · review required`,
    candidate: (index: number, model: string) => `Object ${index} · ${model} paint`,
  })
  const componentWords = $derived(i18n.locale === 'fr' ? {
    title: 'Proposer les régions visibles (composantes connexes, expérimental)',
    description: 'Sépare les régions visibles depuis l’alpha du fond ou le contraste avec la bordure. Un dégradé reste dans une même région connectée. Les formes superposées ou qui se touchent peuvent fusionner; aucun contour caché n’est complété.',
    run: 'Trouver les régions visibles', running: 'Recherche des régions…',
    noFit: 'Aucune région visible ne dépasse les seuils de contraste et de taille.',
    processingError: 'L’analyse des régions visibles a échoué sur cet appareil. Réessayez ou choisissez une autre méthode.',
    ready: (count: number) => `${count} région${count > 1 ? 's' : ''} visible${count > 1 ? 's' : ''} proposée${count > 1 ? 's' : ''} · à vérifier`,
    candidate: (index: number, area: number) => `Région ${index} · ${area.toLocaleString()} px d’analyse`,
  } : {
    title: 'Propose visible regions (connected components, experimental)',
    description: 'Separates visible regions using border alpha or contrast. A gradient stays within one connected region. Overlapping or touching shapes can merge; hidden contours are not completed.',
    run: 'Find visible regions', running: 'Finding regions…',
    noFit: 'No visible region passed the contrast and size thresholds.',
    processingError: 'Visible-region analysis failed on this device. Try again or choose another method.',
    ready: (count: number) => `${count} visible region${count === 1 ? '' : 's'} proposed · review required`,
    candidate: (index: number, area: number) => `Region ${index} · ${area.toLocaleString()} analysis px`,
  })
  const maxDistance = $derived.by(() => {
    const match = svg.match(/\bviewBox="\s*[-+\d.eE]+[\s,]+[-+\d.eE]+[\s,]+([-+\d.eE]+)[\s,]+([-+\d.eE]+)/)
    return match ? Math.min(Number(match[1]), Number(match[2])) * 0.1 : 0
  })
  let distance = $state(0)
  let colorMode = $state<'proximity' | 'same-color'>('proximity')
  let includeSingletons = $state(false)
  let strategy = $state<NearbyStrategy>('proximity')
  let regionCount = $state(12)
  let regionSeed = ''
  $effect(() => { distance = Math.min(maxDistance, Math.max(0.5, Math.min(8, maxDistance * 0.05))) })
  let busy = $state(false)
  let output = $state.raw<NearbyResult | null>(null)
  let source = $state('')
  let usedDistance = $state(0)
  let usedColorMode = $state<'proximity' | 'same-color'>('proximity')
  let usedSingletonMode = $state(false)
  let usedStrategy = $state<NearbyStrategy>('proximity')
  let usedRegionCount = $state(12)
  let selected = $state('')
  let assemblySelection = $state<Set<string>>(new Set())
  let segmentationHypothesis = $state<ObjectHypothesis | null>(null)
  let maskPreviewUrl = $state('')
  let maskMessage = $state('')
  let maskBusy = $state(false)
  let maskSourceUrl = ''
  let mobileSamWorker: Worker | null = null
  let mobileSamRequestId = 0
  let samEncoderFile = $state<File | null>(null)
  let samDecoderFile = $state<File | null>(null)
  let samGridSize = $state(2)
  let samProgress = $state('')
  let samProposals = $state.raw<LocalMaskProposal[]>([])
  let samPreviewIndex = $state(-1)
  let circleWorker: Worker | null = null
  let circleRequestId = 0
  let circleProposals = $state.raw<LocalMaskProposal[]>([])
  let circlePreviewIndex = $state(-1)
  let circleDiagnostics = $state.raw<CircleOverlapDiagnostics | null>(null)
  let planarWorker: Worker | null = null
  let planarRequestId = 0
  let planarProposals = $state.raw<LocalMaskProposal[]>([])
  let planarPreviewIndex = $state(-1)
  let planarDiagnostics = $state.raw<PlanarColorDiagnostics | null>(null)
  let componentWorker: Worker | null = null
  let componentRequestId = 0
  let componentProposals = $state.raw<LocalMaskProposal[]>([])
  let componentPreviewIndex = $state(-1)
  let componentDiagnostics = $state.raw<ConnectedComponentDiagnostics | null>(null)
  const objectProviderComparison = $derived(compareProviderHypothesisSets([
    { provider: 'circle-visible-arc-fit', hypotheses: circleProposals },
    { provider: 'planar-color-adjacency', hypotheses: planarProposals },
  ]))
  const objectProviderComparisonMessage = $derived.by(() => {
    if (objectProviderComparison.status === 'insufficient-data') return ''
    const counts = objectProviderComparison.providers.map(({ provider, count }) => {
      const label = i18n.locale === 'fr'
        ? provider === 'circle-visible-arc-fit' ? 'Ajustement des cercles' : 'Graphe des aplats'
        : provider === 'circle-visible-arc-fit' ? 'Circle fit' : 'Flat-color graph'
      return `${label}: ${count}`
    }).join(' · ')
    const maskSummary = objectProviderComparison.maskComparisons.map((comparison) => {
      const mean = comparison.meanMatchedIoU === null ? 'n/a' : comparison.meanMatchedIoU.toFixed(2)
      const unmatched = [...comparison.unmatchedLeft, ...comparison.unmatchedRight]
      const ids = comparison.matches.map(({ leftHypothesisId, rightHypothesisId, iou }) => `${leftHypothesisId} ↔ ${rightHypothesisId} (${iou.toFixed(2)})`).join(', ')
      return i18n.locale === 'fr'
        ? `IoU moyen des paires retenues ${mean}; ${comparison.matchesAtThreshold}/${comparison.matches.length} paires assignées ≥ ${comparison.matchingThreshold.toFixed(2)}${ids ? ` · ${ids}` : ''}${unmatched.length ? ` · sans paire : ${unmatched.join(', ')}` : ''}${comparison.maskMeaningsComparable ? '' : ' · sens des masques différent ou inconnu; les catégories incompatibles sont exclues de l’IoU'}`
        : `mean accepted-pair IoU ${mean}; ${comparison.matchesAtThreshold}/${comparison.matches.length} assigned pairs ≥ ${comparison.matchingThreshold.toFixed(2)}${ids ? ` · ${ids}` : ''}${unmatched.length ? ` · unmatched: ${unmatched.join(', ')}` : ''}${comparison.maskMeaningsComparable ? '' : ' · mask meanings differ or are unknown; incompatible categories are excluded from IoU'}`
    }).join(' | ')
    const conclusion = objectProviderComparison.status === 'counts-disagree'
      ? i18n.locale === 'fr' ? `Les essais proposent des nombres de formes différents (${counts}).` : `The routes propose different object counts (${counts}).`
      : i18n.locale === 'fr' ? `Les essais proposent le même nombre de formes (${counts}).` : `The routes propose the same object count (${counts}).`
    return `${conclusion} ${i18n.locale === 'fr'
      ? `Comparaison 1-à-1 des masques par IoU (${maskSummary}); ces scores ne désignent pas le bon fournisseur, vérifiez les masques.`
      : `One-to-one mask comparison by IoU (${maskSummary}); these scores do not identify the correct provider, so review the masks.`}`
  })
  let groupLevel = $state<'all' | 'nearby' | 'cluster'>('all')
  let search = $state('')
  type Annotation = { name?: string; role?: string; locked?: boolean; pivot: [number, number] }
  let annotations = $state<Record<string, Annotation>>({})
  let error = $state('')
  const current = $derived(!!output && source === svg && usedDistance === distance && usedColorMode === colorMode && usedSingletonMode === includeSingletons && usedStrategy === strategy && (strategy !== 'spatial' || usedRegionCount === regionCount))
  $effect(() => {
    const currentSvg = svg
    if (regionSeed === currentSvg) return
    regionSeed = currentSvg
    regionCount = grouping?.sourceHash === svgFingerprint(currentSvg) ? grouping.regionCount ?? recommendedRegionCount : recommendedRegionCount
  })
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
  const assemblyCount = $derived(assemblySelection.size)
  const canComposeAssembly = $derived(canComposeSelected())
  const canSplit = $derived(!!selectedGroup && selectedGroup.level === 1 && !!output?.groups.some((group) => group.parentId === selectedGroup.id))
  const canSplitPaths = $derived(!!selectedGroup && selectedGroup.level === 0 && selectedGroup.pathIndices.length > 1 && selectedGroup.members?.length === selectedGroup.pathIndices.length && !annotationFor(selectedGroup, selectedIndex).locked)
  const canMerge = $derived(!!selectedGroup && selectedGroup.level === 0 && !selectedGroup.parentId && !!nextAdjacentRoot(selectedGroup))
  $effect(() => {
    if (output || !grouping || grouping.sourceHash !== svgFingerprint(svg)) return
    const groups: NearbyGroup[] = grouping.groups.map((group) => ({ id: group.id, key: group.key, pathIndices: [...group.pathIndices], count: group.count, bounds: [...group.bounds], pivot: [...group.pivot], fill: group.fill, zone: group.zone, level: group.level, parentId: group.parentId, role: group.role, fragmentIds: group.fragmentIds ? [...group.fragmentIds] : undefined, members: group.members?.map((member) => ({ ...member, bounds: [...member.bounds] as [number, number, number, number], pivot: [...member.pivot] as [number, number] })) }))
    source = svg
    usedDistance = grouping.distance
    distance = grouping.distance
    usedColorMode = grouping.colorMode ?? 'proximity'
    colorMode = usedColorMode
    usedSingletonMode = grouping.includeSingletons ?? false
    includeSingletons = usedSingletonMode
    usedStrategy = grouping.strategy ?? 'proximity'
    strategy = usedStrategy
    usedRegionCount = grouping.regionCount ?? recommendedRegionCount
    regionCount = usedRegionCount
    output = { svg: grouping.svg, groups, considered: grouping.considered ?? (svg.match(/<path d="[^"]*" fill="#[0-9a-fA-F]{6}"/g) ?? []).length, skipped: grouping.skipped ?? 0 }
    annotations = Object.fromEntries(grouping.groups.map((group) => [group.key, { name: group.name, role: group.role, locked: group.locked, pivot: [...group.pivot] as [number, number] }]))
    groupLevel = groups.some((group) => group.level === 1) ? 'cluster' : 'nearby'
    selected = groups.find((group) => group.level === (groupLevel === 'cluster' ? 1 : 0))?.id ?? groups[0]?.id ?? ''
  })
  let worker: Worker | null = null
  let destroyed = false
  let runTimer: ReturnType<typeof setTimeout> | undefined
  onDestroy(() => { destroyed = true; worker?.terminate(); worker = null; mobileSamWorker?.terminate(); mobileSamWorker = null; circleWorker?.terminate(); circleWorker = null; planarWorker?.terminate(); planarWorker = null; componentWorker?.terminate(); componentWorker = null; if (runTimer) clearTimeout(runTimer) })

  $effect(() => {
    const nextSource = sourceImage?.url ?? ''
    if (nextSource === maskSourceUrl) return
    maskSourceUrl = nextSource
    segmentationHypothesis = null
    maskPreviewUrl = ''
    maskMessage = ''
    samProposals = []
    samPreviewIndex = -1
    circleProposals = []
    circlePreviewIndex = -1
    circleDiagnostics = null
    planarProposals = []
    planarPreviewIndex = -1
    planarDiagnostics = null
    componentProposals = []
    componentPreviewIndex = -1
    componentDiagnostics = null
  })

  function renderMaskPreview(mask: BinarySegmentationMask) {
    const scale = Math.min(1, 512 / Math.max(mask.width, mask.height))
    const previewWidth = Math.max(1, Math.round(mask.width * scale))
    const previewHeight = Math.max(1, Math.round(mask.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = previewWidth
    canvas.height = previewHeight
    const context = canvas.getContext('2d')
    if (!context) throw new Error('canvas')
    const pixels = context.createImageData(previewWidth, previewHeight)
    for (let y = 0; y < previewHeight; y++) for (let x = 0; x < previewWidth; x++) {
      const sourceX = Math.min(mask.width - 1, Math.floor(x * mask.width / previewWidth))
      const sourceY = Math.min(mask.height - 1, Math.floor(y * mask.height / previewHeight))
      if (mask.data[sourceY * mask.width + sourceX]) {
        const offset = (y * previewWidth + x) * 4
        pixels.data[offset] = 255
        pixels.data[offset + 1] = 0
        pixels.data[offset + 2] = 180
        pixels.data[offset + 3] = 125
      }
    }
    context.putImageData(pixels, 0, 0)
    return canvas.toDataURL('image/png')
  }

  async function importSegmentationMask(event: Event) {
    const input = event.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    segmentationHypothesis = null
    maskPreviewUrl = ''
    maskMessage = ''
    if (!file || !sourceImage) return
    const sourceUrl = sourceImage.url
    if (file.type !== 'image/png') { maskMessage = words.maskError; return }
    maskBusy = true
    try {
      const image = await decodeFile(file)
      if (sourceImage?.url !== sourceUrl) return
      const sourceRatio = sourceImage.width / sourceImage.height
      if (!Number.isFinite(sourceRatio) || Math.abs(image.width / image.height - sourceRatio) > sourceRatio * 0.005) throw new Error('aspect')
      const mask = binaryMaskFromRgba(image.data, image.width, image.height)
      segmentationHypothesis = createMaskHypothesis({
        id: 'imported-mask', mask, source: { provider: 'imported-mask', description: file.name },
      })
      maskPreviewUrl = renderMaskPreview(mask)
      maskMessage = words.maskLoaded(mask.width, mask.height)
    } catch (cause) {
      maskMessage = cause instanceof Error && cause.message === 'aspect' ? words.maskDimensions : words.maskError
    } finally {
      maskBusy = false
    }
  }

  function mobileSamWorkerForPage() {
    if (!mobileSamWorker) mobileSamWorker = new Worker(new URL('../engine/mobile-sam-worker.ts', import.meta.url), { type: 'module' })
    return mobileSamWorker
  }

  async function generateMobileSamMasks() {
    if (!samEncoderFile || !samDecoderFile || !sourceImage) { maskMessage = words.samChooseModels; return }
    const sourceUrl = sourceImage.url
    if (!sourceUrl.startsWith('blob:')) { maskMessage = words.samLocalError; return }
    maskBusy = true
    maskMessage = ''
    samProgress = words.running
    samProposals = []
    samPreviewIndex = -1
    const requestId = ++mobileSamRequestId
    try {
      const sourceResponse = await fetch(sourceUrl)
      if (!sourceResponse.ok) throw new Error('source-local')
      const sourceBlob = await sourceResponse.blob()
      if (sourceImage?.url !== sourceUrl) throw new Error('source-changed')
      const worker = mobileSamWorkerForPage()
      await new Promise<void>((resolve, reject) => {
        worker.onmessage = (event: MessageEvent<MobileSamWorkerMessage>) => {
          const message = event.data
          if (message.requestId !== requestId) return
          if (message.type === 'progress') {
            const stage = message.stage === 'models' ? 'ONNX' : message.stage === 'encoder' ? 'Encodeur' : 'Décodeur'
            samProgress = words.samWorking(stage, message.complete, message.total)
            return
          }
          if (message.type === 'error') {
            maskMessage = message.code === 'model-hash' ? words.samHashError : message.code === 'model-interface' ? words.samModelError : words.samLocalError
            reject(new Error(message.code))
            return
          }
          if (sourceImage?.url !== sourceUrl) { reject(new Error('source-changed')); return }
          try {
            const candidates = message.proposals.map((proposal): MaskCandidate => {
              const mask: BinarySegmentationMask = { width: proposal.width, height: proposal.height, data: new Uint8Array(proposal.data) }
              const ratio = mask.width / mask.height, expectedRatio = sourceImage!.width / sourceImage!.height
              if (Math.abs(ratio - expectedRatio) > expectedRatio * 0.005) throw new Error('aspect')
              return { prompt: proposal.prompt, score: proposal.score, width: mask.width, height: mask.height, data: mask.data }
            })
            const hypotheses = createMobileSamHypotheses(candidates, {
              applied: message.diagnostics.promptFilterApplied,
              reason: message.diagnostics.promptSelectionReason,
            })
            const proposals: LocalMaskProposal[] = hypotheses.map((hypothesis) => ({
              ...hypothesis,
              previewUrl: renderMaskPreview(hypothesis.mask),
            }))
            samProposals = proposals
            maskMessage = proposals.length ? words.samReady(proposals.length, message.diagnostics.elapsedMs) : words.samNoProposals
            resolve()
          } catch (cause) { reject(cause) }
        }
        worker.onerror = () => reject(new Error('worker'))
        worker.postMessage({ type: 'generate', requestId, encoderFile: samEncoderFile!, decoderFile: samDecoderFile!, sourceImage: sourceBlob, gridSize: samGridSize })
      })
    } catch (cause) {
      if (!maskMessage) maskMessage = cause instanceof Error && cause.message === 'aspect' ? words.maskDimensions : words.samLocalError
    } finally {
      if (requestId === mobileSamRequestId) { maskBusy = false; samProgress = '' }
    }
  }

  function previewMobileSamProposal(index: number) {
    const proposal = samProposals[index]
    if (!proposal) return
    samPreviewIndex = index
    maskPreviewUrl = proposal.previewUrl
  }

  function usePreviewedMobileSamMask() {
    const proposal = samProposals[samPreviewIndex]
    if (!proposal) return
    segmentationHypothesis = proposal
    maskMessage = words.maskLoaded(proposal.mask.width, proposal.mask.height)
  }

  function circleOverlapWorkerForPage() {
    if (!circleWorker) circleWorker = new Worker(new URL('../engine/circle-overlap-worker.ts', import.meta.url), { type: 'module' })
    return circleWorker
  }

  async function generateCircleOverlapMasks() {
    if (!sourceImage || !sourceImage.url.startsWith('blob:')) { maskMessage = circleWords.noFit; return }
    const sourceUrl = sourceImage.url
    const requestId = ++circleRequestId
    maskBusy = true
    maskMessage = ''
    circleProposals = []
    circlePreviewIndex = -1
    circleDiagnostics = null
    try {
      const response = await fetch(sourceUrl)
      if (!response.ok || sourceImage?.url !== sourceUrl) throw new Error('source')
      const blob = await response.blob()
      const image = await decodeFile(new File([blob], 'rastavec-source', { type: blob.type || 'image/png' }))
      if (sourceImage?.url !== sourceUrl) throw new Error('source-changed')
      const worker = circleOverlapWorkerForPage()
      const pixels = image.data.buffer as ArrayBuffer
      await new Promise<void>((resolve, reject) => {
        worker.onmessage = (event: MessageEvent<CircleWorkerMessage>) => {
          const message = event.data
          if (message.requestId !== requestId) return
          if (message.type === 'error') { reject(new Error('circle-worker')); return }
          if (sourceImage?.url !== sourceUrl) { reject(new Error('source-changed')); return }
          const result = message.result
          if (result.status === 'abstained') {
            circleDiagnostics = null
            maskMessage = circleWords.noFit
            resolve()
            return
          }
          circleDiagnostics = result.diagnostics
          circleProposals = result.hypotheses.map((hypothesis): LocalMaskProposal => ({
            ...hypothesis,
            previewUrl: renderMaskPreview(hypothesis.mask),
          }))
          maskMessage = circleWords.ready(circleProposals.length)
          resolve()
        }
        worker.onerror = () => reject(new Error('circle-worker'))
        worker.postMessage({ type: 'propose', requestId, width: image.width, height: image.height, pixels }, [pixels])
      })
    } catch {
      if (requestId === circleRequestId && sourceImage?.url === sourceUrl) maskMessage = circleWords.processingError
    } finally {
      if (requestId === circleRequestId) maskBusy = false
    }
  }

  function previewCircleHypothesis(index: number) {
    const proposal = circleProposals[index]
    if (!proposal) return
    circlePreviewIndex = index
    maskPreviewUrl = proposal.previewUrl
  }

  function usePreviewedCircleHypothesis() {
    const proposal = circleProposals[circlePreviewIndex]
    if (!proposal) return
    segmentationHypothesis = proposal
    maskMessage = words.maskLoaded(proposal.mask.width, proposal.mask.height)
  }

  function planarColorWorkerForPage() {
    if (!planarWorker) planarWorker = new Worker(new URL('../engine/planar-color-worker.ts', import.meta.url), { type: 'module' })
    return planarWorker
  }

  async function generatePlanarColorMasks() {
    if (!sourceImage || !sourceImage.url.startsWith('blob:')) { maskMessage = planarWords.noFit; return }
    const sourceUrl = sourceImage.url
    const requestId = ++planarRequestId
    maskBusy = true
    maskMessage = ''
    planarProposals = []
    planarPreviewIndex = -1
    planarDiagnostics = null
    try {
      const response = await fetch(sourceUrl)
      if (!response.ok || sourceImage?.url !== sourceUrl) throw new Error('source')
      const blob = await response.blob()
      const image = await decodeFile(new File([blob], 'rastavec-source', { type: blob.type || 'image/png' }))
      if (sourceImage?.url !== sourceUrl) throw new Error('source-changed')
      const worker = planarColorWorkerForPage()
      const pixels = image.data.buffer as ArrayBuffer
      await new Promise<void>((resolve, reject) => {
        worker.onmessage = (event: MessageEvent<PlanarColorWorkerMessage>) => {
          const message = event.data
          if (message.requestId !== requestId) return
          if (message.type === 'error') { reject(new Error('planar-worker')); return }
          if (sourceImage?.url !== sourceUrl) { reject(new Error('source-changed')); return }
          const result = message.result
          if (result.status === 'abstained') {
            planarDiagnostics = null
            maskMessage = planarWords.noFit
            resolve()
            return
          }
          planarDiagnostics = result.diagnostics
          planarProposals = result.hypotheses.map((hypothesis): LocalMaskProposal => ({
            ...hypothesis,
            previewUrl: renderMaskPreview(hypothesis.mask),
          }))
          maskMessage = planarWords.ready(planarProposals.length)
          resolve()
        }
        worker.onerror = () => reject(new Error('planar-worker'))
        worker.postMessage({ type: 'propose', requestId, width: image.width, height: image.height, pixels }, [pixels])
      })
    } catch {
      if (requestId === planarRequestId && sourceImage?.url === sourceUrl) maskMessage = planarWords.processingError
    } finally {
      if (requestId === planarRequestId) maskBusy = false
    }
  }

  function previewPlanarColorHypothesis(index: number) {
    const proposal = planarProposals[index]
    if (!proposal) return
    planarPreviewIndex = index
    maskPreviewUrl = proposal.previewUrl
  }

  function usePreviewedPlanarColorHypothesis() {
    const proposal = planarProposals[planarPreviewIndex]
    if (!proposal) return
    segmentationHypothesis = proposal
    maskMessage = words.maskLoaded(proposal.mask.width, proposal.mask.height)
  }

  function connectedComponentWorkerForPage() {
    if (!componentWorker) componentWorker = new Worker(new URL('../engine/connected-component-worker.ts', import.meta.url), { type: 'module' })
    return componentWorker
  }

  async function generateConnectedComponentMasks() {
    if (!sourceImage || !sourceImage.url.startsWith('blob:')) { maskMessage = componentWords.noFit; return }
    const sourceUrl = sourceImage.url
    const requestId = ++componentRequestId
    maskBusy = true
    maskMessage = ''
    componentProposals = []
    componentPreviewIndex = -1
    componentDiagnostics = null
    try {
      const response = await fetch(sourceUrl)
      if (!response.ok || sourceImage?.url !== sourceUrl) throw new Error('source')
      const blob = await response.blob()
      const image = await decodeFile(new File([blob], 'rastavec-source', { type: blob.type || 'image/png' }))
      if (sourceImage?.url !== sourceUrl) throw new Error('source-changed')
      const worker = connectedComponentWorkerForPage()
      const pixels = image.data.buffer as ArrayBuffer
      await new Promise<void>((resolve, reject) => {
        worker.onmessage = (event: MessageEvent<ConnectedComponentWorkerMessage>) => {
          const message = event.data
          if (message.requestId !== requestId) return
          if (message.type === 'error') { reject(new Error('component-worker')); return }
          if (sourceImage?.url !== sourceUrl) { reject(new Error('source-changed')); return }
          const result = message.result
          if (result.status === 'abstained') {
            componentDiagnostics = null
            maskMessage = `${componentWords.noFit} ${result.reason}`
            resolve()
            return
          }
          componentDiagnostics = result.diagnostics
          componentProposals = result.hypotheses.map((hypothesis): LocalMaskProposal => ({
            ...hypothesis,
            previewUrl: renderMaskPreview(hypothesis.mask),
          }))
          maskMessage = componentWords.ready(componentProposals.length)
          resolve()
        }
        worker.onerror = () => reject(new Error('component-worker'))
        worker.postMessage({ type: 'propose', requestId, width: image.width, height: image.height, pixels }, [pixels])
      })
    } catch {
      if (requestId === componentRequestId && sourceImage?.url === sourceUrl) maskMessage = componentWords.processingError
    } finally {
      if (requestId === componentRequestId) maskBusy = false
    }
  }

  function previewConnectedComponentHypothesis(index: number) {
    const proposal = componentProposals[index]
    if (!proposal) return
    componentPreviewIndex = index
    maskPreviewUrl = proposal.previewUrl
  }

  function usePreviewedConnectedComponentHypothesis() {
    const proposal = componentProposals[componentPreviewIndex]
    if (!proposal) return
    segmentationHypothesis = proposal
    maskMessage = words.maskLoaded(proposal.mask.width, proposal.mask.height)
  }

  function selectGroupsFromMask() {
    if (!segmentationHypothesis || !sourceImage || !output || !current) return
    const viewBox = svgViewBox(output.svg)
    if (!viewBox) { maskMessage = words.maskError; return }
    try {
      const result = selectGroupsByMask(output.groups, segmentationHypothesis.mask, viewBox, sourceImage.width, sourceImage.height)
      const eligible = result.groupIds.filter((id) => {
        const group = output!.groups.find((candidate) => candidate.id === id)
        return !!group && !annotations[group.key]?.locked
      })
      assemblySelection = new Set(eligible)
      if (eligible.length) selected = eligible[0]
      maskMessage = eligible.length
        ? words.maskSelected(eligible.length, result.matchedPaths)
        : words.maskNoGroups
    } catch {
      maskMessage = words.maskError
    }
  }

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

  function scheduleRun(event: Event) {
    const value = Number((event.currentTarget as HTMLInputElement).value)
    if (!Number.isFinite(value)) return
    distance = value
    queueRun()
  }
  function queueRun() {
    if (runTimer) clearTimeout(runTimer)
    runTimer = setTimeout(() => { runTimer = undefined; void run() }, 350)
  }
  function changeColorMode(event: Event) {
    colorMode = (event.currentTarget as HTMLSelectElement).value as typeof colorMode
    queueRun()
  }
  function changeSingletonMode(event: Event) {
    includeSingletons = (event.currentTarget as HTMLInputElement).checked
    queueRun()
  }
  function changeStrategy(event: Event) {
    strategy = (event.currentTarget as HTMLSelectElement).value as NearbyStrategy
    queueRun()
  }
  function changeRegionCount(event: Event) {
    const value = Number((event.currentTarget as HTMLInputElement).value)
    if (!Number.isFinite(value)) return
    regionCount = Math.max(2, Math.min(64, Math.round(value)))
    queueRun()
  }
  function canComposeSelected() {
    if (!output || assemblySelection.size < 2) return false
    const selectedGroups = output.groups.filter((group) => assemblySelection.has(group.id))
    if (selectedGroups.length !== assemblySelection.size || selectedGroups.some((group) => group.level !== 0 || annotations[group.key]?.locked)) return false
    const pathIndices = selectedGroups.flatMap((group) => group.pathIndices)
    return new Set(pathIndices).size === pathIndices.length
  }
  function toggleAssemblyMember(group: NearbyGroup) {
    if (group.level !== 0 || annotationFor(group, selectedIndex).locked) return
    const next = new Set(assemblySelection)
    if (next.has(group.id)) next.delete(group.id)
    else next.add(group.id)
    assemblySelection = next
  }
  function clearAssemblySelection() {
    assemblySelection = new Set()
  }
  function composeSelectedGroups() {
    if (!output || !canComposeSelected()) return
    const selectedGroups = output.groups.filter((group) => assemblySelection.has(group.id))
    const doc = new DOMParser().parseFromString(output.svg, 'image/svg+xml')
    if (doc.querySelector('parsererror')) return
    const lookup = (id: string) => Array.from(doc.querySelectorAll('g[id]')).find((element) => element.getAttribute('id') === id)
    const pathByIndex = new Map<number, { path: Element; root: Element }>()
    const roots = new Set<Element>()
    for (const group of selectedGroups) {
      const groupRoots = group.fragmentIds?.length ? group.fragmentIds.map(lookup) : [lookup(group.id)]
      if (groupRoots.some((root) => !root)) return
      const actualRoots = groupRoots as Element[]
      if (group.fragmentIds?.length) {
        if (actualRoots.length !== group.pathIndices.length) return
        for (let i = 0; i < actualRoots.length; i++) {
          const paths = Array.from(actualRoots[i].querySelectorAll('path'))
          if (paths.length !== 1) return
          pathByIndex.set(group.pathIndices[i], { path: paths[0], root: actualRoots[i] })
          roots.add(actualRoots[i])
        }
      } else {
        const paths = Array.from(actualRoots[0].querySelectorAll('path'))
        if (paths.length !== group.pathIndices.length) return
        group.pathIndices.forEach((pathIndex, i) => {
          pathByIndex.set(pathIndex, { path: paths[i], root: actualRoots[0] })
        })
        roots.add(actualRoots[0])
      }
    }
    const pathIndices = [...pathByIndex.keys()].sort((a, b) => a - b)
    if (pathIndices.length !== pathByIndex.size) return
    const baseId = `rastavec-assembly-${pathIndices[0] + 1}-${pathIndices.at(-1)! + 1}`
    let id = baseId, suffix = 2
    while (doc.querySelector(`[id="${id}"]`) || output.groups.some((group) => group.id === id)) id = `${baseId}-${suffix++}`
    const fragmentIds = pathIndices.map((_, index) => `${id}-part-${index + 1}`)
    const parents = new Set(selectedGroups.map((group) => group.parentId ?? ''))
    const parentId = parents.size === 1 ? selectedGroups[0].parentId : undefined
    const bounds = selectedGroups.slice(1).reduce((box, group) => [Math.min(box[0], group.bounds[0]), Math.min(box[1], group.bounds[1]), Math.max(box[2], group.bounds[2]), Math.max(box[3], group.bounds[3])] as [number, number, number, number], [...selectedGroups[0].bounds] as [number, number, number, number])
    const fills = new Map<string, number>()
    for (const group of selectedGroups) fills.set(group.fill, (fills.get(group.fill) ?? 0) + group.count)
    const fill = [...fills].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0]
    const members = selectedGroups.flatMap((group) => group.members?.length === group.pathIndices.length ? group.members : group.pathIndices.map((pathIndex) => ({ pathIndex, bounds: [...group.bounds] as [number, number, number, number], pivot: [...group.pivot] as [number, number], fill: group.fill, zone: group.zone }))).sort((a, b) => a.pathIndex - b.pathIndex)
    const merged: NearbyGroup = { id, key: `0:${pathIndices.join(',')}`, pathIndices, count: pathIndices.length, bounds, pivot: [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2], fill, zone: selectedGroups[0].zone, level: 0, ...(parentId ? { parentId } : {}), members, fragmentIds }
    for (const [index, pathIndex] of pathIndices.entries()) {
      const { path, root } = pathByIndex.get(pathIndex)!
      const parent = root.parentNode
      if (!parent) return
      const fragment = doc.createElementNS('http://www.w3.org/2000/svg', 'g')
      fragment.setAttribute('id', fragmentIds[index])
      fragment.setAttribute('data-rastavec-fragment-of', id)
      fragment.setAttribute('data-rastavec-group', 'proximity')
      fragment.setAttribute('data-rastavec-level', '0')
      parent.insertBefore(fragment, root)
      fragment.appendChild(path)
    }
    // Capture the spatial containers before removing their child roots; detached
    // roots no longer have a parentElement afterwards.
    const spatialContainers = new Set<Element>()
    for (const root of roots) {
      const parent = root.parentElement
      if (parent?.getAttribute('data-rastavec-order-container') === 'spatial') spatialContainers.add(parent)
    }
    for (const root of roots) root.parentNode?.removeChild(root)
    for (const container of spatialContainers) {
      if (!container.querySelector('g[id]')) container.parentNode?.removeChild(container)
    }
    const removedIds = new Set(selectedGroups.map((group) => group.id))
    const { [merged.key]: _oldAnnotation, ...remaining } = annotations
    annotations = { ...remaining, [merged.key]: { name: autoName(merged, output.groups.length), pivot: [...merged.pivot] } }
    output = { ...output, svg: new XMLSerializer().serializeToString(doc), groups: [...output.groups.filter((group) => !removedIds.has(group.id)), merged] }
    assemblySelection = new Set()
    selected = id
    groupLevel = 'all'
    syncGrouping()
  }

  async function run() {
    if (busy) return
    if (runTimer) { clearTimeout(runTimer); runTimer = undefined }
    busy = true; error = ''
    const input = svg, d = distance, c = colorMode, include = includeSingletons, mode = strategy, regions = regionCount
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
        active.postMessage({ svg: input, distance: d, colorMode: c, includeSingletons: include, strategy: mode, regionCount: regions })
      })
      if (destroyed) return
      source = input; usedDistance = d; usedColorMode = c; usedSingletonMode = include; usedStrategy = mode; usedRegionCount = regions; output = result
      const previous = grouping?.groups ?? []
      annotations = Object.fromEntries(result.groups.map((group, index) => {
        const saved = previous.find((annotation) => annotation.key === group.key)
        return [group.key, saved ? { name: saved.name, role: saved.role, locked: saved.locked, pivot: [...saved.pivot] as [number, number] } : { name: autoName(group, groupOrdinals.get(group.id) ?? index), pivot: [...group.pivot] }]
      }))
      search = ''
      assemblySelection = new Set()
      groupLevel = result.groups.some((group) => group.level === 1) ? 'cluster' : 'nearby'
      selected = result.groups.find((group) => group.level === (groupLevel === 'cluster' ? 1 : 0))?.id ?? result.groups[0]?.id ?? ''
      syncGrouping()
    } catch (e) { if (!destroyed) error = e instanceof Error ? e.message : String(e) }
    finally { worker?.terminate(); worker = null; if (!destroyed) busy = false }
  }

  function autoName(group: NearbyGroup, index: number) {
    const locale = i18n.locale
    const shapeLabel = locale === 'fr' ? group.count === 1 ? 'forme' : 'formes' : group.count === 1 ? 'shape' : 'shapes'
    const noun = locale === 'fr'
      ? `${group.level === 1 ? 'Ensemble' : 'Groupe'} ${index + 1} · ${group.count} ${shapeLabel}`
      : `${group.level === 1 ? 'Cluster' : 'Group'} ${index + 1} · ${group.count} ${shapeLabel}`
    return `${noun} · ${colorName(group.fill, locale)} · ${zoneName(group.zone, locale)}`
  }
  function labelFor(group: NearbyGroup, index: number) {
    const ordinal = groupOrdinals.get(group.id) ?? index
    return annotations[group.key]?.name?.trim() || autoName(group, ordinal)
  }
  function annotationFor(group: NearbyGroup, index: number): Annotation {
    return annotations[group.key] ?? { name: autoName(group, groupOrdinals.get(group.id) ?? index), pivot: [...group.pivot] }
  }
  function syncGrouping() {
    if (!current || !output) return
    const groups = output.groups.map((group, index) => {
      const annotation = annotationFor(group, index)
      return { id: group.id, key: group.key, pathIndices: [...group.pathIndices], count: group.count, bounds: [...group.bounds] as [number, number, number, number], fill: group.fill, zone: group.zone, level: group.level, ...(group.parentId ? { parentId: group.parentId } : {}), name: annotation.name?.trim() || autoName(group, groupOrdinals.get(group.id) ?? index), ...(annotation.role?.trim() ? { role: annotation.role.trim() } : {}), ...(annotation.locked ? { locked: true } : {}), pivot: [...annotation.pivot] as [number, number], ...(group.fragmentIds?.length ? { fragmentIds: [...group.fragmentIds] } : {}), ...(group.members?.length ? { members: group.members.map((member) => ({ ...member, bounds: [...member.bounds] as [number, number, number, number], pivot: [...member.pivot] as [number, number] })) } : {}) }
    })
     const state = { sourceHash: svgFingerprint(source), distance: usedDistance, colorMode: usedColorMode, includeSingletons: usedSingletonMode, strategy: usedStrategy, regionCount: usedRegionCount, considered: output.considered, skipped: output.skipped, groups }
    onGroupingChange({ ...state, svg: labelledSvg() })
  }
  function renameSelected(event: Event) {
    if (!selectedGroup || annotationFor(selectedGroup, selectedIndex).locked) return
    annotations = { ...annotations, [selectedGroup.key]: { ...annotationFor(selectedGroup, selectedIndex), name: (event.currentTarget as HTMLInputElement).value } }
    syncGrouping()
  }
  function updateRole(event: Event) {
    if (!selectedGroup || annotationFor(selectedGroup, selectedIndex).locked) return
    annotations = { ...annotations, [selectedGroup.key]: { ...annotationFor(selectedGroup, selectedIndex), role: (event.currentTarget as HTMLInputElement).value } }
    syncGrouping()
  }
  function updatePivot(axis: 0 | 1, event: Event) {
    if (!selectedGroup || annotationFor(selectedGroup, selectedIndex).locked) return
    const value = Number((event.currentTarget as HTMLInputElement).value)
    if (!Number.isFinite(value)) return
    const annotation = annotationFor(selectedGroup, selectedIndex)
    const pivot: [number, number] = [...annotation.pivot]
    pivot[axis] = value
    annotations = { ...annotations, [selectedGroup.key]: { ...annotation, pivot } }
    syncGrouping()
  }
  function toggleLock() {
    if (!selectedGroup) return
    const annotation = annotationFor(selectedGroup, selectedIndex)
    annotations = { ...annotations, [selectedGroup.key]: { ...annotation, locked: !annotation.locked } }
    syncGrouping()
  }
  function nextAdjacentRoot(group: NearbyGroup): NearbyGroup | undefined {
    if (!output) return
    const roots = output.groups.filter((candidate) => candidate.level === 0 && !candidate.parentId).sort((a, b) => a.pathIndices[0] - b.pathIndices[0])
    const index = roots.findIndex((candidate) => candidate.id === group.id)
    const next = roots[index + 1]
    if (!next) return
    const doc = new DOMParser().parseFromString(output.svg, 'image/svg+xml')
    const first = Array.from(doc.querySelectorAll('[id]')).find((element) => element.getAttribute('id') === group.id)
    const second = Array.from(doc.querySelectorAll('[id]')).find((element) => element.getAttribute('id') === next.id)
    if (!first || !second || first.parentElement !== second.parentElement) return
    let cursor: Node | null = first
    while (cursor && cursor !== second) {
      cursor = cursor.nextSibling
      if (cursor && cursor !== second && (cursor.nodeType !== Node.TEXT_NODE || !!cursor.textContent?.trim())) return
    }
    return cursor === second ? next : undefined
  }
  function adjacentMarkup(firstId: string, secondId: string, wrapperId: string): string | null {
    if (!output) return null
    const doc = new DOMParser().parseFromString(output.svg, 'image/svg+xml')
    if (doc.querySelector('parsererror')) return null
    const lookup = (id: string) => Array.from(doc.querySelectorAll('[id]')).find((element) => element.getAttribute('id') === id)
    const first = lookup(firstId), second = lookup(secondId)
    if (!first || !second || first.parentElement !== second.parentElement) return null
    const parent = first.parentElement
    if (!parent) return null
    let cursor: Node | null = first
    const collected: Node[] = []
    while (cursor) {
      const sibling: Node | null = cursor.nextSibling
      collected.push(cursor)
      if (cursor === second) break
      if (!sibling || (sibling !== second && (sibling.nodeType !== Node.TEXT_NODE || !!sibling.textContent?.trim()))) return null
      cursor = sibling
    }
    if (collected.at(-1) !== second) return null
    const wrapper = doc.createElementNS('http://www.w3.org/2000/svg', 'g')
    wrapper.setAttribute('id', wrapperId)
    wrapper.setAttribute('data-rastavec-group', 'proximity')
    wrapper.setAttribute('data-rastavec-level', '1')
    parent.insertBefore(wrapper, first)
    collected.forEach((node) => wrapper.appendChild(node))
    return new XMLSerializer().serializeToString(doc)
  }
  function mergeWithNext() {
    if (!output || !selectedGroup || !canMerge) return
    const next = nextAdjacentRoot(selectedGroup)
    if (!next) return
    const members = [...selectedGroup.pathIndices, ...next.pathIndices].sort((a, b) => a - b)
    const key = `1:${members.join(',')}`
    const baseId = `rastavec-manual-${members[0] + 1}-${members.at(-1)! + 1}`
    let id = baseId, suffix = 2
    while (output.svg.includes(`id="${id}"`) || output.svg.includes(`id='${id}'`)) id = `${baseId}-${suffix++}`
    const svgText = adjacentMarkup(selectedGroup.id, next.id, id)
    if (!svgText) return
    const bounds: [number, number, number, number] = [Math.min(selectedGroup.bounds[0], next.bounds[0]), Math.min(selectedGroup.bounds[1], next.bounds[1]), Math.max(selectedGroup.bounds[2], next.bounds[2]), Math.max(selectedGroup.bounds[3], next.bounds[3])]
    const fill = selectedGroup.count === next.count ? [selectedGroup.fill, next.fill].sort()[0] : selectedGroup.count > next.count ? selectedGroup.fill : next.fill
    const merged: NearbyGroup = { id, key, pathIndices: members, count: selectedGroup.count + next.count, bounds, pivot: [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2], fill, zone: selectedGroup.zone, level: 1 }
    annotations = { ...annotations, [key]: { name: autoName(merged, groupOrdinals.get(id) ?? output.groups.length), pivot: [...merged.pivot] } }
    output = { ...output, svg: svgText, groups: [...output.groups.map((group) => group.id === selectedGroup.id || group.id === next.id ? { ...group, parentId: id } : group), merged] }
    selected = id
    groupLevel = 'all'
    syncGrouping()
  }
  function splitSelected() {
    if (!output || !selectedGroup || !canSplit) return
    const doc = new DOMParser().parseFromString(output.svg, 'image/svg+xml')
    const wrapper = Array.from(doc.querySelectorAll('[id]')).find((element) => element.getAttribute('id') === selectedGroup.id)
    if (!wrapper?.parentNode) return
    const parent = wrapper.parentNode
    while (wrapper.firstChild) parent.insertBefore(wrapper.firstChild, wrapper)
    parent.removeChild(wrapper)
    const children = output.groups.filter((group) => group.parentId === selectedGroup.id)
    const groups = output.groups.filter((group) => group.id !== selectedGroup.id).map((group) => group.parentId === selectedGroup.id ? { ...group, parentId: undefined } : group)
    const { [selectedGroup.key]: _removed, ...remaining } = annotations
    annotations = remaining
    output = { ...output, svg: new XMLSerializer().serializeToString(doc), groups }
    selected = children[0]?.id ?? ''
    groupLevel = 'nearby'
    syncGrouping()
  }
  function splitSelectedPaths() {
    if (!output || !selectedGroup || !canSplitPaths) return
    const doc = new DOMParser().parseFromString(output.svg, 'image/svg+xml')
    if (doc.querySelector('parsererror')) return
    const members = [...(selectedGroup.members ?? [])].sort((a, b) => a.pathIndex - b.pathIndex)
    if (selectedGroup.fragmentIds?.length) {
      if (selectedGroup.fragmentIds.length !== members.length) return
      const childGroups: NearbyGroup[] = []
      for (const [index, member] of members.entries()) {
        const fragment = Array.from(doc.querySelectorAll('g[id]')).find((element) => element.getAttribute('id') === selectedGroup.fragmentIds![index])
        if (!fragment || !fragment.querySelector('path')) return
        const baseId = `rastavec-manual-path-${member.pathIndex + 1}`
        let id = baseId, suffix = 2
        while (Array.from(doc.querySelectorAll('[id]')).some((element) => element.getAttribute('id') === id)) id = `${baseId}-${suffix++}`
        fragment.setAttribute('id', id)
        fragment.removeAttribute('data-rastavec-fragment-of')
        fragment.setAttribute('data-rastavec-group', 'proximity')
        fragment.setAttribute('data-rastavec-level', '0')
        childGroups.push({ id, key: `0:${member.pathIndex}`, pathIndices: [member.pathIndex], count: 1, bounds: [...member.bounds], pivot: [...member.pivot], fill: member.fill, zone: member.zone, level: 0, ...(selectedGroup.parentId ? { parentId: selectedGroup.parentId } : {}), members: [{ ...member }] })
      }
      const firstChildOrdinal = groupOrdinals.get(selectedGroup.id) ?? output.groups.length
      const { [selectedGroup.key]: _removed, ...remaining } = annotations
      annotations = { ...remaining, ...Object.fromEntries(childGroups.map((group, index) => [group.key, { name: autoName(group, firstChildOrdinal + index), pivot: [...group.pivot] as [number, number] }])) }
      output = { ...output, svg: new XMLSerializer().serializeToString(doc), groups: output.groups.flatMap((group) => group.id === selectedGroup.id ? childGroups : [group]) }
      selected = childGroups[0]?.id ?? ''
      syncGrouping()
      return
    }
    const wrapper = Array.from(doc.querySelectorAll('g[id]')).find((element) => element.getAttribute('id') === selectedGroup.id)
    const parent = wrapper?.parentNode
    const paths = wrapper ? Array.from(wrapper.children).filter((element) => element.localName.toLowerCase() === 'path') : []
    if (!wrapper || !parent || paths.length !== members.length) return

    const pathByIndex = new Map(members.map((member, index) => [member.pathIndex, paths[index]]))
    const childGroups: NearbyGroup[] = []
    for (const member of members) {
      const path = pathByIndex.get(member.pathIndex)
      if (!path) return
      const baseId = `rastavec-manual-path-${member.pathIndex + 1}`
      let id = baseId, suffix = 2
      while (Array.from(doc.querySelectorAll('[id]')).some((element) => element.getAttribute('id') === id)) id = `${baseId}-${suffix++}`
      const groupElement = doc.createElementNS('http://www.w3.org/2000/svg', 'g')
      groupElement.setAttribute('id', id)
      groupElement.setAttribute('data-rastavec-group', 'proximity')
      groupElement.setAttribute('data-rastavec-level', '0')
      parent.insertBefore(groupElement, wrapper)
      groupElement.appendChild(path)
      childGroups.push({
        id, key: `0:${member.pathIndex}`, pathIndices: [member.pathIndex], count: 1,
        bounds: [...member.bounds], pivot: [...member.pivot], fill: member.fill, zone: member.zone,
        level: 0, ...(selectedGroup.parentId ? { parentId: selectedGroup.parentId } : {}),
      })
    }
    parent.removeChild(wrapper)

    const firstChildOrdinal = groupOrdinals.get(selectedGroup.id) ?? output.groups.length
    const { [selectedGroup.key]: _removed, ...remaining } = annotations
    annotations = {
      ...remaining,
      ...Object.fromEntries(childGroups.map((group, index) => [group.key, { name: autoName(group, firstChildOrdinal + index), pivot: [...group.pivot] as [number, number] }])),
    }
    output = { ...output, svg: new XMLSerializer().serializeToString(doc), groups: output.groups.flatMap((group) => group.id === selectedGroup.id ? childGroups : [group]) }
    selected = childGroups[0]?.id ?? ''
    syncGrouping()
  }
  function escapeXml(value: string) {
    return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
  }
  function labelledSvg() {
    if (!output) return ''
    const doc = new DOMParser().parseFromString(output.svg, 'image/svg+xml')
    if (doc.querySelector('parsererror')) return output.svg
    for (const [index, group] of output.groups.entries()) {
      const lookup = (id: string) => Array.from(doc.querySelectorAll('g[id]')).find((candidate) => candidate.getAttribute('id') === id)
      const elements = group.fragmentIds?.length ? group.fragmentIds.map(lookup).filter((element): element is Element => !!element) : [lookup(group.id)].filter((element): element is Element => !!element)
      if (!elements.length) continue
      const title = escapeXml(labelFor(group, index))
      const annotation = annotationFor(group, index)
      const role = annotation.role?.trim() ? ` data-rastavec-role="${escapeXml(annotation.role.trim())}"` : ''
      const locked = annotation.locked ? ' data-rastavec-annotations-locked="true"' : ''
      for (const [fragmentIndex, element] of elements.entries()) {
        element.setAttribute('data-rastavec-group', 'proximity')
        element.setAttribute('data-rastavec-level', String(group.level))
        element.setAttribute('data-rastavec-pivot-x', String(annotation.pivot[0]))
        element.setAttribute('data-rastavec-pivot-y', String(annotation.pivot[1]))
        if (group.fragmentIds?.length) element.setAttribute('data-rastavec-fragment-of', group.id)
        if (role) element.setAttribute('data-rastavec-role', annotation.role!.trim()); else element.removeAttribute('data-rastavec-role')
        if (locked) element.setAttribute('data-rastavec-annotations-locked', 'true'); else element.removeAttribute('data-rastavec-annotations-locked')
        element.setAttribute('aria-label', title)
        for (const child of Array.from(element.children)) if (child.localName === 'title') child.remove()
        if (fragmentIndex === 0) {
          const titleElement = doc.createElementNS('http://www.w3.org/2000/svg', 'title')
          titleElement.textContent = labelFor(group, index)
          element.insertBefore(titleElement, element.firstChild)
        }
      }
    }
    return new XMLSerializer().serializeToString(doc)
  }

  // Isolation is a disposable preview: retain ancestors and definitions so inherited
  // transforms, opacity and clipping continue to apply, and remove unrelated artwork.
  function isolatedSvg(input: string, group: NearbyGroup) {
    const doc = new DOMParser().parseFromString(input, 'image/svg+xml')
    if (doc.querySelector('parsererror')) throw new Error('Invalid SVG')
    const ids = group.fragmentIds?.length ? group.fragmentIds : [group.id]
    const targets = ids.map((id) => Array.from(doc.querySelectorAll('[id]')).find((el) => el.getAttribute('id') === id)).filter((element): element is Element => !!element)
    if (targets.length !== ids.length) throw new Error('Group not found')
    const technical = new Set(['defs', 'clippath', 'mask', 'pattern', 'symbol'])
    for (const el of Array.from(doc.querySelectorAll('path,rect,circle,ellipse,line,polyline,polygon,image,text,use'))) {
      let parent: Element | null = el
      let protectedElement = false
      while (parent) { if (technical.has(parent.localName.toLowerCase())) { protectedElement = true; break } parent = parent.parentElement }
      if (!protectedElement && !targets.some((target) => target.contains(el))) el.remove()
    }
    const root = doc.documentElement
    const width = Math.max(0.01, group.bounds[2] - group.bounds[0]), height = Math.max(0.01, group.bounds[3] - group.bounds[1])
    const padding = Math.max(2, Math.max(width, height) * 0.15)
    root.setAttribute('viewBox', `${group.bounds[0] - padding} ${group.bounds[1] - padding} ${width + 2 * padding} ${height + 2 * padding}`)
    root.setAttribute('width', String(width + 2 * padding))
    root.setAttribute('height', String(height + 2 * padding))
    return new XMLSerializer().serializeToString(doc)
  }
  let previewUrl = $state('')
  $effect(() => {
    if (!current || !output || !selected) { previewUrl = ''; return }
    try {
      const group = output.groups.find((candidate) => candidate.id === selected)
      if (!group) { previewUrl = ''; return }
      const url = URL.createObjectURL(new Blob([isolatedSvg(output.svg, group)], { type: 'image/svg+xml' }))
      previewUrl = url
      return () => URL.revokeObjectURL(url)
    } catch { previewUrl = '' }
  })
  function save() {
    if (current && output) { syncGrouping(); download(new Blob([labelledSvg()], { type: 'image/svg+xml' }), `${name}-groupes.svg`) }
  }
</script>

<div class="card stack group-review">
  <div class="between heading">
    <div><h2 class="h3">{words.title}</h2><p class="muted small">{words.description}</p></div>
    <div class="run-controls">
       <label class="small" for="group-strategy">{words.strategy}</label>
       <select id="group-strategy" value={strategy} onchange={changeStrategy} disabled={busy}>
         <option value="proximity">{words.proximityStrategy}</option>
         <option value="spatial">{words.spatialStrategy}</option>
       </select>
       {#if strategy === 'spatial'}
         <label class="small" for="group-region-count">{words.regionCount}</label>
         <input id="group-region-count" type="number" min="2" max="64" step="1" value={regionCount} oninput={changeRegionCount} disabled={busy} />
         <label class="singleton-toggle" title={words.includeSinglesHint}>
           <input id="group-include-singletons" type="checkbox" checked={includeSingletons} onchange={changeSingletonMode} disabled={busy} />
           <span>{words.includeSingles}</span>
         </label>
       {:else}
         <label class="small" for="group-distance">{words.distance}</label>
         <input id="group-distance" type="number" min="0" max={maxDistance} step="0.1" value={distance} oninput={scheduleRun} disabled={busy || !maxDistance} />
         <input class="distance-slider" aria-label={words.distance} type="range" min="0" max={maxDistance} step="0.1" value={distance} oninput={scheduleRun} disabled={busy || !maxDistance} />
         <label class="small" for="group-color-mode">{words.colorMode}</label>
         <select id="group-color-mode" value={colorMode} onchange={changeColorMode} disabled={busy}>
           <option value="proximity">{words.proximity}</option>
           <option value="same-color">{words.sameColor}</option>
         </select>
         <label class="singleton-toggle" title={words.includeSinglesHint}>
           <input id="group-include-singletons" type="checkbox" checked={includeSingletons} onchange={changeSingletonMode} disabled={busy} />
           <span>{words.includeSingles}</span>
         </label>
       {/if}
       <button type="button" class="btn btn-primary" onclick={run} disabled={busy || (strategy === 'proximity' && (!Number.isFinite(distance) || distance < 0 || distance > maxDistance)) || (strategy === 'spatial' && (!Number.isFinite(regionCount) || regionCount < 2 || regionCount > 64))}>{busy ? words.running : words.run}</button>
    </div>
  </div>
    {#if strategy === 'spatial'}<p class="muted tiny spatial-hint">{words.spatialHint}</p>{/if}
  {#if error}<span role="alert" class="small">{words.error}: {error}</span>{/if}
  {#if output && !current}<span class="muted small">{words.stale}</span>{/if}
  {#if output && current}
    {#if sourceImage}
      <section class="mask-tool" aria-labelledby="segmentation-mask-title">
        <div class="mask-copy">
          <h3 id="segmentation-mask-title" class="h3">{words.maskTitle}</h3>
          <p class="muted tiny">{words.maskDescription}</p>
          <div class="row mask-controls">
            <input id="segmentation-mask-file" class="mask-file" type="file" accept="image/png,.png" onchange={importSegmentationMask} disabled={maskBusy} />
            <label class="btn" for="segmentation-mask-file">{words.maskImport}</label>
            <button type="button" class="btn btn-primary" onclick={selectGroupsFromMask} disabled={!segmentationHypothesis || maskBusy || !output.groups.length}>{words.maskApply}</button>
          </div>
          <span class="muted tiny">{words.maskLocalOnly}</span>
          <div class="sam-panel" aria-labelledby="connected-components-title">
            <h4 id="connected-components-title" class="h3">{componentWords.title}</h4>
            <p class="muted tiny">{componentWords.description}</p>
            <div class="row mask-controls">
              <button type="button" class="btn" onclick={generateConnectedComponentMasks} disabled={maskBusy || !sourceImage}>{componentWords.run}</button>
            </div>
            {#if componentProposals.length}
              <div class="sam-proposals" aria-label={componentWords.title}>
                {#each componentProposals as proposal, index}
                  <button type="button" class="sam-proposal" aria-pressed={componentPreviewIndex === index} onclick={() => previewConnectedComponentHypothesis(index)} disabled={maskBusy}>
                    <img src={proposal.previewUrl} alt="" /><span>{componentWords.candidate(index + 1, Number(proposal.geometry?.parameters?.analysisPixelArea ?? 0))}</span>
                  </button>
                {/each}
              </div>
              <button type="button" class="btn" onclick={usePreviewedConnectedComponentHypothesis} disabled={componentPreviewIndex < 0 || maskBusy}>{words.samApplyProposal}</button>
              {#if componentDiagnostics?.warnings.length}
                <ul class="muted tiny">{#each componentDiagnostics.warnings as warning}<li>{warning}</li>{/each}</ul>
              {/if}
            {/if}
          </div>
          <div class="sam-panel" aria-labelledby="mobile-sam-title">
            <h4 id="mobile-sam-title" class="h3">{words.samTitle}</h4>
            <p class="muted tiny">{words.samDescription}</p>
            <div class="row mask-controls">
              <input id="mobile-sam-encoder" class="mask-file" type="file" accept=".onnx,application/octet-stream" onchange={(event) => (samEncoderFile = (event.currentTarget as HTMLInputElement).files?.[0] ?? null)} disabled={maskBusy} />
              <label class="btn" for="mobile-sam-encoder">{words.samEncoder}</label>
              <span class="muted tiny model-file-name">{samEncoderFile?.name ?? words.samNoFile}</span>
            </div>
            <div class="row mask-controls">
              <input id="mobile-sam-decoder" class="mask-file" type="file" accept=".onnx,application/octet-stream" onchange={(event) => (samDecoderFile = (event.currentTarget as HTMLInputElement).files?.[0] ?? null)} disabled={maskBusy} />
              <label class="btn" for="mobile-sam-decoder">{words.samDecoder}</label>
              <span class="muted tiny model-file-name">{samDecoderFile?.name ?? words.samNoFile}</span>
            </div>
            <div class="row mask-controls">
              <label class="small" for="mobile-sam-grid">{words.samGrid}</label>
              <select id="mobile-sam-grid" bind:value={samGridSize} disabled={maskBusy}>
                <option value={2}>2 × 2</option><option value={3}>3 × 3</option><option value={4}>4 × 4</option>
                <option value={5}>5 × 5</option><option value={6}>6 × 6</option>
              </select>
              <button type="button" class="btn" onclick={generateMobileSamMasks} disabled={maskBusy || !samEncoderFile || !samDecoderFile}>{words.samGenerate}</button>
              {#if samProgress}<span class="muted tiny" role="status" aria-live="polite">{samProgress}</span>{/if}
            </div>
            <details class="sam-artifacts">
              <summary class="muted tiny">{words.samSource}</summary>
              <p class="tiny"><a href="https://huggingface.co/Acly/MobileSAM" target="_blank" rel="noreferrer">Acly/MobileSAM · MIT</a></p>
              <p class="tiny">{MOBILE_SAM_ARTIFACTS.encoder.file} · SHA-256 <code>{MOBILE_SAM_ARTIFACTS.encoder.sha256}</code></p>
              <p class="tiny">{MOBILE_SAM_ARTIFACTS.decoder.file} · SHA-256 <code>{MOBILE_SAM_ARTIFACTS.decoder.sha256}</code></p>
            </details>
            {#if samProposals.length}
              <div class="sam-proposals" aria-label={words.samTitle}>
                {#each samProposals as proposal, index}
                  <button type="button" class="sam-proposal" aria-pressed={samPreviewIndex === index} onclick={() => previewMobileSamProposal(index)} disabled={maskBusy}>
                    <img src={proposal.previewUrl} alt="" /><span>{words.samProposal(index + 1, proposal.score?.value ?? 0)}</span>
                  </button>
                {/each}
              </div>
              <button type="button" class="btn" onclick={usePreviewedMobileSamMask} disabled={samPreviewIndex < 0 || maskBusy}>{words.samApplyProposal}</button>
            {/if}
          </div>
          {#if objectProviderComparisonMessage}
            <p class="muted tiny" role="status">{objectProviderComparisonMessage}</p>
          {/if}
          <div class="sam-panel" aria-labelledby="planar-color-title">
            <h4 id="planar-color-title" class="h3">{planarWords.title}</h4>
            <p class="muted tiny">{planarWords.description}</p>
            <div class="row mask-controls">
              <button type="button" class="btn" onclick={generatePlanarColorMasks} disabled={maskBusy || !sourceImage}>{planarWords.run}</button>
            </div>
            {#if planarProposals.length}
              <div class="sam-proposals" aria-label={planarWords.title}>
                {#each planarProposals as proposal, index}
                  <button type="button" class="sam-proposal" aria-pressed={planarPreviewIndex === index} onclick={() => previewPlanarColorHypothesis(index)} disabled={maskBusy}>
                    <img src={proposal.previewUrl} alt="" /><span>{planarWords.candidate(index + 1, planarDiagnostics?.paintFit?.model ?? 'unknown')}</span>
                  </button>
                {/each}
              </div>
              <button type="button" class="btn" onclick={usePreviewedPlanarColorHypothesis} disabled={planarPreviewIndex < 0 || maskBusy}>{words.samApplyProposal}</button>
              {#if planarDiagnostics?.paintFit?.bottomToTop}
                <p class="muted tiny">{planarDiagnostics.paintFit.bottomToTop.join(' → ')}</p>
              {/if}
              {#if planarDiagnostics?.warnings.length}
                <ul class="muted tiny">{#each planarDiagnostics.warnings as warning}<li>{warning}</li>{/each}</ul>
              {/if}
            {/if}
          </div>
          <div class="sam-panel" aria-labelledby="circle-overlap-title">
            <h4 id="circle-overlap-title" class="h3">{circleWords.title}</h4>
            <p class="muted tiny">{circleWords.description}</p>
            <div class="row mask-controls">
              <button type="button" class="btn" onclick={generateCircleOverlapMasks} disabled={maskBusy || !sourceImage}>{circleWords.run}</button>
            </div>
            {#if circleProposals.length}
              <div class="sam-proposals" aria-label={circleWords.title}>
                {#each circleProposals as proposal, index}
                  <button type="button" class="sam-proposal" aria-pressed={circlePreviewIndex === index} onclick={() => previewCircleHypothesis(index)} disabled={maskBusy}>
                    <img src={proposal.previewUrl} alt="" /><span>{circleWords.candidate(index + 1, (proposal.score?.value ?? 0) * 100)}</span>
                  </button>
                {/each}
              </div>
              <button type="button" class="btn" onclick={usePreviewedCircleHypothesis} disabled={circlePreviewIndex < 0 || maskBusy}>{words.samApplyProposal}</button>
              {#if circleDiagnostics?.orderFit}
                <p class="muted tiny">{circleDiagnostics.orderFit.orderIdentifiable && circleDiagnostics.orderFit.bottomToTop
                  ? circleWords.order(circleDiagnostics.orderFit.bottomToTop.join(' → '), circleDiagnostics.orderFit.margin)
                  : circleWords.orderAmbiguous(circleDiagnostics.orderFit.margin)}</p>
              {/if}
              {#if circleDiagnostics?.warnings.length}<p class="muted tiny">{circleWords.warning}</p>{/if}
            {/if}
          </div>
          {#if maskMessage}<span class="small" aria-live="polite">{maskBusy ? words.running : maskMessage}</span>{/if}
        </div>
        {#if maskPreviewUrl}
          <figure class="mask-preview" style={`aspect-ratio: ${sourceImage.width} / ${sourceImage.height}`}>
            <img class="mask-source" src={sourceImage.url} alt="" />
            <img class="mask-overlay" src={maskPreviewUrl} alt={words.maskPreview} />
            <figcaption class="muted tiny">{words.maskPreview}</figcaption>
          </figure>
        {/if}
      </section>
    {/if}
    <div class="result-summary"><span aria-live="polite" class="small">{output.groups.length ? words.count(output.groups.length) : words.empty}</span><span class="muted tiny">{words.details(output.considered, output.skipped)}</span></div>
    {#if output.limit === 'singleton-count'}<span role="status" class="small">{words.singletonLimit}</span>{:else if output.limit}<span role="status" class="small">{words.limit(output.limit)}</span>{/if}
    {#if busy}<span role="status" class="muted tiny">{words.previewing}</span>{/if}
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
            <p class="muted tiny hierarchy-hint">{words.hierarchy}</p>
            <label class="small" for="group-search">{words.search}</label>
            <input id="group-search" type="search" value={search} oninput={changeSearch} />
            <div class="between"><span class="small">{words.list}</span><span class="muted tiny">{visibleGroups.length} / {levelGroups.length}</span></div>
          </div>
          <div class="group-items" role="tree" aria-label={words.list}>
            {#each visibleGroups as group, index (group.id)}
              <button type="button" role="treeitem" aria-level={groupLevel === 'all' && group.parentId ? 2 : 1} aria-selected={selected === group.id} tabindex={selected === group.id || (selectedIndex < 0 && index === 0) ? 0 : -1} data-index={index} class="group-option" class:child={groupLevel === 'all' && !!group.parentId} onclick={() => (selected = group.id)} onkeydown={(event) => moveListSelection(event, index)}>
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
            <button type="button" class="btn protect-btn" aria-pressed={!!annotationFor(selectedGroup, selectedIndex).locked} onclick={toggleLock}>{annotationFor(selectedGroup, selectedIndex).locked ? words.unlock : words.protect}</button>
            {#if canMerge || canSplit || canSplitPaths}<div class="row structure-actions">
              {#if canMerge}<button type="button" class="btn" onclick={mergeWithNext}>{words.merge}</button>{/if}
              {#if canSplit}<button type="button" class="btn" onclick={splitSelected}>{words.split}</button>{/if}
              {#if canSplitPaths}<button type="button" class="btn" onclick={splitSelectedPaths}>{words.splitPaths}</button>{/if}
            </div>{/if}
            {#if selectedGroup.level === 0 && !annotationFor(selectedGroup, selectedIndex).locked}<div class="assembly-actions">
              <div class="row"><button type="button" class="btn" aria-pressed={assemblySelection.has(selectedGroup.id)} onclick={() => toggleAssemblyMember(selectedGroup!)}>{assemblySelection.has(selectedGroup.id) ? words.removeFromAssembly : words.addToAssembly}</button><span class="muted tiny">{assemblyCount} sélectionné{assemblyCount > 1 ? 's' : ''}</span></div>
              {#if assemblyCount >= 2}<div class="row"><button type="button" class="btn btn-primary" onclick={composeSelectedGroups} disabled={!canComposeAssembly}>{words.createAssembly(assemblyCount)}</button><button type="button" class="btn small-btn" onclick={clearAssemblySelection}>{words.clearAssembly}</button></div><span class="muted tiny">{words.assemblyHint}</span>{/if}
            </div>{/if}
            <label for="group-name" class="small">{words.name}</label>
            <input id="group-name" type="text" maxlength="80" value={annotationFor(selectedGroup, selectedIndex).name ?? labelFor(selectedGroup, selectedIndex)} oninput={renameSelected} disabled={!!annotationFor(selectedGroup, selectedIndex).locked} />
            <span class="muted tiny">{words.nameHint}</span>
            <label for="group-role" class="small">{words.role}</label>
            <input id="group-role" type="text" maxlength="80" value={annotationFor(selectedGroup, selectedIndex).role ?? ''} oninput={updateRole} disabled={!!annotationFor(selectedGroup, selectedIndex).locked} />
            <div class="pivot-fields">
              <label class="small" for="group-pivot-x">{words.pivotX}</label>
              <input id="group-pivot-x" type="number" step="any" value={annotationFor(selectedGroup, selectedIndex).pivot[0]} oninput={(event) => updatePivot(0, event)} disabled={!!annotationFor(selectedGroup, selectedIndex).locked} />
              <label class="small" for="group-pivot-y">{words.pivotY}</label>
              <input id="group-pivot-y" type="number" step="any" value={annotationFor(selectedGroup, selectedIndex).pivot[1]} oninput={(event) => updatePivot(1, event)} disabled={!!annotationFor(selectedGroup, selectedIndex).locked} />
            </div>
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
  .singleton-toggle { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; color: var(--muted); font-size: 12px; }
  .singleton-toggle input { width: 15px; height: 15px; padding: 0; accent-color: var(--accent); }
  .distance-slider { width: min(180px, 20vw); }
  .result-summary { display: flex; gap: 16px; align-items: baseline; flex-wrap: wrap; }
  .mask-tool { display: grid; grid-template-columns: minmax(260px, 1fr) minmax(180px, 280px); gap: 16px; align-items: center; padding: 14px; border: 1px solid var(--line-2); border-radius: 12px; background: var(--surface-2); }
  .mask-copy { min-width: 0; display: flex; flex-direction: column; align-items: flex-start; gap: 8px; }
  .mask-copy p { margin: 0; line-height: 1.45; }
  .sam-panel { width: 100%; display: flex; flex-direction: column; align-items: flex-start; gap: 8px; margin-top: 8px; padding: 12px; border: 1px solid var(--line-2); border-radius: 9px; background: var(--surface); }
  .sam-panel h4 { font-size: 14px; }
  .sam-panel > p { margin: 0; line-height: 1.45; }
  .model-file-name { max-width: 100%; overflow-wrap: anywhere; }
  .sam-artifacts { width: 100%; }
  .sam-artifacts p { margin: 6px 0 0; overflow-wrap: anywhere; }
  .sam-artifacts code { user-select: all; }
  .sam-proposals { display: grid; width: 100%; grid-template-columns: repeat(auto-fill, minmax(86px, 1fr)); gap: 7px; }
  .sam-proposal { min-width: 0; display: flex; flex-direction: column; align-items: stretch; gap: 4px; padding: 5px; text-align: left; border: 1px solid var(--line-2); border-radius: 7px; background: var(--checker); color: var(--text); }
  .sam-proposal[aria-pressed='true'] { border-color: var(--accent); outline: 1px solid var(--accent); }
  .sam-proposal img { width: 100%; aspect-ratio: 1.5; object-fit: contain; }
  .sam-proposal span { font-size: 11px; }
  .mask-controls { flex-wrap: wrap; }
  .mask-file { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; clip-path: inset(50%); }
  .mask-file:focus-visible + label { outline: 2px solid var(--accent); outline-offset: 2px; }
  .mask-preview { position: relative; width: 100%; max-height: 180px; margin: 0; overflow: hidden; border: 1px solid var(--line-2); border-radius: 9px; background: var(--checker); }
  .mask-preview img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
  .mask-preview .mask-overlay { pointer-events: none; }
  .mask-preview figcaption { position: absolute; left: 4px; bottom: 4px; padding: 3px 5px; border-radius: 4px; background: var(--surface); }
  .manager { display: grid; grid-template-columns: minmax(260px, 0.8fr) minmax(0, 1.2fr); gap: 18px; min-height: 420px; }
  .group-list, .group-detail { min-width: 0; border: 1px solid var(--line-2); border-radius: 12px; }
  .group-list { display: flex; flex-direction: column; overflow: hidden; }
  .list-controls { padding: 12px; display: grid; grid-template-columns: auto minmax(0,1fr); align-items: center; gap: 8px 12px; border-bottom: 1px solid var(--line-2); }
  .list-controls > label:nth-of-type(2), .list-controls > .between { grid-column: 1 / -1; }
  .list-controls > .between { margin-top: 4px; }
  .hierarchy-hint { grid-column: 1 / -1; margin: 0; }
  .group-items { overflow: auto; max-height: 540px; padding: 6px; }
  .group-option { width: 100%; min-height: 38px; display: flex; align-items: center; gap: 9px; text-align: left; padding: 7px 9px; border: 1px solid transparent; border-radius: 8px; background: transparent; color: var(--text); }
  .group-option:hover { background: var(--surface-2); }
  .group-option[aria-selected='true'] { background: var(--surface-2); border-color: var(--accent-line); }
  .group-option.child { padding-left: 22px; }
  .option-text { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 13px; }
  .branch { color: var(--muted); margin-right: 5px; }
  .swatch { width: 12px; height: 12px; flex: 0 0 12px; border: 1px solid var(--line-3); border-radius: 4px; }
  .no-results { padding: 8px 12px; }
  .group-detail { padding: 16px; display: flex; flex-direction: column; align-items: stretch; gap: 10px; }
  .assembly-actions { display: flex; flex-direction: column; align-items: flex-start; gap: 7px; padding: 9px; border: 1px solid var(--line-2); border-radius: 9px; background: var(--surface-2); }
  .pivot-fields { display: grid; grid-template-columns: auto minmax(0, 1fr) auto minmax(0, 1fr); align-items: center; gap: 8px; }
  .detail-heading { align-items: flex-start; }
  .protect-btn { align-self: flex-start; }
  .nav { flex-shrink: 0; }
  .small { font-size: 13px; }
  .tiny { font-size: 12px; }
  .group-review input, .group-review select { max-width: 100%; min-width: 0; padding: 8px; color: var(--text); background: var(--surface-2); border: 1px solid var(--line-2); border-radius: 8px; }
  .preview { flex: 1; min-height: 250px; max-height: 420px; background: var(--checker); border: 1px solid var(--line-2); border-radius: 12px; }
  .preview img { width: 100%; height: 100%; object-fit: contain; }
  @media (max-width: 760px) { .heading { align-items: flex-start; flex-direction: column; gap: 12px; } .run-controls { flex-wrap: wrap; } .manager { grid-template-columns: minmax(0,1fr); } .mask-tool { grid-template-columns: minmax(0,1fr); } .mask-preview { max-width: 280px; } .group-items { max-height: 300px; } .preview { min-height: 220px; } }
</style>
