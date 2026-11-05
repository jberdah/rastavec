import type { Analysis } from './analyze'

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
  label: string
  params: TraceParams
  svg: string
  metrics: Metrics
  score: number
  ms: number
}

export type ItemStatus = 'queued' | 'tracing' | 'done' | 'error'

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
  /** Progress text while tracing, e.g. "essai 3/7". */
  progress: string
  trials: Trial[]
  chosen: number
  autoTuned: boolean
  error?: string
  /** Image analysis, computed once at import. */
  analysis?: Analysis
  /** Why the auto preset chose these parameters. */
  notes?: string[]
}

export interface AutoTune {
  enabled: boolean
  /** Max acceptable pctDiff. */
  threshold: number
  /** Max SVG size in KiB. */
  maxKB: number
}
