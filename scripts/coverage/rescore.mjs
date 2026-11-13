#!/usr/bin/env node
// Re-score an existing baseline output folder (results.json + svg/) without re-running the CLI.
// Usage: node scripts/coverage/rescore.mjs <outDir>
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { scorePair } from './metrics.mjs';
import { verdict, toCsv } from './baseline.mjs';

const dir = path.resolve(process.argv[2] ?? '');
const file = path.join(dir, 'results.json');
const data = JSON.parse(await readFile(file, 'utf8'));
for (const r of data.results) {
  if (r.status !== 'ok') continue;
  const { fields } = await scorePair(r.input, await readFile(r.svg, 'utf8'));
  Object.assign(r, fields);
  r.verdict = verdict(r.profile, r);
}
data.meta.rescored = new Date().toISOString();
await writeFile(file, JSON.stringify(data, null, 2));
await writeFile(path.join(dir, 'results.csv'), toCsv(data.results));
console.log(`rescored ${data.results.length} entries in ${dir}`);
