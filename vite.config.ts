import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import wasm from 'vite-plugin-wasm'
import { verifyVTracerNext } from './scripts/verify-vtracer-next.mjs'

// VTracer-Next is the sole tracing engine in app builds.
export default defineConfig(({ command }) => {
  if (command === 'build') verifyVTracerNext()
  return {
    plugins: [svelte(), wasm()],
    build: { target: 'esnext' },
    worker: { format: 'es' as const },
  }
})
