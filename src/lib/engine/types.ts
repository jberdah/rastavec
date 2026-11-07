import type { Analysis, NoteCode } from './analyze'
import type { FilterSettings } from './palette'

export type ColorMode = 'color' | 'binary'
export type CurveMode = 'spline' | 'polygon'

/** Tracing parameters, in the same units as the Python `trace.py` helper. */
export interface TraceParams {
  colormode: ColorMode
  mode: CurveMode
  /** Discard patches smaller than N px (side of a square). */
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
  bytes: number
  paths: number
  embeddedRaster: boolean
}

export interface Trial {
  /** True for the first trial (preset / Auto parameters), false for auto-tune candidates. */
  base: boolean
  /** Integer nearest-neighbour enlargement used before tracing (1 = original size). */
  traceScale?: number
  /** Omitted for VTracer; pixel-grid reconstructs exact pixel runs. */
  traceMethod?: 'pixel-grid'
  params: TraceParams
  svg: string
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
  /** Measurement of the exact filtered SVG, keyed to the trial and filter settings. */
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
  /** Max SVG size in KiB. */
  maxKB: number
}
