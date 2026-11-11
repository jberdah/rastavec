# Third-party notices

RastaVec is distributed under the Apache License 2.0 (see `LICENSE` and `NOTICE`).
It relies on the following open-source components, each under its own license.

| Component | Use | License |
|---|---|---|
| VTracer-Next (`vtracer-next` 1.0.0-alpha.5, based on [VTracer](https://github.com/visioncortex/vtracer)) | raster to vector tracing engine (WebAssembly) | [MIT](public/licenses/vtracer-next.txt) |
| [Visioncortex](https://crates.io/crates/visioncortex/0.9.3) | clustering and geometry used by VTracer-Next | MIT OR Apache-2.0 |
| [Svelte](https://svelte.dev) | user interface | MIT |
| [Vite](https://vite.dev) and `vite-plugin-wasm` | build tooling | MIT |
| [JSZip](https://stuk.github.io/jszip/) | zip export | MIT (dual-licensed MIT / GPLv3, used under MIT) |
| [Tauri](https://tauri.app) (`@tauri-apps/*`, `tauri` crates) | desktop application shell | MIT OR Apache-2.0 |
| [Geist / Geist Mono](https://vercel.com/font) (Vercel) | user interface fonts, loaded from Google Fonts | SIL Open Font License 1.1 |

The full license texts are included in the respective packages (`node_modules/*/LICENSE`,
crate sources) and at the links above.
