#!/usr/bin/env node
// Floor for the JPEG / noise grid: how far is the DEGRADED INPUT itself from the CLEAN parent (M01@16/@32, M02)?
// A vectorizer that traced the degraded input perfectly would score about this vs clean; anything above is
// vectorization loss, anything below means the trace denoised. Adds `floor` to each row of results.json and
// writes floor.csv. Usage: node scripts/coverage/floor.mjs <gridOutDir>
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { decode, compare } from './metrics.mjs';

const dir = path.resolve(process.argv[2] ?? '');
const file = path.join(dir, 'results.json');
const data = JSON.parse(await readFile(file, 'utf8'));
const manifest = JSON.parse(await readFile(path.join(dir, 'variants.json'), 'utf8'));
const rows = ['parent,variant,floor_m01_16,floor_m01_32,floor_m02,result_m01_16_vs_clean,excess_m01_16'];
const r2 = (x) => Math.round(x * 10000) / 10000;
for (const r of data.results) {
  const clean = await decode(manifest.parents[r.parent].variants.clean.path);
  const inp = await decode(r.input);
  const c = compare(clean.data, inp.data, clean.width, clean.height);
  r.floor = { m01: r2(c.m01Worst), m01t32: r2(c.m01t32Worst), m02: r2(c.m02Worst) };
  const res = r.vsClean?.m01Worst;
  rows.push([r.parent, r.variant, r.floor.m01, r.floor.m01t32, r.floor.m02, res ?? '', res == null ? '' : r2(res - r.floor.m01)].join(','));
}
await writeFile(file, JSON.stringify(data, null, 2));
await writeFile(path.join(dir, 'floor.csv'), rows.join('\n') + '\n');
console.log(rows.join('\n'));
