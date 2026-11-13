#!/usr/bin/env node
// Degradation variant generator for the JPEG / noise grid (CV-075, CV-055, CV-118).
//
// Usage: node scripts/coverage/degrade.mjs --out <dir> [--data-root <repo with internal-docs>] [--seed 20261112]
//
// For each parent: <out>/variants/<parent>/{clean.png, jpeg-q95.jpg, jpeg-q75.jpg, jpeg-q40.jpg,
// jpeg-q75-444.jpg, noise-s2.png, noise-s5.png} + variants.json (manifest incl. sha256, codec settings).
// - JPEG has no alpha: every parent is FLATTENED ON WHITE first; the flattened image is the "clean" reference
//   (clean.png) used for scoring ALL variants (Gaussian noise sigma 0 == clean.png).
// - JPEG: sharp/libvips mozjpeg:true, chroma subsampling 4:2:0 (default) except jpeg-q75-444 (4:4:4).
// - Noise: additive Gaussian, independent per RGB channel, sigma in 0..255 units, clamped, PRNG mulberry32
//   (seed + sigma/parent-specific offset) + Box-Muller, so runs are reproducible.
// - Parent T01s (CV-118): T01 flattened on white, resized to 96 px wide (lanczos3), contrast reduced 40%
//   toward mid-grey (v' = 128 + 0.6 (v - 128)).
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, loadSharp } from './metrics.mjs';

export const SEED = 20261112;
export const PARENTS = [
  { id: 'T01', cv: 'CV-075', kind: 'logo', path: 'assets/rastavec-logo.png' },
  { id: 'T15', cv: 'CV-075', kind: 'flat shapes', path: 'internal-docs/tests/fixtures/object-detection/raster/09-overlap-flat-opaque-mixed-shapes.png' },
  { id: 'T06', cv: 'CV-075', kind: 'mascot', path: 'tests/fixtures/grouping-corpus/kenney-bear.png' },
  { id: 'T27', cv: 'CV-055', kind: 'gradient horizon', gradient: true, path: 'internal-docs/coverage-audit-2026-11-12/baseline-0.5.0-beta.5/prepared/T27.png' },
  { id: 'T16', cv: 'CV-055', kind: 'gradient on dark', gradient: true, path: 'internal-docs/tests/fixtures/object-detection/raster/12-overlap-gradient-alpha-dark-backdrop.png' },
  { id: 'T01s', cv: 'CV-118', kind: 'small low-contrast logo', derivedFrom: 'T01', smallWidth: 96, contrastLoss: 0.4, path: 'assets/rastavec-logo.png' },
];
export const VARIANTS = [
  { id: 'clean', file: 'clean.png', type: 'png' },
  { id: 'jpeg-q95', file: 'jpeg-q95.jpg', type: 'jpeg', quality: 95, chroma: '4:2:0' },
  { id: 'jpeg-q75', file: 'jpeg-q75.jpg', type: 'jpeg', quality: 75, chroma: '4:2:0' },
  { id: 'jpeg-q40', file: 'jpeg-q40.jpg', type: 'jpeg', quality: 40, chroma: '4:2:0' },
  { id: 'jpeg-q75-444', file: 'jpeg-q75-444.jpg', type: 'jpeg', quality: 75, chroma: '4:4:4' },
  { id: 'noise-s2', file: 'noise-s2.png', type: 'png', sigma: 2 },
  { id: 'noise-s5', file: 'noise-s5.png', type: 'png', sigma: 5 },
];

const sha256 = (b) => createHash('sha256').update(b).digest('hex');

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function addGaussianNoise(rgb, sigma, seed) {
  const rnd = mulberry32(seed);
  const out = Buffer.from(rgb);
  for (let i = 0; i < out.length; i += 2) {
    const u = Math.max(rnd(), 1e-12), v = rnd();
    const r = Math.sqrt(-2 * Math.log(u));
    const z0 = r * Math.cos(2 * Math.PI * v), z1 = r * Math.sin(2 * Math.PI * v);
    out[i] = Math.max(0, Math.min(255, Math.round(out[i] + sigma * z0)));
    if (i + 1 < out.length) out[i + 1] = Math.max(0, Math.min(255, Math.round(out[i + 1] + sigma * z1)));
  }
  return out;
}

