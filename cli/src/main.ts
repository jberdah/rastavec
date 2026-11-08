// RastaVec CLI — raster to SVG with analysis, fidelity metrics and deterministic auto-tuning.
// Designed for scripts and AI agents: JSON report, stable exit codes, never overwrites by default.
import { parseArgs } from 'node:util'
import { existsSync, mkdirSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import { analyze, recommend, type Analysis } from '../../src/lib/engine/analyze'
import { diffImage, summarizeDiff, type RGBAImage } from '../../src/lib/engine/core'
import { DEFAULT_PARAMS, PRESETS, presetById } from '../../src/lib/engine/presets'
import { crop, keyBackground, sliceSheet } from '../../src/lib/engine/slice'
import type { AutoTune, TraceParams } from '../../src/lib/engine/types'
import { needsReviewResult, vectorize, type VectorizeSettings } from '../../src/lib/engine/vectorize'
import { decode, nodeBackend, writeComparison, writePng } from './node-backend'

declare const __VERSION__: string
const VERSION = typeof __VERSION__ === 'string' ? __VERSION__ : '0.0.0-dev'
const SCHEMA_VERSION = 1
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|tiff?|avif)$/i

/** Exit codes: stable contract for scripts and agents. */
const EXIT = { OK: 0, REVIEW: 1, ERROR: 2 } as const

const HELP = `RastaVec ${VERSION} — Smooth vectors. Good vibes.
Raster to SVG with image analysis, fidelity metrics and deterministic auto-tuning.

Usage
  rastavec trace <input...> [options]     vectorise images and/or folders
  rastavec analyze <input...> [--json]    analyse images, print the settings Auto would use (writes nothing)
  rastavec slice <sheet> -o <dir>         split a sprite sheet / brand board into one PNG per element

Trace options
  -o, --out <dir>          output folder (default: ./rastavec-out)
  -p, --preset <id>        auto | ${PRESETS.filter((p) => p.id !== 'auto').map((p) => p.id).join(' | ')} (default: auto)
  -t, --threshold <pct>    max visible difference, % of pixels (default: 3)
  -s, --max-size <KB>      size budget per SVG in KiB (default: 400)
      --no-auto            disable auto-tuning (single trial)
      --compare            also write <name>.comparison.png and <name>.diff.png
      --diff-summary-json  write <name>.diff.json with an 8x8 error grid and top hotspots
      --slice              treat each input as a sheet and vectorise its elements
  -r, --recursive          include sub-folders
  -f, --force              overwrite existing output files
  Parameter overrides (switch to a custom preset):
      --color-precision <1-8>  --layer-difference <n>  --speckle <px>
      --mode <spline|polygon>  --binary (incompatible with clustering options)
      --clustering <color-cluster|watershed> (colour mode only)
      --watershed-detail <0-255> (colour mode only; selects watershed if needed)

Common
      --json               print a machine-readable JSON report on stdout
  -q, --quiet              no progress output
  -h, --help               this help
  -v, --version            print the version

Exit codes
  0  every image is under the threshold and the size budget
  1  at least one image needs review (above threshold or budget)
  2  error (bad arguments, unreadable input, existing outputs without --force)

A report.json is always written to the output folder (trace).
`

// ------------------------------------------------------------------ helpers
const fail = (msg: string): never => {
  process.stderr.write(`rastavec: ${msg}\n`)
  process.exit(EXIT.ERROR)
}

function num(value: string | undefined, name: string, def: number, min: number, max: number) {
  if (value === undefined) return def
  const n = Number(value)
  if (!Number.isFinite(n) || n < min || n > max) fail(`--${name} must be a number between ${min} and ${max}`)
  return n
}

function listImages(inputs: string[], recursive: boolean): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))) {
      const p = join(dir, name)
      const st = statSync(p)
      if (st.isDirectory()) {
        if (recursive) walk(p)
      } else if (IMAGE_EXT.test(name)) out.push(p)
    }
  }
  for (const input of inputs) {
    const p = resolve(input)
    if (!existsSync(p)) fail(`input not found: ${input}`)
    if (statSync(p).isDirectory()) walk(p)
    else if (IMAGE_EXT.test(p)) out.push(p)
    else fail(`unsupported file type: ${input}`)
  }
  if (!out.length) fail('no images found in the given inputs')
  return out
}

const stem = (p: string) => basename(p, extname(p))
const pathKey = (p: string) => {
  const absolute = existsSync(p) ? realpathSync(p) : resolve(p)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}
const fileKeys = (p: string): string[] => {
  const keys = [`path:${pathKey(p)}`]
  if (existsSync(p)) {
    const stat = statSync(p)
    if (stat.ino !== 0) keys.push(`inode:${stat.dev}:${stat.ino}`)
  }
  return keys
}
const r4 = (x: number | null) => (x === null ? null : Math.round(x * 10000) / 10000)
const kb = (b: number) => `${Math.round(b / 1024)} KB`

