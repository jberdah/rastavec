import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'
import { applyDocumentLocale } from './lib/i18n.svelte'

applyDocumentLocale()
document.body.classList.toggle('embedded-app', import.meta.env.BASE_URL !== '/')

const app = mount(App, {
  target: document.getElementById('app')!,
})

// Test hook (dev, or ?debug in production) so scripted checks can feed files without a file picker.
if (import.meta.env.DEV || new URLSearchParams(location.search).has('debug')) {
  Promise.all([import('./lib/pipeline'), import('./lib/store.svelte')]).then(([pipeline, store]) => {
    const hook = { ...pipeline, app: store.app }
    ;(window as unknown as Record<string, unknown>).rastavec = hook
    ;(window as unknown as Record<string, unknown>).svgStudio = hook // legacy alias
  })
}

// Desktop end-to-end test variant only (VITE_E2E_PORT set at build time); removed from normal builds.
if (import.meta.env.VITE_E2E_PORT) import('./lib/e2e-harness')

export default app
