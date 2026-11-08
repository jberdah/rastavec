import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

const root = resolve(new URL('..', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'))
const cli = join(root, 'cli', 'dist', 'rastavec.cjs')
const fixtures = [
  'tests/fixtures/pixel-art/tiny-wizard.png',
  'tests/fixtures/pixel-art/potion.png',
  'tests/fixtures/pixel-art/sword.png',
  'tests/fixtures/pixel-art/shield.png',
  'tests/fixtures/grouping-corpus/kenney-bear.png',
  'tests/fixtures/grouping-corpus/kenney-dog.png',
  'tests/fixtures/grouping-corpus/bat.png',
  'tests/fixtures/grouping-corpus/spell.png',
].map((path) => join(root, path))
const iterations = Math.max(1, Number(process.env.BENCH_ITERATIONS ?? 3))
const outputRoot = resolve(process.env.BENCH_OUTPUT ?? join(root, 'output', 'bench-cli'))
mkdirSync(outputRoot, { recursive: true })
const samples = []

for (let iteration = 0; iteration < iterations; iteration++) {
  const out = join(outputRoot, `run-${iteration + 1}`)
  const started = performance.now()
  const result = spawnSync(process.execPath, [
    cli, 'trace', ...fixtures, '--out', out, '--force', '--compare', '--json',
  ], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  const elapsedMs = performance.now() - started
  if (result.error) throw result.error
  if (result.status > 1) throw new Error(result.stderr || `CLI exited with ${result.status}`)
  const report = JSON.parse(result.stdout)
  samples.push({ elapsedMs: Math.round(elapsedMs), report })
  process.stdout.write(`run ${iteration + 1}/${iterations}: ${elapsedMs.toFixed(0)} ms; ${report.summary.total} images; ${report.summary.review} review; ${report.summary.errors} errors\n`)
}

const sorted = samples.map((sample) => sample.elapsedMs).sort((a, b) => a - b)
const result = {
  benchmark: 'rastavec-cli-batch-auto-compare-v1',
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  iterations,
  fixtures: fixtures.map((path) => path.slice(root.length + 1)),
  wallTimeMs: samples.map((sample) => sample.elapsedMs),
  medianWallTimeMs: sorted[Math.floor(sorted.length / 2)],
  outputs: samples.map((sample, index) => ({
    run: index + 1,
    seconds: sample.report.summary.seconds,
    review: sample.report.summary.review,
    items: sample.report.items.map((item) => ({
      name: item.name,
      width: item.width,
      height: item.height,
      trials: item.trials,
      pctDiff: item.metrics?.pctDiff,
      iou: item.metrics?.iou,
      bytes: item.metrics?.bytes,
      traceMethod: item.traceMethod,
    })),
  })),
}
const resultPath = join(outputRoot, 'result.json')
writeFileSync(resultPath, JSON.stringify(result, null, 2) + '\n')
process.stdout.write(`median ${result.medianWallTimeMs} ms; results ${resultPath}\n`)