function describe(p: TraceParams) {
  if (p.colormode === 'binary') return `binary · speckle ${p.speckle}`
  const mode = p.mode === 'polygon' ? 'polygon · ' : ''
  const clustering = p.clustering === 'watershed' ? `watershed ${p.watershedDetail ?? 128} · ` : ''
  return `${clustering}${mode}cp ${p.colorPrecision} · ld ${p.layerDifference} · speckle ${p.speckle}${p.silhouetteCut !== 128 ? ` · alpha>=${p.silhouetteCut}` : ''}${p.softColor ? ' · colour halo' : ''}`
}

const analysisJson = (a: Analysis) => ({
  kind: a.kind,
  alpha: a.alpha,
  dominantColors: a.dominantColors,
  gradient: r4(a.gradient),
  transparentPct: r4(a.transparentPct),
  softPct: r4(a.softPct),
  grayscale: a.grayscale,
})

// ------------------------------------------------------------------ commands
async function cmdTrace(positionals: string[], o: Record<string, string | boolean | undefined>) {
  if (!positionals.length) fail('trace needs at least one input (file or folder)')
  const out = resolve((o.out as string) ?? 'rastavec-out')
  const json = !!o.json
  const quiet = !!o.quiet || json
  const log = (s: string) => !quiet && process.stdout.write(s + '\n')

  const presetId = (o.preset as string) ?? 'auto'
  if (!PRESETS.some((p) => p.id === presetId)) fail(`unknown preset "${presetId}"`)
  const baseParams = presetId === 'auto' ? { ...DEFAULT_PARAMS } : { ...presetById(presetId).params }
  const overrides: Partial<TraceParams> = {}
  if (o['color-precision'] !== undefined) overrides.colorPrecision = num(o['color-precision'] as string, 'color-precision', 7, 1, 8)
  if (o['layer-difference'] !== undefined) overrides.layerDifference = num(o['layer-difference'] as string, 'layer-difference', 16, 1, 255)
  if (o.speckle !== undefined) overrides.speckle = num(o.speckle as string, 'speckle', 6, 0, 128)
  if (o.mode !== undefined) {
    if (o.mode !== 'spline' && o.mode !== 'polygon') fail('--mode must be spline or polygon')
    overrides.mode = o.mode as 'spline' | 'polygon'
  }
  if (o.clustering !== undefined) {
    const clustering = o.clustering
    if (clustering !== 'color-cluster' && clustering !== 'watershed') fail('--clustering must be color-cluster or watershed')
    overrides.clustering = clustering as 'color-cluster' | 'watershed'
  }
  if (o['watershed-detail'] !== undefined) {
    const detail = num(o['watershed-detail'] as string, 'watershed-detail', 128, 0, 255)
    if (!Number.isInteger(detail)) fail('--watershed-detail must be an integer between 0 and 255')
    overrides.watershedDetail = detail
    if (overrides.clustering === undefined) overrides.clustering = 'watershed'
  }
  if ((o.binary || baseParams.colormode === 'binary') && (o.clustering !== undefined || o['watershed-detail'] !== undefined)) {
    const binarySource = o.binary ? '--binary' : `--preset ${presetId}`
    fail(`${binarySource} uses BW clustering; --clustering and --watershed-detail are only available in color mode`)
  }
  if (o['watershed-detail'] !== undefined && o.clustering === 'color-cluster') {
    fail('--watershed-detail requires Watershed; remove --clustering color-cluster or use --clustering watershed')
  }
  if (o.binary) overrides.colormode = 'binary'
  const custom = Object.keys(overrides).length > 0
  const auto: AutoTune = {
    enabled: !o['no-auto'],
    threshold: num(o.threshold as string | undefined, 'threshold', 3, 0, 100),
    maxKB: num(o['max-size'] as string | undefined, 'max-size', 400, 1, 1_000_000),
  }
  const settings: VectorizeSettings = { presetId: custom ? 'custom' : presetId, params: { ...baseParams, ...overrides }, auto }

  // Collect jobs (sheets are expanded into their elements).
  const files = listImages(positionals, !!o.recursive)
  type Job = { name: string; input: string; image: () => Promise<RGBAImage> }
  const jobs: Job[] = []
  for (const f of files) {
    if (o.slice) {
      const img = await decode(f)
      const sheet = sliceSheet(img)
      if (!sheet.boxes.length) fail(`no elements found in sheet: ${f}`)
      sheet.boxes.forEach((box, k) => {
        const name = `${stem(f)}-${String(k + 1).padStart(2, '0')}`
        jobs.push({ name, input: `${f}#${k + 1}`, image: async () => (sheet.background !== 'transparent' ? keyBackground(crop(img, box), sheet.background) : crop(img, box)) })
      })
    } else jobs.push({ name: stem(f), input: f, image: () => decode(f) })
  }
  // Unique output names, and refuse to overwrite unless --force.
  const used = new Set<string>()
  for (const j of jobs) {
    const base = j.name
    let n = 1
    while (used.has(j.name.toLowerCase())) j.name = `${base}-${++n}`
    used.add(j.name.toLowerCase())
  }
  const paths = [join(out, 'report.json'), ...jobs.flatMap((j) => [
    join(out, `${j.name}.svg`),
    ...(o.compare ? [join(out, `${j.name}.comparison.png`), join(out, `${j.name}.diff.png`)] : []),
    ...(o['diff-summary-json'] ? [join(out, `${j.name}.diff.json`)] : []),
  ])]
  // Even --force must not overwrite an input before the rest of the batch has read it.
  const inputKeys = new Set(files.flatMap(fileKeys))
  const inputClash = paths.find((path) => fileKeys(path).some((key) => inputKeys.has(key)))
  if (inputClash) fail(`output would overwrite an input: ${inputClash}`)
  if (!o.force) {
    const clash = paths.find((path) => existsSync(path))
    if (clash) fail(`${clash} already exists (use --force to overwrite)`)
  }
  mkdirSync(out, { recursive: true })

  const t0 = Date.now()
  const items: Record<string, unknown>[] = []
  let review = 0, errors = 0
  for (const [k, job] of jobs.entries()) {
    const prefix = `[${k + 1}/${jobs.length}]`
    try {
      const src = await job.image()
      const res = await vectorize(src, settings, nodeBackend)
      const t = res.trials[res.chosen]
      const svgPath = join(out, `${job.name}.svg`)
      writeFileSync(svgPath, t.svg)
      let comparison: string | undefined, diff: string | undefined
      let diffSummaryPath: string | undefined
      let diffSummary: ReturnType<typeof summarizeDiff> | undefined
      if (o.compare || o['diff-summary-json']) {
        const render = await nodeBackend.rasterize(t.svg, src.width, src.height)
        if (o.compare) {
          comparison = join(out, `${job.name}.comparison.png`)
          diff = join(out, `${job.name}.diff.png`)
          await writeComparison(src, render, comparison)
          await writePng(diffImage(src, render), diff)
        }
        if (o['diff-summary-json']) {
          diffSummaryPath = join(out, `${job.name}.diff.json`)
          diffSummary = summarizeDiff(src, render)
          writeFileSync(diffSummaryPath, JSON.stringify(diffSummary, null, 2) + '\n')
        }
      }
      const status = needsReviewResult(res, auto) ? 'review' : 'ok'
      if (status === 'review') review++
      const m = t.metrics
      items.push({
        name: job.name,
        input: job.input,
        output: svgPath,
        ...(comparison ? { comparison, diff } : {}),
        ...(diffSummaryPath ? { diffSummaryPath, diffSummary } : {}),
        status,
        width: src.width,
        height: src.height,
        analysis: analysisJson(res.analysis),
        notes: res.notes ?? [],
        autoTuned: res.autoTuned,
        trials: res.trials.length,
        ...(res.failedTrials.length ? { failedTrials: res.failedTrials } : {}),
        traceScale: t.traceScale ?? 1,
        traceMethod: t.traceMethod ?? 'vtracer',
        params: t.params,
        metrics: { pctDiff: r4(m.pctDiff), iou: r4(m.iou), rgbWhite: r4(m.rgbWhite), rgbDark: r4(m.rgbDark), alphaDiff: r4(m.alphaDiff), bytes: m.bytes, paths: m.paths, embeddedRaster: m.embeddedRaster },
      })
      log(`${prefix} ${status === 'ok' ? 'ok    ' : 'REVIEW'} ${job.name}  ${m.pctDiff.toFixed(2)}%  IoU ${(m.iou ?? 0).toFixed(3)}  ${kb(m.bytes)}  ${describe(t.params)}${(t.traceScale ?? 1) > 1 ? ` · trace ×${t.traceScale}` : ''}${res.autoTuned ? '  (auto-tuned)' : ''}`)
    } catch (e) {
      errors++
      const error = e instanceof Error ? e.message : String(e)
      items.push({ name: job.name, input: job.input, status: 'error', error })
      log(`${prefix} ERROR  ${job.name}  ${error}`)
    }
  }

  const report = {
    schemaVersion: SCHEMA_VERSION,
    tool: 'rastavec',
    version: VERSION,
    engine: nodeBackend.name,
    settings: { preset: settings.presetId, params: settings.presetId === 'auto' ? null : settings.params, autoTune: auto },
    summary: { total: jobs.length, ok: jobs.length - review - errors, review, errors, seconds: Math.round((Date.now() - t0) / 100) / 10 },
    items,
  }
  writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  if (json) process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  else log(`\n${report.summary.ok} ok · ${review} to review · ${errors} errors · ${report.summary.seconds}s → ${out}`)
  return errors ? EXIT.ERROR : review ? EXIT.REVIEW : EXIT.OK
}

