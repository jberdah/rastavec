import type { RGBAImage } from './core'
import type {
  ObjectHypothesis,
  ObjectPathAssociation,
  ObjectPathAssociationStatus,
  ObjectPathSupportBasis,
} from './object-hypotheses'
import type { BinarySegmentationMask } from './segmentation-mask'

export interface TracedPathInfo {
  id: string
  /** Counts every SVG path element, including clip-path definitions, to match existing path indices. */
  pathIndex: number
  /** Order among painted SVG elements (rectangles included); null for definitions. */
  paintOrder: number | null
  definition: boolean
  fill: string | null
  effectiveOpacity: number
  transformChain: string[]
  clipPathIds: string[]
}

export interface TracedPathSupport {
  pathId: string
  pathIndex: number
  /** Path geometry with transforms and clips applied, before occlusion by sibling paint. */
  geometricSupport: BinarySegmentationMask
  /** Path alpha contribution after SVG paint order and group opacity are applied. */
  visibleSupport: BinarySegmentationMask
}

export interface PathRasterizationDiagnostics {
  sourceWidth: number
  sourceHeight: number
  analysisWidth: number
  analysisHeight: number
  totalSvgPaths: number
  paintedPaths: number
  renderedPaintElements: number
  rendererCalls: number
  maxRenderConcurrency: number
  elapsedMs: number
  rasterSampleBudget: number
}

export type PathRasterizationResult =
  | { status: 'ready'; paths: TracedPathInfo[]; supports: TracedPathSupport[]; diagnostics: PathRasterizationDiagnostics }
  | { status: 'abstained' | 'error'; reason: string; paths: TracedPathInfo[]; supports: []; diagnostics?: PathRasterizationDiagnostics }

export interface PathHypothesisAssociationEdge extends ObjectPathAssociation {
  hypothesisId: string
}

export interface PathHypothesisAssociationSummary {
  hypotheses: number
  paintedPaths: number
  supporting: number
  partial: number
  ambiguous: number
  unrelated: number
  pathsWithAtLeastOneNonUnrelatedAssociation: number
  unassociatedPaths: number
}

export interface PathHypothesisAssociationResult {
  edges: PathHypothesisAssociationEdge[]
  /** Hypotheses are cloned; provider-owned masks and objects are not mutated. */
  hypotheses: ObjectHypothesis[]
  summary: PathHypothesisAssociationSummary
}

export type SvgRasterizer = (svg: string, width: number, height: number) => Promise<RGBAImage>

interface TagToken {
  name: string
  raw: string
  start: number
  end: number
  closing: boolean
  selfClosing: boolean
  attributes: Record<string, string>
}

interface PaintLeaf {
  kind: 'path' | 'rect'
  id: string
  pathIndex: number | null
  paintOrder: number
  token: TagToken
  alpha: Float32Array | null
}

interface PaintGroup {
  kind: 'group'
  opacity: number
  token: TagToken
  children: Array<PaintGroup | PaintLeaf>
  alpha: Float32Array | null
}

interface ParsedTrace {
  root: PaintGroup
  paths: TracedPathInfo[]
  paintedPathEntries: PaintLeaf[]
  paintEntries: PaintLeaf[]
  groupTokens: TagToken[]
  totalSvgPaths: number
}

const DEFINITION_CONTAINERS = new Set(['defs', 'clippath', 'mask', 'symbol', 'pattern', 'marker'])
const NON_PAINTING_CONTAINERS = new Set(['title', 'desc', 'metadata'])
const UNSUPPORTED_EFFECT_ATTRIBUTES = new Set([
  'class', 'display', 'filter', 'marker-end', 'marker-mid', 'marker-start', 'mask',
  'mix-blend-mode', 'stroke', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-linecap',
  'stroke-linejoin', 'stroke-miterlimit', 'stroke-opacity', 'stroke-width', 'style',
  'vector-effect', 'visibility',
])

const roundTo = (value: number, places = 4) => {
  const scale = 10 ** places
  return Math.round(value * scale) / scale
}

