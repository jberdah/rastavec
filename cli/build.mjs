// Bundles the CLI and the shared engine (../src/lib/engine) into one CommonJS file.
import { build } from 'esbuild'
import { readFileSync, copyFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile: 'dist/rastavec.cjs',
  external: ['sharp', '@visioncortex/vtracer', 'onnxruntime-web'],
  banner: { js: '#!/usr/bin/env node' },
  define: { __VERSION__: JSON.stringify(pkg.version) },
  legalComments: 'none',
  logLevel: 'warning',
})

// Ship the licence files with the npm package.
for (const f of ['LICENSE', 'NOTICE']) copyFileSync(new URL(`../${f}`, import.meta.url), new URL(`./${f}`, import.meta.url))
console.log(`built dist/rastavec.cjs (v${pkg.version})`)
