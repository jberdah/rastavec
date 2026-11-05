# RastaVec

> Smooth vectors. Good vibes.

*(Formerly "SVG Studio". The name RastaVec is provisional until domain and trademark checks are done.)*

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
src/lib/engine/analyze.ts          image analysis (colours, gradients, alpha) -> Auto parameters
src/lib/engine/compact.ts          compact path encoding (pure, deterministic)
src/lib/engine/slice.ts            sprite-sheet / brand-board slicing into elements (pure)
src/lib/pipeline.ts                per-image pipeline: decode → trace → render → measure → auto-tune
src/lib/export.ts                  zip: svg/*.svg, metrics.csv, config.json (replays the batch)
src/lib/views/*                    Import, Lot (batch), Detail screens (Svelte 5)
```

- **Engine**: [VTracer](https://github.com/visioncortex/vtracer) via the official
  `vtracer-webapp` wasm build (MIT/Apache-2.0). It needs DOM elements, so it runs on the main
  thread, time-sliced to keep the UI responsive.
- **Transparency**: transparent pixels are keyed, then the colour result is clipped by a
  silhouette traced separately from the alpha channel (alpha ≥ 128 by default, configurable),
  the two-pass technique validated on the Brainclaw avatars. Soft edges / translucent areas
  below the cut are traced in colour at their mean opacity (or as uniform alpha bands);
  fully semi-transparent artwork keeps its mean opacity.
- **Analysis & Auto preset**: dominant colours, gradients and alpha profile classify each image
  (flat logo, shaded illustration, line art, pixel art, photo) and pick its parameters.
- **Metrics** (identical to the skill's `compare.cjs`): silhouette IoU at alpha ≥ 128,
  mean colour difference on white and on #202020 (0–255), alpha difference, and
  `pct_pixels_diff_gt_32`, the share of visibly different pixels used for ranking.
- **Compact output**: paths are re-encoded (translate baked in, relative coordinates computed
  from rounded points, shortest numbers, implicit repeated commands): about 27 % smaller with
  identical fidelity metrics (sub-pixel rounding only). See `src/lib/engine/compact.ts`.
- **Sheet slicing** ("Découper une planche"): a transparent (or uniform-background) board is
  split into one image per element: connected components, small decorations attached to the
  nearest element, letters of a wordmark grouped, reading order kept. Boards with background
  panels behind groups of items are split per panel.
- **Auto-tune**: when an image exceeds the difference threshold or the size budget, a fixed
  grid of up to 6 parameter sets is tried; the best score (`% diff + 0.002 × KiB`) within the
  budget wins. Same input + same config → byte-identical SVG.

## Brand

- Name `RastaVec`, CLI / packages `rastavec`; signature *Smooth vectors. Good vibes.*
- App: minimal, background `#0A0B0F`, accent `#C8F65A`. Secondary colours gold `#F5C542`,
  coral `#E96650`, green `#2E7D5B`, used sparingly (marketing first).
- **Orange `#FF7A45` is reserved for differences / items to review**: never decorative.
- Logo: minimal Bézier symbol + wordmark (must work monochrome at 16 px). The mascot is a
  separate, original character built from vector shapes, for large formats and animation;
  no cultural stereotypes (no Jamaican hat, dreadlocks, sunglasses).

## Distribution

The engine core is environment-agnostic on purpose: the same `TraceBackend` contract can be
implemented by a native backend (VTracer Rust/Python + sharp) to ship a CLI / MCP server for
coding agents, or a desktop shell (e.g. Tauri) reusing this UI.

Web hosting target: Cloudflare Pages project `rastavec` (domain to be decided):

```bash
npm run deploy     # build + wrangler pages deploy (needs a Cloudflare login)
```

## Local test material

Put sample images in `.tmp/` (git-ignored). In dev (or with `?debug`), `window.rastavec` exposes `addFiles`,
`processAll` and the app state for scripted checks.
