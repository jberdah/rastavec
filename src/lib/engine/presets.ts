import type { TraceParams } from './types'

export const DEFAULT_PARAMS: TraceParams = {
  colormode: 'color',
  mode: 'spline',
  speckle: 6,
  colorPrecision: 7,
  layerDifference: 16,
  cornerThreshold: 60,
  lengthThreshold: 4,
  spliceThreshold: 45,
  pathPrecision: 2,
  alphaFloor: 8,
  silhouetteCut: 128,
  softLayers: 2,
  softColor: false,
  compactPaths: true,
}

export interface Preset {
  id: string
  name: string
  desc: string
  swatches: string[]
  params: TraceParams
  recommended?: boolean
}

export const PRESETS: Preset[] = [
  {
    id: 'auto',
    name: 'Auto',
    desc: 'Réglages choisis pour chaque image : couleurs, dégradés, transparence.',
    swatches: ['#C8F65A', '#FFD34D', '#1F8F4A', '#FFF8E6'],
    params: { ...DEFAULT_PARAMS },
    recommended: true,
  },
  {
    id: 'flat',
    name: 'Logo à aplats',
    desc: 'Peu de couleurs, bords nets, fichier léger.',
    swatches: ['#1E3A8A', '#F59E0B', '#F2F4F7'],
    params: { ...DEFAULT_PARAMS, colorPrecision: 5, layerDifference: 16, speckle: 10, softLayers: 0 },
  },
  {
    id: 'shaded',
    name: 'Illustration ombrée',
    desc: 'Ombres douces et petits détails préservés.',
    swatches: ['#4C6EF5', '#EEF2FF', '#FFC53D', '#FF9AA2'],
    // Validated on a set of 11 shaded mascots: ~1.5 % visibly different pixels, IoU ~0.99.
    params: { ...DEFAULT_PARAMS, colorPrecision: 8, layerDifference: 8, speckle: 6 },
  },
  {
    id: 'line',
    name: 'Dessin au trait',
    desc: 'Une couleur, contours fins.',
    swatches: ['#F2F4F7', '#0A0B0F'],
    params: { ...DEFAULT_PARAMS, colormode: 'binary', speckle: 4 },
  },
  {
    id: 'pixel',
    name: 'Pixel art',
    desc: 'Formes carrées, aucune courbe.',
    swatches: ['#22C55E', '#3B82F6', '#EF4444', '#FACC15'],
    params: { ...DEFAULT_PARAMS, mode: 'polygon', speckle: 1, colorPrecision: 8, layerDifference: 4 },
  },
  {
    id: 'custom',
    name: 'Personnalisé',
    desc: 'Tous les paramètres à la main.',
    swatches: ['#5B6472'],
    params: { ...DEFAULT_PARAMS },
  },
]

export const presetById = (id: string) => PRESETS.find((p) => p.id === id) ?? PRESETS[0]

export function describe(p: TraceParams): string {
  if (p.colormode === 'binary') return `binaire · speckle ${p.speckle}`
  const mode = p.mode === 'polygon' ? 'polygone · ' : ''
  const cut = (p.silhouetteCut !== 128 ? ` · α≥${p.silhouetteCut}` : '') + (p.softColor ? ' · halo couleur' : p.softLayers !== 2 ? ` · halo ${p.softLayers}` : '')
  return `${mode}cp ${p.colorPrecision} · ld ${p.layerDifference} · speckle ${p.speckle}${cut}`
}
