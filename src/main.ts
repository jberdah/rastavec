import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'

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

export default app
