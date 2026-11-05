import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import wasm from 'vite-plugin-wasm'

// vtracer-webapp ships a wasm-bindgen "bundler" build: vite-plugin-wasm resolves the
// `import * as wasm from "./x.wasm"` and needs an esnext target (top-level await).
export default defineConfig({
  plugins: [svelte(), wasm()],
  build: { target: 'esnext' },
  optimizeDeps: { exclude: ['vtracer-webapp'] },
})
