// Compares Auto-Tune scores on the trials recorded by scripts/score-study.mjs.
//
//   node scripts/score-study-analyze.mjs [results.json] [--grid] [--w band,weight,paths,edit]
//
//                                         [--curve knee] [--floor bytes]
//
// The reference is the score the study started from, `pctDiff + 0.01 * meanRgb + 0.002 * KiB`
// with a penalty above a 400 KiB budget. The candidate is, with f = pctDiff + 0.01 * meanRgb,
//
//   f + f² / knee + band * falseEdgePct
//     + weight * log2(bytes + floor) + paths * log2(paths) - edit * editableShare
//
// The product uses band 0.5, weight 1.5, paths 0, edit 0.6, knee 3, floor 4096 (engine/core.ts).
import { readFileSync } from 'node:fs'

const args = process.argv.slice(2)
const grid = args.includes('--grid')
const wIndex = args.indexOf('--w')
const custom = wIndex >= 0 ? args[wIndex + 1].split(',').map(Number) : null
const file = args.find((arg, i) => !arg.startsWith('--') && (wIndex < 0 || i !== wIndex + 1) && (args.indexOf('--curve') < 0 || i !== args.indexOf('--curve') + 1) && (args.indexOf('--floor') < 0 || i !== args.indexOf('--floor') + 1)) ?? 'C:/tmp/score-study/results.json'
const images = JSON.parse(readFileSync(file, 'utf8')).filter((image) => image.trials.length > 1)

const BUDGET = 400 * 1024
const current = (trial) => trial.pctDiff + 0.01 * trial.meanRgb + 0.002 * trial.bytes / 1024 + 4 * Math.max(0, trial.bytes / BUDGET - 1)
const fidelity = (trial) => trial.pctDiff + 0.01 * trial.meanRgb
// Only differences between trials of one image decide, so the logarithms need no reference:
// doubling the weight (or the path count) costs the same wherever it happens.
// A visible difference hurts more than proportionally as it grows: 0.3 % against 0.1 % is
// noise, 4 % against 2 % is a different picture. `curve` is the difference (in %) at which the
// quadratic part equals the linear one; 0 turns it off.
const curveIndex = args.indexOf('--curve')
const curve = curveIndex >= 0 ? Number(args[curveIndex + 1]) : 3
// Bytes added to every size before the logarithm: below it, weight differences stop mattering.
const floorIndex = args.indexOf('--floor')
const floor = floorIndex >= 0 ? Number(args[floorIndex + 1]) : 4096
const convex = (trial) => { const f = fidelity(trial) + 0; return curve > 0 ? f + f * f / curve : f }
const candidate = ([band, weight, paths, edit]) => (trial) =>
  convex(trial) + band * trial.falseEdgePct
    + weight * Math.log2(Math.max(1, trial.bytes) + floor)
    + paths * Math.log2(Math.max(1, trial.paths))
    - edit * trial.editableShare
const pick = (trials, score) => trials.reduce((best, trial) => (score(trial, trials) < score(best, trials) ? trial : best), trials[0])
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)
const geomean = (values) => Math.exp(mean(values.map((value) => Math.log(Math.max(value, 1e-9)))))

function evaluate(weights) {
  const score = candidate(weights)
  const rows = images.map((image) => ({ image, was: pick(image.trials, current), now: pick(image.trials, score) }))
  const changed = rows.filter((row) => row.was.k !== row.now.k)
  return {
    weights, rows, changed,
    summary: {
      changed: changed.length,
      pctDiff: mean(rows.map((row) => row.now.pctDiff - row.was.pctDiff)),
      worseFidelity: rows.filter((row) => row.now.pctDiff > row.was.pctDiff + 0.3).length,
      worstFidelityLoss: Math.max(...rows.map((row) => row.now.pctDiff - row.was.pctDiff)),
      heavier: rows.filter((row) => row.now.bytes > 2 * row.was.bytes).length,
      busier: rows.filter((row) => row.now.paths > 2 * Math.max(1, row.was.paths)).length,
      bytes: geomean(rows.map((row) => row.now.bytes / row.was.bytes)),
      paths: geomean(rows.map((row) => Math.max(1, row.now.paths) / Math.max(1, row.was.paths))),
      falseEdges: mean(rows.map((row) => row.now.falseEdgePct - row.was.falseEdgePct)),
      editable: mean(rows.map((row) => row.now.editableShare - row.was.editableShare)),
    },
  }
}
const line = ({ weights, summary: s }) =>
  `band ${weights[0].toFixed(2)} weight ${weights[1].toFixed(2)} paths ${weights[2].toFixed(2)} edit ${weights[3].toFixed(2)} | changed ${String(s.changed).padStart(2)}/${images.length} | pctDiff ${s.pctDiff >= 0 ? '+' : ''}${s.pctDiff.toFixed(3)} (worse>0.3: ${s.worseFidelity}, max +${s.worstFidelityLoss.toFixed(2)}) | >2x bytes: ${s.heavier}, >2x paths: ${s.busier} | bytes x${s.bytes.toFixed(2)} | paths x${s.paths.toFixed(2)} | falseEdges ${s.falseEdges >= 0 ? '+' : ''}${s.falseEdges.toFixed(3)} | editable ${s.editable >= 0 ? '+' : ''}${(100 * s.editable).toFixed(1)} pts`

console.log(`${images.length} images with several trials, ${images.reduce((n, image) => n + image.trials.length, 0)} trials`)
const kinds = {}
for (const image of images) kinds[image.kind ?? '?'] = (kinds[image.kind ?? '?'] ?? 0) + 1
console.log('kinds:', JSON.stringify(kinds))

if (grid) {
  const outcomes = []
  for (const band of [0.25, 0.5, 1]) for (const weight of [0.5, 0.75, 1, 1.25, 1.5]) for (const paths of [0, 0.1, 0.25, 0.5]) for (const edit of [0.3, 0.6, 1]) outcomes.push(evaluate([band, weight, paths, edit]))
  // Keep fidelity safe first, then rank by what was gained.
  const safe = outcomes.filter((outcome) => outcome.summary.worstFidelityLoss <= 1 && outcome.summary.heavier === 0 && outcome.summary.busier === 0)
  console.log(`\n${safe.length}/${outcomes.length} settings never lose more than 1 pt of visible difference nor double the weight or the path count on any image. Top by structure gain:`)
  safe.sort((a, b) => (a.summary.paths + a.summary.bytes - a.summary.editable + a.summary.falseEdges) - (b.summary.paths + b.summary.bytes - b.summary.editable + b.summary.falseEdges))
  for (const outcome of safe.slice(0, 12)) console.log(line(outcome))
  console.log('\nFor reference, the proposal as first written:')
  console.log(line(evaluate([0.5, 0.25, 0.25, 0.3])))
} else {
  const outcome = evaluate(custom ?? [0.5, 1.5, 0, 0.6])
  console.log(line(outcome))
  console.log('\nImages where the choice changes (current -> candidate):')
  const describe = (trial) => `${trial.label.slice(0, 34).padEnd(34)} ${trial.pctDiff.toFixed(2).padStart(6)}% ${(trial.bytes / 1024).toFixed(0).padStart(5)}K ${String(trial.paths).padStart(5)}p band ${trial.falseEdgePct.toFixed(2)} edit ${(100 * trial.editableShare).toFixed(0)}%`
  for (const row of outcome.changed) console.log(`${row.image.name.slice(0, 30).padEnd(30)} [${row.image.kind}]\n    was ${describe(row.was)}\n    now ${describe(row.now)}`)
}
