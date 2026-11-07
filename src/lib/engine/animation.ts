import type { AnimationKeyframe, AnimationMetadata } from './types'

export interface MotionValue {
  rotation: number
  translateY: number
}

export type WalkRole = 'leg_left' | 'leg_right' | 'arm_left' | 'arm_right' | 'torso'

export interface RoleGroup {
  id: string
  role?: string
  bounds: [number, number, number, number]
  pivot: [number, number]
  locked?: boolean
}

const ROLE_ALIASES: Record<string, WalkRole> = {
  leg_left: 'leg_left', left_leg: 'leg_left', leftleg: 'leg_left',
  leg_right: 'leg_right', right_leg: 'leg_right', rightleg: 'leg_right',
  arm_left: 'arm_left', left_arm: 'arm_left', leftarm: 'arm_left',
  arm_right: 'arm_right', right_arm: 'arm_right', rightarm: 'arm_right',
  torso: 'torso', body: 'torso', trunk: 'torso',
}

export function canonicalWalkRole(role?: string): WalkRole | undefined {
  if (!role) return undefined
  const normalized = role.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  return ROLE_ALIASES[normalized]
}

const WALK_CYCLE_TIMES = Array.from({ length: 9 }, (_, index) => index / 8)
const WALK_SWING: Record<string, number> = { leg_left: 14, leg_right: -14, arm_left: -8, arm_right: 8 }
const roundedMotion = (value: number) => {
  const rounded = Number(value.toFixed(2))
  return Object.is(rounded, -0) ? 0 : rounded
}

/** Moves untouched default pivots to likely limb attachments; preserves user edits. */
export function walkAttachmentPivot(group: RoleGroup, viewBox: string): [number, number] {
  const role = canonicalWalkRole(group.role)
  if (group.locked || !role || role === 'torso' || !group.bounds.every(Number.isFinite)) return [...group.pivot]
  const [x0, y0, x1, y1] = group.bounds
  const width = x1 - x0, height = y1 - y0
  if (width <= 0 || height <= 0) return [...group.pivot]
  const defaultPivot: [number, number] = [(x0 + x1) / 2, (y0 + y1) / 2]
  if (Math.abs(group.pivot[0] - defaultPivot[0]) > 1e-6 || Math.abs(group.pivot[1] - defaultPivot[1]) > 1e-6) return [...group.pivot]
  if (role === 'leg_left' || role === 'leg_right') return [Number(defaultPivot[0].toFixed(2)), Number((y0 + Math.min(6, height * 0.05)).toFixed(2))]
  const vb = viewBox.trim().split(/[\s,]+/).map(Number)
  const centerX = vb.length === 4 && vb.every(Number.isFinite) && vb[2] > 0 ? vb[0] + vb[2] / 2 : defaultPivot[0]
  const inwardInset = Math.min(6, width * 0.05)
  const x = defaultPivot[0] < centerX ? x1 - inwardInset : x0 + inwardInset
  return [Number(x.toFixed(2)), Number((y0 + Math.min(6, height * 0.1)).toFixed(2))]
}

/** Interpolated part motion. Missing translateY values stay at zero for old sessions. */
export function motionAt(
  frames: AnimationKeyframe[],
  time: number,
  easing: AnimationMetadata['easing'] = 'ease-in-out',
): MotionValue {
  if (!frames.length) return { rotation: 0, translateY: 0 }
  const sorted = [...frames].sort((a, b) => a.timeMs - b.timeMs)
  const valueAt = (index: number): MotionValue => ({
    rotation: Number.isFinite(sorted[index].rotation) ? sorted[index].rotation : 0,
    translateY: Number.isFinite(sorted[index].translateY) ? sorted[index].translateY! : 0,
  })
  if (time <= sorted[0].timeMs) return valueAt(0)
  if (time >= sorted.at(-1)!.timeMs) return valueAt(sorted.length - 1)
  const right = sorted.findIndex((frame) => frame.timeMs >= time)
  const a = sorted[right - 1], b = sorted[right]
  const span = b.timeMs - a.timeMs
  let t = span > 0 ? (time - a.timeMs) / span : 1
  if (easing === 'ease-in-out') t = t * t * (3 - 2 * t)
  const av = valueAt(right - 1), bv = valueAt(right)
  return {
    rotation: av.rotation + (bv.rotation - av.rotation) * t,
    translateY: av.translateY + (bv.translateY - av.translateY) * t,
  }
}

/** Builds a coordinated one-second walk loop for groups tagged with standard roles. */
export function buildWalkCycleTracks(groups: RoleGroup[], durationMs = 1000) {
  const tracks = [] as { groupId: string; keyframes: AnimationKeyframe[] }[]
  for (const group of groups) {
    const role = canonicalWalkRole(group.role)
    if (!role) continue
    const bobAmplitude = Math.min(24, Math.max(2, (group.bounds[3] - group.bounds[1]) * 0.05))
    const keyframes = WALK_CYCLE_TIMES.map((fraction, index) => ({
      timeMs: Math.round(durationMs * fraction),
      rotation: role === 'torso' ? 0 : roundedMotion(WALK_SWING[role] * Math.sin(2 * Math.PI * fraction)),
      ...(role === 'torso' ? { translateY: roundedMotion(-bobAmplitude * Math.sin(2 * Math.PI * fraction) ** 2) } : {}),
    }))
    tracks.push({ groupId: group.id, keyframes })
  }
  return tracks
}
