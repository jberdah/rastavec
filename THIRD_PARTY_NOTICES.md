# Third-party notices

RastaVec is distributed under the Apache License 2.0 (see `LICENSE` and `NOTICE`).
It relies on the following open-source components, each under its own license.

| Component | Use | License |
|---|---|---|
| VTracer-Next (`vtracer-next` 1.0.0-alpha.5, based on [VTracer](https://github.com/visioncortex/vtracer)) | raster to vector tracing engine (WebAssembly) | [MIT](public/licenses/vtracer-next.txt) |
| [Visioncortex](https://crates.io/crates/visioncortex/0.9.3) | clustering and geometry used by VTracer-Next | MIT OR Apache-2.0, used under [MIT](public/licenses/vtracer-next-third-party.txt) |
| [flo_curves](https://crates.io/crates/flo_curves) | curve fitting used by VTracer-Next | [Apache-2.0](public/licenses/vtracer-next-third-party.txt) |
| [roots](https://crates.io/crates/roots) | polynomial root finding used by flo_curves | [BSD-2-Clause](public/licenses/vtracer-next-third-party.txt) |
| Other Rust crates built into the VTracer-Next module (wasm-bindgen, serde, smallvec, itertools and others) | WebAssembly bindings and utilities | MIT or MIT OR Apache-2.0; every notice is in [vtracer-next-third-party.txt](public/licenses/vtracer-next-third-party.txt) |
| [Svelte](https://svelte.dev) | user interface | MIT |
| [Vite](https://vite.dev) and `vite-plugin-wasm` | build tooling | MIT |
| [JSZip](https://stuk.github.io/jszip/) | zip export | MIT (dual-licensed MIT / GPLv3, used under MIT) |
| [Tauri](https://tauri.app) (`@tauri-apps/*`, `tauri` crates) | desktop application shell | MIT OR Apache-2.0 |
| [Geist / Geist Mono](https://vercel.com/font) (Vercel) | user interface fonts, loaded from Google Fonts | SIL Open Font License 1.1 |

The full license texts are included in the respective packages (`node_modules/*/LICENSE`,
crate sources) and at the links above.
