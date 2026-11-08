import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join, resolve } from 'node:path'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const requireCli = createRequire(join(root, 'cli', 'package.json'))
const { build } = requireCli('esbuild')
const tempDir = join(root, 'cli', '.tmp')
mkdirSync(tempDir, { recursive: true })
const entry = join(tempDir, 'evolutionary-benchmark.mjs')
await build({
  entryPoints: [join(root, 'scripts', 'evolutionary-benchmark-entry.ts')],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  outfile: entry,
  external: ['sharp', '@visioncortex/vtracer'],
  legalComments: 'none',
})

const { runEvolutionaryBenchmark } = await import(pathToFileURL(entry).href)
const fixtures = [
  'tests/fixtures/pixel-art/tiny-wizard.png',
  'tests/fixtures/grouping-corpus/bat.png',
  'tests/fixtures/grouping-corpus/kenney-dog.png',
  'tests/fixtures/grouping-corpus/spell.png',
]
const repetitions = Math.max(1, Number(process.env.EVOLUTIONARY_REPETITIONS ?? 3))
const maxEvaluations = Math.max(0, Number(process.env.EVOLUTIONARY_MAX_EVALUATIONS ?? 6))
const threshold = Math.max(0, Number(process.env.EVOLUTIONARY_THRESHOLD ?? 3))
const results = []
for (const relative of fixtures) {
  const result = await runEvolutionaryBenchmark(join(root, relative), repetitions, maxEvaluations, threshold)
  results.push({ ...result, file: relative })
  const times = result.runs.map((run) => `${run.fixed.elapsedMs.toFixed(0)}/${run.evolved.elapsedMs.toFixed(0)}`)
  const first = result.runs[0]
  process.stdout.write(`${relative}: fixed/evolved ms ${times.join(', ')}; score ${first.fixed.metrics.score.toFixed(4)} → ${first.evolved.metrics.score.toFixed(4)}; extra ${first.evolved.extraEvaluations}\n`)
}

const output = join(root, 'cli', '.tmp', 'evolutionary-benchmark-results.json')
writeFileSync(output, JSON.stringify({
  benchmark: 'rastavec-fixed-vs-deterministic-evolutionary-v1',
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  repetitions,
  maxEvaluations,
  threshold,
  results,
}, null, 2) + '\n')
process.stdout.write(`results: ${output}\n`)
