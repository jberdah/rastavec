/** Coalesce edits by item and limit rasterisations to one at a time. */
export function createMeasurementQueue(delay?: number): {
  schedule(id: string, task: () => Promise<void>): void
  cancel(id: string): void
}

export const outputQueue: ReturnType<typeof createMeasurementQueue>
