<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/jberdah/rastavec/main/assets/rastavec-logo.svg">
    <img src="https://raw.githubusercontent.com/jberdah/rastavec/main/assets/rastavec-logo-light-bg.svg" alt="RastaVec" width="360">
  </picture>
</p>

# RastaVec CLI

> Smooth vectors. Good vibes.

Raster to SVG from the command line: image analysis, fidelity metrics and deterministic
auto-tuning, with a JSON report and stable exit codes for scripts, CI and AI agents.
Same engine as the [RastaVec web app](https://github.com/jberdah/rastavec), everything runs locally.

```bash
rastavec trace logo.png
rastavec trace images/ -o out/ --preset auto --threshold 2 --max-size 700 --compare --json
rastavec analyze images/ --json        # what Auto would do, writes nothing
rastavec objects venn.png -o hypotheses/ # propose supported object masks for review
rastavec slice board.png -o elements/   # one PNG per element of a sprite sheet
```

## Install

Node.js 18 or later. The beta is attached to the
[GitHub releases](https://github.com/jberdah/rastavec/releases):

```bash
npm install -g https://github.com/jberdah/rastavec/releases/download/v0.4.0-beta.1/rastavec-0.4.0-beta.1.tgz
```

## Commands

| Command | What it does |
|---|---|
| `trace <input...>` | Vectorise files and/or folders. Writes `<name>.svg` and `report.json` to the output folder. |
| `analyze <input...>` | Classifies each image (flat logo, shaded illustration, line art, pixel art, photo), detects transparency, prints the parameters Auto would use. |
| `objects <input...>` | Runs source-raster object proposal providers, writing a JSON report and one transparent PNG mask per proposal. Routes cover visible connected regions, a three-circle fit, a planar graph of dominant flat-color states and optional MobileSAM masks. |
| `slice <sheet>` | Splits a transparent or uniform-background sheet into one PNG per element. |

`objects` is a proposal command, not an automatic reconstruction guarantee. The circle
provider needs three circles with distinct exposed flat-color arcs on a flat opaque
background. The planar-color route is shape-family agnostic but needs two to four overlapping
objects represented by frequent flat-color states on a flat opaque background. Each route
records its own provenance, fit evidence, warnings and explicit abstentions. Proposed
objects remain `human-review-required`. Inference reads only the raster. Each mask PNG is
white on transparency and may be downsampled to the provider's analysis size; exact mask
dimensions are recorded in report.json. The planar-color route is experimental and only
applies to overlapping objects represented by frequent flat-color states on an opaque
background. It currently abstains on gradients and transparent backgrounds, and it has not
been independently validated. Gradient paint fitting and a general-purpose detector for
arbitrary shapes are not wired into this command yet. The connected-component route covers
visible regions on transparent canvases or images with a border-derived background; it does
not complete occluded shapes, and it can merge touching objects or split one object with
disconnected parts.

The report also includes a raster-only route recommendation in its routeRecommendation field.
It can recommend the circle fitter or planar-color route when their geometry and background
assumptions are met. If neither specialist applies, it recommends MobileSAM when enabled,
then visible connected components. If multiple specialists fit, it reports the conflict
without selecting one. Recommendations are advisory, require human review, and are not
validated accuracy or confidence scores for arbitrary imagery.

MobileSAM runs only when both model paths are provided. It verifies the supported
Acly/MobileSAM encoder and decoder by SHA-256, uses the local ONNX Runtime WebAssembly
backend, and never downloads a model or sends the image over the network. Its deterministic
positive-point grid produces visible-region masks; it does not infer semantic labels, hidden
geometry or paint order. Before decoding, RastaVec applies the connected-component prompt gate
only when component detection has no truncated regions and the border evidence is usable
(transparent border, or opaque-border support of at least 0.75). It keeps the full grid if the
component route abstains, support is weak, components were truncated, or no grid point falls
inside a supported foreground mask. This filters prompt locations; it does not split merged
regions or complete occluded geometry. To include MobileSAM, obtain the supported ONNX pair from
[Acly/MobileSAM](https://huggingface.co/Acly/MobileSAM) and pass both files explicitly:

```bash
rastavec objects venn.png -o hypotheses/ --sam-encoder mobile_sam_image_encoder.onnx --sam-decoder sam_mask_decoder_single.onnx --sam-grid 4
```

The grid defaults to 3×3; values from 2 to 6 control the maximum number of positive prompts
(grid size squared). Duplicate masks are removed deterministically. MobileSAM inference is
local and sequential. CI covers prompt-selection helpers and package loading, but does not
currently run encoder/decoder inference with the ONNX model pair; model-backed execution and
session teardown remain unverified by automated tests. The current published `0.4.0-beta.1`
package predates this CLI route; build from the repository checkout to use it.
When multiple routes propose objects, `providerComparison` reports counts from all routes and
maximum-IoU one-to-one mask matches for the routes listed in `maskComparableProviders`.
Only masks with the same known meaning are compared by IoU; unknown or incompatible categories
are excluded while counts remain visible. The reported mean matched IoU includes only
threshold-qualified pairs, and mean assigned IoU remains a separate diagnostic. These are
cross-route consistency measures, not calibrated confidence or proof that either route is
correct. The text summary calls out count disagreements and summarizes matched-mask IoU.
The command is available from a local checkout after `npm run build` in `cli/`; the already
published `0.4.0-beta.1` package does not contain this addition.

## Trace options

| Option | Default | Meaning |
|---|---|---|
| `-o, --out <dir>` | `./rastavec-out` | output folder |
| `-p, --preset <id>` | `auto` | `auto`, `flat`, `shaded`, `line`, `pixel`, `custom` |
| `-t, --threshold <pct>` | `3` | max share of visibly different pixels |
| `-s, --max-size <KB>` | `400` | size budget per SVG (KiB) |
| `--no-auto` | | single trial, no auto-tuning |
| `--compare` | | also write `<name>.comparison.png` (source / SVG on white and dark) and `<name>.diff.png` (differences in magenta) |
| `--diff-summary-json` | | write `<name>.diff.json` with an 8×8 visible-difference grid and up to eight hotspot regions; also embed the summary in each JSON report item |
| `--slice` | | treat inputs as sheets and vectorise each element |
| `-r, --recursive` | | include sub-folders |
| `-f, --force` | | overwrite existing outputs (never overwritten otherwise) |
| `--color-precision`, `--layer-difference`, `--speckle`, `--mode`, `--binary` | | parameter overrides (custom preset) |
| `--clustering <color-cluster|watershed>` | `color-cluster` | choose the colour-region clustering method |
| `--watershed-detail <0-255>` | `128` | Watershed cut detail; selecting it also enables Watershed |
| `--json` | | JSON report on stdout |
| `-q, --quiet` | | no progress output |

Before tracing, all output paths, including `report.json` and optional comparison images,
are checked for existing files. Output names are made unique within a batch, including when
an input name already contains a numeric suffix. A sheet with no detected elements is an
error (exit code 2), rather than a successful empty batch. `slice` checks every element's
destination before writing any of them. Even with `--force`, `trace` refuses to write an
output over one of its input images.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | trace is under its threshold and size budget; `analyze` and `slice` completed |
| `1` | trace needs review, or `objects` produced hypotheses/abstentions that require review |
| `2` | error: bad arguments, unreadable input, existing outputs without `--force` |

## JSON report (`schemaVersion: 1`)

```json
{
  "schemaVersion": 1, "tool": "rastavec", "version": "0.4.0-beta.1",
  "engine": "vtracer 1.0.0-alpha.4 (node) + sharp",
  "settings": { "preset": "auto", "params": null, "autoTune": { "enabled": true, "threshold": 2, "maxKB": 700 } },
  "summary": { "total": 4, "ok": 2, "review": 2, "errors": 0, "seconds": 51.2 },
  "items": [{
    "name": "logo", "input": "…/logo.png", "output": "…/logo.svg",
    "comparison": "…/logo.comparison.png", "diff": "…/logo.diff.png",
    "status": "ok", "width": 2172, "height": 724,
    "analysis": { "kind": "shaded", "alpha": "edges", "dominantColors": 12, "gradient": 0.13, "transparentPct": 76, "softPct": 1.6, "grayscale": false },
    "notes": ["shaded", "edges"], "autoTuned": false, "trials": 1,
    "params": { "colorPrecision": 8, "layerDifference": 8, "speckle": 7, "…": "…" },
    "metrics": { "pctDiff": 1.34, "iou": 0.982, "rgbWhite": 1.9, "rgbDark": 1.4, "alphaDiff": 1.2, "bytes": 96512, "paths": 177, "embeddedRaster": false }
  }]
}
```

- `pctDiff`: % of pixels whose worst-channel difference (on white or on #202020) exceeds 32/255.
- `iou`: overlap of opaque areas (alpha ≥ 128). `rgbWhite`, `rgbDark`, `alphaDiff`: mean differences, 0–255.
- `traceMethod`: selected Auto variant. `paths-merged` means adjacent same-fill paths were combined only
  after a fresh render preserved the measured visible difference, silhouette, alpha and color fidelity.
- `diffSummary`: with `--diff-summary-json`, contains a top-to-bottom grid of visible-difference percentages
  and up to eight hotspot rectangles in source-image pixels. Its 32/255 threshold matches `pctDiff`.
- `status`: `ok`, `review` (above threshold or budget) or `error` (with `error`).
- Same input and same settings give the same SVG.

## Notes

- Engine: the official [VTracer](https://github.com/visioncortex/vtracer) 1.0 WebAssembly build
  (`@visioncortex/vtracer`, MIT/Apache-2.0) and [sharp](https://sharp.pixelplumbing.com).
  The web app also uses VTracer 1.0.0-alpha.4, compiled to WebAssembly in the browser. The CLI
  uses the Node package with `sharp` for image decoding and SVG rendering; metrics can differ
  slightly because the browser and CLI use different rendering backends.
- Source images are limited to 40 million pixels and 16,384 pixels on either side. Oversized
  files are rejected before decoding with an error and exit code 2; resize them before retrying.
  Even images within the limits can require substantial memory during tracing.
- License: Apache-2.0. Redistributions must keep the `NOTICE` file.
