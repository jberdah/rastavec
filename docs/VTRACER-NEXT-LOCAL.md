# VTracer-Next in RastaVec

RastaVec uses one vectorization engine: the pinned VTracer-Next WASM module.
The **Experimental gradients** checkbox and `rastavec trace --gradients` force
its gradient fitter for color traces. With Auto enabled on the regular engine,
RastaVec may also compare one optional gradient candidate for suitable shaded
opaque images and retain it only when its measured score and size budget win.
The web, desktop and CLI use the same generated module.

## Normal app and CLI builds

The generated WASM glue and binary are checked in. The web and CLI builds use
Node.js, and Tauri uses its standard Rust desktop toolchain. CI and release
jobs use the checked-in module without accessing the private source repository.

```powershell
npm ci
npm run dev
npm run check
npm run build
npm ci --prefix cli
npm --prefix cli run build
```

App and CLI builds verify the module and its build inputs against
`scripts/vtracer-next.artifacts.json`. The CLI packages an `.mjs` copy of the
generated glue alongside the WASM and its MIT license. CLI CI installs the
tarball and traces an image through the installed command.

## Rebuilding the engine

The engine build is explicit. It uses the private `VTracer-next` checkout next
to `svg-studio` by default, or the source directory named by
`VTRACER_NEXT_SOURCE`. Install Rust with the `wasm32-unknown-unknown` target
and `wasm-pack` 0.15.1 for this step:

```powershell
npm run build:vtracer-next
node scripts/build-vtracer-next-licenses.mjs
```

The second command regenerates `public/licenses/vtracer-next-third-party.txt`, the license
notices of the Rust crates the module is built from. The module ships as a binary, so those
notices are published with the web app and packaged with the CLI; rerun it whenever the
engine or `scripts/build-vtracer-next.Cargo.lock` changes.

On an offline Windows host, `wasm-pack` may fail while downloading the exact
`wasm-bindgen` CLI required by the lockfile, even after Rust compilation succeeds.
Install that exact CLI from the cached Cargo registry into the workspace and
select it explicitly. For the currently pinned 0.2.130:

```powershell
cargo install wasm-bindgen-cli --version 0.2.130 --locked --offline `
  --root .tmp\wasm-bindgen-cli --target-dir .tmp\wasm-bindgen-target
$env:VTRACER_NEXT_BINDGEN=(Resolve-Path '.tmp/wasm-bindgen-cli/bin/wasm-bindgen.exe').Path
npm run build:vtracer-next
node scripts/verify-vtracer-next.mjs
```

The script validates the CLI version and uses `wasm-pack --mode no-install`.
If Cargo reports `Accès refusé` in a sandbox temporary directory, keep the
explicit `--target-dir` under `.tmp`; do not change the locked version merely
to make an offline build pass.

`scripts/build-vtracer-next.sources.json` pins every imported Rust source file
by SHA-256 against the `be6db85` base plus the RastaVec alpha fixes. The Cargo
lockfile pins Rust dependencies. The maintainer rebuild verifies the exact
source snapshot, builds in a new temporary directory, and updates the
checked-in module and its artifact manifest. Commit both together whenever
refreshing the engine. The base commit requires the RastaVec changes listed in
the source manifest description to match the pinned snapshot.

## Focused checks

The small alpha controls exercise the regressions addressed in the fork:

- transparent-hole detection scans the whole image, including holes smaller
  than the old sparse sampling grid;
- solid SVG fills retain non-opaque alpha;
- adjacent regions with the same RGB but different alpha remain separate;
- partially transparent details are not covered by an opaque fitted gradient.

The browser comparison page and desktop smoke check can be run with:

```powershell
npm ci --prefix e2e
node e2e/vtracer-comparison.mjs --preset gradient-probe --repeats 3 --out output/vtracer-comparison
node e2e/vtracer-desktop-smoke.mjs output/vtracer-comparison/inputs/rainbow-256.png
```

Gradient fitting remains experimental. It can reduce path count substantially
on smooth color ramps, but it can increase size or worsen color error on
complex, conic, or layered artwork. Compare the exported SVG and fidelity
metrics before choosing it for a batch.

## Mosaic alpha correction

The pinned fork preserves solid alpha during Mosaic/Cutout color merging and
keeps neighboring regions with different opacity separate. Stacked compositing
and the experimental gradient route retain their existing selection behavior.
The fork regression `translucent_seams.rs` covers adjacent translucent colors,
a transparent hole, opaque colors, and same-RGB opacity differences.

On the synthetic 64×48 curved boundary, resvg's premultiplied encoded-RGB MAE
was 2.1760 for Stacked and 0.9181 for corrected Cutout; the critical pixel's
alpha was 197 and 168 respectively, against source alpha 168. This does not
establish antialiasing parity at other zoom levels or in other renderers.
An exploratory release microbenchmark over 31 warm compositions of cached
segmentation measured median 0.2934 ms for Stacked and 0.7223 ms for Cutout.
These tiny-image timings are not a production performance bound, and no
automatic routing was introduced.
The rebuilt WASM was also rasterized with sharp/librsvg: encoded premultiplied
RGB MAE was 2.3116 for Stacked and 1.1358 for Cutout. At the same critical
pixel, source RGBA [238,100,30,168] became [133,132,114,200] with Stacked and
[238,99,29,166] with Cutout. The two-alpha-level shortfall in librsvg confirms
that the shared geometry does not guarantee renderer-independent pixel coverage.
