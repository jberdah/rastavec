# Changelog

## 0.5.0-beta.3 — 2026-11-12

### Improved

- Import screen: the "Vectorise" button sits at the bottom of the drop card, next to the images it
  acts on; in Auto mode the Parameters card is folded, and the optional SVG size budget stays folded
  until you set one.

## 0.5.0-beta.2 — 2026-11-12

### Changed

- The web app, desktop app and CLI now trace with the VTracer-Next engine instead of VTracer 1.
- The VTracer-Next engine module is distributed under the VTracer-Next License 1.0
  (`public/licenses/vtracer-next.txt`) instead of MIT. SVGs it produces remain free for any use,
  commercial included; integrating the module in a commercial product needs written permission.
  The rest of RastaVec stays under Apache-2.0.
- Auto-Tune weighs fidelity, banding, file weight and editability together and has no size budget
  by default ("no size limit" in the app, `--max-size 0` in the CLI); a budget you set still flags
  oversized results for review.

### Added

- TIFF import (first full-size page, orientation and premultiplied alpha handled); BMP is now listed
  among the supported formats.
- Shapes panel in the Edit screen: select, move and resize the circles and ellipses the engine
  recognised (including partly hidden ones), recolour them and their gradient stops, undo the edits,
  or send them to Animate as one group per shape.
- Gradient-painted paths can be grouped and animated, and palette filters recolour gradient stops.
- Auto-Tune tries a simplified gradient trace (far fewer shapes for a little fidelity) and tries
  gradients on cut-out art with a transparent canvas.

### Improved

- Gentle gradients are kept instead of flattened, and banded skies become one smooth gradient.
- Two- and three-colour logos are treated as flat art and faint antialiasing pixels no longer become
  paths: a one-colour logo goes from 712 paths and 67 KiB to 27 paths and 6.7 KiB.
- Translucent flat shapes that cross each other come out as one shape each with its own opacity.

### Fixed

- Watershed clustering keeps the opacity of translucent regions without darkening antialiased opaque
  shapes, and drops fully transparent pixels consistently.
- macOS desktop app: vectorisation no longer stays stuck at "decoding" (the engine is loaded
  statically in the worker). 0.5.0-beta.1 was tagged but never published for this reason.

## 0.4.0-beta.1 — 2026-11-08

### Added

- Optional local MobileSAM mask proposals using a user-selected ONNX encoder/decoder pair; masks can be previewed and used to preselect existing geometric groups.
- CLI `--diff-summary-json` reports an 8×8 difference grid and the largest error hotspots.

### Improved

- Small-image batches vectorize in a bounded worker pool; SVG rendering is routed through the browser canvas and cancellation keeps the previous batch results.

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
