#!/usr/bin/env node
// JPEG / noise degradation grid: run the RastaVec CLI (Auto preset) on every variant from degrade.mjs and score it.
//
// Usage: node scripts/coverage/grid.mjs --out <dir> [--data-root <repo with internal-docs>] [--only T01,T27]
//        [--skip-generate] [--timeout 300000]
// Requires `cd cli && npm run build`. Output: results.json, results.csv, svg/<parent>/<variant>.svg, panels/.
//
// Metrics per case (scored against the CLEAN flattened parent = intent; "vsInput" = against the degraded file):
//  M01@16 / M01@32 (worst of white/black/grey128 backgrounds, harness definition), M02 RMSE, bytes, paths,
//  cold ms (run 0) + repeat ms (run 1), CLI-reported pctDiff.
//  topology: up to 6 dominant colours are extracted from the clean parent (top 4-bit colour bins >= 1 % of
//  pixels, merged when closer than 48 in RGB distance); clean parent and rendered result (flattened white), both
//  downscaled (nearest) to <= 512 px, are assigned to the nearest palette colour; per colour mask we count
//  8-connected foreground components and holes (4-connected background components not touching the border).
//  Reported: components/holes for clean parent and result, plus "sig" counts (area >= 0.05 % of the image) so
//  that tiny specks are separable from real shapes. Deltas = result - clean parent.
//  falseContour (gradients): share of horizontal+vertical neighbour pairs where the result's max-channel
//  difference >= 12 while the CLEAN parent's is <= 6.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { loadSharp, scorePair, measure, runCli, decode, render } from './metrics.mjs';
import { generate, VARIANTS } from './degrade.mjs';

const r2 = (x) => (x == null ? null : Math.round(x * 10000) / 10000);

// ---------- topology ----------
function palette(rgb, n) {
  const bins = new Map();
  for (let i = 0; i < n; i++) {
    const k = ((rgb[i * 3] >> 4) << 8) | ((rgb[i * 3 + 1] >> 4) << 4) | (rgb[i * 3 + 2] >> 4);
    bins.set(k, (bins.get(k) || 0) + 1);
  }
  const sorted = [...bins.entries()].sort((a, b) => b[1] - a[1]);
  const pal = [];
  for (const [k, cnt] of sorted) {
    if (cnt < 0.01 * n || pal.length >= 6) break;
    const c = [((k >> 8) & 15) * 16 + 8, ((k >> 4) & 15) * 16 + 8, (k & 15) * 16 + 8];
    if (pal.every((p) => Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]) >= 48)) pal.push(c);
  }
  return pal.length ? pal : [[128, 128, 128]];
}
function labelMap(rgb, n, pal) {
  const lab = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    let best = 0, bd = Infinity;
    for (let j = 0; j < pal.length; j++) {
      const d = (rgb[i * 3] - pal[j][0]) ** 2 + (rgb[i * 3 + 1] - pal[j][1]) ** 2 + (rgb[i * 3 + 2] - pal[j][2]) ** 2;
      if (d < bd) { bd = d; best = j; }
    }
    lab[i] = best;
  }
  return lab;
}
// flood-fill labelling; returns list of components {area, border}
function components(mask, w, h, fg, conn8) {
  const seen = new Uint8Array(w * h);
  const comps = [];
  const stack = [];
  for (let s = 0; s < w * h; s++) {
    if (seen[s] || (mask[s] === 1) !== fg) continue;
    let area = 0, border = false;
    stack.push(s);
    seen[s] = 1;
    while (stack.length) {
      const p = stack.pop();
      area++;
      const x = p % w, y = (p / w) | 0;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) border = true;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if ((dx === 0 && dy === 0) || (!conn8 && dx && dy)) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const q = ny * w + nx;
        if (seen[q] || (mask[q] === 1) !== fg) continue;
        seen[q] = 1;
        stack.push(q);
      }
    }
    comps.push({ area, border });
  }
  return comps;
}
function topology(lab, w, h, k) {
  const sigMin = 0.0005 * w * h;
  let comp = 0, holes = 0, compSig = 0, holesSig = 0;
  for (let c = 0; c < k; c++) {
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) mask[i] = lab[i] === c ? 1 : 0;
    for (const x of components(mask, w, h, true, true)) { comp++; if (x.area >= sigMin) compSig++; }
    for (const x of components(mask, w, h, false, false)) if (!x.border) { holes++; if (x.area >= sigMin) holesSig++; }
  }
  return { comp, holes, compSig, holesSig };
}
async function topologyScore(cleanPath, svgText) {
  const { sharp } = loadSharp();
  const meta = await sharp(cleanPath).metadata();
  const s = Math.min(1, 512 / Math.max(meta.width, meta.height));
  const w = Math.max(1, Math.round(meta.width * s)), h = Math.max(1, Math.round(meta.height * s));
  const cleanRgb = await sharp(cleanPath).flatten({ background: '#fff' }).resize(w, h, { kernel: 'nearest' }).removeAlpha().raw().toBuffer();
  const full = await render(svgText, meta.width, meta.height);
  const outRgb = await sharp(full, { raw: { width: meta.width, height: meta.height, channels: 4 } }).flatten({ background: '#fff' }).resize(w, h, { kernel: 'nearest' }).removeAlpha().raw().toBuffer();
  const pal = palette(cleanRgb, w * h);
  const a = topology(labelMap(cleanRgb, w * h, pal), w, h, pal.length);
  const b = topology(labelMap(outRgb, w * h, pal), w, h, pal.length);
  return { palette: pal.length, clean: a, result: b, dComp: b.comp - a.comp, dHoles: b.holes - a.holes, dCompSig: b.compSig - a.compSig, dHolesSig: b.holesSig - a.holesSig };
}

