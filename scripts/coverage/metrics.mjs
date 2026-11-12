// Reusable fidelity / complexity / timing metrics for RastaVec coverage runs.
// Exports: loadSharp, rasterize, render, decode, compare, measure, runCli, median.
// Metric ids follow the "Protocole" sheet of RastaVec-matrice-couverture.xlsx.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '..', '..');

let _sharp;
/** Load sharp from cli/node_modules (falls back to root). Returns { sharp, versions }. */
export function loadSharp() {
  if (_sharp) return _sharp;
  let sharp, version;
  for (const base of [path.join(REPO_ROOT, 'cli', 'package.json'), path.join(REPO_ROOT, 'package.json')]) {
    try {
      const req = createRequire(base);
      sharp = req('sharp');
      version = req('sharp/package.json').version;
      break;
    } catch {
      /* try next */
    }
  }
  if (!sharp) throw new Error('sharp not found in cli/node_modules or node_modules');
  _sharp = { sharp, versions: { sharp: version, librsvg: sharp.versions.rsvg, vips: sharp.versions.vips } };
  return _sharp;
}

export const BACKGROUNDS = { white: [255, 255, 255], black: [0, 0, 0], grey128: [128, 128, 128] };
export const M01_THRESHOLD = 16;

/**
 * Rasterize an SVG to PNG: longest side = maxSide, ratio kept, transparent background.
 * @returns {{png: Buffer, width: number, height: number}}
 */
export async function rasterize(svg, { maxSide = 512 } = {}) {
  const { sharp } = loadSharp();
  const buf = Buffer.isBuffer(svg) ? svg : Buffer.from(svg);
  const meta = await sharp(buf).metadata();
  const scale = maxSide / Math.max(meta.width, meta.height);
  const width = Math.max(1, Math.round(meta.width * scale));
  const height = Math.max(1, Math.round(meta.height * scale));
  const png = await sharp(buf, { density: 72 * scale })
    .resize(width, height, { fit: 'fill' })
    .ensureAlpha()
    .png()
    .toBuffer();
  return { png, width, height };
}

/** Render an SVG at exact dimensions to raw non-premultiplied RGBA (transparent background). */
export async function render(svg, width, height) {
  const { sharp } = loadSharp();
  const buf = Buffer.isBuffer(svg) ? svg : Buffer.from(svg);
  const meta = await sharp(buf).metadata();
  const density = 72 * Math.max(width / meta.width, height / meta.height);
  const { data, info } = await sharp(buf, { density })
    .resize(width, height, { fit: 'fill' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.width !== width || info.height !== height) throw new Error('render size mismatch');
  return data; // RGBA
}

/** Decode a PNG/JPEG/... file path or buffer to raw RGBA. */
export async function decode(input) {
  const { sharp } = loadSharp();
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/**
 * Compare source vs rendered RGBA buffers (same size).
 * M01 (% of pixels with max |dRGB| > 16), M02 (RMSE RGB) per background; M04 alpha MAE;
 * M05 silhouette IoU (alpha>0.5) when the source has transparency.
 * Also returns a diff heatmap (RGBA raw) for the worst background (or `heatmapBg`).
 */
export function compare(src, out, width, height, { heatmapBg = 'worst' } = {}) {
  const n = width * height;
  let alphaAbs = 0, inter = 0, union = 0, hasAlpha = false;
  for (let i = 0; i < n; i++) {
    const a = src[i * 4 + 3], b = out[i * 4 + 3];
    if (a < 255) hasAlpha = true;
    alphaAbs += Math.abs(a - b);
    const sa = a > 127.5, sb = b > 127.5;
    if (sa && sb) inter++;
    if (sa || sb) union++;
  }
  const perBg = {};
  const diffMaps = {};
  for (const [name, bg] of Object.entries(BACKGROUNDS)) {
    let bad = 0, sq = 0;
    const map = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      const sa = src[o + 3] / 255, oa = out[o + 3] / 255;
      let mx = 0;
      for (let c = 0; c < 3; c++) {
        const s = src[o + c] * sa + bg[c] * (1 - sa);
        const r = out[o + c] * oa + bg[c] * (1 - oa);
        const d = Math.abs(s - r);
        sq += d * d;
        if (d > mx) mx = d;
      }
      map[i] = Math.min(255, Math.round(mx));
      if (mx > M01_THRESHOLD) bad++;
    }
    perBg[name] = { m01: (100 * bad) / n, m02: Math.sqrt(sq / (3 * n)) };
    diffMaps[name] = map;
  }
  const worstBg = Object.entries(perBg).sort((a, b) => b[1].m01 - a[1].m01)[0][0];
  const res = {
    perBg,
    worstBg,
    m01Worst: perBg[worstBg].m01,
    m02Worst: Math.max(...Object.values(perBg).map((v) => v.m02)),
    m04AlphaMae: hasAlpha ? alphaAbs / n : null,
    m05Iou: hasAlpha ? (union ? inter / union : 1) : null,
    hasAlpha,
  };
  const hb = heatmapBg === 'worst' ? worstBg : heatmapBg;
  const map = diffMaps[hb];
  const heat = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    const v = map[i];
    let r, g, b;
    if (v > M01_THRESHOLD) {
      // above threshold: red -> yellow -> white
      const t = (v - M01_THRESHOLD) / (255 - M01_THRESHOLD);
      r = 255;
      g = Math.round(255 * Math.min(1, t * 2));
      b = Math.round(255 * Math.max(0, t * 2 - 1));
    } else {
      r = g = b = Math.round(v * 6); // sub-threshold: dim grey
    }
    heat[i * 4] = r;
    heat[i * 4 + 1] = g;
    heat[i * 4 + 2] = b;
    heat[i * 4 + 3] = 255;
  }
  res.heatmap = heat;
  res.heatmapBg = hb;
  return res;
}

