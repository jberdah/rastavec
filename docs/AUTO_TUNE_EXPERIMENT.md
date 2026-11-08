# Auto-Tune search experiment

## Question

Does a bounded deterministic evolutionary search find better output than RastaVec's current candidate search often enough to justify its extra traces?

The experiment keeps the production path unchanged. It starts from the normal `vectorize()` trials, proposes six unique parameter sets in two generations, evaluates each with the same Node/VTracer backend, and chooses from the combined set with the existing size-budget rule and score.

## Method

- Backend: Node CLI backend (`@visioncortex/vtracer` and `sharp`), same process for baseline and additional traces.
- Preset: Auto; maximum SVG size: 400 KiB.
- Default-threshold run: 3% visible-difference threshold, 3 repetitions.
- Stress run: 0.1% threshold, 1 repetition, to make the fixed search retry the non-pixel illustrations.
- Additional search budget: 6 VTracer evaluations per image.
- Fixtures: `tiny-wizard.png`, `bat.png`, `kenney-dog.png`, and `spell.png` from the existing pixel-art and grouping corpora.
- Quality comparison: selected RastaVec score, where lower is better; the same chooser applies the SVG size limit.
- Timings: elapsed time around the complete fixed pipeline and then around the six added evaluations. Single-process timings vary with system load, so the default-threshold table uses the median of three runs.

## Default-threshold results

| Fixture | Fixed median | With search median | Change | Trials, fixed → search | Selected score, fixed → search |
|---|---:|---:|---:|---:|---:|
| tiny-wizard | 113 ms | 159 ms | +41% | 12 → 18 | 0.03509 → 0.03509 |
| bat | 255 ms | 963 ms | +278% | 2 → 8 | 2.69112 → 2.69112 |
| kenney-dog | 1,476 ms | 1,743 ms | +18% | 13 → 19 | 0.69274 → 0.69274 |
| spell | 4,728 ms | 5,866 ms | +24% | 14 → 20 | 3.14400 → 3.14400 |

The extra candidates did not change the selected score or output metrics on any fixture.

## Low-threshold retry results

At the 0.1% threshold, each fixture received six more candidate evaluations. The three illustrations retried the existing fixed grid before the evolutionary candidates ran.

| Fixture | Fixed | With search | Change | Trials, fixed → search | Selected score, fixed → search |
|---|---:|---:|---:|---:|---:|
| tiny-wizard | 135 ms | 183 ms | +35% | 12 → 18 | 0.03509 → 0.03509 |
| bat | 4,024 ms | 4,339 ms | +8% | 14 → 20 | 1.2654 → 1.2654 |
| kenney-dog | 513 ms | 636 ms | +24% | 13 → 19 | 0.6927 → 0.6927 |
| spell | 1,707 ms | 2,104 ms | +23% | 14 → 20 | 3.1440 → 3.1440 |

The existing search already tries up to fourteen candidates on these examples. Six more trials again changed no selected result.

## Reproduction

From the repository root:

```powershell
node scripts/evolutionary-benchmark.mjs
$env:EVOLUTIONARY_REPETITIONS = '1'
$env:EVOLUTIONARY_THRESHOLD = '0.1'
node scripts/evolutionary-benchmark.mjs
```

The script writes full per-run metrics to `cli/.tmp/evolutionary-benchmark-results.json`. To change the budget, set `EVOLUTIONARY_MAX_EVALUATIONS` before running it. The search generator's determinism, parameter bounds, uniqueness and evaluation budget are covered by `cli/test/evolutionary-search.test.mjs`.

## Decision and limits

Do not add this search to normal Auto-Tune yet. On these four fixtures it increased total runtime by 8–278% and added no quality improvement. This is a small fixture set, so it does not prove that an evolutionary search can never help. A later integration should require a human-reviewed difficult-image corpus and a measurable improvement in chosen fidelity or size at an acceptable added-time budget.
