import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'
import { applyDocumentLocale } from './lib/i18n.svelte'
import * as pipeline from './lib/pipeline'
import { app as appState, go } from './lib/store.svelte'

applyDocumentLocale()
document.body.classList.toggle('embedded-app', import.meta.env.BASE_URL !== '/')

const app = mount(App, {
  target: document.getElementById('app')!,
})

// Converter landing pages pass the selected image through same-origin IndexedDB.
// Consume the one-time handoff and start the existing auto-tuned tracing flow.
async function importLandingImage() {
  const url = new URL(location.href)
  const handoffId = url.searchParams.get('handoff')
  if (!handoffId) return

  url.searchParams.delete('handoff')
  url.searchParams.delete('from')
  history.replaceState(history.state, '', url.pathname + url.search + url.hash)

  try {
    const { consumeLandingImage } = await import('./lib/landing-handoff')
    const file = await consumeLandingImage(handoffId)
    if (!file) {
      appState.landingHandoffFailed = true
      return
    }

    if (!pipeline.addFiles([file])) {
      appState.landingHandoffFailed = true
      return
    }
    appState.landingHandoffFailed = false
    go('lot')
    await pipeline.processAll()
  } catch (error) {
    console.error('Could not load the image from the converter landing page.', error)
    if (appState.route === 'import') appState.landingHandoffFailed = true
  }
}

void importLandingImage()

// Test hook (dev, or ?debug in production) so scripted checks can feed files without a file picker.
if (import.meta.env.DEV || new URLSearchParams(location.search).has('debug')) {
  const hook = { ...pipeline, app: appState }
  ;(window as unknown as Record<string, unknown>).rastavec = hook
  ;(window as unknown as Record<string, unknown>).svgStudio = hook // legacy alias
}

// Desktop end-to-end test variant only (VITE_E2E_PORT set at build time); removed from normal builds.
if (import.meta.env.VITE_E2E_PORT) import('./lib/e2e-harness')

export default app
