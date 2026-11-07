export type PivotBounds = [number, number, number, number]

/**
 * Suggest an attachment point by projecting the SVG viewBox centre onto a
 * group's rectangle, then nudging the point a short distance back toward the
 * artwork centre. Joints can sit just outside a limb's visible bounds.
 * This remains a geometric hint; the user can place it precisely.
 */
export function attachmentPivot(bounds: PivotBounds, viewBox: string): [number, number] {
  const values = viewBox.trim().split(/[\s,]+/).map(Number)
  if (values.length !== 4 || values.some((value) => !Number.isFinite(value)) || values[2] <= 0 || values[3] <= 0) {
    return [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2]
  }

  const [viewX, viewY, width, height] = values
  const centerX = viewX + width / 2
  const centerY = viewY + height / 2
  const projectedX = Math.max(bounds[0], Math.min(bounds[2], centerX))
  const projectedY = Math.max(bounds[1], Math.min(bounds[3], centerY))
  const dx = centerX - projectedX
  const dy = centerY - projectedY
  const distance = Math.hypot(dx, dy)
  const nudge = Math.min(distance, Math.max(bounds[2] - bounds[0], bounds[3] - bounds[1]) * 0.3)
  const point: [number, number] = distance
    ? [projectedX + dx / distance * nudge, projectedY + dy / distance * nudge]
    : [centerX, centerY]
  return point.map((value) => Number(value.toFixed(2))) as [number, number]
}
