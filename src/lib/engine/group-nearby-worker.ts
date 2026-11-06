import { groupNearbyPaths } from './group-nearby'

// Analysis runs away from the UI thread; only RastaVec's own generated SVG is passed in.
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<{ svg: string; distance: number }>) => void) | null
  postMessage: (message: unknown) => void
}
scope.onmessage = (event) => {
  try { scope.postMessage({ result: groupNearbyPaths(event.data.svg, { distance: event.data.distance }) }) }
  catch (error) { scope.postMessage({ error: error instanceof Error ? error.message : String(error) }) }
}