function resolveParent(p, dataRoot) {
  for (const root of [REPO_ROOT, dataRoot].filter(Boolean)) {
    const f = path.join(root, p.path);
    if (existsSync(f)) return f;
  }
  throw new Error(`parent ${p.id} not found: ${p.path} (try --data-root)`);
}

/** Flattened-on-white, optionally derived, raw RGB parent. */
export async function loadCleanParent(p, dataRoot) {
  const { sharp } = loadSharp();
  const file = resolveParent(p, dataRoot);
  const srcBuf = await readFile(file);
  let img = sharp(srcBuf).flatten({ background: '#ffffff' });
  if (p.smallWidth) img = img.resize({ width: p.smallWidth, kernel: 'lanczos3' });
  let { data, info } = await img.removeAlpha().raw().toBuffer({ resolveWithObject: true });
  if (p.contrastLoss) {
    const k = 1 - p.contrastLoss;
    data = Buffer.from(data.map((v) => Math.round(128 + k * (v - 128))));
  }
  const meta = await sharp(srcBuf).metadata();
  return { rgb: data, width: info.width, height: info.height, file, srcSha256: sha256(srcBuf), srcHadAlpha: !!meta.hasAlpha };
}

export async function generate(outDir, { dataRoot, seed = SEED, only } = {}) {
  const { sharp, versions } = loadSharp();
  const manifest = {
    meta: { seed, ...versions, date: new Date().toISOString(), flatten: 'white', note: 'JPEG has no alpha: all parents flattened on white; clean.png is the flattened reference' },
    parents: {},
  };
  for (const p of PARENTS) {
    if (only && !only.includes(p.id)) continue;
    const c = await loadCleanParent(p, dataRoot);
    const dir = path.join(outDir, 'variants', p.id);
    await mkdir(dir, { recursive: true });
    const raw = (buf) => sharp(buf, { raw: { width: c.width, height: c.height, channels: 3 } });
    const entry = { ...p, source: c.file, sourceSha256: c.srcSha256, sourceHadAlpha: c.srcHadAlpha, width: c.width, height: c.height, variants: {} };
    for (const v of VARIANTS) {
      const file = path.join(dir, v.file);
      let buf, noiseSeed;
      if (v.id === 'clean') buf = await raw(c.rgb).png().toBuffer();
      else if (v.type === 'jpeg') buf = await raw(c.rgb).jpeg({ quality: v.quality, mozjpeg: true, chromaSubsampling: v.chroma }).toBuffer();
      else {
        noiseSeed = seed + v.sigma * 1000 + p.id.charCodeAt(1) * 7 + p.id.length;
        buf = await raw(addGaussianNoise(c.rgb, v.sigma, noiseSeed)).png().toBuffer();
      }
      await writeFile(file, buf);
      entry.variants[v.id] = { ...v, noiseSeed, path: file, bytes: buf.length, sha256: sha256(buf) };
    }
    manifest.parents[p.id] = entry;
  }
  await writeFile(path.join(outDir, 'variants.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const get = (k) => (a.includes(k) ? a[a.indexOf(k) + 1] : undefined);
  if (!get('--out')) {
    console.error('usage: degrade.mjs --out <dir> [--data-root <dir>] [--seed n] [--only ids]');
    process.exit(2);
  }
  const m = await generate(path.resolve(get('--out')), { dataRoot: get('--data-root'), seed: get('--seed') ? Number(get('--seed')) : SEED, only: get('--only')?.split(',') });
  console.log(`generated variants for ${Object.keys(m.parents).join(', ')}`);
}