function parseOpacity(value: string | undefined, fallback = 1): number | null {
  if (value === undefined) return fallback
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 && number <= 1 ? number : null
}

function parseAttributes(raw: string): Record<string, string> {
  const body = raw.slice(1, raw.length - (raw.endsWith('/>') ? 2 : 1)).replace(/^\s*\/?\s*[A-Za-z][\w:.-]*/, '')
  const attributes: Record<string, string> = {}
  const expression = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  for (const match of body.matchAll(expression)) attributes[match[1].toLowerCase()] = match[2] ?? match[3] ?? ''
  return attributes
}

function scanTags(svg: string): TagToken[] | string {
  const tags: TagToken[] = []
  let cursor = 0
  while (cursor < svg.length) {
    const start = svg.indexOf('<', cursor)
    if (start < 0) break
    if (svg.startsWith('<!--', start)) {
      const end = svg.indexOf('-->', start + 4)
      if (end < 0) return 'The traced SVG contains an unterminated comment.'
      cursor = end + 3
      continue
    }
    if (svg.startsWith('<!', start) || svg.startsWith('<?', start)) {
      const end = svg.indexOf('>', start + 2)
      if (end < 0) return 'The traced SVG contains an unterminated declaration.'
      cursor = end + 1
      continue
    }
    let end = start + 1, quote = ''
    for (; end < svg.length; end++) {
      const character = svg[end]
      if (quote) {
        if (character === quote) quote = ''
      } else if (character === '"' || character === "'") quote = character
      else if (character === '>') break
    }
    if (end >= svg.length || quote) return 'The traced SVG contains an unterminated tag.'
    const raw = svg.slice(start, end + 1)
    const nameMatch = raw.match(/^<\s*(\/?)\s*([A-Za-z][\w:.-]*)/)
    if (!nameMatch) return 'The traced SVG contains a tag that cannot be parsed safely.'
    const closing = nameMatch[1] === '/'
    const name = nameMatch[2].toLowerCase()
    const selfClosing = !closing && /\/\s*>$/.test(raw)
    tags.push({ name, raw, start, end: end + 1, closing, selfClosing, attributes: closing ? {} : parseAttributes(raw) })
    cursor = end + 1
  }
  return tags
}

function clipIds(value: string | undefined): string[] {
  if (!value) return []
  return [...value.matchAll(/url\(\s*['"]?#([^)'"\s]+)['"]?\s*\)/g)].map((match) => match[1])
}

function unsupportedAttributes(tag: TagToken): string | null {
  const bad = Object.keys(tag.attributes).find((name) => UNSUPPORTED_EFFECT_ATTRIBUTES.has(name))
  return bad ? `The traced SVG uses unsupported paint attribute "${bad}".` : null
}

