# Changelog

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
