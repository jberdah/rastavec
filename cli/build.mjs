// Bundles the CLI and the shared engine (../src/lib/engine) into one CommonJS file.
import { build } from 'esbuild'
import { readFileSync, copyFileSync, mkdirSync } from 'node:fs'
import { verifyVTracerNext, vtracerNextDirectory } from '../scripts/verify-vtracer-next.mjs'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
verifyVTracerNext()

await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: 'dist/rastavec.cjs',
  external: ['sharp'],
  banner: { js: '#!/usr/bin/env node' },
  define: { __VERSION__: JSON.stringify(pkg.version) },
  legalComments: 'none',
  logLevel: 'warning',
})

// Ship the licence files with the npm package.
for (const f of ['LICENSE', 'NOTICE']) copyFileSync(new URL(`../${f}`, import.meta.url), new URL(`./${f}`, import.meta.url))
const nextDist = new URL('./dist/vtracer-next-wasm/', import.meta.url)
mkdirSync(nextDist, { recursive: true })
copyFileSync(new URL('vtracer_next.js', vtracerNextDirectory), new URL('vtracer_next.mjs', nextDist))
copyFileSync(new URL('vtracer_next_bg.wasm', vtracerNextDirectory), new URL('vtracer_next_bg.wasm', nextDist))
copyFileSync(new URL('../public/licenses/vtracer-next.txt', import.meta.url), new URL('LICENSE', nextDist))
console.log(`built dist/rastavec.cjs (v${pkg.version})`)
