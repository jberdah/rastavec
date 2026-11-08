# Developing RastaVec

## Run

The browser dev server and app builds generate the ignored VTracer WebAssembly module. Install Rust, add the
`wasm32-unknown-unknown` target with `rustup target add wasm32-unknown-unknown`, and install
`wasm-pack` (`cargo install wasm-pack --version 0.15.1 --locked`).

```bash
npm install
npm run dev        # http://localhost:5179
npm run build      # static site in dist/
npm run check      # svelte-check + tsc
```

Desktop: `npm run tauri dev` / `npm run tauri build` (needs Rust and, on Windows, the C++
build tools). The Windows MSI has its own numeric version in
`src-tauri/tauri.conf.json` under `bundle.windows.wix.version`; increment its fourth
component for each beta because WiX does not accept the SemVer `beta` label.

CLI: see [cli/README.md](../cli/README.md).

```bash
cd cli && npm install && npm run build
node dist/rastavec.cjs trace ../assets -o out --threshold 2 --max-size 700 --compare --json
```

## Project layout

```
src/lib/engine/core.ts             pure TS, no DOM: prepare (alpha floor, keying, silhouette mask),
                                   metrics, diff map, auto-tune grid, scoring, choice
src/lib/engine/browser-backend.ts  Browser entry point and image decode/encode helpers
src/lib/engine/vtracer1-backend.ts VTracer 1.0.0-alpha.4 WebAssembly adapter + canvas rendering
wasm/vtracer/                       Rust-to-WASM wrapper around the official VTracer crate
scripts/build-vtracer-wasm.mjs      Builds the ignored wasm-bindgen package used by Vite
src/lib/engine/presets.ts          presets, same parameter units as the raster-to-svg skill
src/lib/engine/analyze.ts          image analysis (colours, gradients, alpha) -> Auto parameters
src/lib/engine/compact.ts          compact path encoding (pure, deterministic)
src/lib/engine/compose.ts          SVG assembly shared by backends (silhouette clip, soft layers, binary)
src/lib/engine/vectorize.ts        shared loop: analysis -> trace -> measure -> auto-tune -> choice
src/lib/engine/vectorization-worker*.ts
                                   worker backend, transferable source buffers and bounded batch pool
src/lib/engine/slice.ts            sprite-sheet / brand-board slicing into elements (pure)
src/lib/engine/group-nearby.ts     geometric proximity/spatial grouping and group metadata
src/lib/engine/animation.ts        role-based walk cycles and animation interpolation
src/lib/i18n.svelte.ts             FR / EN dictionaries, locale detection, number / size formatting
src/lib/pipeline.ts                per-image pipeline: decode → trace → render → measure → auto-tune
src/lib/export.ts                  zip: svg/*.svg, metrics.csv, config.json (records settings)
src/lib/views/*                    Import, Lot, Detail, Edit, Groups and Animate screens (Svelte 5)
cli/                               command-line package (Node, VTracer wasm + sharp)
src-tauri/                         desktop shell (Tauri 2)
e2e/                               desktop end-to-end tests
```

The engine core is environment-agnostic: the same `TraceBackend` contract is implemented in
the browser and in the CLI, and could back an MCP server.

## Browser image limits

The browser and desktop UI reject input files above 64 MiB, images above 40 megapixels,
and either dimension above 16,384 pixels. Dimensions are checked before the app allocates
its own bitmap and canvas and rechecked after bitmap decoding. The browser may itself decode
an image while obtaining its dimensions, so these checks cannot prevent every internal
decoder allocation. Large batches can still consume substantial memory. These UI limits are
independent of the CLI limits.

## Engine details

The generated synthetic regression corpus and its limits are described in [CORPUS.md](CORPUS.md).

- **Engine**: the browser and desktop app compile the official
  [`vtracer` 1.0.0-alpha.4 crate](https://github.com/visioncortex/vtracer) to WebAssembly via
  `wasm-pack`; the CLI uses the `@visioncortex/vtracer` 1.0.0-alpha.4 WebAssembly package from Node. Both backends share
  the same `TraceBackend` contract and parameter mapping. Generated wasm-bindgen files and Cargo
  build output are ignored; `npm run dev`, `npm run check` and `npm run build` build the WASM adapter first.
- **Batch execution**: tracing, SVG rendering and fidelity measurement run in dedicated Web Workers when
  `OffscreenCanvas` is available. Up to two images run at once for batches whose largest image is at most
  4 megapixels; larger images run one at a time to limit peak memory. The source RGBA buffer is transferred
  to the worker and returned after each image, avoiding an additional full-image clone. Unsupported worker
  rendering or a worker crash falls back to the browser backend on the main thread.
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
- **Group review**: nearby ordered paths or compact spatial regions can be grouped without
  changing paint order. Spatial regions are geometric proposals, not semantic recognition;
  review groups before animation. Names, roles, pivots and protection state are editable and
  exported as SVG annotations plus `group-metadata/*.json` in the ZIP.
- **Animation**: the editor supports editable group pivots, rotation and vertical-motion
  keyframes, role-based walk cycles, and looping sequences of vectorized poses with matching
  dimensions.
- **Auto-tune**: when an image exceeds the difference threshold or the size budget, a fixed
  grid of parameter sets is tried; the best score (`% diff + 0.01 × mean RGB error (/255) +
  0.002 × KiB`) within the budget wins. Auto also tests source-guided color refinements for flat
  artwork: small per-fill corrections and a dominant-source-palette snap. Palette snapping is
  retained only when visible difference and mean color error both improve without changing the
  silhouette or path count. Same input + same config → byte-identical SVG.
- For images up to 256 px on their longest side, the Auto and Pixel art presets also try
  nearest-neighbour enlargement by 2 and 4 before tracing with the pixel preset. SVGs retain
  their original display dimensions; the measured score and size budget still select the winner.
  `traceScale` in the CLI report and exported config records the chosen factor. Custom presets and
  disabled auto-tuning do not add these trials. The result can contain many more paths and take
  longer to generate, edit and render; inspect its path count and size before use. The CSV includes
  the factor as `trace_scale`.

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

## Local session recovery

The browser keeps one local IndexedDB backup per origin and browser profile. It saves files,
chosen trials, palette edits and settings after changes settle and outside a running batch.
The last committed backup remains intact if a write fails (for example, storage quota).
At startup the user can restore it, delete it, or start a new batch that will replace it.
The application reports storage failures; closing before the pending save completes can lose
recent changes. Stored originals and SVGs remain on the device until the backup is deleted or
browser storage is cleared. IndexedDB may be evicted by the browser; this is not a substitute
for exporting the ZIP. A pending edit measurement is recomputed during restore.
