import type { NearbyGroup } from './group-nearby'

export interface BinarySegmentationMask {
  width: number
  height: number
  /** 1 marks the segmented object; 0 marks the background. */
  data: Uint8Array
}

export interface SvgViewBox { x: number; y: number; width: number; height: number }

export interface MaskGroupSelection {
  groupIds: string[]
  pathIndices: number[]
  sampledPaths: number
  matchedPaths: number
}

/** Decode alpha masks and white-on-black grayscale masks without assuming a colour palette. */
export function binaryMaskFromRgba(rgba: ArrayLike<number>, width: number, height: number): BinarySegmentationMask {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || rgba.length !== width * height * 4)
    throw new Error('The segmentation mask has invalid pixel data.')
  let hasTransparency = false
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] < 250) { hasTransparency = true; break }
  }
  const data = new Uint8Array(width * height)
  for (let pixel = 0, i = 0; pixel < data.length; pixel++, i += 4) {
    const foreground = hasTransparency
      ? rgba[i + 3] >= 128
      : (rgba[i] + rgba[i + 1] + rgba[i + 2]) / 3 >= 128
    data[pixel] = foreground ? 1 : 0
  }
  return { width, height, data }
}

export function svgViewBox(svg: string): SvgViewBox | null {
  const match = svg.match(/<svg\b[^>]*\bviewBox="\s*([-+\d.eE]+)[\s,]+([-+\d.eE]+)[\s,]+([-+\d.eE]+)[\s,]+([-+\d.eE]+)\s*"/i)
  if (!match) return null
  const [x, y, width, height] = match.slice(1).map(Number)
  return [x, y, width, height].every(Number.isFinite) && width > 0 && height > 0 ? { x, y, width, height } : null
}

/**
 * Select existing level-0 path groups by the share of their member path centres inside a mask.
 * RastaVec's geometry metadata only supplies conservative bounds and centres; this mapper does
 * not claim pixel-exact path intersection or semantic labels. It never changes SVG order itself.
 */
export function selectGroupsByMask(
  groups: NearbyGroup[],
  mask: BinarySegmentationMask,
  viewBox: SvgViewBox,
  imageWidth: number,
  imageHeight: number,
  minMemberShare = 0.6,
): MaskGroupSelection {
  if (!Number.isSafeInteger(imageWidth) || !Number.isSafeInteger(imageHeight) || imageWidth < 1 || imageHeight < 1)
    throw new Error('Source image dimensions are invalid.')
  if (mask.data.length !== mask.width * mask.height || mask.width < 1 || mask.height < 1)
    throw new Error('The segmentation mask has invalid dimensions.')
  if (!(minMemberShare > 0.5 && minMemberShare <= 1))
    throw new Error('The path-centre share must be greater than 0.5 and at most 1.')

  const insideMask = (x: number, y: number) => {
    const imageX = Math.floor((x - viewBox.x) * imageWidth / viewBox.width)
    const imageY = Math.floor((y - viewBox.y) * imageHeight / viewBox.height)
    if (imageX < 0 || imageY < 0 || imageX >= imageWidth || imageY >= imageHeight) return false
    const maskX = Math.min(mask.width - 1, Math.floor(imageX * mask.width / imageWidth))
    const maskY = Math.min(mask.height - 1, Math.floor(imageY * mask.height / imageHeight))
    return mask.data[maskY * mask.width + maskX] === 1
  }

  const selected: string[] = []
  const pathIndices: number[] = []
  let sampledPaths = 0, matchedPaths = 0
  for (const group of groups) {
    if (group.level !== 0 || !group.pathIndices.length) continue
    const members = group.members?.length === group.pathIndices.length
      ? group.members.map((member) => ({ pathIndex: member.pathIndex, pivot: member.pivot }))
      : group.pathIndices.length === 1
        ? [{ pathIndex: group.pathIndices[0], pivot: group.pivot }]
        : null
    // A multi-path group without per-path centres cannot be selected conservatively.
    if (!members) continue
    let inside = 0
    for (const member of members) {
      sampledPaths++
      if (insideMask(member.pivot[0], member.pivot[1])) {
        inside++
        matchedPaths++
        pathIndices.push(member.pathIndex)
      }
    }
    if (inside / members.length >= minMemberShare) selected.push(group.id)
  }
  return { groupIds: selected, pathIndices, sampledPaths, matchedPaths }
}
