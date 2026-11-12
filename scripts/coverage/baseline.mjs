#!/usr/bin/env node
// RastaVec coverage baseline harness.
//
// Usage:
//   node scripts/coverage/baseline.mjs --manifest scripts/coverage/temoins.json --out <dir>
//        [--warm 3] [--timeout 180000] [--only T01,T02] [--preset auto] [--max-side 512]
//
// Manifest: JSON array of { id, path, profile, [name], [corpus], [sha256] }; paths are relative to the
// repo root (or absolute). .svg entries are rasterized to <out>/prepared/<id>.png (sharp, longest side
// --max-side, transparent bg). Requires `cd cli && npm run build` beforehand.
// Output: results.json, results.csv, svg/<id>.svg, prepared/, diff/<id>.heat.png, diff/<id>.panel.png.
// Metrics live in ./metrics.mjs (reusable for other grids, e.g. JPEG/noise degradation).
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { REPO_ROOT, loadSharp, rasterize, render, decode, compare, measure, runCli, median, BACKGROUNDS } from './metrics.mjs';

// Budget profiles from the "Protocole" sheet (exploratory targets, not validated thresholds).
export const BUDGETS = {
  B01: { bytes: 30 * 1024, paths: 80, m01: 1, m02: 4, iou: 0.99 },
  B02: { bytes: 120 * 1024, paths: 400, m01: 2, m02: 6 },
  B03: { bytes: 250 * 1024, paths: 800, m01: 3, m02: 8 },
  B04: { bytes: 200 * 1024, paths: 1000, m01: 2, m02: 6 },
  B05: { bytes: 500 * 1024, paths: 2500, m01: 8, m02: 15 },
  B06: { bytes: 100 * 1024, paths: 4096, m01: 0, m02: 0 },
};

export function verdict(profile, r) {
  const b = BUDGETS[profile];
  if (!b || !r) return null;
  const v = {
    bytes: r.bytes <= b.bytes ? 'PASS' : 'FAIL',
    paths: r.paths <= b.paths ? 'PASS' : 'FAIL',
    m01: r.m01Worst <= b.m01 ? 'PASS' : 'FAIL',
    m02: r.m02Worst <= b.m02 ? 'PASS' : 'FAIL',
  };
  if (b.iou !== undefined && r.m05Iou != null) v.iou = r.m05Iou >= b.iou ? 'PASS' : 'FAIL';
  v.overall = Object.values(v).every((x) => x === 'PASS') ? 'PASS' : 'FAIL';
  return v;
}

