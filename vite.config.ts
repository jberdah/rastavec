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
    // Local scratch output (.tmp holds wasm build trees and trial reports, often gigabytes) must
    // not be crawled for dependency entries or watched, or every first request takes minutes.
    optimizeDeps: { entries: ['index.html'] },
    server: { watch: { ignored: ['**/.tmp/**', '**/src-tauri/target/**', '**/output/**'] } },
  }
})