// ---------- false contours ----------
async function falseContour(cleanPath, svgText) {
  const src = await decode(cleanPath);
  const out = await render(svgText, src.width, src.height);
  const { width: w, height: h } = src;
  const flat = (d) => {
    const o = new Float32Array(w * h * 3);
    for (let i = 0; i < w * h; i++) {
      const a = d[i * 4 + 3] / 255;
      for (let c = 0; c < 3; c++) o[i * 3 + c] = d[i * 4 + c] * a + 255 * (1 - a);
    }
    return o;
  };
  const S = flat(src.data), O = flat(out);
  const md = (A, p, q) => Math.max(Math.abs(A[p * 3] - A[q * 3]), Math.abs(A[p * 3 + 1] - A[q * 3 + 1]), Math.abs(A[p * 3 + 2] - A[q * 3 + 2]));
  let hit = 0, total = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = y * w + x;
    for (const q of [x + 1 < w ? p + 1 : -1, y + 1 < h ? p + w : -1]) {
      if (q < 0) continue;
      total++;
      if (md(O, p, q) >= 12 && md(S, p, q) <= 6) hit++;
    }
  }
  return (100 * hit) / total;
}

function parseArgs(argv) {
  const a = { timeout: 300000 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--out') a.out = argv[++i];
    else if (k === '--data-root') a.dataRoot = argv[++i];
    else if (k === '--only') a.only = argv[++i].split(',');
    else if (k === '--skip-generate') a.skipGenerate = true;
    else if (k === '--timeout') a.timeout = Number(argv[++i]);
  }
  if (!a.out) throw new Error('usage: grid.mjs --out <dir> [--data-root dir] [--only ids] [--skip-generate]');
  return a;
}

const COLS = ['parent', 'variant', 'status', 'm01_16_vs_clean', 'm01_32_vs_clean', 'm02_vs_clean', 'm01_16_vs_input', 'm01_32_vs_input', 'm02_vs_input', 'bytes', 'paths', 'commands', 'cold_ms', 'repeat_ms', 'cli_pctDiff', 'comp_clean', 'comp_result', 'd_comp', 'd_comp_sig', 'holes_clean', 'holes_result', 'd_holes', 'd_holes_sig', 'false_contour_pct', 'error'];
const toCsv = (rows) => [COLS.join(','), ...rows.map((r) => COLS.map((c) => {
  const v = (r.csv ?? {})[c] ?? (c === 'parent' ? r.parent : c === 'variant' ? r.variant : c === 'status' ? r.status : c === 'error' ? r.error : undefined);
  return v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v;
}).join(','))].join('\n') + '\n';