async function cmdAnalyze(positionals: string[], o: Record<string, string | boolean | undefined>) {
  if (!positionals.length) fail('analyze needs at least one input (file or folder)')
  const files = listImages(positionals, !!o.recursive)
  const items = []
  for (const f of files) {
    try {
      const img = await decode(f)
      const a = analyze(img)
      const rec = recommend(a)
      items.push({ input: f, width: img.width, height: img.height, analysis: analysisJson(a), recommended: { params: rec.params, notes: rec.notes } })
      if (!o.json) process.stdout.write(`${stem(f)}: ${a.kind}, ${a.alpha}, ${a.dominantColors} colours → ${describe(rec.params)} [${rec.notes.join(', ')}]\n`)
    } catch (e) {
      items.push({ input: f, error: e instanceof Error ? e.message : String(e) })
      if (!o.json) process.stdout.write(`${stem(f)}: ERROR ${e instanceof Error ? e.message : e}\n`)
    }
  }
  if (o.json) process.stdout.write(JSON.stringify({ schemaVersion: SCHEMA_VERSION, tool: 'rastavec', version: VERSION, items }, null, 2) + '\n')
  return items.some((i) => 'error' in i) ? EXIT.ERROR : EXIT.OK
}

async function cmdSlice(positionals: string[], o: Record<string, string | boolean | undefined>) {
  if (positionals.length !== 1) fail('slice needs exactly one sheet image')
  const file = resolve(positionals[0])
  if (!existsSync(file)) fail(`input not found: ${positionals[0]}`)
  const out = resolve((o.out as string) ?? `${stem(file)}-elements`)
  const img = await decode(file)
  const sheet = sliceSheet(img)
  if (!sheet.boxes.length) fail(`no elements found in sheet: ${file}`)
  const paths = sheet.boxes.map((_, k) => join(out, `${stem(file)}-${String(k + 1).padStart(2, '0')}.png`))
  const inputKeys = new Set(fileKeys(file))
  const inputClash = paths.find((path) => fileKeys(path).some((key) => inputKeys.has(key)))
  if (inputClash) fail(`output would overwrite an input: ${inputClash}`)
  if (!o.force) {
    const clash = paths.find((path) => existsSync(path))
    if (clash) fail(`${clash} already exists (use --force to overwrite)`)
  }
  mkdirSync(out, { recursive: true })
  const elements = []
  for (const [k, box] of sheet.boxes.entries()) {
    const path = paths[k]
    await writePng(sheet.background !== 'transparent' ? keyBackground(crop(img, box), sheet.background) : crop(img, box), path)
    elements.push({ path, ...box })
  }
  const result = { schemaVersion: SCHEMA_VERSION, tool: 'rastavec', version: VERSION, input: file, background: sheet.background, dropped: sheet.dropped, elements }
  if (o.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  else if (!o.quiet) process.stdout.write(`${elements.length} elements → ${out}${sheet.dropped ? ` (${sheet.dropped} small isolated details ignored)` : ''}\n`)
  return EXIT.OK
}

// ------------------------------------------------------------------ entry point
async function main() {
  let parsed
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        out: { type: 'string', short: 'o' },
        preset: { type: 'string', short: 'p' },
        threshold: { type: 'string', short: 't' },
        'max-size': { type: 'string', short: 's' },
        'no-auto': { type: 'boolean' },
        compare: { type: 'boolean' },
        'diff-summary-json': { type: 'boolean' },
        slice: { type: 'boolean' },
        recursive: { type: 'boolean', short: 'r' },
        force: { type: 'boolean', short: 'f' },
        'color-precision': { type: 'string' },
        'layer-difference': { type: 'string' },
        speckle: { type: 'string' },
        mode: { type: 'string' },
        clustering: { type: 'string' },
        'watershed-detail': { type: 'string' },
        binary: { type: 'boolean' },
        json: { type: 'boolean' },
        quiet: { type: 'boolean', short: 'q' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    })
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e))
  }
  const { values: o, positionals } = parsed
  if (o.version) return void process.stdout.write(VERSION + '\n')
  const [command, ...rest] = positionals
  if (o.help || !command) return void process.stdout.write(HELP)
  const code =
    command === 'trace' ? await cmdTrace(rest, o)
    : command === 'analyze' ? await cmdAnalyze(rest, o)
    : command === 'slice' ? await cmdSlice(rest, o)
    : fail(`unknown command "${command}" (expected trace, analyze or slice)`)
  process.exitCode = code
}

main().catch((e) => fail(e instanceof Error ? e.stack ?? e.message : String(e)))
