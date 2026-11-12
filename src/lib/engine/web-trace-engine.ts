import type { TraceBackend } from './core'
// Static on purpose (see vtracer-next-backend.ts): dynamic import() hangs in WKWebView workers.
import { createVTracerNextBackend } from './vtracer-next-backend'

export type TraceEngine = 'next' | 'next-gradients'
export type TraceEngineProvenance = TraceEngine | 'official'

export function parseTraceEngine(value: unknown): TraceEngine | undefined {
  if (value === 'official') return 'next'
  return value === 'next' || value === 'next-gradients' ? value : undefined
}

/** Preserve the engine label attached to historical batch results. */
export function parseTraceEngineProvenance(value: unknown): TraceEngineProvenance | undefined {
  return value === 'official' || value === 'next' || value === 'next-gradients' ? value : undefined
}

export async function selectTraceBackend(base: TraceBackend, mode: TraceEngine | 'test'): Promise<TraceBackend> {
  if (mode === 'test') return base // injectable backend for pipeline tests
  return createVTracerNextBackend(base, mode === 'next-gradients')
}
