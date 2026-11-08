# Changelog

## 0.3.0-beta.6 — 2026-11-08

### Added

- Optional Watershed colour clustering with adjustable detail in the app and CLI.

### Improved

- Auto compares a polygon-traced candidate for non-pixel artwork and selects it when the existing
  fidelity-and-size score improves; custom presets and pixel-art workflows keep their prior behavior.
- Auto's ranking includes mean color error. It tests conservative solid-fill calibration and, for
  flat artwork, a dominant-source-palette refinement. Palette refinement is retained only when
  visible difference and mean color error both improve without changing silhouette or path structure.
- Auto tests merging adjacent same-fill paths to reduce SVG object count. It keeps the candidate
  only when a fresh render preserves visible difference, silhouette, alpha, and color metrics.
- Re-measure grouped and pivot-adjusted SVGs so exported metrics and size review describe the output.

### Fixed

- Protect CSV exports from spreadsheet formulas and filenames containing control characters.
- Require actual motion across distinct keyframes before enabling group-animation playback or export.
- Explain failed image handoffs from converter landing pages and how to retry the import.
- Reject CLI Watershed options with binary presets, where clustering is fixed to black and white.
- Build the ignored VTracer WebAssembly adapter when starting the local dev server.

## 0.3.0-beta.5 — 2026-11-07

### Added

- Group review for proximity-based and spatial path groups, with editable hierarchy, names,
  optional roles, pivots, protection, merge/split controls and ZIP metadata export.
- Animation editor with editable pivots, rotation and vertical-motion keyframes, role-driven
  walk cycles, pose sequences and looping animated SVG export.
- Build the browser and desktop tracing backend from the official VTracer 1.0.0-alpha.4 Rust
  crate as WebAssembly; the CLI continues to use the native Rust package.

### Improved

- Preserve SVG paint order and rendered appearance while grouping; keep rotated or skewed paths
  out of proximity calculations and support axis-aligned scale/translation transforms.
- Build and type-check the WebAssembly backend in local scripts and CI.
- Expand grouping limits and safeguards, and keep the CLI type-check scoped to its Node-compatible
  shared engine modules.