function parseArgs(argv) {
  const a = { warm: 3, timeout: 180000, preset: 'auto', maxSide: 512 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => argv[++i];
    if (k === '--manifest') a.manifest = v();
    else if (k === '--out') a.out = v();
    else if (k === '--warm') a.warm = Number(v());
    else if (k === '--timeout') a.timeout = Number(v());
    else if (k === '--only') a.only = v().split(',');
    else if (k === '--preset') a.preset = v();
    else if (k === '--max-side') a.maxSide = Number(v());
  }
  if (!a.manifest || !a.out) throw new Error('usage: baseline.mjs --manifest <json> --out <dir> [--warm 3] [--timeout ms] [--only ids]');
  return a;
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const r2 = (x) => (x == null ? null : Math.round(x * 10000) / 10000);

async function processOne(entry, args, dirs) {
  const { sharp } = loadSharp();
  const res = { id: entry.id, name: entry.name ?? null, corpus: entry.corpus ?? null, profile: entry.profile, source: entry.path };
  const abs = path.isAbsolute(entry.path) ? entry.path : path.join(REPO_ROOT, entry.path);
  const srcBuf = await readFile(abs);
  res.sourceSha256 = sha256(srcBuf);
  res.shaExpected = entry.sha256 ?? null;
  res.shaOk = entry.sha256 ? entry.sha256 === res.sourceSha256 : null;
  let input = abs;
  if (/\.svg$/i.test(abs)) {
    const { png, width, height } = await rasterize(srcBuf, { maxSide: args.maxSide });
    input = path.join(dirs.prepared, `${entry.id}.png`);
    await writeFile(input, png);
    res.prepared = input;
    res.preparedSha256 = sha256(png);
    res.rasterSize = `${width}x${height}`;
  }
  res.input = input;

  // Timing: run 0 = cold, runs 1..warm = warm. Metrics come from run 0.
  const runs = [];
  let first = null;
  for (let i = 0; i <= args.warm; i++) {
    const r = await runCli(input, path.join(dirs.runs, entry.id, `r${i}`), { preset: args.preset, timeoutMs: args.timeout });
    runs.push({ ms: Math.round(r.ms), error: r.error ?? null, timedOut: !!r.timedOut });
    if (r.error) { res.status = r.timedOut ? 'timeout' : 'error'; res.error = r.error; break; }
    if (i === 0) first = r;
    else if (first) {
      const [a, b] = [await readFile(first.svgPath), await readFile(r.svgPath)];
      if (!a.equals(b)) res.nonDeterministic = true;
    }
  }
  res.runsMs = runs.map((r) => r.ms);
  const warm = runs.slice(1).filter((r) => !r.error).map((r) => r.ms);
  res.coldMs = runs[0]?.ms ?? null;
  res.warmMedianMs = warm.length ? median(warm) : null;
  res.warmMaxMs = warm.length ? Math.max(...warm) : null;
  if (!first) return res;
  res.status = 'ok';

  const item = first.item;
  res.width = item.width;
  res.height = item.height;
  res.traceMethod = item.traceMethod;
  res.analysisKind = item.analysis?.kind;
  res.cli = { pctDiff: item.metrics?.pctDiff, iou: item.metrics?.iou, alphaDiff: item.metrics?.alphaDiff, rgbWhite: item.metrics?.rgbWhite, rgbDark: item.metrics?.rgbDark, trials: item.trials, traceScale: item.traceScale, autoTuned: item.autoTuned };
  res.editableShare = item.metrics?.editableShare ?? null; // not reported by CLI 0.5.0-beta.5
  const svgText = await readFile(first.svgPath, 'utf8');
  const svgOut = path.join(dirs.svg, `${entry.id}.svg`);
  await writeFile(svgOut, svgText);
  res.svg = svgOut;
  Object.assign(res, measure(svgText));

  const src = await decode(input);
  if (src.width !== item.width || src.height !== item.height) res.sizeNote = `decoded ${src.width}x${src.height} vs cli ${item.width}x${item.height}`;
  const out = await render(svgText, src.width, src.height);
  const cmp = compare(src.data, out, src.width, src.height);
  res.perBg = Object.fromEntries(Object.entries(cmp.perBg).map(([k, v]) => [k, { m01: r2(v.m01), m02: r2(v.m02) }]));
  res.worstBg = cmp.worstBg;
  res.m01Worst = r2(cmp.m01Worst);
  res.m02Worst = r2(cmp.m02Worst);
  res.m04AlphaMae = r2(cmp.m04AlphaMae);
  res.m05Iou = r2(cmp.m05Iou);
  res.hasAlpha = cmp.hasAlpha;
  res.verdict = verdict(entry.profile, res);

  // Diagnostics: heatmap + panel (source | render | heat) on the worst background.
  const heatPath = path.join(dirs.diff, `${entry.id}.heat.png`);
  await sharp(cmp.heatmap, { raw: { width: src.width, height: src.height, channels: 4 } }).png().toFile(heatPath);
  const bg = BACKGROUNDS[cmp.worstBg];
  const flat = (buf) => sharp(buf, { raw: { width: src.width, height: src.height, channels: 4 } }).flatten({ background: { r: bg[0], g: bg[1], b: bg[2] } }).png().toBuffer();
  const panels = [await flat(src.data), await flat(out), await sharp(heatPath).toBuffer()];
  await sharp({ create: { width: src.width * 3 + 20, height: src.height, channels: 3, background: { r: 60, g: 60, b: 60 } } })
    .composite(panels.map((input2, i) => ({ input: input2, left: i * (src.width + 10), top: 0 })))
    .png()
    .toFile(path.join(dirs.diff, `${entry.id}.panel.png`));
  res.heat = heatPath;
  return res;
}

const CSV_COLS = [
  ['id', (r) => r.id], ['name', (r) => r.name], ['corpus', (r) => r.corpus], ['profile', (r) => r.profile],
  ['input', (r) => r.input], ['status', (r) => r.status], ['trace_method', (r) => r.traceMethod],
  ['m01_worst_pct', (r) => r.m01Worst], ['m01_worst_bg', (r) => r.worstBg],
  ['m01_white', (r) => r.perBg?.white.m01], ['m01_black', (r) => r.perBg?.black.m01], ['m01_grey128', (r) => r.perBg?.grey128.m01],
  ['m02_worst', (r) => r.m02Worst], ['m02_white', (r) => r.perBg?.white.m02], ['m02_black', (r) => r.perBg?.black.m02], ['m02_grey128', (r) => r.perBg?.grey128.m02],
  ['m04_alpha_mae', (r) => r.m04AlphaMae], ['m05_iou', (r) => r.m05Iou],
  ['svg_bytes', (r) => r.bytes], ['paths', (r) => r.paths], ['path_commands', (r) => r.commands], ['primitives', (r) => r.primitiveCount], ['gradients', (r) => r.gradients],
  ['editable_share', (r) => r.editableShare], ['cold_ms', (r) => r.coldMs], ['warm_median_ms', (r) => r.warmMedianMs], ['warm_max_ms', (r) => r.warmMaxMs],
  ['cli_pctDiff', (r) => r.cli?.pctDiff], ['cli_iou', (r) => r.cli?.iou],
  ['v_bytes', (r) => r.verdict?.bytes], ['v_paths', (r) => r.verdict?.paths], ['v_m01', (r) => r.verdict?.m01], ['v_m02', (r) => r.verdict?.m02], ['v_iou', (r) => r.verdict?.iou], ['v_overall', (r) => r.verdict?.overall],
  ['sha_ok', (r) => r.shaOk], ['error', (r) => r.error],
];
const csvCell = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
export const toCsv = (rows) => [CSV_COLS.map((c) => c[0]).join(','), ...rows.map((r) => CSV_COLS.map((c) => csvCell(c[1](r))).join(','))].join('\n') + '\n';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const out = path.resolve(args.out);
  const dirs = { prepared: path.join(out, 'prepared'), svg: path.join(out, 'svg'), diff: path.join(out, 'diff'), runs: path.join(out, '.runs') };
  for (const d of Object.values(dirs)) await mkdir(d, { recursive: true });
  const manifestPath = path.isAbsolute(args.manifest) ? args.manifest : path.resolve(args.manifest);
  let manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (args.only) manifest = manifest.filter((e) => args.only.includes(e.id));
  const results = [];
  for (const entry of manifest) {
    process.stderr.write(`[${entry.id}] ${entry.name ?? entry.path} ... `);
    let r;
    try {
      r = await processOne(entry, args, dirs);
    } catch (e) {
      r = { id: entry.id, name: entry.name, profile: entry.profile, source: entry.path, status: 'error', error: String(e?.stack || e) };
    }
    process.stderr.write(`${r.status}${r.m01Worst != null ? ` m01=${r.m01Worst} bytes=${r.bytes}` : ''} ${r.warmMedianMs ?? ''}ms\n`);
    results.push(r);
    await writeFile(path.join(out, 'results.json'), JSON.stringify({ meta: { ...loadSharp().versions, node: process.version, date: new Date().toISOString(), preset: args.preset, warmRuns: args.warm, maxSide: args.maxSide, manifest: manifestPath }, budgets: BUDGETS, results }, null, 2));
    await writeFile(path.join(out, 'results.csv'), toCsv(results));
  }
}

import { fileURLToPath } from 'node:url';
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(2); });
}
