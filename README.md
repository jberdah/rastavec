# SVG Studio

Vectorise PNG/JPEG/WebP images into editable SVG, compare each result with its source and
tune it automatically, deterministically, 100 % in the browser (images never leave the device).

POC status: **Import → batch review → detail/compare → export** work. Colour editing and
animation are mocked up but not implemented yet.

## Run

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # static site in dist/
npm run check      # svelte-check + tsc
```

## How it works

```
src/lib/engine/core.ts             pure TS, no DOM: prepare (alpha floor, keying, silhouette mask),
                                   metrics, diff map, auto-tune grid, scoring, choice
src/lib/engine/browser-backend.ts  TraceBackend for the browser: vtracer-webapp (wasm) + canvas
src/lib/engine/presets.ts          presets, same parameter units as the raster-to-svg skill
src/lib/pipeline.ts                per-image pipeline: decode → trace → render → measure → auto-tune
src/lib/export.ts                  zip: svg/*.svg, metrics.csv, config.json (replays the batch)
src/lib/views/*                    Import, Lot (batch), Detail screens (Svelte 5)
```

- **Engine**: [VTracer](https://github.com/visioncortex/vtracer) via the official
  `vtracer-webapp` wasm build (MIT/Apache-2.0). It needs DOM elements, so it runs on the main
  thread, time-sliced to keep the UI responsive.
- **Transparency**: transparent pixels are keyed, then the colour result is clipped by a
  silhouette traced separately from the alpha channel (alpha ≥ 96), the two-pass technique
  validated on the Brainclaw avatars. Semi-transparency is not preserved (made opaque) and
  is flagged in the detail view.
- **Metrics** (identical to the skill's `compare.cjs`): silhouette IoU at alpha ≥ 128,
  mean colour difference on white and on #202020 (0–255), alpha difference, and
  `pct_pixels_diff_gt_32`, the share of visibly different pixels used for ranking.
- **Auto-tune**: when an image exceeds the difference threshold or the size budget, a fixed
  grid of up to 6 parameter sets is tried; the best score (`% diff + 0.002 × KiB`) within the
  budget wins. Same input + same config → byte-identical SVG.

## Distribution

The engine core is environment-agnostic on purpose: the same `TraceBackend` contract can be
implemented by a native backend (VTracer Rust/Python + sharp) to ship a CLI / MCP server for
coding agents, or a desktop shell (e.g. Tauri) reusing this UI.

Web hosting target: Cloudflare Pages project `svg-studio` (e.g. `svg-studio.brainclaw.dev`):

```bash
npm run deploy     # build + wrangler pages deploy (needs a Cloudflare login)
```

## Local test material

Put sample images in `.tmp/` (git-ignored). In dev, `window.svgStudio` exposes `addFiles`,
`processAll` and the app state for scripted checks.
