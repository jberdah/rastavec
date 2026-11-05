# Developing RastaVec

## Run

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # static site in dist/
npm run check      # svelte-check + tsc
```

Desktop: `npm run tauri dev` / `npm run tauri build` (needs Rust and, on Windows, the C++
build tools).

CLI: see [cli/README.md](../cli/README.md).

```bash
cd cli && npm install && npm run build
node dist/rastavec.cjs trace ../assets -o out --threshold 2 --max-size 700 --compare --json
```

## Project layout

```
src/lib/engine/core.ts             pure TS, no DOM: prepare (alpha floor, keying, silhouette mask),
                                   metrics, diff map, auto-tune grid, scoring, choice
src/lib/engine/browser-backend.ts  TraceBackend for the browser: vtracer-webapp (wasm) + canvas
src/lib/engine/presets.ts          presets, same parameter units as the raster-to-svg skill
src/lib/engine/analyze.ts          image analysis (colours, gradients, alpha) -> Auto parameters
src/lib/engine/compact.ts          compact path encoding (pure, deterministic)
src/lib/engine/compose.ts          SVG assembly shared by backends (silhouette clip, soft layers, binary)
src/lib/engine/vectorize.ts        shared loop: analysis -> trace -> measure -> auto-tune -> choice
src/lib/engine/slice.ts            sprite-sheet / brand-board slicing into elements (pure)
src/lib/i18n.svelte.ts             FR / EN dictionaries, locale detection, number / size formatting
src/lib/pipeline.ts                per-image pipeline: decode → trace → render → measure → auto-tune
src/lib/export.ts                  zip: svg/*.svg, metrics.csv, config.json (replays the batch)
src/lib/views/*                    Import, Lot (batch), Detail screens (Svelte 5)
cli/                               command-line package (Node, VTracer wasm + sharp)
src-tauri/                         desktop shell (Tauri 2)
e2e/                               desktop end-to-end tests
```

The engine core is environment-agnostic: the same `TraceBackend` contract is implemented in
the browser and in the CLI, and could back an MCP server.

## Engine details

- **Engine**: [VTracer](https://github.com/visioncortex/vtracer) via the official
  `vtracer-webapp` wasm build (MIT/Apache-2.0). It needs DOM elements, so it runs on the main
  thread, time-sliced to keep the UI responsive. The CLI uses `@visioncortex/vtracer` 1.0.
- **Transparency**: transparent pixels are keyed, then the colour result is clipped by a
  silhouette traced separately from the alpha channel (alpha ≥ 128 by default, configurable).
  Soft edges / translucent areas below the cut are traced in colour at their mean opacity (or
  as uniform alpha bands); fully semi-transparent artwork keeps its mean opacity.
- **Analysis & Auto preset**: dominant colours, gradients and alpha profile classify each image
  (flat logo, shaded illustration, line art, pixel art, photo) and pick its parameters.
- **Metrics**: silhouette IoU at alpha ≥ 128, mean colour difference on white and on #202020
  (0–255), alpha difference, and `pct_pixels_diff_gt_32`, the share of visibly different
  pixels used for ranking.
- **Compact output**: paths are re-encoded (translate baked in, relative coordinates computed
  from rounded points, shortest numbers, implicit repeated commands): about 27 % smaller with
  identical fidelity metrics (sub-pixel rounding only).
- **Sheet slicing**: a transparent (or uniform-background) board is split into one image per
  element: connected components, small decorations attached to the nearest element, letters of
  a wordmark grouped, reading order kept. Boards with background panels behind groups of items
  are split per panel.
- **Auto-tune**: when an image exceeds the difference threshold or the size budget, a fixed
  grid of up to 6 parameter sets is tried; the best score (`% diff + 0.002 × KiB`) within the
  budget wins. Same input + same config → byte-identical SVG.

## Localisation

The UI is available in French and English. The default follows the browser language; the
FR / EN switch in the header remembers the choice (localStorage). Numbers, percentages and
sizes are formatted per locale (`1,25 %` / `1.25%`, `Ko` / `KB`). The engine is
language-neutral: analysis and Auto return codes that the UI translates. To add a language,
add a dictionary in `src/lib/i18n.svelte.ts` (the `en` object is typed against the French keys).

## CI and desktop builds (GitHub Actions)

- **CI** (`.github/workflows/ci.yml`): on every push to `main` and every pull request,
  type-check and web build on Linux, plus the CLI build and smoke test.
- **Desktop apps** (`.github/workflows/desktop.yml`): Tauri build for Windows (x64) and macOS
  (universal). Run it from the Actions tab to get the installers as artifacts; push a tag `v*`
  to also get a draft GitHub release (prerelease when the tag has a suffix, e.g. `-beta.2`).
- **Windows end-to-end test**: installs the NSIS build silently and checks that it starts, then
  drives a test variant of the app (WebView2 debugging port via `e2e/tauri.e2e.conf.json`) with
  Playwright over CDP: import, vectorise, batch review, detail view, slider, metrics.
  Screenshots, a screen recording and `report.json` are in the `e2e-desktop-windows` artifact.
- **macOS end-to-end test**: installs the `.dmg`, checks the app starts, then runs a test
  variant built with `VITE_E2E_PORT`: an in-app harness (`src/lib/e2e-harness.ts`, absent from
  normal builds) drives the same UI and reports each step to `e2e/desktop-mac.mjs`, which takes
  screenshots and checks the results (`e2e-desktop-macos`).
- The draft release waits for both tests.

## Web hosting

Target: Cloudflare Pages project `rastavec`.

```bash
npm run deploy     # build + wrangler pages deploy (needs a Cloudflare login)
```

## Local test material

Put sample images in `.tmp/` (git-ignored). In dev (or with `?debug`), `window.rastavec`
exposes `addFiles`, `processAll` and the app state for scripted checks.
