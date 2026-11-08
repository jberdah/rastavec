import { analyze } from '../src/lib/engine/analyze'
import { choose } from '../src/lib/engine/core'
import { DEFAULT_PARAMS } from '../src/lib/engine/presets'
import { runEvolutionarySearch } from '../src/lib/engine/evolutionary-search'
import { runTrial, vectorize } from '../src/lib/engine/vectorize'
import type { TraceParams, Trial } from '../src/lib/engine/types'
import { decode, nodeBackend } from '../cli/src/node-backend'

const resultMetrics = (trials: Trial[], chosen: number) => {
  const trial = trials[chosen]
  return {
    score: trial.score,
    pctDiff: trial.metrics.pctDiff,
    iou: trial.metrics.iou,
    rgbMean: (trial.metrics.rgbWhite + trial.metrics.rgbDark) / 2,
    bytes: trial.metrics.bytes,
    paths: trial.metrics.paths,
    params: trial.params,
  }
}

export async function runEvolutionaryBenchmark(filePath: string, repetitions: number, maxEvaluations: number, threshold: number) {
  const source = await decode(filePath)
  const analysis = analyze(source)
  const settings = {
    presetId: 'auto',
    params: { ...DEFAULT_PARAMS },
    auto: { enabled: true, threshold, maxKB: 400 },
  }
  const runs = []
  for (let repeat = 0; repeat < repetitions; repeat++) {
    const baseStarted = performance.now()
    const baseline = await vectorize(source, settings, nodeBackend, { analysis })
    const baseMs = performance.now() - baseStarted
    const seeds = baseline.trials
      .filter((trial) => !trial.traceMethod && (trial.traceScale ?? 1) === 1)
      .map(({ params, score }) => ({ params, score }))
    const extraStarted = performance.now()
    const extras = await runEvolutionarySearch(seeds, async (params: TraceParams) =>
      runTrial(source, params, false, nodeBackend),
    { maxEvaluations, generationSize: 3, generations: Math.ceil(maxEvaluations / 3) })
    const extraMs = performance.now() - extraStarted
    const combined = [...baseline.trials, ...extras]
    const evolvedChosen = choose(combined, settings.auto.maxKB * 1024)
    runs.push({
      repeat: repeat + 1,
      fixed: {
        elapsedMs: baseMs,
        trials: baseline.trials.length,
        metrics: resultMetrics(baseline.trials, baseline.chosen),
      },
      evolved: {
        elapsedMs: baseMs + extraMs,
        extraElapsedMs: extraMs,
        trials: combined.length,
        extraEvaluations: extras.length,
        metrics: resultMetrics(combined, evolvedChosen),
      },
    })
  }
  return {
    file: filePath,
    width: source.width,
    height: source.height,
    analysis: { kind: analysis.kind, alpha: analysis.alpha },
    settings: { preset: settings.presetId, threshold: settings.auto.threshold, maxKB: settings.auto.maxKB },
    runs,
  }
}
