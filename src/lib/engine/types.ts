import type { Analysis, NoteCode } from './analyze'
import type { FilterSettings } from './palette'

export type ColorMode = 'color' | 'binary'
export type CurveMode = 'spline' | 'polygon' | 'none'
export type ClusteringMode = 'color-cluster' | 'watershed'

/** Tracing parameters, in the same units as the Python `trace.py` helper. */
export interface TraceParams {
  /** Region layering within VTracer-Next. Missing in older sessions means stacked. */
  hierarchical?: 'stacked' | 'cutout'
  colormode: ColorMode
  /** Region clustering algorithm for color traces. Binary traces always use BW. */
  clustering: ClusteringMode
  /** VTracer Watershed cut detail, 0..255. */
  watershedDetail: number
  mode: CurveMode
  /** Cluster area threshold (N squared); nonzero also absorbs thin, thread-like patches. */
  speckle: number
  /** Significant bits per RGB channel, 1..8. */
  colorPrecision: number
  /** Color distance between gradient layers. */
  layerDifference: number
  /** Degrees. */
  cornerThreshold: number
  lengthThreshold: number
  /** Degrees. */
  spliceThreshold: number
  pathPrecision: number
  /** Pixels with alpha below this become fully transparent before tracing. */
  alphaFloor: number
  /** Alpha at or above which a pixel belongs to the silhouette that clips the result (1-255). */
  silhouetteCut: number
  /** Soft edges / glows below the silhouette cut, rendered as N semi-transparent layers (0 = off). */
  softLayers: number
  /** Trace the soft (semi-transparent) area in color instead of uniform bands. */
  softColor: boolean
  /** Re-encode paths compactly (relative coordinates, baked translate, short numbers). Visually lossless. */
  compactPaths: boolean
  /** Let the engine replace verified circles by exact shapes (color traces). Missing means on. */
  detectShapes?: boolean
}

export interface Metrics {
  width: number
  height: number
  /** Overlap of opaque areas (alpha >= 128). null when both are empty. */
  iou: number | null
  /** Mean absolute alpha difference, 0-255. */
  alphaDiff: number
  /** Mean absolute per-channel difference after compositing on white, 0-255. */
  rgbWhite: number
  /** Same on #202020. */
  rgbDark: number
  /** % of pixels whose worst-channel difference (either background) exceeds 32/255. */
  pctDiff: number
  /** Visible difference on a one-pixel band around source edges; diagnostic only. */
  edgePctDiff?: number
  /** % of pixels where the render shows a color step in an area the source keeps smooth (banding). */
  falseEdgePct?: number
  /** Share (0-1) of the image painted by gradients or exact circles / ellipses the engine reported. */
  editableShare?: number
  /** Drawn pixels of the render over drawn pixels of the source: those off the source's most
   *  common colour, on white. Near 0 for an empty result; undefined when the source draws nothing. */
  inkKept?: number
  bytes: number
  paths: number
  embeddedRaster: boolean
}

/**
 * A fact the tracing engine knows about one `<path>` of its SVG, so later stages need not
 * re-derive it from path data. `index` is the path's ordinal in the document.
 * Only paths with something to say are listed: exact circles and ellipses, gradient paints, overlays.
 */
export interface EngineShapeHint {
  index: number
  kind: 'path' | 'circle' | 'ellipse' | 'crescent'
  /** Centre, in viewBox units (circles and ellipses; a crescent's outer circle). */
  cx?: number
  cy?: number
  /** Circle radius (a crescent's outer radius). */
  r?: number
  /** A crescent's inner circle: the disc taken out of the outer one. */
  innerCx?: number
  innerCy?: number
  innerR?: number
  /** Ellipse semi-axes; `rotation` is the direction of `rx` in degrees, as in an SVG `rotate()`. */
  rx?: number
  ry?: number
  rotation?: number
  /** Gradient paint: the `id` of its element in the SVG. */
  gradient?: { id: string; type: 'linear' | 'radial'; stops: number; opaque: boolean }
  /** For a translucent gradient overlay: index of the opaque path it belongs to. */
  overlayOf?: number
  bounds: [number, number, number, number]
}