/** Static SVG complexity (M07): raw UTF-8 bytes, <path> count, path commands, primitives. */
export function measure(svgText) {
  const bytes = Buffer.byteLength(svgText, 'utf8');
  const paths = (svgText.match(/<path\b/g) || []).length;
  let commands = 0;
  for (const m of svgText.matchAll(/<path\b[^>]*?\sd="([^"]*)"/g)) commands += (m[1].match(/[MmLlHhVvCcSsQqTtAaZz]/g) || []).length;
  const count = (t) => (svgText.match(new RegExp(`<${t}\\b`, 'g')) || []).length;
  const primitives = { circle: count('circle'), ellipse: count('ellipse'), rect: count('rect'), polygon: count('polygon'), polyline: count('polyline'), line: count('line') };
  return {
    bytes,
    paths,
    commands,
    primitives,
    primitiveCount: Object.values(primitives).reduce((a, b) => a + b, 0),
    gradients: (svgText.match(/<(?:linear|radial)Gradient\b/g) || []).length,
    embeddedRaster: /<image\b/.test(svgText),
  };
}

export const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Run the RastaVec CLI once on an image. outDir is wiped and recreated by the CLI.
 * @returns {{ms:number, item?:object, svgPath?:string, error?:string, timedOut?:boolean}}
 */
export async function runCli(input, outDir, { preset = 'auto', extraArgs = [], timeoutMs = 180000, cliPath = path.join(REPO_ROOT, 'cli', 'dist', 'rastavec.cjs') } = {}) {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(path.dirname(outDir), { recursive: true });
  const args = [cliPath, 'trace', input, '--preset', preset, '--out', outDir, '--json', '-q', ...extraArgs];
  const t0 = performance.now();
  return await new Promise((resolve) => {
    const p = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '', err = '', timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      p.kill();
    }, timeoutMs);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => {
      clearTimeout(timer);
      const ms = performance.now() - t0;
      if (timedOut) return resolve({ ms, timedOut: true, error: `timeout after ${timeoutMs} ms` });
      try {
        const json = JSON.parse(out);
        const item = json.items?.[0];
        if (!item || item.status === 'error') return resolve({ ms, error: item?.error || item?.message || `cli exit ${code}: ${err.slice(0, 300)}`, item });
        resolve({ ms, item, svgPath: item.output, exitCode: code });
      } catch {
        resolve({ ms, error: `unparseable CLI output (exit ${code}): ${(out + err).slice(0, 300)}` });
      }
    });
  });
}