function parseTrace(svg: string): ParsedTrace | { error: string; paths: TracedPathInfo[] } {
  const tokens = scanTags(svg)
  if (typeof tokens === 'string') return { error: tokens, paths: [] }
  const rootTag = tokens.find((token) => token.name === 'svg' && !token.closing)
  if (!rootTag || !/<svg\b/i.test(svg)) return { error: 'The traced SVG has no SVG root.', paths: [] }
  const rootOpacity = parseOpacity(rootTag.attributes.opacity)
  if (rootOpacity === null) return { error: 'The traced SVG root has an invalid opacity.', paths: [] }
  const root: PaintGroup = { kind: 'group', opacity: rootOpacity, token: rootTag, children: [], alpha: null }
  const groupTokens = [rootTag]
  const stack: Array<{
    name: string
    inDefinition: boolean
    group: PaintGroup | null
    opacityProduct: number
    fill: string | null
    fillOpacity: number
    transformChain: string[]
    clipPathIds: string[]
  }> = []
  const paths: TracedPathInfo[] = []
  const paintedPathEntries: PaintLeaf[] = []
  const paintEntries: PaintLeaf[] = []
  let totalSvgPaths = 0, paintOrder = 0, seenRoot = false

  for (const token of tokens) {
    if (token.closing) {
      const top = stack.pop()
      if (!top || top.name !== token.name) return { error: `The traced SVG has mismatched closing tag </${token.name}>.`, paths }
      continue
    }
    const parent = stack.at(-1)
    if (!parent) {
      if (seenRoot || token.name !== 'svg' || token !== rootTag) return { error: 'The traced SVG has content outside its root element.', paths }
      seenRoot = true
      const context = {
        name: token.name,
        inDefinition: false,
        group: root,
        opacityProduct: rootOpacity,
        fill: token.attributes.fill ?? null,
        fillOpacity: parseOpacity(token.attributes['fill-opacity']) ?? 1,
        transformChain: token.attributes.transform ? [token.attributes.transform] : [],
        clipPathIds: clipIds(token.attributes['clip-path']),
      }
      if (!token.selfClosing) stack.push(context)
      continue
    }

    const inDefinition = parent.inDefinition || DEFINITION_CONTAINERS.has(token.name)
    if ((token.name === 'style' || token.name === 'script' || token.name === 'foreignobject' || token.name === 'use' || token.name === 'image') && !inDefinition)
      return { error: `The traced SVG contains unsupported rendered element <${token.name}>.`, paths }
    if (token.name === 'path') {
      const pathIndex = totalSvgPaths++
      const id = `trace-path-${String(pathIndex).padStart(4, '0')}`
      const bad = !inDefinition ? unsupportedAttributes(token) : null
      if (bad) return { error: bad, paths }
      if (!token.attributes.d || !token.selfClosing) return { error: 'Only self-closing RastaVec path elements with data are supported.', paths }
      const ownOpacity = parseOpacity(token.attributes.opacity)
      const ownFillOpacity = parseOpacity(token.attributes['fill-opacity'], parent.fillOpacity)
      if (ownOpacity === null || ownFillOpacity === null) return { error: `Path ${pathIndex} has invalid opacity.`, paths }
      const paintOrderForPath = inDefinition ? null : paintOrder++
      paths.push({
        id,
        pathIndex,
        paintOrder: paintOrderForPath,
        definition: inDefinition,
        fill: token.attributes.fill ?? parent.fill,
        effectiveOpacity: roundTo(parent.opacityProduct * ownOpacity * ownFillOpacity),
        transformChain: [...parent.transformChain, ...(token.attributes.transform ? [token.attributes.transform] : [])],
        clipPathIds: [...parent.clipPathIds, ...clipIds(token.attributes['clip-path'])],
      })
      if (!inDefinition) {
        const leaf: PaintLeaf = { kind: 'path', id, pathIndex, paintOrder: paintOrderForPath!, token, alpha: null }
        ;(parent.group ?? root).children.push(leaf)
        paintedPathEntries.push(leaf)
        paintEntries.push(leaf)
      }
      continue
    }
    if (token.name === 'rect') {
      if (!inDefinition) {
        const bad = unsupportedAttributes(token)
        if (bad) return { error: bad, paths }
        const leaf: PaintLeaf = { kind: 'rect', id: `paint-rect-${paintOrder}`, pathIndex: null, paintOrder: paintOrder++, token, alpha: null }
        ;(parent.group ?? root).children.push(leaf)
        paintEntries.push(leaf)
      }
      if (!token.selfClosing && !inDefinition) return { error: 'Only self-closing RastaVec rectangles are supported.', paths }
      continue
    }
    if (token.name === 'g' && !inDefinition) {
      const bad = unsupportedAttributes(token)
      if (bad) return { error: bad, paths }
      const opacity = parseOpacity(token.attributes.opacity)
      if (opacity === null) return { error: 'The traced SVG has an invalid group opacity.', paths }
      const group: PaintGroup = { kind: 'group', opacity, token, children: [], alpha: null }
      ;(parent.group ?? root).children.push(group)
      groupTokens.push(token)
      const fillOpacity = parseOpacity(token.attributes['fill-opacity'], parent.fillOpacity)
      if (fillOpacity === null) return { error: 'The traced SVG has an invalid fill opacity.', paths }
      const context = {
        name: token.name,
        inDefinition: false,
        group,
        opacityProduct: parent.opacityProduct * opacity,
        fill: token.attributes.fill ?? parent.fill,
        fillOpacity,
        transformChain: [...parent.transformChain, ...(token.attributes.transform ? [token.attributes.transform] : [])],
        clipPathIds: [...parent.clipPathIds, ...clipIds(token.attributes['clip-path'])],
      }
      if (!token.selfClosing) stack.push(context)
      continue
    }

    if (!inDefinition && !['svg', 'title', 'desc', 'metadata'].includes(token.name))
      return { error: `The traced SVG contains unsupported rendered element <${token.name}>.`, paths }
    if (token.name === 'svg' && token !== rootTag) return { error: 'Nested SVG roots are not supported for path association.', paths }
    const fillOpacity = parseOpacity(token.attributes['fill-opacity'], parent.fillOpacity)
    if (fillOpacity === null) return { error: 'The traced SVG has an invalid fill opacity.', paths }
    const context = {
      name: token.name,
      inDefinition,
      group: inDefinition ? null : parent.group,
      opacityProduct: parent.opacityProduct,
      fill: token.attributes.fill ?? parent.fill,
      fillOpacity,
      transformChain: [...parent.transformChain, ...(token.attributes.transform ? [token.attributes.transform] : [])],
      clipPathIds: [...parent.clipPathIds, ...clipIds(token.attributes['clip-path'])],
    }
    if (!token.selfClosing) stack.push(context)
  }
  if (stack.length) return { error: `The traced SVG has an unclosed <${stack.at(-1)!.name}> element.`, paths }
  if (!seenRoot) return { error: 'The traced SVG root is empty or malformed.', paths }
  return { root, paths, paintedPathEntries, paintEntries, groupTokens, totalSvgPaths }
}