export interface Trial {
  /** True for the first trial (preset / Auto parameters), false for auto-tune candidates. */
  base: boolean
  /** Integer nearest-neighbour enlargement used before tracing (1 = original size). */
  traceScale?: number
  /** Identifies post-trace output variants such as pixel-grid or source-guided color correction. */
  traceMethod?: 'pixel-grid' | 'experimental-gradients' | 'simple-gradients' | 'fill-calibrated' | 'palette-calibrated' | 'paths-merged' | 'shapes-edited' | 'antialias-resolved'
  params: TraceParams
  svg: string
  /** Listed for comparison but never chosen automatically (see `choose`). */
  comparisonOnly?: boolean
  /** Engine hints for `svg`; dropped whenever a later pass renumbers its paths. */
  shapes?: EngineShapeHint[]
  /** For a 'shapes-edited' variant: index of the traced trial it was derived from. */
  sourceTrial?: number
  metrics: Metrics
  score: number
  ms: number
}

export interface GroupingMetadata {
  /** Fingerprint of the exact SVG this grouping was generated from. */
  sourceHash: string
  distance: number
  colorMode: 'proximity' | 'same-color'
  includeSingletons?: boolean
  strategy?: 'proximity' | 'spatial'
  regionCount?: number
  considered: number
  skipped: number
  svg: string
  groups: {
    id: string; key: string; pathIndices: number[]; count: number; bounds: [number, number, number, number]
    fill: string; zone: 'top-left' | 'top' | 'top-right' | 'left' | 'center' | 'right' | 'bottom-left' | 'bottom' | 'bottom-right'; level: 0 | 1; parentId?: string
    name: string; role?: string; locked?: boolean; pivot: [number, number]; fragmentIds?: string[]
    members?: { pathIndex: number; bounds: [number, number, number, number]; pivot: [number, number]; fill: string; zone: 'top-left' | 'top' | 'top-right' | 'left' | 'center' | 'right' | 'bottom-left' | 'bottom' | 'bottom-right' }[]
  }[]
}

export interface AnimationKeyframe {
  timeMs: number
  rotation: number
  /** Vertical translation in the group's SVG user units. Older sessions omit it. */
  translateY?: number
}

export interface AnimationTrack {
  groupId: string
  keyframes: AnimationKeyframe[]
}

/** Editable rotation animation, saved with the local session and independent from the traced SVG. */
export interface AnimationMetadata {
  durationMs: number
  easing?: 'linear' | 'ease-in-out'
  /** When set, play a sequence of existing batch items as full character poses. */
  mode?: 'parts' | 'frames'
  frameIds?: string[]
  /** Uniform playback rate for a pose sequence; durationMs is its derived loop length. */
  fps?: number
  tracks: AnimationTrack[]
}

export type ItemStatus = 'queued' | 'tracing' | 'prepared' | 'done' | 'error'

export interface Item {
  id: string
  name: string
  file: File
  srcUrl: string
  srcBytes: number
  width: number
  height: number
  /** % of meaningfully semi-transparent pixels (alpha 16-239). */
  semiPct: number
  status: ItemStatus
  /** Progress while tracing: "" while decoding, else "k/n" (trial k of n). */
  progress: string
  trials: Trial[]
  chosen: number
  autoTuned: boolean
  failedTrials?: { traceScale: number; message: string }[]
  error?: string
  /** Image analysis, computed once at import. */
  analysis?: Analysis
  /** Why the auto preset chose these parameters. */
  notes?: NoteCode[]
  /** Measurement of the exact final SVG, keyed to the trial, edits, and grouping markup. */
  outputMeasurement?: { key: string; metrics?: Metrics; error?: string }
  /** Palette filters (Edit screen), valid for one trial. */
  edit?: { settings: FilterSettings; trial: number }
  /** Reviewed proximity grouping for the current output SVG. */
  grouping?: GroupingMetadata
  /** Rotation keyframes authored in the Animate screen. */
  animation?: AnimationMetadata
}

export interface AutoTune {
  enabled: boolean
  /** Max acceptable pctDiff. */
  threshold: number
  /** Size budget per SVG in KiB; 0 means no budget (the score alone weighs size). */
  maxKB: number
}