async function panel(outPath, cleanPath, inputPath, svgText, heatPng, w, h) {
  const { sharp } = loadSharp();
  const rend = await sharp(await render(svgText, w, h), { raw: { width: w, height: h, channels: 4 } }).flatten({ background: '#fff' }).png().toBuffer();
  const tiles = [await sharp(cleanPath).png().toBuffer(), await sharp(inputPath).flatten({ background: '#fff' }).png().toBuffer(), rend, heatPng];
  const scale = Math.max(1, Math.min(4, Math.floor(480 / w)));
  const tw = w * scale, th = h * scale;
  const resized = await Promise.all(tiles.map((t) => sharp(t).resize(tw, th, { kernel: 'nearest' }).png().toBuffer()));
  await sharp({ create: { width: tw * 4 + 30, height: th, channels: 3, background: { r: 60, g: 60, b: 60 } } })
    .composite(resized.map((input, i) => ({ input, left: i * (tw + 10), top: 0 })))
    .png()
    .toFile(outPath);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const out = path.resolve(args.out);
  await mkdir(out, { recursive: true });
  const manifest = args.skipGenerate ? JSON.parse(await readFile(path.join(out, 'variants.json'), 'utf8')) : await generate(out, { dataRoot: args.dataRoot, only: args.only });
  const { sharp } = loadSharp();
  const results = [];
  const save = async () => {
    await writeFile(path.join(out, 'results.json'), JSON.stringify({ meta: { ...manifest.meta, node: process.version, preset: 'auto', runs: 'run0=cold(metrics), run1=repeat', date: new Date().toISOString() }, results }, null, 2));
    await writeFile(path.join(out, 'results.csv'), toCsv(results));
  };
  for (const [pid, pe] of Object.entries(manifest.parents)) {
    if (args.only && !args.only.includes(pid)) continue;
    const cleanPath = pe.variants.clean.path;
    await mkdir(path.join(out, 'svg', pid), { recursive: true });
    await mkdir(path.join(out, 'panels'), { recursive: true });
    for (const v of VARIANTS) {
      const ve = pe.variants[v.id];
      const r = { parent: pid, cv: pe.cv, kind: pe.kind, variant: v.id, input: ve.path, inputBytes: ve.bytes, width: pe.width, height: pe.height };
      process.stderr.write(`[${pid}/${v.id}] `);
      try {
        const runs = [];
        let first;
        for (let i = 0; i < 2; i++) {
          const c = await runCli(ve.path, path.join(out, '.runs', pid, v.id, `r${i}`), { timeoutMs: args.timeout });
          runs.push(Math.round(c.ms));
          if (c.error) { r.status = c.timedOut ? 'timeout' : 'error'; r.error = c.error; break; }
          if (i === 0) first = c;
          else if (!(await readFile(first.svgPath)).equals(await readFile(c.svgPath))) r.nonDeterministic = true;
        }
        r.coldMs = runs[0];
        r.repeatMs = runs[1] ?? null;
        if (first) {
          r.status = 'ok';
          const svgText = await readFile(first.svgPath, 'utf8');
          r.svg = path.join(out, 'svg', pid, `${v.id}.svg`);
          await writeFile(r.svg, svgText);
          r.traceMethod = first.item.traceMethod;
          r.analysisKind = first.item.analysis?.kind;
          r.cliPctDiff = first.item.metrics?.pctDiff ?? null;
          Object.assign(r, measure(svgText));
          const vsClean = await scorePair(cleanPath, svgText);
          const vsInput = v.id === 'clean' ? vsClean : await scorePair(ve.path, svgText);
          r.vsClean = vsClean.fields;
          r.vsInput = vsInput.fields;
          r.topology = await topologyScore(cleanPath, svgText);
          r.falseContourPct = r2(await falseContour(cleanPath, svgText));
          const heatPng = await sharp(vsClean.cmp.heatmap, { raw: { width: pe.width, height: pe.height, channels: 4 } }).png().toBuffer();
          r.panel = path.join(out, 'panels', `${pid}__${v.id}.png`);
          await panel(r.panel, cleanPath, ve.path, svgText, heatPng, pe.width, pe.height);
          const t = r.topology;
          r.csv = {
            m01_16_vs_clean: vsClean.fields.m01Worst, m01_32_vs_clean: vsClean.fields.m01t32Worst, m02_vs_clean: vsClean.fields.m02Worst,
            m01_16_vs_input: vsInput.fields.m01Worst, m01_32_vs_input: vsInput.fields.m01t32Worst, m02_vs_input: vsInput.fields.m02Worst,
            bytes: r.bytes, paths: r.paths, commands: r.commands, cold_ms: r.coldMs, repeat_ms: r.repeatMs, cli_pctDiff: r.cliPctDiff,
            comp_clean: t.clean.comp, comp_result: t.result.comp, d_comp: t.dComp, d_comp_sig: t.dCompSig,
            holes_clean: t.clean.holes, holes_result: t.result.holes, d_holes: t.dHoles, d_holes_sig: t.dHolesSig,
            false_contour_pct: r.falseContourPct,
          };
        }
      } catch (e) {
        r.status = 'error';
        r.error = String(e?.stack || e);
      }
      process.stderr.write(`${r.status} ${r.vsClean ? `m01=${r.vsClean.m01Worst} paths=${r.paths} bytes=${r.bytes} ${r.coldMs}ms` : r.error ?? ''}\n`);
      results.push(r);
      await save();
    }
  }
}
main().catch((e) => { console.error(e); process.exit(2); });
