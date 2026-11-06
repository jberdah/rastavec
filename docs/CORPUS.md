# Synthetic engine reference corpus

`cli/test/corpus.test.mjs` creates its inputs from small SVG primitives in a private temporary
directory. It uses no user artwork and removes the generated files after each test. The corpus
covers an empty transparent image, a transparent logo, small isolated shapes, a colour gradient,
and a transparent sheet containing two well-separated elements.

Run it with `cd cli && npm test` (the complete CLI regression suite) after installing the CLI
dependencies. The test traces every fixture twice with identical settings and checks byte-identical
SVG output, readable SVGs with expected dimensions and no embedded `<image>`, basic report
consistency, and two bounded, readable crops for the simple sheet.

These are reproducibility and basic integrity checks, not proof of visual fidelity. The permissive
100% difference and large size limit only allow the tests to inspect all generated outputs; they are
not quality targets. The corpus has no approved reference images or visual tolerance, and exercises
the Node backend only. It does not establish browser/desktop parity or support for realistic artwork,
photographs, soft transparency, busy sheets, tiny details, fonts, or all input formats. Quality gates
for those cases require representative fixtures and human-reviewed expected results.
