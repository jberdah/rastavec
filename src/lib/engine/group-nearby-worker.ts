import { groupNearbyPaths, type NearbyColorMode, type NearbyStrategy } from './group-nearby'

// Analysis runs away from the UI thread; only RastaVec's own generated SVG is passed in.
const scope = globalThis as unknown as {
  onmessage: ((event: { data: { svg: string; distance: number; colorMode?: NearbyColorMode; includeSingletons?: boolean; strategy?: NearbyStrategy; regionCount?: number } }) => void) | null
  postMessage: (message: unknown) => void
}
scope.onmessage = (event) => {
  try { scope.postMessage({ result: groupNearbyPaths(event.data.svg, { distance: event.data.distance, colorMode: event.data.colorMode, includeSingletons: event.data.includeSingletons, strategy: event.data.strategy, regionCount: event.data.regionCount }) }) }
  catch (error) { scope.postMessage({ error: error instanceof Error ? error.message : String(error) }) }
}
