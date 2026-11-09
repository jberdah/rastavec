export interface ObjectRouteCandidate {
  provider: string
  status: string
  hypotheses?: readonly unknown[]
  diagnostics?: unknown
  reason?: string
}

export interface ObjectRouteAssessment {
  provider: string
  eligible: boolean
  basis: string
}

export interface ObjectRouteRecommendation {
  policy: 'specialist-fit-v1'
  status: 'selected-for-review' | 'competing-specialists' | 'fallback-for-review' | 'no-route'
  selectedProvider: string | null
  humanReviewRequired: true
  assessments: ObjectRouteAssessment[]
  note: string
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined
}

/**
 * Recommend a route from raster-only provider evidence. This is an advisory
 * selector: candidates stay in the report and every recommendation needs review.
 */
export function recommendObjectRoute(
  candidates: readonly ObjectRouteCandidate[],
  mobileSamRequested = false,
): ObjectRouteRecommendation {
  const byProvider = new Map(candidates.map((candidate) => [candidate.provider, candidate]))
  const assessments: ObjectRouteAssessment[] = []

  const circles = byProvider.get('circle-visible-arc-fit')
  if (circles?.status === 'proposed') {
    const residuals: unknown = record(circles.diagnostics)?.relativeRadialRms
    const usable = Array.isArray(residuals) && residuals.length === 3
      && residuals.every((value) => typeof value === 'number' && Number.isFinite(value))
    const maximumResidual = usable ? Math.max(...(residuals as number[])) : Infinity
    assessments.push({
      provider: circles.provider,
      eligible: usable && maximumResidual <= 0.01,
      basis: usable
        ? `maximum relative radial residual ${maximumResidual.toFixed(4)} ${maximumResidual <= 0.01 ? 'passes' : 'exceeds'} the 0.01 specialist gate`
        : 'three finite circle residuals are unavailable',
    })
  }

  const planar = byProvider.get('planar-color-adjacency')
  if (planar?.status === 'proposed') {
    const diagnostics = record(planar.diagnostics)
    const paintFit = record(diagnostics?.paintFit)
    const graph = record(diagnostics?.graph)
    const rmse = paintFit?.bestRmse
    const acceptedByFit = typeof rmse === 'number' && Number.isFinite(rmse) && rmse <= 10
    const acceptedTreeWithoutScore = rmse == null && graph?.isTree === true
    assessments.push({
      provider: planar.provider,
      eligible: acceptedByFit || acceptedTreeWithoutScore,
      basis: acceptedByFit
        ? `best compositing RMSE ${rmse.toFixed(3)} is at or below the prior router's 10 RGB-level gate`
        : acceptedTreeWithoutScore
          ? 'no compositing score is available; the accepted membership graph is a tree'
          : typeof rmse === 'number' && Number.isFinite(rmse)
            ? `best compositing RMSE ${rmse.toFixed(3)} exceeds the prior router's 10 RGB-level gate`
            : 'neither a passing compositing fit nor a tree-graph fallback is available',
    })
  }

  const specialists = assessments.filter(({ eligible }) => eligible).map(({ provider }) => provider)
  if (specialists.length > 1) return {
    policy: 'specialist-fit-v1', status: 'competing-specialists', selectedProvider: null,
    humanReviewRequired: true, assessments,
    note: 'Multiple specialized routes pass their raster-evidence gates; compare their masks and review before choosing.',
  }
  if (specialists.length === 1) return {
    policy: 'specialist-fit-v1', status: 'selected-for-review', selectedProvider: specialists[0],
    humanReviewRequired: true, assessments,
    note: 'One specialized route passes its raster-evidence gate; this recommends review priority, not automatic acceptance.',
  }

  const mobileSam = byProvider.get('mobile-sam')
  if (mobileSamRequested && mobileSam?.status === 'proposed') return {
    policy: 'specialist-fit-v1', status: 'fallback-for-review', selectedProvider: 'mobile-sam',
    humanReviewRequired: true, assessments,
    note: 'No specialized geometry/color route passed; MobileSAM supplies visible-region masks only, with its prompt selection policy recorded separately.',
  }

  const components = byProvider.get('visible-connected-components')
  if (components?.status === 'proposed') return {
    policy: 'specialist-fit-v1', status: 'fallback-for-review', selectedProvider: components.provider,
    humanReviewRequired: true, assessments,
    note: 'No specialized route passed; connected components are the visible-region fallback and do not identify overlapping objects.',
  }

  return {
    policy: 'specialist-fit-v1', status: 'no-route', selectedProvider: null,
    humanReviewRequired: true, assessments,
    note: 'No route passed its raster-evidence gate; preserve abstentions and request manual review.',
  }
}