/** Inspect paint order and inherited context from a RastaVec-produced SVG without reading source artwork. */
export function inspectTracedSvgPaths(svg: string): { status: 'ready'; paths: TracedPathInfo[]; totalSvgPaths: number; paintedPaths: number } | { status: 'unsupported'; reason: string; paths: TracedPathInfo[]; totalSvgPaths: number } {
  const parsed = parseTrace(svg)
  if ('error' in parsed) return { status: 'unsupported', reason: parsed.error, paths: parsed.paths, totalSvgPaths: parsed.paths.length }
  return { status: 'ready', paths: parsed.paths, totalSvgPaths: parsed.totalSvgPaths, paintedPaths: parsed.paintedPathEntries.length }
}

function removeGroupOpacity(raw: string): string {
  return raw.replace(/(\sopacity\s*=\s*)(["'])[^"']*\2/i, '$1"1"')
}

function isolatedSvg(svg: string, parsed: ParsedTrace, target: PaintLeaf): string {
  const edits: Array<{ start: number; end: number; replacement: string }> = []
  for (const token of parsed.groupTokens) {
    const modified = removeGroupOpacity(token.raw)
    if (modified !== token.raw) edits.push({ start: token.start, end: token.end, replacement: modified })
  }
  for (const entry of parsed.paintEntries) if (entry !== target)
    edits.push({ start: entry.token.start, end: entry.token.end, replacement: '' })
  edits.sort((a, b) => b.start - a.start)
  let result = svg
  for (const edit of edits) result = `${result.slice(0, edit.start)}${edit.replacement}${result.slice(edit.end)}`
  return result
}

function validImage(image: RGBAImage, width: number, height: number): boolean {
  return image.width === width && image.height === height && image.data.length === width * height * 4
}

function computeGroupAlpha(node: PaintGroup | PaintLeaf, pixels: number): Float32Array {
  if (node.kind !== 'group') return node.alpha ?? new Float32Array(pixels)
  const childAlphas = node.children.map((child) => computeGroupAlpha(child, pixels))
  const output = new Float32Array(pixels)
  for (let pixel = 0; pixel < pixels; pixel++) {
    let transmittance = 1
    for (const alpha of childAlphas) transmittance *= 1 - alpha[pixel]
    output[pixel] = (1 - transmittance) * node.opacity
  }
  node.alpha = output
  return output
}

function propagateVisibleContributions(
  node: PaintGroup | PaintLeaf,
  factor: Float32Array,
  pixels: number,
  visibleThreshold: number,
  masks: Map<string, Uint8Array>,
): void {
  if (node.kind !== 'group') {
    if (node.kind !== 'path') return
    const visible = masks.get(node.id) ?? new Uint8Array(pixels)
    const alpha = node.alpha ?? new Float32Array(pixels)
    for (let pixel = 0; pixel < pixels; pixel++) if (alpha[pixel] * factor[pixel] >= visibleThreshold) visible[pixel] = 1
    masks.set(node.id, visible)
    return
  }
  const laterTransmittance = new Float32Array(pixels).fill(1)
  for (let index = node.children.length - 1; index >= 0; index--) {
    const child = node.children[index]
    const childFactor = new Float32Array(pixels)
    for (let pixel = 0; pixel < pixels; pixel++) childFactor[pixel] = factor[pixel] * node.opacity * laterTransmittance[pixel]
    propagateVisibleContributions(child, childFactor, pixels, visibleThreshold, masks)
    const childAlpha = child.alpha ?? new Float32Array(pixels)
    for (let pixel = 0; pixel < pixels; pixel++) laterTransmittance[pixel] *= 1 - childAlpha[pixel]
  }
}

/** Rasterize paths in their original SVG context: inherited fills, transforms and clip paths are retained. */
export async function rasterizeTracedPathSupports(
  svg: string,
  rasterize: SvgRasterizer,
  sourceWidth: number,
  sourceHeight: number,
  options: { maxDimension?: number; maxPixels?: number; maxPaths?: number; maxRasterSamples?: number; visibleAlphaThreshold?: number; renderConcurrency?: number } = {},
): Promise<PathRasterizationResult> {
  const parsed = parseTrace(svg)
  const pathInfo = 'error' in parsed ? parsed.paths : parsed.paths
  const fail = (status: 'abstained' | 'error', reason: string, diagnostics?: PathRasterizationDiagnostics): PathRasterizationResult => ({ status, reason, paths: pathInfo, supports: [], ...(diagnostics ? { diagnostics } : {}) })
  if ('error' in parsed) return fail('abstained', parsed.error)
  if (!Number.isSafeInteger(sourceWidth) || !Number.isSafeInteger(sourceHeight) || sourceWidth < 1 || sourceHeight < 1)
    return fail('error', 'Source raster dimensions must be positive integers.')
  if (!parsed.paintedPathEntries.length) return fail('abstained', 'The trace has no painted paths to associate.')
  const maxDimension = options.maxDimension ?? 512
  const maxPixels = options.maxPixels ?? 512 * 512
  const maxPaths = options.maxPaths ?? 512
  const maxRasterSamples = options.maxRasterSamples ?? 20_000_000
  const visibleAlphaThreshold = options.visibleAlphaThreshold ?? 8 / 255
  const renderConcurrency = options.renderConcurrency ?? 4
  if (!Number.isSafeInteger(maxDimension) || maxDimension < 1 || !Number.isSafeInteger(maxPixels) || maxPixels < 1 || !Number.isSafeInteger(maxPaths) || maxPaths < 1 || !Number.isSafeInteger(maxRasterSamples) || maxRasterSamples < 1
    || !Number.isSafeInteger(renderConcurrency) || renderConcurrency < 1 || renderConcurrency > 8)
    return fail('error', 'Path rasterization limits must be positive integers.')
  if (!Number.isFinite(visibleAlphaThreshold) || visibleAlphaThreshold < 0 || visibleAlphaThreshold > 1)
    return fail('error', 'The visible alpha threshold must be between 0 and 1.')
  if (parsed.paintedPathEntries.length > maxPaths)
    return fail('abstained', `The trace has ${parsed.paintedPathEntries.length} painted paths, above the ${maxPaths}-path association limit.`)

  const sourcePixels = sourceWidth * sourceHeight
  const pixelScale = Math.min(
    1,
    maxDimension / Math.max(sourceWidth, sourceHeight),
    Math.sqrt(maxPixels / sourcePixels),
    Math.sqrt(maxRasterSamples / (parsed.paintEntries.length * sourcePixels)),
  )
  const width = Math.max(1, Math.floor(sourceWidth * pixelScale))
  const height = Math.max(1, Math.floor(sourceHeight * pixelScale))
  const pixels = width * height
  const estimatedSamples = parsed.paintEntries.length * pixels
  const diagnostics: PathRasterizationDiagnostics = {
    sourceWidth, sourceHeight, analysisWidth: width, analysisHeight: height,
    totalSvgPaths: parsed.totalSvgPaths, paintedPaths: parsed.paintedPathEntries.length,
    renderedPaintElements: parsed.paintEntries.length, rendererCalls: 0, maxRenderConcurrency: renderConcurrency, elapsedMs: 0, rasterSampleBudget: maxRasterSamples,
  }
  if (estimatedSamples > maxRasterSamples)
    return fail('abstained', `Isolating ${parsed.paintEntries.length} paint elements at ${width}×${height} exceeds the ${maxRasterSamples.toLocaleString('en-US')}-sample work budget.`, diagnostics)

  const geometryMasks = new Map<string, Uint8Array>()
  const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now()
  try {
    for (let start = 0; start < parsed.paintEntries.length; start += renderConcurrency) {
      const batch = parsed.paintEntries.slice(start, start + renderConcurrency)
      const rendered = await Promise.all(batch.map(async (entry) => {
        const image = await rasterize(isolatedSvg(svg, parsed, entry), width, height)
        diagnostics.rendererCalls++
        return { entry, image }
      }))
      for (const { entry, image } of rendered) {
        if (!validImage(image, width, height)) return fail('error', 'The SVG rasterizer returned invalid dimensions or RGBA data.', diagnostics)
        const alpha = new Float32Array(pixels)
        for (let pixel = 0; pixel < pixels; pixel++) {
          const value = image.data[pixel * 4 + 3] / 255
          alpha[pixel] = value
        }
        entry.alpha = alpha
        if (entry.kind === 'path') {
          const geometry = new Uint8Array(pixels)
          for (let pixel = 0; pixel < pixels; pixel++) if (alpha[pixel] > 0) geometry[pixel] = 1
          geometryMasks.set(entry.id, geometry)
        }
      }
    }
  } catch (error) {
    diagnostics.elapsedMs = roundTo((typeof performance !== 'undefined' ? performance.now() : Date.now()) - startedAt, 2)
    return fail('error', error instanceof Error ? error.message : String(error), diagnostics)
  }
  diagnostics.elapsedMs = roundTo((typeof performance !== 'undefined' ? performance.now() : Date.now()) - startedAt, 2)

  computeGroupAlpha(parsed.root, pixels)
  const factors = new Float32Array(pixels).fill(1)
  const visibleMasks = new Map<string, Uint8Array>()
  propagateVisibleContributions(parsed.root, factors, pixels, visibleAlphaThreshold, visibleMasks)
  const supports = parsed.paintedPathEntries.map((entry) => ({
    pathId: entry.id,
    pathIndex: entry.pathIndex!,
    geometricSupport: { width, height, data: geometryMasks.get(entry.id) ?? new Uint8Array(pixels) },
    visibleSupport: { width, height, data: visibleMasks.get(entry.id) ?? new Uint8Array(pixels) },
  }))
  return { status: 'ready', paths: pathInfo, supports, diagnostics }
}

interface Coverage {
  pathCoverage: number
  hypothesisCoverage: number
  intersection: number
  pathPixels: number
  hypothesisPixels: number
}

function maskCoverage(path: BinarySegmentationMask, hypothesis: BinarySegmentationMask): Coverage {
  if (!path.width || !path.height || path.data.length !== path.width * path.height || !hypothesis.width || !hypothesis.height || hypothesis.data.length !== hypothesis.width * hypothesis.height)
    return { pathCoverage: 0, hypothesisCoverage: 0, intersection: 0, pathPixels: 0, hypothesisPixels: 0 }
  let intersection = 0, pathPixels = 0, hypothesisPixels = 0
  for (let y = 0; y < path.height; y++) for (let x = 0; x < path.width; x++) {
    const pathPixel = y * path.width + x
    const hx = Math.min(hypothesis.width - 1, Math.floor((x + 0.5) * hypothesis.width / path.width))
    const hy = Math.min(hypothesis.height - 1, Math.floor((y + 0.5) * hypothesis.height / path.height))
    const pathOn = path.data[pathPixel] !== 0
    const hypothesisOn = hypothesis.data[hy * hypothesis.width + hx] !== 0
    if (pathOn) pathPixels++
    if (hypothesisOn) hypothesisPixels++
    if (pathOn && hypothesisOn) intersection++
  }
  return {
    pathCoverage: pathPixels ? intersection / pathPixels : 0,
    hypothesisCoverage: hypothesisPixels ? intersection / hypothesisPixels : 0,
    intersection,
    pathPixels,
    hypothesisPixels,
  }
}

/** Build conservative many-to-many edges without mutating provider hypotheses or merging paths. */
export function associateTracedPathsToHypotheses(
  supports: readonly TracedPathSupport[],
  hypotheses: readonly ObjectHypothesis[],
  options: { minimumPathCoverage?: number; partialPathCoverage?: number; supportingPathCoverage?: number; ambiguityMargin?: number; minimumIntersectionPixels?: number } = {},
): PathHypothesisAssociationResult {
  const minimumPathCoverage = options.minimumPathCoverage ?? 0.05
  const partialPathCoverage = options.partialPathCoverage ?? 0.2
  const supportingPathCoverage = options.supportingPathCoverage ?? 0.75
  const ambiguityMargin = options.ambiguityMargin ?? 0.12
  const minimumIntersectionPixels = options.minimumIntersectionPixels ?? 3
  if (![minimumPathCoverage, partialPathCoverage, supportingPathCoverage, ambiguityMargin].every(Number.isFinite)
    || minimumPathCoverage < 0 || partialPathCoverage < minimumPathCoverage || supportingPathCoverage < partialPathCoverage || supportingPathCoverage > 1
    || ambiguityMargin < 0 || ambiguityMargin > 1 || !Number.isSafeInteger(minimumIntersectionPixels) || minimumIntersectionPixels < 1)
    throw new Error('Path association thresholds are invalid.')
  if (new Set(hypotheses.map(({ id }) => id)).size !== hypotheses.length)
    throw new Error('Object hypothesis IDs must be unique within a path association run.')

  const edges: PathHypothesisAssociationEdge[] = []
  for (const path of supports) for (const hypothesis of hypotheses) {
    const geometric = maskCoverage(path.geometricSupport, hypothesis.mask)
    const visible = maskCoverage(path.visibleSupport, hypothesis.mask)
    const supportBasis: ObjectPathSupportBasis = hypothesis.maskMeaning === 'visible-object'
      ? 'visible-support'
      : hypothesis.maskMeaning === 'completed-object' ? 'completed-geometry' : 'unknown-mask-meaning'
    const primary = supportBasis === 'visible-support' ? visible : supportBasis === 'completed-geometry' ? geometric
      : geometric.pathCoverage >= visible.pathCoverage ? geometric : visible
    const alternate = primary === geometric ? visible : geometric
    const relevant = geometric.intersection >= minimumIntersectionPixels || visible.intersection >= minimumIntersectionPixels
    const coverageRelevant = primary.pathCoverage >= minimumPathCoverage || primary.hypothesisCoverage >= partialPathCoverage
    let status: ObjectPathAssociationStatus
    let reason: string
    if (!relevant || (!coverageRelevant && geometric.pathCoverage < minimumPathCoverage && visible.pathCoverage < minimumPathCoverage)) {
      status = 'unrelated'
      reason = 'Neither geometric nor visible path support covers a meaningful share of this hypothesis.'
    } else if (hypothesis.maskMeaning === 'unknown') {
      status = 'ambiguous'
      reason = 'The provider did not declare whether its mask is visible-only or completed geometry.'
    } else if (primary.pathCoverage < partialPathCoverage && (alternate.pathCoverage >= supportingPathCoverage || alternate.hypothesisCoverage >= partialPathCoverage)) {
      status = 'ambiguous'
      reason = 'Geometric and rendered-visible support disagree for the declared mask meaning.'
    } else if (primary.pathCoverage >= supportingPathCoverage) {
      status = 'supporting'
      reason = `At least ${(supportingPathCoverage * 100).toFixed(0)}% of the path's declared ${supportBasis === 'visible-support' ? 'visible' : 'geometric'} support lies in this hypothesis.`
    } else if (primary.pathCoverage >= partialPathCoverage) {
      status = 'partial'
      reason = 'The path partly overlaps this hypothesis under its declared mask meaning.'
    } else if (primary.hypothesisCoverage >= partialPathCoverage) {
      status = 'ambiguous'
      reason = 'The path covers part of the hypothesis but extends broadly beyond it.'
    } else {
      status = 'ambiguous'
      reason = 'There is measurable overlap, but it is too weak for a supporting or partial association.'
    }
    const edge: PathHypothesisAssociationEdge = {
      hypothesisId: hypothesis.id,
      pathIndex: path.pathIndex,
      pathId: path.pathId,
      pathCoverage: roundTo(primary.pathCoverage),
      hypothesisCoverage: roundTo(primary.hypothesisCoverage),
      status,
      supportBasis,
      geometricPathCoverage: roundTo(geometric.pathCoverage),
      geometricHypothesisCoverage: roundTo(geometric.hypothesisCoverage),
      visiblePathCoverage: roundTo(visible.pathCoverage),
      visibleHypothesisCoverage: roundTo(visible.hypothesisCoverage),
      intersectionPixels: { geometric: geometric.intersection, visible: visible.intersection },
      reason,
    }
    edges.push(edge)
  }

  // A traced path with similar support in multiple same-meaning hypotheses should stay reviewable.
  for (const path of supports) {
    const candidates = edges.filter((edge) => edge.pathId === path.pathId && edge.supportBasis !== 'unknown-mask-meaning' && edge.status !== 'unrelated' && edge.pathCoverage >= partialPathCoverage)
      .sort((a, b) => b.pathCoverage - a.pathCoverage)
    if (candidates.length >= 2 && candidates[0].supportBasis === candidates[1].supportBasis
      && candidates[0].pathCoverage - candidates[1].pathCoverage <= ambiguityMargin) {
      for (const edge of candidates) {
        if (edge.supportBasis !== candidates[0].supportBasis || candidates[0].pathCoverage - edge.pathCoverage > ambiguityMargin) continue
        edge.status = 'ambiguous'
        edge.reason = 'This path has similarly strong support in multiple hypotheses with the same mask meaning.'
      }
    }
  }

  const edgesByHypothesis = new Map<string, ObjectPathAssociation[]>()
  for (const edge of edges) if (edge.status !== 'unrelated') {
    const { hypothesisId: _hypothesisId, ...association } = edge
    const list = edgesByHypothesis.get(edge.hypothesisId) ?? []
    list.push(association)
    edgesByHypothesis.set(edge.hypothesisId, list)
  }
  const associatedHypotheses = hypotheses.map((hypothesis) => ({
    ...hypothesis,
    pathAssociations: edgesByHypothesis.get(hypothesis.id) ?? [],
  }))
  const counts = { supporting: 0, partial: 0, ambiguous: 0, unrelated: 0 }
  for (const edge of edges) counts[edge.status]++
  const pathsWithAtLeastOneNonUnrelatedAssociation = new Set(edges.filter(({ status }) => status !== 'unrelated').map(({ pathId }) => pathId)).size
  return {
    edges,
    hypotheses: associatedHypotheses,
    summary: {
      hypotheses: hypotheses.length,
      paintedPaths: supports.length,
      ...counts,
      pathsWithAtLeastOneNonUnrelatedAssociation,
      unassociatedPaths: Math.max(0, supports.length - pathsWithAtLeastOneNonUnrelatedAssociation),
    },
  }
}
